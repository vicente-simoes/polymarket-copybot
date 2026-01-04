# DigitalOcean Deployment Guide

Complete step-by-step guide to deploy the Polymarket Paper Copy-Trader on a DigitalOcean droplet with a custom domain.

**Your setup:**
- Location: Portugal
- Budget: $200 DigitalOcean credits
- Domain: Free domain from name.com

---

## Phase 1: Create the Droplet

### Step 1.1 — Log into DigitalOcean
Go to [cloud.digitalocean.com](https://cloud.digitalocean.com) and sign in.

### Step 1.2 — Create a new Droplet

1. Click **Create** → **Droplets**
2. Choose settings:

| Setting | Value |
|---------|-------|
| **Region** | Amsterdam (AMS) — closest to Portugal |
| **Image** | Ubuntu 24.04 LTS |
| **Size** | Basic → Regular → **$12/mo (2GB RAM, 1 CPU)** |
| **Authentication** | SSH Key (recommended) or Password |

3. Under **Authentication**:
   - If you have an SSH key, select it
   - If not, click **New SSH Key** and follow the instructions
   - Or choose password (less secure but simpler)

4. **Hostname**: `polymarket-bot`

5. Click **Create Droplet**

### Step 1.3 — Note your IP address
Once created, copy the **IPv4 address** (e.g., `134.209.xx.xx`). You'll need this.

---

## Phase 2: Initial Server Setup

### Step 2.1 — Connect via SSH

```bash
ssh root@<your-droplet-ip>
```

If using a password, enter it when prompted.

### Step 2.2 — Create a non-root user (recommended)

```bash
adduser polybot
usermod -aG sudo polybot
```

Set a password when prompted. Then copy your SSH key to the new user:

```bash
rsync --archive --chown=polybot:polybot ~/.ssh /home/polybot
```

### Step 2.3 — Switch to the new user

```bash
su - polybot
```

From now on, use `polybot` user (not root).

### Step 2.4 — Update the system

```bash
sudo apt update && sudo apt upgrade -y
```

---

## Phase 3: Install Dependencies

### Step 3.1 — Install Docker

```bash
# Install Docker
curl -fsSL https://get.docker.com | sudo sh

# Add your user to docker group (no sudo needed for docker commands)
sudo usermod -aG docker $USER

# Apply group change (or log out and back in)
newgrp docker
```

Verify:
```bash
docker --version
```

### Step 3.2 — Install Docker Compose

```bash
sudo apt install docker-compose-plugin -y
```

Verify:
```bash
docker compose version
```

### Step 3.3 — Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs -y
```

Verify:
```bash
node --version   # Should show v20.x
npm --version
```

### Step 3.4 — Install pnpm (recommended)

```bash
sudo npm install -g pnpm
```

### Step 3.5 — Install Git

```bash
sudo apt install git -y
```

---

## Phase 4: Clone and Set Up the Project

### Step 4.1 — Create project directory

```bash
mkdir -p ~/apps
cd ~/apps
```

### Step 4.2 — Clone your repository

If your repo is on GitHub:
```bash
git clone https://github.com/<your-username>/polymarket-bot.git
cd polymarket-bot
```

Or if it's local, use `scp` to copy it:
```bash
# From your local machine:
scp -r /path/to/polymarket-bot polybot@<droplet-ip>:~/apps/
```

### Step 4.3 — Install dependencies

```bash
pnpm install
```

---

## Phase 5: Start Postgres

### Step 5.1 — Start the database

From your project root (where `docker-compose.yml` is):

```bash
docker compose up -d
```

### Step 5.2 — Verify Postgres is running

```bash
docker ps
```

You should see the postgres container running.

### Step 5.3 — Run database migrations

```bash
cd packages/db
pnpm prisma migrate deploy
pnpm prisma generate
cd ../..
```

---

## Phase 6: Build the Next.js App

### Step 6.1 — Set environment variables

Create production env file for the web app:

```bash
nano apps/web/.env.local
```

Add:
```env
DATABASE_URL="postgresql://polymarket:polymarket@localhost:5432/polymarket"
```

Save: `Ctrl+O`, Enter, `Ctrl+X`

### Step 6.2 — Build for production

```bash
cd apps/web
pnpm build
cd ../..
```

---

## Phase 7: Create systemd Services

### Step 7.1 — Create the worker service

```bash
sudo nano /etc/systemd/system/polymarket-worker.service
```

Paste:
```ini
[Unit]
Description=Polymarket Paper Trading Worker
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=polybot
WorkingDirectory=/home/polybot/apps/polymarket-bot/apps/worker
EnvironmentFile=/home/polybot/apps/polymarket-bot/apps/worker/.env
ExecStart=/usr/bin/node --import tsx src/index.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Save and exit.

### Step 7.2 — Create worker environment file

```bash
nano ~/apps/polymarket-bot/apps/worker/.env
```

Add:
```env
DATABASE_URL="postgresql://polymarket:polymarket@localhost:5432/polymarket"
POLL_INTERVAL_MS=5000
LEADER_FETCH_LIMIT=50
RATIO_DEFAULT=0.01
MAX_USDC_PER_TRADE=2
MAX_USDC_PER_DAY=10
PAPER_MODE=true
```

### Step 7.3 — Create the web service

```bash
sudo nano /etc/systemd/system/polymarket-web.service
```

Paste:
```ini
[Unit]
Description=Polymarket Dashboard (Next.js)
After=network.target

[Service]
Type=simple
User=polybot
WorkingDirectory=/home/polybot/apps/polymarket-bot/apps/web
Environment=NODE_ENV=production
Environment=PORT=3000
EnvironmentFile=/home/polybot/apps/polymarket-bot/apps/web/.env.local
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Step 7.4 — Enable and start services

```bash
sudo systemctl daemon-reload
sudo systemctl enable polymarket-worker polymarket-web
sudo systemctl start polymarket-worker polymarket-web
```

### Step 7.5 — Check status

```bash
sudo systemctl status polymarket-worker
sudo systemctl status polymarket-web
```

Both should show `active (running)`.

---

## Phase 8: Set Up Nginx Reverse Proxy

### Step 8.1 — Install Nginx

```bash
sudo apt install nginx -y
```

### Step 8.2 — Create site configuration

```bash
sudo nano /etc/nginx/sites-available/polymarket
```

Paste:
```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Step 8.3 — Enable the site

```bash
sudo ln -s /etc/nginx/sites-available/polymarket /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default  # Remove default site
sudo nginx -t  # Test config
sudo systemctl reload nginx
```

### Step 8.4 — Test access

Open in your browser:
```
http://<your-droplet-ip>
```

You should see your Next.js dashboard!

---

## Phase 9: Connect Your Domain (name.com)

### Step 9.1 — Log into name.com

Go to [name.com](https://www.name.com) and sign in.

### Step 9.2 — Add DNS record

1. Go to **My Domains** → Select your domain
2. Click **DNS Records**
3. Add a new record:

| Type | Host | Value | TTL |
|------|------|-------|-----|
| A | @ | `<your-droplet-ip>` | 300 |
| A | www | `<your-droplet-ip>` | 300 |

4. Save changes

### Step 9.3 — Wait for DNS propagation

DNS can take 5-30 minutes to propagate. Check with:
```bash
nslookup yourdomain.com
```

Should return your droplet IP.

### Step 9.4 — Update Nginx with your domain

```bash
sudo nano /etc/nginx/sites-available/polymarket
```

Change `server_name _;` to:
```nginx
server_name yourdomain.com www.yourdomain.com;
```

Reload:
```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## Phase 10: Enable HTTPS (Free SSL)

### Step 10.1 — Install Certbot

```bash
sudo apt install certbot python3-certbot-nginx -y
```

### Step 10.2 — Get SSL certificate

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Follow the prompts:
- Enter your email
- Agree to terms
- Choose whether to share email with EFF
- Select "Redirect HTTP to HTTPS" when asked

### Step 10.3 — Verify HTTPS

Open in your browser:
```
https://yourdomain.com
```

You should see a padlock icon! 🔒

### Step 10.4 — Auto-renewal (already set up)

Certbot automatically renews. Verify with:
```bash
sudo certbot renew --dry-run
```

---

## Phase 11: Configure Firewall

### Step 11.1 — Enable UFW

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

### Step 11.2 — Verify

```bash
sudo ufw status
```

Should show SSH and Nginx allowed.

---

## Phase 12: Verify Everything Works

### Checklist

- [ ] **Dashboard accessible**: `https://yourdomain.com`
- [ ] **Worker running**: `sudo systemctl status polymarket-worker`
- [ ] **Postgres running**: `docker ps | grep postgres`
- [ ] **Trades appearing**: Add a leader in the dashboard and wait for trades

### View logs

```bash
# Worker logs
sudo journalctl -u polymarket-worker -f

# Web logs
sudo journalctl -u polymarket-web -f
```

### Reboot test

```bash
sudo reboot
```

Wait 1-2 minutes, then verify services auto-started:
```bash
sudo systemctl status polymarket-worker polymarket-web
```

---

## Maintenance Commands

### Restart services
```bash
sudo systemctl restart polymarket-worker
sudo systemctl restart polymarket-web
```

### View real-time logs
```bash
sudo journalctl -u polymarket-worker -f
```

### Update code
```bash
cd ~/apps/polymarket-bot
git pull
pnpm install
cd apps/web && pnpm build && cd ../..
sudo systemctl restart polymarket-worker polymarket-web
```

### Database backup
```bash
docker exec polymarket-bot-db-1 pg_dump -U polymarket polymarket > backup-$(date +%Y%m%d).sql
```

---

## Cost Estimate

| Resource | Monthly Cost |
|----------|--------------|
| Droplet (2GB) | $12 |
| Domain (name.com) | Free (you have it) |
| SSL (Let's Encrypt) | Free |
| **Total** | **$12/month** |

With $200 credits, you have **~16 months** of runway.

---

## Troubleshooting

### "Connection refused" on port 3000
```bash
sudo systemctl status polymarket-web  # Check if running
sudo journalctl -u polymarket-web -n 50  # Check logs
```

### Worker not ingesting trades
```bash
sudo journalctl -u polymarket-worker -n 100  # Check for errors
```

### Nginx 502 Bad Gateway
Next.js app isn't running or crashed:
```bash
sudo systemctl restart polymarket-web
```

### Can't connect to Postgres
```bash
docker ps  # Is postgres running?
docker compose up -d  # Restart if needed
```

---

## Next Steps

After deployment:
1. Add leader wallets via the `/leaders` page
2. Monitor `/trades` for incoming trades
3. Review `/paper` and `/metrics` after 24-48 hours
4. Tune guardrails based on results
