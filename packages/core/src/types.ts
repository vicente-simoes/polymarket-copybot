// Normalized types for the Polymarket copy-trading bot

export interface Leader {
    id: string;
    label: string;
    wallet: string;
    enabled: boolean;
    createdAt: Date;
}

export interface NormalizedTrade {
    id: string;
    leaderId: string;
    dedupeKey: string;
    txHash: string;
    tradeTs: Date;
    detectedAt: Date;
    side: 'BUY' | 'SELL' | 'SPLIT' | 'MERGE';
    conditionId: string;
    outcome: string;
    leaderPrice: number;
    leaderSize: number;
    leaderUsdc: number;
    title: string | null;
    rawId: string;
}

export interface Quote {
    id: string;
    marketKey: string;
    capturedAt: Date;
    bestBid: number;
    bestAsk: number;
    bidSize: number | null;
    askSize: number | null;
    rawId: string;
}

export interface MarketMapping {
    id: string;
    conditionId: string;
    outcome: string;
    marketKey: string;
    clobTokenId: string;
    updatedAt: Date;
}

export interface PaperIntent {
    id: string;
    tradeId: string;
    ratio: number;
    yourUsdcTarget: number;
    yourSide: 'BUY' | 'SELL' | 'SPLIT' | 'MERGE';
    limitPrice: number;
    decision: 'TRADE' | 'SKIP';
    decisionReason: string;
    createdAt: Date;
}

export interface PaperFill {
    id: string;
    intentId: string;
    filled: boolean;
    fillPrice: number | null;
    fillAt: Date | null;
    slippageAbs: number | null;
    slippagePct: number | null;
    matchSamePrice: boolean;
    quoteId: string;
}

export interface GuardrailConfig {
    ratio: number;
    maxUsdcPerTrade: number;
    maxUsdcPerDay: number;
    maxPriceMovePct: number;
    maxSpread: number;
    minUsdcPerTrade: number;
    allowlist: string[] | null; // null means all markets allowed
}

export interface RiskState {
    dailyUsdcSpent: number;
    date: string; // YYYY-MM-DD
}
