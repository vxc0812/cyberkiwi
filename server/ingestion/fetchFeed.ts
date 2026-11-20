/**
 * Feed fetch and parse for the ingestion worker.
 *
 * All network access goes through safeFetchText in server/netSafety.ts. Do not
 * add a second fetch implementation here: the SSRF, redirect and size protections
 * live only in that shared path.
 */
import { parseFeedBounded } from '../feedParser';
import { safeFetchText } from '../netSafety';
import type { RawFeedItem } from './contract';
import { adapterFor, feedPolicyFor, feedTooLargeMessage } from './catalogPolicy';
import { NVD_MAX_PAGES, NVD_PAGE_DELAY_MS, NVD_PAGE_SIZE, NVD_TIMEOUT_MS, nvdRequestHeaders, nvdRequestUrl, parseNvdResponse } from './adapters/nvd';

export const FEED_FETCH_TIMEOUT_MS = 8000;
export { DEFAULT_FEED_MAX_BYTES as FEED_MAX_BYTES } from './catalogPolicy';

export type FeedFetchResult =
  | { kind: 'not_modified'; httpStatus: 304 }
  | { kind: 'ok'; httpStatus: number; body: string; etag: string | null; lastModified: string | null };

export interface ConditionalHeaders {
  etag?: string | null;
  lastModified?: string | null;
}

/** Conditional GET. Throws on SSRF violations, timeouts, oversize bodies and non-2xx responses. */
export async function fetchFeedXml(
  url: string,
  conditional: ConditionalHeaders = {},
  timeoutMs: number = FEED_FETCH_TIMEOUT_MS,
  extraHeaders: Record<string, string> = {},
): Promise<FeedFetchResult> {
  const headers: Record<string, string> = {
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
    ...extraHeaders,
  };
  if (conditional.etag) headers['If-None-Match'] = conditional.etag;
  if (conditional.lastModified) headers['If-Modified-Since'] = conditional.lastModified;

  // The size limit comes only from the trusted catalog policy, never from the request.
  const policy = feedPolicyFor(url);
  let response;
  try {
    response = await safeFetchText(url, {
      headers,
      maxBytes: policy.maxBytes,
      timeoutMs,
    });
  } catch (err) {
    if (/size limit/i.test((err as Error).message)) {
      throw Object.assign(new Error(feedTooLargeMessage(policy)), { errorCode: 'TOO_LARGE' });
    }
    throw err;
  }

  if (response.status === 304) return { kind: 'not_modified', httpStatus: 304 };
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { httpStatus: response.status });
  return {
    kind: 'ok',
    httpStatus: response.status,
    body: response.text,
    etag: response.etag ?? null,
    lastModified: response.lastModified ?? null,
  };
}

/**
 * Parses RSS or Atom XML into raw items with the bounded parser (server/feedParser.ts). Throws
 * FeedParseError (errorCode PARSE_ERROR) on malformed or entity-declaring documents.
 */
export async function parseFeedXml(xml: string): Promise<{ title: string | null; items: RawFeedItem[] }> {
  const feed = parseFeedBounded(xml.trim().replace(/^﻿/, ''));
  const items: RawFeedItem[] = feed.items.map((item) => ({
    guid: item.guid,
    link: item.link,
    title: item.title,
    contentSnippet: item.contentSnippet,
    summary: item.summary,
    description: item.content ?? item.description,
    creator: item.creator ?? item.author,
    isoDate: item.isoDate,
    pubDate: item.pubDate,
    imageUrl: imageFrom(item),
  }));
  return { title: feed.title ?? null, items };
}

function imageFrom(item: any): string | undefined {
  const media = Array.isArray(item.mediaContent) ? item.mediaContent : [];
  const thumb = Array.isArray(item.mediaThumbnail) ? item.mediaThumbnail : [];
  const enclosure = Array.isArray(item.enclosure) ? item.enclosure : item.enclosure ? [item.enclosure] : [];
  const candidates = [...media, ...thumb, ...enclosure]
    .map((m: any) => m?.$?.url ?? m?.url)
    .filter((u: unknown): u is string => typeof u === 'string');
  return candidates[0];
}

export interface DocumentConditional extends ConditionalHeaders {
  /** Last successful fetch. NVD uses it as the start of the modification window. */
  since?: Date | null;
  now?: Date;
}

/**
 * Fetches a source document with the adapter chosen from the trusted catalog URL.
 * RSS and Atom use conditional GET. NVD uses an incremental modification window instead.
 */
export async function fetchFeedDocument(url: string, conditional: DocumentConditional = {}): Promise<FeedFetchResult> {
  if (adapterFor(url) === 'nvd') {
    return fetchNvdWindow(conditional.since ?? null, conditional.now ?? new Date());
  }
  return fetchFeedXml(url, conditional);
}

/** Parses a fetched document with the adapter chosen from the trusted catalog URL. */
export async function parseFeedDocument(body: string, url: string): Promise<{ title: string | null; items: RawFeedItem[] }> {
  if (adapterFor(url) === 'nvd') {
    const parsed = parseNvdResponse(body);
    return { title: parsed.title, items: parsed.items };
  }
  return parseFeedXml(body);
}

/**
 * Pulls every page of the NVD modification window (bounded by NVD_MAX_PAGES) and returns one
 * combined document, so the parser sees the whole window rather than the first page only.
 */
async function fetchNvdWindow(since: Date | null, now: Date): Promise<FeedFetchResult> {
  const vulnerabilities: unknown[] = [];
  let startIndex = 0;
  let total = Number.POSITIVE_INFINITY;
  for (let page = 0; page < NVD_MAX_PAGES && startIndex < total; page++) {
    if (page > 0) await new Promise((resolve) => setTimeout(resolve, NVD_PAGE_DELAY_MS));
    const res = await fetchFeedXml(nvdRequestUrl(since, now, startIndex), {}, NVD_TIMEOUT_MS, nvdRequestHeaders());
    if (res.kind !== 'ok') return res;
    let json: any;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw Object.assign(new Error('NVD response is not valid JSON'), { errorCode: 'PARSE_ERROR' });
    }
    total = Number(json.totalResults) || 0;
    const batch: unknown[] = Array.isArray(json.vulnerabilities) ? json.vulnerabilities : [];
    vulnerabilities.push(...batch);
    if (batch.length === 0) break;
    startIndex += batch.length;
  }
  if (startIndex < total) {
    console.warn(`[nvd] window truncated: ${startIndex} of ${total} CVEs fetched (page limit ${NVD_MAX_PAGES} x ${NVD_PAGE_SIZE})`);
  }
  return { kind: 'ok', httpStatus: 200, body: JSON.stringify({ totalResults: total, vulnerabilities }), etag: null, lastModified: null };
}
