import assert from 'node:assert/strict';
import {
  BoundedCache,
  MAX_FEED_URLS_PER_REQUEST,
  coalesce,
  mapWithConcurrency,
  selectFeedUrls,
} from '../server/resourceLimits';
import { safeFetchText } from '../server/netSafety';

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`✅ [PASS] ${name}`))
    .catch((err: any) => {
      failures++;
      console.log(`❌ [FAIL] ${name}: ${err?.message ?? err}`);
    });
}

/** A clock the tests can move forward by hand. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

async function run(): Promise<void> {
  await check('cache: size never exceeds the cap, however many distinct keys arrive', () => {
    const cache = new BoundedCache<number>(50, 60_000);
    for (let i = 0; i < 10_000; i++) cache.set(`k${i}`, i);
    assert.equal(cache.size, 50);
    assert.equal(cache.get('k9999'), 9999);
    assert.equal(cache.get('k0'), undefined);
  });

  await check('cache: the least recently used entry is evicted first', () => {
    const cache = new BoundedCache<string>(2, 60_000);
    cache.set('a', 'A');
    cache.set('b', 'B');
    assert.equal(cache.get('a'), 'A'); // touch a, so b is now the oldest
    cache.set('c', 'C');
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a'), 'A');
    assert.equal(cache.get('c'), 'C');
  });

  await check('cache: entries expire after the TTL', () => {
    const clock = fakeClock();
    const cache = new BoundedCache<string>(10, 1_000, clock.now);
    cache.set('x', 'X');
    clock.advance(999);
    assert.equal(cache.get('x'), 'X');
    clock.advance(1);
    assert.equal(cache.get('x'), undefined);
    assert.equal(cache.size, 0);
  });

  await check('cache: a non-positive capacity is rejected at construction', () => {
    assert.throws(() => new BoundedCache<string>(0, 1_000), RangeError);
    assert.throws(() => new BoundedCache<string>(1.5, 1_000), RangeError);
  });

  await check('concurrency: no more than the limit is ever in flight, and order is kept', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 30 }, (_, i) => i);
    const results = await mapWithConcurrency(items, 4, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return n * 2;
    });
    assert.ok(peak <= 4, `peak concurrency was ${peak}`);
    assert.ok(peak > 1, 'tasks should overlap when the limit allows it');
    assert.deepEqual(results.map((r) => (r.status === 'fulfilled' ? r.value : -1)), items.map((n) => n * 2));
  });

  await check('concurrency: a failing task is reported and does not stop the others', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[2].status, 'fulfilled');
  });

  await check('coalesce: concurrent callers for one key share a single run', async () => {
    let runs = 0;
    const slow = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 5));
      return 'payload';
    };
    const [a, b, c] = await Promise.all([coalesce('feed-1', slow), coalesce('feed-1', slow), coalesce('feed-1', slow)]);
    assert.equal(runs, 1);
    assert.equal(a, 'payload');
    assert.equal(b, 'payload');
    assert.equal(c, 'payload');
  });

  await check('coalesce: a failed run is not remembered, so the next call retries', async () => {
    let runs = 0;
    await assert.rejects(coalesce('feed-2', async () => { runs++; throw new Error('down'); }), /down/);
    const value = await coalesce('feed-2', async () => { runs++; return 'ok'; });
    assert.equal(runs, 2);
    assert.equal(value, 'ok');
  });

  await check('urls: entries are trimmed, empty ones dropped, duplicates removed', () => {
    assert.deepEqual(selectFeedUrls(' https://a.test/ ,, https://b.test/ ,https://a.test/ ,'), ['https://a.test/', 'https://b.test/']);
  });

  await check('urls: the list is capped to the per-request maximum', () => {
    const many = Array.from({ length: 500 }, (_, i) => `https://feed${i}.test/`).join(',');
    assert.equal(selectFeedUrls(many).length, MAX_FEED_URLS_PER_REQUEST);
    assert.equal(selectFeedUrls(many).length, 20);
  });

  await check('deadline: a fetch whose overall deadline has passed fails without opening a connection', async () => {
    await assert.rejects(
      safeFetchText('https://feed.example.test/rss', { maxBytes: 1024, timeoutMs: 8000 }, 0, Date.now() - 1),
      /deadline exceeded/,
    );
  });

  if (failures > 0) {
    console.log(`\n${failures} resource limit check(s) failed.`);
    process.exitCode = 1;
  }
}

run();
