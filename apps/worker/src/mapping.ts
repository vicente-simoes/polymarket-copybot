// Market mapping resolver - maps (conditionId, outcome) to tradable instrument
// This is critical for fetching quotes and placing orders

import { prisma } from '@polymarket-bot/db';
import axios from 'axios';
import pino from 'pino';

const logger = pino({ name: 'mapping' });

// Polymarket CLOB API for market metadata
const CLOB_API_BASE = 'https://clob.polymarket.com';

export interface MarketMapping {
    id: string;
    conditionId: string;
    outcome: string;
    marketKey: string;
    clobTokenId: string | null;
    assetId: string | null;
}

export interface ClobMarketInfo {
    condition_id: string;
    tokens: Array<{
        token_id: string;
        outcome: string;
    }>;
}

/**
 * Resolve a (conditionId, outcome) pair to a tradable instrument
 * 
 * 1. Check if mapping exists in DB
 * 2. If not, fetch from Polymarket CLOB API
 * 3. Store in DB for future use
 * 4. Return mapping or null if not found
 */
export async function resolveMapping(
    conditionId: string,
    outcome: string
): Promise<MarketMapping | null> {
    // Check DB first
    const existing = await prisma.marketMapping.findUnique({
        where: {
            conditionId_outcome: { conditionId, outcome },
        },
    });

    if (existing) {
        logger.debug({ conditionId, outcome }, 'Found existing mapping');
        return {
            id: existing.id,
            conditionId: existing.conditionId,
            outcome: existing.outcome,
            marketKey: existing.marketKey,
            clobTokenId: existing.clobTokenId,
            assetId: existing.assetId,
        };
    }

    // Try to fetch from CLOB API
    logger.info({ conditionId, outcome }, 'Fetching mapping from CLOB API');

    try {
        const marketInfo = await fetchMarketInfo(conditionId);

        if (!marketInfo) {
            logger.warn({ conditionId }, 'Market not found in CLOB API');
            return null;
        }

        // Find the token for this outcome
        const token = marketInfo.tokens.find((t) =>
            t.outcome.toUpperCase() === outcome.toUpperCase()
        );

        if (!token) {
            logger.warn({ conditionId, outcome, availableOutcomes: marketInfo.tokens.map(t => t.outcome) },
                'Outcome not found in market tokens');
            return null;
        }

        // Create marketKey as conditionId:outcome for canonical reference
        const marketKey = `${conditionId}:${outcome.toUpperCase()}`;

        // Store in DB
        const newMapping = await prisma.marketMapping.create({
            data: {
                conditionId,
                outcome: outcome.toUpperCase(),
                marketKey,
                clobTokenId: token.token_id,
                assetId: null, // Can be populated later if needed
            },
        });

        logger.info({ conditionId, outcome, clobTokenId: token.token_id }, 'Created new mapping');

        return {
            id: newMapping.id,
            conditionId: newMapping.conditionId,
            outcome: newMapping.outcome,
            marketKey: newMapping.marketKey,
            clobTokenId: newMapping.clobTokenId,
            assetId: newMapping.assetId,
        };
    } catch (error) {
        logger.error({ error, conditionId, outcome }, 'Failed to fetch/create mapping');
        return null;
    }
}

/**
 * Fetch market info from Polymarket CLOB API
 */
async function fetchMarketInfo(conditionId: string): Promise<ClobMarketInfo | null> {
    try {
        const url = `${CLOB_API_BASE}/markets/${conditionId}`;

        const response = await axios.get<ClobMarketInfo>(url, {
            timeout: 10000,
        });

        return response.data;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            if (error.response?.status === 404) {
                logger.debug({ conditionId }, 'Market not found (404)');
                return null;
            }
            logger.error({
                conditionId,
                status: error.response?.status,
                message: error.message,
            }, 'CLOB API request failed');
        }
        return null;
    }
}

/**
 * Batch resolve mappings for multiple trades
 * Returns a map of dedupeKey -> mapping (or null if not found)
 */
export async function resolveMappingsForTrades(
    trades: Array<{ conditionId: string; outcome: string; dedupeKey: string }>
): Promise<Map<string, MarketMapping | null>> {
    const results = new Map<string, MarketMapping | null>();

    // Deduplicate by conditionId+outcome to minimize API calls
    const uniquePairs = new Map<string, { conditionId: string; outcome: string }>();
    for (const trade of trades) {
        const key = `${trade.conditionId}:${trade.outcome}`;
        if (!uniquePairs.has(key)) {
            uniquePairs.set(key, { conditionId: trade.conditionId, outcome: trade.outcome });
        }
    }

    // Resolve each unique pair
    const mappingCache = new Map<string, MarketMapping | null>();
    for (const [key, pair] of uniquePairs) {
        const mapping = await resolveMapping(pair.conditionId, pair.outcome);
        mappingCache.set(key, mapping);
    }

    // Map back to trades
    for (const trade of trades) {
        const key = `${trade.conditionId}:${trade.outcome}`;
        results.set(trade.dedupeKey, mappingCache.get(key) || null);
    }

    return results;
}

/**
 * Get all mappings from DB (for debugging/dashboard)
 */
export async function getAllMappings(): Promise<MarketMapping[]> {
    const mappings = await prisma.marketMapping.findMany({
        orderBy: { updatedAt: 'desc' },
    });

    return mappings.map((m) => ({
        id: m.id,
        conditionId: m.conditionId,
        outcome: m.outcome,
        marketKey: m.marketKey,
        clobTokenId: m.clobTokenId,
        assetId: m.assetId,
    }));
}
