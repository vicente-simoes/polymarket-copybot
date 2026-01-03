// Polymarket API client for fetching wallet activity
import axios from 'axios';
import pino from 'pino';

const logger = pino({ name: 'polymarket-api' });

// Polymarket Data API base URL
const POLYMARKET_API_BASE = 'https://data-api.polymarket.com';

// Activity endpoint response types
export interface PolymarketActivity {
    id: string;
    timestamp: string;
    type: 'TRADE' | 'REDEEM' | 'MERGE' | 'SPLIT';
    transaction_hash: string;
    proxyWallet: string;
    conditionId: string;
    side: 'BUY' | 'SELL';
    outcome: string;
    price: string;
    size: string;
    usdcSize: string;
    feesPaid: string;
    title?: string;
    slug?: string;
    icon?: string;
}

export interface ActivityResponse {
    data: PolymarketActivity[];
    next_cursor?: string;
}

/**
 * Fetch trade activity for a wallet from Polymarket Data API
 */
export async function fetchWalletActivity(
    wallet: string,
    limit: number = 50
): Promise<PolymarketActivity[]> {
    try {
        const url = `${POLYMARKET_API_BASE}/activity`;

        logger.debug({ wallet, limit }, 'Fetching wallet activity');

        const response = await axios.get<ActivityResponse>(url, {
            params: {
                user: wallet,
                limit,
                type: 'TRADE', // Only fetch trades
            },
            timeout: 10000,
        });

        const trades = response.data.data || [];
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
 * Build dedupe key for a trade to prevent duplicates
 * Format: leaderWallet|txHash|side|conditionId|outcome|size|price
 */
export function buildDedupeKey(wallet: string, activity: PolymarketActivity): string {
    return [
        wallet.toLowerCase(),
        activity.transaction_hash,
        activity.side,
        activity.conditionId,
        activity.outcome,
        activity.size,
        activity.price,
    ].join('|');
}
