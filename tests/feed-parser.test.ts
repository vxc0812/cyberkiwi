import assert from 'node:assert/strict';
import { DEFAULT_FEED_LIMITS, FeedParseError, parseFeedBounded, stripTags } from '../server/feedParser';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
  } catch (err: any) {
    failures++;
    console.log(`❌ [FAIL] ${name}: ${err?.message ?? err}`);
  }
}

/** Synchronous parse time in milliseconds. The parser runs on the event loop, so this is the stall. */
function timed(fn: () => void): number {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const RSS = `<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/" version="2.0"><channel>
<title>Test Feed</title><link>https://feed.example.test/</link><description>Desc &amp; more</description>
<item><title><![CDATA[Hello &amp; welcome]]></title><link>https://feed.example.test/a</link><guid>g1</guid>
<pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate><dc:creator>Ann</dc:creator>
<description><![CDATA[<p>Caf&eacute; &nbsp;news <img src="https://img.example.test/x.jpg"></p>]]></description>
<enclosure url="https://img.example.test/enc.png" type="image/png"/>
<media:content url="https://img.example.test/m.jpg" type="image/jpeg"/></item>
<item><title>Second</title><link>https://feed.example.test/b</link><description>plain &nbsp;text</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom T</title><link href="https://atom.example.test/"/>
<entry><title>E1</title><link rel="alternate" href="https://atom.example.test/e1"/><id>urn:e1</id><updated>2026-11-01T08:00:00Z</updated><summary>Sum &amp; more</summary></entry></feed>`;

check('parse: RSS feed and item fields match the consumers', () => {
  const feed = parseFeedBounded(RSS);
  assert.equal(feed.title, 'Test Feed');
  assert.equal(feed.link, 'https://feed.example.test/');
  assert.equal(feed.description, 'Desc & more');
  assert.equal(feed.items.length, 2);
  const first = feed.items[0];
  assert.equal(first.title, 'Hello & welcome');
  assert.equal(first.link, 'https://feed.example.test/a');
  assert.equal(first.guid, 'g1');
  assert.equal(first.isoDate, '2026-11-02T10:00:00.000Z');
  assert.equal(first.creator, 'Ann');
  assert.deepEqual(first.enclosure.map((e) => e.url), ['https://img.example.test/enc.png']);
  assert.deepEqual(first.mediaContent.map((m) => m.url), ['https://img.example.test/m.jpg']);
});

check('parse: CDATA and HTML entities in descriptions are decoded into the snippet', () => {
  const feed = parseFeedBounded(RSS);
  assert.equal(feed.items[0].contentSnippet, 'Café news');
  assert.equal(feed.items[1].contentSnippet, 'plain text');
});

check('parse: Atom feed, alternate link, id and updated date', () => {
  const feed = parseFeedBounded(ATOM);
  assert.equal(feed.title, 'Atom T');
  assert.equal(feed.link, 'https://atom.example.test/');
  assert.equal(feed.items[0].title, 'E1');
  assert.equal(feed.items[0].link, 'https://atom.example.test/e1');
  assert.equal(feed.items[0].guid, 'urn:e1');
  assert.equal(feed.items[0].isoDate, '2026-11-01T08:00:00.000Z');
  assert.equal(feed.items[0].contentSnippet, 'Sum & more');
});

check('parse: control characters forbidden by XML 1.0 are dropped, not fatal', () => {
  const feed = parseFeedBounded('<rss><channel><item><title>Bad\u0001char\u001f here</title></item></channel></rss>');
  assert.equal(feed.items[0].title, 'Badchar here');
});

check('parse: a feed with no items is valid and empty', () => {
  const feed = parseFeedBounded('<rss><channel><title>none</title></channel></rss>');
  assert.equal(feed.title, 'none');
  assert.equal(feed.items.length, 0);
});

check('parse: malformed XML is rejected with PARSE_ERROR', () => {
  assert.throws(() => parseFeedBounded('<rss><channel><item><title>x</channel></rss>'), (err: any) => {
    assert.ok(err instanceof FeedParseError);
    assert.equal(err.errorCode, 'PARSE_ERROR');
    return true;
  });
});

check('parse: documents that declare entities are rejected, not expanded', () => {
  assert.throws(
    () => parseFeedBounded('<!DOCTYPE x [<!ENTITY e "boom">]><rss><channel><title>&e;</title></channel></rss>'),
    (err: any) => err instanceof FeedParseError,
  );
});

check('parse: item count is capped and parsing stops at the cap', () => {
  const xml = '<rss><channel>' + '<item><title>t</title></item>'.repeat(1_200) + '</channel></rss>';
  const feed = parseFeedBounded(xml);
  assert.equal(feed.items.length, DEFAULT_FEED_LIMITS.maxItems);
});

check('parse: field text is capped to the configured length', () => {
  const long = 'a'.repeat(50_000);
  const feed = parseFeedBounded(`<rss><channel><item><title>${long}</title><description>${long}</description></item></channel></rss>`);
  assert.equal(feed.items[0].title?.length, DEFAULT_FEED_LIMITS.maxShortChars);
  assert.equal(feed.items[0].description?.length, DEFAULT_FEED_LIMITS.maxBodyChars);
});

check('parse: nesting beyond the depth limit is rejected', () => {
  const deep = '<a>'.repeat(200) + '</a>'.repeat(200);
  assert.throws(() => parseFeedBounded(`<rss>${deep}</rss>`), (err: any) => err instanceof FeedParseError);
});

check('stripTags: removes markup, decodes entities and collapses whitespace', () => {
  assert.equal(stripTags('<p>Hi <b>there</b></p>'), 'Hi there');
  assert.equal(stripTags('a &lt;b&gt; c'), 'a <b> c');
  assert.equal(stripTags('x <unclosed y'), 'x');
  assert.equal(stripTags(''), '');
});

// Timing regressions for report finding F2. The inputs are the shapes that made the regex-based
// path quadratic: many unclosed "<" tags, and many entity-escaped "<" characters. Each parse is
// synchronous, so its duration is the time the event loop is blocked.
const BUDGET_MS = 1_500;
const wrap = (description: string) =>
  `<?xml version="1.0"?><rss><channel><title>t</title><item><title>x</title><description><![CDATA[${description}]]></description></item></channel></rss>`;

check('timing: 2 MB of unclosed <img tags parses within the event-loop budget', () => {
  const ms = timed(() => parseFeedBounded(wrap('<img '.repeat(400_000))));
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms, budget ${BUDGET_MS} ms`);
});

check('timing: 2 MB of lone "<" characters parses within the event-loop budget', () => {
  const ms = timed(() => parseFeedBounded(wrap('<'.repeat(2_000_000))));
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms, budget ${BUDGET_MS} ms`);
});

check('timing: 2 MB of entity-escaped "<" parses within the event-loop budget', () => {
  const ms = timed(() => parseFeedBounded(wrap('&lt;'.repeat(600_000))));
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms, budget ${BUDGET_MS} ms`);
});

check('timing: stripping a 2 MB entity-escaped body stays within the budget', () => {
  const ms = timed(() => stripTags('&lt;'.repeat(600_000).slice(0, 4_000)));
  assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms, budget ${BUDGET_MS} ms`);
});

if (failures > 0) {
  console.log(`\n${failures} feed parser check(s) failed.`);
  process.exitCode = 1;
}
