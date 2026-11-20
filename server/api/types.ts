/**
 * Public API contract for /api/v1. This file is type-only and is shared with the client.
 * Changing a field is a contract change: update docs/ingestion-contract.md and the client mapper.
 */

export const API_VERSION = 1;

/** Stable error codes. Clients branch on `code`, never on `message`. */
export type ApiErrorCode =
  | 'invalid_limit'
  | 'invalid_cursor'
  | 'invalid_id'
  | 'invalid_feed_id'
  | 'invalid_status'
  | 'invalid_filter'
  | 'not_found'
  | 'unauthorized'
  | 'store_unavailable';

export interface ApiErrorEnvelope {
  success: false;
  error: { code: ApiErrorCode; message: string };
}

export interface SourceRef {
  feedId: string;
  sourceSlug: string;
  name: string;
  feedTitle: string | null;
  category: string;
}

/** A CVE linked to an article, with where its severity came from. */
export interface CveRef {
  id: string;
  cvssScore: number | null;
  severity: string | null;
  /** nvd: canonical NVD data. article: parsed from article text (provisional). unknown: no severity recorded. */
  severitySource: 'nvd' | 'article' | 'unknown';
  /** True when severity is provisional. Article-parsed severity is never presented as authoritative CVSS. */
  severityProvisional: boolean;
  severityUpdatedAt: string | null;
  knownExploited: boolean;
  epss: number | null;
}

export interface ArticleRef {
  id: string;
  title: string;
  url: string;
  excerpt: string | null;
  author: string | null;
  imageUrl: string | null;
  audioUrl?: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
  source: SourceRef;
  /** CVEs linked to this article. Present on article lists. */
  cves?: CveRef[];
}

export interface StoryItem {
  id: string;
  title: string;
  summary: string | null;
  /** Total articles in the story. */
  articleCount: number;
  /** Articles in the story that match the request's filters (equals articleCount when unfiltered). */
  matchedArticleCount: number;
  firstPublishedAt: string | null;
  lastPublishedAt: string | null;
  /** Distinct sources among the articles included in this response. */
  sources: SourceRef[];
  /** Newest first. Only matching articles when a filter is applied. Up to 10 in a list, 100 in a detail. */
  articles: ArticleRef[];
  /** True when matchedArticleCount is larger than articles.length. */
  articlesTruncated: boolean;
}

export interface StoriesPage {
  success: true;
  items: StoryItem[];
  /** Pass as ?cursor= to fetch the next page. Null on the last page. */
  nextCursor: string | null;
  hasMore: boolean;
}

export interface StoryDetail {
  success: true;
  story: StoryItem;
}

export interface ArticlesPage {
  success: true;
  items: ArticleRef[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type FeedHealthStatus = 'never_fetched' | 'ok' | 'failing';

export interface FeedHealthItem {
  feedId: string;
  sourceSlug: string;
  sourceName: string;
  feedTitle: string | null;
  category: string;
  status: FeedHealthStatus;
  consecutiveFailures: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Stable code only (for example HTTP_404). Raw messages are never public. */
  lastErrorCode: string | null;
  nextAttemptAt: string | null;
}

export interface FeedHealthPage {
  success: true;
  counts: { total: number; ok: number; failing: number; never_fetched: number };
  items: FeedHealthItem[];
}

export type ApiResponse<T> = T | ApiErrorEnvelope;

export const PAGE_LIMITS = { default: 20, max: 50 } as const;
