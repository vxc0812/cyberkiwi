/**
 * Account calls for the app: register, login, logout, restore and refresh.
 *
 * Web: the server sets an HttpOnly session cookie. The page never sees a token.
 * Native: the access token is kept in memory. The refresh token is kept in the Keychain/Keystore, or
 * in memory when no secure plugin is available (then the user signs in again after a restart).
 *
 * Refresh is single-flight, and the server rotates refresh tokens with a short grace window, so a
 * dropped response does not log the user out.
 */
import { Capacitor } from '@capacitor/core';
import { apiFetch, authedFetch, reloadCsrfToken, setAccessToken, setCsrfToken, setRefreshHandler } from './apiClient';
import { getSecureValuePort } from './aiKeyStoreFactory';

export interface AuthUser {
  id: string;
  email: string;
  role: 'USER' | 'ADMIN';
}

export class AuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AuthError';
  }
}

const REFRESH_KEY = 'cyberkiwi.refresh-token';
let memoryRefresh: string | null = null;
let refreshing: Promise<boolean> | null = null;

async function saveRefresh(token: string): Promise<void> {
  memoryRefresh = token;
  const port = await getSecureValuePort();
  if (port) await port.set(REFRESH_KEY, token).catch(() => undefined);
}

async function loadRefresh(): Promise<string | null> {
  const port = await getSecureValuePort();
  if (port) {
    const stored = await port.get(REFRESH_KEY).catch(() => null);
    if (stored) return stored;
  }
  return memoryRefresh;
}

async function clearRefresh(): Promise<void> {
  memoryRefresh = null;
  const port = await getSecureValuePort();
  if (port) await port.remove(REFRESH_KEY).catch(() => undefined);
}

async function readError(res: Response, fallback: string): Promise<AuthError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new AuthError(body.error || fallback, res.status);
}

export async function register(email: string, password: string, inviteCode: string): Promise<AuthUser> {
  const res = await apiFetch('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, inviteCode }),
  });
  if (!res.ok) throw await readError(res, 'Registration could not be completed');
  const body = (await res.json()) as { user: AuthUser };
  return body.user;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const native = Capacitor.isNativePlatform();
  const res = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, client: native ? 'native' : 'web' }),
  });
  if (!res.ok) throw await readError(res, 'Invalid email or password');
  const body = (await res.json()) as { user: AuthUser; accessToken?: string; refreshToken?: string; csrfToken?: string };
  if (native && body.accessToken && body.refreshToken) {
    setAccessToken(body.accessToken);
    await saveRefresh(body.refreshToken);
  }
  // Web: the CSRF token arrives in the body, so writes can be sent straight away.
  if (!native) setCsrfToken(body.csrfToken ?? null);
  return body.user;
}

export async function logout(): Promise<void> {
  // Ends the server session and clears the cookie. Local state is cleared even if the call fails.
  await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  setAccessToken(null);
  setCsrfToken(null);
  await clearRefresh();
}

/** The signed-in user, or null. Uses authedFetch, so an expired access token is refreshed once. */
export async function fetchMe(): Promise<AuthUser | null> {
  const res = await authedFetch('/api/auth/me');
  if (!res.ok) return null;
  const body = (await res.json()) as { user: AuthUser };
  // Web: load the session's CSRF token once the session is confirmed.
  if (!Capacitor.isNativePlatform()) await reloadCsrfToken();
  return body.user;
}

/** Native only. Rotates the refresh token. Concurrent calls share one request. */
export function refreshSession(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve(false);
  refreshing ??= (async () => {
    try {
      const token = await loadRefresh();
      if (!token) return false;
      const res = await apiFetch('/api/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: token }),
      });
      if (!res.ok) {
        setAccessToken(null);
        await clearRefresh();
        return false;
      }
      const body = (await res.json()) as { accessToken: string; refreshToken: string };
      setAccessToken(body.accessToken);
      await saveRefresh(body.refreshToken);
      return true;
    } catch {
      // A network failure is not a sign-out. Keep the refresh token and let the next attempt retry.
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Startup: on native, rotate the refresh token first; then ask who is signed in. */
export async function restoreSession(): Promise<AuthUser | null> {
  if (Capacitor.isNativePlatform()) {
    const ok = await refreshSession();
    if (!ok) return null;
  }
  return fetchMe();
}

setRefreshHandler(refreshSession);
