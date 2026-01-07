# polygon-stepbystep.md — Go from your current implementation → Polygon logs (low latency)

_Last updated: 2026-01-07_

## What this document is
You already have:
- A Next.js dashboard (`apps/web`) showing trades + P&L
- A worker (`apps/worker`) that ingests leader trades via Polymarket APIs, writes to Postgres, and generates paper intents/fills
- A Prisma DB package (`packages/db`)

This guide upgrades the **trigger** from “Polymarket REST/indexer lag” to **Polygon mined logs**, and also removes avoidable internal bottlenecks so your “leader → your action” path is as fast and consistent as possible.

## The reality check (so you design correctly)
- The fastest **consistent** trigger is **mined logs** (block inclusion). You can’t reliably copy *before* the leader’s tx is mined.
- If you want faster-than-mined, you need pending/mempool signals, but those are **not guaranteed** and can miss/lie.

## Target success criteria
When you’re done:
1. Trades from watched wallets are ingested from Polygon logs (`source = polygon/orderfilled`).
2. You can flip a single env var to choose trigger mode: Data API, Polygon, or both.
3. WS disconnects do not cause missed trades (cursor + gap-fill).
4. “Internal lag” is near-zero (you don’t block on quote/mapping REST per trade).

---

## 1) What to listen to on Polygon

### The best trade trigger: `OrderFilled`
Polymarket settles CLOB trades through exchange contracts on Polygon. The most useful event is:

```
OrderFilled(
  bytes32 indexed orderHash,
  address indexed maker,
  address indexed taker,
  uint256 makerAssetId,
  uint256 takerAssetId,
  uint256 makerAmountFilled,
  uint256 takerAmountFilled,
  uint256 fee
)
```

Polymarket’s docs note:
- `takerAssetId == 0` ⇒ **SELL** (receiving USDC)
- `takerAssetId != 0` ⇒ **BUY** (receiving outcome tokens)

From that single log you can derive:
- side (BUY/SELL)
- tokenId (the non-zero asset id)
- USDC amount + token amount (from the filled amounts)
- price ≈ USDC/tokens (validate once vs the Data API for unit scaling)

### Which contracts
Start with **both** exchange addresses (CTF + neg-risk). Keep them in code as env-overridable constants so you can change them if Polymarket updates docs.

---

## 2) Phase plan

### Phase A — Polygon trigger (minimum viable)
- Add WS listener(s) for OrderFilled
- Filter for your enabled leaders’ proxy wallets
- Insert into your existing `TradeRaw` + `Trade`
- Keep Data API polling as fallback while validating

### Phase B — Reduce internal lag (this matters as much as triggers)
- Stop blocking on REST `/book` quote fetch inside ingest
- Add a live quote cache using the CLOB market websocket (or at least async quote capture)

### Phase C — Hardening
- Persist per-leader cursors so reconnects don’t miss logs
- Periodically gap-fill using `getLogs`

---
## 3) Phase A — Implement Polygon mined-log triggers (step-by-step)

### Step A1 — Add env vars
Add these to your local `.env` and your VM/systemd environment:

```bash
# Trigger mode: data-api | polygon | both
export TRIGGER_MODE="both"

# Polygon RPC
export POLYGON_WS_URL="wss://..."
export POLYGON_HTTP_URL="https://..."

# Sync tuning
export POLYGON_SYNC_EVERY_MS=15000
export POLYGON_BACKFILL_BLOCKS=2000
```

Notes:
- Use a **paid / reliable** WS provider if you care about consistent latency.
- Keep both WS and HTTP. WS for low latency; HTTP for gap-fill reliability.

---

### Step A2 — Add dependency for chain logs
From repo root:

```bash
pnpm --filter @polymarket-bot/worker add viem
```

---

### Step A3 — Add a cursor table (Prisma)
You need a durable cursor so WS disconnects don’t lose trades.

In `packages/db/prisma/schema.prisma` add:

```prisma
model ChainCursor {
  id        String   @id @default(cuid())
  key       String   @unique
  lastBlock BigInt
  updatedAt DateTime @updatedAt
  createdAt DateTime @default(now())
}
```

Migration + generate:

```bash
pnpm --filter @polymarket-bot/db prisma migrate dev --name add_chain_cursor
pnpm --filter @polymarket-bot/db prisma generate
```

Key format recommendation (simple + explicit):
- `<exchangeAddress>:<leaderWallet>:<maker|taker>`

---

### Step A4 — Store token id in `MarketMapping.assetId`
This makes tokenId → mapping resolution fast.

In `apps/worker/src/mapping.ts`, when creating the mapping from CLOB market info tokens, set:

```ts
assetId: token.token_id,
```

This lets you do:
- `SELECT * FROM market_mapping WHERE asset_id = <tokenId>`

---

### Step A5 — Add the Polygon watcher module
Create: `apps/worker/src/polygon.ts`

What it must do:
1) Load enabled leaders from DB
2) Start WS watchers for each leader on each exchange
3) Persist cursor per leader
4) Periodically gap-fill from last cursor to latest block
5) Convert `OrderFilled` → normalized trade + raw payload

#### Minimal code (core pieces)

**Event ABI**
```ts
import { parseAbiItem } from "viem";

export const orderFilledAbi = parseAbiItem(
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)"
);
```

**Side + tokenId derivation**
```ts
function normalizeOrderFilled(args: any) {
  const makerAssetId = args.makerAssetId as bigint;
  const takerAssetId = args.takerAssetId as bigint;
  const makerAmt = args.makerAmountFilled as bigint;
  const takerAmt = args.takerAmountFilled as bigint;

  const isSell = takerAssetId === 0n;
  const side = isSell ? "SELL" : "BUY";

  const tokenId = isSell ? makerAssetId : takerAssetId; // non-zero
  const tokenAmt = isSell ? makerAmt : takerAmt;
  const usdcAmt = isSell ? takerAmt : makerAmt;

  // price is ratio; validate once vs Data API for unit scaling
  const price = Number(usdcAmt) / Number(tokenAmt);

  return { side, tokenId, tokenAmt, usdcAmt, price };
}
```

**Watch per leader** (maker + taker)
```ts
wsClient.watchContractEvent({
  address: EXCHANGE,
  abi: [orderFilledAbi],
  eventName: "OrderFilled",
  args: { maker: leaderWallet },
  onLogs: (logs) => handleLogs(logs, "maker")
});

wsClient.watchContractEvent({
  address: EXCHANGE,
  abi: [orderFilledAbi],
  eventName: "OrderFilled",
  args: { taker: leaderWallet },
  onLogs: (logs) => handleLogs(logs, "taker")
});
```

**Cursor update rule**
- After successfully processing a log at block N → set cursor to N.
- Gap-fill uses: `fromBlock = cursor + 1`.

---

### Step A6 — Resolve `tokenId → (conditionId, outcome)` (required for your current schema)
Your `Trade` table requires `conditionId` and `outcome`.

Implement a resolver with this exact priority order:

1) **Fast path** (DB):
   - `marketMapping.findFirst({ where: { assetId: tokenId } })`
   - if found → you already know `conditionId` + `outcome`.

2) **Fallback** (one-time work, then cached):
   - Use the exchange registry `getConditionId(tokenId)` via `readContract`.
   - Then call the CLOB market metadata endpoint for that conditionId to get the YES/NO token list.
   - Insert both outcomes into `market_mapping` (with `assetId = token_id`) so next time is instant.

Practical note:
- This fallback should become rare once your mapping table is warm.

**Acceptance test**
- Pick one tx from Data API.
- Extract `asset`.
- Run resolver on `asset` and confirm it matches the Data API `conditionId` + `outcome`.

---

### Step A7 — Insert Polygon trades into your existing tables
For each leader-matched `OrderFilled`:

1) Create `trade_raw`:
- `source = "polygon/orderfilled"`
- payload includes: exchange, blockNumber, logIndex, txHash, decoded args, and derived fields (side/tokenId/amounts/price)

2) Create `trade`:
- `dedupeKey` should include: leaderWallet + txHash + orderHash + side + tokenId + amounts
- `tradeTs` should be the **block timestamp** (fetch block once per blockNumber; cache it)

3) Immediately create the paper intent:
- `await generatePaperIntentForTrade(trade.id)`

---

### Step A8 — Wire it into the worker runtime
In `apps/worker/src/index.ts`:

1) import the starter:
```ts
import { startPolygonWatchers } from "./polygon";
```

2) call it once at startup (before entering the poll loop):
```ts
await startPolygonWatchers();
```

3) gate Data API ingest by mode:
```ts
if ((process.env.TRIGGER_MODE || "both") !== "polygon") {
  await ingestAllLeaders();
}
```

---

### Step A9 — Validate (before you switch fully)
Run with:
- `TRIGGER_MODE=both`

Then confirm:
- You see new `trade_raw` rows with `source=polygon/orderfilled`.
- You see normalized `trade` rows created from those.
- Your latency drops (once `tradeTs` uses chain timestamp).

Only after you trust it:
- switch to `TRIGGER_MODE=polygon`.

## 4) Phase B — Reduce internal lag (so Polygon triggers actually matter)

Your current ingest path in `apps/worker/src/ingester.ts` does three slow things *synchronously* after inserting a trade:
1) mapping resolution (can do network)
2) `captureQuote()` (REST `/book` call)
3) paper intent generation

Even if Polygon logs arrive fast, **(2)** can easily add 5–15 seconds.

### Step B1 — Stop blocking on quote capture (quick win)
In `apps/worker/src/ingester.ts` change this:

```ts
const quoteId = await captureQuote(mapping);
```

To this:

```ts
void captureQuote(mapping).catch((e) => logger.warn({ err: e }, "captureQuote failed"));
```

Do the same in the Polygon path (don’t block your log handler). The goal is:
- trade insert + intent generation happens immediately
- quotes are enrichment, not a gate

### Step B2 — Add a live best-bid/ask cache (best long-term)
If you want consistent low latency, you need “price now” without REST.

Implementation outline (worker-side):
1) Create `apps/worker/src/clobWs.ts` that connects to the CLOB market websocket.
2) Maintain an in-memory map:
   - `Map<tokenId, { bestBid: number|null; bestAsk: number|null; ts: Date }>`
3) Subscribe to tokenIds you care about:
   - leaders’ recent traded tokenIds
   - tokenIds for your open paper positions
4) Update paper fill simulation to prefer the cache (microseconds) before DB/REST.

**Acceptance test:** after this, the time from “trade ingested” → “paper intent created” should be ~milliseconds (not seconds).

---

## 5) Phase C — Hardening (no missed events, no weird duplicates)

### Step C1 — Cursor strategy that actually works
Use cursor keys per (exchange, leader, channel):
- `${exchange}:${leaderWallet}:maker`
- `${exchange}:${leaderWallet}:taker`

You already created `ChainCursor`. Use it for:
- startup backfill: lastBlock+1 → latest
- periodic gap-fill: every `POLYGON_SYNC_EVERY_MS`

### Step C2 — Dedupe strategy that survives real chain behavior
On-chain you can see:
- multiple `OrderFilled` per tx
- the same human action expressed as multiple fills

So dedupe by something that uniquely identifies a fill you care about. A practical key is:
- leaderWallet + txHash + orderHash + side + tokenId + tokenAmt + usdcAmt

This prevents “double counting” without trying to overthink market microstructure.

### Step C3 — Keep Data API as a safety net (until you trust Polygon)
Run:
- `TRIGGER_MODE=both` for a while

Then compare in DB:
- for each leader, count of polygon-ingested trades vs data-api trades over same period

Only switch to `polygon` when they match well.

---

## 6) Realistic latency you should expect
With mined logs + a decent WS provider + no blocking REST work:
- **Leader mined**: ~2–5s typical (Polygon can be faster/slower)
- **WS delivery**: ~0.2–2s
- **Your processing**: ~10–200ms

So end-to-end “leader → your paper intent” is often **~3–8 seconds**.

If you still see frequent 15–20s spikes after this, it’s almost always:
- weak/overloaded WS endpoint, or
- you’re still doing a blocking REST call per trade somewhere.

---

## 7) Done checklist (matches your spec)
- [ ] Polygon `OrderFilled` ingestion is live and writing to `trade_raw` + `trade`.
- [ ] `TRIGGER_MODE=polygon` works without Data API polling.
- [ ] WS disconnect test: stop network for ~60s, restore it, and you still ingest the missed fills (gap-fill works).
- [ ] Mapping is cached so repeated trades don’t require mapping REST calls.
- [ ] Quote work is non-blocking (async) or replaced by a websocket cache.
- [ ] Dashboard delay is mostly single-digit seconds.
