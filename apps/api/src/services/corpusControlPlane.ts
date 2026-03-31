import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type CorpusStatus =
  | 'verified_pass'
  | 'discovered'
  | 'analyzed'
  | 'queued_for_remediation'
  | 'remediated_fail'
  | 'processing_error'
  | 'deferred_manual'
  | 'staged_for_replacement'
  | 'replaced_remote'

export type CohortLabel =
  | 'short_high_likelihood'
  | 'figure_heavy'
  | 'structure_heavy'
  | 'font_heavy'
  | 'long_report'
  | 'manual_tail'

export type SourceKind = 'legacy_archive' | 'agency_upload' | 'researchhub_upload'
export type VerificationClassification = 'verified_pass' | 'soft_fail_advisory' | 'hard_fail'
export type FigureWaveBucket = 'ownership_cleared_figure_debt_remains' | 'mixed_figure_structure_debt' | 'mass_unresolved_figure_debt' | 'figure_processing_error_retry'
export type StructureWaveBucket = 'structure_only_residuals' | 'mixed_structure_figure_residuals' | 'metadata_navigation_residuals' | 'structure_processing_error_retry'
export type Stage4TerminalSurvivorClass =
  | 'staged_pass_candidate_survivor'
  | 'near_pass_grade_only'
  | 'metadata_title_survivor'
  | 'font_text_extractability_survivor'
  | 'figure_spillover_survivor'
  | 'reading_order_only_survivor'
export type Stage4PendingAnalysisDisposition =
  | 'metadata_navigation_residuals'
  | 'structure_only_residuals'
  | 'mixed_structure_figure_residuals'
  | 'structure_processing_error_retry'
  | 'reclassify_to_figure_heavy'
export type Stage4PendingAnalysisEvidenceStrength =
  | 'terminal_report'
  | 'failure_report'
  | 'attempt_artifact_only'
  | 'control_plane_only'

export type Stage4ActiveAnalysisDisposition =
  | 'metadata_navigation_residuals'
  | 'structure_only_residuals'
  | 'mixed_structure_figure_residuals'
  | 'structure_processing_error_retry'

export type Stage4StalledAnalysisDisposition =
  | 'metadata_title_survivor'
  | 'metadata_navigation_residuals'
  | 'font_text_extractability_survivor'
  | 'mixed_structure_figure_residuals'
  | 'structure_processing_error_retry'

export type Stage4OverlapAnalysisDisposition =
  | 'metadata_navigation_residuals'
  | 'reading_order_only_survivor'

export interface PublicationReplacementMapRow {
  publicationId: string
  title: string | null
  slug: string | null
  fileUrl: string | null
  fileHost: string | null
  storageKind: SourceKind | 'other_pdf' | string
  replaceVia: string | null
  serverHost: string | null
  sshTarget: string | null
  remotePath: string | null
  remoteDir: string | null
  localWorkingPath: string | null
  localBackupPath: string | null
  localServerMirrorPath: string | null
  expectedPresence: string | null
  notes: string | null
  checksumState?: {
    checksumRecordedAt?: string | null
    localCurrentFilePath?: string | null
    localCurrentFileMd5?: string | null
    localBackupFileMd5?: string | null
    localMirrorFileMd5?: string | null
    replacementCandidatePath?: string | null
    replacementCandidateMd5?: string | null
  } | null
}

export interface PromotionLedgerVerificationSummary {
  passed: boolean
  overallScore: number | null
  grade: string | null
  pageCount: number | null
  isScanned: boolean | null
  reasons: string[]
  blockingLocalFindingKeys: string[]
  unresolvedCategoryLabels: string[]
  criticalManualReviewFlagCodes: string[]
}

export interface PromotionLedgerRow {
  publicationId: string
  publicationTitle: string | null
  sourceKind: string
  sourcePathOrUrl: string | null
  sourceFileUrl: string | null
  localFinalArtifactPath: string | null
  stagedReplacementPath: string
  currentSourceChecksumSha256: string | null
  replacementChecksumSha256: string
  verificationReportPath: string
  verificationTimestamp: string
  verificationSummary: PromotionLedgerVerificationSummary
  promotionStatus: string
}

export interface VerificationResult {
  key: string
  mode: 'local_staged' | 'remote_live'
  sourcePathOrUrl: string
  filename: string
  verifiedAt: string
  durationMs: number
  passed: boolean
  missing: boolean
  error: string | null
  summary: {
    overallScore: number | null
    grade: string | null
    pageCount: number | null
    isScanned: boolean | null
  }
  gate: {
    reasons: string[]
    blockingLocalFindingKeys: string[]
    unresolvedCategoryLabels: string[]
    criticalManualReviewFlagCodes?: string[]
  }
  artifacts: {
    reportPath: string
  }
}

export interface PublicationVerificationRow {
  publicationId: string
  publicationTitle: string | null
  fileUrl: string | null
  serverHost: string | null
  remotePath: string | null
  stagedReplacementPath: string | null
  localFinalArtifactPath?: string | null
  criticalManualReviewFlagCodes?: string[]
  sourceKind: 'complete_seed' | 'batch_ready' | 'already_replaced_remote'
  sourceManifest: string
  sourceStatus: string
  verificationKey: string
  verificationPassed: boolean
  verificationMissing: boolean
  verificationError: string | null
}

export interface ClassifiedPublicationVerificationRow extends PublicationVerificationRow {
  classification: VerificationClassification
}

export interface OutcomeRecordLike {
  publicationId: string
  publicationTitle?: string | null
  status?: string | null
  processedAt?: string | null
  durationMs?: number | null
  priorityRank?: number | null
  priorityTier?: string | null
  passLikelihoodScore?: number | null
  serverHost?: string | null
  remotePath?: string | null
  localCachePath?: string | null
  fileUrl?: string | null
  storageKind?: string | null
  originalReportPath?: string | null
  gate?: {
    passed?: boolean | null
    blockingLocalFindingKeys?: string[]
    unresolvedCategoryLabels?: string[]
    criticalManualReviewFlagCodes?: string[]
    reasons?: string[]
  } | null
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
  artifacts?: {
    remediatedPdfPath?: string | null
    stagedReplacementPath?: string | null
    detailedReportPath?: string | null
    failureReportPath?: string | null
  } | null
}

export interface CandidateRecordLike {
  publicationId: string
  publicationTitle?: string | null
  priorityRank?: number | null
  priorityTier?: string | null
  recommendedAction?: string | null
  passLikelihoodScore?: number | null
  serverHost?: string | null
  remotePath?: string | null
  localCachePath?: string | null
  fileUrl?: string | null
  storageKind?: string | null
  overallScore?: number | null
  grade?: string | null
  pageCount?: number | null
  isScanned?: boolean | null
  blockerFamilyCount?: number | null
  blockingFindingCount?: number | null
  manualOnlyFailureModeCount?: number | null
  autoRunnableOpportunityCount?: number | null
  topBlockingResidualFamilyIds?: string[]
  blockingFindingKeys?: string[]
  autoRunnableOpportunityKeys?: string[]
  manualOnlyFailureModeKeys?: string[]
  heuristicReasons?: string[]
  reportPath?: string | null
}

export interface BenchmarkOutcomeLike {
  name: string
  filePath: string
  category?: string | null
  ok?: boolean
  durationMs?: number | null
  terminalState?: string | null
  final?: {
    blockingLocalFindingKeys?: string[] | null
    inspectionProfile?: {
      pattern?: string | null
      dominantPhase?: string | null
      deepDowngradedToLight?: boolean | null
    } | null
    remediationMetrics?: {
      phases?: {
        ownershipState?: {
          initialRiskCount?: number | null
          finalRiskCount?: number | null
        } | null
        figureDescriptionState?: {
          initialMissingAltCount?: number | null
          finalMissingAltCount?: number | null
          initialDecorativeFigureCount?: number | null
          finalDecorativeFigureCount?: number | null
        } | null
      } | null
    } | null
  } | null
  error?: {
    code?: string | null
    message?: string | null
  } | null
}

export interface CorpusControlPlaneSources {
  repoRoot: string
  manifestsRoot: string
  replacementMapPath: string
  verificationPath: string | null
  verificationClassifiedPath: string | null
  promotionLedgerPath: string | null
  regressionBenchmarkPath: string | null
  stage4PendingAnalysisPath: string | null
  stage4ActiveAnalysisPath: string | null
  stage4StalledAnalysisPath: string | null
  stage4OverlapAnalysisPath: string | null
  replacementMap: PublicationReplacementMapRow[]
  verificationResults: VerificationResult[]
  verificationRows: PublicationVerificationRow[]
  classifiedRows: ClassifiedPublicationVerificationRow[]
  promotionLedgerRows: PromotionLedgerRow[]
  outcomeManifests: Array<{
    path: string
    outcomes: OutcomeRecordLike[]
  }>
  candidateManifests: Array<{
    path: string
    candidates: CandidateRecordLike[]
  }>
  regressionBenchmarkOutcomes: BenchmarkOutcomeLike[]
  stage4PendingAnalysisRows: Array<{
    publicationId: string
    publicationTitle: string | null
    priorStructureWaveBucket: StructureWaveBucket | null
    analysisDisposition: Stage4PendingAnalysisDisposition
    evidenceStrength: Stage4PendingAnalysisEvidenceStrength
    evidencePaths: {
      terminalReportPath: string | null
      failureReportPath: string | null
      attemptArtifactPath: string | null
      controlPlanePath: string
    }
    reasonCodes: string[]
    notes: string[]
  }>
  stage4ActiveAnalysisRows: Array<{
    publicationId: string
    publicationTitle: string | null
    priorStructureWaveBucket: StructureWaveBucket | null
    activeDisposition: Stage4ActiveAnalysisDisposition
    evidenceStrength: Stage4PendingAnalysisEvidenceStrength
    evidencePaths: {
      latestStage4AttemptPath: string | null
      latestStage4OutcomePath: string | null
      controlPlanePath: string
    }
    reasonCodes: string[]
    notes: string[]
  }>
  stage4StalledAnalysisRows: Array<{
    publicationId: string
    publicationTitle: string | null
    priorStructureWaveBucket: StructureWaveBucket | null
    stalledDisposition: Stage4StalledAnalysisDisposition
    evidenceStrength: Stage4PendingAnalysisEvidenceStrength
    evidencePaths: {
      latestStage4ReportPath: string | null
      latestStage4FailurePath: string | null
      latestStage4AttemptPath: string | null
      controlPlanePath: string
    }
    reasonCodes: string[]
    notes: string[]
  }>
  stage4OverlapAnalysisRows: Array<{
    publicationId: string
    publicationTitle: string | null
    priorStructureWaveBucket: StructureWaveBucket | null
    overlapDisposition: Stage4OverlapAnalysisDisposition
    evidenceStrength: Stage4PendingAnalysisEvidenceStrength
    evidencePaths: {
      latestStage4ReportPath: string | null
      latestStage4FailurePath: string | null
      latestStage4AttemptPath: string | null
      controlPlanePath: string
    }
    reasonCodes: string[]
    notes: string[]
  }>
}

export interface CorpusControlPlaneRow {
  publicationId: string
  title: string | null
  slug: string | null
  fileUrl: string | null
  storageKind: string | null
  sourceKind: SourceKind
  serverHost: string | null
  remotePath: string | null
  remoteDir: string | null
  replaceVia: string | null
  currentCorpusStatus: CorpusStatus
  cohortLabel: CohortLabel
  sourceMetadata: {
    fileHost: string | null
    sshTarget: string | null
    expectedPresence: string | null
    localWorkingPath: string | null
    localBackupPath: string | null
    localServerMirrorPath: string | null
    checksumRecordedAt: string | null
    currentSourcePath: string | null
    currentSourceMd5: string | null
  }
  statusEvidence: {
    sourceManifestPath: string
    sourceStatus: string
    verificationManifestPath: string | null
    verificationClassification: VerificationClassification | null
    verificationTimestamp: string | null
    verificationReportPath: string | null
    outcomeManifestPath: string | null
    outcomeStatus: string | null
    latestReportPath: string | null
    candidateManifestPath: string | null
  }
  classificationEvidence: {
    pageCount: number | null
    isScanned: boolean | null
    overallScore: number | null
    grade: string | null
    blockerFamilyCount: number | null
    blockingFindingCount: number | null
    manualOnlyFailureModeCount: number | null
    autoRunnableOpportunityCount: number | null
    topBlockingResidualFamilyIds: string[]
    blockingFindingKeys: string[]
    autoRunnableOpportunityKeys: string[]
    manualOnlyFailureModeKeys: string[]
  }
  promotionTruth: {
    promotionStatus: string | null
    ledgerRowPresent: boolean
    stagedReplacementPath: string | null
    replacementChecksumSha256: string | null
    verificationPassed: boolean
  }
  stage3FigureDiagnostics: {
    figureWaveBucket: FigureWaveBucket | null
    ownershipRiskKnown: boolean
    ownershipRiskCountInitial: number | null
    ownershipRiskCountFinal: number | null
    missingAltCountInitial: number | null
    missingAltCountFinal: number | null
    decorativeFigureCountInitial: number | null
    decorativeFigureCountFinal: number | null
    dominantFigurePhase: string | null
    inspectionPattern: string | null
    hasGenericTimeoutWording: boolean
  }
  stage4StructureDiagnostics: {
    structureWaveBucket: StructureWaveBucket | null
    terminalSurvivorClass: Stage4TerminalSurvivorClass | null
    dominantStructurePhase: string | null
    hasLogicalStructureDebt: boolean | null
    hasHeadingDebt: boolean | null
    hasReadingOrderDebt: boolean | null
    hasMetadataNavigationDebt: boolean | null
    hasMixedFigureResiduals: boolean | null
    hasBoundedRuntimeWording: boolean
    originLane: 'native_structure_heavy' | 'reclassified_from_figure_heavy' | 'reclassified_from_short_high_likelihood'
  }
  reasonCodes: string[]
  notes: string[]
}

export interface CorpusControlPlaneDocument {
  generatedAt: string
  summary: CorpusControlPlaneSummary
  rows: CorpusControlPlaneRow[]
}

export interface CorpusControlPlaneSummary {
  totalRows: number
  byCurrentCorpusStatus: Record<CorpusStatus, number>
  byCohortLabel: Record<CohortLabel, number>
  byStorageKind: Record<string, number>
  statusByCohort: Record<CohortLabel, Record<CorpusStatus, number>>
  verifiedPassRowsFromLedger: number
  remainingRowsExcludingVerifiedPass: number
}

export interface CorpusControlPlaneByCohortDocument {
  generatedAt: string
  cohorts: Record<CohortLabel, {
    totalRows: number
    byCurrentCorpusStatus: Record<CorpusStatus, number>
    samplePublicationIds: string[]
  }>
}

export interface CorpusControlPlaneCanaryRow {
  publicationId: string | null
  publicationTitle: string | null
  filePath: string
  benchmarkName: string
  benchmarkCategory: string | null
  benchmarkTerminalState: string | null
  cohortLabel: CohortLabel
  currentCorpusStatus: CorpusStatus | null
}

export interface CorpusControlPlaneCanariesDocument {
  generatedAt: string
  summary: {
    totalCanaries: number
    matchedPublicationIds: number
    unmatchedCanaries: number
    byCohortLabel: Record<CohortLabel, number>
  }
  rows: CorpusControlPlaneCanaryRow[]
}

export interface CorpusControlPlaneArtifacts {
  document: CorpusControlPlaneDocument
  byCohort: CorpusControlPlaneByCohortDocument
  canaries: CorpusControlPlaneCanariesDocument
}

export interface CorpusControlPlaneValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const defaultRepoRoot = path.resolve(moduleDir, '..', '..', '..', '..')

const ALL_STATUSES: CorpusStatus[] = [
  'verified_pass',
  'discovered',
  'analyzed',
  'queued_for_remediation',
  'remediated_fail',
  'processing_error',
  'deferred_manual',
  'staged_for_replacement',
  'replaced_remote',
]

const ALL_COHORTS: CohortLabel[] = [
  'short_high_likelihood',
  'figure_heavy',
  'structure_heavy',
  'font_heavy',
  'long_report',
  'manual_tail',
]

const LONG_REPORT_PAGE_THRESHOLD = 40
const FIGURE_FAMILY_PATTERN = /(figure|alt|ownership|artifact|image)/i
const STRUCTURE_FAMILY_PATTERN = /(logical_structure|heading|reading_order|marked_content|page_tabs|structure)/i
const STRUCTURE_METADATA_PATTERN = /(document_language|display_doc_title|metadata_identification|bookmark_language|page_tabs|language|bookmark|metadata|title)/i
const FONT_FAMILY_PATTERN = /(font|unicode|charenc)/i

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function compareIsoDesc(left: string | null, right: string | null): number {
  const leftTime = left ? Date.parse(left) : 0
  const rightTime = right ? Date.parse(right) : 0
  return rightTime - leftTime
}

function normalizeSourceKind(storageKind: string | null | undefined): SourceKind {
  if (storageKind === 'agency_upload') return 'agency_upload'
  if (storageKind === 'researchhub_upload') return 'researchhub_upload'
  return 'legacy_archive'
}

function safeArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : []
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort()
}

function emptyStatusCounts(): Record<CorpusStatus, number> {
  return Object.fromEntries(ALL_STATUSES.map(status => [status, 0])) as Record<CorpusStatus, number>
}

function emptyCohortCounts(): Record<CohortLabel, number> {
  return Object.fromEntries(ALL_COHORTS.map(cohort => [cohort, 0])) as Record<CohortLabel, number>
}

function statusRank(status: CorpusStatus): number {
  return {
    verified_pass: 90,
    replaced_remote: 80,
    staged_for_replacement: 70,
    remediated_fail: 60,
    processing_error: 55,
    deferred_manual: 50,
    queued_for_remediation: 40,
    analyzed: 30,
    discovered: 20,
  }[status]
}

function deriveStatusFromOutcomeStatus(status: string | null | undefined): CorpusStatus | null {
  switch (status) {
    case 'processing_error':
      return 'processing_error'
    case 'failed_after_remediation':
      return 'remediated_fail'
    case 'remediated_pass_candidate':
    case 'ready_to_replace':
      return 'staged_for_replacement'
    default:
      return null
  }
}

function chooseLatestOutcome(outcomes: Array<{ manifestPath: string; outcome: OutcomeRecordLike }>): { manifestPath: string; outcome: OutcomeRecordLike } | null {
  if (!outcomes.length) return null
  return [...outcomes].sort((left, right) => {
    const byProcessedAt = compareIsoDesc(isoOrNull(left.outcome.processedAt), isoOrNull(right.outcome.processedAt))
    if (byProcessedAt !== 0) return byProcessedAt
    return right.manifestPath.localeCompare(left.manifestPath)
  })[0]
}

function chooseBestCandidate(candidates: Array<{ manifestPath: string; candidate: CandidateRecordLike }>): { manifestPath: string; candidate: CandidateRecordLike } | null {
  if (!candidates.length) return null
  return [...candidates].sort((left, right) => {
    const scoreDiff = Number(right.candidate.passLikelihoodScore || 0) - Number(left.candidate.passLikelihoodScore || 0)
    if (scoreDiff !== 0) return scoreDiff
    const rankDiff = Number(left.candidate.priorityRank || Number.MAX_SAFE_INTEGER) - Number(right.candidate.priorityRank || Number.MAX_SAFE_INTEGER)
    if (rankDiff !== 0) return rankDiff
    return left.manifestPath.localeCompare(right.manifestPath)
  })[0]
}

function benchmarkOutcomeByPublicationId(sources: CorpusControlPlaneSources): Map<string, BenchmarkOutcomeLike> {
  const publicationIdByLocalPath = new Map<string, string>()
  for (const row of sources.replacementMap) {
    const localPath = row.checksumState?.localCurrentFilePath
    if (localPath) publicationIdByLocalPath.set(localPath, row.publicationId)
  }

  const outcomes = new Map<string, BenchmarkOutcomeLike>()
  for (const outcome of sources.regressionBenchmarkOutcomes) {
    const publicationId = publicationIdByLocalPath.get(outcome.filePath)
    if (!publicationId) continue
    outcomes.set(publicationId, outcome)
  }
  return outcomes
}

function safeNumberOrNull(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? Number(value) : null
}

function hasGenericTimeoutWording(input: {
  benchmarkOutcome: BenchmarkOutcomeLike | null
  latestOutcome: { manifestPath: string; outcome: OutcomeRecordLike } | null
}): boolean {
  const benchmarkMessage = input.benchmarkOutcome?.error?.message || null
  const outcomeReasons = input.latestOutcome?.outcome.gate?.reasons || []
  const text = [benchmarkMessage, ...outcomeReasons].filter((value): value is string => Boolean(value)).join(' | ')
  if (!text) return false
  return /timeout/i.test(text) && !/inspection budget exceeded/i.test(text) && !/excessive_runtime/i.test(text)
}

function isInspectionBudgetProcessingError(latestOutcome: { manifestPath: string; outcome: OutcomeRecordLike } | null): boolean {
  if (!latestOutcome || latestOutcome.outcome.status !== 'processing_error') return false
  const text = safeArray(latestOutcome.outcome.gate?.reasons).join(' | ')
  return /inspection budget exceeded|excessive runtime|excessive_runtime/i.test(text)
}

function deriveStage3FigureDiagnostics(input: {
  rowCohortLabel: CohortLabel
  rowCurrentCorpusStatus: CorpusStatus
  classificationEvidence: CorpusControlPlaneRow['classificationEvidence']
  latestOutcome: { manifestPath: string; outcome: OutcomeRecordLike } | null
  benchmarkOutcome: BenchmarkOutcomeLike | null
}): CorpusControlPlaneRow['stage3FigureDiagnostics'] {
  const ownershipInitial = safeNumberOrNull(input.benchmarkOutcome?.final?.remediationMetrics?.phases?.ownershipState?.initialRiskCount)
  const ownershipFinal = safeNumberOrNull(input.benchmarkOutcome?.final?.remediationMetrics?.phases?.ownershipState?.finalRiskCount)
  const missingAltInitial = safeNumberOrNull(input.benchmarkOutcome?.final?.remediationMetrics?.phases?.figureDescriptionState?.initialMissingAltCount)
  const missingAltFinal = safeNumberOrNull(input.benchmarkOutcome?.final?.remediationMetrics?.phases?.figureDescriptionState?.finalMissingAltCount)
  const decorativeInitial = safeNumberOrNull(input.benchmarkOutcome?.final?.remediationMetrics?.phases?.figureDescriptionState?.initialDecorativeFigureCount)
  const decorativeFinal = safeNumberOrNull(input.benchmarkOutcome?.final?.remediationMetrics?.phases?.figureDescriptionState?.finalDecorativeFigureCount)
  const latestOutcomeBlockingKeys = uniqueStrings(input.latestOutcome?.outcome.gate?.blockingLocalFindingKeys || [])
  const blockingKeys = uniqueStrings([
    ...input.classificationEvidence.blockingFindingKeys,
    ...(input.benchmarkOutcome?.final?.blockingLocalFindingKeys || []),
    ...latestOutcomeBlockingKeys,
  ])
  const decisiveBlockingKeys = latestOutcomeBlockingKeys.length > 0 ? latestOutcomeBlockingKeys : blockingKeys
  const familyText = [
    ...input.classificationEvidence.topBlockingResidualFamilyIds,
    ...blockingKeys,
  ].join(' ')
  const hasFigureSignals = input.rowCohortLabel === 'figure_heavy' || /pdfua.figure_alt_or_artifact/i.test(familyText) || FIGURE_FAMILY_PATTERN.test(familyText)
  const hasStructureSignals = STRUCTURE_FAMILY_PATTERN.test(familyText)
  const ownershipRiskKnown = ownershipInitial !== null || ownershipFinal !== null
  const ownershipCleared = ownershipRiskKnown && (ownershipInitial || 0) > 0 && ownershipFinal === 0
  const missingAltRemains = (missingAltFinal || 0) > 0 || decisiveBlockingKeys.includes('pdfua.figure_alt_or_artifact')
  const onlyFigureBlocking = decisiveBlockingKeys.length > 0 && decisiveBlockingKeys.every(key => key === 'pdfua.figure_alt_or_artifact')
  const mixedFigureAndStructureBlocking = decisiveBlockingKeys.includes('pdfua.figure_alt_or_artifact') && decisiveBlockingKeys.includes('pdfua.logical_structure')
  const structureOnlyBlocking = decisiveBlockingKeys.includes('pdfua.logical_structure') && !decisiveBlockingKeys.includes('pdfua.figure_alt_or_artifact')
  const largeOrFlatFigureDebt = (missingAltFinal || 0) >= 25 || ((missingAltFinal || 0) > 0 && missingAltFinal === missingAltInitial)

  let figureWaveBucket: FigureWaveBucket | null = null
  if (hasFigureSignals) {
    if (isInspectionBudgetProcessingError(input.latestOutcome)) {
      figureWaveBucket = 'figure_processing_error_retry'
    } else if (mixedFigureAndStructureBlocking) {
      figureWaveBucket = 'mixed_figure_structure_debt'
    } else if (structureOnlyBlocking) {
      figureWaveBucket = null
    } else if (ownershipCleared && decisiveBlockingKeys.includes('pdfua.figure_alt_or_artifact')) {
      figureWaveBucket = largeOrFlatFigureDebt
        ? 'mass_unresolved_figure_debt'
        : 'ownership_cleared_figure_debt_remains'
    } else if (onlyFigureBlocking) {
      figureWaveBucket = ownershipCleared && !largeOrFlatFigureDebt
        ? 'ownership_cleared_figure_debt_remains'
        : 'mass_unresolved_figure_debt'
    } else if (input.rowCurrentCorpusStatus === 'processing_error') {
      figureWaveBucket = 'figure_processing_error_retry'
    } else if (ownershipCleared && missingAltRemains) {
      figureWaveBucket = largeOrFlatFigureDebt
        ? 'mass_unresolved_figure_debt'
        : 'ownership_cleared_figure_debt_remains'
    } else if (hasStructureSignals) {
      figureWaveBucket = 'mixed_figure_structure_debt'
    } else {
      figureWaveBucket = 'mass_unresolved_figure_debt'
    }
  }

  return {
    figureWaveBucket,
    ownershipRiskKnown,
    ownershipRiskCountInitial: ownershipInitial,
    ownershipRiskCountFinal: ownershipFinal,
    missingAltCountInitial: missingAltInitial,
    missingAltCountFinal: missingAltFinal,
    decorativeFigureCountInitial: decorativeInitial,
    decorativeFigureCountFinal: decorativeFinal,
    dominantFigurePhase: input.benchmarkOutcome?.final?.inspectionProfile?.dominantPhase || null,
    inspectionPattern: input.benchmarkOutcome?.final?.inspectionProfile?.pattern || null,
    hasGenericTimeoutWording: hasGenericTimeoutWording({
      benchmarkOutcome: input.benchmarkOutcome,
      latestOutcome: input.latestOutcome,
    }),
  }
}

function deriveStage4StructureDiagnostics(input: {
  rowCohortLabel: CohortLabel
  rowCurrentCorpusStatus: CorpusStatus
  classificationEvidence: CorpusControlPlaneRow['classificationEvidence']
  latestOutcome: { manifestPath: string; outcome: OutcomeRecordLike } | null
  benchmarkOutcome: BenchmarkOutcomeLike | null
  reasonCodes: string[]
}): CorpusControlPlaneRow['stage4StructureDiagnostics'] {
  const latestOutcomeBlockingKeys = uniqueStrings(input.latestOutcome?.outcome.gate?.blockingLocalFindingKeys || [])
  const latestOutcomeUnresolvedCategories = uniqueStrings(input.latestOutcome?.outcome.gate?.unresolvedCategoryLabels || [])
  const latestOutcomeReasons = uniqueStrings(input.latestOutcome?.outcome.gate?.reasons || [])
  const blockingKeys = uniqueStrings([
    ...input.classificationEvidence.blockingFindingKeys,
    ...(input.benchmarkOutcome?.final?.blockingLocalFindingKeys || []),
    ...latestOutcomeBlockingKeys,
  ])
  const latestOutcomeHasGateSignals = latestOutcomeBlockingKeys.length > 0 || latestOutcomeUnresolvedCategories.length > 0 || latestOutcomeReasons.length > 0
  const decisiveBlockingKeys = latestOutcomeHasGateSignals ? latestOutcomeBlockingKeys : blockingKeys
  const decisiveJoinedText = latestOutcomeHasGateSignals
    ? [
        ...latestOutcomeBlockingKeys,
        ...latestOutcomeUnresolvedCategories,
        ...latestOutcomeReasons,
      ].join(' ')
    : [
        ...input.classificationEvidence.topBlockingResidualFamilyIds,
        ...blockingKeys,
        ...input.reasonCodes,
      ].join(' ')

  const hasLogicalStructureDebt = decisiveBlockingKeys.includes('pdfua.logical_structure')
    || decisiveBlockingKeys.includes('pdfua.heading_content_quality')
    || STRUCTURE_FAMILY_PATTERN.test(decisiveJoinedText)
  const hasHeadingDebt = decisiveBlockingKeys.some(key => /heading/i.test(key))
    || /heading/i.test(decisiveJoinedText)
  const hasReadingOrderDebt = decisiveBlockingKeys.some(key => /reading_order|page_tabs/i.test(key))
    || latestOutcomeUnresolvedCategories.some(label => /reading order/i.test(label))
    || latestOutcomeReasons.some(reason => /reading order/i.test(reason))
  const hasMetadataNavigationDebt = decisiveBlockingKeys.some(key => /document_language|display_doc_title|metadata_identification|bookmark_language|page_tabs/i.test(key))
    || STRUCTURE_METADATA_PATTERN.test(decisiveJoinedText)
  const hasMixedFigureResiduals = decisiveBlockingKeys.some(key => /figure|artifact|image|untagged_rendered_images/i.test(key))
    || FIGURE_FAMILY_PATTERN.test(decisiveJoinedText)

  let terminalSurvivorClass: Stage4TerminalSurvivorClass | null = null
  if (input.latestOutcome?.outcome.status === 'remediated_pass_candidate') {
    terminalSurvivorClass = 'staged_pass_candidate_survivor'
  } else if (input.latestOutcome?.outcome.status === 'failed_after_remediation') {
    const finalGrade = input.latestOutcome.outcome.final?.grade || null
    const finalScore = input.latestOutcome.outcome.final?.overallScore ?? null
    if (
      finalGrade === 'B'
      && typeof finalScore === 'number'
      && latestOutcomeBlockingKeys.length === 0
      && latestOutcomeUnresolvedCategories.length === 0
    ) {
      terminalSurvivorClass = 'near_pass_grade_only'
    } else if (
      latestOutcomeBlockingKeys.length === 1
      && latestOutcomeBlockingKeys[0] === 'pdfua.display_doc_title'
      && latestOutcomeUnresolvedCategories.every(label => /document title|pdf\/ua compliance/i.test(label))
    ) {
      terminalSurvivorClass = 'metadata_title_survivor'
    } else if (
      (latestOutcomeBlockingKeys.includes('pdfua.font_embedding')
        || latestOutcomeBlockingKeys.includes('pdfua.font_unicode'))
      && latestOutcomeUnresolvedCategories.some(label => /text extractability/i.test(label))
    ) {
      terminalSurvivorClass = 'font_text_extractability_survivor'
    } else if (
      latestOutcomeBlockingKeys.includes('pdfua.figure_alt_or_artifact')
      && latestOutcomeBlockingKeys.length === 1
    ) {
      terminalSurvivorClass = 'figure_spillover_survivor'
    } else if (
      latestOutcomeBlockingKeys.length === 0
      && latestOutcomeUnresolvedCategories.length === 1
      && /reading order/i.test(latestOutcomeUnresolvedCategories[0] || '')
    ) {
      terminalSurvivorClass = 'reading_order_only_survivor'
    }
  }

  let structureWaveBucket: StructureWaveBucket | null = null
  if (input.rowCohortLabel === 'structure_heavy' || hasLogicalStructureDebt || hasMetadataNavigationDebt || hasReadingOrderDebt) {
    if (isInspectionBudgetProcessingError(input.latestOutcome) || input.rowCurrentCorpusStatus === 'processing_error') {
      structureWaveBucket = 'structure_processing_error_retry'
    } else if (hasReadingOrderDebt && !hasMetadataNavigationDebt && !hasMixedFigureResiduals) {
      structureWaveBucket = 'structure_only_residuals'
    } else if (hasMetadataNavigationDebt && !hasMixedFigureResiduals) {
      structureWaveBucket = 'metadata_navigation_residuals'
    } else if ((hasLogicalStructureDebt || hasMetadataNavigationDebt) && hasMixedFigureResiduals) {
      structureWaveBucket = 'mixed_structure_figure_residuals'
    } else if (hasLogicalStructureDebt || hasMetadataNavigationDebt || hasReadingOrderDebt) {
      structureWaveBucket = 'structure_only_residuals'
    }
  }

  let originLane: CorpusControlPlaneRow['stage4StructureDiagnostics']['originLane'] = 'native_structure_heavy'
  if (input.reasonCodes.includes('stage3:reclassified_from_figure_heavy')) {
    originLane = 'reclassified_from_figure_heavy'
  } else if (input.reasonCodes.includes('stage2:reclassified_from_short_high_likelihood')) {
    originLane = 'reclassified_from_short_high_likelihood'
  }

  return {
    structureWaveBucket,
    terminalSurvivorClass,
    dominantStructurePhase: input.benchmarkOutcome?.final?.inspectionProfile?.dominantPhase || null,
    hasLogicalStructureDebt: hasLogicalStructureDebt || null,
    hasHeadingDebt: hasHeadingDebt || null,
    hasReadingOrderDebt: hasReadingOrderDebt || null,
    hasMetadataNavigationDebt: hasMetadataNavigationDebt || null,
    hasMixedFigureResiduals: hasMixedFigureResiduals || null,
    hasBoundedRuntimeWording: isInspectionBudgetProcessingError(input.latestOutcome),
    originLane,
  }
}

function maybePush(values: string[], value: string | null | undefined): void {
  if (value && !values.includes(value)) values.push(value)
}

export function classifyCohort(input: {
  pageCount: number | null
  isScanned: boolean | null
  manualOnlyFailureModeCount: number | null
  blockerFamilyIds: string[]
  blockingFindingKeys: string[]
  autoRunnableOpportunityCount: number | null
  expectedPresence: string | null
}): CohortLabel {
  if ((input.manualOnlyFailureModeCount || 0) > 0 || input.expectedPresence === 'missing' || input.isScanned) {
    return 'manual_tail'
  }

  const joinedFamilies = [...input.blockerFamilyIds, ...input.blockingFindingKeys].join(' ')
  if (FIGURE_FAMILY_PATTERN.test(joinedFamilies)) return 'figure_heavy'
  if (STRUCTURE_FAMILY_PATTERN.test(joinedFamilies)) return 'structure_heavy'
  if (FONT_FAMILY_PATTERN.test(joinedFamilies)) return 'font_heavy'
  if ((input.pageCount || 0) >= LONG_REPORT_PAGE_THRESHOLD) return 'long_report'
  if ((input.autoRunnableOpportunityCount || 0) >= 0) return 'short_high_likelihood'
  return 'short_high_likelihood'
}

function chooseVerificationResultForPublication(
  publicationRow: PublicationVerificationRow | ClassifiedPublicationVerificationRow | null,
  verificationResultByKey: Map<string, VerificationResult>,
): VerificationResult | null {
  if (!publicationRow) return null
  return verificationResultByKey.get(publicationRow.verificationKey) || null
}

function chooseCorpusStatus(input: {
  replacementRow: PublicationReplacementMapRow
  ledgerRow: PromotionLedgerRow | null
  classifiedRow: ClassifiedPublicationVerificationRow | null
  latestOutcome: { manifestPath: string; outcome: OutcomeRecordLike } | null
  bestCandidate: { manifestPath: string; candidate: CandidateRecordLike } | null
}): { status: CorpusStatus; reasonCodes: string[]; notes: string[] } {
  const reasonCodes: string[] = []
  const notes: string[] = []

  if (input.ledgerRow) {
    reasonCodes.push('verified_promotion_ledger')
    return {
      status: 'verified_pass',
      reasonCodes,
      notes,
    }
  }

  if (input.classifiedRow) {
    if (input.classifiedRow.classification === 'verified_pass') {
      if (input.classifiedRow.sourceKind === 'already_replaced_remote') {
        reasonCodes.push('verified_remote_replacement_without_ledger')
        return { status: 'replaced_remote', reasonCodes, notes }
      }
      reasonCodes.push('verified_verification_without_ledger')
      notes.push('Verification passed without a corresponding verified-promotion ledger row.')
      return { status: 'staged_for_replacement', reasonCodes, notes }
    }
    reasonCodes.push(input.classifiedRow.classification === 'soft_fail_advisory' ? 'verification_soft_fail' : 'verification_hard_fail')
    return { status: 'remediated_fail', reasonCodes, notes }
  }

  if (input.latestOutcome) {
    const derived = deriveStatusFromOutcomeStatus(input.latestOutcome.outcome.status)
    if (derived) {
      reasonCodes.push(`outcome:${input.latestOutcome.outcome.status}`)
      return { status: derived, reasonCodes, notes }
    }
  }

  if (input.bestCandidate) {
    reasonCodes.push('candidate_manifest_selected')
    return { status: 'queued_for_remediation', reasonCodes, notes }
  }

  if (input.replacementRow.expectedPresence === 'missing') {
    reasonCodes.push('expected_presence_missing')
    notes.push(input.replacementRow.notes || 'Publication record points to a missing source PDF.')
    return { status: 'discovered', reasonCodes, notes }
  }

  reasonCodes.push('replacement_map_default')
  return { status: 'analyzed', reasonCodes, notes }
}

function buildSummary(rows: CorpusControlPlaneRow[], ledgerRowCount: number): CorpusControlPlaneSummary {
  const byCurrentCorpusStatus = emptyStatusCounts()
  const byCohortLabel = emptyCohortCounts()
  const byStorageKind: Record<string, number> = {}
  const statusByCohort = Object.fromEntries(
    ALL_COHORTS.map(cohort => [cohort, emptyStatusCounts()]),
  ) as Record<CohortLabel, Record<CorpusStatus, number>>

  for (const row of rows) {
    byCurrentCorpusStatus[row.currentCorpusStatus] += 1
    byCohortLabel[row.cohortLabel] += 1
    byStorageKind[row.storageKind || 'unknown'] = (byStorageKind[row.storageKind || 'unknown'] || 0) + 1
    statusByCohort[row.cohortLabel][row.currentCorpusStatus] += 1
  }

  return {
    totalRows: rows.length,
    byCurrentCorpusStatus,
    byCohortLabel,
    byStorageKind,
    statusByCohort,
    verifiedPassRowsFromLedger: ledgerRowCount,
    remainingRowsExcludingVerifiedPass: rows.filter(row => row.currentCorpusStatus !== 'verified_pass').length,
  }
}

function buildByCohort(rows: CorpusControlPlaneRow[]): CorpusControlPlaneByCohortDocument {
  const cohorts = Object.fromEntries(
    ALL_COHORTS.map(cohort => {
      const cohortRows = rows.filter(row => row.cohortLabel === cohort)
      const byCurrentCorpusStatus = emptyStatusCounts()
      for (const row of cohortRows) byCurrentCorpusStatus[row.currentCorpusStatus] += 1
      return [cohort, {
        totalRows: cohortRows.length,
        byCurrentCorpusStatus,
        samplePublicationIds: cohortRows.slice(0, 10).map(row => row.publicationId),
      }]
    }),
  ) as CorpusControlPlaneByCohortDocument['cohorts']

  return {
    generatedAt: new Date().toISOString(),
    cohorts,
  }
}

function buildCanaries(rows: CorpusControlPlaneRow[], benchmarkOutcomes: BenchmarkOutcomeLike[], replacementMap: PublicationReplacementMapRow[]): CorpusControlPlaneCanariesDocument {
  const rowByPublicationId = new Map(rows.map(row => [row.publicationId, row]))
  const publicationIdByLocalPath = new Map<string, string>()

  for (const replacementRow of replacementMap) {
    const localPath = replacementRow.checksumState?.localCurrentFilePath
    if (localPath) publicationIdByLocalPath.set(localPath, replacementRow.publicationId)
  }

  const canaryRows: CorpusControlPlaneCanaryRow[] = benchmarkOutcomes.map(outcome => {
    const publicationId = publicationIdByLocalPath.get(outcome.filePath) || null
    const matchedRow = publicationId ? rowByPublicationId.get(publicationId) || null : null
    const cohortLabel = matchedRow?.cohortLabel || (
      outcome.category === 'structure'
        ? 'structure_heavy'
        : outcome.category === 'long_report'
          ? 'long_report'
          : 'figure_heavy'
    )

    return {
      publicationId,
      publicationTitle: matchedRow?.title || null,
      filePath: outcome.filePath,
      benchmarkName: outcome.name,
      benchmarkCategory: outcome.category || null,
      benchmarkTerminalState: outcome.terminalState || null,
      cohortLabel,
      currentCorpusStatus: matchedRow?.currentCorpusStatus || null,
    }
  })

  const byCohortLabel = emptyCohortCounts()
  for (const row of canaryRows) byCohortLabel[row.cohortLabel] += 1

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalCanaries: canaryRows.length,
      matchedPublicationIds: canaryRows.filter(row => !!row.publicationId).length,
      unmatchedCanaries: canaryRows.filter(row => !row.publicationId).length,
      byCohortLabel,
    },
    rows: canaryRows,
  }
}

export function validateCorpusControlPlaneArtifacts(artifacts: CorpusControlPlaneArtifacts, sources?: Pick<CorpusControlPlaneSources, 'replacementMap' | 'promotionLedgerRows'>): CorpusControlPlaneValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const rows = artifacts.document.rows

  const rowIds = rows.map(row => row.publicationId)
  if (new Set(rowIds).size !== rowIds.length) {
    errors.push('Canonical corpus manifest contains duplicate publicationId rows.')
  }

  for (const row of rows) {
    if (!row.currentCorpusStatus) errors.push(`Row ${row.publicationId} is missing currentCorpusStatus.`)
    if (!row.cohortLabel) errors.push(`Row ${row.publicationId} is missing cohortLabel.`)
  }

  if (sources) {
    const replacementIds = new Set(sources.replacementMap.map(row => row.publicationId))
    const missingFromCanonical = [...replacementIds].filter(publicationId => !rowIds.includes(publicationId))
    if (missingFromCanonical.length) {
      errors.push(`Canonical corpus manifest is missing ${missingFromCanonical.length} publicationId rows from publication-pdf-replacement-map.json.`)
    }

    const ledgerIds = new Set(sources.promotionLedgerRows.map(row => row.publicationId))
    for (const publicationId of ledgerIds) {
      const row = rows.find(candidate => candidate.publicationId === publicationId)
      if (!row) {
        errors.push(`Verified ledger publicationId ${publicationId} is missing from the canonical corpus manifest.`)
        continue
      }
      if (row.currentCorpusStatus !== 'verified_pass') {
        errors.push(`Verified ledger publicationId ${publicationId} does not map to currentCorpusStatus=verified_pass.`)
      }
    }
  }

  const rowsWithoutLedger = rows.filter(row => row.currentCorpusStatus === 'verified_pass' && !row.promotionTruth.ledgerRowPresent)
  if (rowsWithoutLedger.length) {
    errors.push(`Found ${rowsWithoutLedger.length} verified_pass rows without a backing verified-promotion ledger row.`)
  }

  const recomputedSummary = buildSummary(rows, artifacts.document.summary.verifiedPassRowsFromLedger)
  if (JSON.stringify(recomputedSummary) !== JSON.stringify(artifacts.document.summary)) {
    errors.push('Canonical summary does not match the rows used to build it.')
  }

  for (const cohort of ALL_COHORTS) {
    const cohortRows = rows.filter(row => row.cohortLabel === cohort)
    const summaryTotal = artifacts.byCohort.cohorts[cohort]?.totalRows || 0
    if (summaryTotal !== cohortRows.length) {
      errors.push(`By-cohort summary for ${cohort} does not match canonical row count.`)
    }
  }

  if (artifacts.canaries.summary.totalCanaries !== artifacts.canaries.rows.length) {
    errors.push('Canary summary total does not match canary row count.')
  }

  if (!artifacts.canaries.rows.length) {
    warnings.push('Canary manifest is empty.')
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  }
}

export function buildCorpusControlPlaneArtifactsFromSources(sources: CorpusControlPlaneSources): CorpusControlPlaneArtifacts {
  const verificationResultByKey = new Map(sources.verificationResults.map(result => [result.key, result]))
  const classifiedRowByPublicationId = new Map(sources.classifiedRows.map(row => [row.publicationId, row]))
  const ledgerRowByPublicationId = new Map(sources.promotionLedgerRows.map(row => [row.publicationId, row]))
  const benchmarkByPublicationId = benchmarkOutcomeByPublicationId(sources)

  const outcomesByPublicationId = new Map<string, Array<{ manifestPath: string; outcome: OutcomeRecordLike }>>()
  for (const manifest of sources.outcomeManifests) {
    for (const outcome of manifest.outcomes) {
      const publicationId = outcome.publicationId ? String(outcome.publicationId) : null
      if (!publicationId) continue
      const rows = outcomesByPublicationId.get(publicationId) || []
      rows.push({ manifestPath: manifest.path, outcome })
      outcomesByPublicationId.set(publicationId, rows)
    }
  }

  const candidatesByPublicationId = new Map<string, Array<{ manifestPath: string; candidate: CandidateRecordLike }>>()
  for (const manifest of sources.candidateManifests) {
    for (const candidate of manifest.candidates) {
      const publicationId = candidate.publicationId ? String(candidate.publicationId) : null
      if (!publicationId) continue
      const rows = candidatesByPublicationId.get(publicationId) || []
      rows.push({ manifestPath: manifest.path, candidate })
      candidatesByPublicationId.set(publicationId, rows)
    }
  }

  const rows: CorpusControlPlaneRow[] = sources.replacementMap.map(replacementRow => {
    const publicationId = String(replacementRow.publicationId)
    const ledgerRow = ledgerRowByPublicationId.get(publicationId) || null
    const classifiedRow = classifiedRowByPublicationId.get(publicationId) || null
    const latestOutcome = chooseLatestOutcome(outcomesByPublicationId.get(publicationId) || [])
    const bestCandidate = chooseBestCandidate(candidatesByPublicationId.get(publicationId) || [])
    const verificationResult = chooseVerificationResultForPublication(classifiedRow, verificationResultByKey)
    const benchmarkOutcome = benchmarkByPublicationId.get(publicationId) || null

    const derived = chooseCorpusStatus({
      replacementRow,
      ledgerRow,
      classifiedRow,
      latestOutcome,
      bestCandidate,
    })

    const blockingFindingKeys = uniqueStrings([
      ...(verificationResult?.gate.blockingLocalFindingKeys || []),
      ...(latestOutcome?.outcome.gate?.blockingLocalFindingKeys || []),
      ...(bestCandidate?.candidate.blockingFindingKeys || []),
    ])
    const residualFamilyIds = uniqueStrings([
      ...(bestCandidate?.candidate.topBlockingResidualFamilyIds || []),
    ])
    const autoRunnableOpportunityKeys = uniqueStrings([
      ...(bestCandidate?.candidate.autoRunnableOpportunityKeys || []),
    ])
    const manualOnlyFailureModeKeys = uniqueStrings([
      ...(bestCandidate?.candidate.manualOnlyFailureModeKeys || []),
    ])

    const classificationEvidence = {
      pageCount: ledgerRow?.verificationSummary.pageCount
        ?? verificationResult?.summary.pageCount
        ?? latestOutcome?.outcome.final?.pageCount
        ?? latestOutcome?.outcome.original?.pageCount
        ?? bestCandidate?.candidate.pageCount
        ?? null,
      isScanned: ledgerRow?.verificationSummary.isScanned
        ?? verificationResult?.summary.isScanned
        ?? latestOutcome?.outcome.final?.isScanned
        ?? latestOutcome?.outcome.original?.isScanned
        ?? bestCandidate?.candidate.isScanned
        ?? null,
      overallScore: ledgerRow?.verificationSummary.overallScore
        ?? verificationResult?.summary.overallScore
        ?? latestOutcome?.outcome.final?.overallScore
        ?? latestOutcome?.outcome.original?.overallScore
        ?? bestCandidate?.candidate.overallScore
        ?? null,
      grade: ledgerRow?.verificationSummary.grade
        ?? verificationResult?.summary.grade
        ?? latestOutcome?.outcome.final?.grade
        ?? latestOutcome?.outcome.original?.grade
        ?? bestCandidate?.candidate.grade
        ?? null,
      blockerFamilyCount: bestCandidate?.candidate.blockerFamilyCount ?? (residualFamilyIds.length || null),
      blockingFindingCount: bestCandidate?.candidate.blockingFindingCount ?? (blockingFindingKeys.length || null),
      manualOnlyFailureModeCount: bestCandidate?.candidate.manualOnlyFailureModeCount ?? (manualOnlyFailureModeKeys.length || null),
      autoRunnableOpportunityCount: bestCandidate?.candidate.autoRunnableOpportunityCount ?? (autoRunnableOpportunityKeys.length || null),
      topBlockingResidualFamilyIds: residualFamilyIds,
      blockingFindingKeys,
      autoRunnableOpportunityKeys,
      manualOnlyFailureModeKeys,
    }

    const stage2OperationalRetry = Boolean(
      latestOutcome?.outcome.status === 'processing_error'
      && (latestOutcome.outcome.gate?.reasons || []).some(reason => /mkdtemp/i.test(reason) && /\.tmp\/pdf-ocr/i.test(reason)),
    )
    const stage3FigureDiagnostics = deriveStage3FigureDiagnostics({
      rowCohortLabel: replacementRow.expectedPresence === 'missing' ? 'manual_tail' : classifyCohort({
        pageCount: classificationEvidence.pageCount,
        isScanned: classificationEvidence.isScanned,
        manualOnlyFailureModeCount: classificationEvidence.manualOnlyFailureModeCount,
        blockerFamilyIds: classificationEvidence.topBlockingResidualFamilyIds,
        blockingFindingKeys: classificationEvidence.blockingFindingKeys,
        autoRunnableOpportunityCount: classificationEvidence.autoRunnableOpportunityCount,
        expectedPresence: replacementRow.expectedPresence || null,
      }),
      rowCurrentCorpusStatus: derived.status,
      classificationEvidence,
      latestOutcome,
      benchmarkOutcome,
    })

    const baseCohortLabel = classifyCohort({
      pageCount: classificationEvidence.pageCount,
      isScanned: classificationEvidence.isScanned,
      manualOnlyFailureModeCount: classificationEvidence.manualOnlyFailureModeCount,
      blockerFamilyIds: classificationEvidence.topBlockingResidualFamilyIds,
      blockingFindingKeys: classificationEvidence.blockingFindingKeys,
      autoRunnableOpportunityCount: classificationEvidence.autoRunnableOpportunityCount,
      expectedPresence: replacementRow.expectedPresence || null,
    })
    const cohortLabel = stage2OperationalRetry ? 'short_high_likelihood' : baseCohortLabel

    const reasonCodes = [...derived.reasonCodes]
    if (stage2OperationalRetry) reasonCodes.push('stage2:operational_retry_after_tempdir_failure')
    if (cohortLabel === 'manual_tail') reasonCodes.push('cohort:manual_tail')
    if (cohortLabel === 'figure_heavy') reasonCodes.push('cohort:figure_heavy')
    if (cohortLabel === 'structure_heavy') reasonCodes.push('cohort:structure_heavy')
    if (cohortLabel === 'font_heavy') reasonCodes.push('cohort:font_heavy')
    if (cohortLabel === 'long_report') reasonCodes.push('cohort:long_report')
    if (cohortLabel === 'short_high_likelihood') reasonCodes.push('cohort:short_high_likelihood')
    const stage4StructureDiagnostics = deriveStage4StructureDiagnostics({
      rowCohortLabel: cohortLabel,
      rowCurrentCorpusStatus: derived.status,
      classificationEvidence,
      latestOutcome,
      benchmarkOutcome,
      reasonCodes,
    })

    return {
      publicationId,
      title: replacementRow.title || null,
      slug: replacementRow.slug || null,
      fileUrl: replacementRow.fileUrl || null,
      storageKind: replacementRow.storageKind || null,
      sourceKind: normalizeSourceKind(replacementRow.storageKind),
      serverHost: replacementRow.serverHost || null,
      remotePath: replacementRow.remotePath || null,
      remoteDir: replacementRow.remoteDir || null,
      replaceVia: replacementRow.replaceVia || null,
      currentCorpusStatus: derived.status,
      cohortLabel,
      sourceMetadata: {
        fileHost: replacementRow.fileHost || null,
        sshTarget: replacementRow.sshTarget || null,
        expectedPresence: replacementRow.expectedPresence || null,
        localWorkingPath: replacementRow.localWorkingPath || null,
        localBackupPath: replacementRow.localBackupPath || null,
        localServerMirrorPath: replacementRow.localServerMirrorPath || null,
        checksumRecordedAt: replacementRow.checksumState?.checksumRecordedAt || null,
        currentSourcePath: replacementRow.checksumState?.localCurrentFilePath || null,
        currentSourceMd5: replacementRow.checksumState?.localCurrentFileMd5 || null,
      },
      statusEvidence: {
        sourceManifestPath: sources.replacementMapPath,
        sourceStatus: replacementRow.expectedPresence === 'missing' ? 'replacement_map_missing' : 'replacement_map_present',
        verificationManifestPath: sources.verificationClassifiedPath || sources.verificationPath,
        verificationClassification: classifiedRow?.classification || null,
        verificationTimestamp: ledgerRow?.verificationTimestamp || verificationResult?.verifiedAt || null,
        verificationReportPath: ledgerRow?.verificationReportPath || verificationResult?.artifacts.reportPath || null,
        outcomeManifestPath: latestOutcome?.manifestPath || null,
        outcomeStatus: latestOutcome?.outcome.status || null,
        latestReportPath: latestOutcome?.outcome.artifacts?.detailedReportPath
          || latestOutcome?.outcome.artifacts?.failureReportPath
          || bestCandidate?.candidate.reportPath
          || ledgerRow?.verificationReportPath
          || verificationResult?.artifacts.reportPath
          || null,
        candidateManifestPath: bestCandidate?.manifestPath || null,
      },
      classificationEvidence,
      promotionTruth: {
        promotionStatus: ledgerRow?.promotionStatus || null,
        ledgerRowPresent: Boolean(ledgerRow),
        stagedReplacementPath: ledgerRow?.stagedReplacementPath
          || latestOutcome?.outcome.artifacts?.stagedReplacementPath
          || classifiedRow?.stagedReplacementPath
          || null,
        replacementChecksumSha256: ledgerRow?.replacementChecksumSha256 || null,
        verificationPassed: Boolean(ledgerRow || verificationResult?.passed),
      },
      stage3FigureDiagnostics,
      stage4StructureDiagnostics,
      reasonCodes: uniqueStrings(reasonCodes),
      notes: uniqueStrings([
        replacementRow.notes || null,
        ...derived.notes,
      ]),
    }
  }).sort((left, right) => left.publicationId.localeCompare(right.publicationId))

  const summary = buildSummary(rows, sources.promotionLedgerRows.length)
  const document: CorpusControlPlaneDocument = {
    generatedAt: new Date().toISOString(),
    summary,
    rows,
  }

  return {
    document,
    byCohort: buildByCohort(rows),
    canaries: buildCanaries(rows, sources.regressionBenchmarkOutcomes, sources.replacementMap),
  }
}

function readManifestArray<T>(filePath: string, fieldName: string): T[] {
  const doc = readJson<any>(filePath)
  if (Array.isArray(doc)) return doc as T[]
  return Array.isArray(doc?.[fieldName]) ? doc[fieldName] as T[] : []
}

export function loadCorpusControlPlaneSources(repoRoot = defaultRepoRoot): CorpusControlPlaneSources {
  const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')
  const replacementMapPath = path.join(manifestsRoot, 'publication-pdf-replacement-map.json')
  const verificationPath = path.join(manifestsRoot, 'ready-to-replace-verification.json')
  const verificationClassifiedPath = path.join(manifestsRoot, 'ready-to-replace-verification.classified.json')
  const promotionLedgerPath = path.join(manifestsRoot, 'verified-promotion-ledger.json')
  const regressionBenchmarkPath = path.join(manifestsRoot, 'remediation-regression-benchmark.summary.json')
  const stage4PendingAnalysisPath = path.join(manifestsRoot, 'stage4-structure-pending-analysis.json')
  const stage4ActiveAnalysisPath = path.join(manifestsRoot, 'stage4-structure-active-analysis.json')
  const stage4StalledAnalysisPath = path.join(manifestsRoot, 'stage4-structure-stalled-analysis.json')
  const stage4OverlapAnalysisPath = path.join(manifestsRoot, 'stage4-structure-overlap-analysis.json')

  const outcomeManifests = fs.readdirSync(manifestsRoot)
    .filter(name => name.endsWith('-outcomes.json') || name.endsWith('.outcomes.json'))
    .sort()
    .map(name => ({
      path: path.join(manifestsRoot, name),
      outcomes: readManifestArray<OutcomeRecordLike>(path.join(manifestsRoot, name), 'outcomes'),
    }))

  const candidateManifests = fs.readdirSync(manifestsRoot)
    .filter(name => name.endsWith('-candidates.json') || name.endsWith('.candidates.json'))
    .sort()
    .map(name => ({
      path: path.join(manifestsRoot, name),
      candidates: readManifestArray<CandidateRecordLike>(path.join(manifestsRoot, name), 'candidates'),
    }))

  return {
    repoRoot,
    manifestsRoot,
    replacementMapPath,
    verificationPath: fs.existsSync(verificationPath) ? verificationPath : null,
    verificationClassifiedPath: fs.existsSync(verificationClassifiedPath) ? verificationClassifiedPath : null,
    promotionLedgerPath: fs.existsSync(promotionLedgerPath) ? promotionLedgerPath : null,
    regressionBenchmarkPath: fs.existsSync(regressionBenchmarkPath) ? regressionBenchmarkPath : null,
    stage4PendingAnalysisPath: fs.existsSync(stage4PendingAnalysisPath) ? stage4PendingAnalysisPath : null,
    stage4ActiveAnalysisPath: fs.existsSync(stage4ActiveAnalysisPath) ? stage4ActiveAnalysisPath : null,
    stage4StalledAnalysisPath: fs.existsSync(stage4StalledAnalysisPath) ? stage4StalledAnalysisPath : null,
    stage4OverlapAnalysisPath: fs.existsSync(stage4OverlapAnalysisPath) ? stage4OverlapAnalysisPath : null,
    replacementMap: readManifestArray<PublicationReplacementMapRow>(replacementMapPath, 'rows'),
    verificationResults: fs.existsSync(verificationPath) ? readJson<any>(verificationPath).verificationResults || [] : [],
    verificationRows: fs.existsSync(verificationPath) ? readJson<any>(verificationPath).publicationRows || [] : [],
    classifiedRows: fs.existsSync(verificationClassifiedPath) ? readJson<any>(verificationClassifiedPath).publicationRows || [] : [],
    promotionLedgerRows: fs.existsSync(promotionLedgerPath) ? readJson<any>(promotionLedgerPath).rows || [] : [],
    outcomeManifests,
    candidateManifests,
    regressionBenchmarkOutcomes: fs.existsSync(regressionBenchmarkPath) ? readJson<any>(regressionBenchmarkPath).outcomes || [] : [],
    stage4PendingAnalysisRows: fs.existsSync(stage4PendingAnalysisPath) ? readJson<any>(stage4PendingAnalysisPath).rows || [] : [],
    stage4ActiveAnalysisRows: fs.existsSync(stage4ActiveAnalysisPath) ? readJson<any>(stage4ActiveAnalysisPath).rows || [] : [],
    stage4StalledAnalysisRows: fs.existsSync(stage4StalledAnalysisPath) ? readJson<any>(stage4StalledAnalysisPath).rows || [] : [],
    stage4OverlapAnalysisRows: fs.existsSync(stage4OverlapAnalysisPath) ? readJson<any>(stage4OverlapAnalysisPath).rows || [] : [],
  }
}
