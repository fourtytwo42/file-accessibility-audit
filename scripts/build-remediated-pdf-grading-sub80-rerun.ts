import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

type GradingOutcome = {
  artifactPath: string
  relativeArtifactPath: string
  waveName: string
  publicationId: string | null
  publicationTitle: string | null
  filename: string
  status: 'graded' | 'source_missing' | 'processing_error'
  resultBand: string
  processedAt: string
  durationMs: number
  final: {
    overallScore: number | null
    grade: string | null
    pageCount: number | null
    isScanned: boolean | null
  } | null
  historical: {
    artifactPath: string
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
  } | null
  comparison: {
    scoreDelta: number | null
  }
}

type GradingManifest = {
  generatedAt: string
  outcomes: GradingOutcome[]
}

type SourceOutcome = {
  publicationId?: string | number | null
  publicationTitle?: string | null
  priorityRank?: number | null
  priorityTier?: 'highest' | 'high' | 'medium' | null
  passLikelihoodScore?: number | null
  currentCorpusStatus?: string | null
  dominantSelectionFamily?: string | null
  runtimeWeightBucket?: 'light' | 'medium' | 'heavy' | null
  runtimeProfileKey?: string | null
  blockingFindingKeys?: string[] | null
  serverHost?: string | null
  remotePath?: string | null
  fileUrl?: string | null
  storageKind?: string | null
  originalReportPath?: string | null
  artifacts?: {
    remediatedPdfPath?: string | null
    detailedReportPath?: string | null
    failureReportPath?: string | null
  } | null
}

type SourceManifest = {
  outcomes?: SourceOutcome[]
}

type RerunCandidate = {
  priorityRank: number
  passLikelihoodScore: number
  priorityTier: 'highest' | 'high' | 'medium'
  recommendedAction: 'fix_first'
  publicationId: string | null
  publicationTitle: string | null
  serverHost: string | null
  remotePath: string | null
  localCachePath: string | null
  fileUrl: string | null
  storageKind: string | null
  currentCorpusStatus: string | null
  overallScore: number
  grade: string
  pageCount: number
  isScanned: boolean
  blockerFamilyCount: number
  blockingFindingCount: number
  manualOnlyFailureModeCount: number
  autoRunnableOpportunityCount: number
  topBlockingResidualFamilyIds: string[]
  blockingFindingKeys: string[]
  autoRunnableOpportunityKeys: string[]
  manualOnlyFailureModeKeys: string[]
  heuristicReasons: string[]
  dominantSelectionFamily: string | null
  runtimeWeightBucket: 'light' | 'medium' | 'heavy' | null
  runtimeProfileKey: string | null
  laneIntent: 'pass_rate_conversion'
  seedOverallScore: number | null
  seedGrade: string | null
  seedResultBand: string | null
  seedProcessedAt: string | null
  reportPath: string
}

type OutputManifest = {
  generatedAt: string
  sourceReportRoot: string
  laneName: 'remediated-pdf-grading-sub80-rerun'
  laneIntent: 'pass_rate_conversion'
  executionPolicy: 'active'
  executionPolicyReason: string
  recommendedConcurrency: number
  initialAnalysisProfile: 'full_final'
  verificationPolicy: 'terminal_candidates_only'
  sourceOutcomesPath: string
  sourceOutcomesGeneratedAt: string | null
  scorePolicy: {
    minPassOverallScore: number
    minKeepOverallScore: null
  }
  totals: {
    scannedReportsConsidered: number
    selectedCandidates: number
    byTier: Record<string, number>
    excludedAtOrAbove80: number
    excludedNonTerminal: number
    excludedMissingArtifact: number
    excludedMissingSourceRecord: number
    excludedMissingRemote: number
  }
  candidates: RerunCandidate[]
}

const repoRoot = '/home/hendo420/pdfaf'
const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')
const sourceOutcomesPath = path.join(manifestsRoot, 'remediated-pdf-grading.outcomes.json')
const outputManifestPath = path.join(manifestsRoot, 'remediated-pdf-grading-sub80-rerun.json')
const outputSummaryPath = path.join(manifestsRoot, 'remediated-pdf-grading-sub80-rerun.summary.json')

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

function safeNumber(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

function runtimeRank(value: 'light' | 'medium' | 'heavy' | null | undefined): number {
  if (value === 'light') return 0
  if (value === 'medium') return 1
  if (value === 'heavy') return 2
  return 3
}

function scoreBand(score: number | null): string {
  if (!Number.isFinite(score)) return 'unknown'
  if (score >= 70) return '70-79'
  if (score >= 60) return '60-69'
  if (score >= 50) return '50-59'
  if (score >= 40) return '40-49'
  return '<40'
}

function artifactPathsFor(row: SourceOutcome, sourceManifestPath: string): string[] {
  const candidatePaths = [
    row.artifacts?.remediatedPdfPath,
    sourceManifestPath.endsWith('complete-passing-publication-status.json') ? null : null,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  return candidatePaths
}

function findSourceRow(outcome: GradingOutcome): SourceOutcome | null {
  const sourceManifestPath = outcome.historical?.sourceManifest
  if (!sourceManifestPath || !fs.existsSync(sourceManifestPath)) return null

  if (sourceManifestPath.endsWith('complete-passing-publication-status.json')) {
    const rows = readJson<any[]>(sourceManifestPath)
    const match = rows.find(row => String(row?.sourceCompleteFilePath || '') === outcome.artifactPath)
    if (!match) return null
    return {
      publicationId: match.publicationId ?? null,
      publicationTitle: match.publicationTitle ?? null,
      serverHost: match.serverHost ?? null,
      remotePath: match.remotePath ?? null,
      fileUrl: match.fileUrl ?? null,
      storageKind: match.storageKind ?? null,
      currentCorpusStatus: match.status ?? null,
      artifacts: {
        remediatedPdfPath: match.sourceCompleteFilePath ?? null,
        detailedReportPath: null,
        failureReportPath: null,
      },
    }
  }

  const doc = readJson<SourceManifest>(sourceManifestPath)
  return (doc.outcomes || []).find(row =>
    artifactPathsFor(row, sourceManifestPath).includes(outcome.artifactPath)
    || String(row.publicationId ?? '') === String(outcome.publicationId ?? ''),
  ) || null
}

function toCandidate(outcome: GradingOutcome, sourceRow: SourceOutcome): RerunCandidate {
  const finalScore = Number.isFinite(outcome.final?.overallScore) ? Number(outcome.final?.overallScore) : null
  const finalGrade = outcome.final?.grade == null ? null : String(outcome.final.grade)
  const blockingFindingKeys = Array.isArray(sourceRow.blockingFindingKeys)
    ? sourceRow.blockingFindingKeys.map(String)
    : []

  return {
    priorityRank: safeNumber(sourceRow.priorityRank, 0),
    passLikelihoodScore: Math.max(0, Math.min(100, finalScore ?? safeNumber(sourceRow.passLikelihoodScore, 0))),
    priorityTier: sourceRow.priorityTier || 'medium',
    recommendedAction: 'fix_first',
    publicationId: outcome.publicationId ?? null,
    publicationTitle: outcome.publicationTitle ?? null,
    serverHost: sourceRow.serverHost ?? null,
    remotePath: sourceRow.remotePath ?? null,
    localCachePath: outcome.artifactPath,
    fileUrl: sourceRow.fileUrl ?? null,
    storageKind: sourceRow.storageKind ?? null,
    currentCorpusStatus: sourceRow.currentCorpusStatus ?? 'remediated_fail',
    overallScore: finalScore ?? 0,
    grade: finalGrade ?? '',
    pageCount: safeNumber(outcome.final?.pageCount, 0),
    isScanned: Boolean(outcome.final?.isScanned),
    blockerFamilyCount: 0,
    blockingFindingCount: blockingFindingKeys.length,
    manualOnlyFailureModeCount: 0,
    autoRunnableOpportunityCount: 0,
    topBlockingResidualFamilyIds: [],
    blockingFindingKeys,
    autoRunnableOpportunityKeys: [],
    manualOnlyFailureModeKeys: [],
    heuristicReasons: [
      'rerun_freshly_verified_sub80_remediated_artifact',
      `source_wave:${outcome.waveName}`,
      `fresh_score_band:${scoreBand(finalScore)}`,
      finalScore == null ? 'fresh_score:unknown' : `fresh_score:${finalScore}`,
      outcome.comparison.scoreDelta == null ? 'grading_delta:unknown' : `grading_delta:${outcome.comparison.scoreDelta}`,
    ],
    dominantSelectionFamily: sourceRow.dominantSelectionFamily ?? null,
    runtimeWeightBucket: sourceRow.runtimeWeightBucket ?? null,
    runtimeProfileKey: sourceRow.runtimeProfileKey ?? null,
    laneIntent: 'pass_rate_conversion',
    seedOverallScore: finalScore,
    seedGrade: finalGrade,
    seedResultBand: outcome.resultBand ?? null,
    seedProcessedAt: outcome.processedAt ?? null,
    reportPath: sourceRow.artifacts?.detailedReportPath || sourceRow.artifacts?.failureReportPath || sourceRow.originalReportPath || '',
  }
}

export function buildManifest(source: GradingManifest): OutputManifest {
  const sourceOutcomes = Array.isArray(source.outcomes) ? source.outcomes : []
  let excludedAtOrAbove80 = 0
  let excludedNonTerminal = 0
  let excludedMissingArtifact = 0
  let excludedMissingSourceRecord = 0
  let excludedMissingRemote = 0

  const selected = sourceOutcomes
    .filter(outcome => {
      if (outcome.status !== 'graded' || typeof outcome.final?.overallScore !== 'number') {
        excludedNonTerminal += 1
        return false
      }
      if (outcome.final.overallScore >= 80) {
        excludedAtOrAbove80 += 1
        return false
      }
      if (!outcome.artifactPath || !fs.existsSync(outcome.artifactPath)) {
        excludedMissingArtifact += 1
        return false
      }
      return true
    })
    .map(outcome => {
      const sourceRow = findSourceRow(outcome)
      if (!sourceRow) {
        excludedMissingSourceRecord += 1
        return null
      }
      if (!sourceRow.remotePath) {
        excludedMissingRemote += 1
        return null
      }
      return toCandidate(outcome, sourceRow)
    })
    .filter((candidate): candidate is RerunCandidate => candidate != null)
    .sort((left, right) =>
      runtimeRank(left.runtimeWeightBucket) - runtimeRank(right.runtimeWeightBucket)
      || right.overallScore - left.overallScore
      || (left.priorityRank || Number.MAX_SAFE_INTEGER) - (right.priorityRank || Number.MAX_SAFE_INTEGER)
      || String(left.publicationId || '').localeCompare(String(right.publicationId || '')))
    .map((candidate, index) => ({ ...candidate, priorityRank: index + 1 }))

  const byTier = selected.reduce<Record<string, number>>((acc, candidate) => {
    acc[candidate.priorityTier] = (acc[candidate.priorityTier] || 0) + 1
    return acc
  }, {})

  return {
    generatedAt: new Date().toISOString(),
    sourceReportRoot: path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'test-runs', 'remediated-pdf-grading'),
    laneName: 'remediated-pdf-grading-sub80-rerun',
    laneIntent: 'pass_rate_conversion',
    executionPolicy: 'active',
    executionPolicyReason: 'Fresh grading audit identified remediated artifacts still scoring below 80 and suitable for another automated pass.',
    recommendedConcurrency: 4,
    initialAnalysisProfile: 'full_final',
    verificationPolicy: 'terminal_candidates_only',
    sourceOutcomesPath,
    sourceOutcomesGeneratedAt: source.generatedAt ?? null,
    scorePolicy: {
      minPassOverallScore: 90,
      minKeepOverallScore: null,
    },
    totals: {
      scannedReportsConsidered: sourceOutcomes.length,
      selectedCandidates: selected.length,
      byTier,
      excludedAtOrAbove80,
      excludedNonTerminal,
      excludedMissingArtifact,
      excludedMissingSourceRecord,
      excludedMissingRemote,
    },
    candidates: selected,
  }
}

export async function main(): Promise<void> {
  const source = readJson<GradingManifest>(sourceOutcomesPath)
  const manifest = buildManifest(source)
  writeJson(outputManifestPath, manifest)
  writeJson(outputSummaryPath, {
    generatedAt: manifest.generatedAt,
    laneName: manifest.laneName,
    sourceOutcomesPath: manifest.sourceOutcomesPath,
    sourceOutcomesGeneratedAt: manifest.sourceOutcomesGeneratedAt,
    scorePolicy: manifest.scorePolicy,
    totals: manifest.totals,
  })
  console.log(JSON.stringify({
    outputManifestPath,
    outputSummaryPath,
    selectedCandidates: manifest.totals.selectedCandidates,
    excludedAtOrAbove80: manifest.totals.excludedAtOrAbove80,
    excludedMissingSourceRecord: manifest.totals.excludedMissingSourceRecord,
    excludedMissingRemote: manifest.totals.excludedMissingRemote,
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
