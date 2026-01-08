/**
 * Stage 8.3: Paper Position Tracking
 * 
 * Authoritative paper holdings per condition/outcome.
 * Updated transactionally when PaperFill is created (not from intents or backfill).
 */

import { prisma } from '@polymarket-bot/db';
import pino from 'pino';

const logger = pino({ name: 'paper-position' });

/**
 * Get our current paper position for a condition/outcome
 * Returns 0 if no position exists
 */
export async function getPaperPosition(
    conditionId: string,
    outcome: string
): Promise<{ shares: number; costBasisUsdc: number }> {
    const position = await prisma.paperPosition.findUnique({
        where: {
            conditionId_outcome: {
                conditionId,
                outcome,
            },
        },
    });

    return {
        shares: position ? Number(position.shares) : 0,
        costBasisUsdc: position ? Number(position.costBasisUsdc) : 0,
    };
}

/**
 * Stage 8.3: Update paper position after PaperFill creation
 * 
 * For BUY fills:
 *   shares += fillShares
 *   costBasisUsdc += fillUsdc
 * 
 * For SELL fills:
 *   sellShares = min(fillShares, sharesBefore)
 *   shares -= sellShares
 *   reduce costBasisUsdc proportionally
 *   if shares hits 0, set costBasis to 0
 * 
 * Returns the position state BEFORE this update (needed for proportional sells)
 */
export async function updatePaperPosition(
    conditionId: string,
    outcome: string,
    side: 'BUY' | 'SELL',
    fillShares: number,
    fillUsdc: number
): Promise<{
    previousShares: number;
    previousCostBasis: number;
    newShares: number;
    newCostBasis: number;
}> {
    // Get current position (or default to 0)
    const existing = await prisma.paperPosition.findUnique({
        where: {
            conditionId_outcome: {
                conditionId,
                outcome,
            },
        },
    });

    const previousShares = existing ? Number(existing.shares) : 0;
    const previousCostBasis = existing ? Number(existing.costBasisUsdc) : 0;

    let newShares: number;
    let newCostBasis: number;

    if (side === 'BUY') {
        // BUY: add shares and cost basis
        newShares = previousShares + fillShares;
        newCostBasis = previousCostBasis + fillUsdc;
    } else {
        // SELL: subtract shares (clamped at 0), reduce cost basis proportionally
        const actualSellShares = Math.min(fillShares, previousShares);
        newShares = Math.max(0, previousShares - actualSellShares);

        if (previousShares > 0 && newShares > 0) {
            // Reduce cost basis proportionally
            const remainingRatio = newShares / previousShares;
            newCostBasis = previousCostBasis * remainingRatio;
        } else {
            // Position closed or was empty
            newCostBasis = 0;
        }
    }

    // Upsert the position
    await prisma.paperPosition.upsert({
        where: {
            conditionId_outcome: {
                conditionId,
                outcome,
            },
        },
        create: {
            conditionId,
            outcome,
            shares: newShares,
            costBasisUsdc: newCostBasis,
        },
        update: {
            shares: newShares,
            costBasisUsdc: newCostBasis,
        },
    });

    logger.debug({
        conditionId: conditionId.slice(0, 10) + '...',
        outcome,
        side,
        fillShares,
        fillUsdc,
        previousShares,
        newShares,
    }, 'Paper position updated');

    return {
        previousShares,
        previousCostBasis,
        newShares,
        newCostBasis,
    };
}

/**
 * Calculate proportional sell size based on leader's position reduction
 * 
 * Formula from fullproof.md:
 *   r = clamp(leaderSellSize / max(leaderPreSellShares, epsilon), 0, 1)
 *   ourSell = ourPosition * r
 */
export function calculateProportionalSellSize(
    ourShares: number,
    leaderPreSellShares: number,
    leaderSellSize: number
): number {
    if (ourShares <= 0) {
        return 0;  // No position to sell
    }

    if (leaderPreSellShares <= 0) {
        // Leader had no position before sell (shouldn't happen, but protect against division by zero)
        return 0;
    }

    // Calculate the ratio: what fraction of their position did the leader sell?
    const epsilon = 0.000001;
    const r = Math.min(1, Math.max(0, leaderSellSize / Math.max(leaderPreSellShares, epsilon)));

    // Our sell is proportional to our position
    return ourShares * r;
}

/**
 * Get all paper positions
 */
export async function getAllPaperPositions(): Promise<{
    conditionId: string;
    outcome: string;
    shares: number;
    costBasisUsdc: number;
}[]> {
    const positions = await prisma.paperPosition.findMany({
        where: {
            shares: { gt: 0 },
        },
    });

    return positions.map(p => ({
        conditionId: p.conditionId,
        outcome: p.outcome,
        shares: Number(p.shares),
        costBasisUsdc: Number(p.costBasisUsdc),
    }));
}
