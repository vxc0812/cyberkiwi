import assert from 'node:assert/strict';
import { isBreakingTitle, wantsBreaking } from '../server/push/breaking';
import { dedupeKeyFor, DEDUPE_WINDOW_MS } from '../server/push/jobs';
import { sanitizePrefs, DEFAULT_PREFS } from '../server/devices/routes';

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

const STORY = '3f2c9a10-7b1e-4c55-9d2a-0a1b2c3d4e5f';

async function main(): Promise<void> {
  await check('breaking: active-risk phrases are breaking; routine news is not', () => {
    assert.equal(isBreakingTitle('Actively exploited zero-day in Example VPN'), true);
    assert.equal(isBreakingTitle('Attackers exploited in the wild flaw'), true);
    assert.equal(isBreakingTitle('Emergency patch issued for Exchange'), true);
    assert.equal(isBreakingTitle('Critical RCE found in router firmware'), true);
    assert.equal(isBreakingTitle('Quarterly earnings beat expectations'), false);
    assert.equal(isBreakingTitle('Zero trust architecture explained'), false, 'the phrase alone is not breaking');
  });

  await check('preferences: breaking must be on; an empty category list means all categories', () => {
    assert.equal(wantsBreaking({ breaking: true }, 'news'), true);
    assert.equal(wantsBreaking({ breaking: false }, 'news'), false);
    assert.equal(wantsBreaking({}, 'news'), false, 'missing breaking flag is not opted in');
    assert.equal(wantsBreaking(null, 'news'), false);
    assert.equal(wantsBreaking({ breaking: true, categories: [] }, 'exploits'), true);
    assert.equal(wantsBreaking({ breaking: true, categories: ['exploits'] }, 'exploits'), true);
    assert.equal(wantsBreaking({ breaking: true, categories: ['exploits'] }, 'news'), false);
  });

  await check('dedupe: the same story, category, device and window give the same key; a new window gives a new key', () => {
    const t0 = new Date(Date.UTC(2026, 10, 16, 12, 0, 0));
    const same = new Date(t0.getTime() + 60_000);
    const later = new Date(t0.getTime() + DEDUPE_WINDOW_MS + 1000);
    const k = dedupeKeyFor('breaking', STORY, 'news', t0, 'dev-1');
    assert.equal(dedupeKeyFor('breaking', STORY, 'news', same, 'dev-1'), k, 'inside the window');
    assert.notEqual(dedupeKeyFor('breaking', STORY, 'news', later, 'dev-1'), k, 'after the window');
    assert.notEqual(dedupeKeyFor('breaking', STORY, 'exploits', t0, 'dev-1'), k, 'another category is a separate push');
    assert.notEqual(dedupeKeyFor('breaking', STORY, 'news', t0, 'dev-2'), k, 'another device is a separate push');
  });

  await check('preferences: categories are lower-cased slugs, de-duplicated and capped; defaults include no categories', () => {
    assert.deepEqual(DEFAULT_PREFS.categories, []);
    const clean = sanitizePrefs({ categories: ['exploits', 'exploits', 'Bad Name!', 42, 'news'] });
    assert.deepEqual(clean.categories, ['exploits', 'news']);
    const many = sanitizePrefs({ categories: Array.from({ length: 50 }, (_, i) => `cat-${i}`) });
    assert.equal(many.categories.length, 20);
    assert.deepEqual(sanitizePrefs({ categories: 'exploits' }).categories, [], 'a non-array is ignored');
  });

  if (failures > 0) {
    console.log(`\n${failures} push rule check(s) failed.`);
    process.exitCode = 1;
  }
}

main();
