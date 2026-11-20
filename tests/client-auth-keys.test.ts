import assert from 'node:assert/strict';
import { createAuthenticatedRequest } from '../src/services/authRequest';
import { parseStoryDeepLink } from '../src/services/deepLink';
import { enrichmentParams, storyQueryForBlock, createCyberkiwiApiClient } from '../src/services/cyberkiwiApi';
import { ENRICHMENT_PRESETS } from '../src/services/enrichmentPresets';
import { validateAiKey, saveAiKey, hasAiKey, clearAiKey, describeValidation } from '../src/services/aiKeyService';

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

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const KEY = 'AIza' + 'Z'.repeat(35);

async function main(): Promise<void> {
  await check('auth request: a 401 triggers one refresh and one retry, and the retry result is returned', async () => {
    let calls = 0;
    let refreshes = 0;
    const authed = createAuthenticatedRequest({
      fetchOnce: async () => (++calls === 1 ? json(401, {}) : json(200, { ok: true })),
      refresh: async () => { refreshes++; return true; },
    });
    const res = await authed('/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
    assert.equal(refreshes, 1);
  });

  await check('auth request: concurrent 401s share one refresh (refresh tokens rotate, so parallel refreshes would clash)', async () => {
    let refreshes = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen = new Map<string, number>();
    const authed = createAuthenticatedRequest({
      fetchOnce: async (path) => {
        const n = (seen.get(path) ?? 0) + 1;
        seen.set(path, n);
        return n === 1 ? json(401, {}) : json(200, { path });
      },
      refresh: async () => { refreshes++; await gate; return true; },
    });
    const pending = Promise.all(['/a', '/b', '/c', '/d'].map((p) => authed(p)));
    await new Promise((r) => setTimeout(r, 10));
    release();
    const results = await pending;
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(refreshes, 1, 'one refresh serves all four requests');
  });

  await check('auth request: if the retry is also a 401, it is returned as-is and does not refresh again', async () => {
    let refreshes = 0;
    const authed = createAuthenticatedRequest({
      fetchOnce: async () => json(401, {}),
      refresh: async () => { refreshes++; return true; },
    });
    const res = await authed('/api/x');
    assert.equal(res.status, 401);
    assert.equal(refreshes, 1, 'exactly one refresh, never a loop');
  });

  await check('auth request: a failed refresh reports the session as lost and does not retry', async () => {
    let lost = 0;
    let calls = 0;
    const authed = createAuthenticatedRequest({
      fetchOnce: async () => { calls++; return json(401, {}); },
      refresh: async () => false,
      onSessionLost: () => { lost++; },
    });
    const res = await authed('/api/x');
    assert.equal(res.status, 401);
    assert.equal(lost, 1);
    assert.equal(calls, 1, 'no retry without a successful refresh');
  });

  await check('auth request: a refresh that throws counts as a failed refresh, not a crash', async () => {
    const authed = createAuthenticatedRequest({
      fetchOnce: async () => json(401, {}),
      refresh: async () => { throw new Error('network down'); },
    });
    assert.equal((await authed('/api/x')).status, 401);
  });

  await check('auth request: requests that are not 401 pass through without any refresh', async () => {
    let refreshes = 0;
    const authed = createAuthenticatedRequest({
      fetchOnce: async () => json(200, {}),
      refresh: async () => { refreshes++; return true; },
    });
    assert.equal((await authed('/api/x')).status, 200);
    assert.equal(refreshes, 0);
  });

  await check('deep links: story UUIDs are accepted from the custom scheme and the web URL; anything else is ignored', () => {
    const id = '3F2C9A10-7B1E-4C55-9D2A-0A1B2C3D4E5F';
    assert.equal(parseStoryDeepLink(`cyberkiwi://story/${id}`), id.toLowerCase());
    assert.equal(parseStoryDeepLink(`https://cyberkiwi.app/story/${id.toLowerCase()}/`), id.toLowerCase());
    assert.equal(parseStoryDeepLink('cyberkiwi://story/not-a-uuid'), null);
    assert.equal(parseStoryDeepLink('cyberkiwi://story/%E0%A4%A'), null, 'malformed escapes do not throw');
    assert.equal(parseStoryDeepLink('https://evil.example/story/' + id), null);
    assert.equal(parseStoryDeepLink('cyberkiwi://story/' + id + '?x=1'), null);
  });

  await check('EPSS parameter: minEpss values are sent as the API names them, and missing values are not sent', () => {
    assert.deepEqual(enrichmentParams({ minEpss: 0.5 }), [['minEpss', '0.5']]);
    assert.deepEqual(enrichmentParams({ minEpss: 0 }), [['minEpss', '0']], 'zero is a real value');
    assert.deepEqual(enrichmentParams({ kev: true, severity: 'critical', vendor: 'microsoft', technique: 'T1190', cve: 'CVE-2024-1234' }), [
      ['kev', 'true'], ['severity', 'critical'], ['vendor', 'microsoft'], ['technique', 'T1190'], ['cve', 'CVE-2024-1234'],
    ]);
    assert.deepEqual(enrichmentParams(undefined), []);
    assert.deepEqual(enrichmentParams({}), []);
  });

  await check('blocks: an enrichment block builds a story query with the enrichment filters', async () => {
    const query = storyQueryForBlock({ categoryFilter: 'all', itemCount: 6, enrichment: { kev: true, minEpss: 0.5 } });
    assert.equal(query.limit, 6);
    assert.deepEqual(query.enrichment, { kev: true, minEpss: 0.5 });
    const seen: string[] = [];
    const client = createCyberkiwiApiClient({
      baseUrl: 'https://api.test',
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        return json(200, { success: true, items: [], nextCursor: null, hasMore: false });
      }) as unknown as typeof fetch,
    });
    await client.listStories(query);
    assert.match(seen[0], /minEpss=0\.5/);
    assert.match(seen[0], /kev=true/);
    assert.doesNotMatch(seen[0], /epss%3E|epss>/, 'never an expression');
  });

  await check('enrichment presets: every preset uses only filters the API defines', () => {
    assert.ok(ENRICHMENT_PRESETS.length >= 5);
    for (const preset of ENRICHMENT_PRESETS) {
      const keys = Object.keys(preset.enrichment);
      assert.ok(keys.length > 0, preset.title);
      for (const key of keys) {
        assert.ok(['minEpss', 'kev', 'severity', 'vendor', 'technique', 'cve'].includes(key), `${preset.title}: ${key}`);
      }
    }
  });

  await check('keys: a malformed key is refused before any request; a rejected key is never stored', async () => {
    const seenBodies: string[] = [];
    (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
      seenBodies.push(String((init?.headers as Record<string, string>)?.['X-User-AI-Key'] ?? ''));
      return json(200, { valid: false, error: 'invalid_key' });
    };
    assert.deepEqual(await validateAiKey('nope'), { valid: false, reason: 'format' });
    assert.equal(seenBodies.length, 0, 'no request for a malformed key');

    const rejected = await saveAiKey(KEY);
    assert.deepEqual(rejected, { valid: false, reason: 'invalid_key' });
    assert.equal(await hasAiKey(), false, 'a rejected key is not stored');
    assert.match(describeValidation(rejected), /Google rejected/);
  });

  await check('keys: a valid key is stored only after the server accepts it, and clear removes it', async () => {
    (globalThis as any).fetch = async () => json(200, { valid: true, model: 'gemini-2.0-flash' });
    const saved = await saveAiKey(KEY);
    assert.deepEqual(saved, { valid: true });
    assert.equal(await hasAiKey(), true);
    await clearAiKey();
    assert.equal(await hasAiKey(), false);
  });

  await check('keys: rate limits and server trouble are reported distinctly and never store the key', async () => {
    (globalThis as any).fetch = async () => json(429, { valid: false, error: 'rate_limited' });
    assert.deepEqual(await validateAiKey(KEY), { valid: false, reason: 'rate_limited' });
    (globalThis as any).fetch = async () => { throw new Error('offline'); };
    assert.deepEqual(await validateAiKey(KEY), { valid: false, reason: 'network' });
    assert.equal(await hasAiKey(), false);
  });

  if (failures > 0) {
    console.log(`\n${failures} client check(s) failed.`);
    process.exitCode = 1;
  }
}

main();
