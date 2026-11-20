/**
 * The one place the client calls the CyberKiwi API from.
 *
 * - apiFetch: one request with credentials (cookies), the CSRF header and the in-memory access token.
 * - authedFetch: apiFetch plus one refresh and one retry on a 401 (see authRequest.ts).
 * - authedFetchUrl: the same for a caller that already built an absolute URL (the story read client).
 *
 * Native access tokens live in memory only. Refresh tokens live in the Keychain/Keystore (see authClient.ts).
 * Nothing auth-related is written to localStorage, sessionStorage or a URL.
 */
import { Capacitor } from '@capacitor/core';
import { configuredApiBaseUrl } from './cyberkiwiApi';
import { createAuthenticatedRequest } from './authRequest';

export const CSRF_HEADER = 'X-CSRF-Token';

let accessToken: string | null = null;
/** Web only: the session's CSRF token, kept in memory. It is never written to storage. */
let csrfToken: string | null = null;
let refreshHandler: () => Promise<boolean> = async () => false;
const sessionLostListeners = new Set<() => void>();

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Sets or clears the in-memory access token of a native session. Pass null on logout. */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function hasAccessToken(): boolean {
  return accessToken !== null;
}

/** authClient registers its refresh here, which keeps this module free of an import cycle. */
export function setRefreshHandler(handler: () => Promise<boolean>): void {
  refreshHandler = handler;
}

export function onSessionLost(listener: () => void): () => void {
  sessionLostListeners.add(listener);
  return () => sessionLostListeners.delete(listener);
}

/** Base URL of the API. Empty on the web, where the page and the API share an origin. */
export const getApiBaseUrl = (): string => {
  if (typeof window !== 'undefined') {
    if (
      window.location.protocol === 'tauri:' ||
      window.location.origin.includes('tauri.localhost') ||
      Boolean((window as any).__TAURI_INTERNALS__) ||
      Boolean((window as any).__TAURI__)
    ) {
      return 'http://127.0.0.1:3000';
    }
  }
  return '';
};

/**
 * Native apps run from a local origin, so they must use the configured API address. The web keeps
 * same-origin requests, as before.
 */
export function resolveApiBase(): string {
  if (Capacitor.isNativePlatform()) {
    return configuredApiBaseUrl((import.meta as any).env ?? {}, true) ?? getApiBaseUrl();
  }
  return getApiBaseUrl();
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Reloads the web session's CSRF token from the server. Returns false when there is no session. */
async function reloadCsrfToken(): Promise<boolean> {
  const res = await fetch(`${resolveApiBase()}/api/auth/csrf`, { credentials: 'include', headers: { Accept: 'application/json' } });
  if (!res.ok) return false;
  const body = (await res.json()) as { csrfToken?: string };
  csrfToken = body.csrfToken ?? null;
  return csrfToken !== null;
}

/**
 * One request with the session and CSRF rules applied. A caller's own Authorization header wins.
 * A refused write (CSRF token out of date, for example after another tab rotated it) reloads the token
 * and retries the write once.
 */
export async function apiFetch(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const headers = new Headers(init.headers);
  if (csrfToken) headers.set(CSRF_HEADER, csrfToken);
  if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  const res = await fetch(`${resolveApiBase()}${path}`, { ...init, headers, credentials: 'include' });
  const method = (init.method ?? 'GET').toUpperCase();
  if (res.status === 403 && UNSAFE.has(method) && !retried && csrfToken !== null) {
    if (await reloadCsrfToken()) return apiFetch(path, init, true);
  }
  return res;
}

export { reloadCsrfToken };

function sessionLost(): void {
  accessToken = null;
  sessionLostListeners.forEach((listener) => listener());
}

/** apiFetch with one refresh and one retry on 401. Use this for anything that needs a signed-in user. */
export const authedFetch = createAuthenticatedRequest({
  fetchOnce: (path, init) => apiFetch(path, init),
  refresh: () => refreshHandler(),
  onSessionLost: sessionLost,
});

/**
 * A signed-in GET to an absolute URL: session cookie, the in-memory access token, and one refresh and
 * retry on 401. Story and article reads are invite-only, and the read client builds its own URLs.
 */
export const authedFetchUrl = createAuthenticatedRequest({
  fetchOnce: (url, init) => {
    const headers = new Headers(init.headers);
    if (accessToken && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${accessToken}`);
    return fetch(url, { ...init, headers, credentials: 'include' });
  },
  refresh: () => refreshHandler(),
  onSessionLost: sessionLost,
});
