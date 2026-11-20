/**
 * Apple Push Notification service (APNs), HTTP/2, for iOS devices.
 *
 * Auth: a token-based provider JWT (ES256) signed with the team's .p8 key. The JWT is cached for 50
 * minutes (APNs rejects tokens older than an hour). The key never leaves the server.
 *
 * Payload: generic alert title plus the deep link. No article text, because alerts appear on the lock screen.
 */
import { createSign } from 'crypto';
import type { PushPayload, PushResult, PushSender, PushTarget } from './sender';

const DEVICE_TOKEN = /^[0-9a-f]{64}$/i;
const JWT_CACHE_MS = 50 * 60 * 1000;

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  /** PKCS#8 PEM of the .p8 key. */
  privateKey: string;
  production: boolean;
}

export interface ApnsResponse {
  status: number;
  body: string;
}

/** Sends one HTTP/2 POST to APNs. Injected so tests run without a network. */
export type ApnsTransport = (args: {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<ApnsResponse>;

export function signProviderToken(config: Pick<ApnsConfig, 'keyId' | 'teamId' | 'privateKey'>, nowMs: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) })).toString('base64url');
  const input = `${header}.${claims}`;
  // dsaEncoding "ieee-p1363" gives the raw r||s signature that JWT ES256 requires.
  const signature = createSign('sha256').update(input).sign({ key: config.privateKey, dsaEncoding: 'ieee-p1363' }, 'base64url');
  return `${input}.${signature}`;
}

export class ApnsSender implements PushSender {
  private cachedJwt: { value: string; issuedAt: number } | null = null;

  constructor(
    private readonly config: ApnsConfig,
    private readonly transport: ApnsTransport,
    private readonly now: () => number = () => Date.now()
  ) {}

  private jwt(): string {
    const nowMs = this.now();
    if (!this.cachedJwt || nowMs - this.cachedJwt.issuedAt > JWT_CACHE_MS) {
      this.cachedJwt = { value: signProviderToken(this.config, nowMs), issuedAt: nowMs };
    }
    return this.cachedJwt.value;
  }

  async send(target: PushTarget, payload: PushPayload): Promise<PushResult> {
    if (target.platform !== 'ios') return 'failed';
    // Malformed tokens are refused before any network call.
    if (!DEVICE_TOKEN.test(target.pushToken)) return 'invalid_token';

    const body = JSON.stringify({
      aps: { alert: { title: payload.title }, sound: 'default' },
      kind: payload.kind,
      deepLink: payload.deepLink ?? '',
    });
    let res: ApnsResponse;
    try {
      res = await this.transport({
        host: this.config.production ? 'api.push.apple.com' : 'api.sandbox.push.apple.com',
        path: `/3/device/${target.pushToken.toLowerCase()}`,
        headers: {
          authorization: `bearer ${this.jwt()}`,
          'apns-topic': this.config.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        },
        body,
      });
    } catch {
      return 'failed';
    }
    if (res.status === 200) return 'sent';
    if (res.status === 403 && /ExpiredProviderToken/.test(res.body)) {
      this.cachedJwt = null;
      return 'failed';
    }
    // 410 Unregistered and 400 BadDeviceToken mean the token will never work again.
    if (res.status === 410 || (res.status === 400 && /BadDeviceToken|Unregistered/.test(res.body))) return 'invalid_token';
    return 'failed';
  }
}

/** Default HTTP/2 transport. Opens one session per call, which is simple and fine at this volume. */
export function http2Transport(): ApnsTransport {
  // Imported lazily so that test runs and non-iOS deployments never open sockets.
  return async ({ host, path, headers, body }) => {
    const http2 = await import('http2');
    return new Promise<ApnsResponse>((resolve, reject) => {
      const client = http2.connect(`https://${host}`);
      client.on('error', (err) => {
        client.close();
        reject(err);
      });
      const req = client.request({ ':method': 'POST', ':path': path, ...headers });
      let status = 0;
      let text = '';
      req.setEncoding('utf8');
      req.on('response', (h) => {
        status = Number(h[':status'] ?? 0);
      });
      req.on('data', (chunk: string) => {
        text += chunk;
      });
      req.on('end', () => {
        client.close();
        resolve({ status, body: text });
      });
      req.on('error', (err) => {
        client.close();
        reject(err);
      });
      req.end(body);
    });
  };
}
