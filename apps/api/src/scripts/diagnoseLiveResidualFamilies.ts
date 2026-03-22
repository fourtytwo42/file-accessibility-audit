import fs from 'node:fs/promises'
import path from 'node:path'
import type { ModelReviewFlag } from '../services/documentModel.js'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { buildFailureProfileArtifacts } from '../services/failureProfileService.js'
import { inspectPdfForRemediation } from '../services/pdfRemediationTools.js'
import {
  buildLiveResidualFamilyDiagnosisArtifact,
  buildLiveResidualFamilyState,
  type LiveResidualFamilyDiagnosisArtifact,
  type LiveResidualFamilyState,
} from '../services/liveResidualFamilyDiagnosisService.js'

function repoRoot(): string {
  return path.resolve(process.cwd(), '../..')
}

function timestampForFilename(input: Date): string {
  return input.toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z')
}

function resolveInputPath(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(repoRoot(), inputPath)
}

function relativeToRepoRoot(inputPath: string): string {
  return path.relative(repoRoot(), inputPath) || path.basename(inputPath)
}

async function readManualReviewFlagsIfPresent(pdfPath: string): Promise<ModelReviewFlag[] | undefined> {
  const basename = pdfPath.replace(/\.pdf$/i, '')
  const candidates = [
    `${basename}.manual-review.json`,
    `${basename}.model.json`,
    `${basename}.json`,
  ]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidate, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        return parsed as ModelReviewFlag[]
      }
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { manualReviewFlags?: unknown }).manualReviewFlags)) {
        return (parsed as { manualReviewFlags: ModelReviewFlag[] }).manualReviewFlags
      }
    } catch {
      continue
    }
  }
  return undefined
}

async function diagnosePdfPath(pdfPath: string): Promise<LiveResidualFamilyState> {
  const absolutePath = resolveInputPath(pdfPath)
  const buffer = await fs.readFile(absolutePath)
  const filename = path.basename(absolutePath)
  const analysis = await analyzePDF(buffer, filename, {
    analysisProfile: 'remediation_fast',
    skipAdobe: true,
    skipVeraPdf: true,
  })
  const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
  const artifacts = buildFailureProfileArtifacts({
    analysis,
    context,
    actions: [],
    rejectedActions: [],
  })
  return buildLiveResidualFamilyState({
    filePath: absolutePath,
    overallScore: analysis.overallScore,
    grade: analysis.grade,
    failureProfile: artifacts.failureProfile,
    plannerEvidence: artifacts.plannerEvidence,
    manualReviewFlags: await readManualReviewFlagsIfPresent(absolutePath),
  })
}

type ParsedArgs = {
  pairs: Array<{ source: string; attempt: string }>
  controls: string[]
}

function parseArgs(argv: string[]): ParsedArgs {
  const pairs: Array<{ source: string; attempt: string }> = []
  const controls: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--pair') {
      const source = argv[index + 1]
      const attempt = argv[index + 2]
      if (!source || !attempt) {
        throw new Error('Expected --pair <source-pdf> <attempt-pdf>.')
      }
      pairs.push({ source, attempt })
      index += 2
      continue
    }
    if (arg === '--control') {
      const control = argv[index + 1]
      if (!control) {
        throw new Error('Expected --control <pdf>.')
      }
      controls.push(control)
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!pairs.length) {
    throw new Error('At least one --pair <source-pdf> <attempt-pdf> is required.')
  }

  return { pairs, controls }
}

export async function buildLiveResidualFamilyDiagnosisFromPaths(input: ParsedArgs): Promise<LiveResidualFamilyDiagnosisArtifact> {
  const pairs = []
  for (const pair of input.pairs) {
    pairs.push({
      source: await diagnosePdfPath(pair.source),
      attempt: await diagnosePdfPath(pair.attempt),
    })
  }

  const controls: LiveResidualFamilyState[] = []
  for (const control of input.controls) {
    controls.push(await diagnosePdfPath(control))
  }

  return buildLiveResidualFamilyDiagnosisArtifact({
    pairs,
    controls,
  })
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  const artifact = await buildLiveResidualFamilyDiagnosisFromPaths(parsed)
  const outputDir = path.join(repoRoot(), 'MitigationAttempts', 'live-residual-family-diagnosis')
  await fs.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${timestampForFilename(new Date())}.live-residual-family-diagnosis.json`)
  await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2), 'utf8')
  console.log(JSON.stringify({
    outputPath: relativeToRepoRoot(outputPath),
    pairCount: artifact.pairs.length,
    controlCount: artifact.controls.length,
    topAttemptBlockers: artifact.pairs.map(pair => ({
      attempt: relativeToRepoRoot(pair.attempt.path),
      blocker: pair.familyDiff.attemptTopBlocker,
      semanticSidecarState: pair.attempt.semanticSidecarState,
    })),
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
