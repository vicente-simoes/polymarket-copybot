# Polymarket Copy-Trader Upgrade Spec

This upgrade adds two major features to the existing paper copy-trading system:
1. **Dashboard-controlled guardrails** — Tune settings in real-time without restarts
2. **P&L tracking** — See simulated profit/loss from paper trades

---

## Feature 1: Dashboard-Controlled Guardrails

### Goal
Move configuration from environment variables to database, editable via dashboard.

### Requirements

#### 1.1 Global Settings
A centralized settings page (`/settings`) where you can adjust:

| Setting | Description | Default |
|---------|-------------|---------|
| `ratioDefault` | Copy ratio (leader $100 → you $1 = 0.01) | 0.01 |
| `maxUsdcPerTrade` | Max USDC per single trade | 2 |
| `maxUsdcPerDay` | Max USDC across all trades per day | 10 |
| `maxPriceMovePct` | Skip if price moved more than this % | 0.01 |
| `maxSpread` | Skip if bid-ask spread exceeds this | 0.02 |

**Behavior**: Changes take effect immediately (no restart needed).

#### 1.2 Operation-Specific Settings

Different operations warrant different guardrail strictness. The goal is to **maximize P&L similarity to the leader**.

| Operation | Description | Guardrail Approach |
|-----------|-------------|--------------------|
| `BUY` | Enter a position | **Standard** — Apply all guardrails normally |
| `SELL` | Exit a position | **Lenient** — Prioritize exiting when leader exits |
| `SPLIT` | Convert a position to both outcomes | **Follow always** — Mirror leader exactly |
| `MERGE` | Combine both outcomes to exit | **Follow always** — Mirror leader exactly |

**Rationale**:
- **BUY**: If conditions aren't right (price moved, spread too wide), waiting is acceptable.
- **SELL**: If the leader is exiting, you should too — even if slippage is worse. Missing a SELL can leave you holding a losing position the leader escaped.
- **SPLIT/MERGE**: These are structural operations. You should always mirror them to maintain position parity.

#### 1.3 Per-Operation Guardrail Modifiers

| Setting | Description | Default |
|---------|-------------|---------|
| `sellMaxPriceMovePct` | Override `maxPriceMovePct` for SELL operations | 0.05 (5x more lenient) |
| `sellMaxSpread` | Override `maxSpread` for SELL operations | 0.10 (5x more lenient) |
| `sellAlwaysAttempt` | If true, always attempt SELL (never skip for price/spread) | true |
| `splitMergeAlwaysFollow` | If true, always follow SPLIT/MERGE operations | true |

**Result**: You're more likely to exit when the leader exits, reducing "stuck positions".

#### 1.4 Per-Leader Overrides
On the `/leaders` page, allow optional overrides per leader:

| Field | Description |
|-------|-------------|
| `ratio` | Custom copy ratio for this leader (null = use global) |
| `maxUsdcPerTrade` | Custom max per trade (null = use global) |
| `maxUsdcPerDay` | Custom daily cap (null = use global) |

**Precedence**: Leader-specific setting > Global setting > Env fallback

#### 1.5 Strategy Engine Updates
- Read settings from DB instead of `process.env`
- Apply operation-specific modifiers before making decisions
- Cache settings with short TTL (e.g., 10 seconds) to avoid DB hits per trade
- Log when settings are used (for debugging)

#### 1.6 Validation Rules
- `ratioDefault`: 0.001 – 0.5 (prevent accidental 100% copying)
- `maxUsdcPerTrade`: 0.01 – 100
- `maxUsdcPerDay`: 0.1 – 1000
- `maxPriceMovePct`: 0.001 – 0.1 (0.1% – 10%)
- `maxSpread`: 0.001 – 0.1

---

## Feature 2: P&L Tracking

### Goal
Track simulated positions and calculate profit/loss as if paper trades were real.

### Requirements

#### 2.1 Position Tracking
When a paper fill occurs (filled = true):
- Record shares acquired/sold per market
- Accumulate position over time

**New table: `positions`**
| Field | Type | Description |
|-------|------|-------------|
| id | uuid | Primary key |
| marketKey | string | The market identifier |
| conditionId | string | For linking to market metadata |
| outcome | string | YES/NO or outcome index |
| shares | numeric | Current share count (+ for long, - for short) |
| avgEntryPrice | numeric | Average price paid per share |
| totalCostBasis | numeric | Total USDC spent |
| updatedAt | timestamp | Last update time |

#### 2.2 Mark-to-Market
Periodically fetch current prices and calculate unrealized P&L:
- `unrealizedPnl = (currentPrice - avgEntryPrice) * shares`
- Store snapshots for historical tracking (optional)

#### 2.3 Resolution P&L
When markets resolve:
- Final value = shares × resolution price (1.00 for winner, 0.00 for loser)
- Realized P&L = final value - cost basis

**New table: `resolutions`**
| Field | Type | Description |
|-------|------|-------------|
| id | uuid | Primary key |
| positionId | uuid | FK to positions |
| resolvedOutcome | string | Winning outcome |
| resolutionPrice | numeric | 1.00 or 0.00 |
| realizedPnl | numeric | Final profit/loss |
| resolvedAt | timestamp | When market resolved |

#### 2.4 Dashboard: P&L Page (`/pnl`)
Display:
- **Open positions** — Market, shares, avg entry, current price, unrealized P&L
- **Closed positions** — Resolved markets, final P&L
- **Summary stats**:
  - Total unrealized P&L
  - Total realized P&L
  - Combined P&L
  - Win rate (% of resolved positions profitable)
  - Best/worst trade

#### 2.5 Position Update Logic

Handle all operation types:

```
if BUY:
  shares += fillShares
  totalCostBasis += fillShares × fillPrice
  avgEntryPrice = totalCostBasis / shares
  
if SELL:
  realizedPnl = (fillPrice - avgEntryPrice) × sellShares
  shares -= sellShares
  totalCostBasis -= sellShares × avgEntryPrice
  
if SPLIT:
  # Convert YES shares to equivalent NO shares (or vice versa)
  # This is a hedge operation - track both sides
  # Cost basis redistributed across outcomes
  
if MERGE:
  # Combine YES + NO shares to exit completely
  # Realize P&L based on merge price vs combined cost basis
  yesPnl + noPnl = final realized P&L
```

#### 2.6 P&L Historical Tracking

To show P&L over time, record periodic snapshots.

**New table: `pnl_snapshots`**
| Field | Type | Description |
|-------|------|-------------|
| id | uuid | Primary key |
| timestamp | timestamp | When snapshot was taken |
| totalCostBasis | numeric | Total invested at this moment |
| unrealizedPnl | numeric | Paper gains/losses on open positions |
| realizedPnl | numeric | Locked-in gains/losses |
| totalPnl | numeric | unrealized + realized |
| positionCount | int | Number of open positions |

**Snapshot frequency**: Every hour (or on each fill, whichever is more practical)

#### 2.7 Dashboard: P&L Page (`/pnl`) with Graphs

Display:
- **Summary cards**:
  - Total unrealized P&L
  - Total realized P&L
  - Combined P&L
  - Win rate (% of resolved positions profitable)
  - Best/worst trade

- **P&L Graph** (main feature):
  - Time range selector: **24h | 7d | 30d | All Time**
  - Line chart showing total P&L over time
  - Optional: overlay unrealized vs realized
  - Use `pnl_snapshots` table for historical data

- **Open positions table**: Market, outcome, shares, avg entry, current price, unrealized P&L
- **Closed positions table**: Market, outcome, resolution, realized P&L

---

## Data Model Changes

### New Tables

```prisma
model Settings {
  id                      Int      @id @default(1)
  
  // Base guardrails
  ratioDefault            Float    @default(0.01)
  maxUsdcPerTrade         Float    @default(2)
  maxUsdcPerDay           Float    @default(10)
  maxPriceMovePct         Float    @default(0.01)
  maxSpread               Float    @default(0.02)
  
  // Operation-specific modifiers
  sellMaxPriceMovePct     Float    @default(0.05)  // 5x more lenient for SELL
  sellMaxSpread           Float    @default(0.10)  // 5x more lenient for SELL
  sellAlwaysAttempt       Boolean  @default(true)  // Never skip SELL for price/spread
  splitMergeAlwaysFollow  Boolean  @default(true)  // Always follow SPLIT/MERGE
  
  updatedAt               DateTime @updatedAt
}

model Position {
  id             String   @id @default(uuid())
  marketKey      String
  conditionId    String
  outcome        String
  shares         Float    @default(0)
  avgEntryPrice  Float    @default(0)
  totalCostBasis Float    @default(0)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  
  resolutions    Resolution[]
  
  @@unique([marketKey, outcome])
}

model Resolution {
  id              String   @id @default(uuid())
  positionId      String
  position        Position @relation(fields: [positionId], references: [id])
  resolvedOutcome String
  resolutionPrice Float
  realizedPnl     Float
  resolvedAt      DateTime @default(now())
}

model PnlSnapshot {
  id              String   @id @default(uuid())
  timestamp       DateTime @default(now())
  totalCostBasis  Float
  unrealizedPnl   Float
  realizedPnl     Float
  totalPnl        Float
  positionCount   Int
  
  @@index([timestamp])
}
```

### Modified Tables

```prisma
model Leader {
  // ... existing fields ...
  
  // Per-leader overrides (null = use global)
  ratio           Float?
  maxUsdcPerTrade Float?
  maxUsdcPerDay   Float?
}
```

---

## API/Logic Changes

### Strategy Engine
- Add `getEffectiveConfig(leaderId, operationType)` function
- Apply operation-specific modifiers:
  - For SELL: use `sellMaxPriceMovePct` and `sellMaxSpread`
  - If `sellAlwaysAttempt = true`, skip price/spread checks for SELL
  - For SPLIT/MERGE: if `splitMergeAlwaysFollow = true`, always execute
- Returns merged config: leader overrides + global settings + operation modifiers
- Cache with 10-second TTL

### Paper Fill Handler
- Handle all operation types: BUY, SELL, SPLIT, MERGE
- After recording fill, call `updatePosition(fill)`
- Accumulate shares and cost basis appropriately

### P&L Snapshot Worker
- Run every hour (or configurable)
- Calculate current unrealized P&L across all positions
- Record snapshot to `pnl_snapshots` table

### Resolution Checker (New Worker Task)
- Periodically check if any positions' markets have resolved
- Record resolution and calculate realized P&L
- Mark position as closed

---

## Dashboard Changes

| Page | Changes |
|------|---------|
| `/settings` | NEW — Global guardrail controls |
| `/leaders` | ADD — Per-leader override fields |
| `/pnl` | NEW — Positions and P&L display |
| `/metrics` | ADD — P&L summary cards |

---

## Success Criteria

### Guardrails
- [x] Can edit global guardrails in dashboard, takes effect immediately
- [x] Can set per-leader overrides, strategy respects them
- [x] Operation-specific settings apply correctly (SELL more lenient)
- [x] SPLIT/MERGE operations are always followed

### P&L Tracking
- [x] Paper fills update position shares correctly
- [x] All operation types (BUY/SELL/SPLIT/MERGE) handled
- [x] `/pnl` page shows open positions with unrealized P&L
- [x] P&L graph shows history with time range selector
- [x] When market resolves, realized P&L is calculated
- [x] Summary shows total P&L across all positions

---

## Deployment Steps

### 1. Run Database Migration

```bash
# Navigate to the db package
cd packages/db

# Run migration (creates Settings, Position, Resolution, PnlSnapshot tables)
DATABASE_URL="postgresql://..." npx prisma migrate deploy

# Generate Prisma client
npx prisma generate
```

### 2. Install Dependencies

```bash
# From repo root
npm install
```

### 3. Verify New Pages

After deployment, verify these new dashboard pages:
- `/settings` — Global guardrails configuration
- `/pnl` — P&L dashboard with charts
- `/leaders` — Now includes per-leader override fields

### 4. Environment Variables (Optional)

New optional environment variables for worker:

| Variable | Default | Description |
|----------|---------|-------------|
| `PNL_SNAPSHOT_INTERVAL` | 3600000 (1 hour) | How often to record P&L snapshots |

### 5. First-Time Setup

On first access, the Settings table auto-creates with defaults:
- Copy ratio: 1%
- Max per trade: $2
- Max per day: $10
- SELL always attempt: ✓
- SPLIT/MERGE always follow: ✓

---

## Files Changed

### New Files
| File | Description |
|------|-------------|
| `packages/core/src/settings.ts` | Settings service with caching |
| `packages/core/src/positions.ts` | Position tracking for P&L |
| `apps/web/app/settings/page.tsx` | Settings dashboard page |
| `apps/web/app/pnl/page.tsx` | P&L dashboard with charts |
| `apps/web/app/api/pnl/route.ts` | P&L API endpoint |

### Modified Files
| File | Changes |
|------|---------|
| `packages/db/prisma/schema.prisma` | Added Settings, Position, Resolution, PnlSnapshot tables; updated Leader with overrides |
| `packages/core/src/strategy.ts` | Added `decidePaperIntentAsync` for DB-based config |
| `packages/core/src/types.ts` | Added SPLIT/MERGE to trade side types |
| `packages/core/src/reasons.ts` | Added OPERATION_ALWAYS_FOLLOW decision reason |
| `apps/web/app/leaders/page.tsx` | Added per-leader override fields |
| `apps/web/app/components.tsx` | Added Settings and P&L nav links |
| `apps/worker/src/paper.ts` | Uses `decidePaperIntentAsync` |
| `apps/worker/src/fills.ts` | Calls `updatePosition` after fills |
| `apps/worker/src/index.ts` | Added hourly P&L snapshot task |
