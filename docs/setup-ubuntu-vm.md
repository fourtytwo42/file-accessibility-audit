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

### Bootstrap rerun behavior

- It is safe to rerun the bootstrap
- Existing `.env` files are preserved, but remediation path keys are refreshed
- Managed tools under `.local-tools/` are restaged to the expected layout
