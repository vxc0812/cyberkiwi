/**
 * CORS for the API.
 *
 * ALLOWED_ORIGIN is a comma-separated list of exact origins, for example:
 *   ALLOWED_ORIGIN=https://cyberkiwi.app,capacitor://localhost,https://localhost
 *
 * Origins are kept exactly as configured. They are never normalised through URL.origin, which returns
 * the string "null" for capacitor:// and would silently break the native apps. Each entry is validated
 * against a strict pattern instead: lower-case scheme and host, optional port, no path, no wildcard.
 *
 * A request gets CORS headers only when its Origin matches one entry exactly. Credentials are allowed
 * only for those origins. Development allows local origins (see originPolicy.ts).
 */
import type { NextFunction, Request, Response } from 'express';
import { isLocalDevOrigin } from '../originPolicy';

export const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
/** Headers the browser and native clients send. X-CSRF-Token is required on cookie-authenticated writes. */
export const ALLOWED_HEADERS = 'Content-Type, Authorization, X-CSRF-Token, X-User-AI-Key';

const ORIGIN_PATTERN = /^(?:https?|capacitor|ionic):\/\/(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/;

/**
 * Parses ALLOWED_ORIGIN. Returns the entries exactly as written (trimmed). Throws on anything that is not
 * an exact origin, so a typo cannot widen access. A trailing slash, an uppercase letter, a wildcard or a
 * path all fail, because a browser never sends them in an Origin header.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((value) => {
      if (value.includes('*')) throw new Error(`ALLOWED_ORIGIN entry is a wildcard: "${value}"`);
      if (!ORIGIN_PATTERN.test(value)) {
        throw new Error(`ALLOWED_ORIGIN entry is not an exact lower-case origin: "${value}"`);
      }
      return value;
    });
}

export interface CorsConfig {
  production: boolean;
  allowedOrigins: readonly string[];
}

/** The CORS headers for one request origin, or null when the origin gets no CORS grant. */
export function corsHeadersFor(origin: string | undefined, config: CorsConfig): Record<string, string> | null {
  if (!origin) return null;
  const allowed = config.production
    ? config.allowedOrigins.includes(origin)
    : isLocalDevOrigin(origin);
  if (!allowed) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

export function createCorsMiddleware(config: CorsConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const headers = corsHeadersFor(req.get('origin'), config);
    if (headers) {
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    } else {
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.status(headers ? 204 : 403).end();
      return;
    }
    next();
  };
}
