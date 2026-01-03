// Paper fill simulator - simulates whether paper intents would have filled
import { prisma } from '@polymarket-bot/db';
import pino from 'pino';
import { getLatestQuote, getQuoteNearTimestamp } from './quotes';
import { resolveMapping } from './mapping';

const logger = pino({ name: 'fills' });

export interface FillSimulationResult {
    filled: boolean;
    fillPrice: number | null;
    matchSamePrice: boolean;
    slippageAbs: number | null;
    slippagePct: number | null;
    reason?: string;
}

/**
 * Simulate a fill for a paper intent
 * Returns simulation result with fill details
 */
export async function simulateFillForIntent(intentId: string): Promise<string | null> {
    // Get the intent with related trade
    const intent = await prisma.paperIntent.findUnique({
        where: { id: intentId },
        include: {
            trade: true,
            paperFill: true, // Check if already simulated
        },
    });

    if (!intent) {
        logger.warn({ intentId }, 'Intent not found');
        return null;
    }

    // Skip if already has a fill
    if (intent.paperFill) {
        logger.debug({ intentId }, 'Fill already exists');
        return intent.paperFill.id;
    }

    // If decision was SKIP, create a no-fill record
    if (intent.decision === 'SKIP') {
        const fill = await prisma.paperFill.create({
            data: {
                intentId: intent.id,
                filled: false,
                matchSamePrice: false,
                // No fill details for skipped intents
            },
        });

        logger.debug({ intentId, decision: 'SKIP' }, 'Paper fill: not attempted (SKIP)');
        return fill.id;
    }

    // For TRADE decisions, we need to simulate the fill
    const trade = intent.trade;

    // Resolve mapping to get marketKey
    const mapping = await resolveMapping(trade.conditionId, trade.outcome);
    if (!mapping) {
        // No mapping means we can't simulate - this shouldn't happen for TRADE intents
        const fill = await prisma.paperFill.create({
            data: {
                intentId: intent.id,
                filled: false,
                matchSamePrice: false,
            },
        });

        logger.warn({ intentId }, 'Paper fill: no mapping available');
        return fill.id;
    }

    // Get quote near the trade time for more accurate simulation
    const quote = await getQuoteNearTimestamp(mapping.marketKey, trade.tradeTs, 60000)
        || await getLatestQuote(mapping.marketKey);

    if (!quote) {
        // No quote available - can't determine fill
        const fill = await prisma.paperFill.create({
            data: {
                intentId: intent.id,
                filled: false,
                matchSamePrice: false,
            },
        });

        logger.warn({ intentId, marketKey: mapping.marketKey }, 'Paper fill: no quote available');
        return fill.id;
    }

    // Simulate the fill based on same-price rule
    const leaderPrice = Number(trade.leaderPrice);
    const limitPrice = Number(intent.limitPrice);
    const bestBid = Number(quote.bestBid);
    const bestAsk = Number(quote.bestAsk);
    const side = intent.yourSide;

    let matchSamePrice = false;
    let filled = false;
    let fillPrice: number | null = null;
    let slippageAbs: number | null = null;
    let slippagePct: number | null = null;

    if (side === 'BUY') {
        // BUY: match if bestAsk <= leaderPrice
        matchSamePrice = bestAsk <= leaderPrice;

        if (matchSamePrice) {
            filled = true;
            // Fill at the ask price (what we'd pay)
            fillPrice = bestAsk;
            // Slippage is difference from leader price (negative means we got better price)
            slippageAbs = fillPrice - leaderPrice;
            slippagePct = leaderPrice > 0 ? slippageAbs / leaderPrice : 0;
        }
    } else {
        // SELL: match if bestBid >= leaderPrice
        matchSamePrice = bestBid >= leaderPrice;

        if (matchSamePrice) {
            filled = true;
            // Fill at the bid price (what we'd receive)
            fillPrice = bestBid;
            // Slippage is difference from leader price (positive means we got worse price for sell)
            slippageAbs = leaderPrice - fillPrice;
            slippagePct = leaderPrice > 0 ? slippageAbs / leaderPrice : 0;
        }
    }

    // Create the fill record
    const fill = await prisma.paperFill.create({
        data: {
            intentId: intent.id,
            filled,
            fillPrice: filled ? fillPrice : null,
            fillAt: filled ? new Date() : null,
            matchSamePrice,
            slippageAbs: filled ? slippageAbs : null,
            slippagePct: filled ? slippagePct : null,
            quoteId: quote.id,
        },
    });

    logger.info({
        intentId,
        side,
        leaderPrice,
        bestBid,
        bestAsk,
        matchSamePrice,
        filled,
        fillPrice,
        slippageAbs: slippageAbs?.toFixed(4),
        slippagePct: slippagePct ? `${(slippagePct * 100).toFixed(2)}%` : null,
    }, filled ? 'Paper fill: FILLED' : 'Paper fill: NOT FILLED');

    return fill.id;
}

/**
 * Simulate fills for all intents that don't have them yet
 */
export async function simulateMissingFills(): Promise<number> {
    // Find TRADE intents without fills
    const intentsWithoutFills = await prisma.paperIntent.findMany({
        where: {
            paperFill: null,
        },
        orderBy: { createdAt: 'asc' },
        take: 100, // Batch size
    });

    if (intentsWithoutFills.length === 0) {
        return 0;
    }

    logger.info({ count: intentsWithoutFills.length }, 'Simulating fills for intents');

    let simulated = 0;
    for (const intent of intentsWithoutFills) {
        const fillId = await simulateFillForIntent(intent.id);
        if (fillId) {
            simulated++;
        }
    }

    return simulated;
}

/**
 * Get paper fill stats
 */
export async function getPaperFillStats() {
    const [total, filled, notFilled, matchedPrice] = await Promise.all([
        prisma.paperFill.count(),
        prisma.paperFill.count({ where: { filled: true } }),
        prisma.paperFill.count({ where: { filled: false } }),
        prisma.paperFill.count({ where: { matchSamePrice: true } }),
    ]);

    // Calculate average slippage for filled orders
    const filledWithSlippage = await prisma.paperFill.findMany({
        where: {
            filled: true,
            slippagePct: { not: null },
        },
        select: { slippagePct: true },
    });

    const avgSlippagePct = filledWithSlippage.length > 0
        ? filledWithSlippage.reduce((sum, f) => sum + Number(f.slippagePct || 0), 0) / filledWithSlippage.length
        : 0;

    return {
        total,
        filled,
        notFilled,
        matchedPrice,
        fillRate: total > 0 ? (filled / total) * 100 : 0,
        avgSlippagePct: avgSlippagePct * 100, // as percentage
    };
}
