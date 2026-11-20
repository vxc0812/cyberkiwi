/**
 * Loads the bundled cybersecurity feed catalog into the database.
 *
 * Idempotent. Sources are keyed by slug and feeds by URL, so re-running updates metadata and keeps
 * fetch state. Catalog decisions are applied on every run:
 *   - a feed listed as disabled in catalogPolicy is stored inactive with its reason;
 *   - a feed that is no longer in the catalog is deactivated with reason "removed from catalog";
 *   - everything else is active.
 *
 *   npm run db:seed
 */
import { CYBERSEC_DEFAULT_FEEDS } from '../../src/data/cybersecFeeds';
import { closePrisma, getPrisma } from '../db/client';
import type { PrismaClient } from '../../generated/prisma/client';
import { disabledReasonFor } from './catalogPolicy';
import { upsertFeed, upsertSource } from '../repositories/ingestion';

export interface SeedResult {
  sources: number;
  feeds: number;
  active: number;
  disabled: number;
  removed: number;
}

export async function seedCatalog(db: PrismaClient = getPrisma()): Promise<SeedResult> {
  const catalogUrls = new Set<string>();
  let feeds = 0;
  let active = 0;
  let disabled = 0;

  for (const feed of CYBERSEC_DEFAULT_FEEDS) {
    const sourceId = await upsertSource(db, {
      slug: feed.id,
      name: feed.title,
      category: feed.category,
      homepageUrl: null,
    });
    const feedId = await upsertFeed(db, {
      sourceId,
      url: feed.url,
      category: feed.category,
      title: feed.title,
      fetchIntervalMinutes: 15,
    });
    const reason = disabledReasonFor(feed.url);
    await db.feed.update({
      where: { id: feedId },
      data: { active: reason === null, disabledReason: reason },
    });
    catalogUrls.add(feed.url);
    feeds++;
    if (reason === null) active++;
    else disabled++;
  }

  // Feeds that left the catalog are deactivated, never deleted: their history stays intact.
  const stale = await db.feed.updateMany({
    where: { url: { notIn: [...catalogUrls] }, active: true },
    data: { active: false, disabledReason: 'removed from catalog' },
  });

  return { sources: feeds, feeds, active, disabled, removed: stale.count };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('server/ingestion/seed.ts')) {
  seedCatalog()
    .then(async (r) => {
      console.log(
        `[seed] catalog: ${r.feeds} feeds (${r.active} active, ${r.disabled} disabled by decision); ` +
          `${r.removed} feed(s) deactivated for leaving the catalog`
      );
      await closePrisma();
    })
    .catch(async (err) => {
      console.error('[seed] failed:', (err as Error).message);
      await closePrisma();
      process.exitCode = 1;
    });
}
