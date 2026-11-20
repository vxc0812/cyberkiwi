/**
 * Server-side sessions.
 *
 * - WEB: one opaque token, kept in a Secure, HttpOnly, SameSite=Lax cookie for 30 days.
 * - NATIVE: a 15-minute access token (kept in memory by the app) and a 30-day refresh token (kept in
 *   the Keychain/Keystore). Each refresh rotates both. Presenting a refresh token that was already
 *   rotated is treated as theft and revokes the session.
 *
 * Only SHA-256 hashes of tokens are stored. A database leak does not yield usable sessions.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { PrismaClient } from '../../generated/prisma/client';

export const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const NATIVE_ACCESS_TTL_MS = 15 * 60 * 1000;
export const NATIVE_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TOKEN_LENGTH = 256;
/** How long a replaced refresh token still works, so a lost response does not log the user out. */
export const REFRESH_GRACE_MS = 60 * 1000;

export type SessionKind = 'WEB' | 'NATIVE';

export interface Principal {
  sessionId: string;
  userId: string;
  email: string;
  role: 'USER' | 'ADMIN';
  kind: SessionKind;
  /** Hash of the session's CSRF token, or null for sessions created before CSRF tokens existed. */
  csrfHash: string | null;
}

export interface IssuedSession {
  sessionId: string;
  token: string;
  expiresAt: Date;
  refreshToken?: string;
  refreshExpiresAt?: Date;
  /** Raw CSRF token. Returned once to the client; only its hash is stored. */
  csrfToken: string;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function createSession(
  db: PrismaClient,
  input: { userId: string; kind: SessionKind; userAgent?: string | null; deviceId?: string | null; now?: Date }
): Promise<IssuedSession> {
  const now = input.now ?? new Date();
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + (input.kind === 'WEB' ? WEB_SESSION_TTL_MS : NATIVE_ACCESS_TTL_MS));

  let refreshToken: string | undefined;
  let refreshExpiresAt: Date | undefined;
  if (input.kind === 'NATIVE') {
    refreshToken = randomToken();
    refreshExpiresAt = new Date(now.getTime() + NATIVE_REFRESH_TTL_MS);
  }

  const csrfToken = randomToken();
  const row = await db.session.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      csrfHash: sha256Hex(csrfToken),
      tokenHash: sha256Hex(token),
      expiresAt,
      refreshHash: refreshToken ? sha256Hex(refreshToken) : null,
      refreshExpiresAt: refreshExpiresAt ?? null,
      deviceId: input.deviceId ?? null,
      userAgent: input.userAgent ? input.userAgent.slice(0, 200) : null,
      createdAt: now,
      lastSeenAt: now,
    },
    select: { id: true },
  });

  return { sessionId: row.id, token, expiresAt, refreshToken, refreshExpiresAt, csrfToken };
}

/** Resolves a cookie or access token to an active session. Returns null for anything else. */
export async function resolveAccessToken(db: PrismaClient, token: string, now: Date = new Date()): Promise<Principal | null> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const row = await db.session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { user: { select: { id: true, email: true, role: true, status: true } } },
  });
  if (!row || row.revokedAt || row.expiresAt <= now) return null;
  if (row.user.status !== 'ACTIVE') return null;

  if (now.getTime() - row.lastSeenAt.getTime() > LAST_SEEN_WRITE_INTERVAL_MS) {
    await db.session.update({ where: { id: row.id }, data: { lastSeenAt: now } }).catch(() => undefined);
  }
  return { sessionId: row.id, userId: row.user.id, email: row.user.email, role: row.user.role, kind: row.kind, csrfHash: row.csrfHash ?? null };
}

export type RefreshOutcome =
  | { ok: true; issued: IssuedSession & { refreshToken: string; refreshExpiresAt: Date } }
  | { ok: false; reason: 'invalid' | 'reused' };

/**
 * Rotates a native refresh token. The update is a compare-and-swap on the current refresh hash, so two
 * concurrent refreshes with the same token cannot both succeed.
 *
 * Grace window: the token that a rotation replaced stays usable for REFRESH_GRACE_MS. A response that was
 * lost on the way back to the client therefore does not log the user out. After the window, presenting a
 * replaced token is treated as theft and revokes the session.
 */
export async function rotateRefreshToken(db: PrismaClient, refreshToken: string, now: Date = new Date()): Promise<RefreshOutcome> {
  if (!refreshToken || refreshToken.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'invalid' };
  const hash = sha256Hex(refreshToken);

  let row = await db.session.findUnique({
    where: { refreshHash: hash },
    include: { user: { select: { status: true } } },
  });
  if (!row) {
    const replaced = await db.session.findUnique({
      where: { previousRefreshHash: hash },
      include: { user: { select: { status: true } } },
    });
    if (!replaced || replaced.revokedAt) return { ok: false, reason: 'invalid' };
    const withinGrace =
      replaced.refreshRotatedAt !== null && now.getTime() - replaced.refreshRotatedAt.getTime() <= REFRESH_GRACE_MS;
    if (!withinGrace) {
      await db.session.update({ where: { id: replaced.id }, data: { revokedAt: now } });
      return { ok: false, reason: 'reused' };
    }
    // The client never received the last rotation. Issue a fresh pair from the current token.
    row = replaced;
  }
  if (row.revokedAt || !row.refreshExpiresAt || row.refreshExpiresAt <= now || row.user.status !== 'ACTIVE') {
    return { ok: false, reason: 'invalid' };
  }

  const token = randomToken();
  const nextRefresh = randomToken();
  const expiresAt = new Date(now.getTime() + NATIVE_ACCESS_TTL_MS);
  const refreshExpiresAt = new Date(now.getTime() + NATIVE_REFRESH_TTL_MS);
  const current = row.refreshHash;
  const csrfToken = randomToken();
  const swapped = await db.session.updateMany({
    where: { id: row.id, refreshHash: current, revokedAt: null },
    data: {
      csrfHash: sha256Hex(csrfToken),
      tokenHash: sha256Hex(token),
      expiresAt,
      refreshHash: sha256Hex(nextRefresh),
      previousRefreshHash: current,
      refreshRotatedAt: now,
      refreshExpiresAt,
      lastSeenAt: now,
    },
  });
  if (swapped.count !== 1) return { ok: false, reason: 'invalid' };

  return {
    ok: true,
    issued: { sessionId: row.id, token, expiresAt, refreshToken: nextRefresh, refreshExpiresAt, csrfToken },
  };
}

/**
 * Issues a new CSRF token for a session and stores its hash. The previous token stops working at once.
 * Called at login, on refresh, and by GET /api/auth/csrf. Clients reload the token when a write is refused.
 */
export async function rotateCsrfToken(db: PrismaClient, sessionId: string): Promise<string> {
  const token = randomToken();
  await db.session.update({ where: { id: sessionId }, data: { csrfHash: sha256Hex(token) } });
  return token;
}

/** True when the presented CSRF token matches the session's stored hash. Compared in constant time. */
export function csrfTokenMatches(presented: string, storedHash: string | null): boolean {
  if (!storedHash || !presented || presented.length > 256) return false;
  const a = Buffer.from(sha256Hex(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function revokeSession(db: PrismaClient, sessionId: string, now: Date = new Date()): Promise<void> {
  await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } });
}

/** Revokes every session of a user, optionally keeping the caller's current one. */
export async function revokeAllSessions(
  db: PrismaClient,
  userId: string,
  options: { now?: Date; exceptSessionId?: string } = {}
): Promise<number> {
  const result = await db.session.updateMany({
    where: { userId, revokedAt: null, ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}) },
    data: { revokedAt: options.now ?? new Date() },
  });
  return result.count;
}

export interface SessionSummary {
  id: string;
  kind: SessionKind;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  deviceId: string | null;
}

/** Active sessions for one user. Token hashes are never selected. */
export async function listActiveSessions(db: PrismaClient, userId: string, now: Date = new Date()): Promise<SessionSummary[]> {
  return db.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, kind: true, createdAt: true, lastSeenAt: true, expiresAt: true, userAgent: true, deviceId: true },
  });
}
