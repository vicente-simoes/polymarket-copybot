-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "IntentDecision" AS ENUM ('TRADE', 'SKIP');

-- CreateTable
CREATE TABLE "leaders" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_raw" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_raw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_raw" (
    "id" TEXT NOT NULL,
    "marketKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_raw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "tradeTs" TIMESTAMP(3) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "side" "TradeSide" NOT NULL,
    "conditionId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "leaderPrice" DECIMAL(20,10) NOT NULL,
    "leaderSize" DECIMAL(20,10) NOT NULL,
    "leaderUsdc" DECIMAL(20,10) NOT NULL,
    "title" TEXT,
    "rawId" TEXT NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_mapping" (
    "id" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "marketKey" TEXT NOT NULL,
    "clobTokenId" TEXT,
    "assetId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "marketKey" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bestBid" DECIMAL(20,10) NOT NULL,
    "bestAsk" DECIMAL(20,10) NOT NULL,
    "bidSize" DECIMAL(20,10),
    "askSize" DECIMAL(20,10),
    "rawId" TEXT NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_intents" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "ratio" DECIMAL(10,6) NOT NULL,
    "yourUsdcTarget" DECIMAL(20,10) NOT NULL,
    "yourSide" "TradeSide" NOT NULL,
    "limitPrice" DECIMAL(20,10) NOT NULL,
    "decision" "IntentDecision" NOT NULL,
    "decisionReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paper_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_fills" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "filled" BOOLEAN NOT NULL,
    "fillPrice" DECIMAL(20,10),
    "fillAt" TIMESTAMP(3),
    "slippageAbs" DECIMAL(20,10),
    "slippagePct" DECIMAL(10,6),
    "matchSamePrice" BOOLEAN NOT NULL,
    "quoteId" TEXT,

    CONSTRAINT "paper_fills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leaders_wallet_key" ON "leaders"("wallet");

-- CreateIndex
CREATE UNIQUE INDEX "trades_dedupeKey_key" ON "trades"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "trades_rawId_key" ON "trades"("rawId");

-- CreateIndex
CREATE INDEX "trades_leaderId_idx" ON "trades"("leaderId");

-- CreateIndex
CREATE INDEX "trades_conditionId_idx" ON "trades"("conditionId");

-- CreateIndex
CREATE INDEX "trades_tradeTs_idx" ON "trades"("tradeTs");

-- CreateIndex
CREATE UNIQUE INDEX "market_mapping_conditionId_outcome_key" ON "market_mapping"("conditionId", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_rawId_key" ON "quotes"("rawId");

-- CreateIndex
CREATE INDEX "quotes_marketKey_idx" ON "quotes"("marketKey");

-- CreateIndex
CREATE INDEX "quotes_capturedAt_idx" ON "quotes"("capturedAt");

-- CreateIndex
CREATE INDEX "paper_intents_tradeId_idx" ON "paper_intents"("tradeId");

-- CreateIndex
CREATE INDEX "paper_intents_decision_idx" ON "paper_intents"("decision");

-- CreateIndex
CREATE UNIQUE INDEX "paper_fills_intentId_key" ON "paper_fills"("intentId");

-- AddForeignKey
ALTER TABLE "trade_raw" ADD CONSTRAINT "trade_raw_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "leaders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "leaders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_rawId_fkey" FOREIGN KEY ("rawId") REFERENCES "trade_raw"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_rawId_fkey" FOREIGN KEY ("rawId") REFERENCES "quote_raw"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_intents" ADD CONSTRAINT "paper_intents_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "trades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "paper_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_fills" ADD CONSTRAINT "paper_fills_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
