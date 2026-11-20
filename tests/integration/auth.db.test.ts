/**
 * Integration tests for accounts, sessions, admin, devices, and AI quotas against PostgreSQL.
 * Run with npm run test:db (refuses to run unless the database name ends in _test).
 */
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createPrisma, databaseUrl } from '../../server/db/client';
import { attachSession } from '../../server/auth/middleware';
import { requireSafeOrigin, CSRF_HEADER } from '../../server/auth/csrf';
import { createAuthRouter } from '../../server/auth/routes';
import { createAdminRouter } from '../../server/auth/adminRoutes';
import { createDevicesRouter } from '../../server/devices/routes';
import { createCorsMiddleware } from '../../server/http/cors';
import { createInvite, revokeInvite } from '../../server/auth/invites';
import { hashPassword, verifyPassword } from '../../server/auth/password';
import { createSession, revokeSession, sha256Hex } from '../../server/auth/session';
import { requireAiCaller, fingerprintKey, BYOK_HEADER } from '../../server/aiGuard';
import { consumeQuota } from '../../server/aiQuota';

const url = databaseUrl();
const dbName = new URL(url).pathname.replace(/^\//, '');
if (!dbName.endsWith('_test')) {
  console.error(`Refusing to run: database "${dbName}" does not end in "_test".`);
  process.exit(1);
}

const db = createPrisma(url);
const ORIGIN = 'https://cyberkiwi.app';
const PASSWORD = 'correct horse battery staple';
let failures = 0;
let base = '';
let server: Server;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✅ [PASS] ${name}`);
  } catch (err: any) {
    failures++;
    console.log(`❌ [FAIL] ${name}: ${err?.message ?? err}`);
  }
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createCorsMiddleware({ production: true, allowedOrigins: [ORIGIN] }));
  app.use('/api/', attachSession(db));
  app.use('/api/', requireSafeOrigin({ allowedOrigins: [ORIGIN] }));
  app.use('/api/auth', createAuthRouter(db, { secureCookies: true }));
  app.use('/api/admin', createAdminRouter(db));
  app.use('/api/devices', createDevicesRouter(db));
  app.post(
    '/api/probe-ai',
    requireAiCaller({ db, platformKeyConfigured: () => true, limits: { byokPerDay: 2, userPerDay: 100, platformPerDay: 100 } }),
    (req, res) => res.json({ kind: res.locals.aiCaller.kind, headerSeen: req.headers[BYOK_HEADER] ?? null })
  );
  return app;
}

interface Reply {
  status: number;
  json: any;
  text: string;
  headers: Headers;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<Reply> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? safeJson(text) : null, text, headers: res.headers };
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Headers a browser sends for a cookie-authenticated state change. */
function cookieWrite(cookie: string, csrf: string): Record<string, string> {
  return { Origin: ORIGIN, Cookie: cookie, [CSRF_HEADER]: csrf };
}

function sessionCookieFrom(reply: Reply): string {
  const raw = reply.headers.getSetCookie().find((c) => c.startsWith('ck_session='));
  assert.ok(raw, 'login sets the session cookie');
  return raw!.split(';')[0];
}

async function resetDatabase(): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE "Session", "Device", "InviteCode", "User", "AiQuotaUsage" RESTART IDENTITY CASCADE');
}

async function newInvite(opts: { maxUses?: number; expiresInDays?: number; now?: Date } = {}): Promise<string> {
  return (await createInvite(db, { maxUses: opts.maxUses ?? 1, expiresInDays: opts.expiresInDays ?? 14, now: opts.now })).code;
}

async function register(email: string, code: string, password = PASSWORD): Promise<Reply> {
  return call('POST', '/api/auth/register', { body: { email, password, inviteCode: code } });
}

async function loginNative(email: string, password = PASSWORD): Promise<Reply> {
  return call('POST', '/api/auth/login', { body: { email, password, client: 'native' } });
}

async function makeUser(email: string, role: 'USER' | 'ADMIN' = 'USER'): Promise<string> {
  const code = await newInvite();
  const reply = await register(email, code);
  assert.equal(reply.status, 201, `register ${email}: ${reply.text}`);
  if (role === 'ADMIN') await db.user.update({ where: { email }, data: { role: 'ADMIN' } });
  return reply.json.user.id;
}

async function main(): Promise<void> {
  const server_ = buildApp();
  server = await new Promise<Server>((resolve) => {
    const s = server_.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    await resetDatabase();

    await check('password: hashes verify, a wrong password fails, and a malformed stored value fails safely', async () => {
      const stored = await hashPassword(PASSWORD);
      assert.match(stored, /^scrypt\$16384\$8\$1\$/);
      assert.equal(await verifyPassword(PASSWORD, stored), true);
      assert.equal(await verifyPassword('wrong password here', stored), false);
      assert.equal(await verifyPassword(PASSWORD, 'not-a-hash'), false);
    });

    await check('invites: registration needs a valid invite; a missing or made-up code is refused', async () => {
      const noCode = await call('POST', '/api/auth/register', { body: { email: 'a@example.com', password: PASSWORD } });
      assert.equal(noCode.status, 400);
      const fake = await register('a@example.com', 'x'.repeat(24));
      assert.equal(fake.status, 400);
      assert.equal(fake.json.error, 'Invite code is not valid');
    });

    const code = await newInvite();
    await check('registration: a valid invite creates the account, stores the email lower-cased, and returns no hash', async () => {
      const reply = await register('  Vishal@Example.COM ', code);
      assert.equal(reply.status, 201);
      assert.equal(reply.json.user.email, 'vishal@example.com');
      assert.equal(reply.text.includes('scrypt$'), false, 'password hash is never returned');
      const row = await db.user.findUniqueOrThrow({ where: { email: 'vishal@example.com' } });
      assert.match(row.passwordHash, /^scrypt\$/);
      assert.ok(row.inviteId, 'the invite is recorded on the user');
    });

    await check('invites: a single-use code cannot be reused', async () => {
      const again = await register('second@example.com', code);
      assert.equal(again.status, 400);
      assert.equal(await db.user.count({ where: { email: 'second@example.com' } }), 0);
    });

    await check('invites: concurrent registrations on a one-use code let exactly one account through', async () => {
      const shared = await newInvite({ maxUses: 1 });
      const replies = await Promise.all(
        Array.from({ length: 6 }, (_, i) => register(`race${i}@example.com`, shared))
      );
      assert.equal(replies.filter((r) => r.status === 201).length, 1, 'exactly one succeeds');
      assert.equal(await db.user.count({ where: { email: { startsWith: 'race' } } }), 1, 'exactly one account was created');
    });

    await check('invites: expired and revoked codes are refused', async () => {
      const expired = await newInvite({ now: new Date(Date.now() - 60 * 24 * 3600 * 1000), expiresInDays: 1 });
      assert.equal((await register('expired@example.com', expired)).status, 400);

      const toRevoke = await createInvite(db, { maxUses: 5 });
      assert.equal(await revokeInvite(db, toRevoke.id), true);
      assert.equal((await register('revoked@example.com', toRevoke.code)).status, 400);
    });

    await check('registration: an email that is already taken gets the same generic refusal', async () => {
      const reply = await register('vishal@example.com', await newInvite());
      assert.equal(reply.status, 400);
      assert.equal(reply.json.error, 'Registration could not be completed');
    });

    await check('login: a wrong password and an unknown email return the identical response', async () => {
      const wrong = await call('POST', '/api/auth/login', { body: { email: 'vishal@example.com', password: 'wrong wrong wrong' } });
      const unknown = await call('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: PASSWORD } });
      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.equal(wrong.text, unknown.text);
    });

    await check('web login: the session is a Secure, HttpOnly, SameSite=Lax cookie, and the body has no token', async () => {
      const reply = await call('POST', '/api/auth/login', { body: { email: 'vishal@example.com', password: PASSWORD } });
      assert.equal(reply.status, 200);
      assert.equal(reply.json.accessToken, undefined);
      const setCookie = reply.headers.getSetCookie().find((c) => c.startsWith('ck_session='))!;
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Lax/);
      assert.match(setCookie, /Secure/);
      assert.equal(reply.headers.get('cache-control'), 'no-store');
    });

    await check('cookie auth: /me works with the cookie and is anonymous without it', async () => {
      const login = await call('POST', '/api/auth/login', { body: { email: 'vishal@example.com', password: PASSWORD } });
      const cookie = sessionCookieFrom(login);
      const me = await call('GET', '/api/auth/me', { headers: { Cookie: cookie } });
      assert.equal(me.status, 200);
      assert.equal(me.json.user.email, 'vishal@example.com');
      assert.equal((await call('GET', '/api/auth/me')).status, 401);
    });

    await check('CSRF: a cookie-authenticated logout without the header is refused; with it, the session ends', async () => {
      const login = await call('POST', '/api/auth/login', { body: { email: 'vishal@example.com', password: PASSWORD } });
      const cookie = sessionCookieFrom(login);
      const noHeader = await call('POST', '/api/auth/logout', { headers: { Origin: ORIGIN, Cookie: cookie } });
      assert.equal(noHeader.status, 403);
      const out = await call('POST', '/api/auth/logout', { headers: cookieWrite(cookie, login.json.csrfToken) });
      assert.equal(out.status, 200);
      assert.equal((await call('GET', '/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
    });

    await check('CSRF token: login returns it, only its hash is stored, wrong or rotated-away tokens are refused', async () => {
      const login = await call('POST', '/api/auth/login', { body: { email: 'vishal@example.com', password: PASSWORD } });
      const cookie = sessionCookieFrom(login);
      const token = login.json.csrfToken as string;
      assert.ok(token && token.length >= 32, 'login returns a CSRF token');

      const wrong = await call('POST', '/api/auth/logout', { headers: { Origin: ORIGIN, Cookie: cookie, [CSRF_HEADER]: 'not-the-token' } });
      assert.equal(wrong.status, 403);

      const session = await db.session.findUniqueOrThrow({ where: { tokenHash: sha256Hex(cookie.split('=')[1]) } });
      assert.ok(session.csrfHash, 'a hash is stored');
      assert.notEqual(session.csrfHash, token, 'the raw token is never stored');

      const fresh = await call('GET', '/api/auth/csrf', { headers: { Cookie: cookie } });
      assert.equal(fresh.status, 200);
      const rotated = fresh.json.csrfToken as string;
      assert.notEqual(rotated, token);
      assert.equal((await call('POST', '/api/auth/logout', { headers: cookieWrite(cookie, token) })).status, 403, 'old token refused after rotation');
      assert.equal((await call('POST', '/api/auth/logout', { headers: cookieWrite(cookie, rotated) })).status, 200);
    });

    await check('native login returns short-lived access and refresh tokens, with no-store caching', async () => {
      const reply = await loginNative('vishal@example.com');
      assert.equal(reply.status, 200);
      assert.ok(reply.json.accessToken && reply.json.refreshToken);
      assert.equal(reply.headers.get('cache-control'), 'no-store');
      const me = await call('GET', '/api/auth/me', { headers: { Authorization: `Bearer ${reply.json.accessToken}` } });
      assert.equal(me.status, 200);
    });

    await check('refresh: a rotated refresh token is single-use, and replaying it revokes the session', async () => {
      const first = await loginNative('vishal@example.com');
      const oldAccess = first.json.accessToken as string;
      const oldRefresh = first.json.refreshToken as string;

      const rotated = await call('POST', '/api/auth/refresh', { body: { refreshToken: oldRefresh } });
      assert.equal(rotated.status, 200);
      assert.notEqual(rotated.json.accessToken, oldAccess);
      assert.notEqual(rotated.json.refreshToken, oldRefresh);
      assert.equal((await call('GET', '/api/auth/me', { headers: { Authorization: `Bearer ${oldAccess}` } })).status, 401, 'old access token is dead');

      // Inside the grace window a replay is a lost response, not theft: the client gets a fresh pair.
      const graceReplay = await call('POST', '/api/auth/refresh', { body: { refreshToken: oldRefresh } });
      assert.equal(graceReplay.status, 200, 'a dropped response does not log the client out');
      assert.ok(graceReplay.json.refreshToken);

      // Once the grace window has passed, replaying a replaced token is theft: the session is revoked.
      const replacedHash = sha256Hex(graceReplay.json.refreshToken);
      await db.session.updateMany({ where: { refreshHash: replacedHash }, data: { refreshRotatedAt: new Date(Date.now() - 10 * 60 * 1000) } });
      const stale = await call('POST', '/api/auth/refresh', { body: { refreshToken: rotated.json.refreshToken } });
      assert.equal(stale.status, 401);
      const newest = await call('POST', '/api/auth/refresh', { body: { refreshToken: graceReplay.json.refreshToken } });
      assert.equal(newest.status, 401, 'the session is revoked after a replay outside the window');
    });

    await check('sessions: a user can list and revoke their own sessions, and cannot touch another user\'s', async () => {
      const a = await loginNative('vishal@example.com');
      const b = await loginNative('vishal@example.com');
      const list = await call('GET', '/api/auth/sessions', { headers: { Authorization: `Bearer ${a.json.accessToken}` } });
      assert.equal(list.status, 200);
      assert.equal(JSON.stringify(list.json).includes('tokenHash'), false);
      const otherId = list.json.sessions.find((s: any) => !s.current)?.id;
      assert.ok(otherId);

      const revoke = await call('DELETE', `/api/auth/sessions/${otherId}`, { headers: { Authorization: `Bearer ${a.json.accessToken}`, Origin: ORIGIN } });
      assert.equal(revoke.status, 200);
      assert.equal((await call('GET', '/api/auth/me', { headers: { Authorization: `Bearer ${b.json.accessToken}` } })).status, 401);

      await makeUser('intruder@example.com');
      const intruder = await loginNative('intruder@example.com');
      const cross = await call('DELETE', `/api/auth/sessions/${list.json.currentSessionId}`, { headers: { Authorization: `Bearer ${intruder.json.accessToken}` } });
      assert.equal(cross.status, 404, 'another user\'s session is not found');
      assert.equal((await call('DELETE', '/api/auth/sessions/not-a-uuid', { headers: { Authorization: `Bearer ${intruder.json.accessToken}` } })).status, 400);
    });

    await check('sessions: revoking directly in the database takes effect on the next request', async () => {
      const login = await loginNative('vishal@example.com');
      const user = await db.user.findUniqueOrThrow({ where: { email: 'vishal@example.com' } });
      const direct = await createSession(db, { userId: user.id, kind: 'NATIVE' });
      await revokeSession(db, direct.sessionId);
      assert.equal((await call('GET', '/api/auth/me', { headers: { Authorization: `Bearer ${direct.token}` } })).status, 401);
      assert.equal((await call('GET', '/api/auth/me', { headers: { Authorization: `Bearer ${login.json.accessToken}` } })).status, 200);
    });

    await check('roles: non-admins get 403 from admin routes, anonymous callers get 401, and ADMIN_TOKEN is not accepted', async () => {
      await makeUser('member@example.com');
      const member = await loginNative('member@example.com');
      const memberAuth = { Authorization: `Bearer ${member.json.accessToken}` };
      assert.equal((await call('GET', '/api/admin/invites', { headers: memberAuth })).status, 403);
      assert.equal((await call('GET', '/api/admin/invites')).status, 401);
      const adminTokenLike = { Authorization: `Bearer ${'t'.repeat(40)}` };
      assert.equal((await call('GET', '/api/admin/invites', { headers: adminTokenLike })).status, 401);
    });

    await check('admin: creates an invite whose code is shown once, lists metadata without the code, and revokes it', async () => {
      await makeUser('admin@example.com', 'ADMIN');
      const admin = await loginNative('admin@example.com');
      const auth = { Authorization: `Bearer ${admin.json.accessToken}`, Origin: ORIGIN };
      assert.equal((await call('POST', '/api/admin/invites', { headers: auth, body: { maxUses: 0 } })).status, 400);
      const created = await call('POST', '/api/admin/invites', { headers: auth, body: { maxUses: 3, cohort: 'beta-1' } });
      assert.equal(created.status, 201);
      assert.ok(created.json.code.length >= 16);
      const listed = await call('GET', '/api/admin/invites', { headers: auth });
      assert.equal(listed.text.includes(created.json.code), false, 'codes are never listed');
      const row = listed.json.invites.find((i: any) => i.id === created.json.invite.id);
      assert.equal(row.cohort, 'beta-1');
      assert.equal((await call('DELETE', `/api/admin/invites/${created.json.invite.id}`, { headers: auth })).status, 200);
      assert.equal((await call('DELETE', `/api/admin/invites/${created.json.invite.id}`, { headers: auth })).status, 404);
    });

    await check('admin: suspending a user ends their sessions and blocks new logins; admins cannot suspend themselves', async () => {
      const victimId = await makeUser('victim@example.com');
      const victim = await loginNative('victim@example.com');
      const admin = await loginNative('admin@example.com');
      const auth = { Authorization: `Bearer ${admin.json.accessToken}`, Origin: ORIGIN };
      const suspended = await call('PATCH', `/api/admin/users/${victimId}`, { headers: auth, body: { status: 'SUSPENDED' } });
      assert.equal(suspended.status, 200);
      assert.equal((await call('GET', '/api/auth/me', { headers: { Authorization: `Bearer ${victim.json.accessToken}` } })).status, 401);
      assert.equal((await loginNative('victim@example.com')).status, 401);

      const adminId = (await db.user.findUniqueOrThrow({ where: { email: 'admin@example.com' } })).id;
      const self = await call('PATCH', `/api/admin/users/${adminId}`, { headers: auth, body: { status: 'SUSPENDED' } });
      assert.equal(self.status, 400);
    });

    await check('devices: registration requires sign-in, upserts on the push token, and never returns the token', async () => {
      const anon = await call('POST', '/api/devices', { body: { platform: 'ios', pushToken: 'p'.repeat(40), appVersion: '1.0' } });
      assert.equal(anon.status, 401);

      const session = await loginNative('member@example.com');
      const auth = { Authorization: `Bearer ${session.json.accessToken}` };
      const body = { platform: 'android', pushToken: 'f'.repeat(40), appVersion: '1.2.3', notificationPrefs: { breaking: false, aiReady: true, junk: 1 } };
      const first = await call('POST', '/api/devices', { headers: auth, body });
      assert.equal(first.status, 201);
      assert.equal(first.json.pushAvailable, false, 'no FCM credentials in the test environment, so push is unavailable');
      assert.equal(first.text.includes('f'.repeat(40)), false, 'push token is not echoed');
      assert.deepEqual(first.json.device.notificationPrefs, { breaking: false, dailyDigest: false, aiReady: true, categories: [] });
      const second = await call('POST', '/api/devices', { headers: auth, body: { ...body, appVersion: '1.2.4' } });
      assert.equal(second.status, 200);
      assert.equal(second.json.device.id, first.json.device.id);
      assert.equal(await db.device.count({ where: { pushToken: 'f'.repeat(40) } }), 1);

      const prefs = await call('PATCH', `/api/devices/${first.json.device.id}`, { headers: auth, body: { notificationPrefs: { dailyDigest: true, unknown: 5 } } });
      assert.equal(prefs.status, 200);
      assert.deepEqual(prefs.json.notificationPrefs, { breaking: false, dailyDigest: true, aiReady: true, categories: [] }, 'unchanged keys keep their stored value');
      const stored = await db.device.findUniqueOrThrow({ where: { id: first.json.device.id } });
      assert.equal((stored.notificationPrefs as { dailyDigest: boolean }).dailyDigest, true, 'preferences are persisted');
      assert.equal((await call('PATCH', `/api/devices/${first.json.device.id}`, { headers: auth, body: {} })).status, 400);
      assert.equal((await call('POST', '/api/devices', { headers: auth, body: { ...body, platform: 'tizen' } })).status, 400);
      assert.equal((await call('POST', '/api/devices', { headers: auth, body: { ...body, pushToken: 'short' } })).status, 400);
    });

    await check('devices: cookie-authenticated registration needs the CSRF header; removal is owner-only', async () => {
      const session = await loginNative('member@example.com');
      const cookieLogin = await call('POST', '/api/auth/login', { body: { email: 'member@example.com', password: PASSWORD } });
      const cookie = sessionCookieFrom(cookieLogin);
      const body = { platform: 'web', pushToken: 'w'.repeat(40), appVersion: '1.0' };
      assert.equal((await call('POST', '/api/devices', { headers: { Origin: ORIGIN, Cookie: cookie }, body })).status, 403);
      assert.equal((await call('POST', '/api/devices', { headers: cookieWrite(cookie, cookieLogin.json.csrfToken), body })).status, 201);

      const device = await db.device.findUniqueOrThrow({ where: { pushToken: 'w'.repeat(40) } });
      await makeUser('other@example.com');
      const other = await loginNative('other@example.com');
      const otherAuth = { Authorization: `Bearer ${other.json.accessToken}` };
      assert.equal((await call('DELETE', `/api/devices/${device.id}`, { headers: otherAuth })).status, 404);
      assert.equal(await db.device.count({ where: { id: device.id } }), 1, 'another user cannot remove it');

      const ownAuth = { Authorization: `Bearer ${session.json.accessToken}` };
      assert.equal((await call('DELETE', `/api/devices/${device.id}`, { headers: ownAuth })).status, 200);
      assert.equal((await call('DELETE', `/api/devices/${device.id}`, { headers: ownAuth })).status, 404);
    });

    await check('BYOK over HTTP: the key is redacted before the handler, and malformed keys are refused', async () => {
      const key = 'AIza' + 'K'.repeat(35);
      const ok = await call('POST', '/api/probe-ai', { headers: { [BYOK_HEADER]: key }, body: {} });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.kind, 'byok');
      assert.equal(ok.json.headerSeen, null, 'the handler never sees the key header');
      assert.equal(ok.text.includes(key), false);
      const bad = await call('POST', '/api/probe-ai', { headers: { [BYOK_HEADER]: 'nope' }, body: {} });
      assert.equal(bad.status, 400);
    });

    await check('quota: BYOK counts persist across a restart (a new database client)', async () => {
      const key = 'AIza' + 'Q'.repeat(35);
      const first = await call('POST', '/api/probe-ai', { headers: { [BYOK_HEADER]: key }, body: {} });
      assert.equal(first.status, 200);
      const second = await call('POST', '/api/probe-ai', { headers: { [BYOK_HEADER]: key }, body: {} });
      assert.equal(second.status, 200);
      const third = await call('POST', '/api/probe-ai', { headers: { [BYOK_HEADER]: key }, body: {} });
      assert.equal(third.status, 429, 'limit of 2 reached');

      // A fresh client and a fresh app simulate a restart or a second replica.
      const restarted = createPrisma(url);
      const guard = requireAiCaller({ db: restarted, platformKeyConfigured: () => true, limits: { byokPerDay: 2 } });
      let status = 0;
      let called = false;
      const req = { headers: { [BYOK_HEADER]: key }, get: (n: string) => (n.toLowerCase() === BYOK_HEADER ? key : undefined) } as any;
      const res = {
        locals: {} as Record<string, unknown>,
        status(code: number) { status = code; return this; },
        json() { return this; },
        set() { return this; },
      } as any;
      await guard(req, res, () => { called = true; });
      assert.equal(called, false, 'the restarted client still sees today\'s count');
      assert.equal(status, 429);
      await restarted.$disconnect();
      assert.equal(await db.aiQuotaUsage.count({ where: { identity: `byok:${fingerprintKey(key)}` } }), 1);
    });

    await check('quota: the atomic counter never exceeds the limit under concurrency', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => consumeQuota(db, 'race-identity', 4)));
      assert.equal(results.filter(Boolean).length, 4);
      assert.equal(await consumeQuota(db, 'race-identity', 0), false, 'a zero limit allows nothing');
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.$disconnect();
  }

  if (failures > 0) {
    console.log(`\n${failures} auth database check(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error('[auth.db] fatal:', err);
  await db.$disconnect();
  process.exitCode = 1;
});
