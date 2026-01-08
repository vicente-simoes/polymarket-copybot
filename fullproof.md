# Fullproof plan: Polymarket copy-trader (API backfill only + Polygon realtime)

This document is written to be **fed to an engineer/LLM** to implement changes safely and predictably, based on the current repo state in `repo.zip`.

---

## 0) What you want (target behavior)

### Core goal
Watch a set of “leader” wallets. When a leader trade is detected **as fast as possible**, simulate copying it (paper trading) **only if** it passes the guardrails (settings page).

### Data sources & modes
You want **three realtime configurations**:

1) **API**  
   - Detect trades via Polymarket Data-API polling (lower fidelity latency).

2) **Polygon (Alchemy)**  
   - Detect trades via Polygon logs in realtime (fast).  
   - Use Polymarket/CLOB APIs only for **token mapping + quotes**, not for detection.

3) **Both** (default)  
   - Run both sources and **dedupe**.
   - Record latency metrics per trade.

### Backfills
- **All batch / backfill operations must be API-only.**  
- Polygon must be used only for realtime detection (plus *rare* targeted on-chain fallback).

### Catch-up logic
If a trade is missed and later discovered (“catch-up”):
- **BUY**: only copy if price/guardrails allow (you may require “better than leader” or “within slippage”).  
- **SELL**: if we’re holding that position, it usually makes sense to sell (subject to your SELL guardrail rules). If we’re not holding it, do nothing.

### Partial holdings / multi-buy history
If a leader built a position with multiple buys and we only copied part of it, then later sells must be replicated in a way that makes sense:
- If a leader sells X tokens out of L tokens (pre-sell), that’s a **% reduction**.  
- Apply the same % reduction to our current holding P:
  - `ourSell = P * (X / L)` (clamped to `[0, P]`).

---

## 1) What I found in the current repo (problems vs your desired behavior)

### 1.1 Polygon mode currently does not drive the trade pipeline
In `apps/worker/src/index.ts`, `startPolygonWatcher()` registers an `onFill` callback that **only logs** the event; it does not translate it into a `Trade` and therefore does not produce intents/executions.

**Impact:** “Polygon mode” can’t actually be your realtime trigger today.

### 1.2 Polygon watcher subscribes to a firehose (wastes Alchemy / can lead to 429)
In `apps/worker/src/polygon/orderFilledWatcher.ts`, `subscribeToLogs()` subscribes to:
- `topics: [ORDER_FILLED_TOPIC]` (no wallet filtering)

Then it filters *after the fact* in `processLog()`.

**Impact:** you receive a huge volume of logs, even though you only care about ~3 wallets. This is the #1 reason you can hit provider limits / instability.

### 1.3 Polygon watcher still runs a background block-scan “backfill”
In `apps/worker/src/polygon/orderFilledWatcher.ts`, `runBackgroundBackfill()` loops:
- `getBlockNumber()`
- repeated `getLogs(...)` calls (maker/taker scans) + DB cursor updates

This is explicitly **batch/backfill** behavior.

**Impact:** violates your “API-only backfill” rule AND increases HTTP request volume (429 risk).

### 1.4 API trade polling is not cursor-based
In `apps/worker/src/polymarket.ts`, `fetchWalletActivity()` always fetches `limit=50` without a cursor (`start/end/offset`).
In `apps/worker/src/ingester.ts`, those 50 items are reprocessed each poll.

**Impact:** unnecessary load + duplicates. Even though `Trade` dedupe prevents double trades, **raw tables can grow** (see next item).

### 1.5 Raw payload tables can bloat badly under duplicates
In `apps/worker/src/ingester.ts`, a `TradeRaw` row is created before the `Trade` insert attempt.
If the `Trade` insert later fails due to uniqueness, the raw row remains.

**Impact:** DB grows quickly and can create confusing “ghost history.”

### 1.6 PnL showing positions “before any trades”
Root cause is consistent with this behavior:
- “initial backfill” (first API poll) stores historical trades with `isBackfill: true` in `ingester.ts`.
- BUT `apps/worker/src/paper.ts::generateMissingPaperIntents()` does **not** filter out backfill trades.
- `apps/worker/src/index.ts` runs `generateMissingPaperIntents()` in the poll loop.
- Those intents can then be executed by `PaperExecutor`, creating positions.

**Impact:** you get positions/pnl from historical backfill trades, even when you expected a “fresh start”.

### 1.7 ENV override footgun (you already hit it)
Root `.env` contains `TRIGGER_MODE=data_api`, which can override your default “both” logic.

**Impact:** silent mode changes are easy.

---

## 2) The architecture you should implement (simple + robust)

### 2.1 One canonical “trade event” pipeline
Regardless of trigger source (API vs Polygon), everything should become the same internal unit:

`RawEvent -> Trade (deduped) -> LeaderPosition update -> PaperIntent -> ExecutionAttempt/PaperFill -> Position -> PnL`

### 2.2 Separate concerns cleanly
- **Detection layer**: API poller / Polygon WS only.
- **Normalization**: convert source payload to your `Trade` model.
- **Decision layer**: guardrails + catch-up logic + sizing logic.
- **Execution**: PaperExecutor, updates positions.
- **Observability**: latency metrics, health checks, debug tables.

---

## 3) Database changes (Prisma)

### 3.1 Add API cursor state (per leader wallet)
You need cursor-based polling to avoid re-fetching the same 50 items forever.

**Option A (recommended): add to `Leader`**
- `apiCursorTs DateTime?` (last processed activity timestamp)
- `apiCursorInitialized Boolean @default(false)`
- `apiCursorUpdatedAt DateTime?`

**Option B: separate table**
- `LeaderCursor` keyed by `leaderId` (cleaner if you want multiple cursor types).

**Behavior:**
- On first startup with “start flat”, set cursor to `now()` and mark initialized without ingesting older activity.

### 3.2 Add leader position state (needed for “sell % reduction” logic)
Add a `LeaderPosition` model:

- `leaderId`
- `conditionId`
- `outcome`
- `shares Decimal` (leader’s current token count)
- `updatedAt`

Unique constraint: `@@unique([leaderId, conditionId, outcome])`

This table updates **for every ingested leader trade** (including trades you skip copying), so you always know leader pre-sell size.

### 3.3 Add fields for cross-source correlation / debugging
Extend `Trade` with optional:
- `blockNumber Int?`
- `logIndex Int?`

These are filled from Polygon events (API will leave null).

### 3.4 Prevent raw table bloat
Add either:
- `TradeRaw.dedupeKey String? @unique` (or `(leaderId, source, externalId)` unique)
- Or change ingestion to only create `TradeRaw` after confirming `Trade` is new.

---

## 4) Worker changes (apps/worker)

### 4.1 Make API polling cursor-based + “start flat” by default
Files:
- `apps/worker/src/polymarket.ts`
- `apps/worker/src/ingester.ts`
- `packages/db/prisma/schema.prisma`

#### 4.1.1 Use `/activity` with `start/end/limit/offset`
Implement `fetchWalletActivitySince(wallet, startTs, limit, offset)`.

Algorithm per leader:
1. If cursor not initialized:
   - If `STARTUP_MODE=flat`: set cursor to now and return (no ingestion).
   - If `STARTUP_MODE=warm`: set cursor to `(now - warmStartSeconds)` and ingest.
2. On each poll:
   - call `/activity?user=<wallet>&start=<cursorTs>&limit=500&offset=0`
   - paginate with `offset` until fewer than limit
   - ingest activities ascending by timestamp
   - update cursor to max(timestamp) + 1s

#### 4.1.2 Make “initial backfill” not trade-executable
Even if you ingest warm-start history, those trades must be tagged `isBackfill=true` and must **never** produce intents/executions unless you explicitly opt in.

### 4.2 Fix the “phantom positions” bug immediately
Files:
- `apps/worker/src/paper.ts`
- `apps/worker/src/index.ts`

Changes:
- In `generateMissingPaperIntents()` add `where: { isBackfill: false }` (or an equivalent filter).
- Also add the same backfill filter in `generatePaperIntentForTrade(trade)` as a safety belt:
  - If `trade.isBackfill === true` return SKIP with reason `SKIP_BACKFILL`.
- Consider removing `generateMissingPaperIntents()` entirely once ingestion is reliable.

### 4.3 Make Polygon a true realtime trigger (and remove batch behavior)

#### 4.3.1 Stop Polygon background block scans
File: `apps/worker/src/polygon/orderFilledWatcher.ts`

- Delete or hard-gate `runBackgroundBackfill()` behind an explicit config flag:
  - default: **OFF**
- Remove (or disable by default) any periodic `getLogs` reconcile.

This aligns with “API-only backfills”.

#### 4.3.2 Fix WS subscription: filter by the tracked wallets
File: `apps/worker/src/polygon/orderFilledWatcher.ts`

Replace the firehose `topics: [ORDER_FILLED_TOPIC]` subscription with **two wallet-filtered subscriptions** per exchange:
- Maker subscription:
  - `topics: [ORDER_FILLED_TOPIC, null, [walletTopic1, walletTopic2, walletTopic3]]`
- Taker subscription:
  - `topics: [ORDER_FILLED_TOPIC, null, null, [walletTopic1, walletTopic2, walletTopic3]]`

Notes:
- `walletTopic = ethers.zeroPadValue(wallet, 32)`
- This reduces log volume dramatically and helps you stay inside free tier.

#### 4.3.3 Convert Polygon fills into `Trade` records
File: `apps/worker/src/index.ts` + new helper in `apps/worker/src/ingester.ts` (or a new module)

In the Polygon `onFill` callback:
1. Resolve token -> `(conditionId, outcome, clobTokenId)` using your existing registry resolver.
2. Create `TradeRaw` with `source='polygon/orderFilled'` and payload including `txHash`, `logIndex`, `blockNumber`.
3. Create `Trade` with:
   - `txHash`, `tradeTs` (block timestamp if you fetch it, else `detectedAt`)
   - `side`, `leaderPrice`, `leaderSize`, `leaderUsdc`
   - `conditionId`, `outcome`
   - `dedupeKey` (must match API dedupe for the same trade; see next section)
4. Run the normal decision/execution pipeline:
   - update `LeaderPosition`
   - generate intent
   - execute (paper)

### 4.4 Dedupe correctly when in BOTH mode
Requirement: The same leader trade arriving via API and Polygon should **not** create two `Trade` rows (and therefore should not double-copy).

Implementation:
- Define **one canonical dedupe key** that both sources can compute reliably.
- Strong practical option:
  - `dedupeKey = leaderWalletLower + '|' + txHashLower + '|' + conditionId + '|' + outcome + '|' + side + '|' + round(usdcSize, 2)`

Rationale:
- txHash is shared across sources
- usdcSize rounded to cents is stable enough
- condition/outcome prevents collisions inside the tx

If you can match `logIndex` between sources (you usually can’t from API), you can upgrade the key later.

### 4.5 Implement the “API lag fallback”
You want:
> “API lag fallback” (wait briefly, then targeted on-chain lookup for that tx/log if needed)

How to implement cleanly:
- When Polygon sees a fill:
  1. Write a `LatencyEvent` immediately.
  2. Start a timer (e.g. 2–5 seconds).
  3. If API ingests the same dedupeKey before the timer fires, do nothing (API caught up).
  4. If API does not ingest it in time:
     - Use Polygon payload as authoritative and execute from Polygon-derived `Trade`.

Targeted on-chain lookup should be **rare**:
- Only if Polygon WS gives you txHash but missing critical fields (usually you have everything already).
- If needed, do a single `eth_getTransactionReceipt(txHash)` and parse the relevant log.

### 4.6 Make data-health checks mode-aware (do not skip trades incorrectly)
File: `apps/worker/src/riskEngine.ts` (or wherever `SKIP_POLYGON_UNHEALTHY` is produced)

Rules:
- `triggerMode=api` => polygon health must **not** block execution.
- `triggerMode=polygon` => polygon must be healthy; API can be “degraded” but not blocking.
- `triggerMode=both` => if polygon is unhealthy, you may:
  - continue using API only (log WARN + record degraded mode)
  - OR block if user explicitly wants strict comparison mode

Default should be **degrade gracefully** (maximize copying).

---

## 5) Catch-up trade logic (maximize copy performance)

### 5.1 Classify trades by “freshness”
Define:
- `ageSec = now - trade.tradeTs`
- If `ageSec <= maxLiveLagSec` => “LIVE”
- Else => “CATCH_UP”

Add settings:
- `maxLiveLagSec` (default 10–20s)
- `catchUpBuyMaxAgeSec` (default 5–15 minutes; beyond that, always skip buys)
- `apiLagFallbackMs` (default 3000ms)

### 5.2 Maintain leader positions regardless of whether you copied
On every ingested trade:
- Update `LeaderPosition`:
  - BUY: `leaderShares += trade.leaderSize`
  - SELL: `leaderShares -= trade.leaderSize` (clamp at 0)

This ensures sells always know leader pre-sell size.

### 5.3 Sizing rules for BUY
Base size is already in your system via `ratioDefault` / leader ratio.

For LIVE BUY:
- attempt if:
  - spread <= maxSpread
  - price move <= maxPriceMovePct
  - within exposure caps (`maxUsdcPerTrade`, `maxUsdcPerEvent`, `maxOpenPositions`, etc)

For CATCH_UP BUY:
- only attempt if:
  - **current price is not worse than leader beyond allowed slippage**
  - optionally require “better than leader” (recommended default: require <= leaderPrice + small tolerance)

Suggested default:
- Catch-up BUY allowed only if `currentAsk <= leaderPrice * (1 + 0.002)` (0.2% worse max), AND spread constraint holds.

### 5.4 Sizing rules for SELL (the “makes sense” rule)
If we hold nothing: do nothing.

If we hold P shares:
- Find leader pre-sell shares L (from `LeaderPosition` just before applying the sell).
- Leader reduction ratio: `r = sellSize / max(L, epsilon)`
- Our sell size: `ourSell = P * r`

Clamp:
- `ourSell <= P`
- if `ourSell` < dust threshold => skip

**This solves:**
- leader bought 3 times, you copied only the last
- later sells still reduce your position proportionally

### 5.5 SELL guardrails (recommended defaults)
Your settings already have:
- `sellAlwaysAttempt` default true
- `sellMaxSpread` / `sellMaxPriceMovePct` more lenient

Recommendation:
- Keep `sellAlwaysAttempt=true` for catch-up sells as well (you’d rather exit than drift).

---

## 6) Dashboard changes (apps/web)

### 6.1 Settings page: add the missing controls
File: `apps/web/app/settings/page.tsx`

Add fields (in DB `Settings` unless noted):
- Startup:
  - `startupMode`: `flat | warm` (default flat)
  - `warmStartSeconds`: number (only used if warm)
- Freshness / catch-up:
  - `maxLiveLagSec`
  - `catchUpBuyMaxAgeSec`
  - `apiLagFallbackMs` (worker operational; can be `WorkerConfig` key)
- Catch-up BUY policy:
  - `catchUpBuyRequireBetterPrice` boolean (default true)
  - `catchUpBuyMaxWorseBps` (default 20 bps)
- SELL policy:
  - show + explain the proportional sell behavior (no input needed beyond existing sell settings)
- Trigger mode:
  - keep using `apps/web/app/api/trigger-mode/route.ts` to set WorkerConfig `triggerMode`

Also display:
- current triggerMode
- polygon ws connected? last event timestamp?
- api poll last success timestamp?

### 6.2 Add an explicit “Reset paper state” button
Reason: you will often want to wipe paper positions and replay cleanly.

Implementation:
- new API route: `POST /api/admin/reset-paper`
- deletes:
  - positions, pnlSnapshots, paperFills, executionAttempts, paperIntents (maybe keep trades)
- requires a simple admin token in env (even for local use)

### 6.3 PnL page: guard against “stale open positions”
File: `apps/web/app/api/pnl/route.ts`

Even after you fix the real bug, make UI resilient:
- `where: { isClosed: false, shares: { gt: 0 } }`
- consider `avgEntryPrice != null` for open positions (optional)

---

## 7) Provider usage: how to stay under Alchemy free tier

Your biggest wins:
1) **Wallet-filter WS subscriptions** (massive reduction in events processed).
2) **No periodic getLogs scans**.
3) **Only do HTTP calls for rare fallback** (receipt lookup, maybe block timestamp).

Operational recommendations:
- Add a small rate limiter around any Polygon HTTP calls (token bucket).
- Log provider 429s distinctly with counters.
- Add a “last polygon event time” gauge; if stale, reconnect WS.

---

## 8) Implementation checklist (ordered, minimal risk)

### Step 1 — Stop executing backfill trades (fix PnL bug)
- Filter `isBackfill=false` in `generateMissingPaperIntents()`
- Add safety check in `generatePaperIntentForTrade()`
- Verify PnL starts empty on a fresh DB

### Step 2 — Make API polling cursor-based
- Add cursor fields (DB)
- Implement `/activity` start/offset polling
- Remove the “always fetch last 50” behavior
- Ensure raw rows only grow when trades are new

### Step 3 — Make Polygon watcher cheap and realtime-only
- Remove background backfill
- Implement wallet-filtered topic subscriptions
- Ensure WS reconnect logic is solid

### Step 4 — Polygon -> Trade pipeline
- Convert polygon fills to canonical `Trade` rows
- Ensure dedupeKey matches API and prevents double-copy
- Add API lag fallback timer

### Step 5 — LeaderPosition + proportional sells
- Add `LeaderPosition` table
- Update it on every ingested trade
- Implement proportional sell sizing

### Step 6 — Settings/UI
- Add startup + catch-up controls
- Add reset paper state button
- Add health/metrics display

---

## 9) Small “open decisions” (not blockers, but you should decide)
1) When `startupMode=flat`, should you ingest historical activity at all (for analytics) or skip entirely?  
   - Recommendation: **skip entirely** and just set cursor to now.

2) What’s the default “max live lag” for treating something as catch-up?  
   - Recommendation: **15 seconds**.

3) Catch-up BUY: require “better than leader” or allow slightly worse?  
   - Recommendation: require “not worse than leader by more than 20 bps”.

---

## Appendix: Where to change what (quick map)

### Worker
- API polling: `apps/worker/src/polymarket.ts`, `apps/worker/src/ingester.ts`
- Intent generation & backfill bug: `apps/worker/src/paper.ts`, `apps/worker/src/index.ts`
- Polygon watcher: `apps/worker/src/polygon/orderFilledWatcher.ts`, `apps/worker/src/polygon/index.ts`
- Execution/positions: `apps/worker/src/execution/paperExecutor.ts`, `packages/core/src/positions.ts`

### Web
- Settings UI: `apps/web/app/settings/page.tsx`
- Trigger mode API: `apps/web/app/api/trigger-mode/route.ts`
- PnL API: `apps/web/app/api/pnl/route.ts`
- PnL UI: `apps/web/app/pnl/page.tsx`

### DB
- Prisma schema: `packages/db/prisma/schema.prisma`
- Migrations: `packages/db/prisma/migrations/*`

