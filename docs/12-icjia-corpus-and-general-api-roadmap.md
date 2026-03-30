# ICJIA Corpus Completion And General PDF Accessibility API Roadmap

## Summary

This roadmap serves two linked goals:

1. Process the remaining ICJIA server-cache corpus to passing accessibility outcomes, allowing only minor non-blocking residuals such as color contrast.
2. Use the corpus work to extract a tight, fast, self-contained PDF accessibility grading and remediation API that can be dropped back into the original repository with minimal integration friction.

The core rule for both goals is:

- corpus progress must improve the reusable engine
- source-system updates must happen only after a file is fully mitigated and passes the replacement gate
- all progress must be benchmarked, cohort-aware, and traceable through explicit endgates

## Current Baseline

These numbers are the planning baseline for the next phases:

- Publication PDF rows mapped: `1056`
  Source: `ICJIA-PDFs/manifests/publication-pdf-replacement-map.summary.json`
- Source PDFs scanned and grouped: `910`
  Source: `ICJIA-PDFs/manifests/remaining-source-scan.summary.json`
- Complete-seeded passing publication rows recorded: `107`
  Source: `ICJIA-PDFs/manifests/complete-passing-publication-status.json`
- Staged complete-passing replacements: `104`
  Source: `ICJIA-PDFs/manifests/complete-passing-replacements.summary.json`
- Priority remediation candidates selected: `259`
  Source: `ICJIA-PDFs/manifests/remediation-priority-candidates.summary.json`
- Remaining medium-tier remediation candidates after prior waves: `223`
  Source: `ICJIA-PDFs/manifests/remediation-remaining-all-candidates.summary.json`
- Remaining-all run results:
  - `13` ready to replace
  - `141` failed after remediation
  - `69` processing errors
  Source: `ICJIA-PDFs/manifests/remediation-remaining-all-outcomes.summary.json`
- Ready-to-replace re-verification mismatch:
  - `164` verified pass publication rows
  - `225` hard fail publication rows
  Source: `ICJIA-PDFs/manifests/ready-to-replace-verification.classified.summary.json`

Planning implication:

- The remaining work is not a single queue.
- It is a set of cohorts with different pass likelihoods, failure families, and runtime risks.
- The system must handle short near-pass PDFs, image-heavy ownership PDFs, structure-heavy PDFs, long reports, and true manual/deferred tails differently.

## Planning Principles

- Treat ICJIA as the proving corpus for the general engine, not as a one-off workflow.
- Keep source-system logic outside the remediation core whenever possible.
- Only mark a file ready for API/source update when it reaches the strict replacement gate:
  - grade `A`
  - score `100`
  - no blocking local standards findings
  - no critical manual review flags
  - no categories below `100` except allowed color-contrast residuals
- Optimize for truthful terminal outcomes:
  - fast pass
  - honest hard fail
  - bounded processing error
  instead of hidden loops or stale optimistic grading.
- Every improvement must be attributable to a benchmark, canary, or cohort delta.

## Workstreams

This roadmap is split into four concurrent workstreams that must feed each other.

### Workstream A: Corpus Completion

- discover, group, prioritize, remediate, verify, and stage all remaining ICJIA PDFs
- keep the queue moving by cohort rather than file-by-file heroics

### Workstream B: General Remediation Engine

- improve the document-centric analyzer/remediator
- generalize ownership, figure, structure, font, and metadata fixes
- reduce churn and runtime regressions through phase and residual-family convergence logic

### Workstream C: Reusable API Extraction

- expose a self-contained grader/fixer API with verbose, agent-friendly inputs and outputs
- keep the ICJIA adapter as a consumer of the API, not the API itself

### Workstream D: Tracking, Benchmarking, And Endgates

- define fixed canary sets
- measure cohort progress
- enforce clear promotion gates before moving to the next stage

## Cohort Model For Remaining PDFs

The remaining corpus should be managed in cohorts, not a flat backlog.

### Cohort 1: Near-Pass And High-Likelihood Short PDFs

Characteristics:

- short page counts
- fewer blocker families
- high pass-likelihood scores
- often legacy archive leaflets, briefs, or short reports

Primary goals:

- maximize ready-to-replace throughput
- improve tooling ROI quickly
- generate stable examples of successful automated remediation

Operational rule:

- this cohort is the main throughput driver and should be continuously processed in waves

### Cohort 2: Ownership / Figure-Description Heavy PDFs

Characteristics:

- `pdfua.figure_alt_or_artifact`
- `pdfua.untagged_rendered_images`
- nested figure debt
- image-heavy flyers, county profiles, bulletin-style layouts, infographics

Primary goals:

- generalize image ownership and figure convergence
- improve informative vs decorative image handling
- reduce repeated deep alt-text inspection churn

Operational rule:

- grouped by failure-family similarity, not just title or source path

### Cohort 3: Structure / Reading-Order Heavy PDFs

Characteristics:

- `pdfua.logical_structure`
- `pdfua.heading_content_quality`
- reading-order debt
- post-bootstrap marked-content residue

Primary goals:

- improve structure conformance repair
- stop repeated deep structure validation when the same residual family is flat
- convert loops into bounded hard-fail or pass outcomes

Operational rule:

- this is the main regression-benchmark canary cohort
- examples include `Court System`, `Criminal Sentencing Layout`, and long structure-heavy reports

### Cohort 4: Font / Extractability Heavy PDFs

Characteristics:

- `pdfua.font_embedding`
- `pdfua.font_unicode`
- text extractability ceilings
- older archive reports with damaged or incomplete font encoding

Primary goals:

- improve deterministic font repair coverage
- separate true unrecoverable text debt from fixable encoding problems

Operational rule:

- handled as a dedicated family because these files can look “simple” while still failing late

### Cohort 5: Long Reports And Annual Reports

Characteristics:

- large page counts
- mixed structure, figure, and metadata debt
- high runtime risk
- agency/researchhub upload PDFs and annual reports

Primary goals:

- reduce mixed-family churn
- improve long-report structural convergence
- keep runtime bounded and diagnosable

Operational rule:

- benchmark as a separate long-report canary family before sending large new waves through the batch runner

### Cohort 6: Manual / Deferred Tail

Characteristics:

- repeated bounded processing errors
- persistent blocking issues after generalized repair attempts
- files whose residual debt suggests true manual intervention or missing capability

Primary goals:

- keep these from blocking the rest of the queue
- classify them precisely
- feed their failure shapes back into engine/API design

Operational rule:

- never let this cohort define the default path for the rest of the corpus

## Staged Roadmap

## Stage 0: Freeze The Truth Model

Goal:

- make sure the system’s pass/fail gate reflects final saved bytes and replacement reality

Required state:

- final authoritative analysis always runs on final bytes
- replacement gate allows only contrast-related non-blocking residuals
- ready-to-replace verification remains the source of truth for promoted files

Endgate:

- no new replacement is promoted without a post-remediation verification record
- all benchmark and batch outputs classify terminal outcomes honestly

## Stage 1: Build The Corpus Control Plane

Goal:

- turn the remaining ICJIA corpus into a controlled queue with explicit cohorts and status transitions

Implementation:

- define canonical statuses:
  - discovered
  - analyzed
  - queued_for_remediation
  - remediated_pass
  - remediated_fail
  - processing_error
  - deferred_manual
  - staged_for_replacement
  - replaced_remote
- attach cohort labels to every remaining target:
  - short_high_likelihood
  - figure_heavy
  - structure_heavy
  - font_heavy
  - long_report
  - manual_tail
- record source-system metadata separately from remediation metadata

Tracking artifacts:

- cohort manifest
- per-cohort progress summary
- stable benchmark canary manifest

Endgate:

- every remaining target belongs to a cohort and a current status
- no remaining file is “unknown” or only represented by ad hoc batch history

## Stage 2: Finish The High-Likelihood Throughput Cohorts

Goal:

- maximize the number of passing ICJIA replacements while the harder engine work continues

Implementation:

- keep processing Cohort 1 continuously in prioritized waves
- bias tooling toward short non-scanned PDFs with fewer blocker families
- verify every `ready_to_replace` result before promotion
- update source/API only after strict pass verification

Success metrics:

- rising verified-pass count
- falling backlog in Cohort 1
- low processing-error rate in this cohort

Endgate:

- the majority of high-likelihood short PDFs are either:
  - verified pass and staged
  - or clearly classified into a harder cohort with specific failure reasons

## Stage 3: Generalize Figure And Ownership Remediation

Goal:

- make figure/ownership fixes reliable across bulletins, profiles, flyers, and infographics

Implementation:

- continue improving:
  - native figure semantics repair
  - Acrobat-style ownership repair
  - informative vs decorative figure classification
  - bounded heuristic figure follow-up
- keep phase-aware figure convergence and focused-rescue stop reasons
- use cohort runs to group failures by:
  - ownership cleared but figure debt remains
  - mixed figure + structure debt
  - mass unresolved figure debt

Success metrics:

- higher pass rate in figure-heavy cohort
- lower figure-related processing errors
- more files ending as honest hard fail instead of runtime churn

Endgate:

- figure-heavy benchmark canaries show stable terminal behavior
- no reappearance of generic timeout wording

## Stage 4: Generalize Structure And Residual-Family Convergence

Goal:

- stop structure-heavy PDFs from re-spending deep inspections on flat residual families

Implementation:

- keep stage-family and residual-family convergence rules active
- improve:
  - structure-led vs figure-led residual routing
  - deep-follow-up admission for non-native stage analysis
  - residual cleanup stop reasons
  - late figure deferral while structure debt remains unconverged
- use `Court System`, `Criminal Sentencing Layout`, `SFY24`, and similar files as canaries

Success metrics:

- `Court System` no longer burns the full `light=4, deep=9, total=13` pattern
- structure-heavy files terminate faster and more honestly
- benchmark explains where the budget was spent

Endgate:

- structure-heavy canary benchmark shows a material reduction in deep inspection churn
- no regression in previously stabilized figure-heavy files

## Stage 5: Font And Text Extractability Closure

Goal:

- reduce the remaining font/unicode class from late failures to either pass or explicit manual classification

Implementation:

- improve deterministic font repair order
- better detect unrecoverable font debt vs fixable unicode-map debt
- group font-heavy failures into stable subfamilies

Success metrics:

- more text extractability blockers move to pass in batch runs
- fewer late-stage font cleanup retries with no improvement

Endgate:

- font-heavy cohort has a stable pass/fail envelope and no hidden runtime tail

## Stage 6: Long-Report Stability

Goal:

- make long reports and annual reports terminalize predictably

Implementation:

- benchmark long reports separately
- preserve mixed-family diagnostics
- keep long-report-specific structural convergence rules bounded
- ensure failure reports clearly identify:
  - dominant family
  - residual stop reason
  - whether failure was due to bounded runtime, structure, figure, or font debt

Success metrics:

- annual reports no longer dominate runtime unpredictably
- long-report benchmark produces stable hard-fail or pass outcomes

Endgate:

- long-report benchmark can be rerun repeatedly without crashes, missing paths, or uncontrolled loops

## Stage 7: General API Extraction

Goal:

- turn the remediation engine into a self-contained API that can be dropped into the original repository

Required architecture boundary:

- ICJIA-specific logic becomes an adapter layer
- the general API becomes document-centric

General API contract:

- `analyzePdf(input)`
- `remediatePdf(input)`
- `verifyPdf(input)`
- `explainFailure(input)`

Required request properties:

- file bytes or file path
- filename
- optional source metadata
- optional remediation policy
- optional artifact retention mode
- optional benchmark or canary label

Required response properties:

- overall score and grade
- category scores
- blocking local findings
- unresolved categories
- remediation metrics
- phase diagnostics
- residual cleanup diagnostics
- applied actions
- manual review flags
- artifact paths or handles
- human-readable summary

Agent-facing design requirement:

- the interface must be verbose and easy to understand
- tool errors must say what failed, where, and what the system suggests next
- logging must be structured and high-signal
- the API should expose “why this stopped” rather than forcing source-code inspection

Performance requirement:

- the API must remain visually preserving by default
- remediation should avoid needless model/planner round trips
- expensive deep inspection should be bounded and observable

Packaging requirement:

- keep it self-contained so it can be dropped into the original repository
- avoid hard dependencies on ICJIA manifests, Strapi records, or server-cache layout

Endgate:

- the ICJIA batch runner uses the API as a client
- the API can process arbitrary PDFs without ICJIA-specific context

## Stage 8: Controlled Source-System Promotion

Goal:

- update the live API/source systems only when files are truly complete

Policy:

- never update source URLs or replace remote bytes from a non-verified remediation result
- stage first, verify second, promote third
- allow non-blocking contrast residuals only if the replacement gate explicitly allows them

Required promotion pipeline:

1. remediation pass
2. authoritative re-analysis on final bytes
3. replacement-gate evaluation
4. verification pass
5. staged replacement manifest update
6. source-system update

Endgate:

- all live updates are backed by a verifiable local artifact and replacement manifest entry

## Benchmarking, Tracking, And Endgates

Every stage must move through the same control loop:

1. define cohort or canary set
2. measure current baseline
3. implement capability or convergence rule
4. rerun benchmark
5. compare:
   - verified pass count
   - hard fail count
   - processing error count
   - runtime distribution
   - dominant family
   - stop reasons
6. only then widen to larger batch waves

Required benchmark families:

- figure-heavy canary set
- structure-heavy canary set
- long-report canary set
- high-likelihood short-pass cohort sample
- font-heavy cohort sample

Required endgates per benchmark:

- no new generic timeout wording
- no false optimistic pass states
- no regression in previously stabilized canaries
- lower churn or better terminal honesty for the targeted cohort

## What “Done” Looks Like

For the ICJIA corpus:

- all remaining server-cache PDFs have terminal statuses
- all automatable passable files are verified and staged or replaced
- only true manual/deferred tails remain outside the automated pass lane

For the reusable API:

- a caller can submit any PDF without ICJIA context
- the system grades, attempts remediation, and returns verbose, understandable outputs
- the package can be dropped into the original repository as a self-contained module or service
- the ICJIA adapter is only one consumer of the engine, not the engine itself

## Immediate Next Actions

1. Finish the active residual-churn regression benchmark and compare it against the previous completed 5-case benchmark.
2. Create a canonical cohort manifest for all remaining targets using the current summary/manifests.
3. Split the execution backlog into:
   - throughput cohort
   - figure-heavy cohort
   - structure-heavy cohort
   - long-report cohort
   - font-heavy cohort
   - manual tail
4. Keep improving convergence and repair logic only against named cohort benchmarks.
5. Start extracting the stable document-centric remediation API surface while ICJIA batch work continues.
