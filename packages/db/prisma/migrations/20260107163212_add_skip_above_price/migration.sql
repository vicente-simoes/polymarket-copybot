-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "skipAbovePrice" DOUBLE PRECISION,
ALTER COLUMN "skipMakerTrades" SET DEFAULT false;
