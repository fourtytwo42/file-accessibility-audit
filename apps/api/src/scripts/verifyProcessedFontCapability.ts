import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { buildFailureProfileArtifacts } from '../services/failureProfileService.js'
import {
  executeRemediationTool,
  inspectPdfForRemediation,
} from '../services/pdfRemediationTools.js'
import type { RemediationActionRecord, RemediationToolCall } from '../services/documentModel.js'
import { PROCESSED_REGRESSION_MANIFEST } from './processedRegressionManifest.js'

const DIRECT_FONT_REPAIR_KEY = 'repair_font_unicode_maps:document:document'
const DIRECT_BOOKMARK_REPAIR_KEY = 'replace_bookmarks_from_headings:document:document'

export interface ProcessedCapabilityState {
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

export interface ProcessedCapabilityFileReport {
  filename: string
  directRepairTool: 'repair_font_unicode_maps' | 'replace_bookmarks_from_headings' | null
  baseline: ProcessedCapabilityState
  postRepair: ProcessedCapabilityState | null
  repairOutcome: string | null
}

export type ProcessedFontCapabilityFileReport = ProcessedCapabilityFileReport

export interface ProcessedCapabilityIssue {
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

export interface ProcessedCapabilityClassification {
  fontOnlyStaticMisses: string[]
  nonFontStaticMisses: string[]
}

export interface ProcessedCapabilityArtifact {
  generatedAt: string
  summary: {
    fileCount: number
    baselineImperfectCount: number
    directRepairableCount: number
    unresolvedAfterDirectRepairCount: number
    regressionCount: number
  }
  buckets: {
    fontOnlyDirectlyRepairable: string[]
    nonFontDirectlyRepairable: string[]
    stillUnresolvedAfterDirectRepair: string[]
  }
  nextTrueBlockers: string[]
  regressions: ProcessedCapabilityIssue[]
  files: ProcessedCapabilityFileReport[]
}

export type ProcessedFontCapabilityArtifact = ProcessedCapabilityArtifact

function repoRoot(): string {
  return path.resolve(process.cwd(), '../..')
}

function timestampForFilename(input: Date): string {
  return input.toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z')
}

function isPerfectScore(score: number, grade: string): boolean {
  return score === 100 && grade === 'A'
}

function isFontAutoRunnableKey(key: string): boolean {
  return key === DIRECT_FONT_REPAIR_KEY
}

function isBookmarkAutoRunnableKey(key: string): boolean {
  return key === DIRECT_BOOKMARK_REPAIR_KEY
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
): Promise<ProcessedCapabilityState> {
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
): ProcessedCapabilityClassification {
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

function chooseDeterministicRepairTool(
  baseline: Pick<ProcessedCapabilityState, 'plannerAutoRunnableKeys'>,
): ProcessedCapabilityFileReport['directRepairTool'] {
  const keys = baseline.plannerAutoRunnableKeys
  if (keys.length === 1 && isFontAutoRunnableKey(keys[0])) return 'repair_font_unicode_maps'
  if (keys.length === 1 && isBookmarkAutoRunnableKey(keys[0])) return 'replace_bookmarks_from_headings'
  return null
}

async function executeDeterministicRepair(
  tool: NonNullable<ProcessedCapabilityFileReport['directRepairTool']>,
  buffer: Buffer,
  filename: string,
): Promise<{ action: RemediationActionRecord; buffer: Buffer }> {
  const analysis = await analyzePDF(buffer, filename, {
    analysisProfile: 'remediation_fast',
    skipAdobe: true,
    skipVeraPdf: true,
  })
  const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
  const call: RemediationToolCall = tool === 'repair_font_unicode_maps'
    ? {
        tool_name: 'repair_font_unicode_maps',
        arguments: { target: 'document' },
        rationale: 'Processed capability verification for direct font repair.',
        confidence: 0.95,
      }
    : {
        tool_name: 'replace_bookmarks_from_headings',
        arguments: { target: 'document' },
        rationale: 'Processed capability verification for direct bookmark repair.',
        confidence: 0.95,
      }
  const result = await executeRemediationTool({
    buffer,
    context,
    call,
  })
  return {
    action: result.action,
    buffer: result.buffer,
  }
}

async function buildFileReport(filename: string): Promise<ProcessedCapabilityFileReport> {
  const pdfPath = path.join(repoRoot(), 'Processed', 'After', filename)
  const buffer = await fs.readFile(pdfPath) as Buffer
  const baseline = await summarizeState(buffer, filename, [])
  const directRepairTool = chooseDeterministicRepairTool(baseline)
  if (!directRepairTool) {
    return {
      filename,
      directRepairTool,
      baseline,
      postRepair: null,
      repairOutcome: null,
    }
  }

  const repair = await executeDeterministicRepair(directRepairTool, buffer, filename)
  const postRepair = await summarizeState(repair.buffer, filename, [repair.action])
  return {
    filename,
    directRepairTool,
    baseline,
    postRepair,
    repairOutcome: repair.action.outcome,
  }
}

function isDirectlyRepairable(file: ProcessedCapabilityFileReport): boolean {
  if (!file.directRepairTool || !file.postRepair || file.repairOutcome !== 'applied') return false
  if (!isPerfectScore(file.postRepair.overallScore, file.postRepair.grade)) return false
  if (file.directRepairTool === 'repair_font_unicode_maps') {
    return !file.postRepair.blockingFindingKeys.includes('pdfua.font_unicode')
      && file.postRepair.qpdf.fontsMissingToUnicodeBlocking === 0
      && !file.postRepair.plannerAutoRunnableKeys.some(isFontAutoRunnableKey)
  }
  if (file.directRepairTool === 'replace_bookmarks_from_headings') {
    return !file.postRepair.blockingFindingKeys.includes('pdfua.bookmark_language')
      && !file.postRepair.plannerAutoRunnableKeys.some(isBookmarkAutoRunnableKey)
  }
  return false
}

export function evaluateProcessedFontCapabilityArtifact(
  files: ProcessedCapabilityFileReport[],
  classification?: ProcessedCapabilityClassification,
): ProcessedCapabilityArtifact {
  const regressions: ProcessedCapabilityIssue[] = []

  for (const file of files) {
    if (!file.directRepairTool) {
      regressions.push({
        key: `unsupported_direct_repair:${file.filename}`,
        filename: file.filename,
        message: `${file.filename} does not yet have a supported deterministic direct-repair path.`,
      })
      continue
    }

    if (file.repairOutcome !== 'applied') {
      regressions.push({
        key: `repair_not_applied:${file.filename}`,
        filename: file.filename,
        message: `${file.filename} no longer reports an applied ${file.directRepairTool} outcome.`,
      })
      continue
    }

    if (!file.postRepair || file.postRepair.overallScore !== 100 || file.postRepair.grade !== 'A') {
      regressions.push({
        key: `post_repair_not_perfect:${file.filename}`,
        filename: file.filename,
        message: `${file.filename} only reached ${file.postRepair?.overallScore ?? 'n/a'}/${file.postRepair?.grade ?? 'n/a'} after direct repair.`,
      })
    }

    if (file.directRepairTool === 'repair_font_unicode_maps') {
      if (file.postRepair?.blockingFindingKeys.includes('pdfua.font_unicode')) {
        regressions.push({
          key: `post_repair_font_unicode_blocking:${file.filename}`,
          filename: file.filename,
          message: `${file.filename} still has blocking pdfua.font_unicode after direct repair.`,
        })
      }

      if ((file.postRepair?.qpdf.fontsMissingToUnicodeBlocking ?? 0) > 0) {
        regressions.push({
          key: `post_repair_blocking_counter:${file.filename}`,
          filename: file.filename,
          message: `${file.filename} still has ${(file.postRepair?.qpdf.fontsMissingToUnicodeBlocking ?? 0)} blocking ToUnicode counter(s) after direct repair.`,
        })
      }

      if (file.postRepair?.plannerAutoRunnableKeys.some(isFontAutoRunnableKey)) {
        regressions.push({
          key: `post_repair_font_auto_runnable:${file.filename}`,
          filename: file.filename,
          message: `${file.filename} still exposes repair_font_unicode_maps as auto-runnable after direct repair.`,
        })
      }
    }

    if (file.directRepairTool === 'replace_bookmarks_from_headings') {
      if (file.postRepair?.blockingFindingKeys.includes('pdfua.bookmark_language')) {
        regressions.push({
          key: `post_repair_bookmark_language_blocking:${file.filename}`,
          filename: file.filename,
          message: `${file.filename} still has blocking pdfua.bookmark_language after direct repair.`,
        })
      }

      if (file.postRepair?.plannerAutoRunnableKeys.some(isBookmarkAutoRunnableKey)) {
        regressions.push({
          key: `post_repair_bookmark_auto_runnable:${file.filename}`,
          filename: file.filename,
          message: `${file.filename} still exposes replace_bookmarks_from_headings as auto-runnable after direct repair.`,
        })
      }
    }
  }

  const fontOnlyDirectlyRepairable = files
    .filter(file => isDirectlyRepairable(file) && file.directRepairTool === 'repair_font_unicode_maps')
    .map(file => file.filename)
    .sort()
  const nonFontDirectlyRepairable = files
    .filter(file => isDirectlyRepairable(file) && file.directRepairTool !== 'repair_font_unicode_maps')
    .map(file => file.filename)
    .sort()
  const stillUnresolvedAfterDirectRepair = files
    .filter(file => !isDirectlyRepairable(file))
    .map(file => file.filename)
    .sort()

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      fileCount: files.length,
      baselineImperfectCount: files.filter(file => !isPerfectScore(file.baseline.overallScore, file.baseline.grade)).length,
      directRepairableCount: fontOnlyDirectlyRepairable.length + nonFontDirectlyRepairable.length,
      unresolvedAfterDirectRepairCount: stillUnresolvedAfterDirectRepair.length,
      regressionCount: regressions.length,
    },
    buckets: {
      fontOnlyDirectlyRepairable,
      nonFontDirectlyRepairable,
      stillUnresolvedAfterDirectRepair,
    },
    nextTrueBlockers: [...stillUnresolvedAfterDirectRepair].sort((a, b) => {
      const aScore = classification?.nonFontStaticMisses.includes(a) ? 0 : 1
      const bScore = classification?.nonFontStaticMisses.includes(b) ? 0 : 1
      return aScore - bScore || a.localeCompare(b)
    }),
    regressions,
    files,
  }
}

async function discoverCurrentStaticMisses(): Promise<ProcessedCapabilityClassification> {
  const analyses: ProcessedStaticAfterAnalysis[] = []
  for (const pair of PROCESSED_REGRESSION_MANIFEST.pairs) {
    analyses.push(await analyzeProcessedAfterFile(pair.afterFilename))
  }
  return classifyProcessedStaticMisses(analyses)
}

async function main() {
  const filenames = process.argv.slice(2)
  const classification = await discoverCurrentStaticMisses()
  const targetFiles = filenames.length
    ? filenames
    : [...classification.fontOnlyStaticMisses, ...classification.nonFontStaticMisses]
  const files: ProcessedCapabilityFileReport[] = []
  for (const filename of targetFiles) {
    files.push(await buildFileReport(filename))
  }

  const artifact = evaluateProcessedFontCapabilityArtifact(files, classification)
  const outputDir = path.join(repoRoot(), 'MitigationAttempts', 'processed-capability')
  await fs.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${timestampForFilename(new Date())}.processed-capability.json`)
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
