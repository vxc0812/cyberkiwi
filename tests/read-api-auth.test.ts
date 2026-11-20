/**
 * Invite-only content: story and article reads require a signed-in user.
 *
 * Runs without PostgreSQL. Requests go through the real attachSession and resolveAccessToken that
 * server.ts uses; only the Prisma calls are stubbed. The session table is an in-memory map keyed by
 * token hash, and content queries are recorded, which shows that a refused request reads no content.
 * Real session storage in PostgreSQL is covered by tests/integration (npm run test:db), not here.
 */
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createReadApi } from '../server/api/readApi';
import { attachSession } from '../server/auth/middleware';
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

const STORY_ID = '00000000-0000-4000-8000-000000000001';
const HOUR = 3_600_000;
const VALID = 'valid-access-token';
const REVOKED = 'revoked-access-token';
const EXPIRED = 'expired-access-token';
const SUSPENDED = 'suspended-user-token';

function sessionRow(id: string, opts: { revoked?: boolean; expired?: boolean; status?: string } = {}) {
  return {
    id,
    kind: 'NATIVE',
    csrfHash: null,
    revokedAt: opts.revoked ? new Date(Date.now() - HOUR) : null,
    expiresAt: new Date(Date.now() + (opts.expired ? -HOUR : HOUR)),
    lastSeenAt: new Date(),
    user: { id: `user-${id}`, email: `${id}@example.test`, role: 'USER', status: opts.status ?? 'ACTIVE' },
  };
}

/** Prisma stub: sessions by token hash; content queries recorded and answered with empty results. */
function stubDb() {
  const contentQueries: string[] = [];
  const sessions = new Map<string, unknown>([
    [sha256Hex(VALID), sessionRow('valid')],
    [sha256Hex(REVOKED), sessionRow('revoked', { revoked: true })],
    [sha256Hex(EXPIRED), sessionRow('expired', { expired: true })],
    [sha256Hex(SUSPENDED), sessionRow('suspended', { status: 'SUSPENDED' })],
  ]);
  const db: any = {
    session: {
      findUnique: async ({ where }: any) => sessions.get(where.tokenHash) ?? null,
      update: async () => null,
    },
    feed: { findMany: async () => [] },
    story: {
      findMany: async () => { contentQueries.push('story.findMany'); return []; },
      findUnique: async () => { contentQueries.push('story.findUnique'); return null; },
    },
    article: {
      findMany: async () => { contentQueries.push('article.findMany'); return []; },
    },
  };
  return { db, contentQueries };
}

/** Mounts the read API behind attachSession, as server.ts does. */
async function startApp(db: any): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/api/', attachSession(db));
  app.use('/api/v1', createReadApi(db));
  const server: Server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = (server.address() as any).port;
  return { base: `http://127.0.0.1:${port}/api/v1`, close: () => new Promise((r) => server.close(() => r())) };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const CONTENT_PATHS = ['/stories', `/stories/${STORY_ID}`, '/articles', '/stories?limit=5&category=exploits'];

async function main(): Promise<void> {
  // --- Unauthenticated ---
  {
    const { db, contentQueries } = stubDb();
    const app = await startApp(db);

    await check('unauthenticated: every story and article read is 401 unauthorized', async () => {
      for (const path of CONTENT_PATHS) {
        const res = await fetch(app.base + path);
        assert.equal(res.status, 401, path);
        const body = await res.json();
        assert.equal(body.success, false, path);
        assert.equal(body.error.code, 'unauthorized', path);
      }
    });

    await check('unauthenticated: an unknown bearer token or forged session cookie is refused', async () => {
      assert.equal((await fetch(app.base + '/stories', { headers: bearer('not-a-real-token') })).status, 401);
      assert.equal((await fetch(app.base + '/articles', { headers: { cookie: 'ck_session=forged' } })).status, 401);
    });

    await check('unauthenticated: revoked, expired and suspended-user sessions are refused', async () => {
      for (const token of [REVOKED, EXPIRED, SUSPENDED]) {
        assert.equal((await fetch(app.base + '/stories', { headers: bearer(token) })).status, 401, token);
        assert.equal((await fetch(app.base + '/articles', { headers: { cookie: `ck_session=${token}` } })).status, 401, token);
      }
    });

    await check('unauthenticated: refusals are not cached and vary on credentials', async () => {
      const res = await fetch(app.base + '/stories');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const vary = (res.headers.get('vary') ?? '').toLowerCase();
      assert.ok(vary.includes('authorization') && vary.includes('cookie'), vary);
    });

    await check('unauthenticated: no content query reaches the database', () => {
      assert.deepEqual(contentQueries, []);
    });

    await check('unauthenticated: feed health stays public (operator status, not content)', async () => {
      assert.equal((await fetch(app.base + '/feeds/health')).status, 200);
    });

    await app.close();
  }

  // --- Authenticated: an active session, by bearer token (native) or session cookie (web) ---
  {
    const { db, contentQueries } = stubDb();
    const app = await startApp(db);

    await check('authenticated: story list and article list return 200 pages (bearer token)', async () => {
      for (const path of ['/stories', '/articles']) {
        const res = await fetch(app.base + path, { headers: bearer(VALID) });
        assert.equal(res.status, 200, path);
        const body = await res.json();
        assert.equal(body.success, true, path);
        assert.ok(Array.isArray(body.items), path);
      }
    });

    await check('authenticated: story detail reaches the store (404 for an unknown id, not 401)', async () => {
      const res = await fetch(`${app.base}/stories/${STORY_ID}`, { headers: bearer(VALID) });
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, 'not_found');
    });

    await check('authenticated: the web session cookie also grants access', async () => {
      const res = await fetch(app.base + '/stories', { headers: { cookie: `ck_session=${VALID}` } });
      assert.equal(res.status, 200);
    });

    await check('authenticated: content responses are private and vary on credentials', async () => {
      const res = await fetch(app.base + '/stories', { headers: bearer(VALID) });
      assert.equal(res.headers.get('cache-control'), 'private, max-age=30');
      const vary = (res.headers.get('vary') ?? '').toLowerCase();
      assert.ok(vary.includes('authorization') && vary.includes('cookie'), vary);
    });

    await check('authenticated: content queries ran', () => {
      assert.deepEqual(contentQueries, ['story.findMany', 'article.findMany', 'story.findUnique', 'story.findMany', 'story.findMany']);
    });

    await app.close();
  }

  if (failures > 0) {
    console.log(`\n${failures} read API auth check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll read API auth checks passed.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
