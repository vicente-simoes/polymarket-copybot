-- CreateEnum
CREATE TYPE "FillSource" AS ENUM ('data_api', 'polygon');

-- CreateEnum
CREATE TYPE "LeaderRole" AS ENUM ('maker', 'taker', 'unknown');

-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('paper', 'live');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('SKIPPED', 'SUBMITTED', 'PARTIAL', 'FILLED', 'CANCELED', 'FAILED');

-- CreateTable
CREATE TABLE "leader_fill_raw" (
    "id" TEXT NOT NULL,
    "source" "FillSource" NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leader_fill_raw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leader_fills" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "source" "FillSource" NOT NULL,
    "exchangeAddress" TEXT,
    "blockNumber" INTEGER,
    "txHash" TEXT,
    "logIndex" INTEGER,
    "orderHash" TEXT,
    "maker" TEXT,
    "taker" TEXT,
    "leaderRole" "LeaderRole" NOT NULL DEFAULT 'unknown',
    "tokenId" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "leaderPrice" DECIMAL(20,10) NOT NULL,
    "leaderSize" DECIMAL(20,10) NOT NULL,
    "leaderUsdc" DECIMAL(20,10) NOT NULL,
    "fillTs" TIMESTAMP(3) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "title" TEXT,
    "isBackfill" BOOLEAN NOT NULL DEFAULT false,
    "dedupeKey" TEXT NOT NULL,
    "rawId" TEXT NOT NULL,

    CONSTRAINT "leader_fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_attempts" (
    "id" TEXT NOT NULL,
    "leaderFillId" TEXT NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "decision" "IntentDecision" NOT NULL,
    "decisionReason" TEXT,
    "ratio" DECIMAL(10,6) NOT NULL,
    "tokenId" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "sizeSharesTarget" DECIMAL(20,10) NOT NULL,
    "limitPrice" DECIMAL(20,10) NOT NULL,
    "ttlMs" INTEGER NOT NULL DEFAULT 30000,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "placedAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_fills" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "filledShares" DECIMAL(20,10) NOT NULL,
    "fillPrice" DECIMAL(20,10) NOT NULL,
    "feeUsdc" DECIMAL(20,10),
    "fillAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "polygon_cursors" (
    "id" TEXT NOT NULL,
    "exchangeAddress" TEXT NOT NULL,
    "leaderAddress" TEXT NOT NULL,
    "role" "LeaderRole" NOT NULL,
    "lastProcessedBlock" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "polygon_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leader_fills_dedupeKey_key" ON "leader_fills"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "leader_fills_rawId_key" ON "leader_fills"("rawId");

-- CreateIndex
CREATE INDEX "leader_fills_leaderId_idx" ON "leader_fills"("leaderId");

-- CreateIndex
CREATE INDEX "leader_fills_conditionId_idx" ON "leader_fills"("conditionId");

-- CreateIndex
CREATE INDEX "leader_fills_fillTs_idx" ON "leader_fills"("fillTs");

-- CreateIndex
CREATE INDEX "leader_fills_blockNumber_idx" ON "leader_fills"("blockNumber");

-- CreateIndex
CREATE INDEX "leader_fills_txHash_idx" ON "leader_fills"("txHash");

-- CreateIndex
CREATE INDEX "execution_attempts_leaderFillId_idx" ON "execution_attempts"("leaderFillId");

-- CreateIndex
CREATE INDEX "execution_attempts_status_idx" ON "execution_attempts"("status");

-- CreateIndex
CREATE INDEX "execution_attempts_createdAt_idx" ON "execution_attempts"("createdAt");

-- CreateIndex
CREATE INDEX "execution_fills_attemptId_idx" ON "execution_fills"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "polygon_cursors_exchangeAddress_leaderAddress_role_key" ON "polygon_cursors"("exchangeAddress", "leaderAddress", "role");

-- AddForeignKey
ALTER TABLE "leader_fills" ADD CONSTRAINT "leader_fills_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "leaders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leader_fills" ADD CONSTRAINT "leader_fills_rawId_fkey" FOREIGN KEY ("rawId") REFERENCES "leader_fill_raw"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_leaderFillId_fkey" FOREIGN KEY ("leaderFillId") REFERENCES "leader_fills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execution_fills" ADD CONSTRAINT "execution_fills_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "execution_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
