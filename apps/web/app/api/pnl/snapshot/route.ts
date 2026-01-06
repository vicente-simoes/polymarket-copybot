import { NextResponse } from 'next/server';
import { prisma } from '@polymarket-bot/db';

// Fetch current market price from CLOB API
async function fetchCurrentPrice(conditionId: string, outcome: string): Promise<number | null> {
    try {
        const response = await fetch(`https://clob.polymarket.com/markets/${conditionId}`, {
            headers: { 'Accept': 'application/json' },
        });

        if (!response.ok) return null;

        const data = await response.json();
        const token = data.tokens?.find((t: { outcome: string; price: number }) =>
            t.outcome.toUpperCase() === outcome.toUpperCase()
        );

        return token?.price ?? null;
    } catch {
        return null;
    }
}

export async function POST() {
    try {
        // Get all open positions
        const openPositions = await prisma.position.findMany({
            where: { isClosed: false },
        });

        if (openPositions.length === 0) {
            return NextResponse.json({ success: true, message: 'No open positions' });
        }

        // Calculate unrealized P&L by fetching live prices
        let totalUnrealizedPnl = 0;
        let totalCostBasis = 0;
        let totalCurrentValue = 0;

        for (const pos of openPositions) {
            const currentPrice = await fetchCurrentPrice(pos.conditionId, pos.outcome);
            if (currentPrice !== null) {
                totalUnrealizedPnl += (currentPrice - pos.avgEntryPrice) * pos.shares;
                totalCurrentValue += currentPrice * pos.shares;
            }
            totalCostBasis += pos.totalCostBasis;
        }

        // Get realized P&L from resolutions
        const resolutions = await prisma.resolution.findMany();
        const totalRealizedPnl = resolutions.reduce((sum, r) => sum + r.realizedPnl, 0);

        // Create snapshot
        await prisma.pnlSnapshot.create({
            data: {
                totalCostBasis,
                unrealizedPnl: totalUnrealizedPnl,
                realizedPnl: totalRealizedPnl,
                totalPnl: totalUnrealizedPnl + totalRealizedPnl,
                positionCount: openPositions.length,
            },
        });

        return NextResponse.json({
            success: true,
            unrealizedPnl: totalUnrealizedPnl,
            realizedPnl: totalRealizedPnl,
            totalPnl: totalUnrealizedPnl + totalRealizedPnl,
            positionCount: openPositions.length,
        });
    } catch (error) {
        console.error('Failed to record P&L snapshot:', error);
        return NextResponse.json({ success: false, error: 'Failed to record snapshot' }, { status: 500 });
    }
}
