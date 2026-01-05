# Redeployment Guide

Use this guide to update your live server after pushing changes to GitHub.

## Troubleshooting: "Local changes would be overwritten"

If you see an error like `error: Your local changes to the following files would be overwritten by merge: pnpm-lock.yaml`, run this command to discard server-side changes and accept the new version:

```bash
git checkout pnpm-lock.yaml
git pull origin main
```

## 1. Connect to Server

```bash
ssh polybot@<your-droplet-ip>
cd ~/polymarket-copybot
```

## 2. Pull Changes

```bash
git pull origin main
```

## 3. Update Dependencies (Optional)

Run this if you changed `package.json`:

```bash
pnpm install
```

## 4. Run Database Migrations (Optional)

Run this ONLY if you changed `packages/db/prisma/schema.prisma`:

```bash
cd packages/db
npx prisma migrate deploy
npx prisma generate
cd ../..
```

## 5. Rebuild Applications

Recompile the code to apply changes:

```bash
# Build Core
cd packages/core
pnpm build
cd ../..

# Build Worker
cd apps/worker
pnpm build
cd ../..

# Build Web Dashboard
cd apps/web
# Note: creating a production build requires next build
npx next build --webpack
cd ../..
```

## 6. Restart Services

Restart systemd services to pick up the new code:

```bash
sudo systemctl restart polymarket-worker
sudo systemctl restart polymarket-web
```

## 7. Verify Status

Check that everything started correctly:

```bash
# Check service status
sudo systemctl status polymarket-worker
sudo systemctl status polymarket-web

# View real-time logs
sudo journalctl -u polymarket-worker -f
# (Press Ctrl+C to exit logs)
```

## Quick One-Liner

If you just made code changes (no DB/dependency changes), you can copy-paste this block:

```bash
cd ~/polymarket-copybot && \
git pull origin main && \
pnpm install && \
(cd packages/core && pnpm build) && \
(cd apps/worker && pnpm build) && \
(cd apps/web && npx next build --webpack) && \
sudo systemctl restart polymarket-worker polymarket-web && \
sudo journalctl -u polymarket-worker -f
```
