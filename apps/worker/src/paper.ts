// Paper intent generator - creates paper trading intents using strategy engine
import { prisma } from '@polymarket-bot/db';
import {
    decidePaperIntentAsync,
    DecisionReasons,
    type NormalizedTrade,
    type Quote,
    type RiskState,
} from '@polymarket-bot/core';
import pino from 'pino';
import { getLatestQuote } from './quotes';
import { resolveMapping } from './mapping';
import { simulateFillForIntent } from './fills';

const logger = pino({ name: 'paper' });

// Risk state tracking (per day)
let currentRiskState: RiskState = {
    dailyUsdcSpent: 0,
    date: new Date().toISOString().split('T')[0],
};

/**
 * Reset daily risk state if date has changed
 */
function checkAndResetDailyRisk(): void {
    const today = new Date().toISOString().split('T')[0];
    if (currentRiskState.date !== today) {
        logger.info({
            previousDate: currentRiskState.date,
            previousSpent: currentRiskState.dailyUsdcSpent,
            newDate: today
        }, 'Resetting daily risk state');
        currentRiskState = { dailyUsdcSpent: 0, date: today };
    }
}

/**
 * Get guardrail config - now primarily from DB, ratio fallback to env
 */
function getLegacyRatio(): number {
    return parseFloat(process.env.COPY_RATIO || '0.01');
}

/**
 * Generate paper intent for a trade
 */
export async function generatePaperIntentForTrade(tradeId: string): Promise<string | null> {
    // Check/reset daily risk
    checkAndResetDailyRisk();

    // Get trade with leader info
    const trade = await prisma.trade.findUnique({
        where: { id: tradeId },
        include: { leader: true },
    });

    if (!trade) {
        logger.warn({ tradeId }, 'Trade not found');
        return null;
    }

    // Check if paper intent already exists for this trade
    const existingIntent = await prisma.paperIntent.findFirst({
        where: { tradeId: trade.id },
    });

    if (existingIntent) {
        logger.debug({ tradeId }, 'Paper intent already exists');
        return existingIntent.id;
    }

    // Resolve mapping
    const mapping = await resolveMapping(trade.conditionId, trade.outcome);
    if (!mapping) {
        // Create a SKIP intent due to missing mapping
        const intent = await prisma.paperIntent.create({
            data: {
                tradeId: trade.id,
                ratio: getLegacyRatio(),
                decision: 'SKIP',
                decisionReason: DecisionReasons.SKIP_MISSING_MAPPING,
                yourUsdcTarget: 0,
                limitPrice: Number(trade.leaderPrice),
                yourSide: trade.side as 'BUY' | 'SELL' | 'SPLIT' | 'MERGE',
            },
        });

        logger.info({ tradeId, reason: DecisionReasons.SKIP_MISSING_MAPPING }, 'Paper intent: SKIP (no mapping)');
        return intent.id;
    }

    // Get latest quote for market
    const quoteRecord = await getLatestQuote(mapping.marketKey);

    // Build normalized trade object for strategy
    const normalizedTrade: NormalizedTrade = {
        id: trade.id,
        leaderId: trade.leaderId,
        dedupeKey: trade.dedupeKey,
        txHash: trade.txHash,
        tradeTs: trade.tradeTs,
        detectedAt: trade.detectedAt,
        side: trade.side as 'BUY' | 'SELL' | 'SPLIT' | 'MERGE',
        conditionId: trade.conditionId,
        outcome: trade.outcome,
        leaderPrice: Number(trade.leaderPrice),
        leaderSize: Number(trade.leaderSize),
        leaderUsdc: Number(trade.leaderUsdc),
        title: trade.title ?? null,
        rawId: trade.rawId,
    };

    // Build quote object (may be null if not captured)
    const quote: Quote | null = quoteRecord ? {
        id: quoteRecord.id,
        marketKey: quoteRecord.marketKey,
        capturedAt: quoteRecord.capturedAt,
        bestBid: Number(quoteRecord.bestBid),
        bestAsk: Number(quoteRecord.bestAsk),
        bidSize: quoteRecord.bidSize ? Number(quoteRecord.bidSize) : null,
        askSize: quoteRecord.askSize ? Number(quoteRecord.askSize) : null,
        rawId: quoteRecord.rawId,
    } : null;

    // Run strategy engine with DB-based config
    const decision = await decidePaperIntentAsync({
        trade: normalizedTrade,
        quote,
        leaderId: trade.leaderId,
        riskState: currentRiskState,
    });

    // Get the ratio used (for logging/tracking)
    const ratio = getLegacyRatio();

    // Create paper intent record
    const intent = await prisma.paperIntent.create({
        data: {
            tradeId: trade.id,
            ratio: ratio,
            decision: decision.decision,
            decisionReason: decision.decisionReason,
            yourUsdcTarget: decision.yourUsdcTarget || 0,
            limitPrice: decision.limitPrice || Number(trade.leaderPrice),
            yourSide: trade.side as 'BUY' | 'SELL' | 'SPLIT' | 'MERGE',
        },
    });

    // Update risk state if trade was approved
    if (decision.decision === 'TRADE') {
        currentRiskState.dailyUsdcSpent += decision.yourUsdcTarget || 0;

        logger.info({
            tradeId,
            decision: decision.decision,
            reason: decision.decisionReason,
            usdc: decision.yourUsdcTarget,
            limitPrice: decision.limitPrice,
            dailySpent: currentRiskState.dailyUsdcSpent,
        }, 'Paper intent: TRADE');
    } else {
        logger.info({
            tradeId,
            decision: decision.decision,
            reason: decision.decisionReason,
        }, 'Paper intent: SKIP');
    }

    // Simulate the fill immediately
    await simulateFillForIntent(intent.id);

    return intent.id;
}

/**
 * Generate paper intents for all trades that don't have them yet
 */
export async function generateMissingPaperIntents(): Promise<number> {
    // Find trades without paper intents
    const tradesWithoutIntents = await prisma.trade.findMany({
        where: {
            paperIntents: {
                none: {},
            },
        },
        orderBy: { tradeTs: 'asc' },
        take: 100, // Batch size
    });

    if (tradesWithoutIntents.length === 0) {
        return 0;
    }

    logger.info({ count: tradesWithoutIntents.length }, 'Generating paper intents for trades');

    let generated = 0;
    for (const trade of tradesWithoutIntents) {
        const intentId = await generatePaperIntentForTrade(trade.id);
        if (intentId) {
            generated++;
        }
    }

    return generated;
}

/**
 * Get paper intent stats
 */
export async function getPaperIntentStats() {
    const [total, trades, skips] = await Promise.all([
        prisma.paperIntent.count(),
        prisma.paperIntent.count({ where: { decision: 'TRADE' } }),
        prisma.paperIntent.count({ where: { decision: 'SKIP' } }),
    ]);

    return { total, trades, skips };
}
