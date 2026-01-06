# Polymarket Copy-Trading Bot — Master Project Document

_Last updated: 2026-01-06_

This file is the **single source of truth** for understanding the project end-to-end:
- what it is today (implemented),
- how it started and evolved,
- how the repo is structured,
- how data flows through the system,
- how to run/test/deploy it,
- and the planned “next level” roadmap (low‑latency triggers → optional live copy).

> **Important note about this zip:** a few source files in the uploaded archive contain literal `...` placeholders in the middle of code/type definitions (and the Prisma schema file also appears truncated).  
> That would normally break TypeScript/Prisma compilation. Your *actual running repo* is likely complete, but this archive looks partially redacted or truncated.  
> In practice: treat your GitHub repo (and `pnpm -r build`) as the final validator. This document reflects the architecture and the parts that are clearly present.

---

## 0) Executive summary

You have a **TypeScript monorepo** that:
- Watches one or more **leader wallets** (stored in Postgres)
- Pulls their Polymarket **activity/trades** (Data API polling)
- Stores **raw events** + **normalized trades** in Postgres
- Resolves **market mappings** (conditionId/outcome → marketKey/token)
- Captures **quotes** (best bid/ask snapshots from Polymarket CLOB)
- Runs a shared **strategy engine** that decides whether to copy (paper)
- Simulates **paper fills** + **slippage**
- Tracks **positions** and computes **P&L**
- Exposes a **Next.js dashboard** to manage leaders/settings and inspect results

Current state: **paper trading mode** with a working dashboard including P&L.

---

## 1) How it began and how it evolved

### Phase A — “Notifier” (first working version)
- Goal: notify you when a target wallet buys/sells.
- Implementation: a polling watcher + Telegram notifications, with a dedupe store.
- Deployment: VM + systemd to run 24/7.

### Phase B — “Paper copy-trader + dashboard” (current repo)
- Goal: turn watch events into **paper-copy trading**, evaluate performance, and prepare for a future “live copy”.
- Implementation: a **Next.js dashboard + worker + Postgres**.
- Key design choice: all copy/skip logic lives in a shared **strategy engine** (`packages/core`) so paper and future live share the exact same decision logic.

---

## 2) Current system: architecture and components

### Components
- **DB (Postgres)**  
  Stores leaders, raw trades, normalized trades, mappings, quotes, paper intents/fills, positions, resolutions, P&L snapshots.

- **Worker (`apps/worker`)**  
  Long-running poller/ingester + paper simulation engine.
  - polls enabled leaders
  - ingests new trades (raw + normalized)
  - resolves mapping & captures quotes
  - generates paper intents (TRADE/SKIP + reason)
  - simulates fills + slippage
  - updates positions and snapshots

- **Dashboard (`apps/web`)**  
  Next.js app for:
  - leader management
  - guardrail settings
  - trades & latency inspection
  - paper fills & metrics
  - P&L and charts
  - debug tools

- **Core (`packages/core`)**  
  Strategy engine, validation, settings logic, position tracking, resolution checking.

- **DB package (`packages/db`)**  
  Prisma client and DB utilities.

---

## 3) Domain concepts (Polymarket operations)

You will see these operation types throughout the system:

- **BUY**: acquire outcome shares (e.g., “YES” shares).
- **SELL**: sell outcome shares back into the order book.
- **SPLIT**: split collateral into a set of conditional tokens (turn collateral into per-outcome tokens).
- **MERGE**: merge conditional tokens back into collateral (inverse of split).
- **REDEEM**: redeem after resolution (sometimes appears in activity).

In your system today:
- BUY/SELL map to paper intents and fill simulation.
- SPLIT/MERGE are supported in settings/strategy enums; the “next level” plan treats them specially (often “always follow” depending on your preference).

---

## 4) Repo layout (monorepo)

Top-level:
- `apps/web` — Next.js dashboard
- `apps/worker` — ingestion + simulation worker
- `packages/core` — strategy & risk logic
- `packages/db` — Prisma client and DB glue
- `docker-compose.yml` — local Postgres
- Docs: `polymarketplan.md`, `stepbystep.md`, `testanddeploy.md`, `deploy-guide.md`, `upgrade*.md`, `problems.md`

Workspace tooling:
- Root package: **polymarket-copybot**
- Uses **pnpm workspace** (`pnpm-workspace.yaml`)
- Notable scripts (root `package.json`): `dev:web, dev:worker, build, db:migrate, db:studio, db:generate`

---

## 5) Configuration (environment variables)

### Required
- `DATABASE_URL`  
  Used by Prisma (`packages/db/src/index.ts`). If missing, DB defaults to:
  `postgresql://polymarket:polymarket@localhost:5432/polymarket`

### Worker runtime knobs (observed in code)
- `POLL_INTERVAL_MS` — default 5000ms (poll loop interval)
- `LEADER_FETCH_LIMIT` — leader activity fetch limit (default varies)
- `LEADER_STAGGER_MS` — stagger between leaders to reduce API bursts
- `HEALTH_LOG_INTERVAL` — periodic worker health logging
- `PNL_SNAPSHOT_INTERVAL` — periodic snapshot interval
- `COPY_RATIO` — legacy ratio default used by paper intent generator

### General
- `NODE_ENV` — impacts Prisma logging

---

## 6) Data flow: from leader trade → paper copy result

### Step 1 — Leader ingestion
Worker pulls enabled leaders from DB and ingests their activity.

For each leader wallet:
1. Fetch activity from Polymarket Data API (`https://data-api.polymarket.com/activity`)
2. Build a dedupe key (wallet + tx hash + trade details)
3. If not already ingested, store:
   - **TradeRaw** (full payload)
   - **Trade** (normalized record)

### Step 2 — Market mapping
Resolve `(conditionId, outcome)` into a tradable market/token:
- Uses Polymarket CLOB market metadata (CLOB REST endpoint).
- Stores mapping in `marketMapping`:
  - `marketKey` is canonical (often `conditionId:OUTCOME`)
  - `clobTokenId` found from CLOB metadata

### Step 3 — Quote capture (best bid/ask)
Capture best bid/ask from the Polymarket CLOB orderbook:
- Store **QuoteRaw** (full orderbook payload)
- Store **Quote** (bestBid/bestAsk + sizes + rawId)

### Step 4 — Paper intent generation (strategy engine)
For any trade missing a paper intent, generate one using the shared strategy engine:
- decision: `TRADE` or `SKIP`
- decisionReason (structured reason)
- `yourUsdcTarget`, `limitPrice`, operation type

### Step 5 — Paper fill simulation
For `TRADE` intents:
- simulate fill
- compute slippage

### Step 6 — Position & P&L tracking
When a simulated fill happens:
- update **Position**
- record P&L snapshots periodically (worker) and/or via dashboard API

---

## 7) Database model (logical view)

The exact Prisma schema file in this archive appears truncated, but the code clearly uses these logical tables:

### Leaders
- `id`, `label`, `wallet`, `enabled`
- per-leader overrides exist in generated types/UI intent (ratio, maxes)

### TradeRaw
- `id`, `leaderId`, `source`, `payload` (JSON)

### Trade
Fields observed in worker:
- `leaderId`, `dedupeKey` (unique), `txHash`
- `tradeTs` (leader timestamp), `detectedAt` (ingest time; latency)
- `side`, `conditionId`, `outcome`
- `leaderPrice`, `leaderSize`, `leaderUsdc`
- `title`, `isBackfill`, `rawId`

### MarketMapping
- `conditionId`, `outcome`, `marketKey`, `clobTokenId`, `assetId`

### QuoteRaw / Quote
- QuoteRaw: `marketKey`, `payload`
- Quote: `marketKey`, `bestBid`, `bestAsk`, `bidSize`, `askSize`, `rawId`, `capturedAt`

### PaperIntent
- `tradeId`, `ratio`, `decision`, `decisionReason`, `yourUsdcTarget`, `limitPrice`, `yourSide`

### PaperFill
- `intentId`, `filled`, `fillPrice`, `fillAt`, `matchSamePrice`, `slippageAbs`, `slippagePct`, `quoteId`

### Position
- `marketKey`, `conditionId`, `outcome`, `title`
- `shares`, `avgEntryPrice`, `totalCostBasis`, `isClosed`

### Resolution
- `positionId`, `resolvedOutcome`, `resolvedAt` (+ realized pnl fields in core)

### PnlSnapshot
- `timestamp`, `totalCostBasis`, `unrealizedPnl`, `realizedPnl`, `totalPnl`, `positionCount`

### Settings (global guardrails)
Fields observed in `apps/web/app/settings/page.tsx`:
- `ratioDefault`, `maxUsdcPerTrade`, `maxUsdcPerDay`, `maxPriceMovePct`, `maxSpread`
- SELL modifiers: `sellMaxPriceMovePct`, `sellMaxSpread`, `sellAlwaysAttempt`
- SPLIT/MERGE: `splitMergeAlwaysFollow`

---

## 8) Worker deep-dive (where to look in code)

Worker entry:
- `apps/worker/src/index.ts` — poll loop + health + periodic snapshot/resolution checks.

Ingestion:
- `apps/worker/src/ingester.ts`
  - `ingestAllLeaders()`
  - stores `tradeRaw` then `trade`
  - staggers between leaders to reduce rate limit issues

Polymarket API client:
- `apps/worker/src/polymarket.ts`  
  Uses Data API: `https://data-api.polymarket.com/activity`

Mapping:
- `apps/worker/src/mapping.ts`  
  Uses CLOB: `https://clob.polymarket.com/markets/{conditionId}`

Quotes:
- `apps/worker/src/quotes.ts`  
  Captures best bid/ask from the CLOB orderbook.

Paper intents:
- `apps/worker/src/paper.ts`  
  Generates intents for missing trades using `@polymarket-bot/core`.

Paper fill simulation:
- `apps/worker/src/fills.ts`  
  Simulates fills and updates positions.

Health:
- `apps/worker/src/health.ts`

---

## 9) Dashboard deep-dive (pages + APIs)

Routes under `apps/web/app/`:

### Pages
- `/leaders` — leader CRUD + enable/disable
- `/settings` — global guardrails
- `/trades` — trade list + latency indicator
- `/paper` — paper intents/fills and reset controls
- `/metrics` — aggregated stats (slippage, skipped/copy totals, per-leader stats)
- `/pnl` — positions + summary + charts
- `/debug` — raw payloads, mappings, quotes

### API routes (server)
- `/api/pnl` — mark-to-market P&L (fetches current prices from CLOB)
- `/api/pnl/chart` — snapshot series
- `/api/pnl/snapshot` — records a snapshot
- `/api/reset` — destructive reset (see `problems.md`)

---

## 10) Running locally (known-good workflow)

### Prereqs
- Node 20+
- pnpm
- Docker

### 1) Start Postgres
```bash
docker compose up -d
```

### 2) Install deps
```bash
pnpm install
```

### 3) Set env
```bash
export DATABASE_URL="postgresql://polymarket:polymarket@localhost:5432/polymarket"
```

### 4) Migrate + generate Prisma
```bash
pnpm db:generate
pnpm db:migrate
```

### 5) Run worker + dashboard (two terminals)
Worker:
```bash
pnpm dev:worker
```

Web:
```bash
pnpm dev:web
```

### 6) Open
- Dashboard: `http://localhost:3000`
- Prisma Studio:
  ```bash
  pnpm db:studio
  ```
  Open `http://localhost:5555`

---

## 11) Deployment on a VM (24/7)

Two reasonable styles:

### Option A — systemd + Node apps
- Postgres via Docker
- Web + Worker as systemd services

**Worker service (example)**: `/etc/systemd/system/polymarket-worker.service`
```ini
[Unit]
Description=Polymarket Worker
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/polymarket-copybot
Environment=NODE_ENV=production
Environment=DATABASE_URL=postgresql://polymarket:polymarket@localhost:5432/polymarket
ExecStart=/usr/bin/env pnpm --filter @polymarket-bot/worker start
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

**Web service (example)**: `/etc/systemd/system/polymarket-web.service`
```ini
[Unit]
Description=Polymarket Web Dashboard
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/polymarket-copybot
Environment=NODE_ENV=production
Environment=DATABASE_URL=postgresql://polymarket:polymarket@localhost:5432/polymarket
ExecStart=/usr/bin/env pnpm --filter @polymarket-bot/web start
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

Enable + start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now polymarket-worker polymarket-web
sudo systemctl status polymarket-worker polymarket-web
```

Logs:
```bash
sudo journalctl -u polymarket-worker -f
sudo journalctl -u polymarket-web -f
```

---

## 12) Operations: monitoring, recovery, staying running

Confirm services:
```bash
sudo systemctl status polymarket-worker polymarket-web
```

Watch logs:
```bash
sudo journalctl -u polymarket-worker -n 200 --no-pager
```

Update deployment after code changes:
```bash
git pull
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm -r build
sudo systemctl restart polymarket-worker polymarket-web
```

---

## 13) Latency: what you measure today and how to reduce it

Dashboard latency uses:
- `latency = detectedAt - tradeTs`

This includes:
1) Data API “appearance delay”
2) your polling interval/stagger
3) network + DB time

Fast wins:
- lower `POLL_INTERVAL_MS` (careful with rate limits)
- lower `LEADER_STAGGER_MS` if you follow few wallets
- deploy closer to Polymarket endpoints (RTT matters)

Structural win:
- use **websocket triggers** (CLOB streams) and keep polling as a safety net.

---

## 14) Roadmap: next level agent

- Low-latency triggers (websocket / on-chain) + backstop polling
- Strong idempotency and reprocessing from raw tables
- Better paper realism (partial fills, wider quote windows)
- Optional live executor swap (only if you decide)

See also: `polymarket-next-level.md`

---

## 15) Known issues / technical debt

Read `problems.md` for prioritized fixes (auth, reset endpoint safety, snapshot spam risks, etc).

---

## 16) Open items (to make this doc 100% precise)

If you share these, I can tighten this doc into a “no ambiguity” engineering spec:
1) One real row from `trade_raw` and `trades` (or Prisma Studio screenshots)
2) Your exact worker config (poll interval, leader count, whether websocket is used)

---

## Appendix — Package versions (from repo)
- Worker: `@polymarket-bot/worker` v0.1.0
- Web: `@polymarket-bot/web` v0.1.0
- Core: `@polymarket-bot/core` v0.1.0
- DB: `@polymarket-bot/db` v0.1.0

## Appendix — Do not commit secrets
Never commit or upload:
- bot tokens
- private keys / mnemonics
- API keys
- passwords

Keep secrets in `.env` on the server and add `.env*` to `.gitignore`.
