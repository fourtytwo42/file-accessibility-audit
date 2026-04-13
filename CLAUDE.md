# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

Queue-driven PDF accessibility analysis and remediation platform. Scores PDFs against WCAG 2.1 / ADA Title II requirements (letter grade A–F). Does **not** modify PDFs in-place — the scoring and remediation pipeline produces improved PDFs and guidance reports.

Production: https://audit.icjia.app

## Repository Structure

Pnpm monorepo (Node 22, pnpm 9+):

- `apps/api/` — Express backend (TypeScript, port 6103)
- `apps/web/` — Next.js 15 / React 19 frontend (port 6102)
- `apps/cli/` — Optional CLI (`@icjia/a11y-audit`)
- `scripts/` — Batch orchestration (TypeScript, run with `tsx`)
- `audit.config.ts` — **Single source of truth for all constants** (weights, thresholds, ports, auth, branding). Edit here, never inline constants.
- `docs/00-master-design.md` — Full architecture reference
- `AGENTS.md` — Guide for running batch/agency scripts

## Commands

```bash
# Canonical Ubuntu VM path (API + local Gemma)
pnpm vm:provision      # Install runtime, local AI defaults, PM2, and llama.cpp bundle
pnpm stack:start       # Start or reload the PM2-managed API + local Gemma stack
pnpm stack:stop        # Stop and remove the PM2-managed API + local Gemma stack
pnpm stack:status      # Show PM2 app status + health summary + tool smoke result
pnpm stack:healthcheck # Verify runtime + LLM + vision + remediation smoke path

# Dev
pnpm dev              # Start API + Web together
pnpm dev:api          # API only (port 6103)
pnpm dev:web          # Web only (port 6102)

# Test
pnpm test             # All tests (Vitest)
pnpm test:api         # API tests only
pnpm test:web         # Web tests only
pnpm test:scoring     # Scoring regression fixtures
pnpm test:watch       # Watch mode

# Build & verify
pnpm build            # Type-check + build
pnpm verify:env       # Check remediation runtime + font bundle

# Post config-change
pnpm rebrand          # Regenerate static files after audit.config.ts changes
```

## Architecture

### Analysis Pipeline

`POST /api/engine/analyze` →
1. **Upload** (multer, memory storage, 100 MB limit, `%PDF-` magic-byte check)
2. **Extraction** — pdfjs-dist for text/metadata/fonts; QPDF for structure tree, outlines, form fields
3. **Scoring** (`apps/api/src/services/scorer.ts`) — 9 weighted categories, pure if-then logic, no AI
4. **Queue** — SQLite-backed state machine (`uploading→queued→processing→complete/failed`); SSE pushes live updates to the browser

### Scoring Categories (weights in `audit.config.ts → SCORING_WEIGHTS`)

Text Extractability 17.5%, Title & Language 13%, Heading Structure 13%, Alt Text 13%, Bookmarks 8.5%, Table Markup 8.5%, Link Quality 4.5%, Form Accessibility 4%, Reading Order 4%. N/A categories are excluded and weights redistributed.

### Remediation Engine

`apps/api/src/services/agentRemediationService.ts` + `remediationOrchestrator.ts` — multi-stage LLM-assisted repair. LLM traffic goes through an **OpenAI-compatible** provider chain (`OPENAI_COMPAT_*` in `apps/api/.env`, see `openAiCompatService.ts`). For a fully on-VM setup, prefer `pnpm vm:provision` then `pnpm stack:start`; that path configures the API for local tool-calling by default and runs local Gemma as a separate PM2-managed `llama-server` process. Semantic figure alt-text batches use OpenAI-style `image_url` parts; optional `SEMANTIC_REPAIR_INLINE_FIGURE_IMAGES=1` restores legacy base64-in-JSON. Deterministic fixes run first; LLM only called when heuristics are insufficient.

**Important:** Do NOT add `repair_other_elements_alt_text` to `finalCleanupCalls` — it regresses grades for non-native-tagged PDFs.

### Queue Store

`apps/api/src/services/queueStore.ts` — all queue CRUD, SQLite WAL mode. Unprocessed items recovered on restart. Stale uploads cleaned every 5 min.

### Authentication (optional)

Controlled by `audit.config.ts → AUTH.REQUIRE_LOGIN` (default off). When on: email OTP (`@illinois.gov` only), 6-digit / 15-min TTL / max 5 attempts. JWT httpOnly cookie, 72-hour expiry.

## Key Files

| File | Purpose |
|------|---------|
| `audit.config.ts` | All constants — edit here first |
| `apps/api/src/index.ts` | Express app startup, route mounting |
| `apps/api/src/engine/index.ts` | Public engine API (`analyzePdf`, `remediatePdf`, `verifyPdf`) |
| `apps/api/src/services/pdfAnalyzer.ts` | Core analysis pipeline |
| `apps/api/src/services/scorer.ts` | Grading logic (~2,100 LOC) |
| `apps/api/src/services/agentRemediationService.ts` | LLM-based repairs |
| `apps/api/src/services/queueStore.ts` | Queue state (SQLite) |
| `apps/api/src/db/sqlite.ts` | Schema init, WAL mode |
| `apps/web/app/page.tsx` | Main upload/queue UI |
| `apps/web/next.config.js` | Next.js config + API proxy |

## Testing Patterns

Fixtures live in `apps/api/src/__tests__/fixtures/` — real PDFs paired with `.expected.json` snapshots. Scoring tests are regression-style: run pipeline, diff against fixture. Add a fixture PDF + expected output when adding scoring logic.

## Environment

Copy `.env.example.local` → `.env` in both `apps/api/` and `apps/web/`. Root `.env` holds secrets (`DB_PATH`, `JWT_SECRET`, SMTP credentials) — never commit.

## Batch Scripts (ICJIA Corpus)

Long-running remediation waves are tracked in `ICJIA-PDFs/manifests/`. See `AGENTS.md` for the full staged workflow (Stage 0–8). Run individual scripts with `npx tsx scripts/<script>.ts`.
