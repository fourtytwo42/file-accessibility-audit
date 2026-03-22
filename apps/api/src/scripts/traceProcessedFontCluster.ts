import fs from 'node:fs/promises'
import path from 'node:path'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { buildFailureProfileArtifacts } from '../services/failureProfileService.js'
import {
  executeRemediationTool,
  inspectPdfForRemediation,
} from '../services/pdfRemediationTools.js'
import type { RemediationActionRecord, RemediationToolName } from '../services/documentModel.js'

const DEFAULT_FILES = [
  '11drug_seizures_1997-2007.pdf',
  '12drug_submissions_1997-2007.pdf',
  '13drug_treatment_1999-2008.pdf',
] as const

const FONT_TOOL_CHAIN = [
  'repair_font_unicode_maps',
  'repair_type1_font_unicode_maps',
  'substitute_legacy_fonts_in_place',
  'finalize_substituted_font_conformance',
] as const satisfies readonly RemediationToolName[]

interface FontTraceStep {
  step: string
  outcome?: string
  changedDocumentBytes?: boolean
  score: number
  grade: string
  textExtractability: number | null
  pdfUaCompliance: number | null
  blockingFindingKeys: string[]
  warningFindingKeys: string[]
  qpdf: {
    fontsMissingToUnicode: number
    fontsMissingToUnicodeBlocking: number
    fontsMissingToUnicodeProxy: number
    fontsMissingToUnicodeAdvisory: number
    cidSetRiskFontCount: number
    legacyWidthRiskFontCount: number
  }
  fontOperationSummary?: {
    operation: string
    embeddedFontProgramsAdded: number
    toUnicodeMapsAdded: number
    cidSetStreamsRebuilt: number
    substituteFontsApplied: number
    widthFixesApplied: number
    unresolvedWarningCount: number
  } | null
  autoRunnableFontTools: string[]
}

interface FontTraceFile {
  filename: string
  steps: FontTraceStep[]
}

interface FontTraceArtifact {
  generatedAt: string
  files: FontTraceFile[]
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

function fontToolKey(input: string): boolean {
  return [
    'repair_font_unicode_maps',
    'repair_type1_font_unicode_maps',
    'substitute_legacy_fonts_in_place',
    'finalize_substituted_font_conformance',
  ].some(prefix => input === prefix || input.startsWith(`${prefix}:`))
}

async function summarizeStep(
  step: string,
  buffer: Buffer,
  analysis: any,
  actions: RemediationActionRecord[],
  extra?: Partial<FontTraceStep>,
): Promise<FontTraceStep> {
  const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
  const failureArtifacts = buildFailureProfileArtifacts({
    analysis,
    context,
    actions,
    rejectedActions: [],
  })
  const findings = analysis.localStandards?.findings ?? []
  return {
    step,
    score: analysis.overallScore,
    grade: analysis.grade,
    textExtractability: categoryScore(analysis, 'text_extractability'),
    pdfUaCompliance: categoryScore(analysis, 'pdf_ua_compliance'),
    blockingFindingKeys: findings.filter((finding: any) => finding.blocking).map((finding: any) => finding.key),
    warningFindingKeys: findings.filter((finding: any) => !finding.blocking).map((finding: any) => finding.key),
    qpdf: {
      fontsMissingToUnicode: context.qpdf.fontsMissingToUnicode ?? 0,
      fontsMissingToUnicodeBlocking: context.qpdf.fontsMissingToUnicodeBlocking ?? context.qpdf.fontsMissingToUnicode ?? 0,
      fontsMissingToUnicodeProxy: context.qpdf.fontsMissingToUnicodeProxy ?? 0,
      fontsMissingToUnicodeAdvisory: context.qpdf.fontsMissingToUnicodeAdvisory ?? 0,
      cidSetRiskFontCount: context.qpdf.cidSetRiskFontCount ?? 0,
      legacyWidthRiskFontCount: context.qpdf.legacyWidthRiskFontCount ?? 0,
    },
    autoRunnableFontTools: failureArtifacts.failureProfile.toolOpportunities
      .filter((opportunity: any) => opportunity.status === 'auto_runnable' && fontToolKey(opportunity.toolName))
      .map((opportunity: any) => opportunity.key),
    ...extra,
  }
}

function shouldContinueFontChain(step: FontTraceStep): boolean {
  return step.qpdf.fontsMissingToUnicodeBlocking > 0
    || step.blockingFindingKeys.includes('pdfua.font_unicode')
    || step.autoRunnableFontTools.some(fontToolKey)
}

async function traceFile(filename: string): Promise<FontTraceFile> {
  const pdfPath = path.join(repoRoot(), 'Processed', 'After', filename)
  let buffer = await fs.readFile(pdfPath) as Buffer
  let analysis = await analyzePDF(buffer, filename, {
    analysisProfile: 'remediation_fast',
    skipAdobe: true,
    skipVeraPdf: true,
  })
  const actions: RemediationActionRecord[] = []
  const steps: FontTraceStep[] = []

  let currentStep = await summarizeStep('baseline', buffer, analysis, actions)
  steps.push(currentStep)

  for (const toolName of FONT_TOOL_CHAIN) {
    if (!shouldContinueFontChain(currentStep)) break
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const outcome = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: toolName,
        arguments: { target: 'document' },
        rationale: 'Processed font-cluster trace.',
        confidence: 0.95,
      },
    })
    buffer = outcome.buffer
    actions.push(outcome.action)
    analysis = await analyzePDF(buffer, filename, {
      analysisProfile: 'remediation_fast',
      skipAdobe: true,
      skipVeraPdf: true,
    })
    currentStep = await summarizeStep(toolName, buffer, analysis, actions, {
      outcome: outcome.action.outcome,
      changedDocumentBytes: outcome.action.changedDocumentBytes,
      fontOperationSummary: outcome.operationResult?.fontOperationSummary || null,
    })
    steps.push(currentStep)
  }

  return { filename, steps }
}

async function main() {
  const filenames = process.argv.slice(2)
  const targetFiles = filenames.length ? filenames : [...DEFAULT_FILES]
  const files: FontTraceFile[] = []
  for (const filename of targetFiles) {
    files.push(await traceFile(filename))
  }

  const artifact: FontTraceArtifact = {
    generatedAt: new Date().toISOString(),
    files,
  }

  const outputDir = path.join(repoRoot(), 'MitigationAttempts', 'font-cluster-traces')
  await fs.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${timestampForFilename(new Date())}.font-cluster-trace.json`)
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
