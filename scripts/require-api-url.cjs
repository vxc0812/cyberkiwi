#!/usr/bin/env node
/**
 * Release guard for the CyberKiwi API base URL.
 *
 * Vite environment variables are compiled into the bundle, so the URL must be set when the
 * release is built (CI secret or local environment). Electron, Tauri and Capacitor packages all
 * ship the bundle built here, so each package gets the URL it was built with.
 *
 *   VITE_CYBERKIWI_API_BASE_URL=https://api.example.com  node scripts/require-api-url.cjs
 *
 * Exits 1 when the variable is missing, empty, not an absolute https URL, or points at a
 * query string or fragment. Local development may use http://127.0.0.1 with ALLOW_HTTP_API=1.
 */
const raw = process.env.VITE_CYBERKIWI_API_BASE_URL;

function fail(message) {
  console.error(`[release-check] ${message}`);
  process.exit(1);
}

if (raw === undefined || raw.trim() === '') {
  fail('VITE_CYBERKIWI_API_BASE_URL is not set. Release builds must target a CyberKiwi API.');
}

let url;
try {
  url = new URL(raw.trim());
} catch {
  fail('VITE_CYBERKIWI_API_BASE_URL is not a valid absolute URL.');
}

const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
if (url.protocol !== 'https:' && !(process.env.ALLOW_HTTP_API === '1' && isLoopback && url.protocol === 'http:')) {
  fail('VITE_CYBERKIWI_API_BASE_URL must use https (http is allowed only for loopback with ALLOW_HTTP_API=1).');
}
if (url.search || url.hash) {
  fail('VITE_CYBERKIWI_API_BASE_URL must not contain a query string or fragment.');
}

console.log(`[release-check] API base URL ok: ${url.origin}`);
