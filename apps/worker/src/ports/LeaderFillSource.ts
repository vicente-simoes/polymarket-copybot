/**
 * LeaderFillSource interface - abstraction for detecting leader fills
 * 
 * Phase 0: This interface allows swapping between:
 * - DataApiLeaderFillSource (current polling implementation)
 * - PolygonLeaderFillSource (future blockchain logs)
 * - CompositeLeaderFillSource (both sources with deduplication)
 */

/**
 * A normalized leader fill event from any source
 */
export interface LeaderFillEvent {
    // Identity
    leaderId: string;
    leaderWallet: string;

    // Source metadata
    source: 'data_api' | 'polygon';
    dedupeKey: string;

    // Chain identity (nullable for data_api)
    exchangeAddress?: string;
    blockNumber?: number;
    txHash?: string;
    logIndex?: number;
    orderHash?: string;

    // Participants (nullable for data_api)
    maker?: string;
    taker?: string;
    leaderRole?: 'maker' | 'taker' | 'unknown';

    // Trade details
    tokenId: string;
    conditionId: string;
    outcome: string;
    side: 'BUY' | 'SELL';
    leaderPrice: number;
    leaderSize: number;  // shares
    leaderUsdc: number;

    // Timestamps
    fillTs: Date;        // when the fill happened (chain block time or API timestamp)
    detectedAt: Date;    // when we detected it

    // Metadata
    title?: string;
    isBackfill?: boolean;

    // Raw payload reference
    rawPayload: unknown;
}

/**
 * Interface for leader fill sources
 */
export interface LeaderFillSource {
    /**
     * Name of this source for logging
     */
    readonly name: string;

    /**
     * Start the source (connect to WebSocket, start polling, etc.)
     */
    start(): Promise<void>;

    /**
     * Stop the source gracefully
     */
    stop(): Promise<void>;

    /**
     * Check if the source is healthy
     */
    isHealthy(): boolean;

    /**
     * Get health summary for logging
     */
    getHealthSummary(): {
        healthy: boolean;
        lastEventAt?: Date;
        eventsProcessed: number;
        errorCount: number;
    };

    /**
     * Subscribe to fill events
     * Returns an unsubscribe function
     */
    onFill(handler: (event: LeaderFillEvent) => Promise<void>): () => void;

    /**
     * Trigger a manual poll/sync (for testing or catch-up)
     */
    poll?(): Promise<number>;
}
