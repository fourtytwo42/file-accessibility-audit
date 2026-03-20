# Remediation Progress

## Run Summary

- Status: In progress
- Branch: `pdf-fixing`
- Input folder: `Downloads/`
- Final output folder: `Mitigated/`
- Intermediate output folder: `MitigationAttempts/`
- Mantra: ABI — Always Be Improving

## Current Session Snapshot

- Active PDF: `2007 Annual Report Final.pdf`
- Latest attempt path: `MitigationAttempts/2007 Annual Report Final/attempt-013.pdf`
- Latest result summary: fresh annual-report rerun on the new convergence/finalization path finished at `50/F` with `veraPDF: failed`; latest completed: 2001-2020 SFS Full Year End Report-220520T19141184.pdf
- Latest validation source: Fresh API remediation rerun after PM2 restart
- Next action: Patch the authoritative final-validation blockers exposed by `attempt-013`: PDF/UA metadata identification, native heading hierarchy / unmatched veraPDF structure issues, and over-penalized visual-table detection before rerunning `2007 Annual Report Final.pdf`
- Next hypothesis: The new final `full_final + veraPDF` pass is now correctly surfacing latent standards failures that the older no-vera path hid, so the next wins are in standards-conformance repair and scoring-credit correctness rather than more intermediate-loop work
- API restart status: PM2 API restarted successfully at 2026-03-20T01:09Z before the fresh `attempt-013` rerun
- Build status: `pnpm --filter api build` passed on 2026-03-20T01:08Z; PM2 API restarted successfully afterward

## Current Concurrency

- Active parallel PDF jobs: 2 active
- CPU/memory notes: load 24%, memory 70%
- Last adjustment: current cap 2
- In-flight PDFs before restart: `2019 Illinois Methamphetamine Study-191218T21562198.pdf`, `2025FirearmProhibitorsReport-250626T19175938.pdf`

## Current Focus

- Active PDF: `2007 Annual Report Final.pdf`
- Current phase: System fix / rerun loop
- Immediate next step: Fix the final authoritative blockers still visible on `attempt-013` and rerun from `Downloads/`
- API restart/rerun confirmed for active file: Yes
- Rebuild required for active file: No
- Active remediation loop count: `2007 Annual Report Final.pdf=13`
- Next hypothesis: clear qpdf/local metadata identification and structural heading/read-order mismatches so the authoritative veraPDF-backed final analysis no longer collapses the score after local repairs

## Pending Files

- Default order: alphabetical unless reprioritized here.
- Remaining files: 986

## In Progress

- 2019 Illinois Methamphetamine Study-191218T21562198.pdf: state=remediating, score=--, grade=--, veraPDF=--, attempt=1, loop=1
- 2025FirearmProhibitorsReport-250626T19175938.pdf: state=analyzing, score=--, grade=--, veraPDF=--, attempt=1, loop=1

## Blockers

- 2006CHRIAuditReport.pdf: state=blocked, score=--, grade=--, veraPDF=failed, attempt=4, loop=4
- 2007 Annual Report Final.pdf: state=needs_fix, score=44, grade=F, veraPDF=failed, attempt=4, loop=4
- 2008 Annual Report.pdf: state=needs_fix, score=44, grade=F, veraPDF=failed, attempt=4, loop=4
- 2010 MV Annual Report.pdf: state=blocked, score=--, grade=--, veraPDF=--, attempt=3, loop=3
- 2011 MV Annual Report.pdf: state=blocked, score=--, grade=--, veraPDF=--, attempt=1, loop=1
- 2012_MV_Annual_Report.pdf: state=blocked, score=--, grade=--, veraPDF=--, attempt=1, loop=1
- 2013_MV_Annual_Report.pdf: state=needs_fix, score=59, grade=F, veraPDF=failed, attempt=1, loop=1
- 2014_Adult_Redeploy_Illinois_Annual_Report-20191211T18501178.pdf: state=needs_fix, score=64, grade=D, veraPDF=failed, attempt=1, loop=1
- 2014_CVPP_Reentry_Report-191011T20093121.pdf: state=needs_fix, score=64, grade=D, veraPDF=failed, attempt=1, loop=1
- 2014_MV_Annual_Report.pdf: state=needs_fix, score=58, grade=F, veraPDF=failed, attempt=1, loop=1
- 2015_Motor_Vehicle_Annual_Report.pdf: state=needs_fix, score=62, grade=D, veraPDF=failed, attempt=1, loop=1
- 2016_ICJIA_Victim_Needs_Assessment_Summary_Report-191011T20092564.pdf: state=needs_fix, score=93, grade=A, veraPDF=passed, attempt=1, loop=1
- 2016_Motor_Vehicle_Annual_Report.pdf: state=needs_fix, score=84, grade=B, veraPDF=passed, attempt=1, loop=1
- 2022 SFS Process Evaluation Report-230622T16355531.pdf: state=needs_fix, score=57, grade=F, veraPDF=failed, attempt=1, loop=1
- 2022 Victim Needs Assessment-230306T13210736.pdf: state=needs_fix, score=81, grade=B, veraPDF=failed, attempt=1, loop=1
- 2022 Victim Service Planning Research Report -230817T20035755.pdf: state=needs_fix, score=76, grade=C, veraPDF=failed, attempt=1, loop=1
- 2022_DVFR_Annual_Report_Final_a688e16b10_a00d65b63f.pdf: state=needs_fix, score=64, grade=D, veraPDF=failed, attempt=1, loop=1
- 2023 Deaths in Custody Annual Report-240216T22514713.pdf: state=needs_fix, score=56, grade=F, veraPDF=failed, attempt=1, loop=1
- 2024 Task Force on Missing and Murdered Chicago Women Annual Report_Final-250114T18393571.pdf: state=needs_fix, score=81, grade=B, veraPDF=failed, attempt=1, loop=1
- 2024_Domestic Violence Pretrial Working Group_Final_Report-241115T20303582.pdf: state=needs_fix, score=64, grade=D, veraPDF=failed, attempt=1, loop=1
- 2024_DVFRC_Annual_Report_4_15_f637ee1fcc_compressed-251217T14311834.pdf: state=needs_fix, score=78, grade=C, veraPDF=failed, attempt=1, loop=1

## Completed Files

- 2001-2020 SFS Full Year End Report-220520T19141184.pdf: state=done, score=100, grade=A, veraPDF=passed, attempt=2, loop=2

## Recent Events

- 2026-03-20T07:15:27Z System fix: annual-report hardening v1 now restores authoritative `veraPDF` on `full_final` analysis, broadens figure retagging from raster-only evidence to figure/vector evidence, promotes safe vector-backed `/Shape` and `/Normal` figure targets, softens visual-table penalties by distinguishing high-confidence untagged tables from advisory detections, and tightens legacy font escalation toward substitution/finalization after insufficient Unicode or CIDSet repair. Verified with `pnpm exec vitest run src/__tests__/veraPdfService.test.ts src/__tests__/pdfAnalyzer.test.ts src/__tests__/scorer.test.ts src/__tests__/remediationPlanService.test.ts src/__tests__/agentRemediationService.test.ts`, `pnpm exec vitest run src/__tests__/pdfRemediationTools.test.ts -t "allows vector-backed figure retagging without raster image evidence|retags a safe Shape figure candidate and restores alt text"`, and `pnpm exec tsc --noEmit`. API restart still pending after this code change.

- 2026-03-20T07:34:00Z System fix: the final remediated `full_final` analysis in `agentRemediationService` no longer forces `skipVeraPdf: true`, so fresh remediations will record live `veraPDF` results instead of `unavailable` on the latest stored remediated version. Also updated the startup log to reflect the real `veraPDF` behavior. Root cause was confirmed from PM2 logs during the failed `2010 MV Annual Report.pdf` rerun, which showed `analysisProfile:"full_final"` still executing with `skipVeraPdf:true`. Verified with `pnpm exec vitest run src/__tests__/pdfAnalyzer.test.ts src/__tests__/agentRemediationService.test.ts src/__tests__/veraPdfService.test.ts` and `pnpm exec tsc --noEmit`. Build completed with `pnpm --filter api build`, and PM2 restart completed successfully via `pm2 restart file-audit-api --update-env`; API is now online on PID `1566086`.

- 2026-03-20T07:45:00Z System direction change: veraPDF has been disabled again across the remediation pipeline, including `full_final` post-remediation analysis, so the app now relies entirely on local standards evidence instead of a live veraPDF subprocess. This reverts the temporary final-pass veraPDF re-enable and restores the intended deployment posture from `ANALYSIS.DEFAULT_SKIP_VERAPDF`. Verified with `pnpm exec vitest run src/__tests__/pdfAnalyzer.test.ts src/__tests__/agentRemediationService.test.ts src/__tests__/veraPdfService.test.ts` and `pnpm exec tsc --noEmit`. API rebuild/restart still pending after this code change.

- 2026-03-20T08:06:00Z Small-PDF loop fix: `juv probation.pdf` improved from `26/F` to `63/D` on the first API remediation pass, exposing a reusable no-vera convergence bug plus two scoring/detection mismatches. Patched stage acceptance so flat-score stages are still accepted when blocking local-standards findings improve, stopped inferring missing figure structure when real `/Figure` nodes already exist, and excluded decorative non-figure graphics from alt-text scoring. Verified with `pnpm exec vitest run src/__tests__/localStandardsService.test.ts src/__tests__/scorer.test.ts src/__tests__/agentRemediationService.test.ts` and `pnpm exec tsc --noEmit`. API rebuild/restart still pending before the next fresh rerun of `juv probation.pdf`.

- 2026-03-20T08:10:00Z Small-PDF loop fix: after the first no-vera scoring fix set, a fresh API rerun of `juv probation.pdf` improved from `63/D` to `82/B`. The remaining blocker family is now concentrated in `7` Type1 fonts still missing `/ToUnicode`. Added a new `qpdf` signal for `type1FontsMissingToUnicode` and updated failure-profile planning so `repair_type1_font_unicode_maps` is triggered from real Type1 evidence rather than only on `10+` page documents. Verified with `pnpm exec vitest run src/__tests__/qpdfParser.test.ts src/__tests__/failureProfileService.test.ts src/__tests__/localStandardsService.test.ts src/__tests__/scorer.test.ts src/__tests__/agentRemediationService.test.ts` and `pnpm exec tsc --noEmit`. API rebuild/restart still pending before the next fresh rerun of `juv probation.pdf`.

- 2026-03-20T06:12:00Z System fix: added PDF Classification v1 layered pipeline routing. The remediation loop now computes a rich document classification, derives classification-aware pipeline config, filters irrelevant tools/stages, tunes round/early-exit thresholds, reclassifies after OCR/bootstrap/font-substitution triggers, and keeps the existing reliability/playbook coarse classes aligned through shared classification mapping. Verified with `pnpm exec vitest run src/__tests__/pdfClassificationService.test.ts src/__tests__/remediationPlanService.test.ts src/__tests__/toolReliabilityService.test.ts src/__tests__/playbookService.test.ts src/__tests__/agentRemediationService.test.ts` and `pnpm exec tsc --noEmit`. API restart not yet performed after this code change.

- 2026-03-20T05:30:00Z System fix: added remediation convergence telemetry plus exact-match playbook learning and execution. The API now records per-tool outcomes in `audit.db`, weights deterministic planning by reliability, supports guarded 98+ early exit and net-benefit stage acceptance, stores exact-signature `playbook_entries`/`playbook_runs`, and tries validated/hardened playbooks before iterative replanning. Added admin inspection routes for `/api/playbooks` and `/api/playbooks/:id`. Verified with `pnpm exec tsc --noEmit` and `pnpm exec vitest run src/__tests__/playbookService.test.ts src/__tests__/playbooksRoutes.test.ts src/__tests__/remediationPlanService.test.ts src/__tests__/toolReliabilityService.test.ts src/__tests__/agentRemediationService.test.ts`. API restart not yet performed after this code change.

- 2026-03-20T01:16:00Z System fix: annual-report remediation now includes an explicit Acrobat ownership convergence pass, a final residual repair bundle for metadata/link/table cleanup, stronger link-annotation candidate remapping, relaxed small mixed-MCID split eligibility, and new structural convergence controls in `audit.config.ts`. Verified with `pnpm --filter api exec vitest run src/__tests__/agentRemediationService.test.ts src/__tests__/failureProfileService.test.ts src/__tests__/pdfRemediationTools.test.ts src/__tests__/config.test.ts`, `pnpm --filter api build`, PM2 API restart, and a fresh rerun to `MitigationAttempts/2007 Annual Report Final/attempt-013.pdf`. Runtime improved as intended: intermediate analyses now stayed in roughly `0.3s-0.6s`, and the full remediation completed in `188601ms` with `10` intermediate analyses, `25` light inspections, `5` deep inspections, and `3` rounds. Remaining blocker: the authoritative final pass now forces veraPDF and exposes much larger standards debt than the prior no-vera score showed, so `attempt-013.pdf` finished at `50/F` with `veraPDF failed`, `33` remaining Acrobat alternate-text risks, `47` visually detected untagged tables, `pdfua.metadata_identification`, `pdfua.document_language`, and `pdfua.logical_structure` still unresolved.

- 2026-03-20T00:16:05Z System fix: wrapped `/TBody` table structures are now recognized by both table candidate discovery and `set_table_header_cells`, and Acrobat-risk container detection now recognizes child struct elements exposed via `/S` tags rather than requiring `/Type /StructElem`. The Acrobat-risk repair cap was also lifted from 12 repairs per run to a document-sized batch. Verified with `pnpm --filter api build`, direct backend checks on `MitigationAttempts/2007 Annual Report Final/attempt-007.pdf` showing `set_table_header_cells` now applies on formerly no-effect table refs and `repair_other_elements_alt_text` now applies 25 changes instead of 12, followed by fresh PM2 API restarts and reruns through `attempt-008.pdf`. Remaining blocker: latest rerun still finishes at `56/F` with Acrobat alt-risk nodes still reported at `46`, so the unsplittable mixed text/graphics ownership family remains unresolved.

- 2026-03-19T22:43:30Z API default changed: veraPDF is now skipped by default for standard analysis requests via `ANALYSIS.DEFAULT_SKIP_VERAPDF`, with `DEFAULT_SKIP_VERAPDF=false` available as an environment override to restore the old behavior. Verified with `pnpm --filter api exec tsc --noEmit`, `pnpm --filter api build`, `pm2 restart file-audit-api --update-env`, and a smoke analysis of `ADAM2.pdf` showing `veraStatus: unavailable` on a default `analyzePDF(...)` call.
- 2026-03-19T22:34:30Z API restart: `pm2 restart file-audit-api` completed after the stage-4 parity detector/scoring update; new API process is online for fresh no-vera parity validation.
- 2026-03-19T22:33:30Z System fix: stage-4 no-vera parity layer now detects role-mapped `/Note` tags missing `/ID`, uses object-graph CIDSet inspection for embedded CID fonts, infers artifact-mixing logical-structure failures from structure snapshots, and applies a stricter overall no-vera cap for severe structure-plus-CIDSet cases. Verified with `pnpm --filter api exec vitest run src/__tests__/qpdfParser.test.ts src/__tests__/localStandardsService.test.ts src/__tests__/failureProfileService.test.ts src/__tests__/scorer.test.ts`, `pnpm --filter api exec tsc --noEmit`, `pnpm --filter api build`, targeted parity rerun of the 3 previously failing `Downloads/` sample files (`3/3` parity passes), and the full second 10-file small-PDF `Downloads/` sample (`10/10` parity passes).
- 2026-03-19T21:31:00Z API restart: `pm2 restart file-audit-api` completed after the figure/image-structure logical-coverage detector update; new API process is online for fresh no-vera parity validation.
- 2026-03-19T21:30:00Z System fix: local standards now infer `pdfua.logical_structure` when tagged PDFs expose figure candidates but no image structure nodes, which closed the remaining no-vera miss on `Prescription_drugs_062011.pdf`. Verified with `pnpm --filter api exec vitest run src/__tests__/localStandardsService.test.ts src/__tests__/failureProfileService.test.ts src/__tests__/scorer.test.ts`, `pnpm --filter api build`, targeted parity rerun for `Prescription_drugs_062011.pdf`, and a one-file-at-a-time random 10-file small-PDF `Downloads/` sample (`10/10` parity passes).
- 2026-03-19T20:42:00Z API restart: `pm2 restart file-audit-api` completed after the stage-3 parity detector changes; new process came online successfully before post-change deployment validation.
- 2026-03-19T20:41:05Z System fix: stage-3 no-vera parity layer now detects CIDSet consistency locally, treats non-canonical language tags as document-language failures, and infers logical-structure failures when tagged documents expose only shallow semantic coverage. Verified with `pnpm --filter api exec vitest run src/__tests__/localStandardsService.test.ts src/__tests__/qpdfParser.test.ts src/__tests__/failureProfileService.test.ts src/__tests__/scorer.test.ts`, `pnpm --filter api build`, targeted parity rerun for the 4 previously failing files, and full `Processed/Before` parity sweep saved to `MitigationAttempts/full-before-verapdf-parity-report-2026-03-19.stage3.cleaned.json` (`30/30` parity passes).
- 2026-03-19T19:57:00Z System fix: stage-2 no-vera parity layer now detects page tabs, link annotation /Contents, link tagging, and legacy font-width risk locally; provisional no-vera PDF/UA scoring was tightened for structurally broken documents. Verified with `pnpm --filter api exec vitest run src/__tests__/localStandardsService.test.ts src/__tests__/qpdfParser.test.ts src/__tests__/failureProfileService.test.ts src/__tests__/scorer.test.ts`, `pnpm --filter api build`, and full baseline parity harness `pnpm --filter api exec tsx src/scripts/compareVeraPdfCoverage.ts` (10/10 baseline files now pass parity).
- 2026-03-19T18:51:00Z System fix: intermediate remediation re-analysis now reuses the last known veraPDF result and defers a real veraPDF CLI run to the final post-remediation analysis; verified with `pnpm --filter api exec vitest run src/__tests__/agentRemediationService.test.ts` and `pnpm --filter api build`
- 2026-03-19T07:51:26Z System fix: orphaned empty /Figure alt text now scores as unresolved Acrobat risk and is auto-repaired by stripping orphaned /Alt; verified with `pnpm --filter api build`, `vitest` on qpdf parser/scorer, and targeted Acrobat-risk service tests
- 2026-03-19T07:40:51Z System fix verification complete: API build passed, remediation service tests passed, snapshot optimization updates committed for restart-ready validation
- 2026-03-18T11:07:32.180Z Needs fix: 2022 SFS Process Evaluation Report-230622T16355531.pdf: Unmatched PDF/UA failures | score 57 | grade F
- 2026-03-18T11:27:04.571Z Upload started: 2022 Victim Service Planning Research Report -230817T20035755.pdf
- 2026-03-18T11:27:05.359Z Needs fix: 2022 Victim Needs Assessment-230306T13210736.pdf: Link structure tagging | score 81 | grade B
- 2026-03-18T11:31:01.695Z Upload started: 2022_DVFR_Annual_Report_Final_a688e16b10_a00d65b63f.pdf
- 2026-03-18T11:31:02.252Z Needs fix: 2022 Victim Service Planning Research Report -230817T20035755.pdf: Figure candidates need semantic or manual review | score 76 | grade C
- 2026-03-18T11:51:30.409Z Upload started: 2023 Deaths in Custody Annual Report-240216T22514713.pdf
- 2026-03-18T11:51:31.272Z Needs fix: 2022_DVFR_Annual_Report_Final_a688e16b10_a00d65b63f.pdf: Logical structure and marked content | score 64 | grade D
- 2026-03-18T13:13:32.518Z Upload started: 2024 Task Force on Missing and Murdered Chicago Women Annual Report_Final-250114T18393571.pdf
- 2026-03-18T13:13:33.174Z Needs fix: 2023 Deaths in Custody Annual Report-240216T22514713.pdf: Unmatched PDF/UA failures | score 56 | grade F
- 2026-03-18T13:14:38.559Z Upload started: 2024_Domestic Violence Pretrial Working Group_Final_Report-241115T20303582.pdf
- 2026-03-18T13:14:39.096Z Needs fix: 2024 Task Force on Missing and Murdered Chicago Women Annual Report_Final-250114T18393571.pdf: Unmatched PDF/UA failures | score 81 | grade B
- 2026-03-18T14:03:14.389Z Upload started: 2024_DVFRC_Annual_Report_4_15_f637ee1fcc_compressed-251217T14311834.pdf
- 2026-03-18T14:03:15.610Z Needs fix: 2024_Domestic Violence Pretrial Working Group_Final_Report-241115T20303582.pdf: Logical structure and marked content | score 64 | grade D
- 2026-03-18T14:04:10.964Z Upload started: 2025FirearmProhibitorsReport-250626T19175938.pdf
- 2026-03-18T14:04:11.324Z Needs fix: 2024_DVFRC_Annual_Report_4_15_f637ee1fcc_compressed-251217T14311834.pdf: Font embedding | score 78 | grade C

## Notes

- This file is orchestrator-managed and updated continuously during unattended runs.
- Use `MitigationAttempts/orchestrator-state.json` for the full machine-readable campaign state.

## Current Session Snapshot

- Active file: `2025FirearmProhibitorsReport-250626T19175938.pdf`
- Active loop: `4`
- Latest attempt queue item: `7ce83422-8014-4a01-ab12-0377b529ca8b`
- Latest remediated result: `79/C` after fresh rerun with veraPDF intentionally disabled
- Latest attempt artifact: `/tmp/pdfaf-small-loop/firearm-prohibitors-run4.json`
- Restart status: pending after the latest semantic figure-eligibility fix

## Current Focus

- Rerun `2025FirearmProhibitorsReport-250626T19175938.pdf` after widening semantic figure eligibility so AI can act on the real text-heavy image backlog.

## Retry Checkpoint

- Loop 1: `26/F -> 63/D`
- Loop 2: `63/D -> 82/B`
- Loop 3: `82/B -> 88/B`
- Loop 4: `88/B -> 100/A`
- Confirmed hypothesis: the final remaining font-unicode blocker was a generic legacy Distiller/PageMaker subset-glyph naming pattern (`/Differences [1 /G8b]`) that the Type1 Unicode repair path needed to decode.
- New loop 2 baseline: `2025FirearmProhibitorsReport-250626T19175938.pdf` improved only to `76/C`; first diagnosis shows false-positive link `/Contents` and descendant-font Unicode findings mixed with a real figure-retagging backlog.
- Loop 2 rerun after detector cleanup: `76/C -> 79/C`; detector issues were real but not dominant, and the remaining score gap is now clearly concentrated in image/figure remediation.
- New hypothesis: strong image-backed `/P` candidates were being incorrectly held back by a `pageImageCount` gate even after they already had strong figure evidence; promoting those candidates should materially raise the `alt_text` category on rerun.
- Updated hypothesis: figure promotion alone is insufficient because the document is still routed through `heuristic_only` semantic cleanup; the broader fix is to stop classifying semantically weak documents as `well_tagged`.
- Latest hypothesis: even with `full_ai` enabled, the semantic stage was still blind to most of the backlog because it excluded deferred `text_heavy_candidate` figures from batching. The next rerun should tell us whether widening that AI eligibility finally moves the `alt_text` score.

## Recent Events

- 2026-03-20T08:37:00Z Small-PDF loop fix: semantic AI can now review strong-evidence deferred figure candidates whose only blocker is the conservative `text_heavy_candidate` gate, and semantic-AI-generated figure actions may override that single defer reason during execution. Verified with `pnpm --filter api exec vitest run src/__tests__/pdfRemediationTools.test.ts src/__tests__/agentRemediationService.test.ts -t 'allows semantic AI to override text-heavy defer for strong figure evidence|promotes strong image-backed paragraph figure candidates in recent tagged reports|still runs semantic AI for eligible figures even when semantic categories are complete'` and `pnpm --filter api exec tsc --noEmit`. API rebuild/restart still pending before the next fresh rerun of `2025FirearmProhibitorsReport-250626T19175938.pdf`.
- 2026-03-20T08:31:00Z Small-PDF loop fix: `well_tagged` classification now requires semantic-heavy categories to already be healthy, so documents with deep structure but poor alt text/link/table semantics stay in `native_tagged` and continue using `full_ai` semantic routing. Verified with `pnpm --filter api exec vitest run src/__tests__/pdfClassificationService.test.ts src/__tests__/agentRemediationService.test.ts -t 'classifies structural states including well-tagged documents|uses heuristic-only semantic routing for well-tagged figure cleanup without calling AI enrichment'` and `pnpm --filter api exec tsc --noEmit`. API rebuild/restart still pending before the next fresh rerun of `2025FirearmProhibitorsReport-250626T19175938.pdf`.
- 2026-03-20T08:26:00Z Small-PDF loop fix: safe figure-retagging no longer requires `pageImageCount > 0` once a candidate already has `strong` or `vector` figure evidence. Added a regression on `2025FirearmProhibitorsReport-250626T19175938.pdf` proving a strong image-backed `/P` candidate is promoted to `retag_then_set_alt`. Verified with `pnpm --filter api exec vitest run src/__tests__/pdfRemediationTools.test.ts -t 'promotes strong image-backed paragraph figure candidates in recent tagged reports|repairs legacy Gxx subset glyph names in small Distiller PDFs'` and `pnpm --filter api exec tsc --noEmit`. API rebuild/restart still pending before the next fresh rerun of `2025FirearmProhibitorsReport-250626T19175938.pdf`.
- 2026-03-20T08:24:52Z Fresh post-restart rerun: `2025FirearmProhibitorsReport-250626T19175938.pdf` completed on queue item `60fb95a3-e9a8-47b8-b585-6ef70bcac866` at `79/C`. This confirms the local-standards detector cleanup helped, but the file remains primarily blocked by real figure/alt-text remediation debt rather than parser noise.
- 2026-03-20T08:23:00Z Small-PDF loop fix: local standards now trust `qpdf` as the source of truth for link annotation `/Contents` when `qpdf` detected link annotations, avoiding false `annotation_alt_contents` findings from `pdfjs`'s null link-contents field. `qpdfService` also no longer double-counts descendant CID fonts as standalone fonts when the Type0 parent already owns the family, preventing false `font_unicode` findings from descendant-only objects. Verified with `pnpm --filter api exec vitest run src/__tests__/qpdfParser.test.ts src/__tests__/localStandardsService.test.ts` and `pnpm --filter api exec tsc --noEmit`. API rebuild/restart still pending before the next fresh rerun of `2025FirearmProhibitorsReport-250626T19175938.pdf`.
- 2026-03-20T08:17:00Z Fresh post-restart rerun: `juv probation.pdf` completed on queue item `c361f9ca-0829-4195-991e-b8f2cd3a66ce` at `100/A` after the Type1 `Gxx` subset-glyph decoder fix. This confirms the small-PDF loop fix closed the final font-unicode blocker for this Distiller/PageMaker family.
- 2026-03-20T08:18:00Z Small-PDF loop fix: the Type1 Unicode repair path now decodes legacy subset glyph names in `Gxx` hexadecimal form when deriving `/ToUnicode` maps, covering the remaining one-byte custom-encoding blocker in `juv probation.pdf`. Added a regression test on `Downloads/juv probation.pdf` to verify `repair_type1_font_unicode_maps` reduces the missing Type1 Unicode count for this small Distiller/PageMaker pattern. Verified with `pnpm --filter api exec vitest run src/__tests__/pdfRemediationTools.test.ts -t 'repairs legacy Gxx subset glyph names in small Distiller PDFs|repairs derivable Type1 ToUnicode maps on annual-report PDFs'` and `pnpm --filter api exec tsc --noEmit`. API rebuild/restart still pending before the next fresh rerun of `juv probation.pdf`.
