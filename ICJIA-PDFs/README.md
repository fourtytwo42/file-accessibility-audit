# ICJIA PDFs Workspace

This folder is the working area for bulk publication-PDF processing from the ICJIA agency API.

Planned pipeline:

1. discover publication records from Strapi
2. download source PDFs
3. run initial testing
4. remediate candidate PDFs
5. run post-remediation testing
6. if passing, stage for replace/upload
7. if not passing, retain detailed failure data for later sorting and fixes

## Folder Map

- `config/`
  Environment-specific config, mapping files, and future replace settings.

- `db/`
  Home for the future SQLite database that tracks every PDF, every test run, and every replace attempt.

- `logs/`
  Batch logs, runner logs, and operational traces.

- `manifests/`
  API export manifests, download manifests, cohort lists, and batch inventories.
  This is also where the publication-to-server replacement map lives.

- `backups/`
  Read-only safety copies before any replacement work.

- `backups/server-cache/`
  Server-synced local working cache grouped by source host, used so remediation can run locally without re-fetching individual PDFs from live servers.

- `backups/publication-snapshots/`
  JSON/CSV snapshots of publication records before changes.

- `backups/original-pdfs/`
  Original PDFs downloaded from current publication `fileURL` values.

- `downloads/`
  Working intake area for PDFs pulled from the agency API.

- `downloads/source-pdfs/`
  First-download source files from publication URLs.

- `downloads/retry-pdfs/`
  Files re-queued for later retry or reprocessing.

- `artifacts/`
  Outputs produced during testing and remediation.

- `artifacts/remediated-pdfs/`
  Candidate remediated PDFs before final replace decisions.

- `artifacts/page-1-screenshots/original/`
  Page-1 screenshots from the original PDFs.

- `artifacts/page-1-screenshots/remediated/`
  Page-1 screenshots from remediated PDFs.

- `artifacts/diffs/`
  Visual comparisons, structured diffs, and comparison artifacts.

- `reports/`
  Durable reporting outputs for review and later triage.

- `reports/test-runs/initial/`
  Initial test results before remediation.

- `reports/test-runs/remediated/`
  Post-remediation test results.

- `reports/failures/`
  Detailed per-PDF failure reports for PDFs that do not pass.

- `reports/exports/html/`
  Future HTML dashboards and export reports.

- `reports/exports/csv/`
  Future CSV exports.
  The replacement-map CSV is written here now.

- `queue/`
  Batch control files, run lists, and future orchestrator state.

- `staging/`
  Final operational staging before and after replacement.

- `staging/to-replace/`
  Passing PDFs ready for controlled upload/replace.

- `staging/replaced/`
  PDFs that were successfully replaced in Strapi.

- `staging/failed/`
  PDFs whose replace step failed or needs operator review.

- `webapp/`
  Placeholder for a future monitoring UI.

- `docs/`
  Process notes and operational docs for this bulk pipeline.

## Data Model Direction

The preferred long-term tracker is a SQLite database rather than one JSON file per failed PDF.

Suggested future responsibility for the DB:

- one row per publication/PDF
- one row per download attempt
- one row per test run
- one row per remediation attempt
- one row per replace/upload attempt
- links to backup files, reports, screenshots, and final status

## Status Vocabulary

Suggested future statuses:

- `discovered`
- `downloaded`
- `tested-initial`
- `remediated`
- `tested-remediated`
- `ready-to-replace`
- `replaced`
- `failed`
- `deferred`

## Current Mapping Artifacts

- Build the current replacement map with:
  - `pnpm agency:build-replacement-map`

- Sync the current server-backed source PDFs into the local server cache with:
  - `pnpm agency:sync-server-cache`

- Scan the remaining non-passing cached source PDFs and write one JSON report per file with grouped blocker summaries:
  - `pnpm agency:scan-remaining`

- Outputs:
  - `manifests/publication-pdf-replacement-map.json`
  - `manifests/publication-pdf-replacement-map.summary.json`
  - `reports/exports/csv/publication-pdf-replacement-map.csv`
  - `manifests/server-cache/*.files-from.txt`
  - `manifests/server-cache-sync.summary.json`
  - `reports/test-runs/source-scan/**/*.json`
  - `manifests/remaining-source-scan.summary.json`
  - `manifests/remaining-source-scan-groups.json`
  - `reports/exports/csv/remaining-source-scan-groups.csv`

What the map answers for each live publication-backed PDF:

- publication id and title
- current `fileURL`
- storage kind:
  - `legacy_archive`
  - `agency_upload`
  - `researchhub_upload`
- target server and SSH host
- exact remote filesystem path for eventual SFTP replacement
- known-presence state for the currently broken files

What the server cache adds:

- one local copy of each replaceable source PDF grouped by source server
- deterministic host/path layout for later bulk remediation
- a path-preserving local cache that lines up with the eventual SFTP replace target

What the source scan adds:

- one JSON report per remaining source PDF that is not already represented by a passing `Complete/` import
- grouped blocker-family counts to help batch similar fixes together
- grouped blocking-finding counts to reveal repeated systemic issues across the corpus

## Rule

Keep this workspace organized so any single PDF can be traced from:

- original publication record
- original file backup
- initial test result
- remediated candidate
- post-remediation result
- replace decision
- final outcome
