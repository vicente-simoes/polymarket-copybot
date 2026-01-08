# fix_plan.md

## Objective

Refactor the “Polygon mode” so you **stop doing any backfill via Polygon RPC `getLogs`** and instead:

- **All backfill / catch-up operations are Polymarket API only**
- **Real-time detection supports 3 configurations**:
  1) `api` (API-only real-time)
  2) `polygon` (Polygon WS real-time trigger + API ingestion)
  3) `both` (run both and compare latency, without double-ingesting)

Additionally, add an **API lag fallback**:
- When Polygon sees a fill in real time, **wait briefly** for the Polymarket API to reflect it.
- If the API doesn’t show it within a short window, do a **targeted on-chain lookup** for that specific transaction/log only (NOT a block-range backfill), ingest it, and later reconcile when the API catches up.

This plan is written to be fed to an LLM implementing changes in this repo.

---

## Current repo context (important for the implementer)

- The current 429 issue is driven by Polygon backfill logic in:
  - `apps/worker/src/polygon/orderFilledWatcher.ts`
    - `start()` schedules `runBackgroundBackfill()`
    - backfill loops `exchanges × leaders`, chunked block ranges, calling `httpProvider.getLogs()` repeatedly
    - weak throttling/backoff → 429 storms on any provider

- You already have multiple modes:
  - Polymarket API mode (detect new trades via API)
  - Polygon/Alchemy mode (detect new trades via chain logs)
  - Both mode (runs both and compares detection times)

The key change: **Polygon mode must become “WS trigger only”** (no historical scanning), and **API becomes the source of truth for backfill/catch-up**.

---

## Desired architecture

### A) API is source-of-truth ingestion
- Backfill on startup / after downtime = query API using a cursor (tradeId/time) and ingest fills.
- Real-time in API mode = poll/stream API for new fills and ingest them.

### B) Polygon is low-latency “event trigger”
- In polygon mode, use **WS subscription** to OrderFilled (or equivalent) logs.
- When a log is received, do **NOT** scan blocks.
- Instead, use that log as a trigger to **pull from the API** (because API will contain full normalized trade data you already rely on).

### C) API lag fallback
When a Polygon log arrives but the API hasn’t published it yet:
1) Wait briefly and retry API (short bounded window).
2) If still absent, do a **targeted chain fetch** for that specific tx:
   - `eth_getTransactionReceipt(txHash)` and extract the matching log
   - decode event fields
   - ingest a “chain-sourced fill” record (flagged)
3) Later, when API shows it, **reconcile/dedupe** so you don’t double-count.

This fallback prevents missed trades during API delays without reintroducing heavy `getLogs` backfill.

---

## New configuration / env flags (add to `.env.example`)

### Mode selection
- `TRADE_DETECTION_MODE=api|polygon|both`  
  - `api`: only API real-time loop
  - `polygon`: only Polygon WS trigger loop
  - `both`: run both, compare latency, but dedupe ingestion

### API-only backfill
- `API_BACKFILL_ON_STARTUP=true` (recommended)
- `API_BACKFILL_STARTUP_LOOKBACK_MINUTES=1440` (or use cursor; this is a safety fallback)
- `API_BACKFILL_PAGE_SIZE=200` (tune to API limits)
- `API_BACKFILL_RATE_LIMIT_RPS=2` (start conservative)
- `API_BACKFILL_MAX_CONCURRENCY=2`

### Polygon WS trigger
- `POLYGON_WS_ENABLED=true` (implied by mode)
- `POLYGON_WS_RECONNECT=true`
- `POLYGON_WS_HEALTH_MAX_SILENCE_SECONDS=60`

### API lag fallback (when Polygon triggers first)
- `API_LAG_FALLBACK_ENABLED=true`
- `API_LAG_WAIT_MS=500` (initial wait)
- `API_LAG_MAX_WAIT_MS=8000` (total window)
- `CHAIN_FALLBACK_ENABLED=true`
- `CHAIN_FALLBACK_CONFIRMATIONS=0|1` (optional; 0 is fastest)

### Dedupe/reconciliation
- `FILL_DEDUPE_STRATEGY=tradeId|txHash_logIndex|hybrid` (recommend `hybrid`)

---

## Data model / cursor requirements

You need a stable cursor for API backfill to work efficiently.

### Preferred cursor
- **Per tracked wallet (leader) per exchange**:
  - `lastSeenTradeId` (best if API provides monotonic IDs per wallet)
  - or `lastSeenTimestamp`
- Store cursor in DB (Prisma) or existing cursor table.

### Dedupe keys
Prevent double ingestion across:
- API real-time + API backfill
- Polygon-triggered API fetch + API backfill
- Polygon-triggered chain fallback + later API arrival
- both-mode running simultaneously

Use a unique constraint or idempotency check such as:
- Primary: `exchange + tradeId` (if present)
- Secondary: `exchange + txHash + logIndex` (if present)
- If API does not include logIndex, use a strict fingerprint (leader + market + outcome + size + price + timestamp window).

Also store:
- `source`: `api | polygon_ws | chain_fallback`
- `firstSeenAt`, `apiSeenAt`, `chainSeenAt` to measure lag

---

## Implementation steps (ordered)

### Step 1 — Remove Polygon backfill completely (stop 429s)
1) In `apps/worker/src/polygon/orderFilledWatcher.ts`:
   - Delete or fully disable `runBackgroundBackfill()` scheduling from `start()`.
   - Remove/disable any `gapFillForLeader()` / block-range `getLogs()` logic.
   - Ensure polygon watcher never calls `httpProvider.getLogs()` over ranges.
2) Keep WS subscription logic for live logs only.

Acceptance:
- Polygon mode produces **zero** `eth_getLogs` range scans.

---

### Step 2 — Implement API-only backfill module
Create/refactor:
- `apps/worker/src/backfill/apiBackfill.ts`

Responsibilities:
- For each enabled leader wallet:
  - Read cursor from DB
  - Call Polymarket API: “fills since cursor”
  - Paginate
  - Ingest fills idempotently
  - Update cursor

Requirements:
- Rate limit + bounded concurrency
- Retry with backoff on 429/5xx from API
- Logging: pages fetched, fills ingested, cursor updates

Wire it:
- On worker startup, if `API_BACKFILL_ON_STARTUP=true`, run it once.

Acceptance:
- Restarting worker catches up missed fills via API only.

---

### Step 3 — Standardize ingestion: one code path for “process fill”
Create:
- `apps/worker/src/ingest/ingestFill.ts`

Input: a normalized fill object (exchange, leader, tradeId?, txHash?, logIndex?, timestamp, size/price/outcome, source).
Inside:
- enforce dedupe / idempotency
- upsert to DB
- update “seen times” fields

Acceptance:
- All sources call the same ingestion function.

---

### Step 4 — Real-time detection mode: API
Implement a “real-time API loop”:
- Poll (or subscribe if supported) every 1–3s
- For each leader, request “fills since cursor”
- Ingest
- Update cursor

Acceptance:
- `TRADE_DETECTION_MODE=api` works without polygon dependencies.

---

### Step 5 — Real-time detection mode: Polygon (WS trigger → API ingestion)
In polygon mode:

1) Subscribe via WS to OrderFilled logs.
2) On log:
   - capture `txHash`, `logIndex`, `blockNumber`, and any relevant addresses from topics
   - emit an internal event `{ exchange, txHash, logIndex, blockNumber, seenAt }`
3) Immediately attempt to ingest via API:
   - query API for fills since cursor for the implicated leader(s)
   - ingest new fills

Acceptance:
- Polygon mode is low-latency and does not scan historical logs.

---

### Step 6 — Add “API lag fallback” for Polygon-triggered events
When a Polygon log arrives:

A) Try API immediately.
B) If not found, retry within a bounded window:
- total wait <= `API_LAG_MAX_WAIT_MS`
- exponential backoff (cap a few seconds)

C) If still not found and `CHAIN_FALLBACK_ENABLED`:
- `eth_getTransactionReceipt(txHash)`
- find the log by `logIndex`
- decode OrderFilled event fields
- map into normalized fill
- ingest with `source=chain_fallback`

D) Reconcile later:
- when API eventually includes the trade, ingestion must dedupe (hybrid keying) and optionally set `apiSeenAt`.

Notes:
- This is **targeted**: 1 receipt call, not a block scan.
- If API lacks txHash, implement strict matching (leader + time window + market/outcome + size + price).

Acceptance:
- API delays no longer cause missed trades.

---

### Step 7 — Real-time detection mode: Both (API + Polygon)
In `both` mode, run:
- API real-time loop
- Polygon WS trigger loop

Rules:
- both feed into the same ingestion path
- dedupe prevents double-counting
- a comparator module records per-fill:
  - firstSeenByApiAt
  - firstSeenByPolygonAt
  - lag metrics

Acceptance:
- both-mode compares latency without doubling ingestion.

---

### Step 8 — Health checks + single-worker safety
1) Health:
- Polygon watcher healthy only if WS connected and not erroring/reconnecting endlessly.
- API loop healthy only if polls succeed and cursor advances.

2) Single-flight guard (recommended):
- Prevent accidental double workers (DB lease/advisory lock/Redis lock).
- This avoids duplicate WS connections and doubled API load.

3) Observability:
- Count API 429/5xx and backoff time
- Count chain fallback receipt calls
- Track API lag distribution

---

## Edge cases to handle

- **Reorgs**: optionally require 1 confirmation before chain fallback ingestion, or mark chain fallback fills as “unconfirmed” until API confirms.
- **Cursor boundary misses**: if timestamp-based, always include small overlap (e.g., last 30–60 seconds) and rely on dedupe.
- **API pagination correctness**: no skipping; stable sort; deterministic cursors.
- **Secrets hygiene**: rotate any leaked RPC/API keys; don’t ship `.env` in repo zips.

---

## Definition of done

- Startup/backfill is **API-only**.
- `TRADE_DETECTION_MODE=api|polygon|both` works.
- Polygon WS provides low-latency triggers; API provides canonical trade ingestion.
- API lag fallback prevents missed fills without reintroducing `getLogs` scanning.
- Dedupe prevents double counting across all paths.
