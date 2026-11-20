/**
 * CyberKiwi ingestion contract (version 2).
 *
 * Pure functions only: no network, no database. The worker and the API both
 * depend on these rules, so they are covered by tests in
 * tests/ingestion-contract.test.ts. Changing a rule here is a contract change:
 * bump INGESTION_CONTRACT_VERSION and document it in docs/ingestion-contract.md.
 */
import { createHash } from 'crypto';
import { normalizeAudioUrl } from '../../src/utils/fetchTarget';

export const INGESTION_CONTRACT_VERSION = 2;

export const LIMITS = {
  titleMaxChars: 300,
  excerptMaxChars: 500,
  authorMaxChars: 200,
  externalIdMaxChars: 512,
  maxItemsPerFeed: 200,
  maxBackoffMinutes: 24 * 60,
  futureSkewMs: 24 * 60 * 60 * 1000, // publish dates more than a day ahead are treated as unknown
} as const;

/** Query parameters removed during canonicalization (tracking and campaign noise). */
const TRACKING_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid)$/i;

/** Raw item as produced by the feed parser. Every field is optional and untrusted. */
export interface RawFeedItem {
  guid?: unknown;
  link?: unknown;
  title?: unknown;
  contentSnippet?: unknown;
  summary?: unknown;
  description?: unknown;
  creator?: unknown;
  author?: unknown;
  isoDate?: unknown;
  pubDate?: unknown;
  imageUrl?: unknown;
  audioUrl?: unknown;
}

export interface NormalizedArticle {
  feedId: string;
  externalId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  excerpt: string | null;
  author: string | null;
  imageUrl: string | null;
  audioUrl: string | null;
  publishedAt: Date | null;
  contentHash: string;
}

export type RejectReason = 'missing_title' | 'invalid_link' | 'missing_identity';

export type NormalizeResult =
  | { ok: true; article: NormalizedArticle }
  | { ok: false; reason: RejectReason };

/**
 * Canonical form used to match the same article across feeds.
 * http/https only; lowercased host; no fragment; tracking params removed;
 * remaining params sorted; default ports and a trailing slash removed.
 * Returns null for anything that is not a valid http(s) URL.
 */
export function canonicalizeUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }

  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

/**
 * Stable identity of an item inside one feed. Prefer the feed GUID; fall back
 * to the canonical link. Long values are hashed so the key stays bounded.
 */
export function externalIdFor(guid: unknown, canonicalUrl: string): string | null {
  const g = typeof guid === 'string' ? guid.trim() : '';
  const raw = g ? `guid:${g}` : `link:${canonicalUrl}`;
  if (raw.length <= LIMITS.externalIdMaxChars) return raw;
  return `sha256:${sha256(raw)}`;
}

/** Hash of the normalized title and excerpt, used to detect content changes on refresh. */
export function contentHashFor(title: string, excerpt: string | null): string {
  const normalized = `${title}\n${excerpt ?? ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
  return sha256(normalized).slice(0, 32);
}

/** Removes markup, decodes the common entities and collapses whitespace. */
export function plainText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/<[^>]*>?/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;
}

/** Parses a publish date. Missing, invalid or far-future dates become null. */
export function parsePublishedAt(isoDate: unknown, pubDate: unknown, now: Date = new Date()): Date | null {
  const candidate = [isoDate, pubDate].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  if (!candidate) return null;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() > now.getTime() + LIMITS.futureSkewMs) return null;
  return parsed;
}

/** Normalizes one raw item for a feed. Never throws. */
export function normalizeItem(
  raw: RawFeedItem,
  feedId: string,
  now: Date = new Date()
): NormalizeResult {
  const title = plainText(raw.title, LIMITS.titleMaxChars);
  if (!title) return { ok: false, reason: 'missing_title' };

  const canonicalUrl = canonicalizeUrl(raw.link);
  if (!canonicalUrl) return { ok: false, reason: 'invalid_link' };

  const externalId = externalIdFor(raw.guid, canonicalUrl);
  if (!externalId) return { ok: false, reason: 'missing_identity' };

  const excerptSource = [raw.contentSnippet, raw.summary, raw.description].find(
    (v) => typeof v === 'string' && v.trim()
  );
  const excerpt = plainText(excerptSource, LIMITS.excerptMaxChars) || null;

  const author = plainText(raw.creator ?? raw.author, LIMITS.authorMaxChars) || null;
  const imageUrl = canonicalizeUrl(raw.imageUrl);

  return {
    ok: true,
    article: {
      feedId,
      externalId,
      url: typeof raw.link === 'string' ? raw.link.trim() : canonicalUrl,
      canonicalUrl,
      title,
      excerpt,
      author,
      imageUrl,
      audioUrl: normalizeAudioUrl(raw.audioUrl),
      publishedAt: parsePublishedAt(raw.isoDate, raw.pubDate, now),
      contentHash: contentHashFor(title, excerpt),
    },
  };
}

export interface BatchResult {
  articles: NormalizedArticle[];
  rejected: Array<{ index: number; reason: RejectReason }>;
  duplicates: number;
  truncated: boolean;
}

/**
 * Normalizes a feed's items: caps the count, rejects invalid items with a reason,
 * and keeps only the first occurrence of each externalId within the batch.
 */
export function normalizeBatch(
  raw: RawFeedItem[],
  feedId: string,
  now: Date = new Date(),
  maxItems: number = LIMITS.maxItemsPerFeed
): BatchResult {
  const truncated = raw.length > maxItems;
  const items = truncated ? raw.slice(0, maxItems) : raw;

  const articles: NormalizedArticle[] = [];
  const rejected: BatchResult['rejected'] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  items.forEach((item, index) => {
    const result = normalizeItem(item, feedId, now);
    if ('reason' in result) {
      rejected.push({ index, reason: result.reason });
      return;
    }
    if (seen.has(result.article.externalId)) {
      duplicates++;
      return;
    }
    seen.add(result.article.externalId);
    articles.push(result.article);
  });

  return { articles, rejected, duplicates, truncated };
}

// ---------------------------------------------------------------------------
// Feed health and run status
// ---------------------------------------------------------------------------

export interface FeedHealth {
  consecutiveFailures: number;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
}

export type FetchOutcome =
  | { kind: 'success'; at: Date }
  | { kind: 'not_modified'; at: Date }
  | { kind: 'failure'; at: Date; errorCode: string; errorMessage: string };

export function applyFetchOutcome(prev: FeedHealth, outcome: FetchOutcome): FeedHealth {
  if (outcome.kind === 'failure') {
    return {
      consecutiveFailures: prev.consecutiveFailures + 1,
      lastAttemptAt: outcome.at,
      lastSuccessAt: prev.lastSuccessAt,
      lastFailureAt: outcome.at,
      lastError: `${outcome.errorCode}: ${outcome.errorMessage}`.slice(0, 500),
    };
  }
  // A 304 Not Modified is a healthy answer, so it counts as success.
  return {
    consecutiveFailures: 0,
    lastAttemptAt: outcome.at,
    lastSuccessAt: outcome.at,
    lastFailureAt: prev.lastFailureAt,
    lastError: null,
  };
}

/** Minutes until the next attempt: the base interval, doubled per consecutive failure, capped at 24 h. */
export function nextAttemptDelayMinutes(baseIntervalMinutes: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return baseIntervalMinutes;
  const exponent = Math.min(consecutiveFailures, 16);
  return Math.min(baseIntervalMinutes * 2 ** exponent, LIMITS.maxBackoffMinutes);
}

export type RunStatus = 'SUCCEEDED' | 'PARTIAL' | 'FAILED';

/** FAILED when the fetch or parse failed; PARTIAL when some items were rejected; otherwise SUCCEEDED. */
export function runStatusFor(input: { fetchOk: boolean; itemsSeen: number; itemsRejected: number }): RunStatus {
  if (!input.fetchOk) return 'FAILED';
  if (input.itemsRejected > 0 && input.itemsRejected < input.itemsSeen) return 'PARTIAL';
  if (input.itemsSeen > 0 && input.itemsRejected >= input.itemsSeen) return 'PARTIAL';
  return 'SUCCEEDED';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
