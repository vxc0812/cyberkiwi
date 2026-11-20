# Ingestion contract (Phase 1, version 1)

This document defines how CyberKiwi fetches, normalizes and stores feed data. It is the contract between the ingestion worker, the database schema (`prisma/schema.prisma`), and the read API that clients will use. Rules are implemented in `server/ingestion/contract.ts` and tested in `tests/ingestion-contract.test.ts`. Changing a rule means bumping `INGESTION_CONTRACT_VERSION` and updating this file.

Clients do not perform feed ingestion. Until the read API below exists, the existing client flow stays unchanged.

## 1. Data model

| Model | Purpose | Key rules |
|---|---|---|
| `Source` | A publisher or curated source | `slug` is unique. Holds category and language defaults. |
| `Feed` | One RSS/Atom endpoint | `url` is unique. Holds fetch state: ETag, Last-Modified, last success and failure, consecutive failures, and fetch interval. |
| `Article` | A normalized item | Identity is `(feedId, externalId)`. Stores `canonicalUrl` for cross-feed matching and `contentHash` for change detection. |
| `Story` | A cluster of articles about one event | Holds the representative article and article count. |
| `StoryArticle` | Story membership | An article belongs to at most one story (`articleId` is unique). |
| `IngestionRun` | One fetch attempt for one feed | Records status, HTTP status, counts, timing, and error code and message. |

Enums: `IngestionStatus` = `RUNNING | SUCCEEDED | PARTIAL | FAILED | SKIPPED`; `IngestionTrigger` = `SCHEDULED | MANUAL`.

## 2. Network rules

- Every outbound request goes through `safeFetchText` in `server/netSafety.ts`. Workers must not create their own HTTP clients.
- Scheme must be `http` or `https`.
- Private, loopback, link-local, multicast, and reserved addresses are refused at DNS-resolution time, for IPv4, IPv6, and IPv4-mapped IPv6.
- Redirects are followed manually, and each hop is validated again.
- Responses are capped at `FEED_MAX_BYTES` (2 MB). Requests time out after `FEED_FETCH_TIMEOUT_MS` (8 s).
- Conditional requests send `If-None-Match` and `If-Modified-Since` from the stored feed state. A `304` is a success.

## 3. Item normalization

Applied per item, in this order. Items that fail are rejected with a reason and never stored.

1. **Title** is required. Markup is stripped, and the result is capped at 300 characters. Empty means `missing_title`.
2. **Link** is required. It must be a valid `http(s)` URL after canonicalization. Otherwise `invalid_link`.
3. **Identity** is `guid:<feed guid>` when the feed provides a GUID, or `link:<canonical URL>` otherwise. Values longer than 512 characters are hashed to `sha256:<hex>`.
4. **Excerpt** is the first non-empty of content snippet, summary, or description. Capped at 500 characters.
5. **Publish date** comes from `isoDate`, then `pubDate`. Invalid dates and dates more than 24 hours in the future become `null`. A missing date never rejects an item.
6. **Image URL** is kept only if it is a valid `http(s)` URL. It is not fetched during ingestion.

**Canonical URL**: lowercase host; no fragment; tracking parameters removed (`utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `ref`, `ref_src`, `igshid`); remaining parameters sorted; default port removed; trailing slash removed except on the root path.

**Content hash**: first 32 hex characters of SHA-256 over the lowercased, whitespace-collapsed title and excerpt. A changed hash on a known identity means the article was updated.

## 4. Batch rules

- At most 200 items per feed. Extra items are dropped, and the batch is marked `truncated`.
- Within a batch, the first occurrence of each `externalId` wins. Later occurrences count as duplicates.

## 5. Feed health and backoff

- A failure (network, SSRF refusal, timeout, non-2xx, oversize, or parse error) increments `consecutiveFailures`, sets `lastFailureAt`, and records `lastError` (max 500 characters).
- A success or `304` sets `consecutiveFailures = 0`, sets `lastSuccessAt`, and clears `lastError`.
- Next attempt delay: the base interval when healthy; otherwise base × 2^failures, capped at 24 hours.

## 6. Run status

| Condition | Status |
|---|---|
| Fetch or parse failed | `FAILED` |
| Fetch and parse succeeded, and some (not all) items were rejected | `PARTIAL` |
| Fetch and parse succeeded and all items were rejected | `PARTIAL` |
| Otherwise (including an empty valid feed) | `SUCCEEDED` |

`SKIPPED` is used when a feed is inactive or not yet due.

## 7. Failure isolation

- Each feed is processed independently. One feed's failure must not stop others.
- Ingestion writes are idempotent. Re-running the same feed upserts on `(feedId, externalId)` and never duplicates articles.
- External enrichment (CVE, KEV, EPSS) is out of scope for ingestion and must never block article writes.

## 8. Read API (implemented, read-only)

Mounted at `/api/v1` by `server/api/readApi.ts`. The public types are in `server/api/types.ts` and are shared with the client. Clients read persisted data only. No endpoint fetches a URL, and POST, PUT and DELETE are not routed.

| Method and path | Returns |
|---|---|
| `GET /api/v1/stories?limit=&cursor=&category=&feedId=&keyword=` | Stories, newest first. Each has its sources, article references, counts, and `matchedArticleCount` |
| `GET /api/v1/stories/:id` | One story with its articles (up to 100) |
| `GET /api/v1/articles?limit=&cursor=&category=&feedId=&keyword=` | Articles, newest first |
| `GET /api/v1/feeds/health` | Counts and per-feed status: `never_fetched`, `ok`, `failing`; consecutive failures; next attempt time; public error code |
| `GET /api/v1/ingestion/runs?feedId=&status=&limit=` | Operator only. 404 unless `ADMIN_TOKEN` is set; 401 without `Authorization: Bearer <token>` |

**Envelope.** Every success response has `success: true`. Every error has `success: false` and `error: { code, message }`. Clients branch on `code`. Codes: `invalid_limit`, `invalid_cursor`, `invalid_id`, `invalid_feed_id`, `invalid_filter`, `invalid_status`, `not_found`, `unauthorized`, `store_unavailable`.

**Paging.** Keyset pagination on `(sortAt desc, id desc)`. `limit` is 1 to 50, default 20. List responses carry `nextCursor` (null on the last page) and `hasMore`. Cursors are opaque base64url tokens. A cursor that does not decode returns 400 `invalid_cursor`. A well-formed cursor is never "expired": new articles do not invalidate it, and the next page continues after the same position.

**Filters.** `category` is a lowercase slug (1 to 40 characters). `feedId` is a UUID. `keyword` is at most 100 characters and 10 terms; terms are separated by `|` (OR), matched case-insensitively as plain text in titles and excerpts. Regex is not interpreted. Filters combine with AND. A story matches when any member article matches; with filters, the story's `articles` contains only matching articles and `matchedArticleCount` reports how many match. An unknown category is an empty result, not an error.

**Operator token.** Read only from the `Authorization: Bearer` header. A token in the query string is ignored. The comparison is constant time over SHA-256 digests, and the token is never logged.

**Public health view.** Only the stable error code is returned (for example `HTTP_404`). Raw messages stay internal.

## 9. Stories

Articles about the same URL across feeds form one story. The rule is implemented in `server/repositories/stories.ts` and runs after every successful article write.

- `Story.clusterKey` is the canonical URL of the story's articles, and it is unique.
- Each article joins at most one story (`StoryArticle.articleId` is unique).
- The story title and summary follow the newest article. `articleCount`, `firstPublishedAt` and `lastPublishedAt` are recomputed from the current links.
- Creation is atomic (`INSERT ... ON CONFLICT DO NOTHING`), so concurrent workers cannot create duplicate stories.
- Semantic clustering of different URLs about the same event is not implemented. It is a later phase.

Ordering keys: `Article.sortAt` and `Story.sortAt` are the publish date, falling back to the first-seen time.

## 10. Out of scope for this version

- Semantic clustering across different URLs (later Phase 1 follow-up).
- Authentication for end users (Phase 2). The operator token is a temporary guard, and the read API is not yet protected for public deployment.
- Full-text article bodies. Only excerpts are stored.
- Client-side feed editing. It stays local until authenticated write endpoints exist.
