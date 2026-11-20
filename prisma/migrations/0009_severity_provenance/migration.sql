-- CreateEnum
CREATE TYPE "SeveritySource" AS ENUM ('NVD', 'ARTICLE', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Cve" ADD COLUMN     "severitySource" "SeveritySource" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "severityUpdatedAt" TIMESTAMP(3);

