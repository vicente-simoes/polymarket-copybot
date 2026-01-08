# fullproof_steps.md

This is an implementation runbook to evolve the current repo into the target system described in `fullproof.md`.

It’s organized **stage-by-stage**, in a sensible order that minimizes breakage and lets you verify correctness after each stage.

---

## Stage 0 — Prep and guardrails (do first)

### 0.1 Create a feature branch
- `git checkout -b fullproof-refactor`

### 0.2 Add “effective mode” logging (prevents silent misconfig)
**Why:** you already got burned by env overriding DB.

**Implement**
- In worker startup (`apps/worker/src/index.ts`), log:
  - env trigger mode (if present)
  - DB trigger mode (WorkerConfig)
  - chosen/effective trigger mode + where it came from

**Acceptance**
- Startup logs show `envTriggerMode`, `dbTriggerMode`, `effectiveTriggerMode`.

---

## Stage 1 — Fix the phantom PnL / “positions before trades” bug

### 1.1 Hard-stop backfill trades from generating paper intents
**Files**
- `apps/worker/src/paper.ts`

**Implement**
- In `generateMissingPaperIntents()` add filter:
  - `where: { isBackfill: false }`
- In `generatePaperIntentForTrade(trade)` add safety check:
  - if `trade.isBackfill` → return `{ skip: true, reason: "SKIP_BACKFILL" }`

**Acceptance**
- Start worker on a fresh DB with backfill enabled (or warm start later): no paper intents created from backfill trades.

### 1.2 Stop calling “generate missing intents/fills” automatically (recommended)
**Files**
- `apps/worker/src/index.ts`

**Implement**
- Remove (or gate behind an env flag) calls to:
  - `generateMissingPaperIntents()`
  - `simulateMissingFills()`

If you keep them, they must also filter `isBackfill=false`.

**Acceptance**
- Worker does not create intents for historical trades just because they exist.

---

## Stage 2 — API ingestion becomes cursor-based and supports “flat start”

Right now your API polling repeatedly fetches `limit=50` and re-processes duplicates.

### 2.1 Add API cursor fields to DB
**Files**
- `packages/db/prisma/schema.prisma`

**Implement (recommended)**
Add to `Leader`:
- `apiCursorTs DateTime?`
- `apiCursorInitialized Boolean @default(false)`
- `apiCursorUpdatedAt DateTime?`

Run:
- `pnpm db:migrate`

**Acceptance**
- Prisma migration applied and `Leader` has cursor fields.

### 2.2 Add startup mode in settings (flat vs warm)
**Files**
- DB model holding settings (where your settings currently live)
- `apps/web/app/settings/page.tsx`
- settings API route if needed

**Implement**
Add:
- `startupMode: "flat" | "warm"` (default `flat`)
- `warmStartSeconds: number` (default e.g. 900)

**Acceptance**
- Settings page can persist these values.

### 2.3 Implement cursor-based API polling
**Files**
- `apps/worker/src/polymarket.ts`
- `apps/worker/src/ingester.ts`

**Implement**
Create a function:
- `fetchWalletActivitySince(wallet, startTs, limit, offset)`

In ingester loop:
1) For each leader:
   - if `!apiCursorInitialized`:
     - if `startupMode=flat`: set cursor to now, mark initialized, skip ingestion
     - if `startupMode=warm`: set cursor to now - warmStartSeconds and ingest from there
2) Poll using:
   - `/activity?user=<wallet>&start=<cursorTs>&limit=<pageSize>&offset=<offset>`
3) Paginate until a page returns fewer than pageSize.
4) Ingest in ascending timestamp order.
5) Update cursor to `maxTs + 1 second`.

**Acceptance**
- Poll loop no longer re-fetches the same 50 items forever.
- Flat start ingests nothing historical.

### 2.4 Fix raw table bloat
**Files**
- `apps/worker/src/ingester.ts`
- Prisma schema if adding unique key

**Implement (choose one)**
Option A (preferred):
- Compute `dedupeKey` first.
- If `Trade` exists, do **not** insert `TradeRaw`.
- Only insert raw when you insert a new Trade.

Option B:
- Add unique `TradeRaw.dedupeKey` and upsert.

**Acceptance**
- DB does not grow `TradeRaw` rows when reprocessing duplicates.

---

## Stage 3 — Remove all Polygon batch/backfill behavior

### 3.1 Disable Polygon background backfill and reconcile scans
**Files**
- `apps/worker/src/polygon/orderFilledWatcher.ts`

**Implement**
- Remove scheduling of `runBackgroundBackfill()` from `start()`.
- Remove periodic reconcile that uses `getLogs`.
- Keep only realtime WS subscribe and event handling.

**Acceptance**
- No `getLogs` block-range scans occur in Polygon mode.

---

## Stage 4 — Make Polygon realtime cheap (wallet-filtered subscriptions)

### 4.1 Subscribe only to your leaders (maker/taker topic OR filters)
**Files**
- `apps/worker/src/polygon/orderFilledWatcher.ts`

**Implement**
For each exchange:
- maker subscription:
  - `topics: [ORDER_FILLED_TOPIC, null, [walletTopic1, walletTopic2, walletTopic3], null]`
- taker subscription:
  - `topics: [ORDER_FILLED_TOPIC, null, null, [walletTopic1, walletTopic2, walletTopic3]]`

Where:
- `walletTopic = ethers.zeroPadValue(walletLower, 32)`

**Acceptance**
- Log volume drops significantly.
- Alchemy free tier is safe with 3 wallets.

### 4.2 Add WS reconnect and health reporting (required)
**Files**
- `apps/worker/src/polygon/orderFilledWatcher.ts`

**Implement**
- On `close` / `error`, reconnect with exponential backoff.
- Track `lastLogAt`, `connectedAt`.
- `isHealthy()` should consider:
  - socket is open
  - not stale: `now - lastLogAt < polygonHealthStaleMs` (or at least connection open)

**Acceptance**
- If you unplug internet briefly, watcher reconnects automatically.

---

## Stage 5 — Polygon triggers the same trade pipeline as API

Right now Polygon events don’t create Trade rows and don’t drive paper execution.

### 5.1 Add correlation fields to Trade
**Files**
- `packages/db/prisma/schema.prisma`

**Implement**
Add to `Trade`:
- `blockNumber Int?`
- `logIndex Int?`

**Acceptance**
- Migration applied.

### 5.2 Create a single “ingest trade” entrypoint
**Files**
- New: `apps/worker/src/ingest/ingestTrade.ts` (or similar)

**Implement**
Function signature:
- `ingestTrade({ source, leaderId, wallet, conditionId, outcome, side, price, size, usdc, txHash?, blockNumber?, logIndex?, tradeTs, isBackfill, dedupeKey })`

Responsibilities:
- dedupe check
- insert Trade (+ TradeRaw if desired)
- update LeaderPosition (next stage)
- enqueue decision/execution (or return tradeId to caller)

**Acceptance**
- Both API and Polygon ingestion call the same function.

### 5.3 Convert Polygon fill events into normalized Trade objects
**Files**
- `apps/worker/src/index.ts`
- `apps/worker/src/polygon/*`

**Implement**
In Polygon onFill handler:
1) Determine which tracked leader wallet is involved (maker or taker).
2) Resolve tokenId → conditionId/outcome using your existing mapping logic.
3) Produce a normalized Trade:
   - side, price, size, usdc (from event params)
   - txHash, blockNumber, logIndex
   - tradeTs:
     - ideally fetch block timestamp once per block (cache), or set to now and update later
4) Compute dedupeKey (must match API dedupe strategy later).
5) Call `ingestTrade()`.

**Acceptance**
- With triggerMode=polygon, you can see Trades being created from Polygon logs.

---

## Stage 6 — BOTH mode dedupe + latency metrics

### 6.1 Implement a canonical dedupeKey shared by API and Polygon
**Files**
- `apps/worker/src/ingester.ts`
- `apps/worker/src/ingest/ingestTrade.ts`
- `apps/worker/src/polygon/*`

**Implement**
Pick a key both sources can compute. Recommended:
- `leaderWalletLower|txHashLower|conditionId|outcome|side|round(usdc,2)`

If API doesn’t provide `txHash`, you must use an API-specific key and then do correlation differently.
If API does provide `txHash` in your payload, use it.

**Acceptance**
- In BOTH mode, the same trade detected by API and Polygon yields only one Trade row.

### 6.2 Latency metrics
**Files**
- DB: add `LatencyEvent` table (or add columns on Trade)
- Worker: record timestamps

**Implement**
For each trade:
- `firstSeenByApiAt`
- `firstSeenByPolygonAt`
- compute and store lag stats

**Acceptance**
- Dashboard can show average lag distribution.

---

## Stage 7 — API lag fallback (Polygon sees it first)

### 7.1 Add fallback timer logic (bounded wait for API)
**Files**
- `apps/worker/src/index.ts` (Polygon handler)
- optional helper module

**Implement**
When Polygon emits an event:
1) Create/ensure Trade ingestion from Polygon (fast path).
2) Also start a timer:
   - wait `apiLagFallbackMs` (default 3000ms)
   - if API ingests same dedupeKey before timer → record `apiSeenAt` and stop
   - else keep Polygon as authoritative and proceed

**Note**
- If you decide API is source of truth for normalized fields, you can reverse the logic:
  - wait briefly for API
  - if API doesn’t show it, ingest from Polygon.
But do not block paper execution too long; latency matters.

**Acceptance**
- Polygon-triggered trades execute quickly even if API lags.

### 7.2 Targeted on-chain lookup (only if needed)
**Implement**
Only if Polygon event lacks fields needed to create Trade:
- fetch `eth_getTransactionReceipt(txHash)`
- decode the log by `logIndex`

**Acceptance**
- No broad scans; only one-off receipt fetch.

---

## Stage 8 — LeaderPosition + proportional sells (the “makes sense” rule)

### 8.1 Add LeaderPosition model
**Files**
- `packages/db/prisma/schema.prisma`

**Implement**
Model:
- `leaderId`
- `conditionId`
- `outcome`
- `shares Decimal`
- unique `[leaderId, conditionId, outcome]`

**Acceptance**
- Migration applied.

### 8.2 Update LeaderPosition on every ingested trade
**Files**
- `apps/worker/src/ingest/ingestTrade.ts`

**Implement**
After trade insert:
- BUY: `shares += size`
- SELL: `shares -= size` clamp at 0
Track `leaderPreSellShares` for sells (read before update).

**Acceptance**
- LeaderPosition always reflects leader exposure, even if you skipped copying buys.

### 8.3 Implement proportional SELL sizing in intent generation
**Files**
- `apps/worker/src/paper.ts` (or wherever sizing happens)

**Implement**
When leader SELL detected:
- If `ourPos == 0` → do nothing.
- Else:
  - `L = leaderPreSellShares`
  - `S = leaderSellSize`
  - `r = clamp(S / max(L, epsilon), 0, 1)`
  - `ourSell = ourPos * r` (apply rounding rules)
- Use guardrails for sell execution.

**Acceptance**
- If you only copied some buys, later sells reduce your holding proportionally.

---

## Stage 9 — Settings / Dashboard updates to match new logic

### 9.1 Add defaults + guardrails for catch-up policies
**Files**
- `apps/web/app/settings/page.tsx`
- settings persistence API/routes
- DB settings table/model

**Add fields**
- `maxLiveLagSec` (default 15)
- `catchUpBuyMaxAgeSec` (default 300)
- `catchUpBuyRequireBetterPrice` (default true)
- `catchUpBuyMaxWorseBps` (default 20)
- existing buy/sell slippage/spread caps should apply to catch-up too

**Acceptance**
- Settings page shows these and saves them.

### 9.2 PnL page resiliency
**Files**
- `apps/web/app/api/pnl/route.ts`

**Implement**
- Only show positions with `shares > 0` and not closed.
- Make sure PnL endpoint isn’t using backfill trades incorrectly.

**Acceptance**
- Fresh start shows no positions.

### 9.3 Add “Reset paper state” admin action
**Files**
- new web API route + UI button in settings

**Implement**
- Endpoint wipes paper-only tables (positions/intents/fills/executions).
- Requires admin token in env.

**Acceptance**
- You can reset and rerun cleanly.

---

## Stage 10 — Final operational wiring: mode behavior and health

### 10.1 Mode rules (avoid blocking incorrectly)
**Files**
- risk engine / gating logic that emits `SKIP_POLYGON_UNHEALTHY`

**Implement**
- If mode is `api`, polygon health must never block.
- If mode is `polygon`, polygon health must gate.
- If mode is `both`, degrade gracefully (use API-only if polygon down) unless “strict both” enabled.

**Acceptance**
- In BOTH mode, if Polygon drops, API continues copying.

---

## Stage 11 — ENV setup (examples + recommendations)

Create **one source of truth env file** per environment. For local dev, keep:
- `apps/worker/.env`
- `apps/web/.env`
- `packages/db/.env` (optional)
And avoid a repo-root `.env` with conflicting trigger mode.

### 11.1 Worker env: `apps/worker/.env` (example)
```env
# Database
DATABASE_URL="postgresql://polymarket:polymarket@localhost:5432/polymarket"

# Trigger mode: api | polygon | both
TRIGGER_MODE="both"

# Polymarket APIs
GAMMA_API_URL="https://gamma-api.polymarket.com"
CLOB_HTTP_URL="https://clob.polymarket.com"
CLOB_MARKET_WS_URL="wss://ws-subscriptions-clob.polymarket.com/ws/market"

# Polygon provider (Alchemy)
POLYGON_WS_URL="wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY"
POLYGON_HTTP_URL="https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY"

# Startup behavior
STARTUP_MODE="flat"          # flat | warm
WARM_START_SECONDS="900"     # only used if warm

# Polling
POLL_INTERVAL_MS="5000"
LEADER_STAGGER_MS="500"

# API lag fallback
API_LAG_FALLBACK_MS="3000"
MAX_LIVE_LAG_SEC="15"
CATCHUP_BUY_MAX_AGE_SEC="300"
CATCHUP_BUY_REQUIRE_BETTER="true"
CATCHUP_BUY_MAX_WORSE_BPS="20"

# Admin / safety
ADMIN_TOKEN="dev-local-token"
```

**Recommendations**
- Keep `TRIGGER_MODE="both"` while validating.
- For Alchemy free tier: wallet-filtered WS + no getLogs scans is the key.

### 11.2 Web env: `apps/web/.env` (example)
```env
DATABASE_URL="postgresql://polymarket:polymarket@localhost:5432/polymarket"
NEXTAUTH_SECRET="dev-secret"
ADMIN_TOKEN="dev-local-token"
```

(Include any existing web env required by your app.)

### 11.3 DB env (optional)
If you use Prisma commands from repo root, ensure `DATABASE_URL` is available there too (or pass it).

---

## Stage 12 — Testing plan (how to verify everything works)

### 12.1 Local boot test (flat start)
1) Start DB:
   - `docker compose up -d db` (or `docker-compose up -d db`)
2) Migrate:
   - `pnpm db:generate`
   - `pnpm db:migrate`
3) Start worker:
   - `pnpm -C apps/worker dev`
4) Confirm logs show:
   - `startupMode=flat`
   - cursor initialized
   - **no historical trades ingested**
   - polygon watcher started (if both/polygon)

Expected:
- Dashboard shows **no positions**.
- PnL page shows **no open positions**.

### 12.2 Realtime Polygon trigger test
Prereq: pick a leader who trades somewhat frequently.

1) Set mode to `polygon` (or `both`) in settings.
2) Wait for a real leader trade.
3) Confirm:
   - you see a Polygon log hit
   - a `Trade` row is created with `txHash`
   - a `PaperIntent` is created (if guardrails allow)
   - `PaperFill` created and position updated

Expected:
- The time from Polygon log to intent is low (seconds).

### 12.3 API lag fallback test (forced)
This is hard to reproduce naturally; simulate it:

Option A (recommended):
- Add a dev flag `SIMULATE_API_LAG=true` that makes the API ingestion path ignore new trades for 5 seconds.
- Then trigger a Polygon event.
- Confirm Polygon ingestion executes trade before API catches up.

Expected:
- trade executes from Polygon path
- later API marks `apiSeenAt` without duplicating Trade

### 12.4 Catch-up behavior test
1) Run worker in polygon mode.
2) Stop worker for 2–5 minutes.
3) Restart worker.
4) Confirm catch-up:
   - it fetches missed trades via API cursor
   - BUY catch-up obeys `catchUpBuyRequireBetterPrice` and slippage
   - SELL catch-up sells proportionally if we hold
   - no “phantom” trades from older history

Expected:
- you do not open brand new positions from old buys unless allowed
- you do close/reduce positions if leader sold while you were down

### 12.5 Partial holdings proportional sell test (deterministic)
Create a test harness:
- Insert leader position L=100
- Insert our position P=30
- Simulate leader sell S=50
Expect:
- r=0.5
- ourSell=15

Validate in unit/integration test:
- our position becomes 15

### 12.6 Regression: free-tier safety
Run for 30 minutes in BOTH mode tracking 3 wallets.
Confirm:
- no `eth_getLogs` block scans
- no sustained 429 spam
- WS event volume is low (wallet-filtered)

---

## Done criteria
You’re finished when:
- Flat start produces no positions
- Polygon mode creates trades and paper intents fast
- Both mode dedupes correctly
- Catch-up implements your BUY/SELL policies
- No batch backfills use Polygon
- Dashboard settings fully control behavior
