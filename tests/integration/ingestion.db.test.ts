/**
 * Integration tests: ingestion worker against a real PostgreSQL database.
 *
 * Run with: npm run test:db  (creates cyberkiwi_test if needed and applies migrations).
 * Safety: the suite truncates tables, so it refuses to run unless the database name ends in "_test".
 */
import assert from 'node:assert/strict';
import { createPrisma, databaseUrl } from '../../server/db/client';
import { ingestFeed, isFeedDue, runIngestionCycle, type WorkerDeps } from '../../server/ingestion/worker';
import type { FeedFetchResult } from '../../server/ingestion/fetchFeed';
import { listActiveFeeds, upsertFeed, upsertSource } from '../../server/repositories/ingestion';
import { linkUnassignedArticles } from '../../server/repositories/stories';

const url = databaseUrl();
const dbName = new URL(url).pathname.replace(/^\//, '');
if (!dbName.endsWith('_test')) {
  console.error(`Refusing to run: database "${dbName}" does not end in "_test". Set TEST_DATABASE_URL.`);
  process.exit(1);
}

const db = createPrisma(url);
let failures = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✅ [PASS] ${name}`);
  } catch (err: any) {
    failures++;
    console.log(`❌ [FAIL] ${name}: ${err?.message ?? err}`);
  }
}

async function resetDatabase(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE "IngestionRun", "StoryArticle", "Story", "Article", "Feed", "Source" RESTART IDENTITY CASCADE'
  );
}

async function createFeed(slug: string, feedUrl: string, interval = 15): Promise<string> {
  const sourceId = await upsertSource(db, { slug, name: slug, category: 'news' });
  return upsertFeed(db, { sourceId, url: feedUrl, category: 'news', fetchIntervalMinutes: interval });
}

async function feedRow(feedId: string) {
  return db.feed.findUniqueOrThrow({ where: { id: feedId } });
}

async function activeFeed(feedId: string) {
  const feeds = await listActiveFeeds(db);
  const f = feeds.find((x) => x.id === feedId);
  assert.ok(f, 'feed is active');
  return f;
}

function rss(items: Array<{ guid?: string; link?: string; title?: string; pub?: string }>): string {
  const body = items
    .map(
      (i) =>
        `<item>${i.guid ? `<guid>${i.guid}</guid>` : ''}${i.link !== undefined ? `<link>${i.link}</link>` : ''}` +
        `${i.title !== undefined ? `<title>${i.title}</title>` : ''}<pubDate>${i.pub ?? 'Thu, 12 Nov 2026 08:00:00 GMT'}</pubDate></item>`
    )
    .join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>${body}</channel></rss>`;
}

/** Fake fetcher: returns the configured body for each URL and records conditional headers. */
function fakeFetcher(responses: Record<string, string | Error | 'NOT_MODIFIED'>, seen: Array<{ url: string; etag?: string | null }> = []) {
  return async (feedUrl: string, conditional: { etag?: string | null; lastModified?: string | null }): Promise<FeedFetchResult> => {
    seen.push({ url: feedUrl, etag: conditional.etag });
    const r = responses[feedUrl];
    if (r instanceof Error) throw r;
    if (r === 'NOT_MODIFIED') return { kind: 'not_modified', httpStatus: 304 };
    if (r === undefined) throw Object.assign(new Error('HTTP 404'), { httpStatus: 404 });
    return { kind: 'ok', httpStatus: 200, body: r, etag: '"v1"', lastModified: null };
  };
}

function depsWith(fetch: ReturnType<typeof fakeFetcher>, now: () => Date = () => new Date()): WorkerDeps {
  return { db, fetchFeed: fetch, now };
}

async function main(): Promise<void> {
  await resetDatabase();
  const NOW = new Date('2026-11-13T12:00:00Z');

  await check('idempotent: re-running the same feed inserts nothing new', async () => {
    await resetDatabase();
    const feedId = await createFeed('idem', 'https://idem.test/rss');
    const body = rss([
      { guid: 'a', link: 'https://idem.test/a', title: 'Alpha' },
      { guid: 'b', link: 'https://idem.test/b', title: 'Beta' },
    ]);
    const fetch = fakeFetcher({ 'https://idem.test/rss': body });
    const feed = await activeFeed(feedId);

    const first = await ingestFeed(depsWith(fetch, () => NOW), feed);
    const second = await ingestFeed(depsWith(fetch, () => new Date(NOW.getTime() + 3600_000)), feed);

    assert.equal(first.itemsNew, 2);
    assert.equal(second.itemsNew, 0);
    assert.equal(await db.article.count({ where: { feedId } }), 2);
    assert.equal(await db.ingestionRun.count({ where: { feedId, status: 'SUCCEEDED' } }), 2);
  });

  await check('updates: changed content rewrites the row, unchanged content only refreshes lastSeenAt', async () => {
    await resetDatabase();
    const feedId = await createFeed('upd', 'https://upd.test/rss');
    const feed = await activeFeed(feedId);
    const v1 = fakeFetcher({ 'https://upd.test/rss': rss([{ guid: 'x', link: 'https://upd.test/x', title: 'Old title' }]) });
    await ingestFeed(depsWith(v1, () => NOW), feed);
    const v2 = fakeFetcher({ 'https://upd.test/rss': rss([{ guid: 'x', link: 'https://upd.test/x', title: 'New title' }]) });
    const r = await ingestFeed(depsWith(v2, () => new Date(NOW.getTime() + 60_000)), feed);
    assert.equal(r.itemsUpdated, 1);
    assert.equal(r.itemsNew, 0);
    const row = await db.article.findFirstOrThrow({ where: { feedId } });
    assert.equal(row.title, 'New title');
  });

  await check('partial: invalid items are rejected, valid items stored, run is PARTIAL', async () => {
    await resetDatabase();
    const feedId = await createFeed('part', 'https://part.test/rss');
    const body = rss([
      { guid: 'ok', link: 'https://part.test/ok', title: 'Good' },
      { guid: 'bad', link: 'javascript:alert(1)', title: 'Bad link' },
    ]);
    const r = await ingestFeed(depsWith(fakeFetcher({ 'https://part.test/rss': body }), () => NOW), await activeFeed(feedId));
    assert.equal(r.status, 'PARTIAL');
    assert.equal(await db.article.count({ where: { feedId } }), 1);
    const run = await db.ingestionRun.findFirstOrThrow({ where: { feedId } });
    assert.equal(run.itemsSeen, 2);
    assert.equal(run.itemsNew, 1);
  });

  await check('isolation: one failing feed does not stop the others in the same cycle', async () => {
    await resetDatabase();
    await createFeed('good', 'https://good.test/rss');
    await createFeed('down', 'https://down.test/rss');
    const fetch = fakeFetcher({
      'https://good.test/rss': rss([{ guid: 'g', link: 'https://good.test/g', title: 'G' }]),
      'https://down.test/rss': new Error('connect ECONNREFUSED'),
    });
    const summary = await runIngestionCycle({ db, fetchFeed: fetch, now: () => NOW }, { concurrency: 2 });
    assert.equal(summary.due, 2);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 1);
    const down = await db.feed.findUniqueOrThrow({ where: { url: 'https://down.test/rss' } });
    assert.equal(down.consecutiveFailures, 1);
    assert.equal(await db.article.count(), 1);
  });

  await check('retry: failures back off; the feed is not due until the delay passes; success resets', async () => {
    await resetDatabase();
    const feedId = await createFeed('retry', 'https://retry.test/rss', 15);
    const failing = fakeFetcher({ 'https://retry.test/rss': new Error('timeout reached') });
    await ingestFeed(depsWith(failing, () => NOW), await activeFeed(feedId));
    const after = await feedRow(feedId);
    assert.equal(after.consecutiveFailures, 1);
    assert.equal(after.lastError?.startsWith('TIMEOUT'), true);

    const feedState = await activeFeed(feedId);
    assert.equal(isFeedDue(feedState, new Date(NOW.getTime() + 10 * 60_000)), false, 'not due at 10 min');
    assert.equal(isFeedDue(feedState, new Date(NOW.getTime() + 31 * 60_000)), true, 'due after 2 x 15 min');

    const ok = fakeFetcher({ 'https://retry.test/rss': rss([{ guid: 'r', link: 'https://retry.test/r', title: 'R' }]) });
    await ingestFeed(depsWith(ok, () => new Date(NOW.getTime() + 40 * 60_000)), await activeFeed(feedId));
    const healed = await feedRow(feedId);
    assert.equal(healed.consecutiveFailures, 0);
    assert.equal(healed.lastError, null);
  });

  await check('conditional GET: stored ETag is sent; 304 counts as success with no writes', async () => {
    await resetDatabase();
    const feedId = await createFeed('cond', 'https://cond.test/rss');
    const seen: Array<{ url: string; etag?: string | null }> = [];
    const first = fakeFetcher({ 'https://cond.test/rss': rss([{ guid: 'c', link: 'https://cond.test/c', title: 'C' }]) }, seen);
    await ingestFeed(depsWith(first, () => NOW), await activeFeed(feedId));
    assert.equal((await feedRow(feedId)).etag, '"v1"');

    const second = fakeFetcher({ 'https://cond.test/rss': 'NOT_MODIFIED' }, seen);
    const r = await ingestFeed(depsWith(second, () => new Date(NOW.getTime() + 3600_000)), await activeFeed(feedId));
    assert.equal(seen[1].etag, '"v1"');
    assert.equal(r.status, 'SUCCEEDED');
    assert.equal(await db.article.count({ where: { feedId } }), 1);
    const run = await db.ingestionRun.findFirstOrThrow({ where: { feedId }, orderBy: { startedAt: 'desc' } });
    assert.equal(run.httpStatus, 304);
  });

  await check('error codes: HTTP status is recorded on the run', async () => {
    await resetDatabase();
    const feedId = await createFeed('http', 'https://http.test/rss');
    await ingestFeed(depsWith(fakeFetcher({}), () => NOW), await activeFeed(feedId));
    const run = await db.ingestionRun.findFirstOrThrow({ where: { feedId } });
    assert.equal(run.status, 'FAILED');
    assert.equal(run.errorCode, 'HTTP_404');
    assert.equal(run.httpStatus, 404);
  });

  await check('security: the real shared fetch refuses a private target and records BLOCKED', async () => {
    await resetDatabase();
    const feedId = await createFeed('private', 'http://127.0.0.1:9/feed.xml');
    const r = await ingestFeed({ db, now: () => NOW }, await activeFeed(feedId));
    assert.equal(r.status, 'FAILED');
    assert.equal(r.errorCode, 'BLOCKED');
    assert.equal(await db.article.count({ where: { feedId } }), 0);
  });

  await check('identity: the same link in two feeds is stored once per feed', async () => {
    await resetDatabase();
    const a = await createFeed('dup-a', 'https://dup-a.test/rss');
    const b = await createFeed('dup-b', 'https://dup-b.test/rss');
    const same = rss([{ guid: 'shared', link: 'https://news.test/story', title: 'Story' }]);
    const fetch = fakeFetcher({ 'https://dup-a.test/rss': same, 'https://dup-b.test/rss': same });
    await ingestFeed(depsWith(fetch, () => NOW), await activeFeed(a));
    await ingestFeed(depsWith(fetch, () => NOW), await activeFeed(b));
    assert.equal(await db.article.count({ where: { canonicalUrl: 'https://news.test/story' } }), 2);
  });

  await check('cycle: due feeds are all processed with bounded concurrency', async () => {
    await resetDatabase();
    const urls: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      const u = `https://many${i}.test/rss`;
      urls[u] = rss([{ guid: `m${i}`, link: `https://many${i}.test/m`, title: `M${i}` }]);
      await createFeed(`many-${i}`, u);
    }
    const summary = await runIngestionCycle({ db, fetchFeed: fakeFetcher(urls), now: () => NOW }, { concurrency: 2 });
    assert.equal(summary.results.length, 5);
    assert.equal(summary.succeeded, 5);
    assert.equal(await db.article.count(), 5);
  });

  await check('stories: the same canonical URL from two feeds forms one story with both sources', async () => {
    await resetDatabase();
    const a = await createFeed('st-a', 'https://st-a.test/rss');
    const b = await createFeed('st-b', 'https://st-b.test/rss');
    const fetch = fakeFetcher({
      'https://st-a.test/rss': rss([{ guid: 'a1', link: 'https://news.test/big-breach?utm_source=rss', title: 'Breach (A)', pub: 'Thu, 12 Nov 2026 08:00:00 GMT' }]),
      'https://st-b.test/rss': rss([{ guid: 'b1', link: 'https://news.test/big-breach', title: 'Breach (B)', pub: 'Thu, 12 Nov 2026 09:00:00 GMT' }]),
    });
    await ingestFeed(depsWith(fetch, () => NOW), await activeFeed(a));
    await ingestFeed(depsWith(fetch, () => new Date(NOW.getTime() + 60_000)), await activeFeed(b));

    const stories = await db.story.findMany({ include: { articles: { include: { article: true } } } });
    assert.equal(stories.length, 1);
    assert.equal(stories[0].clusterKey, 'https://news.test/big-breach');
    assert.equal(stories[0].articleCount, 2);
    const feedIds = new Set(stories[0].articles.map((l) => l.article.feedId));
    assert.deepEqual([...feedIds].sort(), [a, b].sort());
    assert.equal(stories[0].title, 'Breach (B)', 'title follows the most recent article');
  });

  await check('stories: re-linking is a no-op and summary fields reflect the newest article', async () => {
    await resetDatabase();
    const feedId = await createFeed('st-c', 'https://st-c.test/rss');
    const early = rss([{ guid: 'c1', link: 'https://news.test/c', title: 'First' }]);
    await ingestFeed(depsWith(fakeFetcher({ 'https://st-c.test/rss': early }), () => NOW), await activeFeed(feedId));
    const again = await linkUnassignedArticles(db);
    assert.equal(again.linkedArticles, 0, 'nothing left to link');
    const sameOnce = await db.story.count();
    await linkUnassignedArticles(db);
    assert.equal(await db.story.count(), sameOnce);

    const story = await db.story.findFirstOrThrow({ where: { clusterKey: 'https://news.test/c' } });
    assert.equal(story.articleCount, 1);
    assert.equal(story.title, 'First');
    assert.ok(story.firstPublishedAt && story.lastPublishedAt, 'published bounds set from the article date');
  });

  await db.$disconnect();
  if (failures > 0) {
    console.log(`\n${failures} integration check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll integration checks passed.');
  }
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exitCode = 1;
});
