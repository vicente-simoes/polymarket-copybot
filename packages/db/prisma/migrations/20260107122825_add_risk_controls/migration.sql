-- DropForeignKey
ALTER TABLE "execution_attempts" DROP CONSTRAINT "execution_attempts_leaderFillId_fkey";

-- DropIndex
DROP INDEX "execution_attempts_tradeId_idx";

-- AlterTable
ALTER TABLE "leaders" ADD COLUMN     "maxUsdcPerEvent" DOUBLE PRECISION,
ADD COLUMN     "skipMakerTrades" BOOLEAN;

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "maxOpenPositions" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "maxUsdcPerEvent" DOUBLE PRECISION NOT NULL DEFAULT 50,
ADD COLUMN     "skipMakerTrades" BOOLEAN NOT NULL DEFAULT true;

-- AddForeignKey
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_leaderFillId_fkey" FOREIGN KEY ("leaderFillId") REFERENCES "leader_fills"("id") ON DELETE SET NULL ON UPDATE CASCADE;
