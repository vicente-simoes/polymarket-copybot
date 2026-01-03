// Trade ingester - stores raw and normalized trades from Polymarket
import { prisma } from '@polymarket-bot/db';
import pino from 'pino';
import { fetchWalletActivity, buildDedupeKey, PolymarketActivity } from './polymarket';
import { resolveMapping } from './mapping';
import { captureQuote } from './quotes';
import { generatePaperIntentForTrade } from './paper';
import { withRetry, sleep } from './retry';
import { initLeaderHealth, updateLeaderHealth } from './health';

const logger = pino({ name: 'ingester' });

// Stagger delay between leaders to avoid API bursts
const LEADER_STAGGER_MS = parseInt(process.env.LEADER_STAGGER_MS || '500', 10);

/**
 * Ingest trades for a single leader wallet
 * Returns the number of new trades stored
 */
export async function ingestTradesForLeader(leaderId: string, wallet: string): Promise<number> {
    const limit = parseInt(process.env.LEADER_FETCH_LIMIT || '50', 10);

    // Fetch trades from Polymarket API
    const activities = await fetchWalletActivity(wallet, limit);

    if (activities.length === 0) {
        logger.debug({ wallet }, 'No trades found');
        return 0;
    }

    let newTradesCount = 0;

    for (const activity of activities) {
        try {
            const dedupeKey = buildDedupeKey(wallet, activity);

            // Check if trade already exists (by dedupe key)
            const existingTrade = await prisma.trade.findUnique({
                where: { dedupeKey },
            });

            if (existingTrade) {
                // Already ingested, skip
                continue;
            }

            // Store raw payload first
            const rawRecord = await prisma.tradeRaw.create({
                data: {
                    leaderId,
                    source: 'data-api/activity',
                    payload: activity as unknown as Record<string, unknown>,
                },
            });

            // Parse numeric values
            const leaderPrice = parseFloat(activity.price);
            const leaderSize = parseFloat(activity.size);
            const leaderUsdc = parseFloat(activity.usdcSize);

            // Store normalized trade with FK to raw
            const newTrade = await prisma.trade.create({
                data: {
                    leaderId,
                    dedupeKey,
                    txHash: activity.transaction_hash,
                    tradeTs: new Date(activity.timestamp),
                    side: activity.side,
                    conditionId: activity.conditionId,
                    outcome: activity.outcome,
                    leaderPrice,
                    leaderSize,
                    leaderUsdc,
                    title: activity.title || null,
                    rawId: rawRecord.id,
                },
            });

            newTradesCount++;

            logger.info({
                wallet,
                txHash: activity.transaction_hash,
                side: activity.side,
                price: leaderPrice,
                usdc: leaderUsdc,
                title: activity.title,
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

                // Generate paper intent for this trade
                await generatePaperIntentForTrade(newTrade.id);
            } else {
                logger.warn({ conditionId: activity.conditionId, outcome: activity.outcome }, 'Mapping not found - quotes will be skipped');
                // Still generate paper intent (will record SKIP_MISSING_MAPPING)
                await generatePaperIntentForTrade(newTrade.id);
            }

        } catch (error) {
            // Handle unique constraint violation (race condition between check and insert)
            if (error instanceof Error && error.message.includes('Unique constraint')) {
                logger.debug({ wallet, activity: activity.id }, 'Trade already exists (race condition)');
                continue;
            }

            logger.error({ error, activity }, 'Failed to ingest trade');
        }
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
