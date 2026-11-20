/**
 * The read gate decides when the app may request invite-only stories and articles.
 * The browser flow (scripts/auth-read-flow.mjs) checks the same transitions in the real app.
 */
import assert from 'node:assert/strict';
import { readerKey, serverReadGate } from '../src/services/serverReadGate';

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

/** Replays auth states as the app sees them and reports which ones would issue protected reads. */
function replay(states: Array<{ loading: boolean; userId: string | null }>) {
  let lastKey: string | null = null;
  return states.map(({ loading, userId }) => {
    const gate = serverReadGate(true, loading, userId);
    const key = readerKey(gate, userId);
    const reload = key !== null && key !== lastKey;
    lastKey = key;
    return { gate, key, reload };
  });
}

check('no server configured: always local, never gated on auth', () => {
  for (const loading of [true, false]) {
    for (const user of [null, 'u1']) {
      assert.equal(serverReadGate(false, loading, user), 'local');
      assert.equal(readerKey('local', user), null);
    }
  }
});

check('startup: no protected read while the session is restoring, even with a known user', () => {
  assert.equal(serverReadGate(true, true, null), 'restoring');
  assert.equal(serverReadGate(true, true, 'u1'), 'restoring');
  assert.equal(readerKey('restoring', 'u1'), null);
});

check('startup restore succeeds (cookie, or native token refresh): reads start once, after restore', () => {
  const steps = replay([
    { loading: true, userId: null },
    { loading: false, userId: 'u1' },
    { loading: false, userId: 'u1' }, // a re-render with the same user does not reload
  ]);
  assert.deepEqual(steps.map((s) => s.gate), ['restoring', 'ready', 'ready']);
  assert.deepEqual(steps.map((s) => s.reload), [false, true, false]);
});

check('startup restore finds no session: signed out, no protected read', () => {
  const steps = replay([{ loading: true, userId: null }, { loading: false, userId: null }]);
  assert.deepEqual(steps.map((s) => s.gate), ['restoring', 'signed_out']);
  assert.ok(steps.every((s) => !s.reload));
});

check('anonymous then sign-in: reads start without a page reload', () => {
  const steps = replay([
    { loading: true, userId: null },
    { loading: false, userId: null },
    { loading: false, userId: 'u1' },
  ]);
  assert.deepEqual(steps.map((s) => s.gate), ['restoring', 'signed_out', 'ready']);
  assert.deepEqual(steps.map((s) => s.reload), [false, false, true]);
});

check('sign-out (or a lost session): reads stop, and results for the old reader are dropped', () => {
  const steps = replay([{ loading: false, userId: 'u1' }, { loading: false, userId: null }]);
  assert.equal(steps[1].gate, 'signed_out');
  assert.equal(steps[1].key, null);
  assert.notEqual(steps[1].key, steps[0].key, 'an in-flight answer for u1 no longer matches');
});

check('a different account signs in: reads run again for the new user', () => {
  const steps = replay([
    { loading: false, userId: 'u1' },
    { loading: false, userId: null },
    { loading: false, userId: 'u2' },
  ]);
  assert.deepEqual(steps.map((s) => s.reload), [true, false, true]);
  assert.equal(steps[2].key, 'u2');
});

check('localhost guest reads can start before session restore', () => {
  const guest = serverReadGate(true, true, null, true);
  assert.equal(guest, 'guest');
  assert.equal(readerKey(guest, null), 'localhost-guest');
  assert.equal(serverReadGate(false, false, null, true), 'local');
});

if (failures > 0) {
  console.log(`\n${failures} read gate check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll read gate checks passed.');
}
