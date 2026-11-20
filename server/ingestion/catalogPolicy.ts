/**
 * Trusted, server-side feed policy.
 *
 * Size limits are code-owned. They are keyed by the catalog feed URL, never by anything a
 * client sends, and no override may exceed HARD_FEED_MAX_BYTES. The 2 MB default protects
 * memory for arbitrary feeds. The article-page limit (3 MB) lives elsewhere and is unchanged.
 */

const MB = 1024 * 1024;

export const DEFAULT_FEED_MAX_BYTES = 2 * MB;
export const HARD_FEED_MAX_BYTES = 10 * MB;

export interface FeedPolicy {
  label: string;
  maxBytes: number;
  /** True when the limit comes from an override rather than the default. */
  overridden: boolean;
}

interface Override {
  url: string;
  label: string;
  maxBytes: number;
}

const OVERRIDES: readonly Override[] = [
  {
    url: 'https://www.cisa.gov/uscert/ics/advisories/advisories.xml',
    label: 'CISA ICS',
    maxBytes: 8 * MB,
  },
];

// Fail at load time, not at fetch time, if an override breaks the hard ceiling.
for (const o of OVERRIDES) {
  if (!Number.isInteger(o.maxBytes) || o.maxBytes <= DEFAULT_FEED_MAX_BYTES || o.maxBytes > HARD_FEED_MAX_BYTES) {
    throw new Error(`Invalid feed size override for ${o.label}: ${o.maxBytes} bytes`);
  }
}

const DEFAULT_POLICY: FeedPolicy = {
  label: 'default',
  maxBytes: DEFAULT_FEED_MAX_BYTES,
  overridden: false,
};

export function feedPolicyFor(feedUrl: string): FeedPolicy {
  const override = OVERRIDES.find((o) => o.url === feedUrl);
  if (!override) return DEFAULT_POLICY;
  return { label: override.label, maxBytes: override.maxBytes, overridden: true };
}

/** Message shown when a feed exceeds its limit. It names the limit that applied. */
export function feedTooLargeMessage(policy: FeedPolicy): string {
  const mb = policy.maxBytes / MB;
  return policy.overridden
    ? `Feed document exceeded configured ${mb} MB limit for ${policy.label}`
    : `Feed document exceeded ${mb} MB limit`;
}

// ---------------------------------------------------------------------------
// Source adapters and catalog decisions (code-owned, never set by a request)
// ---------------------------------------------------------------------------

/** NVD CVE API 2.0. Used through a dedicated adapter (incremental, not RSS). */
export const NVD_API_BASE = 'https://services.nvd.nist.gov/rest/json/cves/2.0';

export type FeedAdapter = 'rss' | 'nvd';

export function adapterFor(feedUrl: string): FeedAdapter {
  return feedUrl.startsWith(NVD_API_BASE) ? 'nvd' : 'rss';
}

/**
 * Feeds that are kept in the catalog for transparency but deliberately inactive. Each has a
 * reason that the catalog check reports. Removing an entry does not re-enable anything: a
 * feed is active again only when it is back in the catalog and not listed here.
 */
const DISABLED: ReadonlyArray<{ url: string; reason: string }> = [
  {
    url: 'https://cvetrends.com/rss',
    reason: 'Returns HTTP 404. No verified, stable replacement has been identified.',
  },
  {
    url: 'https://cve.mitre.org/cve/rss.xml',
    reason: 'Redirects and returns malformed XML. Use an official CVE data adapter (later phase).',
  },
  {
    url: 'https://msrc.microsoft.com/blog/feed/',
    reason: 'Returns malformed XML. Replace with the MSRC CVRF/API source.',
  },
  {
    url: 'https://support.apple.com/en-us/HT201222/rss',
    reason: 'Returns a page that is not an RSS feed. Replace with an official Apple source.',
  },
  {
    url: 'https://source.android.com/security/bulletin/rss.xml',
    reason: 'Returns HTTP 404. Official source has moved; find the current advisory feed.',
  },
  {
    url: 'https://tools.cisco.com/security/center/erdd.xml',
    reason: 'Returns HTTP 404. Find the current Cisco PSIRT feed.',
  },
  {
    url: 'https://access.redhat.com/blogs/766093/feed',
    reason: 'Returns malformed XML. Replace with the Red Hat security data API.',
  },
  {
    url: 'https://www.mandiant.com/resources/blog/rss',
    reason: 'Returns malformed XML. Find the current Mandiant feed.',
  },
  {
    url: 'https://www.secureworks.com/research/feed',
    reason: 'Returns malformed XML. Find the current Secureworks feed.',
  },
  {
    url: 'https://securityintelligence.com/feed/',
    reason: 'TLS certificate chain is not trusted by the server. Verify the source before re-enabling.',
  },
  {
    url: 'https://blog.talosintelligence.com/rss.xml',
    reason: 'Returns HTTP 404. Find the current Talos feed.',
  },
  {
    url: 'https://packetstormsecurity.com/files/rss/',
    reason: 'Returns malformed XML. Find the current Packet Storm feed.',
  },
  {
    url: 'https://any.run/blog/feed/',
    reason: 'Returns HTTP 404. Find the current ANY.RUN feed.',
  },
  {
    url: 'https://www.hybrid-analysis.com/feed',
    reason: 'Returns a non-XML document. Find the current Hybrid Analysis feed.',
  },
  {
    url: 'https://www.scmagazine.com/feed/',
    reason: 'Returns HTTP 403 to automated clients. Not usable without permission.',
  },
  {
    url: 'https://www.appsecnews.com/feed/',
    reason: 'Returns HTTP 404. Replace with a working application security source.',
  },
  {
    url: 'https://devsecops.org/feed/',
    reason: 'Returns HTTP 404. Replace with a working DevSecOps source.',
  },
  {
    url: 'https://www.privacyguides.org/feed.xml',
    reason: 'Returns HTTP 404. Replace with a working privacy source.',
  },
  {
    url: 'https://www.enisa.europa.eu/rss.xml',
    reason: 'Returns HTTP 404. Find the current ENISA feed.',
  },
  {
    url: 'https://cert.europa.eu/rss.xml',
    reason: 'Returns HTTP 404. Find the current CERT-EU feed.',
  },
  {
    url: 'https://www.hackerone.com/blog/rss',
    reason: 'Returns HTTP 404. Find the current HackerOne Hacktivity feed.',
  },
  {
    url: 'https://www.bugcrowd.com/blog/feed/',
    reason: 'Returns malformed XML. Find the current Bugcrowd feed.',
  },
  {
    url: 'https://blog.yeswehack.com/feed/',
    reason: 'Returns malformed XML. Find the current YesWeHack feed.',
  },
  {
    url: 'https://darknetdiaries.com/feed/',
    reason: 'Returns HTTP 404. Podcast source; find the current feed URL.',
  },
  {
    url: 'https://risky.biz/rss/',
    reason: 'Returns HTTP 404. Podcast source; find the current feed URL.',
  },
  {
    url: 'https://feeds.twit.tv/sn_audio.xml',
    reason: 'Returns HTTP 404. Podcast source; find the current feed URL.',
  },
  {
    url: 'https://www.fortiguard.com/rss/feed',
    reason: 'Returns HTTP 404. Find the current FortiGuard feed.',
  },
];

export function disabledReasonFor(feedUrl: string): string | null {
  return DISABLED.find((d) => d.url === feedUrl)?.reason ?? null;
}

/** Read-only view of the trusted overrides, for tests and operator tooling. */
export function listFeedOverrides(): ReadonlyArray<{ url: string; label: string; maxBytes: number }> {
  return OVERRIDES.map((o) => ({ ...o }));
}
