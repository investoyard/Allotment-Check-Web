-- AlterTable
ALTER TABLE "CheckJob" ADD COLUMN     "trigger" TEXT NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "Ipo" ADD COLUMN     "autoCheck" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastProbeAt" TIMESTAMP(3);
