import assert from 'node:assert/strict';
import { extractCveIds, extractEntities, extractTechniques } from '../server/enrichment/extractors';
import { backoffMs, BASE_BACKOFF_MS, MAX_BACKOFF_MS } from '../server/enrichment/queue';
import { parseEpssCsv, parseKevCatalog } from '../server/enrichment/catalog';
import { parseFilters, articleWhere, parseUnitInterval } from '../server/api/readApi';
import { sanitizePrefs, DEFAULT_PREFS } from '../server/devices/routes';
import { payloadFor } from '../server/push/sender';

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

const STORY_ID = '3f2c9a10-7b1e-4c55-9d2a-0a1b2c3d4e5f';

async function main(): Promise<void> {
  await check('CVE extraction: finds identifiers, normalizes case, removes duplicates, ignores implausible years', () => {
    assert.deepEqual(extractCveIds('Patch CVE-2024-1234 and cve-2024-1234, plus CVE-2023-44487.'), ['CVE-2024-1234', 'CVE-2023-44487']);
    assert.deepEqual(extractCveIds('bogus CVE-1900-0001 and CVE-2024-12'), [], 'year out of range and too-short sequence');
    assert.deepEqual(extractCveIds('no identifiers here'), []);
  });

  await check('ATT&CK: a ransomware story is tagged T1486; a phishing story is tagged T1566; neither is tagged for the other', () => {
    assert.deepEqual(extractTechniques('New ransomware gang hits hospitals').map((t) => t.id), ['T1486']);
    assert.deepEqual(extractTechniques('Spear-phishing campaign targets finance').map((t) => t.id), ['T1566']);
    assert.deepEqual(extractTechniques('Quarterly earnings beat expectations'), []);
  });

  await check('ATT&CK: exploitation of public-facing devices is tagged T1190 only when both parts appear close together', () => {
    assert.ok(extractTechniques('Attackers exploit internet-facing VPN gateways').some((t) => t.id === 'T1190'));
    assert.ok(!extractTechniques('The exploit was disclosed. Separately, the firewall was patched.').some((t) => t.id === 'T1190'));
  });

  await check('entities: vendors, products, malware and actors are matched on word boundaries', () => {
    const slugs = extractEntities('Fortigate devices hit by LockBit; APT28 pivots to Microsoft Exchange Server').map((e) => `${e.type}:${e.slug}`);
    assert.ok(slugs.includes('VENDOR:fortinet'));
    assert.ok(slugs.includes('MALWARE_FAMILY:lockbit'));
    assert.ok(slugs.includes('THREAT_ACTOR:apt28'));
    assert.ok(slugs.includes('VENDOR:microsoft'));
    assert.ok(slugs.includes('PRODUCT:exchange-server'));
    assert.deepEqual(extractEntities('Microsoftware for everyone'), [], 'no match inside a longer word');
  });

  await check('retry backoff: doubles from one minute and is capped at six hours', () => {
    assert.equal(backoffMs(1), BASE_BACKOFF_MS);
    assert.equal(backoffMs(2), BASE_BACKOFF_MS * 2);
    assert.equal(backoffMs(3), BASE_BACKOFF_MS * 4);
    assert.equal(backoffMs(50), MAX_BACKOFF_MS);
  });

  await check('KEV parsing: skips entries with a malformed CVE id or date instead of guessing', () => {
    const { rows, dateReleased } = parseKevCatalog({
      dateReleased: '2026-11-15T00:00:00Z',
      vulnerabilities: [
        { cveID: 'cve-2024-3400', vendorProject: 'Palo Alto', product: 'PAN-OS', dateAdded: '2024-04-12', dueDate: '2024-05-03', knownRansomwareCampaignUse: 'Known' },
        { cveID: 'not-a-cve', dateAdded: '2024-04-12' },
        { cveID: 'CVE-2024-9999', dateAdded: 'yesterday' },
      ],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cveId, 'CVE-2024-3400');
    assert.equal(rows[0].ransomwareCampaignUse, true);
    assert.equal(rows[0].dateAdded.toISOString(), '2024-04-12T00:00:00.000Z');
    assert.ok(dateReleased);
    assert.throws(() => parseKevCatalog({}), /no vulnerabilities array/);
  });

  await check('EPSS parsing: skips comment and header lines and values outside 0 to 1', () => {
    const csv = [
      '#model_version:v2025.03.14,score_date:2026-11-15T00:00:00+0000',
      'cve,epss,percentile',
      'CVE-2024-3400,0.97431,0.99981',
      'CVE-2024-9999,1.5,0.5',
      'not-a-cve,0.2,0.3',
      'CVE-2023-44487,0.00123,0.4',
    ].join('\n');
    const rows = parseEpssCsv(csv);
    assert.deepEqual(rows.map((r) => r.cveId), ['CVE-2024-3400', 'CVE-2023-44487']);
    assert.equal(rows[0].epss, 0.97431);
  });

  await check('filters: minEpss, kev, cve and technique are validated, and bad values are refused', () => {
    const ok = parseFilters({ minEpss: '0.5', kev: 'true', cve: 'cve-2024-1234', technique: 't1190' });
    assert.ok(ok.ok);
    if (!ok.ok) return;
    assert.equal(ok.filters.minEpss, 0.5);
    assert.equal(ok.filters.kev, true);
    assert.equal(ok.filters.cve, 'CVE-2024-1234');
    assert.equal(ok.filters.technique, 'T1190');
    assert.equal(parseFilters({ minEpss: '.25' }).ok, true);
    assert.equal(parseFilters({ technique: 'T1059.001' }).ok, true);

    for (const bad of [{ minEpss: '1.5' }, { minEpss: 'high' }, { minEpss: '0.5.1' }, { kev: 'false' }, { kev: '1' }, { cve: 'CVE-24-1' }, { technique: 'T119' }, { minEpss: ['0.5'] }, { severity: 'severe' }, { vendor: 'Micro soft' }]) {
      assert.equal(parseFilters(bad as Record<string, unknown>).ok, false, JSON.stringify(bad));
    }
  });

  await check('EPSS range: 0 and 1 are accepted; 1.5, -0.1, NaN and empty values are refused; a missing value means no filter', () => {
    for (const ok of ['0', '1', '0.5', '.25', '1.0']) {
      assert.equal(parseUnitInterval(ok), Number(ok), ok);
    }
    for (const bad of ['1.5', '-0.1', 'NaN', 'Infinity', '', ' ', '0x1', '1e0', '2']) {
      assert.equal(parseUnitInterval(bad), null, JSON.stringify(bad));
    }
    assert.equal(parseUnitInterval(undefined), null, 'the helper never accepts a missing value');
    assert.deepEqual(parseFilters({}), { ok: true, filters: { keywords: [] } }, 'missing parameter: no EPSS filter');
    assert.equal(parseFilters({ minEpss: '' }).ok, false, 'present but empty is an error');
    assert.equal(parseFilters({ minEpss: '-0.1' }).ok, false);
    assert.equal(parseFilters({ minEpss: '1.5' }).ok, false);
    const severity = parseFilters({ severity: 'critical', vendor: 'Microsoft' });
    assert.ok(severity.ok);
    if (severity.ok) {
      assert.equal(severity.filters.severity, 'CRITICAL');
      assert.equal(severity.filters.vendor, 'microsoft');
    }
  });

  await check('filters: kev and minEpss must hold on the same CVE link, so an article is not matched by two different CVEs', () => {
    const where = JSON.stringify(articleWhere({ keywords: [], kev: true, minEpss: 0.5 }));
    assert.match(where, /"cves":\{"some":\{"cve":\{"knownExploited":true,"epss":\{"gte":0\.5\}\}\}\}/);
    assert.match(JSON.stringify(articleWhere({ keywords: [], technique: 'T1190' })), /"techniques":\{"some":\{"techniqueId":"T1190"\}\}/);
  });

  await check('device preferences: unknown keys are dropped and missing ones take defaults', () => {
    assert.deepEqual(sanitizePrefs({ breaking: false, evil: 'x', dailyDigest: 'yes' }), { breaking: false, dailyDigest: DEFAULT_PREFS.dailyDigest, aiReady: DEFAULT_PREFS.aiReady, categories: [] });
    assert.deepEqual(sanitizePrefs(null), DEFAULT_PREFS);
  });

  await check('push payload: carries a generic title and a deep link with the story id only', () => {
    const p = payloadFor('breaking', STORY_ID.toUpperCase());
    assert.equal(p.deepLink, `cyberkiwi://story/${STORY_ID}`);
    assert.equal(p.title, 'Breaking security news');
    assert.equal(payloadFor('daily_digest').deepLink, null);
    assert.throws(() => payloadFor('breaking', 'not-a-uuid'), /UUID/);
    assert.equal(JSON.stringify(p).includes('<'), false, 'no article text in the payload');
  });

  if (failures > 0) {
    console.log(`\n${failures} enrichment rule check(s) failed.`);
    process.exitCode = 1;
  }
}

main();
