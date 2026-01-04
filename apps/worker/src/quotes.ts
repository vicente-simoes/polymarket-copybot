// Quote snapshotter - captures best bid/ask from Polymarket CLOB
import { prisma } from '@polymarket-bot/db';
import axios from 'axios';
import pino from 'pino';
import { resolveMapping, MarketMapping } from './mapping';

const logger = pino({ name: 'quotes' });

// Polymarket CLOB API base URL
const CLOB_API_BASE = 'https://clob.polymarket.com';

// CLOB orderbook response types
export interface ClobOrderbookResponse {
    market: string;
    asset_id: string;
    hash: string;
    timestamp: string;
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
}

export interface QuoteData {
    bestBid: number;
    bestAsk: number;
    bidSize: number | null;
    askSize: number | null;
    rawPayload: ClobOrderbookResponse;
}

/**
 * Fetch orderbook for a token from Polymarket CLOB API
 */
async function fetchOrderbook(tokenId: string): Promise<ClobOrderbookResponse | null> {
    try {
        const url = `${CLOB_API_BASE}/book`;

        const response = await axios.get<ClobOrderbookResponse>(url, {
            params: { token_id: tokenId },
            timeout: 10000,
        });

        return response.data;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            logger.error({
                tokenId,
                status: error.response?.status,
                message: error.message,
            }, 'Failed to fetch orderbook');
        }
        return null;
    }
}

/**
 * Extract best bid/ask from orderbook data
 */
function extractQuoteFromOrderbook(orderbook: ClobOrderbookResponse): QuoteData | null {
    // Get best bid (highest price)
    const bestBidEntry = orderbook.bids.length > 0
        ? orderbook.bids.reduce((a, b) => parseFloat(a.price) > parseFloat(b.price) ? a : b)
        : null;

    // Get best ask (lowest price)
    const bestAskEntry = orderbook.asks.length > 0
        ? orderbook.asks.reduce((a, b) => parseFloat(a.price) < parseFloat(b.price) ? a : b)
        : null;

    if (!bestBidEntry && !bestAskEntry) {
        logger.warn({ market: orderbook.market }, 'Empty orderbook');
        return null;
    }

    return {
        bestBid: bestBidEntry ? parseFloat(bestBidEntry.price) : 0,
        bestAsk: bestAskEntry ? parseFloat(bestAskEntry.price) : 1,
        bidSize: bestBidEntry ? parseFloat(bestBidEntry.size) : null,
        askSize: bestAskEntry ? parseFloat(bestAskEntry.size) : null,
        rawPayload: orderbook,
    };
}

/**
 * Capture quote for a specific market mapping
 * Returns the quote ID if successful
 */
export async function captureQuote(mapping: MarketMapping): Promise<string | null> {
    if (!mapping.clobTokenId) {
        logger.warn({ conditionId: mapping.conditionId, outcome: mapping.outcome }, 'No clobTokenId for mapping');
        return null;
    }

    const orderbook = await fetchOrderbook(mapping.clobTokenId);
    if (!orderbook) {
        return null;
    }

    const quoteData = extractQuoteFromOrderbook(orderbook);
    if (!quoteData) {
        return null;
    }

    try {
        // Store raw quote first
        const rawQuote = await prisma.quoteRaw.create({
            data: {
                marketKey: mapping.marketKey,
                payload: quoteData.rawPayload as any,
            },
        });

        // Store normalized quote
        const quote = await prisma.quote.create({
            data: {
                marketKey: mapping.marketKey,
                bestBid: quoteData.bestBid,
                bestAsk: quoteData.bestAsk,
                bidSize: quoteData.bidSize,
                askSize: quoteData.askSize,
                rawId: rawQuote.id,
            },
        });

        logger.info({
            marketKey: mapping.marketKey,
            bestBid: quoteData.bestBid,
            bestAsk: quoteData.bestAsk,
            spread: (quoteData.bestAsk - quoteData.bestBid).toFixed(4),
        }, 'Captured quote');

        return quote.id;
    } catch (error) {
        logger.error({ error, mapping }, 'Failed to store quote');
        return null;
    }
}

/**
 * Capture quote for a trade by resolving its mapping first
 */
export async function captureQuoteForTrade(
    conditionId: string,
    outcome: string
): Promise<string | null> {
    const mapping = await resolveMapping(conditionId, outcome);

    if (!mapping) {
        logger.debug({ conditionId, outcome }, 'No mapping found for trade');
        return null;
    }

    return captureQuote(mapping);
}

/**
 * Get the most recent quote for a marketKey
 */
export async function getLatestQuote(marketKey: string) {
    return prisma.quote.findFirst({
        where: { marketKey },
        orderBy: { capturedAt: 'desc' },
    });
}

/**
 * Get quotes captured within a time window of a specific timestamp
 */
export async function getQuoteNearTimestamp(
    marketKey: string,
    timestamp: Date,
    windowMs: number = 60000 // 1 minute default
) {
    const start = new Date(timestamp.getTime() - windowMs);
    const end = new Date(timestamp.getTime() + windowMs);

    return prisma.quote.findFirst({
        where: {
            marketKey,
            capturedAt: {
                gte: start,
                lte: end,
            },
        },
        orderBy: { capturedAt: 'desc' },
    });
}
