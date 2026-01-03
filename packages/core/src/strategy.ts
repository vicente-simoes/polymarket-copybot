// Strategy engine - single source of truth for paper and live trading decisions
// This module contains all the logic for deciding whether to trade or skip

import { NormalizedTrade, Quote, GuardrailConfig, RiskState } from './types';
import { DecisionReason, DecisionReasons } from './reasons';

export interface PaperIntentDecision {
    decision: 'TRADE' | 'SKIP';
    decisionReason: DecisionReason;
    limitPrice: number;
    yourUsdcTarget: number;
    yourSide: 'BUY' | 'SELL';
    matchSamePrice: boolean;
}

export interface DecideIntentInput {
    trade: NormalizedTrade;
    quote: Quote | null;
    config: GuardrailConfig;
    riskState: RiskState;
}

/**
 * Core decision function - determines whether to copy a leader trade.
 * 
 * This function is the SINGLE SOURCE OF TRUTH used by both paper and live modes.
 * Any changes here affect both modes identically.
 */
export function decidePaperIntent(input: DecideIntentInput): PaperIntentDecision {
    const { trade, quote, config, riskState } = input;

    // Calculate target notional
    let yourUsdcTarget = trade.leaderUsdc * config.ratio;

    // Apply min/max constraints
    yourUsdcTarget = Math.max(yourUsdcTarget, config.minUsdcPerTrade);
    yourUsdcTarget = Math.min(yourUsdcTarget, config.maxUsdcPerTrade);

    const limitPrice = trade.leaderPrice;
    const yourSide = trade.side;

    // Default result template
    const result: PaperIntentDecision = {
        decision: 'SKIP',
        decisionReason: DecisionReasons.TRADE_OK,
        limitPrice,
        yourUsdcTarget,
        yourSide,
        matchSamePrice: false,
    };

    // Check: no quote available
    if (!quote) {
        result.decisionReason = DecisionReasons.SKIP_NO_QUOTE;
        return result;
    }

    // Check: below minimum
    if (yourUsdcTarget < config.minUsdcPerTrade) {
        result.decisionReason = DecisionReasons.SKIP_BELOW_MIN;
        return result;
    }

    // Check: exceeds per-trade max
    if (yourUsdcTarget > config.maxUsdcPerTrade) {
        result.decisionReason = DecisionReasons.SKIP_MAX_TRADE_EXCEEDED;
        return result;
    }

    // Check: exceeds daily max
    if (riskState.dailyUsdcSpent + yourUsdcTarget > config.maxUsdcPerDay) {
        result.decisionReason = DecisionReasons.SKIP_MAX_DAILY_EXCEEDED;
        return result;
    }

    // Check: allowlist
    if (config.allowlist !== null && !config.allowlist.includes(trade.conditionId)) {
        result.decisionReason = DecisionReasons.SKIP_MARKET_NOT_ALLOWED;
        return result;
    }

    // Check: spread too wide
    const spread = quote.bestAsk - quote.bestBid;
    if (spread > config.maxSpread) {
        result.decisionReason = DecisionReasons.SKIP_SPREAD_TOO_WIDE;
        return result;
    }

    // Check: same-price match rule
    // For BUY: can fill at leader price if bestAsk <= leaderPrice
    // For SELL: can fill at leader price if bestBid >= leaderPrice
    let matchSamePrice = false;
    if (trade.side === 'BUY') {
        matchSamePrice = quote.bestAsk <= trade.leaderPrice;
    } else {
        matchSamePrice = quote.bestBid >= trade.leaderPrice;
    }

    if (!matchSamePrice) {
        // Check how much the price has moved
        const priceMove = trade.side === 'BUY'
            ? (quote.bestAsk - trade.leaderPrice) / trade.leaderPrice
            : (trade.leaderPrice - quote.bestBid) / trade.leaderPrice;

        if (priceMove > config.maxPriceMovePct) {
            result.decisionReason = DecisionReasons.SKIP_PRICE_MOVED;
            return result;
        }

        // Price moved but within tolerance - still skip if we require same price
        result.decisionReason = DecisionReasons.SKIP_SAME_PRICE_NOT_AVAILABLE;
        return result;
    }

    // All checks passed - trade!
    result.decision = 'TRADE';
    result.decisionReason = DecisionReasons.TRADE_OK;
    result.matchSamePrice = matchSamePrice;

    return result;
}
