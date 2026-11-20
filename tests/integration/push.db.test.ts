/**
 * Integration tests for the push pipeline against PostgreSQL: ingestion queues breaking pushes, preferences and
 * dedupe decide who gets one, the worker sends and retries, dead tokens are revoked, and a push failure never
 * fails the feed run. Run with npm run test:db (refuses to run unless the database name ends in _test).
 */
import assert from 'node:assert/strict';
import { createPrisma, databaseUrl } from '../../server/db/client';
import { normalizeBatch, type RawFeedItem } from '../../server/ingestion/contract';
import { ingestFeed } from '../../server/ingestion/worker';
import { listActiveFeeds, upsertFeed, upsertSource } from '../../server/repositories/ingestion';
import { queueBreakingPushes, processPushJobs } from '../../server/push/jobs';
import type { PushSender, PushTarget, PushPayload, PushResult } from '../../server/push/sender';
import { createPushSender } from '../../server/push/sender';

const url = databaseUrl();
const dbName = new URL(url).pathname.replace(/^\//, '');
if (!dbName.endsWith('_test')) {
  console.error(`Refusing to run: database "${dbName}" does not end in "_test".`);
  process.exit(1);
}

const db = createPrisma(url);
const NOW = new Date();
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

async function resetDatabase(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE "PushJob", "Device", "Session", "User", "IngestionRun", "StoryArticle", "Story", "Article", "Feed", "Source" RESTART IDENTITY CASCADE'
  );
}

let userCount = 0;
async function device(name: string, platform: 'IOS' | 'ANDROID' | 'WEB', token: string, prefs: Record<string, unknown>) {
  userCount++;
  const user = await db.user.create({ data: { email: `${name}@test.example`, passwordHash: 'x' } });
  return db.device.create({
    data: { userId: user.id, platform, pushToken: token, appVersion: '1.0.0', notificationPrefs: prefs as object },
    select: { id: true, pushToken: true },
  });
}

/** Ingests one feed run through the real worker path, with the network stubbed out. */
async function ingest(feedUrl: string, category: string, items: RawFeedItem[], deps: Record<string, unknown> = {}) {
  const sourceId = await upsertSource(db, { slug: `src-${feedUrl}`, name: 'Src', category });
  const feedId = await upsertFeed(db, { sourceId, url: feedUrl, category, title: 'F' });
  const feed = (await listActiveFeeds(db)).find((f) => f.id === feedId)!;
  const result = await ingestFeed(
    {
      db,
      fetchFeed: async () => ({ kind: 'ok', httpStatus: 200, body: '<rss/>', etag: null, lastModified: null }),
      parseFeed: async () => ({ title: 'F', items }),
      now: () => NOW,
      ...deps,
    } as any,
    feed
  );
  return { feedId, result };
}

/** A sender whose result depends on the token, so one run can show every outcome. */
function scriptedSender(): { sender: PushSender; sent: PushTarget[] } {
  const sent: PushTarget[] = [];
  const sender: PushSender = {
    async send(target: PushTarget, _payload: PushPayload): Promise<PushResult> {
      sent.push(target);
      if (target.pushToken.startsWith('dead')) return 'invalid_token';
      if (target.pushToken.startsWith('boom')) return 'failed';
      return 'sent';
    },
  };
  return { sender, sent };
}

async function main(): Promise<void> {
  await resetDatabase();

  const ok = await device('ok', 'IOS', 'ok-' + 'a'.repeat(40), { breaking: true, categories: [] });
  const off = await device('off', 'ANDROID', 'off-' + 'b'.repeat(40), { breaking: false, categories: [] });
  const exploitsOnly = await device('exploits', 'IOS', 'exp-' + 'c'.repeat(40), { breaking: true, categories: ['exploits'] });
  const dead = await device('dead', 'ANDROID', 'dead-' + 'd'.repeat(40), { breaking: true, categories: [] });
  const boom = await device('boom', 'IOS', 'boom-' + 'e'.repeat(40), { breaking: true, categories: [] });

  const feedUrl = 'https://push-news.test/rss';
  const breaking: RawFeedItem = { guid: 'bk-1', link: 'https://push-news.test/zero-day', title: 'Actively exploited zero-day in Example VPN', isoDate: NOW.toISOString() };
  const routine: RawFeedItem = { guid: 'rt-1', link: 'https://push-news.test/earnings', title: 'Quarterly earnings beat expectations', isoDate: NOW.toISOString() };

  await check('ingestion: a breaking story queues one job per device that wants it, with the category filter applied', async () => {
    const { feedId, result } = await ingest(feedUrl, 'news', [breaking, routine]);
    assert.equal(result.status, 'SUCCEEDED');
    const jobs = await db.pushJob.findMany({ select: { deviceId: true, title: true, deepLink: true, storyId: true, category: true, status: true } });
    const targets = jobs.map((j) => j.deviceId).sort();
    assert.deepEqual(targets, [ok.id, boom.id, dead.id].sort(), 'devices with breaking on and matching category');
    assert.ok(!targets.includes(off.id), 'breaking off: no job');
    assert.ok(!targets.includes(exploitsOnly.id), 'category list excludes news: no job');
    assert.ok(jobs.every((j) => j.title === 'Breaking security news'), 'generic title only');
    assert.ok(jobs.every((j) => j.deepLink?.startsWith('cyberkiwi://story/')), 'deep link carries only a story id');
    assert.ok(jobs.every((j) => j.status === 'PENDING'));
    assert.equal(await db.article.count({ where: { feedId, title: { contains: 'earnings' } } }), 1);
    const routineJobs = await db.pushJob.count({ where: { title: { not: 'Breaking security news' } } });
    assert.equal(routineJobs, 0, 'routine news never queues a push');
  });

  await check('dedupe: re-running the same feed and re-queueing inside the window adds nothing', async () => {
    const before = await db.pushJob.count();
    await ingest(feedUrl, 'news', [breaking, routine]);
    assert.equal(await db.pushJob.count(), before, 'unchanged article: no new jobs');

    const feed = await db.feed.findFirstOrThrow({ where: { url: feedUrl } });
    const articleExternal = (await db.article.findFirstOrThrow({ where: { feedId: feed.id, title: { contains: 'zero-day' } } })).externalId;
    const again = await queueBreakingPushes(db, { feedId: feed.id, externalIds: [articleExternal], now: NOW });
    assert.equal(again, 0, 'same story, category and window: deduplicated');
  });

  await check('worker: sent, dead-token and failing sends are recorded; a dead token revokes its device', async () => {
    const { sender, sent } = scriptedSender();
    const summary = await processPushJobs(db, sender, { now: new Date(Date.now() + 1000), maxAttempts: 2 });
    assert.equal(summary.claimed, 3);
    assert.equal(summary.sent, 1);
    assert.equal(summary.invalid, 1);
    assert.equal(summary.retried, 1);
    assert.equal(sent.length, 3);

    const okJob = await db.pushJob.findFirstOrThrow({ where: { deviceId: ok.id } });
    assert.equal(okJob.status, 'SENT');
    const deadJob = await db.pushJob.findFirstOrThrow({ where: { deviceId: dead.id } });
    assert.equal(deadJob.status, 'INVALID');
    assert.equal((await db.device.findUniqueOrThrow({ where: { id: dead.id } })).revokedAt !== null, true, 'dead token device is revoked');
    const boomJob = await db.pushJob.findFirstOrThrow({ where: { deviceId: boom.id } });
    assert.equal(boomJob.status, 'PENDING');
    assert.equal(boomJob.attempts, 1);
    assert.equal(boomJob.lastError, 'send failed');
    assert.ok(boomJob.nextAttemptAt.getTime() > Date.now(), 'retry is scheduled');
  });

  await check('retries: a failing job stops at maxAttempts and is marked FAILED', async () => {
    const { sender } = scriptedSender();
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await processPushJobs(db, sender, { now: later, maxAttempts: 2 });
    const boomJob = await db.pushJob.findFirstOrThrow({ where: { deviceId: boom.id } });
    assert.equal(boomJob.status, 'FAILED');
    assert.equal(boomJob.attempts, 2);
  });

  await check('providers: with no credentials, pushes are never reported as sent; they wait for a provider', async () => {
    await ingest('https://push-news.test/rss2', 'news', [{ guid: 'bk-2', link: 'https://push-news.test/two', title: 'Emergency patch issued for Exchange', isoDate: NOW.toISOString() }]);
    const unconfigured = createPushSender({} as NodeJS.ProcessEnv);
    const summary = await processPushJobs(db, unconfigured, { now: new Date(Date.now() + 3 * 60 * 60 * 1000), maxAttempts: 9 });
    assert.equal(summary.sent, 0);
    assert.ok(summary.retried >= 1);
    const pending = await db.pushJob.findMany({ where: { status: 'PENDING', lastError: 'provider not configured' } });
    assert.ok(pending.length >= 1);
  });

  await check('isolation: a failing push queue does not fail the feed run', async () => {
    const { result } = await ingest('https://push-news.test/rss3', 'news', [{ guid: 'bk-3', link: 'https://push-news.test/three', title: 'Out-of-band update for router firmware', isoDate: NOW.toISOString() }], {
      queuePush: async () => { throw new Error('push store unavailable'); },
    });
    assert.equal(result.status, 'SUCCEEDED');
    const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: result.runId! } });
    assert.equal(run.status, 'SUCCEEDED');
  });

  await db.$disconnect();
  if (failures > 0) {
    console.log(`\n${failures} push database check(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error('[push.db] fatal:', err);
  await db.$disconnect();
  process.exitCode = 1;
});
