/**
 * Data-access layer for ingestion. The only module that issues ingestion queries.
 *
 * Every function receives the Prisma client as its first argument, so the worker
 * and the integration tests can supply their own database connection.
 */
import type { PrismaClient } from '../../generated/prisma/client';
import type { FeedHealth, NormalizedArticle, RunStatus } from '../ingestion/contract';

export type IngestionTrigger = 'SCHEDULED' | 'MANUAL';

export interface SourceInput {
  slug: string;
  name: string;
  category: string;
  language?: string;
  homepageUrl?: string | null;
}

export interface FeedInput {
  sourceId: string;
  url: string;
  category: string;
  language?: string;
  title?: string | null;
  fetchIntervalMinutes?: number;
}

export interface ActiveFeed {
  id: string;
  url: string;
  active: boolean;
  fetchIntervalMinutes: number;
  etag: string | null;
  lastModified: string | null;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface ArticleWriteResult {
  inserted: number;
  updated: number;
  unchanged: number;
  /** External ids of articles that were inserted or rewritten in this call. */
  changedExternalIds: string[];
}

export async function upsertSource(db: PrismaClient, input: SourceInput): Promise<string> {
  const row = await db.source.upsert({
    where: { slug: input.slug },
    create: {
      slug: input.slug,
      name: input.name,
      category: input.category,
      language: input.language ?? 'en',
      homepageUrl: input.homepageUrl ?? null,
    },
    update: {
      name: input.name,
      category: input.category,
      language: input.language ?? 'en',
      homepageUrl: input.homepageUrl ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

/** Feeds are identified by URL. Re-running an import updates metadata and keeps fetch state. */
export async function upsertFeed(db: PrismaClient, input: FeedInput): Promise<string> {
  const row = await db.feed.upsert({
    where: { url: input.url },
    create: {
      sourceId: input.sourceId,
      url: input.url,
      category: input.category,
      language: input.language ?? 'en',
      title: input.title ?? null,
      fetchIntervalMinutes: input.fetchIntervalMinutes ?? 15,
    },
    update: {
      sourceId: input.sourceId,
      category: input.category,
      language: input.language ?? 'en',
      title: input.title ?? null,
      fetchIntervalMinutes: input.fetchIntervalMinutes ?? 15,
    },
    select: { id: true },
  });
  return row.id;
}

export async function setFeedActive(db: PrismaClient, feedId: string, active: boolean): Promise<void> {
  await db.feed.update({ where: { id: feedId }, data: { active } });
}

/** Active feeds only. The worker applies due-time and backoff rules on top of this list. */
export async function listActiveFeeds(db: PrismaClient): Promise<ActiveFeed[]> {
  return db.feed.findMany({
    where: { active: true },
    orderBy: { url: 'asc' },
    select: {
      id: true,
      url: true,
      active: true,
      fetchIntervalMinutes: true,
      etag: true,
      lastModified: true,
      lastAttemptAt: true,
      lastSuccessAt: true,
      lastFailureAt: true,
      lastError: true,
      consecutiveFailures: true,
    },
  });
}

export async function startRun(db: PrismaClient, feedId: string, trigger: IngestionTrigger, startedAt: Date): Promise<string> {
  const run = await db.ingestionRun.create({
    data: { feedId, trigger, status: 'RUNNING', startedAt },
    select: { id: true },
  });
  return run.id;
}

export interface FinishRunInput {
  status: RunStatus | 'SKIPPED';
  finishedAt: Date;
  durationMs: number;
  httpStatus?: number | null;
  itemsSeen: number;
  itemsNew: number;
  itemsUpdated: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export async function finishRun(db: PrismaClient, runId: string, input: FinishRunInput): Promise<void> {
  await db.ingestionRun.update({
    where: { id: runId },
    data: {
      status: input.status,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
      httpStatus: input.httpStatus ?? null,
      itemsSeen: input.itemsSeen,
      itemsNew: input.itemsNew,
      itemsUpdated: input.itemsUpdated,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
    },
  });
}

/** Persists health after an attempt. Validators are stored only when the server sent them. */
export async function saveFeedOutcome(
  db: PrismaClient,
  feedId: string,
  health: FeedHealth,
  validators?: { etag?: string | null; lastModified?: string | null }
): Promise<void> {
  await db.feed.update({
    where: { id: feedId },
    data: {
      lastAttemptAt: health.lastAttemptAt,
      lastSuccessAt: health.lastSuccessAt,
      lastFailureAt: health.lastFailureAt,
      lastError: health.lastError,
      consecutiveFailures: health.consecutiveFailures,
      ...(validators?.etag !== undefined ? { etag: validators.etag } : {}),
      ...(validators?.lastModified !== undefined ? { lastModified: validators.lastModified } : {}),
    },
  });
}

/**
 * Idempotent article write. Identity is (feedId, externalId).
 * - New identities are inserted with skipDuplicates, so concurrent workers cannot double-insert.
 * - Existing identities get lastSeenAt refreshed; they are rewritten only when contentHash changed.
 * Running the same batch twice inserts nothing the second time.
 */
export async function upsertArticles(
  db: PrismaClient,
  feedId: string,
  articles: NormalizedArticle[],
  now: Date
): Promise<ArticleWriteResult> {
  if (articles.length === 0) return { inserted: 0, updated: 0, unchanged: 0, changedExternalIds: [] };

  const externalIds = articles.map((a) => a.externalId);
  const existing = await db.article.findMany({
    where: { feedId, externalId: { in: externalIds } },
    select: { id: true, externalId: true, contentHash: true, audioUrl: true },
  });
  const existingByExternal = new Map(existing.map((row) => [row.externalId, row]));

  const toCreate = articles.filter((a) => !existingByExternal.has(a.externalId));
  const toUpdate = articles.filter((a) => {
    const row = existingByExternal.get(a.externalId);
    return row !== undefined && (row.contentHash !== a.contentHash || row.audioUrl !== a.audioUrl);
  });

  let inserted = 0;
  if (toCreate.length > 0) {
    const created = await db.article.createMany({
      data: toCreate.map((a) => toArticleData(feedId, a, now)),
      skipDuplicates: true,
    });
    inserted = created.count;
  }

  if (toUpdate.length > 0) {
    await db.$transaction(
      toUpdate.map((a) => {
        const row = existingByExternal.get(a.externalId)!;
        return db.article.update({
          where: { id: row.id },
          data: { ...toArticleData(feedId, a, now), firstSeenAt: undefined },
        });
      })
    );
  }

  const unchangedExternalIds = articles
    .filter((a) => existingByExternal.has(a.externalId) && !toUpdate.includes(a))
    .map((a) => a.externalId);
  if (unchangedExternalIds.length > 0) {
    await db.article.updateMany({
      where: { feedId, externalId: { in: unchangedExternalIds } },
      data: { lastSeenAt: now },
    });
  }

  return {
    inserted,
    updated: toUpdate.length,
    unchanged: unchangedExternalIds.length,
    // New or rewritten articles. Only these need enrichment jobs.
    changedExternalIds: [...toCreate.map((a) => a.externalId), ...toUpdate.map((a) => a.externalId)],
  };
}

function toArticleData(feedId: string, a: NormalizedArticle, now: Date) {
  return {
    feedId,
    externalId: a.externalId,
    url: a.url,
    canonicalUrl: a.canonicalUrl,
    title: a.title,
    excerpt: a.excerpt,
    author: a.author,
    imageUrl: a.imageUrl,
    audioUrl: a.audioUrl,
    publishedAt: a.publishedAt,
    sortAt: a.publishedAt ?? now,
    contentHash: a.contentHash,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}
