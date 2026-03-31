# Project Memory

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
