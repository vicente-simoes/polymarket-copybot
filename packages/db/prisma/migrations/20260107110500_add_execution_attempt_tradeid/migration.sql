-- AlterTable: Make leaderFillId optional and add tradeId
ALTER TABLE "execution_attempts" ALTER COLUMN "leaderFillId" DROP NOT NULL;
ALTER TABLE "execution_attempts" ADD COLUMN IF NOT EXISTS "tradeId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "execution_attempts_tradeId_idx" ON "execution_attempts"("tradeId");

-- AddForeignKey
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "trades"("id") ON DELETE SET NULL ON UPDATE CASCADE;
