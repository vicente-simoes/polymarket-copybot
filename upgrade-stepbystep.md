# Upgrade Step-by-Step Implementation Guide

This guide implements the features specified in `upgrade.md`:
1. Dashboard-controlled guardrails (global + per-leader)
2. P&L tracking (positions, mark-to-market, resolution)

Follow steps in order. Each step has a **deliverable** and **verification**.

---

## Phase 1: Database Schema Updates

### Step 1.1 — Add Settings table

Edit `packages/db/prisma/schema.prisma`, add:

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
```

### Step 1.2 — Add per-leader override fields

In the existing `Leader` model, add:

```prisma
model Leader {
  // ... existing fields ...
  
  ratio           Float?
  maxUsdcPerTrade Float?
  maxUsdcPerDay   Float?
}
```

### Step 1.3 — Add Position and Resolution tables

```prisma
model Position {
  id             String   @id @default(uuid())
  marketKey      String
  conditionId    String
  outcome        String
  title          String?
  shares         Float    @default(0)
  avgEntryPrice  Float    @default(0)
  totalCostBasis Float    @default(0)
  isClosed       Boolean  @default(false)
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

### Step 1.4 — Run migration

```bash
cd packages/db
pnpm prisma migrate dev --name add-settings-and-positions
pnpm prisma generate
cd ../..
```

### Deliverable
New tables exist in DB.

### Verify
```bash
pnpm prisma studio
```
See `Settings`, `Position`, `Resolution` tables.

---

## Phase 2: Settings API (packages/core)

### Step 2.1 — Create settings service

Create `packages/core/src/settings.ts`:

```typescript
import { prisma } from '@polymarket/db';

// Cache settings to avoid DB hit per trade
let cachedSettings: Settings | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 10000; // 10 seconds

export interface Settings {
  ratioDefault: number;
  maxUsdcPerTrade: number;
  maxUsdcPerDay: number;
  maxPriceMovePct: number;
  maxSpread: number;
  // Operation-specific
  sellMaxPriceMovePct: number;
  sellMaxSpread: number;
  sellAlwaysAttempt: boolean;
  splitMergeAlwaysFollow: boolean;
}

export async function getGlobalSettings(): Promise<Settings> {
  const now = Date.now();
  if (cachedSettings && now - cacheTime < CACHE_TTL_MS) {
    return cachedSettings;
  }
  
  let settings = await prisma.settings.findUnique({ where: { id: 1 } });
  
  if (!settings) {
    // Create default settings if none exist
    settings = await prisma.settings.create({
      data: { id: 1 }
    });
  }
  
  cachedSettings = settings;
  cacheTime = now;
  return settings;
}

export async function updateGlobalSettings(updates: Partial<Settings>): Promise<Settings> {
  const settings = await prisma.settings.upsert({
    where: { id: 1 },
    update: updates,
    create: { id: 1, ...updates }
  });
  
  // Invalidate cache
  cachedSettings = settings;
  cacheTime = Date.now();
  
  return settings;
}
```

### Step 2.2 — Create effective config function

Add to `packages/core/src/settings.ts`:

```typescript
export interface EffectiveConfig extends Settings {
  leaderId: string;
  operationType: 'BUY' | 'SELL' | 'SPLIT' | 'MERGE';
  // Effective values after applying operation-specific modifiers
  effectiveMaxPriceMovePct: number;
  effectiveMaxSpread: number;
  shouldSkipPriceCheck: boolean;
  isOverridden: {
    ratio: boolean;
    maxUsdcPerTrade: boolean;
    maxUsdcPerDay: boolean;
  };
}

export async function getEffectiveConfig(
  leaderId: string,
  operationType: 'BUY' | 'SELL' | 'SPLIT' | 'MERGE'
): Promise<EffectiveConfig> {
  const global = await getGlobalSettings();
  const leader = await prisma.leader.findUnique({ where: { id: leaderId } });
  
  // Apply operation-specific modifiers
  let effectiveMaxPriceMovePct = global.maxPriceMovePct;
  let effectiveMaxSpread = global.maxSpread;
  let shouldSkipPriceCheck = false;
  
  if (operationType === 'SELL') {
    effectiveMaxPriceMovePct = global.sellMaxPriceMovePct;
    effectiveMaxSpread = global.sellMaxSpread;
    shouldSkipPriceCheck = global.sellAlwaysAttempt;
  } else if (operationType === 'SPLIT' || operationType === 'MERGE') {
    shouldSkipPriceCheck = global.splitMergeAlwaysFollow;
  }
  
  return {
    ...global,
    leaderId,
    operationType,
    ratioDefault: leader?.ratio ?? global.ratioDefault,
    maxUsdcPerTrade: leader?.maxUsdcPerTrade ?? global.maxUsdcPerTrade,
    maxUsdcPerDay: leader?.maxUsdcPerDay ?? global.maxUsdcPerDay,
    effectiveMaxPriceMovePct,
    effectiveMaxSpread,
    shouldSkipPriceCheck,
    isOverridden: {
      ratio: leader?.ratio !== null,
      maxUsdcPerTrade: leader?.maxUsdcPerTrade !== null,
      maxUsdcPerDay: leader?.maxUsdcPerDay !== null,
    }
  };
}
```

### Step 2.3 — Export from index

Update `packages/core/src/index.ts`:

```typescript
export * from './settings';
// ... other exports
```

### Deliverable
Settings can be fetched and merged with leader overrides.

### Verify
Write quick test script that calls `getEffectiveConfig()`.

---

## Phase 3: Update Strategy Engine

### Step 3.1 — Modify strategy to use DB config

Update `packages/core/src/strategy.ts`:

Change from:
```typescript
const config = {
  ratio: parseFloat(process.env.RATIO_DEFAULT || '0.01'),
  // ...
};
```

To:
```typescript
import { getEffectiveConfig } from './settings';

export async function decidePaperIntent(input: {
  trade: NormalizedTrade;
  quote: Quote;
  leaderId: string;
  operationType: 'BUY' | 'SELL' | 'SPLIT' | 'MERGE';
  riskState: RiskState;
}): Promise<PaperIntentDecision> {
  const config = await getEffectiveConfig(input.leaderId, input.operationType);
  
  // For SPLIT/MERGE or when shouldSkipPriceCheck is true, always proceed
  if (config.shouldSkipPriceCheck) {
    return { decision: 'TRADE', reason: 'OPERATION_ALWAYS_FOLLOW', ...computeIntent(input, config) };
  }
  
  // Check price move using operation-specific thresholds
  if (priceMoved > config.effectiveMaxPriceMovePct) {
    return { decision: 'SKIP', reason: 'SKIP_PRICE_MOVED' };
  }
  
  // Check spread using operation-specific thresholds
  if (spread > config.effectiveMaxSpread) {
    return { decision: 'SKIP', reason: 'SKIP_SPREAD_TOO_WIDE' };
  }
  
  // ... rest of logic using config.ratioDefault, config.maxUsdcPerTrade, etc.
}
```

### Deliverable
Strategy engine reads from DB.

### Verify
Change setting in DB, see behavior change without restart.

---

## Phase 4: Settings Dashboard Page

### Step 4.1 — Create settings API route

Create `apps/web/app/api/settings/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { prisma } from '@polymarket/db';

export async function GET() {
  let settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) {
    settings = await prisma.settings.create({ data: { id: 1 } });
  }
  return NextResponse.json(settings);
}

export async function PUT(request: Request) {
  const body = await request.json();
  
  // Validation
  const validated = {
    ratioDefault: Math.max(0.001, Math.min(0.5, body.ratioDefault)),
    maxUsdcPerTrade: Math.max(0.01, Math.min(100, body.maxUsdcPerTrade)),
    maxUsdcPerDay: Math.max(0.1, Math.min(1000, body.maxUsdcPerDay)),
    maxPriceMovePct: Math.max(0.001, Math.min(0.1, body.maxPriceMovePct)),
    maxSpread: Math.max(0.001, Math.min(0.1, body.maxSpread)),
  };
  
  const settings = await prisma.settings.upsert({
    where: { id: 1 },
    update: validated,
    create: { id: 1, ...validated }
  });
  
  return NextResponse.json(settings);
}
```

### Step 4.2 — Create settings page

Create `apps/web/app/settings/page.tsx`:

Build a form with:
- Input fields for each setting
- Validation feedback
- Save button
- Success/error messages

### Deliverable
`/settings` page edits global guardrails.

### Verify
Change a value, save, refresh — value persists.

---

## Phase 5: Per-Leader Overrides UI

### Step 5.1 — Update leaders API

Modify `apps/web/app/api/leaders/[id]/route.ts` to accept:
- `ratio`
- `maxUsdcPerTrade`
- `maxUsdcPerDay`

### Step 5.2 — Update leaders page

Add optional override fields to the leader edit form:
- "Custom ratio (leave blank for global)"
- "Custom max per trade"
- "Custom max per day"

### Deliverable
Can set per-leader overrides.

### Verify
Set override for one leader, check `paper_intents` uses correct value.

---

## Phase 6: Position Tracking

### Step 6.1 — Create position service

Create `packages/core/src/positions.ts`:

```typescript
import { prisma } from '@polymarket/db';

export type OperationType = 'BUY' | 'SELL' | 'SPLIT' | 'MERGE';

export async function updatePosition(fill: {
  marketKey: string;
  conditionId: string;
  outcome: string;
  title?: string;
  operationType: OperationType;
  shares: number;
  price: number;
}) {
  const { marketKey, outcome, operationType, shares, price, conditionId, title } = fill;
  
  // Find or create position
  let position = await prisma.position.findUnique({
    where: { marketKey_outcome: { marketKey, outcome } }
  });
  
  if (!position) {
    position = await prisma.position.create({
      data: { marketKey, outcome, conditionId, title }
    });
  }
  
  switch (operationType) {
    case 'BUY': {
      const newShares = position.shares + shares;
      const newCostBasis = position.totalCostBasis + (shares * price);
      const newAvgPrice = newShares > 0 ? newCostBasis / newShares : 0;
      
      await prisma.position.update({
        where: { id: position.id },
        data: {
          shares: newShares,
          totalCostBasis: newCostBasis,
          avgEntryPrice: newAvgPrice
        }
      });
      break;
    }
    
    case 'SELL': {
      const sellShares = Math.min(shares, position.shares);
      const realizedPnl = (price - position.avgEntryPrice) * sellShares;
      const newShares = position.shares - sellShares;
      const newCostBasis = newShares * position.avgEntryPrice;
      
      await prisma.position.update({
        where: { id: position.id },
        data: {
          shares: newShares,
          totalCostBasis: newCostBasis,
          isClosed: newShares === 0
        }
      });
      
      // Record realized P&L if position closed
      if (newShares === 0) {
        await recordRealizedPnl(position.id, realizedPnl);
      }
      break;
    }
    
    case 'SPLIT': {
      // SPLIT converts shares from one outcome to both outcomes
      // Typically: YES shares -> YES + NO (hedging)
      // Cost basis is redistributed proportionally
      // Implementation depends on Polymarket's exact SPLIT mechanics
      console.log('SPLIT operation - track both outcomes');
      break;
    }
    
    case 'MERGE': {
      // MERGE combines YES + NO shares to exit at $1 total
      // Find complementary position and combine
      const complementaryOutcome = outcome === 'YES' ? 'NO' : 'YES';
      const complementary = await prisma.position.findUnique({
        where: { marketKey_outcome: { marketKey, outcome: complementaryOutcome } }
      });
      
      if (complementary) {
        const mergePnl = 1.0 - (position.avgEntryPrice + complementary.avgEntryPrice);
        const mergeShares = Math.min(position.shares, complementary.shares);
        
        // Close both positions proportionally
        // Record combined realized P&L
        await recordRealizedPnl(position.id, mergePnl * mergeShares);
      }
      break;
    }
  }
  
  // Record P&L snapshot after any position change
  await recordPnlSnapshot();
}

async function recordRealizedPnl(positionId: string, pnl: number) {
  await prisma.resolution.create({
    data: {
      positionId,
      resolvedOutcome: 'MANUAL_CLOSE',
      resolutionPrice: 0,
      realizedPnl: pnl
    }
  });
}

export async function recordPnlSnapshot() {
  const positions = await prisma.position.findMany({
    where: { isClosed: false }
  });
  
  const totalCostBasis = positions.reduce((sum, p) => sum + p.totalCostBasis, 0);
  // For unrealized P&L, would need current market prices
  // Simplified: just track cost basis changes
  const unrealizedPnl = 0; // TODO: fetch current prices and calculate
  
  const resolutions = await prisma.resolution.findMany();
  const realizedPnl = resolutions.reduce((sum, r) => sum + r.realizedPnl, 0);
  
  await prisma.pnlSnapshot.create({
    data: {
      totalCostBasis,
      unrealizedPnl,
      realizedPnl,
      totalPnl: unrealizedPnl + realizedPnl,
      positionCount: positions.length
    }
  });
}
```

In worker where paper fills are recorded, add:

```typescript
import { updatePosition, OperationType } from '@polymarket/core';

// Determine operation type from trade data
function getOperationType(trade: any): OperationType {
  // Polymarket trades have a 'type' or 'action' field
  // Map to our operation types
  if (trade.type === 'SPLIT') return 'SPLIT';
  if (trade.type === 'MERGE') return 'MERGE';
  if (trade.side === 'BUY') return 'BUY';
  return 'SELL';
}

// After recording paper_fill
if (fill.filled) {
  const operationType = getOperationType(trade);
  
  await updatePosition({
    marketKey: trade.marketKey,
    conditionId: trade.conditionId,
    outcome: trade.outcome,
    title: trade.title,
    operationType,
    shares: fillShares,
    price: fill.fillPrice
  });
}
```

### Deliverable
Positions accumulate as paper fills occur.

### Verify
After paper fills, check `Position` table has correct shares.

---

## Phase 7: P&L Dashboard Page

### Step 7.1 — Create P&L API route

Create `apps/web/app/api/pnl/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { prisma } from '@polymarket/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const range = searchParams.get('range') || '7d'; // 24h, 7d, 30d, all
  
  // Calculate date filter
  let dateFilter: Date | undefined;
  const now = new Date();
  switch (range) {
    case '24h': dateFilter = new Date(now.getTime() - 24 * 60 * 60 * 1000); break;
    case '7d': dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
    case '30d': dateFilter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break;
    case 'all': dateFilter = undefined; break;
  }
  
  const positions = await prisma.position.findMany({
    where: { isClosed: false },
    orderBy: { updatedAt: 'desc' }
  });
  
  const closedPositions = await prisma.position.findMany({
    where: { isClosed: true },
    include: { resolutions: true },
    orderBy: { updatedAt: 'desc' }
  });
  
  // Get P&L history for graph
  const pnlHistory = await prisma.pnlSnapshot.findMany({
    where: dateFilter ? { timestamp: { gte: dateFilter } } : {},
    orderBy: { timestamp: 'asc' }
  });
  
  // Calculate totals
  const totalCostBasis = positions.reduce((sum, p) => sum + p.totalCostBasis, 0);
  const totalRealizedPnl = closedPositions
    .flatMap(p => p.resolutions)
    .reduce((sum, r) => sum + r.realizedPnl, 0);
  
  return NextResponse.json({
    openPositions: positions,
    closedPositions,
    pnlHistory: pnlHistory.map(s => ({
      timestamp: s.timestamp.toISOString(),
      totalPnl: s.totalPnl,
      unrealizedPnl: s.unrealizedPnl,
      realizedPnl: s.realizedPnl
    })),
    summary: {
      totalCostBasis,
      totalRealizedPnl,
      openPositionCount: positions.length,
      closedPositionCount: closedPositions.length
    }
  });
}
```

### Step 7.2 — Create P&L page

Create `apps/web/app/pnl/page.tsx`:

Display:
- **Summary cards**: Total cost basis, realized P&L, position counts
- **P&L Graph**: 
  - Time range selector buttons: `24h | 7d | 30d | All Time`
  - Line chart using `pnlHistory` data from API
  - X-axis: timestamp, Y-axis: totalPnl
  - Use a chart library like `recharts` or `chart.js`
- **Open positions table**: Market, outcome, shares, avg price, cost basis
- **Closed positions table**: Market, outcome, resolution, P&L

### Step 7.3 — Add chart library

```bash
cd apps/web
pnpm add recharts
cd ../..
```

### Step 7.4 — Create P&L chart component

Create `apps/web/components/PnlChart.tsx`:

```typescript
'use client';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface PnlChartProps {
  data: { timestamp: string; totalPnl: number }[];
  range: '24h' | '7d' | '30d' | 'all';
  onRangeChange: (range: '24h' | '7d' | '30d' | 'all') => void;
}

export function PnlChart({ data, range, onRangeChange }: PnlChartProps) {
  return (
    <div>
      <div className="flex gap-2 mb-4">
        {(['24h', '7d', '30d', 'all'] as const).map(r => (
          <button
            key={r}
            onClick={() => onRangeChange(r)}
            className={`px-3 py-1 rounded ${range === r ? 'bg-blue-500 text-white' : 'bg-gray-200'}`}
          >
            {r === 'all' ? 'All Time' : r.toUpperCase()}
          </button>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <XAxis 
            dataKey="timestamp" 
            tickFormatter={(t) => new Date(t).toLocaleDateString()}
          />
          <YAxis tickFormatter={(v) => `$${v.toFixed(2)}`} />
          <Tooltip 
            formatter={(v: number) => [`$${v.toFixed(2)}`, 'P&L']}
            labelFormatter={(t) => new Date(t).toLocaleString()}
          />
          <Line 
            type="monotone" 
            dataKey="totalPnl" 
            stroke="#10b981" 
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

### Deliverable
`/pnl` page shows positions and P&L.

### Verify
Paper fills reflect as positions with correct math.

---

## Phase 8: P&L Snapshot Worker

### Step 8.1 — Add hourly snapshot task

In `apps/worker/src/index.ts`, add a scheduled task:

```typescript
import { recordPnlSnapshot } from '@polymarket/core';

// Record P&L snapshot every hour
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function startSnapshotWorker() {
  setInterval(async () => {
    try {
      await recordPnlSnapshot();
      console.log('P&L snapshot recorded');
    } catch (error) {
      console.error('Failed to record P&L snapshot:', error);
    }
  }, SNAPSHOT_INTERVAL_MS);
  
  // Record initial snapshot on startup
  await recordPnlSnapshot();
}

// Call this in your worker startup
startSnapshotWorker();
```

### Deliverable
P&L snapshots recorded hourly.

### Verify
Check `pnl_snapshots` table populates over time.

---

## Phase 9: Resolution Tracking (Optional Enhancement)

### Step 9.1 — Create resolution checker

Add a worker task that periodically:
1. Gets all open positions
2. Checks if their markets have resolved (via Polymarket API)
3. Records resolution and calculates P&L

This can be triggered:
- On a schedule (every hour)
- Manually via API endpoint
- When viewing P&L page

### Deliverable
Resolved markets show final P&L.

### Verify
When test market resolves, position marked closed with correct P&L.

---

## Phase 10: Redeploy to Production

### Step 9.1 — Pull latest code

SSH into your droplet:

```bash
ssh polybot@<your-droplet-ip>
cd ~/apps/polymarket-bot
git pull
```

### Step 9.2 — Install dependencies

```bash
pnpm install
```

### Step 9.3 — Run database migration

```bash
cd packages/db
pnpm prisma migrate deploy
pnpm prisma generate
cd ../..
```

### Step 9.4 — Rebuild Next.js

```bash
cd apps/web
pnpm build
cd ../..
```

### Step 9.5 — Restart services

```bash
sudo systemctl restart polymarket-worker
sudo systemctl restart polymarket-web
```

### Step 9.6 — Verify deployment

1. Check services are running:
   ```bash
   sudo systemctl status polymarket-worker polymarket-web
   ```

2. Check logs for errors:
   ```bash
   sudo journalctl -u polymarket-worker -n 50
   sudo journalctl -u polymarket-web -n 50
   ```

3. Test new pages:
   - `/settings` — Global guardrails + operation-specific settings
   - `/leaders` — Per-leader overrides
   - `/pnl` — Positions, P&L, and historical graph

---

## Phase 11: Acceptance Criteria

### Guardrails
- [ ] `/settings` page loads and shows current values
- [ ] Can edit and save global settings
- [ ] Operation-specific settings (SELL lenient, SPLIT/MERGE always follow) work correctly
- [ ] Changes take effect without restart
- [ ] Can set per-leader overrides on `/leaders` page
- [ ] Strategy uses leader override when set, global otherwise

### P&L Tracking
- [ ] Positions table populates when paper fills occur
- [ ] All operation types (BUY/SELL/SPLIT/MERGE) handled correctly
- [ ] Position shares and cost basis are correct
- [ ] `/pnl` page shows open positions
- [ ] P&L graph displays with time range selector (24h/7d/30d/all)
- [ ] P&L snapshots recorded hourly
- [ ] Summary stats are accurate
- [ ] (Optional) Resolutions are tracked when markets resolve

### Stability
- [ ] Worker runs without errors after upgrade
- [ ] Dashboard loads all pages without errors
- [ ] Reboot test: services auto-start and continue working
