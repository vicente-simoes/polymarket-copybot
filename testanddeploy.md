# testanddeploy.md — How to Run, Test, and Deploy (Next.js + Worker, 24/7 on a VM)

This document assumes you have completed all implementation steps in `stepbystep.md` and your system matches the spec:
- Next.js dashboard (`apps/web`)
- Worker process (`apps/worker`)
- Shared strategy/types (`packages/core`)
- Prisma + Postgres (`packages/db`)
- Paper mode working end-to-end

It shows:
1) How to run and test everything locally
2) How to deploy to a VM so it runs 24/7 (systemd)
3) How to verify it stays running and is producing data

---

## 0) Quick mental model

You will run **two long-running processes**:

1) **Web**: Next.js dashboard (HTTP server)
2) **Worker**: polls Polymarket + captures quotes + generates paper intents/fills

Both processes use the **same Postgres database**.

---

## 1) Local run & test (recommended workflow)

### 1.1 Requirements
- Node.js 20+
- pnpm (recommended) or npm
- Docker (recommended for Postgres)

### 1.2 Start Postgres (local)
From repo root:

```bash
docker compose up -d
```

Verify DB is running:

```bash
docker ps | grep postgres
```

### 1.3 Set environment variables

#### Web env (`apps/web/.env.local`)
Create or edit:

```env
DATABASE_URL="postgresql://polymarket:polymarket@localhost:5432/polymarket"
```

#### Worker env (`apps/worker/.env`)
Create or edit:

```env
DATABASE_URL="postgresql://polymarket:polymarket@localhost:5432/polymarket"
POLL_INTERVAL_MS=5000
LEADER_FETCH_LIMIT=50

# Guardrails (examples — adjust later)
RATIO_DEFAULT=0.01
MAX_USDC_PER_TRADE=2
MAX_USDC_PER_DAY=10
MAX_PRICE_MOVE_PCT=0.01
MAX_SPREAD=0.02

# Feature flags
PAPER_MODE=true
LIVE_TRADING_ENABLED=false
```

**Rule:** `LIVE_TRADING_ENABLED` must remain `false` in paper mode.

### 1.4 Install dependencies
From repo root:

```bash
pnpm install
```

### 1.5 Run Prisma migrations locally
From `packages/db`:

```bash
cd packages/db
pnpm prisma migrate dev
pnpm prisma generate
```

Optional: open Prisma Studio:

```bash
pnpm prisma studio
```

### 1.6 Start the Worker (terminal 1)
From repo root:

```bash
cd apps/worker
pnpm tsx src/index.ts
```

What you should see:
- log lines about polling leaders
- log lines about new trades inserted
- (later) logs about quotes/intent/fill creation

### 1.7 Start the Web dashboard (terminal 2)
From repo root:

```bash
cd apps/web
pnpm dev
```

Open the dashboard URL shown in the terminal.

### 1.8 Local functional tests (no ambiguity checklist)

#### Test A — Leaders CRUD
1) Open `/leaders`
2) Add a leader wallet + label
3) Toggle enabled off and on

Pass condition:
- Leader appears in list
- Enabled toggle updates immediately
- DB shows the leader row

#### Test B — Trade ingestion
1) With worker running, leave leader enabled
2) Wait until worker polls
3) Open `/trades`

Pass condition:
- Trades appear
- No duplicates
- Each trade links to a raw payload in DB

#### Test C — Quote snapshot & mapping
Open a trade in `/debug`:
- Mapping exists (or trade is explicitly skipped with `SKIP_MISSING_MAPPING`)
- Quote row exists with best bid/ask
- quote_raw payload exists

Pass condition:
- You can see bid/ask for that trade’s market/outcome

#### Test D — Paper intents and fills
Open `/paper` and `/metrics`

Pass condition:
- Each trade produces an intent
- Intent has TRADE or SKIP with a reason
- For TRADE intents, fills are computed
- Metrics (match rate, fill rate, slippage) are non-empty once you have data

#### Test E — Restart safety (duplicate prevention)
1) Stop worker (Ctrl+C)
2) Start worker again

Pass condition:
- It does NOT re-insert the same trades
- Unique constraint prevents duplicates
- Worker continues from where it left off

### 1.9 Local performance sanity checks
- Poll interval is respected (no runaway loops)
- Rate limit errors are handled with backoff
- DB connection is stable

---

## 2) Preparing for deployment

### 2.1 Decide where Postgres lives
You have two options:

**Option 1: Managed Postgres (recommended)**
- e.g. Supabase / Neon / RDS / Cloud SQL
- simplest operationally

**Option 2: Postgres on the VM (Docker Compose)**
- simplest cost-wise
- you manage backups yourself

For a first deployment, VM Postgres is fine as long as you can tolerate losing data OR you add backups.

### 2.2 Build for production
From repo root:

```bash
pnpm install
pnpm -C apps/web build
```

(Worker typically runs via `tsx` or compiled TS; for production, compiling worker is cleaner.)

Recommended: compile worker:
- Add a `tsconfig.json` and build script for worker (output `dist/`).

---

## 3) Deploy to a VM (24/7) using systemd (recommended)

The instructions below assume Ubuntu on the VM.

### 3.1 VM setup
SSH into the VM and install dependencies:

```bash
sudo apt update
sudo apt install -y git curl ca-certificates
```

Install Node.js 20+ (choose one approach; simplest is NodeSource):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Install pnpm:

```bash
sudo npm install -g pnpm
```

### 3.2 Clone the repo
```bash
cd ~
git clone <YOUR_REPO_URL> polymarket-bot
cd polymarket-bot
pnpm install
```

### 3.3 Configure environment files (production)

Create a dedicated env folder:

```bash
sudo mkdir -p /etc/polymarket-bot
sudo chmod 700 /etc/polymarket-bot
```

#### Web env: `/etc/polymarket-bot/web.env`
```bash
sudo nano /etc/polymarket-bot/web.env
```

Example:
```env
DATABASE_URL=postgresql://<user>:<pass>@<host>:5432/<db>
NODE_ENV=production
PORT=3000
```

#### Worker env: `/etc/polymarket-bot/worker.env`
```bash
sudo nano /etc/polymarket-bot/worker.env
```

Example:
```env
DATABASE_URL=postgresql://<user>:<pass>@<host>:5432/<db>
NODE_ENV=production

POLL_INTERVAL_MS=5000
LEADER_FETCH_LIMIT=50

RATIO_DEFAULT=0.01
MAX_USDC_PER_TRADE=2
MAX_USDC_PER_DAY=10
MAX_PRICE_MOVE_PCT=0.01
MAX_SPREAD=0.02

PAPER_MODE=true
LIVE_TRADING_ENABLED=false
```

Lock down env files:

```bash
sudo chmod 600 /etc/polymarket-bot/*.env
```

### 3.4 Run migrations on production DB
From repo root on the VM:

```bash
cd ~/polymarket-bot/packages/db
export $(grep -v '^#' /etc/polymarket-bot/worker.env | xargs)
pnpm prisma migrate deploy
pnpm prisma generate
```

(Using the worker env for DATABASE_URL is fine as long as it points to the same DB as web.)

### 3.5 Build the web app for production
```bash
cd ~/polymarket-bot
pnpm -C apps/web build
```

### 3.6 Create systemd service for the Web app

Create:

```bash
sudo nano /etc/systemd/system/polymarket-web.service
```

Paste (edit user/path/port if needed):

```ini
[Unit]
Description=Polymarket Bot Dashboard (Next.js)
After=network.target

[Service]
Type=simple
User=%u
WorkingDirectory=/home/%u/polymarket-bot/apps/web
EnvironmentFile=/etc/polymarket-bot/web.env
ExecStart=/usr/bin/node /home/%u/polymarket-bot/apps/web/node_modules/.bin/next start -p ${PORT}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

> If `${PORT}` expansion causes trouble, hardcode `-p 3000` and set PORT only for your own reference.

Reload + enable + start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable polymarket-web
sudo systemctl start polymarket-web
sudo systemctl status polymarket-web
```

### 3.7 Create systemd service for the Worker

Create:

```bash
sudo nano /etc/systemd/system/polymarket-worker.service
```

Paste:

```ini
[Unit]
Description=Polymarket Bot Worker (Watcher + Quotes + Paper Sim)
After=network.target

[Service]
Type=simple
User=%u
WorkingDirectory=/home/%u/polymarket-bot/apps/worker
EnvironmentFile=/etc/polymarket-bot/worker.env
ExecStart=/usr/bin/node /home/%u/polymarket-bot/apps/worker/node_modules/.bin/tsx /home/%u/polymarket-bot/apps/worker/src/index.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Reload + enable + start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable polymarket-worker
sudo systemctl start polymarket-worker
sudo systemctl status polymarket-worker
```

---

## 4) Verify it runs 24/7

### 4.1 Check status
```bash
sudo systemctl status polymarket-web
sudo systemctl status polymarket-worker
```

Both should show `Active: active (running)`.

### 4.2 Watch logs
```bash
sudo journalctl -u polymarket-worker -n 200 --no-pager
sudo journalctl -u polymarket-web -n 200 --no-pager
```

Follow live:
```bash
sudo journalctl -u polymarket-worker -f
```

### 4.3 Reboot test
```bash
sudo reboot
```

After reconnecting:
```bash
sudo systemctl status polymarket-web
sudo systemctl status polymarket-worker
```

---

## 5) Ongoing operations

### 5.1 Update code
```bash
cd ~/polymarket-bot
git pull
pnpm install
pnpm -C apps/web build
sudo systemctl restart polymarket-web
sudo systemctl restart polymarket-worker
```

### 5.2 Debug common failures

#### Worker not running
```bash
sudo journalctl -u polymarket-worker -n 200 --no-pager
```

Common causes:
- missing env vars
- DATABASE_URL wrong
- mapping/quote endpoints failing
- rate limiting (should backoff, not crash)

#### Web not running
```bash
sudo journalctl -u polymarket-web -n 200 --no-pager
```

Common causes:
- build not run
- wrong working directory
- wrong port binding
- DATABASE_URL wrong

### 5.3 Confirm the system is doing real work
In the dashboard:
- `/leaders`: leader enabled
- `/trades`: new trades appear over time
- `/metrics`: match rate and counts move over time
- `/debug`: raw payloads exist

---

## 6) Production notes (avoid surprises)

- Keep `LIVE_TRADING_ENABLED=false` forever until paper results are proven.
- Treat env files as secrets; restrict permissions.
- Consider managed Postgres for reliability.
- If hosting dashboard publicly, put it behind:
  - authentication (at least basic auth), and/or
  - a reverse proxy (nginx) + HTTPS

---

## 7) Definition of “deployed correctly”

You are deployed correctly when:
- Both systemd services are enabled
- Both survive reboot
- Worker continuously inserts trades/quotes/intents/fills
- Dashboard shows fresh data without manual intervention

