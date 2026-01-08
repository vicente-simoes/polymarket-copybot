import { prisma } from '@polymarket-bot/db';
import pino from 'pino';
import { getEffectiveConfig, type OperationType } from '@polymarket-bot/core';
import type { BookStore, QuoteAge } from '../ports/BookStore.js';
import type { LeaderFillSource } from '../ports/LeaderFillSource.js';
import { getConfig } from '../config.js';

const logger = pino({ name: 'risk-engine' });

export interface RiskCheckResult {
    approved: boolean;
    reason?: string;
}

export class RiskEngine {
    private bookStore: BookStore | null = null;
    private polygonSource: LeaderFillSource | null = null;

    /**
     * Wire up dependencies (called from worker index.ts after creating instances)
     */
    setDependencies(bookStore: BookStore | null, polygonSource: LeaderFillSource | null): void {
        this.bookStore = bookStore;
        this.polygonSource = polygonSource;
        logger.info({
            hasBookStore: !!bookStore,
            hasPolygonSource: !!polygonSource,
        }, 'RiskEngine dependencies set');
    }

    /**
     * Check if we should skip based on Maker/Taker role
     */
    async checkMakerTaker(leaderId: string, role: string, opType: OperationType = 'BUY'): Promise<RiskCheckResult> {
        if (role === 'maker') {
            const config = await getEffectiveConfig(leaderId, opType);
            // Default to true (skip) if not configured, as following makers is dangerous
            const shouldSkip = config.skipMakerTrades ?? true;

            if (shouldSkip) {
                return { approved: false, reason: 'SKIP_MAKER_TRADE' };
            }
        }
        return { approved: true };
    }

    /**
     * Check portfolio exposure limits
     */
    async checkPortfolioLimits(
        leaderId: string,
        usdcAmount: number,
        conditionId: string,
        opType: OperationType = 'BUY'
    ): Promise<RiskCheckResult> {
        const config = await getEffectiveConfig(leaderId, opType);

        // 1. Max Exposure Per Event
        if (config.maxUsdcPerEvent) {
            // Sum current positions + open orders for this market
            // Ideally we'd group by conditionId or eventId. 
            // For now, let's look up positions by conditionId.
            const positions = await prisma.position.findMany({
                where: {
                    conditionId,
                    isClosed: false
                }
            });

            const currentExposure = positions.reduce((sum: number, p: { totalCostBasis: number }) => sum + p.totalCostBasis, 0);

            if (currentExposure + usdcAmount > config.maxUsdcPerEvent) {
                return {
                    approved: false,
                    reason: `SKIP_MAX_EVENT_EXPOSURE: Current ${currentExposure.toFixed(2)} + ${usdcAmount} > ${config.maxUsdcPerEvent}`
                };
            }
        }

        // 2. Max Open Positions (Global)
        if (config.maxOpenPositions) {
            const openPositionsCount = await prisma.position.count({
                where: { isClosed: false }
            });

            // If we are opening a NEW position (not adding to existing), check limit
            // Simple heuristic: if we don't have a position for this conditionId yet
            const hasPosition = await prisma.position.findFirst({
                where: { conditionId, isClosed: false }
            });

            if (!hasPosition && openPositionsCount >= config.maxOpenPositions) {
                return {
                    approved: false,
                    reason: `SKIP_MAX_POSITIONS: ${openPositionsCount} >= ${config.maxOpenPositions}`
                };
            }
        }

        return { approved: true };
    }

    /**
     * Check data health (BookStore + Polygon watcher connectivity)
     * This is the Phase 6 "Data Health Gate"
     * 
     * Stage 10.1: Mode rules:
     * - mode=api: Polygon health never blocks
     * - mode=polygon: Polygon health gates (blocks if unhealthy)
     * - mode=both: Degrade gracefully (warn but don't block if Polygon down)
     */
    checkDataHealth(): RiskCheckResult {
        const config = getConfig();
        const triggerMode = config.triggerMode;

        // 1. BookStore health (if using ws or ws+snapshot mode)
        if (config.bookStoreMode === 'ws' || config.bookStoreMode === 'ws+snapshot') {
            if (!this.bookStore) {
                logger.warn('BookStore not available for health check');
                return { approved: false, reason: 'SKIP_BOOKSTORE_UNHEALTHY' };
            }

            if (!this.bookStore.isHealthy()) {
                const summary = this.bookStore.getHealthSummary();
                logger.warn({ summary }, 'BookStore unhealthy, skipping trade');
                return { approved: false, reason: 'SKIP_BOOKSTORE_UNHEALTHY' };
            }
        }

        // 2. Polygon watcher health - mode-aware gating
        // Stage 10.1: Different behavior based on trigger mode
        if (triggerMode === 'polygon') {
            // POLYGON-ONLY mode: Polygon health MUST gate
            if (!this.polygonSource) {
                logger.warn('PolygonSource not available for health check (polygon mode)');
                return { approved: false, reason: 'SKIP_POLYGON_UNHEALTHY' };
            }

            if (!this.polygonSource.isHealthy()) {
                const summary = this.polygonSource.getHealthSummary();
                logger.warn({ summary }, 'Polygon watcher unhealthy - blocking trade (polygon mode)');
                return { approved: false, reason: 'SKIP_POLYGON_UNHEALTHY' };
            }
        } else if (triggerMode === 'both') {
            // BOTH mode: Degrade gracefully - warn but don't block
            if (this.polygonSource && !this.polygonSource.isHealthy()) {
                const summary = this.polygonSource.getHealthSummary();
                logger.warn({ summary, mode: 'both' },
                    'Polygon watcher unhealthy - degrading to API-only mode (not blocking)');
                // Don't block - API will continue copying
            }
        }
        // API-ONLY mode: Polygon health never checked/blocks

        return { approved: true };
    }

    /**
     * Check quote freshness for a specific token
     * Returns approved: false if quote is hard_stale
     */
    checkQuoteFreshness(tokenId: string): RiskCheckResult {
        if (!this.bookStore) {
            // If no BookStore, we can't check - but we've already checked in checkDataHealth
            // Just approve here as it means we're in REST mode
            return { approved: true };
        }

        const quoteAge: QuoteAge = this.bookStore.getQuoteAge(tokenId);

        if (quoteAge === 'hard_stale') {
            logger.warn({ tokenId, quoteAge }, 'Quote is stale, skipping trade');
            return { approved: false, reason: 'SKIP_QUOTE_STALE' };
        }

        if (quoteAge === 'soft_stale') {
            // Log a warning but still allow the trade
            logger.debug({ tokenId, quoteAge }, 'Quote is slightly stale, proceeding with caution');
        }

        return { approved: true };
    }
}

export const riskEngine = new RiskEngine();

