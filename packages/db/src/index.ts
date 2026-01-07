// Database package - Prisma client and utilities
// Exports the Prisma client for use by web and worker apps

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

// Create connection pool
const connectionString = process.env.DATABASE_URL ?? 'postgresql://polymarket:polymarket@localhost:5432/polymarket';
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);

// Create a singleton Prisma client instance
const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined;
};

export const prisma =
    globalForPrisma.prisma ??
    new PrismaClient({
        adapter,
        log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    });

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}

// Re-export PrismaClient and types
export { PrismaClient, Prisma } from './generated/prisma/client.js';
export * from './generated/prisma/models.js';
export * from './generated/prisma/enums.js';
