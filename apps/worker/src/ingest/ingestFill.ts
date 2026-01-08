/**
 * Unified Fill Ingestion - fix_plan.md Step 3
 * 
 * Single code path for processing fills from any source.
 * All sources (API real-time, API backfill, Polygon WS) call this function.
 * 
 * Responsibilities:
 * - Enforce dedupe/idempotency via dedupeKey
 * - Store to LeaderFill table (unified registry)
 * - Optionally store to Trade table (for API source compatibility)
 * - Record latency events for comparison
 * - Update "seen times" fields for reconciliation
 */

import { prisma } from '@polymarket-bot/db';
import pino from 'pino';
import { recordLatencyEvent } from '../latencyTracker.js';
import { resolveMapping } from '../mapping.js';
import { captureQuote } from '../quotes.js';
import { generatePaperIntentForTrade } from '../paper.js';

const logger = pino({ name: 'ingest-fill' });

/**
 * Source of the fill data
 */
export type FillSource = 'data_api' | 'polygon' | 'chain_fallback';

/**
 * Normalized fill input for ingestion
 * This is the interface all sources must conform to
 */
export interface NormalizedFill {
    // Identity
    leaderId: string;
    leaderWallet: string;

    // Source metadata
    source: FillSource;
    dedupeKey: string;  // Unique key for deduplication

    // Chain identity (optional - available from Polygon)
    exchangeAddress?: string;
    blockNumber?: number;
    txHash?: string;
    logIndex?: number;
    orderHash?: string;

    // Participants (optional - available from Polygon)
    maker?: string;
    taker?: string;
    leaderRole?: 'maker' | 'taker' | 'unknown';

    // Trade details (required)
    tokenId: string;
    conditionId: string;
    outcome: string;
    side: 'BUY' | 'SELL';
    leaderPrice: number;
    leaderSize: number;    // shares
    leaderUsdc: number;    // USDC amount

    // Timestamps
    fillTs: Date;          // When the fill happened

    // Metadata
    title?: string;
    isBackfill?: boolean;  // True if this is historical data

    // Raw payload for storage
    rawPayload: unknown;
}

/**
 * Result of fill ingestion
 */
export interface IngestResult {
    ingested: boolean;          // True if newly ingested
    duplicate: boolean;         // True if already existed
    leaderFillId?: string;      // ID of the LeaderFill record
    tradeId?: string;           // ID of the Trade record (API source only)
    error?: string;             // Error message if failed
}

/**
 * Options for ingestion behavior
 */
export interface IngestOptions {
    // If true, also create a Trade record (for backwards compatibility with API source)
    createTradeRecord?: boolean;

    // If true, generate paper intent for non-backfill trades
    generatePaperIntent?: boolean;

    // If true, capture quote for the market
    captureQuote?: boolean;
}

const DEFAULT_OPTIONS: IngestOptions = {
    createTradeRecord: false,
    generatePaperIntent: true,
    captureQuote: true,
};

/**
 * Ingest a fill from any source
 * This is the unified entry point for all fill ingestion
 */
export async function ingestFill(
    fill: NormalizedFill,
    options: IngestOptions = {}
): Promise<IngestResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const detectedAt = new Date();

    // Step 1: Check for existing fill (dedupe)
    const existingFill = await prisma.leaderFill.findUnique({
        where: { dedupeKey: fill.dedupeKey },
    });

    if (existingFill) {
        // Already exists - dedupe prevents double counting
        // Note: In a future iteration, we could track apiSeenAt/chainSeenAt for reconciliation
        logger.debug({
            dedupeKey: fill.dedupeKey,
            source: fill.source,
            existingSource: existingFill.source,
        }, 'Fill already exists (duplicate)');

        return {
            ingested: false,
            duplicate: true,
            leaderFillId: existingFill.id,
        };
    }

    try {
        // Step 2: Store raw payload
        const rawRecord = await prisma.leaderFillRaw.create({
            data: {
                source: fill.source === 'chain_fallback' ? 'polygon' : fill.source,
                payload: fill.rawPayload as any,
            },
        });

        // Step 3: Create LeaderFill record
        const leaderFill = await prisma.leaderFill.create({
            data: {
                leaderId: fill.leaderId,
                source: fill.source === 'chain_fallback' ? 'polygon' : fill.source,

                // Chain identity
                exchangeAddress: fill.exchangeAddress,
                blockNumber: fill.blockNumber,
                txHash: fill.txHash,
                logIndex: fill.logIndex,
                orderHash: fill.orderHash,

                // Participants
                maker: fill.maker,
                taker: fill.taker,
                leaderRole: fill.leaderRole || 'unknown',

                // Trade details
                tokenId: fill.tokenId,
                conditionId: fill.conditionId,
                outcome: fill.outcome,
                side: fill.side,
                leaderPrice: fill.leaderPrice,
                leaderSize: fill.leaderSize,
                leaderUsdc: fill.leaderUsdc,

                // Timestamps
                fillTs: fill.fillTs,
                detectedAt,
                // Note: firstSeenAt, apiSeenAt, chainSeenAt would be added in future schema migration

                // Metadata
                title: fill.title,
                isBackfill: fill.isBackfill || false,

                // Links
                dedupeKey: fill.dedupeKey,
                rawId: rawRecord.id,
            },
        });

        let tradeId: string | undefined;

        // Step 4: Optionally create Trade record (for API source compatibility)
        if (opts.createTradeRecord && fill.source === 'data_api') {
            // Build trade dedupe key (different format than LeaderFill dedupe key)
            const tradeDedupeKey = fill.dedupeKey.replace(/^data_api:/, '');

            const existingTrade = await prisma.trade.findUnique({
                where: { dedupeKey: tradeDedupeKey },
            });

            if (!existingTrade) {
                // Create raw record for Trade table
                const tradeRaw = await prisma.tradeRaw.create({
                    data: {
                        leaderId: fill.leaderId,
                        source: 'data-api/ingest',
                        payload: fill.rawPayload as any,
                    },
                });

                const trade = await prisma.trade.create({
                    data: {
                        leaderId: fill.leaderId,
                        dedupeKey: tradeDedupeKey,
                        txHash: fill.txHash || '',
                        tradeTs: fill.fillTs,
                        side: fill.side,
                        conditionId: fill.conditionId,
                        outcome: fill.outcome,
                        leaderPrice: fill.leaderPrice,
                        leaderSize: fill.leaderSize,
                        leaderUsdc: fill.leaderUsdc,
                        title: fill.title || null,
                        isBackfill: fill.isBackfill || false,
                        rawId: tradeRaw.id,
                    },
                });
                tradeId = trade.id;
            }
        }

        // Step 5: Record latency event
        await recordLatencyEvent({
            dedupeKey: (fill.txHash || fill.dedupeKey).toLowerCase(),
            source: fill.source === 'chain_fallback' ? 'polygon' : fill.source,
            detectedAt,
            tokenId: fill.tokenId,
            conditionId: fill.conditionId,
            leaderWallet: fill.leaderWallet,
            side: fill.side,
            usdcAmount: fill.leaderUsdc,
        });

        // Step 6: Post-processing (if not backfill)
        if (!fill.isBackfill) {
            // Resolve mapping and capture quote
            if (opts.captureQuote) {
                const mapping = await resolveMapping(fill.conditionId, fill.outcome);
                if (mapping) {
                    await captureQuote(mapping);
                }
            }

            // Generate paper intent
            if (opts.generatePaperIntent && tradeId) {
                await generatePaperIntentForTrade(tradeId);
            }
        }

        logger.info({
            source: fill.source,
            leaderId: fill.leaderId,
            side: fill.side,
            price: fill.leaderPrice.toFixed(4),
            usdc: fill.leaderUsdc.toFixed(2),
            title: fill.title?.slice(0, 30),
            isBackfill: fill.isBackfill,
        }, 'Fill ingested successfully');

        return {
            ingested: true,
            duplicate: false,
            leaderFillId: leaderFill.id,
            tradeId,
        };

    } catch (error) {
        // Handle unique constraint violations (race condition)
        if (error instanceof Error && error.message.includes('Unique constraint')) {
            logger.debug({ dedupeKey: fill.dedupeKey }, 'Fill already exists (race condition)');
            return {
                ingested: false,
                duplicate: true,
            };
        }

        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error({
            dedupeKey: fill.dedupeKey,
            error: errorMsg,
        }, 'Failed to ingest fill');

        return {
            ingested: false,
            duplicate: false,
            error: errorMsg,
        };
    }
}

/**
 * Convert a Polymarket API activity to a NormalizedFill
 */
export function normalizeApiActivity(
    leaderId: string,
    leaderWallet: string,
    activity: {
        transactionHash: string;
        timestamp: number;
        side: 'BUY' | 'SELL';
        conditionId: string;
        outcome: string;
        price: number;
        size: number;
        usdcSize: number;
        asset?: string;
        title?: string;
    },
    isBackfill: boolean = false
): NormalizedFill {
    // Build dedupe key that matches the existing format
    const baseDedupeKey = [
        leaderWallet.toLowerCase(),
        activity.transactionHash,
        activity.side,
        activity.conditionId,
        activity.outcome,
        activity.size,
        activity.price,
    ].join('|');

    return {
        leaderId,
        leaderWallet: leaderWallet.toLowerCase(),
        source: 'data_api',
        dedupeKey: `data_api:${baseDedupeKey}`,

        txHash: activity.transactionHash,

        tokenId: activity.asset || 'unknown',
        conditionId: activity.conditionId,
        outcome: activity.outcome,
        side: activity.side,
        leaderPrice: activity.price,
        leaderSize: activity.size,
        leaderUsdc: activity.usdcSize,

        fillTs: new Date(activity.timestamp * 1000),

        title: activity.title,
        isBackfill,

        rawPayload: activity,
    };
}

/**
 * Batch ingest multiple fills
 * Useful for backfill operations
 */
export async function ingestFillBatch(
    fills: NormalizedFill[],
    options: IngestOptions = {}
): Promise<{
    total: number;
    ingested: number;
    duplicates: number;
    errors: number;
}> {
    let ingested = 0;
    let duplicates = 0;
    let errors = 0;

    for (const fill of fills) {
        const result = await ingestFill(fill, options);
        if (result.ingested) {
            ingested++;
        } else if (result.duplicate) {
            duplicates++;
        } else if (result.error) {
            errors++;
        }
    }

    return {
        total: fills.length,
        ingested,
        duplicates,
        errors,
    };
}
