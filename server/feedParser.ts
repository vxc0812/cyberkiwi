/**
 * Bounded RSS and Atom parser.
 *
 * Replaces rss-parser, whose HTML-stripping step used regular expressions that run in quadratic
 * time on attacker-controlled descriptions and block the Node event loop (report finding F2).
 *
 * The parser is a streaming SAX pass (saxes). Every cost is bounded:
 *  - Work is linear in the input length. The caller caps the input size (safeFetchText).
 *  - DOCTYPE entity declarations are rejected, so entity-expansion attacks cannot apply.
 *  - Items, the length of each field, and element nesting are capped.
 *  - Tag stripping for snippets is one character pass with no regular expressions.
 *
 * The output uses the field names rss-parser produced, so consumers do not change.
 */
import { normalizeAudioUrl } from '../src/utils/fetchTarget';
import { SaxesParser } from 'saxes';

export interface FeedLimits {
  /** Items kept per feed. Once reached, parsing stops and the items read so far are returned. */
  maxItems: number;
  /** Characters kept for short fields such as title, link and guid. */
  maxShortChars: number;
  /** Characters kept for body fields such as description, content and summary. */
  maxBodyChars: number;
  /** Deepest element nesting accepted. Deeper input is rejected. */
  maxDepth: number;
}

export const DEFAULT_FEED_LIMITS: FeedLimits = {
  maxItems: 500,
  maxShortChars: 2_000,
  maxBodyChars: 32_000,
  maxDepth: 64,
};

export interface MediaAttrs {
  $: Record<string, string>;
  url?: string;
  type?: string;
  href?: string;
}

export interface ParsedItem {
  title?: string;
  link?: string;
  guid?: string;
  description?: string;
  content?: string;
  contentEncoded?: string;
  summary?: string;
  contentSnippet?: string;
  pubDate?: string;
  isoDate?: string;
  creator?: string;
  author?: string;
  enclosure: MediaAttrs[];
  mediaContent: MediaAttrs[];
  mediaThumbnail: MediaAttrs[];
  mediaGroup?: { 'media:content': MediaAttrs[]; 'media:thumbnail': MediaAttrs[] };
  image?: string;
  thumbnail?: string;
  thumb?: string;
  ogImage?: string;
  twitterImage?: string;
}

/** Finds a playable enclosure without treating it as artwork. */
export function podcastAudioFrom(item: ParsedItem): string | undefined {
  for (const enclosure of item.enclosure) {
    if (!enclosure.type?.toLowerCase().startsWith('audio/')) continue;
    const url = normalizeAudioUrl(enclosure.url ?? enclosure.href);
    if (url) return url;
  }
  return undefined;
}

export interface ParsedFeed {
  title?: string;
  link?: string;
  description?: string;
  items: ParsedItem[];
}

export class FeedParseError extends Error {
  readonly errorCode = 'PARSE_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'FeedParseError';
  }
}

/** Named HTML entities that appear in feed text but are not defined in XML. */
const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ', copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
  middot: '·', euro: '€', pound: '£', deg: '°', laquo: '«', raquo: '»',
  quot: '"', apos: "'", amp: '&', lt: '<', gt: '>',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û',
  atilde: 'ã', otilde: 'õ', ntilde: 'ñ', ccedil: 'ç', uuml: 'ü',
  ouml: 'ö', auml: 'ä', szlig: 'ß', Aacute: 'Á', Eacute: 'É',
  Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ccedil: 'Ç', Ntilde: 'Ñ',
  Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä', iexcl: '¡', iquest: '¿',
};

/** Decodes named HTML entities left in text by the XML parser. One linear pass. */
export function decodeNamedEntities(text: string): string {
  return text.replace(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, name: string) => HTML_ENTITIES[name] ?? whole);
}

/**
 * Removes markup from text in one linear pass. Characters inside a tag are dropped, including an
 * unclosed tag at the end of the input. Named entities are decoded and whitespace is collapsed.
 */
export function stripTags(input: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      parts.push(input.slice(i));
      break;
    }
    parts.push(input.slice(i, lt), ' ');
    const gt = input.indexOf('>', lt + 1);
    if (gt === -1) break; // an unclosed tag swallows the rest of the input
    i = gt + 1;
  }
  return decodeNamedEntities(parts.join('')).replace(/\s+/g, ' ').trim();
}

function isoDateOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function mediaOf(attrs: Record<string, string>, maxUrl: number): MediaAttrs {
  return {
    $: attrs,
    url: attrs.url ? attrs.url.slice(0, maxUrl) : undefined,
    type: attrs.type,
    href: attrs.href,
  };
}

/** Thrown internally to stop reading once the item cap is reached. Never escapes this module. */
class ItemCapReached extends Error {}

interface Capture {
  key: string;
  text: string;
  limit: number;
}

/**
 * Parses an RSS 2.0 or Atom document with bounded cost. Throws FeedParseError on malformed input,
 * on declared entities, or on nesting beyond the limit.
 */
export function parseFeedBounded(xml: string, limits: FeedLimits = DEFAULT_FEED_LIMITS): ParsedFeed {
  const feed: ParsedFeed = { items: [] };
  const parser = new SaxesParser({ xmlns: false });
  const path: string[] = [];
  const captures: Capture[] = [];
  let item: ParsedItem | null = null;
  let fatal: string | null = null;
  const { maxShortChars: short, maxBodyChars: body, maxItems, maxDepth } = limits;

  const ITEM_FIELDS_SHORT = new Set(['title', 'link', 'guid', 'id', 'pubDate', 'published', 'updated', 'dc:date', 'dc:creator', 'creator', 'author', 'image', 'thumbnail', 'thumb', 'og:image', 'twitter:image']);
  const ITEM_FIELDS_BODY = new Set(['description', 'content', 'content:encoded', 'summary']);
  const FEED_FIELDS = new Set(['title', 'link', 'description', 'subtitle']);
  const isBody = (name: string): boolean => ITEM_FIELDS_BODY.has(name) || name === 'description' || name === 'subtitle';

  const appendText = (text: string): void => {
    for (const cap of captures) {
      const room = cap.limit - cap.text.length;
      if (room > 0) cap.text += room >= text.length ? text : text.slice(0, room);
    }
  };

  const takeCapture = (key: string): string | undefined => {
    for (let i = captures.length - 1; i >= 0; i--) {
      if (captures[i].key === key) {
        const [cap] = captures.splice(i, 1);
        return decodeNamedEntities(cap.text).trim() || undefined;
      }
    }
    return undefined;
  };

  const assign = (p: ParsedItem, name: string, value: string): void => {
    switch (name) {
      case 'title': p.title ??= value; break;
      case 'link': p.link ??= value; break;
      case 'guid': case 'id': p.guid ??= value; break;
      case 'description': p.description ??= value; break;
      case 'content': p.content ??= value; break;
      case 'content:encoded': p.contentEncoded ??= value; break;
      case 'summary': p.summary ??= value; break;
      case 'pubDate': case 'published': case 'updated': case 'dc:date': p.pubDate ??= value; break;
      case 'dc:creator': case 'creator': p.creator ??= value; break;
      case 'author': p.author ??= value; break;
      case 'image': p.image ??= value; break;
      case 'thumbnail': p.thumbnail ??= value; break;
      case 'thumb': p.thumb ??= value; break;
      case 'og:image': p.ogImage ??= value; break;
      case 'twitter:image': p.twitterImage ??= value; break;
      default: break;
    }
  };

  parser.on('error', (err: Error) => {
    // Undefined named entities are recoverable: the raw text still arrives and is decoded later.
    if (/undefined entity/i.test(err.message)) return;
    fatal ??= `malformed feed: ${err.message}`;
  });

  parser.on('doctype', (dt: string) => {
    if (/<!ENTITY/i.test(dt)) fatal ??= 'feed declares entities, which are not accepted';
  });

  parser.on('opentag', (tag: any) => {
    const name: string = tag.name;
    const attrs: Record<string, string> = tag.attributes ?? {};
    path.push(name);
    if (path.length > maxDepth) fatal ??= 'feed nesting is too deep';
    const parent = path.length >= 2 ? path[path.length - 2] : undefined;

    if (!item) {
      if ((name === 'item' || name === 'entry')) {
        if (feed.items.length >= maxItems) throw new ItemCapReached();
        item = { enclosure: [], mediaContent: [], mediaThumbnail: [] };
      } else if (FEED_FIELDS.has(name) && (parent === 'channel' || parent === 'feed')) {
        if (name === 'link' && attrs.href) feed.link ??= attrs.href.slice(0, short);
        captures.push({ key: `feed:${name}`, text: '', limit: isBody(name) ? body : short });
      }
      return;
    }

    const p = item;
    if (name === 'enclosure' || (name === 'link' && attrs.rel === 'enclosure')) {
      p.enclosure.push(mediaOf(attrs, short));
    } else if (name === 'media:content') {
      p.mediaContent.push(mediaOf(attrs, short));
    } else if (name === 'media:thumbnail') {
      p.mediaThumbnail.push(mediaOf(attrs, short));
    } else if (name === 'link' && attrs.href && (!attrs.rel || attrs.rel === 'alternate')) {
      p.link ??= attrs.href.slice(0, short);
    } else if (name === 'image' || name === 'thumbnail' || name === 'thumb') {
      if (attrs.url) assign(p, name, attrs.url.slice(0, short));
    } else if (name === 'og:image' || name === 'twitter:image') {
      if (attrs.content) assign(p, name, attrs.content.slice(0, short));
    }

    if (ITEM_FIELDS_SHORT.has(name) || ITEM_FIELDS_BODY.has(name)) {
      captures.push({ key: `item:${name}`, text: '', limit: isBody(name) ? body : short });
    }
    // Media nested in a media:group is read through its own child elements below.
    if (name === 'media:group') p.mediaGroup ??= { 'media:content': [], 'media:thumbnail': [] };
  });

  const onText = (text: string): void => {
    appendText(text);
  };
  parser.on('text', onText);
  parser.on('cdata', onText);

  parser.on('closetag', (tag: any) => {
    const name: string = tag.name;
    if (item && (name === 'item' || name === 'entry')) {
      const p = item;
      const text = p.content || p.summary || p.description || '';
      // Only the start of the body is needed for a 1,000-character snippet, so bound the work per item.
      p.contentSnippet = text ? stripTags(text.slice(0, 4_000)).slice(0, 1_000) : undefined;
      p.isoDate = isoDateOf(p.pubDate);
      feed.items.push(p);
      item = null;
    } else if (item) {
      const value = takeCapture(`item:${name}`);
      if (value !== undefined) assign(item, name, value);
    } else {
      const value = takeCapture(`feed:${name}`);
      if (value !== undefined) {
        if (name === 'title') feed.title ??= value.slice(0, short);
        else if (name === 'link') feed.link ??= value.slice(0, short);
        else feed.description ??= value.slice(0, body);
      }
    }
    path.pop();
  });

  try {
    // Control characters that XML 1.0 forbids appear in real feeds. Dropping them is one linear
    // pass with a single character class, and matches what feed readers accept.
    parser.write(xml.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''));
    parser.close();
  } catch (err) {
    if (!(err instanceof ItemCapReached)) throw err;
    // The cap was reached: keep what was read so far and stop.
  }
  if (fatal) throw new FeedParseError(fatal);
  return feed;
}
