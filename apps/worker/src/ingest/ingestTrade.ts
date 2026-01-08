/**
 * Stage 5.2: Unified trade ingestion entrypoint
 * 
 * Both API and Polygon sources call this function to create Trade records.
 * This ensures:
 * - Consistent dedupe logic
 * - Same normalization for both sources
 * - Proper chain correlation fields when available
 * - LeaderPosition updates (Stage 8)
 */

import { prisma } from '@polymarket-bot/db';
import pino from 'pino';
import { generatePaperIntentForTrade } from '../paper.js';
import { updateLeaderPosition } from './leaderPosition.js';

const logger = pino({ name: 'ingest-trade' });

/**
 * Input for unified trade ingestion
 */
export interface IngestTradeInput {
    // Source identification
    source: 'data_api' | 'polygon';

    // Leader info
    leaderId: string;
    wallet: string;

    // Trade identity
    dedupeKey: string;
    txHash: string;
    tradeTs: Date;

    // Trade details
    side: 'BUY' | 'SELL' | 'SPLIT' | 'MERGE';
    conditionId: string;
    outcome: string;
    price: number;
    size: number;
    usdc: number;

    // Optional metadata
    title?: string | null;
    isBackfill: boolean;

    // Chain correlation (Polygon only)
    blockNumber?: number | null;
    logIndex?: number | null;

    // Raw payload for audit
    rawPayload: any;
}

/**
 * Result of trade ingestion
 */
export interface IngestTradeResult {
    tradeId: string | null;
    isNew: boolean;
    skippedReason?: string;
    // Stage 8.2: Position info for proportional sizing
    leaderPreTradeShares?: number;
    leaderNewShares?: number;
}

/**
 * Stage 5.2: Unified trade ingestion function
 * 
 * Creates Trade record with proper dedupe check, chain correlation,
 * and triggers paper intent generation for live trades.
 */
export async function ingestTrade(input: IngestTradeInput): Promise<IngestTradeResult> {
    // Check if trade already exists (by dedupe key)
    const existingTrade = await prisma.trade.findUnique({
        where: { dedupeKey: input.dedupeKey },
    });

    if (existingTrade) {
        logger.debug({
            dedupeKey: input.dedupeKey.slice(0, 30) + '...',
            source: input.source,
        }, 'Trade already exists, skipping');

        return {
            tradeId: existingTrade.id,
            isNew: false,
            skippedReason: 'DEDUPE_EXISTS'
        };
    }

    // Create raw record first
    const rawRecord = await prisma.tradeRaw.create({
        data: {
            leaderId: input.leaderId,
            source: input.source === 'data_api' ? 'data-api/activity' : 'polygon/orderFilled',
            payload: input.rawPayload,
        },
    });

    // Create normalized trade
    const newTrade = await prisma.trade.create({
        data: {
            leaderId: input.leaderId,
            dedupeKey: input.dedupeKey,
            txHash: input.txHash,
            tradeTs: input.tradeTs,
            side: input.side,
            conditionId: input.conditionId,
            outcome: input.outcome,
            leaderPrice: input.price,
            leaderSize: input.size,
            leaderUsdc: input.usdc,
            title: input.title ?? null,
            isBackfill: input.isBackfill,
            // Stage 5.1: Chain correlation fields
            blockNumber: input.blockNumber ?? null,
            logIndex: input.logIndex ?? null,
            rawId: rawRecord.id,
        },
    });

    logger.info({
        tradeId: newTrade.id,
        source: input.source,
        side: input.side,
        usdc: input.usdc.toFixed(2),
        conditionId: input.conditionId.slice(0, 10) + '...',
        isBackfill: input.isBackfill,
        hasChainData: input.blockNumber !== null,
    }, 'Trade ingested');

    // Stage 8.2: Update LeaderPosition (for BUY/SELL only, skip SPLIT/MERGE)
    let leaderPreTradeShares: number | undefined;
    let leaderNewShares: number | undefined;

    if (input.side === 'BUY' || input.side === 'SELL') {
        try {
            const positionResult = await updateLeaderPosition(
                input.leaderId,
                input.conditionId,
                input.outcome,
                input.side,
                input.size
            );
            leaderPreTradeShares = positionResult.previousShares;
            leaderNewShares = positionResult.newShares;
        } catch (error) {
            logger.warn({
                tradeId: newTrade.id,
                error: error instanceof Error ? error.message : error
            }, 'Failed to update leader position (non-fatal)');
        }
    }

    // Generate paper intent for live trades
    if (!input.isBackfill) {
        try {
            await generatePaperIntentForTrade(newTrade.id);
        } catch (error) {
            logger.warn({
                tradeId: newTrade.id,
                error: error instanceof Error ? error.message : error
            }, 'Failed to generate paper intent (non-fatal)');
        }
    }

    return {
        tradeId: newTrade.id,
        isNew: true,
        leaderPreTradeShares,
        leaderNewShares,
    };
}

/**
 * Build a standard dedupe key from trade data
 * Format: leaderWallet|txHash|side|conditionId|outcome|size|price
 */
export function buildTradeDedupeKey(
    wallet: string,
    txHash: string,
    side: string,
    conditionId: string,
    outcome: string,
    size: number,
    price: number
): string {
    return [
        wallet.toLowerCase(),
        txHash.toLowerCase(),
        side,
        conditionId,
        outcome,
        size.toString(),
        price.toString(),
    ].join('|');
}
