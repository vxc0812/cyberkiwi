/**
 * Read-only API for persisted CyberKiwi content (mounted at /api/v1).
 *
 * - Clients can only read stored data. No endpoint fetches a URL or accepts one.
 * - Pagination is keyset-based on (sortAt desc, id desc); cursors are opaque.
 * - Every error uses one envelope: { success: false, error: { code, message } }.
 * - Public responses omit raw error messages. Operator data needs ADMIN_TOKEN in the
 *   Authorization header only (never a query parameter), and the token is never logged.
 */
import { Router, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import type { PrismaClient } from '../../generated/prisma/client';
import { nextAttemptDelayMinutes } from '../ingestion/contract';
import { principalOf } from '../auth/middleware';
import {
  PAGE_LIMITS,
  type ApiErrorCode,
  type ArticleRef,
  type CveRef,
  type ArticlesPage,
  type FeedHealthItem,
  type FeedHealthPage,
  type SourceRef,
  type StoriesPage,
  type StoryDetail,
  type StoryItem,
} from './types';

export const DEFAULT_LIMIT = PAGE_LIMITS.default;
export const MAX_LIMIT = PAGE_LIMITS.max;
const MAX_ARTICLES_PER_STORY = 10;
const MAX_ARTICLES_IN_DETAIL = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERROR_STATUS: Record<ApiErrorCode, number> = {
  invalid_limit: 400,
  invalid_cursor: 400,
  invalid_id: 400,
  invalid_feed_id: 400,
  invalid_status: 400,
  invalid_filter: 400,
  not_found: 404,
  unauthorized: 401,
  store_unavailable: 503,
};

const ERROR_MESSAGE: Record<ApiErrorCode, string> = {
  invalid_limit: `limit must be an integer from 1 to ${MAX_LIMIT}`,
  invalid_cursor: 'cursor is not valid for this endpoint',
  invalid_id: 'id must be a UUID',
  invalid_feed_id: 'feedId must be a UUID',
  invalid_status: 'status is not a known ingestion status',
  invalid_filter:
    'category must be a lowercase slug; keyword must be at most 100 characters and 10 terms; ' +
    'minEpss must be a decimal from 0 to 1; kev must be true; cve must look like CVE-2024-1234; ' +
    'technique must look like T1190 or T1059.001; severity must be critical, high, medium, low or none; ' +
    'vendor must be a lower-case slug such as microsoft',
  not_found: 'resource not found',
  unauthorized: 'missing or invalid credentials',
  store_unavailable: 'content store is temporarily unavailable',
};

export function sendError(res: Response, code: ApiErrorCode): void {
  res.status(ERROR_STATUS[code]).json({ success: false, error: { code, message: ERROR_MESSAGE[code] } });
}

// ---------------------------------------------------------------------------
// Cursor and paging helpers
// ---------------------------------------------------------------------------

export interface Cursor {
  sortAt: Date;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify({ t: c.sortAt.toISOString(), i: c.id }), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed?.t !== 'string' || typeof parsed?.i !== 'string' || !UUID.test(parsed.i)) return null;
    const sortAt = new Date(parsed.t);
    if (Number.isNaN(sortAt.getTime())) return null;
    return { sortAt, id: parsed.i };
  } catch {
    return null;
  }
}

/** Rows strictly after the cursor in (sortAt desc, id desc) order. */
export function afterCursor(c: Cursor | null): object {
  if (!c) return {};
  return { OR: [{ sortAt: { lt: c.sortAt } }, { sortAt: c.sortAt, id: { lt: c.id } }] };
}

export type LimitParse = { ok: true; value: number } | { ok: false };

/** Absent means the default. Anything outside 1..MAX_LIMIT is rejected, never silently widened. */
export function parseLimit(raw: unknown): LimitParse {
  if (raw === undefined) return { ok: true, value: DEFAULT_LIMIT };
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return { ok: false };
  const n = Number(raw);
  if (n < 1 || n > MAX_LIMIT) return { ok: false };
  return { ok: true, value: n };
}

/** Takes limit+1 rows: the extra row tells us whether another page exists. */
export function pageOf<T extends { id: string; sortAt: Date }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ sortAt: last.sortAt, id: last.id }) : null,
  };
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

type ArticleWithFeed = {
  id: string;
  title: string;
  url: string;
  excerpt: string | null;
  author: string | null;
  imageUrl: string | null;
  publishedAt: Date | null;
  firstSeenAt: Date;
  sortAt: Date;
  feed: {
    id: string;
    title: string | null;
    category: string;
    source: { slug: string; name: string };
  };
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function cveView(link: { cve: { id: string; cvssScore: number | null; cvssSeverity: string | null; severitySource: string; severityUpdatedAt: Date | null; knownExploited: boolean; epss: number | null } }): CveRef {
  const source = link.cve.severitySource === 'NVD' ? 'nvd' : link.cve.severitySource === 'ARTICLE' ? 'article' : 'unknown';
  return {
    id: link.cve.id,
    cvssScore: link.cve.cvssScore,
    severity: link.cve.cvssSeverity,
    severitySource: source,
    severityProvisional: source === 'article',
    severityUpdatedAt: iso(link.cve.severityUpdatedAt),
    knownExploited: link.cve.knownExploited,
    epss: link.cve.epss,
  };
}

export function articleView(a: ArticleWithFeed): ArticleRef {
  const cves = (a as { cves?: Parameters<typeof cveView>[0][] }).cves;
  return {
    ...(cves ? { cves: cves.map(cveView) } : {}),
    id: a.id,
    title: a.title,
    url: a.url,
    excerpt: a.excerpt,
    author: a.author,
    imageUrl: a.imageUrl,
    publishedAt: iso(a.publishedAt),
    firstSeenAt: a.firstSeenAt.toISOString(),
    source: {
      feedId: a.feed.id,
      sourceSlug: a.feed.source.slug,
      name: a.feed.source.name,
      feedTitle: a.feed.title,
      category: a.feed.category,
    },
  };
}

export function distinctSources(articles: ArticleRef[]): SourceRef[] {
  return [...new Map(articles.map((a) => [a.source.feedId, a.source])).values()];
}

// ---------------------------------------------------------------------------
// Filters (server-side, so each block asks for the subset it needs)
// ---------------------------------------------------------------------------

export interface ArticleFilters {
  category?: string;
  feedId?: string;
  /** Lowercase-insensitive substring terms, combined with OR. Literal text, never a regex. */
  keywords: string[];
  /** Enrichment: an article matches when one of its CVEs has an EPSS score at or above this value. */
  minEpss?: number;
  /** Enrichment: an article matches when one of its CVEs is in the CISA KEV catalog. */
  kev?: boolean;
  /** Enrichment: an article matches when it mentions this CVE. */
  cve?: string;
  /** Enrichment: an article matches when it is tagged with this ATT&CK technique. */
  technique?: string;
  /** Enrichment: an article matches when one of its CVEs has this CVSS severity (upper case). */
  severity?: string;
  /** Enrichment: an article matches when it mentions this vendor (lower-case slug). */
  vendor?: string;
}

const CATEGORY_PATTERN = /^[a-z0-9-]{1,40}$/;
const MAX_KEYWORD_CHARS = 100;
const MAX_KEYWORD_TERMS = 10;
const CVE_PARAM = /^CVE-\d{4}-\d{4,7}$/;
const TECHNIQUE_PARAM = /^T\d{4}(?:\.\d{3})?$/;
const UNIT_INTERVAL_PARAM = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE']);
const VENDOR_PARAM = /^[a-z0-9-]{1,60}$/;

/**
 * The one range check for 0-to-1 values such as minEpss. Returns null for anything that is not a plain
 * decimal in [0, 1]: NaN, negatives, values above 1, and malformed text such as "0x1" or "1e0".
 */
export function parseUnitInterval(raw: unknown): number | null {
  if (typeof raw !== 'string' || !UNIT_INTERVAL_PARAM.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}
const MAX_TERM_CHARS = 50;

/**
 * Parses ?category=, ?feedId= and ?keyword=. Keyword terms are separated by "|" (OR), for example
 * "critical|zero-day". Terms are matched as plain text in article titles and excerpts.
 */
export function parseFilters(q: Record<string, unknown>):
  | { ok: true; filters: ArticleFilters }
  | { ok: false } {
  const filters: ArticleFilters = { keywords: [] };

  if (q.category !== undefined) {
    if (typeof q.category !== 'string' || !CATEGORY_PATTERN.test(q.category)) return { ok: false };
    filters.category = q.category;
  }

  if (q.feedId !== undefined) {
    if (typeof q.feedId !== 'string' || !UUID.test(q.feedId)) return { ok: false };
    filters.feedId = q.feedId;
  }

  if (q.keyword !== undefined) {
    if (typeof q.keyword !== 'string' || q.keyword.length > MAX_KEYWORD_CHARS) return { ok: false };
    const terms = q.keyword
      .split('|')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (terms.length > MAX_KEYWORD_TERMS || terms.some((t) => t.length > MAX_TERM_CHARS)) return { ok: false };
    filters.keywords = terms;
  }

  // Enrichment filters. Use ?minEpss=0.5 (not ?epss>0.5). Each value is validated before it reaches the database.
  if (q.minEpss !== undefined) {
    // A missing parameter means no EPSS filter. A present but invalid one is an error.
    const value = parseUnitInterval(q.minEpss);
    if (value === null) return { ok: false };
    filters.minEpss = value;
  }

  if (q.severity !== undefined) {
    const value = typeof q.severity === 'string' ? q.severity.toUpperCase() : '';
    if (!SEVERITIES.has(value)) return { ok: false };
    filters.severity = value;
  }

  if (q.vendor !== undefined) {
    const value = typeof q.vendor === 'string' ? q.vendor.toLowerCase() : '';
    if (!VENDOR_PARAM.test(value)) return { ok: false };
    filters.vendor = value;
  }

  if (q.kev !== undefined) {
    // Only kev=true is defined. Stories are never filtered by "not known exploited".
    if (q.kev !== 'true') return { ok: false };
    filters.kev = true;
  }

  if (q.cve !== undefined) {
    if (typeof q.cve !== 'string' || !CVE_PARAM.test(q.cve.toUpperCase())) return { ok: false };
    filters.cve = q.cve.toUpperCase();
  }

  if (q.technique !== undefined) {
    if (typeof q.technique !== 'string' || !TECHNIQUE_PARAM.test(q.technique.toUpperCase())) return { ok: false };
    filters.technique = q.technique.toUpperCase();
  }

  return { ok: true, filters };
}

/** Prisma condition for one article, shared by article lists and story membership. */
export function articleWhere(f: ArticleFilters): Record<string, unknown> {
  const and: Record<string, unknown>[] = [];
  // Public reads never show articles from a deactivated feed or source (report F51).
  const feed: Record<string, unknown> = { active: true, source: { active: true } };
  if (f.category) feed.category = f.category;
  if (f.feedId) feed.id = f.feedId;
  and.push({ feed });
  if (f.keywords.length > 0) {
    and.push({
      OR: f.keywords.flatMap((t) => [
        { title: { contains: t, mode: 'insensitive' } },
        { excerpt: { contains: t, mode: 'insensitive' } },
      ]),
    });
  }

  // CVE conditions are evaluated on the same link, so "kev=true&minEpss=0.5" means one CVE that is both.
  const cveCondition: Record<string, unknown> = {};
  if (f.cve) cveCondition.cveId = f.cve;
  const cveRow: Record<string, unknown> = {};
  if (f.kev) cveRow.knownExploited = true;
  if (f.minEpss !== undefined) cveRow.epss = { gte: f.minEpss };
  if (f.severity) cveRow.cvssSeverity = f.severity;
  if (Object.keys(cveRow).length > 0) cveCondition.cve = cveRow;
  if (Object.keys(cveCondition).length > 0) and.push({ cves: { some: cveCondition } });

  if (f.technique) and.push({ techniques: { some: { techniqueId: f.technique } } });
  if (f.vendor) and.push({ entities: { some: { entity: { type: 'VENDOR', slug: f.vendor } } } });

  return and.length > 0 ? { AND: and } : {};
}

/** A story matches when at least one of its articles matches. */
export function storyWhere(f: ArticleFilters): Record<string, unknown> {
  const inner = articleWhere(f);
  if (Object.keys(inner).length === 0) return {};
  return { articles: { some: { article: inner } } };
}

const articleSelect = {
  id: true,
  title: true,
  url: true,
  excerpt: true,
  cves: {
    select: {
      cve: {
        select: { id: true, cvssScore: true, cvssSeverity: true, severitySource: true, severityUpdatedAt: true, knownExploited: true, epss: true },
      },
    },
  },
  author: true,
  imageUrl: true,
  publishedAt: true,
  firstSeenAt: true,
  sortAt: true,
  feed: {
    select: {
      id: true,
      title: true,
      category: true,
      source: { select: { slug: true, name: true } },
    },
  },
} as const;

/** Health label derived from persisted state only. */
export function feedStatus(f: { lastAttemptAt: Date | null; consecutiveFailures: number }): 'never_fetched' | 'ok' | 'failing' {
  if (!f.lastAttemptAt) return 'never_fetched';
  return f.consecutiveFailures > 0 ? 'failing' : 'ok';
}

/** Public error detail is the stable code only, never the raw message. */
export function publicErrorCode(lastError: string | null): string | null {
  if (!lastError) return null;
  return lastError.split(':')[0].slice(0, 40) || null;
}

/**
 * Compares the presented token with the expected one in constant time.
 * Both values are hashed first, so the comparison does not reveal the token's length.
 */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** Reads the bearer token from the Authorization header only. Query strings are ignored. */
export function bearerFrom(req: Request): string | undefined {
  const header = req.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : undefined;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface ReadApiOptions {
  /** Enables /ingestion/runs when set. Unset means the operator endpoint does not exist. */
  adminToken?: string;
}

export function createReadApi(db: PrismaClient, options: ReadApiOptions = {}): Router {
  const router = Router();

  router.use((req, res, next) => {
    // Operator data and its auth errors are never cached (report F29). Content reads may be briefly cached by the user's own client only.
    res.setHeader('Cache-Control', req.path.startsWith('/ingestion') ? 'no-store' : 'private, max-age=30');
    next();
  });

  // Content is invite-only: story and article reads need a signed-in user. The caller is resolved
  // upstream by attachSession (server.ts); without it every content read is refused, never served.
  router.use(['/stories', '/articles'], (_req, res, next) => {
    // A cached response must never be reused across different credentials, and a refusal is never cached.
    res.vary('Authorization');
    res.vary('Cookie');
    if (!principalOf(res)) {
      res.setHeader('Cache-Control', 'no-store');
      return sendError(res, 'unauthorized');
    }
    next();
  });

  const fail = (res: Response, err: unknown) => {
    // Log the error class and message only. Never log request headers or tokens.
    console.error('[read-api] database error:', (err as Error).message);
    sendError(res, 'store_unavailable');
  };

  const parseCursorParam = (raw: unknown): { ok: true; cursor: Cursor | null } | { ok: false } => {
    if (raw === undefined) return { ok: true, cursor: null };
    const cursor = decodeCursor(String(raw));
    return cursor ? { ok: true, cursor } : { ok: false };
  };

  const parseUuidParam = (raw: unknown): { ok: true; value?: string } | { ok: false } => {
    if (raw === undefined) return { ok: true };
    return typeof raw === 'string' && UUID.test(raw) ? { ok: true, value: raw } : { ok: false };
  };

  // GET /stories?limit=&cursor=&category=&feedId=&keyword=  (story-first, newest first)
  // With filters, a story is included when any member article matches, and only matching
  // articles are returned in it.
  router.get('/stories', async (req: Request, res: Response) => {
    const limit = parseLimit(req.query.limit);
    if (!limit.ok) return sendError(res, 'invalid_limit');
    const cursor = parseCursorParam(req.query.cursor);
    if (!cursor.ok) return sendError(res, 'invalid_cursor');
    const filters = parseFilters(req.query as Record<string, unknown>);
    if (!filters.ok) return sendError(res, 'invalid_filter');
    const member = { article: articleWhere(filters.filters) };
    try {
      const rows = await db.story.findMany({
        where: { AND: [afterCursor(cursor.cursor), storyWhere(filters.filters)] } as any,
        orderBy: [{ sortAt: 'desc' }, { id: 'desc' }],
        take: limit.value + 1,
        select: {
          id: true,
          title: true,
          summary: true,
          articleCount: true,
          firstPublishedAt: true,
          lastPublishedAt: true,
          sortAt: true,
          _count: { select: { articles: { where: member as any } } },
          articles: {
            where: member as any,
            take: MAX_ARTICLES_PER_STORY,
            orderBy: { article: { sortAt: 'desc' } },
            select: { article: { select: articleSelect } },
          },
        },
      });
      const page = pageOf(rows, limit.value);
      const body: StoriesPage = {
        success: true,
        items: page.items.map((s) =>
          storyItem(s, s.articles.map((l) => articleView(l.article as ArticleWithFeed)), s._count.articles)
        ),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
      res.json(body);
    } catch (err) {
      fail(res, err);
    }
  });

  // GET /stories/:id  (one story with its articles, newest first)
  router.get('/stories/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID.test(id)) return sendError(res, 'invalid_id');
    try {
      const s = await db.story.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          summary: true,
          articleCount: true,
          firstPublishedAt: true,
          lastPublishedAt: true,
          articles: {
            take: MAX_ARTICLES_IN_DETAIL,
            orderBy: { article: { sortAt: 'desc' } },
            select: { article: { select: articleSelect } },
          },
        },
      });
      if (!s) return sendError(res, 'not_found');
      const body: StoryDetail = {
        success: true,
        story: storyItem(s, s.articles.map((l) => articleView(l.article as ArticleWithFeed))),
      };
      res.json(body);
    } catch (err) {
      fail(res, err);
    }
  });

  // GET /articles?feedId=&limit=&cursor=  (newest first)
  router.get('/articles', async (req: Request, res: Response) => {
    const limit = parseLimit(req.query.limit);
    if (!limit.ok) return sendError(res, 'invalid_limit');
    const cursor = parseCursorParam(req.query.cursor);
    if (!cursor.ok) return sendError(res, 'invalid_cursor');
    const filters = parseFilters(req.query as Record<string, unknown>);
    if (!filters.ok) return sendError(res, 'invalid_filter');
    try {
      const rows = await db.article.findMany({
        where: { AND: [articleWhere(filters.filters), afterCursor(cursor.cursor)] } as any,
        orderBy: [{ sortAt: 'desc' }, { id: 'desc' }],
        take: limit.value + 1,
        select: articleSelect,
      });
      const page = pageOf(rows, limit.value);
      const body: ArticlesPage = {
        success: true,
        items: page.items.map((a) => articleView(a as ArticleWithFeed)),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
      res.json(body);
    } catch (err) {
      fail(res, err);
    }
  });

  // GET /feeds/health  (persisted fetch state; public view has codes only)
  router.get('/feeds/health', async (_req: Request, res: Response) => {
    try {
      const feeds = await db.feed.findMany({
        where: { active: true },
        orderBy: [{ consecutiveFailures: 'desc' }, { url: 'asc' }],
        select: {
          id: true,
          title: true,
          category: true,
          fetchIntervalMinutes: true,
          lastAttemptAt: true,
          lastSuccessAt: true,
          lastFailureAt: true,
          lastError: true,
          consecutiveFailures: true,
          source: { select: { slug: true, name: true } },
        },
      });
      const counts = { total: feeds.length, ok: 0, failing: 0, never_fetched: 0 };
      const items: FeedHealthItem[] = feeds.map((f) => {
        const status = feedStatus(f);
        counts[status]++;
        return {
          feedId: f.id,
          sourceSlug: f.source.slug,
          sourceName: f.source.name,
          feedTitle: f.title,
          category: f.category,
          status,
          consecutiveFailures: f.consecutiveFailures,
          lastAttemptAt: iso(f.lastAttemptAt),
          lastSuccessAt: iso(f.lastSuccessAt),
          lastFailureAt: iso(f.lastFailureAt),
          lastErrorCode: publicErrorCode(f.lastError),
          nextAttemptAt:
            f.lastAttemptAt && f.consecutiveFailures > 0
              ? new Date(
                  f.lastAttemptAt.getTime() +
                    nextAttemptDelayMinutes(f.fetchIntervalMinutes, f.consecutiveFailures) * 60_000
                ).toISOString()
              : null,
        };
      });
      const body: FeedHealthPage = { success: true, counts, items };
      res.json(body);
    } catch (err) {
      fail(res, err);
    }
  });

  // GET /ingestion/runs  (operator only; disabled unless ADMIN_TOKEN is configured)
  router.get('/ingestion/runs', async (req: Request, res: Response) => {
    if (!options.adminToken) return sendError(res, 'not_found');
    if (!tokenMatches(bearerFrom(req), options.adminToken)) return sendError(res, 'unauthorized');
    const limit = parseLimit(req.query.limit);
    if (!limit.ok) return sendError(res, 'invalid_limit');
    const feed = parseUuidParam(req.query.feedId);
    if (!feed.ok) return sendError(res, 'invalid_feed_id');
    const allowed = ['RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'SKIPPED'];
    const status = req.query.status;
    if (status !== undefined && (typeof status !== 'string' || !allowed.includes(status))) {
      return sendError(res, 'invalid_status');
    }
    try {
      const runs = await db.ingestionRun.findMany({
        where: {
          ...(feed.value ? { feedId: feed.value } : {}),
          ...(status ? { status: status as any } : {}),
        },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: limit.value,
        select: {
          id: true,
          feedId: true,
          trigger: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          httpStatus: true,
          itemsSeen: true,
          itemsNew: true,
          itemsUpdated: true,
          errorCode: true,
          errorMessage: true,
        },
      });
      res.json({ success: true, items: runs });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}

function storyItem(
  s: {
    id: string;
    title: string;
    summary: string | null;
    articleCount: number;
    firstPublishedAt: Date | null;
    lastPublishedAt: Date | null;
  },
  articles: ArticleRef[],
  matchedArticleCount: number = s.articleCount
): StoryItem {
  return {
    id: s.id,
    title: s.title,
    summary: s.summary,
    articleCount: s.articleCount,
    matchedArticleCount,
    firstPublishedAt: iso(s.firstPublishedAt),
    lastPublishedAt: iso(s.lastPublishedAt),
    sources: distinctSources(articles),
    articles,
    articlesTruncated: matchedArticleCount > articles.length,
  };
}
