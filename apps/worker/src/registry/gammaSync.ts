/**
 * Gamma API sync - pulls market metadata from Polymarket Gamma API
 * Phase 2: Market Registry
 */

import { prisma } from '@polymarket-bot/db';
import axios from 'axios';
import pino from 'pino';
import { getConfig } from '../config.js';

const logger = pino({ name: 'gamma-sync' });

/**
 * Market info from Gamma API (actual response fields)
 */
interface GammaMarket {
    id: string;
    conditionId: string;
    question: string;
    slug?: string;
    description?: string;
    category?: string;
    endDate?: string;           // ISO string
    endDateIso?: string;
    active?: boolean;
    closed?: boolean;
    outcomes?: string;          // JSON string like '["Yes", "No"]'
    clobTokenIds?: string;      // JSON string like '["tokenId1", "tokenId2"]'
}

/**
 * Parsed token info
 */
interface ParsedToken {
    tokenId: string;
    outcome: string;
}

/**
 * Parse outcomes and clobTokenIds from Gamma market
 */
function parseTokens(market: GammaMarket): ParsedToken[] {
    const tokens: ParsedToken[] = [];

    try {
        // Parse outcomes JSON string
        const outcomes: string[] = market.outcomes ? JSON.parse(market.outcomes) : [];

        // Parse clobTokenIds JSON string
        const tokenIds: string[] = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : [];

        // Match outcomes with tokenIds (they should be in the same order)
        for (let i = 0; i < outcomes.length && i < tokenIds.length; i++) {
            if (tokenIds[i]) {
                tokens.push({
                    tokenId: tokenIds[i],
                    outcome: outcomes[i],
                });
            }
        }
    } catch (error) {
        logger.warn({
            conditionId: market.conditionId,
            outcomes: market.outcomes,
            clobTokenIds: market.clobTokenIds,
            error
        }, 'Failed to parse market tokens');
    }

    return tokens;
}

/**
 * Fetch markets from Gamma API with pagination
 */
async function fetchGammaMarkets(
    offset: number = 0,
    limit: number = 100
): Promise<{ markets: GammaMarket[]; hasMore: boolean }> {
    const config = getConfig();

    try {
        const url = `${config.gammaApiUrl}/markets`;
        const response = await axios.get<GammaMarket[]>(url, {
            params: {
                limit,
                offset,
                active: true,
                closed: false,
            },
            timeout: 30000,
        });

        const markets = response.data || [];
        const hasMore = markets.length === limit;

        logger.debug({
            offset,
            limit,
            fetched: markets.length,
            hasMore,
        }, 'Fetched markets from Gamma API');

        return { markets, hasMore };
    } catch (error) {
        if (axios.isAxiosError(error)) {
            logger.error({
                status: error.response?.status,
                message: error.message,
                url: `${config.gammaApiUrl}/markets`,
            }, 'Failed to fetch from Gamma API');
        }
        throw error;
    }
}

/**
 * Upsert a market into the registry and create token indexes
 */
async function upsertMarket(market: GammaMarket): Promise<{ marketsUpserted: number; tokensIndexed: number }> {
    // Skip if no conditionId
    if (!market.conditionId) {
        logger.debug({ id: market.id }, 'Skipping market without conditionId');
        return { marketsUpserted: 0, tokensIndexed: 0 };
    }

    // Parse tokens
    const tokens = parseTokens(market);

    // Skip if no valid tokens
    if (tokens.length === 0) {
        logger.debug({ conditionId: market.conditionId }, 'Skipping market without tokens');
        return { marketsUpserted: 0, tokensIndexed: 0 };
    }

    // Prepare token data as JSON
    const tokensJson = tokens.map(t => ({
        tokenId: t.tokenId,
        outcome: t.outcome,
    }));

    // Parse end date
    let endDate: Date | null = null;
    const endDateStr = market.endDateIso || market.endDate;
    if (endDateStr) {
        try {
            endDate = new Date(endDateStr);
            if (isNaN(endDate.getTime())) endDate = null;
        } catch {
            endDate = null;
        }
    }

    // Upsert the market registry entry
    const registry = await prisma.marketRegistry.upsert({
        where: { conditionId: market.conditionId },
        create: {
            conditionId: market.conditionId,
            title: market.question || 'Unknown Market',
            slug: market.slug,
            category: market.category,
            endDate,
            enableOrderBook: true,  // We're filtering for active markets
            active: market.active ?? true,
            closed: market.closed ?? false,
            tokens: tokensJson,
            description: market.description,
            gammaMarketId: market.id,
            lastSyncedAt: new Date(),
        },
        update: {
            title: market.question || 'Unknown Market',
            slug: market.slug,
            category: market.category,
            endDate,
            active: market.active ?? true,
            closed: market.closed ?? false,
            tokens: tokensJson,
            description: market.description,
            gammaMarketId: market.id,
            lastSyncedAt: new Date(),
        },
    });

    // Upsert token indexes for fast lookups
    let tokensIndexed = 0;
    for (const token of tokens) {
        if (!token.tokenId) continue;

        await prisma.tokenIndex.upsert({
            where: { tokenId: token.tokenId },
            create: {
                tokenId: token.tokenId,
                registryId: registry.id,
                conditionId: market.conditionId,
                outcome: token.outcome,
                title: market.question,
            },
            update: {
                registryId: registry.id,
                conditionId: market.conditionId,
                outcome: token.outcome,
                title: market.question,
            },
        });
        tokensIndexed++;
    }

    return { marketsUpserted: 1, tokensIndexed };
}

/**
 * Sync all markets from Gamma API to registry
 * Returns the number of markets synced
 */
export async function syncGammaRegistry(): Promise<{
    marketsProcessed: number;
    tokensIndexed: number;
    errors: number;
}> {
    logger.info('Starting Gamma registry sync...');
    const startTime = Date.now();

    let marketsProcessed = 0;
    let tokensIndexed = 0;
    let errors = 0;
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
        try {
            const { markets, hasMore: more } = await fetchGammaMarkets(offset, limit);
            hasMore = more;

            for (const market of markets) {
                try {
                    const result = await upsertMarket(market);
                    marketsProcessed += result.marketsUpserted;
                    tokensIndexed += result.tokensIndexed;
                } catch (error) {
                    errors++;
                    logger.error({
                        conditionId: market.conditionId,
                        error: error instanceof Error ? error.message : error,
                    }, 'Failed to upsert market');
                }
            }

            offset += limit;

            // Log progress every batch
            if (marketsProcessed > 0 && marketsProcessed % 500 === 0) {
                logger.info({ marketsProcessed, tokensIndexed }, 'Sync progress...');
            }

            // Small delay to avoid rate limiting
            if (hasMore) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } catch (error) {
            logger.error({ error, offset }, 'Failed to fetch batch from Gamma API');
            errors++;
            break; // Stop on fetch errors
        }
    }

    const durationMs = Date.now() - startTime;
    logger.info({
        marketsProcessed,
        tokensIndexed,
        errors,
        durationMs,
    }, 'Gamma registry sync complete');

    return { marketsProcessed, tokensIndexed, errors };
}

/**
 * Get registry stats for health/debugging
 */
export async function getRegistryStats(): Promise<{
    totalMarkets: number;
    activeMarkets: number;
    totalTokens: number;
    lastSyncAt: Date | null;
}> {
    const [totalMarkets, activeMarkets, totalTokens, lastSync] = await Promise.all([
        prisma.marketRegistry.count(),
        prisma.marketRegistry.count({ where: { active: true, enableOrderBook: true } }),
        prisma.tokenIndex.count(),
        prisma.marketRegistry.findFirst({
            orderBy: { lastSyncedAt: 'desc' },
            select: { lastSyncedAt: true },
        }),
    ]);

    return {
        totalMarkets,
        activeMarkets,
        totalTokens,
        lastSyncAt: lastSync?.lastSyncedAt ?? null,
    };
}
