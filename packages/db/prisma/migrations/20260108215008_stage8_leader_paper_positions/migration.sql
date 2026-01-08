-- AlterTable
ALTER TABLE "paper_fills" ADD COLUMN     "fillShares" DECIMAL(20,10);

-- CreateTable
CREATE TABLE "paper_positions" (
    "id" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "shares" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "costBasisUsdc" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paper_positions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "paper_positions_conditionId_idx" ON "paper_positions"("conditionId");

-- CreateIndex
CREATE UNIQUE INDEX "paper_positions_conditionId_outcome_key" ON "paper_positions"("conditionId", "outcome");
