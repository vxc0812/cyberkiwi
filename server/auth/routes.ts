/**
 * Account routes (mounted at /api/auth).
 *
 *   POST   /register          invite code + email + password. Does not sign the user in.
 *   POST   /login             web: sets the session cookie. client:"native": returns access and refresh tokens.
 *   POST   /refresh           native only: rotates the refresh token and returns a new access token.
 *   POST   /logout            revokes the current session and clears the cookie.
 *   GET    /me                the signed-in user.
 *   GET    /sessions          active sessions of the signed-in user.
 *   DELETE /sessions/:id      revokes one of the user's own sessions.
 *
 * Token responses carry Cache-Control: no-store. Login errors never say whether an email exists.
 */
import { Router, type Request, type Response } from 'express';
import { Prisma, type PrismaClient } from '../../generated/prisma/client';
import { hashPassword, normalizeEmail, passwordProblem, verifyAgainstDummy, verifyPassword } from './password';
import { redeemInvite, plausibleInviteCode } from './invites';
import {
  createSession,
  listActiveSessions,
  revokeSession,
  rotateCsrfToken,
  rotateRefreshToken,
  WEB_SESSION_TTL_MS,
} from './session';
import { clearSessionCookieHeader, principalOf, requireUser, sessionCookieHeader } from './middleware';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID_LOGIN = 'Invalid email or password';

class InviteRejected extends Error {}

function tokenResponse(res: Response, issued: { token: string; expiresAt: Date; refreshToken?: string; refreshExpiresAt?: Date }) {
  res.set('Cache-Control', 'no-store');
  return {
    accessToken: issued.token,
    accessExpiresAt: issued.expiresAt.toISOString(),
    refreshToken: issued.refreshToken,
    refreshExpiresAt: issued.refreshExpiresAt?.toISOString(),
  };
}

export function createAuthRouter(db: PrismaClient, options: { secureCookies: boolean }): Router {
  const router = Router();

  router.post('/register', async (req: Request, res: Response) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ success: false, error: 'A valid email is required' });
    const problem = passwordProblem(req.body?.password);
    if (problem) return res.status(400).json({ success: false, error: problem });
    const code = req.body?.inviteCode;
    if (!plausibleInviteCode(code)) return res.status(400).json({ success: false, error: 'Invite code is not valid' });

    try {
      const passwordHash = await hashPassword(req.body.password);
      const user = await db.$transaction(async (tx) => {
        const inviteId = await redeemInvite(tx, code);
        if (!inviteId) throw new InviteRejected();
        return tx.user.create({ data: { email, passwordHash, inviteId }, select: { id: true, email: true } });
      });
      return res.status(201).json({ success: true, user });
    } catch (err) {
      if (err instanceof InviteRejected) {
        return res.status(400).json({ success: false, error: 'Invite code is not valid' });
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Same message whether the email exists or the invite was spent: no account enumeration.
        return res.status(400).json({ success: false, error: 'Registration could not be completed' });
      }
      console.error('[auth] register failed:', (err as Error).message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  router.post('/login', async (req: Request, res: Response) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    const native = req.body?.client === 'native';
    if (!email || typeof password !== 'string' || password.length > 256) {
      return res.status(401).json({ success: false, error: INVALID_LOGIN });
    }

    const user = await db.user.findUnique({
      where: { email },
      select: { id: true, email: true, role: true, status: true, passwordHash: true },
    });
    const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyAgainstDummy(password);
    if (!user || !ok || user.status !== 'ACTIVE') {
      return res.status(401).json({ success: false, error: INVALID_LOGIN });
    }

    const now = new Date();
    const issued = await createSession(db, {
      userId: user.id,
      kind: native ? 'NATIVE' : 'WEB',
      userAgent: req.get('user-agent') ?? null,
      now,
    });
    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
    const account = { id: user.id, email: user.email, role: user.role };

    if (native) {
      return res.json({ success: true, user: account, ...tokenResponse(res, issued) });
    }
    res.set('Cache-Control', 'no-store');
    res.append('Set-Cookie', sessionCookieHeader(issued.token, Math.floor(WEB_SESSION_TTL_MS / 1000), options.secureCookies));
    // The CSRF token is returned once, in the body. Web pages keep it in memory and send it in X-CSRF-Token.
    return res.json({ success: true, user: account, csrfToken: issued.csrfToken });
  });

  router.post('/refresh', async (req: Request, res: Response) => {
    const outcome = await rotateRefreshToken(db, req.body?.refreshToken);
    if (!outcome.ok) {
      res.set('Cache-Control', 'no-store');
      return res.status(401).json({ success: false, error: 'Session expired. Sign in again.' });
    }
    return res.json({ success: true, ...tokenResponse(res, outcome.issued) });
  });

  router.post('/logout', async (_req: Request, res: Response) => {
    const principal = principalOf(res);
    if (principal) await revokeSession(db, principal.sessionId);
    res.append('Set-Cookie', clearSessionCookieHeader(options.secureCookies));
    return res.json({ success: true });
  });

  /** Issues a new CSRF token for the current session. The previous one stops working immediately. */
  router.get('/csrf', requireUser, async (_req: Request, res: Response) => {
    const p = principalOf(res)!;
    const csrfToken = await rotateCsrfToken(db, p.sessionId);
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, csrfToken });
  });

  router.get('/me', requireUser, (_req: Request, res: Response) => {
    const p = principalOf(res)!;
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, user: { id: p.userId, email: p.email, role: p.role }, session: { id: p.sessionId, kind: p.kind } });
  });

  router.get('/sessions', requireUser, async (_req: Request, res: Response) => {
    const p = principalOf(res)!;
    const sessions = await listActiveSessions(db, p.userId);
    return res.json({
      success: true,
      currentSessionId: p.sessionId,
      sessions: sessions.map((s) => ({ ...s, current: s.id === p.sessionId })),
    });
  });

  router.delete('/sessions/:id', requireUser, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) return res.status(400).json({ success: false, error: 'Session id must be a UUID' });
    const p = principalOf(res)!;
    const result = await db.session.updateMany({
      where: { id, userId: p.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count !== 1) return res.status(404).json({ success: false, error: 'Session not found' });
    return res.json({ success: true });
  });

  return router;
}
