/**
 * Allowlist for URLs the app may hand to the operating system's browser.
 *
 * Only plain https: and http: URLs pass. Everything else is refused, including javascript:, data:,
 * file:, custom app schemes and URLs with embedded credentials. Electron's shell.openExternal can
 * launch any registered protocol handler, so untrusted URLs must never reach it directly.
 *
 * The same rule lives in src/utils/externalUrl.ts for browser and native paths. The shared test
 * vectors in tests/external-url.test.ts keep the two copies in step.
 */
const MAX_URL_LENGTH = 2048;
const FORBIDDEN_CHARS = /[\u0000- \u007f]/;

/**
 * Returns the normalized URL string when `value` is an allowed external URL, otherwise null.
 * Never throws.
 */
function normalizeExternalUrl(value) {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  if (FORBIDDEN_CHARS.test(value)) return null;
  let url;
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

function isAllowedExternalUrl(value) {
  return normalizeExternalUrl(value) !== null;
}

module.exports = { normalizeExternalUrl, isAllowedExternalUrl, MAX_URL_LENGTH };
