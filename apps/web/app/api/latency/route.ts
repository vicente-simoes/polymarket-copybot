/**
 * API endpoint for latency stats
 * GET /api/latency - Returns latency comparison statistics
 */

import { NextResponse } from 'next/server';
import { prisma } from '@polymarket-bot/db';

export async function GET() {
    try {
        // Get current trigger mode from WorkerConfig
        const triggerModeConfig = await prisma.workerConfig.findUnique({
            where: { key: 'trigger_mode' },
        });
        const triggerMode = triggerModeConfig?.value || 'data_api';

        // Get source health
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

        // Get recent events for comparison
        const recentEvents = await prisma.latencyEvent.findMany({
            orderBy: { createdAt: 'desc' },
            take: 100,
        });

        // Group by dedupeKey and calculate stats
        const groups = new Map<string, { polygon?: Date; dataApi?: Date; usdcAmount?: number; side?: string }>();
        for (const event of recentEvents) {
            const group = groups.get(event.dedupeKey) || {};
            if (event.source === 'polygon') {
                group.polygon = event.detectedAt;
            } else {
                group.dataApi = event.detectedAt;
            }
            group.usdcAmount = event.usdcAmount;
            group.side = event.side;
            groups.set(event.dedupeKey, group);
        }

        // Calculate aggregate stats
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const dayEvents = await prisma.latencyEvent.findMany({
            where: { createdAt: { gte: oneDayAgo } },
        });

        const weekEvents = await prisma.latencyEvent.findMany({
            where: { createdAt: { gte: oneWeekAgo } },
        });

        const last24hStats = calculateStats(dayEvents);
        const lastWeekStats = calculateStats(weekEvents);

        // Build recent comparisons
        const recentComparisons: Array<{
            dedupeKey: string;
            polygonAt: string | null;
            dataApiAt: string | null;
            deltaMs: number | null;
            winner: string;
            usdcAmount: number;
            side: string;
        }> = [];

        for (const [dedupeKey, group] of Array.from(groups).slice(0, 20)) {
            let deltaMs: number | null = null;
            let winner = 'incomplete';

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

            recentComparisons.push({
                dedupeKey: dedupeKey.slice(0, 20) + '...',
                polygonAt: group.polygon?.toISOString() || null,
                dataApiAt: group.dataApi?.toISOString() || null,
                deltaMs,
                winner,
                usdcAmount: group.usdcAmount || 0,
                side: group.side || 'unknown',
            });
        }

        return NextResponse.json({
            current: {
                triggerMode,
                polygonHealthy: polygonEvent ? polygonEvent.createdAt > fiveMinutesAgo : false,
                polygonLastEvent: polygonEvent?.createdAt?.toISOString() || null,
                dataApiHealthy: dataApiEvent ? dataApiEvent.createdAt > fiveMinutesAgo : false,
                dataApiLastEvent: dataApiEvent?.createdAt?.toISOString() || null,
            },
            stats: {
                last24h: last24hStats,
                lastWeek: lastWeekStats,
            },
            recentComparisons,
        });
    } catch (error) {
        console.error('Error fetching latency stats:', error);
        return NextResponse.json(
            { error: 'Failed to fetch latency stats' },
            { status: 500 }
        );
    }
}

function calculateStats(events: { dedupeKey: string; source: string; detectedAt: Date }[]) {
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
        avgDeltaMs: completePairs > 0 ? Math.round(totalDelta / completePairs) : null,
        totalEvents: groups.size,
    };
}
