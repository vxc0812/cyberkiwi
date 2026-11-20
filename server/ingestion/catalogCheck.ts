/**
 * Catalog validation report. Read-only: it fetches and parses each catalog source through the same
 * shared path the worker uses, and writes nothing to the database.
 *
 *   npm run catalog:check
 *
 * For every catalog entry it reports: whether it is intentionally disabled (and why), the HTTP
 * status, the parse result (item count or error), and the last successful fetch recorded in the
 * database. Exits 1 when any enabled source fails, so it can gate a catalog change.
 */
import './loadEnv';
import { CYBERSEC_DEFAULT_FEEDS } from '../../src/data/cybersecFeeds';
import { closePrisma, getPrisma } from '../db/client';
import { disabledReasonFor, adapterFor } from './catalogPolicy';
import { fetchFeedDocument, parseFeedDocument } from './fetchFeed';

export type CheckStatus = 'ok' | 'failed' | 'disabled';

export interface CatalogCheckRow {
  id: string;
  url: string;
  adapter: 'rss' | 'nvd';
  status: CheckStatus;
  httpStatus: number | null;
  parse: string;
  items: number | null;
  lastSuccessAt: string | null;
  note: string | null;
}

function errorDetail(err: unknown): { httpStatus: number | null; message: string } {
  const e = err as { httpStatus?: number; message?: string };
  return {
    httpStatus: typeof e?.httpStatus === 'number' ? e.httpStatus : null,
    message: String(e?.message ?? err).slice(0, 160),
  };
}

export async function checkCatalog(): Promise<CatalogCheckRow[]> {
  const db = getPrisma();
  const rows: CatalogCheckRow[] = [];
  const now = new Date();

  for (const feed of CYBERSEC_DEFAULT_FEEDS) {
    const adapter = adapterFor(feed.url);
    const reason = disabledReasonFor(feed.url);
    const stored = await db.feed
      .findUnique({ where: { url: feed.url }, select: { lastSuccessAt: true } })
      .catch(() => null);
    const lastSuccessAt = stored?.lastSuccessAt ? stored.lastSuccessAt.toISOString() : null;

    if (reason) {
      rows.push({ id: feed.id, url: feed.url, adapter, status: 'disabled', httpStatus: null, parse: 'not checked', items: null, lastSuccessAt, note: reason });
      continue;
    }

    try {
      const fetched = await fetchFeedDocument(feed.url, { since: stored?.lastSuccessAt ?? null, now });
      if (fetched.kind === 'not_modified') {
        rows.push({ id: feed.id, url: feed.url, adapter, status: 'ok', httpStatus: 304, parse: 'not modified', items: null, lastSuccessAt, note: null });
        continue;
      }
      const parsed = await parseFeedDocument(fetched.body, feed.url);
      rows.push({ id: feed.id, url: feed.url, adapter, status: 'ok', httpStatus: fetched.httpStatus, parse: 'ok', items: parsed.items.length, lastSuccessAt, note: null });
    } catch (err) {
      const detail = errorDetail(err);
      const parseFailed = (err as { errorCode?: string })?.errorCode === 'PARSE_ERROR' || /Unexpected close tag|Non-whitespace|Invalid XML|not valid JSON|no vulnerabilities/i.test(detail.message);
      rows.push({
        id: feed.id,
        url: feed.url,
        adapter,
        status: 'failed',
        httpStatus: detail.httpStatus,
        parse: parseFailed ? 'failed' : 'not reached',
        items: null,
        lastSuccessAt,
        note: detail.message,
      });
    }
  }
  return rows;
}

export function formatReport(rows: CatalogCheckRow[]): string {
  const summary = { ok: 0, failed: 0, disabled: 0 };
  for (const r of rows) summary[r.status]++;
  const lines = rows.map((r) => {
    const http = r.httpStatus === null ? '-' : String(r.httpStatus);
    const items = r.items === null ? '-' : String(r.items);
    const note = r.note ? ` | ${r.note}` : '';
    return `${r.status.padEnd(8)} ${r.id.padEnd(16)} http=${http.padEnd(4)} parse=${r.parse.padEnd(11)} items=${items.padEnd(4)} last_ok=${r.lastSuccessAt ?? 'never'}${note}`;
  });
  return [...lines, '', `ok=${summary.ok} failed=${summary.failed} disabled=${summary.disabled} total=${rows.length}`].join('\n');
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('server/ingestion/catalogCheck.ts')) {
  checkCatalog()
    .then(async (rows) => {
      console.log(formatReport(rows));
      await closePrisma();
      process.exitCode = rows.some((r) => r.status === 'failed') ? 1 : 0;
    })
    .catch(async (err) => {
      console.error('[catalog:check] fatal:', (err as Error).message);
      await closePrisma();
      process.exitCode = 1;
    });
}
