/**
 * GET /api/v1/enrichment/stats: operational counts for the enrichment pipeline.
 *
 * Operator data, so it requires a signed-in ADMIN session. It is never public, and the ADMIN_TOKEN is not
 * accepted here. Errors are reported as stored (lastError), which contains provider messages, not secrets.
 */
import { Router, type Request, type Response } from 'express';
import type { PrismaClient } from '../../generated/prisma/client';
import { requireRole, requireUser } from '../auth/middleware';

export interface EnrichmentStats {
  generatedAt: string;
  jobs: Record<'PENDING' | 'RUNNING' | 'DONE' | 'FAILED', number>;
  byProvider: { provider: string; status: string; count: number }[];
  oldestPendingDueAt: string | null;
  recentFailures: { provider: string; attempts: number; updatedAt: string; lastError: string | null }[];
  catalogs: { provider: string; lastAttemptAt: string | null; lastSuccessAt: string | null; lastStatus: string | null; rowsUpdated: number }[];
  cves: { total: number; knownExploited: number; withEpss: number };
}

export async function enrichmentStats(db: PrismaClient, now: Date = new Date()): Promise<EnrichmentStats> {
  const [statusGroups, providerGroups, oldest, failures, catalogs, cveTotal, cveKev, cveEpss] = await Promise.all([
    db.enrichmentJob.groupBy({ by: ['status'], _count: { _all: true } }),
    db.enrichmentJob.groupBy({ by: ['provider', 'status'], _count: { _all: true } }),
    db.enrichmentJob.findFirst({ where: { status: 'PENDING' }, orderBy: { nextAttemptAt: 'asc' }, select: { nextAttemptAt: true } }),
    db.enrichmentJob.findMany({
      where: { status: 'FAILED' },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: { provider: true, attempts: true, updatedAt: true, lastError: true },
    }),
    db.catalogSync.findMany({ orderBy: { provider: 'asc' } }),
    db.cve.count(),
    db.cve.count({ where: { knownExploited: true } }),
    db.cve.count({ where: { epss: { not: null } } }),
  ]);

  const jobs: EnrichmentStats['jobs'] = { PENDING: 0, RUNNING: 0, DONE: 0, FAILED: 0 };
  for (const g of statusGroups) jobs[g.status] = g._count._all;

  return {
    generatedAt: now.toISOString(),
    jobs,
    byProvider: providerGroups.map((g) => ({ provider: g.provider, status: g.status, count: g._count._all })),
    oldestPendingDueAt: oldest?.nextAttemptAt.toISOString() ?? null,
    recentFailures: failures.map((f) => ({
      provider: f.provider,
      attempts: f.attempts,
      updatedAt: f.updatedAt.toISOString(),
      lastError: f.lastError,
    })),
    catalogs: catalogs.map((c) => ({
      provider: c.provider,
      lastAttemptAt: c.lastAttemptAt?.toISOString() ?? null,
      lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
      lastStatus: c.lastStatus,
      rowsUpdated: c.rowsUpdated,
    })),
    cves: { total: cveTotal, knownExploited: cveKev, withEpss: cveEpss },
  };
}

/** Mounted at /api/v1/enrichment before the public read API, so the stats path is never handled there. */
export function createEnrichmentStatsRouter(db: PrismaClient): Router {
  const router = Router();
  router.get('/stats', requireUser, requireRole('ADMIN'), async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, stats: await enrichmentStats(db) });
  });
  return router;
}
