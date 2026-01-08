/**
 * Stage 8.2: Leader Position Tracking
 * 
 * Tracks leader's share holdings per condition/outcome.
 * Used for proportional sell sizing (Stage 8.3).
 */

import { prisma } from '@polymarket-bot/db';
import pino from 'pino';

const logger = pino({ name: 'leader-position' });

/**
 * Result of position update
 */
export interface PositionUpdateResult {
    leaderId: string;
    conditionId: string;
    outcome: string;
    previousShares: number;
    newShares: number;
    delta: number;
}

/**
 * Stage 8.2: Update leader position after trade ingestion
 * 
 * - BUY: shares += size
 * - SELL: shares -= size (clamped at 0)
 * 
 * Returns the previous share count (needed for proportional sell calculation)
 */
export async function updateLeaderPosition(
    leaderId: string,
    conditionId: string,
    outcome: string,
    side: 'BUY' | 'SELL',
    size: number
): Promise<PositionUpdateResult> {
    // Get or create position
    const existing = await prisma.leaderPosition.findUnique({
        where: {
            leaderId_conditionId_outcome: {
                leaderId,
                conditionId,
                outcome,
            },
        },
    });

    const previousShares = existing ? Number(existing.shares) : 0;
    let newShares: number;

    if (side === 'BUY') {
        newShares = previousShares + size;
    } else {
        // SELL: subtract but clamp at 0
        newShares = Math.max(0, previousShares - size);
    }

    // Upsert the position
    await prisma.leaderPosition.upsert({
        where: {
            leaderId_conditionId_outcome: {
                leaderId,
                conditionId,
                outcome,
            },
        },
        create: {
            leaderId,
            conditionId,
            outcome,
            shares: newShares,
        },
        update: {
            shares: newShares,
        },
    });

    logger.debug({
        leaderId: leaderId.slice(0, 8) + '...',
        conditionId: conditionId.slice(0, 10) + '...',
        outcome,
        side,
        size,
        previousShares,
        newShares,
    }, 'Leader position updated');

    return {
        leaderId,
        conditionId,
        outcome,
        previousShares,
        newShares,
        delta: newShares - previousShares,
    };
}

/**
 * Get leader's current position for a condition/outcome
 */
export async function getLeaderPosition(
    leaderId: string,
    conditionId: string,
    outcome: string
): Promise<number> {
    const position = await prisma.leaderPosition.findUnique({
        where: {
            leaderId_conditionId_outcome: {
                leaderId,
                conditionId,
                outcome,
            },
        },
    });

    return position ? Number(position.shares) : 0;
}

/**
 * Get all positions for a leader
 */
export async function getLeaderPositions(leaderId: string): Promise<{
    conditionId: string;
    outcome: string;
    shares: number;
}[]> {
    const positions = await prisma.leaderPosition.findMany({
        where: { leaderId },
    });

    return positions.map(p => ({
        conditionId: p.conditionId,
        outcome: p.outcome,
        shares: Number(p.shares),
    }));
}
