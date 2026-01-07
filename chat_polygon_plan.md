# chat_polygon_plan.md — Final plan: realistic + low-latency Polymarket leader copy (paper now, live soon)

_Last updated: 2026-01-07 (Europe/Lisbon)_

## Goal (what “best” means)
Build a system that:
1) **Detects every leader fill** as quickly as possible **and** does not miss fills on reconnect/restart.
2) **Emulates live copying realistically**: marketable limit orders, orderbook depth, partial fills, TTL cancels, fees/slippage, and latency.
3) Can later switch to **live execution** on Polymarket by swapping `PaperExecutor → ClobExecutor` without rewriting the pipeline.

This plan assumes your repo layout from `PROJECT_MASTER.md`:
- `apps/worker` (ingest + simulate)
- `apps/web` (dashboard)
- `packages/core` (strategy/risk)
- `packages/db` (Prisma + DB)

---

## High-level architecture (target state)

### 1) Trigger sources (leader fills)
A “fill” is the canonical unit. A single tx can contain multiple fills.

- **Primary (low latency, correct):** Polygon logs → `OrderFilled` from Polymarket exchange contracts
- **Secondary (validation/backstop):** Polymarket Data API `/activity` polling

Both sources emit the same internal type: `LeaderFillEvent`.

### 2) Normalization + mapping
`LeaderFillEvent` is enriched into `Trade`:
- resolve `tokenId → conditionId/outcome/title` via Market Registry
- attach leader metadata
- attach timestamps + chain identity for dedupe/replay

### 3) Market data layer (quotes + books)
A process-local, in-memory **Book Store** maintained via:
- CLOB market WS stream (primary)
- Batch REST snapshots for seed/resync (`POST /books`) (secondary)

Provides:
- best bid/ask at “now”
- (optional but recommended) shallow depth per token
- a ring buffer of recent book states for execution simulation

### 4) Execution layer (paper now, live soon)
A unified interface:

- `PaperExecutor` (depth + latency + TTL; produces fills)
- `ClobExecutor` (posts real orders; listens to user stream; records fills)

### 5) Portfolio + PnL
Update positions and PnL from **execution fills** (paper or live), not from leader fills.

---

## Implementation sequence (do in order)

### Phase 0 — Feature flags + scaffolding (1 PR)
**Outcome:** You can run the worker with old behavior or new behavior via env flags.

#### 0.1 Add env flags
Add to your worker config loader (where you read env vars):

- `TRIGGER_MODE = data_api | polygon | both` (default `data_api`)
- `EXECUTION_MODE = paper | live` (default `paper`)
- `BOOKSTORE_MODE = rest | ws | ws+snapshot` (default `rest` for now)
- `POLYGON_WS_URL`, `POLYGON_HTTP_URL`
- `POLY_EXCHANGE_CTF`, `POLY_EXCHANGE_NEGRISK` (addresses)
- `CLOB_MARKET_WS_URL` (default `wss://ws-subscriptions-clob.polymarket.com/ws/market`)
- `CLOB_HTTP_URL` (default `https://clob.polymarket.com`)

#### 0.2 Create “ports” (interfaces) in code
Create a small folder for interfaces (suggested):
- `apps/worker/src/ports/`

Add:
- `LeaderFillSource` interface
- `BookStore` interface
- `ExecutionAdapter` interface

Do NOT change behavior yet—just create interfaces and keep current code behind adapters.

**Acceptance**
- `pnpm -r build` still works
- Worker runs unchanged with default flags

---

### Phase 1 — DB schema upgrades (Prisma migration) (1 PR)
**Outcome:** DB can store chain-derived fills, execution attempts, and execution fills. Everything becomes replayable and live-ready.

> If you prefer minimal changes, you can embed these fields into existing tables. Best practice is to add 2 new tables and extend existing `Trade`.

#### 1.1 Add tables (recommended)
In `packages/db` Prisma schema:

**(A) `LeaderFillRaw`**
Stores raw payloads from *any* source.
- `id` (uuid)
- `source` (`data_api` | `polygon`)
- `payload` (json)
- `createdAt`

**(B) `LeaderFill`**
Canonical “leader fill” normalized from raw.
- `id`
- `leaderId`
- `source`
- `exchangeAddress` (nullable for data_api)
- `blockNumber` (nullable for data_api)
- `txHash` (nullable for data_api but usually present)
- `logIndex` (nullable for data_api)
- `orderHash` (nullable)
- `maker`, `taker` (addresses, nullable for data_api)
- `leaderRole` (`maker` | `taker` | `unknown`)
- `tokenId` (string/int depending on your existing)
- `side` (`BUY` | `SELL`)
- `leaderPrice` (decimal)
- `leaderSize` (decimal)  // shares
- `leaderUsdc` (decimal)
- `fillTs` (timestamp from chain block time or data api)
- `detectedAt`
- `dedupeKey` (unique)

**(C) `ExecutionAttempt`**
One per leader fill you choose to copy (or skip record with status).
- `id`
- `leaderFillId`
- `mode` (`paper` | `live`)
- `decision` (`TRADE` | `SKIP`)
- `decisionReason` (json/text)
- `ratio`
- `tokenId`, `side`
- `sizeSharesTarget`
- `limitPrice`
- `ttlMs`
- `status` (`SKIPPED` | `SUBMITTED` | `PARTIAL` | `FILLED` | `CANCELED` | `FAILED`)
- `placedAt`, `doneAt`
- `createdAt`

**(D) `ExecutionFill`**
Zero+ rows per attempt.
- `id`
- `attemptId`
- `filledShares`
- `fillPrice`
- `feeUsdc` (optional)
- `fillAt`

#### 1.2 Extend existing `Trade` if needed (optional)
If your dashboard is built around `Trade`, you can:
- keep `Trade` as “leader fill” view (but then it becomes confusing), OR
- keep `Trade` as your internal “enriched leader fill” and add the chain fields.

Recommended: keep `Trade` for dashboard continuity but have it reference `LeaderFill`:
- `trade.leaderFillId` (unique)

#### 1.3 Add cursor table for Polygon ingestion
Add `PolygonCursor`:
- `id`
- `exchangeAddress`
- `leaderAddress`
- `role` (`maker`|`taker`)
- `lastProcessedBlock`
- `updatedAt`
Unique on `(exchangeAddress, leaderAddress, role)`.

Run:
- `pnpm db:migrate`
- `pnpm db:generate`

**Acceptance**
- DB migrates cleanly
- You can create/read the new tables via Prisma Studio

---

### Phase 2 — Market Registry (Gamma → DB) (1 PR)
**Outcome:** Mapping is instant. No per-trade metadata fetch.

#### 2.1 Add tables
Add `MarketRegistry` (or extend existing `MarketMapping` with richer metadata):
- `conditionId` (unique)
- `title`
- `category` (optional)
- `endDate` (optional)
- `enableOrderBook` (bool)
- `yesTokenId`, `noTokenId` (or tokenIds array)
- `updatedAt`

Also add an index on `tokenId → conditionId/outcome`.

#### 2.2 Implement a registry sync worker
Create:
- `apps/worker/src/registry/gammaSync.ts`

Functionality:
1) Pull markets from Gamma (paginated)
2) Filter to `enableOrderBook=true`
3) Upsert into DB
4) Maintain tokenId indexes for fast lookup

Run modes:
- `on_startup` sync once
- optional `REGISTRY_SYNC_INTERVAL_MS` (e.g., 10–30 minutes)

#### 2.3 Add a resolver helper
Create:
- `apps/worker/src/registry/resolveToken.ts`

API:
- `resolveTokenId(tokenId) -> { conditionId, outcome, title, marketKey } | null`

**Acceptance**
- Given a tokenId from a known market, resolver returns condition/outcome without network calls
- Dashboard pages that rely on title/outcome still work (or can be updated easily)

---

### Phase 3 — Polygon `OrderFilled` watcher (primary trigger) (1 PR)
**Outcome:** Fast, correct leader fill ingestion with no missed events.

#### 3.1 Implement `OrderFilled` decoder + watcher
Create:
- `apps/worker/src/polygon/orderFilledWatcher.ts`

Dependencies:
- `ethers` (or viem; choose one and standardize)
- a WS provider and HTTP provider

Inputs:
- exchanges: `POLY_EXCHANGE_CTF`, `POLY_EXCHANGE_NEGRISK`
- leaders: load from DB (your existing leader table)
- roles: watch both maker and taker indexed topics

Core responsibilities:
1) Subscribe to logs via WS for speed
2) Persist cursor (`PolygonCursor`) frequently
3) On startup and periodically, **gap-fill** via HTTP `getLogs`:
   - from `lastProcessedBlock + 1` to `latest`
4) Convert each log → `LeaderFillRaw` + normalized `LeaderFill`
5) Deduplicate via unique `dedupeKey = exchange|block|tx|logIndex`

#### 3.2 Derive side + tokenId + amounts
Implement a pure function:
- `decodeLeaderFillFromOrderFilled(log) -> { maker, taker, makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled, ... }`

Then derive:
- If `takerAssetId == 0` (USDC) and `makerAssetId != 0` (token): leader is **SELL** token (they give token, receive USDC)
- If `makerAssetId == 0` and `takerAssetId != 0`: leader is **BUY** token
- `tokenId` is whichever assetId is non-zero
- `leaderUsdc` from USDC amount (ensure decimals)
- `leaderSize` from token amount (ensure decimals)
- `leaderPrice = leaderUsdc / leaderSize`

Also set `leaderRole`:
- if leader address == maker → `maker`
- if leader address == taker → `taker`

#### 3.3 Integrate trigger source selection
Modify your worker entrypoint:
- If `TRIGGER_MODE` includes `polygon`, start the watcher and push normalized `LeaderFill` into your ingestion pipeline.
- If `TRIGGER_MODE` includes `data_api`, keep the existing poller.
- If `both`, run both but **dedupe by `dedupeKey`**; Polygon should win when both arrive.

**Acceptance**
- For a known leader, new fills appear in DB within ~block time
- Restart worker: no duplicates, no missed events (cursor + gap-fill verified)
- Counts reconcile with Data API for same window (within expected indexing delay)

---

### Phase 4 — Market Data “Book Store” (WS + snapshot resync + quote-age tiers) (1 PR)
**Outcome:** No per-trade `/book` calls; simulation has real book depth and “state at time”.

#### 4.1 Implement `BookStore` interface
Create:
- `apps/worker/src/marketdata/bookStore.ts` (interface)
- `apps/worker/src/marketdata/clobWsBookStore.ts` (implementation)

Interface suggestions:
- `start()`
- `subscribe(tokenId)`
- `getBestBidAsk(tokenId) -> { bid, ask, updatedAt } | null`
- `getBookAt(tokenId, ts) -> { bids[], asks[], ts } | null` (from ring buffer)

#### 4.2 Seed and resync with batch snapshot
On startup and on websocket reconnect:
- call `POST /books` for all tracked tokens (or token batches)
- store snapshot into current state + ring buffer baseline

#### 4.3 Handle multiple WS message types + ordering
Implement handlers for:
- `book` updates (depth)
- `best_bid_ask` updates (fast path)
- `tick_size_change` (store metadata if needed)

If WS provides a sequence number:
- ignore out-of-order
- detect gaps; trigger resync snapshot

If no sequence number:
- rely on periodic resync (e.g., every 60–120s) + reconnect resync.

#### 4.4 Quote-age tiers (data health gate)
Implement:
- `FRESH <= 2s`
- `SOFT_STALE 2–5s` → force snapshot refresh for that token before trade
- `HARD_STALE > 5s` → mark data unhealthy; skip trade or “paper log as skipped”

#### 4.5 Subscription strategy
Pre-track tokens:
- all tokens in open positions
- all tokens leaders traded in last N hours
- optionally: top N liquid markets from registry

**Acceptance**
- Worker no longer calls `/book` per trade (only batch snapshots)
- Book store keeps updating; quote-age drops near 0 during activity
- Reconnect: state reseeded; no trading on frozen cache

---

### Phase 5 — Execution layer refactor (PaperExecutor = “live-like”) (1–2 PRs)
**Outcome:** Paper results stop lying. You simulate how live copying would really fill.

#### 5.1 Define `ExecutionAdapter`
Location suggestion:
- `packages/core/src/execution/ExecutionAdapter.ts` (so both worker + future live can share)
or
- `apps/worker/src/execution/ExecutionAdapter.ts`

API:
- `submitMarketableLimit(input) -> { attemptId, orderId? }`
- `cancel(orderId)`
- emits: fills and completion events (or returns them)

Input fields:
- `tokenId`, `side`
- `sizeShares`
- `limitPrice`
- `ttlMs`
- `placedAtTs` (for paper simulation time alignment)

#### 5.2 Implement `PaperExecutor` with depth + latency + TTL
Create:
- `apps/worker/src/execution/paperExecutor.ts`

Algorithm:
1) Determine placement time `placedAt = now + decisionLatency + submitLatency`
2) Query `BookStore.getBookAt(tokenId, placedAt)`
3) Sweep asks (for BUY) or bids (for SELL) up to `limitPrice`
4) If not fully filled:
   - keep an open simulated order that reacts to subsequent book updates
   - fill when book crosses the limit
5) At TTL: cancel remainder
6) Emit `ExecutionFill` rows as fills occur
7) Update `ExecutionAttempt.status` accordingly

Notes:
- Keep it deterministic: all randomness must be seeded or disabled.
- Always store `placedAt`, `firstFillAt`, `doneAt`.

#### 5.3 Refactor your current paper intent/fills flow to use `ExecutionAttempt`
Update:
- `apps/worker/src/paper.ts` should create the decision and an `ExecutionAttempt`
- `apps/worker/src/fills.ts` should be replaced by the executor logic OR reduced to “position update from ExecutionFill”

**Acceptance**
- One leader fill → one attempt
- Paper fills can be partial and can cancel
- Positions/PnL update based on execution fills, not leader fills

---

### Phase 6 — Risk controls (portfolio-level) + maker/taker realism (1 PR)
**Outcome:** System behaves like a survivable live bot, not a toy.

#### 6.1 Maker vs taker leader handling
If leaderRole is `maker`:
- record it in metrics
- optionally reduce copy ratio or tighten guardrails (because following a resting maker is usually worse)

#### 6.2 Portfolio exposure limits
Add in `packages/core`:
- max USDC per event/category
- max open positions
- daily drawdown kill-switch
- per-leader risk budget

#### 6.3 Data health gate
Before placing any attempt:
- require BookStore health (quote-age tiers)
- require Polygon watcher health (last block lag)
- if unhealthy → skip

**Acceptance**
- You can configure limits and see skips with reasons
- Bot halts safely under degraded data conditions

---

### Phase 7 — Validation, reconciliation, and chaos tests (1 PR)
**Outcome:** You can trust that “paper == likely live”.

#### 7.1 Reconciliation job
Create:
- `apps/worker/src/recon/reconcile.ts`

Checks:
- polygon fills vs data-api trades per leader/day (with delay tolerance)
- missing block ranges
- duplicate detection
- mapping misses (tokenId not in registry)

#### 7.2 Metrics dashboard fields
Store and display:
- detect latency (fillTs → detectedAt)
- decision latency (detectedAt → decidedAt)
- placement latency (decidedAt → placedAt)
- time-to-first-fill, time-to-done
- fill rate, partial fill rate
- slippage distribution

#### 7.3 Chaos tests (manual script ok)
Add scripts to:
- kill WS connections and verify gap-fill recovers
- restart worker mid-trade and ensure no duplicates

**Acceptance**
- You can run reconciliation and get “OK” summaries
- You can prove no missed fills over a window

---

### Phase 8 — Live execution (ClobExecutor) skeleton + guarded rollout (later)
**Outcome:** You can flip live for a small leader with small size safely.

#### 8.1 Implement `ClobExecutor` behind `EXECUTION_MODE=live`
Create:
- `apps/worker/src/execution/clobExecutor.ts`

Responsibilities:
- authenticate (L1 → L2 creds)
- submit marketable limit orders
- subscribe to user stream for fills
- record fills to `ExecutionFill`

#### 8.2 Guarded rollout plan
- allowlist leaders
- cap size very low
- run `TRIGGER_MODE=polygon`, `BOOKSTORE_MODE=ws+snapshot`
- continuously reconcile live fills vs expected

**Acceptance**
- Can place and observe a tiny order end-to-end
- No untracked fills; DB reflects reality

---

## Implementation notes (for an LLM coding agent)

### Files you will likely touch
- `apps/worker/src/index.ts` (or worker entrypoint)
- `apps/worker/src/polymarket.ts` (Data API poller — wrap behind `LeaderFillSource`)
- `apps/worker/src/mapping.ts` / registry resolver (replace with DB registry lookups)
- `apps/worker/src/quotes.ts` (replace with `BookStore`)
- `apps/worker/src/paper.ts` + `apps/worker/src/fills.ts` (refactor to `ExecutionAttempt` + executor)
- `packages/core` strategy/risk modules (portfolio limits, decision reasons)
- `packages/db` prisma schema + migrations

### Engineering rules (enforced)
- **Idempotency:** every ingestion/execution step must be safe to re-run.
- **Dedupe:** chain log identity wins: `(exchange, block, tx, logIndex)`.
- **Replayability:** store raw payloads and normalized rows.
- **No “quote-on-demand” in the hot path:** book store must serve quotes locally.

---

## Definition of done (project-level)
You can run:
- `TRIGGER_MODE=polygon`
- `BOOKSTORE_MODE=ws+snapshot`
- `EXECUTION_MODE=paper`

…and reliably observe:
- leader fills ingested within block-time
- one attempt per leader fill
- fills simulated with depth + partials + TTL cancels
- positions + PnL updated from execution fills
- reconciliation shows no missed fills over a day window

---

## Suggested PR breakdown
1) Phase 0 scaffolding
2) Phase 1 DB migration
3) Phase 2 Market Registry
4) Phase 3 Polygon watcher
5) Phase 4 Book Store
6) Phase 5 PaperExecutor + refactor pipeline
7) Phase 6 Risk controls
8) Phase 7 Reconciliation + metrics
9) Phase 8 Live executor skeleton
