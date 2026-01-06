import { NextResponse } from 'next/server';
import { prisma } from '@polymarket-bot/db';

type ChartRange = '1m' | '5m' | '30m' | '1h' | '6h' | '12h' | '24h' | '7d';

function getTimeRangeMs(range: ChartRange): number {
    switch (range) {
        case '1m': return 60 * 1000;
        case '5m': return 5 * 60 * 1000;
        case '30m': return 30 * 60 * 1000;
        case '1h': return 60 * 60 * 1000;
        case '6h': return 6 * 60 * 60 * 1000;
        case '12h': return 12 * 60 * 60 * 1000;
        case '24h': return 24 * 60 * 60 * 1000;
        case '7d': return 7 * 24 * 60 * 60 * 1000;
        default: return 60 * 60 * 1000;
    }
}

function getSampleInterval(range: ChartRange): number {
    // Return sample interval in milliseconds (0 = all points)
    switch (range) {
        case '1m': return 0;
        case '5m': return 0;
        case '30m': return 0;
        case '1h': return 60 * 1000; // 1 per minute
        case '6h': return 5 * 60 * 1000; // 1 per 5 min
        case '12h': return 10 * 60 * 1000; // 1 per 10 min
        case '24h': return 20 * 60 * 1000; // 1 per 20 min
        case '7d': return 60 * 60 * 1000; // 1 per hour
        default: return 0;
    }
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const range = (searchParams.get('range') || '1h') as ChartRange;

    const now = new Date();
    const rangeMs = getTimeRangeMs(range);
    const startTime = new Date(now.getTime() - rangeMs);

    // Get snapshots within range
    const snapshots = await prisma.pnlSnapshot.findMany({
        where: {
            timestamp: { gte: startTime },
        },
        orderBy: { timestamp: 'asc' },
    });

    // Apply sampling if needed
    const sampleInterval = getSampleInterval(range);
    let sampledSnapshots = snapshots;

    if (sampleInterval > 0 && snapshots.length > 100) {
        sampledSnapshots = [];
        let lastSampleTime = 0;

        for (const snapshot of snapshots) {
            const snapshotTime = snapshot.timestamp.getTime();
            if (snapshotTime - lastSampleTime >= sampleInterval) {
                sampledSnapshots.push(snapshot);
                lastSampleTime = snapshotTime;
            }
        }
    }

    return NextResponse.json({
        range,
        dataPoints: sampledSnapshots.map(s => ({
            timestamp: s.timestamp.toISOString(),
            unrealizedPnl: s.unrealizedPnl,
            realizedPnl: s.realizedPnl,
            totalPnl: s.totalPnl,
        })),
    });
}
