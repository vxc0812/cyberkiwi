/**
 * Push jobs: queued notifications, one row per device.
 *
 *   ingestion stores articles → breaking title → story + category → devices that want it
 *   → PushJob rows, deduplicated → worker sends through FCM/APNs → SENT, INVALID (dead token) or retry
 *
 * Queueing is a database write. It makes no network call, so the feed worker stays fast and a provider outage
 * never reaches ingestion. Sending happens in the push worker.
 */
import type { PrismaClient } from '../../generated/prisma/client';
import { backoffMs } from '../enrichment/queue';
import { isBreakingTitle, wantsBreaking } from './breaking';
import { payloadFor, type PushPayload, type PushPlatform, type PushResult, type PushSender } from './sender';

export const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;
export const MAX_DEVICES_PER_RUN = 5000;
export const DEFAULT_MAX_ATTEMPTS = 5;

/** One push per (kind, story, category, window, device). Repeats inside the window hit the unique key. */
export function dedupeKeyFor(kind: string, storyId: string, category: string, now: Date, deviceId: string): string {
  const bucket = Math.floor(now.getTime() / DEDUPE_WINDOW_MS);
  return `${kind}|${storyId}|${category}|${bucket}|${deviceId}`;
}

/** Queues breaking-news pushes for articles that changed in one feed run. Returns the number of new jobs. */
export async function queueBreakingPushes(
  db: PrismaClient,
  input: { feedId: string; externalIds: readonly string[]; now?: Date }
): Promise<number> {
  if (input.externalIds.length === 0) return 0;
  const now = input.now ?? new Date();

  const articles = await db.article.findMany({
    where: { feedId: input.feedId, externalId: { in: [...input.externalIds] } },
    select: { title: true, storyLink: { select: { storyId: true } }, feed: { select: { category: true } } },
  });
  const targets = new Map<string, { storyId: string; category: string }>();
  for (const a of articles) {
    if (!a.storyLink || !isBreakingTitle(a.title)) continue;
    const category = a.feed.category;
    targets.set(`${a.storyLink.storyId}|${category}`, { storyId: a.storyLink.storyId, category });
  }
  if (targets.size === 0) return 0;

  const devices = await db.device.findMany({
    where: { revokedAt: null },
    select: { id: true, notificationPrefs: true },
    take: MAX_DEVICES_PER_RUN,
    orderBy: { createdAt: 'asc' },
  });

  let created = 0;
  for (const { storyId, category } of targets.values()) {
    const payload = payloadFor('breaking', storyId);
    const rows = devices
      .filter((d) => wantsBreaking(d.notificationPrefs, category))
      .map((d) => ({
        deviceId: d.id,
        dedupeKey: dedupeKeyFor('breaking', storyId, category, now, d.id),
        kind: 'breaking',
        storyId,
        category,
        title: payload.title,
        deepLink: payload.deepLink,
        status: 'PENDING' as const,
        nextAttemptAt: now,
      }));
    if (rows.length === 0) continue;
    const result = await db.pushJob.createMany({ data: rows, skipDuplicates: true });
    created += result.count;
  }
  return created;
}

export interface PushRunSummary {
  claimed: number;
  sent: number;
  invalid: number;
  retried: number;
  failed: number;
}

interface ClaimedPush {
  id: string;
  deviceId: string;
  kind: string;
  title: string;
  deepLink: string | null;
  attempts: number;
}

const PLATFORM: Record<'IOS' | 'ANDROID' | 'WEB', PushPlatform> = { IOS: 'ios', ANDROID: 'android', WEB: 'web' };

/**
 * Claims due jobs (FOR UPDATE SKIP LOCKED, so workers never overlap), sends each one, and records the outcome.
 * A dead token marks its device revoked. Other failures back off, and stop after maxAttempts.
 */
export async function processPushJobs(
  db: PrismaClient,
  sender: PushSender,
  options: { limit?: number; now?: Date; maxAttempts?: number } = {}
): Promise<PushRunSummary> {
  const now = options.now ?? new Date();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const claimed = await db.$queryRaw<ClaimedPush[]>`
    UPDATE "PushJob"
       SET "status" = 'RUNNING', "attempts" = "attempts" + 1, "updatedAt" = ${now}
     WHERE "id" IN (
       SELECT "id" FROM "PushJob"
        WHERE "status" = 'PENDING' AND "nextAttemptAt" <= ${now}
        ORDER BY "nextAttemptAt"
        LIMIT ${options.limit ?? 50}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING "id", "deviceId", "kind", "title", "deepLink", "attempts"`;

  const summary: PushRunSummary = { claimed: claimed.length, sent: 0, invalid: 0, retried: 0, failed: 0 };
  for (const job of claimed) {
    const device = await db.device.findUnique({
      where: { id: job.deviceId },
      select: { platform: true, pushToken: true, revokedAt: true },
    });
    if (!device || device.revokedAt) {
      await db.pushJob.update({ where: { id: job.id }, data: { status: 'INVALID', lastError: 'device removed', updatedAt: now } });
      summary.invalid++;
      continue;
    }

    const payload: PushPayload = { kind: job.kind as PushPayload['kind'], title: job.title, deepLink: job.deepLink };
    let result: PushResult;
    try {
      result = await sender.send({ platform: PLATFORM[device.platform], pushToken: device.pushToken }, payload);
    } catch {
      result = 'failed';
    }

    if (result === 'sent') {
      await db.pushJob.update({ where: { id: job.id }, data: { status: 'SENT', lastError: null, updatedAt: now } });
      summary.sent++;
    } else if (result === 'invalid_token') {
      await db.pushJob.update({ where: { id: job.id }, data: { status: 'INVALID', lastError: 'token rejected by provider', updatedAt: now } });
      await db.device.update({ where: { id: job.deviceId }, data: { revokedAt: now } });
      summary.invalid++;
    } else {
      const message = result === 'unavailable' ? 'provider not configured' : 'send failed';
      if (job.attempts >= maxAttempts) {
        await db.pushJob.update({ where: { id: job.id }, data: { status: 'FAILED', lastError: message, updatedAt: now } });
        summary.failed++;
      } else {
        await db.pushJob.update({
          where: { id: job.id },
          data: { status: 'PENDING', lastError: message, nextAttemptAt: new Date(now.getTime() + backoffMs(job.attempts)), updatedAt: now },
        });
        summary.retried++;
      }
    }
  }
  return summary;
}
