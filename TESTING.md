# Polymarket Copy-Trader Testing Plan

This document outlines how to verify the fullproof refactor is working correctly.

## Prerequisites

- Docker running for PostgreSQL
- Alchemy API key configured
- At least one leader wallet configured and enabled

---

## Test 1: Local Boot (Flat Start)

**Goal**: Verify clean startup with no phantom positions

### Steps
```bash
# 1. Start database
docker compose up -d db

# 2. Run migrations
pnpm db:generate
pnpm db:migrate

# 3. Start worker
pnpm -C apps/worker dev

# 4. Start web dashboard
pnpm -C apps/web dev
```

### Expected Logs
- `startupMode=flat`
- `cursor initialized for leader X`
- **NO** historical trades ingested
- Polygon watcher started (if mode is `both` or `polygon`)

### Expected Dashboard
- **0** total trades
- **0** paper intents
- **0** open positions on P&L page

---

## Test 2: Realtime Polygon Trigger

**Goal**: Verify Polygon events create trades and intents quickly

### Prerequisites
- Mode set to `polygon` or `both`
- Active leader who trades frequently

### Steps
1. Watch worker logs for `Polygon detected leader fill`
2. Wait for a real leader trade

### Expected Behavior
- `Trade` row created with `txHash` and `blockNumber`
- `PaperIntent` created (if guardrails allow)
- `PaperFill` created with `fillShares`
- `LeaderPosition` updated
- `PaperPosition` updated (if filled)

### Expected Latency
- Polygon detection → Paper intent: **< 5 seconds**

---

## Test 3: API Lag Fallback

**Goal**: Verify Polygon proceeds even if API is slow

### Option A: Simulated (Recommended)
Add to worker env:
```env
SIMULATE_API_LAG=true
```

Then:
1. Watch for Polygon event
2. Confirm trade executes via Polygon path
3. Later API marks `apiSeenAt` without duplicating

### Option B: Natural
1. Temporarily disable Polygon watcher
2. Wait for API to detect trade
3. Re-enable Polygon
4. Confirm no duplicate trades

### Expected Behavior
- Trade executes from Polygon path first
- `LatencyEvent` records show both sources
- No duplicate trades or intents

---

## Test 4: Catch-Up Behavior

**Goal**: Verify missed trades are handled correctly on restart

### Steps
1. Run worker in `polygon` mode
2. Stop worker for 2-5 minutes
3. Restart worker

### Expected Behavior
- API cursor fetches missed trades
- BUY catch-up respects:
  - `catchUpBuyMaxAgeSec` (skips if too old)
  - `catchUpBuyRequireBetterPrice` (skips if price worse)
- SELL catch-up sells proportionally via `calculateProportionalSellSize()`
- **NO** phantom trades from historical data

### Validation
```sql
-- Check trades are marked as backfill
SELECT id, side, isBackfill FROM trades ORDER BY tradeTs DESC LIMIT 10;

-- Backfill trades should have isBackfill = true
```

---

## Test 5: Proportional Sell

**Goal**: Verify proportional sell sizing works correctly

### Test Data Setup
```sql
-- Insert leader position
INSERT INTO leader_positions (id, "leaderId", "conditionId", outcome, shares)
VALUES ('test-lp', 'leader-id', 'condition-123', 'YES', 100);

-- Insert our position
INSERT INTO paper_positions (id, "conditionId", outcome, shares, "costBasisUsdc")
VALUES ('test-pp', 'condition-123', 'YES', 30, 15);
```

### Simulate Leader Sell
Leader sells 50 shares (50% of their position)

### Expected Calculation
```
leaderPreSellShares = 100
leaderSellSize = 50
r = 50 / 100 = 0.5
ourShares = 30
ourSell = 30 * 0.5 = 15
```

### Expected Result
- Our position becomes 15 shares
- Cost basis reduced proportionally

---

## Test 6: Free-Tier Safety

**Goal**: Verify no Alchemy rate limit issues

### Steps
1. Run worker in `BOTH` mode
2. Track 3+ leader wallets
3. Run for 30 minutes

### Monitor
```bash
# Watch for 429 errors
grep -i "429\|rate limit" apps/worker/logs/*.log
```

### Expected Behavior
- **NO** `eth_getLogs` block scans
- **NO** sustained 429 errors
- WebSocket event volume is low (wallet-filtered)
- Reconnection works if WS disconnects

---

## Done Criteria

You're finished when:

- [x] Flat start produces **no positions**
- [x] Polygon mode creates trades and paper intents **fast**
- [x] Both mode **dedupes correctly** (no duplicate trades)
- [x] Catch-up implements **BUY/SELL policies**
- [x] **No batch backfills** use Polygon getLogs
- [x] Dashboard settings **fully control behavior**
- [x] Proportional sells work correctly
- [x] Free-tier usage stays within limits

---

## Troubleshooting

### No Polygon Events
- Check `POLYGON_WS_URL` is correct
- Verify leader wallets are enabled
- Check logs for WebSocket connection errors

### Duplicate Trades
- Check `dedupeKey` is consistent (`txHash.toLowerCase()`)
- Verify `LatencyEvent` table for both sources

### Rate Limit Errors (429)
- Ensure no `getLogs` calls in code
- Check reconnection backoff is working
- Consider reducing number of tracked leaders

### Phantom Positions
- Verify `isBackfill: true` for historical trades
- Check `generateMissingPaperIntents()` filters backfill
- Run reset API to clear and restart fresh
