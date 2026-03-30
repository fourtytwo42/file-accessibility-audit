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

- If a lasting fact changes, update this file.
- If a mistake is discovered and corrected, record it here.
- If a workflow decision is proven in practice, record it here.
- If a file or publication should be skipped later, record it here.
