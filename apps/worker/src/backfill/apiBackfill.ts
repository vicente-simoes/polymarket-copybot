/**
 * API Backfill Module - fix_plan.md Step 2
 * 
 * Handles startup backfill and catch-up operations via Polymarket API.
 * This replaces the Polygon RPC getLogs backfill to avoid 429 rate limits.
 * 
 * Responsibilities:
 * - For each enabled leader wallet: read cursor from DB, fetch fills since cursor
 * - Paginate through results
 * - Ingest fills idempotently
 * - Update cursor
 * - Rate limit + bounded concurrency
 * - Retry with backoff on 429/5xx from API
 */

import { prisma } from '@polymarket-bot/db';
import pino from 'pino';
import { getConfig } from '../config.js';
import { fetchWalletActivity, buildDedupeKey, type PolymarketActivity } from '../polymarket.js';
import { resolveMapping } from '../mapping.js';
import { captureQuote } from '../quotes.js';
import { generatePaperIntentForTrade } from '../paper.js';
import { withRetry, sleep } from '../retry.js';
import { recordLatencyEvent } from '../latencyTracker.js';

const logger = pino({ name: 'api-backfill' });

/**
 * Cursor stored in DB for API backfill progress tracking
 */
interface LeaderCursor {
    leaderId: string;
    lastSeenTimestamp: number;  // Unix timestamp in seconds
    lastSeenTradeId?: string;   // If API provides monotonic IDs
}

/**
 * Result of a backfill operation for a single leader
 */
interface BackfillResult {
    leaderId: string;
    leaderLabel: string;
    tradesIngested: number;
    cursorUpdated: boolean;
    error?: string;
}

/**
 * Run API backfill for all enabled leaders
 * This is the main entry point called on worker startup
 */
export async function runApiBackfill(): Promise<{
    totalIngested: number;
    leadersProcessed: number;
    errors: number;
}> {
    const config = getConfig();

    if (!config.apiBackfillOnStartup) {
        logger.info('API backfill disabled (API_BACKFILL_ON_STARTUP=false)');
        return { totalIngested: 0, leadersProcessed: 0, errors: 0 };
    }

    logger.info({
        lookbackMinutes: config.apiBackfillStartupLookbackMinutes,
        pageSize: config.apiBackfillPageSize,
        rateLimitRps: config.apiBackfillRateLimitRps,
        maxConcurrency: config.apiBackfillMaxConcurrency,
    }, 'Starting API backfill...');

    // Load enabled leaders
    const leaders = await prisma.leader.findMany({
        where: { enabled: true },
        select: { id: true, wallet: true, label: true },
    });

    if (leaders.length === 0) {
        logger.info('No enabled leaders found for backfill');
        return { totalIngested: 0, leadersProcessed: 0, errors: 0 };
    }

    logger.info({ leaderCount: leaders.length }, 'Found leaders for backfill');

    // Process leaders with bounded concurrency
    const results: BackfillResult[] = [];
    const delayBetweenLeadersMs = 1000 / config.apiBackfillRateLimitRps;

    // Process in batches based on maxConcurrency
    for (let i = 0; i < leaders.length; i += config.apiBackfillMaxConcurrency) {
        const batch = leaders.slice(i, i + config.apiBackfillMaxConcurrency);

        const batchResults = await Promise.all(
            batch.map(leader => backfillForLeader(leader.id, leader.wallet, leader.label))
        );

        results.push(...batchResults);

        // Rate limit between batches
        if (i + config.apiBackfillMaxConcurrency < leaders.length) {
            await sleep(delayBetweenLeadersMs * config.apiBackfillMaxConcurrency);
        }
    }

    // Summarize results
    const totalIngested = results.reduce((sum, r) => sum + r.tradesIngested, 0);
    const errors = results.filter(r => r.error).length;

    logger.info({
        totalIngested,
        leadersProcessed: leaders.length,
        errors,
    }, 'API backfill complete');

    return { totalIngested, leadersProcessed: leaders.length, errors };
}

/**
 * Backfill trades for a single leader
 */
async function backfillForLeader(
    leaderId: string,
    wallet: string,
    label: string
): Promise<BackfillResult> {
    const config = getConfig();
    const result: BackfillResult = {
        leaderId,
        leaderLabel: label,
        tradesIngested: 0,
        cursorUpdated: false,
    };

    try {
        // Get cursor from DB (stored timestamp of last seen trade)
        const cursor = await getLeaderCursor(leaderId);
        const lookbackSeconds = config.apiBackfillStartupLookbackMinutes * 60;
        const nowSeconds = Math.floor(Date.now() / 1000);

        // If we have a cursor, use it; otherwise use lookback window
        const fetchSinceTimestamp = cursor?.lastSeenTimestamp
            ? cursor.lastSeenTimestamp - 60  // Overlap by 60 seconds for safety
            : nowSeconds - lookbackSeconds;

        logger.info({
            leader: label,
            wallet,
            hasCursor: !!cursor,
            fetchSinceTimestamp,
            lookbackMinutes: cursor ? 'from cursor' : config.apiBackfillStartupLookbackMinutes,
        }, 'Starting backfill for leader');

        // Fetch trades from API
        // The Polymarket API doesn't support cursor-based pagination,
        // so we fetch the maximum amount and filter by timestamp
        const activities = await withRetry(
            () => fetchWalletActivity(wallet, config.apiBackfillPageSize),
            `backfill:${label}`,
            { maxRetries: 5, baseDelayMs: 2000, maxDelayMs: 30000 }
        );

        if (activities.length === 0) {
            logger.debug({ leader: label }, 'No trades found for backfill');
            return result;
        }

        // Filter to trades since our cursor (with overlap for deduplication)
        const newActivities = activities.filter(
            a => a.timestamp >= fetchSinceTimestamp
        );

        if (newActivities.length === 0) {
            logger.debug({ leader: label }, 'No new trades since cursor');
            return result;
        }

        logger.info({
            leader: label,
            totalFetched: activities.length,
            newSinceCursor: newActivities.length,
        }, 'Fetched trades for backfill');

        // Check if this is initial backfill (no existing trades)
        const existingTradeCount = await prisma.trade.count({
            where: { leaderId },
        });
        const isInitialBackfill = existingTradeCount === 0;

        // Ingest each trade idempotently
        let latestTimestamp = cursor?.lastSeenTimestamp || 0;

        for (const activity of newActivities) {
            const wasIngested = await ingestActivityIdempotently(
                leaderId,
                wallet,
                activity,
                isInitialBackfill
            );

            if (wasIngested) {
                result.tradesIngested++;
            }

            // Track latest timestamp for cursor update
            if (activity.timestamp > latestTimestamp) {
                latestTimestamp = activity.timestamp;
            }
        }

        // Update cursor if we processed any trades
        if (latestTimestamp > (cursor?.lastSeenTimestamp || 0)) {
            await updateLeaderCursor(leaderId, latestTimestamp);
            result.cursorUpdated = true;
        }

        logger.info({
            leader: label,
            tradesIngested: result.tradesIngested,
            cursorUpdated: result.cursorUpdated,
            newCursor: latestTimestamp,
        }, 'Backfill complete for leader');

    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.error = errorMsg;
        logger.error({
            leader: label,
            error: errorMsg,
        }, 'Backfill failed for leader');
    }

    return result;
}

/**
 * Ingest a single activity idempotently
 * Returns true if the trade was newly ingested, false if it already existed
 */
async function ingestActivityIdempotently(
    leaderId: string,
    wallet: string,
    activity: PolymarketActivity,
    isBackfill: boolean
): Promise<boolean> {
    const dedupeKey = buildDedupeKey(wallet, activity);

    // Check if trade already exists
    const existingTrade = await prisma.trade.findUnique({
        where: { dedupeKey },
    });

    if (existingTrade) {
        return false; // Already exists
    }

    try {
        // Store raw payload
        const rawRecord = await prisma.tradeRaw.create({
            data: {
                leaderId,
                source: 'data-api/backfill',
                payload: activity as any,
            },
        });

        // Store normalized trade
        const newTrade = await prisma.trade.create({
            data: {
                leaderId,
                dedupeKey,
                txHash: activity.transactionHash,
                tradeTs: new Date(activity.timestamp * 1000),
                side: activity.side,
                conditionId: activity.conditionId,
                outcome: activity.outcome,
                leaderPrice: activity.price,
                leaderSize: activity.size,
                leaderUsdc: activity.usdcSize,
                title: activity.title || null,
                isBackfill,
                rawId: rawRecord.id,
            },
        });

        // Create LeaderFill record (Unified Registry)
        const leaderFillDedupeKey = `data_api:${dedupeKey}`;
        const leaderFillRaw = await prisma.leaderFillRaw.create({
            data: {
                source: 'data_api',  // Using data_api (backfill is tracked via isBackfill flag)
                payload: activity as any,
            }
        });

        await prisma.leaderFill.create({
            data: {
                leaderId,
                source: 'data_api',
                leaderRole: 'unknown',
                txHash: activity.transactionHash,
                tokenId: activity.asset || 'unknown',
                conditionId: activity.conditionId,
                outcome: activity.outcome,
                side: activity.side,
                leaderPrice: activity.price,
                leaderSize: activity.size,
                leaderUsdc: activity.usdcSize,
                fillTs: new Date(activity.timestamp * 1000),
                detectedAt: new Date(),
                title: activity.title || null,
                isBackfill,
                dedupeKey: leaderFillDedupeKey,
                rawId: leaderFillRaw.id,
            }
        }).catch(err => {
            // Ignore duplicates
            if (err.code !== 'P2002') {
                logger.error({ error: err, dedupeKey }, 'Failed to create LeaderFill');
            }
        });

        // Record latency event
        await recordLatencyEvent({
            dedupeKey: activity.transactionHash.toLowerCase(),
            source: 'data_api',
            detectedAt: new Date(),
            tokenId: activity.asset || '',
            conditionId: activity.conditionId,
            leaderWallet: wallet.toLowerCase(),
            side: activity.side,
            usdcAmount: activity.usdcSize,
        });

        // Resolve mapping and capture quote (if not backfill)
        if (!isBackfill) {
            const mapping = await resolveMapping(activity.conditionId, activity.outcome);
            if (mapping) {
                await captureQuote(mapping);
                await generatePaperIntentForTrade(newTrade.id);
            } else {
                await generatePaperIntentForTrade(newTrade.id);
            }
        }

        logger.debug({
            wallet,
            txHash: activity.transactionHash,
            side: activity.side,
            isBackfill,
        }, 'Ingested trade via API backfill');

        return true;

    } catch (error) {
        // Handle unique constraint violation (race condition)
        if (error instanceof Error && error.message.includes('Unique constraint')) {
            return false;
        }
        throw error;
    }
}

/**
 * Get the cursor for a leader from DB
 */
async function getLeaderCursor(leaderId: string): Promise<LeaderCursor | null> {
    // We'll use the ApiCursor table to store per-leader cursors
    // If it doesn't exist, we'll create the table via migration
    // For now, use a simple approach with the existing SystemLock pattern

    const cursorKey = `api_cursor:${leaderId}`;

    try {
        const cursorRecord = await prisma.systemLock.findUnique({
            where: { lockKey: cursorKey },
        });

        if (!cursorRecord) {
            return null;
        }

        // Parse cursor from lockValue (stored as JSON)
        const cursorData = JSON.parse(cursorRecord.lockValue);
        return {
            leaderId,
            lastSeenTimestamp: cursorData.lastSeenTimestamp,
            lastSeenTradeId: cursorData.lastSeenTradeId,
        };
    } catch {
        return null;
    }
}

/**
 * Update the cursor for a leader in DB
 */
async function updateLeaderCursor(leaderId: string, lastSeenTimestamp: number): Promise<void> {
    const cursorKey = `api_cursor:${leaderId}`;
    const cursorValue = JSON.stringify({
        lastSeenTimestamp,
        updatedAt: new Date().toISOString(),
    });

    await prisma.systemLock.upsert({
        where: { lockKey: cursorKey },
        create: {
            lockKey: cursorKey,
            lockValue: cursorValue,
        },
        update: {
            lockValue: cursorValue,
            updatedAt: new Date(),
        },
    });
}

/**
 * Get backfill status for all leaders
 */
export async function getBackfillStatus(): Promise<{
    leaders: Array<{
        id: string;
        label: string;
        lastCursor?: number;
        tradeCount: number;
    }>;
}> {
    const leaders = await prisma.leader.findMany({
        where: { enabled: true },
        select: { id: true, label: true },
    });

    const status = await Promise.all(
        leaders.map(async (leader) => {
            const cursor = await getLeaderCursor(leader.id);
            const tradeCount = await prisma.trade.count({
                where: { leaderId: leader.id },
            });

            return {
                id: leader.id,
                label: leader.label,
                lastCursor: cursor?.lastSeenTimestamp,
                tradeCount,
            };
        })
    );

    return { leaders: status };
}
