// Position tracking service - Track accumulated shares per market for P&L calculations
// This module handles position updates for all operation types (BUY, SELL, SPLIT, MERGE)

import { prisma } from '@polymarket-bot/db';
import { OperationType } from './settings.js';

// Re-export for external convenience
export { OperationType };


export interface PositionUpdate {
    marketKey: string;
    conditionId: string;
    outcome: string;
    title?: string;
    operationType: OperationType;
    shares: number;
    price: number;
}

// ============================================================================
// Update Position
// ============================================================================

export async function updatePosition(fill: PositionUpdate) {
    const { marketKey, outcome, operationType, shares, price, conditionId, title } = fill;

    // Find or create position
    let position = await prisma.position.findUnique({
        where: { marketKey_outcome: { marketKey, outcome } }
    });

    if (!position) {
        position = await prisma.position.create({
            data: {
                marketKey,
                outcome,
                conditionId,
                title,
                shares: 0,
                avgEntryPrice: 0,
                totalCostBasis: 0,
            }
        });
    }

    switch (operationType) {
        case 'BUY': {
            const newShares = position.shares + shares;
            const newCostBasis = position.totalCostBasis + (shares * price);
            const newAvgPrice = newShares > 0 ? newCostBasis / newShares : 0;

            await prisma.position.update({
                where: { id: position.id },
                data: {
                    shares: newShares,
                    totalCostBasis: newCostBasis,
                    avgEntryPrice: newAvgPrice,
                    isClosed: false,
                }
            });
            break;
        }

        case 'SELL': {
            const sellShares = Math.min(shares, position.shares);
            const realizedPnl = (price - position.avgEntryPrice) * sellShares;
            const newShares = position.shares - sellShares;
            const newCostBasis = newShares * position.avgEntryPrice;

            await prisma.position.update({
                where: { id: position.id },
                data: {
                    shares: newShares,
                    totalCostBasis: newCostBasis,
                    isClosed: newShares === 0,
                }
            });

            // Record realized P&L if position closed or partial close
            if (sellShares > 0) {
                await recordRealizedPnl(position.id, 'SELL', price, realizedPnl);
            }
            break;
        }

        case 'SPLIT': {
            // SPLIT converts shares from one outcome to both outcomes
            // Typically: YES shares -> YES + NO (hedging)
            // Cost basis is redistributed proportionally
            // For now, log and track - implementation depends on Polymarket's exact mechanics
            console.log(`SPLIT operation on ${marketKey}/${outcome}: ${shares} shares at $${price}`);

            // The split typically doesn't change total value, just redistributes
            // Keep position as-is for tracking, but note the operation occurred
            break;
        }

        case 'MERGE': {
            // MERGE combines YES + NO shares to exit at $1 total
            // Find complementary position and combine
            const complementaryOutcome = outcome === 'YES' ? 'NO' : 'YES';
            const complementary = await prisma.position.findUnique({
                where: { marketKey_outcome: { marketKey, outcome: complementaryOutcome } }
            });

            if (complementary && complementary.shares > 0) {
                // Merge redeems at $1.00 per pair
                const mergeShares = Math.min(position.shares, complementary.shares, shares);
                const redeemValue = mergeShares * 1.0; // $1 per merged pair
                const combinedCost = (position.avgEntryPrice + complementary.avgEntryPrice) * mergeShares;
                const mergePnl = redeemValue - combinedCost;

                // Update both positions
                const newShares = position.shares - mergeShares;
                const newCompShares = complementary.shares - mergeShares;

                await prisma.position.update({
                    where: { id: position.id },
                    data: {
                        shares: newShares,
                        totalCostBasis: newShares * position.avgEntryPrice,
                        isClosed: newShares === 0,
                    }
                });

                await prisma.position.update({
                    where: { id: complementary.id },
                    data: {
                        shares: newCompShares,
                        totalCostBasis: newCompShares * complementary.avgEntryPrice,
                        isClosed: newCompShares === 0,
                    }
                });

                // Record the merge P&L
                await recordRealizedPnl(position.id, 'MERGE', 1.0, mergePnl);
            } else {
                console.log(`MERGE operation on ${marketKey}/${outcome}: no complementary position found`);
            }
            break;
        }
    }

    // Record P&L snapshot after any position change
    await recordPnlSnapshot();
}

// ============================================================================
// Record Realized P&L
// ============================================================================

async function recordRealizedPnl(
    positionId: string,
    resolvedOutcome: string,
    resolutionPrice: number,
    realizedPnl: number
) {
    await prisma.resolution.create({
        data: {
            positionId,
            resolvedOutcome,
            resolutionPrice,
            realizedPnl,
        }
    });
}

// ============================================================================
// Record P&L Snapshot (for historical graphs)
// ============================================================================

export async function recordPnlSnapshot() {
    const positions = await prisma.position.findMany({
        where: { isClosed: false }
    });

    const totalCostBasis = positions.reduce((sum, p) => sum + p.totalCostBasis, 0);

    // For unrealized P&L, would need current market prices
    // Simplified: just track cost basis changes for now
    // TODO: Fetch current prices and calculate unrealized P&L
    const unrealizedPnl = 0;

    const resolutions = await prisma.resolution.findMany();
    const realizedPnl = resolutions.reduce((sum, r) => sum + r.realizedPnl, 0);

    await prisma.pnlSnapshot.create({
        data: {
            totalCostBasis,
            unrealizedPnl,
            realizedPnl,
            totalPnl: unrealizedPnl + realizedPnl,
            positionCount: positions.length,
        }
    });
}

// ============================================================================
// Get Position Summary
// ============================================================================

export async function getOpenPositions() {
    return prisma.position.findMany({
        where: { isClosed: false },
        orderBy: { updatedAt: 'desc' },
    });
}

export async function getClosedPositions() {
    return prisma.position.findMany({
        where: { isClosed: true },
        include: { resolutions: true },
        orderBy: { updatedAt: 'desc' },
    });
}

export async function getPositionSummary() {
    const openPositions = await getOpenPositions();
    const closedPositions = await getClosedPositions();

    const totalCostBasis = openPositions.reduce((sum, p) => sum + p.totalCostBasis, 0);
    const totalRealizedPnl = closedPositions
        .flatMap(p => p.resolutions)
        .reduce((sum, r) => sum + r.realizedPnl, 0);

    return {
        openPositions,
        closedPositions,
        summary: {
            totalCostBasis,
            totalRealizedPnl,
            openPositionCount: openPositions.length,
            closedPositionCount: closedPositions.length,
        }
    };
}
