import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { analyzePdf } from '../apps/api/src/engine/index.ts'
import {
  buildBatchStatusSnapshot,
  classifyOutcomeResultBand,
  countOutcomeResultBands,
  createOrResumeProgressDocument,
  finalizeProgressDocument,
  readJsonIfExists,
  updateProgressDocument,
  writeJson,
  type ProgressCompatibleOutcome,
  type ProgressLastCompleted,
  type RemediationBatchProgressDocument,
  type RemediationResultBand,
  type RemediationScorePolicy,
} from './remediation-batch-progress.ts'

type HistoricalArtifactRecord = {
  publicationId: string | null
  publicationTitle: string | null
  status: string | null
  sourceManifest: string
  processedAt: string | null
  overallScore: number | null
  grade: string | null
  pageCount: number | null
  isScanned: boolean | null
  resultBand: string | null
}

type GradingCandidate = {
  artifactPath: string
  relativeArtifactPath: string
  waveName: string
  publicationId: string | null
  publicationTitle: string | null
  filename: string
  historical: HistoricalArtifactRecord | null
}

type GradingManifest = {
  generatedAt: string
  artifactRoot: string
  totals: {
    totalCandidates: number
  }
  candidates: GradingCandidate[]
}

type GradingOutcome = {
  artifactPath: string
  relativeArtifactPath: string
  waveName: string
  publicationId: string | null
  publicationTitle: string | null
  filename: string
  status: 'graded' | 'source_missing' | 'processing_error'
  resultBand: RemediationResultBand
  processedAt: string
  durationMs: number
  final: {
    overallScore: number | null
    grade: string | null
    pageCount: number | null
    isScanned: boolean | null
  } | null
  historical: HistoricalArtifactRecord | null
  comparison: {
    hasHistoricalScore: boolean
    hasHistoricalGrade: boolean
    exactScoreMatch: boolean | null
    exactGradeMatch: boolean | null
    scoreDelta: number | null
    gradeChanged: boolean | null
  }
  error: string | null
  artifacts: {
    reportPath: string | null
  }
}

type GradingOutcomesManifest = {
  generatedAt: string
  sourceManifestPath: string
  analysisProfile: 'full_final'
  concurrency: number
  totals: {
    targetCandidates: number
    processed: number
    graded: number
    sourceMissing: number
    processingError: number
    remaining: number
  }
  comparisons: {
    withHistoricalScore: number
    exactScoreMatch: number
    scoreDrift: number
    scoredHigherThanHistorical: number
    scoredLowerThanHistorical: number
    withHistoricalGrade: number
    exactGradeMatch: number
    gradeDrift: number
  }
  outcomes: GradingOutcome[]
}

const repoRoot = '/home/hendo420/pdfaf'
const icjiaRoot = path.join(repoRoot, 'ICJIA-PDFs')
const manifestsRoot = path.join(icjiaRoot, 'manifests')
const laneName = 'remediated-pdf-grading'
const manifestPath = path.join(manifestsRoot, `${laneName}.json`)
const outcomesPath = path.join(manifestsRoot, `${laneName}.outcomes.json`)
const outcomesSummaryPath = path.join(manifestsRoot, `${laneName}.outcomes.summary.json`)
const driftReportPath = path.join(manifestsRoot, `${laneName}.drift-report.json`)
const progressPath = outcomesPath.replace(/\.json$/i, '.progress.json')
const detailedReportRoot = path.join(icjiaRoot, 'reports', 'test-runs', laneName)

const concurrency = Number(process.env.ICJIA_GRADING_CONCURRENCY || 4)
const timeoutMs = Number(process.env.ICJIA_GRADING_TIMEOUT_MS || 30 * 60 * 1000)
const enforceSingleOwner = process.env.ICJIA_GRADING_ENFORCE_SINGLE_OWNER !== '0'
const scorePolicy: RemediationScorePolicy = {
  minPassOverallScore: 90,
  minKeepOverallScore: 80,
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function safeStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]+/g, '_').replace(/^_+|_+$/g, '') || 'item'
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`)
  }
}

function reportPathFor(candidate: GradingCandidate): string {
  const stem = safeStem(candidate.relativeArtifactPath.replace(/\.pdf$/i, ''))
  return path.join(detailedReportRoot, `${stem}.grading.json`)
}

function readManifest(): GradingManifest {
  return readJson<GradingManifest>(manifestPath)
}

function readExistingOutcomes(): GradingOutcome[] {
  return readJsonIfExists<GradingOutcomesManifest>(outcomesPath)?.outcomes || []
}

function comparisonSummary(outcomes: GradingOutcome[]) {
  let withHistoricalScore = 0
  let exactScoreMatch = 0
  let scoredHigherThanHistorical = 0
  let scoredLowerThanHistorical = 0
  let withHistoricalGrade = 0
  let exactGradeMatch = 0

  for (const outcome of outcomes) {
    if (outcome.comparison.hasHistoricalScore) {
      withHistoricalScore += 1
      if (outcome.comparison.exactScoreMatch) exactScoreMatch += 1
      if ((outcome.comparison.scoreDelta ?? 0) > 0) scoredHigherThanHistorical += 1
      if ((outcome.comparison.scoreDelta ?? 0) < 0) scoredLowerThanHistorical += 1
    }
    if (outcome.comparison.hasHistoricalGrade) {
      withHistoricalGrade += 1
      if (outcome.comparison.exactGradeMatch) exactGradeMatch += 1
    }
  }

  return {
    withHistoricalScore,
    exactScoreMatch,
    scoreDrift: withHistoricalScore - exactScoreMatch,
    scoredHigherThanHistorical,
    scoredLowerThanHistorical,
    withHistoricalGrade,
    exactGradeMatch,
    gradeDrift: withHistoricalGrade - exactGradeMatch,
  }
}

function writeOutcomeArtifacts(manifest: GradingManifest, outcomes: GradingOutcome[]): void {
  const countsByResultBand = countOutcomeResultBands(outcomes)
  const comparisons = comparisonSummary(outcomes)
  const processed = outcomes.length
  const outcomeDoc: GradingOutcomesManifest = {
    generatedAt: new Date().toISOString(),
    sourceManifestPath: manifestPath,
    analysisProfile: 'full_final',
    concurrency,
    totals: {
      targetCandidates: manifest.candidates.length,
      processed,
      graded: outcomes.filter(outcome => outcome.status === 'graded').length,
      sourceMissing: outcomes.filter(outcome => outcome.status === 'source_missing').length,
      processingError: outcomes.filter(outcome => outcome.status === 'processing_error').length,
      remaining: Math.max(0, manifest.candidates.length - processed),
    },
    comparisons,
    outcomes,
  }

  writeJson(outcomesPath, outcomeDoc)
  writeJson(outcomesSummaryPath, {
    generatedAt: outcomeDoc.generatedAt,
    sourceManifestPath: outcomeDoc.sourceManifestPath,
    analysisProfile: outcomeDoc.analysisProfile,
    concurrency: outcomeDoc.concurrency,
    totals: outcomeDoc.totals,
    countsByResultBand,
    comparisons,
  })

  const driftRows = outcomes
    .filter(outcome => outcome.comparison.hasHistoricalScore && outcome.comparison.exactScoreMatch === false)
    .map(outcome => ({
      publicationId: outcome.publicationId,
      publicationTitle: outcome.publicationTitle,
      artifactPath: outcome.artifactPath,
      relativeArtifactPath: outcome.relativeArtifactPath,
      waveName: outcome.waveName,
      historicalOverallScore: outcome.historical?.overallScore ?? null,
      currentOverallScore: outcome.final?.overallScore ?? null,
      scoreDelta: outcome.comparison.scoreDelta,
      historicalGrade: outcome.historical?.grade ?? null,
      currentGrade: outcome.final?.grade ?? null,
      exactGradeMatch: outcome.comparison.exactGradeMatch,
      sourceManifest: outcome.historical?.sourceManifest ?? null,
      historicalProcessedAt: outcome.historical?.processedAt ?? null,
      processedAt: outcome.processedAt,
      status: outcome.status,
    }))
    .sort((a, b) => Math.abs(b.scoreDelta ?? 0) - Math.abs(a.scoreDelta ?? 0))

  writeJson(driftReportPath, {
    generatedAt: outcomeDoc.generatedAt,
    sourceManifestPath: manifestPath,
    totals: {
      driftRows: driftRows.length,
      exactScoreMatch: comparisons.exactScoreMatch,
      scoreDrift: comparisons.scoreDrift,
      scoredHigherThanHistorical: comparisons.scoredHigherThanHistorical,
      scoredLowerThanHistorical: comparisons.scoredLowerThanHistorical,
    },
    rows: driftRows,
  })
}

function buildLastCompleted(outcome: GradingOutcome): ProgressLastCompleted {
  return {
    publicationId: outcome.publicationId,
    publicationTitle: outcome.publicationTitle,
    status: outcome.status,
    resultBand: outcome.resultBand,
    finalOverallScore: outcome.final?.overallScore ?? null,
    processedAt: outcome.processedAt,
    durationMs: outcome.durationMs,
  }
}

function makeComparison(candidate: GradingCandidate, finalScore: number | null, finalGrade: string | null) {
  const historicalScore = candidate.historical?.overallScore ?? null
  const historicalGrade = candidate.historical?.grade ?? null
  return {
    hasHistoricalScore: historicalScore != null,
    hasHistoricalGrade: historicalGrade != null,
    exactScoreMatch: historicalScore != null && finalScore != null ? historicalScore === finalScore : null,
    exactGradeMatch: historicalGrade != null && finalGrade != null ? historicalGrade === finalGrade : null,
    scoreDelta: historicalScore != null && finalScore != null ? finalScore - historicalScore : null,
    gradeChanged: historicalGrade != null && finalGrade != null ? historicalGrade !== finalGrade : null,
  }
}

async function gradeCandidate(candidate: GradingCandidate): Promise<GradingOutcome> {
  const startedAt = Date.now()
  const processedAt = new Date().toISOString()

  if (!fs.existsSync(candidate.artifactPath)) {
    return {
      artifactPath: candidate.artifactPath,
      relativeArtifactPath: candidate.relativeArtifactPath,
      waveName: candidate.waveName,
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      filename: candidate.filename,
      status: 'source_missing',
      resultBand: 'source_missing',
      processedAt,
      durationMs: Date.now() - startedAt,
      final: null,
      historical: candidate.historical,
      comparison: makeComparison(candidate, null, null),
      error: null,
      artifacts: {
        reportPath: null,
      },
    }
  }

  const reportPath = reportPathFor(candidate)
  ensureDir(path.dirname(reportPath))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const buffer = fs.readFileSync(candidate.artifactPath)
    const analysis = await analyzePdf(buffer, candidate.filename, {
      signal: controller.signal,
      analysisProfile: 'full_final',
    })

    const comparison = makeComparison(candidate, analysis.overallScore ?? null, analysis.grade ?? null)
    const resultBand = classifyOutcomeResultBand({
      status: 'graded',
      finalOverallScore: analysis.overallScore ?? null,
      gatePassed: (analysis.overallScore ?? 0) >= 90,
    })

    const outcome: GradingOutcome = {
      artifactPath: candidate.artifactPath,
      relativeArtifactPath: candidate.relativeArtifactPath,
      waveName: candidate.waveName,
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      filename: candidate.filename,
      status: 'graded',
      resultBand,
      processedAt,
      durationMs: Date.now() - startedAt,
      final: {
        overallScore: analysis.overallScore ?? null,
        grade: analysis.grade ?? null,
        pageCount: analysis.pageCount ?? null,
        isScanned: analysis.isScanned ?? null,
      },
      historical: candidate.historical,
      comparison,
      error: null,
      artifacts: {
        reportPath,
      },
    }

    writeJson(reportPath, {
      generatedAt: processedAt,
      candidate,
      outcome,
      analysis,
    })
    return outcome
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const outcome: GradingOutcome = {
      artifactPath: candidate.artifactPath,
      relativeArtifactPath: candidate.relativeArtifactPath,
      waveName: candidate.waveName,
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      filename: candidate.filename,
      status: 'processing_error',
      resultBand: 'processing_error',
      processedAt,
      durationMs: Date.now() - startedAt,
      final: null,
      historical: candidate.historical,
      comparison: makeComparison(candidate, null, null),
      error: message,
      artifacts: {
        reportPath,
      },
    }

    writeJson(reportPath, {
      generatedAt: processedAt,
      candidate,
      outcome,
      error: message,
    })
    return outcome
  } finally {
    clearTimeout(timer)
  }
}

function resetCampaignState(): void {
  for (const targetPath of [outcomesPath, outcomesSummaryPath, driftReportPath, progressPath]) {
    fs.rmSync(targetPath, { force: true })
  }
}

function shouldResumeExistingCampaign(): boolean {
  if (!fs.existsSync(manifestPath)) return false
  const manifest = readManifest()
  const outcomes = readJsonIfExists<{ outcomes?: ProgressCompatibleOutcome[] }>(outcomesPath)
  const progress = readJsonIfExists<RemediationBatchProgressDocument>(progressPath)
  const snapshot = buildBatchStatusSnapshot({
    manifestPath,
    outcomesPath,
    progressPath,
    totalCandidates: manifest.candidates.length,
    outcomes: outcomes?.outcomes || [],
    progress,
    defaultScorePolicy: scorePolicy,
  })
  return snapshot.runState === 'running' || snapshot.runState === 'stale'
}

export async function main(): Promise<void> {
  const resumeExisting = shouldResumeExistingCampaign()
  if (!resumeExisting) {
    run('pnpm', ['agency:build-remediated-pdf-grading'])
    resetCampaignState()
  } else {
    console.log(JSON.stringify({
      laneName,
      resumeExisting: true,
      manifestPath,
      outcomesPath,
      progressPath,
    }, null, 2))
  }

  const manifest = readManifest()
  const existingOutcomes = readExistingOutcomes()
  const outcomesByPath = new Map(existingOutcomes.map(outcome => [outcome.artifactPath, outcome]))
  const outcomes = [...existingOutcomes]
  const pending = manifest.candidates.filter(candidate => !outcomesByPath.has(candidate.artifactPath))

  let progress = createOrResumeProgressDocument({
    existingProgress: readJsonIfExists<RemediationBatchProgressDocument>(progressPath),
    manifestPath,
    outcomesPath,
    totalCandidates: manifest.candidates.length,
    processed: outcomes.length,
    remaining: Math.max(0, manifest.candidates.length - outcomes.length),
    countsByResultBand: countOutcomeResultBands(outcomes),
    scorePolicy,
    pid: process.pid,
    activeWorkers: 0,
    enforceSingleOwner,
  })
  writeJson(progressPath, progress)

  let nextIndex = 0
  let activeWorkers = 0

  const persistProgress = (lastCompleted?: GradingOutcome): void => {
    progress = updateProgressDocument(progress, {
      totalCandidates: manifest.candidates.length,
      processed: outcomes.length,
      remaining: Math.max(0, manifest.candidates.length - outcomes.length),
      activeWorkers,
      countsByResultBand: countOutcomeResultBands(outcomes),
      lastCompleted: lastCompleted ? buildLastCompleted(lastCompleted) : undefined,
    })
    writeJson(progressPath, progress)
  }

  const worker = async (): Promise<void> => {
    while (true) {
      const current = pending[nextIndex]
      nextIndex += 1
      if (!current) return
      activeWorkers += 1
      persistProgress()
      const outcome = await gradeCandidate(current)
      outcomes.push(outcome)
      writeOutcomeArtifacts(manifest, outcomes)
      activeWorkers -= 1
      persistProgress(outcome)
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, pending.length || 1)) }, () => worker()))
    progress = finalizeProgressDocument(progress, {
      state: 'completed',
      totalCandidates: manifest.candidates.length,
      processed: outcomes.length,
      remaining: Math.max(0, manifest.candidates.length - outcomes.length),
      activeWorkers: 0,
      countsByResultBand: countOutcomeResultBands(outcomes),
      lastCompleted: progress.lastCompleted,
    })
    writeJson(progressPath, progress)
    writeOutcomeArtifacts(manifest, outcomes)
  } catch (error) {
    progress = finalizeProgressDocument(progress, {
      state: 'stale',
      totalCandidates: manifest.candidates.length,
      processed: outcomes.length,
      remaining: Math.max(0, manifest.candidates.length - outcomes.length),
      activeWorkers: 0,
      countsByResultBand: countOutcomeResultBands(outcomes),
      lastCompleted: progress.lastCompleted,
    })
    writeJson(progressPath, progress)
    writeOutcomeArtifacts(manifest, outcomes)
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
