/**
 * Origin and CSRF checks for state-changing requests (POST, PUT, PATCH, DELETE).
 *
 * Two rules:
 * 1. If a request names an Origin, that origin must be the configured allowlist or a local origin.
 *    Anything else is refused before any handler runs.
 * 2. A request authenticated by the session cookie is ambient credential, so it must also carry the
 *    session's CSRF token in X-CSRF-Token. The token is random per session, issued at login, refresh and
 *    GET /api/auth/csrf. Only its SHA-256 is stored, and the comparison is constant time. Origin is
 *    checked as well, as a second layer, but it is not the protection on its own.
 *
 * Bearer-authenticated requests carry no ambient credential, so they skip rule 2.
 */
import type { NextFunction, Request, Response } from 'express';
import { isLocalDevOrigin } from '../originPolicy';
import { bearerToken, principalOf, readCookie, SESSION_COOKIE } from './middleware';
import { csrfTokenMatches } from './session';

export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OriginPolicy {
  /** Exact origins allowed in production, for example https://cyberkiwi.app. */
  allowedOrigins: readonly string[];
}

export function isAllowedOrigin(origin: string, policy: OriginPolicy): boolean {
  return policy.allowedOrigins.includes(origin) || isLocalDevOrigin(origin);
}

export function usesCookieCredentials(req: Request): boolean {
  return bearerToken(req) === null && readCookie(req.get('cookie'), SESSION_COOKIE) !== undefined;
}

export function requireSafeOrigin(policy: OriginPolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin = req.get('origin');
    if (origin !== undefined && !isAllowedOrigin(origin, policy)) {
      res.status(403).json({ success: false, error: 'Cross-origin request refused' });
      return;
    }

    if (usesCookieCredentials(req)) {
      if (origin === undefined) {
        res.status(403).json({ success: false, error: 'Origin header required' });
        return;
      }
      const principal = principalOf(res);
      if (!principal || !csrfTokenMatches(req.get(CSRF_HEADER) ?? '', principal.csrfHash)) {
        res.status(403).json({ success: false, error: 'CSRF token missing or invalid' });
        return;
      }
    }
    next();
  };
}
