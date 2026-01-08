-- CreateTable
CREATE TABLE "leader_positions" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "shares" DECIMAL(20,10) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leader_positions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leader_positions_leaderId_idx" ON "leader_positions"("leaderId");

-- CreateIndex
CREATE UNIQUE INDEX "leader_positions_leaderId_conditionId_outcome_key" ON "leader_positions"("leaderId", "conditionId", "outcome");

-- AddForeignKey
ALTER TABLE "leader_positions" ADD CONSTRAINT "leader_positions_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "leaders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
