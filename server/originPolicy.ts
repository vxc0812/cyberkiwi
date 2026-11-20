/**
 * Which browser origins may call the API in development.
 *
 * Development used to answer every origin with a wildcard, so any web page could call the AI and fetch
 * routes (report F19). Only local origins are allowed now: loopback pages, the Vite dev server and the
 * native app shells, whose origins are capacitor:// or the local https://localhost used on Android.
 */
export function isLocalDevOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === 'capacitor:' || url.protocol === 'ionic:') return true;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
