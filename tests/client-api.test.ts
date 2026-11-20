import assert from 'node:assert/strict';
import {
  CyberkiwiApiError,
  createCyberkiwiApiClient,
  parseApiBaseUrl,
} from '../src/services/cyberkiwiApi';
import { groupItemsByStory, storyToNewsStory, articleToNewsItem, mergeArticles } from '../src/services/storyMapper';
import { configuredApiBaseUrl, describeApiError, storyQueryForBlock } from '../src/services/cyberkiwiApi';
import { emptyStateFor } from '../src/services/emptyState';
import type { ArticleRef, StoriesPage, StoryItem } from '../server/api/types';

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✅ [PASS] ${name}`);
  } catch (err: any) {
    failures++;
    console.log(`❌ [FAIL] ${name}: ${err?.message ?? err}`);
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function article(id: string, feedId: string, sourceName: string, published: string): ArticleRef {
  return {
    id,
    title: `Title ${id}`,
    url: `https://${feedId}.test/${id}`,
    excerpt: `Excerpt ${id}`,
    author: null,
    imageUrl: null,
    publishedAt: published,
    firstSeenAt: published,
    source: { feedId, sourceSlug: feedId, name: sourceName, feedTitle: null, category: 'news' },
  };
}

function story(id: string, articles: ArticleRef[], articleCount = articles.length): StoryItem {
  return {
    id,
    title: articles[0].title,
    summary: null,
    articleCount,
    matchedArticleCount: articleCount,
    firstPublishedAt: articles[articles.length - 1].publishedAt,
    lastPublishedAt: articles[0].publishedAt,
    sources: [],
    articles,
    articlesTruncated: false,
  };
}

async function main() {
  // --- base URL validation -------------------------------------------------
  await check('base URL: empty means same-origin; a trailing slash is removed', () => {
    assert.equal(parseApiBaseUrl(''), '');
    assert.equal(parseApiBaseUrl('  '), '');
    assert.equal(parseApiBaseUrl('https://api.example.test/'), 'https://api.example.test');
    assert.equal(parseApiBaseUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  });
  await check('base URL: only absolute http(s) origins are accepted', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.test', 'not a url', 'https://a.test/?x=1', 'https://a.test/#f']) {
      assert.throws(() => parseApiBaseUrl(bad), undefined, bad);
    }
  });

  // --- client requests and errors -----------------------------------------
  await check('client: builds the list URL with limit and cursor, and parses the page', async () => {
    const seen: string[] = [];
    const client = createCyberkiwiApiClient({
      baseUrl: 'https://api.test',
      fetchImpl: async (u) => {
        seen.push(String(u));
        return json(200, { success: true, items: [], nextCursor: null, hasMore: false });
      },
    });
    const page = await client.listStories({ limit: 5, cursor: 'abc_-' });
    assert.equal(seen[0], 'https://api.test/api/v1/stories?limit=5&cursor=abc_-');
    assert.equal(page.hasMore, false);
  });
  await check('client: an error envelope becomes a typed error with the server code', async () => {
    const client = createCyberkiwiApiClient({
      baseUrl: '',
      fetchImpl: async () => json(400, { success: false, error: { code: 'invalid_cursor', message: 'bad' } }),
    });
    await assert.rejects(client.listStories({ cursor: 'x' }), (err: any) => {
      assert.ok(err instanceof CyberkiwiApiError);
      assert.equal(err.code, 'invalid_cursor');
      assert.equal(err.status, 400);
      return true;
    });
  });
  await check('client: network failure, timeout, bad body and non-JSON errors are distinct codes', async () => {
    const network = createCyberkiwiApiClient({ baseUrl: '', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(network.listStories(), (e: any) => e.code === 'network');
    const timeout = createCyberkiwiApiClient({
      baseUrl: '',
      fetchImpl: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); },
    });
    await assert.rejects(timeout.listStories(), (e: any) => e.code === 'timeout');
    const bad = createCyberkiwiApiClient({ baseUrl: '', fetchImpl: async () => json(200, { hello: 1 }) });
    await assert.rejects(bad.listStories(), (e: any) => e.code === 'bad_response');
    const html = createCyberkiwiApiClient({ baseUrl: '', fetchImpl: async () => new Response('<html>', { status: 502 }) });
    await assert.rejects(html.listStories(), (e: any) => e.code === 'http_error' && e.status === 502);
  });

  // --- pagination against a simulated server --------------------------------
  await check('pagination: following nextCursor returns every story once, in server order', async () => {
    const all = ['s1', 's2', 's3', 's4', 's5'].map((id, i) => story(id, [article(`a-${id}`, 'f', 'Src', `2026-11-0${5 - i}T00:00:00Z`)]));
    const fake = async (u: any) => {
      const url = new URL(String(u));
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const cursor = url.searchParams.get('cursor');
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + limit);
      const next = start + limit < all.length ? String(start + limit) : null;
      const body: StoriesPage = { success: true, items: slice, nextCursor: next, hasMore: next !== null };
      return json(200, body);
    };
    const client = createCyberkiwiApiClient({ baseUrl: 'https://api.test', fetchImpl: fake });
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: StoriesPage = await client.listStories({ limit: 2, cursor });
      ids.push(...page.items.map((s) => s.id));
      cursor = page.nextCursor;
      pages++;
      assert.ok(pages <= 5, 'pagination terminates');
    } while (cursor);
    assert.deepEqual(ids, ['s1', 's2', 's3', 's4', 's5']);
    assert.equal(pages, 3);
  });

  // --- story/source mapping -----------------------------------------------
  await check('mapping: the lead is the newest article; sources are distinct per feed; cluster flags follow the server', () => {
    const newest = article('n', 'feedA', 'Alpha', '2026-11-12T10:00:00Z');
    const other = article('o', 'feedB', 'Beta', '2026-11-11T10:00:00Z');
    const dupe = article('d', 'feedA', 'Alpha', '2026-11-10T10:00:00Z');
    const s = storyToNewsStory(story('st-1', [newest, other, dupe]));
    assert.equal(s.id, 'n', 'lead article id');
    assert.equal(s.clusterId, 'story-st-1');
    assert.equal(s.isCluster, true);
    assert.equal(s.sourcesCount, 2, 'two distinct feeds');
    assert.deepEqual(s.uniqueSources.map((x) => x.sourceId), ['feedA', 'feedB']);
    assert.equal(s.articles.length, 3);
    assert.equal(s.timestamp, Date.parse('2026-11-12T10:00:00Z'));
  });
  await check('mapping: a single-article story is not a cluster and keeps its link and snippet', () => {
    const only = article('x', 'feedC', 'Gamma', '2026-11-01T00:00:00Z');
    const s = storyToNewsStory(story('st-2', [only], 1));
    assert.equal(s.isCluster, false);
    assert.equal(s.link, only.url);
    assert.equal(s.contentSnippet, 'Excerpt x');
    const item = articleToNewsItem(only);
    assert.equal(item.sourceName, 'Gamma');
  });
  await check('grouping: filtered articles regroup under their story, keep order, and singles stand alone', () => {
    const a1 = article('a1', 'f1', 'One', '2026-11-12T00:00:00Z');
    const a2 = article('a2', 'f2', 'Two', '2026-11-11T00:00:00Z');
    const b1 = article('b1', 'f3', 'Three', '2026-11-10T00:00:00Z');
    const stories = [storyToNewsStory(story('A', [a1, a2])), storyToNewsStory(story('B', [b1], 1))];
    const filtered = [articleToNewsItem(a2), articleToNewsItem(b1), articleToNewsItem(a1)];
    const groups = groupItemsByStory(filtered, stories);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].clusterId, 'story-A', 'first seen group comes first');
    assert.equal(groups[0].articles.length, 2, 'both filtered A articles kept');
    assert.equal(groups[0].isCluster, true);
    assert.equal(groups[1].clusterId, 'story-B');
    assert.equal(groups[1].isCluster, false);
    const onlyOne = groupItemsByStory([articleToNewsItem(a1)], stories);
    assert.equal(onlyOne[0].isCluster, false, 'a filter that leaves one article is not shown as a cluster');
  });

  await check('config: absent variable keeps the legacy path; native needs an explicit origin', () => {
    assert.equal(configuredApiBaseUrl({}, false), null);
    assert.equal(configuredApiBaseUrl({ VITE_CYBERKIWI_API_BASE_URL: '' }, true), null);
    assert.equal(configuredApiBaseUrl({ VITE_CYBERKIWI_API_BASE_URL: '' }, false), '');
    assert.equal(configuredApiBaseUrl({ VITE_CYBERKIWI_API_BASE_URL: 'https://pre-beta.example.test/' }, true), 'https://pre-beta.example.test');
    assert.throws(() => configuredApiBaseUrl({ VITE_CYBERKIWI_API_BASE_URL: 'javascript:1' }, false));
  });
  await check('errors: messages are fixed per code and never echo server text', () => {
    assert.match(describeApiError('network'), /Could not reach/);
    assert.match(describeApiError('store_unavailable'), /temporarily unavailable/);
    assert.match(describeApiError('whatever'), /request failed/);
  });
  await check('merge: later pages append without duplicating ids or reordering', () => {
    const a = articleToNewsItem(article('m1', 'f', 'S', '2026-11-01T00:00:00Z'));
    const b = articleToNewsItem(article('m2', 'f', 'S', '2026-11-02T00:00:00Z'));
    const merged = mergeArticles([a], [a, b]);
    assert.deepEqual(merged.map((x) => x.id), ['m1', 'm2']);
    assert.equal(mergeArticles([a], [a]).length, 1, 'a repeated id is not added twice');
  });

  await check('block queries: all means no category; keywords pass through; item count is clamped to 1..50', () => {
    assert.deepEqual(storyQueryForBlock({ categoryFilter: 'all', itemCount: 5 }), { category: null, keyword: null, limit: 5 });
    const q = storyQueryForBlock({ categoryFilter: 'vulnerabilities', filterKeyword: ' critical|zero-day ', itemCount: 500 });
    assert.equal(q.category, 'vulnerabilities');
    assert.equal(q.keyword, 'critical|zero-day');
    assert.equal(q.limit, 50);
    assert.equal(storyQueryForBlock({ itemCount: 0 }).limit, 1);
  });
  await check('client errors: an expired cursor, a 401 and a bare 403 each map to a distinct code', async () => {
    const expired = createCyberkiwiApiClient({ baseUrl: '', fetchImpl: async () => json(400, { success: false, error: { code: 'invalid_cursor', message: 'x' } }) });
    await assert.rejects(expired.listStories({ cursor: 'old' }), (e: any) => e.code === 'invalid_cursor' && e.status === 400);
    const unauth = createCyberkiwiApiClient({ baseUrl: '', fetchImpl: async () => json(401, { success: false, error: { code: 'unauthorized', message: 'x' } }) });
    await assert.rejects(unauth.getFeedHealth(), (e: any) => e.code === 'unauthorized' && e.status === 401);
    const forbidden = createCyberkiwiApiClient({ baseUrl: '', fetchImpl: async () => new Response('', { status: 403 }) });
    await assert.rejects(forbidden.listStories(), (e: any) => e.code === 'http_error' && e.status === 403);
  });
  await check('zero stories: an empty page maps to an empty block without errors', () => {
    assert.deepEqual(groupItemsByStory([], []), []);
  });
  await check('empty states: no sources, all failing, and no matches are reported differently', () => {
    const health = [
      { category: 'exploits', status: 'ok' as const },
      { category: 'vendor-advisories', status: 'failing' as const },
      { category: 'vendor-advisories', status: 'failing' as const },
      { category: 'news', status: 'ok' as const },
      { category: 'news', status: 'never_fetched' as const },
    ];
    assert.equal(emptyStateFor({ categoryFilter: 'all' }, health), 'noArticles');
    assert.equal(emptyStateFor({ categoryFilter: 'exploits' }, health), 'noArticles', 'sources ok, nothing matches');
    assert.equal(emptyStateFor({ categoryFilter: 'vendor-advisories' }, health), 'sourcesFailing');
    assert.equal(emptyStateFor({ categoryFilter: 'cloud' }, health), 'noSources');
    assert.equal(emptyStateFor({ categoryFilter: 'news' }, health), 'noArticles', 'never fetched is not failing');
    assert.equal(emptyStateFor({ categoryFilter: 'exploits' }, null), 'noArticles', 'health not loaded yet');
  });
  if (failures > 0) {
    console.log(`\n${failures} client API check(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
