import db from '../db/sqlite.js'
import type { FamilyPostconditionStatus, ResidualFamilyId, RemediationToolName } from './documentModel.js'
import type { PdfClass } from './toolReliabilityService.js'

export interface FamilyOutcomeRecord {
  familyId: ResidualFamilyId
  pdfClass: PdfClass
  stepTool: RemediationToolName
  postconditionStatus: FamilyPostconditionStatus
  roundNumber: number
  stageNumber: number
  overallScoreBefore: number | null
  overallScoreAfter: number | null
  blockingKeysBefore: string[]
  blockingKeysAfter: string[]
  playbookId?: string | null
  playbookRunId?: string | null
}

type FamilyOutcomeRow = {
  family_id: ResidualFamilyId
  pdf_class: PdfClass
  step_tool: RemediationToolName
  postcondition_status: FamilyPostconditionStatus
}

const insertFamilyOutcomeStatement = db.prepare(`
  INSERT INTO family_outcomes (
    family_id,
    pdf_class,
    step_tool,
    postcondition_status,
    round_number,
    stage_number,
    overall_score_before,
    overall_score_after,
    blocking_keys_before_json,
    blocking_keys_after_json,
    playbook_id,
    playbook_run_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

const selectFamilyOutcomeStatement = db.prepare(`
  SELECT family_id, pdf_class, step_tool, postcondition_status
  FROM family_outcomes
  WHERE family_id = ?
`)

export function recordFamilyOutcomes(records: FamilyOutcomeRecord[]): void {
  if (!records.length) return
  const insertMany = db.transaction((rows: FamilyOutcomeRecord[]) => {
    for (const row of rows) {
      insertFamilyOutcomeStatement.run(
        row.familyId,
        row.pdfClass,
        row.stepTool,
        row.postconditionStatus,
        row.roundNumber,
        row.stageNumber,
        row.overallScoreBefore,
        row.overallScoreAfter,
        JSON.stringify(row.blockingKeysBefore),
        JSON.stringify(row.blockingKeysAfter),
        row.playbookId || null,
        row.playbookRunId || null,
      )
    }
  })
  insertMany(records)
}

export function __test_selectFamilyOutcomes(familyId: ResidualFamilyId): FamilyOutcomeRow[] {
  return selectFamilyOutcomeStatement.all(familyId) as FamilyOutcomeRow[]
}

export function __test_resetFamilyOutcomes(): void {
  db.prepare('DELETE FROM family_outcomes').run()
}

