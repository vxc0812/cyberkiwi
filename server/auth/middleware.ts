/**
 * Credential handling for the API: cookie and bearer tokens, the session cookie, and the guards that
 * require a signed-in user or a role.
 *
 * attachSession never rejects an anonymous request. It only records who is calling, in res.locals.
 * Route guards (requireUser, requireRole) decide what an anonymous or under-privileged caller may do.
 */
import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '../../generated/prisma/client';
import { resolveAccessToken, type Principal } from './session';

export const SESSION_COOKIE = 'ck_session';
export const PRINCIPAL_LOCAL = 'principal';

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim() || undefined;
  }
  return undefined;
}

/** The bearer token from `Authorization: Bearer <token>`, or null. Other schemes are ignored. */
export function bearerToken(req: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
  return match ? match[1] : null;
}

/** Set-Cookie value for the browser session. HttpOnly and SameSite=Lax always; Secure outside development. */
export function sessionCookieHeader(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookieHeader(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** Credentials presented on this request, in the order they are tried. */
function candidateTokens(req: Request): string[] {
  const out: string[] = [];
  const bearer = bearerToken(req);
  if (bearer) out.push(bearer);
  const cookie = readCookie(req.get('cookie'), SESSION_COOKIE);
  if (cookie) out.push(cookie);
  return out;
}

export function attachSession(db: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      for (const token of candidateTokens(req)) {
        const principal = await resolveAccessToken(db, token);
        if (principal) {
          res.locals[PRINCIPAL_LOCAL] = principal;
          break;
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function principalOf(res: Response): Principal | null {
  return (res.locals[PRINCIPAL_LOCAL] as Principal | undefined) ?? null;
}

export function requireUser(_req: Request, res: Response, next: NextFunction): void {
  if (!principalOf(res)) {
    res.status(401).json({ success: false, error: 'Sign in required' });
    return;
  }
  next();
}

export function requireRole(role: 'ADMIN') {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const principal = principalOf(res);
    if (!principal) {
      res.status(401).json({ success: false, error: 'Sign in required' });
      return;
    }
    if (principal.role !== role) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    next();
  };
}
