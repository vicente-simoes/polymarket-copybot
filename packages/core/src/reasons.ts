// Decision reasons - structured reasons for every trade decision
// Every time the system would trade or skip, store one of these

export const DecisionReasons = {
    // Trade decisions
    TRADE_OK: 'TRADE_OK',

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
} as const;

export type DecisionReason = typeof DecisionReasons[keyof typeof DecisionReasons];
