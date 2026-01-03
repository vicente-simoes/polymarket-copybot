# Polymarket Copy-Trading Project Plan (Next.js + TypeScript)

This document is a **top-to-bottom build plan** for turning your working Polymarket notifier into a **TypeScript system** that:
1) Watches one or more leader wallets  
2) Runs **paper-copy trading** at a smaller scale (e.g., leader $100 → you $1)  
3) Evaluates performance (fillability, slippage, simulated P&L)  
4) Provides a **Next.js dashboard** to inspect results  
5) Leaves a clear path to optional **live execution** later (with strict safety controls)

The goal is to build this with **no hidden assumptions**, **no mismatched logic between paper and live**, and **debuggable, auditable data**.

---

## 0) Guiding principles (avoid future pain)

### Single source of truth
- **One codebase** (TypeScript monorepo).
- **One shared decision engine** used by:
  - paper mode
  - live mode (later)

If paper and live logic diverge, paper results become meaningless.

### Every decision must be explainable
Every time the system would trade or skip, store a **structured reason**:
- `SKIP_PRICE_MOVED`
- `SKIP_SPREAD_TOO_WIDE`
- `SKIP_MAX_DAILY_EXCEEDED`
- `SKIP_MARKET_NOT_ALLOWED`
- `SKIP_MISSING_MAPPING`
This makes your dashboard useful and prevents “silent failures”.

### Store raw inputs forever (cheap, saves you later)
Keep the full raw JSON for each detected trade and each quote snapshot. If you later realize a field changed, you can reprocess.

---

## 1) What you are building (high level)

### Components
1) **Watcher/Ingester (worker process)**
   - Polls Polymarket for each leader wallet
   - Normalizes trades into a stable format
   - Writes to Postgres (idempotent inserts)

2) **Market data snapshotter (worker process)**
   - Fetches best bid/ask for the exact market+outcome at decision time
   - Stores quotes in Postgres

3) **Strategy engine (shared library)**
   - Input: leader trade + market snapshot + risk state
   - Output: an “intent” (paper order or live order)
   - Contains scaling and guardrails

4) **Paper execution simulator (worker process)**
   - Uses quotes to simulate whether you’d match leader price
   - Produces fill/no-fill and slippage metrics
   - (Optional) simulates mark-to-market and resolution P&L later

5) **Next.js Dashboard**
   - Displays leaders, trades, paper results, metrics
   - Shows “why skipped” and “what would have happened”

---

## 2) Core decisions (make these now)

### Stack
- **Next.js (App Router)**
- **Postgres** (primary datastore)
- **Prisma** (ORM + migrations)
- **Worker runtime**: Node.js process (separate from Next.js web server)
- Optional later: Redis (only if you need caching/queues)

### Why Postgres (not SQLite)
- Dashboard queries, grouping, filtering, timelines, analytics.
- Concurrency (Next.js + workers).
- Easy hosting (managed Postgres).

---

## 3) Data model (Postgres schema)

Use Prisma models. These tables are the minimum to be correct and debuggable.

### 3.1 Leaders
- `leaders`
  - `id` (uuid)
  - `label` (string)
  - `wallet` (string, lowercase `0x...`)
  - `enabled` (bool)
  - `createdAt`

### 3.2 Raw events (for audit)
- `trade_raw`
  - `id` (uuid)
  - `leaderId`
  - `source` (string: `data-api/activity`)
  - `payload` (jsonb)  ← store entire trade JSON
  - `ingestedAt`

- `quote_raw`
  - `id` (uuid)
  - `marketKey` (string)
  - `payload` (jsonb)
  - `capturedAt`

### 3.3 Normalized trades
- `trades`
  - `id` (uuid)
  - `leaderId`
  - `dedupeKey` (string, unique)  
    **Must be stable**: recommended: `leaderWallet|txHash|side|conditionId|outcome|size|price`  
  - `txHash` (string)
  - `tradeTs` (timestamp)  ← leader trade timestamp
  - `detectedAt` (timestamp) ← when your watcher saw it
  - `side` (`BUY` | `SELL`)
  - `conditionId` (string)
  - `outcome` (string, e.g. `YES`/`NO` or outcomeIndex)
  - `leaderPrice` (numeric)
  - `leaderSize` (numeric, shares)
  - `leaderUsdc` (numeric, notional)
  - `title` (string, nullable)
  - `rawId` (fk to `trade_raw`)

### 3.4 Market mapping (critical)
You must map (conditionId, outcome) → “the tradable instrument for quotes and orders”.
- `market_mapping`
  - `id`
  - `conditionId`
  - `outcome`
  - `marketKey` (string)  ← internal canonical key
  - `clobTokenId` / `assetId` / whatever the quote/order endpoints require
  - `updatedAt`

**Rule:** if mapping is missing, you do NOT trade. You log `SKIP_MISSING_MAPPING`.

### 3.5 Quotes (top-of-book snapshots)
- `quotes`
  - `id`
  - `marketKey`
  - `capturedAt`
  - `bestBid` (numeric)
  - `bestAsk` (numeric)
  - `bidSize` (numeric, optional)
  - `askSize` (numeric, optional)
  - `rawId` (fk to `quote_raw`)

### 3.6 Paper intents and fills
- `paper_intents`
  - `id`
  - `tradeId` (fk to `trades`)
  - `ratio` (numeric, e.g. 0.01)
  - `yourUsdcTarget` (numeric)
  - `yourSide` (`BUY`|`SELL`)
  - `limitPrice` (numeric)  ← the price you would try (often leader price)
  - `decision` (`TRADE`|`SKIP`)
  - `decisionReason` (enum/string)
  - `createdAt`

- `paper_fills`
  - `id`
  - `intentId`
  - `filled` (bool)
  - `fillPrice` (numeric, nullable)
  - `fillAt` (timestamp, nullable)
  - `slippageAbs` (numeric, nullable)
  - `slippagePct` (numeric, nullable)
  - `matchSamePrice` (bool)
  - `quoteId` (fk to `quotes`)

---

## 4) Worker processes (how they run)

### 4.1 You will run TWO node processes in production
1) Next.js web server (dashboard)
2) Worker (polling + paper simulation)

You can run both via:
- systemd (simple VM)
- or Docker Compose (cleaner, portable)

**Do not** run polling logic inside Next.js request handlers. It will be unstable and scale poorly.

---

## 5) Watcher: trade ingestion (exact behavior)

### Inputs
- list of leaders from DB (`leaders where enabled = true`)
- polling interval (start with 5s; consider staggering per wallet)

### Algorithm (must be idempotent)
For each leader wallet:
1) Call Polymarket activity endpoint for `TRADE` events
2) For each returned item:
   - build `dedupeKey`
   - if `dedupeKey` already exists in `trades`, skip
   - else insert into `trade_raw` and `trades`
3) Record `detectedAt` (server time) for latency analysis

### No mistakes rule
- Never “remember last seen in memory only”.
- Use DB uniqueness on `dedupeKey` to prevent duplicates across restarts.

---

## 6) Quote snapshotter (best bid/ask)

### What it must do
When a new trade is ingested:
1) Resolve mapping (conditionId,outcome) → marketKey + instrument id
2) Fetch best bid/ask from the CLOB market data endpoints
3) Store `quote_raw` + normalized `quotes`

### Why this is mandatory
Without bid/ask, you cannot answer:
- “Would my order at leader price have filled?”
- “How far away was the market?”

Mid/last price is not enough.

---

## 7) Strategy engine (shared decision logic)

### Inputs
- leader trade
- latest quote (best bid/ask)
- config + risk state (daily spend, caps, allowlists)

### Outputs
- a **paper_intent** record:
  - TRADE or SKIP
  - limit price you would use
  - your target notional

### Scaling rule
If leader notional is `leaderUsdc`:
- `yourUsdcTarget = leaderUsdc * ratio`
- apply min/max:
  - min $ (avoid dust)
  - max $ per trade
  - max $ per day

### Guardrails (recommended defaults)
- `MAX_USDC_PER_TRADE` (e.g. 2)
- `MAX_USDC_PER_DAY` (e.g. 10)
- `MAX_PRICE_MOVE_PCT` (e.g. 0.5% to 1%)
- `MAX_SPREAD` (e.g. 1–2 cents depending on market)
- `ALLOWLIST` optional: only copy markets you explicitly allow

### “Same price or skip” rule (paper test)
Define your intended behavior precisely:
- For **BUY**: attempt limit at `leaderPrice`
  - `matchSamePrice = (bestAsk <= leaderPrice)`
- For **SELL**: attempt limit at `leaderPrice`
  - `matchSamePrice = (bestBid >= leaderPrice)`

If `matchSamePrice` is false:
- you either SKIP
- or you define a controlled slippage mode (later):
  - `limitPrice = bestAsk` for BUY, `bestBid` for SELL
  - only if `slippagePct <= SLIPPAGE_CAP`

**Pick one behavior and keep it identical between paper and live.**

---

## 8) Paper execution simulator

### Purpose
Simulate what would have happened if you placed the intended order immediately at decision time.

### Minimal simulation (good for 2-day test)
- If `matchSamePrice == true`: mark filled, fillPrice = leaderPrice (or bestAsk/bestBid depending on your fill model)
- If false: not filled (or filled at needed price if you allow slippage)

Store:
- fill/no-fill
- slippage
- matchSamePrice flag

### Later upgrade (optional)
- Track your simulated positions (shares) and compute mark-to-market
- Estimate final resolution P&L when markets resolve

---

## 9) Next.js dashboard (what to build first)

### Pages
1) **/leaders**
   - list leaders, enable/disable, edit label, set ratio
2) **/trades**
   - timeline of leader trades
   - filters: leader, market, side, date
3) **/paper**
   - paper intents + fills
   - show matchSamePrice, slippage
4) **/metrics**
   - summary cards:
     - match rate (%)
     - avg slippage when not matched
     - worst slippage
     - trades copied vs skipped
   - charts: daily match rate, by leader, by market
5) **/debug**
   - raw payload viewer for a selected trade/quote (for troubleshooting)

### Dashboard rule
Everything the UI shows must come from DB tables. No “parsing logs”.

---

## 10) Repository structure (recommended)

```
polymarket-bot/
  apps/
    web/                 # Next.js app
    worker/              # Node worker (polling + paper sim)
  packages/
    core/                # shared types + strategy engine + mapping utils
    db/                  # Prisma schema + DB utilities
  docker-compose.yml     # optional
  README.md
  docs/
    polymarketplan.md    # this file
```

If you prefer a single Next.js app plus a worker folder, that’s fine too. The key is **shared core logic**.

---

## 11) Configuration (env vars)

### Web (Next.js)
- `DATABASE_URL=postgres://...`

### Worker
- `DATABASE_URL=postgres://...`
- `POLL_INTERVAL_MS=5000`
- `LEADER_FETCH_LIMIT=50`
- `RATIO_DEFAULT=0.01`
- Guardrails:
  - `MAX_USDC_PER_TRADE=2`
  - `MAX_USDC_PER_DAY=10`
  - `MAX_PRICE_MOVE_PCT=0.01`
  - `MAX_SPREAD=0.02`
- Feature flags:
  - `PAPER_MODE=true` (always true for first phase)
  - `LIVE_TRADING_ENABLED=false` (must default false forever until intentionally enabled)

**Non-negotiable:** live trading must require an explicit `LIVE_TRADING_ENABLED=true`.

---

## 12) Build order (milestones)

### Milestone 1 — Database + basic Next.js skeleton
- Create Next.js app
- Set up Postgres
- Add Prisma schema + migrations
- Build `/leaders` CRUD UI

**Definition of done:** you can add a leader wallet and see it in the UI.

### Milestone 2 — Worker trade ingestion (watching)
- Build worker process
- Poll each leader’s trades and insert into DB (raw + normalized)
- Show `/trades` timeline in dashboard

**Definition of done:** trades appear reliably, no duplicates, survives restarts.

### Milestone 3 — Market mapping + quotes
- Implement mapping storage and retrieval
- Quote fetcher writes bid/ask snapshots
- Show quotes tied to trades in UI

**Definition of done:** for each trade you can see best bid/ask captured near detection time.

### Milestone 4 — Paper strategy + paper fills
- Implement strategy engine + guardrails
- Create paper intents and fills
- Build `/paper` view and `/metrics`

**Definition of done:** 2-day paper run produces match-rate + slippage metrics.

### Milestone 5 — Hardening
- Rate-limit handling + retries
- Per-wallet staggering
- Monitoring: logs + health endpoint + “last seen trade time”
- Docker/systemd deployment scripts

**Definition of done:** runs for days without manual babysitting.

### Milestone 6 (later) — Live execution (optional)
Only after paper results are acceptable:
- Add execution module using official client
- Add key management (secrets)
- Add kill switch + strict caps

---

## 13) Safety and security checklist (for later live trading)

- Use a **separate wallet** for the bot.
- Keep only the funds you’re willing to lose.
- Store secrets in a secret manager or locked-down env file.
- Restrict SSH and keep VM patched.
- Add hard caps and a kill switch.
- Log every order attempt + response.

---

## 14) “No room for mistakes” operational checks

### Correctness checks
- DB unique constraint prevents duplicates.
- Raw payload stored for every trade and quote.
- Missing mapping always results in SKIP + reason.
- Paper and live use the same strategy engine.

### Reliability checks
- Worker restarts cleanly (no in-memory state required).
- If Polymarket API fails, exponential backoff + retry.
- Health dashboard shows:
  - last trade detected per leader
  - last quote captured
  - worker uptime / last poll timestamp

---

## 15) What you should do next (action list)

1) Create repo structure (Next.js app + worker + shared core)
2) Set up Postgres + Prisma migrations
3) Implement leaders CRUD
4) Implement watcher ingestion into DB
5) Implement mapping + quote snapshots
6) Implement paper strategy + fill simulation
7) Build metrics dashboard
8) Run 2-day paper test and review results

---

### If you want this to be truly mistake-proof:
Before writing any live-execution code, add a dashboard tile:
- **“Paper vs Leader price match rate (last 24h)”**
If that isn’t consistently high in the markets you copy, live copying will disappoint.
