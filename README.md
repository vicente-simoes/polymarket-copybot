# Polymarket Copy-Trading Bot

A TypeScript monorepo for paper copy-trading on Polymarket with a Next.js dashboard.

## Structure

```
apps/
  web/              # Next.js dashboard
  worker/           # Polling + paper simulation worker
packages/
  core/             # Shared types + strategy engine
  db/               # Prisma schema + DB utilities
docs/               # Documentation
```

## Getting Started

### Prerequisites
- Node.js 20+
- pnpm
- Docker (for local Postgres)

### Setup

1. Install dependencies:
```bash
pnpm install
```

2. Start Postgres (Step 2):
```bash
docker compose up -d
```

3. Run database migrations (Step 3):
```bash
pnpm db:migrate
```

4. Start the dashboard:
```bash
pnpm dev:web
```

5. Start the worker:
```bash
pnpm dev:worker
```

## Implementation Progress

See `stepbystep.md` for the full implementation guide.

- [x] Step 1: Create repo structure (monorepo)
- [ ] Step 2: Add Postgres (local dev)
- [ ] Step 3: Set up Prisma (DB schema)
- [ ] Step 4+: See stepbystep.md



passphrase: polymarket-bot

165.22.205.182