# Polymarket “Agent” Blueprint — Watch → Paper Copy → Dashboard → Low‑Latency Triggers → (Optional) Live Copy

This document is a **single, end-to-end blueprint** for what you’ve built so far and how to take it to the next level.

You currently have:
- A **watcher** that detects a leader’s Polymarket trades and stores them in Postgres
- A **paper-copy engine** that simulates copying at a smaller scale
- A **dashboard** (Next.js) including **P&L**
- Deployment running **24/7** on a VM

Your next bottleneck is **latency** (4s–20s typical; sometimes worse). This doc explains:
- Why that happens
- How to measure it properly
- How to reduce it (fast + consistent)
- How to evolve this into a “real agent” that can eventually live trade safely (if you choose)

---

## 0) Important framing: what “copy trading” means on Polymarket

Polymarket uses a **CLOB (central limit order book)** for trading outcome tokens, but final settlement and balances ultimately exist on-chain (Polygon). In practice:

- “Leader clicks buy/sell” → off-chain order matching happens (fast, variable)  
- “Fill/settlement changes balances” → you can observe this on-chain (reliable)  
- Polymarket “Data API activity” is an **indexed view** of on-chain activity (can lag)

This creates two fundamentally different “signals” you can use:
1) **Indexer/REST feeds**: easier, but variable latency  
2) **Chain/WebSocket feeds**: faster and/or more consistent

---

## 1) Vocabulary: Polymarket operations (what you can detect)

At a high level, “operations” that matter for your agent fall into these categories:

### 1.1 Trades (what you already track)
- **BUY**: user increases an outcome position (e.g. “YES”) by spending USDC
- **SELL**: user decreases an outcome position by receiving USDC

Your raw trade payload example includes:
- `proxyWallet`: the user’s Polymarket-visible address
- `conditionId`: market identifier
- `outcome`: “Yes”
- `asset`: a large numeric ID (often the outcome token id / instrument id used by the CLOB)
- `side`, `size`, `usdcSize`, `price`, `timestamp`, `transactionHash`

### 1.2 Split / Merge / Redeem (conditional token mechanics)
Depending on protocol details, these are operations that change ERC-1155 balances:
- **Split**: convert collateral → outcome tokens
- **Merge**: convert outcome tokens → collateral
- **Redeem**: claim payouts after resolution

Even if your Data API currently only shows `type=TRADE`, if you want “every operation”, you need on-chain detection of:
- USDC transfers
- ERC-1155 transfers (outcome token movements)

### 1.3 Deposits / Withdrawals
These show up as **USDC transfers** involving the user’s proxy wallet.

---

## 2) Your current architecture (baseline)

### 2.1 Components you already have (or are close to)
- **DB**: Postgres (Docker for local; can be managed or VM-hosted)
- **Worker**:
  - polls Polymarket endpoints for leader activity
  - writes `trade_raw` (full JSON) and `trades` (normalized)
  - generates `paper_intents` + `paper_fills`
- **Next.js dashboard**:
  - Leaders list
  - Trades timeline
  - Paper trades / metrics
  - P&L page
- **Deployment**: systemd services keep it running 24/7

### 2.2 Your current “delay” definition
From the payload you shared:
- trade timestamp: `2026-01-04T22:00:57Z`
- detectedAt: `2026-01-04T22:10:55Z`

So your dashboard delay is likely:
- `delay = detectedAt - tradeTs`

This delay is NOT just “how fast your code runs”. It’s mostly:
- how quickly your upstream signal becomes visible
- plus your own processing time

---

## 3) The single most important improvement: measure latency correctly

Before changing anything, add *three* timestamps per operation:

### 3.1 Timestamps to store
For each leader event:
- **t_chain**: the event time from the leader’s activity (e.g. `timestamp` field)
- **t_detect**: when your worker first saw the event (immediately after API response decode)
- **t_decide**: when your system created the paper intent (after quote/mapping is available)
- (optional) **t_quote**: when your best bid/ask snapshot was captured
- (optional) **t_ui**: when it first appeared on the dashboard (not necessary, UI is not your bottleneck)

### 3.2 Derived latencies
Compute and chart separately:
- **Upstream lag** = `t_detect - t_chain`  
  *This is your signal source lag (API/indexer / rate limits / chain).*  
- **Internal lag** = `t_decide - t_detect`  
  *This is your own system’s overhead (mapping, quote, DB writes, etc.).*

This separation tells you exactly which lever to pull.

---

## 4) Where latency comes from (and how to reduce it)

There are two distinct problems:

### Problem A: You learn about the trade late (upstream lag)
If your trigger is an indexer-based REST endpoint, your detection time is hostage to:
- indexing delays
- rate limiting / throttling behavior
- burst traffic

### Problem B: You learn about the trade fast, but act slowly (internal lag)
This is usually:
- too many REST calls per trade (quote fetches, mapping fetches)
- serial processing across leaders
- DB round trips
- cold subscriptions (subscribing to market data “when needed” instead of keeping it hot)

---

## 5) Understanding “CLOB WebSocket” (and what it’s for)

If “CLOB is all over your codebase”, you likely already use:
- Polymarket CLOB REST endpoints (orders, markets, etc.)
- Potentially the **market websocket** (real-time best bid/ask + book updates)

### What the CLOB market websocket should be used for
**Pricing** and **liquidity checks**:
- keep a live cache of best bid/ask per instrument (e.g. per `asset` / token id)
- avoid per-trade REST quote calls

### What it cannot do (usually)
It won’t reliably tell you:
- “this specific leader wallet traded”  
Market data websockets are market-level. Wallet identity is not generally exposed publicly.

So the best pattern is:
- **Trigger**: leader activity (Data API or on-chain)
- **Price**: CLOB market websocket cache (best bid/ask)

---

## 6) Fast, consistent triggers: connect to Polygon (proxy wallet monitoring)

You said you are using “the address shown on Polymarket” and your raw payload includes `proxyWallet`.

That is the right address to monitor on-chain because:
- it is the wallet that holds USDC and outcome token balances for that Polymarket user

### 6.1 Two on-chain trigger modes

#### Mode 1: Mined logs (most consistent)
Subscribe to Polygon logs via a WebSocket RPC provider.
Trigger when:
- USDC `Transfer` involves `proxyWallet`
- ERC-1155 `TransferSingle`/`TransferBatch` involves `proxyWallet`

This gives consistent detection near block inclusion.

#### Mode 2: Pending tx (fastest, not guaranteed)
Subscribe to mempool/pending transactions.
This can trigger earlier than mined logs, but:
- you can miss txs depending on provider coverage
- txs can be replaced/dropped

Use pending tx as an optional “early hint”, but always confirm with mined logs.

### 6.2 Do you still need Polymarket APIs?
Not for the trigger itself, if you can decode enough details from logs. But realistically:

**Recommended**:
- Use chain logs to trigger immediately
- Use cached mapping + websocket bid/ask to generate copy decisions immediately
- Use Polymarket APIs afterwards for enrichment (market titles, nicer UI)

---

## 7) The “next-level” architecture (recommended)

### 7.1 Event pipeline
1) **Leader Trigger**
   - (Phase 1) Data API: `/activity?user=<proxyWallet>&type=TRADE`
   - (Phase 2) Polygon logs: USDC + ERC1155 transfers for proxy wallet

2) **Normalize + Deduplicate**
   - store raw payload (`trade_raw` / `op_raw`)
   - store normalized row (`trades` / `operations`)
   - enforce unique `dedupeKey` in DB (idempotent)

3) **Resolve Mapping**
   - map from `asset` (token id) and/or `conditionId+outcome` → tradable instrument
   - cache in DB (`market_mapping`)
   - missing mapping must produce `SKIP_MISSING_MAPPING`

4) **Price Snapshot**
   - read best bid/ask from websocket cache immediately (preferred)
   - optionally also store quote snapshot in DB for audit

5) **Decision Engine (Single Source of Truth)**
   - generate `paper_intent` (TRADE or SKIP + reason)
   - guardrails and scaling here

6) **Paper Fill Simulation**
   - compute “same price match” + slippage using bid/ask at decision time
   - write `paper_fills`

7) **Dashboard**
   - show operations + decisions + fills + P&L
   - show latency breakdown (upstream vs internal)

### 7.2 Why this works
- You stop paying per-trade REST quote latency
- You make the “slowest” part either:
  - indexer visibility (Phase 1), or
  - block inclusion (Phase 2)

---

## 8) How to cut your internal lag to near-zero (immediately actionable)

### 8.1 Keep a live bid/ask cache (don’t REST per trade)
In the worker:
- establish websocket(s) on startup
- subscribe to markets/instruments you care about
- update `Map<assetId, {bid, ask, ts}>`

Then, when an event arrives:
- fetch `bid/ask` from the map in-memory (microseconds)
- store a quote snapshot row if you want audit

### 8.2 Pre-resolve mappings
If a mapping is missing and you resolve it on-demand, you add seconds.

Do this instead:
- whenever you ingest a trade for a new `conditionId/outcome/asset`, schedule a mapping job
- mapping jobs can run async in the worker
- by the time the next trade comes, mapping exists

### 8.3 Reduce DB round trips
- use transactions for multi-row inserts per event
- batch inserts if you ingest bursts
- ensure indexes:
  - trades(dedupeKey) unique
  - trades(leaderId, tradeTs) index
  - quotes(marketKey, capturedAt) index

---

## 9) How to reduce upstream lag (detection)

### 9.1 If you’re still on Data API polling
Do these now:
- store per-leader `lastSeenTimestamp`
- poll only **newer** data:
  - request with start time filter (so you don’t re-fetch old history)
- stagger polling across leaders (avoid bursts)

This stabilizes your “4–20s” and reduces rate-limit spikes, but won’t eliminate indexer lag.

### 9.2 For real consistency: on-chain trigger
Implement Polygon log subscriptions for the proxy wallet(s).
That changes your upstream lag from “indexer dependent” to “block dependent”.

### 9.3 Expected delay ranges (realistic)
From the time the leader is actually **filled/settled**:
- **Data API detection**: often 4–20s; can spike (depends on indexing and throttling)
- **On-chain mined logs**: typically a few seconds to ~10s; occasional spikes
- **Pending tx**: potentially 1–3s earlier, but not guaranteed

Important: none of these observe the leader’s intent before execution.

---

## 10) Paper-copy logic: what “good” simulation looks like

### 10.1 Scaling rule
Example:
- leader spends `leaderUsdc = 100`
- you set `ratio = 0.01`
- your target: `yourUsdcTarget = 1.0`

### 10.2 “Same price match” rule
For paper trading you should simulate exactly what you plan to do live.

If you plan “same price or skip”:
- BUY matches if `bestAsk <= leaderPrice`
- SELL matches if `bestBid >= leaderPrice`

If you plan “allow slippage up to X%”:
- BUY allowed limit: `min(bestAsk, leaderPrice*(1+X))`
- SELL allowed limit: `max(bestBid, leaderPrice*(1-X))`

### 10.3 Guardrails (non-negotiable)
At minimum:
- max USDC per trade
- max USDC per day
- max spread threshold
- max price-move threshold from leader’s fill
- allowlist (optional but recommended)

Store the decision reason for every skip.

---

## 11) P&L: what you can and cannot model in paper mode

### 11.1 “Fillability + slippage” is the first truth
Before trusting P&L, ensure:
- match rate is high enough in the markets you copy
- slippage is bounded

### 11.2 P&L approaches
- **Mark-to-market**: value positions using current mid / best bid
- **Realized P&L**: only when you simulate exits (harder)
- **Resolution P&L**: only once market resolves (slow but definitive)

Start with:
- entry fill quality + exposure tracking
Then add:
- exit simulation / resolution modelling

---

## 12) Turning this into a real “agent” (what that means)

An “agent” here isn’t AI magic. It’s:
- reliable sensing (signals)
- consistent decision engine (policy)
- execution (paper now, live later)
- monitoring + safety systems

### Agent maturity ladder
1) **Notifier** (done)
2) **Paper copier** (done)
3) **Dashboards + analytics** (done)
4) **Low-latency triggers + quote cache** (next)
5) **Robust risk + explainability** (next)
6) **Optional live execution** (later)

---

## 13) Optional: Live execution (only when you’re ready)

### 13.1 Hard rule
Default:
- `LIVE_TRADING_ENABLED=false`

Only enable deliberately once paper results justify it.

### 13.2 Security
- use a separate wallet
- keep limited funds
- store secrets securely
- strict caps and kill switch

### 13.3 Execution logic
Live execution must:
- reuse the same strategy engine
- only swap “paper executor” for “live executor”

If paper and live diverge, you will lose money unexpectedly.

---

## 14) Deployment: keep it 24/7 (production checklist)

### Musts
- web service (Next.js) managed by systemd or Docker
- worker service managed by systemd or Docker
- DB reachable (managed Postgres recommended for reliability)
- logging and health checks

### Basic health checks to show on dashboard
- last poll time per leader
- last trade ingested time per leader
- last quote update time per subscribed market
- worker uptime
- error count in last hour

---

## 15) Troubleshooting quick guide (common issues)

### Symptoms: delay spikes to 20s+
Likely:
- upstream signal lag (indexer)
- throttling due to too many REST calls
Fix:
- start/end filters on polling
- stagger leaders
- reduce REST calls by using websocket cache

### Symptoms: “SKIP_MISSING_MAPPING” often
Likely:
- mapping resolution isn’t implemented or is too slow
Fix:
- store mapping in DB
- pre-fetch mapping asynchronously
- fallback logic

### Symptoms: bid/ask missing
Likely:
- websocket not connected or not subscribed to that instrument
Fix:
- subscribe ahead of time for all instruments you might trade
- reconnect logic + resubscribe on reconnect

---

## 16) Concrete next steps for you (highest impact, shortest path)

1) **Add latency breakdown metrics** (upstream vs internal)  
2) **Confirm you have a hot bid/ask cache** (no REST quote calls per event)  
3) **Switch to “poll only new activity”** using per-leader lastSeen timestamp  
4) **Implement on-chain triggers**:
   - start with mined logs for USDC + ERC1155 transfers involving proxy wallets  
5) Keep Polymarket APIs only for enrichment and mapping resolution  
6) After 2–7 days of paper data under low-latency triggers:
   - revisit match rate and slippage  
   - decide whether live execution is worth it  

---

## Appendix A — Your sample payload (what it tells us)

Raw fields you shared (key ones):
- `proxyWallet`: leader identity you should track
- `conditionId`: market id
- `outcome`: “Yes”
- `side`: SELL
- `asset`: large numeric instrument/token id
- `price`, `size`, `usdcSize`
- `timestamp`, `transactionHash`

This is enough to:
- maintain a tokenId/instrument mapping table
- tie on-chain transfers to a market/outcome once you decode ERC-1155 token ids

---

## Appendix B — Minimal “no surprises” acceptance checklist

You are at the “next level” when:
- [ ] internal lag is consistently under ~0.5s
- [ ] upstream lag is stable and explained (indexer vs chain)
- [ ] bid/ask comes from websocket cache
- [ ] mapping is cached and rarely missing
- [ ] every skip has a reason
- [ ] dashboard shows health + latency breakdown
- [ ] paper results are statistically meaningful (days, not hours)

---

### If you want me to tailor this further
If you share:
- which exact endpoints you use for leader detection right now
- whether you already maintain a bid/ask cache in memory
- how you currently map `asset` → market/outcome for quotes
- how many leaders you track and your poll interval

…then I can add a “specific implementation section” that matches your codebase structure and names, with zero ambiguity about where to add each change.
