/**
 * REST client for fetching orderbook snapshots
 * Phase 4: Market Data
 */

import axios from 'axios';
import pino from 'pino';
import { getConfig } from '../config.js';
import type { OrderbookSnapshot, PriceLevel } from '../ports/BookStore.js';

const logger = pino({ name: 'rest-book-client' });

/**
 * CLOB API response types
 */
interface ClobBookResponse {
    market: string;
    asset_id: string;
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
    hash: string;
    timestamp: string;
}

interface ClobBatchBookRequest {
    token_id: string;
    side: 'BUY' | 'SELL';
}

/**
 * Fetch orderbook snapshot for a single token
 */
export async function fetchBookSnapshot(tokenId: string): Promise<OrderbookSnapshot | null> {
    const config = getConfig();

    try {
        const response = await axios.get<ClobBookResponse>(`${config.clobHttpUrl}/book`, {
            params: { token_id: tokenId },
            timeout: 10000,
        });

        const data = response.data;

        return {
            tokenId,
            bids: data.bids.map(b => ({
                price: parseFloat(b.price),
                size: parseFloat(b.size),
            })),
            asks: data.asks.map(a => ({
                price: parseFloat(a.price),
                size: parseFloat(a.size),
            })),
            timestamp: new Date(data.timestamp),
        };
    } catch (error) {
        logger.error({ error, tokenId }, 'Failed to fetch book snapshot');
        return null;
    }
}

/**
 * Fetch orderbook snapshots for multiple tokens in batch
 * Uses POST /books endpoint
 */
export async function fetchBatchBookSnapshots(tokenIds: string[]): Promise<Map<string, OrderbookSnapshot>> {
    const config = getConfig();
    const results = new Map<string, OrderbookSnapshot>();

    if (tokenIds.length === 0) {
        return results;
    }

    // Build request body - need both BUY and SELL sides
    const requestBody: ClobBatchBookRequest[] = [];
    for (const tokenId of tokenIds) {
        requestBody.push({ token_id: tokenId, side: 'BUY' });
        requestBody.push({ token_id: tokenId, side: 'SELL' });
    }

    try {
        const response = await axios.post<ClobBookResponse[]>(
            `${config.clobHttpUrl}/books`,
            requestBody,
            {
                timeout: 30000,
                headers: { 'Content-Type': 'application/json' },
            }
        );

        // Group by token_id and merge bids/asks
        const grouped = new Map<string, { bids: PriceLevel[]; asks: PriceLevel[]; timestamp: Date }>();

        for (const book of response.data) {
            const tokenId = book.asset_id;
            const existing = grouped.get(tokenId) || { bids: [], asks: [], timestamp: new Date() };

            existing.bids = book.bids.map(b => ({
                price: parseFloat(b.price),
                size: parseFloat(b.size),
            }));
            existing.asks = book.asks.map(a => ({
                price: parseFloat(a.price),
                size: parseFloat(a.size),
            }));
            existing.timestamp = new Date(book.timestamp);

            grouped.set(tokenId, existing);
        }

        // Convert to OrderbookSnapshot
        for (const [tokenId, data] of grouped) {
            results.set(tokenId, {
                tokenId,
                bids: data.bids.sort((a, b) => b.price - a.price), // Descending
                asks: data.asks.sort((a, b) => a.price - b.price), // Ascending
                timestamp: data.timestamp,
            });
        }

        logger.info({ count: results.size, requested: tokenIds.length }, 'Fetched batch book snapshots');
        return results;
    } catch (error) {
        logger.error({ error, tokenCount: tokenIds.length }, 'Failed to fetch batch book snapshots');

        // Fallback: fetch individually
        logger.info('Falling back to individual fetches...');
        for (const tokenId of tokenIds) {
            const snapshot = await fetchBookSnapshot(tokenId);
            if (snapshot) {
                results.set(tokenId, snapshot);
            }
        }

        return results;
    }
}
