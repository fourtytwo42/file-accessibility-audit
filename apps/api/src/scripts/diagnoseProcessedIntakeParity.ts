import fs from 'node:fs/promises'
import path from 'node:path'
import type { ModelReviewFlag, RemediationActionRecord, RemediationIteration } from '../services/documentModel.js'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { buildFailureProfileArtifacts } from '../services/failureProfileService.js'
import { remediatePdfWithAgent } from '../services/agentRemediationService.js'
import { inspectPdfForRemediation } from '../services/pdfRemediationTools.js'
import {
  buildLiveResidualFamilyState,
  type LiveResidualFamilyState,
} from '../services/liveResidualFamilyDiagnosisService.js'
import {
  buildProcessedIntakeParityArtifact,
  buildProcessedIntakeParityPairReport,
  buildProcessedIntakeParityState,
  type ProcessedIntakeParityArtifact,
  type ProcessedIntakeParityPairReport,
  type ProcessedIntakeParityState,
} from '../services/processedIntakeParityService.js'
import { PROCESSED_REGRESSION_MANIFEST } from './processedRegressionManifest.js'

type ParsedArgs = {
  beforeFilenames: string[]
  all: boolean
}

function repoRoot(): string {
  return path.resolve(process.cwd(), '../..')
}

function timestampForFilename(input: Date): string {
  return input.toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z')
}

function relativeToRepoRoot(inputPath: string): string {
  return path.relative(repoRoot(), inputPath) || path.basename(inputPath)
}

function sanitizeBasename(filename: string): string {
  return filename
    .replace(/\.pdf$/i, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function parseArgs(argv: string[]): ParsedArgs {
  const beforeFilenames: string[] = []
  let all = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--pair') {
      const beforeFilename = argv[index + 1]
      if (!beforeFilename) {
        throw new Error('Expected --pair <processed-before filename>.')
      }
      beforeFilenames.push(beforeFilename)
      index += 1
      continue
    }
    if (arg === '--all') {
      all = true
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!all && !beforeFilenames.length) {
    throw new Error('Expected --pair <processed-before filename> or --all.')
  }

  return {
    beforeFilenames,
    all,
  }
}

function manifestPairsForArgs(parsed: ParsedArgs) {
  if (parsed.all) return [...PROCESSED_REGRESSION_MANIFEST.pairs]
  return parsed.beforeFilenames.map(beforeFilename => {
    const match = PROCESSED_REGRESSION_MANIFEST.pairs.find(pair => pair.beforeFilename === beforeFilename)
    if (!match) {
      throw new Error(`No processed regression pair found for ${beforeFilename}.`)
    }
    return match
  })
}

async function buildLiveState(input: {
  buffer: Buffer
  filePath: string
  filename: string
  analysisProfile: 'remediation_fast' | 'full_final'
  manualReviewFlags?: ModelReviewFlag[] | null
  actions?: RemediationActionRecord[]
  rejectedActions?: RemediationActionRecord[]
  iterations?: RemediationIteration[]
}): Promise<LiveResidualFamilyState> {
  const analysis = await analyzePDF(input.buffer, input.filename, {
    analysisProfile: input.analysisProfile,
    skipAdobe: true,
    skipVeraPdf: true,
  })
  const context = await inspectPdfForRemediation(input.buffer, analysis, { inspectMode: 'light' })
  const artifacts = buildFailureProfileArtifacts({
    analysis,
    context,
    actions: input.actions || [],
    rejectedActions: input.rejectedActions || [],
    iterations: input.iterations,
  })
  return buildLiveResidualFamilyState({
    filePath: input.filePath,
    overallScore: analysis.overallScore,
    grade: analysis.grade,
    failureProfile: artifacts.failureProfile,
    plannerEvidence: artifacts.plannerEvidence,
    manualReviewFlags: input.manualReviewFlags || [],
  })
}

async function buildParityState(input: {
  buffer: Buffer
  filePath: string
  filename: string
  manualReviewFlags?: ModelReviewFlag[] | null
  actions?: RemediationActionRecord[]
  rejectedActions?: RemediationActionRecord[]
  iterations?: RemediationIteration[]
}): Promise<ProcessedIntakeParityState> {
  const planningProfile = await buildLiveState({
    buffer: input.buffer,
    filePath: input.filePath,
    filename: input.filename,
    analysisProfile: 'remediation_fast',
    manualReviewFlags: input.manualReviewFlags,
    actions: input.actions,
    rejectedActions: input.rejectedActions,
    iterations: input.iterations,
  })
  const fullAudit = await buildLiveState({
    buffer: input.buffer,
    filePath: input.filePath,
    filename: input.filename,
    analysisProfile: 'full_final',
    manualReviewFlags: input.manualReviewFlags,
    actions: input.actions,
    rejectedActions: input.rejectedActions,
    iterations: input.iterations,
  })
  return buildProcessedIntakeParityState({
    path: input.filePath,
    filename: input.filename,
    planningProfile,
    fullAudit,
  })
}

async function buildRuntimeState(input: {
  beforeFilename: string
  outputDir: string
}): Promise<ProcessedIntakeParityState> {
  const beforePath = path.join(repoRoot(), PROCESSED_REGRESSION_MANIFEST.beforeDir, input.beforeFilename)
  const beforeBuffer = await fs.readFile(beforePath)
  const beforeAnalysis = await analyzePDF(beforeBuffer, input.beforeFilename, {
    analysisProfile: 'full_final',
    skipAdobe: true,
    skipVeraPdf: true,
  })
  const remediated = await remediatePdfWithAgent(beforeBuffer, input.beforeFilename, beforeAnalysis)
  const runtimePdfPath = path.join(input.outputDir, `${sanitizeBasename(input.beforeFilename)}.runtime.pdf`)
  await fs.writeFile(runtimePdfPath, remediated.buffer)
  return buildParityState({
    buffer: remediated.buffer,
    filePath: runtimePdfPath,
    filename: path.basename(runtimePdfPath),
    manualReviewFlags: remediated.model.manualReviewFlags || [],
    actions: remediated.model.actions || [],
    rejectedActions: remediated.model.rejectedActions || [],
    iterations: remediated.model.iterations || [],
  })
}

async function buildPairReport(input: {
  beforeFilename: string
  afterFilename: string
  outputDir: string
}): Promise<ProcessedIntakeParityPairReport> {
  const beforePath = path.join(repoRoot(), PROCESSED_REGRESSION_MANIFEST.beforeDir, input.beforeFilename)
  const afterPath = path.join(repoRoot(), PROCESSED_REGRESSION_MANIFEST.afterDir, input.afterFilename)
  const [beforeBuffer, afterBuffer] = await Promise.all([
    fs.readFile(beforePath),
    fs.readFile(afterPath),
  ])

  const [before, runtime, storedAfter] = await Promise.all([
    buildParityState({
      buffer: beforeBuffer,
      filePath: beforePath,
      filename: input.beforeFilename,
    }),
    buildRuntimeState({
      beforeFilename: input.beforeFilename,
      outputDir: input.outputDir,
    }),
    buildParityState({
      buffer: afterBuffer,
      filePath: afterPath,
      filename: input.afterFilename,
    }),
  ])

  return buildProcessedIntakeParityPairReport({
    beforeFilename: input.beforeFilename,
    afterFilename: input.afterFilename,
    before,
    runtime,
    storedAfter,
  })
}

export async function buildProcessedIntakeParityFromManifest(input: ParsedArgs): Promise<ProcessedIntakeParityArtifact> {
  const pairs = manifestPairsForArgs(input)
  const outputDir = path.join(repoRoot(), 'MitigationAttempts', 'processed-intake-parity')
  await fs.mkdir(outputDir, { recursive: true })

  const reports: ProcessedIntakeParityPairReport[] = []
  for (const pair of pairs) {
    reports.push(await buildPairReport({
      beforeFilename: pair.beforeFilename,
      afterFilename: pair.afterFilename,
      outputDir,
    }))
  }

  return buildProcessedIntakeParityArtifact({
    pairs: reports,
  })
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  const artifact = await buildProcessedIntakeParityFromManifest(parsed)
  const outputDir = path.join(repoRoot(), 'MitigationAttempts', 'processed-intake-parity')
  await fs.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${timestampForFilename(new Date())}.processed-intake-parity.json`)
  await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2), 'utf8')

  console.log(JSON.stringify({
    outputPath: relativeToRepoRoot(outputPath),
    pairCount: artifact.summary.pairCount,
    familyCompletionGapCount: artifact.summary.familyCompletionGapCount,
    fullAuditTailCount: artifact.summary.fullAuditTailCount,
    nextBlockingFamilies: artifact.summary.nextBlockingFamilies,
    pairs: artifact.pairs.map(pair => ({
      before: pair.beforeFilename,
      runtimePdf: relativeToRepoRoot(pair.runtime.path),
      nextBlockingFamily: pair.nextBlockingFamily,
      familyCompletionGap: pair.familyCompletionGap,
      runtimePlanningScore: pair.runtime.planningProfile.overallScore,
      runtimeFullAuditScore: pair.runtime.fullAudit.overallScore,
      storedAfterPlanningScore: pair.storedAfter.planningProfile.overallScore,
      storedAfterFullAuditScore: pair.storedAfter.fullAudit.overallScore,
    })),
  }, null, 2))

  if (artifact.summary.familyCompletionGapCount > 0) {
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
