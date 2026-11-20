/**
 * Story building: groups articles that describe the same URL across feeds into one story.
 *
 * Identity rule (docs/ingestion-contract.md, section 10): a story's clusterKey is the canonical
 * URL of its articles. Each article joins at most one story. Re-running is a no-op for
 * articles that are already linked.
 */
import type { PrismaClient } from '../../generated/prisma/client';

export interface LinkResult {
  linkedArticles: number;
  touchedStories: number;
}

const LINK_BATCH = 2000;

export async function linkUnassignedArticles(db: PrismaClient): Promise<LinkResult> {
  const unassigned = await db.article.findMany({
    where: { storyLink: null },
    orderBy: [{ sortAt: 'desc' }, { id: 'desc' }],
    take: LINK_BATCH,
    select: { id: true, canonicalUrl: true, title: true, sortAt: true, publishedAt: true },
  });
  if (unassigned.length === 0) return { linkedArticles: 0, touchedStories: 0 };

  // Group by canonical URL. The first article in each group (newest) supplies the title.
  const groups = new Map<string, typeof unassigned>();
  for (const a of unassigned) {
    const list = groups.get(a.canonicalUrl) ?? [];
    list.push(a);
    groups.set(a.canonicalUrl, list);
  }

  // Atomic upsert on clusterKey: two workers linking at the same time both get the same story.
  const storyByKey = new Map<string, string>();
  for (const [clusterKey, articles] of groups) {
    // Prisma's upsert is select-then-write and can still raise a unique violation under
    // concurrency. INSERT ... ON CONFLICT DO NOTHING (createMany + skipDuplicates) is atomic.
    await db.story.createMany({
      data: [{ clusterKey, title: articles[0].title, articleCount: 0, sortAt: articles[0].sortAt }],
      skipDuplicates: true,
    });
    const story = await db.story.findUniqueOrThrow({ where: { clusterKey }, select: { id: true } });
    storyByKey.set(clusterKey, story.id);
    const storyId = storyByKey.get(clusterKey)!;
    await db.storyArticle.createMany({
      data: articles.map((a) => ({ storyId, articleId: a.id, method: 'canonical_url', score: 1 })),
      skipDuplicates: true,
    });
  }

  const touched = [...new Set([...groups.keys()].map((k) => storyByKey.get(k)!))];
  for (const storyId of touched) {
    await recomputeStory(db, storyId);
  }

  return { linkedArticles: unassigned.length, touchedStories: touched.length };
}

/** Recomputes a story's summary fields from its current article links. */
export async function recomputeStory(db: PrismaClient, storyId: string): Promise<void> {
  const links = await db.storyArticle.findMany({
    where: { storyId },
    select: { article: { select: { title: true, sortAt: true, publishedAt: true } } },
  });
  if (links.length === 0) return;

  const articles = links.map((l) => l.article).sort((a, b) => b.sortAt.getTime() - a.sortAt.getTime());
  const published = articles.map((a) => a.publishedAt).filter((d): d is Date => d instanceof Date);
  const latest = articles[0];

  await db.story.update({
    where: { id: storyId },
    data: {
      title: latest.title,
      articleCount: articles.length,
      sortAt: latest.sortAt,
      lastPublishedAt: published.length ? new Date(Math.max(...published.map((d) => d.getTime()))) : null,
      firstPublishedAt: published.length ? new Date(Math.min(...published.map((d) => d.getTime()))) : null,
    },
  });
}
