import type { FeedHealthItem } from '../../server/api/types';

export type EmptyKey = 'noArticles' | 'noSources' | 'sourcesFailing';

/**
 * Explains an empty dashboard block from source health.
 * - Unfiltered blocks, or health not loaded yet: "no matching stories".
 * - No active sources for the block's category: "no active sources".
 * - Every source in the category failing: "sources unavailable".
 * - Otherwise: "no matching stories" (sources are fine; nothing matches yet).
 */
export function emptyStateFor(
  block: { categoryFilter?: string },
  health: ReadonlyArray<Pick<FeedHealthItem, 'category' | 'status'>> | null
): EmptyKey {
  const category = block.categoryFilter;
  if (!category || category === 'all' || health === null) return 'noArticles';
  const feeds = health.filter((f) => f.category === category);
  if (feeds.length === 0) return 'noSources';
  if (feeds.every((f) => f.status === 'failing')) return 'sourcesFailing';
  return 'noArticles';
}
