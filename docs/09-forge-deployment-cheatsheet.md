# Forge Deployment Cheatsheet

**Domain:** audit.icjia.app
**Repo:** https://github.com/ICJIA/file-accessibility-audit
**Branch:** main

---

## Step 1: SSH In and Install System Dependencies

```bash
ssh forge@<droplet-ip>
sudo apt update && sudo apt install -y qpdf
npm install -g pnpm

# Verify
node -v        # Must be 22+
qpdf --version # Must be 11+
pnpm -v        # Must be 9+
```

---

## Step 2: Create the Site in Forge

1. Server → **Sites** → **New Site**
2. Domain: `audit.icjia.app`
3. Project type: **Static HTML / Proxy**
4. Web directory: `/public` (unused but required by Forge)

---

## Step 3: Connect GitHub Repository

1. Site → **Git Repository** section
2. Provider: **GitHub**
3. Repository: `ICJIA/file-accessibility-audit`
4. Branch: `main`
5. **Uncheck** "Install Composer Dependencies"
6. Click **Install Repository**

Forge clones to `/home/forge/audit.icjia.app`.

---

## Step 4: Create Environment Files

```bash
cd /home/forge/audit.icjia.app

# API environment
cp apps/api/.env.example.local apps/api/.env
nano apps/api/.env
```

Set these values in `apps/api/.env`:

```env
NODE_ENV=production
PORT=6103
JWT_SECRET=<run: openssl rand -hex 32>
DB_PATH=./data/audit.db
SMTP_USER=postmaster@icjia.cloud
SMTP_PASS=<your-mailgun-smtp-password>
ADMIN_EMAILS=admin@icjia.illinois.gov
ALLOWED_DOMAINS=
MAX_FILE_SIZE_MB=100
TMP_DIR=/tmp
```

> **If auth is disabled** (the default — `REQUIRE_LOGIN: false` in `audit.config.ts`), `JWT_SECRET`, `SMTP_USER`, and `SMTP_PASS` are not needed. The app works without any email provider.

```bash
# Web environment
cp apps/web/.env.example.local apps/web/.env
```

The web `.env` only needs:

```env
NUXT_PUBLIC_APP_NAME=ICJIA File Accessibility Audit
```

---

## Step 5: First Build and PM2 Start

```bash
cd /home/forge/audit.icjia.app

# Create SQLite data directory
mkdir -p apps/api/data

# Install and build
pnpm install --frozen-lockfile
pnpm build

# Start both services via PM2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup    # auto-restart on server reboot — run the command it outputs
```

Verify:

```bash
pm2 status                                # Both "online"
curl -s http://localhost:6103/api/health   # { "status": "ok" }
curl -s http://localhost:6102 | head -5    # HTML from Nuxt
```

---

## Step 6: Forge Deploy Script

Site → **Apps** tab → **Deploy Script** — paste this:

```bash
cd /home/forge/audit.icjia.app

git pull origin main

pnpm install --frozen-lockfile

pnpm build

if pm2 describe file-audit-api > /dev/null 2>&1; then
    pm2 reload ecosystem.config.cjs --update-env
else
    pm2 start ecosystem.config.cjs
    pm2 save
fi
```

Then toggle **Quick Deploy → ON**. Every push to `main` now auto-deploys.

---

## Step 7: nginx Configuration

Site → **nginx** tab → Edit the config. Replace the location blocks with:

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name audit.icjia.app;

    # ── Keep Forge's SSL lines as-is ──
    # ssl_certificate     /etc/nginx/ssl/audit.icjia.app/.../server.crt;
    # ssl_certificate_key /etc/nginx/ssl/audit.icjia.app/.../server.key;

    server_tokens off;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    # ── Proxy 1: API (Express on port 6103) ──
    # MUST come before the catch-all / block
    location /api/ {
        proxy_pass http://127.0.0.1:6103;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 110M;
        proxy_read_timeout 60s;
    }

    # ── Proxy 2: Frontend (Nuxt SSR on port 6102) ──
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

    # ── Static asset caching ──
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot|webmanifest)$ {
        proxy_pass http://127.0.0.1:6102;
        proxy_set_header Host $host;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}

# HTTP → HTTPS redirect
server {
    listen 80;
    listen [::]:80;
    server_name audit.icjia.app;
    return 301 https://$host$request_uri;
}
```

**The two proxies:**

| Location | Port | Service |
|----------|------|---------|
| `/api/` | 6103 | Express API — PDF analysis, auth, shared reports |
| `/` | 6102 | Nuxt SSR — all pages, components, static assets |

---

## Step 8: SSL

Site → **SSL** tab → **Let's Encrypt** → Forge provisions and auto-renews.

Make sure the DNS A record for `audit.icjia.app` points to the droplet IP first.

---

## Step 9: Firewall

DigitalOcean → Networking → Firewalls:

| Port | Allow From |
|------|-----------|
| 22 | Your IP |
| 80 | Anywhere |
| 443 | Anywhere |

Block everything else. Ports 6102/6103 are localhost-only behind nginx.

---

## Step 10: Verify

From your browser:

- `https://audit.icjia.app` → landing page with PDF dropzone
- `https://audit.icjia.app/api/health` → `{ "status": "ok" }`
- `https://audit.icjia.app/robots.txt` → robots directives
- `https://audit.icjia.app/og-image.png` → OG image

Upload a test PDF and verify the full analysis flow works.

---

## Quick Reference: PM2 Commands

```bash
pm2 status                    # Check both processes
pm2 logs                      # Tail all logs
pm2 logs file-audit-api       # API logs only
pm2 logs file-audit-web       # Web logs only
pm2 restart ecosystem.config.cjs              # Restart all services at once
pm2 reload ecosystem.config.cjs --update-env  # Zero-downtime restart (picks up env changes)
pm2 restart file-audit-api    # Restart API only
pm2 restart file-audit-web    # Restart web only
pm2 monit                     # Real-time CPU/memory
```

## Quick Reference: Manual Redeploy

```bash
cd /home/forge/audit.icjia.app
git pull origin main
pnpm install --frozen-lockfile
pnpm build
pm2 restart ecosystem.config.cjs   # Restart all services
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| 502 Bad Gateway | `pm2 status` — processes crashed. `pm2 logs` to see why, then `pm2 restart all` |
| 413 Entity Too Large | nginx needs `client_max_body_size 110M;` in the `/api/` block |
| QPDF errors | `qpdf --version` — install with `sudo apt install qpdf` |
| Port already in use | `lsof -i :6102` / `lsof -i :6103` and kill the stale process |
| Nuxt build fails | `pnpm clean && pnpm install --frozen-lockfile && pnpm build` |
