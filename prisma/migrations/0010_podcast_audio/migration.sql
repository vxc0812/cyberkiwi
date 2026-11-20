ALTER TABLE "Article" ADD COLUMN "audioUrl" TEXT;

-- Fetch podcast documents again to backfill enclosures on existing articles.
UPDATE "Feed"
SET "etag" = NULL, "lastModified" = NULL, "lastAttemptAt" = NULL
WHERE "category" = 'podcasts' AND "active" = true;
