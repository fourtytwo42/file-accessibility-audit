# WCAG 2.1 AA Full-Corpus Remediation Notes

This file tracks remediation-wave outcomes, failure patterns, timeout patterns, score deltas, and API/tooling improvement opportunities discovered during corpus execution.

## Baseline

- Timestamp: 2026-04-03T00:00:00Z
- Baseline source: `ICJIA-PDFs/manifests/corpus-control-plane.summary.json`
- Total rows: 1056
- Verified pass rows: 92
- Remaining non-verified rows: 964
- Active automated lanes at start: Stage 3 figure wave, Stage 4 structure wave
- Stage 5 font lane at start: closed (`selectedRows: 0`; `font_unicode_terminal_survivor: 1`; `font_unicode_manual_residual: 13`)

## Partial Wave Note: Stage 4 Pending Flush

- Timestamp: 2026-04-03T03:29:30Z
- Manifest: `ICJIA-PDFs/manifests/stage4-structure-wave.json`
- Outcomes summary: `ICJIA-PDFs/manifests/stage4-structure-wave.outcomes.summary.json`
- Requested 8 pending IDs; 2 reached terminal outcomes before the wrapper was interrupted to avoid a long verification tail
- Terminal results recorded:
  - `3635` `failed_after_remediation` (`16 -> 80`, blocker: `pdfua.figure_alt_or_artifact`)
  - `3643` `failed_after_remediation` (`18 -> 80`, blocker: `pdfua.figure_alt_or_artifact`)
- Current resumable truth after rebuild:
  - pending IDs: `4162`, `4077`, `4108`, `4122`, `4124`, `4125`
  - `pnpm exec tsx scripts/run-stage4-structure-wave.ts --pending-only` now rebuilds to `eligibleRows: 6`
- Pass rate for completed rows so far: `0 / 2`
- Top blocking finding keys so far:
  - `pdfua.figure_alt_or_artifact`
- Timeout pattern so far:
  - no terminal `excessive_runtime_loop` rows recorded yet
- Score delta pattern so far:
  - both completed short reclassified rows improved strongly but flattened at figure debt rather than structure debt
- Tooling signal:
  - use the outcomes manifest itself, not only the derived outcomes summary, to confirm which pending IDs have actually reached terminal state

## Stage 3 Figure Wave — Iteration 1

- Timestamp: 2026-04-03T14:10:30Z
- Manifest: `ICJIA-PDFs/manifests/stage3-figure-wave.json`
- Outcomes summary: `ICJIA-PDFs/manifests/stage3-figure-wave.outcomes.summary.json`
- Target candidates: 50
- Processed (cumulative): 73
- Pass rate this wave: **4 / 73 readyToReplace** (~5.5%)
- Failed after remediation: 60
- Processing errors (timeout): 9
- Remaining in wave: 0

### Timeout pattern
- `4761` (Statewide Violence Prevention Plan 2020-2024, 45 pages) — `excessive_runtime_loop`, 31.9 min
- 8 other processing errors recorded; likely same timeout class

### Top blocking finding keys (from failures)
- `pdfua.figure_alt_or_artifact` — dominant; figures not reaching alt-text resolution before convergence exit
- `pdfua.logical_structure` — secondary; mixed figure+structure debt PDFs plateauing on structure

### Score delta signal
- Most failures still show significant score improvement vs baseline (F→C/D range common)
- Engine is improving PDFs but not crossing the Grade A threshold

### API/tooling improvement opportunity
- `FigureDescriptionStopReason: same_blocking_keys` is exiting too early; figures remain unresolved
- Consider raising `same_blocking_keys` exit threshold or adding a forced figure-only pass before budget exhaustion

### Verified_pass correction after full-final verification
- Pre-wave control plane showed 93 verified_pass; post-wave ledger settled at **89**
- 4 PDFs that passed fast-path scoring did not hold under full-final analysis (structureInspect timing reveals deep structure debt not caught in remediation_fast profile)
- This is expected behavior — full-final scan is authoritative; fast-path was optimistic on a few PDFs
- Baseline corrected: **89 verified_pass** as of 2026-04-03T16:31Z

## Stage 4 Structure Wave — Iteration 1

- Timestamp: 2026-04-03T19:17:01Z
- Manifest: `ICJIA-PDFs/manifests/stage4-structure-wave.json`
- Outcomes summary: `ICJIA-PDFs/manifests/stage4-structure-wave.outcomes.summary.json`
- Target candidates: 20 (wave limit)
- Processed (cumulative): 84
- Pass rate this wave: **9 / 84 readyToReplace** (~10.7%)
- Failed after remediation: 68
- Processing errors (timeout): 7
- Remaining in wave: 0

### Top blocking finding keys (from failures)
- `pdfua.logical_structure` — dominant; tag trees incomplete or reading order conflicts
- `pdfua.figure_alt_or_artifact` — secondary; mixed-ownership elements blocking figure alt
- Combined structural+figure debt common in multi-blocker failures

### Score delta signal
- Typical improvement: F→D or F→C range (score 60-84)
- Latest failure (4129 Sheridan CC Year 6): F(20)→D(68), still blocked by logical_structure + figure_alt

### title-patch batch (7 PDFs)
- 7 structure_heavy PDFs at score 89 with sole blocker `pdfua.display_doc_title` patched via `patch-display-doc-title.py`
- All 7 patched successfully using pikepdf: set `/Info /Title` and `ViewerPreferences /DisplayDocTitle=True`
- Staged to `ICJIA-PDFs/staging/to-replace/` for verify-ready pickup
- Outcomes manifest updated to `ready_to_replace` for all 7

### Verify-ready status
- Launched post-wave verify-ready scan at 2026-04-03T18:14Z covering 7 title-patch + 8 wave passes
- Running as of 2026-04-03T19:17Z (ongoing)

## Stage 4 Structure Wave — Current 8-Row Canary Slice

- Timestamp: 2026-04-05T00:09:00Z
- Manifest: `ICJIA-PDFs/manifests/stage4-structure-wave.json`
- Outcomes summary: `ICJIA-PDFs/manifests/stage4-structure-wave.outcomes.summary.json`
- Selected canaries:
  - `4755`, `4162`, `4598`, `4551`, `4078`, `4188`, `4189`, `4183`
- Terminal truth from the outcomes manifest:
  - `4598` -> `remediated_pass_candidate` (`26 -> 100`)
  - `4189` -> `remediated_pass_candidate` (`22 -> 100`)
  - `4183` -> `failed_after_remediation` (`22 -> 90`, blocker: `pdfua.figure_alt_or_artifact`)
  - `4188` -> `failed_after_remediation` (`20 -> 75`, blockers: `pdfua.nested_alt_text`, `pdfua.figure_alt_or_artifact`, `pdfua.heading_content_quality`)
  - `4078` -> `failed_after_remediation` (`20 -> 58`, blockers: `pdfua.logical_structure`, `pdfua.figure_alt_or_artifact`, `pdfua.heading_content_quality`)
  - `4551` -> `failed_after_remediation` (`46 -> 65`, blockers: `pdfua.logical_structure`, `pdfua.figure_alt_or_artifact`, `pdfua.heading_content_quality`)
  - `4755` -> `failed_after_remediation` (`36 -> 62`, blockers: `pdfua.logical_structure`, `pdfua.heading_content_quality`)
  - `4162` -> `processing_error` after long annual-report runtime
- Pass rate for this exact canary slice: `2 / 8`

### Top blocking finding keys
- `pdfua.heading_content_quality` — 4
- `pdfua.figure_alt_or_artifact` — 4
- `pdfua.logical_structure` — 3
- `pdfua.nested_alt_text` — 1

### Timeout / runtime pattern
- `4162` (`AnnualReportFY10.pdf`) is the long-runtime canary for this wave and terminated as `processing_error`
- The stage4 wrapper wrote terminal outcomes but remained live afterward; persisted manifests were more truthful than the still-running wrapper process

### Score delta signal
- The two near-pass canaries (`4598`, `4189`) hit `100`
- The hard survivors still improved substantially but plateaued in mixed figure/structure/heading families:
  - `4183`: figure-only residual at `90`
  - `4188`: figure + nested-alt + heading residual at `75`
  - `4078`, `4551`: mixed structure + figure + heading residuals
  - `4755`: structure + heading residual

### Provider / failover behavior
- During this wave, semantic enrichment repeatedly timed out on the primary provider and fell through to the remote hotspot fallback
- This exposed the need for durable provider-routing telemetry rather than relying on stdout-only fallback warnings
- Engine change landed:
  - provider routing is now recorded through the shared OpenAI-compatible helper and surfaced into remediation metrics for future runs

### API / tooling improvement opportunities
- `heading_content_quality` is still acting like a late-stage survivor family and needs stronger focused follow-up, not just hierarchy normalization
- `table_regularity` should be treated as a bounded structural cleanup family inside final rescue, not left passive
- Mixed figure/structure survivors need figure rescue to respect category-score improvement, not only raw missing-alt-count reduction

## Verification / Control-Plane Refresh After 400-Target Verify Pass

- Timestamp: `2026-04-05T00:09:05Z`
- Verification summary source: `ICJIA-PDFs/manifests/ready-to-replace-verification.summary.json`
- Verification totals:
  - `400` unique targets
  - `109` passed targets
  - `291` failed targets
  - `123` verified promotion ledger rows
- Current verified-pass ledger summary:
  - `verifiedPassRows: 123`

### Control-plane rebuild truth
- Manual post-run refresh completed with:
  - `pnpm exec tsx scripts/classify-ready-verification.ts`
  - `pnpm agency:build-control-plane`
- Rebuilt control-plane summary now shows:
  - `114` `verified_pass`
  - `1` `staged_for_replacement`
  - `942` remaining non-verified rows

### Validation mismatch
- `pnpm agency:validate-control-plane` is currently failing
- The failure is a verified-ledger/control-plane truth mismatch, not a schema crash
- Current mismatched publication ids:
  - `3906`, `3921`, `3936`, `4156`, `4180`, `4185`, `4483`, `4598`, `4613`, `4658`
- Tooling implication:
  - the verification ledger can currently remain more optimistic than the rebuilt control plane
  - promotion-ledger reconciliation now needs to be treated as an explicit API/control-plane improvement task before trusting later promotion counts

## Orchestration Hardening / Closure Stabilization

- Timestamp: `2026-04-05T00:59:00Z`
- Scope:
  - `scripts/run-stage4-structure-wave.ts`
  - `apps/api/src/services/agentRemediationService.ts`
  - `apps/api/src/__tests__/agentRemediationService.test.ts`
- Wave/process truth improvement:
  - Stage 4 post-wave completion is now keyed to persisted manifests instead of long-lived wrapper-process liveness
  - The runner now requires:
    - terminal outcomes for all selected Stage 4 IDs
    - fresh verification summary and verified-promotion-ledger summary
    - successful classify/build/validate after post-wave verification
  - If `verify-ready` is still alive after those artifacts exist, the runner logs the disagreement, terminates the hanging child, and continues from the manifests
- Engine/API improvement outcomes:
  - final cleanup keeps batched link `/Contents` repair in the backend path for non-native PDFs
  - direct final cleanup remains available for late font embedding / ToUnicode repair passes
  - native-safe and long-report follow-up paths now use safe inspection fallback instead of dying on inspection-budget exhaustion
  - semantic rollback now correctly clears inherited veraPDF reuse when the semantic batch is rejected and rolled back
- Verification:
  - `pnpm --dir apps/api exec vitest run src/__tests__/agentRemediationService.test.ts` -> `78 / 78` pass
  - `pnpm --dir apps/api exec vitest run src/__tests__/semanticEnrichmentService.test.ts src/__tests__/documentReconstructionService.test.ts src/__tests__/remediationPlanService.test.ts` -> pass
  - `pnpm agency:validate-control-plane` -> `ok: true`
- Operational implication:
  - Persisted manifests are now the trusted closure signal for Stage 4 and should be checked before starting any new wave, even if old wrapper processes remain in the process table

## Stage 4 Scoped Canary Rerun V1

- Timestamp: `2026-04-05T01:47:10Z`
- Benchmark manifest: `ICJIA-PDFs/manifests/stage4-canary-rerun.priority.json`
- Outcomes summary: `ICJIA-PDFs/manifests/stage4-canary-rerun.outcomes.summary.json`
- Active benchmark IDs:
  - `4755`, `4078`, `4188`, `4551`, `4162`, `4183`
- Terminal results:
  - `4755` -> `failed_after_remediation` (`36 -> 86`, blocker: `pdfua.heading_content_quality`)
  - `4078` -> `failed_after_remediation` (`20 -> 48`, blockers: `pdfua.logical_structure`, `pdfua.untagged_rendered_images`, `pdfua.figure_alt_or_artifact`, `pdfua.heading_content_quality`)
  - `4183` -> `failed_after_remediation` (`22 -> 90`, blocker: `pdfua.figure_alt_or_artifact`)
  - `4188` -> `processing_error`
  - `4551` -> `processing_error`
  - `4162` -> `processing_error`
- Pass rate: `0 / 6`

### Top blocking finding keys
- `pdfua.heading_content_quality`
- `pdfua.figure_alt_or_artifact`
- `pdfua.logical_structure`
- `pdfua.untagged_rendered_images`

### Timeout / runtime pattern
- `4551` and `4162` both ran for roughly the full 30-minute budget and terminated as `processing_error`
- `4188` also stayed in the heavy mixed-runtime class and terminated as `processing_error`
- Mixed heavy canaries are still spending too much time inside repeated deep figure/structure inspection loops

### Score delta signal
- `4755` materially improved and narrowed from mixed structure/heading debt to heading-only residual
- `4183` stayed near-pass and narrowed to figure-only residual
- `4078` remains a mixed hard fail and did not show enough structure/figure shrink to satisfy the benchmark gate

### Provider / failover behavior
- Most semantic requests served successfully from the LAN primary provider
- At least one semantic request bypassed the primary liveness check, OpenRouter failed on unsupported `tool_choice`, and the remote hotspot fallback succeeded
- This confirms the provider-routing telemetry is useful for benchmark comparison, especially on long-running canaries

### API / tooling improvement opportunities
- Add a heading-only final-mile path so `pdfua.heading_content_quality` survivors do not settle immediately back into generic structure convergence
- Add candidate-level figure cleanup in the figure-only final-mile path so near-pass survivors like `4183` get bounded `set_figure_alt_text` / `retag_as_figure_and_set_alt` / `mark_figure_decorative` attempts before `same_family_no_progress`
- Reduce runtime churn for mixed long canaries by preferring cached/light rescue context after the residual family shape is established and by using a smaller final rescue set on long mixed documents

## Stage 4 Scoped Canary Rerun V2

- Timestamp: `2026-04-05T02:52:10Z`
- Benchmark manifest: `ICJIA-PDFs/manifests/stage4-canary-rerun.priority.json`
- Outcomes summary: `ICJIA-PDFs/manifests/stage4-canary-rerun-v2.outcomes.summary.json`
- Active benchmark IDs:
  - `4755`, `4078`, `4188`, `4551`, `4162`, `4183`
- Terminal results:
  - `4755` -> `failed_after_remediation` (`36 -> 86`, blocker: `pdfua.heading_content_quality`)
  - `4078` -> `failed_after_remediation` (`20 -> 48`, blockers: `pdfua.logical_structure`, `pdfua.untagged_rendered_images`, `pdfua.figure_alt_or_artifact`, `pdfua.heading_content_quality`)
  - `4188` -> `processing_error`
  - `4551` -> `processing_error`
  - `4162` -> `processing_error`
  - `4183` -> `processing_error`
- Pass rate: `0 / 6`

### Top blocking finding keys
- `pdfua.heading_content_quality`
- `pdfua.figure_alt_or_artifact`
- `pdfua.logical_structure`
- `pdfua.untagged_rendered_images`

### Timeout / runtime pattern
- `4188`, `4551`, `4162`, and `4183` all terminated via `excessive_runtime_loop`
- `4183` regressed from the V1 near-pass figure residual into timeout/error, which indicates the previous figure-only slice still allowed too much heavy mixed/runtime churn
- This benchmark confirms the next engine slice needs to convert runtime-heavy survivors into bounded analyzed outcomes before reopening broader waves

### Score delta signal
- `4755` remained stable at the heading-only plateau (`86 / B`)
- `4078` remained a mixed hard fail with no meaningful blocker shrink
- No new pass candidates or ready-to-replace rows emerged

### Provider / failover behavior
- The prior provider-routing telemetry slice remains useful, but the dominant failure mode in V2 was runtime churn rather than endpoint failover
- The next benchmark needs explicit stop-path metrics so we can distinguish:
  - true timeout
  - bounded compact-final-rescue fallback
  - analyzed hard fail reached before timeout

### API / tooling improvement opportunities
- Add a hard mixed-runtime governor that forces compact final rescue before the global batch timeout
- Split near-pass figure survivors into a fast lane so rows like `4183` do not re-enter broad mixed rescue once figure debt is dominant
- Skip repeated no-effect compact mixed rescue calls against the same stable target refs
- Surface stop-path and rescue-pass counts in `remediationMetrics.runtimeSummary` for canary comparison
