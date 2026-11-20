/**
 * Firebase Cloud Messaging, HTTP v1, for Android devices.
 *
 * Auth: a service account signs a short JWT (RS256). It is exchanged at Google's token endpoint for an
 * access token, which is cached until shortly before it expires. The private key never leaves the server.
 *
 * Only data that is safe on a lock screen is sent: a generic title, the notification kind and the deep
 * link (cyberkiwi://story/<id>). No article text.
 */
import { createSign } from 'crypto';
import type { PushPayload, PushResult, PushSender, PushTarget } from './sender';

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_LIFETIME_S = 3600;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

export function parseServiceAccount(raw: string): ServiceAccount {
  const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
  if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string' || typeof parsed.project_id !== 'string') {
    throw new Error('FCM service account JSON needs client_email, private_key and project_id');
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key.replace(/\\n/g, '\n'), project_id: parsed.project_id };
}

/** Builds the signed JWT assertion used to request an access token. Exported for tests. */
export function signAssertion(account: ServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({ iss: account.client_email, scope: FCM_SCOPE, aud: GOOGLE_TOKEN_URL, iat, exp: iat + TOKEN_LIFETIME_S })
  ).toString('base64url');
  const input = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(input).sign(account.private_key, 'base64url');
  return `${input}.${signature}`;
}

export class FcmSender implements PushSender {
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = () => Date.now()
  ) {}

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt - REFRESH_MARGIN_MS > this.now()) return this.accessToken.value;
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signAssertion(this.account, this.now()),
    }).toString();
    const res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (res.status !== 200) throw new Error(`token exchange failed with HTTP ${res.status}`);
    const json = JSON.parse(await res.text()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('token exchange returned no access token');
    this.accessToken = { value: json.access_token, expiresAt: this.now() + (json.expires_in ?? TOKEN_LIFETIME_S) * 1000 };
    return json.access_token;
  }

  async send(target: PushTarget, payload: PushPayload): Promise<PushResult> {
    if (target.platform !== 'android') return 'failed';
    let token: string;
    try {
      token = await this.token();
    } catch {
      // Never log the response or the assertion. The caller only needs to know that the send failed.
      return 'failed';
    }
    const message = {
      message: {
        token: target.pushToken,
        notification: { title: payload.title },
        data: { kind: payload.kind, deepLink: payload.deepLink ?? '' },
        android: { priority: 'HIGH' },
      },
    };
    const res = await this.fetchImpl(`https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    if (res.status === 200) return 'sent';
    if (res.status === 401) {
      this.accessToken = null;
      return 'failed';
    }
    // FCM reports a dead registration token as UNREGISTERED (404) or INVALID_ARGUMENT (400) with that detail.
    const text = await res.text().catch(() => '');
    if (res.status === 404 || (res.status === 400 && /UNREGISTERED|registration token/i.test(text))) return 'invalid_token';
    return 'failed';
  }
}
