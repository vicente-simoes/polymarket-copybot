// Decision reasons - structured reasons for every trade decision
// Every time the system would trade or skip, store one of these

export const DecisionReasons = {
    // Trade decisions
    TRADE_OK: 'TRADE_OK',
    OPERATION_ALWAYS_FOLLOW: 'OPERATION_ALWAYS_FOLLOW', // SELL/SPLIT/MERGE always followed

    // Skip decisions
    SKIP_PRICE_MOVED: 'SKIP_PRICE_MOVED',
    SKIP_SPREAD_TOO_WIDE: 'SKIP_SPREAD_TOO_WIDE',
    SKIP_MAX_TRADE_EXCEEDED: 'SKIP_MAX_TRADE_EXCEEDED',
    SKIP_MAX_DAILY_EXCEEDED: 'SKIP_MAX_DAILY_EXCEEDED',
    SKIP_MARKET_NOT_ALLOWED: 'SKIP_MARKET_NOT_ALLOWED',
    SKIP_MISSING_MAPPING: 'SKIP_MISSING_MAPPING',
    SKIP_NO_QUOTE: 'SKIP_NO_QUOTE',
    SKIP_BELOW_MIN: 'SKIP_BELOW_MIN',
    SKIP_SAME_PRICE_NOT_AVAILABLE: 'SKIP_SAME_PRICE_NOT_AVAILABLE',

    // Phase 6: Data Health Gate
    SKIP_BOOKSTORE_UNHEALTHY: 'SKIP_BOOKSTORE_UNHEALTHY',
    SKIP_POLYGON_UNHEALTHY: 'SKIP_POLYGON_UNHEALTHY',
    SKIP_QUOTE_STALE: 'SKIP_QUOTE_STALE',
} as const;

export type DecisionReason = typeof DecisionReasons[keyof typeof DecisionReasons];
