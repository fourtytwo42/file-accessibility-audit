import fs from 'node:fs/promises'
import path from 'node:path'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { buildFailureProfileArtifacts } from '../services/failureProfileService.js'
import { heuristicFigureAltText } from '../services/remediationCallDerivationService.js'
import {
  executeRemediationTool,
  inspectPdfForRemediation,
  selectHighConfidenceLongReportFigureCandidates,
} from '../services/pdfRemediationTools.js'
import type { RemediationActionRecord } from '../services/documentModel.js'

const DEFAULT_FILES = [
  '1996CHRIAudit.pdf',
  '1998_Madison.pdf',
  '1988-1989_Biennial_Report.pdf',
] as const

interface FigureTraceStep {
  step: string
  outcome?: string
  changedDocumentBytes?: boolean
  score: number
  grade: string
  altText: number | null
  pdfUaCompliance: number | null
  blockingFindingKeys: string[]
  warningFindingKeys: string[]
  figureCandidateCounts: {
    total: number
    setAlt: number
    retagThenSetAlt: number
    defer: number
    decorativeHint: number
  }
  autoRunnableFigureTools: string[]
  structureSignals: {
    hasStructTree: boolean
    hasMarkInfo: boolean
    figureNodeCount: number
    imageStructNodeCount: number
  }
}

interface FigureTraceFile {
  filename: string
  steps: FigureTraceStep[]
}

interface FigureTraceArtifact {
  generatedAt: string
  files: FigureTraceFile[]
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
  extra?: Partial<FigureTraceStep>,
): Promise<FigureTraceStep> {
  const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
  const failureArtifacts = buildFailureProfileArtifacts({
    analysis,
    context,
    actions,
    rejectedActions: [],
  })
  const findings = analysis.localStandards?.findings ?? []
  const figureCandidates = context.figureCandidates || []
  return {
    step,
    score: analysis.overallScore,
    grade: analysis.grade,
    altText: categoryScore(analysis, 'alt_text'),
    pdfUaCompliance: categoryScore(analysis, 'pdf_ua_compliance'),
    blockingFindingKeys: findings.filter((finding: any) => finding.blocking).map((finding: any) => finding.key),
    warningFindingKeys: findings.filter((finding: any) => !finding.blocking).map((finding: any) => finding.key),
    figureCandidateCounts: {
      total: figureCandidates.length,
      setAlt: figureCandidates.filter((candidate: any) => candidate.repairMode === 'set_alt').length,
      retagThenSetAlt: figureCandidates.filter((candidate: any) => candidate.repairMode === 'retag_then_set_alt').length,
      defer: figureCandidates.filter((candidate: any) => candidate.repairMode === 'defer').length,
      decorativeHint: figureCandidates.filter((candidate: any) => candidate.informativeHint === 'decorative').length,
    },
    autoRunnableFigureTools: failureArtifacts.failureProfile.toolOpportunities
      .filter((opportunity: any) =>
        opportunity.status === 'auto_runnable'
        && ['repair_native_figure_semantics', 'repair_other_elements_alt_text', 'set_figure_alt_text', 'retag_as_figure_and_set_alt', 'mark_figure_decorative'].includes(opportunity.toolName),
      )
      .map((opportunity: any) => opportunity.key),
    structureSignals: {
      hasStructTree: !!context.qpdf.hasStructTree,
      hasMarkInfo: !!context.qpdf.hasMarkInfo,
      figureNodeCount: context.structure.figures?.length || 0,
      imageStructNodeCount: context.structure.imageStructNodes?.length || 0,
    },
    ...extra,
  }
}

async function executeDocumentStep(
  buffer: Buffer,
  analysis: any,
  filename: string,
  toolName: 'repair_native_figure_semantics' | 'repair_other_elements_alt_text' | 'mark_figure_decorative',
) {
  const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
  return executeRemediationTool({
    buffer,
    context,
    call: {
      tool_name: toolName,
      arguments: { target: 'document' },
      rationale: 'Long-report figure cleanup trace.',
      confidence: 0.95,
    },
  })
}

async function traceFile(filename: string): Promise<FigureTraceFile> {
  const pdfPath = path.join(repoRoot(), 'Processed', 'After', filename)
  let buffer = await fs.readFile(pdfPath) as Buffer
  let analysis = await analyzePDF(buffer, filename, {
    analysisProfile: 'remediation_fast',
    skipAdobe: true,
    skipVeraPdf: true,
  })
  const actions: RemediationActionRecord[] = []
  const steps: FigureTraceStep[] = [await summarizeStep('baseline', filename, buffer, analysis, actions)]

  for (const toolName of ['repair_native_figure_semantics', 'repair_other_elements_alt_text', 'mark_figure_decorative'] as const) {
    const outcome = await executeDocumentStep(buffer, analysis, filename, toolName)
    buffer = outcome.buffer
    actions.push(outcome.action)
    analysis = await analyzePDF(buffer, filename, {
      analysisProfile: 'remediation_fast',
      skipAdobe: true,
      skipVeraPdf: true,
    })
    steps.push(await summarizeStep(toolName, filename, buffer, analysis, actions, {
      outcome: outcome.action.outcome,
      changedDocumentBytes: outcome.action.changedDocumentBytes,
    }))
  }

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const candidates = selectHighConfidenceLongReportFigureCandidates(context.figureCandidates, { maxCandidates: 5 })
      .filter(candidate => candidate.repairMode === 'set_alt')
    let batchChanged = false
    let finalOutcome = 'no_effect'
    for (const candidate of candidates) {
      const outcome = await executeRemediationTool({
        buffer,
        context: await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' }),
        call: {
          tool_name: 'set_figure_alt_text',
          arguments: {
            candidateId: candidate.id,
            altText: heuristicFigureAltText(candidate.id, context),
            generationSource: 'heuristic_fallback',
          },
          rationale: 'Bounded long-report figure trace alt-text batch.',
          confidence: 0.9,
        },
      })
      buffer = outcome.buffer
      actions.push(outcome.action)
      batchChanged = batchChanged || !!outcome.action.changedDocumentBytes
      if (outcome.action.outcome === 'applied') finalOutcome = 'applied'
      analysis = await analyzePDF(buffer, filename, {
        analysisProfile: 'remediation_fast',
        skipAdobe: true,
        skipVeraPdf: true,
      })
    }
    steps.push(await summarizeStep('set_figure_alt_text_batch', filename, buffer, analysis, actions, {
      outcome: finalOutcome,
      changedDocumentBytes: batchChanged,
    }))
  }

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const candidates = selectHighConfidenceLongReportFigureCandidates(context.figureCandidates, { maxCandidates: 5 })
      .filter(candidate => candidate.repairMode === 'retag_then_set_alt')
    let batchChanged = false
    let finalOutcome = 'no_effect'
    for (const candidate of candidates) {
      const outcome = await executeRemediationTool({
        buffer,
        context: await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' }),
        call: {
          tool_name: 'retag_as_figure_and_set_alt',
          arguments: {
            candidateId: candidate.id,
            altText: heuristicFigureAltText(candidate.id, context),
            generationSource: 'heuristic_fallback',
          },
          rationale: 'Bounded long-report figure trace retag batch.',
          confidence: 0.9,
        },
      })
      buffer = outcome.buffer
      actions.push(outcome.action)
      batchChanged = batchChanged || !!outcome.action.changedDocumentBytes
      if (outcome.action.outcome === 'applied') finalOutcome = 'applied'
      analysis = await analyzePDF(buffer, filename, {
        analysisProfile: 'remediation_fast',
        skipAdobe: true,
        skipVeraPdf: true,
      })
    }
    steps.push(await summarizeStep('retag_as_figure_and_set_alt_batch', filename, buffer, analysis, actions, {
      outcome: finalOutcome,
      changedDocumentBytes: batchChanged,
    }))
  }

  return { filename, steps }
}

async function main() {
  const filenames = process.argv.slice(2)
  const targetFiles = filenames.length ? filenames : [...DEFAULT_FILES]
  const files: FigureTraceFile[] = []
  for (const filename of targetFiles) {
    files.push(await traceFile(filename))
  }

  const artifact: FigureTraceArtifact = {
    generatedAt: new Date().toISOString(),
    files,
  }

  const outputDir = path.join(repoRoot(), 'MitigationAttempts', 'long-report-figure-traces')
  await fs.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${timestampForFilename(new Date())}.long-report-figure-trace.json`)
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
