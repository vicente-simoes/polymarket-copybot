// Trade ingester - stores raw and normalized trades from Polymarket
import { prisma } from '@polymarket-bot/db';
import pino from 'pino';
import { fetchWalletActivitySince, buildDedupeKey, PolymarketActivity, getStartupSettings } from './polymarket';
import { resolveMapping } from './mapping';
import { captureQuote } from './quotes';
import { generatePaperIntentForTrade } from './paper';
import { withRetry, sleep } from './retry';
import { initLeaderHealth, updateLeaderHealth } from './health';
import { recordLatencyEvent } from './latencyTracker.js';

const logger = pino({ name: 'ingester' });

// Stagger delay between leaders to avoid API bursts
const LEADER_STAGGER_MS = parseInt(process.env.LEADER_STAGGER_MS || '500', 10);

// Page size for cursor-based polling
const CURSOR_PAGE_SIZE = 500;

/**
 * Stage 2.3: Ingest trades for a single leader wallet using cursor-based polling
 * Returns the number of new trades stored
 */
export async function ingestTradesForLeader(leaderId: string, wallet: string): Promise<number> {
    // Get the leader record to check cursor state
    const leader = await prisma.leader.findUnique({
        where: { id: leaderId },
    });

    if (!leader) {
        logger.error({ leaderId }, 'Leader not found');
        return 0;
    }

    // Stage 2.3: Initialize cursor if not already done
    if (!leader.apiCursorInitialized) {
        const settings = await getStartupSettings();

        if (settings.startupMode === 'flat') {
            // Flat start: set cursor to now and skip historical ingestion
            await prisma.leader.update({
                where: { id: leaderId },
                data: {
                    apiCursorTs: new Date(),
                    apiCursorInitialized: true,
                    apiCursorUpdatedAt: new Date(),
                },
            });

            logger.info({
                wallet,
                startupMode: 'flat',
                cursorTs: new Date().toISOString(),
            }, 'Cursor initialized (flat start) - no historical ingestion');

            return 0;  // Skip ingestion on flat start initialization
        } else {
            // Warm start: set cursor to (now - warmStartSeconds) and ingest from there
            const warmStartDate = new Date(Date.now() - settings.warmStartSeconds * 1000);

            await prisma.leader.update({
                where: { id: leaderId },
                data: {
                    apiCursorTs: warmStartDate,
                    apiCursorInitialized: true,
                    apiCursorUpdatedAt: new Date(),
                },
            });

            logger.info({
                wallet,
                startupMode: 'warm',
                warmStartSeconds: settings.warmStartSeconds,
                cursorTs: warmStartDate.toISOString(),
            }, 'Cursor initialized (warm start) - will ingest recent history as backfill');

            // Continue to fetch from warmStartDate (these will be marked as backfill)
        }
    }

    // Refresh leader to get updated cursor
    const leaderWithCursor = await prisma.leader.findUnique({
        where: { id: leaderId },
    });

    if (!leaderWithCursor) return 0;

    const cursorTs = leaderWithCursor.apiCursorTs;

    // Stage 2.3: Fetch all trades since cursor using pagination
    let allActivities: PolymarketActivity[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
        const page = await fetchWalletActivitySince(wallet, cursorTs, CURSOR_PAGE_SIZE, offset);

        if (page.length === 0) {
            hasMore = false;
        } else {
            allActivities = allActivities.concat(page);
            offset += page.length;

            // If page is smaller than limit, we've reached the end
            if (page.length < CURSOR_PAGE_SIZE) {
                hasMore = false;
            }
        }
    }

    if (allActivities.length === 0) {
        logger.debug({ wallet, cursorTs: cursorTs?.toISOString() }, 'No new trades since cursor');
        return 0;
    }

    // Sort by timestamp ascending for proper cursor advancement
    allActivities.sort((a, b) => a.timestamp - b.timestamp);

    logger.info({
        wallet,
        activityCount: allActivities.length,
        cursorTs: cursorTs?.toISOString(),
    }, 'Processing trades since cursor');

    let newTradesCount = 0;
    let maxTimestamp = cursorTs?.getTime() ?? 0;

    for (const activity of allActivities) {
        try {
            const dedupeKey = buildDedupeKey(wallet, activity);

            // Stage 2.4: Check if trade already exists BEFORE creating TradeRaw
            const existingTrade = await prisma.trade.findUnique({
                where: { dedupeKey },
            });

            if (existingTrade) {
                // Already ingested, skip - don't create TradeRaw (fixes bloat)
                continue;
            }

            // Track max timestamp for cursor update
            const activityTs = activity.timestamp * 1000;
            if (activityTs > maxTimestamp) {
                maxTimestamp = activityTs;
            }

            // Stage 2.4: Only create TradeRaw for new trades (fix bloat)
            const rawRecord = await prisma.tradeRaw.create({
                data: {
                    leaderId,
                    source: 'data-api/activity',
                    payload: activity as any,
                },
            });

            // Use numeric values directly (API returns numbers)
            const leaderPrice = activity.price;
            const leaderSize = activity.size;
            const leaderUsdc = activity.usdcSize;

            // Determine if this is a backfill trade (from warm start history)
            // Compare trade timestamp to cursor initialization time
            const isBackfill = cursorTs !== null && new Date(activity.timestamp * 1000) < cursorTs;

            // Store normalized trade with FK to raw
            const newTrade = await prisma.trade.create({
                data: {
                    leaderId,
                    dedupeKey,
                    txHash: activity.transactionHash,
                    tradeTs: new Date(activity.timestamp * 1000),
                    side: activity.side,
                    conditionId: activity.conditionId,
                    outcome: activity.outcome,
                    leaderPrice,
                    leaderSize,
                    leaderUsdc,
                    title: activity.title || null,
                    isBackfill: isBackfill,
                    rawId: rawRecord.id,
                },
            });

            newTradesCount++;

            // Check if Polygon already recorded this trade (by txHash)
            // If so, enrich the existing Polygon record with API metadata
            const existingPolygonFill = await prisma.leaderFill.findFirst({
                where: {
                    txHash: activity.transactionHash,
                    source: 'polygon',
                },
            });

            if (existingPolygonFill) {
                // Enrich the existing Polygon record with API metadata
                await prisma.leaderFill.update({
                    where: { id: existingPolygonFill.id },
                    data: {
                        title: activity.title || existingPolygonFill.title,
                        conditionId: existingPolygonFill.conditionId === 'unknown'
                            ? activity.conditionId
                            : existingPolygonFill.conditionId,
                        outcome: existingPolygonFill.outcome === 'unknown'
                            ? activity.outcome
                            : existingPolygonFill.outcome,
                    },
                });

                logger.info({
                    txHash: activity.transactionHash,
                    title: activity.title,
                    previousTitle: existingPolygonFill.title,
                }, 'Enriched Polygon fill with API metadata');

                // Record latency event for comparison (API was slower)
                await recordLatencyEvent({
                    dedupeKey: activity.transactionHash.toLowerCase(),
                    source: 'data_api',
                    detectedAt: new Date(),
                    tokenId: activity.asset || '',
                    conditionId: activity.conditionId,
                    leaderWallet: wallet.toLowerCase(),
                    side: activity.side,
                    usdcAmount: leaderUsdc,
                });
            } else {
                // No Polygon record exists - create new LeaderFill from API
                const leaderFillDedupeKey = `data_api:${dedupeKey}`;

                const leaderFillRaw = await prisma.leaderFillRaw.create({
                    data: {
                        source: 'data_api',
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
                        leaderPrice: leaderPrice,
                        leaderSize: leaderSize,
                        leaderUsdc: leaderUsdc,
                        fillTs: new Date(activity.timestamp * 1000),
                        detectedAt: new Date(),
                        title: activity.title || null,
                        isBackfill: isBackfill,
                        dedupeKey: leaderFillDedupeKey,
                        rawId: leaderFillRaw.id,
                    }
                }).catch(err => {
                    if (err.code !== 'P2002') {
                        logger.error({ error: err, dedupeKey }, 'Failed to create LeaderFill from API');
                    }
                });

                // Record latency event for comparison with Polygon source
                await recordLatencyEvent({
                    dedupeKey: activity.transactionHash.toLowerCase(),
                    source: 'data_api',
                    detectedAt: new Date(),
                    tokenId: activity.asset || '',
                    conditionId: activity.conditionId,
                    leaderWallet: wallet.toLowerCase(),
                    side: activity.side,
                    usdcAmount: leaderUsdc,
                });
            }

            logger.info({
                wallet,
                txHash: activity.transactionHash,
                side: activity.side,
                price: leaderPrice,
                usdc: leaderUsdc,
                title: activity.title,
                isBackfill,
            }, 'Ingested new trade');

            // Resolve and cache market mapping for this trade
            const mapping = await resolveMapping(activity.conditionId, activity.outcome);
            if (mapping) {
                logger.debug({ conditionId: activity.conditionId, outcome: activity.outcome, clobTokenId: mapping.clobTokenId }, 'Mapping resolved');

                // Capture quote immediately after ingesting trade
                const quoteId = await captureQuote(mapping);
                if (quoteId) {
                    logger.debug({ quoteId, marketKey: mapping.marketKey }, 'Quote captured for trade');
                }

                // Only generate paper intent for live trades (not backfill)
                if (!isBackfill) {
                    await generatePaperIntentForTrade(newTrade.id);
                }
            } else {
                logger.warn({ conditionId: activity.conditionId, outcome: activity.outcome }, 'Mapping not found - quotes will be skipped');
                // Only generate paper intent for live trades (not backfill)
                if (!isBackfill) {
                    await generatePaperIntentForTrade(newTrade.id);
                }
            }

        } catch (error) {
            // Handle unique constraint violation (race condition between check and insert)
            if (error instanceof Error && error.message.includes('Unique constraint')) {
                logger.debug({ wallet, activity: activity.name }, 'Trade already exists (race condition)');
                continue;
            }

            logger.error({ error, activity }, 'Failed to ingest trade');
        }
    }

    // Stage 2.3: Update cursor to max timestamp + 1 second to avoid re-fetching
    if (maxTimestamp > 0) {
        const newCursor = new Date(maxTimestamp + 1000);  // Add 1 second buffer
        await prisma.leader.update({
            where: { id: leaderId },
            data: {
                apiCursorTs: newCursor,
                apiCursorUpdatedAt: new Date(),
            },
        });

        logger.debug({ wallet, newCursor: newCursor.toISOString() }, 'Cursor updated');
    }

    return newTradesCount;
}

/**
 * Ingest trades for all enabled leaders with staggering
 */
export async function ingestAllLeaders(): Promise<{ totalNew: number; leadersProcessed: number }> {
    const leaders = await prisma.leader.findMany({
        where: { enabled: true },
    });

    if (leaders.length === 0) {
        logger.debug('No enabled leaders found');
        return { totalNew: 0, leadersProcessed: 0 };
    }

    logger.info({ leaderCount: leaders.length }, 'Starting ingestion for enabled leaders');

    // Initialize health tracking for all leaders
    for (const leader of leaders) {
        initLeaderHealth(leader.id, leader.label, leader.wallet, leader.enabled);
    }

    let totalNew = 0;

    for (let i = 0; i < leaders.length; i++) {
        const leader = leaders[i];

        try {
            // Use retry wrapper for resilience
            const newTrades = await withRetry(
                () => ingestTradesForLeader(leader.id, leader.wallet),
                `ingest:${leader.label}`,
                { maxRetries: 3, baseDelayMs: 1000 }
            );

            totalNew += newTrades;
            updateLeaderHealth(leader.id, true, newTrades);

            if (newTrades > 0) {
                logger.info({ leader: leader.label, wallet: leader.wallet, newTrades }, 'Leader ingestion complete');
            }
        } catch (error) {
            updateLeaderHealth(leader.id, false);
            logger.error({ leader: leader.label, error }, 'Failed to ingest trades for leader (all retries exhausted)');
        }

        // Stagger between leaders to avoid API rate limits
        if (i < leaders.length - 1 && LEADER_STAGGER_MS > 0) {
            await sleep(LEADER_STAGGER_MS);
        }
    }

    return { totalNew, leadersProcessed: leaders.length };
}
