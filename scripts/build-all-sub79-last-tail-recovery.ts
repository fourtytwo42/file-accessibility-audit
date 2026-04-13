import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = '/home/hendo420/pdfaf'
const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')
const reportsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'test-runs', 'all-sub79-recovery')
const sourceOutcomesPath = path.join(manifestsRoot, 'all-sub79-recovery.outcomes.json')
const laneName = 'all-sub79-last-tail-recovery'
const recoveryWindow = {
  start: Date.parse('2026-04-11T14:40:55.629Z'),
  end: Date.parse('2026-04-11T17:40:49.823Z'),
}

type RecoveryCandidate = {
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
  blockerSignature?: string
  blockerFamilies?: string[]
  scoreDeltaFromPrior?: number | null
  blockerCountDeltaFromPrior?: number | null
  blockerFamilyShrinkFromPrior?: boolean
  plateaued?: boolean
  seedOverallScore?: number | null
  seedGrade?: string | null
  seedResultBand?: string | null
  seedProcessedAt?: string | null
  reportPath: string
}

type DetailedReport = {
  generatedAt?: string
  candidate?: RecoveryCandidate
  final?: {
    overallScore?: number
    grade?: string
    pageCount?: number
    isScanned?: boolean
    localStandards?: {
      findings?: Array<{ key?: string; blocking?: boolean }>
    }
  }
  remediatedPdfPath?: string | null
}

type OutcomeRecord = {
  publicationId: string | null
  publicationTitle?: string | null
  priorityRank?: number
  priorityTier?: 'highest' | 'high' | 'medium' | null
  passLikelihoodScore?: number
  currentCorpusStatus?: string | null
  dominantSelectionFamily?: string | null
  runtimeWeightBucket?: 'light' | 'medium' | 'heavy' | null
  runtimeProfileKey?: string | null
  laneIntent?: 'pass_rate_conversion' | null
  blockingFindingKeys?: string[]
  serverHost?: string | null
  remotePath?: string | null
  localCachePath?: string | null
  fileUrl?: string | null
  storageKind?: string | null
  originalReportPath?: string
  status?: string
  resultBand?: string
  processedAt?: string
  final?: {
    overallScore?: number
    grade?: string
    pageCount?: number
    isScanned?: boolean
  }
  seed?: {
    priorOverallScore?: number | null
    priorGrade?: string | null
    priorResultBand?: string | null
    priorProcessedAt?: string | null
  }
  artifacts?: {
    remediatedPdfPath?: string | null
    detailedReportPath?: string | null
    failureReportPath?: string | null
  }
  gate?: {
    blockingLocalFindingKeys?: string[] | null
  }
}

function walkFiles(dirPath: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const nextPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(nextPath))
    else if (entry.isFile()) out.push(nextPath)
  }
  return out
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

function blockingKeysFromReport(report: DetailedReport): string[] {
  const keys = (report.final?.localStandards?.findings || [])
    .filter(entry => entry?.blocking && entry?.key)
    .map(entry => String(entry.key))
  return [...new Set(keys)].sort((left, right) => left.localeCompare(right))
}

function recoveredCandidatesFromReports(): RecoveryCandidate[] {
  const files = walkFiles(reportsRoot)
  const byId = new Map<string, RecoveryCandidate>()
  for (const filePath of files) {
    const stats = fs.statSync(filePath)
    if (stats.mtimeMs < recoveryWindow.start || stats.mtimeMs > recoveryWindow.end + 1000) continue
    const report = readJson<DetailedReport>(filePath)
    const candidate = report.candidate
    const finalScore = report.final?.overallScore
    const publicationId = String(candidate?.publicationId || '')
    if (!candidate || !publicationId || typeof finalScore !== 'number' || finalScore > 79) continue
    byId.set(publicationId, {
      ...candidate,
      reportPath: filePath,
      localCachePath: report.remediatedPdfPath || candidate.localCachePath || null,
      overallScore: finalScore,
      grade: String(report.final?.grade || candidate.grade || ''),
      pageCount: Number(report.final?.pageCount ?? candidate.pageCount ?? 0),
      isScanned: Boolean(report.final?.isScanned ?? candidate.isScanned),
      blockingFindingKeys: blockingKeysFromReport(report),
      blockingFindingCount: blockingKeysFromReport(report).length,
      passLikelihoodScore: finalScore,
    })
  }
  return [...byId.values()]
}

function recoveredCandidatesFromMistakenRestart(): RecoveryCandidate[] {
  if (!fs.existsSync(sourceOutcomesPath)) return []
  const outcomes = readJson<{ outcomes?: OutcomeRecord[] }>(sourceOutcomesPath)
  const items = (outcomes.outcomes || [])
    .filter(outcome =>
      outcome.status === 'failed_after_remediation'
      && typeof outcome.final?.overallScore === 'number'
      && outcome.final.overallScore <= 79,
    )
    .map(outcome => ({
      priorityRank: Number(outcome.priorityRank || 0),
      passLikelihoodScore: Number(outcome.final?.overallScore || outcome.passLikelihoodScore || 0),
      priorityTier: (outcome.priorityTier || 'medium') as 'highest' | 'high' | 'medium',
      recommendedAction: 'fix_first' as const,
      publicationId: outcome.publicationId ?? null,
      publicationTitle: outcome.publicationTitle ?? null,
      serverHost: outcome.serverHost ?? null,
      remotePath: outcome.remotePath ?? null,
      localCachePath: outcome.artifacts?.remediatedPdfPath || outcome.localCachePath || null,
      fileUrl: outcome.fileUrl ?? null,
      storageKind: outcome.storageKind ?? null,
      currentCorpusStatus: outcome.currentCorpusStatus ?? 'remediated_fail',
      overallScore: Number(outcome.final?.overallScore || 0),
      grade: String(outcome.final?.grade || ''),
      pageCount: Number(outcome.final?.pageCount || 0),
      isScanned: Boolean(outcome.final?.isScanned),
      blockerFamilyCount: 0,
      blockingFindingCount: (outcome.gate?.blockingLocalFindingKeys || outcome.blockingFindingKeys || []).length,
      manualOnlyFailureModeCount: 0,
      autoRunnableOpportunityCount: 0,
      topBlockingResidualFamilyIds: [],
      blockingFindingKeys: [...new Set((outcome.gate?.blockingLocalFindingKeys || outcome.blockingFindingKeys || []).map(String))],
      autoRunnableOpportunityKeys: [],
      manualOnlyFailureModeKeys: [],
      heuristicReasons: ['recovered_from_mistaken_restart'],
      dominantSelectionFamily: outcome.dominantSelectionFamily ?? null,
      runtimeWeightBucket: outcome.runtimeWeightBucket ?? null,
      runtimeProfileKey: outcome.runtimeProfileKey ?? null,
      laneIntent: 'pass_rate_conversion' as const,
      blockerSignature: undefined,
      blockerFamilies: undefined,
      scoreDeltaFromPrior: outcome.seed?.priorOverallScore == null ? null : Number(outcome.final?.overallScore || 0) - Number(outcome.seed.priorOverallScore),
      blockerCountDeltaFromPrior: null,
      blockerFamilyShrinkFromPrior: false,
      plateaued: false,
      seedOverallScore: outcome.seed?.priorOverallScore ?? null,
      seedGrade: outcome.seed?.priorGrade ?? null,
      seedResultBand: outcome.seed?.priorResultBand ?? null,
      seedProcessedAt: outcome.seed?.priorProcessedAt ?? null,
      reportPath: outcome.artifacts?.detailedReportPath || outcome.originalReportPath || '',
    }))
  return items
}

export async function main(): Promise<void> {
  const recovered = new Map<string, RecoveryCandidate>()
  for (const candidate of recoveredCandidatesFromReports()) {
    if (candidate.publicationId) recovered.set(String(candidate.publicationId), candidate)
  }
  for (const candidate of recoveredCandidatesFromMistakenRestart()) {
    if (candidate.publicationId) recovered.set(String(candidate.publicationId), candidate)
  }

  const candidates = [...recovered.values()]
    .sort((left, right) =>
      Number(right.overallScore) - Number(left.overallScore)
      || Number(left.priorityRank || 0) - Number(right.priorityRank || 0)
      || String(left.publicationId || '').localeCompare(String(right.publicationId || '')),
    )
    .map((candidate, index) => ({ ...candidate, priorityRank: index + 1 }))

  const manifest = {
    generatedAt: new Date().toISOString(),
    laneName,
    laneIntent: 'pass_rate_conversion',
    executionPolicy: 'active',
    executionPolicyReason: 'recover_exact_last_tail_from_completed_87_file_sub79_run',
    recommendedConcurrency: 4,
    initialAnalysisProfile: 'full_final',
    verificationPolicy: 'terminal_candidates_only',
    sourceOutcomesPaths: [sourceOutcomesPath],
    sourceOutcomesGeneratedAt: fs.existsSync(sourceOutcomesPath)
      ? readJson<{ generatedAt?: string }>(sourceOutcomesPath).generatedAt || null
      : null,
    scorePolicy: {
      minPassOverallScore: 90,
      minKeepOverallScore: null,
    },
    totals: {
      scannedReportsConsidered: candidates.length,
      selectedCandidates: candidates.length,
      byTier: candidates.reduce<Record<string, number>>((acc, candidate) => {
        acc[candidate.priorityTier] = (acc[candidate.priorityTier] || 0) + 1
        return acc
      }, {}),
      plateauedCandidates: candidates.filter(candidate => candidate.plateaued).length,
      nonPlateauedCandidates: candidates.filter(candidate => !candidate.plateaued).length,
      excludedNonTerminal: 0,
      excludedAbove79: 7,
      excludedMissingArtifact: 0,
      excludedMissingRemote: 0,
      excludedLaneMismatch: 0,
    },
    blockerSignatureCounts: candidates.reduce<Record<string, number>>((acc, candidate) => {
      const key = candidate.blockingFindingKeys.length
        ? [...candidate.blockingFindingKeys].sort((left, right) => left.localeCompare(right)).join(' + ')
        : '(none)'
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {}),
    plateauCounts: {
      plateaued: candidates.filter(candidate => candidate.plateaued).length,
      nonPlateaued: candidates.filter(candidate => !candidate.plateaued).length,
    },
    candidates,
  }

  const manifestPath = path.join(manifestsRoot, `${laneName}.json`)
  const summaryPath = path.join(manifestsRoot, `${laneName}.summary.json`)
  writeJson(manifestPath, manifest)
  writeJson(summaryPath, {
    generatedAt: manifest.generatedAt,
    laneName: manifest.laneName,
    executionPolicyReason: manifest.executionPolicyReason,
    totals: manifest.totals,
    topCandidates: candidates.slice(0, 15).map(candidate => ({
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      overallScore: candidate.overallScore,
      blockingFindingKeys: candidate.blockingFindingKeys,
      localCachePath: candidate.localCachePath,
    })),
  })

  console.log(JSON.stringify({
    laneName,
    selectedCandidates: candidates.length,
    manifestPath,
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
