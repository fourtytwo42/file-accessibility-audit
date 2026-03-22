# PDF Remediation Runbook

This repository supports a long-running remediation workflow over PDFs stored in `Downloads/`.

## Mantra

- ABI: Always Be Improving.
- The primary goal is to get every PDF in `Downloads/` to a validated score above `90/100` and place the successful output in `Complete/`.
- The secondary goal is to improve the shared API remediation system so future PDFs benefit from each general fix without regression.
- The goal is not only to mitigate individual PDFs, but to continuously improve the shared remediation system so future PDFs pass with less manual intervention.
- Default posture: continue the remediation campaign unless a real blocker prevents progress.
- Status updates, summaries, checkpoints, commits, pushes, restarts, and partial successes are not stopping conditions.
- Do not stop after reporting progress. Keep moving to the next rerun, next analysis step, or next system fix.

## Scope

- Input folder: `Downloads/`
- Final output folder: `Complete/`
- Intermediate work folder: `MitigationAttempts/`
- Progress tracker: `REMEDIATION_PROGRESS.md`
- Default branch for work: current active remediation branch

## File Scheduling

- Default processing order is alphabetical by filename unless a specific priority is recorded in `REMEDIATION_PROGRESS.md`.
- Prefer one active PDF at a time by default.
- Increase parallelism only when CPU/memory conditions support it.
- If concurrency is raised, record the reason and active file set in `REMEDIATION_PROGRESS.md`.
- When running in parallel, the target operating mode is up to 4 PDFs at a time unless system load requires less.

## Core Rules

- Do not edit PDFs directly by hand.
- Do not mutate source PDFs in `Downloads/`.
- Use the API remediation/audit pipeline to produce remediated PDFs.
- Treat every PDF as a system test case for the broader product goal: the app should be able to remediate PDFs to Adobe accessibility standards generically, not just through one-off file-specific fixes.
- Avoid regressions: a change that helps one PDF but weakens other PDFs or document classes is incomplete until the shared system is stable again.
- If a PDF does not reach `>90/100`, determine why from the API results and improve the system itself:
  - API services
  - remediation planner
  - scoring/reporting
  - Python PDF structure helper scripts
- Re-run remediation after each system improvement until the PDF reaches the current campaign target and is ready for `Complete/`.

## Output Rules

- Only place PDFs in `Complete/` when they have reached a validated score above `90/100` per this app's API analysis and passed the visual first-page check.
- Keep exactly one final completed copy per source PDF in `Complete/`.
- Use `MitigationAttempts/` for temporary reruns, experimental outputs, and investigation artifacts.
- Do not keep duplicate final copies in `Complete/`.
- Do not move a file into `Complete/` unless all stop gates in this document are satisfied.

## Naming Rules

- Preserve the original filename for the final passing copy placed in `Complete/`.
- Store intermediate attempts under a per-file subfolder in `MitigationAttempts/`.
- Default attempt layout:
  - `MitigationAttempts/<base-name>/attempt-001.pdf`
  - `MitigationAttempts/<base-name>/attempt-002.pdf`
- Keep related diagnostics or comparison artifacts with the same per-file attempt folder when helpful.

## Quality Standard

- The target for every PDF in `Downloads/` is:
  - overall score strictly above `90/100`
  - grade `A` when achievable; otherwise preserve the highest validated score above `90`
  - no unresolved Adobe accessibility-checker failures
- The broader product target is that these standards should be achievable by the app across the corpus without causing regressions on PDFs that already passed.
- `veraPDF` is deprecated in this repository and must not be used as an acceptance gate.
- A mitigation is not considered successful unless the remediated PDF also visually matches the original on the first page.
- Validate visual fidelity by taking a screenshot of page 1 of the original PDF and page 1 of the remediated PDF and comparing them directly.
- Pay special attention to images, logos, charts, and obvious layout/content loss on the first page.
- If the first page does not visually match, the mitigation is not complete even if the score is above `90/100`.
- If visual fidelity regresses, update the remediation approach and re-run until the PDF is both accessible and visually faithful.
- Bookmark cleanup should be AI-driven for long/noisy documents when semantic cleanup is available.
- If bookmarks are still raw, fragmented, OCR-noisy, or obviously not AI-cleaned, treat that as an incomplete remediation/system issue and improve the pipeline.
- If Adobe-specific issues are discovered from manual validation, update detection and repair logic so the system catches and fixes that class of issue in future runs too.
- If code has changed but the queue result still reflects older behavior, restart the API and re-run remediation before judging the latest system state.

## Improvement Loop

For each PDF:

1. Run remediation through the API.
2. Analyze the result.
3. If the PDF reaches the current score target, take screenshots of page 1 of the original and remediated PDFs and compare them.
4. Check the remediated first page yourself, especially images and obvious visual structure.
5. Confirm bookmark cleanup used the intended AI path when applicable and that the resulting bookmarks are clean.
6. If the PDF is not above `90/100`, or if the first page does not visually match, or if the bookmarks are not properly AI-cleaned, identify the exact blockers.
7. Patch the API/tooling so that the blocker is handled generically, not just for one file, and verify that the change does not regress previously-working PDFs.
8. Re-run the same PDF through the API.
9. Repeat until the output is above `90/100`, the first page visually matches the original, and bookmarks are acceptable.
10. Move the single final passing PDF into `Complete/`.
11. If a file still fails after multiple repair loops, document the exact blockers in `REMEDIATION_PROGRESS.md`, keep it out of `Complete/`, and continue improving the shared system.

Continuous execution rule:

- After each checkpoint, continue immediately with the next concrete action.
- After each system fix, continue immediately with verification, restart/rerun if needed, and the next remediation loop.
- After each passing file, continue immediately to the next queued file or blocker family.
- Only stop the campaign when:
  - every PDF in `Downloads/` satisfies all stop gates, or
  - a hard blocker prevents further progress in the current environment, or
  - the user explicitly pauses or stops the work.

## Retry / Escalation Checkpoints

- After every unsuccessful loop, record the current hypothesis and blocker summary in `REMEDIATION_PROGRESS.md`.
- After 3 unsuccessful repair loops on the same PDF, pause and summarize:
  - what improved
  - what still fails
  - what the next system-level hypothesis is
- Do not keep repeating identical reruns without a new system change or a clearly stated new hypothesis.
- A checkpoint is not a stop. Record it, then continue with the next hypothesis in the same session.

## Regression Verification Policy

- Do not rely on full historical reruns for every change.
- Use layered verification so regressions are caught quickly without turning every system fix into an all-day corpus replay.

Verification levels:

- Low-risk change:
  - examples: isolated scoring copy tweaks, narrow reporting text changes, small detector refinements with tight fixture coverage
  - required checks:
    - targeted unit/integration tests for the changed area
    - `pnpm verify:regressions`
- Medium-risk change:
  - examples: scorer logic changes, local-standards changes, planner selection changes, failure-profile/reporting contract changes
  - required checks:
    - targeted tests for the changed area
    - `pnpm verify:regressions`
    - rerun the active PDF or active blocker-family PDF after restart when the runtime path is affected
- High-risk change:
  - examples: qpdf parser changes, Python structure-helper mutations, stage acceptance/rollback changes, broad planner routing changes, shared remediation tool behavior changes
  - required checks:
    - targeted tests for the changed area
    - `pnpm verify:regressions`
    - fresh rerun of the active PDF or blocker-family PDF after restart
    - fresh full Phase 0 baseline rerun when the change can affect corpus-wide scoring or planner behavior

Default commands:

- Fast regression lock:
  - `pnpm verify:regressions`
- Fresh canary artifact:
  - `pnpm baseline:phase0:canary`
- Fresh full source baseline:
  - `pnpm baseline:phase0`
- Artifact comparison:
  - `pnpm baseline:phase0:compare`

What the fast regression lock protects:

- failure-profile/reporting contract stability
- Phase 0 blessed artifact comparison
- canary structural-class coverage
- canary expectation loss
- false high-score increases that the comparator can detect

Canary policy:

- Prefer the canary set for routine regression checking.
- The canary set must keep coverage across the major PDF classes and blocker families.
- When a PDF exposes a new blocker family, either:
  - add a focused test fixture for the underlying bug, or
  - promote that PDF family into canary coverage if it represents a shared regression risk

Full baseline policy:

- Do not rerun the full historical baseline after every fix.
- Run a fresh full baseline when:
  - parser behavior changes
  - structure-helper mutation behavior changes
  - scorer category logic changes in a broad way
  - planner/routing changes can alter corpus-wide opportunity selection
  - a fix is intended to reduce false high-score passes across the corpus

Acceptance rule for system fixes:

- A system fix is not complete just because the active PDF improved.
- A fix is complete when:
  - the active blocker is improved or clarified
  - targeted tests pass
  - the required regression lock for the risk level passes
  - previously-working PDFs or canaries have not regressed

## Stop Gates

A PDF is only complete when all of the following are true:

- API result is above `90/100`
- Grade is recorded, with `A` preferred but not required when the score threshold is satisfied
- No unresolved Adobe accessibility-checker failures remain for the latest validated output
- The latest run was produced after the latest relevant code changes
- Page 1 screenshot of the remediated PDF visually matches page 1 of the original
- No missing images, broken charts, blank rendering, or obvious page-1 text loss are visible
- Bookmarks are semantically acceptable
- AI bookmark cleanup was used when applicable
- The final passing file has been placed in `Complete/`
- The result and any important blockers/fixes have been recorded in `REMEDIATION_PROGRESS.md`

## Resume Checklist

When resuming after interruption or context compression:

1. Open `REMEDIATION_PROGRESS.md`.
2. Read `Current Session Snapshot`.
3. Read `Current Focus`, `Blockers`, `Retry Checkpoint`, and `Unresolved Files`.
4. Confirm the active file, latest attempt path, and next hypothesis.
5. Confirm API health before trusting new remediation results.
6. Confirm whether the next step is:
   - rerun after restart
   - inspect latest failed output
   - apply a new system fix
   - validate a candidate passing output
7. Continue from the recorded next hypothesis rather than restarting analysis from scratch.
8. Resume active remediation immediately after the recap; do not end the session at a state summary.

## Progress Tracking

- Maintain progress in `REMEDIATION_PROGRESS.md`.
- Check `REMEDIATION_PROGRESS.md` frequently during the task and keep it current.
- Use the tracker to preserve momentum, not to pause work.
- Update it when:
  - starting a new PDF
  - identifying blockers
  - changing concurrency strategy
  - making a system-level fix
  - completing a PDF
- Track at minimum:
  - pending files
  - active file
  - current blockers
  - recent system fixes
  - completed files above `90/100` moved to `Complete/`
  - unresolved files that are still blocked
  - whether API restart/rerun confirmation has been completed for the active file
  - the current remediation loop count for the active PDF
  - the next hypothesis for the active PDF
  - the latest attempt path
  - the latest validation summary

## Git Workflow

- After every API or remediation-script change made to fix a PDF, create a git commit.
- After each such commit, push the branch to GitHub.
- These commit/push steps apply to system-fix changes in API code, services, planners, scorers, scripts, and helpers.
- Keep commit messages specific to the repair or system improvement that was made.
- Continue to avoid overwriting unrelated user changes.
- Before commit/push, run the most relevant targeted verification available for the change.
- Record the verification result in `REMEDIATION_PROGRESS.md`.
- Use one commit per distinct system fix, not one commit per remediation rerun.
- Do not create commits for retrying a PDF when no code or script change was made.

## Visual Validation

- Compare page-1 screenshots of the original and remediated PDFs after a passing remediation run.
- Focus on:
  - missing or replaced images
  - broken charts/graphics
  - layout shifts
  - blank or partially blank rendering
  - obvious text loss on the first page
- Treat the following as a visual failure:
  - missing logo or hero image
  - chart/graphic replaced, removed, or obviously altered
  - large movement of page-1 blocks that changes the document's look materially
  - page rendered mostly white or partially blank
- If the first page fails visual comparison, do not consider the PDF done.
- Update the remediation logic to preserve visual fidelity while keeping the file above `90/100`.

## Bookmark Validation

- Do not assume bookmark cleanup worked just because bookmarks exist.
- Verify that bookmark titles are semantically cleaned and not raw OCR fragments, line-wrap junk, or table-of-contents dot leaders.
- Prefer AI-cleaned bookmark titles for long documents with noisy headings.
- If the system falls back to raw heading bookmarks when AI cleanup should have run, treat that as a pipeline bug and fix it.
- Treat the following as bookmark failures:
  - OCR fragments
  - duplicated junk titles
  - wrapped page numbers or dot leaders in titles
  - sentence fragments that should be section labels
  - raw table-of-contents lines copied directly into the outline

## Restart / Rerun Validation

- After any relevant API/service/script change, ensure the API has been restarted before evaluating a new queue result.
- Prefer a fresh remediation run over `Re-analyze` when validating a new fix.
- Record in `REMEDIATION_PROGRESS.md` whether the result being evaluated came from:
  - an old run
  - a rerun after restart
  - a fresh upload/remediation cycle

## Parallel Restart Discipline

- When processing up to 4 PDFs in parallel, be deliberate about restart timing.
- Do not restart the API casually while active remediations are in flight.
- Before restarting during parallel work:
  - record which PDFs are currently in flight
  - note which results may have been produced by old code
  - expect to rerun affected PDFs after restart
- Prefer restart boundaries between concurrency waves rather than mid-wave.
- If a system fix is important enough to justify an immediate restart, treat any in-flight or just-finished results from the previous process as stale until rerun.
- Record restart timing and impacted PDFs in `REMEDIATION_PROGRESS.md`.

## Build / Restart Rules

- After changes to API code, remediation services, scorers, planners, or Python helper scripts, restart the API before evaluating results.
- Default assumption for this repository:
  - restart is required
  - rebuild is usually not required for normal source-based local operation
- If the runtime is serving compiled or stale built output instead of live source, rebuild before restart.
- When uncertain, use this order:
  1. restart the API
  2. run a fresh remediation
  3. if behavior still looks stale, determine whether a rebuild is needed
- Do not treat `Re-analyze` as proof that a remediation fix worked; prefer a fresh remediation run.
- Record in `REMEDIATION_PROGRESS.md`:
  - whether restart was completed
  - whether rebuild was required
  - the command or mechanism used
  - whether the next result came from a fresh remediation after restart

## Performance / Concurrency

- Monitor API/server CPU and memory usage while processing batches.
- Adjust concurrency downward when CPU or memory pressure rises.
- Prefer stable throughput over maximum parallelism.
- If the server is under strain, process fewer PDFs at once.
- If the server is healthy, cautiously increase concurrency.
- Record concurrency changes in `REMEDIATION_PROGRESS.md`.

## Safety / Repository Hygiene

- Keep generated PDFs and attempt folders out of git.
- Do not remove or overwrite unrelated user changes.
- Prefer deterministic, reusable fixes over one-off hacks.
- Treat every difficult PDF as a chance to improve the shared remediation system.

## Unresolved Files

- If a PDF cannot yet be brought above `90/100` with acceptable first-page fidelity and bookmarks, do not move it to `Complete/`.
- Keep the latest investigation notes and blocker summary in `REMEDIATION_PROGRESS.md`.
- Continue using the file to improve the system generically.

## This Setup Task

This document only defines the rules and folder layout.
It does not itself start the batch remediation task.
