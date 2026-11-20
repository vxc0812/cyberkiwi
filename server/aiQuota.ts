/**
 * Persistent daily AI quotas, kept in PostgreSQL so they survive restarts and hold across replicas.
 *
 * One atomic statement either creates today's counter at 1 or increments it while it is below the
 * limit. Two concurrent requests cannot both take the last unit.
 */
import type { PrismaClient } from '../generated/prisma/client';

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Consumes one unit for `identity` today. Returns false when the limit is already reached. */
export async function consumeQuota(
  db: Pick<PrismaClient, '$queryRaw'>,
  identity: string,
  limit: number,
  now: Date = new Date()
): Promise<boolean> {
  if (!Number.isInteger(limit) || limit < 1) return false;
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "AiQuotaUsage" ("identity", "day", "count", "updatedAt")
    VALUES (${identity}, ${utcDay(now)}, 1, ${now})
    ON CONFLICT ("identity", "day")
    DO UPDATE SET "count" = "AiQuotaUsage"."count" + 1, "updatedAt" = ${now}
      WHERE "AiQuotaUsage"."count" < ${limit}
    RETURNING "count"`;
  return rows.length === 1;
}

export async function usageToday(db: Pick<PrismaClient, 'aiQuotaUsage'>, identity: string, now: Date = new Date()): Promise<number> {
  const row = await db.aiQuotaUsage.findUnique({
    where: { identity_day: { identity, day: utcDay(now) } },
    select: { count: true },
  });
  return row?.count ?? 0;
}
