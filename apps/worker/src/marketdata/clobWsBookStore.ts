/**
 * CLOB WebSocket Book Store - real-time orderbook cache
 * Phase 4: Market Data
 * 
 * Maintains an in-memory cache of orderbook data via WebSocket streaming
 * with REST snapshot seeding for startup/reconnect.
 */

import WebSocket from 'ws';
import pino from 'pino';
import { getConfig } from '../config.js';
import { fetchBatchBookSnapshots, fetchBookSnapshot } from './restBookClient.js';
import type {
    BookStore,
    OrderbookSnapshot,
    BestBidAsk,
    QuoteAge,
    PriceLevel,
    QUOTE_AGE_THRESHOLDS
} from '../ports/BookStore.js';
import { prisma } from '@polymarket-bot/db';
import { sleep } from '../retry.js';

const logger = pino({ name: 'clob-ws-book-store' });

// Ring buffer size for historical snapshots
const RING_BUFFER_SIZE = 60; // ~60 seconds at 1 snapshot/sec

// WebSocket message types
interface WsBookMessage {
    event_type: 'book';
    market: string;
    asset_id: string;
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
    timestamp: string;
    hash: string;
}

interface WsPriceChangeMessage {
    event_type: 'price_change';
    asset_id: string;
    market: string;
    price: string;
    side: 'buy' | 'sell';
    size: string;
    timestamp: string;
}

interface WsLastTradeMessage {
    event_type: 'last_trade_price';
    asset_id: string;
    market: string;
    price: string;
    timestamp: string;
}

type WsMessage = WsBookMessage | WsPriceChangeMessage | WsLastTradeMessage;

/**
 * Token state in the cache
 */
interface TokenState {
    tokenId: string;
    bids: PriceLevel[];
    asks: PriceLevel[];
    updatedAt: Date;
    ringBuffer: OrderbookSnapshot[];
}

/**
 * CLOB WebSocket Book Store implementation
 */
export class ClobWsBookStore implements BookStore {
    readonly name = 'clob-ws';

    private ws: WebSocket | null = null;
    private tokens: Map<string, TokenState> = new Map();
    private subscribedTokens: Set<string> = new Set();
    private isConnected = false;
    private lastMessageAt: Date | null = null;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;
    private reconnectDelayMs = 1000;
    private shouldRun = false;
    private pingInterval: NodeJS.Timeout | null = null;

    async start(): Promise<void> {
        this.shouldRun = true;
        logger.info('Starting CLOB WebSocket book store...');

        // Load initial tokens to subscribe
        await this.loadInitialTokens();

        // Seed initial snapshots via REST
        await this.seedSnapshots();

        // Connect WebSocket
        await this.connect();

        // Start ping interval
        this.pingInterval = setInterval(() => this.sendPing(), 30000);

        logger.info({ subscribedTokens: this.subscribedTokens.size }, 'Book store started');
    }

    async stop(): Promise<void> {
        this.shouldRun = false;
        logger.info('Stopping CLOB WebSocket book store...');

        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }

        if (this.ws) {
            this.ws.close(1000, 'Shutdown');
            this.ws = null;
        }

        this.isConnected = false;
        logger.info('Book store stopped');
    }

    async subscribe(tokenId: string): Promise<void> {
        if (this.subscribedTokens.has(tokenId)) {
            return;
        }

        this.subscribedTokens.add(tokenId);

        // Initialize token state
        if (!this.tokens.has(tokenId)) {
            this.tokens.set(tokenId, {
                tokenId,
                bids: [],
                asks: [],
                updatedAt: new Date(0),
                ringBuffer: [],
            });
        }

        // Send subscription message if connected
        if (this.ws && this.isConnected) {
            this.sendSubscription(tokenId);
        }

        // Fetch initial snapshot
        const snapshot = await fetchBookSnapshot(tokenId);
        if (snapshot) {
            this.updateTokenState(tokenId, snapshot.bids, snapshot.asks);
        }

        logger.debug({ tokenId }, 'Subscribed to token');
    }

    async unsubscribe(tokenId: string): Promise<void> {
        this.subscribedTokens.delete(tokenId);
        this.tokens.delete(tokenId);

        // Send unsubscription message if connected
        if (this.ws && this.isConnected) {
            this.sendUnsubscription(tokenId);
        }

        logger.debug({ tokenId }, 'Unsubscribed from token');
    }

    getBestBidAsk(tokenId: string): BestBidAsk | null {
        const state = this.tokens.get(tokenId);
        if (!state) {
            return null;
        }

        const bestBid = state.bids.length > 0 ? state.bids[0] : null;
        const bestAsk = state.asks.length > 0 ? state.asks[0] : null;

        const bid = bestBid?.price ?? null;
        const ask = bestAsk?.price ?? null;
        const spread = bid !== null && ask !== null ? ask - bid : null;
        const midpoint = bid !== null && ask !== null ? (bid + ask) / 2 : null;

        return {
            bid,
            bidSize: bestBid?.size ?? null,
            ask,
            askSize: bestAsk?.size ?? null,
            updatedAt: state.updatedAt,
        };
    }

    getQuoteAge(tokenId: string): QuoteAge {
        const state = this.tokens.get(tokenId);
        if (!state) {
            return 'unknown';
        }

        const ageMs = Date.now() - state.updatedAt.getTime();

        if (ageMs <= 2000) {
            return 'fresh';
        } else if (ageMs <= 5000) {
            return 'soft_stale';
        } else {
            return 'hard_stale';
        }
    }

    getBookAt(tokenId: string, timestamp: Date): OrderbookSnapshot | null {
        const state = this.tokens.get(tokenId);
        if (!state || state.ringBuffer.length === 0) {
            return null;
        }

        // Find closest snapshot at or before the timestamp
        const targetTime = timestamp.getTime();
        let closest: OrderbookSnapshot | null = null;
        let closestDiff = Infinity;

        for (const snapshot of state.ringBuffer) {
            const snapshotTime = snapshot.timestamp.getTime();
            if (snapshotTime <= targetTime) {
                const diff = targetTime - snapshotTime;
                if (diff < closestDiff) {
                    closestDiff = diff;
                    closest = snapshot;
                }
            }
        }

        return closest;
    }

    getCurrentBook(tokenId: string): OrderbookSnapshot | null {
        const state = this.tokens.get(tokenId);
        if (!state) {
            return null;
        }

        return {
            tokenId,
            bids: [...state.bids],
            asks: [...state.asks],
            timestamp: state.updatedAt,
        };
    }

    async refreshToken(tokenId: string): Promise<BestBidAsk | null> {
        const snapshot = await fetchBookSnapshot(tokenId);
        if (snapshot) {
            this.updateTokenState(tokenId, snapshot.bids, snapshot.asks);
            return this.getBestBidAsk(tokenId);
        }
        return null;
    }

    isHealthy(): boolean {
        if (!this.isConnected) return false;
        if (!this.lastMessageAt) return false;

        // Unhealthy if no message in 30 seconds
        const ageMs = Date.now() - this.lastMessageAt.getTime();
        return ageMs < 30000;
    }

    getHealthSummary(): { healthy: boolean; subscribedTokens: number; freshQuotes: number; staleQuotes: number; lastUpdateAt?: Date } {
        let freshQuotes = 0;
        let staleQuotes = 0;

        for (const state of this.tokens.values()) {
            const age = this.getQuoteAge(state.tokenId);
            if (age === 'fresh') {
                freshQuotes++;
            } else if (age !== 'unknown') {
                staleQuotes++;
            }
        }

        return {
            healthy: this.isHealthy(),
            subscribedTokens: this.subscribedTokens.size,
            freshQuotes,
            staleQuotes,
            lastUpdateAt: this.lastMessageAt ?? undefined,
        };
    }

    // === Private Methods ===

    private async loadInitialTokens(): Promise<void> {
        // 1. Get tokens from recent leader fills (last 24h) - these have tokenId
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentFills = await prisma.leaderFill.findMany({
            where: { detectedAt: { gte: oneDayAgo } },
            select: { tokenId: true },
            distinct: ['tokenId'],
        });

        // 2. Get tokens from MarketRegistry that match open positions
        // Position uses conditionId/outcome, so we map via MarketRegistry
        const positions = await prisma.position.findMany({
            where: { shares: { not: 0 } },
            select: { conditionId: true, outcome: true },
        });

        const marketMappings = await prisma.marketMapping.findMany({
            where: {
                conditionId: { in: positions.map(p => p.conditionId) },
            },
            select: { clobTokenId: true },
        });

        const tokenIds = new Set<string>();

        for (const fill of recentFills) {
            if (fill.tokenId) tokenIds.add(fill.tokenId);
        }

        for (const mapping of marketMappings) {
            if (mapping.clobTokenId) tokenIds.add(mapping.clobTokenId);
        }

        logger.info({
            fromRecentFills: recentFills.length,
            fromMarketMappings: marketMappings.length,
            total: tokenIds.size
        }, 'Loaded initial tokens to subscribe');

        for (const tokenId of tokenIds) {
            this.subscribedTokens.add(tokenId);
            this.tokens.set(tokenId, {
                tokenId,
                bids: [],
                asks: [],
                updatedAt: new Date(0),
                ringBuffer: [],
            });
        }
    }

    private async seedSnapshots(): Promise<void> {
        const tokenIds = Array.from(this.subscribedTokens);
        if (tokenIds.length === 0) {
            logger.info('No tokens to seed');
            return;
        }

        logger.info({ count: tokenIds.length }, 'Seeding book snapshots via REST...');

        const snapshots = await fetchBatchBookSnapshots(tokenIds);

        for (const [tokenId, snapshot] of snapshots) {
            this.updateTokenState(tokenId, snapshot.bids, snapshot.asks);
        }

        logger.info({ seeded: snapshots.size }, 'Book snapshots seeded');
    }

    private async connect(): Promise<void> {
        const config = getConfig();

        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(config.clobMarketWsUrl);

                this.ws.on('open', () => {
                    logger.info('WebSocket connected');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;

                    // Subscribe to all tokens in batches
                    const tokenIds = Array.from(this.subscribedTokens);
                    if (tokenIds.length > 0) {
                        this.sendSubscription(tokenIds);
                    }

                    resolve();
                });

                this.ws.on('message', (data: WebSocket.Data) => {
                    this.handleMessage(data);
                });

                this.ws.on('close', (code: number, reason: Buffer) => {
                    logger.warn({ code, reason: reason.toString() }, 'WebSocket closed');
                    this.isConnected = false;
                    this.handleReconnect();
                });

                this.ws.on('error', (error: Error) => {
                    logger.error({ error }, 'WebSocket error');
                    this.isConnected = false;
                });

            } catch (error) {
                logger.error({ error }, 'Failed to connect WebSocket');
                reject(error);
            }
        });
    }

    private async handleReconnect(): Promise<void> {
        if (!this.shouldRun) return;

        this.reconnectAttempts++;

        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            logger.error('Max reconnect attempts reached, giving up');
            return;
        }

        const delay = Math.min(
            this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1),
            30000
        );

        logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Reconnecting...');
        await sleep(delay);

        try {
            await this.connect();
            // Reseed snapshots after reconnect
            await this.seedSnapshots();
        } catch (error) {
            logger.error({ error }, 'Reconnect failed');
            this.handleReconnect();
        }
    }

    private sendSubscription(tokenIdOrIds: string | string[]): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const assetIds = Array.isArray(tokenIdOrIds) ? tokenIdOrIds : [tokenIdOrIds];
        const message = {
            type: 'market',
            assets_ids: assetIds,
        };

        this.ws.send(JSON.stringify(message));
    }

    private sendUnsubscription(tokenId: string): void {
        // CLOB WS may not support unsubscription, but we handle it client-side
        // by ignoring messages for unsubscribed tokens
    }

    private sendPing(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.ping();
    }

    private handleMessage(data: WebSocket.Data): void {
        this.lastMessageAt = new Date();

        try {
            const dataStr = data.toString();

            // Handle non-JSON keepalive/errors
            if (dataStr === 'INVALID OPERATION') {
                logger.warn('Received INVALID OPERATION from WS');
                return;
            }

            const message = JSON.parse(dataStr) as WsMessage | WsMessage[];

            // Handle array of messages
            const messages = Array.isArray(message) ? message : [message];

            for (const msg of messages) {
                this.processMessage(msg);
            }
        } catch (error) {
            logger.warn({ data: data.toString().slice(0, 100) }, 'Failed to parse WS message');
        }
    }

    private processMessage(msg: WsMessage): void {
        const tokenId = msg.asset_id;

        // Ignore if not subscribed
        if (!this.subscribedTokens.has(tokenId)) {
            return;
        }

        switch (msg.event_type) {
            case 'book':
                this.handleBookUpdate(msg);
                break;
            case 'price_change':
                this.handlePriceChange(msg);
                break;
            case 'last_trade_price':
                // Optional: could update last trade price
                break;
            default:
                // Unknown message type
                break;
        }
    }

    private handleBookUpdate(msg: WsBookMessage): void {
        const tokenId = msg.asset_id;

        const bids: PriceLevel[] = msg.bids.map(b => ({
            price: parseFloat(b.price),
            size: parseFloat(b.size),
        }));

        const asks: PriceLevel[] = msg.asks.map(a => ({
            price: parseFloat(a.price),
            size: parseFloat(a.size),
        }));

        this.updateTokenState(tokenId, bids, asks);
    }

    private handlePriceChange(msg: WsPriceChangeMessage): void {
        const tokenId = msg.asset_id;
        const state = this.tokens.get(tokenId);
        if (!state) return;

        const price = parseFloat(msg.price);
        const size = parseFloat(msg.size);

        if (msg.side === 'buy') {
            // Update bids
            this.updatePriceLevel(state.bids, price, size, true);
        } else {
            // Update asks
            this.updatePriceLevel(state.asks, price, size, false);
        }

        state.updatedAt = new Date();
        this.addToRingBuffer(state);
    }

    private updatePriceLevel(levels: PriceLevel[], price: number, size: number, isDescending: boolean): void {
        // Find existing level
        const existingIdx = levels.findIndex(l => l.price === price);

        if (size === 0) {
            // Remove level
            if (existingIdx >= 0) {
                levels.splice(existingIdx, 1);
            }
        } else if (existingIdx >= 0) {
            // Update existing
            levels[existingIdx].size = size;
        } else {
            // Insert new
            const newLevel = { price, size };
            const insertIdx = levels.findIndex(l =>
                isDescending ? l.price < price : l.price > price
            );

            if (insertIdx >= 0) {
                levels.splice(insertIdx, 0, newLevel);
            } else {
                levels.push(newLevel);
            }
        }
    }

    private updateTokenState(tokenId: string, bids: PriceLevel[], asks: PriceLevel[]): void {
        let state = this.tokens.get(tokenId);

        if (!state) {
            state = {
                tokenId,
                bids: [],
                asks: [],
                updatedAt: new Date(0),
                ringBuffer: [],
            };
            this.tokens.set(tokenId, state);
        }

        // Sort bids descending, asks ascending
        state.bids = bids.sort((a, b) => b.price - a.price);
        state.asks = asks.sort((a, b) => a.price - b.price);
        state.updatedAt = new Date();

        this.addToRingBuffer(state);
    }

    private addToRingBuffer(state: TokenState): void {
        const snapshot: OrderbookSnapshot = {
            tokenId: state.tokenId,
            bids: [...state.bids],
            asks: [...state.asks],
            timestamp: state.updatedAt,
        };

        state.ringBuffer.push(snapshot);

        // Trim to max size
        while (state.ringBuffer.length > RING_BUFFER_SIZE) {
            state.ringBuffer.shift();
        }
    }
}

/**
 * Create a new CLOB WebSocket book store
 */
export function createClobWsBookStore(): BookStore {
    return new ClobWsBookStore();
}
