/**
 * Push notification boundary.
 *
 * The app gets a device token from the OS and registers it through POST /api/devices. The server sends:
 *   - Android through FCM (HTTP v1), configured by FCM_SERVICE_ACCOUNT_JSON or FCM_SERVICE_ACCOUNT_FILE
 *   - iOS through APNs (HTTP/2, token-based), configured by APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID,
 *     APNS_PRIVATE_KEY (PEM, \n escapes allowed) and optionally APNS_PRODUCTION=true
 *
 * Credentials stay on the server. When a platform is not configured, its sends return "unavailable",
 * and the API reports push as unavailable. It is never reported as working without credentials.
 *
 * Payloads carry a generic title and a deep link with a story ID. They never carry article text,
 * because notifications are visible on a locked screen.
 */
import { readFileSync } from 'fs';
import { ApnsSender, http2Transport, type ApnsTransport } from './apns';
import { FcmSender, parseServiceAccount, type FetchLike } from './fcm';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PushPlatform = 'ios' | 'android' | 'web';
export type PushKind = 'breaking' | 'daily_digest' | 'ai_ready';

export interface PushPayload {
  kind: PushKind;
  title: string;
  /** cyberkiwi://story/<id>. Null for digests that have no single story. */
  deepLink: string | null;
}

export interface PushTarget {
  platform: PushPlatform;
  pushToken: string;
}

/** sent: delivered to the provider. invalid_token: the token is dead and should be removed. failed: retry later. unavailable: no provider configured. */
export type PushResult = 'sent' | 'invalid_token' | 'failed' | 'unavailable';

export interface PushSender {
  send(target: PushTarget, payload: PushPayload): Promise<PushResult>;
}

const TITLES: Record<PushKind, string> = {
  breaking: 'Breaking security news',
  daily_digest: 'Your daily briefing is ready',
  ai_ready: 'An AI briefing is ready',
};

/** Builds a payload that holds only a generic title and, optionally, a story ID. */
export function payloadFor(kind: PushKind, storyId?: string): PushPayload {
  if (storyId !== undefined && !UUID.test(storyId)) throw new Error('storyId must be a UUID');
  return {
    kind,
    title: TITLES[kind],
    deepLink: storyId ? `cyberkiwi://story/${storyId.toLowerCase()}` : null,
  };
}

export class UnavailablePushSender implements PushSender {
  async send(): Promise<PushResult> {
    return 'unavailable';
  }
}

/** Sends each platform through its own provider. Platforms without one get "unavailable". */
export class RoutingPushSender implements PushSender {
  constructor(private readonly routes: Partial<Record<PushPlatform, PushSender>>) {}

  async send(target: PushTarget, payload: PushPayload): Promise<PushResult> {
    const route = this.routes[target.platform];
    return route ? route.send(target, payload) : 'unavailable';
  }

  /** Which platforms can actually send right now. */
  status(): { android: boolean; ios: boolean; available: boolean } {
    const android = Boolean(this.routes.android);
    const ios = Boolean(this.routes.ios);
    return { android, ios, available: android || ios };
  }
}

export interface PushDeps {
  fetchImpl?: FetchLike;
  apnsTransport?: ApnsTransport;
  now?: () => number;
}

/** Builds the sender from environment variables. Missing credentials leave that platform unavailable. */
export function createPushSender(env: NodeJS.ProcessEnv = process.env, deps: PushDeps = {}): RoutingPushSender {
  const routes: Partial<Record<PushPlatform, PushSender>> = {};

  const fcmJson = env.FCM_SERVICE_ACCOUNT_JSON?.trim() || (env.FCM_SERVICE_ACCOUNT_FILE ? readFileSync(env.FCM_SERVICE_ACCOUNT_FILE, 'utf8') : '');
  if (fcmJson) {
    routes.android = new FcmSender(parseServiceAccount(fcmJson), deps.fetchImpl, deps.now);
  }

  const { APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_PRIVATE_KEY } = env;
  if (APNS_KEY_ID && APNS_TEAM_ID && APNS_BUNDLE_ID && APNS_PRIVATE_KEY) {
    routes.ios = new ApnsSender(
      {
        keyId: APNS_KEY_ID,
        teamId: APNS_TEAM_ID,
        bundleId: APNS_BUNDLE_ID,
        privateKey: APNS_PRIVATE_KEY.replace(/\\n/g, '\n'),
        production: env.APNS_PRODUCTION === 'true',
      },
      deps.apnsTransport ?? http2Transport(),
      deps.now
    );
  }
  return new RoutingPushSender(routes);
}
