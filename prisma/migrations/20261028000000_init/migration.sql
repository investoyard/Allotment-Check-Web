-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'OPERATOR');

-- CreateEnum
CREATE TYPE "AllotmentStatus" AS ENUM ('ALLOTTED', 'NOT_ALLOTTED', 'NOT_APPLIED', 'ERROR');

-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'OPERATOR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pan" (
    "id" SERIAL NOT NULL,
    "clientId" INTEGER NOT NULL,
    "panEncrypted" TEXT NOT NULL,
    "panHash" TEXT NOT NULL,
    "panMasked" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "mobile" TEXT,
    "dpClientId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ipo" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "registrar" TEXT NOT NULL,
    "registrarIpoId" TEXT NOT NULL,
    "isSme" BOOLEAN NOT NULL DEFAULT false,
    "allotmentDate" DATE,
    "listingDate" DATE,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ipo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckResult" (
    "id" SERIAL NOT NULL,
    "ipoId" INTEGER NOT NULL,
    "panId" INTEGER NOT NULL,
    "status" "AllotmentStatus" NOT NULL,
    "appliedQty" INTEGER,
    "allottedQty" INTEGER,
    "category" TEXT,
    "applicantName" TEXT,
    "price" DECIMAL(12,2),
    "amountAdjusted" DECIMAL(14,2),
    "message" TEXT,
    "raw" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckJob" (
    "id" SERIAL NOT NULL,
    "ipoId" INTEGER NOT NULL,
    "state" "JobState" NOT NULL DEFAULT 'QUEUED',
    "scope" TEXT NOT NULL,
    "panIds" INTEGER[],
    "total" INTEGER NOT NULL,
    "done" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CheckJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "details" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Client_code_key" ON "Client"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Pan_panHash_key" ON "Pan"("panHash");

-- CreateIndex
CREATE INDEX "Pan_clientId_idx" ON "Pan"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Ipo_registrar_registrarIpoId_key" ON "Ipo"("registrar", "registrarIpoId");

-- CreateIndex
CREATE INDEX "CheckResult_ipoId_status_idx" ON "CheckResult"("ipoId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CheckResult_ipoId_panId_key" ON "CheckResult"("ipoId", "panId");

-- CreateIndex
CREATE INDEX "CheckJob_ipoId_idx" ON "CheckJob"("ipoId");

-- CreateIndex
CREATE INDEX "CheckJob_state_idx" ON "CheckJob"("state");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- AddForeignKey
ALTER TABLE "Pan" ADD CONSTRAINT "Pan_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckResult" ADD CONSTRAINT "CheckResult_ipoId_fkey" FOREIGN KEY ("ipoId") REFERENCES "Ipo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckResult" ADD CONSTRAINT "CheckResult_panId_fkey" FOREIGN KEY ("panId") REFERENCES "Pan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckJob" ADD CONSTRAINT "CheckJob_ipoId_fkey" FOREIGN KEY ("ipoId") REFERENCES "Ipo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckJob" ADD CONSTRAINT "CheckJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

