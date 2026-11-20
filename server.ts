import express, { Request, Response as ExpressResponse, NextFunction } from 'express';
import path from 'path';
import { parseFeedBounded, stripTags } from './server/feedParser';
import { BYOK_HEADER, configuredAiToken, isWellFormedGeminiKey, requireAiCaller, type AiCaller } from './server/aiGuard';
import { asRoute, handleCurate, handleSummarize, handleTranslate, handleValidateKey } from './server/aiRoutes';
import { attachSession, principalOf } from './server/auth/middleware';
import { requireSafeOrigin } from './server/auth/csrf';
import { createAuthRouter } from './server/auth/routes';
import { createAdminRouter } from './server/auth/adminRoutes';
import { createDevicesRouter } from './server/devices/routes';
import { createCorsMiddleware, parseAllowedOrigins } from './server/http/cors';
import { createEnrichmentStatsRouter } from './server/enrichment/stats';
import { appLinkConfigFromEnv, appLinkRoutes } from './server/http/appLinks';
import {
  BoundedCache,
  FEED_FETCH_CONCURRENCY,
  MAX_ARTICLE_CACHE_ENTRIES,
  MAX_FEED_CACHE_ENTRIES,
  coalesce,
  mapWithConcurrency,
  selectFeedUrls,
} from './server/resourceLimits';
import { GoogleGenAI } from '@google/genai';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { sanitizeArticleHtml } from './server/sanitize';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { URL } from 'url';
import { createHash } from 'crypto';
import { createReadApi } from './server/api/readApi';
import { getPrisma } from './server/db/client';
import { validateOutboundUrl, safeFetchText } from './server/netSafety';

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
// Loopback unless HOST says otherwise. Binding every interface is never the default (report F15, F19).
const HOST = process.env.HOST?.trim() || '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
// Exact origins allowed to make credentialed requests in production (comma-separated). Native apps add
// their own origins, for example capacitor://localhost on iOS and https://localhost on Android.
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGIN || (IS_PRODUCTION ? 'https://cyberkiwi.app' : ''));
// Startup assertion: a production server that listens beyond loopback must name its origin explicitly.
if (IS_PRODUCTION && !LOOPBACK_HOSTS.has(HOST) && !process.env.ALLOWED_ORIGIN) {
  throw new Error('Refusing to start in production: a non-loopback HOST requires an explicit ALLOWED_ORIGIN');
}
const MAX_BODY_SIZE = '100kb';
const RSS_FETCH_TIMEOUT_MS = 8000;
const ARTICLE_FETCH_TIMEOUT_MS = 12000;
const MAX_RSS_BYTES = 2 * 1024 * 1024;        // 2 MB per feed document
const MAX_ARTICLE_BYTES = 3 * 1024 * 1024;    // 3 MB per article page
const MAX_ITEM_HTML_CHARS = 64 * 1024;        // per-item content cap
const MAX_ITEMS_PER_FEED = 200;

// Trusted reverse-proxy hops. 0 (default) means the socket address is used
// for rate limiting; only set this when exactly that many proxies sit in front.
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS || 0);



// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================


/** Cap for individual feed item HTML/text to protect memory. */
function capItemHtml(value: string): string {
  return value.length > MAX_ITEM_HTML_CHARS ? value.slice(0, MAX_ITEM_HTML_CHARS) : value;
}

/** Generate content hash for deduplication */
function contentHash(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex').substring(0, 16);
}

/** Simple heuristic sentiment analyzer */
function calculateSentiment(text: string): 'positive' | 'negative' | 'neutral' {
  const lower = text.toLowerCase();
  const posWords = ['sucesso', 'cresce', 'lucro', 'recorde', 'avanço', 'alta', 'inovação', 'vitória', 'ganho', 'lançado', 'revolução', 'supera', 'bom'];
  const negWords = ['queda', 'crise', 'alerta', 'morte', 'risco', 'prejuízo', 'falha', 'ataque', 'crime', 'violência', 'guerra', 'ameaça', 'multa', 'processo'];

  let posCount = 0;
  let negCount = 0;
  posWords.forEach(w => { if (lower.includes(w)) posCount++; });
  negWords.forEach(w => { if (lower.includes(w)) negCount++; });

  if (posCount > negCount) return 'positive';
  if (negCount > posCount) return 'negative';
  return 'neutral';
}

// ============================================================================
// EXPRESS APP SETUP
// ============================================================================

const app = express();

// Trust X-Forwarded-For only when explicitly deployed behind N trusted proxies.
// Otherwise clients could spoof their IP and bypass rate limiting.
app.set('trust proxy', TRUST_PROXY_HOPS > 0 ? TRUST_PROXY_HOPS : false);

// Body parser with size limit
app.use(express.json({ limit: MAX_BODY_SIZE }));
app.use(express.urlencoded({ extended: true, limit: MAX_BODY_SIZE }));

// Security headers
app.use((req: Request, res: ExpressResponse, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// CORS: exact allowlisted origins with credentials in production; local origins in development.
app.use(createCorsMiddleware({ production: IS_PRODUCTION, allowedOrigins: ALLOWED_ORIGINS }));

// Accounts: resolve the caller from a bearer token or the session cookie (never rejects anonymous
// requests), then refuse cross-origin and cookie-based state changes that lack the CSRF header.
const db = getPrisma();
app.use('/api/', attachSession(db));
app.use('/api/', requireSafeOrigin({ allowedOrigins: ALLOWED_ORIGINS }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: IS_PRODUCTION ? 60 : 300, // requests per window
  message: { success: false, error: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip || 'unknown'),
  skip: (req) => req.path === '/health', // Don't rate limit health checks
});
app.use('/api/', apiLimiter);

// Stricter rate limit for AI endpoints
const aiLimiter = rateLimit({
  keyGenerator: (req) => ipKeyGenerator(req.ip || 'unknown'),
  windowMs: 60 * 1000,
  max: IS_PRODUCTION ? 10 : 30,
  message: { success: false, error: 'AI rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/gemini/', aiLimiter);

// ============================================================================
// RSS PARSER CONFIGURATION
// ============================================================================

// Bounded RSS/Atom parsing (server/feedParser.ts). The parser is linear in input size, so it
// cannot stall the event loop on attacker-controlled feed text (report finding F2).

// In-memory caches (will be replaced by DB in Phase 1)
interface CacheEntry { timestamp: number; data: any[]; }
const CACHE_TTL_MS = 60 * 1000;
// Bounded: least recently used entries are evicted, so client-chosen keys cannot grow memory (F6, F7).
const feedCache = new BoundedCache<CacheEntry>(MAX_FEED_CACHE_ENTRIES, CACHE_TTL_MS);

interface ArticleCacheEntry { timestamp: number; data: any; }
const ARTICLE_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const articleExtractCache = new BoundedCache<ArticleCacheEntry>(MAX_ARTICLE_CACHE_ENTRIES, ARTICLE_CACHE_TTL_MS);

// ============================================================================
// HTML ENTITY DECODING & IMAGE EXTRACTION
// ============================================================================

function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  // &amp; must be decoded last so "&amp;lt;" becomes "&lt;" and not "<"
  return str
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;|&#x0*27;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** Largest amount of description text searched for images (characters). */
const IMG_SCAN_MAX_CHARS = 64 * 1024;

function extractImageUrl(item: any, baseUrl?: string): string | undefined {
  let src: string | undefined = undefined;

  // 1. enclosure
  if (item.enclosure) {
    const arr = Array.isArray(item.enclosure) ? item.enclosure : [item.enclosure];
    for (const enc of arr) {
      const url = enc.url || enc.$?.url || enc.href;
      const type = enc.type || enc.$?.type || '';
      if (url && (type.includes('image') || /\.(jpg|jpeg|gif|png|webp|bmp|svg|avif)/i.test(url) || !type)) {
        src = url; break;
      }
    }
  }

  // 2. mediaContent
  if (!src && item.mediaContent?.length > 0) {
    const img = item.mediaContent.find((m: any) => m.$?.url || m.url || m.href);
    if (img) src = img.$?.url || img.url || img.href;
  }

  // 3. mediaThumbnail
  if (!src && item.mediaThumbnail?.length > 0) {
    const img = item.mediaThumbnail.find((m: any) => m.$?.url || m.url || m.href);
    if (img) src = img.$?.url || img.url || img.href;
  }

  // 4. mediaGroup
  if (!src && item.mediaGroup) {
    const group = item.mediaGroup;
    const content = group['media:content'] || group.mediaContent;
    if (content) {
      const arr = Array.isArray(content) ? content : [content];
      const img = arr.find((m: any) => m.$?.url || m.url || m.href);
      if (img) src = img.$?.url || img.url || img.href;
    }
    if (!src) {
      const thumbnail = group['media:thumbnail'] || group.mediaThumbnail;
      if (thumbnail) {
        const arr = Array.isArray(thumbnail) ? thumbnail : [thumbnail];
        const img = arr.find((m: any) => m.$?.url || m.url || m.href);
        if (img) src = img.$?.url || img.url || img.href;
      }
    }
  }

  // 5. item.image, thumbnail, thumb, ogImage, twitterImage
  if (!src && item.image) src = typeof item.image === 'string' ? item.image : (item.image.url || item.image.$?.url || item.image.href);
  if (!src && item.thumbnail) src = typeof item.thumbnail === 'string' ? item.thumbnail : (item.thumbnail.url || item.thumbnail.$?.url || item.thumbnail.href);
  if (!src && item.thumb) src = typeof item.thumb === 'string' ? item.thumb : (item.thumb.url || item.thumb.$?.url);
  if (!src && (item.ogImage || item.twitterImage)) src = item.ogImage || item.twitterImage;

  // 6. Regex scan HTML content
  if (!src) {
    // Bound the scan: a long description with many unclosed "<img" tags makes unbounded [^>]+ scans
    // quadratic and blocks the event loop. Only the first IMG_SCAN_MAX_CHARS are searched, and each
    // attribute search is limited to 500 characters.
    const rawHtml = `${item.contentEncoded || ''} ${item.content || ''} ${item.description || ''} ${item.summary || ''}`.slice(0, IMG_SCAN_MAX_CHARS);
    const decoded = decodeHtmlEntities(rawHtml);
    const imgRegexes = [
      /<img[^>]{1,500}?(?:data-src|data-original|data-lazy-src|data-hi-res-src)=["']([^"'\s>]+)["']/i,
      /<img[^>]{1,500}?src=["']([^"'\s>]+)["']/i,
      /<img[^>]{1,500}?srcset=["']([^"'\s,>]+)/i,
      /<source[^>]{1,500}?srcset=["']([^"'\s,>]+)/i,
      /url\(["']?(https?:\/\/[^'"\)\s]+\.(?:jpg|jpeg|png|webp|avif|gif))["']?\)/i
    ];
    for (const rx of imgRegexes) {
      const match = decoded.match(rx);
      if (match?.[1]) {
        const candidate = match[1].trim();
        if (!candidate.startsWith('data:image') && !candidate.includes('1x1') && !candidate.includes('pixel') && !candidate.includes('tracker')) {
          src = candidate; break;
        }
      }
    }
  }

  if (!src) return undefined;
  src = decodeHtmlEntities(src).trim();

  // Filter tracking pixels
  if (src.includes('pixel') || src.includes('tracker') || src.includes('1x1') || src.includes('statcounter') || src.includes('doubleclick')) {
    return undefined;
  }

  // Handle protocol-relative and relative URLs
  if (src.startsWith('//')) src = `https:${src}`;
  if (src.startsWith('/') && baseUrl) {
    try { src = new URL(src, baseUrl).toString(); } catch {}
  }

  return src;
}

// ============================================================================
// GEMINI CLIENT (SERVER-SIDE ONLY)
// ============================================================================

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY not configured on server');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'CyberKiwi/1.0' } },
  });
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

// Health check (no rate limit)
app.get('/health', (_req: Request, res: ExpressResponse) => {
  // instance lets the desktop shell confirm this is its own server (report F50). Null outside the desktop app.
  res.json({ status: 'ok', service: 'cyberkiwi-api', timestamp: Date.now(), instance: process.env.APP_INSTANCE_ID ?? null });
});

// 1. Fetch & parse RSS Feeds
// Feed list. POST carries the URLs in the body so subscription URLs (which can contain tokens) are not
// recorded in request logs. GET stays for existing clients (report F49).
const handleRssRequest = async (req: Request, res: ExpressResponse) => {
  try {
    const urlsParam = req.method === 'POST' ? req.body?.urls : req.query.urls;
    if (urlsParam !== undefined && typeof urlsParam !== 'string') {
      return res.status(400).json({ success: false, error: 'urls must be a comma-separated string' });
    }
    if (!urlsParam) return res.json({ success: true, items: [] });

    // Duplicates are removed and the list is capped before any fetch starts (F5).
    const urls = selectFeedUrls(urlsParam);
    const allItems: any[] = [];

    // At most FEED_FETCH_CONCURRENCY feeds are fetched at once for this request.
    await mapWithConcurrency(urls, FEED_FETCH_CONCURRENCY, async (url) => {
        // Validate each URL
        const validation = validateOutboundUrl(url);
        if (!validation.valid) {
          console.warn(`[RSS] Invalid URL rejected: ${url} (${validation.error})`);
          return;
        }

        const cached = feedCache.get(url);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
          allItems.push(...cached.data);
          return;
        }

        try {
          // Requests for the same feed share one in-flight fetch instead of each starting their own.
          const response = await coalesce(url, () => safeFetchText(url, {
            headers: {
              'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml, text/html;q=0.9, */*;q=0.8',
            },
            maxBytes: MAX_RSS_BYTES,
            timeoutMs: RSS_FETCH_TIMEOUT_MS,
          }));
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const cleanXml = response.text.trim().replace(/^\uFEFF/, '');
          const feed: any = parseFeedBounded(cleanXml);

          const sourceTitle = feed.title || new URL(url).hostname.replace('www.', '');
          const parsedItems = (feed.items || []).slice(0, MAX_ITEMS_PER_FEED).map((item: any, idx: number) => {
            // Linear tag stripping. A regex here would be quadratic on crafted "<" runs.
            const rawSnippet = stripTags(item.contentSnippet || item.summary || item.content || '');
            const cleanSnippet = rawSnippet.slice(0, 300) + (rawSnippet.length > 300 ? '...' : '');
            const imageUrl = extractImageUrl(item, feed.link || url);
            const pubTime = item.isoDate ? new Date(item.isoDate).getTime() : (item.pubDate ? new Date(item.pubDate).getTime() : Date.now());

            const baseGuid = (typeof item.guid === 'string' && item.guid.trim()) ? item.guid.trim() : (item.link || url);
            const itemId = `${baseGuid}#${idx}-${pubTime}`;

            return {
              id: itemId,
              title: (item.title || 'Sem título').trim(),
              link: item.link || url,
              contentSnippet: cleanSnippet,
              contentHtml: capItemHtml(item.contentEncoded || item.content || item.description || ''),
              pubDate: item.pubDate || new Date(pubTime).toLocaleString('pt-BR'),
              timestamp: isNaN(pubTime) ? Date.now() : pubTime,
              sourceId: url,
              sourceName: sourceTitle,
              sourceCategory: 'general',
              author: item.creator || item.author || sourceTitle,
              imageUrl,
              sentiment: calculateSentiment((item.title || '') + ' ' + cleanSnippet),
              contentHash: contentHash(item.title + ' ' + rawSnippet),
            };
          });

          feedCache.set(url, { timestamp: Date.now(), data: parsedItems });
          allItems.push(...parsedItems);
        } catch (err: any) {
          console.warn(`[RSS Parser] Error fetching ${url}:`, err?.message);
        }
    });

    allItems.sort((a, b) => b.timestamp - a.timestamp);
    res.json({ success: true, items: allItems });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
};
// Open without sign-in by design (pre-beta): live fetch of the caller's own feeds keeps account-free
// desktop use working. Stored stories and articles (/api/v1) require sign-in. See README "Access model".
app.get('/api/rss', handleRssRequest);
app.post('/api/rss', handleRssRequest);

// 2. Validate Custom Feed URL
app.post('/api/rss/validate', async (req: Request, res: ExpressResponse) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'URL is required' });

    const validation = validateOutboundUrl(url);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    // Same validated, size-capped path as /api/rss (no direct parseURL)
    const response = await safeFetchText(url, {
      headers: {
        'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml, */*;q=0.8',
      },
      maxBytes: MAX_RSS_BYTES,
      timeoutMs: RSS_FETCH_TIMEOUT_MS,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const feed: any = parseFeedBounded(response.text.trim().replace(/^﻿/, ''));
    res.json({
      success: true,
      title: feed.title || new URL(url).hostname,
      description: feed.description || '',
      itemCount: feed.items ? feed.items.length : 0,
    });
  } catch (err: any) {
    // Generic message only. Detailed network errors can reveal how the server resolves hosts (F48).
    console.warn('[RSS validate] feed rejected:', err?.message);
    res.status(400).json({ success: false, error: 'Feed could not be loaded' });
  }
});

// 3. Extract Full Article (Reader Mode)
// Open without sign-in by design (pre-beta), like /api/rss: reader mode for account-free desktop use.
app.get('/api/article/extract', async (req: Request, res: ExpressResponse) => {
  try {
    const targetUrl = req.query.url as string;
    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
      return res.status(400).json({ success: false, error: 'Valid URL required' });
    }

    const validation = validateOutboundUrl(targetUrl);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    // Check cache
    const cached = articleExtractCache.get(targetUrl);
    if (cached && Date.now() - cached.timestamp < ARTICLE_CACHE_TTL_MS) {
      return res.json({ success: true, article: cached.data });
    }

    // Fetch with safeFetch (SSRF protected)
    const response = await safeFetchText(targetUrl, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      maxBytes: MAX_ARTICLE_BYTES,
      timeoutMs: ARTICLE_FETCH_TIMEOUT_MS,
    });

    if (!response.ok) {
      return res.status(422).json({ success: false, error: `Remote server responded with status ${response.status}` });
    }

    const html = response.text;
    if (!html || html.length < 100) {
      return res.status(422).json({ success: false, error: 'Page too short for extraction' });
    }

    const { document, window } = parseHTML(html);

    // Lead image from metadata
    let leadImageUrl: string | undefined;
    const ogImg = document.querySelector('meta[property="og:image"], meta[name="twitter:image"], meta[name="image"]');
    if (ogImg) {
      const src = ogImg.getAttribute('content');
      if (src && (src.startsWith('http') || src.startsWith('//'))) {
        leadImageUrl = src.startsWith('//') ? `https:${src}` : src;
      }
    }

    // Readability extraction
    const reader = new Readability(document as any, { charThreshold: 80 });
    const parsed = reader.parse();

    if (!parsed || !parsed.textContent || parsed.textContent.trim().length < 80) {
      return res.status(422).json({ success: false, error: 'Could not extract article content' });
    }

    // Sanitize HTML. Throws (fails closed) when no working DOM is available to DOMPurify.
    const sanitizedHtml = sanitizeArticleHtml(parsed.content);

    // Fix relative URLs
    const { document: cleanDoc } = parseHTML(`<div>${sanitizedHtml}</div>`);
    for (const img of cleanDoc.querySelectorAll('img')) {
      const src = img.getAttribute('src');
      if (src && !src.startsWith('data:') && !src.startsWith('http://') && !src.startsWith('https://')) {
        try { img.setAttribute('src', new URL(src, targetUrl).toString()); } catch {}
      }
      img.setAttribute('loading', 'lazy');
    }
    for (const a of cleanDoc.querySelectorAll('a')) {
      const href = a.getAttribute('href');
      if (href && !href.startsWith('http') && !href.startsWith('#')) {
        try { a.setAttribute('href', new URL(href, targetUrl).toString()); } catch {}
      }
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }

    const finalHtml = cleanDoc.querySelector('div')?.innerHTML || sanitizedHtml;
    const textContent = parsed.textContent.trim();
    const wordCount = textContent ? textContent.split(/\s+/).length : 0;
    const readingTimeMinutes = Math.max(1, Math.ceil(wordCount / 200));

    const extractedArticle = {
      title: parsed.title || document.querySelector('title')?.textContent || 'Article',
      byline: parsed.byline || undefined,
      siteName: parsed.siteName || new URL(targetUrl).hostname.replace('www.', ''),
      excerpt: parsed.excerpt || textContent.slice(0, 200) + '...',
      contentHtml: finalHtml,
      textContent,
      length: textContent.length,
      wordCount,
      readingTimeMinutes,
      leadImageUrl: leadImageUrl || undefined,
      url: targetUrl,
      extractedAt: Date.now(),
      contentHash: contentHash(textContent),
    };

    articleExtractCache.set(targetUrl, { timestamp: Date.now(), data: extractedArticle });
    res.json({ success: true, article: extractedArticle });
  } catch (err: any) {
    console.warn('[Article Extractor Error]:', err?.message);
    res.status(500).json({ success: false, error: err?.message || 'Failed to extract article' });
  }
});

// AI routes (Gemini). Each one needs an access token and counts against the daily quota. Inputs are
// bounded and feed or user text is delimited as untrusted data (server/aiGuard.ts, server/aiRoutes.ts).
// AI availability only. Never returns the key itself.
app.get('/api/gemini/status', (_req: Request, res: ExpressResponse) => {
  const key = process.env.GEMINI_API_KEY;
  res.json({
    success: true,
    configured: Boolean(key && key !== 'MY_GEMINI_API_KEY'),
    accessRequired: true,
    enabled: configuredAiToken() !== null,
  });
});

const platformGenerate = (args: any) => getGeminiClient().models.generateContent(args);

/** A model call made with the caller's own key (BYOK). The key is used for this request only. */
function generateWithKey(userKey: string) {
  return (args: any) =>
    new GoogleGenAI({ apiKey: userKey, httpOptions: { headers: { 'User-Agent': 'CyberKiwi/1.0' } } }).models.generateContent(args);
}

/** The model client for this request: the caller's key for BYOK, the platform key otherwise. */
function generatorFor(res: ExpressResponse) {
  const caller = res.locals.aiCaller as AiCaller | undefined;
  return caller?.kind === 'byok' ? generateWithKey(caller.userKey) : platformGenerate;
}

const aiGuard = requireAiCaller({
  db,
  platformKeyConfigured: () => Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'),
});

app.post('/api/gemini/summarize', aiGuard, asRoute(handleSummarize, generatorFor, 'summarize'));
app.post('/api/gemini/curate', aiGuard, asRoute(handleCurate, generatorFor, 'curate block'));
app.post('/api/gemini/translate', aiGuard, asRoute(handleTranslate, generatorFor, 'translate'));

// Key check for BYOK. Rate-limited per signed-in user, or per IP when anonymous. No spend on the platform key.
const validateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: IS_PRODUCTION ? 6 : 30,
  keyGenerator: (req, res) => {
    const principal = principalOf(res as unknown as ExpressResponse);
    return principal ? `user:${principal.userId}` : ipKeyGenerator(req.ip || 'unknown');
  },
  message: { success: false, error: 'Too many key checks, please wait a minute' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.post('/api/gemini/validate-key', validateLimiter, async (req: Request, res: ExpressResponse) => {
  res.set('Cache-Control', 'no-store');
  const key = req.get(BYOK_HEADER);
  delete req.headers[BYOK_HEADER];
  if (key === undefined || !isWellFormedGeminiKey(key)) {
    return res.status(400).json({ success: false, error: 'AI key format is not valid' });
  }
  const out = await handleValidateKey(generateWithKey(key));
  return res.status(out.status).json(out.json);
});

// Accounts (invite-only). Login and registration are rate-limited per IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PRODUCTION ? 20 : 200,
  keyGenerator: (req) => ipKeyGenerator(req.ip || 'unknown'),
  message: { success: false, error: 'Too many attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth', createAuthRouter(db, { secureCookies: IS_PRODUCTION }));
app.use('/api/admin', createAdminRouter(db));
app.use('/api/devices', createDevicesRouter(db));

// iOS and Android app-association files. 404 until APPLE_TEAM_ID and ANDROID_CERT_SHA256 are configured.
app.use(appLinkRoutes(appLinkConfigFromEnv()));

// Operator enrichment stats (admin session). Mounted before the public read API.
app.use('/api/v1/enrichment', createEnrichmentStatsRouter(db));

// Read-only persisted-content API (Phase 1). Clients never trigger fetches through it.
app.use('/api/v1', createReadApi(db, { adminToken: process.env.ADMIN_TOKEN || undefined }));

// JSON error handler: no stack traces or HTML to clients (e.g. oversize bodies).
app.use((err: any, _req: Request, res: ExpressResponse, _next: NextFunction) => {
  const status = Number(err?.status || err?.statusCode) || 500;
  if (status >= 500) console.error('[CyberKiwi API] Unhandled error:', err);
  const message =
    status === 413 ? 'Payload too large' :
    status === 400 ? 'Malformed request' :
    status >= 500 ? 'Internal server error' : 'Request failed';
  if (res.headersSent) return;
  res.status(status).json({ success: false, error: message });
});

// ============================================================================
// VITE / STATIC FILE SERVING
// ============================================================================

async function startServer() {
  if (!IS_PRODUCTION) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const candidatePaths = [
      process.env.DIST_PATH,
      __dirname,
      path.join(process.cwd(), 'dist'),
      path.join(__dirname, '..', 'dist'),
    ].filter(Boolean) as string[];

    const distPath = candidatePaths.find((p) => {
      try { return require('fs').existsSync(path.join(p, 'index.html')); } catch { return false; }
    }) || candidatePaths[0] || path.join(process.cwd(), 'dist');

    console.log(`[CyberKiwi API] Serving static files from: ${distPath}`);
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`[CyberKiwi API] Server running on http://${HOST}:${PORT} (${IS_PRODUCTION ? 'production' : 'development'})`);
  });
}

startServer();