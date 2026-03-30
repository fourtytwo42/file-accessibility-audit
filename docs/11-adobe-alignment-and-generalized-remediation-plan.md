# Adobe Alignment and Generalized PDF Remediation Plan

## Purpose

This document turns the current findings into an implementation plan we can execute in small, testable slices.

The two core problems we need to solve are:

1. Our app can return `100/100` even when Adobe Acrobat Accessibility Checker still fails the PDF.
2. Our remediation pipeline is not general enough, so changes that help one document type can regress others.

The target state is a remediation system that:

- Scores PDFs in a way that better matches real-world validators, especially Adobe and `veraPDF`
- Repairs common failures generically instead of file-by-file
- Chooses tools based on PDF type and actual failure modes
- Detects regressions early and isolates the tool that caused them
- Stays stable across scanned, untagged-digital, partially tagged, and native-tagged PDFs

---

## Evidence Summary

Based on the current analysis of the Adobe reports in `3rdPass/Reports/`:

- 20 of 21 PDFs that scored `100/100` in our app still failed Adobe Accessibility Checker
- The dominant Adobe failure categories were:
  - `Figures alternate text`
  - `Other elements alternate text`
  - `Tagged annotations`
  - `Character encoding`
  - `Nested alternate text`
  - `Table regularity`

This tells us the issue is not just a few bad remediations. It is a system design gap between:

- what our scorer currently rewards
- what our remediation tools actually fix
- what Adobe treats as blocking

---

## Root Causes

### 1. Scoring gaps create false passes

Several issue classes are detected somewhere in the pipeline but do not reliably reduce the final score or block `100/100`.

Examples:

- Untagged rendered images can exist even when tagged `/Figure` elements do not
- Non-`/Figure` elements can carry invalid `/Alt`
- Annotations can be visible but not actually owned by the structure tree
- Fonts can be missing `/ToUnicode` maps without materially affecting our current score
- Nested `/Alt` can hide child semantic content
- Table irregularity can be noted without being score-blocking

### 2. Tool selection is too coarse

The planner still behaves too much like "run many safe-looking tools early" rather than "apply the minimum valid repair set for this PDF class and failure profile."

That makes some tools look successful on one family of PDFs while being destructive on another.

### 3. Structural classification is underused

We already have more nuanced structural classification available, but the planner still leans on broad binary gates such as `alreadyTaggedNative`.

That collapses very different PDFs into the same path.

### 4. Regression handling is too late and too broad

We often discover regressions only after an entire stage runs. At that point the rollback is too coarse, and we still do not know which tool caused the damage.

### 5. Remediation capability and scoring are out of sync

Some issue classes are score-visible but not fully repairable, while others are repairable but not strongly reflected in the score. That creates inconsistent system behavior.

---

## Guidance from `Research/`

The projects reviewed in `Research/` point toward a more reliable architecture:

- Prefer modular processors with narrow responsibilities
- Keep semantic generation separate from structural mutation where possible
- Use geometry and actual rendered content as fallback evidence, not only tag inspection
- Continue after non-fatal processor failures and record warnings instead of collapsing the whole pipeline
- Make routing deterministic for native/structural repairs, and reserve AI for semantic ambiguity

These principles inform the plan below.

---

## Strategic Goals

### Goal A: Make `100/100` credible

If our app says a PDF is complete, it should be very unlikely to fail Adobe for known, machine-detectable reasons.

### Goal B: Make remediation more general

A system fix should help a class of PDFs, not just the active file.

### Goal C: Reduce regressions

Repairs should be selected by failure mode and PDF class, and regressions should be attributable to a specific tool or mutation step.

### Goal D: Keep the system shippable during improvement

Each phase below is designed to be independently implementable, testable, and committable.

---

## Phase 0: Baseline and Measurement

### Goal

Establish a repeatable baseline so we can measure whether changes actually improve Adobe alignment and reduce regressions.

### Why this phase matters

Before changing scoring or planner behavior, we need a stable way to answer:

- Did Adobe-alignment improve?
- Did the number of false `100/100` passes decrease?
- Did we break previously good remediations?

### Work

- Create a baseline matrix for the current sample set:
  - source file
  - app score
  - app grade
  - `veraPDF` status
  - Adobe failed checks
  - structural class
  - remediation path taken
- Group the 21 sampled PDFs by type:
  - scanned
  - untagged digital
  - partially tagged
  - native tagged
  - well tagged
- Identify a smaller "canary" set for fast iteration:
  - at least one PDF for each major structural class
  - at least one PDF with annotation issues
  - at least one PDF with image-alt issues
  - at least one PDF with font/encoding issues

### Likely touchpoints

- `REMEDIATION_PROGRESS.md`
- internal scripts or ad hoc verification helpers under `scripts/`
- analysis/reporting code if we want reusable baselines

### Deliverables

- A baseline table checked into docs or progress tracking
- A named canary set we can reuse after each phase
- A quick verification recipe for rerunning the same comparisons

### Acceptance criteria

- We can compare pre-change and post-change results for the same PDFs without ambiguity
- We can quickly tell whether a phase reduced false passes or caused new regressions

---

## Phase 1: Close the Scoring Gaps

### Goal

Make the scorer stop granting `100/100` when Adobe-visible structural failures are still present.

### Expected impact

This phase should eliminate the majority of false-passing scores even before all remediation tools are improved.

### Phase 1A: Figures alternate text false-pass

#### Problem

`scoreAltText()` or the Acrobat-risk overlay path can return `null` / not-applicable when there are no tagged figures, even though rendered images still exist and Adobe flags them.

#### Planned changes

- In [scorer.ts](/home/hendo420/pdfaf/apps/api/src/services/scorer.ts), when the base alt-text category would be `null` but unresolved `untagged_image_*` risk nodes exist, force the category into a failing state instead of `N/A`
- Add a local standards finding for unresolved untagged rendered images in [localStandardsService.ts](/home/hendo420/pdfaf/apps/api/src/services/localStandardsService.ts)
- Ensure this finding blocks "clean standards" behavior and prevents a perfect score

#### Why this matters

This appears to be the single biggest false-pass category in the sampled Adobe reports.

#### Acceptance criteria

- PDFs with unresolved rendered-image alt risks cannot receive `100/100`
- The alt-text category becomes meaningfully scored instead of disappearing as `N/A`
- The failure profile clearly records the reason

### Phase 1B: Other elements alternate text

#### Problem

Elements that are not `/Figure` or `/Formula` can still carry `/Alt`, which Adobe flags, but our score can still round up to `100`.

#### Planned changes

- Add a blocking standards finding for `nonfigure_with_alt`
- Cap or fail the affected category when unresolved invalid `/Alt` ownership remains
- Ensure this issue is visible in the failure profile and executive summary

#### Acceptance criteria

- PDFs with invalid non-figure `/Alt` usage cannot pass as complete

### Phase 1C: Tagged annotations

#### Problem

We check tab order, but not whether visible annotations are actually connected to the structure tree through `/StructParent` and the ParentTree.

#### Planned changes

- Extend [tabOrderService.ts](/home/hendo420/pdfaf/apps/api/src/services/tabOrderService.ts) to count annotations that are visible but structurally unowned
- Feed `unownedAnnotationCount` into [scorer.ts](/home/hendo420/pdfaf/apps/api/src/services/scorer.ts)
- Add a blocking local standards finding for untagged annotations

#### Acceptance criteria

- PDFs with unowned visible annotations cannot silently pass reading-order checks
- The failure profile maps these cases to a repairable issue class

### Phase 1D: Character encoding

#### Problem

Fonts missing `/ToUnicode` maps are already observable in analysis, but they do not currently reduce the score strongly enough.

#### Planned changes

- Penalize text extractability in [scorer.ts](/home/hendo420/pdfaf/apps/api/src/services/scorer.ts) when `fontsMissingToUnicode` is non-empty
- Add configuration constants in [audit.config.ts](/home/hendo420/pdfaf/audit.config.ts) for mild versus severe caps

#### Acceptance criteria

- Missing `/ToUnicode` maps are reflected in the final score
- More missing fonts causes a larger penalty than isolated cases

### Phase 1E: Nested alternate text

#### Problem

A parent `/Figure` can carry `/Alt` while also containing child structure content. Adobe can treat this as hidden child content, but we do not currently detect it.

#### Planned changes

- Add nested-alt detection in [pdf_structure_helper.py](/home/hendo420/pdfaf/apps/api/scripts/pdf_structure_helper.py)
- Extend backend types in [pdfStructureBackend.ts](/home/hendo420/pdfaf/apps/api/src/services/pdfStructureBackend.ts)
- Treat `nested_alt_text_hides_content` as a substantive blocker in [scorer.ts](/home/hendo420/pdfaf/apps/api/src/services/scorer.ts)

#### Acceptance criteria

- Nested alt cases become explicit findings instead of invisible pass-throughs

### Phase 1F: Config and thresholds

#### Planned changes

Add explicit constants in [audit.config.ts](/home/hendo420/pdfaf/audit.config.ts) for:

- untagged rendered image alt score cap
- non-figure alt score cap
- unowned annotation score cap
- character encoding score caps
- any related standards thresholds needed to keep the behavior predictable

### Test plan for Phase 1

- Add and update tests in:
  - [scorer.test.ts](/home/hendo420/pdfaf/apps/api/src/services/scorer.test.ts)
  - [localStandardsService.test.ts](/home/hendo420/pdfaf/apps/api/src/services/localStandardsService.test.ts)
  - any failure-profile tests impacted by new findings
- Verify that the previously false-passing sample PDFs no longer score `100/100`
- Confirm that PDFs already known to be correct do not get over-penalized

### Phase 1 completion criteria

- `100/100` is much harder to obtain falsely
- Known Adobe-visible issue classes now reduce score or block clean-pass status
- The canary set shows fewer false positives without obvious regressions

---

## Phase 2: Close the Remediation Gaps

### Goal

Make the pipeline able to repair the newly surfaced blocking issues, not just detect them.

### Why this phase matters

Phase 1 makes scoring more honest. Phase 2 makes the system more capable so those new failures can be resolved automatically.

### Phase 2A: Untagged image remediation

#### Current state

The planner already has some support for `repair_other_elements_alt_text`, but the issue is not consistently surfaced as a hard failure today.

#### Planned changes

- Reuse the existing tool path for `untagged_image_mcid` and `untagged_image_direct`
- Verify the failure-profile mapping is strong enough that the planner reliably selects the tool when appropriate
- Avoid adding risky final-cleanup behavior that would over-apply late in the plan

#### Acceptance criteria

- A PDF that fails due to untagged rendered images can now both fail honestly and improve via remediation

### Phase 2B: Tagged annotation remediation

#### Problem

We can detect the issue after Phase 1C, but we do not yet have a generic repair for connecting unowned annotations into the structure tree.

#### Planned changes

- Add `mutate_tag_unowned_annotations()` in [pdf_structure_helper.py](/home/hendo420/pdfaf/apps/api/scripts/pdf_structure_helper.py)
- Register a new `tag_unowned_annotations` tool in [pdfRemediationTools.ts](/home/hendo420/pdfaf/apps/api/src/services/pdfRemediationTools.ts)
- Map the standards finding to the new tool in [failureProfileService.ts](/home/hendo420/pdfaf/apps/api/src/services/failureProfileService.ts)
- Add planner support in [remediationPlanService.ts](/home/hendo420/pdfaf/apps/api/src/services/remediationPlanService.ts)

#### Acceptance criteria

- PDFs with unowned annotations can be auto-remediated without manual file-specific logic

### Phase 2C: Nested alt remediation

#### Planned changes

- Extend `repair_other_elements_alt_text` or related helper logic so parent `/Alt` is removed or normalized when it incorrectly hides child semantic content
- Preserve valid child semantics while avoiding destructive flattening

#### Acceptance criteria

- Nested-alt failures can be corrected without degrading legitimate figure semantics

### Phase 2D: Table regularity follow-through

#### Problem

Some table irregularity cases are already recognized but not treated strongly enough in scoring or planning.

#### Planned changes

- Decide whether table regularity belongs in scoring, standards findings, remediation routing, or all three
- Ensure irregular-table findings cannot be silently ignored when they are structurally material
- Only auto-repair if we can do so safely; otherwise make the manual/semantic boundary explicit

#### Acceptance criteria

- Table irregularity is consistently categorized as either auto-repairable or a clear blocker

### Test plan for Phase 2

- Add targeted tests for:
  - annotation tagging mutations
  - nested-alt mutation safety
  - failure-profile to tool mapping
  - planner selection for these issue classes
- Run remediation on the canary set and compare:
  - score
  - Adobe-visible blockers
  - visual fidelity on page 1

### Phase 2 completion criteria

- The system can repair more of the now-visible failures
- Newly surfaced blockers are no longer dead ends

---

## Phase 3: Make Planning Type-Aware and More General

### Goal

Reduce cross-file regressions by making tool selection depend on PDF structure class and concrete evidence.

### Why this phase matters

This is the main generalization phase. It is how we stop solving one file by accidentally damaging another family of PDFs.

### Phase 3A: Replace binary gating with structural-class-aware routing

#### Problem

`alreadyTaggedNative` is too coarse for real-world PDFs.

#### Planned changes

- Use the existing `PdfStructuralClass` more directly in [remediationPlanService.ts](/home/hendo420/pdfaf/apps/api/src/services/remediationPlanService.ts)
- Pass structural class through the remediation context so planner logic can make informed decisions
- Introduce class-aware defaults such as:
  - `well_tagged`: avoid bootstrap and broad conformance rewrites
  - `native_tagged`: run only narrowly justified structural repairs
  - `partially_tagged`: prefer targeted augmentation over rebuild-style tools
  - `untagged_digital` and `scanned`: allow more foundational structure tools when evidence supports it

#### Acceptance criteria

- The same tool is no longer treated as equally safe across all PDF classes

### Phase 3B: Class-specific tool reliability

#### Problem

Tool reliability is effectively global, even though actual success and risk vary by PDF type.

#### Planned changes

- Extend [toolReliabilityService.ts](/home/hendo420/pdfaf/apps/api/src/services/toolReliabilityService.ts) to report reliability by structural class
- Let [remediationPlanService.ts](/home/hendo420/pdfaf/apps/api/src/services/remediationPlanService.ts) consult class-specific reliability before selecting risky tools
- Add configurable thresholds in [audit.config.ts](/home/hendo420/pdfaf/audit.config.ts)

#### Acceptance criteria

- A tool with poor historical outcomes on native-tagged PDFs is automatically deprioritized or skipped there, even if it remains useful on scanned PDFs

### Phase 3C: Evidence-driven minimum viable repair sets

#### Problem

The planner still tends to over-apply tools early.

#### Planned changes

- Shift planner logic from "run all likely-safe tools in the stage" toward "run the minimum tool set justified by the current failure profile"
- Tighten opportunity gating so a tool must have:
  - a supporting failure mode
  - compatible structural class
  - acceptable reliability
  - no prior no-effect/rejected history for the same target

#### Acceptance criteria

- Plans become shorter, more explainable, and less destructive

### Test plan for Phase 3

- Compare planner output across mixed PDF classes for the same category failures
- Confirm that native-tagged PDFs avoid broad restructuring
- Confirm that untagged/scanned PDFs still get the foundational tools they need

### Phase 3 completion criteria

- Cross-file regressions are reduced
- The planner becomes more deterministic and easier to reason about

---

## Phase 4: Isolate Regressions to the Tool Level

### Goal

Detect which specific tool caused a regression instead of rolling back whole stages blindly.

### Why this phase matters

Without finer-grained isolation, every failure looks like a stage-level mystery. That slows debugging and makes the system feel inconsistent.

### Planned changes

- Update [agentRemediationService.ts](/home/hendo420/pdfaf/apps/api/src/services/agentRemediationService.ts) so stage rejection can isolate the regressing tool when a stage contains multiple tools
- Prefer per-tool fallback or retry-without-last-tool strategies before discarding an entire stage
- Record structured evidence about:
  - tool attempted
  - pre/post score deltas
  - failure-profile delta
  - visual or standards regressions introduced

### Optional extension

If needed, move toward a binary-search style isolation strategy for multi-tool stages.

### Acceptance criteria

- When a stage regresses, we can identify the likely offending tool with much higher confidence
- Regression history becomes useful planner input rather than just logging noise

### Test plan for Phase 4

- Unit tests around stage rejection behavior
- Simulated multi-tool stage where only one tool causes a regression
- Verification that the planner can avoid repeatedly choosing the known regressor

---

## Phase 5: Strengthen the Failure Profile and Reporting Contract

### Goal

Make the failure profile the source of truth that connects analysis, scoring, remediation planning, and post-run reporting.

### Why this phase matters

A generalized system needs one stable vocabulary for:

- what is wrong
- what is repairable
- what was attempted
- what improved
- what regressed

### Planned changes

- Ensure Adobe-aligned findings map into stable internal keys
- Make sure each blocking issue class includes:
  - severity
  - repairability
  - candidate scope
  - structural-class sensitivity
  - planner/tool mapping
- Improve reportability so we can tell why a PDF is not complete without reading ad hoc logs

### Likely touchpoints

- [failureProfileService.ts](/home/hendo420/pdfaf/apps/api/src/services/failureProfileService.ts)
- [scorer.ts](/home/hendo420/pdfaf/apps/api/src/services/scorer.ts)
- planner and remediation execution services

### Acceptance criteria

- The same issue class is described consistently across analysis, remediation, and scoring
- Reports become good enough to debug a failed remediation without manual source diving every time

---

## Phase 6: Verification, Canary Suite, and Regression Locks

### Goal

Keep the improved behavior stable after we ship each phase.

### Planned changes

- Build a canary verification suite that includes:
  - mixed structural classes
  - a known-good remediated PDF set
  - PDFs that previously false-passed
  - PDFs that historically regress under aggressive structure repairs
- Add tests covering:
  - scorer behavior
  - standards findings
  - failure-profile mapping
  - planner routing
  - tool-level regression isolation
- Add a verification checklist for every system-fix change:
  - targeted unit tests
  - restart confirmation
  - fresh remediation run
  - comparison against canary expectations

### Acceptance criteria

- We can catch score alignment regressions before they affect batch remediation
- We can detect when a planner or tool change helps one class and harms another

---

## Recommended Implementation Order

### Wave 1: Honesty first

1. Phase 0 baseline
2. Phase 1A figures alt-text scoring
3. Phase 1B non-figure alt scoring
4. Phase 1D character encoding scoring
5. Phase 1C tagged annotation scoring
6. Phase 1E nested alt scoring

Rationale:

- This quickly removes the biggest false `100/100` outcomes
- It gives us a more truthful platform before planner changes

### Wave 2: Repair what we now detect

1. Phase 2A untagged image remediation validation
2. Phase 2B tagged annotation repair tool
3. Phase 2C nested alt repair
4. Phase 2D table regularity follow-through

### Wave 3: Generalization and stability

1. Phase 3A structural-class-aware routing
2. Phase 3B class-specific reliability
3. Phase 3C minimum viable repair sets
4. Phase 4 tool-level regression isolation

### Wave 4: Long-term stability

1. Phase 5 stronger failure profile contract
2. Phase 6 canary suite and regression locks

---

## Success Metrics

We should consider this effort successful when all of the following trend in the right direction:

- Far fewer PDFs score `100/100` while still failing Adobe for known machine-detectable reasons
- Previously successful remediations stay successful after unrelated system fixes
- Planner output is shorter and more explainable
- Native-tagged PDFs suffer fewer destructive structure regressions
- The canary suite becomes a reliable early warning system

Suggested measurable targets:

- False `100/100` pass rate on the sample Adobe set drops sharply from the current baseline
- Regression rate on the canary set decreases after Phase 3
- Planner attempts per successful remediation decrease for stable document classes

---

## Risks and Watchouts

### Risk 1: Over-correcting the scorer

If we tighten scoring too aggressively without enough nuance, we may create false failures.

Mitigation:

- Use the canary set
- Keep category caps configurable
- Prefer evidence-driven penalties rather than blanket deductions

### Risk 2: Safe-on-scanned, risky-on-native tools

Some tools are genuinely useful on low-structure PDFs but dangerous on native-tagged files.

Mitigation:

- Structural-class-aware routing
- Class-specific reliability thresholds

### Risk 3: Fixing score honesty before repair coverage

Phase 1 will likely increase the visible failure count before Phase 2 reduces it.

Mitigation:

- Treat that as expected and correct
- Message it internally as "more honest scoring," not regression

### Risk 4: Visual fidelity regressions

Some structural fixes can still damage layout or first-page rendering.

Mitigation:

- Keep visual validation in the stop gates
- Do not treat score alignment alone as success

---

## Working Rules During Implementation

- Every system-fix change should be committed separately
- Each commit should have targeted verification attached
- After each code change affecting remediation behavior, restart the API before evaluating a fresh rerun
- Do not judge a fix from stale results or from `Re-analyze` alone
- Record outcome and next hypothesis in `REMEDIATION_PROGRESS.md`

---

## Immediate Next Steps

1. Establish the Phase 0 baseline table for the sampled Adobe-report set.
2. Implement Phase 1A first, since it appears to be the largest false-pass category.
3. Add or update tests for Phase 1A before moving to the next scoring gap.
4. Re-run the canary set and compare score honesty versus the baseline.
5. Continue through the remaining Phase 1 items before moving into planner generalization.

---

## Summary

This plan intentionally separates three jobs that are currently too entangled:

1. scoring honestly
2. repairing effectively
3. choosing repairs safely

If we execute in that order, we should end up with a system that is much more aligned with Adobe, much less fragile across PDF types, and much easier to improve without breaking previous gains.
