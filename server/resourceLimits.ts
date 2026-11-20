/**
 * Shared bounds for request-driven work: cache size, concurrency and URL-list size.
 *
 * These limits protect the API process from one client creating unbounded memory or outbound
 * traffic (report findings F5, F6 and F7).
 */

/** Maximum distinct URLs accepted in one /api/rss request. Extra entries are ignored. */
export const MAX_FEED_URLS_PER_REQUEST = 20;

/** Feed fetches that may run at once within one request. */
export const FEED_FETCH_CONCURRENCY = 4;

/** Feed results kept in memory. Least recently used entries are evicted first. */
export const MAX_FEED_CACHE_ENTRIES = 500;

/** Article extraction results kept in memory. */
export const MAX_ARTICLE_CACHE_ENTRIES = 200;

/**
 * A size-bounded map with per-entry expiry. When full, the least recently used entry is evicted,
 * so memory use is capped regardless of how many distinct keys clients request.
 */
export class BoundedCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive integer');
    }
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert so this key becomes the most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Runs `task` over `items` with at most `limit` tasks in flight. Results keep the input order and
 * each one is settled, so one failing task does not stop the others.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Shares one in-flight run per key. Concurrent callers for the same key wait on the same promise, so
 * a popular feed is fetched once per burst rather than once per request. The entry is removed when
 * the run settles, so failures are never cached.
 */
export function coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const pending = run().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}

/**
 * Parses the comma-separated `urls` query parameter: trims entries, drops empty ones, removes
 * duplicates and keeps at most `max` URLs.
 */
export function selectFeedUrls(param: string, max: number = MAX_FEED_URLS_PER_REQUEST): string[] {
  const seen = new Set<string>();
  for (const raw of param.split(',')) {
    const url = raw.trim();
    if (url) seen.add(url);
    if (seen.size >= max) break;
  }
  return [...seen];
}
