-- AlterTable
ALTER TABLE "Article" ADD COLUMN     "sortAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Story" ADD COLUMN     "clusterKey" TEXT NOT NULL,
ADD COLUMN     "sortAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: existing articles sort by their publish date, falling back to first-seen time.
UPDATE "Article" SET "sortAt" = COALESCE("publishedAt", "firstSeenAt");

-- CreateIndex
CREATE INDEX "Article_sortAt_id_idx" ON "Article"("sortAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Story_clusterKey_key" ON "Story"("clusterKey");

-- CreateIndex
CREATE INDEX "Story_sortAt_id_idx" ON "Story"("sortAt", "id");

