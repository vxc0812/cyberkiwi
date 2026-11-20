import assert from 'node:assert/strict';
import { sanitizeArticleHtml } from '../server/sanitize';

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

check('sanitize: img onerror handler is removed', () => {
  const out = sanitizeArticleHtml('<p>Text</p><img src="x" onerror="alert(1)">');
  assert.doesNotMatch(out, /onerror/i);
  assert.match(out, /<p>Text<\/p>/);
});

check('sanitize: javascript: URLs in links are removed', () => {
  const out = sanitizeArticleHtml('<a href="javascript:alert(1)">click</a>');
  assert.doesNotMatch(out, /javascript:/i);
});

check('sanitize: javascript: URLs in image sources are removed', () => {
  const out = sanitizeArticleHtml('<img src="javascript:alert(1)">');
  assert.doesNotMatch(out, /javascript:/i);
});

check('sanitize: SVG onload payloads are removed', () => {
  const out = sanitizeArticleHtml('<svg onload="alert(1)"><circle r="5"></circle></svg>');
  assert.doesNotMatch(out, /onload/i);
  assert.doesNotMatch(out, /<svg/i);
});

check('sanitize: script elements are removed', () => {
  const out = sanitizeArticleHtml('<p>Hi</p><script>alert(1)</script>');
  assert.doesNotMatch(out, /<script/i);
  assert.match(out, /<p>Hi<\/p>/);
});

check('sanitize: allowed article markup survives', () => {
  const html = '<h2>Title</h2><p>Body with <a href="https://example.test/a" rel="noopener">link</a>.</p>';
  const out = sanitizeArticleHtml(html);
  assert.match(out, /<h2>Title<\/h2>/);
  assert.match(out, /href="https:\/\/example\.test\/a"/);
});

if (failures > 0) {
  console.log(`\n${failures} sanitizer check(s) failed.`);
  process.exitCode = 1;
}
