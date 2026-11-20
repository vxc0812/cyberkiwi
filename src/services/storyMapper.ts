/**
 * Maps CyberKiwi API stories into the UI models (NewsItem, NewsStory).
 *
 * The server builds stories, so the client does not cluster when server stories are present.
 * Mapping keeps the same shape the UI already uses: the lead article's id as the story id, one
 * entry per source in uniqueSources, and isCluster when more than one article is present.
 */
import type { ArticleRef, StoryItem } from '../../server/api/types';
import type { ClusterSource, NewsItem, NewsStory } from '../types';

export function articleToNewsItem(a: ArticleRef): NewsItem {
  const published = a.publishedAt ?? a.firstSeenAt;
  return {
    id: a.id,
    title: a.title,
    link: a.url,
    contentSnippet: a.excerpt ?? '',
    pubDate: published,
    timestamp: Date.parse(published) || 0,
    sourceId: a.source.feedId,
    sourceName: a.source.name,
    sourceCategory: a.source.category,
    author: a.author ?? undefined,
    imageUrl: a.imageUrl ?? undefined,
    audioUrl: a.audioUrl ?? undefined,
  };
}

/** One entry per feed, using that feed's most recent article in the list. */
function sourcesOf(items: NewsItem[]): ClusterSource[] {
  const bySource = new Map<string, ClusterSource>();
  for (const item of items) {
    if (bySource.has(item.sourceId)) continue;
    bySource.set(item.sourceId, {
      sourceName: item.sourceName,
      sourceId: item.sourceId,
      link: item.link,
      title: item.title,
      timestamp: item.timestamp,
      pubDate: item.pubDate,
      author: item.author,
      imageUrl: item.imageUrl,
      audioUrl: item.audioUrl,
      contentSnippet: item.contentSnippet,
    });
  }
  return [...bySource.values()];
}

/** Builds a NewsStory from a list of items that all belong to one story. Items are newest first. */
function buildStory(clusterId: string, title: string, items: NewsItem[], isCluster: boolean): NewsStory {
  const lead = items[0];
  const uniqueSources = sourcesOf(items);
  return {
    ...lead,
    title,
    articles: items,
    sourcesCount: uniqueSources.length,
    uniqueSources,
    isCluster,
    clusterId,
  };
}

export function storyToNewsStory(story: StoryItem): NewsStory {
  const items = story.articles.map(articleToNewsItem);
  if (items.length === 0) {
    // A story always has at least one article in a list response; keep the UI safe if it does not.
    throw new Error(`Story ${story.id} has no articles`);
  }
  return buildStory(`story-${story.id}`, story.title, items, story.articleCount > 1);
}

/**
 * Groups already-filtered articles back into their server stories, keeping first-seen order.
 * Used by the block pipeline, which filters articles first and then needs story objects.
 * Articles that do not belong to any known story stand alone.
 */
export function groupItemsByStory(items: NewsItem[], stories: NewsStory[]): NewsStory[] {
  const storyOfArticle = new Map<string, NewsStory>();
  for (const s of stories) {
    for (const a of s.articles) storyOfArticle.set(a.id, s);
  }

  const groups = new Map<string, { story: NewsStory | null; items: NewsItem[] }>();
  for (const item of items) {
    const story = storyOfArticle.get(item.id) ?? null;
    const key = story ? story.clusterId : `single-${item.id}`;
    const group = groups.get(key) ?? { story, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }

  return [...groups.values()].map((g) => {
    if (!g.story) {
      const lead = g.items[0];
      return buildStory(`story-${lead.id}`, lead.title, g.items, false);
    }
    return buildStory(g.story.clusterId, g.story.title, g.items, g.items.length > 1);
  });
}

/**
 * Appends articles from a later page, keeping the first copy of each id and the existing order.
 */
export function mergeArticles(existing: NewsItem[], incoming: NewsItem[]): NewsItem[] {
  const seen = new Set(existing.map((a) => a.id));
  const added = incoming.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
  return added.length === 0 ? existing : [...existing, ...added];
}
