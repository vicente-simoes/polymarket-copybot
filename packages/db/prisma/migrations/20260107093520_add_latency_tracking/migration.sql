-- CreateTable
CREATE TABLE "latency_events" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "tokenId" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "leaderWallet" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "usdcAmount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "latency_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "latency_stats" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "polygonWins" INTEGER NOT NULL DEFAULT 0,
    "dataApiWins" INTEGER NOT NULL DEFAULT 0,
    "ties" INTEGER NOT NULL DEFAULT 0,
    "avgPolygonMs" DOUBLE PRECISION,
    "avgDataApiMs" DOUBLE PRECISION,
    "avgDeltaMs" DOUBLE PRECISION,
    "totalEvents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "latency_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_config" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_config_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "latency_events_dedupeKey_idx" ON "latency_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "latency_events_createdAt_idx" ON "latency_events"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "latency_stats_period_periodStart_key" ON "latency_stats"("period", "periodStart");
