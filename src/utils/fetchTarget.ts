/**
 * Gate for URLs the client fetches itself: the browser fallback, the native (CapacitorHttp) feed and
 * article fetches. These requests run on the user's device, so they must not reach the device's own
 * network or loopback interfaces. Hostnames that resolve to private addresses cannot be checked here,
 * because DNS happens on the device. A public-looking name that resolves to a private address is a
 * residual risk on native builds, since the device resolves it and the server's DNS guard does not run.
 */
import { normalizeExternalUrl } from './externalUrl';
import { isIPv4Literal, isIPv6Literal, isPrivateAddress } from './networkAddress';

/** Returns the normalized URL when it may be fetched from the client, otherwise null. Never throws. */
export function normalizeFetchTarget(value: unknown): string | null {
  const url = normalizeExternalUrl(value);
  if (!url) return null;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return null;
  }
  if ((isIPv4Literal(host) || isIPv6Literal(host)) && isPrivateAddress(host)) return null;
  return url;
}
