/**
 * Latency Tracker - Compare detection times from Data API vs Polygon
 * Phase 3.5: Latency Tracking
 */

import { prisma } from '@polymarket-bot/db';
import pino from 'pino';

const logger = pino({ name: 'latency-tracker' });

/**
 * Record a latency event from any source
 */
export async function recordLatencyEvent(event: {
    dedupeKey: string;
    source: 'data_api' | 'polygon';
    detectedAt: Date;
    tokenId: string;
    conditionId: string;
    leaderWallet: string;
    side: 'BUY' | 'SELL';
    usdcAmount: number;
}): Promise<void> {
    try {
        await prisma.latencyEvent.create({
            data: {
                dedupeKey: event.dedupeKey,
                source: event.source,
                detectedAt: event.detectedAt,
                tokenId: event.tokenId,
                conditionId: event.conditionId,
                leaderWallet: event.leaderWallet,
                side: event.side,
                usdcAmount: event.usdcAmount,
            },
        });
    } catch (error) {
        // Ignore duplicate key errors (expected when both sources detect same trade)
        if ((error as Error).message?.includes('Unique constraint')) {
            return;
        }
        logger.error({ error, dedupeKey: event.dedupeKey }, 'Failed to record latency event');
    }
}

/**
 * Latency comparison result
 */
export interface LatencyComparison {
    dedupeKey: string;
    polygonAt: Date | null;
    dataApiAt: Date | null;
    deltaMs: number | null;  // positive = polygon faster
    winner: 'polygon' | 'data_api' | 'tie' | 'incomplete';
}

/**
 * Get recent latency comparisons
 */
export async function getRecentComparisons(limit: number = 20): Promise<LatencyComparison[]> {
    // Get recent events grouped by dedupeKey
    const events = await prisma.latencyEvent.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit * 2,  // Get more to account for pairs
    });

    // Group by dedupeKey
    const groups = new Map<string, { polygon?: Date; dataApi?: Date }>();
    for (const event of events) {
        const group = groups.get(event.dedupeKey) || {};
        if (event.source === 'polygon') {
            group.polygon = event.detectedAt;
        } else {
            group.dataApi = event.detectedAt;
        }
        groups.set(event.dedupeKey, group);
    }

    // Convert to comparisons
    const comparisons: LatencyComparison[] = [];
    for (const [dedupeKey, group] of groups) {
        if (limit <= 0) break;

        let deltaMs: number | null = null;
        let winner: LatencyComparison['winner'] = 'incomplete';

        if (group.polygon && group.dataApi) {
            deltaMs = group.dataApi.getTime() - group.polygon.getTime();
            if (deltaMs > 100) {
                winner = 'polygon';
            } else if (deltaMs < -100) {
                winner = 'data_api';
            } else {
                winner = 'tie';
            }
        }

        comparisons.push({
            dedupeKey,
            polygonAt: group.polygon || null,
            dataApiAt: group.dataApi || null,
            deltaMs,
            winner,
        });
        limit--;
    }

    return comparisons;
}

/**
 * Get aggregated latency stats
 */
export async function getLatencyStats(): Promise<{
    last24h: {
        polygonWins: number;
        dataApiWins: number;
        ties: number;
        avgDeltaMs: number | null;
        totalEvents: number;
    };
    lastWeek: {
        polygonWins: number;
        dataApiWins: number;
        ties: number;
        avgDeltaMs: number | null;
        totalEvents: number;
    };
}> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [last24hEvents, lastWeekEvents] = await Promise.all([
        prisma.latencyEvent.findMany({
            where: { createdAt: { gte: oneDayAgo } },
        }),
        prisma.latencyEvent.findMany({
            where: { createdAt: { gte: oneWeekAgo } },
        }),
    ]);

    return {
        last24h: calculateStats(last24hEvents),
        lastWeek: calculateStats(lastWeekEvents),
    };
}

function calculateStats(events: { dedupeKey: string; source: string; detectedAt: Date }[]): {
    polygonWins: number;
    dataApiWins: number;
    ties: number;
    avgDeltaMs: number | null;
    totalEvents: number;
} {
    // Group by dedupeKey
    const groups = new Map<string, { polygon?: Date; dataApi?: Date }>();
    for (const event of events) {
        const group = groups.get(event.dedupeKey) || {};
        if (event.source === 'polygon') {
            group.polygon = event.detectedAt;
        } else {
            group.dataApi = event.detectedAt;
        }
        groups.set(event.dedupeKey, group);
    }

    let polygonWins = 0;
    let dataApiWins = 0;
    let ties = 0;
    let totalDelta = 0;
    let completePairs = 0;

    for (const group of groups.values()) {
        if (group.polygon && group.dataApi) {
            completePairs++;
            const delta = group.dataApi.getTime() - group.polygon.getTime();
            totalDelta += delta;

            if (delta > 100) {
                polygonWins++;
            } else if (delta < -100) {
                dataApiWins++;
            } else {
                ties++;
            }
        }
    }

    return {
        polygonWins,
        dataApiWins,
        ties,
        avgDeltaMs: completePairs > 0 ? totalDelta / completePairs : null,
        totalEvents: groups.size,
    };
}

/**
 * Get current trigger mode from WorkerConfig
 */
export async function getTriggerMode(): Promise<'data_api' | 'polygon' | 'both'> {
    const config = await prisma.workerConfig.findUnique({
        where: { key: 'trigger_mode' },
    });

    const mode = config?.value;
    if (mode === 'polygon' || mode === 'both') {
        return mode;
    }
    return 'data_api';
}

/**
 * Set trigger mode in WorkerConfig
 */
export async function setTriggerMode(mode: 'data_api' | 'polygon' | 'both'): Promise<void> {
    await prisma.workerConfig.upsert({
        where: { key: 'trigger_mode' },
        create: { key: 'trigger_mode', value: mode },
        update: { value: mode },
    });

    logger.info({ mode }, 'Trigger mode updated');
}

/**
 * Get source health status
 */
export async function getSourceHealth(): Promise<{
    polygonHealthy: boolean;
    polygonLastEvent: Date | null;
    dataApiHealthy: boolean;
    dataApiLastEvent: Date | null;
}> {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const [polygonEvent, dataApiEvent] = await Promise.all([
        prisma.latencyEvent.findFirst({
            where: { source: 'polygon' },
            orderBy: { createdAt: 'desc' },
        }),
        prisma.latencyEvent.findFirst({
            where: { source: 'data_api' },
            orderBy: { createdAt: 'desc' },
        }),
    ]);

    return {
        polygonHealthy: polygonEvent ? polygonEvent.createdAt > fiveMinutesAgo : false,
        polygonLastEvent: polygonEvent?.createdAt || null,
        dataApiHealthy: dataApiEvent ? dataApiEvent.createdAt > fiveMinutesAgo : false,
        dataApiLastEvent: dataApiEvent?.createdAt || null,
    };
}
