## Polymarket Copybot – Problem List and Fix Plans

Each section describes the issue, why it matters, and a concrete fix plan so an engineer can address it directly.

---

### 1) Reset endpoint crashes and allows anyone to wipe data
**Where**: `apps/web/app/api/reset/route.ts`  
**Problem**:
- Calls `prisma.rawPayload.deleteMany()` – that model does not exist, so the route throws and the “Reset All Data” UI never works.
- Deletes quotes/mappings/positions/trades but not `tradeRaw`/`quoteRaw`, leaving orphaned rows.
- Endpoint is publicly callable (no auth), so any visitor could wipe data if it worked.
**Fix plan**:
1) Replace the delete order with the real tables, respecting FK dependencies: `paperFill` → `paperIntent` → `resolution` → `pnlSnapshot` → `position` → `quote` → `quoteRaw` → `marketMapping` → `trade` → `tradeRaw`. Use a transaction and return success/failure.
2) Add authentication/authorization middleware (Next.js middleware or protected route handler) and CSRF protection; restrict to admin roles.
3) Consider feature-flagging the reset route in production or removing it; keep a CLI/ops-only script for destructive resets.

---

### 2) No authentication/authorization or CSRF protection across dashboard and APIs
**Where**: All Next.js pages, server actions on `/leaders` and `/settings`, route handlers under `/api`.  
**Problem**:
- Anyone can add/delete leaders, change global guardrails, trigger resets, and write P&L snapshots. Server actions accept unauthenticated POSTs and are CSRF-vulnerable.
**Fix plan**:
1) Introduce an auth layer (e.g., NextAuth with credential/provider) and wrap all server actions/route handlers with an authorization check.
2) Add CSRF protection (Next.js middleware + anti-CSRF token or same-site strict cookies). Reject non-POST/unsafe requests without a valid token.
3) Hide “Reset” and other destructive controls behind admin-only checks; return 401/403 for unauthorized calls.

---

### 3) Client-driven P&L snapshot spam
**Where**: `apps/web/app/pnl/page.tsx` triggers `POST /api/pnl/snapshot` every 30s.  
**Problem**:
- Any user loading the page causes continuous DB writes and external price fetches; easy to DoS or inflate metrics.
**Fix plan**:
1) Move snapshot scheduling to the worker (it already runs hourly); remove the client interval and the `/api/pnl/snapshot` route or make it admin-only/manual.
2) If manual snapshots are needed, debounce + auth-protect the endpoint and rate limit by IP/user.

---

### 4) Daily risk limits are in-memory, global, and reset on restart
**Where**: `apps/worker/src/paper.ts` (`currentRiskState`).  
**Problem**:
- Risk tracking is a process-local variable, shared across leaders, and resets on restart. Per-leader/day caps are not enforced and can be bypassed after restarts or with multiple leaders.
**Fix plan**:
1) Persist per-leader daily spend in the DB: add a `leaderDailySpend` table keyed by leaderId + date or reuse `paperIntent` aggregates.
2) In `decidePaperIntentAsync`, query current day spend per leader; update after recording a TRADE intent in the same transaction (or use a counter table).
3) Reset counts by date boundary in the DB (or via a worker job), not in-memory.

---

### 5) Stored intent ratio diverges from the configured ratio
**Where**: `apps/worker/src/paper.ts` uses `COPY_RATIO` env for `paperIntent.ratio`; decision uses DB settings/leader overrides.  
**Problem**:
- The ratio persisted with the intent may not match the ratio used to decide, making audits and metrics misleading.
**Fix plan**:
1) After `decidePaperIntentAsync`, persist the actual ratio from `getEffectiveConfig` (e.g., `config.ratioDefault` or leader override) instead of `getLegacyRatio()`.
2) Remove or deprecate `COPY_RATIO` env once DB-driven settings are canonical.

---

### 6) Trade ingestion can drop bursts of trades
**Where**: `apps/worker/src/ingester.ts`, `fetchWalletActivity` in `apps/worker/src/polymarket.ts`.  
**Problem**:
- Only fetches the latest `limit` (default 50) trades per poll. If a leader trades > limit between polls, older trades fall out of the window and are lost permanently.
**Fix plan**:
1) Track a per-leader cursor (last seen `timestamp`/`transactionHash`) and paginate backward until older-than-last-seen; insert until hitting already-known dedupe keys.
2) Increase `limit` defensively but rely on cursor/backfill to guarantee coverage.
3) Add metrics/alerts for gaps (e.g., detect timestamp discontinuities).

---

### 7) P&L accuracy gaps: sells, splits/merges, and fill simulation
**Where**: `apps/worker/src/fills.ts`, `packages/core/src/positions.ts`.  
**Problems**:
- SELL intents compute shares from USDC even if no position exists; `updatePosition` caps sells to existing shares and silently ignores excess volume → understated exits and P&L.
- SPLIT/MERGE logic is stubbed; positions/cost basis aren’t updated realistically.
- Fill simulation uses nearest/latest quote and a same-price check, not time-aligned to trade timestamp or depth → may mark fills as matched when market moved, skewing metrics and positions.
**Fix plan**:
1) Before processing SELL, verify holdings; if insufficient, record a skip/partial with an explicit reason, not a silent cap. Alternatively, cap and record the partial exit delta separately.
2) Implement SPLIT/MERGE inventory math: adjust YES/NO legs and cost basis per Polymarket mechanics; write tests to validate.
3) Use quotes captured closest before/after the trade timestamp (bounded window) and require price overlap; otherwise mark as not filled. Optionally ingest book depth or multiple snapshots to improve fidelity.

---

### 8) Worker churn from “missing” generators
**Where**: `apps/worker/src/index.ts` calls `generateMissingPaperIntents` and `simulateMissingFills` every poll.  
**Problem**:
- Each poll scans batches of rows and retries already-failed cases; as data grows this becomes a constant hot loop, wasting DB/CPU and slowing ingestion.
**Fix plan**:
1) Gate the jobs: run on a slower interval (e.g., every N minutes) or only when there was an ingestion error/mapping miss.
2) Add status markers for hard failures to avoid reprocessing in tight loops.
3) Paginate with stable cursors and cap runtime per cycle.

---

### 9) P&L API performance and rate-limit risk
**Where**: `apps/web/app/api/pnl/route.ts`.  
**Problem**:
- On each GET, fetches current prices sequentially for every open position; multiple users or many positions can cause slow responses and hit external rate limits.
**Fix plan**:
1) Parallelize price fetches with a small concurrency limit and cache results (e.g., in-memory TTL or Redis) for short intervals.
2) Prefer using worker-generated snapshots for the UI; fall back to live prices only for deltas, and paginate open positions if large.
3) Add error handling/timeout/backoff to avoid blocking the response.

---

### 10) Reset leaves inconsistent state (even when fixed)
**Where**: `apps/web/app/api/reset/route.ts`.  
**Problem**:
- Current logic deletes mappings/quotes/positions/trades but not raw payloads, leaving orphans; no transaction means partial failures can leave mixed states.
**Fix plan**:
1) Wrap all deletes in a single transaction in correct FK order, including `tradeRaw` and `quoteRaw`.
2) Return a summary of rows affected; log errors.
3) Add an ops script (CLI) for resets with confirmation prompts; keep the HTTP route admin-only or disabled in prod.

---

### 11) Fill + position math for SELL exits can undercount P&L
**Where**: `packages/core/src/positions.ts` and `apps/worker/src/fills.ts`.  
**Problem**:
- SELL P&L uses `min(shares, position.shares)`; excess intended sell is dropped without recording realized loss/gain for the requested notional, and positions may remain overstated relative to “copied” volume.
**Fix plan**:
1) Compute intended shares; if greater than holdings, record a partial fill and a skip/shortfall reason. Optionally allow flatting to zero and mark the remainder as “could not exit”.
2) Ensure realized P&L uses the actual sold shares and logs partial exits; surface in metrics/debug views.

---

### 12) Strategy/config drift between recorded intents and guardrails
**Where**: `apps/worker/src/paper.ts`, `packages/core/src/settings.ts`.  
**Problem**:
- Settings are cached for 10s, but there’s no logging of which overrides were applied per intent. Hard to debug why a trade was allowed or skipped, especially with per-operation overrides.
**Fix plan**:
1) Persist the effective config summary with each intent (ratio used, maxUsdcPerTrade, maxUsdcPerDay, effectiveMaxSpread/priceMove, override flags).  
2) Expose these in `/debug` and metrics to audit decisions.

---

### 13) Security of external calls
**Where**: Polymarket CLOB/Data API calls in `apps/worker/src/*` and `/api/pnl`.  
**Problem**:
- No rate limiting or retry backoff on `/api/pnl` routes; worker calls already retry, but HTTP routes could hammer external APIs.
**Fix plan**:
1) Add per-route rate limiting and timeouts; reuse worker-cached data where possible.
2) Centralize external fetch helpers with sane defaults (timeout, retry with backoff, concurrency cap).

---

### 14) Missing ingestion observability
**Where**: `apps/worker/src/ingester.ts`.  
**Problem**:
- No detection of gaps/latency outliers beyond logging; if dedupe keys are malformed or API changes shape, ingestion could silently degrade.
**Fix plan**:
1) Add metrics: trades ingested per leader per poll, max/min trade timestamp lag, gap alerts when `tradeTs` of newest - oldest fetched exceeds window or when dedupe collisions spike.
2) Add schema validation of activity payloads (zod) and alert on parse failures.

