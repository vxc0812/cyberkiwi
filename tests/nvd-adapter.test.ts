import assert from 'node:assert/strict';
import { NVD_API_BASE, adapterFor, disabledReasonFor } from '../server/ingestion/catalogPolicy';
import { NVD_MAX_WINDOW_DAYS, nvdRequestHeaders, nvdRequestUrl, nvdTimestamp, nvdWindow, parseNvdResponse, pickCvss } from '../server/ingestion/adapters/nvd';
import { normalizeBatch } from '../server/ingestion/contract';
import { CYBERSEC_DEFAULT_FEEDS } from '../src/data/cybersecFeeds';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
  } catch (err: any) {
    failures++;
    console.log(`❌ [FAIL] ${name}: ${err?.message ?? err}`);
  }
}

const NOW = new Date('2026-11-13T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const fixture = JSON.stringify({
  resultsPerPage: 3,
  startIndex: 0,
  totalResults: 3,
  vulnerabilities: [
    {
      cve: {
        id: 'CVE-2026-1001',
        sourceIdentifier: 'cve@mitre.org',
        published: '2026-11-12T08:00:00.000',
        lastModified: '2026-11-12T09:00:00.000',
        descriptions: [
          { lang: 'es', value: 'Descripción en español' },
          { lang: 'en', value: 'Remote code execution in ExampleVPN via crafted request.' },
        ],
        metrics: {
          cvssMetricV31: [{ cvssData: { baseScore: 9.8, baseSeverity: 'CRITICAL' } }],
          cvssMetricV2: [{ baseSeverity: 'HIGH', cvssData: { baseScore: 7.5 } }],
        },
      },
    },
    {
      cve: {
        id: 'CVE-2026-1002',
        published: '2026-11-11T08:00:00.000',
        descriptions: [{ lang: 'en', value: 'Old scoring only.' }],
        metrics: { cvssMetricV2: [{ baseSeverity: 'MEDIUM', cvssData: { baseScore: 5.0 } }] },
      },
    },
    { cve: { id: 'CVE-2026-1003', published: '2026-11-10T08:00:00.000', descriptions: [] } },
    { cve: null },
  ],
});

check('window: incremental from the last success, with a one-hour overlap', () => {
  const since = new Date('2026-11-13T10:00:00.000Z');
  const w = nvdWindow(since, NOW);
  assert.equal(w.start.toISOString(), '2026-11-13T09:00:00.000Z');
  assert.equal(w.end.toISOString(), NOW.toISOString());
});

check('window: a first run looks back one day; very old success is clamped to the 120-day limit', () => {
  assert.equal(nvdWindow(null, NOW).start.toISOString(), new Date(NOW.getTime() - 6 * 60 * 60 * 1000).toISOString());
  const ancient = nvdWindow(new Date(NOW.getTime() - 400 * DAY), NOW);
  assert.equal(ancient.start.getTime(), NOW.getTime() - NVD_MAX_WINDOW_DAYS * DAY);
});

check('request: uses the NVD timestamp format and the page size', () => {
  const url = new URL(nvdRequestUrl(new Date('2026-11-13T10:00:00.000Z'), NOW));
  assert.equal(url.origin + url.pathname, NVD_API_BASE);
  assert.equal(url.searchParams.get('lastModStartDate'), '2026-11-13T09:00:00.000');
  assert.equal(url.searchParams.get('lastModEndDate'), '2026-11-13T12:00:00.000');
  assert.equal(url.searchParams.get('resultsPerPage'), '100');
  assert.equal(nvdTimestamp(NOW), '2026-11-13T12:00:00.000');
});

check('parse: maps English descriptions, prefers CVSS v3.1, falls back to v2, and skips malformed entries', () => {
  const parsed = parseNvdResponse(fixture);
  assert.equal(parsed.items.length, 3, 'the null entry is skipped');
  const [a, b, c] = parsed.items;
  assert.equal(a.guid, 'CVE-2026-1001');
  assert.equal(a.title, 'CVE-2026-1001: Remote code execution in ExampleVPN via crafted request.');
  assert.equal(a.contentSnippet, 'CVSS 9.8 CRITICAL. Remote code execution in ExampleVPN via crafted request.');
  assert.equal(a.link, 'https://nvd.nist.gov/vuln/detail/CVE-2026-1001');
  assert.equal(a.isoDate, '2026-11-12T08:00:00.000Z');
  assert.equal(b.contentSnippet, 'CVSS 5 MEDIUM. Old scoring only.');
  assert.equal(c.title, 'CVE-2026-1003', 'no description falls back to the id');
});

check('parse: the NVD items flow through the same normalizer as RSS items', () => {
  const batch = normalizeBatch(parseNvdResponse(fixture).items, '11111111-1111-4111-8111-111111111111', NOW);
  assert.equal(batch.articles.length, 3);
  assert.ok(batch.articles.every((x) => x.canonicalUrl.startsWith('https://nvd.nist.gov/vuln/detail/')));
  assert.equal(batch.articles[0].publishedAt?.toISOString(), '2026-11-12T08:00:00.000Z');
});

check('parse: invalid JSON and a missing array are PARSE_ERROR, never silent success', () => {
  for (const bad of ['<html>', '{"ok":true}']) {
    try {
      parseNvdResponse(bad);
      assert.fail('expected a throw');
    } catch (err: any) {
      assert.equal(err.errorCode, 'PARSE_ERROR');
    }
  }
});

check('cvss: no metrics gives null', () => {
  assert.equal(pickCvss(undefined), null);
  assert.equal(pickCvss({}), null);
});

check('catalog: NVD is handled by its adapter; RSS is the default; cloud is gone', () => {
  const nvd = CYBERSEC_DEFAULT_FEEDS.find((f) => f.id === 'nvd');
  assert.ok(nvd, 'NVD entry exists');
  assert.equal(nvd!.url, NVD_API_BASE);
  assert.equal(adapterFor(nvd!.url), 'nvd');
  assert.equal(adapterFor('https://news.example.test/feed'), 'rss');
  assert.equal(CYBERSEC_DEFAULT_FEEDS.some((f) => f.url.includes('cloudsecuritynews')), false);
});

check('catalog: disabled feeds carry a reason; active catalog feeds do not', () => {
  assert.match(disabledReasonFor('https://cvetrends.com/rss') ?? '', /HTTP 404/);
  assert.match(disabledReasonFor('https://cve.mitre.org/cve/rss.xml') ?? '', /malformed/);
  assert.equal(disabledReasonFor(NVD_API_BASE), null);
});

check('auth: the apiKey header is sent only when NVD_API_KEY is set and non-empty', () => {
  assert.deepEqual(nvdRequestHeaders({ NVD_API_KEY: 'test-key-123' }), { apiKey: 'test-key-123' });
  assert.deepEqual(nvdRequestHeaders({ NVD_API_KEY: '  padded-key  ' }), { apiKey: 'padded-key' });
  assert.deepEqual(nvdRequestHeaders({}), {});
  assert.deepEqual(nvdRequestHeaders({ NVD_API_KEY: '' }), {});
  assert.deepEqual(nvdRequestHeaders({ NVD_API_KEY: '   ' }), {});
});

if (failures > 0) {
  console.log(`\n${failures} NVD adapter / catalog check(s) failed.`);
  process.exitCode = 1;
}
