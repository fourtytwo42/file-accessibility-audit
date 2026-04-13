# 04 — Deployment Guide

For a plain Ubuntu 24.04 VM running the **API + local Gemma AI** stack, prefer the repo-managed systemd path:

```bash
bash ./scripts/provision-vm.sh
bash ./scripts/start-stack.sh
```

The PM2-based flow below remains an alternate deployment path for the broader app/web setup, but it is no longer the preferred local API + AI VM path.

**Project:** `file-accessibility-audit`
**Production URL:** https://audit.icjia.app
**Target:** DigitalOcean droplet → Laravel Forge → PM2 → nginx reverse proxy

---

## Quick Reference

If you've deployed before and just need the commands:

```bash
# SSH into the server
ssh forge@<droplet-ip>
cd /home/forge/audit.icjia.app

# Pull, install, build, restart
git pull origin main
pnpm install --frozen-lockfile
pnpm build                                     # Type-check API + build Nuxt
pm2 reload ecosystem.config.cjs --update-env

# Verify
pm2 status
curl -s http://localhost:6103/api/health | jq
curl -s http://localhost:6102 | head -5
```

Or just push to `main` — Forge auto-deploys via webhook if Quick Deploy is enabled.

---

## 1. Infrastructure

### DigitalOcean Droplet

| Spec | Recommendation | Notes |
|------|---------------|-------|
| **Plan** | Basic — Regular Intel | |
| **Size** | 2 vCPU / 4GB RAM / 80GB SSD | `$24/mo` — headroom for QPDF subprocess + pdfjs |
| **Minimum** | 1 vCPU / 2GB RAM / 50GB SSD | `$12/mo` — adequate for low traffic, tight on memory |
| **OS** | Ubuntu 24.04 LTS | Forge-supported, LTS through 2029 |
| **Region** | Chicago (ORD1) | Closest to ICJIA |

### Why 4GB?

QPDF runs as a subprocess and can spike memory on complex PDFs. pdfjs-dist loads the full PDF into memory for parsing. With Node.js overhead and Nuxt SSR, 2GB is genuinely tight. 4GB gives comfortable headroom.

### Architecture Overview

```
Internet → nginx (443) → Nuxt SSR (6102) → serves pages
                       → Express API (6103) → PDF analysis, auth, reports

PM2 manages both Node processes
Forge manages nginx, SSL, deploys
SQLite stores audit logs + shared reports
```

---

## 2. First-Time Server Setup

After Forge creates the server and provisions Node.js, SSH in once:

```bash
# 1. Install system dependencies
sudo apt update && sudo apt install -y qpdf
npm install -g pnpm

# 2. Verify versions
node -v    # Must be 22+
qpdf --version
pnpm -v

# 3. Create the site in Forge (see Section 5 below)
# Forge clones the repo to /home/forge/audit.icjia.app

# 4. Go to the project directory
cd /home/forge/audit.icjia.app

# 5. Create .env files from production templates
cp apps/api/.env.example.production apps/api/.env
cp apps/web/.env.example.production apps/web/.env

# 6. Edit API .env with real credentials
nano apps/api/.env
```

### Required values in `apps/api/.env`:

```env
NODE_ENV=production
PORT=6103
JWT_SECRET=<generate-with: openssl rand -hex 32>
DB_PATH=./data/audit.db
SMTP_USER=postmaster@icjia.cloud
SMTP_PASS=<your-mailgun-smtp-password>
ADMIN_EMAILS=admin@icjia.illinois.gov
ALLOWED_DOMAINS=
MAX_FILE_SIZE_MB=100
TMP_DIR=/tmp
```

### Required values in `apps/web/.env`:

```env
NUXT_PUBLIC_APP_NAME=ICJIA File Accessibility Audit
NODE_ENV=production
```

> **Note:** Auth is off by default (`REQUIRE_LOGIN: false` in `audit.config.ts`). If auth is disabled, `JWT_SECRET`, `SMTP_USER`, and `SMTP_PASS` are not needed. The app works without any email provider.

```bash
# 7. Create data directory for SQLite
mkdir -p apps/api/data

# 8. Install, build, and start
pnpm install --frozen-lockfile
pnpm --filter api build
pnpm --filter web build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # ensures PM2 restarts on server reboot
```

---

## 3. PM2 Configuration

The `ecosystem.config.cjs` in the project root manages both processes:

```javascript
module.exports = {
  apps: [
    {
      name: 'file-audit-api',
      cwd: './apps/api',
      script: 'pnpm',
      args: 'start',           // runs: node --import tsx src/index.ts
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        PORT: 6103,
      },
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 3000,
      exp_backoff_restart_delay: 100,
    },
    {
      name: 'file-audit-web',
      cwd: './apps/web',
      script: 'pnpm',
      args: 'start',           // runs: node .output/server/index.mjs
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        PORT: 6102,
      },
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 3000,
      exp_backoff_restart_delay: 100,
    },
  ],
}
```

### Ports

| Service | Port | Listens on |
|---------|------|------------|
| Nuxt frontend (SSR) | 6102 | localhost only |
| Express API | 6103 | localhost only |
| nginx (public) | 80 / 443 | 0.0.0.0 |

Both Node processes listen on localhost only — nginx proxies all public traffic.

### What each `start` script runs

| App | `pnpm start` runs | Notes |
|-----|-------------------|-------|
| API | `node --import tsx src/index.ts` | tsx runs TypeScript directly — no build output needed at runtime |
| Web | `node .output/server/index.mjs` | Nuxt builds to `.output/` — this is the production SSR server |

The `pnpm --filter api build` step runs `tsc --noEmit` (type check only). The API runs from source via tsx in production. The `pnpm --filter web build` step runs `nuxt build` which generates the `.output/` directory.

---

## 4. nginx Configuration

In Forge, edit the nginx config for the site. Replace the default `location` blocks with:

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name audit.icjia.app;

    # Forge manages these SSL paths — do not change
    ssl_certificate /etc/nginx/ssl/audit.icjia.app/xxx/server.crt;
    ssl_certificate_key /etc/nginx/ssl/audit.icjia.app/xxx/server.key;

    # Security
    server_tokens off;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    # API — proxy to Express on port 6103
    # Must come BEFORE the catch-all / block
    location /api/ {
        proxy_pass http://127.0.0.1:6103;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 110M;    # PDF upload limit (100MB + overhead)
        proxy_read_timeout 60s;       # PDF analysis can take time
    }

    # SEO static files — serve directly for crawlers
    location = /robots.txt {
        proxy_pass http://127.0.0.1:6102;
        proxy_set_header Host $host;
        expires 1d;
    }

    location = /sitemap.xml {
        proxy_pass http://127.0.0.1:6102;
        proxy_set_header Host $host;
        expires 1d;
    }

    location = /llms.txt {
        proxy_pass http://127.0.0.1:6102;
        proxy_set_header Host $host;
        expires 1d;
    }

    location = /llms-full.txt {
        proxy_pass http://127.0.0.1:6102;
        proxy_set_header Host $host;
        expires 1d;
    }

    # Frontend — proxy everything else to Nuxt SSR on port 6102
    location / {
        proxy_pass http://127.0.0.1:6102;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Static assets cache
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot|webmanifest)$ {
        proxy_pass http://127.0.0.1:6102;
        proxy_set_header Host $host;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}

# HTTP → HTTPS redirect (Forge usually handles this, but just in case)
server {
    listen 80;
    listen [::]:80;
    server_name audit.icjia.app;
    return 301 https://$host$request_uri;
}
```

### What each proxy does

| Location | Target | Purpose |
|----------|--------|---------|
| `/api/` | `127.0.0.1:6103` | Express API — PDF analysis, auth, reports, health check |
| `/robots.txt` | `127.0.0.1:6102` | Auto-generated by @nuxtjs/seo (robots module) |
| `/sitemap.xml` | `127.0.0.1:6102` | Auto-generated by @nuxtjs/seo (sitemap module) |
| `/llms.txt` | `127.0.0.1:6102` | AI discoverability file (static in `public/`) |
| `/llms-full.txt` | `127.0.0.1:6102` | Full AI documentation (static in `public/`) |
| `/` | `127.0.0.1:6102` | Nuxt SSR — all pages, components, client JS |
| Static assets | `127.0.0.1:6102` | JS/CSS/images with 30-day cache |

### Important nginx notes

- The `/api/` block **must come before** the `/` catch-all block
- `client_max_body_size 110M` allows PDF uploads up to 100MB (with HTTP overhead)
- `proxy_read_timeout 60s` prevents nginx from killing long-running PDF analyses
- The `Upgrade` headers on `/` are needed for Nuxt HMR in development (harmless in production)
- Forge manages SSL certificate paths — keep whatever Forge generated for `ssl_certificate` and `ssl_certificate_key`

---

## 5. Connecting Forge to GitHub

### Step 1: Create a Site in Forge

1. In Forge, go to your server → **Sites** → **New Site**
2. Set the domain to `audit.icjia.app`
3. Set the project type to **Static HTML / Proxy** (Forge won't serve files directly — nginx proxies to PM2)
4. Set the web directory to `/public` (unused, but Forge requires it)

### Step 2: Connect the GitHub Repository

1. On the site page, go to the **Git Repository** section
2. Select **GitHub** and authorize if needed
3. Enter the repository: `ICJIA/file-accessibility-audit`
4. Branch: `main`
5. Check **"Install Composer Dependencies"**: **No** (this is a Node project)
6. Click **Install Repository** — Forge clones to `/home/forge/audit.icjia.app`

### Step 3: Set the Deploy Script

In the site's **Deploy Script** box (Apps tab → Deploy Script), paste:

```bash
cd /home/forge/audit.icjia.app

# Pull latest code
git pull origin main

# Install dependencies
pnpm install --frozen-lockfile

# Build both apps (type-check API + build Nuxt to .output/)
pnpm build

# Start or restart PM2 processes
if pm2 describe file-audit-api > /dev/null 2>&1; then
    pm2 reload ecosystem.config.cjs --update-env
else
    pm2 start ecosystem.config.cjs
    pm2 save
fi
```

### Step 4: Enable Auto-Deploy

1. On the site page, toggle **"Quick Deploy"** → **ON**
2. This installs a GitHub webhook so every push to `main` triggers the deploy script automatically

Now every `git push origin main` will:
1. GitHub sends a webhook to Forge
2. Forge SSHs into the droplet and runs the deploy script
3. Code is pulled, rebuilt, and PM2 processes are reloaded with zero downtime

### Manual Deploy (if needed)

You can trigger a deploy manually from the Forge UI:
- Go to the site → click **"Deploy Now"**

Or SSH in and run the deploy script commands directly.

---

## 6. Verification Checklist

After deploying, verify everything works:

```bash
# On the server:
pm2 status                                  # Both processes "online"
curl -s http://localhost:6103/api/health    # { "status": "ok", ... }
curl -s http://localhost:6102 | head -20    # HTML output from Nuxt

# From your browser:
# https://audit.icjia.app                  → landing page with dropzone
# https://audit.icjia.app/api/health       → JSON health response
# https://audit.icjia.app/robots.txt       → robots directives
# https://audit.icjia.app/sitemap.xml      → sitemap
# https://audit.icjia.app/llms.txt         → AI discoverability file
# https://audit.icjia.app/og-image.png     → 1200x630 OG image
# https://audit.icjia.app/favicon.png      → favicon
```

---

## 7. Firewall

Configure the DigitalOcean firewall (or `ufw` on the droplet) to allow only:

| Port | Protocol | Source |
|------|----------|--------|
| 22 | TCP | Your IP / ICJIA network |
| 80 | TCP | Anywhere |
| 443 | TCP | Anywhere |

Block all other inbound ports. The Express API (6103) and Nuxt server (6102) listen on localhost and are proxied through nginx — they must not be directly accessible from the internet.

```bash
# If using ufw instead of DO firewall:
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

---

## 8. SSL & DNS

1. Point your domain's DNS A record to the droplet's IP address
2. In Forge, add the site with the domain name
3. Click "SSL" → "Let's Encrypt" → Forge provisions and auto-renews the certificate

---

## 9. Monitoring & Maintenance

### PM2 Commands

```bash
pm2 status                    # Check process status
pm2 logs                      # Tail all logs
pm2 logs file-audit-api       # Tail API logs only
pm2 logs file-audit-web       # Tail web logs only
pm2 monit                     # Real-time resource monitoring
pm2 restart all               # Restart both processes
pm2 reload ecosystem.config.cjs --update-env  # Zero-downtime restart
```

### Log Rotation

PM2 logs grow indefinitely. Install `pm2-logrotate`:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

### QPDF Temp File Cleanup

The app cleans up temp files in its `finally` block, but as a safety net, add a cron job:

```bash
# Crontab: delete QPDF temp files older than 1 hour
0 * * * * find /tmp -name '*.pdf' -mmin +60 -delete
```

### SQLite Backup

The database at `apps/api/data/audit.db` stores audit logs and shared report links. Back it up:

```bash
# Crontab: daily backup
0 2 * * * cp /home/forge/audit.icjia.app/apps/api/data/audit.db /home/forge/backups/audit-$(date +\%Y\%m\%d).db
```

---

## 10. Troubleshooting

### PM2 processes won't start

```bash
# Check logs for errors
pm2 logs --lines 50

# Common issues:
# - Missing .env file → copy from .env.example.production
# - QPDF not installed → sudo apt install qpdf
# - Wrong Node version → node -v (must be 22+)
# - Port already in use → kill-port 6102 6103 or lsof -i :6102
```

### nginx returns 502 Bad Gateway

The Node process isn't running or crashed:

```bash
pm2 status        # Check if processes are online
pm2 restart all   # Restart them
pm2 logs          # Check for crash reasons
```

### PDF upload returns 413 (Entity Too Large)

nginx is rejecting the upload before it reaches Express:

```bash
# Check that nginx config has:
# client_max_body_size 110M;  (in the /api/ location block)
sudo nginx -t && sudo systemctl reload nginx
```

### Nuxt build fails

```bash
cd /home/forge/audit.icjia.app
pnpm clean                    # Clear caches
pnpm install --frozen-lockfile
pnpm --filter web build       # Retry
```

### Shared report links return 404

The SQLite database might be missing or in the wrong location:

```bash
ls -la apps/api/data/audit.db
# If missing, the app creates it on first start — restart PM2:
pm2 restart file-audit-api
```

---

*End of Deployment Guide — v2.0*
