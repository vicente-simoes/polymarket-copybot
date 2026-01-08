// Paper intent generator - creates paper trading intents using strategy engine
import { prisma } from '@polymarket-bot/db';

// Infer types from Prisma client to avoid export issues
type Trade = NonNullable<Awaited<ReturnType<typeof prisma.trade.findFirst>>>;
type Leader = NonNullable<Awaited<ReturnType<typeof prisma.leader.findFirst>>>;
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
import { getExecutor } from './execution/executorService.js';
import type { ExecutionInput } from './ports/ExecutionAdapter.js';
import { riskEngine } from './execution/risk.js';
import { getEffectiveConfig, type OperationType } from '@polymarket-bot/core';

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

    // Stage 1.1: Never create paper intents for backfill trades (fix phantom positions bug)
    if (trade.isBackfill) {
        logger.debug({ tradeId }, 'Skipping backfill trade - no paper intent generated');
        await createSkipIntent(trade, 'SKIP_BACKFILL', 'Trade was ingested during backfill - not eligible for paper trading');
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

    // --- Phase 6: Risk Control ---
    // 0. Determine Leader Role
    let leaderRole = 'unknown';
    if (trade.txHash) {
        // Try to find linked LeaderFill for role info
        const leaderFill = await prisma.leaderFill.findFirst({
            where: { txHash: trade.txHash }
        });
        if (leaderFill) leaderRole = leaderFill.leaderRole;
    }

    // 1. Maker/Taker Check
    const opType = trade.side as OperationType;
    const makerCheck = await riskEngine.checkMakerTaker(trade.leaderId, leaderRole, opType);
    if (!makerCheck.approved) {
        await createSkipIntent(trade, 'SKIP_RISK_MAKER', makerCheck.reason);
        return 'SKIPPED';
    }

    // 2. Portfolio Limits Check
    // Estimate cost based on leader size or default max until we have real sizing
    const config = await getEffectiveConfig(trade.leaderId, opType);
    const estimatedUsdc = config.maxUsdcPerTrade || 10;

    const portfolioCheck = await riskEngine.checkPortfolioLimits(trade.leaderId, estimatedUsdc, trade.conditionId);
    if (!portfolioCheck.approved) {
        await createSkipIntent(trade, 'SKIP_RISK_LIMIT', portfolioCheck.reason);
        return 'SKIPPED';
    }

    // 3. Data Health Check (BookStore + Polygon watcher)
    const dataHealthCheck = riskEngine.checkDataHealth();
    if (!dataHealthCheck.approved) {
        await createSkipIntent(trade, dataHealthCheck.reason || 'SKIP_DATA_UNHEALTHY');
        return 'SKIPPED';
    }
    // ----------------------------

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

    // 4. Quote Freshness Check (only if we have a tokenId from mapping)
    if (mapping.clobTokenId) {
        const quoteFreshnessCheck = riskEngine.checkQuoteFreshness(mapping.clobTokenId);
        if (!quoteFreshnessCheck.approved) {
            await createSkipIntent(trade, quoteFreshnessCheck.reason || 'SKIP_QUOTE_STALE');
            return 'SKIPPED';
        }
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

    // Stage 8.3: Proportional sell sizing
    // For SELL trades, calculate size based on leader's position reduction vs our position
    let proportionalSellUsdc: number | null = null;
    if (trade.side === 'SELL') {
        const { getPaperPosition, calculateProportionalSellSize } = await import('./ingest/paperPosition.js');
        const { getLeaderPosition } = await import('./ingest/leaderPosition.js');

        // Get our paper position
        const ourPosition = await getPaperPosition(trade.conditionId, trade.outcome.toUpperCase());

        // Get leader's position BEFORE this sell (note: was already updated in ingestTrade, need pre-trade)
        // We stored this in ingestTrade result, but since we're in a separate call, we compute it
        // leaderPreSellShares = current shares + this sell size (since position was already decremented)
        const leaderCurrentShares = await getLeaderPosition(trade.leaderId, trade.conditionId, trade.outcome);
        const leaderPreSellShares = leaderCurrentShares + Number(trade.leaderSize);

        if (ourPosition.shares <= 0) {
            // We have no position to sell
            await createSkipIntent(trade, 'SKIP_NO_POSITION', 'No paper position to sell for this condition/outcome');
            return 'SKIPPED';
        }

        // Calculate proportional sell shares
        const proportionalShares = calculateProportionalSellSize(
            ourPosition.shares,
            leaderPreSellShares,
            Number(trade.leaderSize)
        );

        // Convert to USDC using leader's price
        proportionalSellUsdc = proportionalShares * Number(trade.leaderPrice);

        logger.debug({
            tradeId,
            ourShares: ourPosition.shares,
            leaderPreSellShares,
            leaderSellSize: Number(trade.leaderSize),
            proportionalShares,
            proportionalSellUsdc,
        }, 'Proportional sell calculated');
    }

    // Run strategy engine with DB-based config
    const decision = await decidePaperIntentAsync({
        trade: normalizedTrade,
        quote,
        leaderId: trade.leaderId,
        riskState: currentRiskState,
    });

    // Stage 8.3: Override USDC target for proportional sells
    if (proportionalSellUsdc !== null && decision.decision === 'TRADE') {
        decision.yourUsdcTarget = proportionalSellUsdc;
    }

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

    // Execute the trade (use PaperExecutor if available, else legacy fill simulation)
    if (decision.decision === 'TRADE') {
        const executor = getExecutor();
        if (executor && mapping.clobTokenId) {
            // Use new depth-based executor
            const execInput: ExecutionInput = {
                tradeId: trade.id,
                tokenId: mapping.clobTokenId,
                conditionId: trade.conditionId,
                outcome: trade.outcome,
                side: trade.side as 'BUY' | 'SELL',
                sizeShares: (decision.yourUsdcTarget || 0) / (decision.limitPrice || Number(trade.leaderPrice)),
                sizeUsdc: decision.yourUsdcTarget || 0,
                limitPrice: decision.limitPrice || Number(trade.leaderPrice),
                ttlMs: 30000,
                leaderPrice: Number(trade.leaderPrice),
                leaderSize: Number(trade.leaderSize),
                ratio,
            };
            await executor.submitMarketableLimit(execInput);
        } else {
            // Fallback to legacy fill simulation
            await simulateFillForIntent(intent.id);
        }
    } else {
        // SKIP decisions still use legacy for record-keeping
        await simulateFillForIntent(intent.id);
    }

    return intent.id;
}

async function createSkipIntent(trade: Trade, reasonShort: string, reasonLong?: string): Promise<void> {
    await prisma.paperIntent.create({
        data: {
            tradeId: trade.id,
            ratio: 0,
            yourUsdcTarget: 0,
            yourSide: trade.side,
            limitPrice: 0,
            decision: 'SKIP',
            decisionReason: `${reasonShort}${reasonLong ? ': ' + reasonLong : ''}`,
            createdAt: new Date(),
        },
    });

    logger.info({ tradeId: trade.id, reason: reasonShort }, 'Paper intent: SKIP (Risk)');
}

/**
 * Generate paper intents for all trades that don't have them yet
 */
export async function generateMissingPaperIntents(): Promise<number> {
    // Find trades without paper intents
    // Stage 1.1: Exclude backfill trades to prevent phantom positions
    const tradesWithoutIntents = await prisma.trade.findMany({
        where: {
            paperIntents: {
                none: {},
            },
            isBackfill: false,  // Never generate intents for backfill trades
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
