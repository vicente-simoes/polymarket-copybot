// Market resolution checker - detects resolved markets and calculates realized P&L
// This module periodically checks open positions against Polymarket's API

import { prisma } from '@polymarket-bot/db';

// ============================================================================
// Types
// ============================================================================

export interface MarketResolution {
    resolved: boolean;
    winningOutcome: string | null; // "YES" or "NO" or outcome index
    closedAt?: Date;
}

export interface ResolutionResult {
    positionsChecked: number;
    positionsResolved: number;
    totalRealizedPnl: number;
}

// ============================================================================
// API Integration
// ============================================================================

// API response shape from Polymarket
interface PolymarketMarketResponse {
    closed?: boolean;
    resolved?: boolean;
    winning_outcome?: string;
    winningOutcome?: string;
    closed_at?: string;
}

/**
 * Fetch market resolution status from Polymarket CLOB API
 * Returns null if market is not resolved
 */
async function fetchMarketResolution(conditionId: string): Promise<MarketResolution | null> {
    try {
        // Polymarket CLOB API endpoint
        const response = await fetch(`https://clob.polymarket.com/markets/${conditionId}`, {
            headers: {
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            // Market might not exist or API error
            return null;
        }

        const data = await response.json() as PolymarketMarketResponse;

        // Check if market is closed/resolved
        // The API returns different fields depending on market state
        if (data.closed || data.resolved) {
            return {
                resolved: true,
                winningOutcome: data.winning_outcome || data.winningOutcome || null,
                closedAt: data.closed_at ? new Date(data.closed_at) : new Date(),
            };
        }

        return null;
    } catch (error) {
        // Network error or invalid response - treat as not resolved
        console.error(`Failed to fetch resolution for ${conditionId}:`, error);
        return null;
    }
}

// ============================================================================
// Resolution Logic
// ============================================================================

/**
 * Check all open positions for market resolutions
 * When a market resolves, calculate realized P&L and record the resolution
 */
export async function checkMarketResolutions(): Promise<ResolutionResult> {
    // Get all open positions
    const openPositions = await prisma.position.findMany({
        where: { isClosed: false },
    });

    let positionsResolved = 0;
    let totalRealizedPnl = 0;

    for (const position of openPositions) {
        try {
            // Fetch market status from Polymarket API
            const resolution = await fetchMarketResolution(position.conditionId);

            if (resolution?.resolved && resolution.winningOutcome) {
                // Calculate resolution price based on outcome
                // If our outcome won, price = 1.00; if it lost, price = 0.00
                const ourOutcomeWon = position.outcome.toUpperCase() === resolution.winningOutcome.toUpperCase();
                const resolutionPrice = ourOutcomeWon ? 1.0 : 0.0;

                // Calculate realized P&L
                // Final value = shares × resolution price
                // P&L = final value - cost basis
                const finalValue = position.shares * resolutionPrice;
                const realizedPnl = finalValue - position.totalCostBasis;

                // Record the resolution
                await prisma.resolution.create({
                    data: {
                        positionId: position.id,
                        resolvedOutcome: resolution.winningOutcome,
                        resolutionPrice,
                        realizedPnl,
                        resolvedAt: resolution.closedAt || new Date(),
                    },
                });

                // Mark position as closed
                await prisma.position.update({
                    where: { id: position.id },
                    data: { isClosed: true },
                });

                positionsResolved++;
                totalRealizedPnl += realizedPnl;

                console.log(`Market resolved: ${position.title || position.marketKey}`, {
                    outcome: position.outcome,
                    winningOutcome: resolution.winningOutcome,
                    shares: position.shares,
                    costBasis: position.totalCostBasis,
                    finalValue,
                    realizedPnl,
                    won: ourOutcomeWon,
                });
            }

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            console.error(`Error checking resolution for position ${position.id}:`, error);
            // Continue checking other positions
        }
    }

    return {
        positionsChecked: openPositions.length,
        positionsResolved,
        totalRealizedPnl,
    };
}

/**
 * Get summary of all resolutions
 */
export async function getResolutionSummary() {
    const resolutions = await prisma.resolution.findMany({
        include: { position: true },
        orderBy: { resolvedAt: 'desc' },
    });

    const totalRealizedPnl = resolutions.reduce((sum, r) => sum + r.realizedPnl, 0);
    const wins = resolutions.filter(r => r.realizedPnl > 0).length;
    const losses = resolutions.filter(r => r.realizedPnl <= 0).length;
    const winRate = resolutions.length > 0 ? (wins / resolutions.length) * 100 : 0;

    const bestTrade = resolutions.reduce((best, r) =>
        r.realizedPnl > (best?.realizedPnl || -Infinity) ? r : best,
        resolutions[0] || null
    );

    const worstTrade = resolutions.reduce((worst, r) =>
        r.realizedPnl < (worst?.realizedPnl || Infinity) ? r : worst,
        resolutions[0] || null
    );

    return {
        totalResolutions: resolutions.length,
        totalRealizedPnl,
        wins,
        losses,
        winRate,
        bestTrade: bestTrade ? {
            market: bestTrade.position.title || bestTrade.position.marketKey,
            pnl: bestTrade.realizedPnl,
        } : null,
        worstTrade: worstTrade ? {
            market: worstTrade.position.title || worstTrade.position.marketKey,
            pnl: worstTrade.realizedPnl,
        } : null,
        recentResolutions: resolutions.slice(0, 10).map(r => ({
            market: r.position.title || r.position.marketKey,
            outcome: r.position.outcome,
            winningOutcome: r.resolvedOutcome,
            realizedPnl: r.realizedPnl,
            resolvedAt: r.resolvedAt,
        })),
    };
}
