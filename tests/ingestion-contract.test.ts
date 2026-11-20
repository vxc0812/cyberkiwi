import assert from 'node:assert/strict';
import {
  applyFetchOutcome,
  canonicalizeUrl,
  externalIdFor,
  nextAttemptDelayMinutes,
  normalizeBatch,
  normalizeItem,
  runStatusFor,
  LIMITS,
  type FeedHealth,
  type RawFeedItem,
} from '../server/ingestion/contract';
import { fetchFeedXml, parseFeedXml } from '../server/ingestion/fetchFeed';

const NOW = new Date('2026-11-13T12:00:00Z');
const FEED_ID = '11111111-1111-4111-8111-111111111111';

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

const emptyHealth: FeedHealth = {
  consecutiveFailures: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
};

async function main() {
  // --- canonicalizeUrl ---------------------------------------------------
  await check('canonical: strips tracking params and fragment', () => {
    assert.equal(
      canonicalizeUrl('https://Example.com:443/news/item/?utm_source=x&id=7&fbclid=abc#top'),
      'https://example.com/news/item?id=7'
    );
  });
  await check('canonical: sorts remaining params for stable keys', () => {
    assert.equal(canonicalizeUrl('https://a.test/p?b=2&a=1'), 'https://a.test/p?a=1&b=2');
  });
  await check('canonical: keeps root slash, drops trailing slash elsewhere', () => {
    assert.equal(canonicalizeUrl('https://a.test/'), 'https://a.test/');
    assert.equal(canonicalizeUrl('https://a.test/x/'), 'https://a.test/x');
  });
  await check('canonical: removes default http port only', () => {
    assert.equal(canonicalizeUrl('http://a.test:80/x'), 'http://a.test/x');
    assert.equal(canonicalizeUrl('http://a.test:8080/x'), 'http://a.test:8080/x');
  });
  await check('canonical: rejects non-http schemes and garbage', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://a.test/x', 'not a url', '', null, 42]) {
      assert.equal(canonicalizeUrl(bad as any), null, `expected null for ${String(bad)}`);
    }
  });

  // --- externalIdFor -----------------------------------------------------
  await check('externalId: prefers feed GUID', () => {
    assert.equal(externalIdFor(' abc-1 ', 'https://a.test/x'), 'guid:abc-1');
  });
  await check('externalId: falls back to canonical link', () => {
    assert.equal(externalIdFor(undefined, 'https://a.test/x'), 'link:https://a.test/x');
  });
  await check('externalId: hashes overlong values to stay bounded', () => {
    const id = externalIdFor('g'.repeat(2000), 'https://a.test/x');
    assert.ok(id && id.startsWith('sha256:') && id.length < 100);
  });

  // --- normalizeItem -----------------------------------------------------
  await check('normalizeItem: rejects missing title', () => {
    const r = normalizeItem({ link: 'https://a.test/x', title: '   ' }, FEED_ID, NOW);
    assert.deepEqual(r, { ok: false, reason: 'missing_title' });
  });
  await check('normalizeItem: rejects invalid link', () => {
    const r = normalizeItem({ link: 'javascript:void(0)', title: 'Hi' }, FEED_ID, NOW);
    assert.deepEqual(r, { ok: false, reason: 'invalid_link' });
  });
  await check('normalizeItem: strips markup from title and excerpt', () => {
    const r = normalizeItem(
      { guid: 'g1', link: 'https://a.test/x', title: '<b>CVE-2026-0001</b> &amp; patch', summary: '<p>Fixed&nbsp;now</p>' },
      FEED_ID,
      NOW
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.article.title, 'CVE-2026-0001 & patch');
      assert.equal(r.article.excerpt, 'Fixed now');
      assert.equal(r.article.externalId, 'guid:g1');
    }
  });
  await check('normalizeItem: caps title and excerpt lengths', () => {
    const r = normalizeItem(
      { link: 'https://a.test/x', title: 'T'.repeat(1000), contentSnippet: 'E'.repeat(2000) },
      FEED_ID,
      NOW
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.ok(r.article.title.length <= LIMITS.titleMaxChars);
      assert.ok((r.article.excerpt ?? '').length <= LIMITS.excerptMaxChars);
    }
  });
  await check('normalizeItem: invalid or far-future dates become null', () => {
    const bad = normalizeItem({ link: 'https://a.test/x', title: 'a', isoDate: 'yesterday-ish' }, FEED_ID, NOW);
    const future = normalizeItem({ link: 'https://a.test/x', title: 'a', isoDate: '2031-01-01T00:00:00Z' }, FEED_ID, NOW);
    const ok = normalizeItem({ link: 'https://a.test/x', title: 'a', isoDate: '2026-11-12T08:00:00Z' }, FEED_ID, NOW);
    assert.equal(bad.ok && bad.article.publishedAt, null);
    assert.equal(future.ok && future.article.publishedAt, null);
    assert.equal(ok.ok && ok.article.publishedAt?.toISOString(), '2026-11-12T08:00:00.000Z');
  });
  await check('normalizeItem: content hash is stable for whitespace and case changes', () => {
    const a = normalizeItem({ link: 'https://a.test/x', title: 'Big  Breach', summary: 'Data  leaked' }, FEED_ID, NOW);
    const b = normalizeItem({ link: 'https://a.test/x', title: 'big breach', summary: 'data leaked' }, FEED_ID, NOW);
    assert.equal(a.ok && b.ok && a.article.contentHash, b.ok && a.ok && b.article.contentHash);
  });

  // --- normalizeBatch ----------------------------------------------------
  await check('batch: dedupes by externalId and counts rejects', () => {
    const items: RawFeedItem[] = [
      { guid: 'same', link: 'https://a.test/1', title: 'First' },
      { guid: 'same', link: 'https://a.test/1', title: 'Second copy' },
      { link: 'nope', title: 'Bad link' },
      { guid: 'other', link: 'https://a.test/2', title: 'Second item' },
    ];
    const batch = normalizeBatch(items, FEED_ID, NOW);
    assert.equal(batch.articles.length, 2);
    assert.equal(batch.duplicates, 1);
    assert.deepEqual(batch.rejected, [{ index: 2, reason: 'invalid_link' }]);
    assert.equal(batch.truncated, false);
  });
  await check('batch: caps items per feed', () => {
    const items = Array.from({ length: LIMITS.maxItemsPerFeed + 5 }, (_, i) => ({
      guid: `g${i}`,
      link: `https://a.test/${i}`,
      title: `Item ${i}`,
    }));
    const batch = normalizeBatch(items, FEED_ID, NOW);
    assert.equal(batch.articles.length, LIMITS.maxItemsPerFeed);
    assert.equal(batch.truncated, true);
  });

  // --- feed health and backoff ------------------------------------------
  await check('health: failure increments streak and records error', () => {
    const next = applyFetchOutcome(emptyHealth, { kind: 'failure', at: NOW, errorCode: 'HTTP', errorMessage: '503' });
    assert.equal(next.consecutiveFailures, 1);
    assert.equal(next.lastError, 'HTTP: 503');
    assert.equal(next.lastFailureAt, NOW);
  });
  await check('health: success and 304 both reset the streak', () => {
    const failing = { ...emptyHealth, consecutiveFailures: 4, lastError: 'x' };
    const ok = applyFetchOutcome(failing, { kind: 'success', at: NOW });
    const nm = applyFetchOutcome(failing, { kind: 'not_modified', at: NOW });
    assert.equal(ok.consecutiveFailures, 0);
    assert.equal(ok.lastError, null);
    assert.equal(nm.consecutiveFailures, 0);
    assert.equal(nm.lastSuccessAt, NOW);
  });
  await check('backoff: base interval when healthy, doubled per failure, capped at 24h', () => {
    assert.equal(nextAttemptDelayMinutes(15, 0), 15);
    assert.equal(nextAttemptDelayMinutes(15, 1), 30);
    assert.equal(nextAttemptDelayMinutes(15, 3), 120);
    assert.equal(nextAttemptDelayMinutes(15, 50), LIMITS.maxBackoffMinutes);
  });
  await check('run status: FAILED, PARTIAL and SUCCEEDED rules', () => {
    assert.equal(runStatusFor({ fetchOk: false, itemsSeen: 0, itemsRejected: 0 }), 'FAILED');
    assert.equal(runStatusFor({ fetchOk: true, itemsSeen: 10, itemsRejected: 2 }), 'PARTIAL');
    assert.equal(runStatusFor({ fetchOk: true, itemsSeen: 3, itemsRejected: 3 }), 'PARTIAL');
    assert.equal(runStatusFor({ fetchOk: true, itemsSeen: 0, itemsRejected: 0 }), 'SUCCEEDED');
  });

  // --- parsing (offline fixture) and the shared fetch path -------------
  const fixture = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Fixture Security</title>
  <item>
    <guid isPermaLink="false">fx-1</guid>
    <title>Critical RCE in ExampleVPN &amp; patch now</title>
    <link>https://news.example.test/vpn-rce?utm_medium=rss&amp;id=9</link>
    <description>&lt;p&gt;Attackers exploit CVE-2026-1234.&lt;/p&gt;</description>
    <pubDate>Thu, 12 Nov 2026 08:00:00 GMT</pubDate>
    <enclosure url="https://cdn.example.test/vpn.jpg" type="image/jpeg" length="10"/>
  </item>
</channel></rss>`;

  await check('parse: RSS fixture normalizes end to end', async () => {
    const parsed = await parseFeedXml(fixture);
    assert.equal(parsed.title, 'Fixture Security');
    const batch = normalizeBatch(parsed.items, FEED_ID, NOW);
    assert.equal(batch.articles.length, 1);
    const [a] = batch.articles;
    assert.equal(a.title, 'Critical RCE in ExampleVPN & patch now');
    assert.equal(a.canonicalUrl, 'https://news.example.test/vpn-rce?id=9');
    assert.equal(a.externalId, 'guid:fx-1');
    assert.equal(a.imageUrl, 'https://cdn.example.test/vpn.jpg');
    assert.equal(a.excerpt, 'Attackers exploit CVE-2026-1234.');
    assert.equal(a.publishedAt?.toISOString(), '2026-11-12T08:00:00.000Z');
  });

  await check('parse: podcast audio survives normalization and is not used as artwork', async () => {
    const parsed = await parseFeedXml(fixture.replace(
      /<enclosure[^>]+>/,
      '<enclosure url="https://127.0.0.1/episode.mp3" type="audio/mpeg"/>' +
      '<enclosure url="https://cdn.example.test/episode.mp3?ref=player&amp;token=abc" type="audio/mpeg"/>',
    ));
    const [episode] = normalizeBatch(parsed.items, FEED_ID, NOW).articles;
    assert.equal(episode.imageUrl, null);
    assert.equal(episode.audioUrl, 'https://cdn.example.test/episode.mp3?ref=player&token=abc');
  });

  await check('fetch: refuses private targets before any connection', async () => {
    await assert.rejects(fetchFeedXml('http://127.0.0.1:9/feed.xml'), /Private IP addresses not allowed/);
    await assert.rejects(fetchFeedXml('http://169.254.169.254/latest/meta-data/'), /Private IP addresses not allowed/);
  });
  await check('fetch: refuses non-http schemes', async () => {
    await assert.rejects(fetchFeedXml('file:///etc/passwd'), /not allowed/);
  });

  if (failures > 0) {
    console.log(`\n${failures} ingestion contract check(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
