/**
 * Token resolver - fast tokenId → market/outcome lookup
 * Phase 2: Market Registry
 * 
 * Uses the TokenIndex table for O(1) lookups instead of per-trade CLOB API calls.
 * Falls back to CLOB API if token not in registry.
 */

import { prisma } from '@polymarket-bot/db';
import axios from 'axios';
import pino from 'pino';
import { getConfig } from '../config.js';

const logger = pino({ name: 'resolve-token' });

/**
 * Resolved token info
 */
export interface ResolvedToken {
    tokenId: string;
    conditionId: string;
    outcome: string;
    title: string | null;
    marketKey: string;
}

/**
 * In-memory cache for hot path performance
 * Maps tokenId → ResolvedToken
 */
const tokenCache = new Map<string, ResolvedToken | null>();

/**
 * Resolve a tokenId to its market/outcome info
 * 
 * 1. Check in-memory cache
 * 2. Check TokenIndex table
 * 3. Fall back to CLOB API (and cache result)
 * 
 * Returns null if token cannot be resolved
 */
export async function resolveTokenId(tokenId: string): Promise<ResolvedToken | null> {
    // Check in-memory cache first
    if (tokenCache.has(tokenId)) {
        return tokenCache.get(tokenId)!;
    }

    // Check TokenIndex table
    const indexed = await prisma.tokenIndex.findUnique({
        where: { tokenId },
    });

    if (indexed) {
        const result: ResolvedToken = {
            tokenId,
            conditionId: indexed.conditionId,
            outcome: indexed.outcome,
            title: indexed.title,
            marketKey: `${indexed.conditionId}:${indexed.outcome.toUpperCase()}`,
        };
        tokenCache.set(tokenId, result);
        logger.debug({ tokenId, conditionId: result.conditionId }, 'Resolved token from index');
        return result;
    }

    // Fall back to CLOB API
    logger.info({ tokenId }, 'Token not in index, falling back to CLOB API');
    const result = await resolveFromClobApi(tokenId);

    // Cache the result (even if null to avoid repeated lookups)
    tokenCache.set(tokenId, result);

    return result;
}

/**
 * Resolve token from CLOB API by searching markets
 * This is the slow path - only used for tokens not in registry
 */
async function resolveFromClobApi(tokenId: string): Promise<ResolvedToken | null> {
    const config = getConfig();

    try {
        // The CLOB API doesn't have a direct tokenId lookup
        // We need to get the market by token_id
        const url = `${config.clobHttpUrl}/markets`;
        const response = await axios.get(url, {
            params: { token_id: tokenId },
            timeout: 10000,
        });

        const markets = response.data;
        if (!markets || markets.length === 0) {
            logger.warn({ tokenId }, 'Token not found in CLOB API');
            return null;
        }

        const market = markets[0];
        const token = market.tokens?.find((t: any) => t.token_id === tokenId);

        if (!token) {
            logger.warn({ tokenId }, 'Token not found in market tokens');
            return null;
        }

        const result: ResolvedToken = {
            tokenId,
            conditionId: market.condition_id,
            outcome: token.outcome,
            title: market.question || null,
            marketKey: `${market.condition_id}:${token.outcome.toUpperCase()}`,
        };

        // Also store in TokenIndex for future lookups
        try {
            // First ensure the market is in the registry
            const registry = await prisma.marketRegistry.upsert({
                where: { conditionId: market.condition_id },
                create: {
                    conditionId: market.condition_id,
                    title: market.question || 'Unknown',
                    enableOrderBook: true,
                    active: true,
                    closed: false,
                    tokens: market.tokens?.map((t: any) => ({
                        tokenId: t.token_id,
                        outcome: t.outcome,
                    })) || [],
                },
                update: {
                    lastSyncedAt: new Date(),
                },
            });

            // Then create the token index
            await prisma.tokenIndex.upsert({
                where: { tokenId },
                create: {
                    tokenId,
                    registryId: registry.id,
                    conditionId: market.condition_id,
                    outcome: token.outcome,
                    title: market.question,
                },
                update: {
                    conditionId: market.condition_id,
                    outcome: token.outcome,
                    title: market.question,
                },
            });

            logger.info({ tokenId, conditionId: market.condition_id }, 'Indexed token from CLOB API fallback');
        } catch (error) {
            logger.error({ error, tokenId }, 'Failed to index token from CLOB fallback');
        }

        return result;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            logger.error({
                tokenId,
                status: error.response?.status,
                message: error.message,
            }, 'CLOB API lookup failed');
        }
        return null;
    }
}

/**
 * Batch resolve multiple tokenIds
 * Returns a map of tokenId → ResolvedToken (or null if not found)
 */
export async function resolveTokenIds(
    tokenIds: string[]
): Promise<Map<string, ResolvedToken | null>> {
    const results = new Map<string, ResolvedToken | null>();

    // Deduplicate
    const uniqueIds = [...new Set(tokenIds)];

    // Check what's already in cache
    const uncached: string[] = [];
    for (const id of uniqueIds) {
        if (tokenCache.has(id)) {
            results.set(id, tokenCache.get(id)!);
        } else {
            uncached.push(id);
        }
    }

    if (uncached.length === 0) {
        return results;
    }

    // Batch query TokenIndex
    const indexed = await prisma.tokenIndex.findMany({
        where: { tokenId: { in: uncached } },
    });

    const foundIds = new Set<string>();
    for (const idx of indexed) {
        const result: ResolvedToken = {
            tokenId: idx.tokenId,
            conditionId: idx.conditionId,
            outcome: idx.outcome,
            title: idx.title,
            marketKey: `${idx.conditionId}:${idx.outcome.toUpperCase()}`,
        };
        results.set(idx.tokenId, result);
        tokenCache.set(idx.tokenId, result);
        foundIds.add(idx.tokenId);
    }

    // For remaining unfound tokens, fall back to CLOB API one by one
    const notFound = uncached.filter(id => !foundIds.has(id));
    for (const id of notFound) {
        const result = await resolveTokenId(id);  // Uses CLOB fallback
        results.set(id, result);
    }

    return results;
}

/**
 * Clear the in-memory cache (useful after registry sync)
 */
export function clearTokenCache(): void {
    tokenCache.clear();
    logger.info('Token cache cleared');
}

/**
 * Get cache stats for debugging
 */
export function getTokenCacheStats(): { size: number; hits: number } {
    return {
        size: tokenCache.size,
        hits: 0, // Could track this with a counter if needed
    };
}
