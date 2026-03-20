import { REMEDIATION } from '#config'
import db from '../db/sqlite.js'
import type { RemediationActionRecord, RemediationToolName, ToolReliabilitySummary } from './documentModel.js'
import type { AnalysisResult } from './pdfAnalyzer.js'
import { classifyPdfFull, toReliabilityPdfClass } from './pdfClassificationService.js'
import type { PdfRemediationContext } from './pdfRemediationTools.js'

export type PdfClass = ToolReliabilitySummary['pdfClass']

export interface ToolOutcomeRecord {
  toolName: RemediationToolName
  pdfClass: PdfClass
  outcome: Extract<RemediationActionRecord['outcome'], 'applied' | 'no_effect' | 'rejected' | 'failed' | 'unsupported'>
  roundNumber: number
  stageNumber: number
  overallScoreBefore: number | null
  overallScoreAfter: number | null
  categoryDeltas: Array<{ categoryId: string; before: number | null; after: number | null }>
  reliabilitySuccess: boolean
  playbookId?: string | null
  playbookRunId?: string | null
}

type ToolOutcomeRow = {
  tool_name: RemediationToolName
  pdf_class: PdfClass
  reliability_success: number
}

const insertToolOutcomeStatement = db.prepare(`
  INSERT INTO tool_outcomes (
    tool_name,
    pdf_class,
    outcome,
    round_number,
    stage_number,
    overall_score_before,
    overall_score_after,
    category_deltas_json,
    reliability_success,
    playbook_id,
    playbook_run_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

const selectToolOutcomesStatement = db.prepare(`
  SELECT tool_name, pdf_class, reliability_success
  FROM tool_outcomes
  WHERE tool_name = ?
`)

export function classifyPdf(input: {
  analysis: AnalysisResult
  context?: Pick<PdfRemediationContext, 'qpdf' | 'structure'> | null
}): PdfClass {
  return toReliabilityPdfClass(classifyPdfFull({
    analysis: input.analysis,
    context: input.context
      ? {
          qpdf: input.context.qpdf as any,
        }
      : null,
  }))
}

export function recordToolOutcomes(records: ToolOutcomeRecord[]): void {
  if (!records.length) return
  const insertMany = db.transaction((rows: ToolOutcomeRecord[]) => {
    for (const row of rows) {
      insertToolOutcomeStatement.run(
        row.toolName,
        row.pdfClass,
        row.outcome,
        row.roundNumber,
        row.stageNumber,
        row.overallScoreBefore,
        row.overallScoreAfter,
        JSON.stringify(row.categoryDeltas),
        row.reliabilitySuccess ? 1 : 0,
        row.playbookId || null,
        row.playbookRunId || null,
      )
    }
  })
  insertMany(records)
}

function summarizeRows(rows: ToolOutcomeRow[], fallback: {
  toolName: RemediationToolName
  pdfClass: PdfClass
  source: ToolReliabilitySummary['source']
  defaultReliability?: number
}): ToolReliabilitySummary {
  const attempts = rows.length
  const successes = rows.filter(row => row.reliability_success === 1).length
  return {
    toolName: fallback.toolName,
    pdfClass: fallback.pdfClass,
    attempts,
    successes,
    reliability: attempts > 0 ? successes / attempts : (fallback.defaultReliability ?? REMEDIATION.TOOL_RELIABILITY_DEFAULT),
    source: fallback.source,
  }
}

export function getToolReliability(toolName: RemediationToolName, pdfClass: PdfClass): ToolReliabilitySummary {
  const rows = selectToolOutcomesStatement.all(toolName) as ToolOutcomeRow[]
  const classRows = rows.filter(row => row.pdf_class === pdfClass)
  if (classRows.length >= REMEDIATION.TOOL_RELIABILITY_MIN_ATTEMPTS) {
    return summarizeRows(classRows, { toolName, pdfClass, source: 'tool_and_class' })
  }
  if (rows.length > 0) {
    return summarizeRows(rows, { toolName, pdfClass, source: 'tool_global' })
  }
  return summarizeRows([], {
    toolName,
    pdfClass,
    source: 'default',
    defaultReliability: REMEDIATION.TOOL_RELIABILITY_DEFAULT,
  })
}

export function getToolReliabilityMap(toolNames: RemediationToolName[], pdfClass: PdfClass): Map<RemediationToolName, ToolReliabilitySummary> {
  return new Map(toolNames.map(toolName => [toolName, getToolReliability(toolName, pdfClass)]))
}

export function __test_resetToolOutcomes(): void {
  db.prepare('DELETE FROM tool_outcomes').run()
}
