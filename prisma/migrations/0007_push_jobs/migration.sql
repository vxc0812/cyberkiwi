-- CreateEnum
CREATE TYPE "PushJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SENT', 'FAILED', 'INVALID');

-- CreateTable
CREATE TABLE "PushJob" (
    "id" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storyId" UUID,
    "category" TEXT,
    "title" TEXT NOT NULL,
    "deepLink" TEXT,
    "status" "PushJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" UUID,

    CONSTRAINT "PushJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushJob_dedupeKey_key" ON "PushJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "PushJob_status_nextAttemptAt_idx" ON "PushJob"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "PushJob" ADD CONSTRAINT "PushJob_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushJob" ADD CONSTRAINT "PushJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

