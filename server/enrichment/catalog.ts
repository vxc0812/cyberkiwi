/**
 * Catalog-level enrichment: CISA KEV (known exploited) and FIRST EPSS (exploit probability).
 *
 * These feeds describe CVEs, not articles, so they are synced on their own schedule. A sync updates the
 * Cve rows in place, touches updatedAt only when a value really changed, and records provenance
 * (sourceUpdatedAt and provider). Articles are never re-ingested for a catalog change.
 *
 * Fetching is injected: the worker passes real fetchers, and the tests pass fixtures.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/client';

export const KEV_PROVIDER = 'cisa-kev';
export const EPSS_PROVIDER = 'first-epss';
const CVE_PATTERN = /^CVE-\d{4}-\d{4,7}$/;
const BATCH = 500;

export interface KevRow {
  cveId: string;
  vendorProject: string | null;
  product: string | null;
  dateAdded: Date;
  dueDate: Date | null;
  ransomwareCampaignUse: boolean;
}

function isoDay(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parses the KEV JSON catalog. Entries with an invalid CVE id or date are skipped, not guessed at. */
export function parseKevCatalog(json: unknown): { rows: KevRow[]; dateReleased: Date | null } {
  const root = json as { dateReleased?: unknown; vulnerabilities?: unknown };
  if (!Array.isArray(root?.vulnerabilities)) throw new Error('KEV catalog has no vulnerabilities array');
  const rows: KevRow[] = [];
  for (const v of root.vulnerabilities as Record<string, unknown>[]) {
    const cveId = typeof v?.cveID === 'string' ? v.cveID.trim().toUpperCase() : '';
    const dateAdded = isoDay(v?.dateAdded);
    if (!CVE_PATTERN.test(cveId) || !dateAdded) continue;
    rows.push({
      cveId,
      vendorProject: typeof v.vendorProject === 'string' ? v.vendorProject.slice(0, 200) : null,
      product: typeof v.product === 'string' ? v.product.slice(0, 200) : null,
      dateAdded,
      dueDate: isoDay(v.dueDate),
      ransomwareCampaignUse: v.knownRansomwareCampaignUse === 'Known',
    });
  }
  return { rows, dateReleased: typeof root.dateReleased === 'string' ? new Date(root.dateReleased) : null };
}

/** Applies a parsed KEV catalog. Returns the number of entries written. */
export async function syncKev(
  db: PrismaClient,
  json: unknown,
  now: Date = new Date()
): Promise<{ written: number }> {
  const { rows, dateReleased } = parseKevCatalog(json);
  const sourceUpdatedAt = dateReleased && !Number.isNaN(dateReleased.getTime()) ? dateReleased : now;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await db.cve.createMany({
      data: batch.map((r) => ({ id: r.cveId, provider: KEV_PROVIDER, knownExploited: true, sourceUpdatedAt })),
      skipDuplicates: true,
    });
    await db.$transaction(
      batch.map((r) =>
        db.kevEntry.upsert({
          where: { cveId: r.cveId },
          create: { ...r, sourceUpdatedAt },
          update: { vendorProject: r.vendorProject, product: r.product, dateAdded: r.dateAdded, dueDate: r.dueDate, ransomwareCampaignUse: r.ransomwareCampaignUse, sourceUpdatedAt },
        })
      )
    );
    await db.cve.updateMany({
      where: { id: { in: batch.map((r) => r.cveId) }, knownExploited: false },
      data: { knownExploited: true, updatedAt: now, sourceUpdatedAt },
    });
  }

  await recordSync(db, KEV_PROVIDER, { now, rowsUpdated: rows.length, sourceUpdatedAt });
  return { written: rows.length };
}

export interface EpssRow {
  cveId: string;
  epss: number;
  percentile: number;
}

/** Parses the EPSS CSV (comment lines start with #, then a "cve,epss,percentile" header). */
export function parseEpssCsv(text: string): EpssRow[] {
  const rows: EpssRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#') || line.toLowerCase().startsWith('cve,')) continue;
    const [rawId, rawEpss, rawPct] = line.split(',');
    const cveId = (rawId ?? '').trim().toUpperCase();
    const epss = Number(rawEpss);
    const percentile = Number(rawPct);
    if (!CVE_PATTERN.test(cveId)) continue;
    if (!Number.isFinite(epss) || epss < 0 || epss > 1) continue;
    if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) continue;
    rows.push({ cveId, epss, percentile });
  }
  return rows;
}

/**
 * Updates EPSS scores for CVEs we already track, and records a daily snapshot for each. EPSS covers
 * hundreds of thousands of CVEs, so rows we do not track are ignored rather than stored.
 */
export async function syncEpss(
  db: PrismaClient,
  text: string,
  date: Date,
  now: Date = new Date()
): Promise<{ updated: number; parsed: number }> {
  const rows = parseEpssCsv(text);
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  let updated = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = Prisma.join(batch.map((r) => Prisma.sql`(${r.cveId}, ${r.epss}::float8, ${r.percentile}::float8)`));

    const changed = await db.$queryRaw<{ id: string }[]>`
      UPDATE "Cve" AS c
         SET "epss" = v.epss,
             "epssPercentile" = v.pct,
             "epssDate" = ${day}::date,
             "updatedAt" = ${now},
             "sourceUpdatedAt" = ${now}
        FROM (VALUES ${values}) AS v(id, epss, pct)
       WHERE c."id" = v.id
         AND (c."epss" IS DISTINCT FROM v.epss OR c."epssPercentile" IS DISTINCT FROM v.pct)
      RETURNING c."id"`;
    updated += changed.length;

    await db.$executeRaw`
      INSERT INTO "EpssSnapshot" ("cveId", "date", "epss", "percentile")
      SELECT v.id, ${day}::date, v.epss, v.pct
        FROM (VALUES ${values}) AS v(id, epss, pct)
        JOIN "Cve" AS c ON c."id" = v.id
      ON CONFLICT ("cveId", "date") DO UPDATE
        SET "epss" = EXCLUDED."epss", "percentile" = EXCLUDED."percentile"`;
  }

  await recordSync(db, EPSS_PROVIDER, { now, rowsUpdated: updated, sourceUpdatedAt: day });
  return { updated, parsed: rows.length };
}

async function recordSync(
  db: PrismaClient,
  provider: string,
  input: { now: Date; rowsUpdated: number; sourceUpdatedAt: Date | null }
): Promise<void> {
  await db.catalogSync.upsert({
    where: { provider },
    create: {
      provider,
      lastAttemptAt: input.now,
      lastSuccessAt: input.now,
      lastStatus: 'ok',
      rowsUpdated: input.rowsUpdated,
      sourceUpdatedAt: input.sourceUpdatedAt,
    },
    update: {
      lastAttemptAt: input.now,
      lastSuccessAt: input.now,
      lastStatus: 'ok',
      lastError: null,
      rowsUpdated: input.rowsUpdated,
      sourceUpdatedAt: input.sourceUpdatedAt,
    },
  });
}

/** Records a failed sync attempt without touching the last good sync time. */
export async function recordSyncFailure(db: PrismaClient, provider: string, error: string, now: Date = new Date()): Promise<void> {
  const message = error.replace(/\s+/g, ' ').slice(0, 300);
  await db.catalogSync.upsert({
    where: { provider },
    create: { provider, lastAttemptAt: now, lastStatus: 'failed', lastError: message },
    update: { lastAttemptAt: now, lastStatus: 'failed', lastError: message },
  });
}
