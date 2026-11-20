-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "SessionKind" AS ENUM ('WEB', 'NATIVE');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('IOS', 'ANDROID', 'WEB');

-- CreateEnum
CREATE TYPE "EnrichmentJobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('VENDOR', 'PRODUCT', 'MALWARE_FAMILY', 'THREAT_ACTOR');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "preferences" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "inviteId" UUID,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteCode" (
    "id" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "cohort" TEXT,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "SessionKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "refreshHash" TEXT,
    "refreshExpiresAt" TIMESTAMP(3),
    "previousRefreshHash" TEXT,
    "deviceId" UUID,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "pushToken" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "notificationPrefs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiQuotaUsage" (
    "identity" TEXT NOT NULL,
    "day" VARCHAR(10) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiQuotaUsage_pkey" PRIMARY KEY ("identity","day")
);

-- CreateTable
CREATE TABLE "EnrichmentJob" (
    "id" UUID NOT NULL,
    "articleId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "EnrichmentJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnrichmentJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cve" (
    "id" TEXT NOT NULL,
    "cvssScore" DOUBLE PRECISION,
    "cvssSeverity" TEXT,
    "publishedAt" TIMESTAMP(3),
    "knownExploited" BOOLEAN NOT NULL DEFAULT false,
    "epss" DOUBLE PRECISION,
    "epssPercentile" DOUBLE PRECISION,
    "epssDate" DATE,
    "provider" TEXT NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cve_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KevEntry" (
    "cveId" TEXT NOT NULL,
    "vendorProject" TEXT,
    "product" TEXT,
    "dateAdded" DATE NOT NULL,
    "dueDate" DATE,
    "ransomwareCampaignUse" BOOLEAN NOT NULL DEFAULT false,
    "sourceUpdatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KevEntry_pkey" PRIMARY KEY ("cveId")
);

-- CreateTable
CREATE TABLE "EpssSnapshot" (
    "cveId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "epss" DOUBLE PRECISION NOT NULL,
    "percentile" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "EpssSnapshot_pkey" PRIMARY KEY ("cveId","date")
);

-- CreateTable
CREATE TABLE "ArticleCve" (
    "articleId" UUID NOT NULL,
    "cveId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleCve_pkey" PRIMARY KEY ("articleId","cveId")
);

-- CreateTable
CREATE TABLE "MitreTechnique" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tactic" TEXT,

    CONSTRAINT "MitreTechnique_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleTechnique" (
    "articleId" UUID NOT NULL,
    "techniqueId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleTechnique_pkey" PRIMARY KEY ("articleId","techniqueId")
);

-- CreateTable
CREATE TABLE "Entity" (
    "id" UUID NOT NULL,
    "type" "EntityType" NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleEntity" (
    "articleId" UUID NOT NULL,
    "entityId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleEntity_pkey" PRIMARY KEY ("articleId","entityId")
);

-- CreateTable
CREATE TABLE "CatalogSync" (
    "provider" TEXT NOT NULL,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastError" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3),
    "rowsUpdated" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CatalogSync_pkey" PRIMARY KEY ("provider")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_codeHash_key" ON "InviteCode"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshHash_key" ON "Session"("refreshHash");

-- CreateIndex
CREATE UNIQUE INDEX "Session_previousRefreshHash_key" ON "Session"("previousRefreshHash");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Device_pushToken_key" ON "Device"("pushToken");

-- CreateIndex
CREATE INDEX "Device_userId_idx" ON "Device"("userId");

-- CreateIndex
CREATE INDEX "EnrichmentJob_status_nextAttemptAt_idx" ON "EnrichmentJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "EnrichmentJob_articleId_provider_key" ON "EnrichmentJob"("articleId", "provider");

-- CreateIndex
CREATE INDEX "Cve_knownExploited_idx" ON "Cve"("knownExploited");

-- CreateIndex
CREATE INDEX "Cve_epss_idx" ON "Cve"("epss");

-- CreateIndex
CREATE INDEX "ArticleCve_cveId_idx" ON "ArticleCve"("cveId");

-- CreateIndex
CREATE INDEX "ArticleTechnique_techniqueId_idx" ON "ArticleTechnique"("techniqueId");

-- CreateIndex
CREATE UNIQUE INDEX "Entity_type_slug_key" ON "Entity"("type", "slug");

-- CreateIndex
CREATE INDEX "ArticleEntity_entityId_idx" ON "ArticleEntity"("entityId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "InviteCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrichmentJob" ADD CONSTRAINT "EnrichmentJob_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KevEntry" ADD CONSTRAINT "KevEntry_cveId_fkey" FOREIGN KEY ("cveId") REFERENCES "Cve"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpssSnapshot" ADD CONSTRAINT "EpssSnapshot_cveId_fkey" FOREIGN KEY ("cveId") REFERENCES "Cve"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleCve" ADD CONSTRAINT "ArticleCve_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleCve" ADD CONSTRAINT "ArticleCve_cveId_fkey" FOREIGN KEY ("cveId") REFERENCES "Cve"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleTechnique" ADD CONSTRAINT "ArticleTechnique_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleTechnique" ADD CONSTRAINT "ArticleTechnique_techniqueId_fkey" FOREIGN KEY ("techniqueId") REFERENCES "MitreTechnique"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleEntity" ADD CONSTRAINT "ArticleEntity_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleEntity" ADD CONSTRAINT "ArticleEntity_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

