# correct_polygon_plan.md

## What’s causing the 429s (in your current code)

File: `apps/worker/src/polygon/orderFilledWatcher.ts`

1) **Every startup triggers a heavy HTTP `getLogs` storm**
- `start()` schedules `runBackgroundBackfill()` after 5 seconds.
- `runBackgroundBackfill()` loops **2 exchanges × every enabled leader** and calls `gapFillForLeader(exchange, leader)`.
- `gapFillForLeader()` backfills from `latestBlock - 500` when there’s no cursor, chunks by `MAX_BLOCK_RANGE = 10`, and does **two `getLogs()` calls per chunk** (maker + taker).
- With multiple leaders, this explodes into hundreds/thousands of `eth_getLogs` calls quickly. `eth_getLogs` is expensive; providers throttle it hard → **429**.

2) **On 429 you don’t back off**
- In `gapFillForLeader()`, errors are logged and you “continue”, then you sleep a fixed `THROTTLE_MS = 500`.
- If you’re already throttled, this keeps you in a permanent 429 spiral (and it never recovers).

3) **Extra load from per-log `getBlock()`**
- `processLog()` calls `httpProvider.getBlock(log.blockNumber)` for every fill.
- Bursts with multiple fills in the same block cause redundant calls (not the main 429 driver, but it adds pressure).

4) **If you run multiple worker processes, you multiply everything**
- Two workers + same Alchemy key = double the backfill + double the WS connections/subscriptions.

---

## The target behavior

- **WS handles real-time logs** (low latency).
- A **lightweight reconciliation backfill** runs:
  - at startup (small window), and/or
  - periodically (small window),
  - and only uses **a small, rate-limited number of `getLogs` calls**.
- Backfill is **not multiplied by number of leaders**.
- 429 triggers **exponential backoff + jitter** and pauses the backfill/retry safely.

---

## One-go fix (recommended): redesign backfill so it’s not per-leader

### A. Replace “per-leader backfill” with “per-exchange backfill”
Instead of `gapFillForLeader(exchange, leader)`:

1) Maintain a cursor **per exchange** (not per leader):
- Option 1 (minimal DB change): reuse `PolygonCursor` with a sentinel leader, e.g. `leaderAddress = '0x0000000000000000000000000000000000000000'` and `role = unknown`.
- Option 2 (cleaner): create a new Prisma model, e.g. `PolygonExchangeCursor { exchangeAddress, lastProcessedBlock }`.

2) On startup, backfill:
- `fromBlock = max(0, cursor - SAFETY_OVERLAP_BLOCKS)`
- `toBlock = latestBlock - CONFIRMATION_BLOCKS` (optional, helps with reorg safety)

3) For each block chunk, do at most **2 `getLogs` calls total**:
- **Maker query**: topic0 = `ORDER_FILLED_TOPIC`, topic2 = **OR list of leader topics**
- **Taker query**: topic0 = `ORDER_FILLED_TOPIC`, topic3 = **OR list of leader topics**

Ethereum log filters support OR by passing an array at a topic position (ethers supports `string[]` in `topics`).
If your leader list is large, batch leaders into groups (e.g., 25–100 addresses per query) to stay within provider limits.

### B. Make startup backfill small and configurable
Add config/env flags (defaults that won’t nuke your RPC quota):

- `POLYGON_BACKFILL_ON_STARTUP=false` (default)
- `POLYGON_BACKFILL_STARTUP_BLOCKS=50` (or 100)
- `POLYGON_BACKFILL_SAFETY_OVERLAP=20`
- `POLYGON_BACKFILL_MAX_RANGE=500` (hard cap to prevent surprises)

If you keep it enabled, it should do “last N blocks” — not “last 500 by default for every leader”.

### C. Add 429-aware backoff and a global rate limiter
Do this in one centralized place so **all** Polygon RPC calls are governed.

- Introduce a small request wrapper like:
  - max concurrency (e.g., 3–10)
  - max RPS (e.g., 1–5, depending on plan)
  - exponential backoff on 429 / “rate limit” errors with jitter
- You already have `apps/worker/src/retry.ts` — reuse it, but upgrade it to:
  - detect 429 from HTTP and JSON-RPC payloads,
  - increase delays on consecutive 429s,
  - optionally respect `Retry-After` if present.

### D. Cache `getBlock()` lookups by block number
In `processLog()`:
- Keep a simple in-memory `Map<number, { ts: Date, expiresAt: number }>` cache.
- When multiple logs are in the same block, you’ll do **1** `getBlock()` instead of N.

---

## Incremental, ordered steps (safe rollout)

### Step 1 — Stop the bleeding (same day)
1) **Gate startup backfill**
- In `start()`, only schedule `runBackgroundBackfill()` if `config.polygonBackfillOnStartup === true`.

2) **Reduce initial backfill window**
- Change `latestBlock - 500` to `latestBlock - STARTUP_BACKFILL_BLOCKS` where the default is 50–100.

3) **Fix the throttle math**
- Your current loop does **two** `getLogs` per chunk.
- If you want ~2 RPC calls/sec total, `THROTTLE_MS` needs to be ~1000ms **per call**, not per chunk.
- Easiest: set `THROTTLE_MS = 2000–5000` until the redesign is in.

4) **Add exponential backoff on 429**
- If a chunk hits 429, do not “continue in 500ms”.
- Back off (e.g., 1s → 2s → 4s → 8s with jitter), then retry the same chunk.

✅ Acceptance: Polygon mode can run for 1–2 hours without sustained 429 spam.

---

### Step 2 — Remove the root cause (backfill not multiplied by leaders)
1) Create a new function:
- `gapFillForExchange(exchange: string): Promise<number>`

2) Inside it:
- Read the **exchange-level cursor**
- Compute `fromBlock/toBlock`
- Chunk blocks (range size can be larger than 10 if your provider allows it; keep it conservative initially)
- Run **maker OR query** and **taker OR query** per chunk (batch leaders if needed)
- Dedupe logs by `(txHash, logIndex)` before `processLog()`.

3) Replace `runBackgroundBackfill()` loop:
- from: `for exchange -> for leader -> gapFillForLeader`
- to: `for exchange -> gapFillForExchange`

✅ Acceptance: Backfill traffic becomes ~O(exchanges × chunks) instead of O(exchanges × leaders × chunks).

---

### Step 3 — Make it robust in production
1) **Single-flight guard**
- Ensure only one Polygon watcher runs at a time (DB advisory lock, Redis lock, or a “lease” row).
- Prevent accidental double workers from doubling WS + backfill load.

2) **Health check that reflects reality**
- `isHealthy()` should require:
  - WS connected, and
  - receiving logs recently (or at least not failing to connect).

3) **Periodic mini-reconciliation**
- Every X minutes: backfill last 20–100 blocks (rate-limited).
- This catches missed WS events without massive load.

✅ Acceptance: When you kill the worker for 2 minutes and restart, it catches up without 429 storms.

---

## Notes on “both modes” (API + Polygon comparator)

If you run API mode and Polygon mode concurrently:
- Avoid duplicate heavyweight calls during comparison.
- The comparator should consume **already-produced events** from each source, not trigger extra RPC polling on top.

---

## Minimal code touchpoints (where you’ll edit)

- `apps/worker/src/polygon/orderFilledWatcher.ts`
  - gate/disable startup backfill
  - replace per-leader gapfill with per-exchange gapfill using OR topics
  - add 429 backoff + better throttling
  - add block timestamp cache

- `packages/db/prisma/schema.prisma`
  - optional: add `PolygonExchangeCursor` model (cleanest)
  - or adopt a sentinel leader address for a “global per-exchange cursor”

- `apps/worker/src/retry.ts`
  - extend to handle 429 properly for Polygon calls (if you centralize retry there)

---

## Definition of done

- No sustained 429 spam under normal load.
- Restarting the worker does **not** produce a spike proportional to number of leaders.
- Missed WS events during downtime are recovered by backfill (small window).
- Measured latency in “polygon mode” is stable and not distorted by rate limiting.
