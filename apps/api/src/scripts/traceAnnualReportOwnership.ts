import fs from 'node:fs/promises'
import path from 'node:path'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { buildFailureProfileArtifacts } from '../services/failureProfileService.js'
import {
  executeRemediationTool,
  inspectPdfForRemediation,
} from '../services/pdfRemediationTools.js'
import type { RemediationActionRecord } from '../services/documentModel.js'

const DEFAULT_FILES = [
  '2007 Annual Report Final.pdf',
  '2008 Annual Report.pdf',
] as const

interface AnnualReportTraceStep {
  step: string
  outcome?: string
  changedDocumentBytes?: boolean
  score: number
  grade: string
  veraPdf: {
    status: string
    failedChecks: number
  }
  categories: {
    altText: number | null
    tableMarkup: number | null
    pdfUaCompliance: number | null
    titleLanguage: number | null
  }
  blockingFindingKeys: string[]
  mixedOwnership: {
    total: number
    splitSafe: number
    containmentSafe: number
    unsplittable: number
  }
  acrobatAltRiskCount: number
  highConfidenceUntaggedTables: number
  advisoryUntaggedTables: number
  autoRunnableKeys: string[]
}

interface AnnualReportTraceFile {
  filename: string
  steps: AnnualReportTraceStep[]
}

interface AnnualReportTraceArtifact {
  generatedAt: string
  files: AnnualReportTraceFile[]
}

function repoRoot(): string {
  return path.resolve(process.cwd(), '../..')
}

function timestampForFilename(input: Date): string {
  return input.toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z')
}

function categoryScore(analysis: any, id: string): number | null {
  return analysis.categories?.find((category: any) => category.id === id)?.score ?? null
}

async function summarizeStep(
  step: string,
  filename: string,
  buffer: Buffer,
  analysis: any,
  actions: RemediationActionRecord[],
  extra?: Partial<AnnualReportTraceStep>,
): Promise<AnnualReportTraceStep> {
  const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
  const artifacts = buildFailureProfileArtifacts({
    analysis,
    context,
    actions,
    rejectedActions: [],
  })
  const acrobatAltRiskNodes = context.structure.acrobatAltRiskNodes || []
  const mixedOwnershipNodes = acrobatAltRiskNodes.filter((node: any) => node.ownershipMode === 'mixed_text_graphics_same_mcid')
  const tableStructure = analysis.tableStructure || {}

  return {
    step,
    score: analysis.overallScore,
    grade: analysis.grade,
    veraPdf: {
      status: analysis.verapdf?.status || 'unavailable',
      failedChecks: analysis.verapdf?.failedChecks || 0,
    },
    categories: {
      altText: categoryScore(analysis, 'alt_text'),
      tableMarkup: categoryScore(analysis, 'table_markup'),
      pdfUaCompliance: categoryScore(analysis, 'pdf_ua_compliance'),
      titleLanguage: categoryScore(analysis, 'title_language'),
    },
    blockingFindingKeys: (analysis.localStandards?.findings || [])
      .filter((finding: any) => finding.blocking)
      .map((finding: any) => finding.key),
    mixedOwnership: {
      total: mixedOwnershipNodes.length,
      splitSafe: mixedOwnershipNodes.filter((node: any) => node.splitSafe).length,
      containmentSafe: mixedOwnershipNodes.filter((node: any) => node.containmentSafe).length,
      unsplittable: mixedOwnershipNodes.filter((node: any) => !node.splitSafe && !node.containmentSafe).length,
    },
    acrobatAltRiskCount: acrobatAltRiskNodes.length,
    highConfidenceUntaggedTables: tableStructure.highConfidenceUntaggedTables ?? tableStructure.untaggedTables ?? 0,
    advisoryUntaggedTables: tableStructure.advisoryUntaggedTables ?? 0,
    autoRunnableKeys: artifacts.failureProfile.toolOpportunities
      .filter((opportunity: any) => opportunity.status === 'auto_runnable')
      .map((opportunity: any) => opportunity.key),
    ...extra,
  }
}

async function analyzeForTrace(buffer: Buffer, filename: string) {
  return analyzePDF(buffer, filename, {
    analysisProfile: 'remediation_fast',
    skipAdobe: true,
    skipVeraPdf: false,
  })
}

async function traceFile(filename: string): Promise<AnnualReportTraceFile> {
  const pdfPath = path.join(repoRoot(), 'Downloads', filename)
  let buffer = await fs.readFile(pdfPath) as Buffer
  let analysis = await analyzeForTrace(buffer, filename)
  const actions: RemediationActionRecord[] = []
  const steps: AnnualReportTraceStep[] = [
    await summarizeStep('baseline', filename, buffer, analysis, actions),
  ]

  for (const toolName of ['repair_structure_conformance', 'repair_other_elements_alt_text'] as const) {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const outcome = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: toolName,
        arguments: { target: 'document' },
        rationale: 'Annual-report ownership trace.',
        confidence: 0.95,
      },
    })
    buffer = outcome.buffer
    actions.push(outcome.action)
    analysis = await analyzeForTrace(buffer, filename)
    steps.push(await summarizeStep(toolName, filename, buffer, analysis, actions, {
      outcome: outcome.action.outcome,
      changedDocumentBytes: outcome.action.changedDocumentBytes,
    }))
  }

  {
    let batchChanged = false
    let batchOutcome = 'no_effect'
    let context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const candidates = context.tableCandidates.filter(candidate => candidate.repairMode === 'safe' && !candidate.hasHeaders && !!candidate.ref)
    for (const candidate of candidates.slice(0, 24)) {
      const outcome = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name: 'set_table_header_cells',
          arguments: { candidateId: candidate.id, ref: candidate.ref },
          rationale: 'Annual-report table-header trace batch.',
          confidence: 0.9,
        },
      })
      buffer = outcome.buffer
      actions.push(outcome.action)
      if (outcome.action.outcome === 'applied') batchOutcome = 'applied'
      batchChanged = batchChanged || !!outcome.action.changedDocumentBytes
      analysis = await analyzeForTrace(buffer, filename)
      context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    }
    steps.push(await summarizeStep('set_table_header_cells_batch', filename, buffer, analysis, actions, {
      outcome: batchOutcome,
      changedDocumentBytes: batchChanged,
    }))
  }

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const metadataOpportunity = buildFailureProfileArtifacts({
      analysis,
      context,
      actions,
      rejectedActions: [],
    }).failureProfile.toolOpportunities.find((opportunity: any) =>
      opportunity.status === 'auto_runnable' && opportunity.toolName === 'normalize_document_metadata',
    )
    if (metadataOpportunity) {
      const outcome = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name: 'normalize_document_metadata',
          arguments: { target: 'document' },
          rationale: 'Annual-report metadata cleanup trace.',
          confidence: 0.9,
        },
      })
      buffer = outcome.buffer
      actions.push(outcome.action)
      analysis = await analyzeForTrace(buffer, filename)
      steps.push(await summarizeStep('normalize_document_metadata', filename, buffer, analysis, actions, {
        outcome: outcome.action.outcome,
        changedDocumentBytes: outcome.action.changedDocumentBytes,
      }))
    }
  }

  return { filename, steps }
}

async function main() {
  const filenames = process.argv.slice(2)
  const targetFiles = filenames.length ? filenames : [...DEFAULT_FILES]
  const files: AnnualReportTraceFile[] = []
  for (const filename of targetFiles) {
    files.push(await traceFile(filename))
  }

  const artifact: AnnualReportTraceArtifact = {
    generatedAt: new Date().toISOString(),
    files,
  }

  const outputDir = path.join(repoRoot(), 'MitigationAttempts', 'annual-report-traces')
  await fs.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${timestampForFilename(new Date())}.annual-report-trace.json`)
  await fs.writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')

  console.log(JSON.stringify({
    outputPath: path.relative(repoRoot(), outputPath),
    ...artifact,
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
