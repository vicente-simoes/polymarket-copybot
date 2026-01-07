/**
 * PaperExecutor - Depth-based paper trading execution
 * Phase 5: Execution Layer Refactor
 * 
 * Simulates realistic order execution using orderbook depth from BookStore.
 * Supports partial fills and TTL-based cancellation.
 */

import { prisma } from '@polymarket-bot/db';
import pino from 'pino';
import type {
    ExecutionAdapter,
    ExecutionInput,
    ExecutionResult,
    ExecutionFill,
    ExecutionStatus,
} from '../ports/ExecutionAdapter.js';
import type { BookStore, PriceLevel, OrderbookSnapshot } from '../ports/BookStore.js';
import { updatePosition } from '@polymarket-bot/core';

const logger = pino({ name: 'paper-executor' });

// Default TTL if not specified (30 seconds)
const DEFAULT_TTL_MS = 30000;

// Simulated latency for order submission (ms)
const SUBMIT_LATENCY_MS = 50;

/**
 * Pending order for TTL tracking
 */
interface PendingOrder {
    attemptId: string;
    tokenId: string;
    conditionId: string;
    outcome: string;
    side: 'BUY' | 'SELL';
    remainingShares: number;
    limitPrice: number;
    ttlMs: number;
    placedAt: Date;
    timeoutId: NodeJS.Timeout;
}

/**
 * PaperExecutor implementation
 */
export class PaperExecutor implements ExecutionAdapter {
    readonly name = 'paper-executor';
    readonly mode = 'paper' as const;

    private bookStore: BookStore | null = null;
    private fillHandlers: Array<(fill: ExecutionFill) => Promise<void>> = [];
    private pendingOrders: Map<string, PendingOrder> = new Map();
    private totalAttempts = 0;
    private totalFills = 0;
    private lastFillAt: Date | undefined;

    constructor(bookStore: BookStore | null) {
        this.bookStore = bookStore;
    }

    async start(): Promise<void> {
        logger.info('PaperExecutor started');
    }

    async stop(): Promise<void> {
        // Cancel all pending order timeouts
        for (const order of this.pendingOrders.values()) {
            clearTimeout(order.timeoutId);
        }
        this.pendingOrders.clear();
        logger.info('PaperExecutor stopped');
    }

    async submitMarketableLimit(input: ExecutionInput): Promise<ExecutionResult> {
        this.totalAttempts++;

        const {
            tokenId,
            conditionId,
            outcome,
            side,
            sizeShares,
            sizeUsdc,
            limitPrice,
            ttlMs = DEFAULT_TTL_MS,
            leaderFillId,
            tradeId,
            leaderPrice,
            leaderSize,
            ratio,
        } = input;

        // Create ExecutionAttempt record
        const attempt = await prisma.executionAttempt.create({
            data: {
                leaderFillId: leaderFillId || undefined,
                mode: 'paper',
                decision: 'TRADE',
                decisionReason: undefined,
                ratio,
                tokenId,
                conditionId,
                outcome,
                side,
                sizeSharesTarget: sizeShares,
                limitPrice,
                ttlMs,
                status: 'SUBMITTED',
                placedAt: new Date(),
            },
        });

        logger.info({
            attemptId: attempt.id,
            tokenId: tokenId.slice(0, 20) + '...',
            side,
            sizeShares,
            limitPrice,
        }, 'Order submitted');

        // Simulate submit latency
        await this.sleep(SUBMIT_LATENCY_MS);

        // Get orderbook from BookStore
        let book: OrderbookSnapshot | null = null;
        if (this.bookStore) {
            book = this.bookStore.getCurrentBook(tokenId);
        }

        if (!book || (side === 'BUY' && book.asks.length === 0) || (side === 'SELL' && book.bids.length === 0)) {
            // No book available - can't fill
            await prisma.executionAttempt.update({
                where: { id: attempt.id },
                data: { status: 'CANCELED', doneAt: new Date() },
            });

            logger.warn({ attemptId: attempt.id }, 'No orderbook available, canceled');

            return {
                attemptId: attempt.id,
                status: 'CANCELED',
                decision: 'TRADE',
                decisionReason: 'No orderbook available',
            };
        }

        // Sweep orderbook
        const { filledShares, fillPrice, levels } = this.sweepOrderbook(
            side,
            sizeShares,
            limitPrice,
            side === 'BUY' ? book.asks : book.bids
        );

        if (filledShares > 0) {
            // Create ExecutionFill record
            const fill = await prisma.executionFill.create({
                data: {
                    attemptId: attempt.id,
                    filledShares,
                    fillPrice,
                    fillAt: new Date(),
                },
            });

            this.totalFills++;
            this.lastFillAt = new Date();

            // Emit fill event
            const fillEvent: ExecutionFill = {
                attemptId: attempt.id,
                fillId: fill.id,
                filledShares,
                fillPrice,
                fillAt: fill.fillAt,
                isFinal: filledShares >= sizeShares,
            };

            await this.emitFill(fillEvent);

            // Update position
            await updatePosition({
                marketKey: `${conditionId}:${outcome}`,
                conditionId,
                outcome: outcome.toUpperCase(),
                title: undefined,
                operationType: side,
                shares: filledShares,
                price: fillPrice,
            });

            logger.info({
                attemptId: attempt.id,
                filledShares,
                fillPrice,
                levelsSwept: levels,
            }, 'Order filled');
        }

        // Determine final status
        const remainingShares = sizeShares - filledShares;
        let status: ExecutionStatus;

        if (remainingShares <= 0) {
            status = 'FILLED';
            await prisma.executionAttempt.update({
                where: { id: attempt.id },
                data: { status: 'FILLED', doneAt: new Date() },
            });
        } else if (filledShares > 0) {
            // Partial fill - set up TTL for remainder
            status = 'PARTIAL';
            await prisma.executionAttempt.update({
                where: { id: attempt.id },
                data: { status: 'PARTIAL' },
            });

            this.setupTtlCancellation(attempt.id, {
                tokenId,
                conditionId,
                outcome,
                side,
                remainingShares,
                limitPrice,
                ttlMs,
            });
        } else {
            // No fill - set up TTL for full order
            status = 'SUBMITTED';
            this.setupTtlCancellation(attempt.id, {
                tokenId,
                conditionId,
                outcome,
                side,
                remainingShares: sizeShares,
                limitPrice,
                ttlMs,
            });
        }

        return {
            attemptId: attempt.id,
            status,
            decision: 'TRADE',
        };
    }

    async cancel(orderId: string): Promise<boolean> {
        const pending = this.pendingOrders.get(orderId);
        if (!pending) {
            return false;
        }

        clearTimeout(pending.timeoutId);
        this.pendingOrders.delete(orderId);

        await prisma.executionAttempt.update({
            where: { id: orderId },
            data: { status: 'CANCELED', doneAt: new Date() },
        });

        logger.info({ attemptId: orderId }, 'Order canceled manually');
        return true;
    }

    onFill(handler: (fill: ExecutionFill) => Promise<void>): () => void {
        this.fillHandlers.push(handler);
        return () => {
            const idx = this.fillHandlers.indexOf(handler);
            if (idx >= 0) {
                this.fillHandlers.splice(idx, 1);
            }
        };
    }

    getPendingOrders(): ExecutionResult[] {
        return Array.from(this.pendingOrders.values()).map(order => ({
            attemptId: order.attemptId,
            status: 'PARTIAL' as ExecutionStatus,
            decision: 'TRADE' as const,
        }));
    }

    isHealthy(): boolean {
        return true; // Paper executor is always healthy
    }

    getHealthSummary() {
        return {
            healthy: true,
            pendingOrders: this.pendingOrders.size,
            totalAttempts: this.totalAttempts,
            totalFills: this.totalFills,
            lastFillAt: this.lastFillAt,
        };
    }

    // === Private Methods ===

    /**
     * Sweep orderbook to simulate fill
     */
    private sweepOrderbook(
        side: 'BUY' | 'SELL',
        targetShares: number,
        limitPrice: number,
        levels: PriceLevel[]
    ): { filledShares: number; fillPrice: number; levels: number } {
        let filledShares = 0;
        let totalValue = 0;
        let levelsSwept = 0;

        for (const level of levels) {
            // Check price limit
            if (side === 'BUY' && level.price > limitPrice) {
                break; // Ask too high
            }
            if (side === 'SELL' && level.price < limitPrice) {
                break; // Bid too low
            }

            const remainingToFill = targetShares - filledShares;
            const fillFromLevel = Math.min(level.size, remainingToFill);

            filledShares += fillFromLevel;
            totalValue += fillFromLevel * level.price;
            levelsSwept++;

            if (filledShares >= targetShares) {
                break;
            }
        }

        const avgFillPrice = filledShares > 0 ? totalValue / filledShares : 0;

        return {
            filledShares,
            fillPrice: avgFillPrice,
            levels: levelsSwept,
        };
    }

    /**
     * Set up TTL cancellation for pending order
     */
    private setupTtlCancellation(
        attemptId: string,
        params: {
            tokenId: string;
            conditionId: string;
            outcome: string;
            side: 'BUY' | 'SELL';
            remainingShares: number;
            limitPrice: number;
            ttlMs: number;
        }
    ): void {
        const timeoutId = setTimeout(async () => {
            // Cancel the order
            this.pendingOrders.delete(attemptId);

            await prisma.executionAttempt.update({
                where: { id: attemptId },
                data: { status: 'CANCELED', doneAt: new Date() },
            });

            logger.info({ attemptId, remainingShares: params.remainingShares }, 'Order TTL expired, canceled');
        }, params.ttlMs);

        this.pendingOrders.set(attemptId, {
            attemptId,
            tokenId: params.tokenId,
            conditionId: params.conditionId,
            outcome: params.outcome,
            side: params.side,
            remainingShares: params.remainingShares,
            limitPrice: params.limitPrice,
            ttlMs: params.ttlMs,
            placedAt: new Date(),
            timeoutId,
        });
    }

    /**
     * Emit fill to all handlers
     */
    private async emitFill(fill: ExecutionFill): Promise<void> {
        for (const handler of this.fillHandlers) {
            try {
                await handler(fill);
            } catch (error) {
                logger.error({ error, fillId: fill.fillId }, 'Fill handler error');
            }
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

/**
 * Create a new PaperExecutor
 */
export function createPaperExecutor(bookStore: BookStore | null): ExecutionAdapter {
    return new PaperExecutor(bookStore);
}
