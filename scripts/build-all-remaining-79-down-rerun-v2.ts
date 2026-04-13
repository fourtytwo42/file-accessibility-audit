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

type RerunManifest = {
  generatedAt: string
  sourceReportRoot: string
  laneName: 'all-remaining-79-down-rerun-v2'
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
    excludedAbove79: number
    excludedNonTerminal: number
    excludedMissingArtifact: number
    excludedMissingRemote: number
  }
  candidates: RerunCandidate[]
}

const repoRoot = '/home/hendo420/pdfaf'
const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')
const sourceOutcomesPath = path.join(manifestsRoot, 'all-remaining-79-down-rerun.outcomes.json')
const outputManifestPath = path.join(manifestsRoot, 'all-remaining-79-down-rerun-v2.json')
const outputSummaryPath = path.join(manifestsRoot, 'all-remaining-79-down-rerun-v2.summary.json')

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

function toCandidate(outcome: PriorOutcome): RerunCandidate {
  const finalScore = Number.isFinite(outcome.final?.overallScore) ? Number(outcome.final?.overallScore) : null
  const finalGrade = outcome.final?.grade == null ? null : String(outcome.final.grade)
  const pageCount = safeNumber(outcome.final?.pageCount ?? outcome.original?.pageCount, 0)
  const blockingFindingKeys = Array.isArray(outcome.gate?.blockingLocalFindingKeys) && outcome.gate?.blockingLocalFindingKeys.length
    ? outcome.gate.blockingLocalFindingKeys.map(String)
    : Array.isArray(outcome.blockingFindingKeys)
      ? outcome.blockingFindingKeys.map(String)
      : []

  return {
    priorityRank: safeNumber(outcome.priorityRank, 0),
    passLikelihoodScore: Math.max(0, Math.min(100, finalScore ?? safeNumber(outcome.passLikelihoodScore, 0))),
    priorityTier: outcome.priorityTier || 'medium',
    recommendedAction: 'fix_first',
    publicationId: outcome.publicationId ?? null,
    publicationTitle: outcome.publicationTitle ?? null,
    serverHost: outcome.serverHost ?? null,
    remotePath: outcome.remotePath ?? null,
    localCachePath: outcome.artifacts?.remediatedPdfPath ?? null,
    fileUrl: outcome.fileUrl ?? null,
    storageKind: outcome.storageKind ?? null,
    currentCorpusStatus: outcome.currentCorpusStatus ?? 'remediated_fail',
    overallScore: finalScore ?? 0,
    grade: finalGrade ?? '',
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
    heuristicReasons: [
      'rerun_prior_79_down_v2',
      'source:all-remaining-79-down-rerun',
      `prior_score_band:${scoreBand(finalScore)}`,
      finalScore == null ? 'prior_score:unknown' : `prior_score:${finalScore}`,
    ],
    dominantSelectionFamily: outcome.dominantSelectionFamily ?? null,
    runtimeWeightBucket: outcome.runtimeWeightBucket ?? null,
    runtimeProfileKey: outcome.runtimeProfileKey ?? null,
    laneIntent: 'pass_rate_conversion',
    seedOverallScore: finalScore,
    seedGrade: finalGrade,
    seedResultBand: outcome.resultBand ?? null,
    seedProcessedAt: outcome.processedAt ?? null,
    reportPath: outcome.artifacts?.detailedReportPath || outcome.artifacts?.failureReportPath || outcome.originalReportPath || '',
  }
}

export function buildManifest(source: PriorManifest): RerunManifest {
  const sourceOutcomes = Array.isArray(source.outcomes) ? source.outcomes : []
  let excludedAbove79 = 0
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
      if (score > 79) {
        excludedAbove79 += 1
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
    sourceReportRoot: path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'test-runs', 'all-remaining-79-down-rerun-v2'),
    laneName: 'all-remaining-79-down-rerun-v2',
    laneIntent: 'pass_rate_conversion',
    executionPolicy: 'active',
    executionPolicyReason: 'rerun_latest_79_down_outputs_with_full_artifact_retention',
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
      excludedAbove79,
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
