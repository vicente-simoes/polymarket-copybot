// Polymarket API client for fetching wallet activity
import axios from 'axios';
import pino from 'pino';
import { prisma } from '@polymarket-bot/db';

const logger = pino({ name: 'polymarket-api' });

// Polymarket Data API base URL
const POLYMARKET_API_BASE = 'https://data-api.polymarket.com';

// Activity endpoint response types
export interface PolymarketActivity {
    name: string;  // Unique activity identifier
    timestamp: number;  // Unix timestamp (seconds)
    type: 'TRADE' | 'REDEEM' | 'MERGE' | 'SPLIT';
    transactionHash: string;  // Note: camelCase in API response
    proxyWallet: string;
    conditionId: string;
    side: 'BUY' | 'SELL';
    outcome: string;
    outcomeIndex: number;
    price: number;  // API returns numbers, not strings
    size: number;
    usdcSize: number;
    asset: string;
    title?: string;
    slug?: string;
    eventSlug?: string;
    icon?: string;
}

/**
 * Fetch trade activity for a wallet from Polymarket Data API
 * Legacy function - use fetchWalletActivitySince for cursor-based polling
 */
export async function fetchWalletActivity(
    wallet: string,
    limit: number = 50
): Promise<PolymarketActivity[]> {
    try {
        const url = `${POLYMARKET_API_BASE}/activity`;

        logger.debug({ wallet, limit }, 'Fetching wallet activity');

        // Polymarket /activity endpoint returns an array directly
        const response = await axios.get<PolymarketActivity[]>(url, {
            params: {
                user: wallet,
                limit,
                type: 'TRADE', // Only fetch trades
            },
            timeout: 10000,
        });

        const trades = response.data || [];
        logger.info({ wallet, tradeCount: trades.length }, 'Fetched trades from Polymarket');

        return trades;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            logger.error({
                wallet,
                status: error.response?.status,
                message: error.message,
            }, 'Failed to fetch wallet activity');

            // Return empty array on error to prevent crashing the poll loop
            return [];
        }
        throw error;
    }
}

/**
 * Stage 2.3: Fetch trade activity since a specific timestamp (cursor-based)
 * Uses start parameter for timestamp-based pagination
 */
export async function fetchWalletActivitySince(
    wallet: string,
    startTs: Date | null,
    limit: number = 500,
    offset: number = 0
): Promise<PolymarketActivity[]> {
    try {
        const url = `${POLYMARKET_API_BASE}/activity`;

        // Convert Date to Unix timestamp (seconds) for API
        const startParam = startTs ? Math.floor(startTs.getTime() / 1000) : undefined;

        logger.debug({ wallet, limit, offset, startTs: startParam }, 'Fetching wallet activity since timestamp');

        const response = await axios.get<PolymarketActivity[]>(url, {
            params: {
                user: wallet,
                limit,
                offset,
                start: startParam,  // Only fetch trades after this timestamp
                type: 'TRADE',
            },
            timeout: 15000,
        });

        const trades = response.data || [];
        logger.info({ wallet, tradeCount: trades.length, startTs: startParam, offset }, 'Fetched trades since timestamp');

        return trades;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            logger.error({
                wallet,
                status: error.response?.status,
                message: error.message,
            }, 'Failed to fetch wallet activity since timestamp');

            return [];
        }
        throw error;
    }
}

/**
 * Stage 2.2: Get settings with startup mode configuration
 */
export async function getStartupSettings(): Promise<{ startupMode: string; warmStartSeconds: number }> {
    const settings = await prisma.settings.findFirst();
    return {
        startupMode: settings?.startupMode ?? 'flat',
        warmStartSeconds: settings?.warmStartSeconds ?? 900,
    };
}

/**
 * Build dedupe key for a trade to prevent duplicates
 * Format: leaderWallet|txHash|side|conditionId|outcome|size|price
 */
export function buildDedupeKey(wallet: string, activity: PolymarketActivity): string {
    return [
        wallet.toLowerCase(),
        activity.transactionHash,
        activity.side,
        activity.conditionId,
        activity.outcome,
        activity.size,
        activity.price,
    ].join('|');
}

