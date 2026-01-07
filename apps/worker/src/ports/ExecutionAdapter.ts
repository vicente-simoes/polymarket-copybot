/**
 * ExecutionAdapter interface - abstraction for order execution
 * 
 * Phase 0: This interface allows swapping between:
 * - PaperExecutor (current simulation with depth + latency + TTL)
 * - ClobExecutor (future live trading via Polymarket CLOB API)
 */

/**
 * Input for submitting an execution order
 */
export interface ExecutionInput {
    // Trade identity
    leaderFillId?: string;  // optional reference to the leader fill
    tradeId?: string;       // optional reference to the trade

    // Order details
    tokenId: string;
    conditionId: string;
    outcome: string;
    side: 'BUY' | 'SELL';

    // Sizing
    sizeShares: number;
    sizeUsdc: number;

    // Pricing
    limitPrice: number;

    // Timing
    ttlMs: number;              // time-to-live before cancel
    placedAtTs?: Date;          // for paper simulation time alignment

    // Metadata
    leaderPrice: number;
    leaderSize: number;
    ratio: number;
}

/**
 * Result from an execution attempt
 */
export interface ExecutionResult {
    attemptId: string;
    orderId?: string;          // for live orders
    status: ExecutionStatus;
    decision: 'TRADE' | 'SKIP';
    decisionReason?: string;
}

/**
 * Status of an execution attempt
 */
export type ExecutionStatus =
    | 'SKIPPED'     // decision was SKIP
    | 'SUBMITTED'   // order placed, waiting for fills
    | 'PARTIAL'     // partially filled
    | 'FILLED'      // fully filled
    | 'CANCELED'    // canceled (TTL expired or manual)
    | 'FAILED';     // failed to execute

/**
 * A fill event from execution
 */
export interface ExecutionFill {
    attemptId: string;
    fillId: string;
    filledShares: number;
    fillPrice: number;
    feeUsdc?: number;
    fillAt: Date;
    isFinal: boolean;          // true if this completes the order
}

/**
 * Interface for execution adapters
 */
export interface ExecutionAdapter {
    /**
     * Name of this adapter for logging
     */
    readonly name: string;

    /**
     * Mode of execution (paper or live)
     */
    readonly mode: 'paper' | 'live';

    /**
     * Start the adapter (connect to user stream for live, etc.)
     */
    start(): Promise<void>;

    /**
     * Stop the adapter gracefully
     */
    stop(): Promise<void>;

    /**
     * Submit a marketable limit order
     * Returns the attempt result
     */
    submitMarketableLimit(input: ExecutionInput): Promise<ExecutionResult>;

    /**
     * Cancel an order by orderId (for live orders)
     */
    cancel?(orderId: string): Promise<boolean>;

    /**
     * Subscribe to fill events
     * Returns an unsubscribe function
     */
    onFill(handler: (fill: ExecutionFill) => Promise<void>): () => void;

    /**
     * Get pending orders (orders that are SUBMITTED or PARTIAL)
     */
    getPendingOrders(): ExecutionResult[];

    /**
     * Check if the adapter is healthy
     */
    isHealthy(): boolean;

    /**
     * Get health summary for logging
     */
    getHealthSummary(): {
        healthy: boolean;
        pendingOrders: number;
        totalAttempts: number;
        totalFills: number;
        lastFillAt?: Date;
    };
}
