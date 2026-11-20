/**
 * NVD CVE API 2.0 adapter.
 *
 * NVD is structured vulnerability data, not a news feed. This adapter requests only CVEs modified
 * since the last successful fetch (incremental), and maps each CVE into the same raw item shape the
 * RSS path produces. Storage, deduplication and stories therefore work unchanged.
 *
 * The NVD API has a 120-day limit on modification windows; the window is clamped to that.
 */
import { NVD_API_BASE } from '../catalogPolicy';
import type { RawFeedItem } from '../contract';

export const NVD_PAGE_SIZE = 100;
/** NVD answers are larger and slower than news feeds, so they get their own limit. */
export const NVD_TIMEOUT_MS = 90_000;
/** Without an API key NVD allows about 5 requests per 30 s. Pages are paced to stay under that. */
export const NVD_PAGE_DELAY_MS = 6_500;
export const NVD_MAX_WINDOW_DAYS = 120;
/** Pages fetched per run (200 CVEs each). Beyond this the run is truncated and logged. */
export const NVD_MAX_PAGES = 20;
/** Largest number of CVEs one run can store (pages x page size). */
export const NVD_MAX_ITEMS = NVD_MAX_PAGES * NVD_PAGE_SIZE;
const DAY_MS = 24 * 60 * 60 * 1000;
const OVERLAP_MS = 60 * 60 * 1000;
const FIRST_RUN_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/** NVD expects local-time-less timestamps: YYYY-MM-DDTHH:mm:ss.SSS (UTC, no zone suffix). */
export function nvdTimestamp(d: Date): string {
  return d.toISOString().slice(0, 23);
}

export function nvdWindow(since: Date | null, now: Date): { start: Date; end: Date } {
  let start = since ? new Date(since.getTime() - OVERLAP_MS) : new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);
  const earliest = new Date(now.getTime() - NVD_MAX_WINDOW_DAYS * DAY_MS);
  if (start.getTime() < earliest.getTime()) start = earliest;
  return { start, end: now };
}

/**
 * Request headers for NVD. The key comes only from the server environment (NVD_API_KEY) and is
 * never logged or returned. Without it, NVD applies its lower unauthenticated limit.
 */
export function nvdRequestHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const key = env.NVD_API_KEY?.trim();
  return key ? { apiKey: key } : {};
}

/** The request URL for one incremental pull. */
export function nvdRequestUrl(since: Date | null, now: Date, startIndex = 0): string {
  const { start, end } = nvdWindow(since, now);
  const url = new URL(NVD_API_BASE);
  url.searchParams.set('lastModStartDate', nvdTimestamp(start));
  url.searchParams.set('lastModEndDate', nvdTimestamp(end));
  url.searchParams.set('resultsPerPage', String(NVD_PAGE_SIZE));
  if (startIndex > 0) url.searchParams.set('startIndex', String(startIndex));
  return url.toString();
}

interface CvssSummary {
  score: number;
  severity: string;
}

/** Prefers CVSS v3.1, then v2. Returns null when neither is present. */
export function pickCvss(metrics: any): CvssSummary | null {
  const v31 = metrics?.cvssMetricV31?.[0]?.cvssData;
  if (v31 && typeof v31.baseScore === 'number') {
    return { score: v31.baseScore, severity: String(v31.baseSeverity ?? 'UNKNOWN') };
  }
  const v2 = metrics?.cvssMetricV2?.[0];
  if (v2?.cvssData && typeof v2.cvssData.baseScore === 'number') {
    return { score: v2.cvssData.baseScore, severity: String(v2.baseSeverity ?? 'UNKNOWN') };
  }
  return null;
}

function toRawItem(cve: any): RawFeedItem | null {
  if (!cve || typeof cve.id !== 'string' || cve.id.length === 0) return null;
  const description = String((cve.descriptions ?? []).find((d: any) => d?.lang === 'en')?.value ?? '').trim();
  const cvss = pickCvss(cve.metrics);
  const prefix = cvss ? `CVSS ${cvss.score} ${cvss.severity}. ` : '';
  return {
    guid: cve.id,
    link: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cve.id)}`,
    title: description ? `${cve.id}: ${description}` : cve.id,
    contentSnippet: `${prefix}${description}`.trim(),
    creator: typeof cve.sourceIdentifier === 'string' ? cve.sourceIdentifier : undefined,
    isoDate: typeof cve.published === 'string' ? `${cve.published}Z` : undefined,
  };
}

/** Parses one NVD 2.0 response page. Throws a PARSE_ERROR-tagged error on a malformed document. */
export function parseNvdResponse(text: string): { title: string; items: RawFeedItem[]; totalResults: number } {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('NVD response is not valid JSON'), { errorCode: 'PARSE_ERROR' });
  }
  if (!Array.isArray(json?.vulnerabilities)) {
    throw Object.assign(new Error('NVD response has no vulnerabilities array'), { errorCode: 'PARSE_ERROR' });
  }
  const items = json.vulnerabilities.map((v: any) => toRawItem(v?.cve)).filter((x: RawFeedItem | null): x is RawFeedItem => x !== null);
  return { title: 'NVD CVE 2.0', items, totalResults: Number(json.totalResults) || 0 };
}
