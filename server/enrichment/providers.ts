/**
 * Enrichment providers and the runner that executes due jobs.
 *
 * A provider takes one article and writes its enrichment rows. Every write is idempotent (skipDuplicates
 * on the join tables), so a retried job cannot create duplicates.
 *
 * Providers never run inside the RSS ingestion path. The ingestion worker only enqueues jobs. The
 * enrichment worker (run-worker.ts) executes them, and a failure there leaves the feed run untouched.
 */
import type { PrismaClient } from '../../generated/prisma/client';
import { extractCveIds, extractEntities, extractTechniques } from './extractors';
import { claimDueJobs, DEFAULT_MAX_ATTEMPTS, markDone, markFailed } from './queue';

export type EnrichmentProvider = (db: PrismaClient, articleId: string) => Promise<void>;

export const PROVIDER_CVE = 'cve-link';
export const PROVIDER_ATTACK = 'attack';
export const PROVIDER_ENTITIES = 'entities';
/** Providers that run in the enrichment worker from article text alone. */
export const ARTICLE_PROVIDERS = [PROVIDER_CVE, PROVIDER_ATTACK, PROVIDER_ENTITIES] as const;

/**
 * NVD articles (from the NVD ingestion adapter) start with their own CVE id and carry the CVSS summary
 * "CVSS 9.8 CRITICAL. ...". Their severity is recorded on the Cve row. No network call is needed.
 */
const NVD_SUMMARY = /^CVSS (\d{1,2}(?:\.\d)?) (CRITICAL|HIGH|MEDIUM|LOW|NONE)\b/;

async function recordNvdSeverity(db: PrismaClient, articleId: string): Promise<void> {
  const article = await db.article.findUnique({ where: { id: articleId }, select: { title: true, excerpt: true } });
  if (!article) return;
  const match = NVD_SUMMARY.exec(article.excerpt ?? '');
  const id = /^(CVE-\d{4}-\d{4,7}):/.exec(article.title)?.[1];
  if (!match || !id) return;
  const score = Number(match[1]);
  const severity = match[2];
  if (!Number.isFinite(score)) return;
  // Provisional: parsed from article text, not from NVD. Consumers see severitySource "article".
  await db.cve.updateMany({
    where: { id, OR: [{ cvssSeverity: null }, { cvssSeverity: { not: severity } }, { cvssScore: { not: score } }] },
    data: { cvssScore: score, cvssSeverity: severity, severitySource: 'ARTICLE', severityUpdatedAt: new Date() },
  });
}

async function articleText(db: PrismaClient, articleId: string): Promise<string | null> {
  const article = await db.article.findUnique({
    where: { id: articleId },
    select: { title: true, excerpt: true },
  });
  if (!article) return null;
  return `${article.title} ${article.excerpt ?? ''}`;
}

export const localProviders: Record<string, EnrichmentProvider> = {
  [PROVIDER_CVE]: async (db, articleId) => {
    const text = await articleText(db, articleId);
    if (text === null) return;
    const ids = extractCveIds(text);
    if (ids.length === 0) return;
    await db.cve.createMany({ data: ids.map((id) => ({ id, provider: PROVIDER_CVE })), skipDuplicates: true });
    await recordNvdSeverity(db, articleId);
    await db.articleCve.createMany({
      data: ids.map((cveId) => ({ articleId, cveId, provider: PROVIDER_CVE })),
      skipDuplicates: true,
    });
  },

  [PROVIDER_ATTACK]: async (db, articleId) => {
    const text = await articleText(db, articleId);
    if (text === null) return;
    const rules = extractTechniques(text);
    if (rules.length === 0) return;
    await db.mitreTechnique.createMany({
      data: rules.map((r) => ({ id: r.id, name: r.name, tactic: r.tactic })),
      skipDuplicates: true,
    });
    await db.articleTechnique.createMany({
      data: rules.map((r) => ({ articleId, techniqueId: r.id, provider: PROVIDER_ATTACK })),
      skipDuplicates: true,
    });
  },

  [PROVIDER_ENTITIES]: async (db, articleId) => {
    const text = await articleText(db, articleId);
    if (text === null) return;
    const rules = extractEntities(text);
    for (const rule of rules) {
      const entity = await db.entity.upsert({
        where: { type_slug: { type: rule.type, slug: rule.slug } },
        create: { type: rule.type, slug: rule.slug, name: rule.name },
        update: {},
        select: { id: true },
      });
      await db.articleEntity.createMany({
        data: [{ articleId, entityId: entity.id, provider: PROVIDER_ENTITIES }],
        skipDuplicates: true,
      });
    }
  },
};

export interface RunSummary {
  claimed: number;
  done: number;
  retried: number;
  failed: number;
}

/**
 * Claims due jobs and runs their providers. One job's failure is recorded on that job and never stops
 * the others. Unknown providers fail immediately, because a typo must not loop forever.
 */
export async function runEnrichmentBatch(
  db: PrismaClient,
  providers: Record<string, EnrichmentProvider> = localProviders,
  options: { limit?: number; now?: Date; maxAttempts?: number } = {}
): Promise<RunSummary> {
  const now = options.now ?? new Date();
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const jobs = await claimDueJobs(db, options.limit ?? 50, now);
  const summary: RunSummary = { claimed: jobs.length, done: 0, retried: 0, failed: 0 };

  for (const job of jobs) {
    const provider = providers[job.provider];
    try {
      if (!provider) throw new Error(`unknown enrichment provider "${job.provider}"`);
      await provider(db, job.articleId);
      await markDone(db, job.id, now);
      summary.done++;
    } catch (err) {
      const outcome = await markFailed(db, job, (err as Error).message ?? 'unknown error', { now, maxAttempts });
      if (outcome === 'retry') summary.retried++;
      else summary.failed++;
    }
  }
  return summary;
}
