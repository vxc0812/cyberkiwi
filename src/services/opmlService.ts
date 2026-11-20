import { RssFeed, FeedCategory } from '../types';

/**
 * Escapes characters for safe inclusion in XML attributes and elements.
 */
export function escapeXml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Unescapes standard XML entities.
 */
export function unescapeXml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Maps arbitrary category strings to supported CyberKiwi categories.
 */
export function normalizeCategory(categoryStr?: string | null): RssFeed['category'] {
  if (!categoryStr) return 'custom';
  const c = categoryStr.toLowerCase().trim();

  if (/tech|tecnol|geek|dev|coding|gadget|software|hardware|comput/i.test(c)) return 'tech';
  if (/\b(?:ia|ai)\b|intelig[eê]ncia artificial|machine learning|deep learning/i.test(c)) return 'ai';
  if (/brasil|brazil|nacional|pol[ií]tica nacional/i.test(c)) return 'brazil';
  if (/world|mundo|internacional|globo|global|geopol[ií]t/i.test(c)) return 'world';
  if (/finan|econ|market|mercado|moeda|invest|crypto|cripto|dinheiro/i.test(c)) return 'finance';
  if (/sport|esport|futebol|soccer|basquete|nba|f1|corrida/i.test(c)) return 'sports';
  if (/cinema|filme|movie|music|m[úu]sica|game|jogos|entreten|pop|s[eé]rie/i.test(c)) return 'entertainment';

  return 'custom';
}

/**
 * Returns a fitting emoji icon based on feed category.
 */
export function getCategoryIcon(cat: FeedCategory): string {
  switch (cat) {
    // Legacy categories
    case 'tech': return '💻';
    case 'ai': return '🤖';
    case 'brazil': return '🇧🇷';
    case 'world': return '🌍';
    case 'finance': return '📈';
    case 'sports': return '⚽';
    case 'entertainment': return '🎬';
    // Cybersec categories
    case 'vulnerabilities': return '🔴';
    case 'vendor-advisories': return '🪟';
    case 'threat-intel': return '🕵️';
    case 'exploits': return '💣';
    case 'malware': return '🦠';
    case 'news': return '📰';
    case 'cloud': return '☁️';
    case 'iot': return '📱';
    case 'appsec': return '🛠️';
    case 'devsecops': return '⚙️';
    case 'privacy': return '🕵️‍♀️';
    case 'crypto': return '🔐';
    case 'cert': return '🇺🇸';
    case 'bugbounty': return '🎁';
    case 'podcasts': return '🎧';
    default: return '🔗';
  }
}

/**
 * Returns user-friendly category folder names for OPML export.
 */
const CATEGORY_NAMES: Record<FeedCategory, string> = {
  // Legacy categories
  tech: 'Technology',
  ai: 'Artificial Intelligence',
  brazil: 'Brazil News',
  world: 'World News',
  finance: 'Finance & Markets',
  sports: 'Sports',
  entertainment: 'Entertainment & Gaming',
  custom: 'Custom Feeds',
  // Cybersec categories
  vulnerabilities: 'Vulnerabilities & CVEs',
  'vendor-advisories': 'Vendor Advisories',
  'threat-intel': 'Threat Intelligence',
  exploits: 'Exploits & PoCs',
  malware: 'Malware Analysis',
  news: 'Security News',
  cloud: 'Cloud Security',
  iot: 'IoT Security',
  appsec: 'Application Security',
  devsecops: 'DevSecOps',
  privacy: 'Privacy',
  crypto: 'Cryptography',
  cert: 'CERT/CSIRT Alerts',
  bugbounty: 'Bug Bounty & VDP',
  podcasts: 'Security Podcasts',
};

/**
 * Exports a list of RSS feeds to standard OPML 2.0 XML format.
 */
export function exportFeedsToOpml(feeds: RssFeed[], title = 'CyberKiwi Subscriptions'): string {
  const dateStr = new Date().toUTCString();

  // Group feeds by category
  const grouped = new Map<RssFeed['category'], RssFeed[]>();
  for (const feed of feeds) {
    const cat = feed.category || 'custom';
    if (!grouped.has(cat)) {
      grouped.set(cat, []);
    }
    grouped.get(cat)!.push(feed);
  }

  let bodyXml = '';

  for (const [cat, catFeeds] of grouped.entries()) {
    const folderTitle = CATEGORY_NAMES[cat] || cat;
    bodyXml += `    <outline text="${escapeXml(folderTitle)}" title="${escapeXml(folderTitle)}">\n`;

    for (const feed of catFeeds) {
      const feedTitle = escapeXml(feed.title || 'Untitled Feed');
      const xmlUrl = escapeXml(feed.url);
      let htmlUrl = '';
      try {
        const parsed = new URL(feed.url);
        htmlUrl = escapeXml(`${parsed.protocol}//${parsed.hostname}`);
      } catch {
        htmlUrl = '';
      }

      bodyXml += `      <outline type="rss" text="${feedTitle}" title="${feedTitle}" xmlUrl="${xmlUrl}"`;
      if (htmlUrl) {
        bodyXml += ` htmlUrl="${htmlUrl}"`;
      }
      bodyXml += ` category="${escapeXml(cat)}" />\n`;
    }

    bodyXml += '    </outline>\n';
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${escapeXml(title)}</title>
    <dateCreated>${dateStr}</dateCreated>
    <docs>http://opml.org/spec2.html</docs>
  </head>
  <body>
${bodyXml}  </body>
</opml>`;
}

export interface OpmlParseResult {
  feeds: RssFeed[];
  totalParsed: number;
  categoriesFound: string[];
}

/**
 * Extracts attribute values from an XML tag string defensively.
 */
function getTagAttribute(tagStr: string, attrName: string): string | null {
  const rx = new RegExp(`(?:\\s|^)${attrName}\\s*=\\s*["']([^"']*)["']`, 'i');
  const match = tagStr.match(rx);
  return match ? unescapeXml(match[1].trim()) : null;
}

/**
 * Parses OPML XML text and returns an array of valid RssFeed objects.
 * Handles nested folders, flat lists, and varied attribute names (xmlUrl, xmlurl, url).
 * Works both with browser DOMParser and fallback regex parser (Node.js environments).
 */
export function parseOpml(xmlText: string): OpmlParseResult {
  if (!xmlText || typeof xmlText !== 'string') {
    return { feeds: [], totalParsed: 0, categoriesFound: [] };
  }

  // Attempt DOMParser if available (Browser, Electron, WebView)
  if (typeof DOMParser !== 'undefined') {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');
      const parserErrors = doc.querySelectorAll('parsererror');

      if (parserErrors.length === 0) {
        return parseOpmlWithDom(doc);
      }
    } catch {
      // Fallback to regex parser below
    }
  }

  // Fallback regex-based OPML parser for Node.js / non-DOM environments
  return parseOpmlWithRegex(xmlText);
}

/**
 * DOM-based parser for Browser/WebView
 */
function parseOpmlWithDom(doc: Document): OpmlParseResult {
  const feeds: RssFeed[] = [];
  const categoriesSet = new Set<string>();
  const seenUrls = new Set<string>();

  const outlines = Array.from(doc.querySelectorAll('outline'));

  for (let idx = 0; idx < outlines.length; idx++) {
    const el = outlines[idx];
    const xmlUrl = el.getAttribute('xmlUrl') || el.getAttribute('xmlurl') || el.getAttribute('url');

    // Only process outlines that have an RSS/Atom URL (leaves)
    if (!xmlUrl || !xmlUrl.trim().startsWith('http')) {
      continue;
    }

    const cleanUrl = xmlUrl.trim();
    if (seenUrls.has(cleanUrl.toLowerCase())) {
      continue;
    }
    seenUrls.add(cleanUrl.toLowerCase());

    const title = el.getAttribute('title') || el.getAttribute('text') || 'Feed RSS';

    // Check parent outline for category folder name
    let categoryName = el.getAttribute('category') || '';
    const parent = el.parentElement;
    if (!categoryName && parent && parent.tagName.toLowerCase() === 'outline') {
      categoryName = parent.getAttribute('text') || parent.getAttribute('title') || '';
    }

    const category = normalizeCategory(categoryName || title);
    if (categoryName) categoriesSet.add(categoryName);

    feeds.push({
      id: `custom_opml_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 5)}`,
      title: title.trim(),
      url: cleanUrl,
      category,
      icon: getCategoryIcon(category),
      active: true,
      status: 'ok',
    });
  }

  return {
    feeds,
    totalParsed: feeds.length,
    categoriesFound: Array.from(categoriesSet),
  };
}

/**
 * Robust regex-based OPML parser for Node.js tests and environments without DOMParser
 */
/** Folders nested deeper than this are read as plain outlines. Bounds memory on crafted input (F31, F38). */
const MAX_OUTLINE_DEPTH = 32;

/**
 * Linear pass over <outline> tags. Each tag is found by a pattern with no nested repetition, openers are
 * paired with closers using a stack, and a folder's inner text is cut from the source. Unlike a lazy
 * "...</outline>" pattern, an unclosed tag never makes the scan run to the end of the input for each tag.
 */
function outlineElements(xml: string): { attrs: string; innerContent?: string }[] {
  const tokenRe = /<(\/?)outline\b([^>]*)>/gi;
  const tokens: { closing: boolean; attrs: string; start: number; end: number; selfClosing: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(xml)) !== null) {
    tokens.push({
      closing: m[1] === '/',
      attrs: m[2],
      start: m.index,
      end: m.index + m[0].length,
      selfClosing: m[2].endsWith('/'),
    });
  }

  const openStack: number[] = [];
  const closerOf = new Map<number, number>();
  tokens.forEach((t, i) => {
    if (t.closing) {
      const open = openStack.pop();
      if (open !== undefined) closerOf.set(open, i);
    } else if (!t.selfClosing && openStack.length < MAX_OUTLINE_DEPTH) {
      openStack.push(i);
    }
  });

  const out: { attrs: string; innerContent?: string }[] = [];
  tokens.forEach((t, i) => {
    if (t.closing) return;
    const attrs = t.selfClosing ? t.attrs.slice(0, -1) : t.attrs;
    const closer = closerOf.get(i);
    out.push({ attrs, innerContent: closer !== undefined ? xml.slice(t.end, tokens[closer].start) : undefined });
  });
  return out;
}

function parseOpmlWithRegex(xmlText: string): OpmlParseResult {
  const feeds: RssFeed[] = [];
  const categoriesSet = new Set<string>();
  const seenUrls = new Set<string>();
  let idx = 0;

  // Search outlines with folder hierarchy
  for (const el of outlineElements(xmlText)) {
    const attrs = el.attrs;
    const innerContent = el.innerContent;

    const xmlUrl = getTagAttribute(attrs, 'xmlUrl') || getTagAttribute(attrs, 'xmlurl') || getTagAttribute(attrs, 'url');

    if (xmlUrl && xmlUrl.startsWith('http')) {
      // Direct outline feed
      const cleanUrl = xmlUrl.trim();
      if (!seenUrls.has(cleanUrl.toLowerCase())) {
        seenUrls.add(cleanUrl.toLowerCase());
        const title = getTagAttribute(attrs, 'title') || getTagAttribute(attrs, 'text') || 'Feed RSS';
        const categoryAttr = getTagAttribute(attrs, 'category');
        const category = normalizeCategory(categoryAttr || title);
        if (categoryAttr) categoriesSet.add(categoryAttr);

        feeds.push({
          id: `custom_opml_${Date.now()}_${idx++}_${Math.random().toString(36).substr(2, 5)}`,
          title: title.trim(),
          url: cleanUrl,
          category,
          icon: getCategoryIcon(category),
          active: true,
          status: 'ok',
        });
      }
    } else if (innerContent) {
      // Folder outline: examine inner outlines
      const folderTitle = getTagAttribute(attrs, 'text') || getTagAttribute(attrs, 'title') || '';
      if (folderTitle) categoriesSet.add(folderTitle);

      const innerOutlineRegex = /<outline\b([^>]*)\/?>/gi;
      let innerMatch: RegExpExecArray | null;

      while ((innerMatch = innerOutlineRegex.exec(innerContent)) !== null) {
        const innerAttrs = innerMatch[1];
        const innerXmlUrl = getTagAttribute(innerAttrs, 'xmlUrl') || getTagAttribute(innerAttrs, 'xmlurl') || getTagAttribute(innerAttrs, 'url');

        if (innerXmlUrl && innerXmlUrl.startsWith('http')) {
          const cleanInnerUrl = innerXmlUrl.trim();
          if (!seenUrls.has(cleanInnerUrl.toLowerCase())) {
            seenUrls.add(cleanInnerUrl.toLowerCase());
            const title = getTagAttribute(innerAttrs, 'title') || getTagAttribute(innerAttrs, 'text') || 'Feed RSS';
            const categoryAttr = getTagAttribute(innerAttrs, 'category') || folderTitle;
            const category = normalizeCategory(categoryAttr || title);

            feeds.push({
              id: `custom_opml_${Date.now()}_${idx++}_${Math.random().toString(36).substr(2, 5)}`,
              title: title.trim(),
              url: cleanInnerUrl,
              category,
              icon: getCategoryIcon(category),
              active: true,
              status: 'ok',
            });
          }
        }
      }
    }
  }

  return {
    feeds,
    totalParsed: feeds.length,
    categoriesFound: Array.from(categoriesSet),
  };
}
