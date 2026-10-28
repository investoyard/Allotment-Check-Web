-- DropForeignKey
ALTER TABLE "CheckResult" DROP CONSTRAINT "CheckResult_panId_fkey";

-- AlterTable
ALTER TABLE "CheckResult" ADD COLUMN     "clientId" INTEGER,
ADD COLUMN     "clientName" TEXT,
ADD COLUMN     "holderName" TEXT,
ADD COLUMN     "panMasked" TEXT,
ALTER COLUMN "panId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "CheckResult" ADD CONSTRAINT "CheckResult_panId_fkey" FOREIGN KEY ("panId") REFERENCES "Pan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
