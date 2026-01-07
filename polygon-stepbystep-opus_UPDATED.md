# Polygon Log Migration — Step-by-Step Guide

**Goal**: Migrate from the current polling-based Data API approach to Polygon on-chain log subscriptions for reduced and consistent latency.

---

## Current State Summary

Your system today:
- **Trigger**: REST polling of Polymarket Data API (`/activity?user=<wallet>&type=TRADE`)
- **Quotes**: REST call per trade to CLOB `/book` endpoint
- **Latency**: 4–20+ seconds (dominated by Data API indexer lag + per-trade REST calls)

**Key files involved**:
| File | Role |
|------|------|
| [index.ts](file:///home/vicente/AntigravityProjects/polymarket-copybot-1/apps/worker/src/index.ts) | Poll loop entry point |
| [polymarket.ts](file:///home/vicente/AntigravityProjects/polymarket-copybot-1/apps/worker/src/polymarket.ts) | Data API client |
| [ingester.ts](file:///home/vicente/AntigravityProjects/polymarket-copybot-1/apps/worker/src/ingester.ts) | Trade normalization + storage |
| [quotes.ts](file:///home/vicente/AntigravityProjects/polymarket-copybot-1/apps/worker/src/quotes.ts) | REST orderbook fetching |

---

## Target State

After migration:
- **Trigger**: WebSocket subscription to Polygon logs (USDC + ERC-1155 transfers)
- **Quotes**: In-memory cache from CLOB WebSocket (no REST per trade)
- **Latency**: ~2–5 seconds (block time) + sub-100ms internal processing
- **Fallback**: REST polling remains as safety net

---

## Migration Phases

```mermaid
flowchart LR
    subgraph "Phase 1: Foundation"
        A[Add Latency Metrics] --> B[WebSocket Quote Cache]
    end
    subgraph "Phase 2: Polygon Logs"
        C[Log Subscription Service] --> D[Event Decoder]
        D --> E[Dual-Mode Ingestion]
    end
    subgraph "Phase 3: Optimization"
        F[Full Integration] --> G[Disable Polling]
    end
    A --> C
    B --> C
    E --> F
```

---

## Phase 1: Foundation (Reduce Internal Lag)

### Step 1.1: Add Latency Breakdown Metrics

**What**: Store separate timestamps for upstream vs internal lag.

**Why**: You can't optimize what you don't measure. Currently `detectedAt - tradeTs` conflates indexer delay with your own processing.

**Changes**:

#### [MODIFY] [ingester.ts](file:///home/vicente/AntigravityProjects/polymarket-copybot-1/apps/worker/src/ingester.ts)

Add timestamp fields when storing trades:

```diff
// In ingestTradesForLeader, when creating the trade:
const newTrade = await prisma.trade.create({
    data: {
        leaderId,
        dedupeKey,
        txHash: activity.transactionHash,
        tradeTs: new Date(activity.timestamp * 1000),
+       detectedAt: new Date(),  // When we first saw it
        side: activity.side,
        // ... rest of fields
    },
});

// After paper intent generation:
+await prisma.trade.update({
+    where: { id: newTrade.id },
+    data: { decidedAt: new Date() }  // When decision was made
+});
```

#### [MODIFY] Prisma Schema

Add to `Trade` model:
```prisma
model Trade {
    // existing fields...
    detectedAt  DateTime @default(now())  // When worker saw event
    decidedAt   DateTime?                  // When paper intent generated
}
```

**Dashboard Enhancement** (optional):
- Show `upstreamLag = detectedAt - tradeTs` 
- Show `internalLag = decidedAt - detectedAt`

---

### Step 1.2: Implement WebSocket Quote Cache (Upgraded)

**What**: Replace per-trade REST quote calls with a **live in-memory quote cache** fed by CLOB WebSocket, with **snapshot seeding + resync** via batch REST.

**Why**:
- Eliminates 100–500ms per trade from REST `/book`
- Makes quotes **trustworthy** (detects stale feeds / missed updates)
- Sets you up for realistic execution simulation and eventual live execution

This step has 4 critical upgrades:
1. **Fast staleness rule (quote age)**: treat quotes as *invalid* if the feed isn’t updating quickly.
2. **Reconnect resync**: after any disconnect or missed update suspicion, bulk-refresh the cache with a snapshot.
3. **Handle message types + sequencing**: process multiple update shapes and ignore out-of-order updates.
4. **Subscription strategy**: pre-subscribe to the tokens you might trade (not only “after a REST fallback”).

---

#### Step 1.2.1: Add quote freshness tiers (fast staleness rule)

Define freshness thresholds (tune later):

- **FRESH**: quote updated within **2s**
- **SOFT_STALE**: **2–5s** → allow trade only if you can REST-refresh or accept degraded mode
- **HARD_STALE**: **>5s** → default **no-trade** (you’re effectively blind)

These tiers don’t replace your “leader price delta” guardrail — they protect you from **broken market data** (WS stalled, unsubscribed, missed bursts, etc.).

---

#### Step 1.2.2: Implement cache + resync + sequencing

##### [NEW] [quote-cache.ts](file:///home/vicente/AntigravityProjects/polymarket-copybot-1/apps/worker/src/quote-cache.ts)

Create a WebSocket-based quote cache with:
- freshness tiers
- reconnect resync (batch snapshot)
- out-of-order protection (sequence handling if available)

```typescript
import WebSocket from 'ws';
import pino from 'pino';

const logger = pino({ name: 'quote-cache' });

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// Tune these later
const FRESH_MS = 2_000;       // 0–2s: OK
const SOFT_STALE_MS = 5_000;  // 2–5s: degraded (REST refresh recommended)
const HARD_STALE_MS = 5_000;  // >5s: default no-trade

type QuoteFreshness = 'FRESH' | 'SOFT_STALE' | 'HARD_STALE' | 'MISSING';

interface CachedQuote {
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  bidSize: number;
  askSize: number;
  updatedAt: Date;

  // Optional ordering protection (only used if WS provides it)
  seq?: number;
  sourceEvent?: string;
}

// In-memory cache
const quoteCache = new Map<string, CachedQuote>();

// Token subscription state
const trackedTokens = new Set<string>();
const pendingSubscriptions = new Set<string>();

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

// Resync coordination
let resyncTimer: NodeJS.Timeout | null = null;
const RESYNC_DEBOUNCE_MS = 750;

// ---- Public API ----

export function ensureTokenTracked(tokenId: string): void {
  trackedTokens.add(tokenId);
  if (ws?.readyState === WebSocket.OPEN) {
    subscribeToToken(tokenId);
  } else {
    pendingSubscriptions.add(tokenId);
  }
}

export function getCachedQuote(tokenId: string): CachedQuote | null {
  return quoteCache.get(tokenId) || null;
}

export function getQuoteFreshness(tokenId: string): QuoteFreshness {
  const q = quoteCache.get(tokenId);
  if (!q) return 'MISSING';
  const age = Date.now() - q.updatedAt.getTime();
  if (age <= FRESH_MS) return 'FRESH';
  if (age <= SOFT_STALE_MS) return 'SOFT_STALE';
  return 'HARD_STALE';
}

export function connectQuoteWebSocket(): void {
  if (ws) ws.close();

  ws = new WebSocket(CLOB_WS_URL);

  ws.on('open', async () => {
    logger.info('CLOB WebSocket connected');

    // 1) Seed cache snapshot for all tracked tokens (fast baseline after reconnect/startup)
    await resyncSnapshot('on_open');

    // 2) Subscribe to all tracked tokens (and any pending ones)
    for (const tokenId of trackedTokens) subscribeToToken(tokenId);
    for (const tokenId of pendingSubscriptions) subscribeToToken(tokenId);
    pendingSubscriptions.clear();
  });

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      handleWsMessage(msg);
    } catch (e) {
      logger.error({ error: e }, 'Failed to parse WS message');
    }
  });

  ws.on('close', () => {
    logger.warn('CLOB WebSocket disconnected, reconnecting in 5s...');
    scheduleReconnect();
  });

  ws.on('error', (error) => {
    logger.error({ error }, 'CLOB WebSocket error');
  });
}

export function getQuoteCacheStats() {
  return {
    tokenCount: quoteCache.size,
    trackedTokenCount: trackedTokens.size,
    connected: ws?.readyState === WebSocket.OPEN,
  };
}

// ---- Internals ----

function subscribeToToken(tokenId: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    pendingSubscriptions.add(tokenId);
    return;
  }

  const msg = { type: 'market', assets_ids: [tokenId] };
  ws.send(JSON.stringify(msg));
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectQuoteWebSocket();
  }, 5000);
}

// Debounced resync to avoid stampedes on bursts of reconnects / gap detection
function scheduleResync(reason: string): void {
  if (resyncTimer) return;
  resyncTimer = setTimeout(async () => {
    resyncTimer = null;
    await resyncSnapshot(reason);
  }, RESYNC_DEBOUNCE_MS);
}

/**
 * Snapshot seed / resync using batch REST. This is what makes the cache "trustworthy"
 * after reconnects or suspected missed WS updates.
 *
 * NOTE: implement fetchBooksSnapshot() using CLOB batch endpoint (POST /books).
 */
async function resyncSnapshot(reason: string): Promise<void> {
  const tokenIds = Array.from(trackedTokens);
  if (tokenIds.length === 0) return;

  try {
    logger.info({ reason, tokenCount: tokenIds.length }, 'Resyncing quote cache snapshot');

    const snapshot = await fetchBooksSnapshot(tokenIds);

    // Snapshot is expected to return best bid/ask (and optionally sizes).
    // Adapt parsing to the actual REST response.
    for (const item of snapshot) {
      const tokenId = item.tokenId;
      quoteCache.set(tokenId, {
        tokenId,
        bestBid: item.bestBid,
        bestAsk: item.bestAsk,
        bidSize: item.bidSize ?? 0,
        askSize: item.askSize ?? 0,
        updatedAt: new Date(),
        sourceEvent: 'snapshot',
      });
    }
  } catch (e) {
    logger.error({ error: e, reason }, 'Snapshot resync failed');
  }
}

/**
 * Placeholder for batch snapshot call.
 * Implement with your existing REST client and CLOB batch endpoint (POST /books).
 */
async function fetchBooksSnapshot(tokenIds: string[]): Promise<Array<{
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  bidSize?: number;
  askSize?: number;
}>> {
  // TODO: call POST /books with tokenIds and parse response
  // Return [] on failure, but log error where you call it.
  return [];
}

/**
 * Handle WS updates.
 *
 * Important behaviors:
 * - Process multiple message shapes (best_bid_ask, book, etc.)
 * - Ignore out-of-order updates if WS provides a monotonic seq
 * - If you detect a gap / unknown format, trigger a snapshot resync
 */
function handleWsMessage(msg: any): void {
  // You MUST adapt this to Polymarket’s actual WS message schema.
  // The point is the behavior, not this exact parsing.

  const tokenId = msg.asset_id || msg.token_id || msg.market?.asset_id;
  const eventType = msg.event_type || msg.type || msg.event;

  if (!tokenId) return;

  // Optional ordering: use a provided sequence number if available
  const incomingSeq: number | undefined =
    typeof msg.sequence === 'number' ? msg.sequence :
    typeof msg.seq === 'number' ? msg.seq :
    undefined;

  const prev = quoteCache.get(tokenId);
  if (incomingSeq !== undefined && prev?.seq !== undefined) {
    if (incomingSeq <= prev.seq) return; // out-of-order update, ignore
    if (incomingSeq > prev.seq + 1) {
      // We likely missed messages; resync snapshot to regain correctness
      logger.warn({ tokenId, prevSeq: prev.seq, incomingSeq }, 'WS sequence gap detected; scheduling resync');
      scheduleResync('seq_gap');
    }
  }

  // 1) best bid/ask style messages (fast path)
  if (eventType === 'best_bid_ask' || (msg.best_bid !== undefined && msg.best_ask !== undefined)) {
    const bestBid = Number(msg.best_bid);
    const bestAsk = Number(msg.best_ask);

    quoteCache.set(tokenId, {
      tokenId,
      bestBid,
      bestAsk,
      bidSize: msg.bid_size ? Number(msg.bid_size) : prev?.bidSize ?? 0,
      askSize: msg.ask_size ? Number(msg.ask_size) : prev?.askSize ?? 0,
      updatedAt: new Date(),
      seq: incomingSeq ?? prev?.seq,
      sourceEvent: 'best_bid_ask',
    });
    return;
  }

  // 2) book updates (derive best bid/ask from top of book)
  if (eventType === 'book' || msg.bids || msg.asks) {
    const bids = msg.bids || [];
    const asks = msg.asks || [];

    const bestBid = bids.length > 0 ? Math.max(...bids.map((b: any) => Number(b.price))) : (prev?.bestBid ?? 0);
    const bestAsk = asks.length > 0 ? Math.min(...asks.map((a: any) => Number(a.price))) : (prev?.bestAsk ?? 1);

    quoteCache.set(tokenId, {
      tokenId,
      bestBid,
      bestAsk,
      bidSize: bids[0]?.size ? Number(bids[0].size) : prev?.bidSize ?? 0,
      askSize: asks[0]?.size ? Number(asks[0].size) : prev?.askSize ?? 0,
      updatedAt: new Date(),
      seq: incomingSeq ?? prev?.seq,
      sourceEvent: 'book',
    });
    return;
  }

  // Unknown message type: don’t guess — resync.
  logger.debug({ tokenId, eventType }, 'Unhandled WS message type; scheduling resync');
  scheduleResync('unhandled_message');
}
```

---

#### Step 1.2.3: Pre-subscribe token universe (subscription strategy)

The goal is: **don’t start tracking a token only after you needed a REST fallback**.

Minimum viable approach:
- Track/subscribe any token you’ve seen recently (e.g., last 24h)
- Optionally: pre-track tokens from your market mapping table / registry

##### [MODIFY] Startup wiring ([index.ts](file:///home/vicente/AntigravityProjects/polymarket-copybot-1/apps/worker/src/index.ts))

```diff
 import { connectQuoteWebSocket } from './quote-cache.js';
+import { ensureTokenTracked } from './quote-cache.js';

 async function runPollLoop(): Promise<void> {
   // ...existing db wait logic...

   connectQuoteWebSocket();

+  // Optional: pre-track tokens you've already mapped in DB so cache is warm before first trade
+  // const tokenIds = await prisma.marketMapping.findMany({ select: { clobTokenId: true } });
+  // for (const t of tokenIds) if (t.clobTokenId) ensureTokenTracked(t.clobTokenId);

   logger.info('Database connected, starting poll loop');
   // ...rest...
 }
```

---

#### Step 1.2.4: Update quote capture to use freshness tiers

##### [MODIFY] [quotes.ts](file:///home/vicente/AntigravityProjects/polymarket-copybot-1/apps/worker/src/quotes.ts)

```diff
-import { getCachedQuote, subscribeToToken } from './quote-cache.js';
+import { getCachedQuote, getQuoteFreshness, ensureTokenTracked } from './quote-cache.js';

 export async function captureQuote(mapping: MarketMapping): Promise<string | null> {
   if (!mapping.clobTokenId) return null;

+  // Ensure we track/sub to this token early (even if we later fall back to REST)
+  ensureTokenTracked(mapping.clobTokenId);

   const cached = getCachedQuote(mapping.clobTokenId);
+  const freshness = getQuoteFreshness(mapping.clobTokenId);

-  if (cached && (Date.now() - cached.updatedAt.getTime()) < 30000) {
+  if (cached && freshness === 'FRESH') {
     return await storeQuote(mapping, {
       bestBid: cached.bestBid,
       bestAsk: cached.bestAsk,
       bidSize: cached.bidSize,
       askSize: cached.askSize,
       source: 'websocket',
     });
   }

+  // Soft-stale: allow REST refresh (degraded, but actionable)
+  if (freshness === 'SOFT_STALE') {
+    const orderbook = await fetchOrderbook(mapping.clobTokenId);
+    return await storeQuote(mapping, {
+      bestBid: orderbook.bestBid,
+      bestAsk: orderbook.bestAsk,
+      bidSize: orderbook.bidSize,
+      askSize: orderbook.askSize,
+      source: 'rest_refresh',
+    });
+  }
+
+  // Hard-stale/missing: default no-trade (or keep REST-only mode if you insist)
+  if (freshness === 'HARD_STALE' || freshness === 'MISSING') {
+    logger.warn({ tokenId: mapping.clobTokenId, freshness }, 'No-trade: quote cache not trustworthy');
+    return null;
+  }

   // (If you keep any remaining REST logic here, it should be explicit and rare.)
 }
```

**Result**:
- You no longer treat “30s-old quotes” as acceptable.
- Your cache is correct after reconnects.
- You’re protected against out-of-order updates.
- You warm subscriptions *before* you need them.

---

## Phase 2: Polygon Log Subscription

### Step 2.1: Create Polygon Log Subscription Service

**What**: Subscribe to USDC and ERC-1155 transfer logs on Polygon that involve leader proxy wallets.

**Why**: On-chain logs trigger within block time (~2s) vs Data API indexer (4–20s+).

**Changes**:

#### [NEW] [polygon-listener.ts](file:///home/vicente/AntigravityProjects/polymarket-copybot-1/apps/worker/src/polygon-listener.ts)

```typescript
// Polygon on-chain log subscription for leader wallet activity
import { WebSocketProvider, Contract, ethers, Log } from 'ethers';
import { prisma } from '@polymarket-bot/db';
import pino from 'pino';

const logger = pino({ name: 'polygon-listener' });

// Contract addresses on Polygon
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';  // USDC on Polygon
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';   // Polymarket CTF

// Event signatures (topic0)
const USDC_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ERC1155_SINGLE_TOPIC = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
const ERC1155_BATCH_TOPIC = ethers.id('TransferBatch(address,address,address,uint256[],uint256[])');

interface LeaderWallet {
    id: string;
    wallet: string;
    label: string;
}

let provider: WebSocketProvider | null = null;
let leaderWallets: Map<string, LeaderWallet> = new Map(); // lowercased wallet -> leader

/**
 * Initialize the Polygon WebSocket connection
 */
export async function initPolygonListener(rpcUrl: string): Promise<void> {
    if (provider) {
        await provider.destroy();
    }
    
    provider = new WebSocketProvider(rpcUrl);
    
    provider.on('error', (error) => {
        logger.error({ error }, 'Polygon WebSocket error');
    });
    
    // Load enabled leaders and their wallets
    await refreshLeaderWallets();
    
    // Subscribe to logs
    await subscribeToLogs();
    
    logger.info({ 
        leaderCount: leaderWallets.size,
        rpcUrl: rpcUrl.replace(/\/[^/]*$/, '/***') // mask API key
    }, 'Polygon listener initialized');
}

/**
 * Refresh leader wallets from database
 */
export async function refreshLeaderWallets(): Promise<void> {
    const leaders = await prisma.leader.findMany({
        where: { enabled: true },
        select: { id: true, wallet: true, label: true }
    });
    
    leaderWallets.clear();
    for (const leader of leaders) {
        leaderWallets.set(leader.wallet.toLowerCase(), leader);
    }
    
    logger.info({ count: leaderWallets.size }, 'Leader wallets refreshed');
}

/**
 * Subscribe to relevant contract logs
 */
async function subscribeToLogs(): Promise<void> {
    if (!provider) {
        throw new Error('Provider not initialized');
    }
    
    // Create filter for USDC transfers
    const usdcFilter = {
        address: USDC_ADDRESS,
        topics: [USDC_TRANSFER_TOPIC]
    };
    
    // Create filter for ERC-1155 transfers on Polymarket CTF
    const erc1155Filter = {
        address: CTF_ADDRESS,
        topics: [[ERC1155_SINGLE_TOPIC, ERC1155_BATCH_TOPIC]]
    };
    
    // Subscribe to logs
    provider.on(usdcFilter, (log) => handleUsdcTransfer(log));
    provider.on(erc1155Filter, (log) => handleErc1155Transfer(log));
    
    logger.info('Subscribed to USDC and ERC-1155 transfer logs');
}

/**
 * Handle USDC transfer log
 */
async function handleUsdcTransfer(log: Log): Promise<void> {
    try {
        // Decode: Transfer(from, to, value)
        const from = ethers.getAddress('0x' + log.topics[1].slice(26));
        const to = ethers.getAddress('0x' + log.topics[2].slice(26));
        const value = BigInt(log.data);
        
        const fromLower = from.toLowerCase();
        const toLower = to.toLowerCase();
        
        // Check if sender or receiver is a tracked leader
        const leader = leaderWallets.get(fromLower) || leaderWallets.get(toLower);
        if (!leader) return;
        
        const direction = leaderWallets.has(fromLower) ? 'OUT' : 'IN';
        
        logger.info({
            leader: leader.label,
            direction,
            usdc: Number(value) / 1e6,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
        }, 'USDC transfer detected for leader');
        
        // Store raw on-chain event
        await storeOnChainEvent({
            leaderId: leader.id,
            eventType: 'USDC_TRANSFER',
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            from,
            to,
            value: value.toString(),
            detectedAt: new Date(),
        });
        
    } catch (error) {
        logger.error({ error, log }, 'Failed to process USDC transfer');
    }
}

/**
 * Handle ERC-1155 transfer log (CTF outcome tokens)
 */
async function handleErc1155Transfer(log: Log): Promise<void> {
    try {
        const isBatch = log.topics[0] === ERC1155_BATCH_TOPIC;
        
        // TransferSingle(operator, from, to, id, value)
        // TransferBatch(operator, from, to, ids[], values[])
        const from = ethers.getAddress('0x' + log.topics[2].slice(26));
        const to = ethers.getAddress('0x' + log.topics[3].slice(26));
        
        const fromLower = from.toLowerCase();
        const toLower = to.toLowerCase();
        
        // Check if sender or receiver is a tracked leader
        const leader = leaderWallets.get(fromLower) || leaderWallets.get(toLower);
        if (!leader) return;
        
        // Decode token ID(s) and value(s) from data
        let tokenId: string;
        let value: bigint;
        
        if (isBatch) {
            // Batch transfer - decode arrays
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
                ['uint256[]', 'uint256[]'],
                log.data
            );
            // For simplicity, take first token in batch
            tokenId = decoded[0][0].toString();
            value = decoded[1][0];
        } else {
            // Single transfer
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
                ['uint256', 'uint256'],
                log.data
            );
            tokenId = decoded[0].toString();
            value = decoded[1];
        }
        
        const direction = leaderWallets.has(fromLower) ? 'SELL' : 'BUY';
        
        logger.info({
            leader: leader.label,
            direction,
            tokenId,
            shares: value.toString(),
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
        }, 'CTF token transfer detected for leader');
        
        // Store raw on-chain event
        await storeOnChainEvent({
            leaderId: leader.id,
            eventType: 'CTF_TRANSFER',
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            from,
            to,
            tokenId,
            value: value.toString(),
            detectedAt: new Date(),
        });
        
        // Trigger ingestion via txHash lookup
        await triggerTradeIngestion(leader.id, log.transactionHash);
        
    } catch (error) {
        logger.error({ error, log }, 'Failed to process ERC-1155 transfer');
    }
}

interface OnChainEventData {
    leaderId: string;
    eventType: string;
    txHash: string;
    blockNumber: number;
    from: string;
    to: string;
    tokenId?: string;
    value: string;
    detectedAt: Date;
}

/**
 * Store raw on-chain event for audit trail
 */
async function storeOnChainEvent(data: OnChainEventData): Promise<void> {
    await prisma.onChainEvent.create({
        data: {
            leaderId: data.leaderId,
            eventType: data.eventType,
            txHash: data.txHash,
            blockNumber: data.blockNumber,
            payload: data as any,
            detectedAt: data.detectedAt,
        }
    });
}

/**
 * Trigger trade ingestion when on-chain event is detected
 * This correlates with Data API for full trade details
 */
async function triggerTradeIngestion(leaderId: string, txHash: string): Promise<void> {
    // Emit event or directly call ingester
    // The ingester will poll Data API for this specific tx
    // This is a "fast hint" - we know the trade happened, now get details
    
    // For now, just log - integration with ingester is in Step 2.3
    logger.debug({ leaderId, txHash }, 'Trade ingestion triggered by on-chain event');
}

/**
 * Get listener stats for health monitoring
 */
export function getPolygonListenerStats() {
    return {
        connected: provider !== null,
        leaderCount: leaderWallets.size,
    };
}
```

---

### Step 2.2: Add Database Model for On-Chain Events

**What**: Create a table to store raw on-chain events for audit and correlation.

#### [MODIFY] Prisma Schema

```prisma
model OnChainEvent {
    id          String   @id @default(cuid())
    leaderId    String
    leader      Leader   @relation(fields: [leaderId], references: [id])
    eventType   String   // USDC_TRANSFER, CTF_TRANSFER
    txHash      String
    blockNumber Int
    payload     Json
    detectedAt  DateTime @default(now())
    processed   Boolean  @default(false)
    
    @@index([leaderId, detectedAt])
    @@index([txHash])
}
```

---

### Step 2.3: Create Dual-Mode Ingestion

**What**: Modify the ingester to handle both:
1. On-chain trigger (fast path): event detected on-chain, fetch details from Data API
2. Polling (fallback): existing behavior, acts as safety net

#### [MODIFY] [ingester.ts](file:///home/vicente/AntigravityProjects/polymarket-copybot-1/apps/worker/src/ingester.ts)

Add on-chain triggered ingestion:

```diff
+import { refreshLeaderWallets } from './polygon-listener.js';

+/**
+ * Ingest a specific trade triggered by on-chain event
+ * This is the "fast path" - we already know the tx happened
+ */
+export async function ingestTradeByTxHash(
+    leaderId: string, 
+    wallet: string, 
+    txHash: string
+): Promise<boolean> {
+    // Fetch from Data API with txHash filter
+    const activities = await fetchWalletActivity(wallet, 10);
+    
+    // Find the specific transaction
+    const activity = activities.find(a => a.transactionHash === txHash);
+    if (!activity) {
+        logger.debug({ txHash }, 'Trade not yet in Data API (may need retry)');
+        return false;
+    }
+    
+    // Check if already ingested
+    const dedupeKey = buildDedupeKey(wallet, activity);
+    const existing = await prisma.trade.findUnique({
+        where: { dedupeKey }
+    });
+    if (existing) {
+        return true; // Already have it
+    }
+    
+    // Ingest using existing logic (code reuse)
+    // ... similar to existing ingestTradesForLeader logic
+    logger.info({ txHash, wallet }, 'Fast-path trade ingestion from on-chain trigger');
+    
+    return true;
+}
```

---

### Step 2.4: Integrate Polygon Listener into Worker

#### [MODIFY] [index.ts](file:///home/vicente/AntigravityProjects/polymarket-copybot-1/apps/worker/src/index.ts)

```diff
+import { initPolygonListener, getPolygonListenerStats } from './polygon-listener.js';
+import { connectQuoteWebSocket, getQuoteCacheStats } from './quote-cache.js';

+// Environment variable for Polygon RPC (WebSocket endpoint)
+const POLYGON_WS_RPC = process.env.POLYGON_WS_RPC || '';
+const USE_POLYGON_LOGS = process.env.USE_POLYGON_LOGS === 'true';

async function runPollLoop(): Promise<void> {
    // ...existing db wait logic...
    
+   // Initialize quote WebSocket cache
+   connectQuoteWebSocket();
+   logger.info('Quote WebSocket cache initialized');
    
+   // Initialize Polygon log listener (if enabled)
+   if (USE_POLYGON_LOGS && POLYGON_WS_RPC) {
+       await initPolygonListener(POLYGON_WS_RPC);
+       logger.info('Polygon on-chain listener initialized');
+   } else if (USE_POLYGON_LOGS) {
+       logger.warn('POLYGON_WS_RPC not set, falling back to polling only');
+   }
    
    logger.info('Database connected, starting poll loop');
    
    while (isRunning) {
        // ... existing poll loop logic ...
        
+       // Include WebSocket/Polygon stats in health
+       if (now - lastHealthLog >= HEALTH_LOG_INTERVAL) {
+           const quoteCacheStats = getQuoteCacheStats();
+           const polygonStats = USE_POLYGON_LOGS ? getPolygonListenerStats() : null;
+           logger.info({ quoteCacheStats, polygonStats }, 'WebSocket status');
+           // ...existing health log...
+       }
    }
}
```

---

## Phase 3: Environment & Configuration

### Step 3.1: Add Required Environment Variables

#### [MODIFY] `.env.example` (create if doesn't exist)

```bash
# Existing
DATABASE_URL=postgresql://polymarket:polymarket@localhost:5432/polymarket
POLL_INTERVAL_MS=5000

# New - Polygon Logs (Phase 2)
USE_POLYGON_LOGS=false
POLYGON_WS_RPC=wss://polygon-mainnet.g.alchemy.com/v2/YOUR_API_KEY

# Alternatively, use a public RPC (less reliable)
# POLYGON_WS_RPC=wss://polygon-rpc.com
```

### Step 3.2: Choose a Polygon RPC Provider

> [!IMPORTANT]
> You need a WebSocket-enabled Polygon RPC endpoint. Options:

| Provider | Free Tier | Reliability | Notes |
|----------|-----------|-------------|-------|
| **Alchemy** | 300M compute units/month | High | Recommended |
| **Infura** | 100k requests/day | High | Good alternative |
| **QuickNode** | Paid only | Very High | Best for production |
| **Public RPCs** | Free | Variable | Not recommended for production |

**Sign up at**: https://www.alchemy.com or https://www.infura.io

---

## Phase 4: Deployment Changes

### Step 4.1: Update systemd Service

#### [MODIFY] `polymarket-worker.service`

```diff
[Service]
# ...existing config...
Environment=NODE_ENV=production
Environment=DATABASE_URL=postgresql://polymarket:polymarket@localhost:5432/polymarket
+Environment=USE_POLYGON_LOGS=true
+Environment=POLYGON_WS_RPC=wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
```

### Step 4.2: Gradual Rollout Strategy

1. **Week 1**: Deploy with `USE_POLYGON_LOGS=false`
   - Just the quote cache improvements
   - Measure internal lag reduction

2. **Week 2**: Enable `USE_POLYGON_LOGS=true`
   - Keep polling as fallback
   - Compare on-chain vs polling detection times

3. **Week 3+**: Tune and optimize
   - Increase `POLL_INTERVAL_MS` once confident in on-chain triggers
   - Consider disabling polling entirely (set to 60s+ as safety net)

---

## Verification Checklist

### After Phase 1 (Quote Cache)

- [ ] WebSocket connects on worker startup
- [ ] Quotes are served from cache (check logs for "source: websocket")
- [ ] Fallback to REST works when cache miss
- [ ] Internal lag (`decidedAt - detectedAt`) < 500ms

### After Phase 2 (Polygon Logs)

- [ ] Polygon WebSocket connects successfully
- [ ] USDC transfers for leader wallets trigger events
- [ ] ERC-1155 transfers for leader wallets trigger events
- [ ] `OnChainEvent` table populates
- [ ] Upstream lag (`detectedAt - tradeTs`) is ~2-10 seconds consistently

### Production Readiness

- [ ] RPC provider has sufficient rate limits
- [ ] Reconnection logic works (test by killing connection)
- [ ] Polling fallback catches any missed events
- [ ] Dashboard shows latency breakdown

---

## Expected Results

| Metric | Before | After |
|--------|--------|-------|
| **Upstream Lag** | 4–20s (variable) | 2–5s (block time) |
| **Internal Lag** | 1–5s (REST calls) | < 500ms (cache) |
| **Total Latency** | 5–25s | 2–6s |
| **Consistency** | Variable | Predictable |

---

## Files Changed Summary

| Phase | Action | File |
|-------|--------|------|
| 1.1 | MODIFY | `apps/worker/src/ingester.ts` |
| 1.1 | MODIFY | `packages/db/prisma/schema.prisma` |
| 1.2 | NEW | `apps/worker/src/quote-cache.ts` |
| 1.2 | MODIFY | `apps/worker/src/index.ts` |
| 1.2 | MODIFY | `apps/worker/src/quotes.ts` |
| 2.1 | NEW | `apps/worker/src/polygon-listener.ts` |
| 2.2 | MODIFY | `packages/db/prisma/schema.prisma` |
| 2.3 | MODIFY | `apps/worker/src/ingester.ts` |
| 2.4 | MODIFY | `apps/worker/src/index.ts` |
| 3.1 | NEW | `.env.example` |

---

## Dependencies to Add

```bash
# In apps/worker:
pnpm add ethers@^6 ws
pnpm add -D @types/ws
```

---

## Risk Mitigation

> [!CAUTION]
> **RPC Rate Limits**: WebSocket subscriptions can be rate-limited. Start with Alchemy's free tier (generous) before committing to paid.

> [!WARNING]  
> **Don't disable polling immediately**: Keep it as a safety net for at least 2 weeks. Some edge cases (reorgs, RPC outages) may only be caught by polling.

> [!TIP]
> **Test with one leader first**: Enable Polygon logs only for your test wallet initially. Monitor for a few days before adding production leaders.

---

## Next Steps After This Migration

Once latency is stable at 2–6 seconds:

1. **Evaluate paper trading results** - Is match rate acceptable?
2. **Refine slippage model** - Use WebSocket quote history for better simulation
3. **Consider pending tx monitoring** - Can shave 1-2s more (advanced)
4. **(Optional) Live execution** - Only if paper results justify it
