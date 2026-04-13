# Project Memory

## ICJIA data disk (second volume)

- **Canonical Ubuntu 24.04 VM path for API + local Gemma (2026-04-13):** fresh local-AI hosts should now use **`bash scripts/provision-vm.sh`** followed by **`bash scripts/start-stack.sh`** as the supported path after `git clone`. Provisioning reuses **`bootstrap-ubuntu.sh`**, writes/preserves local `OPENAI_COMPAT_*` defaults in **`apps/api/.env`**, installs a pinned llama.cpp bundle when missing, installs **PM2** when missing, and can run **`scripts/healthcheck-stack.sh`** as a post-install check. The supported long-running apps are **`file-audit-llm`** and **`file-audit-api`** in **`ecosystem.config.cjs`**. Operator helpers: **`scripts/stop-stack.sh`**, **`scripts/status-stack.sh`**, **`scripts/healthcheck-stack.sh`** plus package aliases **`pnpm vm:provision`**, **`pnpm stack:start|stop|status|healthcheck`**.
- **Bootstrap hardening for fresh VMs (2026-04-13):** `bootstrap-ubuntu.sh` now installs the Chromium/Playwright runtime libraries needed for headless launch on Ubuntu 24.04 (e.g. `libatk1.0-0`, `libgtk-3-0t64`, `libnss3`, `xvfb`), and the local legacy-font bundle install is tolerant of the real msttcorefonts/Carlito naming shipped by Ubuntu plus IBM Plex `ttf`/`otf` upstream differences. `healthcheck-stack.sh` invokes `bash scripts/verify-env.sh` so it works on a fresh clone even if executable bits have not been normalized yet.

- When the root volume is nearly full, add a physical disk, then run **`sudo bash scripts/setup-icjia-data-disk.sh`** from the repo root (requires root for partition, mkfs, mount, fstab).
- Defaults: device **`/dev/sdb`**, mount **`/mnt/icjia-work`**, **`ext4`**, fstab with **`nofail`**. Override with **`ICJIA_DATA_DEVICE`**, **`ICJIA_DATA_PARTITION`**, **`ICJIA_DATA_MOUNT`**, **`ICJIA_REPO_ROOT`** if needed.
- The script **`rsync --remove-source-files`** into the mount, then replaces **`ICJIA-PDFs/artifacts`**, **`backups`**, **`staging`**, and **`reports`** with **symlinks** to the same names under the mount so existing absolute paths in manifests keep resolving.
- If **`mount`** fails with **wrong fs type / bad superblock** after a fresh partition, **`blkid`** may have seen a non-ext4 signature on **`/dev/sdb1`** and the old script skipped **`mkfs`**. Current script formats unless **`blkid TYPE` is `ext4`**; re-run **`sudo bash scripts/setup-icjia-data-disk.sh`** (or run **`sudo mkfs.ext4 -F -L icjia-work /dev/sdb1`** once, then mount and re-run the script).
- After symlinking **`ICJIA-PDFs/{artifacts,...}`** to **`/mnt/icjia-work`**, **`pdf-mcp`** allow-list includes **`fs.realpathSync`** of those subdirs so MCP can open files under the data volume. **`run-manual-mcp-batch`** resolves remediated PDFs by scanning the whole remediated tree, **drops 0-byte matches**, prefers wave dirs (**`stage3-figure-wave`**, **`priority-batch`**, etc.) over **`manual-mcp-batch`** (avoids ENOSPC-truncated leftovers).
- **`run-manual-mcp-batch`** (verification-failure and other modes): for PDFs with structure/figure/**`pdfua.untagged_rendered_images`** blockers and **`pageCount` ≤ `MANUAL_MCP_STRUCTURE_MAX_PAGES`** (default **240**), it now runs **`bootstrap_struct_tree`**, **`repair_native_marked_content_refs`**, and **`repair_structure_conformance`** before native figure/alt passes (previously structure repairs only ran for **`pageCount` ≤ 8**, so large reports never got a tree and figures stayed **`repairMode: defer`**). Figure repairs iterate up to **`MANUAL_MCP_MAX_FIGURE_OPS`** (default **48**), skipping candidates that repeatedly return **`no_effect`**.
- **Manual MCP promotion gate (default relaxed):** by default the batch treats **`overallScore` ≥ `MANUAL_MCP_MIN_OVERALL_SCORE`** (default **90**), not scanned, and no **critical** manual-review flags as **`manual_ready_to_replace`** (reason **`cleared_min_overall_score`** when strict gate would still fail). Blocking local-standard keys may remain on the outcome for transparency. Set **`MANUAL_MCP_STRICT_PROMOTION_GATE=1`** for the original grade **A** / score **100** / no-blocking-locals bar. **`scripts/verify-ready-to-replace.ts`** and the engine still use the **strict** gate unless changed separately.
- **Priority remediation batch (`run-priority-remediation-batch.ts`):** optional **`ICJIA_REMEDIATION_MIN_PASS_SCORE`** (e.g. **90**) switches pass/staging to relaxed **`evaluatePromotionGate`** **`minOverallScore`** (overall **≥** that score passes, plus not scanned / no critical manual flags); optional **`ICJIA_REMEDIATION_MIN_KEEP_SCORE`** (e.g. **80**) deletes the remediated PDF when final score is below that threshold and the row did **not** pass the effective gate (overall **≥** threshold is kept on disk). Unset vars preserve strict pass and always-on-disk artifacts. Detailed JSON includes **`strictPromotionGate`** when the pass threshold overrides the engine strict gate.
- **All-remaining automated lane (2026-04-08):** a dedicated active backlog snapshot now exists at **`ICJIA-PDFs/manifests/all-remaining-automated.json`** (plus `.summary.json`) and is built by **`pnpm agency:build-pass-rate-slices`**. It includes only active automatable rows (`discovered`, `analyzed`, `queued_for_remediation`, `remediated_fail`, `processing_error`) that still have a runnable local source path and remote path, and excludes verified/staged/replaced rows, manual-mitigated or deferred rows, scanned/manual-only rows, and missing-source rows.
- **All-remaining run command:** **`pnpm agency:run-all-remaining-automated`** wraps the generic priority runner with fixed defaults:
  - concurrency **`4`**
  - timeout **`1800000`** ms per PDF
  - analysis profile **`full_final`**
  - pass/stage threshold **`>= 90`**
  - keep-artifact threshold **`>= 80`**
  - lane-specific outputs:
    - outcomes: **`ICJIA-PDFs/manifests/all-remaining-automated.outcomes.json`**
    - summary: **`ICJIA-PDFs/manifests/all-remaining-automated.outcomes.summary.json`**
    - progress: **`ICJIA-PDFs/manifests/all-remaining-automated.outcomes.progress.json`**
  - the wrapper resumes the same manifest/outcomes/progress set while a campaign is `running` or `stale`; once completed, the next start rebuilds a fresh snapshot.
- **Resumable progress tracking:** the generic remediation batch runner now writes a durable progress document with `runId`, `state`, `pid`, `firstStartedAt`, `currentSessionStartedAt`, accumulated active runtime, heartbeat, `processed/remaining`, active workers, score policy, counts by result band, and last-completed row. Result bands are explicit (`pass_ge_90`, `keep_fail_80_to_89`, `drop_fail_lt_80`, `processing_error`, `source_missing`) so status tooling does not have to re-infer policy from scores. ETA is based on active wall-clock runtime across resumed sessions, not summed worker durations. Single-owner lock enforcement is available with **`ICJIA_REMEDIATION_ENFORCE_SINGLE_OWNER=1`** and is enabled by the all-remaining wrapper.
- **All-remaining status command:** **`pnpm agency:all-remaining-status`** reads the lane manifest, outcomes, and progress file and prints `processed/total`, remaining, counts by result band, throughput, ETA, and run state (`not_started`, `running`, `stale`, `completed`). `--json` emits the same snapshot as machine-readable JSON.
- **All-remaining dropped rerun lane (2026-04-09):** a dedicated rerun manifest for prior **`drop_fail_lt_80`** rows now exists at **`ICJIA-PDFs/manifests/all-remaining-dropped-rerun.json`** (plus `.summary.json`) and is built by **`pnpm agency:build-all-remaining-dropped-rerun`** from **`all-remaining-automated.outcomes.json`**. It reuses the exact input `localCachePath` values from the previous all-remaining run, carries forward the prior score/grade/band as seed context, and excludes rows whose source path or remote path is missing.
- **All-remaining dropped rerun command:** **`pnpm agency:run-all-remaining-dropped-rerun`** wraps the generic runner for that dropped-only manifest with:
  - concurrency **`4`**
  - timeout **`1800000`** ms
  - analysis profile **`full_final`**
  - pass/stage threshold **`>= 90`**
  - keep-artifact threshold **unset** so every rerun output PDF is retained on disk even when the rerun still scores below **`80`**
  - lane-specific outputs:
    - outcomes: **`ICJIA-PDFs/manifests/all-remaining-dropped-rerun.outcomes.json`**
    - summary: **`ICJIA-PDFs/manifests/all-remaining-dropped-rerun.outcomes.summary.json`**
    - progress: **`ICJIA-PDFs/manifests/all-remaining-dropped-rerun.outcomes.progress.json`**
- **Dropped rerun status command:** **`pnpm agency:all-remaining-dropped-rerun-status`** reports the same resumable progress/ETA view for the dropped-only rerun campaign.
- **All-remaining 79-down rerun lane (2026-04-10):** a second rerun manifest for prior scored outcomes at **`<=79`** now exists at **`ICJIA-PDFs/manifests/all-remaining-79-down-rerun.json`** (plus `.summary.json`) and is built by **`pnpm agency:build-all-remaining-79-down-rerun`** from **`all-remaining-dropped-rerun.outcomes.json`**. It uses the kept remediated PDFs from the dropped-rerun lane as the new `localCachePath` inputs, carries forward the previous rerun score as seed context, and excludes the completed `80+` rows plus no-score processing errors.
- **All-remaining 79-down rerun v2 lane (2026-04-10):** a third rerun manifest for the latest scored outcomes at **`<=79`** now exists at **`ICJIA-PDFs/manifests/all-remaining-79-down-rerun-v2.json`** (plus `.summary.json`) and is built by **`pnpm agency:build-all-remaining-79-down-rerun-v2`** from **`all-remaining-79-down-rerun.outcomes.json`**. It uses the kept remediated PDFs from the completed `79-down` rerun as the next `localCachePath` inputs, keeps all outputs again, and runs under the same fixed defaults via:
  - `pnpm agency:run-all-remaining-79-down-rerun-v2`
  - status: `pnpm agency:all-remaining-79-down-rerun-v2-status`
- **All-remaining 60-69 material wave (2026-04-11):** a targeted rerun manifest for the latest scored outcomes in the **`60-69`** band now exists at **`ICJIA-PDFs/manifests/all-remaining-60-69-material-wave.json`** (plus `.summary.json`) and is built by **`pnpm agency:build-all-remaining-60-69-material-wave`** from **`all-remaining-79-down-rerun-v2.outcomes.json`**. It uses the kept remediated PDFs from the completed `79-down` v2 rerun as inputs, keeps all outputs again, and changes the retry ordering materially by prioritizing lighter-runtime files with the strongest prior score deltas first. Run and track with:
  - `pnpm agency:run-all-remaining-60-69-material-wave`
  - `pnpm agency:all-remaining-60-69-material-wave-status`
- **All-remaining 60-69 positive-delta wave (2026-04-11):** when the full `60-69` band proved mostly plateaued, a smaller momentum-only lane was added at **`ICJIA-PDFs/manifests/all-remaining-60-69-positive-delta-wave.json`** (plus `.summary.json`) to rerun only the current `60-69` rows that still improved on the previous pass. It is built from **`all-remaining-79-down-rerun-v2.outcomes.json`**, keeps all outputs, runs at concurrency **`2`**, and is intended as the highest-confidence next retry:
  - `pnpm agency:build-all-remaining-60-69-positive-delta-wave`
  - `pnpm agency:run-all-remaining-60-69-positive-delta-wave`
  - `pnpm agency:all-remaining-60-69-positive-delta-wave-status`
- **Sub-79 recovery wave tooling (2026-04-11):** targeted rerun selection for the plateaued remediated sub-79 corpus now uses current residual blocker truth instead of historical `dominantSelectionFamily`. New service: **`apps/api/src/services/sub79RecoveryWave.ts`**. New build/run/status commands:
  - `pnpm agency:build-mixed-structure-figure-core`
  - `pnpm agency:run-mixed-structure-figure-core`
  - `pnpm agency:mixed-structure-figure-core-status`
  - `pnpm agency:build-mixed-structure-figure-plus`
  - `pnpm agency:run-mixed-structure-figure-plus`
  - `pnpm agency:mixed-structure-figure-plus-status`
  - `pnpm agency:build-font-led-deterministic`
  - `pnpm agency:run-font-led-deterministic`
  - `pnpm agency:font-led-deterministic-status`
  - latest builder smoke counts: `mixed-structure-figure-core: 279`, `mixed-structure-figure-plus: 14`, `font-led-deterministic: 15`
- **Mixed structure/figure convergence policy (2026-04-11):** remediation planning/runtime now has a first-class mixed-family path for residual `pdfua.logical_structure + pdfua.figure_alt_or_artifact` debt. The deterministic order is:
  - `normalize_heading_hierarchy`
  - `repair_native_marked_content_refs`
  - `repair_structure_conformance`
  - `normalize_nested_figure_containers`
  - `repair_native_figure_semantics`
  - `repair_other_elements_alt_text`
  - bounded candidate-level figure repair
- **Sub-79 tail final-mile engine upgrade (2026-04-11):** the remaining sub-79 tail now has a specialized near-pass branch inside `apps/api/src/services/agentRemediationService.ts` instead of relying only on the generic mixed-family loop.
  - activation: current score `70-79`, blocker count `<= 2`, or repeated signatures such as:
    - `pdfua.figure_alt_or_artifact`
    - `pdfua.font_embedding`
    - `pdfua.annotation_alt_contents + pdfua.figure_alt_or_artifact`
    - `pdfua.figure_alt_or_artifact + pdfua.table_regularity`
    - `pdfua.figure_alt_or_artifact + pdfua.logical_structure`
  - specialized tail modes now exposed in planner/failure metadata and runtime summary:
    - `figure_tail`
    - `font_tail`
    - `annotation_table_tail`
    - `figure_structure_tail`
  - metadata fields now carried on planner/failure summaries:
    - `tailSignature`
    - `tailFamilies`
    - `nearPassTailEligible`
    - `specializedTailMode`
    - `specializedTailAttempted`
    - `specializedTailImproved`
  - behavior changes:
    - stricter figure final-mile candidate ordering
    - dedicated font finalization tail stage
    - dedicated annotation/link/table tail cleanup before terminalization
    - signature-aware plateau switching so a repeated generic signature escalates into one specialized tail pass before terminal stop
  - canary lane commands:
    - `pnpm agency:build-sub79-tail-canary`
    - `pnpm agency:run-sub79-tail-canary`
    - `pnpm agency:sub79-tail-canary-status`
  - first canary build selected `34` current candidates (`20` plateaued) from the one-blocker/near-pass tail plus best-scoring `annotation+figure` and `figure+table` rows.
- **Mixed-path gating/runtime changes (2026-04-11):**
  - failure-profile structure opportunities no longer get deferred solely because figure debt is dominant when the document is in mixed structure/figure convergence
  - mixed-path failure profiles keep heading, marked-content, and broad conformance opportunities visible as `auto_runnable`; the planner still enforces the action order
  - light/medium mixed rescue now gets one extra serialized pass before mixed-family terminalization; heavy documents keep tighter bounds
  - final residual cleanup now includes bounded deterministic sweeps for `pdfua.annotation_alt_contents`, `pdfua.link_tagging`, and `pdfua.table_regularity`
- **Visual approval holds (2026-04-10):** material visual-parity review exceptions now live in **`ICJIA-PDFs/manifests/visual-approval-holds.json`**. `scripts/verify-ready-to-replace.ts` reads this manifest and marks matching staged rows with `visualApproval.required`; those rows remain staged locally but are forced to `verificationPassed: false`, excluded from the verified-promotion ledger, and classified as **`held_visual_review`** by `scripts/classify-ready-verification.ts`. `apps/api/src/services/corpusControlPlane.ts` maps that classification to `staged_for_replacement` with reason code `verification_held_visual_review`, so they stay out of auto-upload flows until the hold is cleared. Current held ids: `3783`, `4641` (only `4641` is presently in the staged-ready set).
- **Visual review hold status command:** run **`pnpm agency:visual-review-holds`** for a human-readable snapshot of active `held_visual_review` rows plus hold-manifest-only ids; add **`-- --json`** for machine-readable output. This is the fastest way to confirm whether a visually flagged PDF is actively blocking auto-promotion.
- **All-remaining 79-down rerun command:** **`pnpm agency:run-all-remaining-79-down-rerun`** wraps the generic runner for that manifest with:
  - concurrency **`4`**
  - timeout **`1800000`** ms
  - analysis profile **`full_final`**
  - pass/stage threshold **`>= 90`**
  - keep-artifact threshold **unset** so every second-rerun output PDF is retained on disk
  - lane-specific outputs:
    - outcomes: **`ICJIA-PDFs/manifests/all-remaining-79-down-rerun.outcomes.json`**
    - summary: **`ICJIA-PDFs/manifests/all-remaining-79-down-rerun.outcomes.summary.json`**
    - progress: **`ICJIA-PDFs/manifests/all-remaining-79-down-rerun.outcomes.progress.json`**
- **79-down rerun status command:** **`pnpm agency:all-remaining-79-down-rerun-status`** reports the same resumable progress/ETA view for the second rerun campaign.
- **Forward verification policy (2026-04-08):** **`pnpm agency:verify-ready`** now defaults to the same forward-looking minimum overall score threshold of **`90`** (still not scanned / no critical manual-review flags) for staged outputs it verifies, and records `scorePolicy` in verification and promotion summaries. This is forward-looking only; historical manifests are not rewritten retroactively.
- **`ICJIA-PDFs/manifests/`** is not moved by default (stays on the repo/root filesystem).

## 2026-04-07 PDF MCP Manual Batch

- The local PDF MCP server is now a proven manual-remediation path even though no MCP server is configured in the session resource list:
  - `list_mcp_resources` and `list_mcp_resource_templates` returned empty
  - the working path is to spawn the local stdio server directly with the SDK client:
    - `pnpm --filter pdf-mcp exec tsx src/index.ts`
- A reusable MCP batch runner now exists:
  - script: `apps/pdf-mcp/scripts/run-manual-mcp-batch.ts`
  - root wrapper: `scripts/run-manual-mcp-batch.ts`
  - command:
    - `pnpm agency:run-manual-mcp-batch` (no args: legacy four ids from `pass-rate-figure-canary.json`)
    - `pnpm agency:run-manual-mcp-batch -- --manifest` (default path `ICJIA-PDFs/manifests/manual-mcp-next-batch.json`) merges that manifest with `publication-pdf-replacement-map.json` and prefers remediated PDFs under `ICJIA-PDFs/artifacts/remediated-pdfs/`; figure-canary is no longer the only lookup table for manifest runs.
    - optional tranche: same command with numeric ids after `--manifest` to filter while preserving tranche order.
    - `pnpm agency:run-manual-mcp-batch -- --manifest --dry-run` to resolve and prefilter without MCP.
    - optional single-file rerun:
      - `pnpm agency:run-manual-mcp-batch <publicationId>` (replacement-map-only resolution)
  - following-wave manifest builder:
    - `pnpm agency:build-manual-mcp-next-batch-v2` → `ICJIA-PDFs/manifests/manual-mcp-next-batch-v2.json` (+ `.summary.json`), excluding manual-terminal rows, current `manual-mcp-next-batch` ids, and locals that already pass `full_final`.
  - Verified 2026-03-31: `pnpm --filter pdf-mcp typecheck` pass; `pnpm agency:run-manual-mcp-batch -- --manifest --dry-run 4192` resolves a non-canary id from the next-batch manifest + replacement map (remediated path preferred).
- `manual-mcp-next-batch` twenty-file MCP wave (four tranches) completed; every id has a terminal manual outcome (`manual_ready_to_replace` or `manual_terminalized` with `manualResolutionReason`):
  - `manual_ready_to_replace` (`cleared_final_blockers`): `4079`, `4100`, `4015`, `4019`, `4565`, `4072`, `4098`, `4121`
  - `manual_terminalized` (`manual_object_level_repair_exhausted`): `4192`, `4726`, `3585`, `3778`, `4758`, `4639`, `4750`, `4651`, `4607`, `4634`, `4756`, `4688`
  - After each tranche: `pnpm agency:build-pass-rate-slices`; final slice pass reported `manualMitigation.manualReadyCount: 10`, `manualTerminalizedCount: 26`, `manualInProgressCount: 0` (ledger includes prior MCP + manual-lane rows).
- Following-wave manifest built with control plane + ledger + `full_final` preflight + exclusion of prior `manual-mcp-next-batch` ids:
  - `pnpm agency:build-manual-mcp-next-batch-v2`
  - `ICJIA-PDFs/manifests/manual-mcp-next-batch-v2.json` and `manual-mcp-next-batch-v2.summary.json` (`queueName: manual-mcp-next-batch-v2`, 20 selected ids starting with `4632`, `4492`, …; `poolSizeBeforePreflight: 48` at generation time).
- The MCP batch writes durable artifacts to:
  - `ICJIA-PDFs/manifests/manual-mcp-batch.json`
  - `ICJIA-PDFs/manifests/manual-mcp-batch.summary.json`
  - `ICJIA-PDFs/reports/manual-mcp-batch/`
  - `ICJIA-PDFs/artifacts/remediated-pdfs/manual-mcp-batch/`
  - `ICJIA-PDFs/staging/to-replace/manual-mcp-batch/`
- The MCP batch records its final statuses in the shared manual outcome ledger:
  - `ICJIA-PDFs/manifests/manual-worklist.outcomes.json`
  - `ICJIA-PDFs/manifests/manual-worklist.outcomes.summary.json`
  - this is enough for control-plane exclusion even when the publications are outside the original fixed 12-row manual worklist
- First MCP manual batch selected:
  - `4150` — `ICJIA 2009 Annual Report`
  - `3671` — `ICJIA 1997 Annual Report`
  - `4169` — `Juvenile sentencing`
  - `4590` — `Research at a Glance Impacts of Probationer Screening and Services on Probation Success and Future Arrests`
- Final MCP batch outcomes:
  - `4150` -> `manual_terminalized`
    - reason: `manual_object_level_repair_exhausted`
    - final: `92/B`
    - blocker remained: `pdfua.figure_alt_or_artifact`
  - `3671` -> `manual_ready_to_replace`
    - reason: `cleared_final_blockers`
    - final: `100/A`
    - staged replacement:
      - `ICJIA-PDFs/staging/to-replace/manual-mcp-batch/143.244.146.43/3671-ICJIA_1997_Annual_Report.pdf`
  - `4169` -> `manual_terminalized`
    - reason: `manual_object_level_repair_exhausted`
    - final: `83/B`
  - `4590` -> `manual_ready_to_replace`
    - reason: `cleared_final_blockers`
    - final: `100/A`
    - staged replacement:
      - `ICJIA-PDFs/staging/to-replace/manual-mcp-batch/143.244.146.43/4590-Research_at_a_Glance_Impacts_of_Probationer_Screening_and_Services_on_Probation_Success_and_Future_Arrests.pdf`
- Practical workflow conclusion:
  - using MCP for mutation/inspection plus `full_final` for the final decision works
  - first implementation mistake: `4590` was already passing locally and should not have been sent into manual processing
  - corrected rule: already-passing local artifacts must be excluded before MCP batch selection, not processed and reclassified afterward
  - `apps/pdf-mcp/scripts/run-manual-mcp-batch.ts` now pre-checks candidate inputs with `full_final` and skips already-passing ids in the batch manifest
  - next planned MCP manual batch now lives at:
    - `ICJIA-PDFs/manifests/manual-mcp-next-batch.json`
    - `ICJIA-PDFs/manifests/manual-mcp-next-batch.summary.json`
  - the next batch is intentionally weighted toward failing, light-runtime, figure-dominant rows rather than heavy county-profile style PDFs
  - after rebuilding pass-rate slices on 2026-04-07:
    - `manualReadyCount: 2`
    - `manualTerminalizedCount: 14`
    - newly excluded publication ids include:
      - `3671`
      - `4150`
      - `4169`
      - `4590`
  - current staged manual-ready MCP replacements are:
    - `3671`
    - `4590`

## 2026-04-07 Manual Worklist And Tracking Loop

- The manual figure-final-mile lane is now a durable tracked queue instead of an ad-hoc shortlist:
  - service: `apps/api/src/services/manualWorklist.ts`
  - queue builder: `scripts/build-manual-worklist.ts`
  - manual runner: `apps/api/src/scripts/manualFigureFinalMile.ts`
  - root commands:
    - `pnpm agency:build-manual-worklist`
    - `pnpm agency:build-manual-fix-candidates` (compatibility alias)
    - `pnpm agency:manual-figure-final-mile <publicationId>`
- The first manual wave is the fixed 12-row hardest-salvageable figure-final-mile queue:
  - `4481`
  - `4186`
  - `4593`
  - `3691`
  - `3705`
  - `3703`
  - `3710`
  - `3698`
  - `3707`
  - `3694`
  - `3706`
  - `3700`
- Manual queue artifacts now live at:
  - `ICJIA-PDFs/manifests/manual-worklist.json`
  - `ICJIA-PDFs/manifests/manual-worklist.summary.json`
  - `ICJIA-PDFs/manifests/manual-worklist.outcomes.json`
  - `ICJIA-PDFs/manifests/manual-worklist.outcomes.summary.json`
- The manual outcome ledger uses explicit statuses:
  - `manual_ready_to_replace`
  - `manual_terminalized`
  - `manual_in_progress`
  - `manual_deferred`
- Control-plane/slice behavior now honors manual mitigation:
  - manually mitigated rows are excluded from throughput lanes, runtime retry lanes, replacement-likelihood, and residual active cohorts
  - `manual_ready_to_replace` maps to control-plane status `staged_for_replacement`
  - `manual_terminalized`, `manual_in_progress`, and `manual_deferred` map to control-plane status `deferred_manual`
  - residual-family reporting now exposes manual mitigation counts, reasons, and excluded publication ids
- Manual reports must be judged by `full_final`, not `remediation_fast`
- The manual lane starts from the best local remediated artifact it can find for the selected publication id (preferring `medium-figure-conversion`, then other prior remediated roots) and writes outputs to:
  - `ICJIA-PDFs/artifacts/remediated-pdfs/manual-figure-final-mile/`
  - `ICJIA-PDFs/reports/manual-figure-final-mile/`
  - `ICJIA-PDFs/staging/to-replace/manual-worklist/`
- Verified on 2026-04-07:
  - `pnpm --filter api build` -> pass
  - `pnpm --filter api exec vitest run src/__tests__/manualWorklist.test.ts src/__tests__/passRateWaveSlices.test.ts src/__tests__/residualFamilyClosureReport.test.ts` -> `18/18` pass
  - `pnpm agency:build-pass-rate-slices` -> pass
  - `pnpm agency:build-manual-worklist` -> pass
  - `pnpm agency:validate-control-plane` -> `ok: true`
- Latest generated manual/control-plane truth after wiring:
  - before manual outcomes were backfilled, `manualWorklistCount` was `12`
  - after backfilling the first two manual outcomes and rebuilding slices:
    - active manual worklist count is now `10`
    - `4186` and `4481` are excluded from active automation cohorts and active manual queue selection
    - residual-family summary now reports:
      - `manualTerminalizedCount: 2`
      - `excludedPublicationIds: 4186, 4481`
    - manual outcomes summary now reports:
      - `manualReadyToReplace: 0`
      - `manualTerminalized: 2`
      - reason frequency:
        - `manual_object_level_repair_exhausted: 2`
- Manual remainder wave completed on 2026-04-07:
  - remaining queue processed in order:
    - `4593`
    - `3691`
    - `3705`
    - `3703`
    - `3710`
    - `3698`
    - `3707`
    - `3694`
    - `3706`
    - `3700`
  - every remaining file ended as `manual_terminalized`
  - final manual outcomes summary:
    - `totalOutcomes: 12`
    - `manualReadyToReplace: 0`
    - `manualTerminalized: 12`
    - `manualInProgress: 0`
    - `manualDeferred: 0`
    - `reasonsByFrequency.manual_object_level_repair_exhausted: 12`
  - final active manual queue state:
    - `manual-worklist.summary.json` now shows `selectedRows: 0`
  - final residual/control-plane state:
    - `manualTerminalizedCount: 12`
    - all 12 manual ids are excluded from active automation cohorts
    - `figureFinalMileClosureCount` dropped to `0` in the manual wave source queue
  - county-profile wave pattern was consistent:
    - baseline: `21/F`
    - after manual figure/object-level pass: still blocked by the same broader family set
    - final: `24/F`
    - blockers remained:
      - `pdfua.logical_structure`
      - `pdfua.document_language`
      - `pdfua.display_doc_title`
      - `pdfua.font_embedding`
      - `pdfua.font_unicode`
      - `pdfua.figure_alt_or_artifact`
    - practical conclusion: these were not true figure-final-mile-only salvage cases; manual figure-only surgery exhausted without exposing a replacement path
  - `4593` also confirmed the same conclusion at smaller scale:
    - figure work removed the initial figure-alt blocker mid-run, but `full_final` still ended at `24/F`
    - final blockers remained broad and included:
      - `pdfua.logical_structure`
      - `pdfua.document_language`
      - `pdfua.display_doc_title`
      - `pdfua.bookmark_language`
      - `pdfua.font_embedding`
      - `pdfua.font_unicode`
      - `pdfua.page_tabs`
      - `pdfua.annotation_alt_contents`
      - `pdfua.note_tag_id`
      - `pdfua.untagged_rendered_images`
      - `pdfua.nested_alt_text`
    - practical conclusion: `4593` was not a figure-final-mile candidate either, and its manual result validated the decision to treat the rest of the wave as automation-relief terminalization rather than pass hunting
- Live manual-run results on 2026-04-07:
  - `4186` (`Underreporting of violent victimization impedes justice services`)
    - input: `ICJIA-PDFs/artifacts/remediated-pdfs/medium-figure-conversion/143.244.146.43/4186-Underreporting_of_violent_victimization_impedes_justice_services.pdf`
    - output/report written successfully
    - final result improved to `91/B` but still failed on `pdfua.figure_alt_or_artifact`
    - one figure (`obj:42 0 R`) still failed even after a decorative/manual alt attempt
  - `4481` (`Addressing Child Exposure to Violence`)
    - input: `ICJIA-PDFs/artifacts/remediated-pdfs/medium-figure-conversion/157.230.3.215/4481-Addressing_Child_Exposure_to_Violence.pdf`
    - output/report written successfully
    - `remediation_fast` baseline misleadingly looked clean (`100/A`), but `full_final` still ended at `89/B`
    - final blockers remained:
      - `pdfua.nested_alt_text`
      - `pdfua.figure_alt_or_artifact`
- Practical conclusion:
  - a manual lane is viable and worth keeping
  - the queue/tracking loop now lets manual work spare automation cleanly once outcomes are recorded
  - but generic local figure-candidate replay is not enough by itself for the remaining hard cases
  - for real manual wins, the next step should be direct object-level inspection/patching of the exact remaining figure refs reported in the manual reports

## 2026-04-07 Large Mixed Runtime Reduction Slice

- The next engine slice for `large_mixed_runtime_reduction` is now implemented in:
  - `apps/api/src/services/agentRemediationService.ts`
- Large mixed runtime behavior is now more aggressively cost-controlled before deep rescue:
  - `isRuntimeHeavyMixedProfile(...)` treats mixed rows as runtime-heavy when page count is high (`>= 80`), deep inspections are already elevated, or repeated mixed no-progress history is present
  - `shouldTripMixedRuntimeGovernor(...)` now requires the row to qualify as a runtime-heavy mixed profile before firing
  - `shouldSerialTerminalizeLargeMixedProfile(...)` now uses the lower heavy threshold (`>= 80` pages) instead of the older very-large threshold (`>= 140`)
  - new helper `shouldAllowLargeMixedDominantFamilyRescue(...)` limits figure/structure rescue on runtime-heavy mixed rows:
    - first rescue pass only enters the dominant-family branch when a family-specific opportunity is exposed
    - later rescue passes only re-enter that branch if the immediately prior residual snapshot actually shrank that family’s debt
    - non-dominant-family rescue is blocked on runtime-heavy mixed rows
- In the focused final rescue loop:
  - figure rescue now checks `allowLargeMixedFigureRescue`
  - structure/table rescue now checks `allowLargeMixedStructureRescue`
  - this keeps large mixed docs from repeatedly re-entering expensive deep rescue branches just because both families remain present
- Focused regression coverage was expanded in:
  - `apps/api/src/__tests__/agentRemediationService.test.ts`
  - new cases cover:
    - blocking repeated large mixed structure rescue without fresh structure shrink
    - allowing repeated large mixed figure rescue only after figure shrink
    - allowing normal dominant-family rescue to continue on non-heavy mixed profiles
- Verified on 2026-04-07:
  - `pnpm --filter api build` -> pass
  - `pnpm --filter api exec vitest run src/__tests__/agentRemediationService.test.ts src/__tests__/passRateWaveSlices.test.ts src/__tests__/residualFamilyClosureReport.test.ts src/__tests__/runtimeTailOvernight.test.ts` -> `122/122` pass
  - `pnpm agency:build-pass-rate-slices` -> pass
  - `pnpm agency:validate-control-plane` -> `ok: true`
- Latest rebuild truth after this runtime-heavy slice:
  - recommended next engine slice still reports `mixed_figure_structure_separation`
  - `mixed_figure_structure_separation`: `233`
  - `figure_final_mile_closure`: `122`
  - `large_mixed_runtime_reduction`: `48`
  - `runtimeMixedTerminalizationCount`: `49`
  - runtime mixed grouped counts:
    - `mixed`: `48`
    - `structure`: `1`
- Practical conclusion:
  - the runtime-heavy mixed controls are now tighter and validated, but the cohort counts did not move from a static rebuild alone
  - the next meaningful decision depends on new live runtime truth or a direct figure-final-mile attempt, not another rebuild-only inference

## 2026-04-07 Mixed Figure/Structure Separation Tightening Pass 2

- A second mixed-family tightening pass is now implemented in:
  - `apps/api/src/services/agentRemediationService.ts`
- The residual cleanup follow-up gate is now stricter about when mixed rows may re-enter the wrong family:
  - figure-primary mixed states no longer re-enter structure-family deep follow-up unless the immediately prior residual snapshot shows actual structure-debt shrink
  - structure-primary mixed states no longer re-enter figure-family cleanup unless that figure family is newly exposed
  - repeated irreducibly mixed states with no structure or figure shrink are blocked from reseeding another broad residual loop
- Focused structure rescue now also stops earlier for:
  - repeated irreducibly mixed no-progress states
  - figure-primary mixed after-states
- `selectResidualCleanupFamilyTarget` now accepts remediation context and uses mixed-family pressure to prefer:
  - `native_figure_convergence` when a mixed row has become figure-primary
  - structural cleanup only when a mixed row is still structure-primary
- Focused regression coverage was expanded in:
  - `apps/api/src/__tests__/agentRemediationService.test.ts`
  - new cases cover:
    - figure-primary mixed states only allowing structure follow-up after actual structure shrink
    - blocking figure cleanup while a row is still structure-primary
    - repeated irreducibly mixed rescue stopping early
    - figure-family selection after a mixed row becomes figure-primary
- Verified on 2026-04-07:
  - `pnpm --filter api build` -> pass
  - `pnpm --filter api exec vitest run src/__tests__/agentRemediationService.test.ts src/__tests__/passRateWaveSlices.test.ts src/__tests__/residualFamilyClosureReport.test.ts` -> `113/113` pass
  - `pnpm agency:build-pass-rate-slices` -> pass
  - `pnpm agency:validate-control-plane` -> `ok: true`
- Latest rebuild truth after this second tightening pass:
  - recommended next engine slice remains `mixed_figure_structure_separation`
  - `mixed_figure_structure_separation`: `233`
  - `figure_final_mile_closure`: `122`
  - `large_mixed_runtime_reduction`: `48`
  - `runtimeMixedTerminalizationCount`: `49`
  - `runtimeStructureRetryCount`: `2`
- Practical conclusion:
  - the mixed routing logic is now tighter and more explicit, but the rebuilt cohort counts did not materially move beyond the prior pass
  - the next pivot should be chosen between:
    - another stop-condition/runtime-cost reduction slice for large mixed docs, or
    - figure-final-mile closure only if future live truth shifts more rows cleanly out of the mixed cohort

## 2026-04-07 Mixed Figure/Structure Separation Tightening

- The next engine slice for `mixed_figure_structure_separation` is now implemented in:
  - `apps/api/src/services/agentRemediationService.ts`
  - `apps/api/src/services/residualFamilyClosureReport.ts`
- Residual cleanup now uses a mixed-family pressure model instead of raw family presence only:
  - `single_family`
  - `structure_primary`
  - `figure_primary`
  - `irreducibly_mixed`
  - `unknown`
- `ResidualCleanupProgressSnapshot` now carries `pressure`, and mixed residual progress can count as real improvement when the family pressure shifts even if blocker families still overlap.
- Mixed-family routing behavior is now tighter:
  - mixed rows whose figure debt materially outweighs structure debt are treated as figure-primary
  - structure-family deep follow-up is blocked when a mixed state is already figure-primary
  - focused structure rescue now stops earlier when the after-state is already figure-dominant
  - residual cleanup family targeting is more likely to hand off toward figure cleanup instead of reseeding another structure loop
- `residualFamilyClosureReport` now records `familyPressure` per row and uses that signal to identify cleaner figure-final-mile handoff candidates.
- Latest rebuilt residual-family report truth after this slice:
  - remaining non-pass rows: `912`
  - rows with observed outcomes: `252`
  - rows with observed blocking shrink: `53`
  - recommended next engine slice remains: `mixed_figure_structure_separation`
  - ranked cohort counts:
    - `font_symbol_closure`: `336`
    - `mixed_figure_structure_separation`: `233`
    - `manual_scanned_deferred`: `173`
    - `figure_final_mile_closure`: `122`
    - `large_mixed_runtime_reduction`: `48`
- Compared with the previous residual-family rebuild:
  - `mixed_figure_structure_separation` shrank from `235` to `233`
  - `figure_final_mile_closure` grew from `120` to `122`
  - this is the current evidence of a slightly cleaner handoff from mixed survivors into figure-final-mile closure
- Current operational slice truth after the rebuild:
  - `runtimeFigureRetryCount: 0`
  - `runtimeStructureRetryCount: 2`
  - `runtimeMixedTerminalizationCount: 49`
  - `smallFastPassCount: 1`
  - `mediumFigureConversionCount: 32`
  - `serialHeavyMixedTerminalizationCount: 111`
  - `manualScannedDeferredCount: 168`
  - `replacementLikelihoodCount: 0`
  - `figureFinalMileClosureCount: 12`
- Verified on 2026-04-07:
  - `pnpm --filter api build` -> pass
  - `pnpm --filter api exec vitest run src/__tests__/agentRemediationService.test.ts src/__tests__/passRateWaveSlices.test.ts src/__tests__/residualFamilyClosureReport.test.ts` -> `109/109` pass
  - `pnpm agency:build-pass-rate-slices` -> pass
  - `pnpm agency:validate-control-plane` -> `ok: true`

## 2026-04-07 Residual-Family Closure Loop And Broad Conversion Lane Freeze

- The broad throughput conversion experiments are now treated as answered and operationally dormant:
  - `small-fast-pass` -> `executionPolicy: dormant`
  - `medium-figure-conversion` -> `executionPolicy: dormant`
  - `replacement-likelihood` -> `executionPolicy: dormant`
- Their dormant policy is enforced in both:
  - `scripts/run-throughput-lane.ts`
  - `scripts/run-priority-remediation-batch.ts`
  unless `ICJIA_ALLOW_DORMANT_LANE=1` is explicitly set.
- `serial-heavy-mixed-terminalization` remains the active throughput/control lane and is still measured as:
  - terminal outcomes/hour
  - `processing_error -> failed_after_remediation`
  - retry-budget reduction
  - blocker-family shrink
- New residual-family closure reporting now exists:
  - service: `apps/api/src/services/residualFamilyClosureReport.ts`
  - generated artifacts:
    - `ICJIA-PDFs/manifests/residual-family-closure-report.json`
    - `ICJIA-PDFs/manifests/residual-family-closure-report.summary.json`
    - `ICJIA-PDFs/manifests/figure-final-mile-closure.json`
    - `ICJIA-PDFs/manifests/figure-final-mile-closure.summary.json`
  - command path:
    - `pnpm agency:build-pass-rate-slices`
    - alias: `pnpm agency:build-residual-family-closure-report`
- The residual-family report consumes real completed outcome manifests plus current control-plane truth and tags remaining non-pass rows into candidate engine slices:
  - `figure_final_mile_closure`
  - `mixed_figure_structure_separation`
  - `font_symbol_closure`
  - `manual_scanned_deferred`
  - `large_mixed_runtime_reduction`
- Current residual-family report truth from the latest rebuild:
  - remaining non-pass rows: `912`
  - rows with observed outcomes: `252`
  - rows with observed blocking shrink: `53`
  - recommended next engine slice: `mixed_figure_structure_separation`
  - ranked cohort counts:
    - `font_symbol_closure`: `336`
    - `mixed_figure_structure_separation`: `235`
    - `manual_scanned_deferred`: `173`
    - `figure_final_mile_closure`: `120`
    - `large_mixed_runtime_reduction`: `48`
- The figure-final-mile closure cohort now exists as a dedicated manifest sourced from real outcome history:
  - current selected count: `12`
  - current selected ids:
    - `4186, 4481, 3700, 3706, 3694, 3698, 3707, 3710, 3703, 3705, 3691, 4593`
- Narrow engine slice implemented:
  - `agentRemediationService` now prefers `native_figure_convergence` during final residual cleanup when the document is already high-scoring and the remaining blocking local findings are figure-final-mile only:
    - `pdfua.figure_alt_or_artifact`
    - `pdfua.nested_alt_text`
    - `pdfua.figure_alt_quality`
    - `category.alt_text`
    - `context.long_report_figure_residue`
    - `context.figure_candidates_blocked`
- Verified on 2026-04-07:
  - `pnpm --filter api build` -> pass
  - `pnpm --filter api exec vitest run src/__tests__/passRateWaveSlices.test.ts src/__tests__/residualFamilyClosureReport.test.ts src/__tests__/agentRemediationService.test.ts` -> `106/106` pass
  - `pnpm agency:build-pass-rate-slices` -> pass
  - `pnpm agency:run-small-fast-pass` -> skipped because dormant
  - `pnpm agency:run-replacement-likelihood` -> skipped because dormant

## 2026-04-05 Claude Plan-Mode Tooling Failure Root Cause

- Claude Code `2.1.92` can now reach the LAN Anthropic-compatible endpoint successfully when `ANTHROPIC_BASE_URL` is set to the host root (`http://192.168.50.238:51824`) instead of the versioned path.
- Durable CLI config currently works for direct requests with:
  - `ANTHROPIC_BASE_URL=http://192.168.50.238:51824`
  - `ANTHROPIC_CUSTOM_MODEL_OPTION=gpt-5.4`
- The reported plan-mode / explore-agent tool failure is not primarily an endpoint outage.
- Claude’s own local session logs show repeated sub-agent/worktree failures on:
  - `Failed to resolve base branch "origin/main": git rev-parse failed`
- Repo truth at the time of failure:
  - local branch: `feature/pdf-fixing`
  - only remote branch present locally: `origin/feature/pdf-fixing`
  - `origin/main` does not exist locally
  - `origin/HEAD` is missing
- This means plan-mode agent/worktree setup is defaulting to `origin/main` and failing before the intended read-only exploration can proceed.
- Separate endpoint-compatibility observation from Claude debug logs:
  - Claude reaches `/v1/messages` on the LAN hotspot
  - the hotspot stream response does not emit Anthropic `message_start`, so Claude logs:
    - `Stream completed without receiving message_start event`
  - Claude then falls back to non-streaming mode
- Practical consequence:
  - direct Claude usage with the LAN endpoint can still work
  - plan-mode/explore-agent flows may still fail in this repo until base-branch resolution is fixed or a compatible `origin/main` / `origin/HEAD` is provided

## 2026-04-05 Stage 4 Canary Runtime And Final-Mile Recovery Slice

- The next post-canary runtime-recovery slice is now implemented in `agentRemediationService`.
- New late-phase behavior:
  - mixed late rescue now has a bounded runtime governor that can trip before the global batch timeout once mixed debt has repeated without residual shrink
  - compact mixed rescue now skips repeated no-effect candidate/target-ref retries instead of reissuing the same stable call surface
  - near-pass figure survivors can enter a fast lane that keeps them in figure-only final-mile cleanup instead of re-entering mixed rescue
  - heading-only survivors keep a bounded heading finisher and no longer branch back into broad mixed cleanup once that lane is detected
- `remediationMetrics.runtimeSummary` now also carries:
  - `focusedRescuePassCount`
  - `mixedRuntimeGovernorFired`
  - `compactFinalRescueFallback`
  - `authoritativeFinalScoringReached`
- Focused regression coverage added for:
  - near-pass figure fast-lane eligibility
  - mixed-runtime governor activation
  - skipping repeated no-effect compact mixed rescue calls against the same stable target ref
- Verified on 2026-04-05:
  - `pnpm --dir apps/api exec vitest run src/__tests__/agentRemediationService.test.ts` -> `84/84` pass
  - `pnpm --dir apps/api exec vitest run src/__tests__/semanticEnrichmentService.test.ts src/__tests__/documentReconstructionService.test.ts src/__tests__/remediationPlanService.test.ts` -> pass
- Scoped canary rerun V2 truth before this slice:
  - `4755` -> `failed_after_remediation`, `36 -> 86`, still blocked only by `pdfua.heading_content_quality`
  - `4078` -> `failed_after_remediation`, `20 -> 48`, still mixed structure/figure/heading hard fail
  - `4188`, `4551`, `4162`, `4183` -> `processing_error`
  - `4183` regressed from the V1 near-pass figure residual into timeout/error, so bulk Stage 3 / broad Stage 4 remain paused pending a V3 rerun

## 2026-04-06 Engine Contract And Runtime-Tail Planning Sync

- The public document-centric engine surface in `apps/api/src/engine/index.ts` is now treated as the canonical Stage 7 API boundary.
- Engine operations now normalize and echo a reusable request policy with:
  - `remediationPolicy.visualPreservation` defaulting to `strict`
  - `artifactRetention`
  - `benchmarkLabel`
  - `canaryLabel`
  - `maxRuntimeMs`
- Engine responses now expose standardized diagnostics for:
  - blocking finding keys
  - unresolved categories
  - residual-family summaries
  - stop reasons
  - runtime metrics
  - retained artifact paths
- A shared runtime/manual-tail classifier now exists in:
  - `apps/api/src/services/runtimeTailClassifier.ts`
- New runtime-tail analysis entrypoint:
  - `pnpm agency:analyze-runtime-manual-tail`
  - writes:
    - `ICJIA-PDFs/manifests/runtime-manual-tail-analysis.json`
    - `ICJIA-PDFs/manifests/runtime-manual-tail-analysis.summary.json`
- Stage 4 wave selection is now stricter:
  - unresolved rows from the active Stage 4 wave stay selected until they reach terminal outcomes
  - forensic classification can refine routing, but it no longer clears an active Stage 4 row from the wave before terminalization
- Roadmap truth was reconciled again:
  - Stage 5 remains done
  - Stage 6 remains done
  - Stage 4 is functionally done at the engine level but still has an actively guarded pending-wave closure path

## 2026-04-06 Failure-Profile And Figure-Family Contract Hardening

- `apps/api/scripts/pdf_structure_helper.py` native figure repair now backfills empty `/Alt` placeholders onto existing leaf `/Figure` nodes that already own page-backed content but were missing alt entirely.
- Focused regression coverage exists in:
  - `apps/api/src/__tests__/pdfRemediationTools.test.ts`
  - validates missing-`/Alt` backfill on an existing native `/Figure`
- `apps/api/src/services/documentModel.ts` and `apps/api/src/services/failureProfileService.ts` now expose reusable retry/routing summary fields on both `failureProfile.summary` and `plannerEvidence`:
  - `safeToRetry`
  - `dominantResidualFamily`
  - `lastStableNoEffectTool`
  - `retryDisposition`
- `apps/api/src/engine/index.ts` now surfaces those same Stage 7 diagnostics for non-ICJIA callers, plus family-oriented stop-reason fields for:
  - figure family
  - structure family
  - font family
  - runtime retry classification
- Verified on 2026-04-06:
  - `pnpm --filter api build` -> pass
  - `pnpm --filter api exec vitest run src/__tests__/failureProfileService.test.ts src/__tests__/engine.test.ts` -> `45/45` pass

## 2026-04-06 Pass-Rate Slice Operationalization

- Native figure repair in `apps/api/scripts/pdf_structure_helper.py` now also:
  - normalizes whitespace/junk placeholder `/Alt` values on existing `/Figure` nodes back to empty placeholders
  - artifacts decorative graphics-only native owners instead of promoting them to `/Figure`
- `apps/api/src/services/failureProfileService.ts` now applies explicit planner policy for:
  - smallest-lane font recovery after generic Unicode no-effect passes
  - heading/reading-order/marked-content cleanup ahead of broad structure conformance on post-bootstrap/native survivors
  - keeping figure-dominant residuals ahead of structure cleanup when figure debt is still active
- New operational slice builder:
  - `apps/api/src/services/passRateWaveSlices.ts`
  - command: `pnpm agency:build-pass-rate-slices`
  - writes:
    - `ICJIA-PDFs/manifests/pass-rate-figure-canary.json`
    - `ICJIA-PDFs/manifests/pass-rate-font-canary.json`
    - `ICJIA-PDFs/manifests/runtime-tail-retry-wave.json`
- Current generated slice truth from that command:
  - figure canary selected `3567, 3640, 3763, 3864, 4043, 4068, 4095, 4113`
  - font canary selected `3838, 4099, 4144, 4151, 4166, 4173, 4176, 4199`
  - runtime retry wave currently contains `99` rows
- Verified on 2026-04-06:
  - `pnpm --filter api build` -> pass
  - `pnpm --filter api exec vitest run src/__tests__/failureProfileService.test.ts src/__tests__/passRateWaveSlices.test.ts src/__tests__/pdfRemediationTools.test.ts -t "normalizes junk or whitespace /Alt on existing native /Figure elements back to an empty placeholder|prefers the next smallest font lane after generic Unicode repair hits a no-effect ceiling|blocks broad structure conformance while only heading and marked-content cleanup remain|passRateWaveSlices"` -> pass
  - `pnpm agency:build-pass-rate-slices` -> pass
  - `pnpm agency:validate-control-plane` -> `ok: true`

## 2026-04-06 Runtime Retry Pipeline Split Into Family-Targeted Lanes

- The old monolithic overnight `runtime-tail-retry-wave` is no longer the intended default runtime retry strategy.
- New runtime-targeted manifests now build from `pnpm agency:build-pass-rate-slices`:
  - `ICJIA-PDFs/manifests/runtime-tail-figure-retry.json`
  - `ICJIA-PDFs/manifests/runtime-tail-structure-retry.json`
  - `ICJIA-PDFs/manifests/runtime-tail-mixed-terminalization.json`
- New direct runners now exist:
  - `pnpm agency:run-runtime-tail-figure-retry`
  - `pnpm agency:run-runtime-tail-structure-retry`
  - `pnpm agency:run-runtime-tail-mixed-terminalization`
- The runtime slice builder now:
  - excludes prior processed runtime-wave rows from future automatic retry manifests
  - applies a winner-likelihood filter for figure/structure conversion lanes
  - keeps mixed-dominant retryables in a separate truth-hardening terminalization lane
- New chunk-aware overnight worker:
  - `scripts/run-runtime-tail-overnight-pipeline.ts`
  - detached launcher still uses `pnpm agency:start-runtime-tail-retry-wave-overnight`
  - status command still uses `pnpm agency:runtime-tail-retry-wave-status`
  - overnight summaries now write to `<slice>.overnight.summary.json`
- New chunk recommendation rules are covered in:
  - `apps/api/src/services/runtimeTailOvernight.ts`
  - `apps/api/src/__tests__/runtimeTailOvernight.test.ts`
- Verified on 2026-04-06:
  - `pnpm --filter api build` -> pass
  - `pnpm --filter api exec vitest run src/__tests__/passRateWaveSlices.test.ts src/__tests__/passRateProofLoops.test.ts src/__tests__/runtimeTailOvernight.test.ts` -> `15/15` pass
  - `pnpm agency:build-pass-rate-slices` -> pass
  - `pnpm agency:run-runtime-tail-figure-retry -- --build-only` -> pass, no selected rows
  - `pnpm agency:run-runtime-tail-structure-retry -- --build-only` -> pass
  - `pnpm agency:run-runtime-tail-mixed-terminalization -- --build-only` -> pass
  - `pnpm agency:validate-control-plane` -> `ok: true`
  - `ICJIA_RUNTIME_TAIL_OVERNIGHT_SLICE=runtime-tail-figure-retry pnpm exec tsx scripts/run-runtime-tail-overnight-pipeline.ts` -> smoke-test pass
- Current runtime-lane truth after the split:
  - monolithic retryable runtime rows still visible in the legacy manifest: `60`
  - figure conversion lane: `0`
  - structure conversion lane: `4` (`4162`, `4739`, `3912`, `3519`)
  - mixed terminalization lane: `53`
- Practical implication:
  - the previous overnight evidence is now reflected in the manifests themselves
  - current retry backlog is mostly a mixed terminalization problem, not a figure-conversion batch

## 2026-04-06 Mixed Figure/Structure Separation Slice

- Runtime conversion is now treated as dormant, not primary:
  - `runtime-tail-figure-retry` remains empty
  - partial live `runtime-tail-structure-retry` evidence plus refreshed proof showed no conversion / blocker shrink
  - the refreshed structure runtime slice now stands at `3` remaining (`4162`, `3912`, `3519`)
- `scripts/start-runtime-tail-retry-wave-overnight.ts` now defaults to:
  - `runtime-tail-mixed-terminalization`
  - not `runtime-tail-figure-retry`
- Runtime retry slice manifests now carry explicit execution policy:
  - `runtime-tail-mixed-terminalization` -> `active`
  - `runtime-tail-figure-retry` -> `dormant`
  - `runtime-tail-structure-retry` -> `dormant`
- Mixed runtime candidates now carry chunk-shaping metadata:
  - `runtimeWeightBucket`
  - `runtimeProfileKey`
- Mixed overnight chunking now:
  - avoids stacking repeated heavyweight profile rows in the same first chunk
  - isolates heavyweight mixed rows when needed
  - uses concurrency `1` for heavyweight mixed chunks and `2` for lighter mixed truth-hardening chunks
- Live proof-loop runners now refuse dormant runtime conversion slices unless explicitly overridden:
  - `scripts/run-pass-rate-proof-loop-common.ts`
  - `scripts/run-runtime-tail-overnight-pipeline.ts`
- Runtime structure conversion selection now excludes rows already marked with:
  - `structure_debt_cleared_figure_debt_remaining`
  - `mixed_figure_structure_separation_required`
  so structure-improved/figure-blocked survivors are not reintroduced as structure-conversion candidates
- `agentRemediationService` now emits explicit residual stop reasons for mixed figure/structure separation:
  - `structure_debt_cleared_figure_debt_remaining`
  - `figure_debt_cleared_structure_debt_remaining`
  - `mixed_figure_structure_separation_required`
  - `mixed_runtime_churn_without_family_shrink`
  - `mixed_large_runtime_profile_requires_serial_terminalization`
- Those stop reasons now flow through the remediation metrics / Stage 7 diagnostics type surface in:
  - `apps/api/src/services/documentModel.ts`
  - `apps/api/src/services/agentRemediationService.ts`
  - benchmark typing in `scripts/run-remediation-regression-benchmark.ts`
- Focused regression coverage added/updated in:
  - `apps/api/src/__tests__/agentRemediationService.test.ts`
  - `apps/api/src/__tests__/passRateWaveSlices.test.ts`
  - `apps/api/src/__tests__/runtimeTailOvernight.test.ts`
- Verified on 2026-04-06:
  - `pnpm --filter api build` -> pass
  - `pnpm --filter api exec vitest run src/__tests__/agentRemediationService.test.ts src/__tests__/passRateWaveSlices.test.ts src/__tests__/runtimeTailOvernight.test.ts` -> `104/104` pass
  - `pnpm agency:build-pass-rate-slices` -> pass
  - `pnpm agency:validate-control-plane` -> `ok: true`
- Current post-slice runtime truth remains:
  - `runtimeFigureRetryCount: 0`
  - `runtimeStructureRetryCount: 3`
  - `runtimeMixedTerminalizationCount: 53`
- The latest rebuilt dormant structure trio is:
  - `4162`
  - `3912`
  - `3519`
- A startup bug in the mixed overnight launcher was fixed on 2026-04-06:
  - `scripts/start-runtime-tail-retry-wave-overnight.ts` now exports `ICJIA_RUNTIME_TAIL_OVERNIGHT_SLICE` into the child process
  - `scripts/run-runtime-tail-overnight-pipeline.ts` now defaults internally to `runtime-tail-mixed-terminalization`
  - after the fix, a live mixed-terminalization overnight run started successfully with:
    - pid `1295297`
    - log `ICJIA-PDFs/logs/runtime-tail-overnight-runtime-tail-mixed-terminalization-2026-04-06T18-42-48-273Z.log`
    - chunk 001 manifest `ICJIA-PDFs/manifests/runtime-tail-mixed-terminalization.chunk-001.json`
- After the first mixed chunk still failed with exit `137`, the heavy-mixed runtime slice was tightened on 2026-04-06:
  - `runtime-tail-mixed-terminalization.chunk-001.json` is now shaped away from the old heavyweight `CAPS3` stack
  - controlled rerun with `ICJIA_RUNTIME_TAIL_MAX_CHUNKS=1` started successfully:
    - pid `1305624`
    - log `ICJIA-PDFs/logs/runtime-tail-overnight-runtime-tail-mixed-terminalization-2026-04-06T19-36-32-864Z.log`
  - the safer first chunk currently contains:
    - `3556`
    - `3590`
    - `3421`
    - `3424`
  - these are medium-weight mixed/manual-tail rows, not repeated heavyweight `CAPS3` profiles
- Practical implication:
  - do not resume the structure retry remainder as a conversion wave
  - mixed runtime is now the only active operational lane, and only for truth-hardening

## 2026-04-05 Stage 4 Canary Follow-Up Slice

- The next post-canary engine slice is now implemented in `agentRemediationService`.
- New late-phase behavior:
  - heading-only residual survivors are detected explicitly so focused final rescue can prefer bounded heading cleanup instead of falling straight back into generic structure churn
  - figure-only residual survivors now get candidate-level final-mile calls (`set_figure_alt_text`, `retag_as_figure_and_set_alt`, `mark_figure_decorative`) in addition to document-level figure rescue
  - mixed heavy canaries can prefer light rescue context after repeated deep inspection churn, which is intended to reduce runtime loops on files like `4188`, `4551`, and `4162`
  - compact mixed final rescue now trims the late-stage call set on long/heavy mixed files
- `remediationMetrics` now also emits a `runtimeSummary` with:
  - `lightInspectionCount`
  - `deepInspectionCount`
  - `semanticCallCount`
  - `providerCallCount`
- Focused regression coverage added for:
  - heading-only residual detection
  - candidate-level figure final-mile calls
  - mixed-runtime preference for light focused rescue context
- Verified on 2026-04-05:
  - `pnpm --dir apps/api exec vitest run src/__tests__/agentRemediationService.test.ts` -> 81/81 pass
  - `pnpm --dir apps/api exec vitest run src/__tests__/semanticEnrichmentService.test.ts src/__tests__/documentReconstructionService.test.ts src/__tests__/remediationPlanService.test.ts` -> pass
- Scoped canary rerun V1 truth:
  - `4755` -> `failed_after_remediation`, `36 -> 86`, now blocked only by `pdfua.heading_content_quality`
  - `4183` -> `failed_after_remediation`, `22 -> 90`, now blocked only by `pdfua.figure_alt_or_artifact`
  - `4078` -> `failed_after_remediation`, still mixed hard fail
  - `4188`, `4551`, `4162` -> `processing_error`
  - The first scoped rerun still did not meet the bulk-resume gate, so Stage 3 / broad Stage 4 remain paused pending a second isolated rerun

## 2026-04-05 Stage 4 Truth-Hardening And Closure Stabilization

- The Stage 4 closure-stabilization slice is now green.
- `scripts/run-stage4-structure-wave.ts` now treats persisted manifests as the source of truth for post-wave completion:
  - it requires pre-existing classified verification and a validated control-plane summary before starting a new Stage 4 wave
  - it checks that `stage4-structure-wave.outcomes.json` is terminal for all selected publication IDs
  - it treats fresh `ready-to-replace-verification.summary.json` plus `verified-promotion-ledger.summary.json` and terminal wave outcomes as sufficient truth to continue
  - if `pnpm agency:verify-ready` is still alive after those artifacts are written, the runner now warns, terminates the child process, and continues with classify/build/validate
- This hardens Stage 4 against the known “wrapper hangs after persisted truth is already written” failure mode.
- `agentRemediationService` stabilization fixes landed:
  - native-safe and replanning paths now use safe context inspection fallback instead of failing on inspection-budget exhaustion
  - semantic regression rollback now clears inherited veraPDF reuse when reverting to the pre-semantic baseline
  - final cleanup now preserves batch-first behavior for link annotation `/Contents` repairs in non-native mode while still allowing direct final cleanup for remaining unembedded-font and Unicode-map fixes
  - final cleanup can run even when earlier deterministic stages did not mutate the document, so late hygiene/final-residual tools still get a chance to apply
- Regression coverage is now fully green for the required closure slice:
  - `pnpm --dir apps/api exec vitest run src/__tests__/agentRemediationService.test.ts` -> 78/78 pass
  - `pnpm --dir apps/api exec vitest run src/__tests__/semanticEnrichmentService.test.ts src/__tests__/documentReconstructionService.test.ts src/__tests__/remediationPlanService.test.ts` -> pass
- Current validation truth rechecked on 2026-04-05:
  - `pnpm agency:validate-control-plane` -> `ok: true`

## 2026-04-05 Stage 4 Canary Slice And Provider-Telemetry Follow-Up

- A live Stage 4 canary wave completed terminal outcomes for:
  - `4755`, `4162`, `4598`, `4551`, `4078`, `4188`, `4189`, `4183`
- Terminal truth for that 8-row slice:
  - `4598`, `4189` -> `remediated_pass_candidate`
  - `4755`, `4551`, `4078`, `4188`, `4183` -> `failed_after_remediation`
  - `4162` -> `processing_error`
- Dominant blocker families in the canary slice:
  - `pdfua.heading_content_quality`
  - `pdfua.figure_alt_or_artifact`
  - `pdfua.logical_structure`
  - secondary: `pdfua.nested_alt_text`
- `verify-ready` finished a 400-target pass on 2026-04-05:
  - `109` passed targets
  - `291` failed targets
  - `123` verified promotion ledger rows
- Manual refresh after that run:
  - `pnpm exec tsx scripts/classify-ready-verification.ts`
  - `pnpm agency:build-control-plane`
  rebuilt the control plane to:
  - `114` `verified_pass`
  - `1` `staged_for_replacement`
  - `942` remaining non-verified rows
- Important truth-model note:
  - a transient verified-ledger/control-plane mismatch was observed earlier in the day for:
    - `3906`, `3921`, `3936`, `4156`, `4180`, `4185`, `4483`, `4598`, `4613`, `4658`
  - current validation truth has since been rechecked and is back to:
    - `pnpm agency:validate-control-plane` -> `ok: true`
  - keep persisted manifests as the source of truth if wrapper processes disagree with them.
- Engine/API changes landed on 2026-04-05:
  - shared OpenAI-compatible provider helper now records routing attempts, success/failure, and liveness-check skips
  - `agentRemediationService` now absorbs provider-routing telemetry into `remediationMetrics.providerRouting`
  - structure-phase progress tracking now treats `table_markup` / `pdfua.table_regularity` as part of late-stage structural convergence
  - focused figure rescue no longer stops solely because missing-alt counts are flat when figure category scores or issue-surface shrink still improved
  - focused final rescue now adds:
    - `repair_native_reading_order`
    - candidate-group `reorder_structure_children`
    - bounded `create_heading_from_candidate`
    - bounded table-header cleanup via `repair_native_table_headers` and `set_table_header_cells`
- Verified tests on 2026-04-05:
  - `pnpm --dir apps/api exec vitest run src/__tests__/semanticEnrichmentService.test.ts src/__tests__/documentReconstructionService.test.ts src/__tests__/remediationPlanService.test.ts` -> pass
- Broader `src/__tests__/agentRemediationService.test.ts` still has the pre-existing 7-test failure cluster around:
  - inspection-count expectations
  - native-safe final cleanup tool coverage
  - residual font cleanup
  - semantic rollback accounting
  - long-report inspection-budget exhaustion

## Local Gemma 4 E2B Q4 (on-VM, 2026-04-13)

- Remediation already uses **OpenAI-compatible** `/v1/chat/completions` with **tool calling** via `apps/api/src/services/openAiCompatService.ts` (planner fallback, semantic repair, page reconstruction).
- **Run the model:** `pnpm llm:gemma4-e2b` (foreground) or `pnpm llm:gemma4-e2b:bg` → logs `.tmp/llama-server.log`, pid `.tmp/llama-server.pid`. Defaults: HF repo **`unsloth/gemma-4-E2B-it-GGUF`** + **`gemma-4-E2B-it-Q4_K_M.gguf`** (the `ggml-org` snapshot may only offer Q8_0/bf16). Bundled binary: extract `llama-b*-bin-ubuntu-x64.tar.gz` to `.local-tools/llama-b*/` (script auto-sets `LD_LIBRARY_PATH`). The background launcher now truncates stale logs and uses `setsid` when available so the server survives `pnpm`/parent-shell exit. Port `1234`. Override with `GEMMA4_HF_REPO`, `GEMMA4_GGUF_FILE`, `LLAMA_SERVER_PORT`, `LLAMA_SERVER_BIN`.
- **Disable thinking:** the launcher now passes `--reasoning-budget 0`, `--chat-template-kwargs '{"enable_thinking": false}'`, and `--reasoning-format deepseek`. Verified with a plain local chat completion returning exact `content: "OK"` and no reasoning block.
- **App env:** `OPENAI_COMPAT_BASE_URL=http://127.0.0.1:1234/v1`, non-empty `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_MODEL` can remain the GGUF basename (`gemma-4-E2B-it-Q4_K_M.gguf`) even though `/v1/models` reports repo id `unsloth/gemma-4-E2B-it-GGUF`, `OPENAI_COMPAT_TOOL_CHOICE_MODE=required`, `OPENAI_COMPAT_DISABLE_FALLBACKS=1` to skip cloud fallbacks.
- **Probe:** `pnpm probe:openai-compat` or `pnpm probe:openai-compat -- --tool-smoke`. **API (auth):** `GET /api/engine/llm-provider?probe=1`, `POST /api/engine/llm-tool-smoke`.
- **Vision / alt text:** Semantic figure batches now send crops as OpenAI **`image_url`** content parts (plus text with `imageAttachmentIndex` mapping) so local multimodal models (Gemma 4 E2B + llama.cpp mmproj) actually see pixels. Page reconstruction already used `image_url`. Legacy: `SEMANTIC_REPAIR_INLINE_FIGURE_IMAGES=1` embeds base64 inside the JSON blob again.
- **Verified 2026-04-13:** `pnpm --filter api test src/__tests__/semanticEnrichmentService.test.ts src/__tests__/openAiCompatService.test.ts` passed; live local smoke checks passed for `GET http://127.0.0.1:1234/v1/models` and `pnpm probe:openai-compat -- --tool-smoke`; direct chat completions with `image_url` content parts are accepted by the running Gemma/llama.cpp server. End-to-end remediation smoke checks: `inaccessible.pdf` exercised `semanticEnrichmentService` successfully 4 times against the local provider and improved `35/F -> 44/F`; `ADAM2.pdf` improved `32/F -> 66/D` on deterministic passes with the same local server configuration.

## 2026-04-04 AI Provider Chain Refresh

- The API’s OpenAI-compatible provider routing now uses an ordered provider chain instead of a single primary plus one fallback.
- New shared helper:
  - `apps/api/src/services/openAiCompatService.ts`
- Current ordered provider policy in `apps/api/.env`:
  - primary: LAN-hosted LLM Hotspot `http://192.168.50.238:51824/v1`
  - model: `gpt-5.1-codex-mini`
  - fallback 1: OpenRouter `qwen/qwen3.6-plus:free`
  - fallback 2: remote LLM Hotspot `https://hs-c48895c933.llmhotspot.com/v1`
- The shared chain is now used by:
  - `openRouterService`
  - `semanticEnrichmentService`
  - planner AI fallback in `remediationPlanService`
- Test-safe behavior:
  - when no provider env is configured under Vitest/test mode, the helper exposes a harmless dummy endpoint so service tests still exercise fetch-based logic without relying on real secrets
- Verified on 2026-04-04:
  - `pnpm --dir apps/api exec vitest run src/__tests__/semanticEnrichmentService.test.ts src/__tests__/documentReconstructionService.test.ts src/__tests__/remediationPlanService.test.ts` -> pass

## 2026-04-03 Stage 4 Survivor Convergence Upgrade

- Stage 4 survivor-convergence work landed in the remediation engine for the current residual plateau families.
- `agentRemediationService` now:
  - treats measured structure-category gains (`reading_order`, `heading_structure`, `text_extractability`, `pdf_ua_compliance`) as residual progress
  - only counts structure-opportunity shrink when structural surfaces were actually present in the inspected context
  - allows mixed figure+structure survivors to reuse the figure-only late-rescue path when figure debt remains dominant and informative figure surface still exists
  - stops repeated focused structure rescue loops when mixed residuals keep the same structure debt while figure debt remains dominant
  - falls back to an empty remediation context instead of crashing final failure-profile generation when no final context is available
- `remediationPlanService` now promotes `repair_native_reading_order` and `reorder_structure_children` for Stage 4-style logical-structure survivors, while preserving heading-family priority when planner evidence says heading convergence should lead.
- `residualFamilyService` now prefers reading-order/group repairs inside:
  - `post_bootstrap_heading_convergence`
  - `logical_structure_marked_content`
- Verified tests on 2026-04-03:
  - `pnpm --dir apps/api exec vitest run src/__tests__/remediationPlanService.test.ts` -> pass
  - targeted survivor coverage in `src/__tests__/agentRemediationService.test.ts` and `src/__tests__/remediationPlanService.test.ts` -> pass
- Broader `src/__tests__/agentRemediationService.test.ts` still has a separate unresolved failure cluster (9 failing tests) around batching, inspection-budget behavior, scan-path fallback, CIDSet replanning, semantic regression rollback, and long-report replanning.

## 2026-04-01 Stage 6 Closure

- Stage 6 (`long_report` cohort) is **DONE**.
- `scripts/run-stage6-long-report-wave.ts` and `agency:run-stage6-long-report-wave` were added (mirror of Stage 5 run script pattern).
- `3513` ("Trends and Issues 90") retry outcome:
  - Status: `failed_after_remediation`, F→F (score 9→52)
  - Blocking: `pdfua.logical_structure`, `pdfua.figure_alt_or_artifact`
  - The PDF was scanned (143 pages); remediation improved it but couldn't pass the gate
  - After remediation, `classify-ready-verification.ts` **reclassified `3513` from `long_report` to `figure_heavy`** — its true cohort became apparent once blocking keys were known
  - `3513` is now `figure_heavy / remediated_fail` — it is no longer a Stage 6 row
- Final Stage 6 cohort truth (14 rows after `3513` reclassification):
  - `9` `long_report_verified_pass`: 3829, 3840, 3865, 3900, 4010, 4085, 4091, 4103, 4552
  - `5` `long_report_stable_hard_fail`: 3518, 3703, 3710, 3755, 3873
  - `0` `long_report_processing_retry`
  - `0` `long_report_mixed_residual`
  - `stillUnclassifiedRows: 0`
- Final throughput: `pendingWaveRows: 0`, `stillUnclassifiedRows: 0`
- Verified: `pnpm agency:validate-control-plane` → `ok: true`
- Verified: `pnpm --dir apps/api exec vitest run src/__tests__/longReportStage6.test.ts` → 3/3 pass
- Stable hard fail closure model: these 5 rows remain `remediated_fail` in corpus status; their forensics disposition `long_report_stable_hard_fail` is the terminal closure record (same pattern as Stage 5)
- Note: `verify-ready` phase after the run takes ~30 minutes and hangs due to open HTTP connections from the Anthropic SDK. Safe to kill after outcomes are written and run classify/build-control-plane/validate manually.

## 2026-04-01 Stage 6 Long-Report Lane Shell And First Truth Split

- Stage 6 is now the active roadmap lane after truthful Stage 5 closure.
- A first-class Stage 6 shell was added:
  - `apps/api/src/services/longReportStage6.ts`
  - `scripts/analyze-stage6-long-report-forensics.ts`
  - `scripts/build-stage6-long-report-wave.ts`
  - package commands:
    - `pnpm agency:analyze-stage6-long-report-forensics`
    - `pnpm agency:build-stage6-long-report-wave`
- Stage 6 now writes dedicated artifacts:
  - `ICJIA-PDFs/manifests/stage6-long-report-forensics.json`
  - `ICJIA-PDFs/manifests/stage6-long-report-forensics.summary.json`
  - `ICJIA-PDFs/manifests/stage6-long-report-wave.json`
  - `ICJIA-PDFs/manifests/stage6-long-report-wave.summary.json`
  - `ICJIA-PDFs/manifests/stage6-long-report-throughput.summary.json`
- First Stage 6 cohort truth:
  - `long_report` cohort size is `15`
  - current cohort state is:
    - `9` `verified_pass`
    - `5` `remediated_fail`
    - `1` `processing_error`
- First Stage 6 forensics split:
  - `long_report_verified_pass`:
    - `3829`
    - `3840`
    - `3865`
    - `3900`
    - `4010`
    - `4085`
    - `4091`
    - `4103`
    - `4552`
  - `long_report_stable_hard_fail`:
    - `3518`
    - `3703`
    - `3710`
    - `3755`
    - `3873`
  - `long_report_processing_retry`:
    - `3513`
  - `long_report_mixed_residual`:
    - none
  - `stillUnclassifiedRows: 0`
- First rebuilt Stage 6 wave truth:
  - `eligibleRows: 1`
  - `selectedRows: 1`
  - `pendingRows: 0`
  - the current active Stage 6 wave is exactly:
    - `3513`
- Stage 6 throughput now carries the benchmark proof surface directly:
  - benchmark lead case:
    - `SFY24 ICJIA Annual Report`
  - current benchmark lead-case truth:
    - `terminalState: hard_fail`
    - `dominantFamily: mixed`
    - `finalStopReason: same_family_no_progress`
    - `processingError: false`
- Verified commands for the first Stage 6 slice:
  - `pnpm --dir apps/api exec vitest run src/__tests__/longReportStage6.test.ts`
  - `pnpm agency:analyze-stage6-long-report-forensics`
  - `pnpm agency:build-stage6-long-report-wave`
  - `pnpm agency:validate-control-plane`
- Validation result remained:
  - `ok: true`
- Net Stage 6 state after the first shell/build slice:
  - all `15` long-report rows are represented in explicit Stage 6 truth
  - the active long-report runtime surface is now only `3513`
  - the other `5` non-verified rows are already treated as stable hard-fail closure, not active retries
  - the benchmark proof surface is stable and lane-owned

## 2026-04-01 Stage 5.3 Verification Truth And Retry-Bucket Closure

- The Stage 5 attempt to carry `4156` forward as a verified pass candidate was completed through the repo’s verification/classification flow.
- `scripts/verify-ready-to-replace.ts` now supports:
  - `ICJIA_VERIFY_INCLUDE_PUBLICATION_IDS`
- Important verification-script behavior fix:
  - include-scoped verification runs now merge back into the existing:
    - `ready-to-replace-verification.json`
    - `ready-to-replace-verification.summary.json`
    - `verified-promotion-ledger.json`
    - `verified-promotion-ledger.summary.json`
  - they no longer overwrite the repo-wide verification baseline with a tiny scoped manifest
- A scoped verification run was executed for:
  - `4156`
- Current verification truth for `4156`:
  - verification result: `hard_fail`
  - verified score/grade: `84 / B`
  - blocking local finding keys:
    - `pdfua.font_unicode`
  - so `4156` is not a truthful `verified_pass`
  - the earlier `remediated_pass_candidate` outcome was optimistic and does not survive the repo’s normal verification gate
- Stage 5 routing was tightened again in `apps/api/src/services/fontWaveStage5.ts`:
  - repeated runtime-only unicode rows with:
    - latest outcome `processing_error`
    - deferred reason `excessive_runtime_loop`
    - `skipNextBatch: true`
    - no embedding/type1 signal
    - unicode-only blocking keys
    now route to:
    - `font_unicode_manual_residual`
  - failed Stage 5 pass-candidates with:
    - `verificationClassification: hard_fail`
    - latest outcome `remediated_pass_candidate`
    - unicode-only blocking keys
    now route to:
    - `font_unicode_terminal_survivor`
- Focused Stage 5 verification after the routing changes:
  - `pnpm --dir apps/api exec vitest run src/__tests__/fontWaveStage5.test.ts`
  - `pnpm --dir apps/api exec vitest run src/__tests__/remediationPlanService.test.ts -t "does not repeat generic font unicode repair after a no-effect attempt"`
  - `pnpm --dir apps/api exec vitest run src/__tests__/processedFontCapability.test.ts`
- Rebuilt Stage 5 truth after:
  - `pnpm exec tsx scripts/classify-ready-verification.ts`
  - `pnpm agency:build-control-plane`
  - `pnpm agency:analyze-stage5-font-forensics`
  - `pnpm agency:build-stage5-font-wave`
  - `pnpm agency:validate-control-plane`
  - validation remained `ok: true`
- Final Stage 5 forensics split:
  - `font_unicode_terminal_survivor`:
    - `4156`
  - `font_unicode_manual_residual`:
    - `3838`
    - `4099`
    - `4144`
    - `4151`
    - `4166`
    - `4168`
    - `4172`
    - `4173`
    - `4174`
    - `4176`
    - `4199`
    - `4211`
    - `4214`
  - `embedded_font_repairable`: none
  - `deterministic_unicode_map_repair_available`: none
  - `type1_unicode_fallback_candidate`: none
  - `font_processing_error_retry`: none
  - `stillUnclassifiedRows: 0`
- Final rebuilt Stage 5 wave truth:
  - `eligibleRows: 0`
  - `selectedRows: 0`
  - `pendingRows: 0`
  - no active Stage 5 wave remains
- Stage 5 closure truth:
  - the `font_heavy` cohort now has a stable explicit closure envelope
  - there is no hidden runtime tail left in Stage 5 manifests
  - the cohort closed with:
    - `1` terminal survivor
    - `13` manual residuals
    - `0` active deterministic rows
    - `0` active retry rows
- Stage 5 status: **DONE truthfully**
  - Stage 5 did not end with a verified pass gain
  - it ended by proving the remaining font-heavy corpus belongs in explicit terminal/manual closure buckets rather than further active deterministic remediation

## 2026-04-01 Stage 5.2 Deterministic-Only Font Wave And Retry Separation

- Stage 5 wave selection now excludes `font_processing_error_retry` rows by default in:
  - `apps/api/src/services/fontWaveStage5.ts`
- New default Stage 5 selection rule:
  - `font_processing_error_retry` remains visible in Stage 5 forensics/throughput truth
  - but it is no longer part of the immediate active wave unless explicitly included later
- Focused Stage 5 coverage now verifies:
  - retry rows are not re-selected by default
  - verified-pass rows stay out of the active wave
  - deterministic rows still populate the active wave
- Verified tests after the selector change:
  - `pnpm --dir apps/api exec vitest run src/__tests__/fontWaveStage5.test.ts`
  - `pnpm --dir apps/api exec vitest run src/__tests__/remediationPlanService.test.ts -t "does not repeat generic font unicode repair after a no-effect attempt"`
  - `pnpm --dir apps/api exec vitest run src/__tests__/processedFontCapability.test.ts`
- After rebuild and validation:
  - `pnpm agency:build-control-plane`
  - `pnpm agency:analyze-stage5-font-forensics`
  - `pnpm agency:build-stage5-font-wave`
  - `pnpm agency:validate-control-plane`
  - validation remained `ok: true`
- The rebuilt pre-run active Stage 5 wave became exactly the 6 fresh deterministic ids:
  - `3838`
  - `4099`
  - `4156`
  - `4173`
  - `4176`
  - `4211`
- A second bounded Stage 5 wave was then run with:
  - `ICJIA_REMEDIATION_TIMEOUT_MS=120000 pnpm agency:run-stage5-font-wave`
- Useful Stage 5 execution truth was fully written before the wrapper rolled into the broad `verify-ready` tail:
  - the wrapper was then interrupted after outcomes were persisted so the repo could be rebuilt from the actual Stage 5 results instead of waiting on unrelated staged-file verification
- Deterministic-only wave results by publication id:
  - `4156` -> `remediated_pass_candidate`
    - final score/grade: `100 / A`
    - staged replacement written
    - gate passed cleanly
  - `3838`, `4099`, `4173`, `4176`, `4211` -> `processing_error`
    - deferred reason code: `excessive_runtime_loop`
    - `skipNextBatch: true`
- Important operational nuance:
  - `stage5-font-wave.outcomes.summary.json` currently shows cumulative totals across both Stage 5 waves:
    - `targetCandidates: 6`
    - `processed: 14`
    - `remediatedPassCandidates: 1`
    - `processingError: 13`
    - `remaining: 0`
  - so per-publication truth should be read from the outcomes rows and rebuilt Stage 5 manifests, not from the raw cumulative processed count alone
- Rebuilt Stage 5 post-run truth after the deterministic-only wave:
  - `deterministic_unicode_map_repair_available`:
    - `4156`
  - `font_processing_error_retry`:
    - `3838`, `4099`, `4144`, `4151`, `4166`, `4168`, `4172`, `4173`, `4174`, `4176`, `4199`, `4211`, `4214`
  - `embedded_font_repairable`: none
  - `type1_unicode_fallback_candidate`: none
  - `font_unicode_terminal_survivor`: none
  - `font_unicode_manual_residual`: none
  - `stillUnclassifiedRows: 0`
- Rebuilt Stage 5 wave truth:
  - current selected active wave is now only:
    - `4156`
  - `processingRetryRows: 13`
  - `deterministicUnicodeRepairRows: 1`
  - `pendingWaveRows: 0`
- Important current nuance:
  - `4156` is a real `remediated_pass_candidate` with a staged replacement and clean gate
  - but because the wrapper was interrupted during the broad `verify-ready` tail, Stage 5/control-plane truth has not yet promoted it into verified-pass ledger state
  - so the rebuilt manifests still treat `4156` as the lone deterministic Stage 5 row until verification/promotion truth catches up
- Net Stage 5 state after Stage 5.2:
  - the retry bucket is now clearly separated from the active deterministic surface
  - five additional rows moved from deterministic to bounded retry
  - one row (`4156`) produced the first genuine Stage 5 pass candidate
  - no font-heavy row is unclassified or unowned
  - the next Stage 5 question is whether to verify/promote `4156` first or tighten terminal/manual routing for the now-13-row retry bucket

## 2026-04-01 Stage 5.1 First Font-Wave Execution And Post-Run Routing

- The first bounded live Stage 5 font wave was executed against the initial selected 8-row set:
  - `4144`
  - `4166`
  - `4168`
  - `4199`
  - `4214`
  - `4151`
  - `4172`
  - `4174`
- To keep the first Stage 5 wave bounded and prevent hidden runtime tails, the live run was executed with:
  - `ICJIA_REMEDIATION_TIMEOUT_MS=120000 pnpm agency:run-stage5-font-wave`
- Wave execution truth from `stage5-font-wave.outcomes.summary.json`:
  - `targetCandidates: 8`
  - `processed: 8`
  - `processingError: 8`
  - `remaining: 0`
- The dominant first-run Stage 5 stop reason is now explicit and bounded:
  - outcome status: `processing_error`
  - deferred reason code: `excessive_runtime_loop`
  - gate wording:
    - `Processing exceeded the 2-minute runtime limit.`
    - `Marked as excessive runtime and deferred so the batch can continue.`
- Stage 5 post-run forensics/routing was expanded in `apps/api/src/services/fontWaveStage5.ts`:
  - new explicit Stage 5 dispositions:
    - `font_unicode_terminal_survivor`
    - `font_processing_error_retry`
  - Stage 5 now inspects:
    - latest outcome status
    - latest remediation report planner evidence (`attemptedKeys`, `noEffectKeys`)
    - current blocking finding keys
  - rows that fail boundedly with processing errors no longer remain generic unowned failures
- Rebuilt Stage 5 post-run truth after:
  - `pnpm agency:build-control-plane`
  - `pnpm agency:analyze-stage5-font-forensics`
  - `pnpm agency:build-stage5-font-wave`
  - `pnpm agency:validate-control-plane`
- Current `stage5-font-forensics.summary.json` truth:
  - `deterministic_unicode_map_repair_available`:
    - `3838`, `4099`, `4156`, `4173`, `4176`, `4211`
  - `font_processing_error_retry`:
    - `4144`, `4151`, `4166`, `4168`, `4172`, `4174`, `4199`, `4214`
  - `embedded_font_repairable`: none
  - `type1_unicode_fallback_candidate`: none
  - `font_unicode_terminal_survivor`: none
  - `font_unicode_manual_residual`: none
  - `stillUnclassifiedRows: 0`
- Current rebuilt Stage 5 throughput truth:
  - `totalFontHeavyRows: 14`
  - `verifiedPassRowsInCohort: 0`
  - `remainingFontHeavyRows: 14`
  - `newlyVerifiedPassRowsFromWave: 0`
  - `processingErrorsInWave: 2`
  - `pendingWaveRows: 6`
  - `deterministicUnicodeRepairRows: 6`
  - `processingRetryRows: 8`
  - `stillUnclassifiedRows: 0`
- Current rebuilt active Stage 5 wave is no longer the old initial 8-row set; it now mixes the 6 fresh deterministic candidates plus 2 bounded retry rows:
  - `4173`
  - `4176`
  - `4211`
  - `3838`
  - `4099`
  - `4156`
  - `4144`
  - `4151`
- Focused Stage 5 verification that passed after the post-run routing changes:
  - `pnpm exec vitest run src/__tests__/fontWaveStage5.test.ts`
  - `pnpm exec vitest run src/__tests__/remediationPlanService.test.ts -t "does not repeat generic font unicode repair after a no-effect attempt"`
  - `pnpm exec vitest run src/__tests__/processedFontCapability.test.ts`
  - `pnpm agency:validate-control-plane`
- Net Stage 5 state after the first live wave:
  - Stage 5 is still active
  - no font-heavy row remains an unclassified or unowned generic failure
  - the lane now has a truthful split between:
    - fresh deterministic unicode-map candidates
    - bounded Stage 5 processing retries
  - the next Stage 5 question is whether the retry bucket should be retried immediately, deprioritized behind the remaining deterministic rows, or further split into stricter terminal/manual font buckets

## 2026-04-01 Stage 5 Font Lane Shell And First Forensics Split

- Stage 5 is now the active roadmap lane after Stage 4 closure.
- A first-class Stage 5 shell was added:
  - `apps/api/src/services/fontWaveStage5.ts`
  - `scripts/analyze-stage5-font-forensics.ts`
  - `scripts/build-stage5-font-wave.ts`
  - `scripts/run-stage5-font-wave.ts`
  - package commands:
    - `pnpm agency:analyze-stage5-font-forensics`
    - `pnpm agency:build-stage5-font-wave`
    - `pnpm agency:run-stage5-font-wave`
- Stage 5 now writes dedicated artifacts:
  - `ICJIA-PDFs/manifests/stage5-font-forensics.json`
  - `ICJIA-PDFs/manifests/stage5-font-forensics.summary.json`
  - `ICJIA-PDFs/manifests/stage5-font-wave.json`
  - `ICJIA-PDFs/manifests/stage5-font-wave.summary.json`
  - `ICJIA-PDFs/manifests/stage5-font-throughput.summary.json`
- First Stage 5 forensic truth:
  - `font_heavy` cohort size is `14`
  - all `14` rows are currently `remediated_fail`
  - all `14` are now explicitly classified as:
    - `deterministic_unicode_map_repair_available`
  - no rows are currently classified as:
    - `embedded_font_repairable`
    - `type1_unicode_fallback_candidate`
    - `font_unicode_manual_residual`
  - `stillUnclassifiedRows: 0`
- First Stage 5 work surface is exactly:
  - `3838`, `4099`, `4144`, `4151`, `4156`, `4166`, `4168`, `4172`, `4173`, `4174`, `4176`, `4199`, `4211`, `4214`
- Initial Stage 5 bounded wave now selects `8` ids:
  - `4144`, `4166`, `4168`, `4199`, `4214`, `4151`, `4172`, `4174`
- Current Stage 5 throughput truth after the first build:
  - `totalFontHeavyRows: 14`
  - `verifiedPassRowsInCohort: 0`
  - `remainingFontHeavyRows: 14`
  - `pendingWaveRows: 8`
  - `deterministicUnicodeRepairRows: 14`
  - `stillUnclassifiedRows: 0`
- Stage 5 remediation-planning guardrails were tightened:
  - `repair_font_unicode_maps` is no longer replanned after a `no_effect` attempt
  - `repair_type1_font_unicode_maps` now requires actual Type1 evidence or a prior generic Unicode no-effect path before it becomes selectable
- Verified commands for the first Stage 5 slice:
  - `pnpm agency:analyze-stage5-font-forensics`
  - `pnpm agency:build-control-plane`
  - `pnpm agency:build-stage5-font-wave`
  - `pnpm agency:validate-control-plane`
  - `pnpm exec vitest run src/__tests__/fontWaveStage5.test.ts`
  - `pnpm exec vitest run src/__tests__/remediationPlanService.test.ts -t "does not repeat generic font unicode repair after a no-effect attempt"`
  - `pnpm exec vitest run src/__tests__/processedFontCapability.test.ts`
- Validation result remained:
  - `ok: true`

## 2026-04-01 Stage 4 Runtime Closure — Complete

- All three Stage 4 blockers are resolved:
  1. `4726` completed with status `failed_after_remediation` (grade F→C, 53→78) — no longer in active wave
  2. Court System Get The Facts no longer crashes with `Inspection budget exceeded` — ends as `hard_fail` with `same_family_no_progress`
  3. Kendall County focused rescue convergence gate relaxed — rescue now runs when `latePhaseConvergence.figure_description_state.converged` is true but remaining figure debt is ≤8 (`smallFigureDebtOverride`)
- Key code changes in `agentRemediationService.ts`:
  - `inspectRemediationContext` gracefully falls back to cached data when budget exceeded (instead of throwing)
  - `isInspectionBudgetExhausted()` pre-flight guards at late alt passes (stages 92-94) and other unsafe inspection sites
  - `smallFigureDebtOverride` in `runFocusedFinalRescue` (line ~4155): allows focused rescue to override late convergence when `informativeFigureMissingAltCount <= 8`
- Benchmark truth (fresh run 2026-04-01, all 5 cases re-executed):
  - `processingError: 0` across all 5 cases
  - Kendall County Profile: `hard_fail` B (87) — focused rescue ran but couldn't resolve remaining 4 figures
  - Court System Get The Facts: `hard_fail` C (74)
  - SFY24 ICJIA Annual Report: `hard_fail` B (83)
  - Criminal Sentencing Layout: `hard_fail` C (76)
  - CSEC 2008 Research Bulletin: `hard_fail` D (69)
- Control plane validates: `ok: true`
- Stage 4 status: **DONE** — all blockers resolved, no processing errors, honest hard_fail outcomes

## 2026-04-01 Stage 4 Helper Lifecycle And Single-Row Runtime Checkpoint

- Stage 4 remains blocked by runtime behavior, not routing truth.
- Current active Stage 4 wave is still the single row:
  - `4726`
- A helper-lifecycle supervision pass was implemented in:
  - `apps/api/src/services/pdfStructureBackend.ts`
  - `apps/api/src/services/readingOrderService.ts`
- New helper-runner behavior:
  - structure-helper-backed Python calls now run through a shared supervised runner instead of ad hoc `execFileAsync(...)`
  - the Node caller now tracks helper child processes explicitly
  - timeout and abort paths now attempt to kill the helper process tree
  - focused helper-lifecycle coverage was added in:
    - `apps/api/src/__tests__/pdfStructureBackend.test.ts`
- A Stage 4 verified-pass preservation fix was also added in:
  - `apps/api/src/services/structureWaveStage4.ts`
- New Stage 4 routing rule:
  - when a row has `terminalSurvivorClass === 'staged_pass_candidate_survivor'` and promotion truth shows a backing verified ledger row with `promotionStatus === 'verified_pass'`, Stage 4 must preserve `currentCorpusStatus: verified_pass`
  - it must not demote that row back to `staged_for_replacement`
- This fixed the temporary control-plane inconsistency around:
  - `4037`
  - `4061`
- Verified commands after that fix:
  - `pnpm agency:build-control-plane`
  - `pnpm agency:build-stage4-structure-wave`
  - `pnpm agency:validate-control-plane`
  - validation returned `ok: true`
- A fresh single-row Stage 4 follow-up was rerun for `4726`:
  - `ICJIA_STAGE4_STRUCTURE_ACTIVE_FORENSICS_INCLUDE_IDS=4726 pnpm agency:analyze-stage4-structure-active-forensics`
  - `ICJIA_STAGE4_STRUCTURE_WAVE_INCLUDE_IDS=4726 pnpm agency:run-stage4-structure-wave`
- Current truth from that rerun:
  - `4726` still classifies as:
    - `mixed_structure_figure_residuals`
  - the bounded live rerun again cycled through:
    - long `pdf_structure_helper.py` structure work
    - repeated `alt_text_deep` inspection
    - repeated light inspection / fast analysis follow-up
  - no terminal outcome was written for `4726`
  - after rebuild, Stage 4 still truthfully selects only `4726`
- Helper lifecycle result from the bounded rerun:
  - helper children are now cleanly attributable to the active Stage 4 batch instead of showing up only as stale background leftovers
  - however, sending `TERM` to the Stage 4 process group still left one detached orphan `pdf_structure_helper.py`
  - that orphan had to be killed manually
  - so the helper-lifecycle bug is narrowed but not fully solved:
    - normal/background confusion is improved
    - forced-shutdown cleanup is still incomplete
- Benchmark rerun was executed with:
  - `pnpm agency:benchmark-remediation`
- Current Stage 4 endgate truth remains unchanged:
  - `Court System Get The Facts` still fails as:
    - `processing_error`
  - current benchmark error remains:
    - `Inspection budget exceeded (light=4, deep=9, total=13).`
  - `Criminal Sentencing Layout` remains a `hard_fail` with final figure debt, not a pass regression
  - no `pdf_structure_helper.py` or `pdf_accessibility_extras.py` processes remained after the benchmark completed
- Net result of this checkpoint:
  - routing truth is still aligned
  - `stillUnclassifiedPendingPublicationIds` remains empty
  - Stage 4 is still open because both blockers remain:
    - `4726` runtime/convergence
    - `Court System` benchmark churn endgate
  - the remaining helper-lifecycle defect is specifically:
    - detached orphan cleanup on forced termination of structure-heavy runs

## 2026-04-01 Stage 4 Single-Row Follow-Up

- Stage 4 was narrowed to the single truthful active row:
  - `4726`
- A single-row active-forensics refresh was run:
  - `ICJIA_STAGE4_STRUCTURE_ACTIVE_FORENSICS_INCLUDE_IDS=4726 pnpm agency:analyze-stage4-structure-active-forensics`
- `4726` remained:
  - `mixed_structure_figure_residuals`
- After rebuild and validation:
  - `pnpm agency:build-control-plane`
  - `pnpm agency:build-stage4-structure-wave`
  - `pnpm agency:validate-control-plane`
  - validation remained `ok: true`
  - the truthful active Stage 4 wave remained `4726`
  - `stillUnclassifiedPendingPublicationIds` remained `[]`
- A bounded single-row live follow-up was attempted:
  - `ICJIA_STAGE4_STRUCTURE_WAVE_INCLUDE_IDS=4726 pnpm agency:run-stage4-structure-wave`
- That live follow-up did not write a new terminal outcome for `4726` before being stopped.
  - the row repeatedly cycled through long `pdf_structure_helper.py` structure work plus light-inspection churn
  - evidence included `full_final` structure analysis around `74s` and repeated light inspections around `73s`, `26s`, and `29s`
  - after interruption and rebuild, the truthful active wave still remained `4726`
- Wrapper/teardown follow-up:
  - added an explicit SQLite close path in `apps/api/src/db/sqlite.ts`
  - `scripts/run-priority-remediation-batch.ts` now calls that close path in a `finally` block
  - this did not fully eliminate the operational leak
  - the more important remaining non-exit defect is orphaned `pdf_structure_helper.py` subprocesses during structure-heavy remediation, not just the SQLite handle
- Stage 4 benchmark rerun was executed with:
  - `pnpm agency:benchmark-remediation`
- Current Stage 4 endgate truth after that benchmark:
  - `Court System Get The Facts` still fails as `processing_error`
  - current benchmark error remains:
    - `Inspection budget exceeded (light=4, deep=9, total=13).`
  - `Criminal Sentencing Layout` remains a hard fail, not a pass regression
  - benchmark totals currently show:
    - `pass: 1`
    - `hardFail: 3`
    - `processingError: 1`
  - `stopReasonSignals.boundedRuntimeRetry` is `1`
- Net Stage 4 state after the single-row follow-up:
  - routing truth is still aligned
  - the active wave is still the single row `4726`
  - the remaining blockers are:
    - `4726` structure-helper/runtime convergence
    - orphaned `pdf_structure_helper.py` teardown
    - `Court System` still missing the churn-reduction endgate

## 2026-04-01 Stage 4.14 New-Wave Forensics And Follow-Up

- After the prior Stage 4 wave rolled off, the rebuilt active Stage 4 wave advanced to:
  - `4162`
  - `4501`
  - `4731`
  - `4720`
  - `4506`
  - `4627`
  - `4726`
  - `3567`
- A narrow active-forensics refresh was run only on that new 8-row wave:
  - `ICJIA_STAGE4_STRUCTURE_ACTIVE_FORENSICS_INCLUDE_IDS=4162,4501,4731,4720,4506,4627,4726,3567 pnpm agency:analyze-stage4-structure-active-forensics`
- Stage 4.14 forensic dispositions:
  - `4162` -> `font_text_extractability_survivor`
  - `3567`, `4501`, `4506`, `4627`, `4720`, `4726`, `4731` -> `mixed_structure_figure_residuals`
- After rebuild and validation:
  - `pnpm agency:build-control-plane`
  - `pnpm agency:build-stage4-structure-wave`
  - `pnpm agency:validate-control-plane`
  - validation remained `ok: true`
- The forensic refresh immediately reduced the active Stage 4 wave from `8` rows to `7` rows:
  - `4501`, `4731`, `4720`, `4506`, `4627`, `4726`, `3567`
  - `stillUnclassifiedPendingPublicationIds` became `[]`
- One bounded live Stage 4 follow-up was then run only on that rebuilt 7-row set:
  - `ICJIA_STAGE4_STRUCTURE_WAVE_INCLUDE_IDS=4501,4731,4720,4506,4627,4726,3567 pnpm agency:run-stage4-structure-wave`
- Written terminal outcomes from that bounded rerun:
  - `4501`, `4731`, `3567`, `4720`, `4506`, `4627` -> `failed_after_remediation`
  - dominant stop reason pattern: `same_family_no_progress`
  - no generic timeout wording was introduced
- The Stage 4 wrapper/batch hang reproduced after the candidate loop had effectively finished:
  - `run-stage4-structure-wave.ts` and `run-priority-remediation-batch.ts` were both idle in `ep_poll`
  - `lsof` showed only the SQLite audit DB open, not active PDF/report files
  - `4726` never received a written terminal outcome before the wrapper was killed
- After killing the stuck wrapper and rebuilding again, the truthful active Stage 4 wave is now:
  - `4726`
- Current post-Stage-4.14 truth:
  - `stage4-structure-wave.summary.json` selects only `4726`
  - `stage4-structure-throughput.summary.json` shows:
    - `activeWaveSelectedPublicationIds: [4726]`
    - `stillUnclassifiedPendingPublicationIds: []`
    - `reclassifiedOutOfStructureHeavyRows: 4`
  - cohort shift after the rerun/rebuild:
    - `structure_heavy: 338`
    - `figure_heavy: 494`
- Next step after Stage 4.14 should start from the single-row truthful active wave `4726`, while treating the wrapper non-exit as a separate operational bug.

## 2026-04-01 Stage 4 Active-Wave Selection Truth Fix

- The Stage 4 active-wave selection drift between `4162` and `4169` is now fixed.
- The selection fix was implemented in:
  - `apps/api/src/services/structureWaveStage4.ts`
- New Stage 4 continuation rule:
  - when `activeForensicsRows` are present, unresolved active-forensics dispositions now define the canonical active continuation set
  - unresolved active-forensics rows are:
    - `metadata_navigation_residuals`
    - `mixed_structure_figure_residuals`
    - `structure_processing_error_retry`
  - terminal active-forensics survivor rows are excluded from active continuation
  - the older `activeAnalysisRows` / carried pending-wave truth is now the fallback only when no active forensics rows exist
- Focused regression coverage was added in:
  - `apps/api/src/__tests__/structureWaveStage4.test.ts`
- Verified commands:
  - `pnpm exec vitest run src/__tests__/structureWaveStage4.test.ts`
  - `pnpm agency:build-control-plane`
  - `pnpm agency:build-stage4-structure-wave`
  - `pnpm agency:validate-control-plane`
  - validation remained `ok: true`
- New truthful Stage 4 state from the rebuilt manifests:
  - `stage4-structure-wave.summary.json` now selects and reports:
    - `4755`
    - `4142`
    - `4753`
    - `4084`
    - `4436`
    - `4153`
    - `4167`
    - `4169`
  - `4162` is no longer reintroduced into the active wave
  - `stage4-structure-throughput.summary.json` now aligns active-wave selection with active forensics instead of showing split-brain selection truth
  - `genericTimeoutRows` remains `0`
- Stage 4 is still the active roadmap lane, but the remaining work is now convergence on the truthful active wave rather than repairing reporting or selection drift.

## 2026-04-01 Stage 4 Closure Follow-Up

- The remaining Stage 4 blocker is no longer manifest selection truth.
- Current Stage 4 active-wave truth remains:
  - `4755`
  - `4142`
  - `4753`
  - `4084`
  - `4436`
  - `4153`
  - `4167`
  - `4169`
- A narrow active-forensics refresh was rerun against those exact 8 ids:
  - `ICJIA_STAGE4_STRUCTURE_ACTIVE_FORENSICS_INCLUDE_IDS=4755,4142,4753,4084,4436,4153,4167,4169 pnpm agency:analyze-stage4-structure-active-forensics`
- The refreshed forensics did not change routing:
  - `4084`, `4142`, `4753`, `4755` remain `metadata_navigation_residuals`
  - `4153`, `4167`, `4169`, `4436` remain `mixed_structure_figure_residuals`
- After rebuild:
  - `pnpm agency:build-control-plane`
  - `pnpm agency:build-stage4-structure-wave`
  - `pnpm agency:validate-control-plane`
  - validation remained `ok: true`
- Roadmap/doc wording should now treat Stage 4 as:
  - active-wave truth fixed
  - remaining blocker is canary churn reduction plus active-wave convergence

## 2026-04-01 Stage 3 Truthful Closure

- Stage 3 is now truthfully closed as a roadmap stage.
- The closure fix was implemented in:
  - `apps/api/src/services/figureWaveStage3.ts`
- New Stage 3 closure rule:
  - stale pending figure-wave carryover is dropped when a prior Stage 3 wave has already written truthful outcomes, produced `0` newly verified passes, and the remaining pending ids are still fully represented by the stable Stage 3 bucket model
  - in that situation, the rebuilt Stage 3 wave should represent the next truthful figure-only selection instead of preserving stale pending throughput state
- Focused test coverage was added in:
  - `apps/api/src/__tests__/figureWaveStage3.test.ts`
- After rebuild:
  - `pnpm agency:build-control-plane`
  - `pnpm agency:build-stage3-figure-wave`
  - `pnpm agency:validate-control-plane`
  - validation remained `ok: true`
- New truthful Stage 3 state from the rebuilt manifests:
  - `stage3-figure-wave.summary.json` now shows:
    - `pendingRows: 0`
    - selected ids:
      - `3614`
      - `3794`
      - `4185`
      - `4481`
      - `4020`
      - `4551`
      - `3878`
      - `3886`
  - `stage3-figure-throughput.summary.json` now shows:
    - `totalFigureHeavyRows: 493`
    - `verifiedPassRowsInCohort: 19`
    - `newlyVerifiedPassRowsFromWave: 0`
    - `remainingFigureHeavyRows: 474`
    - `processingErrorsInWave: 4`
    - `hardFailsInWave: 8`
    - `ownershipClearedFigureDebtRows: 1`
    - `mixedFigureStructureDebtRows: 279`
    - `massUnresolvedFigureDebtRows: 43`
    - `figureProcessingErrorRetryRows: 53`
    - `genericTimeoutRows: 0`
    - `pendingWaveRows: 0`
- Stage 3 endgate interpretation:
  - generalized figure/ownership remediation is complete as a lane
  - benchmark and representative canaries remain stable
  - generic timeout wording remains eliminated
  - Stage 3 is not a meaningful expected conversion engine anymore
  - residual mixed figure+structure spillover and saturated hard cases should be handled by Stage 4+ rather than keeping Stage 3 open
- Roadmap status should now be treated as:
  - Stage `0`: done
  - Stage `1`: done
  - Stage `2`: done
  - Stage `3`: done
  - Stage `4`: in progress / active lane

## 2026-04-01 Stage 2 Truthful Closure

- Stage 2 is now truthfully closed as a roadmap stage.
- The closure fix was implemented in:
  - `apps/api/src/services/shortCohortStage2.ts`
- New Stage 2 closure rule:
  - non-`verified_pass` `short_high_likelihood` rows are reclassified out of Stage 2 when they already carry a Stage 4 terminal survivor class
  - `near_pass_grade_only` now escalates to `structure_heavy`
  - `font_text_extractability_survivor` now escalates to `font_heavy`
  - other Stage 4 structure survivor classes default to `structure_heavy` for Stage 2 handoff
- Tests were added in:
  - `apps/api/src/__tests__/shortCohortStage2.test.ts`
- The specific stale Stage 2 backlog rows handed out of `short_high_likelihood` were:
  - `4023`
  - `4054`
  - `4067`
- Those rows were not real Stage 2 throughput backlog anymore:
  - all three were already Stage 4 terminal survivors with `terminalSurvivorClass: near_pass_grade_only`
  - after the fix they moved from `short_high_likelihood` to `structure_heavy`
- After rebuild:
  - `pnpm agency:build-control-plane`
  - `pnpm agency:build-stage2-short-wave`
  - `pnpm agency:validate-control-plane`
  - validation remained `ok: true`
- New truthful Stage 2 state:
  - `short_high_likelihood: 20` rows total
  - all `20` are `verified_pass`
  - `0` `remediated_fail`
  - `0` `processing_error`
  - `stage2-short-cohort-wave.json` selects `0` rows
  - `stage2-short-cohort-throughput.summary.json` shows:
    - `verifiedPassRowsInCohort: 20`
    - `remainingRowsInCohort: 0`
    - `pendingWaveRows: 0`
- Roadmap status should now be treated as:
  - Stage `0`: done
  - Stage `1`: done
  - Stage `2`: done
  - Stage `3`: substantially done
  - Stage `4`: in progress / active lane

## 2026-03-31 Roadmap Doc Refresh

- The staged ICJIA-to-general-API roadmap is now explicitly documented in:
  - `docs/12-icjia-corpus-and-general-api-roadmap.md`
- The roadmap now includes all stages `0` through `8` with:
  - a clear title
  - current status
  - goal
  - endgate
- Current roadmap status snapshot:
  - Stage `0`: done
  - Stage `1`: done
  - Stage `2`: substantially done
  - Stage `3`: substantially done
  - Stage `4`: in progress / active lane
  - Stage `5`: not started as a dedicated closure phase
  - Stage `6`: not started as a dedicated closure phase
  - Stage `7`: not started as a dedicated extraction phase
  - Stage `8`: not started as a dedicated promotion phase

## 2026-03-31 Stage 4.13

- A second narrow Stage 4 active-wave forensic pass was run against:
  - `4755`
  - `4142`
  - `4753`
  - `4084`
  - `4436`
  - `4153`
  - `4167`
  - `4169`
- The targeted forensic pass again resolved all `8` rows from `terminal_report` evidence in:
  - `ICJIA-PDFs/manifests/stage4-structure-active-forensics.json`
  - `ICJIA-PDFs/manifests/stage4-structure-active-forensics.summary.json`
- Stage 4.13 forensic dispositions:
  - `metadata_navigation_residuals`:
    - `4084`
    - `4142`
    - `4753`
    - `4755`
  - `mixed_structure_figure_residuals`:
    - `4153`
    - `4167`
    - `4169`
    - `4436`
- Reporting-wave alignment was patched in:
  - `scripts/build-stage4-structure-wave.ts`
- New reporting-wave rule:
  - do not preserve an older fully terminal reporting wave when the freshly built active wave has advanced to a different unresolved set
  - prefer the freshly built `nextWave` when it has selected rows
  - only fall back to the latest completed wave when there is no newer active unresolved wave to report
- After the Stage 4.13 rebuild/validate sequence:
  - `pnpm agency:build-control-plane`
  - `pnpm agency:build-stage4-structure-wave`
  - `pnpm agency:validate-control-plane`
  - validation remained clean with `ok: true`
- Practical effect of the reporting fix:
  - `stage4-structure-wave.summary.json` no longer stayed pinned to the older completed 5-row cohort `3465/3671/4023/4054/4067`
  - reporting now reflects the current selected Stage 4 wave instead of that stale completed cohort
- After rebuild, the selected/active Stage 4 wave settled to:
  - `4755`
  - `4142`
  - `4753`
  - `4084`
  - `4162`
  - `4436`
  - `4153`
  - `4167`
- Important nuance:
  - even though the Stage 4.13 forensic target included `4169`, the rebuilt active/selected wave reintroduced `4162` and excluded `4169`
  - this indicates the current active-wave continuation/selection inputs still pull the prior unresolved structure-heavy set back into the rebuilt wave
  - the stale reporting-wave pinning bug is fixed, but active-wave selection behavior itself was not changed in Stage 4.13
- Next step should be a focused forensic/selection follow-up on why rebuild still prefers `4162` over `4169`, not another blind Stage 4 rerun.

## 2026-03-31 Stage 4.12 Follow-Up

- The narrow Stage 4.12 active-wave forensic follow-up was run against the exact 8-row set:
  - `4755`
  - `4142`
  - `4753`
  - `4084`
  - `4162`
  - `4436`
  - `4153`
  - `4167`
- The targeted forensic pass resolved all `8` rows from `terminal_report` evidence in:
  - `ICJIA-PDFs/manifests/stage4-structure-active-forensics.json`
  - `ICJIA-PDFs/manifests/stage4-structure-active-forensics.summary.json`
- Forensic dispositions for that 8-row set:
  - `metadata_navigation_residuals`:
    - `4084`
    - `4142`
    - `4753`
    - `4755`
  - `font_text_extractability_survivor`:
    - `4162`
  - `mixed_structure_figure_residuals`:
    - `4153`
    - `4167`
    - `4436`
- After the forensic refresh, the truthful rebuild/validate sequence was completed with:
  - `pnpm agency:build-control-plane`
  - `pnpm agency:build-stage4-structure-wave`
  - `pnpm agency:validate-control-plane`
- Validation remained clean after rebuild:
  - `pnpm agency:validate-control-plane` returned `ok: true`
- The previous active Stage 4 wave no longer survived intact after rebuild:
  - `4162` was reclassified out of the active Stage 4 wave as `font_text_extractability_survivor`
  - `4169` entered as the next pending eligible Stage 4 row
- The rebuilt active Stage 4 wave is now:
  - `4755`
  - `4142`
  - `4753`
  - `4084`
  - `4436`
  - `4153`
  - `4167`
  - `4169`
- Important reporting nuance:
  - `stage4-structure-wave.summary.json` still reports the older completed 5-row reporting wave `3465/3671/4023/4054/4067`
  - this is expected from the current reporting-wave pinning logic and does not mean the active wave failed to advance
- Next step after this follow-up should be another narrow Stage 4.x forensic/routing pass on the new active 8-row set, not a blind Stage 4 rerun.

## 2026-03-31 Stage 4.12

- Stage 4.11 was committed and pushed as `5581aa8` (Implement Stage 4.11 homogeneous survivor routing).
- A real Stage 4.12 wave was run on:
  - `4755`
  - `4142`
  - `4753`
  - `4084`
  - `4162`
  - `4436`
  - `4153`
  - `4167`
- The Stage 4.12 run wrote `0` new terminal outcomes before falling back into inspection churn.
- The truthful fallback rebuild was completed with:
  - `pnpm agency:build-control-plane`
  - `pnpm agency:build-stage4-structure-wave`
  - `pnpm agency:validate-control-plane`
- After the fallback rebuild, the active Stage 4 wave remained unchanged:
  - `4755`
  - `4142`
  - `4753`
  - `4084`
  - `4162`
  - `4436`
  - `4153`
  - `4167`
- Next step should be a narrow Stage 4.12 forensic follow-up on that exact 8-row set, not another blind rerun.

## 2026-03-31 Stage 4.11

- Stage 4.11 added a new Stage 4 terminal survivor class: `metadata_font_structure_survivor`.
- A homogeneous-wave forensic pass now writes:
  - `ICJIA-PDFs/manifests/stage4-structure-homogeneous-analysis.json`
  - `ICJIA-PDFs/manifests/stage4-structure-homogeneous-analysis.summary.json`
- The homogeneous Stage 4 wave `3655/3781/3785/3793/3870/3919/3924/4045` was terminalized as `metadata_font_structure_survivor` from terminal-report evidence, not rerun live.
- Those rows should be excluded from metadata-first Stage 4 retry selection unless a later Stage 4.x pass explicitly targets metadata+font+structure survivors.
- Stage 4 reporting now exposes:
  - `metadataFontStructureSurvivorPublicationIds`
  - `homogeneousAnalysisPublicationIds`
  - `homogeneousAnalysisByDisposition`
- After Stage 4.11, the rebuilt active Stage 4 wave is:
  - `4755`
  - `4142`
  - `4753`
  - `4084`
  - `4162`
  - `4436`
  - `4153`
  - `4167`
- Stage 4 canaries now include `3655` as the representative `metadata_font_structure_survivor`.

## 2026-03-31 Stage 4.5

- Stage 4 remains the active lane.
- Stage 4.5 corrected reporting drift so the Stage 4 reporting wave can advance to the latest fully terminal eight-row cohort instead of staying pinned to the older Stage 4.4 five-row fallback.
- Latest completed eight-row Stage 4 reporting wave:
  - `3767`
  - `3771`
  - `3964`
  - `3981`
  - `4046`
  - `4047`
  - `4050`
  - `4135`
- Truth for that wave:
  - `4047` is a `remediated_pass_candidate` / staged local replacement and is tracked as `staged_pass_candidate_survivor`
  - `4046`, `4050`, `4135` are `near_pass_grade_only`
  - `3767`, `3981`, and `3771` are `font_text_extractability_survivor`
  - `3964` is `reading_order_only_survivor`
- `3771` should no longer be treated as a generic metadata/navigation hard fail:
  - latest blocker includes `pdfua.font_unicode`
  - unresolved categories include `Text Extractability`
  - so it belongs with the font/text-extractability survivor class
- Stage 4 canaries should prefer the latest terminal shapes:
  - `4047` for staged pass candidate
  - one of `4046` / `4050` / `4135` for near-pass
  - `3767` or `3981` for font/text extractability
  - `3964` for reading-order-only
  - keep `3671` as figure spillover
- Stage 4.6 reconciliation rule: when a Stage 4 row is a `staged_pass_candidate_survivor`, Stage 4 routing must preserve `currentCorpusStatus: staged_for_replacement` instead of flattening it back to `remediated_fail`.

This file stores durable project facts, proven workflows, known exceptions, and anything we should not forget across chats.

## Important Verification Finding

- Re-verification of the `ready_to_replace` bucket showed a major mismatch:
  - `392` publication rows checked
  - `164` verified pass
  - `3` soft-fail advisory
  - `225` hard fail
- The dominant hard-fail patterns are:
  - `pdfua.untagged_rendered_images`
  - `Alt Text on Images`
  - `PDF/UA Compliance`
  - then smaller buckets for:
    - `pdfua.logical_structure`
    - `pdfua.heading_content_quality`
    - `pdfua.font_unicode`
- Important root-cause clue:
  - the staged replacement bytes for at least some batch-produced files match the remediated artifact exactly
  - but the saved remediation report says `100 / A` while a later direct re-analysis of those same bytes scores them much lower
- Likely code-level cause:
  - in `apps/api/src/services/agentRemediationService.ts`, late-stage mutations can still change `workingBuffer` after the last authoritative `analyzePDF(... full_final ...)`
  - especially after `applyReviewedAltTextSidecar()` and `runFinalResidualRepairs()`
  - the function then returns `finalResult: currentResult` without always re-running a final authoritative analysis on the final bytes
  - so the batch can record a stale optimistic `finalResult` that does not match the actual saved/staged PDF bytes
- This has now been patched:
  - `agentRemediationService.ts` now always performs one last authoritative `full_final` analysis on the exact final bytes after all late-stage cleanup/mutation steps
  - the remediation gate should now reflect the actual saved/staged PDF bytes rather than an earlier optimistic snapshot
  - a focused final rescue pass was also added for the most common residual families:
    - Acrobat-style image ownership / alt-text residuals
    - font Unicode residuals
    - logical-structure / heading residuals
  - semantic-enrichment provider cooldown errors are now treated as recoverable and fall back to heuristic/native repair instead of crashing the whole remediation
  - loop guards were tightened:
    - stable-state repeat limit reduced
    - coarse-state loop detection added using blocking findings + unresolved categories
    - some late cleanup pass counts were reduced to stop futile loops earlier
  - a hard per-file inspection budget was added:

## 2026-03-29 Remediation Improvements

- Post-ownership figure follow-up is now explicit in `apps/api/src/services/agentRemediationService.ts`:
  - `runHeuristicFigureFallbackStage(...)` now supports a bounded `maxCandidates` limit.
  - a new bounded post-ownership figure-alt pass runs:
    - after Acrobat ownership convergence
    - after final residual repairs
  - late heuristic alt sweeps are capped to the same bounded candidate count to reduce long cleanup tails.
  - goal:
    - when `repair_other_elements_alt_text` or related ownership cleanup creates new `/Figure` candidates, the pipeline now gives those figures an immediate chance to receive alt text instead of waiting for a later coarse stage boundary.

- General repair improvement in `apps/api/scripts/pdf_structure_helper.py`:
  - `repair_other_elements_alt_text` can now artifact decorative untagged direct-image draws even when the PDF has no existing `StructTreeRoot`.
  - Verified on `CountyProfiles/Kendall.pdf`:
    - before: `5` Acrobat ownership-risk nodes
    - after direct helper repair: `0` ownership-risk nodes
    - applied mutations: `5` `/Artifact` wraps

- General repair improvement for mixed text/graphics ownership:
  - the helper no longer rejects safe mixed-MCID cases simply because the risk reports multiple MCIDs.
  - it now prefers the node's direct MCIDs, preserves already text-only direct MCIDs, and splits only the genuinely mixed direct groups while preserving nested child structure.
  - Verified on `Bulletins/CSEC 2008 Research Bulletin.pdf`:
    - before: `1` Acrobat ownership-risk node on `obj:204 0 R`
    - after helper repair: `0` ownership-risk nodes
    - applied mutations:
      - split mixed ownership on direct MCID groups
      - preserved already text-only direct MCID ownership
      - created sibling `/Figure` element for the graphics segment

- General throughput improvement for image-heavy files:
  - `apps/api/src/services/pdfRemediationTools.ts`
  - `repair_other_elements_alt_text` budget increased from:
    - `maxRepairsPerRun: 192` -> `512`
    - `maxElapsedMs: 20000` -> `45000`
  - Representative result on `GetTheFacts/GTF_CourtSystem.pdf` with direct backend test:
    - previous focused repro with lower budget repaired `50` ownership risks and left `148`
    - new focused repro repaired `116` ownership risks and left `82`
  - This is a real improvement in one-pass repair coverage for image-heavy PDFs.

- Important scoring-model caveat:
  - the ownership repair can be real even when the remaining debt is now a plain missing-figure-alt problem rather than an Acrobat ownership problem.
  - Verified on `CSEC 2008 Research Bulletin.pdf`:
    - helper repair removed all Acrobat ownership-risk nodes (`afterRisks: 0`)
    - but the repaired file still contains informative `/Figure` nodes with no `/Alt`
    - full analyzer now reports this coherently after the verifier patch:
      - local standards include `pdfua.figure_alt_or_artifact`
      - `Alt Text on Images` score remains `0`
      - `PDF/UA Compliance` score remains `20`
  - Verifier/scoring fix applied:
    - `apps/api/src/services/localStandardsService.ts`
    - added blocking finding `pdfua.figure_alt_or_artifact`
    - this catches informative `/Figure` nodes that still lack alternate text or decorative artifact treatment
  - Result:
    - the verifier no longer produces the inconsistent state “alt score 0 but no local alt-related blocking finding”
    - ownership repairs are now distinguished cleanly from the remaining figure-description debt
    - light inspections capped
    - deep inspections capped
    - total inspections capped
  - representative runtime probe:
    - `CrimSentencLayout.pdf` previously kept looping until an outer timeout
    - after the inspection-budget change, it now exits much earlier with controlled `EXCESSIVE_RUNTIME` once the remediation path burns through repeated deep inspections
  - isolated benchmark rerun started:
    - manifest:
      - `ICJIA-PDFs/manifests/remediation-benchmark-candidates.json`
    - outcomes:
      - `ICJIA-PDFs/manifests/remediation-benchmark-outcomes.json`
    - benchmark artifact roots:
      - `ICJIA-PDFs/reports/test-runs/remediation-benchmark/`
      - `ICJIA-PDFs/reports/failures/remediation-benchmark/`
      - `ICJIA-PDFs/artifacts/remediated-pdfs/remediation-benchmark/`
      - `ICJIA-PDFs/artifacts/remediation-attempts/remediation-benchmark/`
      - `ICJIA-PDFs/staging/benchmark-to-replace/`
    - the benchmark runner now supports env overrides for those roots in `scripts/run-priority-remediation-batch.ts`
  - first benchmark result:
    - `3614` `KENDALL County Profile`
    - old batch runtime:
      - `890085ms`
    - old batch result:
      - recorded as `100 / A` and `ready_to_replace`
    - later verification result:
      - `81 / B` with `pdfua.untagged_rendered_images`
    - benchmark rerun result:
      - `processing_error` in about `83251ms`
      - this indicates the new runtime guard is preventing another long false-pass loop, though the current outcome message still reflects the older generic timeout phrasing for that first already-written record
  - concrete alt-text / image-ownership fix added in `apps/api/scripts/pdf_structure_helper.py`:
    - `repair_other_elements_alt_text` now artifacts decorative untagged images even when the PDF has no existing struct tree
    - before this change, decorative `untagged_image_direct` / `untagged_image_mcid` cases returned `No struct tree root...` and did nothing
    - validated on the original source `Kendall.pdf`:
      - before repair:
        - 5 `untagged_image_direct` Acrobat-risk nodes
      - after direct `repair_other_elements_alt_text` run:
        - status `applied`
        - 5 mutations written as `/Artifact`
        - remaining Acrobat ownership-risk node count dropped to `0`
    - this should help county-profile / bulletin-style PDFs that have decorative page graphics on otherwise untagged files

- End-to-end follow-up validation after the bounded post-ownership pass:
  - representative full-agent reruns:
    - `Bulletins/CSEC 2008 Research Bulletin.pdf`
    - `CountyProfiles/Kendall.pdf`
  - result:
    - the new handoff path is active, but these representative files still terminate on the inspection-budget guard before reaching a stable passing result
    - `CSEC` exited with:
      - `Inspection budget exceeded (light=9, deep=5, total=14)`
    - `Kendall` exited with:
      - `Inspection budget exceeded (light=0, deep=9, total=9)`
  - practical takeaway:
    - the new post-ownership figure-alt handoff is a real improvement in repair sequencing
    - but it is not yet sufficient to turn these harder figure/structure PDFs into successful full remediations
    - next remaining bottleneck is still repeated inspection churn, not just missing figure candidate routing

- Inspection-churn bug fix in `apps/api/src/services/agentRemediationService.ts`:
  - `inspectRemediationContext(...)` was incrementing the light/deep inspection counters before deciding whether it could reuse a cached context for the same buffer.
  - that meant harmless cache reuses were still burning the inspection budget and could contribute to false `EXCESSIVE_RUNTIME` outcomes.
  - this is now patched:
    - inspection counters only increment when a real fresh inspect is required
    - cache rebind/reuse no longer consumes budget
  - representative reruns after the patch:
    - `CSEC 2008 Research Bulletin.pdf`
    - `Kendall.pdf`
  - outcome:
    - they still remain expensive and can still hit the budget on real deep inspections
    - but they no longer fail as early due to budget being consumed by cached context reuse
  - practical meaning:
    - runtime accounting is now more honest
    - any remaining `EXCESSIVE_RUNTIME` on these cases reflects real inspection churn, not a cache-accounting bug

- Batch snapshot reuse improvement in `apps/api/src/services/agentRemediationService.ts`:
  - batched structure mutations were previously run with `includeSnapshot: false`
  - after a successful batch mutation, the pipeline would immediately pay for a fresh inspect to rebuild the same structure state the backend already knew
  - this is now improved in two places:
    - main batched stage executor
    - semantic-stage batched execution
  - they now request backend snapshots and rebind the next remediation context from that snapshot instead of always re-inspecting immediately
  - representative rerun:
    - `CountyProfiles/Kendall.pdf`
  - outcome:
    - the file still remains expensive and still spends real time in deep structure/alt inspections
    - but the pipeline now avoids some redundant post-batch re-inspection churn and progresses further on real work before the remaining hard bottlenecks appear
  - practical takeaway:
    - another real source of wasted inspection time has been removed
    - the remaining runtime pain is now more concentrated in genuinely expensive deep inspections, especially `structureInspect`-heavy passes

- 2026-03-29 remediation-system implementation pass:
  - `apps/api/src/services/agentRemediationService.ts`
    - added explicit internal remediation-phase tracking for:
      - `ownership_state`
      - `figure_description_state`
      - `structure_state`
    - deep alt inspection can now downgrade to `light` when the relevant phase state has stabilized and no phase-mutating tool has rerun
    - structure-deep analysis requests now flow through a downgrade helper instead of unconditionally asking for deep structure scoring
    - changed-document actions now reset only the relevant inspection phases instead of blindly forcing every phase back to “dirty”
    - remediation runs now record internal metrics for:
      - fresh vs reused light/deep inspections
      - deep-to-light downgrades
      - ownership risk counts before/after
      - informative missing-alt counts before/after
      - decorative figure counts before/after
      - structure deep-analysis counts
    - these metrics are now attached to `DocumentModel.remediationMetrics` and emitted in the `pdf_remediation_timing` log line
  - `apps/api/src/services/documentModel.ts`
    - added optional `remediationMetrics` block to the document model so runs can persist phase-aware runtime and figure/ownership summaries
  - `scripts/run-priority-remediation-batch.ts`
    - excessive-runtime notes are now classified more explicitly so the output can distinguish:
      - inspection-budget exhaustion
      - repeated ownership/structure verification churn
      - generic timeout/runtime exhaustion
  - new benchmark harness:
    - `scripts/run-remediation-regression-benchmark.ts`
    - fixed cohort includes:
      - `Kendall.pdf`
      - `CSEC 2008 Research Bulletin.pdf`
      - `GTF_CourtSystem.pdf`
      - `SFY24 ICJIA Annual Report`
      - `CrimSentencLayout.pdf`
    - writes summary to:
      - `ICJIA-PDFs/manifests/remediation-regression-benchmark.summary.json`
    - artifacts root:
      - `ICJIA-PDFs/artifacts/remediation-regression-benchmark/`

- 2026-03-30 figure-description convergence follow-up:
  - `apps/api/src/services/agentRemediationService.ts`
    - `runFocusedFinalRescue()` now has a figure-rescue local stop-state instead of freely re-entering deep figure cleanup.
    - new behavior:
      - tracks whether focused figure rescue actually ran
      - skips reopening deep figure rescue when `figure_description_state` is already `lateConverged`
      - uses a figure-only late-rescue path once ownership risk is `0` and the remaining blocking debt is primarily `pdfua.figure_alt_or_artifact`
      - treats large unchanged informative-figure debt as a fast-fail signal rather than spending repeated deep follow-ups
      - records additive figure stop reasons:
        - `no_mutation`
        - `no_debt_reduction`
        - `same_blocking_keys`
        - `completed`
  - `apps/api/src/services/documentModel.ts`
    - `remediationMetrics.phases.figureDescriptionState` now optionally exposes:
      - `focusedRescueRan`
      - `focusedRescueSkippedBecauseLateConverged`
      - `finalStopReason`
  - `scripts/run-remediation-regression-benchmark.ts`
    - benchmark outcomes now include additive `figurePhaseDiagnostic`
    - processing errors with `Inspection budget exceeded ...` are derived as:
      - `finalStopReason: budget_exhausted`
    - script is now safe to import in tests because it only calls `main()` on direct execution
  - focused validation added:
    - `apps/api/src/__tests__/agentRemediationService.test.ts`
      - figure-only rescue routing
      - large unchanged figure debt stop
      - genuine figure-debt improvement allows one more follow-up
    - `apps/api/src/__tests__/runRemediationRegressionBenchmark.test.ts`
      - benchmark figure-phase diagnostic derivation

- 2026-03-30 residual-family churn control pass:
  - `apps/api/src/services/agentRemediationService.ts`
    - added a shared residual-cleanup tracker for pre-final-rescue churn control
    - deep follow-up admission can now be denied when the same residual family already changed bytes without measurable progress
    - residual cleanup now distinguishes buckets:
      - `structure`
      - `figure`
      - `mixed`
      - `unknown`
    - late figure sweeps are now deferred when structure or mixed residual debt is still unconverged
    - `runFinalResidualRepairs()` now records residual-family progress and can stop early on:
      - `same_family_no_progress`
      - `no_mutation`
      - `family_shifted`
  - `apps/api/src/services/documentModel.ts`
    - `remediationMetrics` now optionally includes:
      - `phases.structureState.finalStopReason`
      - `residualCleanup.dominantFamily`
      - `residualCleanup.finalStopReason`
  - `scripts/run-remediation-regression-benchmark.ts`
    - benchmark outcomes now include additive `residualCleanupDiagnostic`
    - processing errors with inspection-budget wording derive:
      - `residualCleanupDiagnostic.finalStopReason: budget_exhausted`
  - validation:
    - `pnpm --filter api build`
    - focused helper tests for residual cleanup progress, deep-follow-up admission, and late-figure deferral all passed
  - fresh post-patch benchmark rerun launched with:
    - summary:
      - `ICJIA-PDFs/manifests/remediation-regression-benchmark.residual-churn.summary.json`
    - artifacts:
      - `ICJIA-PDFs/artifacts/remediation-regression-benchmark-residual-churn/`

- 2026-03-30 long-range planning artifact:
  - primary roadmap for finishing the ICJIA corpus and extracting a reusable remediation API:
    - `docs/12-icjia-corpus-and-general-api-roadmap.md`
  - this doc is the main staged plan for:
    - cohort-based completion of remaining ICJIA PDFs
    - strict replace-only-after-verified-pass workflow
    - extraction of a self-contained verbose grader/fixer API suitable for upstream integration
    - package command:
      - `pnpm agency:benchmark-remediation`
  - validation notes:
    - `vitest` is not installed in this workspace, so the targeted unit test run could not be executed via `pnpm exec vitest`
    - the live regression benchmark harness was started successfully and began processing the cohort
  - follow-up churn-reduction implementation:
    - `apps/api/src/services/agentRemediationService.ts`
      - added explicit late-phase convergence tracking for:
        - `ownership_state`
        - `figure_description_state`
        - `structure_state`
      - late loops now compare phase-progress snapshots that include:
        - ownership risk count
        - informative missing-alt figure count
        - decorative figure count
        - relevant blocking local finding keys
        - relevant unresolved issue labels
        - key category scores
      - Acrobat ownership convergence now records whether a pass materially reduced debt and can mark the ownership phase late-converged after repeated no-progress passes
      - late figure-alt sweep stages now share one guard for stages:
        - `92`
        - `93`
        - `94`
        - `96`
      - those sweeps now short-circuit when:
        - the figure-description phase is already converged
        - there was no recent relevant mutation
        - the previous pass made no progress
      - added a stable light-verification signature helper so unchanged late light checks can reuse cached light context instead of always consuming another inspection
      - final authoritative re-analysis now prefers cache rebind / safe inspection reuse before forcing another fresh inspect
    - `apps/api/src/services/documentModel.ts`
      - `remediationMetrics.phases.*` now optionally includes:
        - `lateConverged`
    - `scripts/run-remediation-regression-benchmark.ts`
      - benchmark outcomes now include final `remediationMetrics`
      - benchmark outcomes now include derived `inspectionProfile` with:
        - `pattern`
        - `dominantPhase`
        - `deepDowngradedToLight`
      - benchmark summary now aggregates by:
        - inspection pattern
        - dominant remediation phase
        - generic-timeout-wording bucket
      - benchmark harness now checkpoints after every completed case to:
        - `ICJIA-PDFs/manifests/remediation-regression-benchmark.summary.json`
      - the summary now records:
        - `status`
          - `running`
          - `completed`
          - `crashed`
        - `startedAt`
        - `latestCompletedCase`
        - `fatalError`
      - reruns can now resume from already-completed benchmark cases recorded in the summary file
    - `scripts/run-priority-remediation-batch.ts`
      - excessive-runtime classification now parses explicit `light/deep/total` inspection-budget tuples first
      - goal:
        - avoid misleading generic timeout wording when the real cause is inspection-budget exhaustion
    - focused validation now works in this workspace:
      - `pnpm --filter api exec vitest run src/__tests__/agentRemediationService.test.ts`
      - targeted helper and nearby regression checks passed for:
        - ownership progress detection
        - stable light-verification short-circuit
        - late figure-sweep no-progress stop
        - metadata-only cached-context path
        - final tab-order cleanup path
        - representative native no-effect path

## Current Verified State

- Strapi admin backend:
  - `https://agency.icjia-api.cloud`
- GraphQL endpoint:
  - `https://agency.icjia-api.cloud/graphql`
- root environment file:
  - `.env`
- read-only connection test:
  - `pnpm agency:test`

Current verified account state:

- authenticated successfully via `/admin/login`
- user:
  - `Eric Henderson`
- role:
  - `Super Admin`

## SSH / SFTP

Dedicated keypair created for archive/server access:

- private key path:
  - `/home/hendo420/pdfaf/.tmp/ssh/icjia_archive_ed25519`
- public key path:
  - `/home/hendo420/pdfaf/.tmp/ssh/icjia_archive_ed25519.pub`

Current verified access:

- archive server:
  - `forge@143.244.146.43`
- agency media server:
  - `forge@192.241.146.85`
- researchhub uploads server:
  - `forge@157.230.3.215`

Useful connection forms:

- `ssh -i /home/hendo420/pdfaf/.tmp/ssh/icjia_archive_ed25519 forge@143.244.146.43`
- `sftp -i /home/hendo420/pdfaf/.tmp/ssh/icjia_archive_ed25519 forge@143.244.146.43`
- `ssh -i /home/hendo420/pdfaf/.tmp/ssh/icjia_archive_ed25519 forge@192.241.146.85`
- `ssh -i /home/hendo420/pdfaf/.tmp/ssh/icjia_archive_ed25519 forge@157.230.3.215`

## Publication Counts

Current verified publication counts:

- aggregate publication records:
  - `1133`
- published/listable publication rows exported through GraphQL:
  - `1101`
- PDF-backed publication rows:
  - `1056`
- non-PDF rows:
  - `45`
- unique PDF URLs across all live publication rows:
  - `1022`

Important counting note:

- `1056` is the number of live publication rows with PDF `fileURL`s
- it is not the same thing as unique PDF files on disk
- multiple publication rows can point at the same underlying URL/file

## PDF Storage Map

Current verified PDF storage split by publication rows:

- legacy archive replacement paths:
  - `927`
- `agency` upload replacement paths:
  - `20`
- `researchhub` upload replacement paths:
  - `109`

Current verified 3-server storage map:

- `forge@143.244.146.43`
  - backs legacy archive URLs:
    - `https://archive.icjia-api.cloud/files/...`
    - `https://archive.icjia.cloud/files/...`
- `forge@192.241.146.85`
  - backs `agency` upload URLs:
    - `https://agency.icjia-api.cloud/uploads/...`
- `forge@157.230.3.215`
  - backs `researchhub` upload URLs:
    - `https://researchhub.icjia-api.cloud/uploads/...`
    - and the lone legacy-site path:
      - `https://icjia.illinois.gov/researchhub/files/...`

Operational consequence:

- do not assume all Strapi-style upload PDFs live on the agency server
- before replacing any `/uploads/...` PDF, confirm which host actually serves it

## Legacy Archive PDFs

Legacy archive example:

- public URL:
  - `https://archive.icjia-api.cloud/files/icjia/pdf/ADAM/ADAM2.pdf`
- server file path:
  - `/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/ADAM/ADAM2.pdf`

Current verified archive app root:

- `/home/forge/archive.icjia-api.cloud`

Current verified archive content root:

- `/home/forge/archive.icjia-api.cloud/root/files`

Additional verified archive facts:

- the raw legacy archive tree originally contained many more PDFs than the live `publications` API references
- after filtering to current live publication-backed legacy URLs, the local mirror contains exactly:
  - `791` PDFs
- local mirror path:
  - `ICJIA-PDFs/backups/server-mirror/icjia/pdf/`

Archive app limitation:

- upload route exists:
  - `POST /uploadFiles`
- it requires:
  - `VUE_APP_ARCHIVE_SECRET`
- it does not overwrite existing files
- use direct filesystem replacement through SFTP/SSH when preserving the exact archive URL is required

## Proven Replacement Strategy

The legacy archive replacement path was successfully tested on `ADAM2.pdf`.

Working principle:

1. create a server-side backup of the current file
2. upload/copy the remediated replacement to the server
3. move the replacement into the exact live filesystem path
4. verify the public URL still works
5. verify the live MD5 now matches the replacement MD5

Proven example:

- public URL:
  - `https://archive.icjia-api.cloud/files/icjia/pdf/ADAM/ADAM2.pdf`
- server file:
  - `/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf/ADAM/ADAM2.pdf`

Verified backup location used:

- `/home/forge/archive.icjia-api.cloud/.tmp/replacement-backups/ADAM/`

Recommended verification checklist:

- `curl -I <public-url>` returns `200`
- `curl <public-url> | md5sum` equals the local remediated file MD5
- public URL string is unchanged
- publication record still points at the same URL

Rollback rule:

- keep a timestamped pre-replacement backup on the server
- if verification fails, move the backup back into place immediately

## Strapi Upload PDFs

Strapi upload files use URLs like:

- `/uploads/<hash>.pdf`

The hash is appended to some files, not all files.

Operational consequence:

- uploading a new file with the same original filename does not imply in-place replacement
- do not assume “same name means overwrite”

Current verified hosting split:

- `20` publication-backed upload PDFs use `agency.icjia-api.cloud/uploads/...`
- `108` publication-backed upload PDFs use `researchhub.icjia-api.cloud/uploads/...`
- `1` publication-backed PDF uses:
  - `icjia.illinois.gov/researchhub/files/...`
  - and maps to the researchhub uploads server for replacement

On-disk verified counts:

- `/home/forge/agency.icjia-api.cloud/agency-api/public/uploads`
  - contains `861` PDF files total
- `/home/forge/researchhub.icjia-api.cloud/researchhub/public/uploads`
  - contains `218` PDF files total

Researchhub exact-match note:

- `108` researchhub publication rows collapse to `106` unique upload paths
- `103` of those `106` are present on disk
- `3` are known broken/missing files

## Known Broken / Missing Files

Current known dead-link publication ids:

- `4682`
- `4695`
- `4719`

Known missing researchhub files:

- `FINAL PDF for posting-230915T15353341.pdf`
- `Illegal gun carrying article PDF for posting-220913T20573010.pdf`
- `R3 Program Grantmaking and Implementation ReportV2-230209T22371426.pdf`

Treat these as stale CMS references until the missing binaries are found or the CMS records are repaired.

## Backups

Metadata/API dump:

- `ICJIA-PDFs/backups/api-dumps/2026-03-25T21-19-49-164Z/`

Contents:

- `publications.json`
- `upload-files.json`
- `graphql-schema-summary.json`
- `summary.json`

Binary PDF backup workspace:

- `ICJIA-PDFs/backups/original-pdfs/`

Backup tooling:

- script:
  - `scripts/backup-icjia-pdfs.ts`
- command:
  - `pnpm agency:backup-pdfs`

Current verified backup outcome:

- total PDF-backed publication rows processed:
  - `1056`
- downloaded rows:
  - `1013`
- skipped-existing rows:
  - `34`
- failed rows:
  - `9`
- unique PDF files on disk:
  - `1012`

Rollback confidence:

- strong for the large majority of the corpus
- incomplete for the `3` dead-link publication records because the original binaries were already missing

## Replacement Map and Local Cache

Replacement map artifacts:

- `ICJIA-PDFs/manifests/publication-pdf-replacement-map.json`
- `ICJIA-PDFs/manifests/publication-pdf-replacement-map.summary.json`
- `ICJIA-PDFs/reports/exports/csv/publication-pdf-replacement-map.csv`

This is the authoritative per-publication routing artifact for eventual SFTP replacement.

Server-cache artifacts:

- sync command:
  - `pnpm agency:sync-server-cache`
- summary:
  - `ICJIA-PDFs/manifests/server-cache-sync.summary.json`
- local cache root:
  - `ICJIA-PDFs/backups/server-cache/`

Current verified first-sync result:

- local cached PDFs:
  - `1014`
- host cache split:
  - `143.244.146.43`: `890`
  - `192.241.146.85`: `20`
  - `157.230.3.215`: `104`
- skipped as known missing:
  - `3`

Operational use:

- process PDFs locally from the server cache rather than re-fetching live files one at a time
- use the replacement map to push finished files back to the exact remote path

## Seeded Passing Replacements

Seed command:

- `pnpm agency:seed-complete-replacements`

Artifacts:

- `ICJIA-PDFs/manifests/complete-passing-replacements.json`
- `ICJIA-PDFs/manifests/complete-passing-publication-status.json`
- `ICJIA-PDFs/manifests/complete-passing-replacements.summary.json`
- `ICJIA-PDFs/reports/exports/csv/complete-passing-replacements.csv`

Current verified seed result:

- `104` staged replacement files copied from root `Complete/` into `ICJIA-PDFs/staging/to-replace/`
- those staged files cover `107` publication ids
- host split:
  - `143.244.146.43`: `96`
  - `192.241.146.85`: `2`
  - `157.230.3.215`: `6`
- unmatched `Complete/` files remaining:
  - `9`

Operational meaning:

- seeded files should be treated as already-passing replacement candidates

## Remaining Source Scan

Scan command:

- `pnpm agency:scan-remaining`

Artifacts:

- `ICJIA-PDFs/reports/test-runs/source-scan/`
- `ICJIA-PDFs/manifests/remaining-source-scan.summary.json`
- `ICJIA-PDFs/manifests/remaining-source-scan-groups.json`
- `ICJIA-PDFs/reports/exports/csv/remaining-source-scan-groups.csv`

Operational meaning:

- one JSON report exists per unique remaining source file
- grouped blocker outputs are used to identify reusable remediation families

## Priority Remediation Batch Memory

Batch runner:

- script:
  - `scripts/run-priority-remediation-batch.ts`
- command:
  - `pnpm agency:run-priority-remediation`

Important batch rule:

- `Color Contrast` is ignored for pass/ready decisions

Current verified batch closeout:

- batch summary file:
  - `ICJIA-PDFs/manifests/remediation-batch-outcomes.summary.json`
- final totals:
  - `259` target candidates
  - `259` processed
  - `67` `ready_to_replace`
  - `191` `failed_after_remediation`
  - `1` `processing_error`
  - `0` remaining

Current staged replacement count on disk:

- `171`

Important staging note:

- not all staged files are from this batch
- the staging tree also includes the earlier seeded `Complete/` replacements

Current verified deferred exception:

- publication id:
  - `4573`
- title:
  - `Ad Hoc Victim Services Committee Research Report`
- source file:
  - `https://archive.icjia-api.cloud/files/icjia/articles/ICJIA_FINAL_AdHocReport_VictimServices_012717.pdf`
- terminal status:
  - `processing_error`
- reason code:
  - `excessive_runtime_loop`
- skip flag:
  - `skipNextBatch: true`
- failure record:
  - `ICJIA-PDFs/reports/failures/remediation-batch/143.244.146.43/4573-Ad_Hoc_Victim_Services_Committee_Research_Report.failure.json`

Why it matters:

- this file was manually stopped after more than five hours of repeated light-inspection and remediation loops
- do not pick it up again in the next batch unless the loop behavior is intentionally being revisited

Current runner state after closeout:

- PM2 process:
  - `icjia-priority-remediation`
- state:
  - `stopped`

## Next-Wave Shortlist

Follow-up shortlist built from the remaining unprocessed PDFs:

- manifest:
  - `ICJIA-PDFs/manifests/remediation-next-wave-candidates.json`
- summary:
  - `ICJIA-PDFs/manifests/remediation-next-wave-candidates.summary.json`
- CSV:
  - `ICJIA-PDFs/reports/exports/csv/remediation-next-wave-candidates.csv`

Current verified shortlist totals:

- remaining publication rows considered:
  - `690`
- shortlisted candidates:
  - `20`
- by tier:
  - `highest`: `12`
  - `high`: `8`

Current active next-wave runner:

- PM2 process:
  - `icjia-next-wave-remediation`
- manifest used:
  - `ICJIA-PDFs/manifests/remediation-next-wave-candidates.json`
- outcomes file:
  - `ICJIA-PDFs/manifests/remediation-next-wave-outcomes.json`
- summary file:
  - `ICJIA-PDFs/manifests/remediation-next-wave-outcomes.summary.json`
- runtime settings:
  - concurrency `8`
  - timeout `3600000` ms

Current launched first 8 files in the next wave:

- `4050` `Meth response teams easing burden on localized drug task forces`
- `4677` `Parole and Mandatory Supervised Release in Illinois`
- `3787` `Sex Offender Probation Programs in Lake DuPage and Winnebago Counties`
- `4506` `Issues in Policing Rural Areas: A Review of the Literature`
- `4509` `Criminal Justice System Utilization in Rural Areas`
- `4153` `Juvenile corrections and parole`
- `4167` `Juvenile court`
- `4169` `Juvenile sentencing`

Current verified next-wave closeout:

- outcomes file:
  - `ICJIA-PDFs/manifests/remediation-next-wave-outcomes.json`
- summary file:
  - `ICJIA-PDFs/manifests/remediation-next-wave-outcomes.summary.json`
- final totals:
  - `20` target candidates
  - `20` processed
  - `2` `ready_to_replace`
  - `17` `failed_after_remediation`
  - `1` `processing_error`
  - `0` remaining

Current verified deferred exception from next wave:

- publication id:
  - `4739`
- title:
  - `SFY24 ICJIA Annual Report`
- terminal status:
  - `processing_error`
- reason code:
  - `excessive_runtime_loop`
- skip flag:
  - `skipNextBatch: true`
- failure record:
  - `ICJIA-PDFs/reports/failures/remediation-batch/192.241.146.85/4739-SFY24_ICJIA_Annual_Report.failure.json`
- duration:
  - `3611325` ms

Current runner state after next-wave closeout:

- PM2 process:
  - `icjia-next-wave-remediation`
- state:
  - `stopped`

## Stricter Next Batch

Stricter selector artifacts:

- manifest:
  - `ICJIA-PDFs/manifests/remediation-next-batch-candidates.json`
- summary:
  - `ICJIA-PDFs/manifests/remediation-next-batch-candidates.summary.json`
- CSV:
  - `ICJIA-PDFs/reports/exports/csv/remediation-next-batch-candidates.csv`

This selector was based on traits shared by successful remediations:

- non-scanned
- short, usually under 30 pages
- no manual-only failure modes
- few blocker families
- few blocking findings
- blocker mix dominated by metadata, font/unicode, and link/tabs cleanup

Current verified stricter next-batch closeout:

- outcomes file:
  - `ICJIA-PDFs/manifests/remediation-next-batch-outcomes.json`
- summary file:
  - `ICJIA-PDFs/manifests/remediation-next-batch-outcomes.summary.json`
- final totals:
  - `20` target candidates
  - `20` processed
  - `10` `ready_to_replace`
  - `7` `failed_after_remediation`
  - `3` `processing_error`
  - `0` remaining

Current staged replacement count after this batch:

- `183`

Important result:

- this stricter selector performed much better than the prior `20`-file shortlist
- earlier next-wave shortlist:
  - `2 / 20` passes
- stricter next batch:
  - `10 / 20` passes

Current verified deferred exceptions from this stricter batch:

- `4168`
  - `Summer Compiler 2008.pdf`
- `4178`
  - `WinterSpring08CompilerVol25No2.pdf`
- `4183`
  - `CompilerSummer2007.pdf`

Operational pattern to remember:

- compiler-style PDFs were prone to excessive runtime loops even when they otherwise looked promising
- treat similar compiler/newsletter-style files as higher timeout-risk in future batch selection

Current runner state after stricter batch closeout:

- PM2 process:
  - `icjia-next-batch-remediation`
- state:
  - `stopped`

## Second 50-File Batch

Current verified 50-file batch closeout:

- candidate manifest:
  - `ICJIA-PDFs/manifests/remediation-50-batch-candidates.json`
- outcomes file:
  - `ICJIA-PDFs/manifests/remediation-50-batch-outcomes.json`
- summary file:
  - `ICJIA-PDFs/manifests/remediation-50-batch-outcomes.summary.json`
- final totals:
  - `50` target candidates
  - `50` processed
  - `16` `ready_to_replace`
  - `34` `failed_after_remediation`
  - `0` `processing_error`
  - `0` remaining

Current staged replacement count after this batch:

- `199`

Operational note:

- the batch completed on disk, but PM2 initially still showed the process as `online`
- treat this as another case where the outcomes summary is the source of truth and the worker may need cleanup stop afterward

## New Strict 50 Selector

Current reusable selector command:

- `pnpm agency:build-next-batch`

Current selector script:

- `scripts/build-next-remediation-batch.ts`

Current default output set:

- manifest:
  - `ICJIA-PDFs/manifests/remediation-50-batch-2-candidates.json`
- summary:
  - `ICJIA-PDFs/manifests/remediation-50-batch-2-candidates.summary.json`
- CSV:
  - `ICJIA-PDFs/reports/exports/csv/remediation-50-batch-2-candidates.csv`

Selection rule to remember:

- this stricter selector excludes already-covered publication ids from:
  - `complete-passing-publication-status.json`
  - `remediation-batch-outcomes.json`
  - `remediation-next-wave-outcomes.json`
  - `remediation-next-batch-outcomes.json`
  - `remediation-50-batch-outcomes.json`
- it also excludes:
  - scanned PDFs
  - PDFs with manual-only failure modes
  - PDFs over `30` pages
  - PDFs with more than `5` blocker families
  - PDFs with more than `10` blocking findings
  - compiler/newsletter-style PDFs because of timeout risk

Current verified result of this stricter next-50 selection:

- only `18` PDFs remain that fit the full “best chance to pass” profile
- tier split:
  - `15` `highest`
  - `3` `high`

Operational consequence:

- there are not `50` remaining PDFs that still satisfy the strict best-chance profile
- to build a larger next batch, the selector will need to be relaxed

Follow-up verified result after the strict-18 batch finished:

- the ultra-strict selector is now exhausted
- rerunning the strict selector over the truly remaining pool yields:
  - `0` eligible candidates

Next practical selector:

- command:
  - `ICJIA_BATCH_OUTPUT_BASENAME=remediation-next-relaxed-batch ICJIA_BATCH_LIMIT=50 ICJIA_BATCH_MAX_PAGES=40 ICJIA_BATCH_MAX_BLOCKER_FAMILIES=6 ICJIA_BATCH_MAX_BLOCKING_FINDINGS=12 pnpm agency:build-next-batch`
- outputs:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-candidates.json`
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-candidates.summary.json`
  - `ICJIA-PDFs/reports/exports/csv/remediation-next-relaxed-batch-candidates.csv`

Current verified relaxed-selector result:

- eligible after filtering:
  - `146`
- shortlisted:
  - `50`
- tier split:
  - `44` `highest`
  - `6` `high`

Relaxed selector profile to remember:

- still excludes:
  - scanned PDFs
  - manual-only PDFs
  - compiler/newsletter-style timeout-risk files
- but allows up to:
  - `40` pages
  - `6` blocker families
  - `12` blocking findings

## Remediation Loopiness Fix

Current verified mitigation for excessive runtime loops:

- `apps/api/src/services/agentRemediationService.ts` now includes a stable-state convergence guard
- the remediation service computes a signature from:
  - overall score
  - grade
  - scanned state
  - unresolved category labels
  - blocking local finding keys
  - per-category scores

Operational rule:

- if remediation keeps changing PDF bytes but the analyzed accessibility state stays effectively identical across repeated no-progress cycles, the service now stops early instead of spinning until the outer `1 hour` timeout

Current guard setting:

- repeated identical stable states allowed:
  - `3`

Operational consequence:

- some former `excessive_runtime_loop` cases should now close out sooner as ordinary failed remediations instead of consuming the full timeout budget

## Relaxed 50 Batch

Current batch launch:

- PM2 process:
  - `icjia-next-relaxed-50-remediation`
- manifest:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-candidates.json`
- outcomes:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-outcomes.json`
- summary:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-outcomes.summary.json`

Launch settings:

- concurrency:
  - `8`
- timeout per PDF:
  - `1 hour`

Startup note:

- finished strict-18 worker
  - `icjia-strict-18-remediation`
  was stopped before launching this batch

First confirmed in-flight files:

- `4660`
  - `Civil Rights Discrimination Complaint Form`
- `3550`
  - `McGruff Will Your Familys Car be Stolen This Year`
- `3591`
  - `An Implementation Evaluation of the Enhanced Domestic Violence Probation Program in Champaign County`
- `3652`
  - `Citizen Awareness Local Involvement Fuel Community Policing Program`
- `3596`
  - `Community Policing in Chicago An Evaluation`
- `3595`
  - `Evaluation of the Little Village Gang Violence Reduction Project The First Three Years`
- `3649`
  - `Intimate Partner Violence in Illinois`
- `3613`
  - `Perceptions of Crime Trends in Illinois`

Current verified relaxed-50 closeout:

- outcomes file:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-outcomes.json`
- summary file:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-outcomes.summary.json`
- final totals:
  - `50` processed
  - `13` `ready_to_replace`
  - `32` `failed_after_remediation`
  - `5` `processing_error`
  - `0` remaining

Current staged replacement count after this batch:

- `223`

## Relaxed 50 Batch 2

Current batch launch:

- PM2 process:
  - `icjia-next-relaxed-50b-remediation`
- manifest:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-2-candidates.json`
- outcomes:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-2-outcomes.json`
- summary:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-2-outcomes.summary.json`

Launch settings:

- concurrency:
  - `8`
- timeout per PDF:
  - `1 hour`

Startup note:

- finished worker
  - `icjia-next-relaxed-50-remediation`
  was stopped before launching this batch

Current selector profile result:

- eligible after filtering:
  - `96`
- shortlisted:
  - `50`
- tier split:
  - `50` `high`

First confirmed in-flight files:

- `3704`
  - `CHRISTIAN County Profile`
- `3702`
  - `CLARK County Profile`
- `3708`
  - `CLAY County Profile`
- `3714`
  - `CLINTON County Profile`
- `3693`
  - `COLES County Profile`
- `3717`
  - `CRAWFORD County Profile`
- `3715`
  - `CUMBERLAND County Profile`
- `3629`
  - `DE KALB County Profile`

Current verified relaxed-50b closeout:

- outcomes file:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-2-outcomes.json`
- summary file:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-2-outcomes.summary.json`
- final totals:
  - `50` processed
  - `50` `ready_to_replace`
  - `0` `failed_after_remediation`
  - `0` `processing_error`
  - `0` remaining

Current staged replacement count after this batch:

- `273`

## Relaxed 46 Batch

Current batch launch:

- PM2 process:
  - `icjia-next-relaxed-46-remediation`
- manifest:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-3-candidates.json`
- outcomes:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-3-outcomes.json`
- summary:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-3-outcomes.summary.json`

Launch settings:

- concurrency:
  - `8`
- timeout per PDF:
  - `1 hour`

Startup note:

- finished worker
  - `icjia-next-relaxed-50b-remediation`
  was stopped before launching this batch

Current selector profile result:

- eligible after filtering:
  - `46`
- shortlisted:
  - `46`
- tier split:
  - `46` `high`

First confirmed in-flight files:

- `3749`
  - `OGLE County Profile`
- `3745`
  - `PERRY County Profile`
- `3754`
  - `PIATT County Profile`
- `3751`
  - `PIKE County Profile`
- `3750`
  - `POPE County Profile`
- `3741`
  - `PULASKI County Profile`
- `3861`
  - `PUTNAM County Profile`
- `3723`
  - `RICHLAND County Profile`

Current verified relaxed-46 closeout:

- outcomes file:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-3-outcomes.json`
- summary file:
  - `ICJIA-PDFs/manifests/remediation-next-relaxed-batch-3-outcomes.summary.json`
- final totals:
  - `46` processed
  - `41` `ready_to_replace`
  - `1` `failed_after_remediation`
  - `4` `processing_error`
  - `0` remaining

Current staged replacement count after this batch:

- `314`

## Lower-Confidence 77 Batch

Current batch launch:

- PM2 process:
  - `icjia-lower-confidence-77-remediation`
- manifest:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-77-candidates.json`
- outcomes:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-77-outcomes.json`
- summary:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-77-outcomes.summary.json`

Launch settings:

- concurrency:
  - `8`
- timeout per PDF:
  - `1 hour`

Current selector profile result:

- eligible after filtering:
  - `77`
- shortlisted:
  - `77`
- tier split:
  - `27` `highest`
  - `50` `high`

Selector relaxation used for this batch:

- allow up to:
  - `60` pages
  - `7` blocker families
  - `14` blocking findings
- still exclude:
  - scanned PDFs
  - manual-only cases
  - compiler/newsletter timeout-risk files

First confirmed in-flight files:

- `4002`
  - `Driving under the influence DUI laws andenforcement in Illinois and the US`
- `4493`
  - `Police Technology: Acoustic Gunshot Detection Systems`
- `4492`
  - `Provider-Reported Challenges & Opportunities in Supporting Young Victims of Crime`
- `4495`
  - `Provider-Reported Challenges and Opportunities in Supporting Young Victims of Crime`
- `4737`
  - `Evaluation of Youth Mental Health First Aid Trainings for Illinois Schools, 2022-2023`
- `4585`
  - `Collaboration in Criminal Justice: A Review of the Literature on Criminal Justice Coordinating Councils`
- `4485`
  - `Demystifying Program Evaluation in Criminal Justice: A Guide for Practitioners`
- `4607`
  - `The Victim-Offender Overlap: Examining the Relationship Between Victimization and Offending`

Current verified lower-confidence-77 closeout:

- outcomes file:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-77-outcomes.json`
- summary file:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-77-outcomes.summary.json`
- final totals:
  - `77` processed
  - `27` `ready_to_replace`
  - `38` `failed_after_remediation`
  - `12` `processing_error`
  - `0` remaining

Current staged replacement count after this batch:

- `341`

## Next Lower-Confidence Batch 2

Next remaining selector after the 77 batch:

- build command:
  - `ICJIA_BATCH_OUTPUT_BASENAME=remediation-next-lower-confidence-batch-2 ICJIA_BATCH_LIMIT=100 ICJIA_BATCH_MAX_PAGES=80 ICJIA_BATCH_MAX_BLOCKER_FAMILIES=8 ICJIA_BATCH_MAX_BLOCKING_FINDINGS=16 pnpm agency:build-next-batch`
- manifest:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-2-candidates.json`
- summary:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-2-candidates.summary.json`
- CSV:
  - `ICJIA-PDFs/reports/exports/csv/remediation-next-lower-confidence-batch-2-candidates.csv`

Current verified selector result:

- eligible after filtering:
  - `32`
- shortlisted:
  - `32`
- tier split:
  - `21` `highest`
  - `11` `high`

Selector relaxation used for this batch:

- allow up to:
  - `80` pages
  - `8` blocker families
  - `16` blocking findings
- still exclude:
  - scanned PDFs
  - manual-only cases
  - compiler/newsletter timeout-risk files

Current top candidates:

- `4636`
  - `Conducting Research Interviews on Sensitive Topics`
- `4474`
  - `Behavioral and Public Health Perspectives on Violence Prevention: A Survey of Illinois Practitioners`
- `4639`
  - `Adjusting Work Conditions During the COVID-19 Pandemic: A Survey of Illinois Mental Health Court Staff`
- `4673`
  - `Understanding Police Officer Stress: A Review of the Literature`
- `4674`
  - `Addressing Police Officer Stress: Programs and Practices`

Current batch launch:

- PM2 process:
  - `icjia-lower-confidence-32-remediation`
- manifest:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-2-candidates.json`
- outcomes:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-2-outcomes.json`
- summary:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-2-outcomes.summary.json`

Launch settings:

- concurrency:
  - `8`
- timeout per PDF:
  - `1 hour`

Startup note:

- finished worker
  - `icjia-lower-confidence-77-remediation`
  was stopped before launching this batch

First confirmed in-flight files:

- `4636`
  - `Conducting Research Interviews on Sensitive Topics`
- `4474`
  - `Behavioral and Public Health Perspectives on Violence Prevention: A Survey of Illinois Practitioners`
- `4639`
  - `Adjusting Work Conditions During the COVID-19 Pandemic: A Survey of Illinois Mental Health Court Staff`
- `4673`
  - `Understanding Police Officer Stress: A Review of the Literature`
- `4674`
  - `Addressing Police Officer Stress: Programs and Practices`
- `4546`
  - `The Intersection of Homelessness and the Criminal Justice System`
- `4478`
  - `How Illinois Service Providers Support Young Victims of Crime: Findings from an Illinois HEALS Survey`
- `4484`
  - `Youth Alcohol Use: National and Illinois Trends, Consequences, and Interventions`

Current verified lower-confidence-32 closeout:

- outcomes file:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-2-outcomes.json`
- summary file:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-2-outcomes.summary.json`
- final totals:
  - `32` processed
  - `16` `ready_to_replace`
  - `16` `failed_after_remediation`
  - `0` `processing_error`
  - `0` remaining

Current staged replacement count after this batch:

- `357`

## Next Lower-Confidence Batch 3

Next remaining selector after the 32 batch:

- build command:
  - `ICJIA_BATCH_OUTPUT_BASENAME=remediation-next-lower-confidence-batch-3 ICJIA_BATCH_LIMIT=100 ICJIA_BATCH_MAX_PAGES=100 ICJIA_BATCH_MAX_BLOCKER_FAMILIES=9 ICJIA_BATCH_MAX_BLOCKING_FINDINGS=18 pnpm agency:build-next-batch`
- manifest:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-3-candidates.json`
- summary:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-3-candidates.summary.json`
- CSV:
  - `ICJIA-PDFs/reports/exports/csv/remediation-next-lower-confidence-batch-3-candidates.csv`

Current verified selector result:

- eligible after filtering:
  - `12`
- shortlisted:
  - `12`
- tier split:
  - `12` `high`

Selector relaxation used for this batch:

- allow up to:
  - `100` pages
  - `9` blocker families
  - `18` blocking findings
- still exclude:
  - scanned PDFs
  - manual-only cases
  - compiler/newsletter timeout-risk files

Current top candidates:

- `4655`
  - `A Preliminary Outcome Evaluation of Lake County's Police Referral to Substance Use Disorder Treatment Program`
- `4583`
  - `An Overview of Medication-Assisted Treatment for Opioid Use Disorders for Criminal Justice-Involved Individuals`
- `4179`
  - `Illinois Criminal Justice Information Authority Needs Assessment Survey APPENDIX`
- `4117`
  - `Program Completion Behavioral Change and Rearrest for the Batterer Intervention System of Cook County Illinois`
- `3992`
  - `Evaluation of the Gang Violence Reduction Project in Little Village`

## Next Lower-Confidence Batch 4

Wider remaining selector for a larger batch after lower-confidence batch 3:

- build command:
  - `ICJIA_BATCH_OUTPUT_BASENAME=remediation-next-lower-confidence-batch-4 ICJIA_BATCH_LIMIT=100 ICJIA_BATCH_MAX_PAGES=150 ICJIA_BATCH_MAX_BLOCKER_FAMILIES=10 ICJIA_BATCH_MAX_BLOCKING_FINDINGS=24 pnpm agency:build-next-batch`
- manifest:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-4-candidates.json`
- summary:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-4-candidates.summary.json`
- CSV:
  - `ICJIA-PDFs/reports/exports/csv/remediation-next-lower-confidence-batch-4-candidates.csv`

Current verified selector result:

- eligible after filtering:
  - `110`
- shortlisted:
  - `100`
- tier split:
  - `1` `highest`
  - `99` `high`

Selector relaxation used for this batch:

- allow up to:
  - `150` pages
  - `10` blocker families
  - `24` blocking findings
- still exclude:
  - scanned PDFs
  - manual-only cases
  - compiler/newsletter timeout-risk files

Current top candidates:

- `4635`
  - `A Guide to Conducting Field Observations`
- `4655`
  - `A Preliminary Outcome Evaluation of Lake County's Police Referral to Substance Use Disorder Treatment Program`
- `3775`
  - `Criminal Justice Plan for the State of Illinois`
- `4583`
  - `An Overview of Medication-Assisted Treatment for Opioid Use Disorders for Criminal Justice-Involved Individuals`
- `4031`
  - `CLEAR and ICLEAR A Status Report on New Information Technology and its Impact on Management the Organization and CrimeFighting Strategies`

Current batch launch:

- PM2 process:
  - `icjia-lower-confidence-100-remediation`
- manifest:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-4-candidates.json`
- outcomes:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-4-outcomes.json`
- summary:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-4-outcomes.summary.json`

Launch settings:

- concurrency:
  - `8`
- timeout per PDF:
  - `1 hour`

Startup note:

- finished worker
  - `icjia-lower-confidence-32-remediation`
  was stopped before launching this batch

First confirmed in-flight files:

- `4635`
  - `A Guide to Conducting Field Observations`
- `4655`
  - `A Preliminary Outcome Evaluation of Lake County's Police Referral to Substance Use Disorder Treatment Program`
- `3775`
  - `Criminal Justice Plan for the State of Illinois`
- `4583`
  - `An Overview of Medication-Assisted Treatment for Opioid Use Disorders for Criminal Justice-Involved Individuals`
- `4031`
  - `CLEAR and ICLEAR A Status Report on New Information Technology and its Impact on Management the Organization and CrimeFighting Strategies`
- `4014`
  - `Developing profiles of violent offenders and identifying groups of violent offenders at high risk of recidivism and treatment failure`
- `3641`
  - `Community Policing in Chicago Years Five and Six An Interim Report`
- `3970`
  - `A Study of Disproportionate Minority Representation in the Cook County Juvenile Justice System Part I Assessment of Disproportionate Minority Representation at Key Decision Points in the Cook County Juvenile Justice System`

Current verified lower-confidence-100 closeout:

- outcomes file:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-4-outcomes.json`
- summary file:
  - `ICJIA-PDFs/manifests/remediation-next-lower-confidence-batch-4-outcomes.summary.json`
- final totals:
  - `100` processed
  - `19` `ready_to_replace`
  - `79` `failed_after_remediation`
  - `2` `processing_error`
  - `0` remaining

Current staged replacement count after this batch:

- `376`

## Remaining-All Batch

Catch-all remaining manifest built from source-scan-backed unprocessed publication rows:

- manifest:
  - `ICJIA-PDFs/manifests/remediation-remaining-all-candidates.json`
- summary:
  - `ICJIA-PDFs/manifests/remediation-remaining-all-candidates.summary.json`
- outcomes:
  - `ICJIA-PDFs/manifests/remediation-remaining-all-outcomes.json`
- outcomes summary:
  - `ICJIA-PDFs/manifests/remediation-remaining-all-outcomes.summary.json`

Current verified manifest result:

- candidates:
  - `223`
- all candidates are assigned:
  - `medium`

Important note:

- the earlier library-level remaining count appeared as `227`
- after reconciliation against the replacement map and all outcomes manifests, there is no uncovered publication-row gap
- the catch-all source-scan-backed manifest covers the remaining routable publication rows we actually needed to process in batch form

Current batch launch:

- PM2 process:
  - `icjia-remaining-all-remediation`

Launch settings:

- concurrency:
  - `8`
- timeout per PDF:
  - `1 hour`

Startup note:

- initial launch used a custom tier label `remaining`
- the runner ignores anything outside `highest|high|medium`
- fixing the manifest to use `medium` allowed the batch to start properly

First confirmed in-flight files:

- `3597`
  - `Evaluation of the Cook County Juvenile Sheriffs Work Alternative Program`
- `3608`
  - `Champaign County Enhanced Domestic Violence Probation Program Evaluated`
- `3653`
  - `Juvenile Work Program Provides Alternative to Detention`
- `3660`
  - `Kankakee MEG unit employs problem solving approach to combat drug crime`
- `3687`
  - `Prison Sentences for Drug Offenses`
- `3695`
  - `The judicial system responds to methamphetamine use in rural Illinois`
- `3699`
  - `Bilingual domestic violence legal advocacy program evaluated`
- `3700`
  - `Northern Illinois counties collaborate to tackle methamphetamine trafficking`

Current verified remaining-all closeout:

- outcomes file:
  - `ICJIA-PDFs/manifests/remediation-remaining-all-outcomes.json`
- summary file:
  - `ICJIA-PDFs/manifests/remediation-remaining-all-outcomes.summary.json`
- final totals:
  - `223` processed
  - `13` `ready_to_replace`
  - `141` `failed_after_remediation`
  - `69` `processing_error`
  - `0` remaining

Current staged replacement count after this batch:

- `384`

Current verified whole-library state after remaining-all closeout:

- all publication rows in the replacement map are now covered by either:
  - seeded passing replacements
  - a remediation outcome
- there is no remaining uncovered publication-row discrepancy in the replacement map

## Strict 18 Batch

Current strict remaining batch:

- PM2 process:
  - `icjia-strict-18-remediation`
- manifest:
  - `ICJIA-PDFs/manifests/remediation-50-batch-2-candidates.json`
- outcomes:
  - `ICJIA-PDFs/manifests/remediation-50-batch-2-outcomes.json`
- summary:
  - `ICJIA-PDFs/manifests/remediation-50-batch-2-outcomes.summary.json`

Launch settings:

- concurrency:
  - `8`
- timeout per PDF:
  - `1 hour`

Current startup note:

- the stale completed worker
  - `icjia-50-batch-remediation`
  was stopped before launching this batch

First confirmed in-flight files:

- `3912`
  - `Court System`
- `3682`
  - `Criminal Sentencing`
- `4100`
  - `Lake County probation program addresses womenspecific needs`
- `4079`
  - `Peoria St Clair counties initiate Redeploy Illinois youth programs`
- `4193`
  - `Prostitution study finds Chicago girls trafficked through coercion violence`
- `3679`
  - `Drug Offenders on Probation`
- `3864`
  - `Examining Restorative Justice`
- `3763`
  - `Trends in violent crime and the justice systems response`

## Things To Remember Going Forward

- 2026-03-30 Stage 0 truth-model freeze implementation:
  - shared promotion/replacement gate now lives in:
    - `apps/api/src/services/promotionGate.ts`
  - the same gate contract is now used by:
    - `agentRemediationService.ts`
    - `scripts/run-priority-remediation-batch.ts`
    - `scripts/verify-ready-to-replace.ts`
  - gate semantics:
    - require:
      - grade `A`
      - overall score `100`
      - no blocking local findings except `category.color_contrast`
      - no critical manual review flags
      - no scored categories below `100` except `Color Contrast`
    - still rejects documents that remain scanned/image-only
  - `DocumentModel` now carries additive `promotionGate` output so terminal remediation results expose the exact shared pass/fail reasons.
  - priority batch outcomes no longer write new success rows as `ready_to_replace`:
    - new successful remediation status is:
      - `remediated_pass_candidate`
    - remediation success is now intentionally separate from verified promotion readiness
    - verification still reads legacy `ready_to_replace` rows for backward compatibility
  - batch runner now records byte-invariant checksums for:
    - the final gate-evaluated buffer
    - the saved remediated artifact
    - the staged replacement candidate
  - if the saved or staged bytes do not match the gate-evaluated final buffer hash, the batch now fails that item instead of silently trusting the earlier result
  - `scripts/verify-ready-to-replace.ts` now writes a durable verified-promotion ledger:
    - manifest:
      - `ICJIA-PDFs/manifests/verified-promotion-ledger.json`
    - summary:
      - `ICJIA-PDFs/manifests/verified-promotion-ledger.summary.json`
    - rows are created only for verification-passing items
    - each row records:
      - publication identity
      - source kind / source path
      - local final artifact path
      - staged replacement path
      - current source checksum
      - replacement checksum
      - verification report path
      - verification timestamp
      - promotion status `verified_pass`
  - both `scripts/verify-ready-to-replace.ts` and `scripts/run-priority-remediation-batch.ts` are now safe to import in tests or helper contexts because they only call `main()` on direct execution

- 2026-03-30 Stage 0 truth-model freeze operational refresh:
  - reran:
    - `pnpm agency:verify-ready`
  - refreshed authoritative artifacts:
    - `ICJIA-PDFs/manifests/ready-to-replace-verification.json`
    - `ICJIA-PDFs/manifests/ready-to-replace-verification.summary.json`
    - `ICJIA-PDFs/manifests/verified-promotion-ledger.json`
    - `ICJIA-PDFs/manifests/verified-promotion-ledger.summary.json`
    - `ICJIA-PDFs/manifests/ready-to-replace-verification.classified.json`
    - `ICJIA-PDFs/manifests/ready-to-replace-verification.classified.summary.json`
  - refresh timestamp:
    - `2026-03-30T16:06:01.533Z`
  - refreshed verification totals:
    - `392` publication rows
    - `383` unique targets
    - `84` passed targets
    - `299` failed targets
    - `0` errored targets
    - `0` missing targets
    - `86` passed publication rows
    - `306` failed publication rows
    - `86` verified promotion ledger rows
  - ledger consistency checks:
    - all ledger rows currently have promotion status `verified_pass`
    - all ledger rows come from verification-passing rows only
    - duplicate publication rows that share the same staged replacement path can legitimately produce multiple verified ledger rows
  - refreshed classified verification totals:
    - `84` verified-pass targets
    - `2` soft-fail advisory targets
    - `297` hard-fail targets
    - `86` verified-pass publication rows
    - `2` soft-fail advisory publication rows
    - `304` hard-fail publication rows
  - Stage 0 operational rule confirmed:
    - promotion truth now comes from `verified-promotion-ledger.json`, not historical `ready_to_replace` flags in legacy manifests
    - legacy `ready_to_replace` rows remain verifier inputs for backward compatibility only
  - practical outcome:
    - Stage 0 is now operationally complete in this workspace without starting Stage 1 queue/control-plane work

- 2026-03-30 Stage 1 manifest-first corpus control plane implementation:
  - new builder script:
    - `scripts/build-corpus-control-plane.ts`
  - new validator script:
    - `scripts/validate-corpus-control-plane.ts`
  - new shared builder/validation service:
    - `apps/api/src/services/corpusControlPlane.ts`
  - package scripts:
    - `pnpm agency:build-control-plane`
    - `pnpm agency:validate-control-plane`
  - authoritative Stage 1 artifacts:
    - `ICJIA-PDFs/manifests/corpus-control-plane.json`
    - `ICJIA-PDFs/manifests/corpus-control-plane.summary.json`
    - `ICJIA-PDFs/manifests/corpus-control-plane.by-cohort.json`
    - `ICJIA-PDFs/manifests/corpus-control-plane-canaries.json`
  - builder inputs currently include:
    - `publication-pdf-replacement-map.json`
    - `verified-promotion-ledger.json`
    - `ready-to-replace-verification.json`
    - `ready-to-replace-verification.classified.json`
    - remediation `*-outcomes.json`
    - remediation `*-candidates.json`
    - `remediation-regression-benchmark.summary.json`
  - current canonical corpus baseline from `corpus-control-plane.summary.json`:
    - `1056` total rows
    - status counts:
      - `verified_pass: 86`
      - `discovered: 3`
      - `analyzed: 1`
      - `queued_for_remediation: 0`
      - `remediated_fail: 866`
      - `processing_error: 100`
      - `deferred_manual: 0`
      - `staged_for_replacement: 0`
      - `replaced_remote: 0`
    - cohort counts:
      - `short_high_likelihood: 27`
      - `figure_heavy: 686`
      - `structure_heavy: 143`
      - `font_heavy: 14`
      - `long_report: 11`
      - `manual_tail: 175`
    - `verifiedPassRowsFromLedger: 86`
    - `remainingRowsExcludingVerifiedPass: 970`
  - current source-kind/storage baseline:
    - `legacy_archive: 927`
    - `researchhub_upload: 109`
    - `agency_upload: 20`
  - validation state:
    - `pnpm agency:validate-control-plane` currently returns:
      - `ok: true`
      - no errors
      - no warnings
  - operational rule:
    - Stage 1 corpus statuses are manifest-only and are not written into the SQLite queue schema in this phase
    - Stage 0 promotion truth from the verified promotion ledger still outranks every other source in the Stage 1 builder

- If a lasting fact changes, update this file.
- If a mistake is discovered and corrected, record it here.
- If a workflow decision is proven in practice, record it here.
- If a file or publication should be skipped later, record it here.

- 2026-03-30 Stage 2 high-likelihood throughput closure implementation:
  - new shared Stage 2 service:
    - `apps/api/src/services/shortCohortStage2.ts`
  - new Stage 2 scripts:
    - `scripts/build-stage2-short-cohort-wave.ts`
    - `scripts/run-stage2-short-cohort-wave.ts`
  - new package scripts:
    - `pnpm agency:build-stage2-short-wave`
    - `pnpm agency:run-stage2-short-wave`
  - Stage 2 now reuses the Stage 1 control plane and Stage 0 verification gate instead of introducing a second queue or API authority path.
  - `pnpm agency:build-control-plane` now applies deterministic Stage 2 short-cohort reclassification before writing canonical control-plane artifacts.
  - current deterministic short-cohort reclassification rules only affect non-`verified_pass` rows and currently move:
    - benchmarked structure canaries such as `Court System` out of `short_high_likelihood`
    - annual-report shaped residual rows into `long_report`
  - refreshed control-plane baseline after Stage 2 reclassification:
    - `short_high_likelihood: 23` rows total
    - `18` `verified_pass`
    - `1` `analyzed`
    - `4` `remediated_fail`
    - `0` `processing_error`
    - `structure_heavy` increased to `145`
    - `long_report` increased to `13`
  - new Stage 2 authoritative artifacts:
    - `ICJIA-PDFs/manifests/stage2-short-cohort-wave.json`
    - `ICJIA-PDFs/manifests/stage2-short-cohort-wave.summary.json`
    - `ICJIA-PDFs/manifests/stage2-short-cohort-throughput.summary.json`
  - current Stage 2 wave baseline from `stage2-short-cohort-wave.summary.json` / throughput summary:
    - `5` eligible short-cohort rows selected
    - selected publication ids:
      - `3513`
      - `4054`
      - `3685`
      - `4023`
      - `4067`
    - `5` pending wave rows
    - `0` newly verified-pass rows from the wave yet
    - `5` remaining short-cohort rows
  - `pnpm agency:run-stage2-short-wave --build-only` is now safe to use as a dry run:
    - it preserves the current pending wave instead of clearing the selection when no outcomes exist yet
  - first real Stage 2 short-cohort wave outcome on 2026-03-30:
    - wave outcomes:
      - `ICJIA-PDFs/manifests/stage2-short-cohort-wave.outcomes.json`
      - `ICJIA-PDFs/manifests/stage2-short-cohort-wave.outcomes.summary.json`
    - totals:
      - `5` target candidates
      - `0` ready-to-replace / pass-candidate results
      - `4` `failed_after_remediation`
      - `1` `processing_error`
    - processed publication ids and terminal states:
      - `3513`: `processing_error`
      - `4054`: `failed_after_remediation`
      - `3685`: `failed_after_remediation`
      - `4023`: `failed_after_remediation`
      - `4067`: `failed_after_remediation`
    - `3513` failed for an operational reason rather than a semantic remediation result:
      - the local project temp directory `.tmp/` had been deleted during disk cleanup
      - OCR temp-dir creation failed with:
        - `ENOENT: no such file or directory, mkdtemp '/home/hendo420/pdfaf/.tmp/pdf-ocr-*'`
      - `.tmp/` was recreated after the wave so future OCR-capable runs are not blocked by the same issue
    - practical Stage 2 outcome after the first wave refresh:
      - no new verified passes were added
      - no short-cohort rows were newly reclassified by this wave
      - `stage2-short-cohort-throughput.summary.json` now shows:
        - `23` total short-cohort rows
        - `18` verified-pass rows
        - `5` remaining short-cohort rows
        - `4` hard fails in the wave
        - `1` processing error in the wave
        - `0` pending wave rows
    - current short-cohort rows still unresolved after the first wave:
      - `3513`
      - `4054`
      - `3685`
      - `4023`
      - `4067`

- 2026-03-30 Stage 2 short-cohort closure follow-up:
  - `3513` (`Trends and Issues 90 Criminal and Juvenile Justice in Illinois`) was retried once after restoring `.tmp/`.
  - retry behavior:
    - the remediation worker got past the old `mkdtemp ... .tmp/pdf-ocr-*` failure
    - it created fresh Stage 2 attempt artifacts and ran for about `12` minutes on CPU
    - it did not emit a new Stage 2 outcomes manifest or terminal row before being stopped
  - practical conclusion:
    - `3513` is not a real `short_high_likelihood` fit
    - current truthful corpus status remains the previously recorded `processing_error`
    - the cohort label is now reclassified to `long_report`
    - supporting evidence:
      - `pageCount: 143`
      - `isScanned: true`
      - prior Stage 2 operational retry exemption no longer pins obviously long/scanned rows in the short cohort
  - Stage 2 logic update:
    - `apps/api/src/services/shortCohortStage2.ts`
      - operational-retry rows are now reclassified out of `short_high_likelihood` when the document is clearly not a short-profile fit
      - stale pending Stage 2 wave rows are now dropped if they are no longer eligible in the rebuilt control plane
  - refreshed Stage 2 endpoint state after rebuild:
    - `short_high_likelihood: 18` rows total
    - all `18` are `verified_pass`
    - `0` remaining short-cohort rows
    - `0` pending Stage 2 wave rows
    - `stage2-short-cohort-wave.json` now selects no rows
    - `stage2-short-cohort-throughput.summary.json` now shows the short cohort fully closed
  - operational takeaway:
    - Stage 2 is now effectively closed as a throughput-closure milestone
    - the remaining non-pass work for `3513` has been escalated into the `long_report` lane rather than left as ambiguous short-cohort backlog

- 2026-03-30 Stage 3 figure-and-ownership generalization implementation:
  - new shared Stage 3 service:
    - `apps/api/src/services/figureWaveStage3.ts`
  - new Stage 3 scripts:
    - `scripts/build-stage3-figure-wave.ts`
    - `scripts/run-stage3-figure-wave.ts`
  - new package scripts:
    - `pnpm agency:build-stage3-figure-wave`
    - `pnpm agency:run-stage3-figure-wave`
  - canonical control-plane rows now expose `stage3FigureDiagnostics` with:
    - `figureWaveBucket`
    - ownership-risk known/initial/final counts when available
    - missing-alt initial/final counts when available
    - decorative-figure initial/final counts when available
    - `dominantFigurePhase`
    - `inspectionPattern`
    - `hasGenericTimeoutWording`
  - Stage 3 currently derives those diagnostics primarily from:
    - remediation regression benchmark metrics when available
    - current blocking finding keys / residual family ids
    - latest outcome timeout/reason wording
  - new Stage 3 authoritative artifacts:
    - `ICJIA-PDFs/manifests/stage3-figure-wave.json`
    - `ICJIA-PDFs/manifests/stage3-figure-wave.summary.json`
    - `ICJIA-PDFs/manifests/stage3-figure-throughput.summary.json`
    - `ICJIA-PDFs/manifests/stage3-figure-canaries.json`
  - current Stage 3 baseline from the generated artifacts:
    - `686` figure-heavy rows total
    - `17` verified-pass rows in cohort
    - `669` remaining figure-heavy rows
    - bucket counts among non-verified figure-heavy rows:
      - `ownership_cleared_figure_debt_remains: 3`
      - `mixed_figure_structure_debt: 585`
      - `mass_unresolved_figure_debt: 40`
      - `figure_processing_error_retry: 41`
      - `genericTimeoutRows: 0`
    - first Stage 3 wave currently selects `8` rows:
      - `3614`
      - `4184`
      - `3682`
      - `4074`
      - `4436`
      - `4487`
      - `4657`
      - `4693`
    - dry-run runner behavior:
      - `pnpm agency:run-stage3-figure-wave --build-only` now succeeds
      - it preserves the current pending figure wave without running remediation
  - Stage 3 canary manifest now includes:
    - benchmark canaries:
      - `Kendall County Profile`
      - `CSEC 2008 Research Bulletin`
      - `Criminal Sentencing Layout`
    - cohort representatives for:
      - ownership-cleared remaining figure debt
      - mixed figure+structure debt
      - figure-processing-error retry
      - short flyer / infographic style figure-heavy case
  - operational rule:
    - Stage 3 remains manifest-first and local-only
    - raw Stage 3 wave outcomes are not promotion truth
    - verified-promotion ledger remains the only authoritative promotion-ready source

- 2026-03-31 first real Stage 3 figure wave outcome:
  - wave artifacts:
    - `ICJIA-PDFs/manifests/stage3-figure-wave.outcomes.json`
    - `ICJIA-PDFs/manifests/stage3-figure-wave.outcomes.summary.json`
  - selected publication ids:
    - `3614`
    - `4184`
    - `3682`
    - `4074`
    - `4436`
    - `4487`
    - `4657`
    - `4693`
  - remediation totals:
    - `8` target candidates
    - `8` processed
    - `0` ready-to-replace / pass-candidate results
    - `5` `failed_after_remediation`
    - `3` `processing_error`
    - `0` remaining in the wave
  - hard-fail rows and dominant blocking patterns:
    - `3614`:
      - final `87 / B`
      - blocking `pdfua.figure_alt_or_artifact`
    - `3682`:
      - final `76 / C`
      - blocking `pdfua.figure_alt_or_artifact`
    - `4074`:
      - final `62 / D`
      - blocking `pdfua.logical_structure`, `pdfua.figure_alt_or_artifact`
    - `4184`:
      - final `69 / D`
      - blocking `pdfua.logical_structure`, `pdfua.figure_alt_or_artifact`
    - `4436`:
      - final `72 / C`
      - blocking `pdfua.logical_structure`
  - processing-error rows:
    - `4487`
    - `4657`
    - `4693`
    - all three now use bounded-runtime / inspection-budget wording instead of generic timeout phrasing
  - Stage 3 throughput summary after refresh:
    - `686` figure-heavy rows total
    - `17` verified-pass rows in cohort
    - `669` remaining figure-heavy rows
    - current wave results:
      - `5` hard fails
      - `3` processing errors
      - `0` newly verified passes
      - `0` pending rows after the refresh
    - `genericTimeoutRows: 0`
  - operational note:
    - the Stage 3 runner again hung after remediation outcomes were written
    - manual post-wave refresh was performed with:
      - control-plane rebuild
      - Stage 3 figure-wave rebuild
      - control-plane validation
    - because the wave produced `0` pass candidates, waiting for a full corpus-wide `agency:verify-ready` rerun was not necessary to truthfully update the Stage 3 lane


- 2026-03-31 Stage 3.1 figure-wave rebucketing pass:
  - `apps/api/src/services/corpusControlPlane.ts` now derives Stage 3 figure buckets from the latest Stage 3 wave outcomes before falling back to older benchmark/verification hints.
  - Latest-wave-driven routing now behaves as follows:
    - `3614` remains `ownership_cleared_figure_debt_remains`.
    - `3682` moves to `mass_unresolved_figure_debt`.
    - `4074` and `4184` remain `figure_heavy` but bucket as `mixed_figure_structure_debt`.
    - `4436` is reclassified from `figure_heavy` to `structure_heavy` after a structure-only first-wave outcome.
    - `4487`, `4657`, and `4693` remain `figure_heavy` but now surface as truthful `processing_error` rows with `figure_processing_error_retry` bucketing.
  - New Stage 3 routing reason codes are now used:
    - `stage3:reclassified_from_figure_heavy`
    - `stage3:structure_dominant_after_figure_wave`
    - `stage3:mixed_figure_structure_after_wave`
    - `stage3:bounded_runtime_figure_retry`
    - `stage3:mass_figure_debt_after_wave`
  - `apps/api/src/services/figureWaveStage3.ts` now prioritizes the next Stage 3 wave in this order:
    - `ownership_cleared_figure_debt_remains`
    - `mass_unresolved_figure_debt`
    - `figure_processing_error_retry`
    - `mixed_figure_structure_debt`
  - Stage 3 throughput summaries now expose routing views:
    - `nextWaveFigureOnlyPublicationIds`
    - `mixedFollowupPublicationIds`
    - `boundedRuntimeRetryPublicationIds`
    - `reclassifiedOutOfFigureHeavyPublicationIds`
  - Current post-rebucket Stage 3 control-plane state from `ICJIA-PDFs/manifests/corpus-control-plane.summary.json`:
    - `488` `figure_heavy` rows total
    - `17` `verified_pass` in cohort
    - `419` `remediated_fail` in cohort
    - `52` `processing_error` in cohort
    - `347` `structure_heavy` rows overall after spillover, including `4436`
  - Current next Stage 3 wave from `ICJIA-PDFs/manifests/stage3-figure-wave.json` no longer front-loads the mixed first-wave cases `4074` / `4184` / `4436` / `4487` / `4657` / `4693`.
    - selected publication ids are now:
      - `3614`
      - `3794`
      - `4185`
      - `4186`
      - `4481`
      - `4020`
      - `4551`
      - `3806`
  - Stage 3 canary representatives now intentionally include:
    - `3614` as ownership-cleared remaining figure debt
    - `3682` as mass unresolved figure debt
    - `4487` as bounded-runtime retry
  - `pnpm --filter api test src/__tests__/figureWaveStage3.test.ts` passed.
  - `pnpm --filter api build` passed.
  - `pnpm agency:build-control-plane` passed.
  - `pnpm agency:build-stage3-figure-wave` passed.
  - `pnpm agency:validate-control-plane` passed.

- 2026-03-31 second Stage 3 figure-wave execution against the corrected Stage 3.1 routing:
  - Before the run, the two dirty files
    - `ICJIA-PDFs/manifests/ready-to-replace-verification.classified.json`
    - `ICJIA-PDFs/manifests/ready-to-replace-verification.classified.summary.json`
    were restored because they only differed by regenerated timestamps and did not contain newer verification truth.
  - The corrected Stage 3 wave was started from `ICJIA-PDFs/manifests/stage3-figure-wave.json` with selected ids:
    - `3614`
    - `3794`
    - `4185`
    - `4186`
    - `4481`
    - `4020`
    - `4551`
    - `3806`
  - The live runner did not cleanly finish within the turn; it was interrupted after truthful partial outcomes had already been written for part of the wave.
  - Manual post-run refresh was then completed with:
    - `pnpm agency:build-control-plane`
    - `pnpm agency:build-stage3-figure-wave`
    - `pnpm agency:validate-control-plane`
  - There were no new verified passes from this second wave.
  - Truthful second-wave terminal outcomes written before interruption:
    - `3794`:
      - `failed_after_remediation`
      - final `80 / B`
      - blocking `pdfua.untagged_rendered_images`
    - `3806`:
      - `processing_error`
      - deferred with `excessive_runtime_loop`
      - notes: `Inspection budget exceeded (light=4, deep=9, total=13).`
    - `4020`:
      - `failed_after_remediation`
      - final `99 / B`
      - no local blocking keys remained, but still failed gate because score/grade were not perfect
    - `4186`:
      - `failed_after_remediation`
      - final `54 / F`
      - blocking:
        - `pdfua.logical_structure`
        - `pdfua.untagged_rendered_images`
        - `pdfua.figure_alt_or_artifact`
  - Previously written Stage 3 rows from the first figure wave remain in the same outcomes manifest, so the append-style file now mixes first-wave and second-wave rows; totals in `stage3-figure-wave.outcomes.summary.json` should not be read as a clean per-wave cohort total unless filtered by publication id.
  - Current refreshed Stage 3 throughput from `ICJIA-PDFs/manifests/stage3-figure-throughput.summary.json` after the partial second-wave refresh:
    - `488` total `figure_heavy` rows
    - `17` verified-pass rows in cohort
    - `0` newly verified-pass rows from this wave
    - `471` remaining figure-heavy rows
    - `4` processing-error rows in the combined current wave outcomes set
    - `8` hard-fail rows in the combined current wave outcomes set
    - `pendingWaveRows: 3`
      - `4185`
      - `4481`
      - `4551`
    - `genericTimeoutRows: 0`
  - Post-refresh routing signal:
    - Stage 3 is improving honesty, but not yet throughput.
    - The corrected wave still did not produce new ledger-backed passes.
    - The finished rows reinforce two buckets:
      - mass unresolved figure debt
      - mixed figure+structure debt
    - This is evidence that Stage 3 may be approaching saturation and that Stage 4 should likely focus on structure-heavy spillover rather than expecting large additional figure-only conversion.

- 2026-03-31 Stage 3 decision checkpoint after the corrected second wave:
  - Stage 3 should not currently be treated as complete in the sense of throughput closure.
  - Reason:
    - the corrected second Stage 3 wave produced `0` new ledger-backed verified passes
    - the finished rows reinforced:
      - mass unresolved figure debt
      - mixed figure+structure debt
      - bounded-runtime processing-error survivors
  - Current practical interpretation:
    - Stage 3 improved routing honesty and cohort separation
    - Stage 3 did not materially improve pass throughput in the latest wave
    - Stage 3 should be treated as operationally saturated rather than fully closed
  - Planning consequence:
    - Stage 4 should become the primary active lane
    - Stage 4 should focus on structure-heavy spillover from Stage 3
    - Stage 3 can remain open for occasional figure-only wins, but should not be the main expected conversion engine

- 2026-03-31 Stage 4 structure-heavy spillover lane implemented:
  - Added manifest-first Stage 4 structure-lane service and scripts:
    - `apps/api/src/services/structureWaveStage4.ts`
    - `scripts/build-stage4-structure-wave.ts`
    - `scripts/run-stage4-structure-wave.ts`
  - Extended the canonical control-plane row model with `stage4StructureDiagnostics` and updated `scripts/build-corpus-control-plane.ts` so the Stage 4 structure reclassification pass now runs after Stage 3.
  - Added package scripts:
    - `pnpm agency:build-stage4-structure-wave`
    - `pnpm agency:run-stage4-structure-wave`
  - Added test coverage in `apps/api/src/__tests__/structureWaveStage4.test.ts` and updated the Stage 2/3 test fixtures for the new control-plane field.
  - Current refreshed Stage 4 baseline from `ICJIA-PDFs/manifests/stage4-structure-throughput.summary.json`:
    - `342` total `structure_heavy` rows
    - `42` `verified_pass`
    - `300` remaining `structure_heavy` rows
    - bucketed as:
      - `93` `metadata_navigation_residuals`
      - `5` `structure_only_residuals`
      - `198` `mixed_structure_figure_residuals`
      - `4` `structure_processing_error_retry`
    - `0` generic timeout rows
  - First Stage 4 wave now exists at `ICJIA-PDFs/manifests/stage4-structure-wave.json` and currently selects:
    - `4054`
    - `3685`
    - `4023`
    - `4067`
    - `3671`
    - `3606`
    - `3465`
    - `3550`
  - Stage 4 canaries now exist at `ICJIA-PDFs/manifests/stage4-structure-canaries.json` and include benchmark plus spillover representatives, including `4436`.
  - Verified implementation commands:
    - `pnpm --filter api build`
    - `pnpm --filter api test src/__tests__/structureWaveStage4.test.ts src/__tests__/figureWaveStage3.test.ts src/__tests__/shortCohortStage2.test.ts`
    - `pnpm agency:build-control-plane`
    - `pnpm agency:build-stage4-structure-wave`
    - `pnpm agency:validate-control-plane`
    - `pnpm agency:run-stage4-structure-wave --build-only`
  - Important operational note:
    - running `pnpm agency:run-stage4-structure-wave --build-only` immediately after building the wave reuses the selected Stage 4 rows as the active pending wave, so `pendingWaveRows` becomes `8` in the throughput summary until real outcomes are written.

- 2026-03-31 Stage 4 first real structure wave started, partially completed, and was truthfully refreshed after interruption:
  - Started the first real Stage 4 wave with:
    - `pnpm agency:run-stage4-structure-wave`
  - The live run wrote truthful partial outcomes to:
    - `ICJIA-PDFs/manifests/stage4-structure-wave.outcomes.json`
    - `ICJIA-PDFs/manifests/stage4-structure-wave.outcomes.summary.json`
  - After the run was interrupted to avoid waiting indefinitely on the remaining in-flight items, the truthful fallback refresh was completed with:
    - `pnpm agency:build-control-plane`
    - `pnpm agency:build-stage4-structure-wave`
    - `pnpm agency:validate-control-plane`
  - Current truthful partial wave state from `stage4-structure-wave.outcomes.summary.json`:
    - `8` target candidates
    - `3` processed
    - `0` ready-to-replace / remediated pass-candidates
    - `3` `failed_after_remediation`
    - `0` `processing_error`
    - `5` remaining without written terminal outcomes
  - Processed publication ids so far:
    - `3685` (`ADAM 4`)
      - truthful terminal state: `failed_after_remediation`
      - gate failed only because `Categories still below 100: Reading Order`
      - no blocking local finding keys remained
    - `3550` (`Motor Vehicle Theft: A Message from McGruff`)
      - truthful terminal state: `failed_after_remediation`
      - improved from original `21 / F` to final `100 / A`
      - gate still failed only because `Categories still below 100: Reading Order`
      - no blocking local finding keys remained
    - `3606` (`Information for Crime Victims`)
      - truthful terminal state: `failed_after_remediation`
      - improved from original `21 / F` to final `100 / A`
      - gate still failed only because `Categories still below 100: Reading Order`
      - no blocking local finding keys remained
  - Remaining selected Stage 4 ids without written terminal outcomes when the run was stopped:
    - `3465`
    - `3671`
    - `4023`
    - `4054`
    - `4067`
  - Refreshed Stage 4 throughput from `ICJIA-PDFs/manifests/stage4-structure-throughput.summary.json` after the truthful fallback rebuild:
    - `341` total `structure_heavy` rows
    - `42` `verified_pass`
    - `299` remaining `structure_heavy` rows
    - `3` hard-fail rows in the current wave outcomes set
    - `0` processing-error rows in the current wave outcomes set
    - `5` pending wave rows: `3465`, `3671`, `4023`, `4054`, `4067`
    - `0` generic timeout rows
  - Interpretation:
    - The first real Stage 4 wave has begun and is producing truthful structure-lane evidence.
    - No new ledger-backed passes were produced before interruption.
    - The completed rows reinforce metadata/navigation structure debt rather than generic runtime churn.
    - The next Stage 4 decision should start from the refreshed manifests, not the interrupted process state.

- 2026-03-31 Stage 4.1 follow-up slice and reporting refinement implemented:
  - Added Stage 4 follow-up execution support so `scripts/run-stage4-structure-wave.ts` can run `--pending-only` and rebuild the Stage 4 wave for only the unresolved pending publication ids.
  - `scripts/build-stage4-structure-wave.ts` now accepts `ICJIA_STAGE4_STRUCTURE_WAVE_INCLUDE_IDS` and passes the filtered ids into the Stage 4 wave builder, keeping the same Stage 4 artifact family while allowing a narrow follow-up slice.
  - `apps/api/src/services/structureWaveStage4.ts` now:
    - preserves latest outcome-driven structure diagnostics when reclassifying rows
    - can adopt rows with Stage 4 outcome evidence into the `structure_heavy` lane
    - exposes `readingOrderOnlyResidualPublicationIds` in `stage4-structure-throughput.summary.json`
  - Current Stage 4 follow-up slice after rebuild:
    - selected pending ids: `4054`, `4023`, `4067`, `3671`, `3465`
    - `pendingWaveRows: 5`
  - The Stage 4.1 follow-up run was attempted with:
    - `pnpm agency:run-stage4-structure-wave --pending-only`
  - It did not write any new terminal outcomes before being interrupted, so the truthful Stage 4 outcomes set remains:
    - `3` hard fails: `3550`, `3606`, `3685`
    - `0` processing errors
    - `0` new pass candidates
    - `5` still pending without written terminal outcomes: `3465`, `3671`, `4023`, `4054`, `4067`
  - Stage 4 throughput after the Stage 4.1 rebuild now explicitly surfaces the first-wave structure-only survivors via `readingOrderOnlyResidualPublicationIds`:
    - `3550`
    - `3606`
    - `3685`
  - Refreshed Stage 4 structure totals now read:
    - `342` total `structure_heavy`
    - `42` `verified_pass`
    - `300` remaining `structure_heavy`
    - `83` `metadata_navigation_residuals`
    - `6` `structure_only_residuals`
    - `207` `mixed_structure_figure_residuals`
    - `4` `structure_processing_error_retry`
    - `0` generic timeout rows
  - Verified commands:
    - `pnpm --filter api build`
    - `pnpm --filter api test src/__tests__/structureWaveStage4.test.ts src/__tests__/figureWaveStage3.test.ts src/__tests__/shortCohortStage2.test.ts`
    - `pnpm agency:build-control-plane`
    - `pnpm agency:build-stage4-structure-wave`
    - `pnpm agency:validate-control-plane`
  - Current interpretation:
    - Stage 4 remains active and is still not complete.
    - The first real Stage 4 wave is still unfinished operationally because the same `5` rows remain without written terminal outcomes.
    - The Stage 4 decision surface is now clearer: the completed first-wave rows are explicit `Reading Order`-only structure survivors, and the pending five can be retried later without re-running the already-written rows.

## 2026-03-31 Stage 4.2 Pending-Row Forensics

- Stage 4.2 is now implemented as a manifest-first forensic routing pass for unresolved Stage 4 pending rows.
- New artifact/script surface:
  - `ICJIA-PDFs/manifests/stage4-structure-pending-analysis.json`
  - `ICJIA-PDFs/manifests/stage4-structure-pending-analysis.summary.json`
  - `scripts/analyze-stage4-structure-pending.ts`
  - package script: `pnpm agency:analyze-stage4-structure-pending`
- The control plane and Stage 4 wave builders now consume Stage 4.2 analysis rows when a row has no terminal Stage 4 outcome.
- Current Stage 4.2 forensic result:
  - analyzed pending ids: `3465`, `3671`, `4023`, `4054`, `4067`
  - all `5` were classified as `metadata_navigation_residuals`
  - evidence strength for all `5`: `attempt_artifact_only`
  - no rows were reclassified to `figure_heavy`
  - no rows were forced into `structure_processing_error_retry`
- Stage 4 throughput after Stage 4.2 rebuild:
  - `342` total `structure_heavy`
  - `42` `verified_pass`
  - `300` remaining
  - `83` `metadata_navigation_residuals`
  - `6` `structure_only_residuals`
  - `207` `mixed_structure_figure_residuals`
  - `4` `structure_processing_error_retry`
  - `0` `pendingWaveRows`
  - `0` generic timeout rows
- Stage 4 reporting now distinguishes:
  - `forensicallyResolvedPendingPublicationIds`
  - `stillUnclassifiedPendingPublicationIds`
  - `readingOrderOnlyResidualPublicationIds`
- Current Stage 4.2 reporting state in `stage4-structure-throughput.summary.json`:
  - `forensicallyResolvedPendingPublicationIds`: `3465`, `3671`, `4023`, `4054`, `4067`
  - `stillUnclassifiedPendingPublicationIds`: empty
  - `readingOrderOnlyResidualPublicationIds`: `3550`, `3606`, `3685`
- Practical outcome:
  - the first Stage 4 wave is now decision-complete at the routing layer even though only `3` rows have terminal Stage 4 remediation outcomes
  - the stale pending state from the interrupted first wave has been eliminated without inventing any passes or terminal failures
  - Stage 4 remains active and not complete, but it no longer has unresolved “pending because interrupted” rows blocking the next planning step

## 2026-03-31 Stage 4.3 Truth-D drift fix

- Stage 4 remains the active lane.
- Stage 4.3 fixed a truth drift where `stage4-structure-wave.json` could show stale `pendingPublicationIds` that no longer matched written Stage 4 outcomes.
- Implementation changes:
  - `apps/api/src/services/structureWaveStage4.ts`
    - terminal Stage 4 outcomes now always win over stale pending-wave state
    - Stage 4 wave continuation now prefers the explicit Stage 4.3 active-analysis artifact when present
    - Stage 4 throughput reporting now exposes `activeUnresolvedPublicationIds`
    - Stage 4 build now refreshes `stage4-structure-wave.outcomes.summary.json` so wave manifest, outcomes summary, and throughput summary stay aligned after interrupted runs
  - new script:
    - `scripts/analyze-stage4-structure-active.ts`
    - package script: `pnpm agency:analyze-stage4-structure-active`
- New Stage 4.3 forensic artifact roots:
  - `ICJIA-PDFs/manifests/stage4-structure-active-analysis.json`
  - `ICJIA-PDFs/manifests/stage4-structure-active-analysis.summary.json`
- Current Stage 4.3 active unresolved set is exactly:
  - `3465`
  - `3671`
  - `4023`
  - `4054`
  - `4067`
- Stage 4.3 classified all five active unresolved rows as:
  - `metadata_navigation_residuals`
  - evidence strength: `attempt_artifact_only`
- Current aligned Stage 4 truth after Stage 4.3 rebuild:
  - `stage4-structure-wave.json`
    - `selectedRows: 5`
    - `pendingRows: 5`
    - selected/pending ids match the five-row active unresolved set above
  - `stage4-structure-wave.outcomes.summary.json`
    - `processed: 4`
    - `failedAfterRemediation: 4`
    - `remaining: 5`
  - `stage4-structure-throughput.summary.json`
    - `pendingWaveRows: 5`
    - `activeUnresolvedPublicationIds` matches the same five ids
    - `stillUnclassifiedPendingPublicationIds: []`
    - `readingOrderOnlyResidualPublicationIds` remains:
      - `3550`
      - `3606`
      - `3685`
- `3651` is now correctly treated as a terminal Stage 4 hard fail, not a pending row.
  - it is not part of `readingOrderOnlyResidualPublicationIds`
  - its terminal blocker shape includes `pdfua.font_embedding` plus unresolved `Text Extractability`, `Reading Order`, and `PDF/UA Compliance`
- Stage 4 is still not complete.
  - The next practical move after Stage 4.3 is another targeted Stage 4 execution step or a Stage 4.4 routing pass if those five metadata/navigation survivors continue to churn without writing terminal outcomes.

## Stage 4 Active Lane
- 2026-03-31 partial follow-up Stage 4 wave after Stage 4.4:
  - selected wave initially: `3767`, `3771`, `3964`, `3981`, `4046`, `4047`, `4050`, `4135`
  - before interrupt, only `3767` wrote a fresh truthful terminal outcome:
    - `failed_after_remediation`
    - failure report path: `ICJIA-PDFs/reports/failures/stage4-structure-wave/143.244.146.43/3767-Safety_Plan_for_Domestic_Violence_Victims.failure.json`
  - the remaining seven did not write terminal outcomes before the run was stopped and manifests were rebuilt from written evidence only
  - after the fallback rebuild, the next Stage 4 wave advanced to:
    - `3964`, `4046`, `4047`, `4050`, `4135`, `4037`, `4061`, `3597`
- 2026-03-31 Stage 4.4 is now implemented as a routing/reporting correction pass over the five-row metadata/navigation wave.
- The latest five-row Stage 4 wave is now terminalized truthfully in manifest space:
  - processed rows: `3465`, `3671`, `4023`, `4054`, `4067`
  - outcomes summary now reports current-wave truth separately from cumulative append history:
    - current wave: `targetCandidates 5`, `processed 5`, `failedAfterRemediation 5`, `remaining 0`
    - cumulative Stage 4 history remains preserved separately
- Stage 4.4 terminal survivor routing now treats these rows as:
  - `4023`, `4054`, `4067` -> `near_pass_grade_only`
  - `3465` -> `font_text_extractability_survivor`
  - `3671` -> `figure_spillover_survivor` and reclassified back to `figure_heavy`
  - `3550`, `3606`, `3685` remain `reading_order_only_survivor` representatives
- Stage 4 throughput/reporting after Stage 4.4:
  - `pendingWaveRows: 0` for the completed five-row reporting wave
  - `activeUnresolvedPublicationIds: []` for that completed wave
  - the next Stage 4 wave has been rebuilt from fresh unresolved candidates instead of stale carryover
- Stage 4 canaries now intentionally prefer current Stage 4.4 representatives:
  - near-pass grade-only representative: `4023`
  - font/text-extractability representative: `3465`
  - figure-spillover representative: `3671`
- 2026-03-31: Stage 4 follow-up wave `3665/3670/3683/3768/3769/3770/3784/3836` completed after truthful fallback rebuild with `8` processed, `8` `failed_after_remediation`, `0` `processing_error`, `0` remaining. The next active Stage 4 wave rebuilt to `3866/3871/3877/3898/3899/3903/3933/4039`.
- 2026-03-31: Stage 4.7 routed `3665/3670/3683/3768/3769/3770/3784` as `metadata_title_survivor` terminal rows and kept `3836` as `font_text_extractability_survivor`, which dropped live `metadata_navigation_residuals` backlog from `28` to `18` without changing the next active wave `3866/3871/3877/3898/3899/3903/3933/4039`.
- 2026-03-31: Attempted Stage 4 wave `3866/3871/3877/3898/3899/3903/3933/4039` but it returned to long inspection churn and wrote `0` terminal outcomes before truthful fallback rebuild. Active wave selection remained unchanged after rebuild.
- 2026-03-31: Stage 4.8 is now implemented as a non-remediation stalled-wave forensic pass for the zero-outcome attempted wave `3866/3871/3877/3898/3899/3903/3933/4039`.
  - New script and package command:
    - `scripts/analyze-stage4-structure-stalled.ts`
    - `pnpm agency:analyze-stage4-structure-stalled`
  - New forensic artifacts:
    - `ICJIA-PDFs/manifests/stage4-structure-stalled-analysis.json`
    - `ICJIA-PDFs/manifests/stage4-structure-stalled-analysis.summary.json`
  - Stage 4.8 stalled-analysis disposition for that 8-row wave:
    - `metadata_title_survivor`: `3866`, `3871`, `3899`, `3933`
    - `metadata_navigation_residuals`: `3877`, `3903`
    - `font_text_extractability_survivor`: `3898`, `4039`
    - `mixed_structure_figure_residuals`: none
    - `structure_processing_error_retry`: none
  - Evidence strength for all 8 stalled rows was `attempt_artifact_only`.
  - Stage 4 throughput reporting now separates completed reporting-wave truth from active-wave truth with:
    - `activeWaveSelectedPublicationIds`
    - `activeWavePendingPublicationIds`
    - `activeWaveAttemptedButUnterminalizedPublicationIds`
    - `stalledForensicPublicationIds`
    - `stalledForensicByDisposition`
  - After Stage 4.8 rebuild, the old stalled 8-row wave is no longer front-of-wave retry state; the next active Stage 4 wave advanced to:
    - `3877`, `3903`, `3936`, `4677`, `4723`, `3483`, `4145`, `4094`
  - Current Stage 4 active-wave reporting after Stage 4.8:
    - `pendingWaveRows: 8`
    - `activeWaveSelectedPublicationIds` and `activeWavePendingPublicationIds` both match the 8-row set above
    - `activeWaveAttemptedButUnterminalizedPublicationIds` currently highlights `3877` and `3903` because they are the only rows shared between the active wave and the stalled forensic set
  - `genericTimeoutRows` remains `0`.
  - Stage 4 remains the active lane; the next likely move after Stage 4.8 is a targeted Stage 4 live wave on the rebuilt active set or a narrower routing pass if `3877` and `3903` should also be terminalized out of metadata-first selection.
- 2026-03-31: Stage 4.9 is now implemented as a narrow overlap-analysis pass for the two rows shared between Stage 4.8 stalled forensics and the active metadata wave.
  - New script and package command:
    - `scripts/analyze-stage4-structure-overlap.ts`
    - `pnpm agency:analyze-stage4-structure-overlap`
  - New forensic artifacts:
    - `ICJIA-PDFs/manifests/stage4-structure-overlap-analysis.json`
    - `ICJIA-PDFs/manifests/stage4-structure-overlap-analysis.summary.json`
  - Stage 4.9 overlap decision:
    - `3877` -> `reading_order_only_survivor`
    - `3903` -> `reading_order_only_survivor`
  - Reasoning: both rows' latest prior remediation evidence ended with `Reading Order` as the only unresolved category, so Stage 4.9 terminalized them out of `metadata_navigation_residuals`.
  - After Stage 4.9 rebuild, the next active Stage 4 wave advanced from `3877/3903/3936/4677/4723/3483/4145/4094` to:
    - `3936`, `4677`, `4723`, `3483`, `4145`, `4094`, `4209`, `4076`
  - Then a targeted live Stage 4 run was attempted on that rebuilt active set, but it returned to long inspection churn and wrote `0` terminal outcomes before truthful fallback rebuild.
  - After fallback rebuild, the active Stage 4 wave remained unchanged:
    - `3936`, `4677`, `4723`, `3483`, `4145`, `4094`, `4209`, `4076`
  - `genericTimeoutRows` remains `0`.
  - Stage 4 remains the active lane; the next likely move after Stage 4.9 is a Stage 4.10 routing/forensics pass on `3936/4677/4723/3483/4145/4094/4209/4076`, not another blind rerun.
- 2026-03-31: Stage 4.10 is now implemented as an active-wave forensic pass for the post-overlap zero-outcome wave `3936/4677/4723/3483/4145/4094/4209/4076`.
  - New script and package command:
    - `scripts/analyze-stage4-structure-active-forensics.ts`
    - `pnpm agency:analyze-stage4-structure-active-forensics`
  - New forensic artifacts:
    - `ICJIA-PDFs/manifests/stage4-structure-active-forensics.json`
    - `ICJIA-PDFs/manifests/stage4-structure-active-forensics.summary.json`
  - Stage 4.10 active-forensics result from current active-wave evidence:
    - `font_text_extractability_survivor`: `4076`, `4209`
    - no new `metadata_title_survivor`, `reading_order_only_survivor`, `mixed_structure_figure_residuals`, or `structure_processing_error_retry` rows from this pass
  - After sequential rebuild from the new forensic artifact, `4076` and `4209` were terminalized out of the live metadata retry lane while preserving truthful status `remediated_fail`.
  - Stage 4 reporting now exposes:
    - `activeForensicsPublicationIds`
    - `activeForensicsByDisposition`
  - After Stage 4.10 rebuild, the active Stage 4 wave advanced from `3936/4677/4723/3483/4145/4094/4209/4076` to:
    - `3870`, `3655`, `4045`, `3781`, `3785`, `3919`, `3793`, `3924`
  - A targeted live Stage 4 run was attempted on that reduced 8-row set, but it wrote `0` new terminal outcomes before truthful fallback rebuild.
  - After fallback rebuild, the active Stage 4 wave remained unchanged:
    - `3870`, `3655`, `4045`, `3781`, `3785`, `3919`, `3793`, `3924`
  - Current Stage 4.10 reporting state:
    - `pendingWaveRows: 8`
    - `activeWaveSelectedPublicationIds` and `activeWavePendingPublicationIds` both match the 8-row set above
    - `reportingWaveSelectedPublicationIds` remains the last completed truthful reporting wave: `3936`, `4145`, `4723`, `3483`, `4094`
  - `genericTimeoutRows` remains `0`.
  - Stage 4 remains the active lane; the next likely move after Stage 4.10 is a Stage 4.11 forensics/routing pass on `3870/3655/4045/3781/3785/3919/3793/3924`, not another blind rerun.

## 2026-04-06 Pass-Rate Proof-Loop Execution Layer

- `apps/api/src/services/passRateWaveSlices.ts` now hardens pass-rate slice selection so:
  - figure canaries prefer figure-dominant rows instead of rows where figure debt is only incidental
  - font canaries exclude figure-dominant mixed rows
  - non-verified `100/A` near-pass anomalies are excluded unless the target family is truly dominant
  - slice manifests now include runner-ready candidate fields compatible with `scripts/run-priority-remediation-batch.ts`
  - figure/font slice docs expose `totals` and `selectionSanity`
  - runtime retry docs expose grouped per-family counts
- New proof-loop service:
  - `apps/api/src/services/passRateProofLoops.ts`
  - writes before/after delta summaries for figure, font, and runtime retry slices
- New operational runners:
  - `pnpm agency:run-pass-rate-figure-canary`
  - `pnpm agency:run-pass-rate-font-canary`
  - `pnpm agency:run-runtime-tail-retry-wave`
  - each runner:
    - rebuilds pass-rate slices
    - optionally runs remediation on only the selected IDs
    - rebuilds/validates the control plane
    - writes a proof summary JSON for the selected slice
- New proof summary outputs:
  - `ICJIA-PDFs/manifests/pass-rate-figure-canary.proof-summary.json`
  - `ICJIA-PDFs/manifests/pass-rate-font-canary.proof-summary.json`
  - `ICJIA-PDFs/manifests/runtime-tail-retry-wave.proof-summary.json`
- Hardened real-manifest truth after selection tightening:
  - figure canary selected `3614, 3755, 3873, 4700, 3839, 3844, 3996, 4020`
  - font canary selected `3838, 4099, 4144, 4151, 4166, 4173, 4176, 4199`
  - runtime retry wave still contains `99` rows
  - suspicious prior figure-canary anomaly `3567` is no longer selected
- Verified on 2026-04-06:
  - `pnpm --filter api build` -> pass
  - `pnpm --filter api exec vitest run src/__tests__/passRateWaveSlices.test.ts src/__tests__/passRateProofLoops.test.ts` -> `7/7` pass
  - `pnpm agency:build-pass-rate-slices` -> pass
  - `pnpm agency:run-pass-rate-figure-canary --build-only` -> pass and wrote baseline proof summary
  - `pnpm agency:run-pass-rate-font-canary --build-only` -> pass and wrote baseline proof summary
  - `pnpm agency:run-runtime-tail-retry-wave --build-only` -> pass and wrote baseline proof summary
  - `pnpm agency:validate-control-plane` -> `ok: true`

## 2026-04-06 Live Figure And Font Proof-Loop Results

- Live figure canary execution completed for the 8-row cohort selected at run start:
  - `3614, 3755, 3873, 4700, 3839, 3844, 3996, 4020`
- Figure canary truthful outcome:
  - `1` `remediated_pass_candidate`
  - `7` `failed_after_remediation`
  - `0` `processing_error`
- The figure winner was publication `4700` (`R3 2022 Annual Report`):
  - improved from `75/C` to `100/A`
  - staged to `/home/hendo420/pdfaf/ICJIA-PDFs/staging/to-replace/192.241.146.85/R3_Report_Final_c3f12abc60.pdf`
- Figure canary operational note:
  - the remediation batch completed, but the wrapper hung in the post-remediation phase
  - truthful fallback was to kill the hung wrapper, then run:
    - `pnpm exec tsx scripts/classify-ready-verification.ts`
    - `pnpm agency:build-control-plane`
    - `pnpm agency:validate-control-plane`
- Live font canary execution completed for the 8-row cohort selected at run start:
  - `3838, 4099, 4144, 4151, 4166, 4173, 4176, 4199`
- Font canary truthful outcome:
  - `0` `remediated_pass_candidate`
  - `8` `failed_after_remediation`
  - `0` `processing_error`
- Font canary residual pattern:
  - the lane did improve scores on some files, but survivors commonly ended at:
    - `pdfua.heading_content_quality`
    - remaining `Heading Structure` / `PDF/UA Compliance` deficits
  - this is evidence that current planner-only font-lane selection is not enough by itself
- Current evidence-led next lane after those two live proof loops:
  - figure-family deepening is stronger than font as the immediate next engine investment
- Runtime retry wave was started on 2026-04-06, but it was intentionally stopped before completion so the workspace would not be left running a 99-row unattended batch with no persisted summary yet.

## 2026-04-06 Overnight Runtime Retry Runner

- `scripts/run-pass-rate-proof-loop-common.ts` now uses a persisted-truth verify wrapper modeled on Stage 4:
  - it can continue once verification artifacts are written and the selected outcomes are terminal, even if `verify-ready` itself is still hanging
- New overnight runtime-tail helpers:
  - `pnpm agency:start-runtime-tail-retry-wave-overnight`
  - `pnpm agency:runtime-tail-retry-wave-status`
- The overnight launcher writes:
  - PID file: `ICJIA-PDFs/logs/runtime-tail-retry-wave-overnight.pid`
  - metadata file: `ICJIA-PDFs/logs/runtime-tail-retry-wave-overnight.json`
  - timestamped log file under `ICJIA-PDFs/logs/`
- Current overnight runtime-tail batch was launched at `2026-04-06T05:36:02.992Z` with:
  - PID `1110182`
  - log file `/home/hendo420/pdfaf/ICJIA-PDFs/logs/runtime-tail-retry-wave-2026-04-06T05-36-02-992Z.log`
- The launched batch is the full `99`-row `runtime-tail-retry-wave` cohort and is intended to run unattended overnight through the hardened proof-loop path.

## 2026-04-06 Throughput Sprint Lanes

- Throughput work is now routed through explicit operational lanes instead of one blended remediation queue.
- New manifest builders in `apps/api/src/services/passRateWaveSlices.ts`:
  - `small-fast-pass`
  - `medium-figure-conversion`
  - `serial-heavy-mixed-terminalization`
  - `manual-scanned-deferred`
- New lane manifest fields:
  - `laneIntent`
  - `executionPolicy`
  - `recommendedConcurrency`
  - `initialAnalysisProfile`
  - `verificationPolicy`
  - per-candidate `runtimeWeightBucket`
  - per-candidate `runtimeProfileKey`
- Lane intent values:
  - `pass_rate_conversion`
  - `truth_hardening_terminalization`
  - `deferred_manual_review`
- Current generated throughput-lane counts after `pnpm agency:build-pass-rate-slices`:
  - `smallFastPassCount: 48`
  - `mediumFigureConversionCount: 32`
  - `serialHeavyMixedTerminalizationCount: 116`
  - `manualScannedDeferredCount: 169`
- Runtime retry lanes remain separate from the throughput sprint and still reflect:
  - `runtimeFigureRetryCount: 0`
  - `runtimeStructureRetryCount: 3`
  - `runtimeMixedTerminalizationCount: 49`
- New throughput runner:
  - `scripts/run-throughput-lane.ts`
- New package scripts:
  - `pnpm agency:run-small-fast-pass`
  - `pnpm agency:run-medium-figure-conversion`
  - `pnpm agency:run-serial-heavy-mixed-terminalization`
  - `pnpm agency:run-manual-scanned-deferred`
- Throughput runner behavior:
  - rebuilds throughput manifests first
  - respects per-lane `executionPolicy`
  - passes lane-specific concurrency into `scripts/run-priority-remediation-batch.ts`
  - passes lane-specific initial analysis profile into `scripts/run-priority-remediation-batch.ts`
  - keeps deferred manual/scanned lane non-runnable unless `ICJIA_ALLOW_DEFERRED_LANE=1`
- `scripts/run-priority-remediation-batch.ts` now:
  - carries lane metadata from the manifest into outcomes
  - supports `ICJIA_REMEDIATION_INITIAL_ANALYSIS_PROFILE`
  - can start fast lanes with `remediation_fast` instead of `full_final` for the initial analysis pass
  - writes lane-aware summaries with:
    - throughput metrics (`pdfsPerHour`, `terminalOutcomesPerHour`, `passCandidatesPerHour`)
    - pass-rate quality metrics for conversion lanes
    - truth-hardening quality metrics for terminalization lanes
- Policy currently implemented:
  - `small-fast-pass` -> active, `pass_rate_conversion`, concurrency `10`, `remediation_fast`
  - `medium-figure-conversion` -> active, `pass_rate_conversion`, concurrency `5`, `remediation_fast`
  - `serial-heavy-mixed-terminalization` -> active, `truth_hardening_terminalization`, concurrency `1`, `remediation_fast`
  - `manual-scanned-deferred` -> deferred, `deferred_manual_review`, concurrency `1`, `remediation_fast`
- Verified on 2026-04-06:
  - `pnpm --filter api build` -> pass
  - `pnpm --filter api exec vitest run src/__tests__/passRateWaveSlices.test.ts src/__tests__/runtimeTailOvernight.test.ts src/__tests__/agentRemediationService.test.ts` -> `108/108` pass
  - `pnpm agency:build-pass-rate-slices` -> pass
  - `pnpm agency:validate-control-plane` -> `ok: true`
  - `ICJIA_THROUGHPUT_LANE_NAME=manual-scanned-deferred pnpm exec tsx scripts/run-throughput-lane.ts` -> skips correctly because the lane is deferred by policy
- Live `small-fast-pass` run on 2026-04-06:
  - manifest size at run start: `48`
  - concurrency: `10`
  - initial analysis profile: `remediation_fast`
  - final result:
    - `48` processed
    - `0` pass candidates
    - `48` failed after remediation
    - `0` processing errors
  - throughput summary from `ICJIA-PDFs/manifests/small-fast-pass.outcomes.summary.json`:
    - `pdfsPerHour: 33.25`
    - `terminalOutcomesPerHour: 33.25`
    - `passCandidatesPerHour: 0`
    - `rowsWithBlockingFindingShrink: 42`
  - interpretation:
    - the lane moved files quickly and honestly, but did not produce passes under the strict gate
    - several “small” docs were still runtime-expensive outliers, including:
      - `Focused Deterrence: A Policing Strategy to Combat Gun Violence`
      - `2024 Domestic Violence Fatality Review Committee Biennial Report`
      - `Addressing Child Exposure to Violence`
      - `Civil Rights Policy 2019`
  - after tightening `small-fast-pass` to exclude:
    - font debt
    - structure-only / non-figure quick-shape rows
    - blocker-heavy rows
    - known slow small-doc profiles
  - rebuilt `smallFastPassCount` dropped to `0`
- current conclusion:
  - there is no real cheap-winner cohort left under the stricter selector
  - the next practical throughput lane is `medium-figure-conversion`, not `small-fast-pass`

## 2026-04-07 Replacement-Likelihood Lane

- Added a new evidence-based throughput lane:
  - `replacement-likelihood`
- Purpose:
  - only include rows that look plausibly replaceable under the current strict gate
  - explicitly avoid broad blocker-shrink lanes that do not produce pass candidates
- Implemented in:
  - `apps/api/src/services/passRateWaveSlices.ts`
  - `scripts/build-pass-rate-slices.ts`
  - `package.json`
- New command:
  - `pnpm agency:run-replacement-likelihood`
- Selection policy is intentionally strict:
  - non-pass only
  - light runtime weight only
  - page count `<= 16`
  - no scanned/manual-tail rows
  - no known slow small-doc profiles
  - no font debt
  - no `pdfua.logical_structure`
  - no table/link/note/context residuals
  - blocker family count `<= 1`
  - blocking finding count `<= 3`
  - all blocking keys must be inside a narrow allowlist:
    - `pdfua.figure_alt_or_artifact`
    - `pdfua.nested_alt_text`
    - `pdfua.heading_content_quality`
    - `pdfua.display_doc_title`
    - `pdfua.document_language`
    - `pdfua.bookmark_language`
  - requires auto-runnable opportunities
- Verified on 2026-04-07:
  - `pnpm --filter api exec vitest run src/__tests__/passRateWaveSlices.test.ts` -> pass (`12/12`)
  - `pnpm agency:build-pass-rate-slices` -> pass
- Current grounded result after rebuild:
  - `replacementLikelihoodCount: 0`
- Interpretation:
  - the lane is implemented correctly, but current corpus truth does not contain any rows that meet a genuinely strict replacement-likelihood threshold
  - this confirms the present bottleneck is not “we haven’t isolated the likely winners yet”; it is that the remaining backlog still carries too much residual debt for a clean pass-only lane

## 2026-04-11 Remediated PDF Grading Audit

- A corpus-wide verification lane now exists for grading every PDF under `ICJIA-PDFs/artifacts/remediated-pdfs/` and comparing the current grade against the latest historical score recorded for that same remediated artifact path.
- Commands:
  - build manifest:
    - `pnpm agency:build-remediated-pdf-grading`
  - run or resume grading:
    - `pnpm agency:run-remediated-pdf-grading`
  - status / watch:
    - `pnpm agency:remediated-pdf-grading-status`
    - supports `--json`
- Outputs:
  - manifest:
    - `ICJIA-PDFs/manifests/remediated-pdf-grading.json`
    - `ICJIA-PDFs/manifests/remediated-pdf-grading.summary.json`
  - outcomes:
    - `ICJIA-PDFs/manifests/remediated-pdf-grading.outcomes.json`
    - `ICJIA-PDFs/manifests/remediated-pdf-grading.outcomes.summary.json`
    - `ICJIA-PDFs/manifests/remediated-pdf-grading.drift-report.json`
    - `ICJIA-PDFs/manifests/remediated-pdf-grading.outcomes.progress.json`
  - per-file detailed grading reports:
    - `ICJIA-PDFs/reports/test-runs/remediated-pdf-grading/`
- Defaults:
  - analysis profile: `full_final`
  - concurrency: `4`
  - timeout per PDF: `1800000` ms
- Status output is intentionally aligned with remediation lanes:
  - `processed/total`
  - score-band counts
  - exact historical score matches vs drift
  - throughput / ETA
  - last-completed row
- Finished 2026-04-12 on the corrected scope of best-known remediated artifact per publication:
  - `970` graded
  - score bands:
    - `90+`: `312`
    - `80-89`: `352`
    - `<80`: `306`
  - comparison vs historical:
    - `969` with historical score
    - `423` exact score matches
    - `546` score drifts
    - `57` scored higher than historical
    - `489` scored lower than historical
    - `651` exact grade matches
    - `318` grade drifts
- Follow-on rerun lane for the freshly verified sub-80 remediated artifacts:
  - build:
    - `pnpm agency:build-remediated-pdf-grading-sub80-rerun`
  - run:
    - `pnpm agency:run-remediated-pdf-grading-sub80-rerun`
  - status:
    - `pnpm agency:remediated-pdf-grading-sub80-rerun-status`
  - source:
    - `ICJIA-PDFs/manifests/remediated-pdf-grading.outcomes.json`
  - selection:
    - currently `306` graded remediated artifacts with fresh score `<80`
    - uses the graded remediated PDF itself as the next `localCachePath`
    - keeps all outputs on disk (`ICJIA_REMEDIATION_MIN_KEEP_SCORE` unset)
- Second rerun lane from the retained failed outputs of that grading-sub80 pass:
  - build:
    - `pnpm agency:build-remediated-pdf-grading-sub80-rerun-v2`
  - run:
    - `pnpm agency:run-remediated-pdf-grading-sub80-rerun-v2`
  - status:
    - `pnpm agency:remediated-pdf-grading-sub80-rerun-v2-status`
  - source:
    - `ICJIA-PDFs/manifests/remediated-pdf-grading-sub80-rerun.outcomes.json`
  - selection:
    - `216` retained sub-80 failed outputs
    - excludes rows that rose to `80+` and non-terminal processing-error style rows
  - current campaign state on 2026-04-12:
    - run id: `24177e6f-d324-485e-995e-8115d35f1c92`
    - completed on 2026-04-13 with `216/216`
    - results:
      - `21` scored `90+`
      - `2` scored `80-89`
      - `191` remained `<80`
      - `2` processing errors
    - safe to resume without losing prior progress
- Third rerun lane from the retained failed outputs of the grading-sub80 v2 pass:
  - build:
    - `pnpm agency:build-remediated-pdf-grading-sub80-rerun-v3`
  - run:
    - `pnpm agency:run-remediated-pdf-grading-sub80-rerun-v3`
  - status:
    - `pnpm agency:remediated-pdf-grading-sub80-rerun-v3-status`
  - source:
    - `ICJIA-PDFs/manifests/remediated-pdf-grading-sub80-rerun-v2.outcomes.json`
  - selection:
    - `191` retained sub-80 failed outputs
    - excludes `2` rows that rose above `79`
    - excludes `23` non-terminal / processing-error rows
  - current campaign state on 2026-04-13:
    - run id: `c38e318a-b218-453a-8782-5891f4445962`
    - started with `0/191`
- LM Studio provider switch (2026-04-12):
  - default primary provider in `apps/api/.env` now points to LM Studio on `http://192.168.50.238:1234/v1`
  - model: `google/gemma-4-26b-a4b`
  - `OPENAI_COMPAT_TOOL_CHOICE_MODE=required` is required for LM Studio/Gemma tool calling because the planner’s prior named-function object format is rejected there
  - direct `/v1/chat/completions` verification against LM Studio confirmed `google/gemma-4-26b-a4b` returns valid `tool_calls` when called with `tool_choice: "required"`
  - `openAiCompatService.isEndpointAlive` now sends auth on the `/models` preflight and treats `401/403` as reachable, which is required for auth-protected LM Studio servers; before this fix the app falsely marked LM Studio as unreachable and fell through to fallback providers
  - focused regression coverage:
    - `src/__tests__/openAiCompatService.test.ts`
    - `src/__tests__/remediationPlanService.test.ts`
  - provider-selection smoke after the fix:
    - `callWithOpenAiCompatFallbacks(..., preflightPrimary: true)` selected `primary`
    - base URL: `http://192.168.50.238:1234/v1`
    - model: `google/gemma-4-26b-a4b`
  - operational conclusion from live remediation logs: although Gemma 4 could return simple tool calls, it frequently truncated the real `propose_semantic_repairs` tool payload under remediation load, causing LM Studio to drop the tool call and the batch to receive `tool_calls: []`
  - on 2026-04-12 the default primary provider was switched back to the LAN hotspot (`http://192.168.50.238:51824/v1`, `gpt-5.1-codex-mini`) for actual remediation runs; the paused `remediated-pdf-grading-sub80-rerun-v2` campaign should resume on that provider rather than Gemma 4
