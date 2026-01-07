-- CreateTable
CREATE TABLE "market_registry" (
    "id" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT,
    "category" TEXT,
    "endDate" TIMESTAMP(3),
    "enableOrderBook" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "tokens" JSONB NOT NULL,
    "description" TEXT,
    "gammaMarketId" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_index" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "registryId" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_index_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "market_registry_conditionId_key" ON "market_registry"("conditionId");

-- CreateIndex
CREATE INDEX "market_registry_enableOrderBook_idx" ON "market_registry"("enableOrderBook");

-- CreateIndex
CREATE INDEX "market_registry_active_idx" ON "market_registry"("active");

-- CreateIndex
CREATE INDEX "market_registry_lastSyncedAt_idx" ON "market_registry"("lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "token_index_tokenId_key" ON "token_index"("tokenId");

-- CreateIndex
CREATE INDEX "token_index_conditionId_idx" ON "token_index"("conditionId");

-- AddForeignKey
ALTER TABLE "token_index" ADD CONSTRAINT "token_index_registryId_fkey" FOREIGN KEY ("registryId") REFERENCES "market_registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
