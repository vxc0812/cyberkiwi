import assert from 'node:assert/strict';
import {
  DEFAULT_FEED_MAX_BYTES,
  HARD_FEED_MAX_BYTES,
  feedPolicyFor,
  feedTooLargeMessage,
  listFeedOverrides,
} from '../server/ingestion/catalogPolicy';

const CISA = 'https://www.cisa.gov/uscert/ics/advisories/advisories.xml';
const MB = 1024 * 1024;
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

check('default: arbitrary feeds keep the 2 MB cap', () => {
  const p = feedPolicyFor('https://example.test/feed.xml');
  assert.equal(p.maxBytes, 2 * MB);
  assert.equal(p.overridden, false);
});

check('override: the CISA ICS feed gets 8 MB and is labelled', () => {
  const p = feedPolicyFor(CISA);
  assert.equal(p.maxBytes, 8 * MB);
  assert.equal(p.overridden, true);
  assert.equal(p.label, 'CISA ICS');
});

check('override is exact-URL only: a similar CISA URL stays at 2 MB', () => {
  assert.equal(feedPolicyFor(CISA.replace('advisories.xml', 'other.xml')).maxBytes, 2 * MB);
  assert.equal(feedPolicyFor(CISA + '?x=1').maxBytes, 2 * MB);
  assert.equal(feedPolicyFor('http://www.cisa.gov/uscert/ics/advisories/advisories.xml').maxBytes, 2 * MB);
});

check('ceiling: every override is above the default and within the hard maximum', () => {
  for (const o of listFeedOverrides()) {
    assert.ok(o.maxBytes > DEFAULT_FEED_MAX_BYTES, `${o.label} must exceed the default`);
    assert.ok(o.maxBytes <= HARD_FEED_MAX_BYTES, `${o.label} must not exceed the hard maximum`);
  }
  assert.equal(HARD_FEED_MAX_BYTES, 10 * MB);
});

check('messages: the default and override failures name the limit that applied', () => {
  assert.equal(feedTooLargeMessage(feedPolicyFor('https://example.test/x')), 'Feed document exceeded 2 MB limit');
  assert.equal(
    feedTooLargeMessage(feedPolicyFor(CISA)),
    'Feed document exceeded configured 8 MB limit for CISA ICS'
  );
});

if (failures > 0) {
  console.log(`\n${failures} feed policy check(s) failed.`);
  process.exitCode = 1;
}
