-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TradeSide" ADD VALUE 'SPLIT';
ALTER TYPE "TradeSide" ADD VALUE 'MERGE';

-- AlterTable
ALTER TABLE "leaders" ADD COLUMN     "maxUsdcPerDay" DOUBLE PRECISION,
ADD COLUMN     "maxUsdcPerTrade" DOUBLE PRECISION,
ADD COLUMN     "ratio" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "ratioDefault" DOUBLE PRECISION NOT NULL DEFAULT 0.01,
    "maxUsdcPerTrade" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "maxUsdcPerDay" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "maxPriceMovePct" DOUBLE PRECISION NOT NULL DEFAULT 0.01,
    "maxSpread" DOUBLE PRECISION NOT NULL DEFAULT 0.02,
    "sellMaxPriceMovePct" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "sellMaxSpread" DOUBLE PRECISION NOT NULL DEFAULT 0.10,
    "sellAlwaysAttempt" BOOLEAN NOT NULL DEFAULT true,
    "splitMergeAlwaysFollow" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "marketKey" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "title" TEXT,
    "shares" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgEntryPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCostBasis" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resolutions" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "resolvedOutcome" TEXT NOT NULL,
    "resolutionPrice" DOUBLE PRECISION NOT NULL,
    "realizedPnl" DOUBLE PRECISION NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pnl_snapshots" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalCostBasis" DOUBLE PRECISION NOT NULL,
    "unrealizedPnl" DOUBLE PRECISION NOT NULL,
    "realizedPnl" DOUBLE PRECISION NOT NULL,
    "totalPnl" DOUBLE PRECISION NOT NULL,
    "positionCount" INTEGER NOT NULL,

    CONSTRAINT "pnl_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "positions_isClosed_idx" ON "positions"("isClosed");

-- CreateIndex
CREATE UNIQUE INDEX "positions_marketKey_outcome_key" ON "positions"("marketKey", "outcome");

-- CreateIndex
CREATE INDEX "resolutions_positionId_idx" ON "resolutions"("positionId");

-- CreateIndex
CREATE INDEX "pnl_snapshots_timestamp_idx" ON "pnl_snapshots"("timestamp");

-- AddForeignKey
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
