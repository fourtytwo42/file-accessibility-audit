# Ubuntu 24.04 VM Setup

This project can bootstrap a fresh Ubuntu 24.04 LTS VM into a remediation-capable development environment.

## Supported Target

- Ubuntu `24.04 LTS`
- Internet access during bootstrap
- A user account with `sudo`

If you need to run on another Ubuntu release, set `ALLOW_UNSUPPORTED_UBUNTU=1` and rerun the bootstrap. That bypasses the release check but is not the supported path.

## One-Command Bootstrap

From the repo root:

```bash
git clone https://github.com/ICJIA/file-accessibility-audit.git
cd file-accessibility-audit
bash ./scripts/bootstrap-ubuntu.sh
pnpm dev
```

The bootstrap leaves the VM ready for `pnpm dev`. It does not leave long-running services started.

## What the Bootstrap Installs

System packages:

- Node.js `22.x`
- `pnpm`
- Python `3`
- `qpdf`
- Java `17`
- build tooling needed by native dependencies
- Microsoft core fonts and Carlito compatibility fonts

Project/runtime assets:

- Python helper packages from [`apps/api/scripts/requirements.txt`](../apps/api/scripts/requirements.txt)
- veraPDF under `.local-tools/verapdf/current/`
- managed font bundle under `.local-tools/fonts/legacy/`
- Playwright Chromium browser
- repo dependencies via `pnpm install`

Environment files:

- `apps/api/.env` from `apps/api/.env.example.local` when missing
- `apps/web/.env` from `apps/web/.env.example.local` when missing
- remediation/runtime paths written into `apps/api/.env`

## Managed Paths

The Ubuntu bootstrap standardizes local tool locations so the app does not depend on per-user machine paths:

- veraPDF: `.local-tools/verapdf/current/`
- Python helper venv: `.local-tools/python/`
- legacy fonts: `.local-tools/fonts/legacy/`

The bootstrap writes absolute values for these keys into `apps/api/.env`:

- `PYTHON_PATH`
- `PDF_FONT_DIRS`
- `LEGACY_FONT_DIRS`
- `VERAPDF_PATH`
- `JAVACMD`

## Verification

Run verification at any time:

```bash
bash ./scripts/verify-env.sh
```

Optional API smoke check:

```bash
bash ./scripts/verify-env.sh --smoke-api
```

JSON output for CI or automation:

```bash
bash ./scripts/verify-env.sh --json
```

You can also run the package.json aliases:

```bash
pnpm bootstrap:ubuntu
pnpm verify:env
```

## Overrides and Air-Gapped Prep

The bootstrap supports overriding download URLs through environment variables:

- `VERAPDF_DOWNLOAD_URL`
- `IBM_PLEX_ARCHIVE_URL`
- `SOURCE_SANS_ARCHIVE_URL`
- `LIBRE_BASKERVILLE_ARCHIVE_URL`
- `LIBERTINUS_ARCHIVE_URL`

Examples:

```bash
VERAPDF_DOWNLOAD_URL=https://internal.example/verapdf.zip bash ./scripts/bootstrap-ubuntu.sh
LIBERTINUS_ARCHIVE_URL=/mnt/assets/Libertinus-7.050.tar.zst bash ./scripts/bootstrap-ubuntu.sh
```

For an air-gapped VM, mirror the required assets internally and point the bootstrap at those mirrored URLs or mounted files.

## Useful Modes

Verify only:

```bash
bash ./scripts/bootstrap-ubuntu.sh --verify-only
```

Skip browser installation:

```bash
bash ./scripts/bootstrap-ubuntu.sh --skip-playwright
```

Run verification with API smoke test at the end:

```bash
bash ./scripts/bootstrap-ubuntu.sh --smoke-api
```

## Low-memory / small VM (unresponsive during processing)

If the VM becomes slow or unresponsive while PDFs are processing, the main consumers are:

- **veraPDF (Java)** — can use a lot of heap on large PDFs.
- **Node (API)** — holds buffers and document state.
- **Python (remediation)** — one subprocess per run, moderate memory.

The following limits are already set or recommended:

| Control | Where | Effect |
|--------|--------|--------|
| `JAVA_TOOL_OPTIONS=-Xmx768m` | `apps/api/.env` | Caps the Java heap used by veraPDF (e.g. 768 MB). Lower to `512m` if the VM has very little RAM. |
| `--max-old-space-size=512` | API `start` / `dev` scripts | Caps Node’s heap (512 MB). |
| `QUEUE_MAX_PARALLEL=1` | `apps/api/.env` | Only one PDF processed at a time; reduces peak memory and keeps the VM responsive (see [SSH tunnel](#ssh-tunnel-and-remote-access)). |

After changing `.env`, restart the API. If the VM still struggles, try `JAVA_TOOL_OPTIONS=-Xmx512m` and ensure `QUEUE_MAX_PARALLEL=1`.

## SSH tunnel and remote access

When you run the app on a VM and access it via an SSH tunnel, heavy processing (veraPDF, Python remediation) can load the VM enough that the tunnel goes idle or the connection drops. You may see the tunnel repeatedly close and re-establish.

**Keep the tunnel alive (on your local machine):**

Use keepalives so the SSH client sends traffic regularly and the tunnel is not treated as idle:

```bash
ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -L 6102:127.0.0.1:6102 -L 6103:127.0.0.1:6103 user@your-vm
```

- `ServerAliveInterval=30` — send a keepalive every 30 seconds
- `ServerAliveCountMax=6` — allow several missed replies before disconnecting

**Reduce load so the VM stays responsive:**

Limit how many PDFs are processed at once so CPU/memory don’t starve SSH:

In `apps/api/.env`:

```bash
# Process one PDF at a time (default is 5). Use when running over SSH on a small VM.
QUEUE_MAX_PARALLEL=1
```

Restart the API after changing this. Processing will be slower but the tunnel should stay up.

## Troubleshooting

### Playwright Chromium did not launch

- Re-run `pnpm --filter api exec playwright install chromium`
- Then rerun `bash ./scripts/verify-env.sh`

### veraPDF path or Java path is wrong

- Check `apps/api/.env` for `VERAPDF_PATH` and `JAVACMD`
- Confirm the files exist and are executable
- Re-run `bash ./scripts/bootstrap-ubuntu.sh --verify-only`

### Python helper packages failed to install

- Check that Python 3, `python3-venv`, and build prerequisites installed cleanly
- Re-run the bootstrap after network or package mirror issues are resolved
- The helper runtime lives in `.local-tools/python/`

### Legacy font download failed

- Re-run the bootstrap once connectivity is restored
- If a single upstream source is blocked, override the corresponding `*_ARCHIVE_URL`
- Verify the final staged files with `bash ./scripts/verify-env.sh`

### qpdf was not found

- Confirm `apt` succeeded
- Check `qpdf --version`
- Re-run the bootstrap if package installation was interrupted

### SSH tunnel keeps closing during processing

- Use keepalives when opening the tunnel: `-o ServerAliveInterval=30 -o ServerAliveCountMax=6` (see [SSH tunnel and remote access](#ssh-tunnel-and-remote-access)).
- Set `QUEUE_MAX_PARALLEL=1` in `apps/api/.env` and restart the API so only one PDF is processed at a time; this reduces CPU/memory spikes that can make the VM unresponsive and drop the connection.

### Bootstrap rerun behavior

- It is safe to rerun the bootstrap
- Existing `.env` files are preserved, but remediation path keys are refreshed
- Managed tools under `.local-tools/` are restaged to the expected layout
