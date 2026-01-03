// Health tracking for worker status monitoring
import { prisma } from '@polymarket-bot/db';
import pino from 'pino';

const logger = pino({ name: 'health' });

export interface LeaderHealth {
    leaderId: string;
    label: string;
    wallet: string;
    enabled: boolean;
    lastTradeIngested: Date | null;
    lastPollAttempt: Date | null;
    consecutiveErrors: number;
}

export interface WorkerHealth {
    startedAt: Date;
    lastPollTime: Date | null;
    totalPollCycles: number;
    totalTradesIngested: number;
    totalErrors: number;
    leaders: Map<string, LeaderHealth>;
    isHealthy: boolean;
}

// Global health state
const health: WorkerHealth = {
    startedAt: new Date(),
    lastPollTime: null,
    totalPollCycles: 0,
    totalTradesIngested: 0,
    totalErrors: 0,
    leaders: new Map(),
    isHealthy: true,
};

/**
 * Initialize health tracking for a leader
 */
export function initLeaderHealth(leaderId: string, label: string, wallet: string, enabled: boolean): void {
    if (!health.leaders.has(leaderId)) {
        health.leaders.set(leaderId, {
            leaderId,
            label,
            wallet,
            enabled,
            lastTradeIngested: null,
            lastPollAttempt: null,
            consecutiveErrors: 0,
        });
    }
}

/**
 * Update leader health after a poll attempt
 */
export function updateLeaderHealth(
    leaderId: string,
    success: boolean,
    newTradesCount: number = 0
): void {
    const leaderHealth = health.leaders.get(leaderId);
    if (!leaderHealth) return;

    leaderHealth.lastPollAttempt = new Date();

    if (success) {
        leaderHealth.consecutiveErrors = 0;
        if (newTradesCount > 0) {
            leaderHealth.lastTradeIngested = new Date();
            health.totalTradesIngested += newTradesCount;
        }
    } else {
        leaderHealth.consecutiveErrors++;
        health.totalErrors++;
    }
}

/**
 * Mark poll cycle complete
 */
export function recordPollCycle(): void {
    health.lastPollTime = new Date();
    health.totalPollCycles++;
}

/**
 * Get current worker health status
 */
export function getWorkerHealth(): WorkerHealth {
    // Check if system is healthy
    const unhealthyLeaders = Array.from(health.leaders.values())
        .filter(l => l.enabled && l.consecutiveErrors >= 3);

    health.isHealthy = unhealthyLeaders.length === 0;

    return { ...health };
}

/**
 * Get health summary for logging
 */
export function getHealthSummary() {
    const h = getWorkerHealth();
    const leaders = Array.from(h.leaders.values());

    return {
        uptime: Math.floor((Date.now() - h.startedAt.getTime()) / 1000),
        lastPoll: h.lastPollTime?.toISOString() || 'never',
        pollCycles: h.totalPollCycles,
        tradesIngested: h.totalTradesIngested,
        errors: h.totalErrors,
        isHealthy: h.isHealthy,
        leadersEnabled: leaders.filter(l => l.enabled).length,
        leadersWithErrors: leaders.filter(l => l.consecutiveErrors > 0).length,
    };
}

/**
 * Log health status periodically
 */
export function logHealthStatus(): void {
    const summary = getHealthSummary();

    if (summary.isHealthy) {
        logger.info(summary, 'Worker health: OK');
    } else {
        logger.warn(summary, 'Worker health: DEGRADED');
    }
}

/**
 * Check database connectivity
 */
export async function checkDatabaseConnection(): Promise<boolean> {
    try {
        await prisma.$queryRaw`SELECT 1`;
        return true;
    } catch (error) {
        logger.error({ error }, 'Database connection check failed');
        return false;
    }
}

/**
 * Wait for database to be available with retries
 */
export async function waitForDatabase(maxAttempts: number = 10, delayMs: number = 2000): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        logger.info({ attempt, maxAttempts }, 'Checking database connection...');

        const connected = await checkDatabaseConnection();
        if (connected) {
            logger.info('Database connection established');
            return true;
        }

        if (attempt < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    logger.error({ maxAttempts }, 'Failed to connect to database after max attempts');
    return false;
}
