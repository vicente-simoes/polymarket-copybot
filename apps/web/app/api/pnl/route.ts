import { NextResponse } from 'next/server';
import { prisma } from '@polymarket-bot/db';

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

    // Get open positions
    const openPositions = await prisma.position.findMany({
        where: { isClosed: false },
        orderBy: { updatedAt: 'desc' },
    });

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

    return NextResponse.json({
        openPositions: openPositions.map(p => ({
            id: p.id,
            marketKey: p.marketKey,
            outcome: p.outcome,
            title: p.title,
            shares: p.shares,
            avgEntryPrice: p.avgEntryPrice,
            totalCostBasis: p.totalCostBasis,
            updatedAt: p.updatedAt.toISOString(),
        })),
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
            openPositionCount: openPositions.length,
            closedPositionCount: closedPositions.length,
        },
    });
}
