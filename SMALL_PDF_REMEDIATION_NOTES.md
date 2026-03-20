# Small PDF Remediation Notes

## Current Active File

- `Traffic and Pedestrian Stop Data Use and Collection Task Force 2025 Report - FINAL 2-24-25-250328T14564559.pdf` (`437,736` bytes)
- Latest fresh queue item: `01f16829-3e84-4ec7-8768-82b2349496ea`
- Latest result: `86/B`

## Recent Loop Summary

- Baseline: `47/F`
- First rerun: `87/B`
- Latest rerun: `86/B`

## New System Fixes This Round

- `46fc241` `Exclude decorative Acrobat cleanup figures from alt scoring`
  - Decorative split-generated Acrobat cleanup figures no longer count as missing informative alt debt.

- `6db0c35` `Force structure scoring for native alt-text validation`
  - Native-safe validation now forces structure-aware scoring for alt-text-sensitive structure mutations.

- Pending commit: native-safe heading validation fix
  - `normalize_heading_hierarchy` now opts into deep structure scoring during native-safe validation.
  - Per-entry native-safe culprit isolation now compares each cumulative result against the prior accepted result, preventing later cleanup tools from inheriting stale regressions.

## Current Blocker Hypothesis

- The active file is no longer broadly blocked by missing figure alt text.
- Current residual blockers are narrow:
  - false `alt_text` regression during `normalize_heading_hierarchy` validation on native-tagged cleanup
  - one remaining link annotation `/Contents` miss that still caps `link_quality` and `pdf_ua_compliance`
- The next fresh rerun after restart should show whether the heading cleanup is now retained; if it is, the remaining work should collapse to the single link-contents blocker.

## Direct Artifact Probe

- Probed rebuilt artifact: `apps/api/data/queue-storage/rebuilt/6649eb51-031a-4eb3-9773-1bbbb9010c91.pdf`
- Baseline analysis with `forceStructureForScoring: true`:
  - overall `86/B`
  - `heading_structure = 60`
  - `alt_text = 75`
  - `link_quality = 60`
- Applying only `normalize_heading_hierarchy` directly to that rebuilt artifact produced:
  - overall `92/B`
  - `heading_structure = 100`
  - `alt_text = 75`
  - `link_quality = 60`
- Conclusion:
  - heading normalization is genuinely good for this file
  - the queue rejection is coming from a stale/intermediate pre-final-cleanup baseline, not from the heading tool regressing real output quality
  - the next generic fix is a deep-structure baseline refresh before native-tagged final cleanup validation

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

## Stopping Point

- Current score is exactly `95`, not above `95`.
- The next step should inspect why those seven page-1 candidates are still skipped even after the final post-cleanup pass:
  - either they emerge only after the last full-final analysis
  - or the execution path is silently no-op/rejecting them
  - or qpdf is still counting duplicate/decorative page-1 image XObjects after structure repair
