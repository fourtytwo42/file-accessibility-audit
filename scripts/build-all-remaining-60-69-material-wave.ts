import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

type PriorOutcome = {
  publicationId: string | null
  publicationTitle: string | null
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
  status?: string | null
  resultBand?: string | null
  processedAt?: string | null
  original?: {
    overallScore?: number | null
    grade?: string | null
    pageCount?: number | null
    isScanned?: boolean | null
  } | null
  final?: {
    overallScore?: number | null
    grade?: string | null
    pageCount?: number | null
    isScanned?: boolean | null
  } | null
  gate?: {
    blockingLocalFindingKeys?: string[] | null
  } | null
  seed?: {
    priorOverallScore?: number | null
    priorGrade?: string | null
    priorResultBand?: string | null
    priorProcessedAt?: string | null
  } | null
  artifacts?: {
    remediatedPdfPath?: string | null
    detailedReportPath?: string | null
    failureReportPath?: string | null
  } | null
}

type PriorManifest = {
  generatedAt?: string
  outcomes?: PriorOutcome[]
}

type WaveCandidate = {
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

type WaveManifest = {
  generatedAt: string
  sourceReportRoot: string
  laneName: 'all-remaining-60-69-material-wave'
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
    withPositiveDelta: number
    withFlatOrNegativeDelta: number
    excludedOutsideBand: number
    excludedNonTerminal: number
    excludedMissingArtifact: number
    excludedMissingRemote: number
  }
  candidates: WaveCandidate[]
}

const repoRoot = '/home/hendo420/pdfaf'
const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')
const sourceOutcomesPath = path.join(manifestsRoot, 'all-remaining-79-down-rerun-v2.outcomes.json')
const outputManifestPath = path.join(manifestsRoot, 'all-remaining-60-69-material-wave.json')
const outputSummaryPath = path.join(manifestsRoot, 'all-remaining-60-69-material-wave.summary.json')

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

function derivePriorityTier(delta: number, currentScore: number): 'highest' | 'high' | 'medium' {
  if (delta >= 8 || currentScore >= 67) return 'highest'
  if (delta >= 3 || currentScore >= 64) return 'high'
  return 'medium'
}

function toCandidate(outcome: PriorOutcome): WaveCandidate {
  const finalScore = Number(outcome.final?.overallScore || 0)
  const finalGrade = outcome.final?.grade == null ? '' : String(outcome.final.grade)
  const seedScore = Number.isFinite(outcome.seed?.priorOverallScore) ? Number(outcome.seed?.priorOverallScore) : null
  const scoreDelta = seedScore == null ? null : finalScore - seedScore
  const pageCount = safeNumber(outcome.final?.pageCount ?? outcome.original?.pageCount, 0)
  const blockingFindingKeys = Array.isArray(outcome.gate?.blockingLocalFindingKeys) && outcome.gate?.blockingLocalFindingKeys.length
    ? outcome.gate.blockingLocalFindingKeys.map(String)
    : Array.isArray(outcome.blockingFindingKeys)
      ? outcome.blockingFindingKeys.map(String)
      : []
  const priorityTier = derivePriorityTier(scoreDelta ?? 0, finalScore)
  const heuristicReasons = [
    'material_wave_current_score_60_69',
    'source:all-remaining-79-down-rerun-v2',
    `current_score:${finalScore}`,
    seedScore == null ? 'prior_score:unknown' : `prior_score:${seedScore}`,
    scoreDelta == null ? 'prior_delta:unknown' : `prior_delta:${scoreDelta >= 0 ? '+' : ''}${scoreDelta}`,
  ]

  return {
    priorityRank: safeNumber(outcome.priorityRank, 0),
    passLikelihoodScore: Math.max(0, Math.min(100, finalScore)),
    priorityTier,
    recommendedAction: 'fix_first',
    publicationId: outcome.publicationId ?? null,
    publicationTitle: outcome.publicationTitle ?? null,
    serverHost: outcome.serverHost ?? null,
    remotePath: outcome.remotePath ?? null,
    localCachePath: outcome.artifacts?.remediatedPdfPath ?? null,
    fileUrl: outcome.fileUrl ?? null,
    storageKind: outcome.storageKind ?? null,
    currentCorpusStatus: outcome.currentCorpusStatus ?? 'remediated_fail',
    overallScore: finalScore,
    grade: finalGrade,
    pageCount,
    isScanned: Boolean(outcome.final?.isScanned ?? outcome.original?.isScanned),
    blockerFamilyCount: 0,
    blockingFindingCount: blockingFindingKeys.length,
    manualOnlyFailureModeCount: 0,
    autoRunnableOpportunityCount: 0,
    topBlockingResidualFamilyIds: [],
    blockingFindingKeys,
    autoRunnableOpportunityKeys: [],
    manualOnlyFailureModeKeys: [],
    heuristicReasons,
    dominantSelectionFamily: outcome.dominantSelectionFamily ?? null,
    runtimeWeightBucket: outcome.runtimeWeightBucket ?? null,
    runtimeProfileKey: outcome.runtimeProfileKey ?? null,
    laneIntent: 'pass_rate_conversion',
    seedOverallScore: seedScore,
    seedGrade: outcome.seed?.priorGrade == null ? null : String(outcome.seed.priorGrade),
    seedResultBand: outcome.seed?.priorResultBand == null ? null : String(outcome.seed.priorResultBand),
    seedProcessedAt: outcome.seed?.priorProcessedAt == null ? null : String(outcome.seed.priorProcessedAt),
    reportPath: outcome.artifacts?.detailedReportPath || outcome.artifacts?.failureReportPath || outcome.originalReportPath || '',
  }
}

export function buildManifest(source: PriorManifest): WaveManifest {
  const sourceOutcomes = Array.isArray(source.outcomes) ? source.outcomes : []
  let excludedOutsideBand = 0
  let excludedNonTerminal = 0
  let excludedMissingArtifact = 0
  let excludedMissingRemote = 0

  const selected = sourceOutcomes
    .filter(outcome => {
      const score = outcome.final?.overallScore
      if (outcome.status !== 'failed_after_remediation' || typeof score !== 'number') {
        excludedNonTerminal += 1
        return false
      }
      if (score < 60 || score > 69) {
        excludedOutsideBand += 1
        return false
      }
      if (!outcome.artifacts?.remediatedPdfPath || !fs.existsSync(outcome.artifacts.remediatedPdfPath)) {
        excludedMissingArtifact += 1
        return false
      }
      if (!outcome.remotePath) {
        excludedMissingRemote += 1
        return false
      }
      return true
    })
    .map(toCandidate)
    .sort((left, right) => {
      const leftDelta = (left.overallScore - (left.seedOverallScore ?? left.overallScore))
      const rightDelta = (right.overallScore - (right.seedOverallScore ?? right.overallScore))
      return runtimeRank(left.runtimeWeightBucket) - runtimeRank(right.runtimeWeightBucket)
        || rightDelta - leftDelta
        || right.overallScore - left.overallScore
        || String(left.publicationId || '').localeCompare(String(right.publicationId || ''))
    })
    .map((candidate, index) => ({ ...candidate, priorityRank: index + 1 }))

  const byTier = selected.reduce<Record<string, number>>((acc, candidate) => {
    acc[candidate.priorityTier] = (acc[candidate.priorityTier] || 0) + 1
    return acc
  }, {})

  const withPositiveDelta = selected.filter(candidate => (
    candidate.seedOverallScore != null && candidate.overallScore > candidate.seedOverallScore
  )).length

  return {
    generatedAt: new Date().toISOString(),
    sourceReportRoot: path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'test-runs', 'all-remaining-60-69-material-wave'),
    laneName: 'all-remaining-60-69-material-wave',
    laneIntent: 'pass_rate_conversion',
    executionPolicy: 'active',
    executionPolicyReason: 'focus_only_on_current_60_69_band_and_prior_positive_delta_ordering',
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
      withPositiveDelta,
      withFlatOrNegativeDelta: selected.length - withPositiveDelta,
      excludedOutsideBand,
      excludedNonTerminal,
      excludedMissingArtifact,
      excludedMissingRemote,
    },
    candidates: selected,
  }
}

export function main(): void {
  const source = readJson<PriorManifest>(sourceOutcomesPath)
  const manifest = buildManifest(source)
  writeJson(outputManifestPath, manifest)
  writeJson(outputSummaryPath, {
    generatedAt: manifest.generatedAt,
    laneName: manifest.laneName,
    sourceOutcomesPath: manifest.sourceOutcomesPath,
    sourceOutcomesGeneratedAt: manifest.sourceOutcomesGeneratedAt,
    executionPolicyReason: manifest.executionPolicyReason,
    scorePolicy: manifest.scorePolicy,
    totals: manifest.totals,
  })
  console.log(JSON.stringify({
    manifestPath: outputManifestPath,
    summaryPath: outputSummaryPath,
    totals: manifest.totals,
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
