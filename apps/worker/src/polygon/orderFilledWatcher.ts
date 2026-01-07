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
    private eventsProcessed = 0;
    private errorCount = 0;
    private subscriptionIds: string[] = [];

    async start(): Promise<void> {
        const config = getConfig();

        logger.info({
            wsUrl: config.polygonWsUrl.replace(/\/v2\/[^/]+/, '/v2/***'),
            ctfExchange: config.polyExchangeCtf,
            negRiskExchange: config.polyExchangeNegRisk,
        }, 'Starting Polygon watcher...');

        // Load enabled leaders
        this.leaders = await this.loadLeaders();
        if (this.leaders.length === 0) {
            logger.warn('No enabled leaders found, watcher will not receive events');
        }

        // Create providers
        this.httpProvider = new ethers.JsonRpcProvider(config.polygonHttpUrl);
        this.wsProvider = new ethers.WebSocketProvider(config.polygonWsUrl);

        // Start background backfill (don't await)
        this.runBackgroundBackfill().catch(err => {
            logger.error({ error: err }, 'Background backfill process failed');
        });

        // Subscribe to new logs
        await this.subscribeToLogs();

        this.isRunning = true;
        logger.info({ leaderCount: this.leaders.length }, 'Polygon watcher started');
    }

    async stop(): Promise<void> {
        logger.info('Stopping Polygon watcher...');
        this.isRunning = false;

        // Close WebSocket connection
        if (this.wsProvider) {
            await this.wsProvider.destroy();
            this.wsProvider = null;
        }

        this.httpProvider = null;
        logger.info('Polygon watcher stopped');
    }

    isHealthy(): boolean {
        return this.isRunning && this.wsProvider !== null;
    }

    getHealthSummary() {
        return {
            healthy: this.isHealthy(),
            lastEventAt: this.lastEventAt,
            eventsProcessed: this.eventsProcessed,
            errorCount: this.errorCount,
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

    private async runBackgroundBackfill(): Promise<void> {
        const config = getConfig();
        const exchanges = [config.polyExchangeCtf, config.polyExchangeNegRisk];
        let totalProcessed = 0;

        logger.info('Starting background gap-fill (throttled)...');

        for (const exchange of exchanges) {
            if (!exchange || exchange === '0x') continue;

            for (const leader of this.leaders) {
                // Check if stopped
                if (!this.isRunning) return;

                try {
                    const processed = await this.gapFillForLeader(exchange, leader);
                    totalProcessed += processed;

                    // Small delay between leaders
                    await sleep(200);
                } catch (error) {
                    this.errorCount++;
                    logger.error({ error, exchange, leader: leader.label }, 'Gap-fill error');
                }
            }
        }

        if (totalProcessed > 0) {
            logger.info({ totalProcessed }, 'Background backfill complete');
        }
    }

    private async gapFillForLeader(exchange: string, leader: LeaderInfo): Promise<number> {
        const MAX_BLOCK_RANGE = 10; // Alchemy Free Tier limit
        const THROTTLE_MS = 100;    // Limit to ~10 req/sec max per leader

        // Get last processed block from cursor
        const cursor = await prisma.polygonCursor.findFirst({
            where: {
                exchangeAddress: exchange.toLowerCase(),
                leaderAddress: leader.wallet,
            },
        });

        const latestBlock = await this.httpProvider!.getBlockNumber();
        // If no cursor, start from 500 blocks ago (~15 mins) to catch recent history
        // without doing a massive unexpected backfill
        const fromBlock = cursor ? cursor.lastProcessedBlock + 1 : Math.max(0, latestBlock - 500);

        if (fromBlock > latestBlock) {
            return 0;
        }

        logger.info({
            exchange: exchange.slice(0, 10) + '...',
            leader: leader.label,
            fromBlock,
            toBlock: latestBlock,
            chunks: Math.ceil((latestBlock - fromBlock + 1) / MAX_BLOCK_RANGE)
        }, 'Gap-filling started');

        // Build topics
        const makerTopic = ethers.zeroPadValue(leader.wallet, 32);
        const takerTopic = ethers.zeroPadValue(leader.wallet, 32);

        let processed = 0;
        let currentFrom = fromBlock;

        // Loop through chunks
        while (currentFrom <= latestBlock) {
            if (!this.isRunning) break;

            const currentTo = Math.min(currentFrom + MAX_BLOCK_RANGE - 1, latestBlock);

            try {
                // Fetch logs where leader is maker
                const makerLogs = await this.httpProvider!.getLogs({
                    address: exchange,
                    topics: [ORDER_FILLED_TOPIC, null, makerTopic],
                    fromBlock: currentFrom,
                    toBlock: currentTo,
                });

                // Fetch logs where leader is taker
                const takerLogs = await this.httpProvider!.getLogs({
                    address: exchange,
                    topics: [ORDER_FILLED_TOPIC, null, null, takerTopic],
                    fromBlock: currentFrom,
                    toBlock: currentTo,
                });

                // Combine and dedupe
                const allLogs = [...makerLogs, ...takerLogs];
                const seenKeys = new Set<string>();
                const uniqueLogs = allLogs.filter(log => {
                    const key = `${log.transactionHash}:${log.index}`;
                    if (seenKeys.has(key)) return false;
                    seenKeys.add(key);
                    return true;
                });

                // Process logs
                for (const log of uniqueLogs) {
                    try {
                        const wasProcessed = await this.processLog({
                            topics: log.topics as string[],
                            data: log.data,
                            blockNumber: log.blockNumber,
                            transactionHash: log.transactionHash,
                            logIndex: log.index,
                            address: log.address,
                        });
                        if (wasProcessed) processed++;
                    } catch (error) {
                        logger.error({ error, txHash: log.transactionHash }, 'Error processing historical log');
                    }
                }

                // Update cursor progressively so we don't lose progress on error
                await prisma.polygonCursor.upsert({
                    where: {
                        exchangeAddress_leaderAddress_role: {
                            exchangeAddress: exchange.toLowerCase(),
                            leaderAddress: leader.wallet,
                            role: 'unknown',
                        },
                    },
                    create: {
                        exchangeAddress: exchange.toLowerCase(),
                        leaderAddress: leader.wallet,
                        role: 'unknown',
                        lastProcessedBlock: currentTo,
                    },
                    update: {
                        lastProcessedBlock: currentTo,
                    },
                });

            } catch (error) {
                logger.error({ error, currentFrom, currentTo }, 'Error fetching logs chunk');
                // Continue to next chunk or retry? 
                // For now, we continue (skip bad chunk) to avoid sticking loop
            }

            // Throttle
            await sleep(THROTTLE_MS);
            currentFrom = currentTo + 1;
        }

        if (processed > 0) {
            logger.info({ leader: leader.label, processed }, 'Gap-fill complete');
        }

        return processed;
    }

    private async getStartBlock(): Promise<number> {
        // Start from only ~10 seconds ago to stay within Alchemy free tier limit
        // Alchemy free tier only allows 10 block range for getLogs
        // Polygon has ~2s block time, so 5 blocks = ~10 seconds
        const latestBlock = await this.httpProvider!.getBlockNumber();
        return Math.max(0, latestBlock - 5);
    }

    private async processLog(log: {
        topics: string[];
        data: string;
        blockNumber: number;
        transactionHash: string;
        logIndex: number;
        address: string;
    }): Promise<boolean> {
        // Decode the log
        const decoded = decodeOrderFilledLog(log);
        if (!decoded) return false;

        // Check if any leader is involved
        const maker = decoded.maker.toLowerCase();
        const taker = decoded.taker.toLowerCase();

        const involvedLeader = this.leaders.find(
            l => l.wallet === maker || l.wallet === taker
        );

        if (!involvedLeader) return false;

        // Derive fill info
        const fillInfo = deriveFillInfo(decoded, involvedLeader.wallet);
        if (!fillInfo) return false;

        // Generate dedupe key
        const dedupeKey = generateDedupeKey(decoded);

        // Check if already processed
        const existing = await prisma.leaderFill.findUnique({
            where: { dedupeKey },
        });
        if (existing) return false;

        // Resolve token info
        const tokenInfo = await resolveTokenId(fillInfo.tokenId);

        // Get block timestamp
        const block = await this.httpProvider!.getBlock(log.blockNumber);
        const fillTs = block ? new Date(block.timestamp * 1000) : new Date();

        // Store raw payload - convert bigints to strings for JSON
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
        }));
        const raw = await prisma.leaderFillRaw.create({
            data: {
                source: 'polygon',
                payload: rawPayload,
            },
        });

        // Store normalized fill
        const leaderFill = await prisma.leaderFill.create({
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
                title: tokenInfo?.title,
                isBackfill: false,
                dedupeKey,
                rawId: raw.id,
            },
        });

        // Update stats
        this.eventsProcessed++;
        this.lastEventAt = new Date();

        // Record latency event for comparison
        await recordLatencyEvent({
            dedupeKey: decoded.transactionHash.toLowerCase(),
            source: 'polygon',
            detectedAt: new Date(),
            tokenId: fillInfo.tokenId,
            conditionId: tokenInfo?.conditionId || 'unknown',
            leaderWallet: involvedLeader.wallet,
            side: fillInfo.side,
            usdcAmount: fillInfo.usdcAmount,
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
            detectedAt: new Date(),
            title: tokenInfo?.title ?? undefined,
            rawPayload: rawPayload,
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
            size: fillInfo.tokenAmount.toFixed(2),
            usdc: fillInfo.usdcAmount.toFixed(2),
            title: tokenInfo?.title?.slice(0, 30),
            txHash: decoded.transactionHash.slice(0, 10) + '...',
        }, 'Detected leader fill from Polygon');

        return true;
    }
}

/**
 * Create a new Polygon leader fill source
 */
export function createPolygonSource(): LeaderFillSource {
    return new PolygonLeaderFillSource();
}
