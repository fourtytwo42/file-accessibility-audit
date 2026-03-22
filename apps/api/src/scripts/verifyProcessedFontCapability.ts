import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { buildFailureProfileArtifacts } from '../services/failureProfileService.js'
import {
  executeRemediationTool,
  inspectPdfForRemediation,
} from '../services/pdfRemediationTools.js'
import type { RemediationActionRecord } from '../services/documentModel.js'
import { PROCESSED_REGRESSION_MANIFEST } from './processedRegressionManifest.js'

const DIRECT_FONT_REPAIR_KEY = 'repair_font_unicode_maps:document:document'

export interface ProcessedFontCapabilityState {
  filename: string
  overallScore: number
  grade: string
  blockingFindingKeys: string[]
  plannerAutoRunnableKeys: string[]
  qpdf: {
    fontsMissingToUnicode: number
    fontsMissingToUnicodeBlocking: number
    fontsMissingToUnicodeProxy: number
    fontsMissingToUnicodeAdvisory: number
    cidSetRiskFontCount: number
    legacyWidthRiskFontCount: number
  }
}

export interface ProcessedFontCapabilityFileReport {
  filename: string
  baseline: ProcessedFontCapabilityState
  postRepair: ProcessedFontCapabilityState
  repairOutcome: string
}

export interface ProcessedFontCapabilityIssue {
  key: string
  filename: string
  message: string
}

export interface ProcessedStaticAfterAnalysis {
  filename: string
  overallScore: number
  grade: string
  plannerAutoRunnableKeys: string[]
}

export interface ProcessedFontCapabilityClassification {
  fontOnlyStaticMisses: string[]
  nonFontStaticMisses: string[]
}

export interface ProcessedFontCapabilityArtifact {
  generatedAt: string
  summary: {
    fileCount: number
    baselineImperfectCount: number
    directRepairableCount: number
    unresolvedAfterDirectRepairCount: number
    regressionCount: number
  }
  buckets: {
    baselineImperfectButDirectlyRepairable: string[]
    stillUnresolvedAfterDirectFontRepair: string[]
    nonFontStaticMisses: string[]
  }
  nextTrueBlockers: string[]
  regressions: ProcessedFontCapabilityIssue[]
  files: ProcessedFontCapabilityFileReport[]
}

function repoRoot(): string {
  return path.resolve(process.cwd(), '../..')
}

function timestampForFilename(input: Date): string {
  return input.toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z')
}

function gradeWeight(grade: string): number {
  return ['F', 'D', 'C', 'B', 'A'].indexOf(grade)
}

function isPerfectScore(score: number, grade: string): boolean {
  return score === 100 && grade === 'A'
}

function isFontAutoRunnableKey(key: string): boolean {
  return key === DIRECT_FONT_REPAIR_KEY
}

function isStaticMiss(entry: ProcessedStaticAfterAnalysis): boolean {
  return !isPerfectScore(entry.overallScore, entry.grade) || entry.plannerAutoRunnableKeys.length > 0
}

function hasOnlyFontAutoRunnable(entry: ProcessedStaticAfterAnalysis): boolean {
  return entry.plannerAutoRunnableKeys.length > 0 && entry.plannerAutoRunnableKeys.every(isFontAutoRunnableKey)
}

async function summarizeState(
  buffer: Buffer,
  filename: string,
  actions: RemediationActionRecord[],
): Promise<ProcessedFontCapabilityState> {
  const analysis = await analyzePDF(buffer, filename, {
    analysisProfile: 'remediation_fast',
    skipAdobe: true,
    skipVeraPdf: true,
  })
  const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
  const artifacts = buildFailureProfileArtifacts({
    analysis,
    context,
    actions,
    rejectedActions: [],
  })
  return {
    filename,
    overallScore: analysis.overallScore,
    grade: analysis.grade,
    blockingFindingKeys: (analysis.localStandards?.findings ?? [])
      .filter((finding: any) => finding.blocking)
      .map((finding: any) => finding.key)
      .sort(),
    plannerAutoRunnableKeys: artifacts.failureProfile.toolOpportunities
      .filter((opportunity: any) => opportunity.status === 'auto_runnable')
      .map((opportunity: any) => opportunity.key)
      .sort(),
    qpdf: {
      fontsMissingToUnicode: context.qpdf.fontsMissingToUnicode ?? 0,
      fontsMissingToUnicodeBlocking: context.qpdf.fontsMissingToUnicodeBlocking ?? context.qpdf.fontsMissingToUnicode ?? 0,
      fontsMissingToUnicodeProxy: context.qpdf.fontsMissingToUnicodeProxy ?? 0,
      fontsMissingToUnicodeAdvisory: context.qpdf.fontsMissingToUnicodeAdvisory ?? 0,
      cidSetRiskFontCount: context.qpdf.cidSetRiskFontCount ?? 0,
      legacyWidthRiskFontCount: context.qpdf.legacyWidthRiskFontCount ?? 0,
    },
  }
}

async function analyzeProcessedAfterFile(filename: string): Promise<ProcessedStaticAfterAnalysis> {
  const pdfPath = path.join(repoRoot(), 'Processed', 'After', filename)
  const buffer = await fs.readFile(pdfPath)
  const state = await summarizeState(buffer, filename, [])
  return {
    filename,
    overallScore: state.overallScore,
    grade: state.grade,
    plannerAutoRunnableKeys: state.plannerAutoRunnableKeys,
  }
}

export function classifyProcessedStaticMisses(
  files: ProcessedStaticAfterAnalysis[],
): ProcessedFontCapabilityClassification {
  const fontOnlyStaticMisses: string[] = []
  const nonFontStaticMisses: string[] = []

  for (const file of files) {
    if (!isStaticMiss(file)) continue
    if (hasOnlyFontAutoRunnable(file)) {
      fontOnlyStaticMisses.push(file.filename)
    } else {
      nonFontStaticMisses.push(file.filename)
    }
  }

  return {
    fontOnlyStaticMisses: fontOnlyStaticMisses.sort(),
    nonFontStaticMisses: nonFontStaticMisses.sort(),
  }
}

async function buildFileReport(filename: string): Promise<ProcessedFontCapabilityFileReport> {
  const pdfPath = path.join(repoRoot(), 'Processed', 'After', filename)
  const buffer = await fs.readFile(pdfPath) as Buffer
  const baseline = await summarizeState(buffer, filename, [])
  const beforeAnalysis = await analyzePDF(buffer, filename, {
    analysisProfile: 'remediation_fast',
    skipAdobe: true,
    skipVeraPdf: true,
  })
  const beforeContext = await inspectPdfForRemediation(buffer, beforeAnalysis, { inspectMode: 'light' })
  const repair = await executeRemediationTool({
    buffer,
    context: beforeContext,
    call: {
      tool_name: 'repair_font_unicode_maps',
      arguments: { target: 'document' },
      rationale: 'Processed font capability verification.',
      confidence: 0.95,
    },
  })
  const postRepair = await summarizeState(repair.buffer, filename, [repair.action])
  return {
    filename,
    baseline,
    postRepair,
    repairOutcome: repair.action.outcome,
  }
}

function isDirectlyRepairable(file: ProcessedFontCapabilityFileReport): boolean {
  return file.repairOutcome === 'applied'
    && isPerfectScore(file.postRepair.overallScore, file.postRepair.grade)
    && !file.postRepair.blockingFindingKeys.includes('pdfua.font_unicode')
    && file.postRepair.qpdf.fontsMissingToUnicodeBlocking === 0
    && !file.postRepair.plannerAutoRunnableKeys.some(isFontAutoRunnableKey)
}

export function evaluateProcessedFontCapabilityArtifact(
  files: ProcessedFontCapabilityFileReport[],
  classification?: ProcessedFontCapabilityClassification,
): ProcessedFontCapabilityArtifact {
  const regressions: ProcessedFontCapabilityIssue[] = []

  for (const file of files) {
    if (file.repairOutcome !== 'applied') {
      regressions.push({
        key: `repair_not_applied:${file.filename}`,
        filename: file.filename,
        message: `${file.filename} no longer reports an applied repair_font_unicode_maps outcome.`,
      })
    }

    if (file.postRepair.overallScore !== 100 || file.postRepair.grade !== 'A') {
      regressions.push({
        key: `post_repair_not_perfect:${file.filename}`,
        filename: file.filename,
        message: `${file.filename} only reached ${file.postRepair.overallScore}/${file.postRepair.grade} after direct repair.`,
      })
    }

    if (file.postRepair.blockingFindingKeys.includes('pdfua.font_unicode')) {
      regressions.push({
        key: `post_repair_font_unicode_blocking:${file.filename}`,
        filename: file.filename,
        message: `${file.filename} still has blocking pdfua.font_unicode after direct repair.`,
      })
    }

    if (file.postRepair.qpdf.fontsMissingToUnicodeBlocking > 0) {
      regressions.push({
        key: `post_repair_blocking_counter:${file.filename}`,
        filename: file.filename,
        message: `${file.filename} still has ${file.postRepair.qpdf.fontsMissingToUnicodeBlocking} blocking ToUnicode counter(s) after direct repair.`,
      })
    }

    if (file.postRepair.plannerAutoRunnableKeys.some(isFontAutoRunnableKey)) {
      regressions.push({
        key: `post_repair_font_auto_runnable:${file.filename}`,
        filename: file.filename,
        message: `${file.filename} still exposes repair_font_unicode_maps as auto-runnable after direct repair.`,
      })
    }
  }

  const baselineImperfectButDirectlyRepairable = files
    .filter(file => !isPerfectScore(file.baseline.overallScore, file.baseline.grade) && isDirectlyRepairable(file))
    .map(file => file.filename)
    .sort()
  const stillUnresolvedAfterDirectFontRepair = files
    .filter(file => !isDirectlyRepairable(file))
    .map(file => file.filename)
    .sort()
  const nonFontStaticMisses = [...(classification?.nonFontStaticMisses ?? [])].sort()

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      fileCount: files.length,
      baselineImperfectCount: files.filter(file => !isPerfectScore(file.baseline.overallScore, file.baseline.grade)).length,
      directRepairableCount: baselineImperfectButDirectlyRepairable.length,
      unresolvedAfterDirectRepairCount: stillUnresolvedAfterDirectFontRepair.length,
      regressionCount: regressions.length,
    },
    buckets: {
      baselineImperfectButDirectlyRepairable,
      stillUnresolvedAfterDirectFontRepair,
      nonFontStaticMisses,
    },
    nextTrueBlockers: [...stillUnresolvedAfterDirectFontRepair, ...nonFontStaticMisses].sort((a, b) => {
      const aScore = classification?.nonFontStaticMisses.includes(a) ? 0 : 1
      const bScore = classification?.nonFontStaticMisses.includes(b) ? 0 : 1
      return aScore - bScore || a.localeCompare(b)
    }),
    regressions,
    files,
  }
}

async function discoverCurrentStaticMisses(): Promise<ProcessedFontCapabilityClassification> {
  const analyses: ProcessedStaticAfterAnalysis[] = []
  for (const pair of PROCESSED_REGRESSION_MANIFEST.pairs) {
    analyses.push(await analyzeProcessedAfterFile(pair.afterFilename))
  }
  return classifyProcessedStaticMisses(analyses)
}

async function main() {
  const filenames = process.argv.slice(2)
  const classification = await discoverCurrentStaticMisses()
  const targetFiles = filenames.length ? filenames : classification.fontOnlyStaticMisses
  const files: ProcessedFontCapabilityFileReport[] = []
  for (const filename of targetFiles) {
    files.push(await buildFileReport(filename))
  }

  const artifact = evaluateProcessedFontCapabilityArtifact(files, classification)
  const outputDir = path.join(repoRoot(), 'MitigationAttempts', 'processed-font-capability')
  await fs.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${timestampForFilename(new Date())}.processed-font-capability.json`)
  await fs.writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')

  console.log(JSON.stringify({
    outputPath: path.relative(repoRoot(), outputPath),
    classification,
    ...artifact,
  }, null, 2))

  if (artifact.regressions.length > 0) {
    process.exitCode = 1
  }
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isMainModule) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}
