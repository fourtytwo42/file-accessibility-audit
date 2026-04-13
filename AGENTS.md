# Agency API Guide

This file is for operating instructions. Durable project facts and "don't forget this" state live in:

- `/home/hendo420/pdfaf/MEMORY.md`
- `/home/hendo420/pdfaf/docs/12-icjia-corpus-and-general-api-roadmap.md`

## Memory Rule

- Read `MEMORY.md` whenever:
  - context is compacted
  - a new/fresh chat starts
  - anything important seems uncertain
  - you need current project state, counts, storage layout, prior decisions, or known exceptions
- If the contents of `MEMORY.md` are not already known in-context, read it before making assumptions.
- Any time a lasting fact changes, a mistake is corrected, a workflow decision is proven, or something should be remembered later, update `MEMORY.md`.

## Roadmap Rule

- Read `docs/12-icjia-corpus-and-general-api-roadmap.md` whenever:
  - a task is about stage planning, sequencing, or “what’s next”
  - the user asks about Stage `0` through Stage `8`
  - you need the current stage goal, endgate, or roadmap status
  - you need to know whether a stage is done, active, or not yet started
- Treat the roadmap doc as the canonical staged-plan reference for:
  - ICJIA corpus completion
  - general PDF accessibility API extraction
  - stage goals and endgates
- If the staged roadmap changes, update `docs/12-icjia-corpus-and-general-api-roadmap.md` and record the durable outcome in `MEMORY.md`.

## Purpose

- For a fresh Ubuntu 24.04 VM that needs the local API + Gemma stack, prefer:
  - `bash ./scripts/provision-vm.sh`
  - `bash ./scripts/start-stack.sh`
- For that VM path, PM2 is the supported operational surface:
  - `file-audit-llm`
  - `file-audit-api`
- Use the agency API to enumerate publication records.
- Identify which publication records point to PDF files.
- Verify authentication before any bulk operation.
- Keep read-only discovery separate from write/update operations.

## Environment

Store agency connection details in the root `.env` file.

Required variables:

- `AGENCY_STRAPI_BASE_URL`
- `AGENCY_STRAPI_GRAPHQL_URL`
- `AGENCY_STRAPI_CONTENT_TYPE`
- `AGENCY_STRAPI_USERNAME`
- `AGENCY_STRAPI_PASSWORD`
- `ICJIA_ARCHIVE_SSH_KEY_PATH`
- `ICJIA_ARCHIVE_SSH_PUBLIC_KEY_PATH`

## Read-Only Connection Test

Use this command first:

```bash
pnpm agency:test
```

What it does:

- loads the root `.env`
- logs into Strapi admin
- verifies the authenticated user
- queries GraphQL publication counts
- reports how many publication rows have PDF `fileURL` values

Current helper script:

- `scripts/test-agency-strapi.ts`

## Authentication

Admin login endpoint:

```text
POST /admin/login
```

Base URL:

```text
https://agency.icjia-api.cloud
```

## GraphQL Usage

GraphQL endpoint:

```text
https://agency.icjia-api.cloud/graphql
```

Read-only queries are allowed and are the default path for discovery.

Useful queries:

Count all publication records:

```graphql
{
  publicationsConnection {
    aggregate {
      count
    }
  }
}
```

List publication rows:

```graphql
query PublicationsPage($start: Int!, $limit: Int!) {
  publications(start: $start, limit: $limit) {
    id
    title
    slug
    fileURL
    articleURL
    publicationDate
    pubType
    verified
  }
}
```

## Write Safety

- Do not write to Strapi unless the user explicitly asks for it.
- Do not assume GraphQL mutations are enabled for `publications`.
- Prefer REST for eventual upload/replace work if GraphQL mutations are disabled.
- Before any write operation:
  - export a rollback manifest
  - download the current original files
  - record publication ids and current `fileURL` values
  - verify replacement filenames carefully
- Before replacing any file, determine whether it is:
  - a legacy archive PDF
  - a Strapi upload-style PDF
- Use the replacement strategy appropriate to that storage model.

## Versioning Warning

This Strapi 3 instance does not currently appear to expose built-in content revisioning or file version history.

Operational rule:

- treat replacements as overwrites unless proven otherwise
- create your own backup manifest before bulk replace

## Bulk Workflow

Recommended order:

1. Run `pnpm agency:test`.
2. Export the publication list.
3. Filter to rows whose `fileURL` ends in `.pdf`.
4. Classify each PDF as `legacy_archive` or `strapi_upload`.
5. Back up the targeted records and source PDFs.
6. Run remediation in bulk.
7. Produce CSV/HTML reports.
8. Only after backup and validation, perform controlled replacement.

## Workspace Layout

Bulk publication-processing workspace:

- `ICJIA-PDFs/`

Key subfolders:

- `ICJIA-PDFs/backups/`
- `ICJIA-PDFs/downloads/`
- `ICJIA-PDFs/artifacts/`
- `ICJIA-PDFs/reports/`
- `ICJIA-PDFs/staging/`
- `ICJIA-PDFs/manifests/`
- `ICJIA-PDFs/logs/`
- `ICJIA-PDFs/db/`
- `ICJIA-PDFs/webapp/`

Use this workspace for:

- publication snapshots
- source PDF backups
- remediated outputs
- test reports
- failure reports
- replacement staging
- future SQLite tracking

## Priority Remediation Batch

Current fix-first input manifest:

- `ICJIA-PDFs/manifests/remediation-priority-candidates.json`
- `ICJIA-PDFs/manifests/remediation-priority-candidates.summary.json`

Current selection policy:

- process `highest`, then `high`, then `medium`
- run up to `8` files at a time for remediation
- skip anything already covered by the passing/replacement trackers

Batch runner:

- script:
  - `scripts/run-priority-remediation-batch.ts`
- command:
  - `pnpm agency:run-priority-remediation`

Runtime controls:

- `ICJIA_REMEDIATION_CONCURRENCY`
  - default: `8`
- `ICJIA_REMEDIATION_LIMIT`
  - optional smoke-test cap for the first `N` priority candidates
- `ICJIA_REMEDIATION_TIMEOUT_MS`
  - default: `3600000`
  - if a single PDF runs longer than this without reaching a terminal outcome, record it as `processing_error`
  - use reason code:
    - `excessive_runtime_loop`
  - mark it:
    - `skipNextBatch: true`
  - then continue to the next PDF instead of letting the batch stall
- `ICJIA_REMEDIATION_MIN_PASS_SCORE` (optional)
  - when set (e.g. `90`), the batch uses the relaxed promotion gate from `evaluatePromotionGate` with `minOverallScore` (not scanned, no critical manual-review flags) for pass/staging and outcome `remediated_pass_candidate`, instead of strict grade **A** / score **100**
  - unset keeps the engine default strict gate for that batch
- `ICJIA_REMEDIATION_MIN_KEEP_SCORE` (optional)
  - when set (e.g. `80`), remediated PDF bytes under the batch artifact root are deleted after the row finishes if the final overall score is **below** this value (`<` threshold), unless the row **passes** the effective gate; scores **≥** the threshold are kept (so `80` keeps **80+** on failures)
  - unset keeps every remediated PDF on disk (current default)

Current output locations:

- resumable batch outcomes:
  - `ICJIA-PDFs/manifests/remediation-batch-outcomes.json`
- batch summary:
  - `ICJIA-PDFs/manifests/remediation-batch-outcomes.summary.json`
- per-file detailed remediation reports:
  - `ICJIA-PDFs/reports/test-runs/remediation-batch/`
- per-file failure reports:
  - `ICJIA-PDFs/reports/failures/remediation-batch/`
- remediated PDFs:
  - `ICJIA-PDFs/artifacts/remediated-pdfs/priority-batch/`
- remediation attempt artifacts:
  - `ICJIA-PDFs/artifacts/remediation-attempts/priority-batch/`
- staged ready-to-replace files:
  - `ICJIA-PDFs/staging/to-replace/`

Pass/ready rule:

- default (strict): mark `remediated_pass_candidate` / stage only when the remediated result has:
  - grade `A`
  - score `100`
  - no blocking local-standards findings
  - no critical manual-review flags
  - no scored categories below `100`, except:
    - `Color Contrast`
- optional: set `ICJIA_REMEDIATION_MIN_PASS_SCORE` to use a minimum overall score (and the same not-scanned / no-critical-flags rules as manual MCP relaxed mode) instead of strict **A**/**100** for this batch only
- otherwise record as `failed_after_remediation` with detailed reasons and artifacts

Operational rule:

- do not replace on remote during this batch
- remediate locally first
- stage only the PDFs that are confirmed `ready_to_replace`
- keep detailed JSON evidence for failures so similar problems can be grouped and fixed later
- if a PDF exceeds the runtime timeout, treat it as broken/deferred for the current wave and do not let it block the batch

## Manual Figure Final-Mile Lane

Use this lane for hard-but-salvageable PDFs that are already close to passing after automation and should be pulled out of automatic retry waves.

Current helper commands:

- build the durable manual queue:
  - `pnpm agency:build-manual-worklist`
- compatibility alias:
  - `pnpm agency:build-manual-fix-candidates`
- run a local manual figure-final-mile pass for one publication:
  - `pnpm agency:manual-figure-final-mile <publicationId>`
- run the MCP-driven manual batch:
  - `pnpm agency:run-manual-mcp-batch`
  - with no arguments, loads the legacy four-id figure-canary cohort (`4150`, `3671`, `4169`, `4590`) from `ICJIA-PDFs/manifests/pass-rate-figure-canary.json` (same as before).
  - manifest-driven next wave (recommended):
    - `pnpm agency:run-manual-mcp-batch -- --manifest` uses `ICJIA-PDFs/manifests/manual-mcp-next-batch.json` for ids, titles, and rationales, and merges `ICJIA-PDFs/manifests/publication-pdf-replacement-map.json` for `serverHost` and cache paths.
    - optional explicit manifest path: `pnpm agency:run-manual-mcp-batch -- --manifest ICJIA-PDFs/manifests/manual-mcp-next-batch.json`
    - optional subset (tranche order preserved): `pnpm agency:run-manual-mcp-batch -- --manifest 4079 4192 4726`
  - map-only ids (no batch manifest): `pnpm agency:run-manual-mcp-batch -- 4192` resolves the publication from the replacement map and remediated tree only.
  - resolve candidates and run `full_final` prefilter without MCP: `pnpm agency:run-manual-mcp-batch -- --manifest --dry-run` (add numeric ids after `--manifest` to filter).
  - optional single-file rerun:
    - `pnpm agency:run-manual-mcp-batch <publicationId>`
- build the following manual MCP wave manifest (after the current next batch is closed):
  - `pnpm agency:build-manual-mcp-next-batch-v2`
  - writes `ICJIA-PDFs/manifests/manual-mcp-next-batch-v2.json` and `manual-mcp-next-batch-v2.summary.json` using the corpus control plane, manual outcome ledger, replacement map, `full_final` preflight, and excludes ids still listed on `manual-mcp-next-batch.json`.

Current manual queue artifacts:

- manual queue manifest:
  - `ICJIA-PDFs/manifests/manual-worklist.json`
- manual queue summary:
  - `ICJIA-PDFs/manifests/manual-worklist.summary.json`
- manual outcome ledger:
  - `ICJIA-PDFs/manifests/manual-worklist.outcomes.json`
- manual outcome summary:
  - `ICJIA-PDFs/manifests/manual-worklist.outcomes.summary.json`
- per-file manual reports:
  - `ICJIA-PDFs/reports/manual-figure-final-mile/`
- per-file manual output PDFs:
  - `ICJIA-PDFs/artifacts/remediated-pdfs/manual-figure-final-mile/`
- staged manual replacements:
  - `ICJIA-PDFs/staging/to-replace/manual-worklist/`
- MCP manual batch manifest:
  - `ICJIA-PDFs/manifests/manual-mcp-batch.json`
- MCP manual batch summary:
  - `ICJIA-PDFs/manifests/manual-mcp-batch.summary.json`
- MCP per-file manual reports:
  - `ICJIA-PDFs/reports/manual-mcp-batch/`
- MCP per-file manual output PDFs:
  - `ICJIA-PDFs/artifacts/remediated-pdfs/manual-mcp-batch/`
- MCP staged manual replacements:
  - `ICJIA-PDFs/staging/to-replace/manual-mcp-batch/`

Manual statuses:

- `manual_ready_to_replace`
- `manual_terminalized`
- `manual_in_progress`
- `manual_deferred`

Manual-lane operating rules:

- start from the best local remediated artifact, not from live replacement paths
- use the fixed 12-row manual wave as the first hard queue and work it in priority order
- judge manual completion by `full_final`, not `remediation_fast`
- `remediation_fast` may be used for iteration, but never as the final decision surface
- when using the PDF MCP server, treat MCP as the mutation/inspection surface and still validate the final decision with the normal `full_final` gate
- do not send already-passing PDFs into the MCP manual batch; exclude them up front by checking the best local input with `full_final`
- if a supposedly hard candidate is already passing locally, treat that as a selection mistake and fix the selector instead of processing it
- keep explicit manual reasons in the outcomes ledger so the control plane can explain why a PDF was manually mitigated
- `manual_terminalized` is a valid success state when it removes a PDF from automation retry budgets with a recorded reason
- do not let manually mitigated rows drift back into throughput lanes, runtime retry lanes, or replacement-likelihood selection
- `manual_ready_to_replace` should remain visible to normal verification/replacement flow as distinct from automated-ready rows

## Default Rule

- Discovery is safe by default.
- Replacement is never implicit.
- Always verify auth, counts, backup state, `MEMORY.md`, and the roadmap doc before touching live content or making stage-planning claims.
