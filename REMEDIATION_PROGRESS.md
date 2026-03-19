# Remediation Progress

## Run Summary

- Status: In progress
- Branch: `pdf-fixing`
- Input folder: `Downloads/`
- Final output folder: `Mitigated/`
- Intermediate output folder: `MitigationAttempts/`
- Mantra: ABI — Always Be Improving

## Current Session Snapshot

- Active PDF: `2019 Illinois Methamphetamine Study-191218T21562198.pdf`, `2025FirearmProhibitorsReport-250626T19175938.pdf`
- Latest attempt path: `MitigationAttempts/2019 Illinois Methamphetamine Study-191218T21562198/attempt-001.pdf`, `MitigationAttempts/2025FirearmProhibitorsReport-250626T19175938/attempt-001.pdf`
- Latest result summary: 1 file(s) fully mitigated; latest completed: 2001-2020 SFS Full Year End Report-220520T19141184.pdf
- Latest validation source: Fresh API remediation plus visual compare
- Next action: Autofix the current blocker batch, restart API, and rerun affected PDFs
- Next hypothesis: Generic remediation gap needs a system fix
- API restart status: Last restart recorded at 2026-03-19T07:40:51Z
- Build status: `pnpm --filter api build` passed on 2026-03-19T07:40:30Z; PM2 API restarted successfully afterward

## Current Concurrency

- Active parallel PDF jobs: 2 active
- CPU/memory notes: load 24%, memory 70%
- Last adjustment: current cap 2
- In-flight PDFs before restart: `2019 Illinois Methamphetamine Study-191218T21562198.pdf`, `2025FirearmProhibitorsReport-250626T19175938.pdf`

## Current Focus

- Active PDF: `2019 Illinois Methamphetamine Study-191218T21562198.pdf`, `2025FirearmProhibitorsReport-250626T19175938.pdf`
- Current phase: Autofix / rerun loop
- Immediate next step: Run Codex autofix on failure packets, then restart PM2 API and rerun
- API restart/rerun confirmed for active file: Yes
- Rebuild required for active file: No
- Active remediation loop count: 2019 Illinois Methamphetamine Study-191218T21562198.pdf=1, 2025FirearmProhibitorsReport-250626T19175938.pdf=1
- Next hypothesis: 2006CHRIAuditReport.pdf: score --, grade --, veraPDF failed

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
