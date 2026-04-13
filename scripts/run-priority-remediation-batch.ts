import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { closeAuditDb } from '../apps/api/src/db/sqlite.ts'
import { analyzePdf, remediatePdf } from '../apps/api/src/engine/index.ts'
import type { AnalysisProfile } from '../apps/api/src/services/pdfAnalyzer.ts'
import type { PromotionLifecycleStatus } from '../apps/api/src/services/promotionLedger.ts'
import {
  evaluatePromotionGate,
  type PromotionGateResult,
} from '../apps/api/src/services/promotionGate.ts'
import {
  classifyOutcomeResultBand,
  countOutcomeResultBands,
  createOrResumeProgressDocument,
  finalizeProgressDocument,
  inferOutcomeResultBand,
  type ProgressLastCompleted,
  processIsAlive,
  type RemediationBatchProgressDocument,
  type RemediationResultBand,
  type RemediationScorePolicy,
  updateProgressDocument,
} from './remediation-batch-progress.ts'

type PriorityCandidate = {
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
  currentCorpusStatus?: string | null
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
  dominantSelectionFamily?: string | null
  runtimeWeightBucket?: 'light' | 'medium' | 'heavy' | null
  runtimeProfileKey?: string | null
  laneIntent?: 'pass_rate_conversion' | 'truth_hardening_terminalization' | 'deferred_manual_review' | null
  seedOverallScore?: number | null
  seedGrade?: string | null
  seedResultBand?: RemediationResultBand | null
  seedProcessedAt?: string | null
  reportPath: string
}

type OutcomeSeedContext = {
  priorOverallScore: number | null
  priorGrade: string | null
  priorResultBand: RemediationResultBand | null
  priorProcessedAt: string | null
} | null

type PriorityManifest = {
  generatedAt: string
  sourceReportRoot: string
  laneName?: string | null
  laneIntent?: 'pass_rate_conversion' | 'truth_hardening_terminalization' | 'deferred_manual_review' | null
  executionPolicy?: 'active' | 'dormant' | 'deferred' | null
  recommendedConcurrency?: number | null
  initialAnalysisProfile?: AnalysisProfile | null
  verificationPolicy?: 'terminal_candidates_only' | null
  totals: {
    scannedReportsConsidered: number
    selectedCandidates: number
    byTier: Record<string, number>
  }
  candidates: PriorityCandidate[]
}

type OutcomeRecord = {
  publicationId: string | null
  publicationTitle: string | null
  priorityRank: number
  priorityTier: 'highest' | 'high' | 'medium'
  passLikelihoodScore: number
  currentCorpusStatus?: string | null
  dominantSelectionFamily?: string | null
  runtimeWeightBucket?: 'light' | 'medium' | 'heavy' | null
  runtimeProfileKey?: string | null
  laneIntent?: 'pass_rate_conversion' | 'truth_hardening_terminalization' | 'deferred_manual_review' | null
  blockingFindingKeys: string[]
  serverHost: string | null
  remotePath: string | null
  localCachePath: string | null
  fileUrl: string | null
  storageKind: string | null
  originalReportPath: string
  status: 'remediated_pass_candidate' | 'ready_to_replace' | 'failed_after_remediation' | 'source_missing' | 'processing_error'
  resultBand: RemediationResultBand
  promotionStatus: PromotionLifecycleStatus | null
  processedAt: string
  durationMs: number
  original: {
    overallScore: number
    grade: string
    pageCount: number
    isScanned: boolean
  } | null
  final: {
    overallScore: number
    grade: string
    pageCount: number
    isScanned: boolean
  } | null
  seed?: OutcomeSeedContext
  gate: {
    passed: boolean
    reasons: string[]
    blockingLocalFindingKeys: string[]
    criticalManualReviewFlagCodes: string[]
    unresolvedCategoryLabels: string[]
  }
  artifacts: {
    remediatedPdfPath: string | null
    stagedReplacementPath: string | null
    detailedReportPath: string | null
    failureReportPath: string | null
  }
  checksums?: {
    gateEvaluatedBufferSha256: string | null
    remediatedPdfSha256: string | null
    stagedReplacementSha256: string | null
  }
  deferred?: {
    reasonCode: string
    skipNextBatch: boolean
    notes: string
  }
  /** Present when `ICJIA_REMEDIATION_MIN_PASS_SCORE` overrides the engine strict gate for this row. */
  strictPromotionGate?: PromotionGateResult | null
}

type OutcomesManifest = {
  generatedAt: string
  sourcePriorityManifestPath: string
  laneName?: string | null
  laneIntent?: 'pass_rate_conversion' | 'truth_hardening_terminalization' | 'deferred_manual_review' | null
  initialAnalysisProfile?: AnalysisProfile | null
  concurrency: number
  totals: {
    targetCandidates: number
    processed: number
    readyToReplace: number
    remediatedPassCandidates?: number
    failedAfterRemediation: number
    sourceMissing: number
    processingError: number
    remaining: number
  }
  outcomes: OutcomeRecord[]
}

const repoRoot = '/home/hendo420/pdfaf'
const icjiaRoot = path.join(repoRoot, 'ICJIA-PDFs')
const priorityManifestPath = process.env.ICJIA_PRIORITY_MANIFEST_PATH || path.join(icjiaRoot, 'manifests', 'remediation-priority-candidates.json')
const outcomesManifestPath = process.env.ICJIA_REMEDIATION_OUTCOMES_PATH || path.join(icjiaRoot, 'manifests', 'remediation-batch-outcomes.json')
const outcomesSummaryPath = process.env.ICJIA_REMEDIATION_OUTCOMES_SUMMARY_PATH || outcomesManifestPath.replace(/\.json$/i, '.summary.json')
const progressPath = process.env.ICJIA_REMEDIATION_PROGRESS_PATH || outcomesManifestPath.replace(/\.json$/i, '.progress.json')
const detailedReportRoot = process.env.ICJIA_REMEDIATION_DETAILED_REPORT_ROOT || path.join(icjiaRoot, 'reports', 'test-runs', 'remediation-batch')
const failureReportRoot = process.env.ICJIA_REMEDIATION_FAILURE_REPORT_ROOT || path.join(icjiaRoot, 'reports', 'failures', 'remediation-batch')
const remediatedPdfRoot = process.env.ICJIA_REMEDIATION_REMEDIATED_PDF_ROOT || path.join(icjiaRoot, 'artifacts', 'remediated-pdfs', 'priority-batch')
const attemptsRoot = process.env.ICJIA_REMEDIATION_ATTEMPTS_ROOT || path.join(icjiaRoot, 'artifacts', 'remediation-attempts', 'priority-batch')
const stagingRoot = process.env.ICJIA_REMEDIATION_STAGING_ROOT || path.join(icjiaRoot, 'staging', 'to-replace')

const concurrency = Number(process.env.ICJIA_REMEDIATION_CONCURRENCY || 8)
const limit = Number(process.env.ICJIA_REMEDIATION_LIMIT || 0)
const timeoutMs = Number(process.env.ICJIA_REMEDIATION_TIMEOUT_MS || 60 * 60 * 1000)
const initialAnalysisProfile = (process.env.ICJIA_REMEDIATION_INITIAL_ANALYSIS_PROFILE === 'remediation_fast'
  ? 'remediation_fast'
  : 'full_final') as AnalysisProfile

/**
 * Optional relaxed pass: same rules as `evaluatePromotionGate` with `minOverallScore` (not scanned,
 * score >= threshold, no critical manual-review flags). Unset = engine strict gate (A/100/…).
 */
function parseOptionalThreshold(envKey: string): number | null {
  const raw = process.env[envKey]
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

const minPassOverallScore = parseOptionalThreshold('ICJIA_REMEDIATION_MIN_PASS_SCORE')
/**
 * When set (e.g. 80), remediated PDF bytes are deleted after the run if final overall score is
 * below this value (failures only; passing rows always keep). Saved when score >= threshold.
 */
const minKeepOverallScore = parseOptionalThreshold('ICJIA_REMEDIATION_MIN_KEEP_SCORE')
const scorePolicy: RemediationScorePolicy = {
  minPassOverallScore,
  minKeepOverallScore,
}
const enforceSingleOwner = process.env.ICJIA_REMEDIATION_ENFORCE_SINGLE_OWNER === '1'

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

function safeStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'item'
}

function relativeRemoteParts(serverHost: string | null, remotePath: string | null): string[] {
  if (!serverHost || !remotePath) return ['unknown']
  const roots: Record<string, string> = {
    '143.244.146.43': '/home/forge/archive.icjia-api.cloud/root/files',
    '192.241.146.85': '/home/forge/agency.icjia-api.cloud/agency-api/public/uploads',
    '157.230.3.215': '/home/forge/researchhub.icjia-api.cloud/researchhub/public/uploads',
  }
  const root = roots[serverHost]
  if (!root) return [safeStem(path.basename(remotePath))]
  const relative = path.posix.relative(root, remotePath)
  if (!relative || relative.startsWith('..')) return [safeStem(path.basename(remotePath))]
  return relative.split('/').filter(Boolean)
}

function stagePathFor(serverHost: string | null, remotePath: string | null): string {
  return path.join(stagingRoot, serverHost || 'unknown', ...relativeRemoteParts(serverHost, remotePath))
}

function reportPathFor(root: string, candidate: PriorityCandidate, suffix: string): string {
  const publicationPart = candidate.publicationId ? `${candidate.publicationId}-${safeStem(candidate.publicationTitle || '')}` : safeStem(path.basename(candidate.remotePath || candidate.reportPath))
  return path.join(root, candidate.serverHost || 'unknown', `${publicationPart}.${suffix}.json`)
}

function artifactPdfPathFor(candidate: PriorityCandidate): string {
  const publicationPart = candidate.publicationId ? `${candidate.publicationId}-${safeStem(candidate.publicationTitle || '')}` : safeStem(path.basename(candidate.remotePath || candidate.reportPath))
  return path.join(remediatedPdfRoot, candidate.serverHost || 'unknown', `${publicationPart}.pdf`)
}

function timeoutFailureRecord(
  candidate: PriorityCandidate,
  startedAt: number,
  originalResult: any,
  failureReportPath: string,
  options?: {
    reasonMessage?: string
    notes?: string
  },
): OutcomeRecord {
  const reasonMessage = options?.reasonMessage || `Processing exceeded the ${Math.round(timeoutMs / (60 * 1000))}-minute runtime limit.`
  const notes = options?.notes || `Processing exceeded ${timeoutMs}ms without producing a terminal outcome.`
  return {
    publicationId: candidate.publicationId,
    publicationTitle: candidate.publicationTitle,
    priorityRank: candidate.priorityRank,
    priorityTier: candidate.priorityTier,
    passLikelihoodScore: candidate.passLikelihoodScore,
    currentCorpusStatus: candidate.currentCorpusStatus,
    dominantSelectionFamily: candidate.dominantSelectionFamily,
    runtimeWeightBucket: candidate.runtimeWeightBucket,
    runtimeProfileKey: candidate.runtimeProfileKey,
    laneIntent: candidate.laneIntent,
    blockingFindingKeys: candidate.blockingFindingKeys,
    serverHost: candidate.serverHost,
    remotePath: candidate.remotePath,
    localCachePath: candidate.localCachePath,
    fileUrl: candidate.fileUrl,
    storageKind: candidate.storageKind,
    originalReportPath: candidate.reportPath,
    status: 'processing_error',
    resultBand: 'processing_error',
    processedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    original: {
      overallScore: originalResult.overallScore,
      grade: originalResult.grade,
      pageCount: originalResult.pageCount,
      isScanned: originalResult.isScanned,
    },
    final: null,
    seed: seedContextFor(candidate),
    gate: {
      passed: false,
      reasons: [
        reasonMessage,
        'Marked as excessive runtime and deferred so the batch can continue.',
      ],
      blockingLocalFindingKeys: [],
      criticalManualReviewFlagCodes: [],
      unresolvedCategoryLabels: [],
    },
    promotionStatus: null,
    artifacts: {
      remediatedPdfPath: null,
      stagedReplacementPath: null,
      detailedReportPath: null,
      failureReportPath,
    },
    checksums: {
      gateEvaluatedBufferSha256: null,
      remediatedPdfSha256: null,
      stagedReplacementSha256: null,
    },
    deferred: {
      reasonCode: 'excessive_runtime_loop',
      skipNextBatch: true,
      notes,
    },
  }
}

function excessiveRuntimeReasonFromMessage(message: string): {
  reasonMessage: string
  notes: string
} {
  const normalizedMessage = String(message || '').trim()
  const notes = normalizedMessage || `Processing exceeded ${timeoutMs}ms without producing a terminal outcome.`
  const budgetTupleMatch = /light=(\d+),\s*deep=(\d+),\s*total=(\d+)/i.exec(normalizedMessage)
  if (budgetTupleMatch) {
    const light = Number(budgetTupleMatch[1] || 0)
    const deep = Number(budgetTupleMatch[2] || 0)
    if (deep > 0 && light === 0) {
      return {
        reasonMessage: 'Processing hit the remediation inspection budget during deep ownership or figure analysis before reaching a stable passing result.',
        notes,
      }
    }
    if (light > 0 && deep > 0) {
      return {
        reasonMessage: 'Processing hit the remediation inspection budget after repeated ownership/structure verification without reaching a stable passing result.',
        notes,
      }
    }
    return {
      reasonMessage: 'Processing hit the remediation inspection budget before reaching a stable passing result.',
      notes,
    }
  }
  if (/inspection budget exceeded/i.test(normalizedMessage)) {
    if (/deep=\d+/i.test(normalizedMessage) && !/light=\d+/i.test(normalizedMessage)) {
      return {
        reasonMessage: 'Processing hit the remediation inspection budget during deep ownership or figure analysis before reaching a stable passing result.',
        notes,
      }
    }
    if (/light=\d+/i.test(normalizedMessage) && /deep=\d+/i.test(normalizedMessage)) {
      return {
        reasonMessage: 'Processing hit the remediation inspection budget after repeated ownership/structure verification without reaching a stable passing result.',
        notes,
      }
    }
    return {
      reasonMessage: 'Processing hit the remediation inspection budget before reaching a stable passing result.',
      notes,
    }
  }
  if (/inspect/i.test(normalizedMessage) || /structure/i.test(normalizedMessage)) {
    return {
      reasonMessage: 'Processing stopped after repeated structure inspection churn without reaching a stable passing result.',
      notes,
    }
  }
  return {
    reasonMessage: `Processing exceeded the ${Math.round(timeoutMs / (60 * 1000))}-minute runtime limit.`,
    notes,
  }
}

function attemptDirFor(candidate: PriorityCandidate): string {
  const publicationPart = candidate.publicationId ? `${candidate.publicationId}-${safeStem(candidate.publicationTitle || '')}` : safeStem(path.basename(candidate.remotePath || candidate.reportPath))
  return path.join(attemptsRoot, candidate.serverHost || 'unknown', publicationPart)
}

function loadOutcomes(): OutcomesManifest {
  if (!fs.existsSync(outcomesManifestPath)) {
    return {
      generatedAt: new Date().toISOString(),
      sourcePriorityManifestPath: priorityManifestPath,
      laneName: null,
      laneIntent: null,
      initialAnalysisProfile,
      concurrency,
      totals: {
        targetCandidates: 0,
        processed: 0,
        readyToReplace: 0,
        failedAfterRemediation: 0,
        sourceMissing: 0,
        processingError: 0,
        remaining: 0,
      },
      outcomes: [],
    }
  }
  return readJson<OutcomesManifest>(outcomesManifestPath)
}

function loadProgress(): RemediationBatchProgressDocument | null {
  if (!fs.existsSync(progressPath)) return null
  return readJson<RemediationBatchProgressDocument>(progressPath)
}

function normalizePriorityManifest(value: unknown): PriorityManifest {
  const doc = value as Record<string, unknown>
  const sourceCandidates = Array.isArray((doc as any).candidates)
    ? ((doc as any).candidates as Array<Record<string, unknown>>)
    : []

  const candidates: PriorityCandidate[] = sourceCandidates.map((candidate, index) => ({
    priorityRank: Number(candidate.priorityRank ?? candidate.nextWaveRank ?? index + 1),
    passLikelihoodScore: Number(candidate.passLikelihoodScore ?? 0),
    priorityTier: String(candidate.priorityTier ?? candidate.waveTier ?? 'medium') as 'highest' | 'high' | 'medium',
    recommendedAction: 'fix_first',
    publicationId: candidate.publicationId == null ? null : String(candidate.publicationId),
    publicationTitle: candidate.publicationTitle == null ? null : String(candidate.publicationTitle),
    serverHost: candidate.serverHost == null ? null : String(candidate.serverHost),
    remotePath: candidate.remotePath == null ? null : String(candidate.remotePath),
    localCachePath: candidate.localCachePath == null ? null : String(candidate.localCachePath),
    fileUrl: candidate.fileUrl == null ? null : String(candidate.fileUrl),
    storageKind: candidate.storageKind == null ? null : String(candidate.storageKind),
    currentCorpusStatus: candidate.currentCorpusStatus == null ? null : String(candidate.currentCorpusStatus),
    overallScore: Number(candidate.overallScore ?? 0),
    grade: String(candidate.grade ?? ''),
    pageCount: Number(candidate.pageCount ?? 0),
    isScanned: Boolean(candidate.isScanned),
    blockerFamilyCount: Number(candidate.blockerFamilyCount ?? 0),
    blockingFindingCount: Number(candidate.blockingFindingCount ?? 0),
    manualOnlyFailureModeCount: Number(candidate.manualOnlyFailureModeCount ?? 0),
    autoRunnableOpportunityCount: Number(candidate.autoRunnableOpportunityCount ?? 0),
    topBlockingResidualFamilyIds: Array.isArray(candidate.topBlockingResidualFamilyIds) ? candidate.topBlockingResidualFamilyIds.map(String) : [],
    blockingFindingKeys: Array.isArray(candidate.blockingFindingKeys) ? candidate.blockingFindingKeys.map(String) : [],
    autoRunnableOpportunityKeys: Array.isArray(candidate.autoRunnableOpportunityKeys) ? candidate.autoRunnableOpportunityKeys.map(String) : [],
    manualOnlyFailureModeKeys: Array.isArray(candidate.manualOnlyFailureModeKeys) ? candidate.manualOnlyFailureModeKeys.map(String) : [],
    heuristicReasons: Array.isArray(candidate.heuristicReasons) ? candidate.heuristicReasons.map(String) : [],
    dominantSelectionFamily: candidate.dominantSelectionFamily == null ? null : String(candidate.dominantSelectionFamily),
    runtimeWeightBucket: candidate.runtimeWeightBucket == null ? null : String(candidate.runtimeWeightBucket) as PriorityCandidate['runtimeWeightBucket'],
    runtimeProfileKey: candidate.runtimeProfileKey == null ? null : String(candidate.runtimeProfileKey),
    laneIntent: candidate.laneIntent == null ? null : String(candidate.laneIntent) as PriorityCandidate['laneIntent'],
    seedOverallScore: Number.isFinite(candidate.seedOverallScore) ? Number(candidate.seedOverallScore) : null,
    seedGrade: candidate.seedGrade == null ? null : String(candidate.seedGrade),
    seedResultBand: candidate.seedResultBand == null ? null : String(candidate.seedResultBand) as RemediationResultBand,
    seedProcessedAt: candidate.seedProcessedAt == null ? null : String(candidate.seedProcessedAt),
    reportPath: String(candidate.reportPath ?? ''),
  }))

  return {
    generatedAt: String(doc.generatedAt ?? new Date().toISOString()),
    sourceReportRoot: String(doc.sourceReportRoot ?? (doc.basedOn as any)?.sourceReportRoot ?? ''),
    laneName: doc.laneName == null ? null : String(doc.laneName),
    laneIntent: doc.laneIntent == null ? null : String(doc.laneIntent) as PriorityManifest['laneIntent'],
    executionPolicy: doc.executionPolicy == null ? null : String(doc.executionPolicy) as PriorityManifest['executionPolicy'],
    recommendedConcurrency: doc.recommendedConcurrency == null ? null : Number(doc.recommendedConcurrency),
    initialAnalysisProfile: doc.initialAnalysisProfile == null ? null : String(doc.initialAnalysisProfile) as AnalysisProfile,
    verificationPolicy: doc.verificationPolicy == null ? null : String(doc.verificationPolicy) as PriorityManifest['verificationPolicy'],
    totals: {
      scannedReportsConsidered: Number((doc.totals as any)?.scannedReportsConsidered ?? (doc.totals as any)?.remainingPublicationRowsConsidered ?? candidates.length),
      selectedCandidates: Number((doc.totals as any)?.selectedCandidates ?? (doc.totals as any)?.shortlistedCandidates ?? candidates.length),
      byTier: (((doc.totals as any)?.byTier ?? {}) as Record<string, number>),
    },
    candidates,
  }
}

function seedContextFor(candidate: PriorityCandidate): OutcomeSeedContext {
  const hasAnySeed =
    candidate.seedOverallScore != null
    || candidate.seedGrade != null
    || candidate.seedResultBand != null
    || candidate.seedProcessedAt != null

  if (!hasAnySeed) return null

  return {
    priorOverallScore: candidate.seedOverallScore ?? null,
    priorGrade: candidate.seedGrade ?? null,
    priorResultBand: candidate.seedResultBand ?? null,
    priorProcessedAt: candidate.seedProcessedAt ?? null,
  }
}

function lastCompletedFromOutcomes(manifest: OutcomesManifest): ProgressLastCompleted | null {
  const latest = manifest.outcomes.at(-1)
  if (!latest) return null
  return {
    publicationId: latest.publicationId,
    publicationTitle: latest.publicationTitle,
    status: latest.status,
    resultBand: inferOutcomeResultBand(latest),
    finalOverallScore: latest.final?.overallScore ?? null,
    processedAt: latest.processedAt,
    durationMs: latest.durationMs,
  }
}

function saveProgress(progress: RemediationBatchProgressDocument): void {
  writeJson(progressPath, progress)
}

function saveOutcomes(
  manifest: OutcomesManifest,
  targetCandidates: number,
  progress?: RemediationBatchProgressDocument | null,
): RemediationBatchProgressDocument | null {
  const remediatedPassCandidates = manifest.outcomes.filter(entry => entry.status === 'remediated_pass_candidate' || entry.status === 'ready_to_replace').length
  const countsByResultBand = countOutcomeResultBands(manifest.outcomes)
  const processingErrorToFailedAfterRemediation = manifest.outcomes.filter(entry =>
    entry.currentCorpusStatus === 'processing_error' && entry.status === 'failed_after_remediation'
  ).length
  const rowsWithBlockingFindingShrink = manifest.outcomes.filter(entry => {
    const gateBlocking = entry.gate?.blockingLocalFindingKeys?.length ?? 0
    const priorBlocking = entry.blockingFindingKeys?.length ?? 0
    return (
      entry.status === 'remediated_pass_candidate'
      || entry.status === 'ready_to_replace'
      || (
        entry.status === 'failed_after_remediation'
        && gateBlocking < priorBlocking
      )
    )
  }).length
  const totalDurationMs = manifest.outcomes.reduce((sum, entry) => sum + Math.max(0, entry.durationMs || 0), 0)
  const pdfsPerHour = totalDurationMs > 0
    ? Number(((manifest.outcomes.length * 60 * 60 * 1000) / totalDurationMs).toFixed(2))
    : 0
  const passCandidatesPerHour = totalDurationMs > 0
    ? Number(((remediatedPassCandidates * 60 * 60 * 1000) / totalDurationMs).toFixed(2))
    : 0
  const totals = {
    targetCandidates,
    processed: manifest.outcomes.length,
    readyToReplace: remediatedPassCandidates,
    remediatedPassCandidates,
    failedAfterRemediation: manifest.outcomes.filter(entry => entry.status === 'failed_after_remediation').length,
    sourceMissing: manifest.outcomes.filter(entry => entry.status === 'source_missing').length,
    processingError: manifest.outcomes.filter(entry => entry.status === 'processing_error').length,
    remaining: Math.max(0, targetCandidates - manifest.outcomes.length),
  }

  manifest.generatedAt = new Date().toISOString()
  manifest.concurrency = concurrency
  manifest.sourcePriorityManifestPath = priorityManifestPath
  manifest.totals = totals

  writeJson(outcomesManifestPath, manifest)
  writeJson(outcomesSummaryPath, {
    generatedAt: manifest.generatedAt,
    sourcePriorityManifestPath: manifest.sourcePriorityManifestPath,
    laneName: manifest.laneName,
    laneIntent: manifest.laneIntent,
    initialAnalysisProfile: manifest.initialAnalysisProfile,
    concurrency: manifest.concurrency,
    scorePolicy,
    countsByResultBand,
    totals,
    throughput: {
      processedRows: manifest.outcomes.length,
      pdfsPerHour,
      terminalOutcomesPerHour: pdfsPerHour,
      passCandidatesPerHour,
    },
    quality: manifest.laneIntent === 'truth_hardening_terminalization'
      ? {
          processingErrorToFailedAfterRemediation,
          rowsRemovedFromRetryBudget: processingErrorToFailedAfterRemediation + remediatedPassCandidates,
          unchangedUnresolvedRows: manifest.outcomes.filter(entry => entry.status === 'processing_error').length,
          rowsWithBlockingFindingShrink,
        }
      : {
          passCandidates: remediatedPassCandidates,
          rowsWithBlockingFindingShrink,
          remainingRetryWorthyRows: totals.remaining,
      },
    latestProcessed: manifest.outcomes.at(-1) || null,
  })

  if (!progress) return null

  const nextProgress = updateProgressDocument(progress, {
    totalCandidates: targetCandidates,
    processed: manifest.outcomes.length,
    remaining: totals.remaining,
    activeWorkers: progress.activeWorkers,
    countsByResultBand,
    lastCompleted: lastCompletedFromOutcomes(manifest),
  })
  saveProgress(nextProgress)
  return nextProgress
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function sha256OfFile(filePath: string): Promise<string> {
  return sha256Hex(await fs.promises.readFile(filePath))
}

async function processCandidate(candidate: PriorityCandidate): Promise<OutcomeRecord> {
  const startedAt = Date.now()
  const detailedReportPath = reportPathFor(detailedReportRoot, candidate, 'remediation')
  const failureReportPath = reportPathFor(failureReportRoot, candidate, 'failure')
  const remediatedPdfPath = artifactPdfPathFor(candidate)
  const stagedReplacementPath = stagePathFor(candidate.serverHost, candidate.remotePath)

  if (!candidate.localCachePath || !fs.existsSync(candidate.localCachePath)) {
    const record: OutcomeRecord = {
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      priorityRank: candidate.priorityRank,
      priorityTier: candidate.priorityTier,
      passLikelihoodScore: candidate.passLikelihoodScore,
      currentCorpusStatus: candidate.currentCorpusStatus,
      dominantSelectionFamily: candidate.dominantSelectionFamily,
      runtimeWeightBucket: candidate.runtimeWeightBucket,
      runtimeProfileKey: candidate.runtimeProfileKey,
      laneIntent: candidate.laneIntent,
      blockingFindingKeys: candidate.blockingFindingKeys,
      serverHost: candidate.serverHost,
      remotePath: candidate.remotePath,
      localCachePath: candidate.localCachePath,
      fileUrl: candidate.fileUrl,
      storageKind: candidate.storageKind,
      originalReportPath: candidate.reportPath,
      status: 'source_missing',
      resultBand: 'source_missing',
      processedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      original: null,
      final: null,
      seed: seedContextFor(candidate),
      gate: {
        passed: false,
        reasons: ['Local cache source PDF is missing.'],
        blockingLocalFindingKeys: [],
        criticalManualReviewFlagCodes: [],
        unresolvedCategoryLabels: [],
      },
      promotionStatus: null,
      artifacts: {
        remediatedPdfPath: null,
        stagedReplacementPath: null,
        detailedReportPath: null,
        failureReportPath,
      },
      checksums: {
        gateEvaluatedBufferSha256: null,
        remediatedPdfSha256: null,
        stagedReplacementSha256: null,
      },
    }
    writeJson(failureReportPath, record)
    return record
  }

  const originalBuffer = await fs.promises.readFile(candidate.localCachePath)
  const filename = path.basename(candidate.localCachePath)
  const originalResult = await analyzePdf(originalBuffer, filename, {
    skipAdobe: true,
    skipVeraPdf: true,
    analysisProfile: initialAnalysisProfile,
  })

  try {
    const remediation = await Promise.race([
      remediatePdf(originalBuffer, filename, originalResult, {
        artifactsDir: attemptDirFor(candidate),
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          const error = new Error(`Processing exceeded runtime limit of ${timeoutMs}ms`)
          ;(error as Error & { code?: string }).code = 'EXCESSIVE_RUNTIME'
          reject(error)
        }, timeoutMs)
      }),
    ])

    ensureDir(path.dirname(remediatedPdfPath))
    await fs.promises.writeFile(remediatedPdfPath, remediation.buffer)

    const gateEvaluatedBufferSha256 = sha256Hex(remediation.buffer)

    const strictGate = remediation.promotionGate
    const effectiveGate =
      minPassOverallScore != null
        ? evaluatePromotionGate(
            {
              analysisResult: remediation.finalAnalysis,
              manualReviewFlags: remediation.manualReviewFlags,
            },
            { minOverallScore: minPassOverallScore },
          )
        : strictGate

    const passed = effectiveGate.passed
    const finalScoreRaw = remediation.finalAnalysis.overallScore
    const scoreFinite = typeof finalScoreRaw === 'number' && Number.isFinite(finalScoreRaw)
    const meetsKeepFloor =
      minKeepOverallScore == null
      || (scoreFinite && finalScoreRaw >= minKeepOverallScore)
    const keepRemediatedFile = passed || meetsKeepFloor

    const checksums: NonNullable<OutcomeRecord['checksums']> = {
      gateEvaluatedBufferSha256,
      remediatedPdfSha256: null,
      stagedReplacementSha256: null,
    }

    const detailed = {
      generatedAt: new Date().toISOString(),
      candidate,
      seed: seedContextFor(candidate),
      original: {
        overallScore: originalResult.overallScore,
        grade: originalResult.grade,
        pageCount: originalResult.pageCount,
        isScanned: originalResult.isScanned,
        executiveSummary: originalResult.executiveSummary,
        warnings: originalResult.warnings,
        localStandards: originalResult.localStandards,
      },
      final: {
        overallScore: remediation.finalAnalysis.overallScore,
        grade: remediation.finalAnalysis.grade,
        pageCount: remediation.finalAnalysis.pageCount,
        isScanned: remediation.finalAnalysis.isScanned,
        executiveSummary: remediation.finalAnalysis.executiveSummary,
        warnings: remediation.finalAnalysis.warnings,
        localStandards: remediation.finalAnalysis.localStandards,
        categories: remediation.finalAnalysis.categories,
      },
      model: {
        manualReviewFlags: remediation.manualReviewFlags,
        finalAudit: remediation.finalAudit,
        plannerEvidence: remediation.plannerEvidence,
        failureProfile: remediation.failureProfile,
      },
      gate: effectiveGate,
      strictPromotionGate: minPassOverallScore != null ? strictGate : undefined,
      scorePolicy: {
        minPassOverallScore,
        minKeepOverallScore,
        keepRemediatedFile,
      },
      promotionStatus: null,
      checksums,
      remediatedPdfPath: keepRemediatedFile ? remediatedPdfPath : null,
      stagedReplacementPath: passed ? stagedReplacementPath : null,
    }

    if (passed) {
      ensureDir(path.dirname(stagedReplacementPath))
      await fs.promises.copyFile(remediatedPdfPath, stagedReplacementPath)
    } else {
      // Failure details are written after checksum collection so the report records
      // the exact bytes used for the final gate evaluation.
    }

    const remediatedPdfSha256 = await sha256OfFile(remediatedPdfPath)
    const stagedReplacementSha256 = passed ? await sha256OfFile(stagedReplacementPath) : null
    if (remediatedPdfSha256 !== gateEvaluatedBufferSha256) {
      throw new Error('Saved remediated PDF bytes do not match the final gate-evaluated buffer.')
    }
    if (passed && stagedReplacementSha256 !== gateEvaluatedBufferSha256) {
      throw new Error('Staged replacement bytes do not match the final gate-evaluated buffer.')
    }

    if (!keepRemediatedFile) {
      try {
        await fs.promises.unlink(remediatedPdfPath)
      } catch {
        // best-effort cleanup
      }
    }

    checksums.remediatedPdfSha256 = remediatedPdfSha256
    checksums.stagedReplacementSha256 = stagedReplacementSha256
    writeJson(detailedReportPath, detailed)
    if (!passed) {
      writeJson(failureReportPath, detailed)
    }

    const outcomeBase = {
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      priorityRank: candidate.priorityRank,
      priorityTier: candidate.priorityTier,
      passLikelihoodScore: candidate.passLikelihoodScore,
      currentCorpusStatus: candidate.currentCorpusStatus,
      dominantSelectionFamily: candidate.dominantSelectionFamily,
      runtimeWeightBucket: candidate.runtimeWeightBucket,
      runtimeProfileKey: candidate.runtimeProfileKey,
      laneIntent: candidate.laneIntent,
      blockingFindingKeys: candidate.blockingFindingKeys,
      serverHost: candidate.serverHost,
      remotePath: candidate.remotePath,
      localCachePath: candidate.localCachePath,
      fileUrl: candidate.fileUrl,
      storageKind: candidate.storageKind,
      originalReportPath: candidate.reportPath,
      status: passed ? ('remediated_pass_candidate' as const) : ('failed_after_remediation' as const),
      resultBand: classifyOutcomeResultBand({
        status: passed ? 'remediated_pass_candidate' : 'failed_after_remediation',
        finalOverallScore: remediation.finalAnalysis.overallScore,
        gatePassed: passed,
      }),
      promotionStatus: null,
      processedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      original: {
        overallScore: originalResult.overallScore,
        grade: originalResult.grade,
        pageCount: originalResult.pageCount,
        isScanned: originalResult.isScanned,
      },
      final: {
        overallScore: remediation.finalAnalysis.overallScore,
        grade: remediation.finalAnalysis.grade,
        pageCount: remediation.finalAnalysis.pageCount,
        isScanned: remediation.finalAnalysis.isScanned,
      },
      seed: seedContextFor(candidate),
      gate: effectiveGate,
      artifacts: {
        remediatedPdfPath: keepRemediatedFile ? remediatedPdfPath : null,
        stagedReplacementPath: passed ? stagedReplacementPath : null,
        detailedReportPath,
        failureReportPath: passed ? null : failureReportPath,
      },
      checksums: {
        gateEvaluatedBufferSha256,
        remediatedPdfSha256,
        stagedReplacementSha256,
      },
    }
    return minPassOverallScore != null
      ? { ...outcomeBase, strictPromotionGate: strictGate }
      : outcomeBase
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === 'EXCESSIVE_RUNTIME') {
      const message = error.message || ''
      const record = timeoutFailureRecord(
        candidate,
        startedAt,
        originalResult,
        failureReportPath,
        excessiveRuntimeReasonFromMessage(message),
      )
      writeJson(failureReportPath, record)
      return record
    }

    const message = error instanceof Error ? error.stack || error.message : String(error)
    const record: OutcomeRecord = {
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      priorityRank: candidate.priorityRank,
      priorityTier: candidate.priorityTier,
      passLikelihoodScore: candidate.passLikelihoodScore,
      currentCorpusStatus: candidate.currentCorpusStatus,
      dominantSelectionFamily: candidate.dominantSelectionFamily,
      runtimeWeightBucket: candidate.runtimeWeightBucket,
      runtimeProfileKey: candidate.runtimeProfileKey,
      laneIntent: candidate.laneIntent,
      blockingFindingKeys: candidate.blockingFindingKeys,
      serverHost: candidate.serverHost,
      remotePath: candidate.remotePath,
      localCachePath: candidate.localCachePath,
      fileUrl: candidate.fileUrl,
      storageKind: candidate.storageKind,
      originalReportPath: candidate.reportPath,
      status: 'processing_error',
      resultBand: 'processing_error',
      processedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      original: {
        overallScore: originalResult.overallScore,
        grade: originalResult.grade,
        pageCount: originalResult.pageCount,
        isScanned: originalResult.isScanned,
      },
      final: null,
      seed: seedContextFor(candidate),
      gate: {
        passed: false,
        reasons: [message],
        blockingLocalFindingKeys: [],
        criticalManualReviewFlagCodes: [],
        unresolvedCategoryLabels: [],
      },
      promotionStatus: null,
      artifacts: {
        remediatedPdfPath: null,
        stagedReplacementPath: null,
        detailedReportPath: null,
        failureReportPath,
      },
      checksums: {
        gateEvaluatedBufferSha256: null,
        remediatedPdfSha256: null,
        stagedReplacementSha256: null,
      },
    }
    writeJson(failureReportPath, record)
    return record
  }
}

export async function main(): Promise<void> {
  let progress: RemediationBatchProgressDocument | null = null
  let heartbeatTimer: NodeJS.Timeout | null = null
  let completed = false
  let activeWorkers = 0

  try {
    if (minPassOverallScore != null || minKeepOverallScore != null) {
      console.log(JSON.stringify({
        remediationScorePolicy: {
          ICJIA_REMEDIATION_MIN_PASS_SCORE: minPassOverallScore,
          ICJIA_REMEDIATION_MIN_KEEP_SCORE: minKeepOverallScore,
          note:
            'When MIN_PASS_SCORE is set, batch pass/staging uses relaxed promotion gate (min overall score, not scanned, no critical manual flags). '
            + 'Remediated PDFs are dropped when final score is below MIN_KEEP_SCORE (saved when >= that score) unless the row passes the effective gate. '
            + '`pnpm agency:verify-ready` now uses the forward verification threshold policy; the engine default remains strict unless you change it separately.',
        },
      }, null, 2))
    }

    ensureDir(path.dirname(outcomesManifestPath))
    ensureDir(detailedReportRoot)
    ensureDir(failureReportRoot)
    ensureDir(remediatedPdfRoot)
    ensureDir(path.dirname(progressPath))

    const priorityManifest = normalizePriorityManifest(readJson<unknown>(priorityManifestPath))
    if (
      (priorityManifest.executionPolicy === 'deferred' && process.env.ICJIA_ALLOW_DEFERRED_LANE !== '1')
      || (priorityManifest.executionPolicy === 'dormant' && process.env.ICJIA_ALLOW_DORMANT_LANE !== '1')
    ) {
      console.log(JSON.stringify({
        skipped: true,
        reason: `Manifest lane ${priorityManifest.laneName || 'unknown'} is ${priorityManifest.executionPolicy} by policy.`,
      }, null, 2))
      return
    }
    const targets = priorityManifest.candidates.filter(candidate =>
      candidate.priorityTier === 'highest'
      || candidate.priorityTier === 'high'
      || candidate.priorityTier === 'medium',
    )
    const limitedTargets = limit > 0 ? targets.slice(0, limit) : targets

    const outcomes = loadOutcomes()
    outcomes.laneName = priorityManifest.laneName || outcomes.laneName || null
    outcomes.laneIntent = priorityManifest.laneIntent || outcomes.laneIntent || null
    outcomes.initialAnalysisProfile = priorityManifest.initialAnalysisProfile || outcomes.initialAnalysisProfile || initialAnalysisProfile
    const doneKeys = new Set(outcomes.outcomes.map(entry => `${entry.serverHost}:${entry.remotePath}`))
    const pending = limitedTargets.filter(candidate => !doneKeys.has(`${candidate.serverHost}:${candidate.remotePath}`))
    let index = 0
    const countsByResultBand = countOutcomeResultBands(outcomes.outcomes)
    progress = createOrResumeProgressDocument({
      existingProgress: loadProgress(),
      manifestPath: priorityManifestPath,
      outcomesPath: outcomesManifestPath,
      totalCandidates: limitedTargets.length,
      processed: outcomes.outcomes.length,
      remaining: Math.max(0, limitedTargets.length - outcomes.outcomes.length),
      countsByResultBand,
      scorePolicy,
      pid: process.pid,
      activeWorkers,
      lastCompleted: lastCompletedFromOutcomes(outcomes),
      enforceSingleOwner,
      isAlive: processIsAlive,
    })
    saveProgress(progress)

    heartbeatTimer = setInterval(() => {
      if (!progress) return
      progress = updateProgressDocument(progress, {
        totalCandidates: limitedTargets.length,
        processed: outcomes.outcomes.length,
        remaining: Math.max(0, limitedTargets.length - outcomes.outcomes.length),
        activeWorkers,
        countsByResultBand: countOutcomeResultBands(outcomes.outcomes),
        lastCompleted: lastCompletedFromOutcomes(outcomes),
      })
      saveProgress(progress)
    }, 5000)
    heartbeatTimer.unref?.()

    async function worker(): Promise<void> {
      while (index < pending.length) {
        const candidate = pending[index++]
        activeWorkers += 1
        if (progress) {
          progress = updateProgressDocument(progress, {
            totalCandidates: limitedTargets.length,
            processed: outcomes.outcomes.length,
            remaining: Math.max(0, limitedTargets.length - outcomes.outcomes.length),
            activeWorkers,
            countsByResultBand: countOutcomeResultBands(outcomes.outcomes),
            lastCompleted: lastCompletedFromOutcomes(outcomes),
          })
          saveProgress(progress)
        }
        console.log(`[priority-remediation] starting rank=${candidate.priorityRank} tier=${candidate.priorityTier} ${candidate.remotePath}`)
        try {
          const outcome = await processCandidate(candidate)
          outcomes.outcomes.push(outcome)
          progress = saveOutcomes(outcomes, limitedTargets.length, progress) || progress
          console.log(`[priority-remediation] finished status=${outcome.status} rank=${candidate.priorityRank} ${candidate.remotePath}`)
        } finally {
          activeWorkers = Math.max(0, activeWorkers - 1)
          if (progress) {
            progress = updateProgressDocument(progress, {
              totalCandidates: limitedTargets.length,
              processed: outcomes.outcomes.length,
              remaining: Math.max(0, limitedTargets.length - outcomes.outcomes.length),
              activeWorkers,
              countsByResultBand: countOutcomeResultBands(outcomes.outcomes),
              lastCompleted: lastCompletedFromOutcomes(outcomes),
            })
            saveProgress(progress)
          }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))
    progress = saveOutcomes(outcomes, limitedTargets.length, progress) || progress
    if (progress) {
      progress = finalizeProgressDocument(progress, {
        state: 'completed',
        totalCandidates: limitedTargets.length,
        processed: outcomes.outcomes.length,
        remaining: Math.max(0, limitedTargets.length - outcomes.outcomes.length),
        activeWorkers: 0,
        countsByResultBand: countOutcomeResultBands(outcomes.outcomes),
        lastCompleted: lastCompletedFromOutcomes(outcomes),
      })
      saveProgress(progress)
    }
    completed = true
    console.log(JSON.stringify({ completed: outcomes.totals.processed, totals: outcomes.totals }, null, 2))
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (progress && !completed) {
      progress = finalizeProgressDocument(progress, {
        state: 'stale',
        totalCandidates: progress.totalCandidates,
        processed: progress.processed,
        remaining: progress.remaining,
        activeWorkers: 0,
        countsByResultBand: progress.countsByResultBand,
        lastCompleted: progress.lastCompleted,
      })
      saveProgress(progress)
    }
    closeAuditDb()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
