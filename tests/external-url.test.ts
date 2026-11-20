import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { normalizeExternalUrl as normalizeTs } from '../src/utils/externalUrl';

const require = createRequire(import.meta.url);
const cjs = require('../electron/externalUrl.cjs') as {
  normalizeExternalUrl: (value: unknown) => string | null;
};

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

/** Inputs that must be accepted, with the normalized form expected. */
const ALLOWED: [unknown, string][] = [
  ['https://example.test/article', 'https://example.test/article'],
  ['http://example.test/', 'http://example.test/'],
  ['HTTPS://EXAMPLE.TEST/Path', 'https://example.test/Path'],
  ['https://example.test/a?b=1#c', 'https://example.test/a?b=1#c'],
];

/** Inputs that must be refused. */
const REFUSED: unknown[] = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'file:///C:/Windows/win.ini',
  'intent://example.test#Intent;scheme=https;end',
  'ms-cxh://example',
  'cyberkiwi://open',
  'mailto:someone@example.test',
  'https://user:secret@example.test/',
  'https://user@example.test/',
  ' https://example.test/',
  'https://example.test/ with space',
  'https://example.test/\u0000nul',
  'https://example.test/\u0007bell',
  'https://',
  'not a url',
  '',
  null,
  undefined,
  42,
  { href: 'https://example.test/' },
  'https://' + 'a'.repeat(2100) + '.test/',
];

check('external url: allowed http and https URLs are normalized and accepted', () => {
  for (const [input, expected] of ALLOWED) {
    assert.equal(normalizeTs(input), expected, `TS: ${String(input)}`);
    assert.equal(cjs.normalizeExternalUrl(input), expected, `CJS: ${String(input)}`);
  }
});

check('external url: unsafe schemes, credentials, whitespace and malformed input are refused', () => {
  for (const input of REFUSED) {
    assert.equal(normalizeTs(input), null, `TS accepted: ${String(input)}`);
    assert.equal(cjs.normalizeExternalUrl(input), null, `CJS accepted: ${String(input)}`);
  }
});

check('external url: the TypeScript and CommonJS copies agree on every vector', () => {
  const all = [...ALLOWED.map(([v]) => v), ...REFUSED];
  for (const input of all) {
    assert.equal(normalizeTs(input), cjs.normalizeExternalUrl(input), `disagree on ${String(input)}`);
  }
});

check('electron: shell.openExternal is called only from the allowlisted helper and one fixed https link', () => {
  const source = readFileSync(path.resolve(process.cwd(), 'electron', 'main.cjs'), 'utf8');
  const calls = source.split('\n').filter((line) => /shell\.openExternal\(/.test(line) && !line.trimStart().startsWith('*'));
  assert.equal(calls.length, 2, `expected 2 call sites, found ${calls.length}:\n${calls.join('\n')}`);
  assert.ok(calls.some((line) => line.includes('shell.openExternal(safe)')), 'helper call missing');
  assert.ok(calls.some((line) => line.includes('https://github.com/cyberkiwi/')), 'fixed release link missing');
});

if (failures > 0) {
  console.log(`\n${failures} external URL check(s) failed.`);
  process.exitCode = 1;
}
