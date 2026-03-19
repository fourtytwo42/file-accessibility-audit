# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Root (run from `/home/hendo420/pdfaf`):**
```bash
pnpm dev              # Start API (port 6103) + Web (port 6102) in dev mode
pnpm dev:api          # API only
pnpm dev:web          # Web only
pnpm test             # All tests (API + Web)
pnpm test:api         # API tests only
pnpm test:scoring     # Scoring model tests only (fast, targeted)
pnpm build            # Type-check API + build Next.js frontend
```

**API (run from `apps/api`):**
```bash
npx vitest run                          # All API tests
npx vitest run --testPathPattern=scorer # Single test file
npx vitest run --reporter=verbose       # Verbose output
```

After changing any constant in `audit.config.ts`, always run `pnpm test:scoring` to verify scoring still produces expected results.

## Architecture

This is a **pnpm monorepo** with three apps: `apps/api` (Express/TypeScript backend), `apps/web` (Next.js 15 frontend), and `apps/cli` (command-line auditor). The API is the core — the web and CLI are thin clients over it.

### Single source of truth

**`audit.config.ts`** (root) — Every configurable constant lives here: scoring weights, grade thresholds, rate limits, queue limits, branding, auth settings. No magic numbers anywhere in services. If adding a constant, put it here first and import via the `#config` path alias.

### Analysis pipeline (`apps/api/src/services/`)

`analyzePDF()` in `pdfAnalyzer.ts` is the entry point for all analysis. It fans out in parallel to:
- **`qpdfService.ts`** — QPDF CLI wrapper; extracts structural data (tags, headings, images, outlines, form fields)
- **`pdfjsService.ts`** — PDF.js; extracts text content, links, metadata, page count
- **`veraPdfService.ts`** — veraPDF CLI wrapper for PDF/UA standards validation; results are cached by buffer SHA-256 to skip redundant 30–120s runs
- **`adobePdfServices.ts`** — Optional Adobe PDF Services API (disabled by default)

Results feed into **`scorer.ts`** which produces a score across 11 weighted categories (null = N/A, excluded from weight renormalization). Grade thresholds: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60.

### Remediation pipeline

The agent-driven remediation loop lives in **`agentRemediationService.ts`**:

1. Analyze PDF → identify failures via **`failureProfileService.ts`**
2. Plan tool sequence via **`remediationPlanService.ts`** (OpenRouter LLM or deterministic fallback)
3. Execute tools from **`pdfRemediationTools.ts`** (40+ tools) in stage order
4. Re-analyze; track regressions — roll back entire stages that regress without improving targets
5. Repeat up to 5 rounds; always run a 5-tool final cleanup pass before returning

Heavy PDF structure mutations run through **`pdfStructureBackend.ts`** which spawns `apps/api/scripts/pdf_structure_helper.py` (pikepdf-based). Use `runPdfStructureBackendBatch()` when running multiple mutations on the same document to avoid repeated subprocess overhead — the `batch_mutate` operation applies all mutations in one Python process invocation.

After semantic AI fixes, **`semanticEnrichmentService.ts`** handles AI-driven bookmark cleanup, figure alt text generation, and reading order repair via OpenRouter.

### Queue system

PDFs are uploaded into a persistent queue backed by **SQLite** (`data/audit.db`, WAL mode). Key services:
- **`queueStore.ts`** — CRUD, item lifecycle, state machine (`queued → processing → done/error`)
- **`queueManager.ts`** — concurrency control (max 2 concurrent analyses), restart recovery
- **`queueEvents.ts`** — Server-Sent Events for real-time progress to the frontend

Queue items persist to disk at `data/queue/<id>/`. The `DocumentModel` JSON (from `documentModel.ts`) is the authoritative record of all remediation iterations, applied actions, and manual review flags for each PDF.

### Database schema

Tables: `queue_items`, `sessions`, `otp_codes`, `browser_clients`, `shared_reports`, `audit_log`. Schema lives in `apps/api/src/db/sqlite.ts` with idempotent `ensureColumn()` migrations — never use `ALTER TABLE` directly; add columns via `ensureColumn()`.

### Authentication

Optional email OTP → JWT (httpOnly cookie). Auth is gated on `illinois.gov` email domains by default (configurable in `audit.config.ts`). The `authMiddleware` and `adminMiddleware` are in `apps/api/src/middleware/auth.ts`.

## Remediation Campaign (AGENTS.md)

When running the remediation campaign against PDFs in `Downloads/`:

- **Target**: every PDF reaches `100/100`, grade `A`, `veraPDF: passed`, and passes a visual first-page comparison
- **Progress tracker**: `REMEDIATION_PROGRESS.md` — update it when starting a file, hitting blockers, making system fixes, or completing a file
- **Output**: passing PDFs go to `Mitigated/`; intermediate attempts go to `MitigationAttempts/<base-name>/attempt-NNN.pdf`
- **Git discipline**: one commit per distinct system fix (not per rerun); push after each commit; run relevant tests before committing
- **Improvement mindset**: if a PDF fails, fix the shared system (services, planner, scorer, Python helper) generically — not just for that one file
- **Resume**: on context reset, read `REMEDIATION_PROGRESS.md` → `Current Session Snapshot` first

## Testing conventions

- All API tests use **Vitest** (not Jest — ignore any Jest config artifacts)
- Tests heavily mock `executeRemediationTool`, `inspectPdfForRemediation`, `analyzePDF`, and `planRemediationActions` via `vi.mock`
- Integration tests in `integration.test.ts` actually invoke the full analysis pipeline on fixture PDFs — they are slow (~30s) and run last
- The `agentRemediationService.test.ts` mocks track exact call counts and ordered return values; when adding new behavior that adds tool calls (e.g., a new cleanup stage), update the mock sequence and expected call counts accordingly

## Key conventions

- **No compilation step**: the API runs directly via `tsx`; `tsc --noEmit` is only for type checking
- **Path alias**: `#config` resolves to the root `audit.config.ts`
- **Abort signals**: pass `options?.signal` through the entire analysis/remediation call chain; check `signal.aborted` before expensive operations
- **veraPDF caching**: always call `getVeraPdfCached()` (in `pdfAnalyzer.ts`) rather than `analyzeWithVeraPdf()` directly during multi-round remediation
- **Scoring N/A**: a `null` score means the category is not applicable; the overall score renormalizes weights to exclude null categories
