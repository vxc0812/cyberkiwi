import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import { URL } from 'url';

// Shared outbound-network safety. Every server-side fetch (feeds, validation,
// article extraction and the Phase 1 ingestion worker) MUST use safeFetchText.

// Address classification lives in src/utils/networkAddress.ts so the browser and server share one rule.
import { isPrivateAddress } from '../src/utils/networkAddress';
export { isPrivateAddress };

const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'CyberKiwi/0.2 (+https://cyberkiwi.app)';
// Allowed schemes for outbound requests
const ALLOWED_SCHEMES = ['http:', 'https:'];

/**
 * DNS lookup hook used for every outbound connection. It resolves the host,
 * rejects the whole lookup if ANY returned address is private, and returns the
 * validated address(es) to the socket. Because validation and connection use the
 * same lookup result, a rebinding DNS server cannot swap in a private IP later.
 */
function safeLookup(hostname: string, options: any, callback: any): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return callback(err);
    if (!addrs || addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
      return callback(new Error('Blocked: host resolves to a private or reserved address'));
    }
    if (options && options.all) return callback(null, addrs);
    return callback(null, addrs[0].address, addrs[0].family);
  });
}

/** Validate URL against SSRF and format requirements */
export function validateOutboundUrl(urlString: string): { valid: boolean; error?: string; url?: URL } {
  if (!urlString || typeof urlString !== 'string') {
    return { valid: false, error: 'URL is required' };
  }
  if (urlString.length > MAX_URL_LENGTH) {
    return { valid: false, error: `URL exceeds maximum length of ${MAX_URL_LENGTH}` };
  }

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Credentials in the URL would be stored and logged in plain text, so they are refused (report F46).
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Credentials in URLs are not allowed' };
  }

  // Scheme check
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return { valid: false, error: `Scheme ${parsed.protocol} not allowed` };
  }

  // Hostname validation (string-level; DNS-level checks happen in safeLookup)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) {
    return { valid: false, error: 'Missing hostname' };
  }

  const lowerHost = hostname.toLowerCase();
  if (lowerHost === 'localhost' || lowerHost.endsWith('.localhost') || lowerHost.endsWith('.local') || lowerHost.endsWith('.internal')) {
    return { valid: false, error: 'Local hostnames not allowed' };
  }

  // IP literals are checked directly; names are checked after DNS resolution
  if (net.isIP(hostname) && isPrivateAddress(hostname)) {
    return { valid: false, error: 'Private IP addresses not allowed' };
  }

  return { valid: true, url: parsed };
}

export interface SafeTextResponse { ok: boolean; status: number; text: string; etag?: string; lastModified?: string; }

interface SafeFetchOptions {
  headers?: Record<string, string>;
  maxBytes: number;
  timeoutMs: number;
}

/**
 * Outbound GET with: scheme/host validation, DNS-pinned SSRF lookup, manual
 * redirect validation (each hop re-checked), a hard byte cap and a timeout.
 * Returns decoded text. Used for RSS, validation and article extraction.
 */
export function safeFetchText(urlString: string, opts: SafeFetchOptions, redirects = 0, deadlineAt?: number): Promise<SafeTextResponse> {
  const validation = validateOutboundUrl(urlString);
  if (!validation.valid || !validation.url) {
    return Promise.reject(new Error(validation.error || 'Invalid URL'));
  }
  const target = validation.url;
  const lib = target.protocol === 'https:' ? https : http;
  // One deadline covers the whole fetch, including every redirect hop. The socket idle timeout alone
  // lets a slow-drip response keep the request open indefinitely (report finding F16).
  const deadline = deadlineAt ?? Date.now() + opts.timeoutMs;

  return new Promise<SafeTextResponse>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      settle();
    };
    const ok = (value: SafeTextResponse): void => finish(() => resolve(value));
    const fail = (err: Error): void => finish(() => reject(err));

    const remaining = deadline - Date.now();
    if (remaining <= 0) return fail(new Error('Request deadline exceeded'));

    const req = lib.request(
      target,
      {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
        lookup: safeLookup as any,
        timeout: remaining,
      },
      (res) => {
        const status = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (redirects >= MAX_REDIRECTS) return fail(new Error(`Too many redirects (max ${MAX_REDIRECTS})`));
          let nextUrl: string;
          try {
            nextUrl = new URL(res.headers.location, target).toString();
          } catch {
            return fail(new Error('Invalid redirect URL'));
          }
          safeFetchText(nextUrl, opts, redirects + 1, deadline).then(ok, fail);
          return;
        }

        const declared = Number(res.headers['content-length'] || 0);
        if (declared > opts.maxBytes) {
          res.destroy();
          return fail(new Error('Response exceeds size limit'));
        }

        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > opts.maxBytes) {
            fail(new Error('Response exceeds size limit'));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', fail);
        res.on('end', () => {
          ok({
            ok: status >= 200 && status < 300,
            status,
            text: Buffer.concat(chunks).toString("utf8"),
            etag: typeof res.headers.etag === "string" ? res.headers.etag : undefined,
            lastModified: typeof res.headers["last-modified"] === "string" ? res.headers["last-modified"] : undefined,
          });
        });
      }
    );

    // Hard deadline. Destroying the request ends the socket even when bytes keep arriving.
    timer = setTimeout(() => {
      fail(new Error('Request deadline exceeded'));
      req.destroy();
    }, remaining);
    req.on('timeout', () => {
      fail(new Error('Request timed out'));
      req.destroy();
    });
    req.on('error', fail);
    req.end();
  });
}
