# stepbystep.md — Implementation Guide (Next.js + TypeScript Polymarket Paper Copy-Trader)

This guide turns `polymarketplan.md` into a **no-ambiguity implementation sequence**.  
Follow the steps in order. Each step has an explicit **deliverable** and a **verification check**.

When you complete all steps, the system will fully match the original spec:
- Watch leader wallets
- Store trades + raw payloads
- Capture best bid/ask snapshots
- Generate paper-copy intents with guardrails
- Simulate fills + slippage
- Provide a Next.js dashboard for leaders/trades/paper/metrics/debug
- Keep paper and (future) live logic aligned via a shared strategy engine

---

## 0) Prereqs (do this once)

### Local tools
- Node.js 20+ (recommended)
- pnpm (recommended) or npm
- Docker (recommended for local Postgres)

### Decide deployment approach (for later)
- For iteration: local dev + Docker Postgres
- For production: VM + systemd or Docker Compose

---

## 1) Create repo structure (monorepo)

### Goal
A single TypeScript codebase with:
- Next.js app
- Worker process
- Shared core logic
- Prisma schema

### Commands
From an empty folder:

```bash
mkdir polymarket-bot && cd polymarket-bot
pnpm init
```

Create folders:

```bash
mkdir -p apps/web apps/worker packages/core packages/db docs
```

### Deliverable
Repo tree exists:

```
apps/
  web/
  worker/
packages/
  core/
  db/
docs/
```

### Verify
`ls -R` shows the structure above.

---

## 2) Add Postgres (local dev)

### Goal
A Postgres DB you can reset easily.

### Recommended: Docker Compose
Create `docker-compose.yml` in repo root:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: polymarket
      POSTGRES_PASSWORD: polymarket
      POSTGRES_DB: polymarket
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

Start it:

```bash
docker compose up -d
```

### Deliverable
Postgres running on localhost:5432.

### Verify
```bash
docker ps | grep postgres
```

---

## 3) Set up Prisma (DB schema + migrations)

### Goal
Prisma manages schema and migrations. Both web and worker use the same DB models.

### Commands
In `packages/db`:

```bash
cd packages/db
pnpm add prisma @prisma/client
pnpm prisma init
```

Set `DATABASE_URL` in `packages/db/.env`:

```env
DATABASE_URL="postgresql://polymarket:polymarket@localhost:5432/polymarket"
```

### Create Prisma schema
Edit `packages/db/prisma/schema.prisma` and define the tables from the plan:

- leaders
- trade_raw
- quote_raw
- trades (unique dedupeKey)
- market_mapping
- quotes
- paper_intents
- paper_fills

**Rule:** include a unique index on `trades.dedupeKey`.

### Migrate
```bash
pnpm prisma migrate dev --name init
pnpm prisma generate
```

### Deliverable
- `packages/db/prisma/schema.prisma` defines all tables
- a migration exists
- Prisma client generated

### Verify
```bash
pnpm prisma studio
```
You can see the tables.

---

## 4) Create shared TypeScript packages

### Goal
One shared place for types + strategy engine logic used by worker and (later) live execution.

### 4.1 packages/core
```bash
cd ../../packages/core
pnpm init
pnpm add zod
```

Create:
- `packages/core/src/types.ts` — normalized types (Leader, Trade, Quote, PaperIntent)
- `packages/core/src/reasons.ts` — constants/enums for decisions (SKIP_*)
- `packages/core/src/strategy.ts` — **single source of truth** decision function

Export everything from `packages/core/src/index.ts`.

### 4.2 packages/db
Add a small helper to instantiate Prisma client.
Create `packages/db/src/client.ts` that exports `prisma`.

### Deliverable
- `packages/core` exposes strategy + types
- `packages/db` exposes Prisma client

### Verify
From repo root, add a quick TS script (or use worker later) that imports these without errors.

---

## 5) Set up Next.js app (dashboard shell)

### Goal
A working Next.js dashboard connected to Postgres.

### Commands
```bash
cd ../../apps/web
pnpm dlx create-next-app@latest . --ts --app --eslint
pnpm add @prisma/client
```

Configure `DATABASE_URL` for web:
- create `apps/web/.env.local`:

```env
DATABASE_URL="postgresql://polymarket:polymarket@localhost:5432/polymarket"
```

Add Prisma client usage in the app by importing from `packages/db` (recommended), or configure local Prisma client in web (less ideal). Prefer importing from `packages/db`.

### Deliverable
Next.js runs.

### Verify
```bash
pnpm dev
```
Open the app in browser.

---

## 6) Build Leaders CRUD UI (dashboard page 1)

### Goal
Manage which wallets are watched:
- add leader (label + wallet)
- enable/disable leader

### Steps
1) Create page `/leaders`
2) Implement:
   - List leaders
   - Add form
   - Toggle enabled
3) Normalize wallet on write:
   - lowercase
   - trimmed
   - basic validation: starts with `0x` and length 42

### Deliverable
You can add a leader and see it in the list.

### Verify
Add a leader from the UI and confirm it appears in DB via Prisma Studio.

---

## 7) Build Worker (trade ingestion)

### Goal
A separate Node process that:
- reads enabled leaders from DB
- polls Polymarket trades
- stores both raw payload and normalized trade row
- is idempotent (no duplicates)

### Setup
In `apps/worker`:

```bash
cd ../../apps/worker
pnpm init
pnpm add axios pino
pnpm add -D tsx typescript @types/node
```

Create worker entry:
- `apps/worker/src/index.ts`

Create env:
- `apps/worker/.env`

```env
DATABASE_URL="postgresql://polymarket:polymarket@localhost:5432/polymarket"
POLL_INTERVAL_MS=5000
LEADER_FETCH_LIMIT=50
```

### Ingestion algorithm (must follow exactly)
For each enabled leader:
1) Call Polymarket Data API activity endpoint filtered to `TRADE`
2) For each returned item:
   - compute `dedupeKey = leaderWallet|txHash|side|conditionId|outcome|size|price`
   - insert into `trade_raw` (payload json)
   - insert into `trades` with FK to raw id
   - if unique constraint fails on `dedupeKey`, ignore

### Deliverable
Trades appear in DB.

### Verify
1) Start worker:
```bash
pnpm tsx src/index.ts
```
2) In Prisma Studio, see rows in `trade_raw` and `trades`.

---

## 8) Dashboard: Trades timeline (page 2)

### Goal
A `/trades` page that shows normalized trades.

### Requirements
- Filter by leader
- Show timestamp, side, market title/outcome, price, usdc/size, txHash
- Show detectedAt vs tradeTs (latency visibility)

### Deliverable
You can see trades and filter.

### Verify
Trades shown in UI match rows in DB.

---

## 9) Market mapping (conditionId/outcome → tradable instrument)

### Goal
You can reliably fetch quotes and later place orders.
If mapping is missing, paper mode must SKIP.

### Steps
1) Create DB table `market_mapping` (already in schema)
2) Implement a module in worker:
   - `resolveMapping(conditionId, outcome)`:
     - check DB
     - if missing, attempt to fetch metadata from Polymarket endpoints (your chosen source)
     - store mapping
     - return mapping
3) If metadata fetch fails:
   - do not trade
   - mark decision reason `SKIP_MISSING_MAPPING`

### Deliverable
Mappings get created automatically for markets you observe.

### Verify
For a known trade, mapping exists in DB.

---

## 10) Quote snapshotter (best bid/ask)

### Goal
Capture top-of-book bid/ask at the time you would act.

### Steps
1) For each newly ingested trade (or for trades lacking quotes):
   - resolve mapping → instrument id
   - call CLOB market data to get best bid/ask
   - store `quote_raw` and normalized `quotes`
2) Link quotes to the trade via `marketKey` and timestamp proximity.

### Deliverable
Quotes exist for trades.

### Verify
In DB:
- `quotes.bestBid` and `quotes.bestAsk` populated
- `quote_raw.payload` stored

---

## 11) Strategy engine (paper intent generation)

### Goal
Generate a paper intent per trade using shared code in `packages/core`.

### Implement in `packages/core/src/strategy.ts`
Function signature:

```ts
decidePaperIntent(input: {
  trade: NormalizedTrade,
  quote: Quote,
  config: GuardrailConfig,
  riskState: RiskState
}): PaperIntentDecision
```

### Must implement
- Ratio scaling: `yourUsdcTarget = leaderUsdc * ratio`
- Guardrails:
  - max per trade
  - max per day
  - max spread
  - max price move
  - allowlist (optional)
- Same-price rule:
  - BUY: match if `bestAsk <= leaderPrice`
  - SELL: match if `bestBid >= leaderPrice`

Output:
- `decision: TRADE|SKIP`
- `decisionReason`
- `limitPrice` (usually leaderPrice)
- `yourUsdcTarget`

### Deliverable
Worker can write `paper_intents` for each trade.

### Verify
`paper_intents` rows appear, with reasons when skipped.

---

## 12) Paper fill simulator

### Goal
Simulate fills and slippage at decision time.

### Minimal simulation (must be explicit)
- If decision is SKIP: no fill row needed (or fill row with filled=false)
- If decision is TRADE:
  - If same-price match is true:
    - filled=true
    - fillPrice = leaderPrice (or bestAsk/bestBid if you choose that model — pick one and keep it consistent)
    - matchSamePrice=true
    - slippageAbs/slippagePct computed
  - Else:
    - filled=false
    - matchSamePrice=false
    - neededPrice = bestAsk (BUY) or bestBid (SELL) stored in intent or fill metadata (recommended)

### Deliverable
`paper_fills` rows exist for intents.

### Verify
For a sample trade:
- paper intent decision matches rule
- fill flags and slippage computed correctly from quotes

---

## 13) Dashboard: Paper results (page 3) + Metrics (page 4)

### 13.1 /paper
Show:
- leader trade
- your intended notional
- decision + reason
- filled + fill price
- matchSamePrice
- slippage

Filters:
- leader
- date range
- decision (trade/skip)
- filled (true/false)

### 13.2 /metrics
Compute and show:
- match rate = matchSamePrice true / total TRADE decisions
- fill rate = filled true / total TRADE decisions
- avg slippage when not matched (or when filled with slippage)
- worst slippage
- copied vs skipped counts
- breakdown by leader and by market

### Deliverable
You can understand performance at a glance.

### Verify
Metrics values match raw DB queries.

---

## 14) Dashboard: Debug page (page 5)

### Goal
No black boxes. You can inspect raw payloads.

Create `/debug`:
- pick a trade → show `trade_raw.payload`
- show associated quote raw
- show intent + fill records

### Deliverable
Full audit trail per event.

### Verify
Raw payload matches what you ingested.

---

## 15) Hardening (required before long runs)

### Worker reliability
- exponential backoff on API errors
- per-leader staggering (avoid bursts)
- DB reconnect handling
- health output:
  - last poll time
  - last trade ingested time per leader

### Data correctness
- enforce unique constraint on trades.dedupeKey
- store raw payloads for all trades and quotes
- never rely on in-memory “last seen” only

### Deliverable
System runs for days without duplicates or crashes.

### Verify
Stop worker, restart it, confirm no duplicate trades get inserted.

---

## 16) Production deployment (paper mode)

### Recommended for first production: VM + systemd
Run two services:
1) `web` (Next.js)
2) `worker` (poller + paper sim)

**Rule:** do not run worker inside web server.

### Deliverable
- Dashboard accessible
- Worker running continuously

### Verify
Reboot VM, both services come back and continue.

---

## 17) Acceptance criteria (final checklist)

You are “done” when all are true:

### Data ingestion
- [ ] Leaders can be added/disabled in dashboard
- [ ] Worker ingests trades for enabled leaders
- [ ] `trade_raw` and `trades` both populated
- [ ] No duplicates after restart (unique dedupeKey works)

### Quotes + mapping
- [ ] Market mapping exists for trades
- [ ] Quotes (best bid/ask) are captured and stored with raw payloads

### Paper mode
- [ ] Paper intents generated for each trade with clear decisions/reasons
- [ ] Paper fills computed consistently and stored
- [ ] Slippage + matchSamePrice is correctly computed from quotes

### Dashboard
- [ ] /leaders works (CRUD + enabled toggle)
- [ ] /trades shows trades with filters
- [ ] /paper shows intents/fills with filters
- [ ] /metrics shows match rate, fill rate, slippage stats, breakdowns
- [ ] /debug shows raw payloads end-to-end

### Alignment guarantee
- [ ] Strategy logic lives only in `packages/core`
- [ ] Worker imports and uses it (no duplicated rule logic in worker or web)

---

## 18) What NOT to do (common mistakes)

- Don’t put polling logic in Next.js API routes.
- Don’t use “mid price” as a substitute for best bid/ask.
- Don’t store only derived data (store raw payloads too).
- Don’t let paper and live use different decision logic.
- Don’t assume `$USER` expands inside systemd env files.

---

## 19) Future: Live execution (only after paper success)

Not part of this step-by-step build.  
When you add it later:
- add `LIVE_TRADING_ENABLED=false` default
- require explicit enable
- use separate wallet + strict caps + kill switch
- reuse the exact strategy engine

