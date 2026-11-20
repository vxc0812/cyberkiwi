import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadLocalEnv } from '../server/ingestion/loadEnv';

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

/** Creates a temporary project folder with optional .env and .env.local contents. */
function project(files: { env?: string; envLocal?: string }): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'cyberkiwi-env-'));
  if (files.env !== undefined) writeFileSync(path.join(root, '.env'), files.env);
  if (files.envLocal !== undefined) writeFileSync(path.join(root, '.env.local'), files.envLocal);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

check('env: .env.local overrides .env, and .env fills what .env.local does not set', () => {
  const p = project({ env: 'SHARED=from-env\nBASE_ONLY=base\n', envLocal: 'SHARED=from-local\nLOCAL_ONLY=local\n' });
  try {
    const target: NodeJS.ProcessEnv = {};
    loadLocalEnv(p.root, target);
    assert.equal(target.SHARED, 'from-local');
    assert.equal(target.BASE_ONLY, 'base');
    assert.equal(target.LOCAL_ONLY, 'local');
  } finally {
    p.cleanup();
  }
});

check('env: the real process environment wins over both files', () => {
  const p = project({ env: 'NVD_API_KEY=from-env\n', envLocal: 'NVD_API_KEY=from-local\n' });
  try {
    const target: NodeJS.ProcessEnv = { NVD_API_KEY: 'from-process' };
    loadLocalEnv(p.root, target);
    assert.equal(target.NVD_API_KEY, 'from-process');
  } finally {
    p.cleanup();
  }
});

check('env: a missing .env or .env.local is not an error', () => {
  const onlyLocal = project({ envLocal: 'ONLY=local\n' });
  const onlyBase = project({ env: 'ONLY=base\n' });
  const none = project({});
  try {
    const a: NodeJS.ProcessEnv = {};
    loadLocalEnv(onlyLocal.root, a);
    assert.equal(a.ONLY, 'local');

    const b: NodeJS.ProcessEnv = {};
    loadLocalEnv(onlyBase.root, b);
    assert.equal(b.ONLY, 'base');

    const c: NodeJS.ProcessEnv = {};
    loadLocalEnv(none.root, c);
    assert.equal(c.ONLY, undefined);
  } finally {
    onlyLocal.cleanup();
    onlyBase.cleanup();
    none.cleanup();
  }
});

if (failures > 0) {
  console.log(`\n${failures} env loading check(s) failed.`);
  process.exitCode = 1;
}
