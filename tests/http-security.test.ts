import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createCorsMiddleware, corsHeadersFor, parseAllowedOrigins } from '../server/http/cors';
import { requireSafeOrigin, usesCookieCredentials, CSRF_HEADER } from '../server/auth/csrf';
import { readCookie, sessionCookieHeader, clearSessionCookieHeader, SESSION_COOKIE, bearerToken } from '../server/auth/middleware';
import { sha256Hex } from '../server/auth/session';

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✅ [PASS] ${name}`);
  } catch (err: any) {
    failures++;
    console.log(`❌ [FAIL] ${name}: ${err?.message ?? err}`);
  }
}

const PROD_ORIGIN = 'https://cyberkiwi.app';
const NATIVE_IOS = 'capacitor://localhost';
const PROD = { production: true, allowedOrigins: [PROD_ORIGIN, NATIVE_IOS] };
const DEV = { production: false, allowedOrigins: [] as string[] };
const POLICY = { allowedOrigins: [PROD_ORIGIN, NATIVE_IOS] };

/** A small app that uses the same middleware as server.ts, on a random local port. */
async function startApp(config: { production: boolean; allowedOrigins: string[] }): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(createCorsMiddleware(config));
  // A stand-in for attachSession: the cookie value "abc" is a session whose CSRF token is "good-csrf".
  app.use((req, res, next) => {
    if (readCookie(req.get('cookie'), SESSION_COOKIE) === 'abc') {
      res.locals.principal = { sessionId: 's', userId: 'u', email: 'e@x.y', role: 'USER', kind: 'WEB', csrfHash: sha256Hex('good-csrf') };
    }
    next();
  });
  app.use('/api/', requireSafeOrigin({ allowedOrigins: config.allowedOrigins }));
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));
  app.post('/api/echo', (req, res) => res.json({ ok: true, body: req.body }));
  app.delete('/api/thing', (_req, res) => res.json({ ok: true }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function main(): Promise<void> {
  await check('origins: ALLOWED_ORIGIN accepts exact origins, comma-separated, and rejects wildcards and paths', () => {
    assert.deepEqual(parseAllowedOrigins('https://cyberkiwi.app,capacitor://localhost,https://localhost'), ['https://cyberkiwi.app', 'capacitor://localhost', 'https://localhost']);
    assert.deepEqual(parseAllowedOrigins(' https://cyberkiwi.app , http://127.0.0.1:3000 '), ['https://cyberkiwi.app', 'http://127.0.0.1:3000'], 'entries are trimmed, otherwise kept exactly');
    assert.throws(() => parseAllowedOrigins('https://cyberkiwi.app/'), /exact lower-case origin/, 'trailing slash never appears in an Origin header');
    assert.throws(() => parseAllowedOrigins('https://CyberKiwi.app'), /exact lower-case origin/, 'uppercase would never match a browser Origin');
    assert.deepEqual(parseAllowedOrigins(undefined), []);
    assert.throws(() => parseAllowedOrigins('*'), /wildcard/);
    assert.throws(() => parseAllowedOrigins('https://*.cyberkiwi.app'), /wildcard/);
    assert.throws(() => parseAllowedOrigins('https://cyberkiwi.app/path'), /exact lower-case origin/);
    assert.throws(() => parseAllowedOrigins('ftp://cyberkiwi.app'), /exact lower-case origin/);
  });

  await check('production CORS: the allowed origin gets itself back with credentials, never a wildcard', () => {
    const h = corsHeadersFor(PROD_ORIGIN, PROD);
    assert.ok(h);
    assert.equal(h!['Access-Control-Allow-Origin'], PROD_ORIGIN);
    assert.equal(h!['Access-Control-Allow-Credentials'], 'true');
    assert.notEqual(h!['Access-Control-Allow-Origin'], '*');
  });

  await check('production CORS: other origins, including local ones, get no CORS grant', () => {
    assert.equal(corsHeadersFor('https://evil.example', PROD), null);
    assert.equal(corsHeadersFor('http://localhost:5173', PROD), null, 'local origins are development only');
    assert.equal(corsHeadersFor(undefined, PROD), null);
  });

  await check('CORS: the allowlist includes X-User-AI-Key and X-CSRF-Token so BYOK and CSRF preflights pass', () => {
    const h = corsHeadersFor(PROD_ORIGIN, PROD)!;
    const allowed = h['Access-Control-Allow-Headers'].split(',').map((s) => s.trim().toLowerCase());
    assert.ok(allowed.includes('x-user-ai-key'));
    assert.ok(allowed.includes('x-csrf-token'));
    assert.ok(allowed.includes('content-type'));
    assert.ok(allowed.includes('authorization'));
    assert.ok(h['Access-Control-Allow-Methods'].includes('DELETE'));
    assert.ok(h['Access-Control-Allow-Methods'].includes('PUT'));
  });

  const prod = await startApp(PROD);
  try {
    await check('BYOK preflight over HTTP: allowed origin gets 204 with credentials and X-User-AI-Key allowed', async () => {
      const res = await fetch(`${prod.base}/api/echo`, {
        method: 'OPTIONS',
        headers: {
          Origin: PROD_ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type, x-user-ai-key, x-csrf-token',
        },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), PROD_ORIGIN);
      assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
      assert.match(res.headers.get('access-control-allow-headers') ?? '', /X-User-AI-Key/);
    });

    await check('preflight from a foreign origin is refused and gets no allow-origin header', async () => {
      const res = await fetch(`${prod.base}/api/echo`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    });

    await check('native origin from the allowlist is accepted (capacitor://localhost)', async () => {
      const res = await fetch(`${prod.base}/api/ping`, { headers: { Origin: NATIVE_IOS } });
      assert.equal(res.headers.get('access-control-allow-origin'), NATIVE_IOS);
    });

    await check('a POST from a foreign origin is refused before the handler runs', async () => {
      const res = await fetch(`${prod.base}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ x: 1 }),
      });
      assert.equal(res.status, 403);
    });

    await check('a cookie-authenticated POST without the CSRF header is refused', async () => {
      const res = await fetch(`${prod.base}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: PROD_ORIGIN, Cookie: `${SESSION_COOKIE}=abc` },
        body: JSON.stringify({ x: 1 }),
      });
      assert.equal(res.status, 403);
      assert.match((await res.json()).error, /CSRF/);
    });

    await check('a cookie-authenticated POST without an Origin header is refused', async () => {
      const res = await fetch(`${prod.base}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=abc`, [CSRF_HEADER]: 'x' },
        body: JSON.stringify({ x: 1 }),
      });
      assert.equal(res.status, 403);
    });

    await check('a cookie-authenticated DELETE with Origin and the CSRF header passes', async () => {
      const res = await fetch(`${prod.base}/api/thing`, {
        method: 'DELETE',
        headers: { Origin: PROD_ORIGIN, Cookie: `${SESSION_COOKIE}=abc`, [CSRF_HEADER]: 'good-csrf' },
      });
      assert.equal(res.status, 200);
    });

    await check('CSRF token: a cookie write with a wrong token is refused even with Origin set', async () => {
      const res = await fetch(`${prod.base}/api/thing`, {
        method: 'DELETE',
        headers: { Origin: PROD_ORIGIN, Cookie: `${SESSION_COOKIE}=abc`, [CSRF_HEADER]: 'x' },
      });
      assert.equal(res.status, 403);
    });

    await check('a bearer-authenticated POST needs no CSRF header (no ambient credential)', async () => {
      const res = await fetch(`${prod.base}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer some-token' },
        body: JSON.stringify({ x: 1 }),
      });
      assert.equal(res.status, 200);
    });

    await check('a request with no credentials and no Origin is allowed through (no ambient authority)', async () => {
      const res = await fetch(`${prod.base}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: 1 }),
      });
      assert.equal(res.status, 200);
    });

    await check('GET requests are not subject to the state-change checks', async () => {
      const res = await fetch(`${prod.base}/api/ping`, { headers: { Origin: 'https://evil.example', Cookie: `${SESSION_COOKIE}=abc` } });
      assert.equal(res.status, 200);
    });
  } finally {
    await prod.close();
  }

  const dev = await startApp(DEV);
  try {
    await check('development CORS: a local origin is allowed with credentials, a remote one is not', async () => {
      const ok = await fetch(`${dev.base}/api/ping`, { headers: { Origin: 'http://localhost:5173' } });
      assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
      const no = await fetch(`${dev.base}/api/ping`, { headers: { Origin: 'https://evil.example' } });
      assert.equal(no.headers.get('access-control-allow-origin'), null);
    });
  } finally {
    await dev.close();
  }

  await check('cookies: HttpOnly and SameSite=Lax always; Secure only when production sets it', () => {
    const prodCookie = sessionCookieHeader('tok', 60, true);
    assert.match(prodCookie, /HttpOnly/);
    assert.match(prodCookie, /SameSite=Lax/);
    assert.match(prodCookie, /; Secure/);
    const devCookie = sessionCookieHeader('tok', 60, false);
    assert.doesNotMatch(devCookie, /Secure/);
    assert.match(clearSessionCookieHeader(true), /Max-Age=0/);
  });

  await check('cookies: the session value is read by exact name, not by substring', () => {
    assert.equal(readCookie(`a=1; ${SESSION_COOKIE}=tok123; b=2`, SESSION_COOKIE), 'tok123');
    assert.equal(readCookie(`x${SESSION_COOKIE}=nope`, SESSION_COOKIE), undefined);
    assert.equal(readCookie(undefined, SESSION_COOKIE), undefined);
  });

  await check('bearer: only the Bearer scheme is read', () => {
    const fake = (auth?: string) => ({ get: (n: string) => (n.toLowerCase() === 'authorization' ? auth : undefined) }) as any;
    assert.equal(bearerToken(fake('Bearer abc')), 'abc');
    assert.equal(bearerToken(fake('Basic abc')), null);
    assert.equal(bearerToken(fake(undefined)), null);
    assert.equal(usesCookieCredentials(fake('Bearer abc')), false);
  });

  if (failures > 0) {
    console.log(`\n${failures} HTTP security check(s) failed.`);
    process.exitCode = 1;
  }
}

main();
