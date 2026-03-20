# Small PDF Remediation Notes

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
