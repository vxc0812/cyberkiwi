/**
 * Integration tests for the read-only API against PostgreSQL.
 * Run with npm run test:db (refuses to run unless the database name ends in _test).
 */
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createPrisma, databaseUrl } from '../../server/db/client';
import { createReadApi, decodeCursor, encodeCursor, parseLimit, feedStatus, publicErrorCode } from '../../server/api/readApi';
import { normalizeBatch, type RawFeedItem } from '../../server/ingestion/contract';
import { upsertArticles, upsertFeed, upsertSource, saveFeedOutcome } from '../../server/repositories/ingestion';
import { linkUnassignedArticles } from '../../server/repositories/stories';
import { PRINCIPAL_LOCAL } from '../../server/auth/middleware';
import type { Principal } from '../../server/auth/session';

const url = databaseUrl();
const dbName = new URL(url).pathname.replace(/^\//, '');
if (!dbName.endsWith('_test')) {
  console.error(`Refusing to run: database "${dbName}" does not end in "_test".`);
  process.exit(1);
}

const db = createPrisma(url);
const ADMIN = 'test-admin-token';
let failures = 0;
let server: Server;
let base = '';
let adminBase = '';
let noAdminBase = '';

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✅ [PASS] ${name}`);
  } catch (err: any) {
    failures++;
    console.log(`❌ [FAIL] ${name}: ${err?.message ?? err}`);
  }
}

async function get(path: string, headers: Record<string, string> = {}, root = base) {
  const res = await fetch(root + path, { headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

async function resetDatabase(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE "IngestionRun", "StoryArticle", "Story", "Article", "Feed", "Source" RESTART IDENTITY CASCADE'
  );
}

async function feed(slug: string, feedUrl: string, category = 'news'): Promise<string> {
  const sourceId = await upsertSource(db, { slug, name: `Source ${slug}`, category });
  return upsertFeed(db, { sourceId, url: feedUrl, category, title: `Feed ${slug}` });
}

/** Stores items through the same normalization and write path the worker uses, then links stories. */
async function seed(feedId: string, items: RawFeedItem[], now: Date): Promise<void> {
  const batch = normalizeBatch(items, feedId, now);
  await upsertArticles(db, feedId, batch.articles, now);
  await linkUnassignedArticles(db);
}

function day(n: number): string {
  return `2026-11-${String(n).padStart(2, '0')}T08:00:00Z`;
}

async function main(): Promise<void> {
  await resetDatabase();
  const NOW = new Date('2026-11-20T00:00:00Z');

  // Shared fixture: 5 distinct stories across 2 feeds, plus one story covered by both feeds.
  const fa = await feed('api-a', 'https://api-a.test/rss');
  const fb = await feed('api-b', 'https://api-b.test/rss');
  for (let i = 1; i <= 5; i++) {
    await seed(fa, [{ guid: `a${i}`, link: `https://api-a.test/story-${i}`, title: `Story ${i}`, isoDate: day(i) }], NOW);
  }
  await seed(fb, [{ guid: 'shared', link: 'https://news.test/shared?utm_source=x', title: 'Shared (B)', isoDate: day(9) }], NOW);
  await seed(fa, [{ guid: 'shared-a', link: 'https://news.test/shared', title: 'Shared (A)', isoDate: day(8) }], NOW);

  const ex = await feed('api-x', 'https://api-x.test/rss', 'exploits');
  await seed(ex, [{ guid: 'x1', link: 'https://api-x.test/poc', title: 'PoC exploit for X', isoDate: day(7) }, { guid: 'x2', link: 'https://api-x.test/other', title: 'Unrelated patch notes', isoDate: day(6) }], NOW);

  // Content reads are invite-only. These suites test query behavior, so they run as a signed-in reader;
  // the sign-in requirement itself is covered by tests/read-api-auth.test.ts and the check below.
  const reader: Principal = { sessionId: 's', userId: 'u', email: 'reader@example.test', role: 'USER', kind: 'WEB', csrfHash: null };
  const signedIn: express.RequestHandler = (_req, res, next) => { res.locals[PRINCIPAL_LOCAL] = reader; next(); };
  const app = express();
  app.use(signedIn);
  app.use('/api/v1', createReadApi(db));
  const adminApp = express();
  adminApp.use(signedIn);
  adminApp.use('/api/v1', createReadApi(db, { adminToken: ADMIN }));
  const anonApp = express();
  anonApp.use('/api/v1', createReadApi(db));
  const anonServer = anonApp.listen(0);
  const anonBase = `http://127.0.0.1:${(anonServer.address() as any).port}/api/v1`;
  server = app.listen(0);
  const adminServer = adminApp.listen(0);
  const port = (server.address() as any).port;
  const adminPort = (adminServer.address() as any).port;
  base = `http://127.0.0.1:${port}/api/v1`;
  noAdminBase = base;
  adminBase = `http://127.0.0.1:${adminPort}/api/v1`;

  await check('stories: paging returns every story once, newest first, and ends with a null cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q = `/stories?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const r = await get(q);
      assert.equal(r.status, 200);
      seen.push(...r.body.items.map((s: any) => s.id));
      cursor = r.body.nextCursor;
      pages++;
      assert.ok(pages < 10, 'pagination must terminate');
    } while (cursor);
    assert.equal(seen.length, 8, 'five single stories, the shared story, and two exploit stories');
    assert.equal(new Set(seen).size, seen.length, 'no story appears twice across pages');
    const all = await get('/stories?limit=50');
    assert.deepEqual(seen, all.body.items.map((s: any) => s.id), 'pages concatenate to the full ordering');
    const dates = all.body.items.map((s: any) => s.sortAt ?? s.lastPublishedAt);
    assert.ok(dates[0] >= dates[1], 'newest story first');
  });

  await check('stories: a shared canonical URL shows both sources and both article references', async () => {
    const r = await get('/stories?limit=50');
    const shared = r.body.items.find((s: any) => s.title === 'Shared (B)');
    assert.ok(shared, 'shared story is listed under the newest article title');
    assert.equal(shared.articleCount, 2);
    assert.equal(shared.sources.length, 2);
    assert.equal(shared.articles.length, 2);
    assert.equal(shared.articlesTruncated, false);
    assert.ok(shared.articles.every((a: any) => typeof a.url === 'string' && a.source.name.startsWith('Source')));
  });

  await check('story detail: returns the story; unknown id is 404; malformed id is 400', async () => {
    const list = await get('/stories?limit=1');
    const id = list.body.items[0].id;
    const ok = await get(`/stories/${id}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.story.id, id);
    assert.equal((await get('/stories/00000000-0000-4000-8000-00000000dead')).status, 404);
    assert.equal((await get('/stories/not-a-uuid')).status, 400);
  });

  await check('articles: feed filter returns only that feed, with stable paging', async () => {
    const r = await get(`/articles?feedId=${fb}&limit=50`);
    assert.equal(r.status, 200);
    assert.ok(r.body.items.length >= 1);
    assert.ok(r.body.items.every((a: any) => a.source.feedId === fb));
    const paged = await get(`/articles?limit=2`);
    assert.equal(paged.body.items.length, 2);
    assert.ok(paged.body.nextCursor, 'a second page exists');
    const next = await get(`/articles?limit=2&cursor=${encodeURIComponent(paged.body.nextCursor)}`);
    const firstIds = new Set(paged.body.items.map((a: any) => a.id));
    assert.ok(next.body.items.every((a: any) => !firstIds.has(a.id)), 'second page does not repeat the first');
  });

  await check('validation: bad limit, bad cursor, bad feed id and bad status are rejected', async () => {
    for (const q of ['/stories?limit=0', '/stories?limit=51', '/stories?limit=abc', '/stories?limit=-1']) {
      const r = await get(q);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.error.code, 'invalid_limit'); assert.equal(r.body.success, false); assert.ok(r.body.error.message);
    }
    assert.equal((await get('/stories?cursor=garbage')).body.error.code, 'invalid_cursor');
    assert.equal((await get('/articles?feedId=nope')).body.error.code, 'invalid_filter');
    assert.equal((await get('/ingestion/runs', { authorization: `Bearer ${ADMIN}` }, adminBase)).status, 200);
    assert.equal((await get('/ingestion/runs?status=BOGUS', { authorization: `Bearer ${ADMIN}` }, adminBase)).status, 400);
  });

  await check('cursor: encode and decode round-trip; tampered cursors are rejected', () => {
    const c = { sortAt: new Date('2026-11-05T08:00:00.000Z'), id: '00000000-0000-4000-8000-000000000001' };
    const back = decodeCursor(encodeCursor(c));
    assert.ok(back);
    assert.equal(back!.sortAt.toISOString(), c.sortAt.toISOString());
    assert.equal(back!.id, c.id);
    assert.equal(decodeCursor(Buffer.from('{"t":"nope","i":"x"}').toString('base64url')), null);
    assert.equal(parseLimit('20').ok, true);
    assert.equal(parseLimit('1.5').ok, false);
  });

  await check('health: a failing feed shows its code, not the raw message, and a backoff time', async () => {
    const failing = await feed('api-bad', 'https://api-bad.test/rss');
    const at = new Date('2026-11-19T10:00:00Z');
    await saveFeedOutcome(db, failing, {
      consecutiveFailures: 2,
      lastAttemptAt: at,
      lastSuccessAt: null,
      lastFailureAt: at,
      lastError: 'HTTP_404: HTTP 404 from https://api-bad.test/rss',
    });
    const r = await get('/feeds/health');
    assert.equal(r.status, 200);
    const row = r.body.items.find((x: any) => x.feedId === failing);
    assert.equal(row.status, 'failing');
    assert.equal(row.lastErrorCode, 'HTTP_404');
    assert.ok(!r.text.includes('api-bad.test/rss'), 'raw error message is not exposed publicly');
    assert.ok(row.nextAttemptAt, 'next attempt time is reported');
    assert.ok(r.body.counts.failing >= 1);
    assert.equal(feedStatus({ lastAttemptAt: null, consecutiveFailures: 0 }), 'never_fetched');
    assert.equal(publicErrorCode('TIMEOUT: Request timed out'), 'TIMEOUT');
  });

  await check('operator runs: disabled without ADMIN_TOKEN; 401 without the right token; 200 with it', async () => {
    assert.equal((await get('/ingestion/runs', {}, noAdminBase)).status, 404, 'endpoint does not exist without a token');
    assert.equal((await get('/ingestion/runs', {}, adminBase)).status, 401);
    assert.equal((await get('/ingestion/runs', { authorization: 'Bearer wrong' }, adminBase)).status, 401);
    const ok = await get('/ingestion/runs', { authorization: `Bearer ${ADMIN}` }, adminBase);
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.body.items));
  });

  await check('contract: hasMore agrees with nextCursor, and the last page has hasMore=false', async () => {
    const first = await get('/stories?limit=2');
    assert.equal(first.body.hasMore, true);
    assert.ok(first.body.nextCursor);
    const second = await get(`/stories?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    assert.equal(second.body.items.length, 2);
    const last = await get(`/stories?limit=50&cursor=${encodeURIComponent(second.body.nextCursor)}`);
    assert.equal(last.body.hasMore, false);
    assert.equal(last.body.nextCursor, null);
  });

  await check('contract: error envelope has code and message and never leaks internals', async () => {
    const r = await get('/stories/not-a-uuid');
    assert.equal(r.status, 400);
    assert.deepEqual(Object.keys(r.body).sort(), ['error', 'success']);
    assert.equal(r.body.error.code, 'invalid_id');
    assert.ok(!/prisma|stack|\bat /i.test(r.text));
  });

  await check('auth: the admin token is accepted only in the Authorization header, not the query string', async () => {
    const q = await get(`/ingestion/runs?token=${ADMIN}`, {}, adminBase);
    assert.equal(q.status, 401, 'token in query string is ignored');
    const basic = await get('/ingestion/runs', { authorization: `Basic ${ADMIN}` }, adminBase);
    assert.equal(basic.status, 401, 'only the Bearer scheme is accepted');
  });

  await check('filters: category returns only matching stories and only their matching articles', async () => {
    const r = await get('/stories?category=exploits&limit=50');
    assert.equal(r.status, 200);
    assert.ok(r.body.items.length >= 1, 'exploit stories exist');
    for (const s of r.body.items) {
      assert.ok(s.articles.length >= 1);
      assert.ok(s.articles.every((a: any) => a.source.category === 'exploits'), 'only exploit articles are returned');
      assert.ok(s.matchedArticleCount <= s.articleCount);
    }
    const none = await get('/stories?category=no-such-category');
    assert.equal(none.body.items.length, 0, 'an unknown category is an empty result, not an error');
  });

  await check('filters: keyword is case-insensitive, supports | as OR, and is literal text', async () => {
    const poc = await get('/stories?keyword=POC');
    assert.ok(poc.body.items.some((s: any) => s.title === 'PoC exploit for X'));
    const or = await get('/stories?keyword=zzz-nothing|PoC');
    assert.ok(or.body.items.some((s: any) => s.title === 'PoC exploit for X'));
    const literal = await get('/stories?keyword=' + encodeURIComponent('.*'));
    assert.equal(literal.body.items.length, 0, 'regex metacharacters are not interpreted');
  });

  await check('filters: feedId returns stories that contain that feed, and rejects a bad id', async () => {
    const r = await get(`/stories?feedId=${ex}&limit=50`);
    assert.ok(r.body.items.length >= 1);
    assert.ok(r.body.items.every((s: any) => s.sources.some((src: any) => src.feedId === ex)));
    assert.equal((await get('/stories?feedId=not-a-uuid')).body.error.code, 'invalid_filter');
  });

  await check('filters: filtered pages still terminate and do not repeat stories', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const r: any = await get(`/stories?category=news&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...r.body.items.map((s: any) => s.id));
      cursor = r.body.nextCursor;
      guard++;
      assert.ok(guard < 20, 'pagination terminates');
    } while (cursor);
    assert.equal(new Set(seen).size, seen.length, 'no story twice');
    assert.ok(seen.length >= 1);
  });

  await check('filters: malformed category or oversized keyword are rejected with invalid_filter', async () => {
    assert.equal((await get('/stories?category=Bad%20Cat')).body.error.code, 'invalid_filter');
    assert.equal((await get('/stories?category=../etc')).body.error.code, 'invalid_filter');
    assert.equal((await get('/stories?keyword=' + 'x'.repeat(101))).body.error.code, 'invalid_filter');
    assert.equal((await get('/stories?keyword=' + Array(11).fill('a').join('|'))).body.error.code, 'invalid_filter');
    assert.equal((await get('/articles?category=Bad%20Cat')).body.error.code, 'invalid_filter');
  });

  await check('invite-only: seeded stories and articles are refused without a signed-in user', async () => {
    for (const path of ['/stories', '/articles']) {
      const res = await get(path, {}, anonBase);
      assert.equal(res.status, 401, path);
      assert.equal(res.body.error.code, 'unauthorized', path);
    }
  });

  await check('no write surface: POST, PUT and DELETE are not routed', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await fetch(`${base}/stories`, { method });
      assert.equal(res.status, 404, method);
    }
  });

  server.close();
  adminServer.close();
  anonServer.close();
  await db.$disconnect();
  if (failures > 0) {
    console.log(`\n${failures} read API check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll read API checks passed.');
  }
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exitCode = 1;
});
