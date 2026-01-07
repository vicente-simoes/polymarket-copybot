/**
 * BookStore interface - abstraction for market data (quotes/orderbook)
 * 
 * Phase 0: This interface allows swapping between:
 * - RestBookStore (current per-trade REST API calls)
 * - WsBookStore (future WebSocket streaming)
 * - HybridBookStore (WS primary with REST snapshots for resync)
 */

/**
 * A price level in the orderbook
 */
export interface PriceLevel {
    price: number;
    size: number;
}

/**
 * Best bid/ask snapshot
 */
export interface BestBidAsk {
    bid: number | null;
    bidSize: number | null;
    ask: number | null;
    askSize: number | null;
    updatedAt: Date;
}

/**
 * Full orderbook snapshot at a point in time
 */
export interface OrderbookSnapshot {
    tokenId: string;
    bids: PriceLevel[];
    asks: PriceLevel[];
    timestamp: Date;
}

/**
 * Quote age classification for data health gates
 */
export type QuoteAge = 'fresh' | 'soft_stale' | 'hard_stale' | 'unknown';

/**
 * Quote age thresholds in milliseconds
 */
export const QUOTE_AGE_THRESHOLDS = {
    FRESH_MAX_MS: 2000,       // <= 2s
    SOFT_STALE_MAX_MS: 5000,  // 2-5s
    // > 5s = hard stale
};

/**
 * Interface for book/quote stores
 */
export interface BookStore {
    /**
     * Name of this store for logging
     */
    readonly name: string;

    /**
     * Start the store (connect WS, initialize cache, etc.)
     */
    start(): Promise<void>;

    /**
     * Stop the store gracefully
     */
    stop(): Promise<void>;

    /**
     * Subscribe to a tokenId to receive updates
     */
    subscribe(tokenId: string): Promise<void>;

    /**
     * Unsubscribe from a tokenId
     */
    unsubscribe(tokenId: string): Promise<void>;

    /**
     * Get current best bid/ask for a token
     * Returns null if not subscribed or no data
     */
    getBestBidAsk(tokenId: string): BestBidAsk | null;

    /**
     * Get the quote age classification for a token
     */
    getQuoteAge(tokenId: string): QuoteAge;

    /**
     * Get orderbook snapshot at a specific time (from ring buffer)
     * Used for fill simulation
     * Returns null if not available
     */
    getBookAt(tokenId: string, timestamp: Date): OrderbookSnapshot | null;

    /**
     * Get current orderbook snapshot
     */
    getCurrentBook(tokenId: string): OrderbookSnapshot | null;

    /**
     * Force refresh from REST API (for single token)
     */
    refreshToken(tokenId: string): Promise<BestBidAsk | null>;

    /**
     * Check if the store is healthy
     */
    isHealthy(): boolean;

    /**
     * Get health summary for logging
     */
    getHealthSummary(): {
        healthy: boolean;
        subscribedTokens: number;
        freshQuotes: number;
        staleQuotes: number;
        lastUpdateAt?: Date;
    };
}
