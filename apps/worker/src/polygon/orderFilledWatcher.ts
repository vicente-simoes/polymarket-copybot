/**
 * OrderFilled watcher - subscribes to Polygon logs for leader fills
 * Phase 3: Polygon Logs
 * 
 * Implements the LeaderFillSource interface for real-time blockchain event detection.
 */

import { ethers } from 'ethers';
import { prisma } from '@polymarket-bot/db';
import pino from 'pino';
import { getConfig } from '../config.js';
import {
    ORDER_FILLED_TOPIC,
    decodeOrderFilledLog,
    deriveFillInfo,
    generateDedupeKey,
    type DecodedOrderFilled,
    type DerivedFillInfo,
} from './orderFilledDecoder.js';
import { resolveTokenId } from '../registry/resolveToken.js';
import { recordLatencyEvent } from '../latencyTracker.js';
import type { LeaderFillEvent, LeaderFillSource } from '../ports/index.js';
import { sleep } from '../retry.js';

const logger = pino({ name: 'polygon-watcher' });

/**
 * Leader info for filtering logs
 */
interface LeaderInfo {
    id: string;
    wallet: string;
    label: string;
}

/**
 * PolygonLeaderFillSource - watches OrderFilled events on Polygon
 */
export class PolygonLeaderFillSource implements LeaderFillSource {
    readonly name = 'polygon';

    private wsProvider: ethers.WebSocketProvider | null = null;
    private httpProvider: ethers.JsonRpcProvider | null = null;
    private leaders: LeaderInfo[] = [];
    private fillHandlers: Array<(event: LeaderFillEvent) => Promise<void>> = [];
    private isRunning = false;
    private lastEventAt?: Date;
    private lastWsLogAt?: Date; // Track last WS log received (distinct from processed events)
    private eventsProcessed = 0;
    private errorCount = 0;
    private subscriptionIds: string[] = [];
    // DEPRECATED: Periodic reconciliation removed - API is now source of truth for backfill
    // private reconcileInterval?: NodeJS.Timeout;
    private blockTimestampCache = new Map<number, { ts: Date; expiresAt: number }>(); // Block timestamp cache
    private lockId?: string; // Single-flight lock ID
    private hasReceivedFirstWsLog = false; // Track if we've ever received a WS log

    async start(): Promise<void> {
        const config = getConfig();

        logger.info({
            wsUrl: config.polygonWsUrl.replace(/\/v2\/[^/]+/, '/v2/***'),
            ctfExchange: config.polyExchangeCtf,
            negRiskExchange: config.polyExchangeNegRisk,
        }, 'Starting Polygon watcher...');

        // Step 3: Single-flight guard - acquire lock to prevent duplicate workers
        const lockAcquired = await this.acquireLock();
        if (!lockAcquired) {
            logger.warn('Another Polygon watcher instance is running. Skipping startup.');
            throw new Error('Polygon watcher lock already held by another instance');
        }

        // Load enabled leaders
        this.leaders = await this.loadLeaders();
        if (this.leaders.length === 0) {
            logger.warn('No enabled leaders found, watcher will not receive events');
        }

        // Create HTTP provider
        this.httpProvider = new ethers.JsonRpcProvider(config.polygonHttpUrl);

        // Create WS provider with retry logic for 429 errors
        const maxRetries = 5;
        let lastError: any = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                logger.info({ attempt, maxRetries }, 'Attempting WebSocket connection...');

                this.wsProvider = new ethers.WebSocketProvider(config.polygonWsUrl);

                // Prevent unhandled 'error' events from crashing the process
                this.wsProvider.on('error', (error) => {
                    this.errorCount++;
                    const serialized = error instanceof Error
                        ? { message: error.message, stack: error.stack, name: error.name }
                        : error;
                    logger.error({ error: serialized }, 'Polygon WebSocket provider error');
                });

                // Wait for the provider to be ready (connection established)
                // This ensures we catch connection errors early
                await this.wsProvider.ready;

                // FIX: Attach error listener to underlying socket to prevent Uncaught Exception
                // ethers.js v6 doesn't always propagate socket errors to the provider 'error' event
                const rawSocket = (this.wsProvider as any).websocket;
                if (rawSocket) {
                    rawSocket.on('error', (err: any) => {
                        // Log it but prevent crash
                        const serialized = err instanceof Error
                            ? { message: err.message, name: err.name }
                            : err;
                        logger.error({ error: serialized }, 'Underlying WebSocket error (caught)');
                    });
                }

                logger.info({ attempt }, 'WebSocket connection established successfully');
                break; // Success - exit retry loop

            } catch (wsError: any) {
                lastError = wsError;
                const is429 = wsError?.message?.includes('429') ||
                    wsError?.message?.toLowerCase()?.includes('rate limit');

                const serialized = wsError instanceof Error
                    ? { message: wsError.message, name: wsError.name }
                    : wsError;

                if (attempt < maxRetries) {
                    // Exponential backoff: 5s, 10s, 20s, 40s, 80s
                    const backoffMs = 5000 * Math.pow(2, attempt - 1);
                    logger.warn({
                        error: serialized,
                        attempt,
                        maxRetries,
                        backoffMs,
                        is429,
                    }, 'WebSocket connection failed, retrying after backoff...');

                    // Clean up failed provider
                    if (this.wsProvider) {
                        try { await this.wsProvider.destroy(); } catch (e) { /* ignore */ }
                        this.wsProvider = null;
                    }

                    await sleep(backoffMs);
                } else {
                    logger.error({
                        error: serialized,
                        attempt,
                        maxRetries,
                    }, 'WebSocket connection failed after all retries');
                    this.errorCount++;
                    throw wsError; // Re-throw so caller knows start() failed
                }
            }
        }

        // REMOVED: Background backfill via Polygon RPC getLogs
        // API is now the source of truth for all backfill/catch-up operations.
        // See fix_plan.md Step 1 - this eliminates 429 rate limit storms.
        logger.info('Polygon backfill via RPC DISABLED - API is now source of truth for backfill');

        // Subscribe to new logs (WS real-time only)
        await this.subscribeToLogs();

        // REMOVED: Periodic mini-reconciliation (also used getLogs)
        // API backfill will handle catch-up instead.

        this.isRunning = true;
        this.lastWsLogAt = new Date(); // Initialize to avoid immediate staleness
        logger.info({ leaderCount: this.leaders.length }, 'Polygon watcher started');
    }

    async stop(): Promise<void> {
        logger.info('Stopping Polygon watcher...');
        this.isRunning = false;

        // REMOVED: Periodic reconciliation no longer used
        // if (this.reconcileInterval) {
        //     clearInterval(this.reconcileInterval);
        //     this.reconcileInterval = undefined;
        // }

        // Close WebSocket connection
        if (this.wsProvider) {
            await this.wsProvider.destroy();
            this.wsProvider = null;
        }

        this.httpProvider = null;

        // Release single-flight lock
        await this.releaseLock();

        // Clear caches
        this.blockTimestampCache.clear();

        logger.info('Polygon watcher stopped');
    }

    /**
     * Step 3: Enhanced health check
     * Checks: WS connected and running.
     * Note: We log staleness warnings but don't mark as unhealthy since
     * low trading volume is normal and doesn't indicate a broken connection.
     */
    isHealthy(): boolean {
        if (!this.isRunning || !this.wsProvider) {
            return false;
        }

        // Log staleness warning but don't mark as unhealthy
        // Low trading volume should not be treated as a broken connection
        const config = getConfig();
        const now = Date.now();
        const staleThreshold = config.polygonHealthStaleMs;

        if (this.lastWsLogAt) {
            const msSinceLastLog = now - this.lastWsLogAt.getTime();
            if (msSinceLastLog > staleThreshold) {
                // Only log occasionally to avoid spam (every 5 minutes)
                if (!this.lastStaleWarningAt || now - this.lastStaleWarningAt > 300000) {
                    logger.warn({
                        msSinceLastLog,
                        staleThreshold,
                        lastWsLogAt: this.lastWsLogAt,
                    }, 'Polygon watcher may be stale - no WS logs received recently (this could be normal if trading is slow)');
                    this.lastStaleWarningAt = now;
                }
            }
        }

        return true;
    }

    private lastStaleWarningAt?: number;

    getHealthSummary() {
        const config = getConfig();
        const now = Date.now();
        const msSinceLastWsLog = this.lastWsLogAt ? now - this.lastWsLogAt.getTime() : undefined;

        return {
            healthy: this.isHealthy(),
            lastEventAt: this.lastEventAt,
            lastWsLogAt: this.lastWsLogAt,
            msSinceLastWsLog,
            staleThresholdMs: config.polygonHealthStaleMs,
            eventsProcessed: this.eventsProcessed,
            errorCount: this.errorCount,
            wsConnected: this.wsProvider !== null,
            lockId: this.lockId,
        };
    }

    onFill(handler: (event: LeaderFillEvent) => Promise<void>): () => void {
        this.fillHandlers.push(handler);
        return () => {
            const idx = this.fillHandlers.indexOf(handler);
            if (idx >= 0) this.fillHandlers.splice(idx, 1);
        };
    }

    async poll(): Promise<number> {
        // For Polygon, poll is not used for regular updates, only health checks
        // We return 0 as we don't want to trigger gap fills periodically here anymore
        // or we could return 'events processed since last poll'
        return 0;
    }

    private async loadLeaders(): Promise<LeaderInfo[]> {
        const leaders = await prisma.leader.findMany({
            where: { enabled: true },
            select: { id: true, wallet: true, label: true },
        });
        return leaders.map(l => ({
            id: l.id,
            wallet: l.wallet.toLowerCase(),
            label: l.label,
        }));
    }

    private async subscribeToLogs(): Promise<void> {
        const config = getConfig();
        const exchanges = [config.polyExchangeCtf, config.polyExchangeNegRisk];

        for (const exchange of exchanges) {
            if (!exchange || exchange === '0x') continue;

            const filter = {
                address: exchange,
                topics: [ORDER_FILLED_TOPIC],
            };

            this.wsProvider!.on(filter, async (log: ethers.Log) => {
                // Track last WS log received for health check
                this.lastWsLogAt = new Date();

                // Log first event received (helps debug subscription issues)
                if (!this.hasReceivedFirstWsLog) {
                    this.hasReceivedFirstWsLog = true;
                    logger.info({
                        exchange: log.address,
                        blockNumber: log.blockNumber,
                        txHash: log.transactionHash,
                    }, 'First WebSocket log event received - subscription is working!');
                }

                try {
                    await this.processLog({
                        topics: log.topics as string[],
                        data: log.data,
                        blockNumber: log.blockNumber,
                        transactionHash: log.transactionHash,
                        logIndex: log.index,
                        address: log.address,
                    });
                } catch (error) {
                    this.errorCount++;
                    logger.error({ error, txHash: log.transactionHash }, 'Error processing log');
                }
            });

            logger.info({ exchange }, 'Subscribed to OrderFilled events');
        }
    }

    /**
     * DEPRECATED: runBackgroundBackfill removed in fix_plan.md Step 1
     * API is now the source of truth for all backfill operations.
     * This eliminates 429 rate limit storms from excessive getLogs calls.
     */
    // @ts-ignore - Keeping for reference
    private async runBackgroundBackfill_DEPRECATED(): Promise<void> {
        logger.warn('runBackgroundBackfill is DEPRECATED - use API backfill instead');
    }

    /**
     * DEPRECATED: gapFillForExchange removed in fix_plan.md Step 1
     * API is now the source of truth for all backfill operations.
     * This method caused 429 rate limit storms via excessive getLogs calls.
     * 
     * The old implementation looped through block chunks calling httpProvider.getLogs()
     * which hammered Alchemy's free tier limits.
     */
    // @ts-ignore - Keeping for reference
    private async gapFillForExchange_DEPRECATED(_exchange: string): Promise<number> {
        logger.warn('gapFillForExchange is DEPRECATED - use API backfill instead');
        return 0;
    }

    private async getStartBlock(): Promise<number> {
        // Start from only ~10 seconds ago to stay within Alchemy free tier limit
        // Alchemy free tier only allows 10 block range for getLogs
        // Polygon has ~2s block time, so 5 blocks = ~10 seconds
        const latestBlock = await this.httpProvider!.getBlockNumber();
        return Math.max(0, latestBlock - 5);
    }

    /**
     * Process a log event from WebSocket subscription
     * fix_plan.md Step 5: Polygon WS is now a "trigger" for API ingestion
     * Instead of storing chain data directly, we:
     * 1. Identify the involved leader from the log
     * 2. Trigger an API fetch for that leader's recent trades
     * 3. Keep chain context for API lag fallback (Step 6)
     */
    private async processLog(log: {
        topics: string[];
        data: string;
        blockNumber: number;
        transactionHash: string;
        logIndex: number;
        address: string;
    }): Promise<boolean> {
        // Decode the log to identify the involved leader
        const decoded = decodeOrderFilledLog(log);
        if (!decoded) return false;

        // Check if any leader is involved
        const maker = decoded.maker.toLowerCase();
        const taker = decoded.taker.toLowerCase();

        const involvedLeader = this.leaders.find(
            l => l.wallet === maker || l.wallet === taker
        );

        if (!involvedLeader) return false;

        // Derive fill info for context
        const fillInfo = deriveFillInfo(decoded, involvedLeader.wallet);
        if (!fillInfo) return false;

        // Generate dedupe key for the chain event
        const polygonDedupeKey = generateDedupeKey(decoded);

        // Check if already processed (either by Polygon or API)
        const existing = await prisma.leaderFill.findUnique({
            where: { dedupeKey: polygonDedupeKey },
        });
        if (existing) {
            logger.debug({
                txHash: decoded.transactionHash.slice(0, 10) + '...',
                leader: involvedLeader.label,
            }, 'Log already processed, skipping');
            return false;
        }

        // Record that we detected this event for latency comparison
        const detectedAt = new Date();
        await recordLatencyEvent({
            dedupeKey: decoded.transactionHash.toLowerCase(),
            source: 'polygon',
            detectedAt,
            tokenId: fillInfo.tokenId,
            conditionId: 'pending',  // Will be resolved by API
            leaderWallet: involvedLeader.wallet,
            side: fillInfo.side,
            usdcAmount: fillInfo.usdcAmount,
        });

        logger.info({
            leader: involvedLeader.label,
            txHash: decoded.transactionHash.slice(0, 10) + '...',
            blockNumber: log.blockNumber,
        }, 'Polygon detected leader fill - triggering API ingestion');

        // Step 5+6: Trigger API ingestion with retry and chain fallback
        const config = getConfig();
        const { ingestTradesForLeader } = await import('../ingester.js');

        let totalWaitMs = 0;
        let waitMs = config.apiLagWaitMs;
        let apiFound = false;
        let lastError: Error | null = null;

        // Step 6A: Try API with retry within bounded wait window
        while (totalWaitMs < config.apiLagMaxWaitMs && config.apiLagFallbackEnabled) {
            try {
                const newTrades = await ingestTradesForLeader(involvedLeader.id, involvedLeader.wallet);

                if (newTrades > 0) {
                    logger.info({
                        leader: involvedLeader.label,
                        newTrades,
                        waitMs: totalWaitMs,
                        triggeredBy: decoded.transactionHash.slice(0, 10) + '...',
                    }, 'API ingestion triggered by Polygon - new trades found');
                    apiFound = true;
                    break;
                }

                // Step 6B: Not found yet, wait and retry with exponential backoff
                if (totalWaitMs + waitMs >= config.apiLagMaxWaitMs) {
                    break; // Would exceed max wait
                }

                logger.debug({
                    leader: involvedLeader.label,
                    txHash: decoded.transactionHash.slice(0, 10) + '...',
                    waitMs,
                    totalWaitMs,
                }, 'API ingestion found nothing, retrying after wait');

                await sleep(waitMs);
                totalWaitMs += waitMs;
                waitMs = Math.min(waitMs * 2, 3000); // Cap at 3s between retries

            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                logger.warn({
                    error: lastError.message,
                    leader: involvedLeader.label,
                    waitMs: totalWaitMs,
                }, 'API ingestion attempt failed');

                await sleep(waitMs);
                totalWaitMs += waitMs;
                waitMs = Math.min(waitMs * 2, 3000);
            }
        }

        // Step 6C: Chain fallback if API hasn't caught up
        if (!apiFound && config.chainFallbackEnabled) {
            logger.info({
                leader: involvedLeader.label,
                txHash: decoded.transactionHash.slice(0, 10) + '...',
                totalWaitMs,
            }, 'API lag fallback: storing from chain data');

            await this.ingestFromChainData(involvedLeader, decoded, fillInfo, log, detectedAt);
        } else if (!apiFound) {
            logger.debug({
                leader: involvedLeader.label,
                txHash: decoded.transactionHash.slice(0, 10) + '...',
            }, 'API lag fallback disabled - emitting pending event only');

            await this.emitPendingChainEvent(involvedLeader, decoded, fillInfo, log, detectedAt);
        }

        // Update stats
        this.eventsProcessed++;
        this.lastEventAt = detectedAt;

        return true;
    }

    /**
     * Ingest a fill directly from chain data (Step 6C fallback)
     * This is a targeted operation - single tx, no block scan
     */
    private async ingestFromChainData(
        involvedLeader: LeaderInfo,
        decoded: DecodedOrderFilled,
        fillInfo: DerivedFillInfo,
        log: { blockNumber: number; transactionHash: string; logIndex: number; address: string },
        detectedAt: Date
    ): Promise<void> {
        const dedupeKey = generateDedupeKey(decoded);

        // Check again if already processed (API might have caught up)
        const existing = await prisma.leaderFill.findUnique({
            where: { dedupeKey },
        });
        if (existing) {
            logger.debug({ dedupeKey }, 'Chain fallback skipped - already ingested');
            return;
        }

        // Resolve token info
        const tokenInfo = await resolveTokenId(fillInfo.tokenId);

        // Get block timestamp
        const fillTs = await this.getBlockTimestamp(log.blockNumber);

        // Store raw payload
        const rawPayload = JSON.parse(JSON.stringify({
            decoded: {
                ...decoded,
                makerAssetId: decoded.makerAssetId.toString(),
                takerAssetId: decoded.takerAssetId.toString(),
                makerAmountFilled: decoded.makerAmountFilled.toString(),
                takerAmountFilled: decoded.takerAmountFilled.toString(),
                fee: decoded.fee.toString(),
            },
            fillInfo,
            log,
            chainFallback: true,
        }));

        const raw = await prisma.leaderFillRaw.create({
            data: {
                source: 'polygon',  // Still polygon source, just via fallback
                payload: rawPayload,
            },
        });

        // Store normalized fill
        await prisma.leaderFill.create({
            data: {
                leaderId: involvedLeader.id,
                source: 'polygon',
                exchangeAddress: decoded.exchangeAddress,
                blockNumber: decoded.blockNumber,
                txHash: decoded.transactionHash,
                logIndex: decoded.logIndex,
                orderHash: decoded.orderHash,
                maker: decoded.maker.toLowerCase(),
                taker: decoded.taker.toLowerCase(),
                leaderRole: fillInfo.leaderRole,
                tokenId: fillInfo.tokenId,
                conditionId: tokenInfo?.conditionId || 'unknown',
                outcome: tokenInfo?.outcome || 'unknown',
                side: fillInfo.side,
                leaderPrice: fillInfo.price,
                leaderSize: fillInfo.tokenAmount,
                leaderUsdc: fillInfo.usdcAmount,
                fillTs,
                detectedAt,
                title: tokenInfo?.title,
                isBackfill: false,
                dedupeKey,
                rawId: raw.id,
            },
        });

        // Emit event to handlers
        const event: LeaderFillEvent = {
            leaderId: involvedLeader.id,
            leaderWallet: involvedLeader.wallet,
            source: 'polygon',
            dedupeKey,
            exchangeAddress: decoded.exchangeAddress,
            blockNumber: decoded.blockNumber,
            txHash: decoded.transactionHash,
            logIndex: decoded.logIndex,
            orderHash: decoded.orderHash,
            maker: decoded.maker.toLowerCase(),
            taker: decoded.taker.toLowerCase(),
            leaderRole: fillInfo.leaderRole,
            tokenId: fillInfo.tokenId,
            conditionId: tokenInfo?.conditionId || 'unknown',
            outcome: tokenInfo?.outcome || 'unknown',
            side: fillInfo.side,
            leaderPrice: fillInfo.price,
            leaderSize: fillInfo.tokenAmount,
            leaderUsdc: fillInfo.usdcAmount,
            fillTs,
            detectedAt,
            title: tokenInfo?.title ?? undefined,
            rawPayload,
        };

        for (const handler of this.fillHandlers) {
            try {
                await handler(event);
            } catch (error) {
                logger.error({ error }, 'Fill handler error');
            }
        }

        logger.info({
            leader: involvedLeader.label,
            side: fillInfo.side,
            price: fillInfo.price.toFixed(4),
            usdc: fillInfo.usdcAmount.toFixed(2),
            title: tokenInfo?.title?.slice(0, 30),
            txHash: decoded.transactionHash.slice(0, 10) + '...',
        }, 'Chain fallback ingested fill');
    }

    /**
     * Emit a pending chain event for handlers (used when API hasn't caught up yet)
     * This provides context for Step 6 (API lag fallback)
     */
    private async emitPendingChainEvent(
        involvedLeader: LeaderInfo,
        decoded: DecodedOrderFilled,
        fillInfo: DerivedFillInfo,
        log: { blockNumber: number; transactionHash: string; logIndex: number; address: string },
        detectedAt: Date
    ): Promise<void> {
        // Resolve token info for the event
        const tokenInfo = await resolveTokenId(fillInfo.tokenId);

        // Get block timestamp
        const fillTs = await this.getBlockTimestamp(log.blockNumber);

        const dedupeKey = generateDedupeKey(decoded);

        // Emit event to handlers (but don't store - that's API's job or fallback)
        const event: LeaderFillEvent = {
            leaderId: involvedLeader.id,
            leaderWallet: involvedLeader.wallet,
            source: 'polygon',
            dedupeKey,
            exchangeAddress: decoded.exchangeAddress,
            blockNumber: decoded.blockNumber,
            txHash: decoded.transactionHash,
            logIndex: decoded.logIndex,
            orderHash: decoded.orderHash,
            maker: decoded.maker.toLowerCase(),
            taker: decoded.taker.toLowerCase(),
            leaderRole: fillInfo.leaderRole,
            tokenId: fillInfo.tokenId,
            conditionId: tokenInfo?.conditionId || 'unknown',
            outcome: tokenInfo?.outcome || 'unknown',
            side: fillInfo.side,
            leaderPrice: fillInfo.price,
            leaderSize: fillInfo.tokenAmount,
            leaderUsdc: fillInfo.usdcAmount,
            fillTs,
            detectedAt,
            title: tokenInfo?.title ?? undefined,
            rawPayload: { decoded, fillInfo, log, pendingApiFetch: true },
        };

        for (const handler of this.fillHandlers) {
            try {
                await handler(event);
            } catch (error) {
                logger.error({ error }, 'Fill handler error');
            }
        }
    }

    // ============================================================================
    // Step 3: Single-flight guard, periodic reconciliation, and block cache
    // ============================================================================

    /**
     * Acquire a DB-based lock to prevent duplicate workers.
     * Uses a simple upsert pattern with a lock table.
     */
    private async acquireLock(): Promise<boolean> {
        const lockKey = 'polygon_watcher_lock';
        const lockValue = `${process.pid}-${Date.now()}`;
        const lockExpireMs = 60000; // 1 minute lock TTL

        try {
            // Try to create or update the lock
            // We use a simple approach: if the lock exists and hasn't expired, fail
            const existingLock = await prisma.systemLock.findUnique({
                where: { lockKey },
            });

            const now = new Date();

            if (existingLock) {
                // Check if lock has expired
                const lockAge = now.getTime() - existingLock.updatedAt.getTime();
                if (lockAge < lockExpireMs) {
                    logger.warn({
                        existingLockValue: existingLock.lockValue,
                        lockAge,
                    }, 'Lock already held by another process');
                    return false;
                }
                // Lock expired, take it over
                logger.info({ lockAge }, 'Taking over expired lock');
            }

            // Acquire or renew the lock
            await prisma.systemLock.upsert({
                where: { lockKey },
                create: {
                    lockKey,
                    lockValue,
                },
                update: {
                    lockValue,
                    updatedAt: now,
                },
            });

            this.lockId = lockValue;
            logger.info({ lockId: lockValue }, 'Acquired Polygon watcher lock');

            // Start a heartbeat to keep the lock alive
            this.startLockHeartbeat();

            return true;
        } catch (error) {
            logger.error({ error }, 'Error acquiring lock');
            return false;
        }
    }

    /**
     * Release the DB-based lock.
     */
    private async releaseLock(): Promise<void> {
        if (!this.lockId) return;

        const lockKey = 'polygon_watcher_lock';

        try {
            // Only delete if we still own the lock
            const existingLock = await prisma.systemLock.findUnique({
                where: { lockKey },
            });

            if (existingLock && existingLock.lockValue === this.lockId) {
                await prisma.systemLock.delete({
                    where: { lockKey },
                });
                logger.info({ lockId: this.lockId }, 'Released Polygon watcher lock');
            }
        } catch (error) {
            logger.error({ error }, 'Error releasing lock');
        }

        this.lockId = undefined;
    }

    /**
     * Start a heartbeat interval to keep the lock alive.
     */
    private lockHeartbeatInterval?: NodeJS.Timeout;
    private startLockHeartbeat(): void {
        const lockKey = 'polygon_watcher_lock';
        const heartbeatMs = 30000; // Every 30 seconds

        this.lockHeartbeatInterval = setInterval(async () => {
            if (!this.lockId || !this.isRunning) {
                if (this.lockHeartbeatInterval) {
                    clearInterval(this.lockHeartbeatInterval);
                }
                return;
            }

            try {
                await prisma.systemLock.update({
                    where: { lockKey },
                    data: { updatedAt: new Date() },
                });
            } catch (error) {
                logger.error({ error }, 'Error updating lock heartbeat');
            }
        }, heartbeatMs);
    }

    /**
     * DEPRECATED: startPeriodicReconciliation removed in fix_plan.md Step 1
     * API is now the source of truth for backfill/catch-up.
     */
    // @ts-ignore - Keeping for reference  
    private startPeriodicReconciliation_DEPRECATED(): void {
        logger.warn('startPeriodicReconciliation is DEPRECATED - use API backfill instead');
    }

    /**
     * DEPRECATED: runMiniReconciliation removed in fix_plan.md Step 1
     * This used getLogs which caused 429 rate limit issues.
     */
    // @ts-ignore - Keeping for reference
    private async runMiniReconciliation_DEPRECATED(): Promise<void> {
        logger.warn('runMiniReconciliation is DEPRECATED - use API backfill instead');
    }

    /**
     * DEPRECATED: gapFillForExchangeWithRange removed in fix_plan.md Step 1
     * This used getLogs which caused 429 rate limit issues.
     */
    // @ts-ignore - Keeping for reference
    private async gapFillForExchangeWithRange_DEPRECATED(_exchange: string, _blockCount: number): Promise<number> {
        logger.warn('gapFillForExchangeWithRange is DEPRECATED - use API backfill instead');
        return 0;
    }

    /**
     * Get block timestamp with caching to reduce RPC calls.
     */
    private async getBlockTimestamp(blockNumber: number): Promise<Date> {
        const now = Date.now();
        const CACHE_TTL_MS = 60000; // Cache for 1 minute

        // Check cache
        const cached = this.blockTimestampCache.get(blockNumber);
        if (cached && cached.expiresAt > now) {
            return cached.ts;
        }

        // Fetch from provider
        const block = await this.httpProvider!.getBlock(blockNumber);
        const ts = block ? new Date(block.timestamp * 1000) : new Date();

        // Cache it
        this.blockTimestampCache.set(blockNumber, {
            ts,
            expiresAt: now + CACHE_TTL_MS,
        });

        // Clean up old cache entries periodically
        if (this.blockTimestampCache.size > 100) {
            for (const [bn, entry] of this.blockTimestampCache.entries()) {
                if (entry.expiresAt < now) {
                    this.blockTimestampCache.delete(bn);
                }
            }
        }

        return ts;
    }
}

/**
 * Create a new Polygon leader fill source
 */
export function createPolygonSource(): LeaderFillSource {
    return new PolygonLeaderFillSource();
}
