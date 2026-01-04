-- AlterTable
ALTER TABLE "trades" ADD COLUMN     "isBackfill" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "trades_isBackfill_idx" ON "trades"("isBackfill");
