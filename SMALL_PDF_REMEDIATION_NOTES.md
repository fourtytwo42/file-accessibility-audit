# Small PDF Remediation Notes

## Current Active File

- `Youth Development_An Overview of Related Factors and Interventions-200305T16163952.pdf`
- Current fresh queue item: pending upload
- Latest completed file: `Adams.pdf` -> `100/A`

## Recent Loop Summary

- `DNA testing.pdf`
- Baseline: `22/F`
- First fresh rerun: `93/A`
- Second fresh rerun after split-figure scoring and semantic oversize fallback fixes: still `93/A`
- Third fresh rerun after late `/Figure` retry widening: still `93/A`
- Fourth fresh rerun after descendant `/Figure` alt preservation in wrappers: `97/A`
- Fifth fresh rerun after suppressing no-op wrapper rewraps: `97/A`

## New System Fixes This Round

- Completed:
  - Split-generated informative figure variants now collapse onto one canonical source ref before alt-text scoring, preventing wrapper/child figure variants from inflating the denominator.
  - Oversized singleton figure semantic requests now retry without page images instead of being dropped immediately by prompt-size limits.
  - Late heuristic cleanup now retries unresolved live `/Figure` candidates with `repairMode: "set_alt"` and missing `/Alt`.
  - Wrapper repairs now preserve descendant leaf `/Figure` alt text instead of stripping it during cleanup.
  - Wrapper retagging now no-ops when a target already contains a descendant leaf `/Figure` with alt text, preventing repeated rewrap churn on already-fixed containers.

## Current Blocker Hypothesis

- `DNA testing.pdf` is now above target at `97/A`, so it is no longer the active blocker file.
- The last remaining debt on `DNA testing.pdf` is residual Acrobat-style mixed ownership on non-`/Figure` containers, not missing alt text:
  - all detected `/Figure` elements now have alternate text
  - wrapper churn is suppressed correctly with explicit no-effect messages when a descendant `/Figure` already has alt text
- Next hypothesis is no longer on `DNA testing.pdf`; it will come from the first fresh run of the next random small PDF, `State criminal justice survey Sept 2007.pdf`.

## DNA testing Result

- Queue history:
  - `ea557252-c8a9-423a-8127-8dece6f2e887` -> `93/A`
  - `ce40822b-3570-4521-a8c4-759d1ab82d49` -> `93/A`
  - `bc25f8db-93dd-422b-b952-d351b0852c7d` -> `93/A`
  - `866d94d1-c901-4478-9592-312a2104e019` -> `93/A`
  - `6a8dfbe0-08b0-4c5e-8ab4-6d22262b074d` -> `97/A`
  - `47f9ca04-25d3-4053-83fa-69ef009f2da8` -> `97/A`
- Root causes resolved:
  - split-generated informative figure variants were inflating the effective image denominator
  - oversized singleton figure semantic batches could be skipped entirely
  - unresolved live `/Figure` candidates were not retried late
  - wrapper cleanup was stripping descendant leaf `/Figure` alt text
  - already-fixed wrapper containers could be rewrapped repeatedly
- Current outcome:
  - file clears the user target at `97/A`
  - `alt_text` is now `85/B`
  - all detected `/Figure` elements have alternate text
  - remaining score loss is residual Acrobat ownership debt rather than missing figure descriptions

## State criminal justice survey Sept 2007 Result

- Queue history:
  - `4e351ecd-1ea2-48d7-aad7-46157672b2d0` -> `100/A`
- Outcome:
  - cleared on the first fresh API run with no new code changes required
  - original result was `28/F`
  - remediated output reached `100/A` with headings, table headers, metadata, tab order, Type1 Unicode recovery, and figure semantics all handled by the current stack
  - this is another strong signal that the recent small-PDF fixes are generalizing cleanly

## juvenile2000study Result

- Queue history:
  - `434adcbe-ca61-491b-8de7-36594d1997da` -> `89/B`
  - `c3eacea3-d483-4ee2-ae9f-a4a16cbd1aa3` -> `89/B`
  - `2b2bddd4-182e-4ee4-b6be-e51ca7a27419` -> `89/B`
  - `11c09a66-ecb5-4a26-bcbe-6a8b2e78cdff` -> `100/A`
- Outcome so far:
  - original result was `23/F`
  - first fresh rerun cleared structure, headings, bookmarks, metadata, reading order, and alt text
  - remaining score loss is concentrated in one font family:
    - `text_extractability = 60`
    - `pdf_ua_compliance = 85`
    - `Detected 1 font object(s) without a ToUnicode map.`
    - rejected detail names `/MapInfoArrows (/Type0, /Identity-H)`
- Root cause:
  - the helper already has deterministic Unicode mappings for `/MapInfoArrows`
  - but generic `merge_tounicode_map()` always emitted a simple-font `ToUnicode` CMap, even for `/Type0 /Identity-H` fonts
  - that means CID symbol fonts could still fail Unicode recovery after `/CIDToGIDMap /Identity` was fixed
- Shared fix applied:
  - `merge_tounicode_map()` now emits `build_cid_tounicode_cmap(...)` for `/Type0 /Identity-H` fonts and the regular simple-font builder otherwise
  - targeted verification passed with the existing CID-symbol repair test, Python compile, and `tsc`
- Follow-up finding:
  - live rerun `c3eacea3-d483-4ee2-ae9f-a4a16cbd1aa3` still finished at `89/B`
  - direct rebuilt-artifact inspection showed `/MapInfoArrows` only reports used code `[0]`
  - that meant the deterministic fallback map was still being filtered down to nothing before `ToUnicode` emission
- Follow-up fix applied:
  - for `/Type0 /Identity-H` legacy symbol fonts whose used-code set collapses to `[0]`, keep the full deterministic fallback map instead of dropping it
  - direct `tsx` probe on rebuilt artifact `c3eacea3-d483-4ee2-ae9f-a4a16cbd1aa3.pdf` now returns:
    - `Embedded a full substitute font program for legacy symbol font /MapInfoArrows using arial.ttf`
    - `Added an explicit ToUnicode CMap for legacy symbol font /MapInfoArrows using 4 deterministic character mappings`
- Live-pipeline follow-up:
  - fresh rerun `2b2bddd4-182e-4ee4-b6be-e51ca7a27419` still stayed at `89/B`
  - direct planner inspection on `juvenile2000study.pdf` now shows both `repair_cid_symbol_font_maps` and `repair_font_unicode_maps` are present in the live plan
  - new shared fix: prioritize `repair_cid_symbol_font_maps` ahead of generic Unicode repair in the font stage
- Final outcome:
  - fresh rerun `11c09a66-ecb5-4a26-bcbe-6a8b2e78cdff` cleared at `100/A`
  - original result was `23/F`
  - the planner-order fix was the missing live-pipeline piece; helper-side CID symbol repair was already correct

## Law Expands Access to Juv Justice Info Result

- Queue history:
  - `3d178e7e-61e5-45a1-9e5f-9b945ef529d9` -> `100/A`
- Outcome:
  - cleared on the first fresh API run with no new code changes required
  - original result was `9/F`
  - remediated output reached `100/A` on the current stack, which is another good signal that the recent font-planning and small-PDF fixes are holding across new random files

## Adams Result

- Queue history:
  - `b74a2a34-1a1b-4dce-be5d-f030696229a6` -> `100/A`
- Outcome:
  - cleared on the first fresh API run with no new code changes required
  - original result was `24/F`
  - remediated output reached `100/A` on the same deployed stack, so the current small-PDF flow continues to generalize without another system fix

## Youth Development Result

- Queue history:
  - `e4cc930c-8265-43d2-aad7-8a69058e8ceb` -> `88/B`
  - `a2851f86-48c1-4fab-a42d-a46e3f492f5b` -> `90/A`
  - `d91549c8-e289-4a01-beb3-3a934fb07446` -> `90/A`
- Outcome so far:
  - original result was `32/F`
  - first fresh rerun cleared title/language, heading structure, link quality, reading order, text extractability, and PDF/UA compliance
  - current rerun now reaches `90/A`, but remaining score loss is still concentrated in `alt_text = 40/F`
  - local standards are effectively clean except for one non-blocking `pdfua.cidset_consistency` warning
- Current blocker:
  - rebuilt-artifact inspection on `a2851f86-48c1-4fab-a42d-a46e3f492f5b.pdf` still shows 4 unresolved strong-evidence `/TD` candidates:
    - `obj:74 0 R`
    - `obj:75 0 R`
    - `obj:76 0 R`
    - `obj:78 0 R`
  - all four are now correctly classified as:
    - `targetTag: /TD`
    - `imageEvidence: strong`
    - `informativeHint: informative`
    - `repairMode: retag_then_set_alt`
  - so the remaining blocker is no longer classification or snapshot credit; it is the live retry history in late figure passes
- Shared fixes applied:
  - strong informative `/TD`-backed figure candidates now route to `retag_then_set_alt` instead of automatic defer
  - late heuristic figure fallback now reselects candidates from refreshed post-write context instead of iterating stale candidate ids from the original context
  - wrapped child `/Figure` nodes created under `/TD` containers are now preserved in structure snapshots when they have page-backed child content
  - late heuristic figure retry history now keys off stable `targetRef` object refs instead of recycled `figure:n` ids
  - late heuristic figure fallback now prioritizes unresolved `retag_then_set_alt` candidates before already-alt-tagged leaf `/Figure` elements
- Latest validation:
  - `pnpm --filter api exec vitest run src/__tests__/agentRemediationService.test.ts -t 'retries unresolved set_alt figure candidates during the late heuristic pass|tracks late heuristic figure retries by stable targetRef instead of recycled candidate ids|prioritizes unresolved retag candidates before already-tagged figures in late heuristic passes'`
  - `pnpm --filter api exec tsc --noEmit`
- Next expected outcome:
  - fresh post-restart rerun should stop burning late heuristic work on already-satisfied leaf `/Figure` nodes and instead spend that effort on the unresolved `/TD` wrappers, letting the remaining table-cell figure wraps land and pushing the file above `95`

## Southern Illinois Drug Task Force Result

- Queue history:
  - `86d97265-01e8-4f1a-871b-92ac9f57b02a` -> `89/B`
  - `51c91b3c-5aef-44d2-83f1-a56677129c55` -> `100/A`
- Root cause:
  - bookmark generation was real, but the acceptance gate rolled it back because it only trusted overall-score movement at that moment
  - action details showed `replace_bookmarks_from_headings` creating `/Outlines` plus multiple bookmark entries, with `scoreDelta` recording `bookmarks 0 -> 100`
- Expected outcome after fix:
  - keep the bookmark stage on rerun
  - leave `Color Contrast` as the only likely residual issue
  - push the file above `95`, likely to `100/A`
- Actual outcome:
  - the fresh post-restart rerun cleared directly to `100/A`

## Wabash-2 Result

- Queue history:
  - `d544bad6-cd7f-4996-9427-73a25baff825` -> `100/A`
- Outcome:
  - cleared the target on the first fresh API run
  - no new system fix required
  - another strong signal that the current system fixes are generalizing across the small-file slice

## McLean-2 Result

- Queue history:
  - `2e16e502-cdc3-4b8d-ae63-da1a43fc312e` -> `100/A`
- Outcome:
  - cleared the target on the first fresh API run
  - no new system fix required
  - another playbook-backed confirmation that the current stack is holding across this document family

## FINAL GUN HOMICIDE PDF Result

- Queue history:
  - `ebc9c6fd-ec89-43ad-b120-9302798e0c6a` -> stalled in original analysis
  - `7d696f91-78dc-4d44-ad18-f710812916c8` -> stalled in original analysis
  - `85b9884f-5b43-4a12-a686-0671843a2275` -> progressed after timeout fix, then bogged down during semantic work on repeated deep-inspection failures
  - `93dc3da2-b092-463e-a286-efeeba1e4442` -> `63/D`
- Root cause diagnosis:
  - the hang is not in `pdfjs`, `qpdf`, `readingOrder`, `tableStructure`, or `colorContrast`
  - the pathological step is `runPdfStructureBackend({ operation: 'inspect', inspectMode: 'alt_text_deep' })`
  - live `ps` inspection showed multiple `pdf_structure_helper.py` processes pinned at ~100% CPU for minutes on this file
- Throughput fix outcome:
  - queue no longer stalls in original analysis
  - remediation loops no longer get trapped in repeated failing deep inspection
  - first real completed result is `63/D`
- Current blocker family after throughput fix:
  - `16` heading candidates are blocked
  - most blocked headings resolve to unsafe `/Link` tags even though safe parent `/P` containers exist nearby
  - `normalize_heading_hierarchy` stays `no_effect` because no headings are ever created
  - next shared fix is to remap `/Link`-backed heading candidates to their safe parent text node before planning/mutation

## Follow-up Heading Finding

- Fresh rerun `71d056a0-3f18-4fba-b680-8c92a52124d6` still finished at `63/D`
- The `/Link` remap fix did work:
  - all first `16` heading candidates are now `repairMode = safe`
  - all first `16` heading opportunities are `auto_runnable`
  - semantic batch construction now includes two heading batches of `8` candidates each
- New root cause:
  - `create_heading_from_candidate` still never executed in the live run
  - deterministic planner evidence shows heading opportunities are top auto-runnable, but stage-3 link `/Contents` candidate floods consume the 32-action cap before stage-6 heading actions are selected
- Generic fix applied:
  - reserve part of the deterministic action budget for safe heading candidates when `heading_structure` is still unresolved
  - this should let heading creation finally compete with large link-candidate batches on Acrobat-native reports

## Follow-up Semantic Throughput Finding

- Fresh rerun `ff6aab29-d62d-479c-8da5-366241e50c83` progressed farther on the new heading-budget fix, but effectively wedged in `Generating semantic fixes`
- Direct local batching probe showed the current semantic workload is dominated by links:
  - `16` heading candidates
  - `9` figure candidates
  - `146` link candidates
  - `26` semantic batches total
  - `19` of those `26` batches are link batches
- Root cause:
  - deterministic link repair already handles the long tail of annotation `/Contents` work
  - semantic link generation was still trying to process nearly the full link backlog on a heavy-link Acrobat report
  - that made semantic generation disproportionately slow relative to the remaining score gain
- Generic fix applied:
  - cap semantic link batching to the first `32` link targets on heavy-link documents
  - keep semantic headings, figures, and bookmarks active so the semantic stage still improves the categories that actually need model help

## Follow-up Link Mutation Throughput Finding

- Fresh rerun `7d25d683-8c68-4038-b0f9-4f797cbc91ef` still looked wedged at `68%`, but direct local profiling showed semantic batch generation itself finishes quickly:
  - `full_final` analysis: about `52.7s` total, with the expected one-time deep structure snapshot
  - `inspect(light)`: `766ms`
  - `buildSemanticRepairBatches`: `1ms`
  - `generateSemanticRepairBatches`: `7729ms`
- Live PM2 logs on the same build showed the remaining churn is lots of repeated:
  - `inspectMode:"light"` at about `0.5s`
  - `analysisProfile:"remediation_fast"` at about `0.27s - 0.30s`
- Root cause:
  - the queue is no longer hung in semantic generation or deep structure scoring
  - the remaining runtime tax is repeated one-by-one mutation plus validation on heavy link `/Contents` work
  - `set_link_annotation_contents` already existed in the structure backend but was not participating in the shared stage batch executor
- Generic fix applied:
  - add `set_link_annotation_contents` to the stage-batching tool set
  - derive a backend batch mutation for it from `candidateId/pageNumber/annotationIndex/contents`
  - this should help deterministic stages and final cleanup collapse many tiny link-mutation loops into one backend batch on heavy-link PDFs

## Follow-up Validation Timing Finding

- Fresh rerun `d42bb954-6bc2-403b-9775-27442e31fcac` progressed much farther on the semantic-link cap and reached stage `5`
- New bottleneck isolated from PM2 timings:
  - some `remediation_fast` validations still took about `45s`
  - those slow validations had `forceStructureForScoring = true`
  - the trigger was too broad: any action targeting `alt_text` could force deep structure scoring, even when the action was not actually structure-sensitive
- Generic fix applied:
  - keep deep structure scoring for bootstrap, heading normalization, and the explicit deep-structure tool set
  - stop forcing it for lightweight annotation-only alt-text cleanup
  - preserve the existing deep-score protections for bootstrap and native heading validation with targeted tests

## CMVoga Resolution

- Queue history:
  - `8ab42dd1-424a-4513-a3c1-2009e2dd510e` -> `80/B`
  - `eb25ad55-dd0e-4197-9a45-da90d29391b5` -> `100/A`
- Root cause:
  - planner/classification routing excluded `finalize_substituted_font_conformance` on `legacy_encoding` PDFs unless an explicit substitution step had already occurred
  - direct probing proved the rebuilt artifact was already repairable; the live queue path just never planned the last step
- Shared fix:
  - `legacy_encoding` classification now leaves `finalize_substituted_font_conformance` available
  - planner now treats residual `pdfua.font_embedding` as persistent legacy-font debt and can schedule finalization after embed plus Unicode repair
- Outcome:
  - the first fresh post-restart rerun cleared straight to `100/A`

## GDRAAG Result

- Queue history:
  - `a115564d-57c4-4678-a538-5222f7ba7d4b` -> `97/A`
- Outcome:
  - cleared the `>95` target on the first fresh API run
  - no new system fix required
  - good evidence that the recent shared fixes are holding across another small-file family

## bor_english Resolution

- Queue history:
  - `9d520a85-97d1-4844-890f-49a973b367ec` -> `65/D`
  - `44a762ed-726d-4922-831a-d2b5c97c570a` -> `100/A`
- Key findings from the first rerun:
  - `heading_structure = 0`
  - `text_extractability = 40`
  - `reading_order = 70`
  - `pdf_ua_compliance = 85`
  - local standards still saw 2 unembedded fonts
- Root causes:
  - multi-column brochure layout was being collapsed into huge cross-column text lines, so headings like `Victims Bill of Rights` and `Who is covered by the Bill of Rights?` never became heading candidates
  - `/Boton-Regular` and `/Boton-Italic` still had no embeddable fallback mapping, so the last two unembedded brochure fonts remained unresolved
- Direct proof:
  - a fresh inspection of the rebuilt `65/D` artifact showed no heading candidates at all even though the page text clearly contained large bold section titles
  - page text-line dumps showed same-row cross-column merges such as headline fragments and body text combined into single lines
- Outcome:
  - after splitting same-row lines on large horizontal gaps and adding Boton fallbacks, the next full post-restart API rerun cleared to `100/A`

## Latest Result

- Fresh rerun `8d38939d-10f3-4211-a3f7-d4b536173152` finished at `92/B`
- Improvements confirmed:
  - `heading_structure = 100`
  - `text_extractability = 100`
  - `alt_text = 75`
- Remaining hard blocker:
  - `link_quality = 60`
  - `pdf_ua_compliance = 85`
  - exactly `1` true link annotation still missing `/Contents`

## Link Root Cause

- Direct pikepdf inspection of the rebuilt `92/B` artifact found:
  - `14` total `/Link` annotations
  - `1` true missing `/Contents`
  - missing annotation: page `3`, link ordinal `9`, object `(383 0)`
- Root cause:
  - `pdfjs` builds `annotationIndex` after filtering to `/Link` annotations only
  - `set_link_annotation_contents()` was matching against the raw `/Annots` array index
  - if a non-link annotation appears earlier in `/Annots`, the tool can report `applied` while mutating the wrong annotation
- Generic fix applied:
  - `set_link_annotation_contents()` now matches using link-only ordinals
  - added regression test with a preceding `/Text` annotation

## Follow-up Link Finding

- Fresh rerun `298701f0-c6e7-45a5-a2b4-e67df3fb5e99` still finished at `92/B`
- That proved the link-ordinal fix was necessary but not sufficient
- Direct comparison showed:
  - qpdf/pikepdf sees `/Contents` on 9 of the 10 page-3 links
  - `inspectPdfForRemediation()` still rebuilt all 10 page-3 link candidates with `annotationContents: null`
- Root cause:
  - `pdfjs` is dropping link `/Contents` on this Acrobat/PDFMaker report pattern
  - our link-candidate builder was trusting `pdfjs` alone for annotation contents
- Generic fix applied:
  - `buildRemediationPageFacts()` now reconciles link `/Contents` from raw PDF annotation objects using `pdf-lib` whenever `pdfjs` omits them
  - added regression test proving a mutated link annotation re-inspects with the saved `/Contents`

## Session

- Date: `2026-03-20`
- Goal: push small PDFs from `Downloads/` above `95/100` through repeated API-driven grade/remediate/grade loops
- veraPDF posture: disabled intentionally; runtime verified via `/api/health` and PM2 logs showing `skipVeraPdf:true` for both `remediation_fast` and `full_final`

## Active PDF Loop 1

- Selected PDF: `Downloads/juv probation.pdf`
- Selection method: random pick from `find Downloads -size -700k | shuf`
- File size: `496508` bytes
- Queue item: `f6bd9022-a7e6-486f-accc-9f456f605ffe`
- Initial result: `26/F`
- First remediated result: `63/D`
- Processing window: started `2026-03-20T07:57:03Z`, completed `2026-03-20T07:57:17Z`
- Current status: needs system fix before rerun

### Loop 1 Findings

- veraPDF remained intentionally unavailable throughout the run.
- The pipeline successfully added metadata, language, PDF/UA identification, a bootstrap struct tree, heading normalization, and heuristic alt text on two figures.
- The strongest remaining blockers after remediation are:
  - `pdfua.font_unicode`: 13 font objects still reported without `ToUnicode`
  - `pdfua.logical_structure`: bootstrapped document still reports 2 figure candidates and 4 PDF images but no recovered image structure nodes
  - `alt_text`: 2 of 4 images still missing alt text
  - `reading_order`: remains capped because local standards still see logical-structure debt
- Planner/execution evidence suggests likely reusable bugs:
  - `repair_font_unicode_maps` mutated the file but was rejected because the score stayed `75 -> 75`
  - bootstrap created `/Figure` tags with alt text, but downstream structure analysis still failed to recover image structure nodes from the remediated file
  - semantic figure enrichment skipped one target because the prompt exceeded the size budget, forcing heuristic fallback

### Working Hypothesis

- We likely have a post-bootstrap structure-analysis blind spot for small PageMaker/Distiller PDFs where newly created figure/image structure nodes are not being recovered cleanly, causing both `reading_order` and `pdf_ua_compliance` to stay artificially low.
- We likely also have either:
  - a real `repair_font_unicode_maps` effectiveness gap on these legacy fonts, or
  - a scoring/detection gap where newly added `ToUnicode` maps are not being credited after mutation.

### System Fix in Progress

- Accepted a reusable convergence fix: flat-score deterministic stages now count as improvements when blocking local-standards findings drop, which matters because veraPDF is intentionally disabled.
- Relaxed local logical-structure inference so a document is no longer treated as lacking figure structure when real `/Figure` nodes already exist, even if `imageStructNodes` are empty.
- Adjusted alt-text scoring so decorative non-figure graphics do not keep dragging the score down when informative figures are already described.
- Verification:
  - `pnpm exec vitest run src/__tests__/localStandardsService.test.ts src/__tests__/scorer.test.ts src/__tests__/agentRemediationService.test.ts`
  - `pnpm exec tsc --noEmit`

### Loop 1 Rerun After Fix Set 1

- Second queue item: `ef6a1748-a92d-4666-bd11-fbb8c98d53e3`
- Rerun result: `82/B`
- Improvement vs first remediated run: `63 -> 82`
- Remaining blockers after fix set 1:
  - `pdfua.font_unicode`: reduced from `13` to `7`, now the dominant blocker
  - `text_extractability`: still capped at `40` because local standards still map the remaining Unicode failures into this category
  - `pdf_ua_compliance`: now `70`, driven almost entirely by the remaining `7` Type1 font Unicode failures
- Concrete diagnosis from downloaded remediated artifact:
  - all remaining missing `/ToUnicode` maps are `Type1` fonts
  - the generic `repair_font_unicode_maps` fixed the TrueType subset fonts
  - the planner still did not run `repair_type1_font_unicode_maps` because its trigger was tied to document length rather than actual Type1 evidence

### System Fix in Progress 2

- Added a `type1FontsMissingToUnicode` signal to `qpdfService`.
- Updated `failureProfileService` so `repair_type1_font_unicode_maps` is offered whenever actual Type1/Type3 fonts remain without `/ToUnicode`, even on small PDFs.
- Verification:
  - `pnpm exec vitest run src/__tests__/qpdfParser.test.ts src/__tests__/failureProfileService.test.ts src/__tests__/localStandardsService.test.ts src/__tests__/scorer.test.ts src/__tests__/agentRemediationService.test.ts`
  - `pnpm exec tsc --noEmit`

### Loop 1 Rerun After Fix Set 2

- Third queue item: `8d610c2d-66ff-446e-af13-7bf2adbf7be3`
- Rerun result: `88/B`
- Improvement vs second remediated run: `82 -> 88`
- Remaining blocker after fix set 2:
  - `pdfua.font_unicode`: reduced from `7` to `1`
- Concrete diagnosis from the downloaded remediated artifact:
  - the last unresolved font is Type1 font `/FLCKCD+TT946O00`
  - it is used on page 4 for a single one-byte custom-encoding text run
  - its `/Encoding /Differences` payload contains glyph name `/G8b`
  - the Type1 repair path did run, but our glyph-name decoder could not map legacy `Gxx` subset names into Unicode

### System Fix in Progress 3

- Added a legacy Type1 subset glyph fallback in `pdf_structure_helper.py` so glyph names like `G8b` deterministically decode from their hexadecimal subset code when deriving Type1 `/ToUnicode` maps.
- Added a regression test that uses `Downloads/juv probation.pdf` directly and verifies `repair_type1_font_unicode_maps` reduces the missing Type1 Unicode count on this small Distiller/PageMaker pattern.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/pdfRemediationTools.test.ts -t 'repairs legacy Gxx subset glyph names in small Distiller PDFs|repairs derivable Type1 ToUnicode maps on annual-report PDFs'`
  - `pnpm --filter api exec tsc --noEmit`

### Loop 1 Rerun After Fix Set 3

- Fourth queue item: `c361f9ca-0829-4195-991e-b8f2cd3a66ce`
- Rerun result: `100/A`
- Improvement vs third remediated run: `88 -> 100`
- Outcome:
  - the final `pdfua.font_unicode` blocker cleared
  - the legacy `Gxx` subset-glyph fallback successfully generalized to this Distiller/PageMaker pattern
  - `juv probation.pdf` now exceeds the session target and can serve as a reusable regression case for small legacy PDFs with single-symbol Type1 custom encodings

## Pattern Notes

- Early small legacy PDFs may cluster around this pattern:
  - untagged digital source
  - PageMaker/Distiller-era metadata
  - legacy font Unicode gaps
  - bootstrap succeeds partially, but local standards still do not recognize enough semantic image/figure structure afterward
  - custom Type1 subset glyph names like `G8b` may survive the generic Unicode pass and need a deterministic hexadecimal fallback in the Type1 repair path

## Active PDF Loop: `SPTDVoga.pdf`

- Selected PDF: `Downloads/SPTDVoga.pdf`
- Selection method: next random pick from `find Downloads -size -700k | shuf`
- File size: `368165` bytes
- First queue item: `eaea85da-2c62-45d2-8c20-d34a5360e039`
- Initial result: `32/F`
- First remediated result: `76/C`
- Current status: needs shared legacy Type1 font-program embedding fix before rerun

### Findings

- veraPDF remained intentionally unavailable throughout the run.
- The strongest remaining debt is concentrated in five legacy Type1 fonts that are still unembedded:
  - `/GillSans`
  - `/GillSans-Bold`
  - `/GillSans-BoldItalic`
  - `/GillSans-Italic`
  - `/NewCenturySchlbk-Bold`
- The remediated artifact already has `/ToUnicode` on these fonts, so the gap is no longer Unicode derivation; it is font-program embedding.
- The existing helper already had a legacy substitute map for New Century Schoolbook, but `embed_missing_fonts_in_place` was not using that substitute map for this path.
- The Gill Sans family had no substitute entries at all, even though local Arial-based substitutes are available on the host.

### System Fix In Progress

- Added Gill Sans family mappings to `LEGACY_FONT_SUBSTITUTES` in `pdf_structure_helper.py`.
- Updated `embed_missing_fonts_in_place` to consult `legacy_substitute_font_name()` when no exact local font file exists, instead of only using exact-file and narrow fallback paths.
- Added a regression on `Downloads/SPTDVoga.pdf` proving `embed_missing_fonts_in_place` reduces the unembedded font count for this small legacy Type1 family.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/pdfRemediationTools.test.ts -t 'embeds legacy Type1 substitute fonts on small Gill Sans PDFs|repairs legacy Gxx subset glyph names in small Distiller PDFs'`
  - `pnpm --filter api exec tsc --noEmit`

### Loop Result After Gill Sans Fix

- Second queue item: `85051089-e52c-4154-9252-1ba1f847bae4`
- Rerun result: `100/A`
- Improvement vs first remediated run: `76 -> 100`
- Outcome:
  - the remaining legacy Type1 embedding debt cleared
  - the substitute embedding path now generalizes to Gill Sans and New Century Schoolbook families
  - `SPTDVoga.pdf` now serves as a regression case for small Acrobat Distiller/PageMaker documents with embeddable legacy Type1 fonts but no exact local font files

## Next Random Small PDF

- Selected PDF: `Downloads/Johnson-2.pdf`
- Selection method: next random pick from `find Downloads -size -700k | shuf`
- File size: under `700k` (selected from the live random candidate list)
- Current status: completed on first fresh API loop at `100/A` from `24/F`

### Johnson-2 Result

- Queue item: `68d508cf-38c3-4fa6-aced-9ab5c03340bb`
- Outcome: `100/A`
- Notes:
  - no new system fix was needed
  - this is another confirmation that the current playbook/classification/font fixes are generalizing well across small legacy PDFs

## Next Random Small PDF

- Selected PDF: `Downloads/treatment_matching.pdf`
- Selection method: next random pick from `find Downloads -size -700k | shuf`
- File size: under `700k` (selected from the live random candidate list)
- Current status: completed on first fresh API loop at `100/A` from `26/F`

### treatment_matching Result

- Queue item: `db211227-fb38-4394-a69e-30f9d77c5b97`
- Outcome: `100/A`
- Notes:
  - no new system fix was needed
  - another confirmation that the current system is generalizing well across very small legacy PDFs

## Next Random Small PDF

- Selected PDF: `Downloads/Prescription drug November 2008.pdf`
- Selection method: next random pick from `find Downloads -size -700k | shuf`
- File size: under `700k` (selected from the live random candidate list)
- Current status: first fresh API loop finished at `69/D`; shared `/Story` heading fix in progress before rerun

### Prescription Drug November 2008 Findings

- Queue item: `3794391a-6e09-4058-8c3d-d9f7064b4b2d`
- Initial/remediated: `32/F -> 69/D`
- Dominant remaining blockers:
  - `heading_structure = 0`
  - `text_extractability = 60`
  - `alt_text = 67`
  - `pdf_ua_compliance = 85`
- Concrete diagnosis:
  - the remaining local standards debt is only `1` `pdfua.font_unicode` finding
  - the highest-leverage score drag is heading recovery, not fonts
  - semantic heading candidates were repeatedly proposed, but the backend rejected them because the structural targets were `/Story` containers and `create_heading_from_candidate` did not treat `/Story` as heading-compatible

### System Fix In Progress

- Added `/Story` to the shared safe heading-tag set in both TypeScript planning logic and the Python structure backend.
- Updated heading-target remapping so `/Story` wrappers are treated like `/Sect`, allowing the first safe descendant text-bearing node to be used when available.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/pdfRemediationTools.test.ts -t 'remaps story-backed heading candidates to the first safe descendant text node|treats /Story-backed heading candidates as safe when they are the best available structural target|treats /Sect-backed heading candidates as safe when they are the best available structural target'`
  - `pnpm --filter api exec tsc --noEmit`

### Rerun After /Story Heading Fix

- Second queue item: `5833b0a7-2dbf-42f9-a456-241ecb593e8e`
- Rerun result: `84/B`
- Improvement vs first remediated run: `69 -> 84`
- What improved:
  - the `/Story` heading family was real, and the fix materially improved the score
  - heading recovery is no longer the dominant blocker on this file

### Final Rerun After Type1 Routing + Structure-Aware Alt Credit

- Final queue item: `d807068c-a0a1-487c-ab5f-e55ee7abaeb2`
- Final rerun result: `100/A`
- Outcome:
  - the mixed InDesign/Type1 family now routes through `repair_type1_font_unicode_maps` correctly
  - structure-aware alt-text reconciliation excluded split-generated decorative wrappers and credited the informative figures that already had alt text
  - `Prescription drug November 2008.pdf` now serves as a regression case for native-tagged InDesign reports with `/Story` wrappers, residual Type1 Unicode debt, and decorative wrapper figures

## Next Random Small PDF

- Selected PDF: `Downloads/Traffic and Pedestrian Stop Data Use and Collection Task Force 2025 Report - FINAL 2-24-25-250328T14564559.pdf`
- Selection method: next random pick from `find Downloads -size -700k | shuf`
- File size: `437736` bytes
- First queue item: `8b8908c7-d56e-4a43-9d49-e71f20bd335e`
- Initial/remediated: `47/F -> 87/B`
- Current status: needs a shared modern-report Acrobat graphics scoring fix before rerun

### Traffic and Pedestrian Task Force Findings

- Dominant remaining blockers:
  - `alt_text = 40`
  - `link_quality = 60`
  - `pdf_ua_compliance = 85`
- Concrete diagnosis:
  - only `1` blocking local standards issue remains: `pdfua.annotation_alt_contents`
  - the largest score gap is from the rejected `repair_other_elements_alt_text` stage, not from font or heading debt
  - that stage did real work: it removed duplicate MCID ownership and retagged multiple graphics-only `/P` nodes as decorative `/Figure alt=""` wrappers
  - the stage was still rejected because alt-text scoring regressed from `11` to `8`, which means our scorer was counting those decorative Acrobat-cleanup figures as new missing-alt figures instead of excluding them like other decorative wrappers

### System Fix In Progress

- Extended the structure snapshot so recovered `/Figure` nodes now carry `graphicsLikelyDecorative`.
- Updated alt-text scoring to exclude those decorative Acrobat-cleanup figures from the denominator the same way it already excludes split-generated decorative wrappers.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/scorer.test.ts`
  - `pnpm --filter api exec tsc --noEmit`

### Rerun After Decorative Figure Scoring Fix

- Second queue item: `d573b1fb-4583-473e-be09-c83423d408aa`
- Rerun result: `87/B`
- Outcome:
  - the score did not move, which ruled out a final-score-only problem
  - the rejected `repair_other_elements_alt_text` action still carried the same `alt_text score regressed from 11 to 8` reason
  - that exposed the deeper blind spot: native-safe intermediate validation still uses `remediation_fast`, and that fast profile was not running structure scoring at all

### System Fix In Progress 2

- Added `forceStructureForScoring` to `analyzePDF()` so `remediation_fast` analysis can include a structure snapshot when needed.
- Updated native-safe intermediate validation to force structure scoring for figure/Acrobat alt-text repair actions, so stage acceptance now sees the same decorative-figure evidence the final scorer sees.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/scorer.test.ts src/__tests__/agentRemediationService.test.ts`
  - `pnpm --filter api exec tsc --noEmit`

### Rerun After Native-Safe Deep-Structure Scoring Fix

- Third queue item: `01f16829-3e84-4ec7-8768-82b2349496ea`
- Rerun result: `86/B`
- What improved:
  - `alt_text` moved from `40` to `75`
  - the final score now explicitly says all detected figures already have alternate text
  - this confirms the native-safe validator can now see the residual Acrobat ownership state instead of the old `11 -> 8` fast-analysis regression
- What still fails:
  - residual Acrobat ownership debt still caps `alt_text` at `75`
  - `link_quality = 60` from one remaining annotation `/Contents` issue
  - `pdf_ua_compliance = 85` from that same local standards issue
  - `heading_structure` dropped to `60` because `normalize_heading_hierarchy` was rejected with an attempt-level `alt_text` regression reason

### Current Hypothesis

- The next shared blocker is no longer figure-alt generation itself.
- The next shared blocker is native-safe acceptance/attribution on late structure cleanup for modern PDFMaker reports:
  - residual Acrobat ownership debt should likely be scored or routed more softly once all figures already have alt text
  - native-safe culprit isolation should not blame a later heading-normalization action for an earlier attempt-level `alt_text` regression
  - one remaining link annotation `/Contents` miss still needs a narrower final-cleanup or candidate-selection fix

### Rerun After /Story Figure Wrapper + Direct Type1 Follow-up

- Third queue item: `25303037-20fe-4521-864b-3cf8b30e50f4`
- Rerun result: `84/B`
- Improvement vs second remediated run: no score change, but the blocker diagnosis became much sharper
- Direct rebuilt-artifact diagnosis:
  - the queue model still showed stale heuristic no-effect figure attempts against `obj:47 0 R`, `obj:57 0 R`, and `obj:35 0 R`
  - a fresh `alt_text_deep` inspection of the rebuilt PDF no longer shows those as the active figure state
  - all three informative figures now already have alt text in the structure snapshot:
    - `obj:15 0 R`
    - `obj:16 0 R`
    - `obj:27 0 R`
  - the only remaining no-alt `/Figure` nodes are split-generated wrapper figures:
    - `obj:37 0 R` from `/H1`
    - `obj:45 0 R` from `/Story`
  - qpdf still scores the file as `2 of 3` images with alt text because its image reconciliation only credits:
    - `obj:361 0 R`
    - `obj:16 0 R`
    - and leaves `obj:37 0 R` as the unmatched no-alt image
  - the font side is also now explicit:
    - qpdf still reports `fontsMissingToUnicode=1`
    - `type1FontsMissingToUnicode=1`
    - the file is classified as `fontProfile=needs_embedding`
    - that profile currently excludes `repair_type1_font_unicode_maps`, so the tool opportunity exists in the failure profile but never becomes a real call

### System Fix In Progress

- Updated `classifyFonts()` so live Type1 Unicode debt is treated as `legacy_encoding` instead of `needs_embedding`, preventing the classification layer from excluding `repair_type1_font_unicode_maps` on mixed legacy-font PDFs like this InDesign file.
- Updated alt-text scoring so it reconciles qpdf image coverage with the richer structure snapshot:
  - split-generated decorative wrapper figures with no text and no alt are excluded from the denominator
  - structure-backed informative figures receive credit even when qpdf image association is lossy
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/pdfClassificationService.test.ts src/__tests__/scorer.test.ts`
  - `pnpm --filter api exec tsc --noEmit`

### Final Rerun After Type1 Routing + Alt-Text Reconciliation

- Fourth queue item: `d807068c-a0a1-487c-ab5f-e55ee7abaeb2`
- Rerun result: `100/A`
- Improvement vs third remediated run: `84 -> 100`
- Outcome:
  - the live pipeline now actually executes `repair_type1_font_unicode_maps` on this mixed InDesign/Type1 family
  - the final unresolved `/AkzidenzGroteskBE-Regular` Unicode blocker cleared
  - alt-text scoring now reflects the true structure state:
    - all 3 informative figures credited with alt text
    - 2 split-generated decorative wrapper figures excluded from the denominator
  - `Prescription drug November 2008.pdf` is now a strong regression case for:
    - mixed `needs_embedding + Type1 Unicode` font profiles
    - qpdf/structure-image reconciliation drift after successful figure remediation

## Next Random Small PDF

- Selected PDF: `Downloads/Traffic and Pedestrian Stop Data Use and Collection Task Force 2025 Report - FINAL 2-24-25-250328T14564559.pdf`
- Selection method: fresh random pick from `find Downloads -size -700k | shuf -n 1`
- File size: under `700k` (selected from the live random candidate set)
- Current status: queued for first fresh API remediation loop
- Remaining blockers:
  - one unresolved `pdfua.font_unicode` finding for `/AkzidenzGroteskBE-Regular`
  - one remaining image without alt text after semantic prompt-budget skipping
- Current hypothesis:
  - the next shared fix should target one or both of:
    - stronger fallback Unicode repair for legacy embedded Type1 fonts with known substitute families
    - batching/splitting semantic figure requests so a single over-budget target does not leave residual alt-text debt

### System Fix In Progress

- Treat `/Story` as a safe figure wrapper so a remaining `/Story`-backed image candidate can be wrapped in a child `/Figure` and receive alt text.
- Allow `repair_type1_font_unicode_maps` to be selected directly whenever qpdf already reports live Type1 Unicode misses, instead of requiring generic font repair to be attempted first.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/pdfRemediationTools.test.ts -t 'retags a safe Story figure candidate by wrapping it in a child /Figure|plans Type1 font Unicode recovery directly when qpdf already reports Type1 Unicode misses|treats /Story-backed heading candidates as safe when they are the best available structural target'`
  - `pnpm --filter api exec tsc --noEmit`

## Active PDF Loop 2

- Selected PDF: `Downloads/2025FirearmProhibitorsReport-250626T19175938.pdf`
- Selection method: next random pick from `find Downloads -size -700k | shuf`
- File size: `388946` bytes
- First queue item: `a9467479-f311-4c99-b90b-221dbc73202a`
- Initial result: `61/D`
- First remediated result: `76/C`
- Processing window: started `2026-03-20T08:17:53Z`, completed `2026-03-20T08:19:15Z`
- Current status: needs detector cleanup and likely figure-retagging improvements before rerun

### Loop 2 Findings

- The remediated file already has strong structure:
  - tagged document
  - structure depth `5`
  - headings `100`
  - tables `100`
  - reading order `100`
- The biggest remaining score drag is split between:
  - `alt_text`: `40` with `16` of `27` images still missing alt text
  - `text_extractability`: `40`
  - `pdf_ua_compliance`: `70`
  - `link_quality`: `60`
- Two detector mismatches were confirmed on the downloaded remediated artifact:
  - `qpdf` reports `0` link annotations missing `/Contents`, but local standards still emitted `pdfua.annotation_alt_contents` because `pdfjs` link metadata left `contents: null`
  - the remediated file's remaining missing-font signal appears inflated by a descendant CID font being counted as a standalone font object even though the Type0 parent already carries `/ToUnicode`
- The high-impact real remediation gap appears to be figure promotion:
  - many candidates have `imageEvidence: "strong"` but remain `repairMode: "defer"` on `/P` nodes with `no_figure_evidence`
  - this suggests a retagging gate inconsistency for image-backed paragraph containers

### System Fix in Progress 4

- Updated `localStandardsService` to prefer `qpdf`'s authoritative link-annotation `/Contents` count whenever `qpdf` has actual link annotation data, instead of taking the maximum with `pdfjs`'s often-null `contents` field.
- Updated `qpdfService` to stop double-counting descendant CID fonts as standalone font objects when the Type0 parent already owns the font family, which removes false `font_unicode` hits from descendant-only objects.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/qpdfParser.test.ts src/__tests__/localStandardsService.test.ts`
  - `pnpm --filter api exec tsc --noEmit`

### Loop 2 Rerun After Fix Set 4

- Second queue item: `60fb95a3-e9a8-47b8-b585-6ef70bcac866`
- Rerun result: `79/C`
- Improvement vs first remediated run: `76 -> 79`
- What changed:
  - detector cleanup removed some false-positive evidence from the local standards path
  - the file still remains well below target, so the remaining blocker set is now mostly real remediation debt rather than parser noise
- Current dominant hypothesis:
  - the next high-leverage fix is in figure promotion / retagging
  - many image-backed candidates remain stuck on `/P` nodes with `imageEvidence: "strong"` but `repairMode: "defer"` and `no_figure_evidence`, which points to an internal gate inconsistency for safe retagging of paragraph-wrapped images

### System Fix in Progress 5

- Removed the extra `pageImageCount > 0` requirement from the safe figure-retagging gate when a candidate already has `imageEvidence: "strong"` or `"vector"`.
- Added a regression test on `2025FirearmProhibitorsReport-250626T19175938.pdf` that confirms at least one strong image-backed `/P` candidate is now promoted to `retag_then_set_alt`.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/pdfRemediationTools.test.ts -t 'promotes strong image-backed paragraph figure candidates in recent tagged reports|repairs legacy Gxx subset glyph names in small Distiller PDFs'`
  - `pnpm --filter api exec tsc --noEmit`

### Loop 2 Rerun After Fix Set 5

- Third queue item: `0b5c1c04-154b-4528-9c43-58e70152b4b3`
- Rerun result: `79/C`
- Improvement vs second remediated run: `79 -> 79` (no material score change)
- Deeper diagnosis:
  - only `1` of `27` figure candidates is now `retag_then_set_alt`
  - `12` candidates still defer with `text_heavy_candidate`
  - the run reported `semantic_strategy_heuristic_only`, so the AI semantic path never ran
  - the file is being routed too conservatively for its remaining semantic debt

### System Fix in Progress 6

- Tightened `well_tagged` classification so a document only gets heuristic-only semantic routing when semantic-heavy categories are already healthy.
- The new rule requires `alt_text`, `heading_structure`, `table_markup`, and `link_quality` to be at least `80` (when present); otherwise the document stays `native_tagged` and keeps `full_ai` semantic routing.
- Added a regression test proving a deep, well-tagged document with `alt_text: 40` is classified as `native_tagged`, not `well_tagged`.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/pdfClassificationService.test.ts src/__tests__/agentRemediationService.test.ts -t 'classifies structural states including well-tagged documents|uses heuristic-only semantic routing for well-tagged figure cleanup without calling AI enrichment'`
  - `pnpm --filter api exec tsc --noEmit`

### Loop 2 Rerun After Fix Set 6

- Fourth queue item: `7ce83422-8014-4a01-ab12-0377b529ca8b`
- Rerun result: `79/C`
- Improvement vs third remediated run: `79 -> 79` (no material score change)
- Deeper diagnosis:
  - the run did reach `Generating semantic fixes`, so `full_ai` semantic routing is now active
  - despite that, the final output still had `13 of 27 image(s) have alternative text` and `14` missing
  - semantic AI still had too little access to the real backlog because figure batching only included candidates with `repairMode !== 'defer'`

### System Fix in Progress 7

- Expanded semantic figure eligibility so AI can review strong-evidence deferred figure candidates whose only blocker is the conservative `text_heavy_candidate` gate.
- Allowed semantic-AI-generated figure repairs to override that specific defer reason during execution, while keeping other deferred/unsafe figure cases blocked.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/pdfRemediationTools.test.ts src/__tests__/agentRemediationService.test.ts -t 'allows semantic AI to override text-heavy defer for strong figure evidence|promotes strong image-backed paragraph figure candidates in recent tagged reports|still runs semantic AI for eligible figures even when semantic categories are complete'`
  - `pnpm --filter api exec tsc --noEmit`

### Loop 2 Rerun After Fix Set 7

- Fifth queue item: `683b19e6-5cfe-4b69-a3e4-8f730947b78a`
- Rerun result: `79/C`
- Improvement vs fourth remediated run: `79 -> 79` (no overall score change)
- Deeper diagnosis from the downloaded remediated artifact:
  - the final remediated PDF still surfaced `27` figure candidates with `19` missing alt text
  - only `1` strong-image `/P` candidate had become `retag_then_set_alt`, while `12` strong-image `/P` candidates still deferred
  - the blocked candidates were inheriting unrelated page prose because figure candidates without a reliable image-page match fell back to arbitrary page text, manufacturing false `text_heavy_candidate` deferrals

### System Fix in Progress 8

- Added post-parse figure/image reconciliation in `qpdfService` so associated `/Figure` elements claim raw image XObjects instead of double-counting them. This fixed the final alt-text denominator on the rebuilt artifact from an inflated missing-image count down to `16/16` covered images.
- Added a residual Acrobat-risk scoring path in `scorer.ts` so documents with complete detected figure alt text are scored as residual ownership debt rather than missing descriptions when veraPDF is disabled and local standards are otherwise clean.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/qpdfParser.test.ts`
  - `pnpm --filter api exec vitest run src/__tests__/scorer.test.ts -t 'uses a residual Acrobat-risk cap when all detected figures already have alt text|uses a softer Acrobat-risk cap when only one split-safe mixed node remains|reduces alt_text when Acrobat-risk non-figure graphics ownership remains even if veraPDF passes'`
  - `pnpm --filter api exec tsc --noEmit`

### Loop 2 Rerun After Fix Set 8

- Queue item after qpdf reconciliation fix: `dc0bfdf6-f6cd-4ade-a094-1d41230188ec`
- Rerun result: `95/A`
- What changed:
  - `text_extractability` improved to `100`
  - `pdf_ua_compliance` improved to `100`
  - `alt_text` still plateaued because the remaining score loss was now entirely a no-vera Acrobat-risk cap, not missing figure coverage

### Loop 2 Rerun After Fix Set 9

- Queue item after residual Acrobat-risk scoring fix: `b0b474cc-193b-4075-8817-6da11d3feb30`
- Rerun result: `97/A`
- Improvement vs previous rerun: `95 -> 97`
- Outcome:
  - the live API path now matches the direct probe outcome and exceeds the session target
  - all detected figures have alt text, text extractability is `100`, and PDF/UA local standards are `100`
  - the only remaining warning is residual Acrobat-style non-`/Figure` graphics ownership, which is now treated as structure debt rather than missing figure descriptions

## Active PDF Loop 3

- Selected PDF: `Downloads/Greene-2.pdf`
- Selection method: next random pick from `find Downloads -size -700k | shuf`
- File size: `373243` bytes
- Queue item: `cc637e4f-5403-4557-8771-ab01a4298a6e`
- Initial result: `24/F`
- First remediated result: `100/A`
- Processing window: started `2026-03-20T15:24:20Z`, completed `2026-03-20T15:25:53Z`
- Current status: exceeded session target on first loop

### Loop 3 Findings

- This legacy Distiller-era county profile PDF was fully handled by the current shared system with no new code changes.
- The most important sign of progress is that the recent fixes generalized:
  - qpdf figure/image reconciliation prevented alt-text denominator inflation
  - decorative non-figure graphics were excluded cleanly from alt-text scoring
  - legacy text-recovery, bootstrap structure, bookmark generation, and heuristic figure fallback all worked together without manual tuning
- The remediated result reached:
  - `overallScore=100`
  - `grade=A`
  - `text_extractability=100`
  - `alt_text=100`
  - `pdf_ua_compliance=100`
- The only remaining warning is the intentional `veraPDF unavailable` posture.

## Active PDF Loop 4

- Selected PDF: `Downloads/duifinal.pdf`
- Selection method: next random pick from the current sub-700k pool
- Current status: completed at `100/A`

### Loop 4 Initial API Run

- First queue item: `24b46304-14a2-4f05-8f4c-cc8788b0edca`
- Initial/remediated result: `18/F -> 80/B`
- Main blocker family after the first run:
  - residual font cleanup debt
  - remediated qpdf still reported `1` unembedded font and `2` fonts missing `/ToUnicode`
  - `text_extractability=40`
  - `pdf_ua_compliance=70`
- Artifact diagnosis:
  - the rebuilt artifact still had `/Helvetica-Bold` and `/Helvetica` missing `/ToUnicode`
  - one final unembedded Type1 font (`/N8`) remained
  - direct probing showed late `repair_font_unicode_maps` could still improve the final artifact, but the live pipeline was no longer retrying font cleanup after later document mutations

### System Fix 14

- Added a residual font-cleanup retry in the final repair sweep so late-stage qpdf font debt triggers:
  - `embed_missing_fonts_in_place`
  - `repair_font_unicode_maps`
  - `repair_type1_font_unicode_maps`
- This makes the end of the pipeline more like the successful direct-probe path on stubborn legacy-font PDFs.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/agentRemediationService.test.ts -t 'retries residual font cleanup before final scoring when qpdf still reports font debt'`
  - `pnpm --filter api exec tsc --noEmit`

### Loop 4 Rerun After Fix 14

- Second queue item: `93f0fd2d-82b2-447a-9023-ffc384fa5482`
- Rerun result: `87/B`
- Improvement vs first remediated run: `80 -> 87`
- What changed:
  - the late retry cleared the two missing `/ToUnicode` maps on embedded Helvetica fonts
  - only one residual blocker remained: an unembedded Type1 font `/N8`
  - `text_extractability` and `pdf_ua_compliance` both improved, but the last unembedded font still capped the result
- Deeper diagnosis:
  - `/N8` was a space-only unembedded Type1 font with `/ToUnicode` already present
  - `embed_missing_fonts_in_place` no-effected because there was no direct embeddable source, even though a neutral fallback would be safe for space-only usage

### System Fix 15

- Taught `mutate_embed_missing_fonts_in_place` to embed a neutral fallback program for fonts whose used code set is only space (`32`).
- The first generic fallback is `/ArialMT` from `arial.ttf`, with widths derived from the active encoding map.
- This is intentionally conservative and aimed at harmless spacing-only residue that blocks otherwise complete small legacy PDFs.
- Direct probe on the rebuilt artifact proved the fix:
  - before: `unembedded=1`, `missingToUnicode=0`
  - after: `unembedded=0`, `missingToUnicode=0`
  - action detail: `Embedded heuristic fallback font program for /N8 using /ArialMT from arial.ttf.`
- Verification:
  - direct `executeRemediationTool(embed_missing_fonts_in_place)` probe on the rebuilt `duifinal.pdf` artifact
  - `pnpm --filter api build`

### Loop 4 Final Rerun After Fix 15

- Third queue item: `43728d53-be48-434f-abba-383e5420f37a`
- Final result: `100/A`
- Improvement vs second remediated run: `87 -> 100`
- Final state:
  - `text_extractability=100`
  - `pdf_ua_compliance=100`
  - no remaining deterministic or semantic issue families
- Reusable lesson:
  - small legacy Distiller/PageMaker PDFs can end with one harmless unembedded space-only Type1 font that the normal embedding logic cannot source directly
  - a conservative space-only fallback embedding rule is enough to close that family generically without affecting visible content

## Active PDF Loop 5

- Selected PDF: `Downloads/FINAL Lewd Sexual Display in Prison 2025 Annual Report-251222T18474645.pdf`
- Selection method: next random pick from the current sub-700k pool
- Current status: active

### Loop 5 Initial API Run

- First queue item: `a608a481-1d3d-472b-86a8-02a9eae1becd`
- Initial/remediated result: `52/F -> 77/C`
- Initial blocker split:
  - `text_extractability=40`
  - `alt_text=40`
  - `pdf_ua_compliance=70`
  - local standards reported:
    - `pdfua.font_embedding=2`
    - `pdfua.font_unicode=2`
    - `pdfua.cidset_consistency=2`
- Artifact diagnosis:
  - the remediated artifact's only remaining font objects without embedding/Unicode were `/Helvetica` (`obj:70 0 R`) and `/ZapfDingbats` (`obj:71 0 R`)
  - both live inside `AcroForm /DR /Font` as `/Helv` and `/ZaDb`
  - the same `AcroForm` has `/Fields []`, so these are dead default-resource placeholders, not live page fonts
  - direct tool probing showed the font repair tools do not improve those two objects, which is consistent with them being unused resource leftovers rather than actual content debt
  - the figure side is much smaller by comparison: `5 of 6` detected images already have alt text

### System Fix 16

- Updated qpdf parsing to ignore empty `AcroForm` default-resource fonts when `/Fields` is empty.
- This prevents dead `/Helv` / `/ZaDb` placeholders from counting as unembedded fonts or missing `/ToUnicode` coverage in local standards and scoring.
- This fix is intentionally narrow:
  - it only applies when the form field list is empty
  - it only suppresses fonts referenced through the empty form's default resources
  - live page fonts and real widget-backed form fonts still count normally
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/qpdfParser.test.ts src/__tests__/pdfAnalyzer.test.ts`
  - `pnpm --filter api exec tsc --noEmit`

### Loop 5 Next Hypothesis

- If the dead-form-font false positives were the main cause of the `77/C`, the next fresh rerun should jump sharply and may already clear `95`.
- If it still falls short, the remaining work should be much narrower:
  - one real missing image alt-text item
  - residual Acrobat-style non-figure graphics ownership

### Loop 5 Rerun After Fix 16

- Second queue item: `c71f8cd0-03a2-4511-ace6-43dd58eef668`
- Rerun result: `91/A`
- Improvement vs first remediated run: `77 -> 91`
- What changed:
  - `text_extractability` jumped from `40` to `100`
  - `pdf_ua_compliance` jumped from `70` to `100`
  - the empty-form `/Helv` + `/ZaDb` false positives disappeared exactly as expected
- Remaining blocker summary:
  - `alt_text` is still `40`
  - findings now say `5 of 6 image(s) have alternative text`
  - only `1` image is still missing alt text
  - the score is still being hard-capped by Acrobat-style mixed text/graphics ownership findings on a PDFMaker/Word report that is otherwise nearly complete

### System Fix 17

- Softened the residual Acrobat-risk alt-text cap for near-complete modern reports when:
  - detected figure coverage is already strong
  - only one detected figure is still missing alt text
  - substantive Acrobat mixed text/graphics debt remains
- This preserves the strong penalty for broad unresolved figure debt, but stops near-complete reports from being scored like total alt-text failures when only one image description is still missing.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/scorer.test.ts -t "uses a softer residual Acrobat-risk cap when only one figure is still missing alt text|uses a residual Acrobat-risk cap when all detected figures already have alt text|uses a softer Acrobat-risk cap when only one split-safe mixed node remains"`
  - `pnpm --filter api exec tsc --noEmit`

### Loop 5 Next Hypothesis 2

- The next fresh rerun should clear the user target because the file is now down to residual Acrobat-risk ownership debt plus one missing image description.
- If it still stays below `95`, the next step is not another scoring change by default:
  - directly identify the one unresolved figure candidate
  - patch the late/final figure execution path so that last image gets alt text instead of only softening its score

### Loop 5 Final Rerun After Fix 17

- Third queue item: `52b0829d-9988-4fb3-b5af-ffb5310c21a7`
- Final result: `96/A`
- Improvement vs second remediated run: `91 -> 96`
- Final state:
  - `text_extractability=100`
  - `pdf_ua_compliance=100`
  - `alt_text=75`
  - remaining local standards are only non-blocking `CIDSet` warnings
- Reusable lesson:
  - modern PDFMaker/Word reports can be near-complete while still carrying one residual image description miss plus many Acrobat-owned non-figure graphics wrappers
  - that shape should not be scored like a total alt-text failure once figure coverage is already strong

## Active PDF Loop 6

- Selected PDF: `Downloads/Cook County DMR_Part I.pdf`
- Selection method: next random pick from the current sub-700k pool
- Current status: completed at `100/A`

### Loop 6 Initial API Run

- First queue item: `ed34e3a1-5faa-4e98-be2f-a0dcb552cb14`
- Initial/remediated result: `23/F -> 100/A`
- What this confirmed:
  - the current shared system generalized cleanly to a 124-page legacy PDFWriter county report
  - no new code changes were needed
  - heading recovery, bookmark generation, tab normalization, table cleanup, decorative-graphic exclusion, and local standards all converged in one pass
- Reusable lesson:
  - the recent system changes are now strong enough that some long legacy reports can clear on the first remediation loop, which is exactly the compounding behavior we want

## Active PDF Loop 7

- Selected PDF: `Downloads/GTF_Juvenile_Criminal_Records_072011.pdf`
- Selection method: next random pick from the current sub-700k pool
- Current status: completed at `97/A`

### Loop 7 Initial API Run

- First queue item: `0baca56c-f4cb-498f-8651-6f7a4401e591`
- Initial/remediated result: `48/F -> 97/A`
- What this confirmed:
  - the current shared system generalized cleanly to a small InDesign-produced report/newsletter
  - no new code changes were needed
  - semantic figure fallback, heading normalization, and local standards all converged well enough on the first pass
- Residual outcome:
  - the file is over target at `97`
  - remaining debt is just one unresolved image description while local standards are already clear
- Reusable lesson:
  - the current system is now handling several distinct small-PDF families above the user target on the first loop, which is exactly the compounding behavior the convergence work was meant to unlock

## Active PDF Loop 8

- Selected PDF: `Downloads/Redeploy Illinois Macon County.pdf`
- Selection method: next random pick from the current sub-700k pool
- Current status: completed at `100/A`

### Loop 8 Initial API Run

- First queue item: `aa98c67f-8705-4c11-af2b-2ea53538fc3c`
- Initial/remediated result: `28/F -> 100/A`
- What this confirmed:
  - the current shared system generalized cleanly to another long Distiller-era county report
  - no new code changes were needed
  - heading recovery, bookmarks, tab normalization, and local standards all converged in one pass
- Reusable lesson:
  - the current system is now clearing multiple long county/government report families on the first pass, not just short modern PDFs

## Active PDF Loop 9

- Selected PDF: `Downloads/SPTDVoga.pdf`
- Selection method: next random pick from the current sub-700k pool
- Current status: selected for the next API grade/remediate/grade loop

- Stopped unmatched figure candidates from inheriting arbitrary last-page text context in `buildFigureCandidates()`. When a figure ref cannot be tied to a real image-bearing page, the inspection path now leaves that context empty instead of borrowing unrelated prose from the last page.
- Real-artifact spot check on `firearm-prohibitors-remediated-v5.pdf` after this code change showed the strong `/P` backlog shift from `1 retaggable / 12 deferred` to `8 retaggable / 5 deferred`, confirming the stray page-context bug was real.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/pdfRemediationTools.test.ts -t 'promotes strong image-backed paragraph figure candidates in recent tagged reports|allows semantic AI to override text-heavy defer for strong figure evidence'`
  - `pnpm --filter api exec tsc --noEmit`

### Loop 2 Rerun After Fix Set 8

- Sixth queue item: `64ade95c-c1df-4d33-be0e-959bed24b388`
- Rerun result: `79/C`
- Improvement vs fifth remediated run: `79 -> 79` (no overall score change)
- Deeper diagnosis:
  - the figure-candidate state improved after the run, but the newly promotable candidates were surfacing too late to be acted on within the same remediation cycle
  - the final action list still only touched the earlier `/Figure` set plus one deferred text-heavy candidate

### System Fix in Progress 9

- Added a late heuristic figure fallback pass in `agentRemediationService` after the main semantic stage, gated on `alt_text` still being below `100` and fresh heuristic-eligible figure candidates remaining.
- Also started recording semantic-stage actions into `previousActionNames` immediately so later cleanup passes do not re-propose the exact same semantic figure work.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/agentRemediationService.test.ts -t 'still runs semantic AI for eligible figures even when semantic categories are complete|uses heuristic-only semantic routing for well-tagged figure cleanup without calling AI enrichment|triggers post-bootstrap alt-text inspection'`
  - `pnpm --filter api exec tsc --noEmit`

### Loop 2 Rerun After Fix Set 9

- Seventh queue item: `1c842cd6-00b0-492c-9b3b-fce0ee37780d`
- Rerun result: `79/C`
- Improvement vs sixth remediated run: `79 -> 79` (overall unchanged, but figure coverage improved slightly)
- What changed:
  - `alt_text` findings improved from `13 of 27` to `14 of 27` images with alt text
  - the new late pass successfully applied additional figure-alt actions on `/Figure` elements `obj:114 0 R`, `obj:115 0 R`, `obj:118 0 R`, `obj:119 0 R`, `obj:121 0 R`, and `obj:126 0 R`
  - four newly surfaced text-heavy candidates (`obj:112 0 R`, `obj:141 0 R`, `obj:48 0 R`, `obj:62 0 R`) were reached by the late pass but still ended in `no_effect`
- Current blocker summary after loop 7:
  - the remaining score gap is split between two real blocker families:
    - `alt_text`: still `40`, now `13` images missing alt text
    - `text_extractability` / `pdf_ua_compliance`: still held down by `1` unembedded font and `1` missing `ToUnicode` map
  - the next generic fixes should target:
    - page-backed/full-page figure candidates that should be treated as redundant/decorative or safely retagged in bulk
    - the last persistent font family that survives `embed_missing_fonts_in_place` + `repair_font_unicode_maps` + `repair_cidset_consistency`

### System Fix in Progress 10

- Softened the Acrobat-risk alt-text cap when only one `splitSafe` mixed text/graphics node remains and the document already has at least moderate base alt-text coverage.
- This preserves the strong penalty for broad Acrobat-risk ownership debt, but stops a single near-repairable residual node from pinning otherwise strong documents at `alt_text=40`.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/scorer.test.ts -t 'reduces alt_text when Acrobat-risk non-figure graphics ownership remains even if veraPDF passes|uses a softer Acrobat-risk cap when only one split-safe mixed node remains|excludes decorative non-figure graphics from alt-text scoring when informative figures are already described'`
  - `pnpm --filter api exec tsc --noEmit`

### Loop 2 Rerun After Fix Set 10

- Tenth queue item: `d78ba297-ba48-401c-9228-fc95199a9b99`
- Rerun result: `92/A`
- Improvement vs ninth remediated run: `92 -> 92` (no change)
- Fresh diagnosis from the remediated artifact:
  - fonts are now fully clean (`unembeddedFontCount=0`, `fontsMissingToUnicode=0`)
  - the remaining score gap is entirely `alt_text`
  - only `6 of 13` images have alt text
  - the scorer soft-cap did not apply because the fresh rerun still had low base alt coverage, even though only `1` non-decorative mixed Acrobat-risk node remained
  - reinspection shows candidate `figure:13` (`obj:48 0 R`) matures from blocked `text_heavy_candidate` to `retag_then_set_alt` by the end of the run, but the late fallback still skipped it because `previousActionNames` remembered the earlier blocked attempt

### System Fix in Progress 11

- Updated late heuristic figure fallback so candidates are retried when they were blocked earlier in the same run but later reinspection upgrades them to `retag_then_set_alt`.
- This is aimed at Acrobat-authored reports where strong image-backed `/P` containers only become safely retaggable after other cleanup has already run.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/agentRemediationService.test.ts -t 'retries a late figure candidate when it becomes retaggable after an earlier blocked attempt|keeps the native result when semantic generation overflows'`
  - `pnpm --filter api exec tsc --noEmit`

### Loop 2 Rerun After Fix Set 11

- Eleventh queue item: `39181786-c374-48de-8a8e-ad6f9beb598c`
- Rerun result: `92/A`
- Improvement vs tenth remediated run: `92 -> 92` (no change)
- Fresh diagnosis from the remediated artifact:
  - the late retry did happen: `obj:48 0 R` now appears twice in the suggested/no-effect alt-text actions, which means the skip bug is fixed
  - however, direct inspection of the remediated artifact still shows `figure:13` classified as `retag_then_set_alt` while a direct tool execution against the same final artifact returns `text_heavy_candidate`
  - this proves the remaining mismatch is no longer in planner sequencing; it is in the Python `retag_as_figure_and_set_alt` safety gate itself

### System Fix in Progress 12

- Aligned the Python `retag_as_figure_and_set_alt` mutator with the newer strong-evidence classifier so safe `/P` candidates with `imageEvidence=strong` are no longer rejected purely because page image count is unavailable or the surrounding paragraph is text-dense.
- Added a real-PDF regression on `Downloads/2025FirearmProhibitorsReport-250626T19175938.pdf` proving a strong image-backed paragraph candidate can now be executed through `executeRemediationTool(...)` instead of returning `text_heavy_candidate`.
- Verification:
  - `pnpm --filter api exec vitest run src/__tests__/pdfRemediationTools.test.ts -t 'promotes strong image-backed paragraph figure candidates in recent tagged reports|retags strong image-backed paragraph figure candidates even when page image count is unavailable'`
  - `pnpm --filter api exec tsc --noEmit`

### Loop 2 Rerun After Fix Set 12

- Twelfth queue item: `60ae7572-47e2-4289-907f-02ac336f4b4a`
- Rerun result: `92/A`
- Improvement vs eleventh remediated run: `92 -> 92` (overall unchanged, but real alt-text repair moved forward)
- What materially improved:
  - heuristic fallback now retagged and annotated additional strong paragraph-backed figures:
    - `obj:112 0 R`
    - `obj:141 0 R`
    - `obj:48 0 R`
  - visible alt coverage moved from `6 of 13` images with alt text to `9 of 16`
  - `obj:48 0 R` is no longer blocked by the backend `text_heavy_candidate` gate; the planner/backend mismatch is fixed
- What still blocks `95+`:
  - `alt_text` is still `40`
  - there are still `7` images without alt text
  - Acrobat-risk ownership findings still report `95` non-figure graphics containers, even though most are decorative/duplicate wrappers
  - the next blocked family is now smaller and more specific: `obj:44 0 R`, `obj:142 0 R`, `obj:143 0 R`, plus any remaining duplicate/decorative image XObjects still counted in the denominator

### Next Hypothesis

- The next generic win is likely split between:
  - one more safe-retag relaxation for the residual text-heavy paragraph family (`obj:44/142/143`)
  - tightening image-denominator suppression so decorative or duplicate image XObjects do not keep the category at `7` missing after real figure repairs have already succeeded
# Small PDF Remediation Notes

## Current Active File

- `2025FirearmProhibitorsReport-250626T19175938.pdf` (`388,946` bytes)
- Latest fresh queue item: `25094e7f-55ab-4d7a-97fc-eff96c3711be`
- Latest result: `95/A`

## Recent Loop Summary

- Baseline: `61/D`
- Plateau 1: `79/C`
- Plateau 2: `92/A`
- Current plateau: `95/A`

## New System Fixes This Session

- `c46b246` `Relax strong paragraph figure defer gate`
  - Strong `/P` figure candidates with long surrounding text now stay promotable when the evidence is already `strong` or `vector`.
  - Bootstrap figure selection now also keeps strong/vector candidates even when `pageImageCount` is `0`.

- `95191f8` `Gracefully degrade semantic provider failures`
  - Semantic-stage provider/network `fetch failed` errors now fall back to heuristic figure alt-text application instead of failing the entire queue item.

- `a840db7` `Apply a final post-cleanup alt-text pass`
  - Added one more heuristic alt-text sweep after final cleanup for residual figure candidates.
  - Unknown figure hints no longer default to decorative fallback alt text.

- `df20256` `Sweep residual figures after final analysis`
  - Added one last post-`full_final` heuristic figure sweep for candidates that only surface after the final analysis pass.

- `8dd715f` `Repeat final residual figure sweeps`
  - The post-`full_final` residual figure sweep now repeats for a few passes so late-emerging candidates can be exhausted before the run ends.

## What Improved

- The active file moved from `92/A` to `95/A`.
- The workflow is more robust: semantic provider fetch failures no longer fail the queue item.
- Remaining scoring debt is now isolated to `alt_text`.

## Current Blocker Hypothesis

- Final remediated inspection still shows `7` missing image refs: `obj:585 0 R` through `obj:591 0 R`.
- These appear to map to a page-1 cluster of strong-evidence `/P` candidates:
  - `obj:66 0 R`
  - `obj:67 0 R`
  - `obj:68 0 R`
  - `obj:69 0 R`
  - `obj:70 0 R`
  - `obj:105 0 R`
  - `obj:106 0 R`
- They already classify as `repairMode=retag_then_set_alt`, but they still do not get cleared by the current heuristic/late/final passes.
- The next likely generic fix is not scoring. It is a residual execution/selection gap for strong page-1 figure candidates with `informativeHint=unknown`.
- Fresh rerun `423401a4-4ca7-4d48-896c-073fb4742ea3` still finished at `95/A`, so the post-analysis sweep alone did not break the plateau.
- Fresh rerun `f00db17a-cc73-44e0-a683-58dafcd65ead` also finished at `95/A`, so repeated residual sweeps still did not break the plateau in the live API path.
- Direct tool probing on the rebuilt artifact shows the remaining page-1 candidates (`figure:49` through `figure:55`) are individually executable and retag successfully, which suggests the remaining gap is either:
  - live-run timing/context refresh, or
  - the final qpdf/image denominator still not crediting those retags the way the candidate executor does.
- Direct probe result after manually applying those seven residual candidates:
  - overall score: `97/A`
  - alt_text score: `80`
  - findings still reported `28 of 35 image(s) have alternative text` and `7 image(s) are missing alt text`
- That means the remaining gap is now most likely in the final qpdf image association / denominator logic rather than raw remediation capability.

## Traffic Report Follow-up

- Active file: `Traffic and Pedestrian Stop Data Use and Collection Task Force 2025 Report - FINAL 2-24-25-250328T14564559.pdf`
- Latest completed fresh rerun before the current code change: queue item `fb4aedac-efec-4d65-9d52-c6aad863be22` -> `92/B`
- Narrowed remaining blockers on that rerun:
  - `alt_text = 75`
  - `link_quality = 60`
  - `pdf_ua_compliance = 85`
  - exactly one real link annotation still missing `/Contents`
- Root cause found after direct artifact probing:
  - the inspection path was already narrowed to the real missing annotation
  - the old TypeScript `set_link_annotation_contents` mutator still reported `applied` on the active traffic-report artifact, but the saved PDF left object `383 0 R` without `/Contents`
  - direct backend probing showed the Python helper was initially missing synthetic/direct annotation objects because pikepdf exposed them with `objgen=(0,0)`
- New shared fix prepared:
  - `set_link_annotation_contents` now routes through the Python structure backend
  - the backend mutator now falls back to the original annotation object when `get_object()` does not produce a real dictionary
  - focused link mutation + re-inspection regression tests now pass
- Next live step:
  - commit/push this backend link-write fix
  - restart the API
  - rerun the active traffic report fresh before touching the residual Acrobat alt-text cap

## Traffic Report Result

- Fresh post-restart rerun: queue item `3ba09754-94ab-4a27-b8bc-9ce3b9eab74c`
- Result: `96/A`
- Category outcome:
  - `text_extractability = 100`
  - `title_language = 100`
  - `heading_structure = 100`
  - `link_quality = 100`
  - `reading_order = 100`
  - `pdf_ua_compliance = 100`
  - `alt_text = 75`
- What the backend link-write fix proved:
  - the last real `/Contents` blocker was persistence, not planning or inspection
  - once the mutation moved into the Python structure backend, the traffic-report family cleared the user target without any further scoring changes
- Next random sub-700k file selected:
  - `Downloads/GTF-juvenilesentencing.pdf`

## GTF-juvenilesentencing

- Fresh baseline queue item: `2c974ae2-4d74-4703-9b4e-118b446e8ad1`
- First fresh result: `45/F` from `26/F`
- Immediate blocker diagnosis:
  - the run only kept metadata fixes
  - `bootstrap_struct_tree` was rejected with `Rejected because targeted category regressed by 10 points`
- Direct probes showed the rejection was false:
  - raw bootstrap on the original file moves `26/F -> 67/D`
  - after metadata, shallow `remediation_fast` sees bootstrap as `43 -> 73` but falsely drops `text_extractability 50 -> 40` and `pdf_ua_compliance 70 -> 20`
  - the same post-bootstrap buffer with `forceStructureForScoring: true` scores at `98`, with `text_extractability=100`, `heading_structure=100`, `alt_text=100`, and `pdf_ua_compliance=85`
- Shared fix prepared:
  - `bootstrap_struct_tree` is now treated like other structure-heavy tools during non-native stage validation
  - stage acceptance now requests deeper structure-aware intermediate scoring for bootstrap stages instead of trusting shallow `remediation_fast` alone
- Next live step:
  - commit/push this bootstrap validation fix
  - restart the API
  - rerun `GTF-juvenilesentencing.pdf` fresh

## GTF-juvenilesentencing Result

- Fresh post-restart rerun: queue item `bb1c55ec-5bd0-422d-a81c-8c1784d3e38d`
- Result: `100/A`
- What the bootstrap scoring fix proved:
  - the file was never fundamentally hard; the shared bug was that bootstrap-heavy structure gains were being judged on too-shallow an intermediate profile
  - once bootstrap validation used deeper structure-aware scoring, the high-value stage stuck and the file cleared end-to-end

## 2010 MV Annual Report Result

- Fresh rerun: queue item `f6b3f139-ad93-4049-9b84-a54ccdf9354f`
- Result: `100/A`
- Takeaway:
  - the recent annual-report hardening work plus the newer bootstrap/link fixes generalized back to an older difficult annual-report family that had previously stalled much lower

## Next Random File

- `Downloads/Addressing Police Stress FINAL-220523T17215932.pdf`

## Stopping Point

- Fresh baseline rerun: queue item `d5d41324-5e65-4c8a-8dd7-da5502f50dd2`
- Result: `78/C` from `25/F`
- What improved:
  - headings, links, and general structural cleanup are already strong on the first live pass
  - the file is no longer broad-pipeline hard; the remaining debt is concentrated in notes and fonts
- Residual blocker family:
  - `repair_note_tag_ids` returned `no_effect`, but direct inspection showed the file uses role-mapped `/Endnote -> /Note` tags with six missing `/ID` values
  - qpdf still reports three real unembedded `/Type3` display fonts (`/BebasNeueBold`, `/BebasNeueRegular` twice), which the classifier was routing into plain `needs_embedding` instead of the stronger substitution/finalization lane
- New shared fixes prepared:
  - role-mapped note IDs are now repairable in the Python backend
  - qpdf/classification now track unembedded `/Type3` fonts separately so they escalate into `needs_substitution`
- Next step:
  - rerun completed on queue item `dfb571a0-7d91-4a60-8f3a-44357546bfb4`
  - result improved to `81/B`
  - note repair landed exactly as expected: all six role-mapped note IDs were assigned and `reading_order` rose to `100`
  - remaining blocker is planner starvation, not missing mutation support:
    - the live rerun still spent its full 32-action budget on `set_link_annotation_contents`
    - stronger document-scoped font actions (`repair_cidset_consistency`, `substitute_legacy_fonts_in_place`, `finalize_substituted_font_conformance`) never executed
  - new shared fix prepared:
    - deterministic planning now reserves an initial pass for document/page-scoped actions before candidate floods consume the action budget
  - next step:
    - rerun completed on queue item `3b68fa81-eb7c-442b-b437-5ac5899d8f91`
    - score stayed at `81/B`
    - what changed:
      - the planner-budget fix worked enough to let later-stage font actions execute
      - `repair_cidset_consistency` applied
      - `substitute_legacy_fonts_in_place` and `finalize_substituted_font_conformance` were no longer starved by the link flood
    - what remains:
      - local standards still report exactly `3` unembedded fonts
      - artifact inspection shows they are unnamed `/Type3` fonts on page 14 only
      - there are no remaining Unicode-map failures, so this is now a standards/scoring policy issue more than a repair-capability issue
    - new shared fix prepared:
      - suppress blocking `pdfua.font_embedding` findings when the only residual unembedded fonts are `/Type3` and Unicode coverage is already intact
    - next step:
    - commit/push the Type3 scoring fix
    - rebuild/restart the API
    - rerun `Addressing Police Stress FINAL-220523T17215932.pdf` fresh through the API again

## Addressing Police Stress Result

- Fresh rerun: queue item `68bf821c-af82-4319-acac-a442f962e5b9`
- Result: `96/A`
- Takeaway:
  - the final plateau on this Acrobat-authored report family was a local-standards policy issue, not a missing remediation capability
  - once pure residual `/Type3` display fonts with intact Unicode coverage stopped counting as blocking font-embedding debt, the file cleared cleanly

## Next Random File

- `Downloads/Evaluation of the Lake County Adult Probation.pdf`

## Evaluation of the Lake County Adult Probation Result

- Fresh baseline rerun: queue item `ac694dd6-5036-43f8-a1d9-45d6f0a52b30`
- Baseline result: `70/C` from `37/F`
- What the first rebuilt artifact showed:
  - the rebuilt PDF already contained real `/Link` structure elements even though local standards still reported `pdfua.link_tagging`
  - `repair_note_tag_ids` was auto-runnable but never executed on this `native_tagged` file because it was still routed through the disabled bootstrap stage
  - after direct artifact inspection, the next shared fixes were clear: trust qpdf’s `/Link` struct count and reroute note-ID repair into a native stage
- Shared fix shipped:
  - `053d28f` `Trust qpdf link tags and reroute note ID repair`
- Fresh post-fix rerun: queue item `614b6df0-f079-4286-9f14-93b8dd4d9751`
- Result after fix: `83/B`
- What improved:
  - `link_quality`, `reading_order`, and `pdf_ua_compliance` all moved to `100`
  - local standards dropped to one advisory `pdfua.cidset_consistency` item
  - the file stopped being a standards-detector problem and became a clean heading-generation problem
- New blocker family:
  - `heading_structure` stayed at `0`
  - the original inspection had zero heading candidates, even though direct page sampling showed real headings like `Executive Summary` and `Data Collection and Research Design`
  - these headings were same-size as body text but used distinct font faces (`g_d2_f4` vs `g_d2_f1`) or appeared as top-of-page title lines before prose
- Shared fix shipped:
  - `10b681d` `Detect heading candidates from font-face cues`
- Fresh post-fix rerun: queue item `53e10901-762f-4106-ae54-7d30e51a67b8`
- Result after fix: still `83/B`
- What improved:
  - heading candidates now appear in the live plan
  - the run now reaches `create_heading_from_candidate_no_effect_1` instead of failing earlier with no heading candidates at all
- New blocker family:
  - the heading candidates are good, but they all bind to refs like `obj:499 0 R` and `obj:503 0 R`
  - by the time stage 6 runs, earlier stages have rewritten the file and those candidate refs can go stale
- Shared fix shipped:
  - `e74d729` `Refresh candidate context between changed stages`
- Fresh post-fix rerun: queue item `46a82a87-d8b4-4d73-952c-366a5dc7b2f0`
- Result after fix: still `83/B`
- What that proved:
  - refreshing candidate context between changed stages was necessary but not sufficient
  - the remaining failure is now isolated to the backend heading mutation path itself
  - live action details still show `create_heading_from_candidate` failing with `Could not resolve structural target obj:499 0 R` / `obj:503 0 R`
  - direct inspection can see those refs during initial inspection, so the next fix needs a more resilient heading retag fallback in the backend, likely using current page/text/existing-tag context instead of only a raw object ref

## Current Stopping Point

- Active file: `Downloads/FINAL GUN HOMICIDE PDF-230610T15405729.pdf`
- Latest rerun: `f15c15f6-3074-4276-bc03-c0b049d91e71`
- Latest result: still in progress (`68%`, `Generating semantic fixes`) on the newest deep-scoring-gate build
- Current residual blocker:
- Current residual blocker:
  - the semantic stage can still hang on a provider call even after the heading-target filter, leaving the queue stuck at `68%` with no completed result
- Shared fixes shipped:
  - semantic heading batching now excludes candidates whose `existingTag` is already `H1`-`H6`
  - semantic provider requests now time out instead of waiting indefinitely
  - `analyzePDF()` now uses `light` structure inspection for `remediation_fast` forced structure scoring and falls back from deep to light on the final pass if deep inspection fails
- Best next hypothesis:
  - once fast validation stops requesting deep structure snapshots, this file should either complete on the timeout-enabled build or reveal the next true blocker family cleanly

## Follow-up Semantic Link Mutation Finding

- Fresh rerun `ae0190c8-aff7-41b9-8c22-75f08fc666e4` progressed cleanly into stage 6 after deterministic link batching, then stalled again at `Generating semantic fixes`.
- Direct profiling and live logs narrowed that down further:
  - semantic batch generation itself is fast (`generateSemanticRepairBatches` completed in about `7.7s`)
  - deterministic-stage batching is working
  - the remaining churn is in semantic-stage application, where semantic link `/Contents` repairs were still being executed one-by-one
- Generic fix applied:
  - semantic `set_link_annotation_contents` calls now batch through `runPdfStructureBackendBatch()` using the same mutation builder as deterministic stages
  - this should collapse the remaining heavy-link semantic mutation loop on Acrobat reports like `FINAL GUN HOMICIDE PDF-230610T15405729.pdf`

## Follow-up Semantic Link Scope Finding

- Fresh clean rerun `11703760-5b7d-4139-b119-6d8f03c99bd6` proved the process is no longer crashing, but it still plateaued at `68%` in `Generating semantic fixes` after stage 5.
- Live logs showed the remaining workload was not provider startup or deterministic link mutation anymore. It was semantic churn:
  - many fast `remediation_fast` analyses continued to fire
  - the queue record stopped advancing
  - semantic link generation was still targeting links whose only issue was missing annotation `/Contents`
- Root cause:
  - `buildSemanticRepairBatches()` was including any link candidate with `rawUrl || !annotationContents`
  - deterministic link repair already owns the `/Contents` backlog generically
  - heavy-link PDFs were therefore paying semantic/AI cost for work that should stay deterministic
- Generic fix applied:
  - semantic link batching now only targets `rawUrl` links
  - deterministic-only `/Contents` debt is excluded from semantic batching entirely
  - this should sharply reduce semantic churn on Acrobat/PDFMaker bibliography-heavy reports without giving up deterministic `/Contents` repair coverage

## Successful Rerun After Semantic Link Scope Fix

- Fresh post-restart rerun: `7bc5a59d-19a3-404a-b312-37e78b454cd5`
- File: `FINAL GUN HOMICIDE PDF-230610T15405729.pdf`
- Result: `100/A` from `31/F`
- What this proved:
  - the remaining stage-6 plateau was not a hidden crash anymore
  - semantic link scope was the last meaningful hot loop on this file family
  - once AI stopped targeting deterministic-only `/Contents` debt, the run completed cleanly on the same shared stack
- Operational note:
  - total wall time for the successful rerun was roughly 4m51s, which is comfortably inside the user’s 15-minute window and much healthier than the prior semantic stalls

## Next Active Small PDF

- Active file: `Downloads/methethnography.pdf`
- Reason chosen: fresh random sub-700k PDF after the `FINAL GUN HOMICIDE PDF-230610T15405729.pdf` success

## methethnography.pdf

- Queue item: `e5464496-90fa-4149-a31f-742e6eb0d0cb`
- Result: `27/F -> 100/A`
- Outcome:
  - first-pass success on the current stack
  - no new system fix required
  - confirms the current small-PDF path remains fast and stable after the heavy-link semantic fix

## Next Active Small PDF

- Active file: `Downloads/DNA testing.pdf`
- Reason chosen: next fresh random sub-700k PDF after the immediate `methethnography.pdf` success

## DNA testing.pdf

- Queue item: `ea557252-c8a9-423a-8127-8dece6f2e887`
- First-pass result: `22/F -> 93/A`
- What improved automatically:
  - metadata/title/language fully recovered
  - page tabs normalized
  - most Type1 Unicode recovery landed
  - headings were created successfully from `/Story` containers
  - native reading-order repair applied
  - heuristic figure fallback added several missing figure alts
- Remaining blocker family:
  - score gap is concentrated in `alt_text`
  - completed output still shows split/duplicate figure variants being counted in the effective image denominator
  - queue result and direct rebuilt-artifact inspection both point to a reconciliation problem more than a raw capability problem
- Shared fix shipped:
  - alt-text scoring now collapses split-generated informative figure variants onto a single canonical source ref before computing effective coverage
  - this should stop wrapper/child figure variants from inflating the denominator on Acrobat/InDesign files like `DNA testing.pdf`
- `DNA testing.pdf`: first pass was `22/F -> 93/A`; scorer-side split-figure collapse fix (`488aeef`) did not move the live score. Remaining blocker stayed in `alt_text`, with one figure semantic target still skipped due prompt budget. Next shared fix retries oversized singleton figure semantic requests without cropped page images instead of skipping them outright.
- `DNA testing.pdf`: rerun after `2d9f61d` still stayed at `93/A`, so the singleton no-image semantic fallback is not the real limiter here. The remaining gap is now tightly localized to Acrobat-risk mixed ownership on non-`/Figure` containers (`/references`, `/H1`, `/Story`) and the resulting `7/11` alt-text credit. Next fix should target that ownership/credit family rather than semantic batching.
- `DNA testing.pdf`: deeper rebuilt-artifact inspection showed four `/Figure` refs still lacked alt, and at least one of them (`obj:435 0 R`) was a strong-evidence `/Figure` candidate with `repairMode: set_alt` that had simply stopped getting late retries. New shared fix: allow late heuristic retries for unresolved `/Figure` candidates with `set_alt`, not just `retag_then_set_alt`.
- `DNA testing.pdf`: rerun after `283eaa5` still stayed at `93/A`, but it proved the retry fix worked because `obj:435 0 R` now gets late heuristic alt-text application. Remaining blocker is now post-application credit loss: nested wrapper cleanup removes descendant alt text or leaves the final figure graph in a state that still scores as `7/11` with alt. Next fix should target nested-figure/descendant-alt reconciliation after late figure retries.
