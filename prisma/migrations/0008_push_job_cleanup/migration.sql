-- DropForeignKey
ALTER TABLE "PushJob" DROP CONSTRAINT "PushJob_userId_fkey";

-- AlterTable
ALTER TABLE "PushJob" DROP COLUMN "userId";

