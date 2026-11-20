/**
 * Ingestion worker and scheduler.
 *
 * Responsibilities:
 * - Select active feeds that are due (base interval, or backoff after failures).
 * - Fetch, parse and normalize each feed through the shared network-safety path.
 * - Persist articles idempotently and record one IngestionRun per attempt.
 * - Isolate failures: one feed's error never stops the cycle or other feeds.
 *
 * Dependencies (database, fetcher, parser, clock) are injected so the integration
 * tests can drive the same code with fake sources.
 */
import type { PrismaClient } from '../../generated/prisma/client';
import {
  applyFetchOutcome,
  nextAttemptDelayMinutes,
  normalizeBatch,
  runStatusFor,
  type FeedHealth,
  type FetchOutcome,
  type RawFeedItem,
  type RunStatus,
} from './contract';
import { fetchFeedDocument, parseFeedDocument, type FeedFetchResult } from './fetchFeed';
import { linkUnassignedArticles } from '../repositories/stories';
import { NVD_MAX_ITEMS } from './adapters/nvd';
import { adapterFor } from './catalogPolicy';
import { enqueueChangedArticles } from '../enrichment/queue';
import { ARTICLE_PROVIDERS } from '../enrichment/providers';
import { queueBreakingPushes } from '../push/jobs';
import {
  finishRun,
  listActiveFeeds,
  saveFeedOutcome,
  startRun,
  upsertArticles,
  type ActiveFeed,
  type IngestionTrigger,
} from '../repositories/ingestion';

export interface WorkerDeps {
  db: PrismaClient;
  fetchFeed?: (url: string, conditional: { etag?: string | null; lastModified?: string | null; since?: Date | null; now?: Date }) => Promise<FeedFetchResult>;
  parseFeed?: (body: string, url: string) => Promise<{ title: string | null; items: RawFeedItem[] }>;
  now?: () => Date;
  /** Queues enrichment for changed articles. Defaults to writing jobs to the database. Failures never fail the run. */
  enqueueEnrichment?: (feedId: string, externalIds: string[]) => Promise<number>;
  /** Queues breaking-news pushes (database writes only). Failures never fail the run. */
  queuePush?: (feedId: string, externalIds: string[]) => Promise<number>;
}

async function queuePushes(deps: WorkerDeps, feedId: string, externalIds: string[], now: Date): Promise<void> {
  if (externalIds.length === 0) return;
  try {
    if (deps.queuePush) await deps.queuePush(feedId, externalIds);
    else await queueBreakingPushes(deps.db, { feedId, externalIds, now });
  } catch (err) {
    console.warn(`[ingest] push not queued for feed ${feedId}:`, (err as Error).message);
  }
}

/**
 * Queues enrichment jobs for articles that changed in this run. Enrichment runs later, in its own worker,
 * so a queueing failure is logged here and the feed run finishes as normal.
 */
async function queueEnrichment(deps: WorkerDeps, feedId: string, externalIds: string[], now: Date): Promise<void> {
  if (externalIds.length === 0) return;
  try {
    if (deps.enqueueEnrichment) await deps.enqueueEnrichment(feedId, externalIds);
    else await enqueueChangedArticles(deps.db, feedId, externalIds, ARTICLE_PROVIDERS, now);
  } catch (err) {
    console.warn(`[ingest] enrichment not queued for feed ${feedId}:`, (err as Error).message);
  }
}

export interface IngestResult {
  feedId: string;
  runId: string | null;
  status: RunStatus;
  itemsSeen: number;
  itemsNew: number;
  itemsUpdated: number;
  errorCode: string | null;
}

export interface CycleSummary {
  startedAt: Date;
  finishedAt: Date;
  considered: number;
  due: number;
  succeeded: number;
  partial: number;
  failed: number;
  results: IngestResult[];
}

/** Maps any thrown value to a stable, low-cardinality error code. */
export function classifyError(err: unknown): { code: string; message: string } {
  const e = err as { httpStatus?: number; code?: string; message?: string; name?: string; errorCode?: string };
  const message = String(e?.message ?? err ?? 'unknown error').slice(0, 300);
  // Errors tagged by a pipeline stage (parse, store) keep their stage code.
  if (typeof e?.errorCode === 'string') return { code: e.errorCode, message };
  if (typeof e?.httpStatus === 'number') return { code: `HTTP_${e.httpStatus}`, message };
  if (/private|reserved|not allowed|Local hostnames|resolves to|Invalid URL|Missing hostname/i.test(message)) {
    return { code: 'BLOCKED', message };
  }
  if (/timed out|timeout|ETIMEDOUT|aborted/i.test(message)) return { code: 'TIMEOUT', message };
  if (/size limit/i.test(message)) return { code: 'TOO_LARGE', message };
  if (/redirect/i.test(message)) return { code: 'REDIRECT', message };
  if (e?.code === 'ENOTFOUND' || e?.code === 'ECONNREFUSED' || e?.code === 'ECONNRESET') {
    return { code: 'NETWORK', message };
  }
  if (e?.name === 'ParseError' || /Non-whitespace|Invalid XML|Unexpected close tag|Feed not recognized/i.test(message)) {
    return { code: 'PARSE_ERROR', message };
  }
  return { code: 'FETCH_ERROR', message };
}

/** A feed is due when it has never been attempted, or its (possibly backed-off) interval has elapsed. */
export function isFeedDue(feed: Pick<ActiveFeed, 'lastAttemptAt' | 'fetchIntervalMinutes' | 'consecutiveFailures'>, now: Date): boolean {
  if (!feed.lastAttemptAt) return true;
  const delayMinutes = nextAttemptDelayMinutes(feed.fetchIntervalMinutes, feed.consecutiveFailures);
  return feed.lastAttemptAt.getTime() + delayMinutes * 60_000 <= now.getTime();
}

function healthOf(feed: ActiveFeed): FeedHealth {
  return {
    consecutiveFailures: feed.consecutiveFailures,
    lastAttemptAt: feed.lastAttemptAt,
    lastSuccessAt: feed.lastSuccessAt,
    lastFailureAt: feed.lastFailureAt,
    lastError: feed.lastError,
  };
}

/** Runs one fetch attempt for one feed. Never throws: failures are recorded and returned. */
export async function ingestFeed(
  deps: WorkerDeps,
  feed: ActiveFeed,
  trigger: IngestionTrigger = 'SCHEDULED'
): Promise<IngestResult> {
  const fetchFn = deps.fetchFeed ?? fetchFeedDocument;
  const parseFn = deps.parseFeed ?? parseFeedDocument;
  const now = deps.now ?? (() => new Date());

  const startedAt = now();
  let runId: string | null = null;
  let outcome: FetchOutcome;
  let runStatus: RunStatus = 'FAILED';
  let httpStatus: number | null = null;
  let itemsSeen = 0;
  let itemsNew = 0;
  let itemsUpdated = 0;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  let validators: { etag?: string | null; lastModified?: string | null } | undefined;

  try {
    runId = await startRun(deps.db, feed.id, trigger, startedAt);
  } catch (err) {
    // Without a run row we still attempt the fetch, but nothing is recorded for it.
    console.warn(`[ingest] could not open run for ${feed.url}:`, (err as Error).message);
  }

  try {
    const fetched = await fetchFn(feed.url, { etag: feed.etag, lastModified: feed.lastModified, since: feed.lastSuccessAt, now: startedAt });

    if (fetched.kind === 'not_modified') {
      httpStatus = 304;
      runStatus = 'SUCCEEDED';
      outcome = { kind: 'not_modified', at: now() };
    } else {
      httpStatus = fetched.httpStatus;
      const parsed = await parseFn(fetched.body, feed.url).catch((err) => {
        throw Object.assign(new Error(classifyError(err).message), { errorCode: 'PARSE_ERROR' });
      });
      itemsSeen = parsed.items.length;
      const batch = normalizeBatch(parsed.items, feed.id, now(), adapterFor(feed.url) === 'nvd' ? NVD_MAX_ITEMS : undefined);
      const write = await upsertArticles(deps.db, feed.id, batch.articles, now()).catch((err) => {
        throw Object.assign(new Error(classifyError(err).message), { errorCode: 'STORE_ERROR' });
      });
      // Enrichment jobs are queued before stories are linked. The enrichment worker runs them later.
      await queueEnrichment(deps, feed.id, write.changedExternalIds, now());
      // Group newly stored articles into stories. Unlinked articles are retried on the next run.
      await linkUnassignedArticles(deps.db).catch((err) => {
        throw Object.assign(new Error(classifyError(err).message), { errorCode: 'STORE_ERROR' });
      });
      // Breaking pushes need the story link, so they are queued after linking.
      await queuePushes(deps, feed.id, write.changedExternalIds, now());
      itemsNew = write.inserted;
      itemsUpdated = write.updated;
      runStatus = runStatusFor({ fetchOk: true, itemsSeen, itemsRejected: batch.rejected.length });
      outcome = { kind: 'success', at: now() };
      validators = { etag: fetched.etag, lastModified: fetched.lastModified };
    }
  } catch (err) {
    const classified = classifyError(err);
    const httpFromError = (err as { httpStatus?: number }).httpStatus;
    httpStatus = typeof httpFromError === 'number' ? httpFromError : null;
    errorCode = classified.code;
    errorMessage = classified.message;
    runStatus = 'FAILED';
    outcome = { kind: 'failure', at: now(), errorCode, errorMessage };
  }

  const finishedAt = now();
  const health = applyFetchOutcome(healthOf(feed), outcome!);

  try {
    await saveFeedOutcome(deps.db, feed.id, health, validators);
    if (runId) {
      await finishRun(deps.db, runId, {
        status: runStatus,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        httpStatus,
        itemsSeen,
        itemsNew,
        itemsUpdated,
        errorCode,
        errorMessage,
      });
    }
  } catch (err) {
    console.error(`[ingest] could not persist outcome for ${feed.url}:`, (err as Error).message);
  }

  return { feedId: feed.id, runId, status: runStatus, itemsSeen, itemsNew, itemsUpdated, errorCode };
}

/** One pass over all active feeds that are due. Feeds run with bounded concurrency. */
export async function runIngestionCycle(
  deps: WorkerDeps,
  options: { concurrency?: number; trigger?: IngestionTrigger } = {}
): Promise<CycleSummary> {
  const now = deps.now ?? (() => new Date());
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const trigger = options.trigger ?? 'SCHEDULED';
  const startedAt = now();

  const feeds = await listActiveFeeds(deps.db);
  const due = feeds.filter((f) => isFeedDue(f, startedAt));

  const results: IngestResult[] = [];
  for (let i = 0; i < due.length; i += concurrency) {
    const batch = due.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map((feed) => ingestFeed(deps, feed, trigger)));
    settled.forEach((s, idx) => {
      if (s.status === 'fulfilled') {
        results.push(s.value);
      } else {
        // ingestFeed is designed not to throw; this only guards against programming errors.
        results.push({
          feedId: batch[idx].id,
          runId: null,
          status: 'FAILED',
          itemsSeen: 0,
          itemsNew: 0,
          itemsUpdated: 0,
          errorCode: 'INTERNAL',
        });
      }
    });
  }

  return {
    startedAt,
    finishedAt: now(),
    considered: feeds.length,
    due: due.length,
    succeeded: results.filter((r) => r.status === 'SUCCEEDED').length,
    partial: results.filter((r) => r.status === 'PARTIAL').length,
    failed: results.filter((r) => r.status === 'FAILED').length,
    results,
  };
}

export interface SchedulerHandle {
  stop(): Promise<void>;
  /** Resolves when the cycle currently in progress, if any, has finished. */
  idle(): Promise<void>;
}

/**
 * Runs a cycle immediately and then every intervalMs. Cycles never overlap:
 * if a cycle is still running when the next tick fires, that tick is skipped.
 */
export function startScheduler(
  deps: WorkerDeps,
  options: { intervalMs: number; concurrency?: number; onCycle?: (s: CycleSummary) => void; onError?: (e: unknown) => void }
): SchedulerHandle {
  let running: Promise<void> | null = null;
  let stopped = false;

  const tick = async () => {
    if (stopped || running) return;
    running = runIngestionCycle(deps, { concurrency: options.concurrency })
      .then((summary) => options.onCycle?.(summary))
      .catch((err) => options.onError?.(err))
      .finally(() => {
        running = null;
      });
    await running;
  };

  void tick();
  const timer = setInterval(() => void tick(), options.intervalMs);

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
    async idle() {
      await running;
    },
  };
}
