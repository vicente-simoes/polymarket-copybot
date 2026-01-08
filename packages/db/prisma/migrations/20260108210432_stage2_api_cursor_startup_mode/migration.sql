-- AlterTable
ALTER TABLE "leaders" ADD COLUMN     "apiCursorInitialized" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "apiCursorTs" TIMESTAMP(3),
ADD COLUMN     "apiCursorUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "startupMode" TEXT NOT NULL DEFAULT 'flat',
ADD COLUMN     "warmStartSeconds" INTEGER NOT NULL DEFAULT 900;
