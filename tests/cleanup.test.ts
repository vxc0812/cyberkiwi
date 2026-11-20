import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isLocalDevOrigin } from '../server/originPolicy';
import { assertDatabaseTransport } from '../server/db/client';
import { validateOutboundUrl } from '../server/netSafety';
import { parseOpml } from '../src/services/opmlService';
import { cleanHeadline } from '../src/services/clustering/textUtils';

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

/** Synchronous duration in milliseconds, used as the event-loop stall budget for crafted input. */
function timed(fn: () => void): number {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const BUDGET_MS = 1_500;
const root = process.cwd();

async function main(): Promise<void> {
  await check('dev cors: only local origins are allowed (F19)', () => {
    assert.equal(isLocalDevOrigin('http://localhost:5173'), true);
    assert.equal(isLocalDevOrigin('http://127.0.0.1:3000'), true);
    assert.equal(isLocalDevOrigin('http://[::1]:3000'), true);
    assert.equal(isLocalDevOrigin('capacitor://localhost'), true);
    assert.equal(isLocalDevOrigin('https://attacker.test'), false);
    assert.equal(isLocalDevOrigin('http://localhost.attacker.test'), false);
    assert.equal(isLocalDevOrigin('http://192.168.1.20:3000'), false);
    assert.equal(isLocalDevOrigin('null'), false);
    assert.equal(isLocalDevOrigin(undefined), false);
  });

  await check('database: a remote host must request TLS (F36)', () => {
    assert.throws(() => assertDatabaseTransport('postgresql://u:p@db.example.test:5432/app'), /sslmode/);
    assert.throws(() => assertDatabaseTransport('postgresql://u:p@db.example.test/app?sslmode=disable'), /sslmode/);
    assert.doesNotThrow(() => assertDatabaseTransport('postgresql://u:p@db.example.test/app?sslmode=require'));
    assert.doesNotThrow(() => assertDatabaseTransport('postgresql://u:p@localhost:5433/app'));
    assert.doesNotThrow(() => assertDatabaseTransport('postgresql://u:p@127.0.0.1/app'));
    assert.throws(() => assertDatabaseTransport('not a url'), /valid URL/);
  });

  await check('feed urls: credentials embedded in a feed URL are refused (F46)', () => {
    assert.equal(validateOutboundUrl('https://user:secret@feed.example.test/rss').valid, false);
    assert.equal(validateOutboundUrl('https://token@feed.example.test/rss').valid, false);
    assert.equal(validateOutboundUrl('https://feed.example.test/rss?token=abc').valid, true);
  });

  await check('opml: a normal file still parses folders and feeds', () => {
    const xml = `<?xml version="1.0"?><opml version="2.0"><body>
      <outline text="Security" title="Security">
        <outline type="rss" text="A" xmlUrl="https://a.test/feed"/>
        <outline type="rss" text="B" xmlUrl="https://b.test/feed"/>
      </outline>
      <outline type="rss" text="C" xmlUrl="https://c.test/feed"/>
    </body></opml>`;
    const result = parseOpml(xml);
    const urls = result.feeds.map((f) => f.url).sort();
    assert.deepEqual(urls, ['https://a.test/feed', 'https://b.test/feed', 'https://c.test/feed']);
  });

  await check('opml: many unclosed outline tags parse within the event-loop budget (F31, F38)', () => {
    const hostile = '<opml><body>' + '<outline text="x" xmlUrl="https://x.test/">'.repeat(60_000);
    const ms = timed(() => parseOpml(hostile));
    assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms, budget ${BUDGET_MS} ms`);
  });

  await check('headline: a long whitespace run is cleaned within the budget and the suffix is still removed (F37)', () => {
    const hostile = 'Breaking news' + ' '.repeat(60_000) + 'x';
    const ms = timed(() => cleanHeadline(hostile));
    assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms, budget ${BUDGET_MS} ms`);
    assert.equal(cleanHeadline('Big security story - Reuters'), 'Big security story');
    assert.equal(cleanHeadline('Plain title'), 'Plain title');
  });

  await check('android: the FileProvider shares only a dedicated cache folder (F34)', () => {
    const xml = readFileSync(path.join(root, 'android/app/src/main/res/xml/file_paths.xml'), 'utf8');
    assert.doesNotMatch(xml, /external-path/);
    assert.doesNotMatch(xml, /path="\."/);
    assert.match(xml, /cache-path[^>]*path="shared\/"/);
  });

  await check('electron: the window waits for this launch\'s server instance, not any 200 (F50)', () => {
    const main = readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
    assert.match(main, /body\.instance === expectedInstance/);
    assert.match(main, /waitForServer\(`\$\{serverUrl\}\/health`, instanceId\)/);
  });

  if (failures > 0) {
    console.log(`\n${failures} cleanup check(s) failed.`);
    process.exitCode = 1;
  }
}

main();
