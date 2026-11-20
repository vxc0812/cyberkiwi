/**
 * Enrichment worker. Separate from RSS ingestion, so enrichment cannot slow or fail feed fetches.
 *
 *   npm run worker:enrich                run continuously (ENRICH_INTERVAL_MS, default 60 s)
 *   npm run worker:enrich -- --once      drain the due jobs once and exit
 *   npm run worker:enrich -- --no-catalog  skip the KEV and EPSS downloads
 *
 * Each cycle first runs due article jobs (cve-link, attack, entities). Then, at most once a day, it syncs
 * the CISA KEV catalog and the FIRST EPSS scores. A failed catalog download is recorded in CatalogSync and
 * does not stop article jobs.
 */
import '../ingestion/loadEnv';
import { gunzipSync } from 'zlib';
import { closePrisma, getPrisma } from '../db/client';
import { runEnrichmentBatch } from './providers';
import { recordSyncFailure, syncEpss, syncKev, KEV_PROVIDER, EPSS_PROVIDER } from './catalog';

export const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
export const EPSS_URL = 'https://epss.cyentia.com/epss_scores-current.csv.gz';
export const CATALOG_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 60 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 90_000;

/** Fetches a fixed catalog URL with a timeout and a size limit. Only the host is ever logged. */
async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { 'User-Agent': 'CyberKiwi-enrichment/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error('catalog download exceeds the size limit');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error('catalog download exceeds the size limit');
  return buf;
}

export async function syncCatalogsIfDue(
  db: ReturnType<typeof getPrisma>,
  now: Date = new Date(),
  fetchBytes: (url: string) => Promise<Buffer> = download
): Promise<{ kev?: string; epss?: string }> {
  const out: { kev?: string; epss?: string } = {};
  const due = async (provider: string): Promise<boolean> => {
    const row = await db.catalogSync.findUnique({ where: { provider }, select: { lastSuccessAt: true } });
    return !row?.lastSuccessAt || now.getTime() - row.lastSuccessAt.getTime() >= CATALOG_INTERVAL_MS;
  };

  if (await due(KEV_PROVIDER)) {
    try {
      const json = JSON.parse((await fetchBytes(KEV_URL)).toString('utf8'));
      const result = await syncKev(db, json, now);
      out.kev = `ok:${result.written}`;
    } catch (err) {
      await recordSyncFailure(db, KEV_PROVIDER, (err as Error).message, now);
      out.kev = 'failed';
    }
  }

  if (await due(EPSS_PROVIDER)) {
    try {
      const text = gunzipSync(await fetchBytes(EPSS_URL)).toString('utf8');
      const result = await syncEpss(db, text, now, now);
      out.epss = `ok:${result.updated}`;
    } catch (err) {
      await recordSyncFailure(db, EPSS_PROVIDER, (err as Error).message, now);
      out.epss = 'failed';
    }
  }
  return out;
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const skipCatalog = process.argv.includes('--no-catalog');
  const intervalMs = Number(process.env.ENRICH_INTERVAL_MS || 60_000);
  const db = getPrisma();

  const cycle = async (): Promise<void> => {
    let processed = 0;
    for (;;) {
      const summary = await runEnrichmentBatch(db, undefined, { limit: 100 });
      processed += summary.claimed;
      if (summary.claimed === 0 || !once) break;
    }
    const catalogs = skipCatalog ? {} : await syncCatalogsIfDue(db);
    console.log(`[enrich] jobs=${processed} kev=${catalogs.kev ?? 'skipped'} epss=${catalogs.epss ?? 'skipped'}`);
  };

  if (once) {
    await cycle();
    await closePrisma();
    return;
  }

  console.log(`[enrich] running every ${intervalMs} ms`);
  let stopped = false;
  const timer = setInterval(() => {
    if (!stopped) void cycle().catch((err) => console.error('[enrich] cycle failed:', (err as Error).message));
  }, intervalMs);
  await cycle().catch((err) => console.error('[enrich] cycle failed:', (err as Error).message));

  const shutdown = async () => {
    stopped = true;
    clearInterval(timer);
    await closePrisma();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(async (err) => {
  console.error('[enrich] fatal:', (err as Error).message);
  await closePrisma();
  process.exitCode = 1;
});
