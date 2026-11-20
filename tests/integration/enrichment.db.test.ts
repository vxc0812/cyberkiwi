/**
 * Integration tests for enrichment against PostgreSQL: idempotent jobs, retries, RSS isolation, catalog
 * provenance and the read-API filters.
 * Run with npm run test:db (refuses to run unless the database name ends in _test).
 */
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createPrisma, databaseUrl } from '../../server/db/client';
import { normalizeBatch, type RawFeedItem } from '../../server/ingestion/contract';
import { ingestFeed } from '../../server/ingestion/worker';
import { upsertArticles, upsertFeed, upsertSource, listActiveFeeds } from '../../server/repositories/ingestion';
import { linkUnassignedArticles } from '../../server/repositories/stories';
import { createReadApi } from '../../server/api/readApi';
import { PRINCIPAL_LOCAL } from '../../server/auth/middleware';
import type { Principal } from '../../server/auth/session';

// Content reads are invite-only; these checks test filtering, so they run as a signed-in reader.
const READER: Principal = { sessionId: 's', userId: 'u', email: 'reader@example.test', role: 'USER', kind: 'WEB', csrfHash: null };
const signedIn: express.RequestHandler = (_req, res, next) => { res.locals[PRINCIPAL_LOCAL] = READER; next(); };
import { enqueueEnrichment, enqueueChangedArticles, claimDueJobs } from '../../server/enrichment/queue';
import { ARTICLE_PROVIDERS, localProviders, runEnrichmentBatch, type EnrichmentProvider } from '../../server/enrichment/providers';
import { parseEpssCsv, recordSyncFailure, syncEpss, syncKev, KEV_PROVIDER } from '../../server/enrichment/catalog';
import { createEnrichmentStatsRouter } from '../../server/enrichment/stats';

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
    'TRUNCATE "IngestionRun", "StoryArticle", "Story", "Article", "Feed", "Source", "EnrichmentJob", "ArticleCve", "ArticleTechnique", "ArticleEntity", "EpssSnapshot", "KevEntry", "Cve", "MitreTechnique", "Entity", "CatalogSync" RESTART IDENTITY CASCADE'
  );
}

async function feedFor(slug: string, feedUrl: string): Promise<string> {
  const sourceId = await upsertSource(db, { slug, name: `Source ${slug}`, category: 'news' });
  return upsertFeed(db, { sourceId, url: feedUrl, category: 'news', title: `Feed ${slug}` });
}

async function storeItems(feedId: string, items: RawFeedItem[], now: Date = NOW): Promise<string[]> {
  const batch = normalizeBatch(items, feedId, now);
  await upsertArticles(db, feedId, batch.articles, now);
  await linkUnassignedArticles(db);
  const rows = await db.article.findMany({ where: { feedId }, select: { id: true } });
  return rows.map((r) => r.id);
}

const STORY_TEXT = 'CVE-2024-3400 in PAN-OS: ransomware gangs exploit internet-facing VPN gateways. Fortigate devices hit by LockBit; APT28 pivots to Microsoft Exchange Server';

async function main(): Promise<void> {
  await resetDatabase();

  await check('queue: enqueueing is idempotent per (article, provider)', async () => {
    const feedId = await feedFor('q', 'https://q.test/rss');
    const [articleId] = await storeItems(feedId, [{ guid: 'q1', link: 'https://q.test/1', title: 'Story one', isoDate: NOW.toISOString() }]);
    assert.equal(await enqueueEnrichment(db, [articleId], ARTICLE_PROVIDERS), 3);
    assert.equal(await enqueueEnrichment(db, [articleId], ARTICLE_PROVIDERS), 0, 'second enqueue creates nothing');
    assert.equal(await db.enrichmentJob.count({ where: { articleId, status: 'PENDING' } }), 3);
  });

  await check('providers: a run extracts CVEs, ATT&CK techniques and entities, and a repeated run adds no duplicates', async () => {
    const feedId = await feedFor('p', 'https://p.test/rss');
    const [articleId] = await storeItems(feedId, [{ guid: 'p1', link: 'https://p.test/1', title: STORY_TEXT, isoDate: NOW.toISOString() }]);
    await enqueueEnrichment(db, [articleId], ARTICLE_PROVIDERS);
    const first = await runEnrichmentBatch(db, localProviders, { now: new Date(Date.now() + 1000), limit: 100 });
    assert.ok(first.done >= 3, 'this article three jobs ran (other due jobs may run too)');
    assert.equal(first.failed + first.retried, 0);

    assert.ok(await db.cve.findUnique({ where: { id: 'CVE-2024-3400' } }), 'CVE stub created');
    const techniques = (await db.articleTechnique.findMany({ where: { articleId }, select: { techniqueId: true } })).map((t) => t.techniqueId).sort();
    assert.deepEqual(techniques, ['T1190', 'T1486']);
    const entities = await db.articleEntity.findMany({ where: { articleId }, include: { entity: true } });
    const slugs = entities.map((e) => `${e.entity.type}:${e.entity.slug}`).sort();
    assert.ok(slugs.includes('VENDOR:fortinet') && slugs.includes('THREAT_ACTOR:apt28') && slugs.includes('VENDOR:microsoft'));

    const linksBefore = await db.articleEntity.count({ where: { articleId } }) + await db.articleCve.count({ where: { articleId } }) + await db.articleTechnique.count({ where: { articleId } });
    // Re-enqueue and re-run the same article: a retry must not duplicate any row.
    await db.enrichmentJob.updateMany({ where: { articleId }, data: { status: 'PENDING', nextAttemptAt: new Date(0) } });
    await runEnrichmentBatch(db, localProviders, { now: new Date(Date.now() + 2000), limit: 100 });
    const linksAfter = await db.articleEntity.count({ where: { articleId } }) + await db.articleCve.count({ where: { articleId } }) + await db.articleTechnique.count({ where: { articleId } });
    assert.equal(linksAfter, linksBefore, 'idempotent: no duplicate join rows on retry');
  });

  await check('claiming: two claims never receive the same job', async () => {
    const feedId = await feedFor('c', 'https://c.test/rss');
    const ids = await storeItems(feedId, Array.from({ length: 5 }, (_, i) => ({ guid: `c${i}`, link: `https://c.test/${i}`, title: `Item ${i}`, isoDate: NOW.toISOString() })));
    await enqueueEnrichment(db, ids, ['claim-test']);
    const [a, b] = await Promise.all([claimDueJobs(db, 3, new Date()), claimDueJobs(db, 3, new Date())]);
    // Other due jobs from earlier tests may be claimed too. This test checks only its own provider.
    const mine = [...a, ...b].filter((j) => j.provider === 'claim-test').map((j) => j.id);
    assert.equal(new Set(mine).size, mine.length, 'no job is claimed twice');
    assert.equal(mine.length, 5);
    const all = [...a, ...b].map((j) => j.id);
    assert.equal(new Set(all).size, all.length, 'no job is claimed twice across all providers');
    // Leave no due jobs behind for later tests.
    await db.enrichmentJob.updateMany({ where: { provider: 'claim-test' }, data: { status: 'DONE' } });
  });

  await check('failures: a failing provider backs off, then the job is marked FAILED after its last attempt', async () => {
    const feedId = await feedFor('f', 'https://f.test/rss');
    const [articleId] = await storeItems(feedId, [{ guid: 'f1', link: 'https://f.test/1', title: 'Breaking item', isoDate: NOW.toISOString() }]);
    await enqueueEnrichment(db, [articleId], ['boom']);
    // Local providers stay registered so that other due jobs succeed and only "boom" fails.
    const boom: Record<string, EnrichmentProvider> = {
      ...localProviders,
      boom: async () => { throw new Error('upstream returned 503'); },
    };

    const t0 = new Date(Date.now() + 5000);
    const first = await runEnrichmentBatch(db, boom, { now: t0, maxAttempts: 2 });
    assert.equal(first.retried, 1);
    const afterFirst = await db.enrichmentJob.findFirstOrThrow({ where: { articleId, provider: 'boom' } });
    assert.equal(afterFirst.status, 'PENDING');
    assert.equal(afterFirst.attempts, 1);
    assert.match(afterFirst.lastError ?? '', /upstream returned 503/);
    assert.ok(afterFirst.nextAttemptAt.getTime() > t0.getTime(), 'retry is scheduled in the future');

    const notYet = await runEnrichmentBatch(db, boom, { now: t0 });
    assert.equal(notYet.claimed, 0, 'not due before the backoff ends');

    const last = await runEnrichmentBatch(db, boom, { now: new Date(t0.getTime() + 10 * 60 * 1000), maxAttempts: 2 });
    assert.equal(last.failed, 1);
    const final = await db.enrichmentJob.findFirstOrThrow({ where: { articleId, provider: 'boom' } });
    assert.equal(final.status, 'FAILED');
    assert.equal(final.attempts, 2);
  });

  await check('RSS isolation: a failing enrichment queue does not fail the feed run, and articles are still stored', async () => {
    const feedId = await feedFor('iso', 'https://iso.test/rss');
    const [feed] = (await listActiveFeeds(db)).filter((f) => f.id === feedId);
    const items: RawFeedItem[] = [{ guid: 'i1', link: 'https://iso.test/1', title: 'Isolated item', isoDate: NOW.toISOString() }];
    const result = await ingestFeed(
      {
        db,
        fetchFeed: async () => ({ kind: 'ok', httpStatus: 200, body: '<rss/>', etag: null, lastModified: null }),
        parseFeed: async () => ({ title: 'T', items }),
        enqueueEnrichment: async () => { throw new Error('enrichment store unavailable'); },
        now: () => NOW,
      },
      feed
    );
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.itemsNew, 1);
    assert.equal(await db.article.count({ where: { feedId } }), 1);
  });

  await check('RSS queueing: by default, a successful run queues jobs only for articles that changed', async () => {
    const feedId = await feedFor('queue', 'https://queue.test/rss');
    const [feed] = (await listActiveFeeds(db)).filter((f) => f.id === feedId);
    const items: RawFeedItem[] = [
      { guid: 'g1', link: 'https://queue.test/1', title: 'One', isoDate: NOW.toISOString() },
      { guid: 'g2', link: 'https://queue.test/2', title: 'Two', isoDate: NOW.toISOString() },
    ];
    const deps = {
      db,
      fetchFeed: async () => ({ kind: 'ok' as const, httpStatus: 200, body: '<rss/>', etag: null, lastModified: null }),
      parseFeed: async () => ({ title: 'T', items }),
      now: () => NOW,
    };
    await ingestFeed(deps, feed);
    assert.equal(await db.enrichmentJob.count({ where: { article: { feedId } } }), 6, '2 articles x 3 providers');
    await ingestFeed(deps, feed);
    assert.equal(await db.enrichmentJob.count({ where: { article: { feedId } } }), 6, 'an unchanged re-run queues nothing new');
  });

  await check('KEV: a sync sets knownExploited and records provenance; an unchanged re-sync does not touch updatedAt', async () => {
    const catalog = {
      dateReleased: '2026-11-15T00:00:00Z',
      vulnerabilities: [
        { cveID: 'CVE-2024-3400', vendorProject: 'Palo Alto Networks', product: 'PAN-OS', dateAdded: '2024-04-12', dueDate: '2024-05-03', knownRansomwareCampaignUse: 'Known' },
      ],
    };
    await syncKev(db, catalog, new Date('2026-11-15T01:00:00Z'));
    const first = await db.cve.findUniqueOrThrow({ where: { id: 'CVE-2024-3400' }, include: { kev: true } });
    assert.equal(first.knownExploited, true);
    assert.equal(first.kev?.ransomwareCampaignUse, true);
    assert.equal(first.kev?.vendorProject, 'Palo Alto Networks');
    const stamp = first.updatedAt.getTime();

    await new Promise((r) => setTimeout(r, 20));
    await syncKev(db, catalog, new Date('2026-11-16T01:00:00Z'));
    const second = await db.cve.findUniqueOrThrow({ where: { id: 'CVE-2024-3400' } });
    assert.equal(second.updatedAt.getTime(), stamp, 'no churn when nothing changed');
    assert.equal((await db.catalogSync.findUniqueOrThrow({ where: { provider: KEV_PROVIDER } })).lastStatus, 'ok');
  });

  await check('EPSS: updates only CVEs we track, keeps one snapshot per day, and an unchanged re-run updates nothing', async () => {
    const csv = ['#model_version:v1', 'cve,epss,percentile', 'CVE-2024-3400,0.97431,0.99981', 'CVE-2099-0001,0.5,0.9'].join('\n');
    assert.equal(parseEpssCsv(csv).length, 2);
    const day = new Date('2026-11-15T00:00:00Z');
    const first = await syncEpss(db, csv, day, new Date('2026-11-15T02:00:00Z'));
    assert.equal(first.updated, 1, 'untracked CVE-2099-0001 is ignored');
    const cve = await db.cve.findUniqueOrThrow({ where: { id: 'CVE-2024-3400' } });
    assert.equal(cve.epss, 0.97431);
    assert.equal(cve.epssPercentile, 0.99981);
    assert.equal(await db.cve.count({ where: { id: 'CVE-2099-0001' } }), 0);
    assert.equal(await db.epssSnapshot.count({ where: { cveId: 'CVE-2024-3400' } }), 1);

    const again = await syncEpss(db, csv, day, new Date('2026-11-15T03:00:00Z'));
    assert.equal(again.updated, 0);
    assert.equal(await db.epssSnapshot.count({ where: { cveId: 'CVE-2024-3400' } }), 1, 'same-day rerun upserts the snapshot');
  });

  await check('catalog failures are recorded without losing the last successful sync time', async () => {
    const before = await db.catalogSync.findUniqueOrThrow({ where: { provider: KEV_PROVIDER } });
    await recordSyncFailure(db, KEV_PROVIDER, 'HTTP 503 from www.cisa.gov', new Date('2026-11-17T00:00:00Z'));
    const after = await db.catalogSync.findUniqueOrThrow({ where: { provider: KEV_PROVIDER } });
    assert.equal(after.lastStatus, 'failed');
    assert.equal(after.lastError, 'HTTP 503 from www.cisa.gov');
    assert.equal(after.lastSuccessAt?.getTime(), before.lastSuccessAt?.getTime());
  });

  // Filters over HTTP. Story A: KEV, EPSS 0.97, T1190. Story B: no KEV, EPSS 0.1, T1566.
  await check('read filters: kev, minEpss, cve and technique select the right stories, and bad values are refused', async () => {
    const feedA = await feedFor('filter-a', 'https://filter-a.test/rss');
    const feedB = await feedFor('filter-b', 'https://filter-b.test/rss');
    const [articleA] = await storeItems(feedA, [{ guid: 'fa', link: 'https://filter-a.test/1', title: 'Story A: PAN-OS exploited', contentSnippet: STORY_TEXT, isoDate: NOW.toISOString() }]);
    const [articleB] = await storeItems(feedB, [{ guid: 'fb', link: 'https://filter-b.test/1', title: 'Story B: phishing wave', contentSnippet: 'Phishing lures mention CVE-2023-0001 widely.', isoDate: NOW.toISOString() }]);
    await enqueueEnrichment(db, [articleA, articleB], ARTICLE_PROVIDERS);
    await runEnrichmentBatch(db, localProviders, { now: new Date(Date.now() + 1000), limit: 100 });
    await db.cve.upsert({ where: { id: 'CVE-2023-0001' }, create: { id: 'CVE-2023-0001', provider: 'test', epss: 0.1 }, update: { epss: 0.1 } });
    await db.cve.update({ where: { id: 'CVE-2024-3400' }, data: { knownExploited: true, epss: 0.97 } });
    assert.ok(articleA && articleB);

    const app = express();
    app.use(signedIn);
    app.use('/api/v1', createReadApi(db));
    const server: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
    try {
      const titles = async (query: string) => {
        const res = await fetch(`${base}/stories?${query}`);
        assert.equal(res.status, 200, `${query}: ${res.status}`);
        const body = await res.json();
        return body.items.map((s: { title: string }) => s.title).sort();
      };
      // The earlier providers test stored an article with the same CVE, so it is also a KEV match.
      const KEV_TITLES = ['Story A: PAN-OS exploited', STORY_TEXT].sort();
      assert.deepEqual(await titles('kev=true'), KEV_TITLES);
      assert.deepEqual(await titles('minEpss=0.5'), KEV_TITLES);
      assert.deepEqual(await titles('minEpss=0.05'), [...KEV_TITLES, 'Story B: phishing wave'].sort());
      assert.deepEqual(await titles('cve=cve-2023-0001'), ['Story B: phishing wave']);
      assert.deepEqual(await titles('technique=T1566'), ['Story B: phishing wave']);
      assert.deepEqual(await titles('kev=true&minEpss=0.5'), KEV_TITLES);
      assert.deepEqual(await titles('kev=true&minEpss=0.99'), [], 'the same CVE must satisfy both conditions');
      assert.deepEqual(await titles('technique=T1566&kev=true'), [], 'kev and technique are separate article conditions');

      // Both the earlier provider article and Story A carry the same "exploit internet-facing" text.
      const articles = await (await fetch(`${base}/articles?technique=T1190`)).json();
      assert.equal(articles.items.length, 2);
      assert.ok(articles.items.every((a: { title: string }) => a.title.length > 0));

      for (const bad of ['minEpss=2', 'minEpss=high', 'kev=false', 'cve=CVE-24-1', 'technique=T9', 'minEpss=0.5&minEpss=0.6']) {
        const res = await fetch(`${base}/stories?${bad}`);
        assert.equal(res.status, 400, bad);
        assert.equal((await res.json()).error.code, 'invalid_filter', bad);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await check('feed worker: a run only enqueues; no CVE, ATT&CK or entity rows are written inline', async () => {
    const feedId = await feedFor('inline', 'https://inline.test/rss');
    const [feed] = (await listActiveFeeds(db)).filter((f) => f.id === feedId);
    const items: RawFeedItem[] = [{ guid: 'in1', link: 'https://inline.test/1', title: STORY_TEXT, isoDate: NOW.toISOString() }];
    const result = await ingestFeed(
      { db, fetchFeed: async () => ({ kind: 'ok', httpStatus: 200, body: '<rss/>', etag: null, lastModified: null }), parseFeed: async () => ({ title: 'T', items }), now: () => NOW },
      feed
    );
    assert.equal(result.status, 'SUCCEEDED');
    const articleIds = (await db.article.findMany({ where: { feedId }, select: { id: true } })).map((a) => a.id);
    assert.equal(await db.enrichmentJob.count({ where: { articleId: { in: articleIds }, status: 'PENDING' } }), 3, 'jobs are queued');
    assert.equal(await db.articleCve.count({ where: { articleId: { in: articleIds } } }), 0, 'no inline CVE work');
    assert.equal(await db.articleTechnique.count({ where: { articleId: { in: articleIds } } }), 0, 'no inline ATT&CK work');
    assert.equal(await db.articleEntity.count({ where: { articleId: { in: articleIds } } }), 0, 'no inline entity work');
  });

  await check('enrichment failure does not change the feed run: the run stays SUCCEEDED and the feed stays healthy', async () => {
    const feedId = await feedFor('healthy', 'https://healthy.test/rss');
    const [feed] = (await listActiveFeeds(db)).filter((f) => f.id === feedId);
    const items: RawFeedItem[] = [{ guid: 'h1', link: 'https://healthy.test/1', title: 'Healthy item', isoDate: NOW.toISOString() }];
    const result = await ingestFeed(
      { db, fetchFeed: async () => ({ kind: 'ok', httpStatus: 200, body: '<rss/>', etag: null, lastModified: null }), parseFeed: async () => ({ title: 'T', items }), now: () => NOW },
      feed
    );
    assert.equal(result.status, 'SUCCEEDED');
    const failing: Record<string, EnrichmentProvider> = {
      ...localProviders,
      'cve-link': async () => { throw new Error('enrichment provider exploded'); },
    };
    const summary = await runEnrichmentBatch(db, failing, { now: new Date(Date.now() + 1000), limit: 100 });
    assert.ok(summary.retried + summary.failed >= 1, 'the enrichment failure was recorded');
    const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: result.runId! } });
    assert.equal(run.status, 'SUCCEEDED', 'the feed run is not affected');
    const row = await db.feed.findUniqueOrThrow({ where: { id: feedId } });
    assert.equal(row.consecutiveFailures, 0);
    assert.equal(row.lastError, null);
  });

  await check('severity and vendor filters: an NVD article sets CVSS severity; vendor matches the entity table', async () => {
    const feedId = await feedFor('nvd-sev', 'https://nvd-sev.test/rss');
    const [articleId] = await storeItems(feedId, [{
      guid: 'nvd-7777',
      link: 'https://nvd.nist.gov/vuln/detail/CVE-2024-7777',
      title: 'CVE-2024-7777: Remote code execution in Example Gateway',
      contentSnippet: 'CVSS 9.8 CRITICAL. Remote code execution in Example Gateway',
      isoDate: NOW.toISOString(),
    }], new Date(Date.now() + 2000));
    await enqueueEnrichment(db, [articleId], ARTICLE_PROVIDERS);
    await runEnrichmentBatch(db, localProviders, { now: new Date(Date.now() + 3000), limit: 100 });
    const cve = await db.cve.findUniqueOrThrow({ where: { id: 'CVE-2024-7777' } });
    assert.equal(cve.cvssSeverity, 'CRITICAL');
    assert.equal(cve.cvssScore, 9.8);

    const app = express();
    app.use(signedIn);
    app.use('/api/v1', createReadApi(db));
    const server: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
    try {
      const titles = async (q: string) => ((await (await fetch(`${base}/stories?${q}`)).json()).items as { title: string }[]).map((i) => i.title);
      assert.ok((await titles('severity=critical')).some((t) => t.includes('CVE-2024-7777')));
      assert.equal((await titles('severity=low')).some((t) => t.includes('CVE-2024-7777')), false);
      assert.ok((await titles('vendor=microsoft')).some((t) => t.includes('Microsoft Exchange')), 'vendor matches the entity');
      assert.equal((await titles('vendor=cisco')).length, 0);
      assert.equal((await fetch(`${base}/stories?severity=severe`)).status, 400);
      assert.equal((await fetch(`${base}/stories?vendor=Micro%20soft`)).status, 400);

      // Provenance: severity parsed from article text is provisional, and the API says so.
      const withCve = await (await fetch(`${base}/articles?cve=CVE-2024-7777`)).json();
      const link = withCve.items[0].cves.find((c: { id: string }) => c.id === 'CVE-2024-7777');
      assert.equal(link.severity, 'CRITICAL');
      assert.equal(link.severitySource, 'article');
      assert.equal(link.severityProvisional, true);
      assert.ok(link.severityUpdatedAt, 'when the severity was recorded is exposed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await check('stats: only a signed-in admin sees /api/v1/enrichment/stats; the stats count jobs and catalogs', async () => {
    const app = express();
    app.use((req, res, next) => {
      const role = req.get('x-test-role');
      if (role) res.locals.principal = { sessionId: 's', userId: 'u', email: 'x@y.z', role, kind: 'WEB' };
      next();
    });
    app.use('/api/v1/enrichment', createEnrichmentStatsRouter(db));
    const server: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/enrichment/stats`;
    try {
      assert.equal((await fetch(base)).status, 401, 'anonymous');
      assert.equal((await fetch(base, { headers: { 'x-test-role': 'USER' } })).status, 403, 'member');
      const ok = await fetch(base, { headers: { 'x-test-role': 'ADMIN' } });
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.equal(typeof body.stats.jobs.PENDING, 'number');
      assert.ok(body.stats.catalogs.some((c: { provider: string }) => c.provider === KEV_PROVIDER));
      assert.ok(body.stats.cves.total >= 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await db.$disconnect();
  if (failures > 0) {
    console.log(`\n${failures} enrichment database check(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error('[enrichment.db] fatal:', err);
  await db.$disconnect();
  process.exitCode = 1;
});
