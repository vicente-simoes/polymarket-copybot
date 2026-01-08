import { NextResponse } from 'next/server';
import { prisma } from '@polymarket-bot/db';

// Fetch current market price from CLOB API
async function fetchCurrentPrice(conditionId: string, outcome: string): Promise<number | null> {
    try {
        const response = await fetch(`https://clob.polymarket.com/markets/${conditionId}`, {
            headers: { 'Accept': 'application/json' },
            next: { revalidate: 60 }, // Cache for 60 seconds
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

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get('range') || '7d';

    // Calculate date filter
    let dateFilter: Date | undefined;
    const now = new Date();
    switch (range) {
        case '24h':
            dateFilter = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            break;
        case '7d':
            dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            break;
        case '30d':
            dateFilter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            break;
        case 'all':
        default:
            dateFilter = undefined;
            break;
    }

    // Stage 9.2: Get open positions - only those with shares > 0 and not closed
    const openPositions = await prisma.position.findMany({
        where: {
            isClosed: false,
            shares: { gt: 0 },  // Only positions with actual shares
        },
        orderBy: { updatedAt: 'desc' },
    });

    // Fetch current prices for all open positions (in parallel)
    const positionsWithPrices = await Promise.all(
        openPositions.map(async (p) => {
            const currentPrice = await fetchCurrentPrice(p.conditionId, p.outcome);
            const unrealizedPnl = currentPrice !== null
                ? (currentPrice - p.avgEntryPrice) * p.shares
                : null;
            const currentValue = currentPrice !== null
                ? currentPrice * p.shares
                : null;

            return {
                id: p.id,
                marketKey: p.marketKey,
                conditionId: p.conditionId,
                outcome: p.outcome,
                title: p.title,
                shares: p.shares,
                avgEntryPrice: p.avgEntryPrice,
                totalCostBasis: p.totalCostBasis,
                currentPrice,
                unrealizedPnl,
                currentValue,
                updatedAt: p.updatedAt.toISOString(),
            };
        })
    );

    // Get closed positions with resolutions
    const closedPositions = await prisma.position.findMany({
        where: { isClosed: true },
        include: { resolutions: true },
        orderBy: { updatedAt: 'desc' },
    });

    // Get P&L history for graph
    const pnlHistory = await prisma.pnlSnapshot.findMany({
        where: dateFilter ? { timestamp: { gte: dateFilter } } : {},
        orderBy: { timestamp: 'asc' },
    });

    // Calculate totals
    const totalCostBasis = openPositions.reduce((sum, p) => sum + p.totalCostBasis, 0);
    const totalRealizedPnl = closedPositions
        .flatMap(p => p.resolutions)
        .reduce((sum, r) => sum + r.realizedPnl, 0);

    // Calculate unrealized P&L totals
    const totalUnrealizedPnl = positionsWithPrices
        .filter(p => p.unrealizedPnl !== null)
        .reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
    const totalCurrentValue = positionsWithPrices
        .filter(p => p.currentValue !== null)
        .reduce((sum, p) => sum + (p.currentValue ?? 0), 0);

    return NextResponse.json({
        openPositions: positionsWithPrices,
        closedPositions: closedPositions.map(p => ({
            id: p.id,
            marketKey: p.marketKey,
            outcome: p.outcome,
            title: p.title,
            resolutions: p.resolutions.map(r => ({
                realizedPnl: r.realizedPnl,
                resolvedOutcome: r.resolvedOutcome,
                resolvedAt: r.resolvedAt.toISOString(),
            })),
        })),
        pnlHistory: pnlHistory.map(s => ({
            timestamp: s.timestamp.toISOString(),
            totalPnl: s.totalPnl,
            unrealizedPnl: s.unrealizedPnl,
            realizedPnl: s.realizedPnl,
        })),
        summary: {
            totalCostBasis,
            totalRealizedPnl,
            totalUnrealizedPnl,
            totalCurrentValue,
            openPositionCount: openPositions.length,
            closedPositionCount: closedPositions.length,
        },
    });
}
