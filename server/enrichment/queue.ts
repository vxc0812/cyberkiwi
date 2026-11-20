/**
 * The enrichment job queue, stored in PostgreSQL.
 *
 * - Enqueueing is idempotent: one row per (article, provider). Enqueueing the same article twice is a no-op.
 * - Claiming uses FOR UPDATE SKIP LOCKED, so two workers never run the same job at once. A job whose
 *   worker died (status RUNNING and not touched for a while) becomes claimable again.
 * - Failures back off exponentially and stop after maxAttempts, at which point the job is FAILED and
 *   stays visible for inspection.
 */
import type { PrismaClient } from '../../generated/prisma/client';

export const DEFAULT_MAX_ATTEMPTS = 5;
export const BASE_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const STALE_RUNNING_MS = 10 * 60 * 1000;
const BATCH = 1000;

/** Delay before retry number `attempts` (1-based): 1 min, 2 min, 4 min ... capped at 6 hours. */
export function backoffMs(attempts: number): number {
  const exp = Math.min(Math.max(attempts, 1) - 1, 20);
  return Math.min(BASE_BACKOFF_MS * 2 ** exp, MAX_BACKOFF_MS);
}

/** Creates pending jobs for each (article, provider) pair. Existing jobs are left alone. */
export async function enqueueEnrichment(
  db: PrismaClient,
  articleIds: readonly string[],
  providers: readonly string[],
  now: Date = new Date()
): Promise<number> {
  const rows = articleIds.flatMap((articleId) =>
    providers.map((provider) => ({ articleId, provider, status: 'PENDING' as const, nextAttemptAt: now }))
  );
  let created = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const result = await db.enrichmentJob.createMany({ data: rows.slice(i, i + BATCH), skipDuplicates: true });
    created += result.count;
  }
  return created;
}

/** Enqueues the given articles (by feed and external id) for every provider. Returns the number of new jobs. */
export async function enqueueChangedArticles(
  db: PrismaClient,
  feedId: string,
  externalIds: readonly string[],
  providers: readonly string[],
  now: Date = new Date()
): Promise<number> {
  if (externalIds.length === 0) return 0;
  const articles = await db.article.findMany({
    where: { feedId, externalId: { in: [...externalIds] } },
    select: { id: true },
  });
  return enqueueEnrichment(db, articles.map((a) => a.id), providers, now);
}

export interface ClaimedJob {
  id: string;
  articleId: string;
  provider: string;
  attempts: number;
}

/** Atomically claims up to `limit` due jobs and marks them RUNNING. */
export async function claimDueJobs(
  db: Pick<PrismaClient, '$queryRaw'>,
  limit: number,
  now: Date = new Date()
): Promise<ClaimedJob[]> {
  const staleBefore = new Date(now.getTime() - STALE_RUNNING_MS);
  const rows = await db.$queryRaw<ClaimedJob[]>`
    UPDATE "EnrichmentJob"
       SET "status" = 'RUNNING', "attempts" = "attempts" + 1, "updatedAt" = ${now}
     WHERE "id" IN (
       SELECT "id" FROM "EnrichmentJob"
        WHERE ("status" = 'PENDING' AND "nextAttemptAt" <= ${now})
           OR ("status" = 'RUNNING' AND "updatedAt" < ${staleBefore})
        ORDER BY "nextAttemptAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING "id", "articleId", "provider", "attempts"`;
  return rows;
}

export async function markDone(db: PrismaClient, id: string, now: Date = new Date()): Promise<void> {
  await db.enrichmentJob.update({ where: { id }, data: { status: 'DONE', lastError: null, updatedAt: now } });
}

/** Records a failure. Retries with backoff until maxAttempts, then the job is FAILED. */
export async function markFailed(
  db: PrismaClient,
  job: { id: string; attempts: number },
  error: string,
  options: { now?: Date; maxAttempts?: number } = {}
): Promise<'retry' | 'failed'> {
  const now = options.now ?? new Date();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const message = error.replace(/\s+/g, ' ').slice(0, 300);
  if (job.attempts >= maxAttempts) {
    await db.enrichmentJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', lastError: message, updatedAt: now },
    });
    return 'failed';
  }
  await db.enrichmentJob.update({
    where: { id: job.id },
    data: {
      status: 'PENDING',
      lastError: message,
      nextAttemptAt: new Date(now.getTime() + backoffMs(job.attempts)),
      updatedAt: now,
    },
  });
  return 'retry';
}

export async function queueCounts(db: Pick<PrismaClient, 'enrichmentJob'>): Promise<Record<string, number>> {
  const groups = await db.enrichmentJob.groupBy({ by: ['status'], _count: { _all: true } });
  const out: Record<string, number> = { PENDING: 0, RUNNING: 0, DONE: 0, FAILED: 0 };
  for (const g of groups) out[g.status] = g._count._all;
  return out;
}

