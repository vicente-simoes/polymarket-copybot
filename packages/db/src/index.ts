// Database package - Prisma client and utilities
// Exports the Prisma client for use by web and worker apps

import { PrismaClient } from './generated/prisma';

// Create a singleton Prisma client instance
const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined;
};

export const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
        log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    });

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}

// Re-export Prisma types for convenience
export { PrismaClient } from './generated/prisma';
export * from './generated/prisma';
