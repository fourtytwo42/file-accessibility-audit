# Remediation Progress

## Run Summary

- Status: In progress
- Branch: `pdf-fixing`
- Input folder: `Downloads/`
- Final output folder: `Complete/`
- Intermediate output folder: `MitigationAttempts/`
- Mantra: ABI — Always Be Improving
- Completion threshold: score >= `95/100`, grade `A`, no blocking accessibility debt, no critical manual-review debt, and visual page-1 fidelity

## Current Session Snapshot

- Active PDF: `2019 Illinois Methamphetamine Study-191218T21562198.pdf`, `Addressing_Opioid_Use_Disorders_in_Corrections_2018-191011T20091010.pdf`, `Alternatives to Incarceration.pdf`, `An Evaluation of Redeploy Illinois - St. Clair County and Peoria County.pdf`
- Latest attempt path: `MitigationAttempts/2019 Illinois Methamphetamine Study-191218T21562198/attempt-001.pdf`, `MitigationAttempts/Addressing_Opioid_Use_Disorders_in_Corrections_2018-191011T20091010/attempt-001.pdf`, `MitigationAttempts/Alternatives to Incarceration/attempt-001.pdf`, `MitigationAttempts/An Evaluation of Redeploy Illinois - St. Clair County and Peoria County/attempt-001.pdf`, `MitigationAttempts/An Evaluation of the Adams County SWAP/attempt-001.pdf`, `MitigationAttempts/An Evaluation of the IDOC Juvenile Sex Offender Treatment Program/attempt-001.pdf`
- Latest result summary: 7 file(s) accepted into Complete/; latest completed: 2022_DVFR_Annual_Report_Final_a688e16b10_a00d65b63f.pdf
- Latest validation source: Fresh API remediation plus blocker-free accessibility validation plus visual compare; bookmark/process improvements may continue after Complete placement
- Next action: Autofix the current blocker batch, restart API, and rerun affected PDFs
- Next hypothesis: Bookmark cleanup did not appear to use the semantic AI path.
- API restart status: No orchestrator-managed restart recorded yet
- Build status: Restart preferred; rebuild only if stale behavior persists after restart

## MV Annual Cohort

- Owned PDFs: `2011 MV Annual Report.pdf`, `2012_MV_Annual_Report.pdf`, `2013_MV_Annual_Report.pdf`, `2014_MV_Annual_Report.pdf`, `2015_Motor_Vehicle_Annual_Report.pdf`, `2016_Motor_Vehicle_Annual_Report.pdf`, `2007 Annual Report Final.pdf`, `2008 Annual Report.pdf`
- Shared fix candidate under validation: safer heading target remapping that refuses container-only targets without a real text-bearing descendant
- Shared fix candidate under validation: text-aware heading target selection now refuses structurally safe nodes that do not actually carry text, and `create_heading_tag` skips blank top-level heading candidates
- Table-heavy split:
  - `2007 Annual Report Final.pdf` and `2008 Annual Report.pdf` are now the active table-family branch
  - shared hypothesis: table recovery needs a document-level bridge when qpdf reports tables but the structure snapshot does not surface candidate refs
  - shared fix candidate under validation: table opportunity generation now promotes `repair_native_table_headers` when `table_markup` debt exists and qpdf still sees tables, even if the backend snapshot missed explicit table candidates
- Strict-gate complete:
  - `2011 MV Annual Report.pdf` reached `100/A` on `attempt-002-heading-chain.pdf`, passed the page-1 visual compare, and was copied into `Complete/`
  - `2013_MV_Annual_Report.pdf` reached `100/A` on `attempt-002-heading-chain.pdf`, passed the page-1 visual compare, and was copied into `Complete/`
- Latest reruns:
  - `2011 MV Annual Report.pdf` -> `MitigationAttempts/2011_MV_Annual_Report/attempt-002-heading-remap.pdf`
    - strict analysis: `89/B`
    - blocking local standards: `pdfua.heading_content_quality`
    - visual page-1 compare: passed
  - `2014_MV_Annual_Report.pdf` -> `MitigationAttempts/2014_MV_Annual_Report/attempt-002-heading-remap.pdf`
    - strict analysis: `70/C`
    - blocking local standards: `pdfua.logical_structure`, `pdfua.heading_content_quality`
    - visual page-1 compare: passed
- In-flight rerun:
  - `2011 MV Annual Report.pdf` -> `MitigationAttempts/2011_MV_Annual_Report/attempt-003-text-aware.pdf`
  - `2014_MV_Annual_Report.pdf` -> `MitigationAttempts/2014_MV_Annual_Report/attempt-003-text-aware.pdf`
  - hypothesis: blank H1s were being promoted through structurally safe but textless heading targets
- Strict complete in this cohort so far:
  - `2015_Motor_Vehicle_Annual_Report.pdf`
  - `2011 MV Annual Report.pdf`
  - `2013_MV_Annual_Report.pdf`
- Latest annual split:
  - `2014_MV_Annual_Report.pdf` still blocks on `pdfua.logical_structure` and `pdfua.heading_content_quality` in `full_final` (`70/C`)
  - `2007 Annual Report Final.pdf` is the table-backed branch: qpdf reports 5 tables, 5 table candidates are surfaced, and the blocker set is `context.table_candidates_blocked` + `pdfua.table_regularity` + `pdfua.logical_structure`
  - `2007 Annual Report Final.pdf` rerun in flight: `MitigationAttempts/2007_Annual_Report_Final/attempt-008-table-bridge.pdf`
  - `2008 Annual Report.pdf` remains the table-heavy branch under the new table bridge; fresh rerun in flight: `MitigationAttempts/2008_Annual_Report/attempt-008-table-bridge.pdf`
  - shared reusable fix candidate under investigation: table structure recovery and table-to-heading credit handoff for annual report tails

## Current Concurrency

- Active parallel PDF jobs: 6 active
- CPU/memory notes: load 0%, memory 40%
- Last adjustment: current cap 6
- In-flight PDFs before restart: `2019 Illinois Methamphetamine Study-191218T21562198.pdf`, `Addressing_Opioid_Use_Disorders_in_Corrections_2018-191011T20091010.pdf`, `Alternatives to Incarceration.pdf`, `An Evaluation of Redeploy Illinois - St. Clair County and Peoria County.pdf`

## Current Focus

- Active PDF: `2019 Illinois Methamphetamine Study-191218T21562198.pdf`, `Addressing_Opioid_Use_Disorders_in_Corrections_2018-191011T20091010.pdf`, `Alternatives to Incarceration.pdf`, `An Evaluation of Redeploy Illinois - St. Clair County and Peoria County.pdf`
- Current phase: Autofix / rerun loop
- Immediate next step: Run Codex autofix on failure packets, then restart PM2 API and rerun
- API restart/rerun confirmed for active file: No
- Rebuild required for active file: No
- Active remediation loop count: 2019 Illinois Methamphetamine Study-191218T21562198.pdf=1, Addressing_Opioid_Use_Disorders_in_Corrections_2018-191011T20091010.pdf=1, Alternatives to Incarceration.pdf=1, An Evaluation of Redeploy Illinois - St. Clair County and Peoria County.pdf=1, An Evaluation of the Adams County SWAP.pdf=1, An Evaluation of the IDOC Juvenile Sex Offender Treatment Program.pdf=1
- Next hypothesis: 2001-2020 SFS Full Year End Report-220520T19141184.pdf: Logical structure and marked content | score 65 | grade D

## County Outline Lane

- Cohort name: `county-outline-family`
- Reason grouped: county / outline-heavy reports with shared navigation and semantic cleanup behavior
- Member PDFs: `Adams-2.pdf`, `Alexander.pdf`, `Alexander-2.pdf`, `Bond.pdf`, `Bond-2.pdf`, `Boone.pdf`, `Boone-2.pdf`, `Brown.pdf`, `Brown-2.pdf`, `Bureau.pdf`, `Bureau-2.pdf`
- Status: remediation-active
- Active lane hypothesis: the county batch is not bookmark-only; `replace_bookmarks_from_headings` can lift some files, but `alt_text` is still the remaining limiter on the current representative file
- Current representative attempt chain: `MitigationAttempts/county-pairs/Adams-2/attempt-001.pdf` -> `attempt-002.pdf` -> `attempt-003.pdf` -> `attempt-004.pdf`
- Representative result: `Adams-2.pdf` reached `96/B` on `attempt-006.pdf`, passed the page-1 visual compare, and was copied into `Complete/`
- Representative blockers after remediation: no blocking accessibility debt remains on the latest revalidation; the remaining difference is nonblocking score/grade debt
- Next hypothesis: the county lane likely needs stronger semantic alt-text / figure cleanup, not another bookmark-only pass
- Current in-flight pair:
  - `Alexander.pdf` reached `91/B` on `attempt-002.pdf` and is being pushed again from `attempt-003.pdf`
  - `Alexander-2.pdf` is in remediation from the raw source and is following the same county outline tail
  - `Bond.pdf` is now in remediation from the raw source and should follow the same county outline tail if it behaves similarly
- New county result:
  - `Bond.pdf` reached `90/B` on `attempt-002.pdf`; it is still below the strict gate and remains a shared county-outline tail case
- New county in-flight file:
  - `Bond-2.pdf` is now in remediation from the raw source and should be treated as the next sibling in the county-outline family
- County lane expansion:
  - `Boone.pdf` is now in remediation from the raw source and is being processed under the same county-outline family hypothesis
- New county result:
  - `Boone.pdf` reached `90/B` on `attempt-001.pdf`; the page-1 visual comparison passed, but it remains below the strict gate and stays in remediation
- County lane expansion:
  - `Boone-2.pdf` is now in remediation from the raw source and should follow the same county-outline family unless it diverges
- Strict-gate complete:
  - `Boone-2.pdf` reached `100/A` on `attempt-001.pdf`, passed the page-1 visual compare, and was copied into `Complete/`
- New county result:
  - `Brown.pdf` reached `96/B` on `attempt-001.pdf`; the page-1 visual comparison passed, but it remains below the strict gate and stays in remediation
- New county blocker:
  - `Bureau.pdf` timed out during semantic remediation on `attempt-001.pdf`; keep it in the county-outline family and retry after the semantic provider stabilizes
- County lane expansion:
  - `Calhoun.pdf` is now in remediation from the raw source and should follow the same county-outline family unless it diverges
- New county blocker:
  - `Calhoun.pdf` timed out during semantic remediation on `attempt-001.pdf`; keep it in the county-outline family and retry after the semantic provider stabilizes
- County lane expansion:
  - `Carroll.pdf` is now in remediation from the raw source and should follow the same county-outline family unless it diverges
- New county blocker:
  - `Carroll.pdf` timed out during semantic remediation on `attempt-001.pdf`; keep it in the county-outline family and retry after the semantic provider stabilizes
- County lane expansion:
  - `Carroll-2.pdf` is now in remediation from the raw source and should follow the same county-outline family unless it diverges
- New county blocker:
  - `Carroll-2.pdf` timed out during semantic remediation on `attempt-001.pdf`; keep it in the county-outline family and retry after the semantic provider stabilizes
- County lane expansion:
  - `Cass.pdf` is now in remediation from the raw source and should follow the same county-outline family unless it diverges
- County lane expansion:
  - `Cass-2.pdf` remains the next county sibling to queue after `Cass.pdf` if it diverges or finishes
- New county result:
  - `Cass.pdf` finished at `80/B`; the run exposed the same county-family late tail and the write target folder needed to be created before saving output
- County lane expansion:
  - `Cass-2.pdf` is now in remediation from the raw source and should follow the same county-outline family unless it diverges
- Strict-gate complete:
  - `Bond-2.pdf` reached `100/A` on `attempt-002.pdf`, passed the page-1 visual compare, and was copied into `Complete/`
- County lane expansion:
  - `Brown.pdf` is now in remediation from the raw source and should continue the same county-outline family pattern unless it diverges
- New county result:
  - `Boone.pdf` reached `90/B` on `attempt-002.pdf`; it remains below the strict gate and stays in the county queue
- County lane expansion:
  - `Brown-2.pdf` is now in remediation from the raw source and should stay with the same county-outline family until evidence says otherwise
- Strict-gate complete:
  - `Brown-2.pdf` reached `100/A` on `attempt-002.pdf`, passed the page-1 visual compare, and was copied into `Complete/`
- New county in-flight file:
  - `Bureau-2.pdf` is now in remediation from the raw source and should follow the same county-outline family unless it diverges
- New county result:
  - `Bureau.pdf` reached `96/B` on `attempt-002.pdf`; it is still below the strict gate and remains in the county queue
- Shared fix candidate under validation:
  - deterministic figure alt text fallback when semantic generation returns an empty alt string
  - safer heading target remapping so container-only outline nodes are not promoted without a real text-bearing descendant
- Strict-gate complete:
  - `Alexander-2.pdf` reached `100/A` on `attempt-002.pdf`, passed the page-1 visual compare, and was copied into `Complete/`
- Strict-gate complete:
  - `Adams-2.pdf` reached `96/B` on `attempt-006.pdf`, passed the page-1 visual compare, and was copied into `Complete/`
- Strict-gate complete:
  - `Alexander.pdf` reached `100/A` on `attempt-004.pdf`, passed the page-1 visual compare, and was copied into `Complete/`
- Strict-gate complete:
  - `Alexander.pdf` reached `100/A` on `attempt-004.pdf`, passed the page-1 visual compare, and was copied into `Complete/`

## Victim/DV Cohort

- Cohort name: `victim-dv-family`
- Reason grouped: victim services, DV reports, and annual-style long reports with repeated semantic cleanup patterns
- Owned PDFs:
  - `2016_ICJIA_Victim_Needs_Assessment_Summary_Report-191011T20092564.pdf`
  - `2022 Victim Needs Assessment-230306T13210736.pdf`
  - `2022 Victim Service Planning Research Report -230817T20035755.pdf`
  - `2022_DVFR_Annual_Report_Final_a688e16b10_a00d65b63f.pdf`
  - `2024 Task Force on Missing and Murdered Chicago Women Annual Report_Final-250114T18393571.pdf`
  - `2024_DVFRC_Annual_Report_4_15_f637ee1fcc_compressed-251217T14311834.pdf`
  - `2024_Domestic Violence Pretrial Working Group_Final_Report-241115T20303582.pdf`
- Status: remediation-active
- Dominant subfamilies from the latest failure packets:
  - `bookmark_language_outline_cleanup`
  - `link_tabs_and_annotation_cleanup`
  - `native_figure_convergence`
- Strict-gate complete so far:
  - `2022_DVFR_Annual_Report_Final_a688e16b10_a00d65b63f.pdf` -> `Complete/2022_DVFR_Annual_Report_Final_a688e16b10_a00d65b63f.pdf`
- Current active rerun:
  - `2022 Victim Service Planning Research Report -230817T20035755.pdf` -> `MitigationAttempts/victim-planning/2022 Victim Service Planning Research Report -230817T20035755/attempt-002-strict.pdf` (in flight; strict-gate revalidation using the current API)
  - `2024_Domestic Violence Pretrial Working Group_Final_Report-241115T20303582.pdf` -> `MitigationAttempts/victim-planning/2024_Domestic Violence Pretrial Working Group_Final_Report-241115T20303582/attempt-004-strict.pdf` (now active after the semantic-timeout + 5xx resilience fixes)
- Latest settled after-state:
  - `2022 Victim Service Planning Research Report -230817T20035755.pdf` -> `84/B` strict after-state in `MitigationAttempts/victim-planning/2022 Victim Service Planning Research Report -230817T20035755/attempt-002-strict.pdf`
- Shared fix candidates under watch:
  - stronger semantic bookmark synthesis fallback for long reports
  - tighter link/annotation ownership repair
  - native figure alt-text fallback and heading cleanup handoff

## Pending Files

- Default order: alphabetical unless reprioritized here.
- Remaining files: 951

## In Progress

- 2019 Illinois Methamphetamine Study-191218T21562198.pdf: state=remediating, score=--, grade=--, veraPDF=--, attempt=1, loop=1
- Addressing_Opioid_Use_Disorders_in_Corrections_2018-191011T20091010.pdf: state=remediating, score=--, grade=--, veraPDF=--, attempt=1, loop=1
- Alternatives to Incarceration.pdf: state=remediating, score=--, grade=--, veraPDF=--, attempt=1, loop=1
- An Evaluation of Redeploy Illinois - St. Clair County and Peoria County.pdf: state=remediating, score=--, grade=--, veraPDF=--, attempt=1, loop=1
- An Evaluation of the Adams County SWAP.pdf: state=analyzing, score=--, grade=--, veraPDF=--, attempt=1, loop=1
- An Evaluation of the IDOC Juvenile Sex Offender Treatment Program.pdf: state=uploading, score=--, grade=--, veraPDF=--, attempt=1, loop=1

## Blockers

- 2001-2020 SFS Full Year End Report-220520T19141184.pdf: state=needs_fix, score=65, grade=D, veraPDF=unavailable, attempt=1, loop=1
- 2006CHRIAuditReport.pdf: state=needs_fix, score=80, grade=B, veraPDF=unavailable, attempt=1, loop=1
- 2007 Annual Report Final.pdf: state=needs_fix, score=80, grade=B, veraPDF=unavailable, attempt=1, loop=1
- 2008 Annual Report.pdf: state=needs_fix, score=83, grade=B, veraPDF=unavailable, attempt=1, loop=1
- 2011 MV Annual Report.pdf: state=needs_fix, score=86, grade=B, veraPDF=unavailable, attempt=1, loop=1
- 2013_MV_Annual_Report.pdf: state=needs_fix, score=89, grade=B, veraPDF=unavailable, attempt=1, loop=1
- 2014_Adult_Redeploy_Illinois_Annual_Report-20191211T18501178.pdf: state=needs_fix, score=76, grade=C, veraPDF=unavailable, attempt=1, loop=1
- 2014_CVPP_Reentry_Report-191011T20093121.pdf: state=needs_fix, score=91, grade=B, veraPDF=unavailable, attempt=1, loop=1
- 2014_MV_Annual_Report.pdf: state=needs_fix, score=86, grade=B, veraPDF=unavailable, attempt=1, loop=1
- 2016_ICJIA_Victim_Needs_Assessment_Summary_Report-191011T20092564.pdf: state=needs_fix, score=62, grade=D, veraPDF=unavailable, attempt=1, loop=1
- 2016_Motor_Vehicle_Annual_Report.pdf: state=needs_fix, score=81, grade=B, veraPDF=unavailable, attempt=1, loop=1
- 2022 SFS Process Evaluation Report-230622T16355531.pdf: state=needs_fix, score=67, grade=D, veraPDF=unavailable, attempt=1, loop=1
- 2022 Victim Needs Assessment-230306T13210736.pdf: state=needs_fix, score=52, grade=F, veraPDF=unavailable, attempt=1, loop=1
- 2022 Victim Service Planning Research Report -230817T20035755.pdf: state=needs_fix, score=52, grade=F, veraPDF=unavailable, attempt=1, loop=1
- 2023 Deaths in Custody Annual Report-240216T22514713.pdf: state=needs_fix, score=70, grade=C, veraPDF=unavailable, attempt=1, loop=1
- 2024 Task Force on Missing and Murdered Chicago Women Annual Report_Final-250114T18393571.pdf: state=needs_fix, score=52, grade=F, veraPDF=unavailable, attempt=1, loop=1
- 2024_Domestic Violence Pretrial Working Group_Final_Report-241115T20303582.pdf: state=needs_fix, score=68, grade=D, veraPDF=unavailable, attempt=1, loop=1
- 2024_DVFRC_Annual_Report_4_15_f637ee1fcc_compressed-251217T14311834.pdf: state=needs_fix, score=52, grade=F, veraPDF=unavailable, attempt=1, loop=1
- 36612 Cmplr WNTR_SPRNG_07.pdf: state=needs_fix, score=65, grade=D, veraPDF=unavailable, attempt=1, loop=1
- A Crime Analysts Guide to Mapping.pdf: state=needs_fix, score=60, grade=D, veraPDF=unavailable, attempt=1, loop=1
- A Primer on Drug Addiction, Crime and Treatment Nov 2007.pdf: state=needs_fix, score=87, grade=B, veraPDF=unavailable, attempt=1, loop=1
- A Study Gun Addendum .pdf: state=needs_fix, score=70, grade=C, veraPDF=unavailable, attempt=1, loop=1
- A Time Study of Juvenile Probation Services in Illinois.pdf: state=needs_fix, score=69, grade=D, veraPDF=unavailable, attempt=1, loop=1
- A Trip to the State Fair.pdf: state=needs_fix, score=35, grade=F, veraPDF=unavailable, attempt=1, loop=1
- abateOGA.pdf: state=needs_fix, score=65, grade=D, veraPDF=unavailable, attempt=1, loop=1
- accountability.pdf: state=needs_fix, score=71, grade=C, veraPDF=unavailable, attempt=1, loop=1
- adam3.pdf: state=needs_fix, score=100, grade=A, veraPDF=unavailable, attempt=1, loop=1
- ADAM4.pdf: state=needs_fix, score=67, grade=D, veraPDF=unavailable, attempt=1, loop=1
- Adams-2.pdf: state=needs_fix, score=69, grade=D, veraPDF=unavailable, attempt=1, loop=1
- Addressing_Child_Exposure_to_Violence_final-191011T20090231.pdf: state=needs_fix, score=94, grade=B, veraPDF=unavailable, attempt=1, loop=1
- age2.pdf: state=needs_fix, score=61, grade=D, veraPDF=unavailable, attempt=1, loop=1
- Alexander-2.pdf: state=needs_fix, score=69, grade=D, veraPDF=unavailable, attempt=1, loop=1
- Alexander.pdf: state=needs_fix, score=69, grade=D, veraPDF=unavailable, attempt=1, loop=1

## Completed Files

- 2012_MV_Annual_Report.pdf: state=done, score=95, grade=B, veraPDF=unavailable, attempt=1, loop=1
- 2015_Motor_Vehicle_Annual_Report.pdf: state=done, score=100, grade=A, veraPDF=unavailable, attempt=1, loop=1
- 2022_DVFR_Annual_Report_Final_a688e16b10_a00d65b63f.pdf: state=done, score=100, grade=A, veraPDF=unavailable, attempt=2, loop=2
- ADAM1.pdf: state=done, score=100, grade=A, veraPDF=unavailable, attempt=1, loop=1
- ADAM2.pdf: state=done, score=100, grade=A, veraPDF=unavailable, attempt=1, loop=1
- BARJ law enforcement.pdf: state=done, score=100, grade=A, veraPDF=unavailable, attempt=3, loop=3

## Recent Events

- 2026-03-23T01:56:42.482Z Needs fix: 2024_Domestic Violence Pretrial Working Group_Final_Report-241115T20303582.pdf: Acrobat-style other-elements alternate text | score 68 | grade D
- 2026-03-23T01:57:44.138Z Upload started: Alexander-2.pdf
- 2026-03-23T01:57:44.676Z Needs fix: Adams-2.pdf: Logical structure and marked content | score 69 | grade D
- 2026-03-23T01:57:49.945Z Upload started: Alexander.pdf
- 2026-03-23T01:57:52.404Z Needs fix: Addressing_Child_Exposure_to_Violence_final-191011T20090231.pdf: CIDSet consistency | score 94 | grade B
- 2026-03-23T01:58:25.415Z Upload started: Alternatives to Incarceration.pdf
- 2026-03-23T01:58:25.929Z Needs fix: age2.pdf: Font embedding | score 61 | grade D
- 2026-03-23T02:02:11.082Z Upload started: An Evaluation of Redeploy Illinois - St. Clair County and Peoria County.pdf
- 2026-03-23T02:02:14.195Z Needs fix: Alexander.pdf: Logical structure and marked content | score 69 | grade D
- 2026-03-23T02:03:38.445Z Upload started: An Evaluation of the Adams County SWAP.pdf
- 2026-03-23T02:03:39.183Z Needs fix: Alexander-2.pdf: Logical structure and marked content | score 69 | grade D
- 2026-03-23T02:07:34.045Z Upload started: An Evaluation of the IDOC Juvenile Sex Offender Treatment Program.pdf
- 2026-03-23T02:07:39.718Z Needs fix: A Crime Analysts Guide to Mapping.pdf: Figure candidates need semantic or manual review | score 60 | grade D
- 2026-03-23T02:07:45.247Z API session renewed for client 63738b31-dad2-4468-ada1-85f2a71fa08d
- 2026-03-23T02:08:11.558Z API session ready for client 63738b31-dad2-4468-ada1-85f2a71fa08d

## Notes

- This file is orchestrator-managed and updated continuously during unattended runs.
- Use `MitigationAttempts/orchestrator-state.json` for the full machine-readable campaign state.
