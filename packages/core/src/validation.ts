// Validation schemas using zod
// These can be used to validate API responses and runtime data

import { z } from 'zod';

// Trade side enum
export const TradeSideSchema = z.enum(['BUY', 'SELL']);

// Decision enum
export const IntentDecisionSchema = z.enum(['TRADE', 'SKIP']);

// Guardrail config schema
export const GuardrailConfigSchema = z.object({
    ratio: z.number().positive().max(1),
    maxUsdcPerTrade: z.number().positive(),
    maxUsdcPerDay: z.number().positive(),
    maxPriceMovePct: z.number().positive().max(1),
    maxSpread: z.number().positive(),
    minUsdcPerTrade: z.number().positive(),
    allowlist: z.array(z.string()).nullable(),
});

// Risk state schema
export const RiskStateSchema = z.object({
    dailyUsdcSpent: z.number().nonnegative(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD
});

// Polymarket API trade response schema (for validation during ingestion)
export const PolymarketTradeSchema = z.object({
    transactionHash: z.string(),
    timestamp: z.string().or(z.number()),
    side: TradeSideSchema,
    conditionId: z.string(),
    outcome: z.string(),
    price: z.string().or(z.number()),
    size: z.string().or(z.number()),
    usdcSize: z.string().or(z.number()).optional(),
    title: z.string().optional(),
});

// Quote data schema
export const QuoteDataSchema = z.object({
    bestBid: z.number(),
    bestAsk: z.number(),
    bidSize: z.number().optional(),
    askSize: z.number().optional(),
});

// Default guardrail config
export const DEFAULT_GUARDRAIL_CONFIG = {
    ratio: 0.01, // leader $100 -> you $1
    maxUsdcPerTrade: 2,
    maxUsdcPerDay: 10,
    maxPriceMovePct: 0.01, // 1%
    maxSpread: 0.02, // 2 cents
    minUsdcPerTrade: 0.10, // avoid dust trades
    allowlist: null, // all markets allowed by default
} as const;
