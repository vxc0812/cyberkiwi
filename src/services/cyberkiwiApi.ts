/**
 * Typed client for the CyberKiwi read API (/api/v1).
 *
 * The base URL is configured per build or environment (VITE_CYBERKIWI_API_BASE_URL). It is never
 * hard-coded here, so desktop, local development, iOS and pre-beta builds can target different backends.
 */
import type {
  ApiErrorCode,
  FeedHealthPage,
  StoriesPage,
  StoryDetail,
} from '../../server/api/types';

export type ClientErrorCode = ApiErrorCode | 'network' | 'timeout' | 'bad_response' | 'http_error';

export class CyberkiwiApiError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;

  constructor(code: ClientErrorCode, status: number, message: string) {
    super(message);
    this.name = 'CyberkiwiApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Validates a configured base URL. Returns the origin without a trailing slash, or '' for same-origin.
 * Only absolute http(s) URLs are accepted, so a misconfigured value cannot redirect requests elsewhere
 * (for example to a javascript: or file: URL).
 */
export function parseApiBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`VITE_CYBERKIWI_API_BASE_URL is not a valid URL: ${trimmed}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('VITE_CYBERKIWI_API_BASE_URL must use http or https');
  }
  if (url.search || url.hash) {
    throw new Error('VITE_CYBERKIWI_API_BASE_URL must not contain a query string or fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export interface ApiClientOptions {
  /** Result of parseApiBaseUrl. Empty string means same-origin requests. */
  baseUrl: string;
  /** Defaults to fetch. The app passes authedFetchUrl, since story and article reads need a signed-in user. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

export interface ListStoriesOptions {
  limit?: number;
  cursor?: string | null;
  /** Feed category slug, for example "exploits". Omit for all categories. */
  category?: string | null;
  /** Feed UUID. Omit for all feeds. */
  feedId?: string | null;
  /** Keyword terms separated by "|" (OR), matched as plain text on the server. */
  keyword?: string | null;
  /** Enrichment filters, sent as query parameters (minEpss=0.5, kev=true, severity=critical, ...). */
  enrichment?: import('../types').EnrichmentFilters;
}

export interface CyberkiwiApiClient {
  listStories(options?: ListStoriesOptions): Promise<StoriesPage>;
  getStory(id: string): Promise<StoryDetail>;
  getFeedHealth(): Promise<FeedHealthPage>;
}

export function createCyberkiwiApiClient(options: ApiClientOptions): CyberkiwiApiClient {
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl;

  async function request<T>(path: string, check: (body: any) => boolean): Promise<T> {
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const aborted = (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
      throw new CyberkiwiApiError(
        aborted ? 'timeout' : 'network',
        0,
        aborted ? 'The CyberKiwi server took too long to respond.' : 'Could not reach the CyberKiwi server.'
      );
    }

    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (body && body.success === false && body.error) {
      throw new CyberkiwiApiError(
        (body.error.code as ClientErrorCode) ?? 'http_error',
        res.status,
        String(body.error.message ?? 'Request failed.')
      );
    }
    if (!res.ok) {
      throw new CyberkiwiApiError('http_error', res.status, `CyberKiwi server responded with HTTP ${res.status}.`);
    }
    if (!check(body)) {
      throw new CyberkiwiApiError('bad_response', res.status, 'Unexpected response from the CyberKiwi server.');
    }
    return body as T;
  }

  return {
    listStories(opts = {}) {
      const params = new URLSearchParams();
      if (opts.limit !== undefined) params.set('limit', String(opts.limit));
      if (opts.cursor) params.set('cursor', opts.cursor);
      if (opts.category) params.set('category', opts.category);
      if (opts.feedId) params.set('feedId', opts.feedId);
      if (opts.keyword) params.set('keyword', opts.keyword);
      for (const [key, value] of enrichmentParams(opts.enrichment)) params.set(key, value);
      const qs = params.toString();
      return request<StoriesPage>(`/api/v1/stories${qs ? `?${qs}` : ''}`, (b) => b?.success === true && Array.isArray(b.items) && 'nextCursor' in b && typeof b.hasMore === 'boolean');
    },
    getStory(id) {
      return request<StoryDetail>(`/api/v1/stories/${encodeURIComponent(id)}`, (b) => b?.success === true && b.story && Array.isArray(b.story.articles));
    },
    getFeedHealth() {
      return request<FeedHealthPage>('/api/v1/feeds/health', (b) => b?.success === true && Array.isArray(b.items) && typeof b.counts === 'object');
    },
  };
}

/**
 * Resolves the API base URL from build-time environment values.
 * - Variable absent: null, so the client keeps the legacy local fetch path.
 * - Empty on a native platform: null. Native apps need an explicit origin.
 * - Otherwise: the validated origin ('' means same-origin).
 */
export function configuredApiBaseUrl(env: Record<string, unknown>, nativePlatform: boolean): string | null {
  const raw = env.VITE_CYBERKIWI_API_BASE_URL;
  if (raw === undefined || raw === null) return null;
  const text = String(raw);
  if (nativePlatform && text.trim() === '') return null;
  return parseApiBaseUrl(text);
}

/** User-facing message for a client error. Never includes server internals or tokens. */
export function describeApiError(code: string): string {
  switch (code) {
    case 'network':
    case 'timeout':
      return 'Could not reach CyberKiwi. Showing saved stories.';
    case 'unauthorized':
      return 'Sign in to load CyberKiwi stories. Showing saved stories.';
    case 'store_unavailable':
      return 'CyberKiwi content is temporarily unavailable. Showing saved stories.';
    case 'bad_response':
    case 'http_error':
      return 'CyberKiwi returned an unexpected response. Showing saved stories.';
    default:
      return 'CyberKiwi request failed. Showing saved stories.';
  }
}

/** Server query for one dashboard block. 'all' and empty values mean no filter. */
/**
 * The query parameters for enrichment filters. Only set fields are sent. Values are sent as the API
 * names them (for example minEpss=0.5), and never as expressions such as epss>0.5.
 */
export function enrichmentParams(filters: import('../types').EnrichmentFilters | undefined): [string, string][] {
  if (!filters) return [];
  const out: [string, string][] = [];
  if (filters.minEpss !== undefined) out.push(['minEpss', String(filters.minEpss)]);
  if (filters.kev) out.push(['kev', 'true']);
  if (filters.severity) out.push(['severity', filters.severity]);
  if (filters.vendor) out.push(['vendor', filters.vendor]);
  if (filters.technique) out.push(['technique', filters.technique]);
  if (filters.cve) out.push(['cve', filters.cve]);
  return out;
}

export function storyQueryForBlock(block: {
  categoryFilter?: string;
  filterKeyword?: string;
  itemCount?: number;
  enrichment?: import('../types').EnrichmentFilters;
}): ListStoriesOptions {
  const category = block.categoryFilter && block.categoryFilter !== 'all' ? block.categoryFilter : null;
  const keyword = block.filterKeyword && block.filterKeyword.trim() ? block.filterKeyword.trim() : null;
  const wanted = Number.isFinite(block.itemCount) ? Math.floor(block.itemCount as number) : 10;
  const limit = Math.min(50, Math.max(1, wanted));
  return block.enrichment ? { category, keyword, limit, enrichment: block.enrichment } : { category, keyword, limit };
}
