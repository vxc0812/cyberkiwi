/**
 * Allowlist for URLs the app may open outside itself: browser links, system browser, share sheets.
 *
 * Only plain https: and http: URLs pass. The rule matches electron/externalUrl.cjs, and the shared
 * vectors in tests/external-url.test.ts check both copies.
 */
const MAX_URL_LENGTH = 2048;
// Control characters, spaces and DEL. A legitimate absolute URL never contains them unencoded.
const FORBIDDEN_CHARS = /[\u0000- \u007f]/;

/** Returns the normalized URL when `value` is an allowed external URL, otherwise null. Never throws. */
export function normalizeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  if (FORBIDDEN_CHARS.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname) return null;
  if (url.username || url.password) return null;
  return url.href;
}

export function isAllowedExternalUrl(value: unknown): boolean {
  return normalizeExternalUrl(value) !== null;
}
