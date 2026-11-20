/**
 * Address classification shared by the server SSRF guard and the client fetch paths.
 *
 * Pure TypeScript with no Node or browser APIs, so the same rules run on the server, in the browser
 * and on native builds. Anything that cannot be parsed as an IP address is treated as unsafe.
 *
 * IPv6 addresses that embed an IPv4 address are checked against the embedded address: IPv4-mapped
 * (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16). Teredo
 * (2001::/32) and the NAT64 local-use prefix (64:ff9b:1::/48) are refused outright because their
 * embedded address is obfuscated or not globally routable.
 */

/** True when the text is a dotted-quad IPv4 address with every octet in range. */
export function isIPv4Literal(text: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  return !!m && m.slice(1).every((octet) => Number(octet) <= 255);
}

/** True when the text looks like an IPv6 literal (contains a colon). Use isPrivateAddress to judge it. */
export function isIPv6Literal(text: string): boolean {
  return text.includes(':');
}

/** Parses an IPv4 dotted quad into four octets, or null. */
function parseIPv4(text: string): [number, number, number, number] | null {
  if (!isIPv4Literal(text)) return null;
  const [a, b, c, d] = text.split('.').map(Number);
  return [a, b, c, d];
}

/** Parses an IPv6 address into eight 16-bit groups, or null when it is malformed. */
function parseIPv6(text: string): number[] | null {
  let addr = text;
  // A trailing dotted IPv4 part (for example ::ffff:1.2.3.4) becomes two hex groups.
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (tail) {
    const v4 = parseIPv4(tail[1]);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    addr = addr.slice(0, tail.index) + `${hi}:${lo}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && fill < 1) return null;
  const parts = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...rest];
  if (parts.length !== 8) return null;
  const groups: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

/** Private, loopback, link-local, multicast, documentation or otherwise reserved IPv4 address. */
function isPrivateIPv4(a: number, b: number, c: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||          // 100.64.0.0/10 carrier-grade NAT
    (a === 169 && b === 254) ||                    // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||           // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 0 && c === 2) ||           // 192.0.2.0/24 documentation
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||       // benchmarking
    (a === 198 && b === 51 && c === 100) ||        // 198.51.100.0/24 documentation
    (a === 203 && b === 0 && c === 113) ||         // 203.0.113.0/24 documentation
    a >= 224                                       // multicast and reserved
  );
}

function isPrivateEmbeddedIPv4(hi: number, lo: number): boolean {
  const v4 = [hi >> 8, hi & 255, lo >> 8, lo & 255];
  return isPrivateIPv4(v4[0], v4[1], v4[2]);
}

/**
 * True when the address is private or reserved, or cannot be parsed. Brackets and zone identifiers
 * (for example fe80::1%eth0) are removed before the check.
 */
export function isPrivateAddress(input: string): boolean {
  const text = input.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!text) return true;

  if (isIPv4Literal(text)) {
    const [a, b, c] = parseIPv4(text)!;
    return isPrivateIPv4(a, b, c);
  }
  if (!isIPv6Literal(text)) return true;

  const g = parseIPv6(text);
  if (!g) return true;

  const allZeroTo = (n: number): boolean => g.slice(0, n).every((x) => x === 0);

  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible, deprecated).
  if (allZeroTo(5) && g[5] === 0xffff) return isPrivateEmbeddedIPv4(g[6], g[7]);
  if (allZeroTo(6)) {
    if (g[6] === 0 && g[7] <= 1) return true; // :: and ::1
    return isPrivateEmbeddedIPv4(g[6], g[7]);
  }

  // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 address in the last 32 bits.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPrivateEmbeddedIPv4(g[6], g[7]);
  }
  // NAT64 local-use prefix 64:ff9b:1::/48 is not globally routable.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0x1) return true;

  // 6to4 2002::/16 embeds an IPv4 address in bits 16 to 47.
  if (g[0] === 0x2002) return isPrivateEmbeddedIPv4(g[1], g[2]);

  // Teredo 2001:0000::/32 obfuscates the client address. Refuse the whole prefix.
  if (g[0] === 0x2001 && g[1] === 0) return true;

  // Documentation 2001:db8::/32 and discard-only 100::/64.
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;

  // Unique local fc00::/7, link-local fe80::/10, site-local fec0::/10 and multicast ff00::/8.
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  if ((g[0] & 0xffc0) === 0xfec0) return true;
  if ((g[0] & 0xff00) === 0xff00) return true;

  // Global unicast is 2000::/3. Anything else is unassigned, so refuse it.
  return (g[0] & 0xe000) !== 0x2000;
}
