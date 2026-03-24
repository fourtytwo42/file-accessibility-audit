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

- Active PDF: `2006CHRIAuditReport.pdf`, `2007 Annual Report Final.pdf`, `2008 Annual Report.pdf`, `2014_MV_Annual_Report.pdf`
- Latest attempt path: `MitigationAttempts/2006CHRIAuditReport/attempt-001.pdf`, `MitigationAttempts/2007 Annual Report Final/attempt-001.pdf`, `MitigationAttempts/2008 Annual Report/attempt-001.pdf`, `MitigationAttempts/2014_MV_Annual_Report/attempt-001.pdf`, `MitigationAttempts/2016_ICJIA_Victim_Needs_Assessment_Summary_Report-191011T20092564/attempt-001.pdf`, `MitigationAttempts/2019 Illinois Methamphetamine Study-191218T21562198/attempt-001.pdf`, `MitigationAttempts/2022 Victim Service Planning Research Report -230817T20035755/attempt-001.pdf`, `MitigationAttempts/Addressing_Opioid_Use_Disorders_in_Corrections_2018-191011T20091010/attempt-001.pdf`, `MitigationAttempts/Alexander-2/attempt-001.pdf`, `MitigationAttempts/Alexander/attempt-001.pdf`, `MitigationAttempts/Alternatives to Incarceration/attempt-001.pdf`, `MitigationAttempts/An Evaluation of Redeploy Illinois - St. Clair County and Peoria County/attempt-001.pdf`, `MitigationAttempts/An Evaluation of the Adams County SWAP/attempt-001.pdf`, `MitigationAttempts/An Evaluation of the IDOC Juvenile Sex Offender Treatment Program/attempt-001.pdf`
- Latest result summary: 4 file(s) accepted into Complete/; latest completed: ADAM2.pdf
- Latest validation source: Fresh API remediation plus blocker-free accessibility validation plus visual compare; bookmark/process improvements may continue after Complete placement
- Next action: Autofix the current blocker batch, restart API, and rerun affected PDFs
- Next hypothesis: Bookmark cleanup did not appear to use the semantic AI path.
- API restart status: No orchestrator-managed restart recorded yet
- Build status: Restart preferred; rebuild only if stale behavior persists after restart

## Current Concurrency

- Active parallel PDF jobs: 14 active
- CPU/memory notes: load 98%, memory 24%
- Last adjustment: current cap 1
- In-flight PDFs before restart: `2006CHRIAuditReport.pdf`, `2007 Annual Report Final.pdf`, `2008 Annual Report.pdf`, `2014_MV_Annual_Report.pdf`

## Current Focus

- Active PDF: `2006CHRIAuditReport.pdf`, `2007 Annual Report Final.pdf`, `2008 Annual Report.pdf`, `2014_MV_Annual_Report.pdf`
- Current phase: Autofix / rerun loop
- Immediate next step: Run Codex autofix on failure packets, then restart PM2 API and rerun
- API restart/rerun confirmed for active file: No
- Rebuild required for active file: No
- Active remediation loop count: 2006CHRIAuditReport.pdf=1, 2007 Annual Report Final.pdf=1, 2008 Annual Report.pdf=1, 2014_MV_Annual_Report.pdf=1, 2016_ICJIA_Victim_Needs_Assessment_Summary_Report-191011T20092564.pdf=1, 2019 Illinois Methamphetamine Study-191218T21562198.pdf=1, 2022 Victim Service Planning Research Report -230817T20035755.pdf=1, Addressing_Opioid_Use_Disorders_in_Corrections_2018-191011T20091010.pdf=1, Alexander-2.pdf=1, Alexander.pdf=1, Alternatives to Incarceration.pdf=1, An Evaluation of Redeploy Illinois - St. Clair County and Peoria County.pdf=1, An Evaluation of the Adams County SWAP.pdf=1, An Evaluation of the IDOC Juvenile Sex Offender Treatment Program.pdf=1
- Next hypothesis: 2001-2020 SFS Full Year End Report-220520T19141184.pdf: Logical structure and marked content | score 65 | grade D

## Pending Files

- Default order: alphabetical unless reprioritized here.
- Remaining files: 951

## In Progress

- 2006CHRIAuditReport.pdf: state=remediating, score=--, grade=--, veraPDF=unavailable, attempt=1, loop=1
- 2007 Annual Report Final.pdf: state=remediating, score=--, grade=--, veraPDF=unavailable, attempt=1, loop=1
- 2008 Annual Report.pdf: state=remediating, score=--, grade=--, veraPDF=unavailable, attempt=1, loop=1
- 2014_MV_Annual_Report.pdf: state=remediating, score=--, grade=--, veraPDF=unavailable, attempt=1, loop=1
- 2016_ICJIA_Victim_Needs_Assessment_Summary_Report-191011T20092564.pdf: state=rerunning, score=--, grade=--, veraPDF=unavailable, attempt=1, loop=1
- 2019 Illinois Methamphetamine Study-191218T21562198.pdf: state=remediating, score=--, grade=--, veraPDF=--, attempt=1, loop=1
- 2022 Victim Service Planning Research Report -230817T20035755.pdf: state=rerunning, score=--, grade=--, veraPDF=unavailable, attempt=1, loop=1
- Addressing_Opioid_Use_Disorders_in_Corrections_2018-191011T20091010.pdf: state=rerunning, score=--, grade=--, veraPDF=--, attempt=1, loop=1
- Alexander-2.pdf: state=rerunning, score=--, grade=--, veraPDF=unavailable, attempt=1, loop=1
- Alexander.pdf: state=rerunning, score=--, grade=--, veraPDF=unavailable, attempt=1, loop=1
- Alternatives to Incarceration.pdf: state=remediating, score=--, grade=--, veraPDF=--, attempt=1, loop=1
- An Evaluation of Redeploy Illinois - St. Clair County and Peoria County.pdf: state=remediating, score=--, grade=--, veraPDF=--, attempt=1, loop=1
- An Evaluation of the Adams County SWAP.pdf: state=analyzing, score=--, grade=--, veraPDF=--, attempt=1, loop=1
- An Evaluation of the IDOC Juvenile Sex Offender Treatment Program.pdf: state=uploading, score=--, grade=--, veraPDF=--, attempt=1, loop=1

## Blockers

- 2001-2020 SFS Full Year End Report-220520T19141184.pdf: state=needs_fix, score=65, grade=D, veraPDF=unavailable, attempt=1, loop=1
- 2011 MV Annual Report.pdf: state=needs_fix, score=68, grade=D, veraPDF=unavailable, attempt=1, loop=1
- 2013_MV_Annual_Report.pdf: state=needs_fix, score=89, grade=B, veraPDF=unavailable, attempt=1, loop=1
- 2014_Adult_Redeploy_Illinois_Annual_Report-20191211T18501178.pdf: state=needs_fix, score=76, grade=C, veraPDF=unavailable, attempt=1, loop=1
- 2014_CVPP_Reentry_Report-191011T20093121.pdf: state=needs_fix, score=91, grade=B, veraPDF=unavailable, attempt=1, loop=1
- 2016_Motor_Vehicle_Annual_Report.pdf: state=needs_fix, score=16, grade=F, veraPDF=unavailable, attempt=1, loop=1
- 2022 SFS Process Evaluation Report-230622T16355531.pdf: state=needs_fix, score=67, grade=D, veraPDF=unavailable, attempt=1, loop=1
- 2022 Victim Needs Assessment-230306T13210736.pdf: state=needs_fix, score=52, grade=F, veraPDF=unavailable, attempt=1, loop=1
- 2022_DVFR_Annual_Report_Final_a688e16b10_a00d65b63f.pdf: state=needs_fix, score=70, grade=C, veraPDF=unavailable, attempt=1, loop=1
- 2023 Deaths in Custody Annual Report-240216T22514713.pdf: state=needs_fix, score=70, grade=C, veraPDF=unavailable, attempt=1, loop=1
- 2024 Task Force on Missing and Murdered Chicago Women Annual Report_Final-250114T18393571.pdf: state=needs_fix, score=52, grade=F, veraPDF=unavailable, attempt=1, loop=1
- 2024_Domestic Violence Pretrial Working Group_Final_Report-241115T20303582.pdf: state=needs_fix, score=37, grade=F, veraPDF=unavailable, attempt=1, loop=1
- 2024_DVFRC_Annual_Report_4_15_f637ee1fcc_compressed-251217T14311834.pdf: state=needs_fix, score=23, grade=F, veraPDF=unavailable, attempt=1, loop=1
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
- Boone.pdf: state=needs_fix, score=69, grade=D, veraPDF=unavailable, attempt=0, loop=0
- Brown.pdf: state=needs_fix, score=69, grade=D, veraPDF=unavailable, attempt=0, loop=0
- Bureau.pdf: state=needs_fix, score=69, grade=D, veraPDF=unavailable, attempt=0, loop=0
- Cass-2.pdf: state=needs_fix, score=90, grade=B, veraPDF=unavailable, attempt=0, loop=0
- Cass.pdf: state=needs_fix, score=69, grade=D, veraPDF=unavailable, attempt=0, loop=0
- Champaign-2.pdf: state=needs_fix, score=90, grade=B, veraPDF=unavailable, attempt=0, loop=0
- Champaign.pdf: state=needs_fix, score=69, grade=D, veraPDF=unavailable, attempt=0, loop=0
- IMVTPC 1999 Annual Report.pdf: state=needs_fix, score=69, grade=D, veraPDF=unavailable, attempt=0, loop=0

## Completed Files

- 2012_MV_Annual_Report.pdf: state=done, score=95, grade=B, veraPDF=unavailable, attempt=1, loop=1
- 2015_Motor_Vehicle_Annual_Report.pdf: state=done, score=100, grade=A, veraPDF=unavailable, attempt=1, loop=1
- ADAM1.pdf: state=done, score=100, grade=A, veraPDF=unavailable, attempt=1, loop=1
- ADAM2.pdf: state=done, score=100, grade=A, veraPDF=unavailable, attempt=1, loop=1

## Recent Events

- 2026-03-24T05:03:00.000Z System fix: added agent-safe queue ownership, freshness, validate-for-complete, promote, and blocker endpoints so PDF lanes can close out or escalate without owning API restarts
- 2026-03-23T02:07:34.045Z Upload started: An Evaluation of the IDOC Juvenile Sex Offender Treatment Program.pdf
- 2026-03-23T02:07:39.718Z Needs fix: A Crime Analysts Guide to Mapping.pdf: Figure candidates need semantic or manual review | score 60 | grade D
- 2026-03-23T02:07:45.247Z API session renewed for client 63738b31-dad2-4468-ada1-85f2a71fa08d
- 2026-03-23T02:08:11.558Z API session ready for client 63738b31-dad2-4468-ada1-85f2a71fa08d
- 2026-03-24T01:11:26.425Z API session ready for client 63738b31-dad2-4468-ada1-85f2a71fa08d
- 2026-03-24T04:07:14.845Z API session ready for client 63738b31-dad2-4468-ada1-85f2a71fa08d
- 2026-03-24T04:07:15.760Z Needs fix: Boone.pdf: Logical structure and marked content | score 69 | grade D
- 2026-03-24T04:07:16.161Z Needs fix: Brown.pdf: Logical structure and marked content | score 69 | grade D
- 2026-03-24T04:07:16.572Z Needs fix: Bureau.pdf: Logical structure and marked content | score 69 | grade D
- 2026-03-24T04:07:17.045Z Needs fix: Cass-2.pdf: Alt Text on Images | score 90 | grade B
- 2026-03-24T04:07:17.508Z Needs fix: Cass.pdf: Logical structure and marked content | score 69 | grade D
- 2026-03-24T04:07:17.976Z Needs fix: Champaign-2.pdf: Alt Text on Images | score 90 | grade B
- 2026-03-24T04:07:18.697Z Needs fix: Champaign.pdf: Logical structure and marked content | score 69 | grade D
- 2026-03-24T04:07:19.080Z Needs fix: IMVTPC 1999 Annual Report.pdf: Logical structure and marked content | score 69 | grade D
- 2026-03-24T04:16:24.642Z API session ready for client 63738b31-dad2-4468-ada1-85f2a71fa08d

## Notes

- This file is orchestrator-managed and updated continuously during unattended runs.
- Use `MitigationAttempts/orchestrator-state.json` for the full machine-readable campaign state.
