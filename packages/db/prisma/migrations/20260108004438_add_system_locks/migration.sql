-- CreateTable
CREATE TABLE "system_locks" (
    "lockKey" TEXT NOT NULL,
    "lockValue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_locks_pkey" PRIMARY KEY ("lockKey")
);
