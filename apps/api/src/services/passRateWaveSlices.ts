import type {
  CorpusControlPlaneArtifacts,
  CorpusControlPlaneRow,
  CorpusStatus,
} from './corpusControlPlane.ts'
import {
  classifyRuntimeTailRow,
  type RuntimeTailClassification,
  type RuntimeTailDominantFamily,
} from './runtimeTailClassifier.ts'
import { isManualMitigationStatus, type ManualWorklistStatus } from './manualWorklist.ts'

type PriorityTier = 'highest' | 'high' | 'medium'

type FamilyKind = 'figure' | 'font' | 'structure' | 'metadata'

interface SliceSelectionSanity {
  dominantFamilyCounts: Record<string, number>
  inScopeBlockerKeyCounts: Record<string, number>
  excludedBecauseSecondary: number
  excludedNearPassAnomalies: number
}

interface PassRateSliceCandidateBase {
  priorityRank: number
  passLikelihoodScore: number
  priorityTier: PriorityTier
  recommendedAction: 'fix_first'
  publicationId: string
  publicationTitle: string | null
  serverHost: string | null
  remotePath: string | null
  localCachePath: string | null
  fileUrl: string | null
  storageKind: string | null
  currentCorpusStatus: CorpusStatus
  cohortLabel: string
  overallScore: number | null
  grade: string | null
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
  reportPath: string
  selectionReasons: string[]
  dominantSelectionFamily: FamilyKind | 'mixed' | 'unknown'
}

export interface PassRateFigureCanaryCandidate extends PassRateSliceCandidateBase {}

export interface PassRateFigureCanaryDocument {
  generatedAt: string
  sliceName: 'pass-rate-figure-canary'
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  maxCandidates: number
  totals: {
    eligibleRows: number
    selectedRows: number
    skippedRows: number
  }
  selectedPublicationIds: string[]
  candidates: PassRateFigureCanaryCandidate[]
  selectionSanity: SliceSelectionSanity
}

export interface PassRateFontCanaryCandidate extends PassRateSliceCandidateBase {}

export interface PassRateFontCanaryDocument {
  generatedAt: string
  sliceName: 'pass-rate-font-canary'
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  maxCandidates: number
  totals: {
    eligibleRows: number
    selectedRows: number
    skippedRows: number
  }
  selectedPublicationIds: string[]
  candidates: PassRateFontCanaryCandidate[]
  selectionSanity: SliceSelectionSanity
}

export interface RuntimeRetryWaveCandidate extends RuntimeTailClassification {
  priorityRank: number
  passLikelihoodScore: number
  priorityTier: PriorityTier
  recommendedAction: 'fix_first'
  serverHost: string | null
  remotePath: string | null
  localCachePath: string | null
  fileUrl: string | null
  storageKind: string | null
  overallScore: number | null
  grade: string | null
  pageCount: number
  isScanned: boolean
  blockerFamilyCount: number
  blockingFindingCount: number
  manualOnlyFailureModeCount: number
  autoRunnableOpportunityCount: number
  autoRunnableOpportunityKeys: string[]
  manualOnlyFailureModeKeys: string[]
  heuristicReasons: string[]
  reportPath: string
}

export interface RuntimeRetryWaveDocument {
  generatedAt: string
  sliceName: 'runtime-tail-retry-wave'
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  totals: {
    selectedRows: number
  }
  selectedPublicationIds: string[]
  candidates: RuntimeRetryWaveCandidate[]
  groupedPublicationIds: Record<'figure' | 'structure' | 'font' | 'mixed' | 'unknown', string[]>
  groupedCounts: Record<'figure' | 'structure' | 'font' | 'mixed' | 'unknown', number>
}

export type RuntimeRetrySliceName =
  | 'runtime-tail-figure-retry'
  | 'runtime-tail-structure-retry'
  | 'runtime-tail-mixed-terminalization'

export type RuntimeRetrySliceIntent =
  | 'pass_rate_conversion'
  | 'truth_hardening_terminalization'

export type RuntimeRetrySliceExecutionPolicy =
  | 'active'
  | 'dormant'

export interface RuntimeRetryPriorOutcome {
  publicationId: string
  status: 'remediated_pass_candidate' | 'ready_to_replace' | 'failed_after_remediation' | 'source_missing' | 'processing_error'
  finalOverallScore?: number | null
  blockingLocalFindingKeys?: string[]
}

interface RuntimeSelectionSanity {
  dominantFamilyCounts: Record<string, number>
  inScopeBlockerKeyCounts: Record<string, number>
  excludedPriorProcessed: number
  excludedSecondary: number
  excludedLowConfidence: number
}

export interface RuntimeRetrySliceCandidate extends RuntimeRetryWaveCandidate {
  selectionReasons: string[]
  targetLane: 'figure' | 'structure' | 'mixed'
  runtimeWeightBucket?: 'light' | 'medium' | 'heavy'
  runtimeProfileKey?: string | null
}

export interface RuntimeRetrySliceDocument {
  generatedAt: string
  sliceName: RuntimeRetrySliceName
  sliceIntent: RuntimeRetrySliceIntent
  executionPolicy: RuntimeRetrySliceExecutionPolicy
  executionPolicyReason: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  totals: {
    eligibleRows: number
    selectedRows: number
    skippedRows: number
    excludedPriorProcessed: number
    excludedSecondary: number
    excludedLowConfidence: number
  }
  selectedPublicationIds: string[]
  candidates: RuntimeRetrySliceCandidate[]
  groupedPublicationIds: Record<'figure' | 'structure' | 'font' | 'mixed' | 'unknown', string[]>
  groupedCounts: Record<'figure' | 'structure' | 'font' | 'mixed' | 'unknown', number>
  selectionSanity: RuntimeSelectionSanity
  targetedFindingKeys: string[]
  targetedFamilyIds: string[]
}

export type ThroughputLaneName =
  | 'small-fast-pass'
  | 'medium-figure-conversion'
  | 'serial-heavy-mixed-terminalization'
  | 'manual-scanned-deferred'
  | 'all-remaining-automated'
  | 'replacement-likelihood'

export type ThroughputLaneIntent =
  | 'pass_rate_conversion'
  | 'truth_hardening_terminalization'
  | 'deferred_manual_review'

export type ThroughputLaneExecutionPolicy =
  | 'active'
  | 'dormant'
  | 'deferred'

interface ThroughputLaneSelectionSanity {
  dominantFamilyCounts: Record<string, number>
  runtimeWeightCounts: Record<string, number>
  excludedHeavyMixed: number
  excludedManualOrScanned: number
  excludedRuntimeTail: number
}

export interface ThroughputLaneCandidate extends PassRateSliceCandidateBase {
  laneIntent: ThroughputLaneIntent
  runtimeWeightBucket: 'light' | 'medium' | 'heavy'
  runtimeProfileKey: string | null
}

export interface ThroughputLaneDocument {
  generatedAt: string
  laneName: ThroughputLaneName
  laneIntent: ThroughputLaneIntent
  executionPolicy: ThroughputLaneExecutionPolicy
  executionPolicyReason: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  recommendedConcurrency: number
  initialAnalysisProfile: 'remediation_fast' | 'full_final'
  verificationPolicy: 'terminal_candidates_only'
  totals: {
    eligibleRows: number
    selectedRows: number
    skippedRows: number
  }
  selectedPublicationIds: string[]
  candidates: ThroughputLaneCandidate[]
  selectionSanity: ThroughputLaneSelectionSanity
}

export interface FigureFinalMileClosureCandidate extends PassRateSliceCandidateBase {
  runtimeWeightBucket: 'light' | 'medium' | 'heavy'
  runtimeProfileKey: string | null
  latestObservedStatus: string | null
  latestObservedProcessedAt: string | null
  observedBlockingFindingShrink: boolean
  candidateEngineSliceTag: 'figure_final_mile_closure'
}

export interface FigureFinalMileClosureDocument {
  generatedAt: string
  cohortName: 'figure-final-mile-closure'
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  totals: {
    eligibleRows: number
    selectedRows: number
    skippedRows: number
  }
  selectedPublicationIds: string[]
  candidates: FigureFinalMileClosureCandidate[]
}

export interface ManualMitigationOutcomeRef {
  status: ManualWorklistStatus
}

function safeNumber(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort()
}

function isRowManuallyMitigated(
  row: CorpusControlPlaneRow,
  manualOutcomeByPublicationId?: Map<string, ManualMitigationOutcomeRef>,
): boolean {
  const status = manualOutcomeByPublicationId?.get(row.publicationId)?.status || row.statusEvidence.outcomeStatus || null
  return isManualMitigationStatus(status)
}

function isNearPassAnomaly(row: CorpusControlPlaneRow): boolean {
  return row.currentCorpusStatus !== 'verified_pass'
    && safeNumber(row.classificationEvidence.overallScore, -1) === 100
    && String(row.classificationEvidence.grade || '').toUpperCase() === 'A'
}

function familyScore(row: CorpusControlPlaneRow, family: FamilyKind): number {
  const joined = [
    ...row.classificationEvidence.topBlockingResidualFamilyIds,
    ...row.classificationEvidence.blockingFindingKeys,
    ...row.reasonCodes,
  ].join(' ')

  if (family === 'figure') {
    return (
      (row.classificationEvidence.topBlockingResidualFamilyIds.includes('native_figure_convergence') ? 4 : 0)
      + (row.classificationEvidence.blockingFindingKeys.includes('pdfua.figure_alt_or_artifact') ? 3 : 0)
      + (row.classificationEvidence.blockingFindingKeys.includes('category.alt_text') ? 2 : 0)
      + (/figure|alt|artifact|image|ownership/i.test(joined) ? 1 : 0)
    )
  }
  if (family === 'font') {
    return (
      (row.classificationEvidence.topBlockingResidualFamilyIds.includes('font_embedding_and_unicode') ? 4 : 0)
      + (row.classificationEvidence.blockingFindingKeys.includes('pdfua.font_unicode') ? 3 : 0)
      + (row.classificationEvidence.blockingFindingKeys.includes('pdfua.cid_symbol_fonts') ? 3 : 0)
      + (row.classificationEvidence.blockingFindingKeys.includes('pdfua.font_embedding') ? 2 : 0)
      + (/font|unicode|charenc|cidset/i.test(joined) ? 1 : 0)
    )
  }
  if (family === 'structure') {
    return (
      (row.classificationEvidence.topBlockingResidualFamilyIds.includes('post_bootstrap_heading_convergence') ? 4 : 0)
      + (row.classificationEvidence.blockingFindingKeys.includes('pdfua.logical_structure') ? 3 : 0)
      + (row.classificationEvidence.blockingFindingKeys.includes('pdfua.heading_content_quality') ? 3 : 0)
      + (row.classificationEvidence.blockingFindingKeys.includes('pdfua.reading_order') ? 2 : 0)
      + (/logical_structure|heading|reading_order|marked_content|structure/i.test(joined) ? 1 : 0)
    )
  }
  return (
    (row.classificationEvidence.blockingFindingKeys.includes('pdfua.display_doc_title') ? 2 : 0)
    + (row.classificationEvidence.blockingFindingKeys.includes('pdfua.bookmark_language') ? 2 : 0)
    + (/bookmark|title|language|metadata/i.test(joined) ? 1 : 0)
  )
}

function dominantSelectionFamilyForRow(row: CorpusControlPlaneRow): FamilyKind | 'mixed' | 'unknown' {
  const scores = {
    figure: familyScore(row, 'figure'),
    font: familyScore(row, 'font'),
    structure: familyScore(row, 'structure'),
    metadata: familyScore(row, 'metadata'),
  }
  const entries = Object.entries(scores).sort((left, right) => right[1] - left[1])
  const [bestFamily, bestScore] = entries[0] || ['unknown', 0]
  const [, secondScore] = entries[1] || ['unknown', 0]
  if (bestScore <= 0) return 'unknown'
  if (secondScore === bestScore) return 'mixed'
  return bestFamily as FamilyKind
}

function hasFigureDebt(row: CorpusControlPlaneRow): boolean {
  return row.classificationEvidence.topBlockingResidualFamilyIds.includes('native_figure_convergence')
    || row.classificationEvidence.blockingFindingKeys.includes('pdfua.figure_alt_or_artifact')
    || row.classificationEvidence.blockingFindingKeys.includes('category.alt_text')
}

function hasFontDebt(row: CorpusControlPlaneRow): boolean {
  return row.classificationEvidence.topBlockingResidualFamilyIds.includes('font_embedding_and_unicode')
    || row.classificationEvidence.blockingFindingKeys.includes('pdfua.font_unicode')
    || row.classificationEvidence.blockingFindingKeys.includes('pdfua.cid_symbol_fonts')
    || row.classificationEvidence.blockingFindingKeys.includes('pdfua.font_embedding')
}

function hasStructureDebt(row: CorpusControlPlaneRow): boolean {
  return row.classificationEvidence.topBlockingResidualFamilyIds.includes('post_bootstrap_heading_convergence')
    || row.classificationEvidence.blockingFindingKeys.includes('pdfua.logical_structure')
    || row.classificationEvidence.blockingFindingKeys.includes('pdfua.heading_content_quality')
    || row.classificationEvidence.blockingFindingKeys.includes('pdfua.reading_order')
}

function computePassLikelihoodScore(row: CorpusControlPlaneRow, family: FamilyKind): number {
  const base = safeNumber(row.classificationEvidence.overallScore, 0)
  const statusBonus = row.currentCorpusStatus === 'remediated_fail'
    ? 12
    : row.currentCorpusStatus === 'processing_error'
      ? 8
      : 4
  const familyBonus = familyScore(row, family) * 4
  const blockerPenalty = safeNumber(row.classificationEvidence.blockerFamilyCount, 0) * 2
  return Math.max(0, Math.min(100, base + statusBonus + familyBonus - blockerPenalty))
}

function priorityTierForRow(row: CorpusControlPlaneRow, family: FamilyKind): PriorityTier {
  if (row.currentCorpusStatus === 'processing_error') return 'high'
  const score = computePassLikelihoodScore(row, family)
  if (score >= 88) return 'highest'
  if (score >= 70) return 'high'
  return 'medium'
}

function buildCandidateBase(
  row: CorpusControlPlaneRow,
  index: number,
  family: FamilyKind,
  selectionReasons: string[],
): PassRateSliceCandidateBase {
  return {
    priorityRank: index + 1,
    passLikelihoodScore: computePassLikelihoodScore(row, family),
    priorityTier: priorityTierForRow(row, family),
    recommendedAction: 'fix_first',
    publicationId: row.publicationId,
    publicationTitle: row.title,
    serverHost: row.serverHost,
    remotePath: row.remotePath,
    localCachePath: row.sourceMetadata.currentSourcePath,
    fileUrl: row.fileUrl,
    storageKind: row.storageKind,
    currentCorpusStatus: row.currentCorpusStatus,
    cohortLabel: row.cohortLabel,
    overallScore: row.classificationEvidence.overallScore,
    grade: row.classificationEvidence.grade,
    pageCount: safeNumber(row.classificationEvidence.pageCount, 0),
    isScanned: Boolean(row.classificationEvidence.isScanned),
    blockerFamilyCount: safeNumber(row.classificationEvidence.blockerFamilyCount, 0),
    blockingFindingCount: safeNumber(row.classificationEvidence.blockingFindingCount, 0),
    manualOnlyFailureModeCount: safeNumber(row.classificationEvidence.manualOnlyFailureModeCount, 0),
    autoRunnableOpportunityCount: safeNumber(row.classificationEvidence.autoRunnableOpportunityCount, 0),
    topBlockingResidualFamilyIds: row.classificationEvidence.topBlockingResidualFamilyIds,
    blockingFindingKeys: row.classificationEvidence.blockingFindingKeys,
    autoRunnableOpportunityKeys: row.classificationEvidence.autoRunnableOpportunityKeys,
    manualOnlyFailureModeKeys: row.classificationEvidence.manualOnlyFailureModeKeys,
    heuristicReasons: selectionReasons,
    reportPath: row.statusEvidence.latestReportPath || row.statusEvidence.verificationReportPath || '',
    selectionReasons,
    dominantSelectionFamily: dominantSelectionFamilyForRow(row),
  }
}

function compareFigureRows(left: CorpusControlPlaneRow, right: CorpusControlPlaneRow): number {
  const leftDominant = dominantSelectionFamilyForRow(left) === 'figure' ? 0 : 1
  const rightDominant = dominantSelectionFamilyForRow(right) === 'figure' ? 0 : 1
  if (leftDominant !== rightDominant) return leftDominant - rightDominant
  const bucketRank = {
    ownership_cleared_figure_debt_remains: 0,
    mass_unresolved_figure_debt: 1,
    figure_processing_error_retry: 2,
    mixed_figure_structure_debt: 3,
  } as const
  const leftBucket = left.stage3FigureDiagnostics.figureWaveBucket
  const rightBucket = right.stage3FigureDiagnostics.figureWaveBucket
  if (leftBucket && rightBucket && leftBucket !== rightBucket) return bucketRank[leftBucket] - bucketRank[rightBucket]
  const statusRank = (row: CorpusControlPlaneRow) => row.currentCorpusStatus === 'remediated_fail' ? 0 : row.currentCorpusStatus === 'processing_error' ? 1 : 2
  const statusDiff = statusRank(left) - statusRank(right)
  if (statusDiff !== 0) return statusDiff
  const scoreDiff = safeNumber(right.classificationEvidence.overallScore, -1) - safeNumber(left.classificationEvidence.overallScore, -1)
  if (scoreDiff !== 0) return scoreDiff
  const blockerDiff = safeNumber(left.classificationEvidence.blockerFamilyCount, 99) - safeNumber(right.classificationEvidence.blockerFamilyCount, 99)
  if (blockerDiff !== 0) return blockerDiff
  return left.publicationId.localeCompare(right.publicationId)
}

function compareFontRows(left: CorpusControlPlaneRow, right: CorpusControlPlaneRow): number {
  const leftDominant = dominantSelectionFamilyForRow(left) === 'font' ? 0 : 1
  const rightDominant = dominantSelectionFamilyForRow(right) === 'font' ? 0 : 1
  if (leftDominant !== rightDominant) return leftDominant - rightDominant
  const leftFontHeavy = left.cohortLabel === 'font_heavy' ? 0 : 1
  const rightFontHeavy = right.cohortLabel === 'font_heavy' ? 0 : 1
  if (leftFontHeavy !== rightFontHeavy) return leftFontHeavy - rightFontHeavy
  const leftProcessing = left.currentCorpusStatus === 'processing_error' ? 0 : 1
  const rightProcessing = right.currentCorpusStatus === 'processing_error' ? 0 : 1
  if (leftProcessing !== rightProcessing) return leftProcessing - rightProcessing
  const blockerDiff = safeNumber(left.classificationEvidence.blockingFindingCount, 99) - safeNumber(right.classificationEvidence.blockingFindingCount, 99)
  if (blockerDiff !== 0) return blockerDiff
  const scoreDiff = safeNumber(right.classificationEvidence.overallScore, -1) - safeNumber(left.classificationEvidence.overallScore, -1)
  if (scoreDiff !== 0) return scoreDiff
  return left.publicationId.localeCompare(right.publicationId)
}

function buildSelectionSanity(
  selectedRows: CorpusControlPlaneRow[],
  inScopeBlockerKeys: string[],
  excludedBecauseSecondary: number,
  excludedNearPassAnomalies: number,
): SliceSelectionSanity {
  const dominantFamilyCounts: Record<string, number> = {}
  const inScopeBlockerKeyCounts: Record<string, number> = {}
  for (const row of selectedRows) {
    const dominantFamily = dominantSelectionFamilyForRow(row)
    dominantFamilyCounts[dominantFamily] = (dominantFamilyCounts[dominantFamily] || 0) + 1
    for (const key of inScopeBlockerKeys) {
      if (row.classificationEvidence.blockingFindingKeys.includes(key)) {
        inScopeBlockerKeyCounts[key] = (inScopeBlockerKeyCounts[key] || 0) + 1
      }
    }
  }
  return {
    dominantFamilyCounts,
    inScopeBlockerKeyCounts,
    excludedBecauseSecondary,
    excludedNearPassAnomalies,
  }
}

function boundedRuntimeSignalCount(row: CorpusControlPlaneRow): number {
  return Number(Boolean(row.stage3FigureDiagnostics.hasGenericTimeoutWording))
    + Number(Boolean(row.stage4StructureDiagnostics.hasBoundedRuntimeWording))
    + Number(row.currentCorpusStatus === 'processing_error')
}

function passLikelihoodScoreForDominantFamily(row: CorpusControlPlaneRow): number {
  const dominantFamily = dominantSelectionFamilyForRow(row)
  if (dominantFamily === 'figure') return computePassLikelihoodScore(row, 'figure')
  if (dominantFamily === 'font') return computePassLikelihoodScore(row, 'font')
  if (dominantFamily === 'metadata') return computePassLikelihoodScore(row, 'metadata')
  return computePassLikelihoodScore(row, 'structure')
}

function hasKnownSlowSmallDocProfile(row: CorpusControlPlaneRow): boolean {
  const joined = [
    String(row.title || ''),
    String(row.remotePath || ''),
    String(row.statusEvidence.latestReportPath || ''),
  ].join(' ')
  return /focused deterrence|biennial report|civil rights policy|child exposure to violence/i.test(joined)
}

function isReplacementLikelihoodBlockingKey(key: string): boolean {
  return key === 'pdfua.figure_alt_or_artifact'
    || key === 'pdfua.nested_alt_text'
    || key === 'pdfua.heading_content_quality'
    || key === 'pdfua.display_doc_title'
    || key === 'pdfua.document_language'
    || key === 'pdfua.bookmark_language'
}

function isFigureFinalMileBlockingKey(key: string): boolean {
  return key === 'pdfua.figure_alt_or_artifact'
    || key === 'pdfua.nested_alt_text'
    || key === 'pdfua.figure_alt_quality'
    || key === 'category.alt_text'
    || key === 'context.long_report_figure_residue'
    || key === 'context.figure_candidates_blocked'
}

function compareThroughputRows(left: ThroughputLaneCandidate, right: ThroughputLaneCandidate): number {
  const scoreDiff = right.passLikelihoodScore - left.passLikelihoodScore
  if (scoreDiff !== 0) return scoreDiff
  const blockerDiff = left.blockerFamilyCount - right.blockerFamilyCount
  if (blockerDiff !== 0) return blockerDiff
  const pageDiff = left.pageCount - right.pageCount
  if (pageDiff !== 0) return pageDiff
  return left.publicationId.localeCompare(right.publicationId)
}

function buildThroughputCandidate(
  row: CorpusControlPlaneRow,
  index: number,
  laneIntent: ThroughputLaneIntent,
  selectionReasons: string[],
): ThroughputLaneCandidate {
  const dominantFamily = dominantSelectionFamilyForRow(row)
  const family = dominantFamily === 'figure'
    ? 'figure'
    : dominantFamily === 'font'
      ? 'font'
      : dominantFamily === 'metadata'
        ? 'metadata'
        : 'structure'
  return {
    ...buildCandidateBase(row, index, family, selectionReasons),
    passLikelihoodScore: passLikelihoodScoreForDominantFamily(row),
    laneIntent,
    runtimeWeightBucket: runtimeWeightBucketForRow(row),
    runtimeProfileKey: runtimeProfileKeyForRow(row),
  }
}

function buildThroughputSelectionSanity(input: {
  selectedRows: ThroughputLaneCandidate[]
  excludedHeavyMixed: number
  excludedManualOrScanned: number
  excludedRuntimeTail: number
}): ThroughputLaneSelectionSanity {
  const dominantFamilyCounts: Record<string, number> = {}
  const runtimeWeightCounts: Record<string, number> = {}
  for (const row of input.selectedRows) {
    dominantFamilyCounts[row.dominantSelectionFamily] = (dominantFamilyCounts[row.dominantSelectionFamily] || 0) + 1
    runtimeWeightCounts[row.runtimeWeightBucket] = (runtimeWeightCounts[row.runtimeWeightBucket] || 0) + 1
  }
  return {
    dominantFamilyCounts,
    runtimeWeightCounts,
    excludedHeavyMixed: input.excludedHeavyMixed,
    excludedManualOrScanned: input.excludedManualOrScanned,
    excludedRuntimeTail: input.excludedRuntimeTail,
  }
}

export function buildPassRateFigureCanary(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  maxCandidates: number
  manualOutcomeByPublicationId?: Map<string, ManualMitigationOutcomeRef>
}): PassRateFigureCanaryDocument {
  const maxCandidates = Math.max(1, input.maxCandidates)
  let excludedBecauseSecondary = 0
  let excludedNearPassAnomalies = 0

  const eligibleRows = input.artifacts.document.rows.filter(row => {
    if (row.currentCorpusStatus === 'verified_pass') return false
    if (isRowManuallyMitigated(row, input.manualOutcomeByPublicationId)) return false
    if (!hasFigureDebt(row)) return false
    if (!row.sourceMetadata.currentSourcePath || !row.remotePath) return false
    const dominantFamily = dominantSelectionFamilyForRow(row)
    const anomaly = isNearPassAnomaly(row)
    const inScopeDominant = dominantFamily === 'figure'
    const allowFigureHeavyMixed = dominantFamily === 'mixed'
      && row.cohortLabel === 'figure_heavy'
      && familyScore(row, 'figure') >= familyScore(row, 'font')
      && familyScore(row, 'figure') >= familyScore(row, 'structure')
    if (anomaly && !inScopeDominant) {
      excludedNearPassAnomalies += 1
      return false
    }
    if (!inScopeDominant && !allowFigureHeavyMixed) {
      excludedBecauseSecondary += 1
      return false
    }
    return true
  })

  const selectedRows = eligibleRows.sort(compareFigureRows).slice(0, maxCandidates)
  const candidates = selectedRows.map((row, index) => buildCandidateBase(row, index, 'figure', uniqueStrings([
    row.stage3FigureDiagnostics.figureWaveBucket ? `figure_bucket:${row.stage3FigureDiagnostics.figureWaveBucket}` : null,
    row.classificationEvidence.topBlockingResidualFamilyIds.includes('native_figure_convergence') ? 'native_figure_convergence' : null,
    row.classificationEvidence.blockingFindingKeys.includes('pdfua.figure_alt_or_artifact') ? 'pdfua.figure_alt_or_artifact' : null,
    row.classificationEvidence.blockingFindingKeys.includes('category.alt_text') ? 'category.alt_text' : null,
    row.currentCorpusStatus === 'processing_error' ? 'bounded_runtime_followup' : 'pass_rate_candidate',
  ])))

  return {
    generatedAt: new Date().toISOString(),
    sliceName: 'pass-rate-figure-canary',
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    maxCandidates: input.maxCandidates,
    totals: {
      eligibleRows: eligibleRows.length,
      selectedRows: candidates.length,
      skippedRows: Math.max(0, eligibleRows.length - candidates.length + excludedBecauseSecondary + excludedNearPassAnomalies),
    },
    selectedPublicationIds: candidates.map(candidate => candidate.publicationId),
    candidates,
    selectionSanity: buildSelectionSanity(
      selectedRows,
      ['pdfua.figure_alt_or_artifact', 'category.alt_text'],
      excludedBecauseSecondary,
      excludedNearPassAnomalies,
    ),
  }
}

export function buildPassRateFontCanary(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  maxCandidates: number
  manualOutcomeByPublicationId?: Map<string, ManualMitigationOutcomeRef>
}): PassRateFontCanaryDocument {
  const maxCandidates = Math.max(1, input.maxCandidates)
  let excludedBecauseSecondary = 0
  let excludedNearPassAnomalies = 0

  const eligibleRows = input.artifacts.document.rows.filter(row => {
    if (row.currentCorpusStatus === 'verified_pass') return false
    if (isRowManuallyMitigated(row, input.manualOutcomeByPublicationId)) return false
    if (!hasFontDebt(row)) return false
    if (!row.sourceMetadata.currentSourcePath || !row.remotePath) return false
    const dominantFamily = dominantSelectionFamilyForRow(row)
    const anomaly = isNearPassAnomaly(row)
    const inScopeDominant = dominantFamily === 'font'
    if (anomaly && !inScopeDominant) {
      excludedNearPassAnomalies += 1
      return false
    }
    if (dominantFamily === 'figure') {
      excludedBecauseSecondary += 1
      return false
    }
    if (!inScopeDominant && row.cohortLabel !== 'font_heavy') {
      excludedBecauseSecondary += 1
      return false
    }
    return true
  })

  const selectedRows = eligibleRows.sort(compareFontRows).slice(0, maxCandidates)
  const candidates = selectedRows.map((row, index) => buildCandidateBase(row, index, 'font', uniqueStrings([
    row.classificationEvidence.topBlockingResidualFamilyIds.includes('font_embedding_and_unicode') ? 'font_embedding_and_unicode' : null,
    row.classificationEvidence.blockingFindingKeys.includes('pdfua.font_unicode') ? 'pdfua.font_unicode' : null,
    row.classificationEvidence.blockingFindingKeys.includes('pdfua.cid_symbol_fonts') ? 'pdfua.cid_symbol_fonts' : null,
    row.classificationEvidence.blockingFindingKeys.includes('pdfua.font_embedding') ? 'pdfua.font_embedding' : null,
    row.currentCorpusStatus === 'processing_error' ? 'runtime_tail_font_followup' : 'font_pass_rate_candidate',
  ])))

  return {
    generatedAt: new Date().toISOString(),
    sliceName: 'pass-rate-font-canary',
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    maxCandidates: input.maxCandidates,
    totals: {
      eligibleRows: eligibleRows.length,
      selectedRows: candidates.length,
      skippedRows: Math.max(0, eligibleRows.length - candidates.length + excludedBecauseSecondary + excludedNearPassAnomalies),
    },
    selectedPublicationIds: candidates.map(candidate => candidate.publicationId),
    candidates,
    selectionSanity: buildSelectionSanity(
      selectedRows,
      ['pdfua.font_unicode', 'pdfua.cid_symbol_fonts', 'pdfua.font_embedding'],
      excludedBecauseSecondary,
      excludedNearPassAnomalies,
    ),
  }
}

function buildThroughputLaneDocument(input: {
  laneName: ThroughputLaneName
  laneIntent: ThroughputLaneIntent
  executionPolicy: ThroughputLaneExecutionPolicy
  executionPolicyReason: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  recommendedConcurrency: number
  initialAnalysisProfile: 'remediation_fast' | 'full_final'
  candidates: ThroughputLaneCandidate[]
  selectionSanity: ThroughputLaneSelectionSanity
}): ThroughputLaneDocument {
  return {
    generatedAt: new Date().toISOString(),
    laneName: input.laneName,
    laneIntent: input.laneIntent,
    executionPolicy: input.executionPolicy,
    executionPolicyReason: input.executionPolicyReason,
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    recommendedConcurrency: input.recommendedConcurrency,
    initialAnalysisProfile: input.initialAnalysisProfile,
    verificationPolicy: 'terminal_candidates_only',
    totals: {
      eligibleRows: input.candidates.length,
      selectedRows: input.candidates.length,
      skippedRows: input.selectionSanity.excludedHeavyMixed + input.selectionSanity.excludedManualOrScanned + input.selectionSanity.excludedRuntimeTail,
    },
    selectedPublicationIds: input.candidates.map(candidate => candidate.publicationId),
    candidates: input.candidates,
    selectionSanity: input.selectionSanity,
  }
}

export function buildSmallFastPassLane(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  maxCandidates?: number
  manualOutcomeByPublicationId?: Map<string, ManualMitigationOutcomeRef>
}): ThroughputLaneDocument {
  const maxCandidates = Math.max(1, input.maxCandidates || 48)
  let excludedHeavyMixed = 0
  let excludedManualOrScanned = 0
  let excludedRuntimeTail = 0

  const selected = input.artifacts.document.rows
    .filter(row => {
      if (row.currentCorpusStatus === 'verified_pass') return false
      if (isRowManuallyMitigated(row, input.manualOutcomeByPublicationId)) return false
      if (!row.sourceMetadata.currentSourcePath || !row.remotePath) return false
      if (safeNumber(row.classificationEvidence.pageCount, 0) > 20) return false
      if (dominantSelectionFamilyForRow(row) === 'mixed') {
        excludedHeavyMixed += 1
        return false
      }
      if (hasKnownSlowSmallDocProfile(row)) {
        excludedHeavyMixed += 1
        return false
      }
      if (runtimeWeightBucketForRow(row) === 'heavy' || hasKnownLargeRuntimeProfile(row)) {
        excludedHeavyMixed += 1
        return false
      }
      if (hasFontDebt(row)) {
        excludedHeavyMixed += 1
        return false
      }
      if (safeNumber(row.classificationEvidence.blockerFamilyCount, 0) > 2 || safeNumber(row.classificationEvidence.blockingFindingCount, 0) > 3) {
        excludedHeavyMixed += 1
        return false
      }
      const dominantFamily = dominantSelectionFamilyForRow(row)
      const quickConversionShape = hasFigureDebt(row)
        || dominantFamily === 'metadata'
        || (
          !hasStructureDebt(row)
          && safeNumber(row.classificationEvidence.overallScore, 0) >= 85
          && safeNumber(row.classificationEvidence.blockerFamilyCount, 0) <= 1
        )
      if (!quickConversionShape) {
        excludedHeavyMixed += 1
        return false
      }
      if (boundedRuntimeSignalCount(row) > 0) {
        excludedRuntimeTail += 1
        return false
      }
      const stronglyDeterministicScanned = Boolean(row.classificationEvidence.isScanned)
        && safeNumber(row.classificationEvidence.overallScore, 0) >= 85
        && safeNumber(row.classificationEvidence.autoRunnableOpportunityCount, 0) >= 2
        && safeNumber(row.classificationEvidence.blockerFamilyCount, 0) <= 2
      if ((row.classificationEvidence.isScanned || row.cohortLabel === 'manual_tail' || safeNumber(row.classificationEvidence.manualOnlyFailureModeCount, 0) > 0) && !stronglyDeterministicScanned) {
        excludedManualOrScanned += 1
        return false
      }
      return true
    })
    .map((row, index) => buildThroughputCandidate(row, index, 'pass_rate_conversion', uniqueStrings([
      'cheap_first_lane',
      safeNumber(row.classificationEvidence.pageCount, 0) <= 25 ? 'page_count_le_25' : null,
      hasFigureDebt(row) ? 'native_figure_or_alt_opportunity' : null,
      hasStructureDebt(row) ? 'metadata_or_structure_cleanup' : null,
      safeNumber(row.classificationEvidence.autoRunnableOpportunityCount, 0) > 0 ? 'deterministic_surface_available' : null,
    ])))
    .sort(compareThroughputRows)
    .slice(0, maxCandidates)
    .map((candidate, index) => ({ ...candidate, priorityRank: index + 1 }))

  return buildThroughputLaneDocument({
    laneName: 'small-fast-pass',
    laneIntent: 'pass_rate_conversion',
    executionPolicy: 'dormant',
    executionPolicyReason: 'broad_conversion_experiment_retired_zero_replacements',
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    recommendedConcurrency: 10,
    initialAnalysisProfile: 'remediation_fast',
    candidates: selected,
    selectionSanity: buildThroughputSelectionSanity({
      selectedRows: selected,
      excludedHeavyMixed,
      excludedManualOrScanned,
      excludedRuntimeTail,
    }),
  })
}

export function buildMediumFigureConversionLane(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  maxCandidates?: number
  manualOutcomeByPublicationId?: Map<string, ManualMitigationOutcomeRef>
}): ThroughputLaneDocument {
  const maxCandidates = Math.max(1, input.maxCandidates || 32)
  let excludedHeavyMixed = 0
  let excludedManualOrScanned = 0
  let excludedRuntimeTail = 0

  const selected = input.artifacts.document.rows
    .filter(row => {
      if (row.currentCorpusStatus === 'verified_pass') return false
      if (isRowManuallyMitigated(row, input.manualOutcomeByPublicationId)) return false
      if (!row.sourceMetadata.currentSourcePath || !row.remotePath) return false
      if (!hasFigureDebt(row)) return false
      const pageCount = safeNumber(row.classificationEvidence.pageCount, 0)
      if (pageCount <= 0 || pageCount > 80) return false
      if (row.classificationEvidence.isScanned || row.cohortLabel === 'manual_tail') {
        excludedManualOrScanned += 1
        return false
      }
      if (runtimeWeightBucketForRow(row) === 'heavy' || hasKnownLargeRuntimeProfile(row)) {
        excludedHeavyMixed += 1
        return false
      }
      const dominantFamily = dominantSelectionFamilyForRow(row)
      const figurePrimary = dominantFamily === 'figure'
        || (row.cohortLabel === 'figure_heavy' && familyScore(row, 'figure') >= familyScore(row, 'structure'))
      if (!figurePrimary) {
        excludedHeavyMixed += 1
        return false
      }
      if (boundedRuntimeSignalCount(row) >= 2 && row.currentCorpusStatus === 'processing_error') {
        excludedRuntimeTail += 1
        return false
      }
      return true
    })
    .map((row, index) => buildThroughputCandidate(row, index, 'pass_rate_conversion', uniqueStrings([
      'medium_cost_figure_lane',
      row.cohortLabel === 'figure_heavy' ? 'figure_heavy' : null,
      row.classificationEvidence.blockingFindingKeys.includes('pdfua.figure_alt_or_artifact') ? 'pdfua.figure_alt_or_artifact' : null,
      row.classificationEvidence.blockingFindingKeys.includes('category.alt_text') ? 'category.alt_text' : null,
      row.classificationEvidence.topBlockingResidualFamilyIds.includes('native_figure_convergence') ? 'native_figure_convergence' : null,
    ])))
    .sort(compareThroughputRows)
    .slice(0, maxCandidates)
    .map((candidate, index) => ({ ...candidate, priorityRank: index + 1 }))

  return buildThroughputLaneDocument({
    laneName: 'medium-figure-conversion',
    laneIntent: 'pass_rate_conversion',
    executionPolicy: 'dormant',
    executionPolicyReason: 'broad_conversion_experiment_retired_zero_replacements',
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    recommendedConcurrency: 5,
    initialAnalysisProfile: 'remediation_fast',
    candidates: selected,
    selectionSanity: buildThroughputSelectionSanity({
      selectedRows: selected,
      excludedHeavyMixed,
      excludedManualOrScanned,
      excludedRuntimeTail,
    }),
  })
}

export function buildSerialHeavyMixedTerminalizationLane(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manualOutcomeByPublicationId?: Map<string, ManualMitigationOutcomeRef>
}): ThroughputLaneDocument {
  let excludedHeavyMixed = 0
  let excludedManualOrScanned = 0
  let excludedRuntimeTail = 0

  const selected = input.artifacts.document.rows
    .filter(row => {
      if (row.currentCorpusStatus === 'verified_pass') return false
      if (isRowManuallyMitigated(row, input.manualOutcomeByPublicationId)) return false
      if (!row.sourceMetadata.currentSourcePath || !row.remotePath) return false
      const mixedDominant = dominantSelectionFamilyForRow(row) === 'mixed'
        || (hasFigureDebt(row) && hasStructureDebt(row))
      if (!mixedDominant) {
        excludedHeavyMixed += 1
        return false
      }
      const heavyRuntime = runtimeWeightBucketForRow(row) === 'heavy'
        || hasKnownLargeRuntimeProfile(row)
        || boundedRuntimeSignalCount(row) >= 2
      if (!heavyRuntime) {
        excludedRuntimeTail += 1
        return false
      }
      if (row.classificationEvidence.isScanned && row.cohortLabel === 'manual_tail') {
        excludedManualOrScanned += 1
      }
      return true
    })
    .map((row, index) => buildThroughputCandidate(row, index, 'truth_hardening_terminalization', uniqueStrings([
      'serial_heavy_mixed_lane',
      row.classificationEvidence.blockingFindingKeys.includes('pdfua.figure_alt_or_artifact') ? 'pdfua.figure_alt_or_artifact' : null,
      row.classificationEvidence.blockingFindingKeys.includes('pdfua.logical_structure') ? 'pdfua.logical_structure' : null,
      runtimeWeightBucketForRow(row) === 'heavy' ? 'heavy_runtime_weight' : null,
      hasKnownLargeRuntimeProfile(row) ? 'known_large_runtime_profile' : null,
      boundedRuntimeSignalCount(row) >= 2 ? 'repeated_bounded_runtime_history' : null,
    ])))
    .sort((left, right) =>
      (left.runtimeWeightBucket === 'heavy' ? 0 : left.runtimeWeightBucket === 'medium' ? 1 : 2)
      - (right.runtimeWeightBucket === 'heavy' ? 0 : right.runtimeWeightBucket === 'medium' ? 1 : 2)
      || left.pageCount - right.pageCount
      || right.passLikelihoodScore - left.passLikelihoodScore
      || left.publicationId.localeCompare(right.publicationId))
    .map((candidate, index) => ({ ...candidate, priorityRank: index + 1 }))

  return buildThroughputLaneDocument({
    laneName: 'serial-heavy-mixed-terminalization',
    laneIntent: 'truth_hardening_terminalization',
    executionPolicy: 'active',
    executionPolicyReason: 'heavy_mixed_cost_control_lane',
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    recommendedConcurrency: 1,
    initialAnalysisProfile: 'remediation_fast',
    candidates: selected,
    selectionSanity: buildThroughputSelectionSanity({
      selectedRows: selected,
      excludedHeavyMixed,
      excludedManualOrScanned,
      excludedRuntimeTail,
    }),
  })
}

export function buildManualScannedDeferredLane(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manualOutcomeByPublicationId?: Map<string, ManualMitigationOutcomeRef>
}): ThroughputLaneDocument {
  let excludedHeavyMixed = 0
  let excludedManualOrScanned = 0
  let excludedRuntimeTail = 0

  const selected = input.artifacts.document.rows
    .filter(row => {
      if (row.currentCorpusStatus === 'verified_pass') return false
      if (isRowManuallyMitigated(row, input.manualOutcomeByPublicationId)) return false
      if (!row.sourceMetadata.currentSourcePath || !row.remotePath) return false
      const deferred = row.classificationEvidence.isScanned
        || row.cohortLabel === 'manual_tail'
        || safeNumber(row.classificationEvidence.manualOnlyFailureModeCount, 0) > 0
      if (!deferred) {
        excludedManualOrScanned += 1
        return false
      }
      const unusuallyStrongDeterministicSurface = safeNumber(row.classificationEvidence.overallScore, 0) >= 90
        && safeNumber(row.classificationEvidence.autoRunnableOpportunityCount, 0) >= 2
        && boundedRuntimeSignalCount(row) === 0
      if (unusuallyStrongDeterministicSurface) {
        excludedRuntimeTail += 1
        return false
      }
      return true
    })
    .map((row, index) => buildThroughputCandidate(row, index, 'deferred_manual_review', uniqueStrings([
      'manual_scanned_deferred_lane',
      row.classificationEvidence.isScanned ? 'scanned_input' : null,
      row.cohortLabel === 'manual_tail' ? 'manual_tail' : null,
      safeNumber(row.classificationEvidence.manualOnlyFailureModeCount, 0) > 0 ? 'manual_only_failure_modes' : null,
    ])))
    .sort((left, right) =>
      left.pageCount - right.pageCount
      || right.manualOnlyFailureModeCount - left.manualOnlyFailureModeCount
      || left.publicationId.localeCompare(right.publicationId))
    .map((candidate, index) => ({ ...candidate, priorityRank: index + 1 }))

  return buildThroughputLaneDocument({
    laneName: 'manual-scanned-deferred',
    laneIntent: 'deferred_manual_review',
    executionPolicy: 'deferred',
    executionPolicyReason: 'manual_or_ocr_specific_handling_required',
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    recommendedConcurrency: 1,
    initialAnalysisProfile: 'remediation_fast',
    candidates: selected,
    selectionSanity: buildThroughputSelectionSanity({
      selectedRows: selected,
      excludedHeavyMixed,
      excludedManualOrScanned,
      excludedRuntimeTail,
    }),
  })
}

export function buildReplacementLikelihoodLane(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  maxCandidates?: number
  manualOutcomeByPublicationId?: Map<string, ManualMitigationOutcomeRef>
}): ThroughputLaneDocument {
  const maxCandidates = Math.max(1, input.maxCandidates || 24)
  let excludedHeavyMixed = 0
  let excludedManualOrScanned = 0
  let excludedRuntimeTail = 0

  const selected = input.artifacts.document.rows
    .filter(row => {
      if (row.currentCorpusStatus === 'verified_pass') return false
      if (isRowManuallyMitigated(row, input.manualOutcomeByPublicationId)) return false
      if (!row.sourceMetadata.currentSourcePath || !row.remotePath) return false
      if (Boolean(row.classificationEvidence.isScanned) || row.cohortLabel === 'manual_tail' || safeNumber(row.classificationEvidence.manualOnlyFailureModeCount, 0) > 0) {
        excludedManualOrScanned += 1
        return false
      }
      if (hasKnownLargeRuntimeProfile(row) || hasKnownSlowSmallDocProfile(row) || runtimeWeightBucketForRow(row) !== 'light') {
        excludedHeavyMixed += 1
        return false
      }
      const pageCount = safeNumber(row.classificationEvidence.pageCount, 0)
      if (pageCount <= 0 || pageCount > 16) {
        excludedHeavyMixed += 1
        return false
      }
      const score = safeNumber(row.classificationEvidence.overallScore, 0)
      const grade = String(row.classificationEvidence.grade || '').toUpperCase()
      if (score < 97 && grade !== 'A' && grade !== 'B') {
        excludedHeavyMixed += 1
        return false
      }
      const blockingKeys = row.classificationEvidence.blockingFindingKeys || []
      if (!blockingKeys.length || blockingKeys.length > 3) {
        excludedHeavyMixed += 1
        return false
      }
      if (blockingKeys.some(key => !isReplacementLikelihoodBlockingKey(key))) {
        excludedHeavyMixed += 1
        return false
      }
      if (
        hasFontDebt(row)
        || row.classificationEvidence.blockingFindingKeys.includes('pdfua.logical_structure')
        || row.classificationEvidence.blockingFindingKeys.includes('pdfua.table_regularity')
        || row.classificationEvidence.blockingFindingKeys.includes('pdfua.annotation_alt_contents')
        || row.classificationEvidence.blockingFindingKeys.includes('pdfua.link_tagging')
        || row.classificationEvidence.blockingFindingKeys.includes('pdfua.note_tag_id')
        || row.classificationEvidence.blockingFindingKeys.includes('context.table_candidates_blocked')
        || row.classificationEvidence.blockingFindingKeys.includes('context.long_report_figure_residue')
      ) {
        excludedHeavyMixed += 1
        return false
      }
      if (safeNumber(row.classificationEvidence.blockerFamilyCount, 0) > 1) {
        excludedHeavyMixed += 1
        return false
      }
      if (safeNumber(row.classificationEvidence.autoRunnableOpportunityCount, 0) <= 0) {
        excludedRuntimeTail += 1
        return false
      }
      return true
    })
    .map((row, index) => buildThroughputCandidate(row, index, 'pass_rate_conversion', uniqueStrings([
      'replacement_likelihood_lane',
      `score_${safeNumber(row.classificationEvidence.overallScore, 0)}`,
      String(row.classificationEvidence.grade || '').toUpperCase() || null,
      row.classificationEvidence.blockingFindingKeys.includes('pdfua.figure_alt_or_artifact') ? 'pdfua.figure_alt_or_artifact' : null,
      row.classificationEvidence.blockingFindingKeys.includes('pdfua.nested_alt_text') ? 'pdfua.nested_alt_text' : null,
      row.classificationEvidence.blockingFindingKeys.includes('pdfua.heading_content_quality') ? 'pdfua.heading_content_quality' : null,
    ])))
    .sort(compareThroughputRows)
    .slice(0, maxCandidates)
    .map((candidate, index) => ({ ...candidate, priorityRank: index + 1 }))

  return buildThroughputLaneDocument({
    laneName: 'replacement-likelihood',
    laneIntent: 'pass_rate_conversion',
    executionPolicy: 'dormant',
    executionPolicyReason: 'replacement_likelihood_empty_until_engine_change',
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    recommendedConcurrency: 3,
    initialAnalysisProfile: 'remediation_fast',
    candidates: selected,
    selectionSanity: buildThroughputSelectionSanity({
      selectedRows: selected,
      excludedHeavyMixed,
      excludedManualOrScanned,
      excludedRuntimeTail,
    }),
  })
}

export function buildAllRemainingAutomatedLane(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manualOutcomeByPublicationId?: Map<string, ManualMitigationOutcomeRef>
}): ThroughputLaneDocument {
  let excludedHeavyMixed = 0
  let excludedManualOrScanned = 0
  let excludedRuntimeTail = 0

  const activeStatuses = new Set([
    'discovered',
    'analyzed',
    'queued_for_remediation',
    'remediated_fail',
    'processing_error',
  ])

  const runtimeRank = {
    light: 0,
    medium: 1,
    heavy: 2,
  } as const

  const selected = input.artifacts.document.rows
    .filter(row => {
      if (!activeStatuses.has(row.currentCorpusStatus)) {
        excludedHeavyMixed += 1
        return false
      }
      if (isRowManuallyMitigated(row, input.manualOutcomeByPublicationId)) {
        excludedManualOrScanned += 1
        return false
      }
      if (!row.sourceMetadata.currentSourcePath || !row.remotePath) {
        excludedRuntimeTail += 1
        return false
      }
      if (Boolean(row.classificationEvidence.isScanned) || safeNumber(row.classificationEvidence.manualOnlyFailureModeCount, 0) > 0 || row.currentCorpusStatus === 'deferred_manual') {
        excludedManualOrScanned += 1
        return false
      }
      return true
    })
    .map((row, index) => buildThroughputCandidate(row, index, 'pass_rate_conversion', uniqueStrings([
      'all_remaining_automated_lane',
      `status:${row.currentCorpusStatus}`,
      `runtime_weight:${runtimeWeightBucketForRow(row)}`,
      row.currentCorpusStatus === 'processing_error' ? 'retry_after_processing_error' : null,
    ])))
    .sort((left, right) =>
      runtimeRank[left.runtimeWeightBucket] - runtimeRank[right.runtimeWeightBucket]
      || right.passLikelihoodScore - left.passLikelihoodScore
      || left.pageCount - right.pageCount
      || left.publicationId.localeCompare(right.publicationId))
    .map((candidate, index) => ({ ...candidate, priorityRank: index + 1 }))

  return buildThroughputLaneDocument({
    laneName: 'all-remaining-automated',
    laneIntent: 'pass_rate_conversion',
    executionPolicy: 'active',
    executionPolicyReason: 'active_automatable_backlog_snapshot',
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    recommendedConcurrency: 4,
    initialAnalysisProfile: 'full_final',
    candidates: selected,
    selectionSanity: buildThroughputSelectionSanity({
      selectedRows: selected,
      excludedHeavyMixed,
      excludedManualOrScanned,
      excludedRuntimeTail,
    }),
  })
}

export function buildFigureFinalMileClosureCohort(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  latestOutcomeByPublicationId?: Map<string, {
    status: string
    processedAt: string | null
    blockingFindingShrink: boolean
  }>
  maxCandidates?: number
  manualOutcomeByPublicationId?: Map<string, ManualMitigationOutcomeRef>
}): FigureFinalMileClosureDocument {
  const maxCandidates = Math.max(1, input.maxCandidates || 32)
  const eligibleRows = input.artifacts.document.rows.filter(row => {
    if (row.currentCorpusStatus === 'verified_pass') return false
    if (isRowManuallyMitigated(row, input.manualOutcomeByPublicationId)) return false
    if (!row.sourceMetadata.currentSourcePath || !row.remotePath) return false
    if (row.classificationEvidence.isScanned || row.cohortLabel === 'manual_tail') return false
    if (!hasFigureDebt(row) || hasFontDebt(row)) return false
    const blockingKeys = row.classificationEvidence.blockingFindingKeys || []
    if (!blockingKeys.length || blockingKeys.some(key => !isFigureFinalMileBlockingKey(key))) return false
    if (hasStructureDebt(row) && familyScore(row, 'figure') <= familyScore(row, 'structure')) return false
    if (safeNumber(row.classificationEvidence.blockerFamilyCount, 0) > 2) return false
    return true
  })

  const candidates = eligibleRows
    .map((row, index) => {
      const prior = input.latestOutcomeByPublicationId?.get(row.publicationId)
      return {
        ...buildCandidateBase(row, index, 'figure', uniqueStrings([
          'figure_final_mile_closure',
          row.classificationEvidence.blockingFindingKeys.includes('pdfua.figure_alt_or_artifact') ? 'pdfua.figure_alt_or_artifact' : null,
          row.classificationEvidence.blockingFindingKeys.includes('pdfua.nested_alt_text') ? 'pdfua.nested_alt_text' : null,
          row.classificationEvidence.blockingFindingKeys.includes('category.alt_text') ? 'category.alt_text' : null,
          prior?.blockingFindingShrink ? 'observed_blocker_shrink' : null,
        ])),
        runtimeWeightBucket: runtimeWeightBucketForRow(row),
        runtimeProfileKey: runtimeProfileKeyForRow(row),
        latestObservedStatus: prior?.status || null,
        latestObservedProcessedAt: prior?.processedAt || null,
        observedBlockingFindingShrink: Boolean(prior?.blockingFindingShrink),
        candidateEngineSliceTag: 'figure_final_mile_closure' as const,
      }
    })
    .sort((left, right) =>
      Number(right.observedBlockingFindingShrink) - Number(left.observedBlockingFindingShrink)
      || right.passLikelihoodScore - left.passLikelihoodScore
      || left.blockerFamilyCount - right.blockerFamilyCount
      || left.pageCount - right.pageCount
      || left.publicationId.localeCompare(right.publicationId))
    .slice(0, maxCandidates)
    .map((candidate, index) => ({ ...candidate, priorityRank: index + 1 }))

  return {
    generatedAt: new Date().toISOString(),
    cohortName: 'figure-final-mile-closure',
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    totals: {
      eligibleRows: eligibleRows.length,
      selectedRows: candidates.length,
      skippedRows: Math.max(0, eligibleRows.length - candidates.length),
    },
    selectedPublicationIds: candidates.map(candidate => candidate.publicationId),
    candidates,
  }
}

function priorityTierForRuntime(candidate: RuntimeTailClassification): PriorityTier {
  if (candidate.dominantFamily === 'figure' || candidate.dominantFamily === 'font') return 'highest'
  if (candidate.dominantFamily === 'structure') return 'high'
  return 'medium'
}

function normalizePriorOutcomeMap(
  priorOutcomes?: Record<string, RuntimeRetryPriorOutcome> | Map<string, RuntimeRetryPriorOutcome>,
): Map<string, RuntimeRetryPriorOutcome> {
  if (!priorOutcomes) return new Map()
  if (priorOutcomes instanceof Map) return priorOutcomes
  return new Map(Object.entries(priorOutcomes))
}

function rowHasResidualStopReason(row: CorpusControlPlaneRow, reason: string): boolean {
  return row.reasonCodes.includes(reason) || row.notes.includes(reason)
}

function runtimeSliceExecutionPolicy(input: {
  lane: 'figure' | 'structure' | 'mixed'
}): {
  executionPolicy: RuntimeRetrySliceExecutionPolicy
  executionPolicyReason: string
} {
  if (input.lane === 'mixed') {
    return {
      executionPolicy: 'active',
      executionPolicyReason: 'truth_hardening_active_lane',
    }
  }

  return {
    executionPolicy: 'dormant',
    executionPolicyReason: 'runtime_conversion_dormant_until_engine_change',
  }
}

function hasKnownLargeRuntimeProfile(row: CorpusControlPlaneRow): boolean {
  const title = String(row.title || '')
  const remotePath = String(row.remotePath || '')
  return /annual report|caps/i.test(title) || /AnnualReport|CAPS/i.test(remotePath)
}

function runtimeProfileKeyForRow(row: CorpusControlPlaneRow): string | null {
  const title = String(row.title || '').trim()
  const remotePath = String(row.remotePath || '').trim()
  const basename = remotePath.split('/').filter(Boolean).pop() || title
  const normalized = basename
    .replace(/\.pdf$/i, '')
    .replace(/\d+/g, '#')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  return normalized || null
}

function runtimeWeightBucketForRow(row: CorpusControlPlaneRow): 'light' | 'medium' | 'heavy' {
  const pageCount = safeNumber(row.classificationEvidence.pageCount, 0)
  const boundedRuntimeSignals = Number(Boolean(row.stage3FigureDiagnostics.hasGenericTimeoutWording))
    + Number(Boolean(row.stage4StructureDiagnostics.hasBoundedRuntimeWording))
    + Number(row.currentCorpusStatus === 'processing_error')
  if (hasKnownLargeRuntimeProfile(row) && pageCount >= 100) return 'heavy'
  if (pageCount >= 160) return 'heavy'
  if (pageCount >= 120 && boundedRuntimeSignals >= 2) return 'heavy'
  if (pageCount >= 80) return 'medium'
  if (boundedRuntimeSignals >= 2) return 'medium'
  return 'light'
}

function runtimeWinnerLikelihoodScore(row: CorpusControlPlaneRow, lane: 'figure' | 'structure'): number {
  const figureScore = familyScore(row, 'figure')
  const structureScore = familyScore(row, 'structure')
  const baseScore = safeNumber(row.classificationEvidence.overallScore, 0)
  const pageCount = safeNumber(row.classificationEvidence.pageCount, 0)

  let score = baseScore >= 30 ? 8 : baseScore >= 20 ? 5 : 2
  if (pageCount > 0 && pageCount <= 80) score += 4
  else if (pageCount <= 140) score += 2
  else if (pageCount > 220) score -= 4

  if (lane === 'figure') {
    if (row.cohortLabel === 'figure_heavy') score += 8
    if (row.stage3FigureDiagnostics.hasGenericTimeoutWording) score += 4
    if (figureScore > structureScore) score += 7
    else if (figureScore === structureScore) score += 3
    if (row.classificationEvidence.blockingFindingKeys.includes('pdfua.figure_alt_or_artifact')) score += 4
    if (row.classificationEvidence.blockingFindingKeys.includes('category.alt_text')) score += 2
    if (row.classificationEvidence.blockingFindingKeys.includes('pdfua.logical_structure')) score -= 5
  } else {
    if (row.cohortLabel === 'structure_heavy') score += 8
    if (row.stage4StructureDiagnostics.hasBoundedRuntimeWording) score += 4
    if (structureScore > figureScore) score += 7
    else if (structureScore === figureScore) score += 3
    if (row.classificationEvidence.blockingFindingKeys.includes('pdfua.logical_structure')) score += 4
    if (row.classificationEvidence.blockingFindingKeys.includes('pdfua.heading_content_quality')) score += 2
    if (row.classificationEvidence.blockingFindingKeys.includes('pdfua.figure_alt_or_artifact')) score -= 4
  }

  if (safeNumber(row.classificationEvidence.autoRunnableOpportunityCount, 0) > 0) score += 2
  if (safeNumber(row.classificationEvidence.blockerFamilyCount, 0) >= 4) score -= 3
  if (hasKnownLargeRuntimeProfile(row)) score -= 4
  return score
}

function buildRuntimeSelectionSanity(
  selectedRows: RuntimeRetrySliceCandidate[],
  targetedFindingKeys: string[],
  excludedPriorProcessed: number,
  excludedSecondary: number,
  excludedLowConfidence: number,
): RuntimeSelectionSanity {
  const dominantFamilyCounts: Record<string, number> = {}
  const inScopeBlockerKeyCounts: Record<string, number> = {}
  for (const row of selectedRows) {
    dominantFamilyCounts[row.dominantFamily] = (dominantFamilyCounts[row.dominantFamily] || 0) + 1
    for (const key of targetedFindingKeys) {
      if (row.blockingFindingKeys.includes(key)) {
        inScopeBlockerKeyCounts[key] = (inScopeBlockerKeyCounts[key] || 0) + 1
      }
    }
  }
  return {
    dominantFamilyCounts,
    inScopeBlockerKeyCounts,
    excludedPriorProcessed,
    excludedSecondary,
    excludedLowConfidence,
  }
}

function buildRuntimeCandidate(
  row: CorpusControlPlaneRow,
  classified: RuntimeTailClassification,
  lane: 'figure' | 'structure' | 'mixed',
  index: number,
  selectionReasons: string[],
): RuntimeRetrySliceCandidate {
  return {
    ...classified,
    priorityRank: index + 1,
    passLikelihoodScore: lane === 'mixed'
      ? computePassLikelihoodScore(row, dominantSelectionFamilyForRow(row) === 'font' ? 'font' : dominantSelectionFamilyForRow(row) === 'figure' ? 'figure' : 'structure')
      : Math.max(0, Math.min(100, runtimeWinnerLikelihoodScore(row, lane) + 35)),
    priorityTier: lane === 'mixed'
      ? 'medium'
      : priorityTierForRuntime(classified),
    recommendedAction: 'fix_first',
    serverHost: row.serverHost,
    remotePath: row.remotePath,
    localCachePath: row.sourceMetadata.currentSourcePath,
    fileUrl: row.fileUrl,
    storageKind: row.storageKind,
    overallScore: row.classificationEvidence.overallScore,
    grade: row.classificationEvidence.grade,
    pageCount: safeNumber(row.classificationEvidence.pageCount, 0),
    isScanned: Boolean(row.classificationEvidence.isScanned),
    blockerFamilyCount: safeNumber(row.classificationEvidence.blockerFamilyCount, 0),
    blockingFindingCount: safeNumber(row.classificationEvidence.blockingFindingCount, 0),
    manualOnlyFailureModeCount: safeNumber(row.classificationEvidence.manualOnlyFailureModeCount, 0),
    autoRunnableOpportunityCount: safeNumber(row.classificationEvidence.autoRunnableOpportunityCount, 0),
    autoRunnableOpportunityKeys: row.classificationEvidence.autoRunnableOpportunityKeys,
    manualOnlyFailureModeKeys: row.classificationEvidence.manualOnlyFailureModeKeys,
    heuristicReasons: selectionReasons,
    reportPath: row.statusEvidence.latestReportPath || row.statusEvidence.verificationReportPath || '',
    selectionReasons,
    targetLane: lane,
    runtimeWeightBucket: runtimeWeightBucketForRow(row),
    runtimeProfileKey: runtimeProfileKeyForRow(row),
  }
}

function groupRuntimeCandidates(candidates: RuntimeRetrySliceCandidate[]) {
  const groupedPublicationIds = {
    figure: [] as string[],
    structure: [] as string[],
    font: [] as string[],
    mixed: [] as string[],
    unknown: [] as string[],
  }
  for (const candidate of candidates) {
    if (candidate.dominantFamily === 'manual') continue
    groupedPublicationIds[candidate.dominantFamily].push(candidate.publicationId)
  }
  return {
    groupedPublicationIds,
    groupedCounts: {
      figure: groupedPublicationIds.figure.length,
      structure: groupedPublicationIds.structure.length,
      font: groupedPublicationIds.font.length,
      mixed: groupedPublicationIds.mixed.length,
      unknown: groupedPublicationIds.unknown.length,
    },
  }
}

function compareRuntimeLaneRows(
  left: RuntimeRetrySliceCandidate,
  right: RuntimeRetrySliceCandidate,
): number {
  const tierRank = { highest: 0, high: 1, medium: 2 } as const
  const tierDiff = tierRank[left.priorityTier] - tierRank[right.priorityTier]
  if (tierDiff !== 0) return tierDiff
  const scoreDiff = right.passLikelihoodScore - left.passLikelihoodScore
  if (scoreDiff !== 0) return scoreDiff
  const pageDiff = left.pageCount - right.pageCount
  if (pageDiff !== 0) return pageDiff
  return left.publicationId.localeCompare(right.publicationId)
}

function priorOutcomeShouldExclude(priorOutcome: RuntimeRetryPriorOutcome | undefined): boolean {
  if (!priorOutcome) return false
  return priorOutcome.status === 'failed_after_remediation'
    || priorOutcome.status === 'processing_error'
    || priorOutcome.status === 'ready_to_replace'
    || priorOutcome.status === 'remediated_pass_candidate'
}

function buildRuntimeRetrySlice(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  sliceName: RuntimeRetrySliceName
  sliceIntent: RuntimeRetrySliceIntent
  lane: 'figure' | 'structure' | 'mixed'
  targetedFindingKeys: string[]
  targetedFamilyIds: string[]
  priorOutcomes?: Record<string, RuntimeRetryPriorOutcome> | Map<string, RuntimeRetryPriorOutcome>
  manualOutcomeByPublicationId?: Map<string, ManualMitigationOutcomeRef>
}): RuntimeRetrySliceDocument {
  const executionPolicy = runtimeSliceExecutionPolicy({ lane: input.lane })
  const priorOutcomeMap = normalizePriorOutcomeMap(input.priorOutcomes)
  let excludedPriorProcessed = 0
  let excludedSecondary = 0
  let excludedLowConfidence = 0

  const candidates = input.artifacts.document.rows
    .flatMap(row => {
      const classified = classifyRuntimeTailRow(row)
      if (classified.disposition !== 'retryable_deterministic') return []
      if (isRowManuallyMitigated(row, input.manualOutcomeByPublicationId)) return []
      if (!row.sourceMetadata.currentSourcePath || !row.remotePath) return []

      const priorOutcome = priorOutcomeMap.get(row.publicationId)
      if (priorOutcomeShouldExclude(priorOutcome)) {
        excludedPriorProcessed += 1
        return []
      }

      const figureDebt = hasFigureDebt(row)
      const structureDebt = hasStructureDebt(row)
      const figureScore = familyScore(row, 'figure')
      const structureScore = familyScore(row, 'structure')
      const dominantSelectionFamily = dominantSelectionFamilyForRow(row)
      const lowConfidenceFigure =
        input.lane === 'figure'
        && runtimeWinnerLikelihoodScore(row, 'figure') < 12
      const lowConfidenceStructure =
        input.lane === 'structure'
        && runtimeWinnerLikelihoodScore(row, 'structure') < 11

      if (input.lane === 'figure') {
        if (rowHasResidualStopReason(row, 'figure_debt_cleared_structure_debt_remaining')) {
          excludedSecondary += 1
          return []
        }
        const figurePrimary = figureDebt
          && (dominantSelectionFamily === 'figure'
            || (row.cohortLabel === 'figure_heavy' && figureScore >= structureScore))
        const blockedMixedPattern = row.classificationEvidence.blockingFindingKeys.includes('pdfua.figure_alt_or_artifact')
          && row.classificationEvidence.blockingFindingKeys.includes('pdfua.logical_structure')
          && row.cohortLabel !== 'figure_heavy'
        if (!figurePrimary || blockedMixedPattern) {
          excludedSecondary += 1
          return []
        }
        if (lowConfidenceFigure) {
          excludedLowConfidence += 1
          return []
        }
        return [
          buildRuntimeCandidate(row, classified, 'figure', 0, uniqueStrings([
            'runtime_conversion_lane',
            row.cohortLabel === 'figure_heavy' ? 'figure_heavy' : null,
            row.stage3FigureDiagnostics.hasGenericTimeoutWording ? 'bounded_runtime_figure_retry' : null,
            row.classificationEvidence.blockingFindingKeys.includes('pdfua.figure_alt_or_artifact') ? 'pdfua.figure_alt_or_artifact' : null,
            row.classificationEvidence.blockingFindingKeys.includes('category.alt_text') ? 'category.alt_text' : null,
            hasKnownLargeRuntimeProfile(row) ? 'large_runtime_profile_penalty' : null,
          ])),
        ]
      }

      if (input.lane === 'structure') {
        if (
          rowHasResidualStopReason(row, 'structure_debt_cleared_figure_debt_remaining')
          || rowHasResidualStopReason(row, 'mixed_figure_structure_separation_required')
        ) {
          excludedSecondary += 1
          return []
        }
        const structurePrimary = structureDebt
          && !figureDebt
          && (classified.dominantFamily === 'structure'
            || dominantSelectionFamily === 'structure'
            || row.cohortLabel === 'structure_heavy')
        if (!structurePrimary) {
          excludedSecondary += 1
          return []
        }
        if (lowConfidenceStructure) {
          excludedLowConfidence += 1
          return []
        }
        return [
          buildRuntimeCandidate(row, classified, 'structure', 0, uniqueStrings([
            'runtime_conversion_lane',
            row.cohortLabel === 'structure_heavy' ? 'structure_heavy' : null,
            row.stage4StructureDiagnostics.hasBoundedRuntimeWording ? 'bounded_runtime_structure_retry' : null,
            row.classificationEvidence.blockingFindingKeys.includes('pdfua.logical_structure') ? 'pdfua.logical_structure' : null,
            row.classificationEvidence.blockingFindingKeys.includes('pdfua.heading_content_quality') ? 'pdfua.heading_content_quality' : null,
          ])),
        ]
      }

      const mixedEligible = classified.dominantFamily === 'mixed'
        || dominantSelectionFamily === 'mixed'
        || (figureDebt && structureDebt)
        || row.cohortLabel === 'manual_tail'
      if (!mixedEligible) {
        excludedSecondary += 1
        return []
      }
      return [
        buildRuntimeCandidate(row, classified, 'mixed', 0, uniqueStrings([
          'truth_hardening_lane',
          row.classificationEvidence.blockingFindingKeys.includes('pdfua.figure_alt_or_artifact') ? 'pdfua.figure_alt_or_artifact' : null,
          row.classificationEvidence.blockingFindingKeys.includes('pdfua.logical_structure') ? 'pdfua.logical_structure' : null,
          row.stage3FigureDiagnostics.hasGenericTimeoutWording ? 'bounded_runtime_figure_retry' : null,
          row.stage4StructureDiagnostics.hasBoundedRuntimeWording ? 'bounded_runtime_structure_retry' : null,
        ])),
      ]
    })
    .sort(compareRuntimeLaneRows)
    .map((candidate, index) => ({ ...candidate, priorityRank: index + 1 }))

  const grouped = groupRuntimeCandidates(candidates)
  return {
    generatedAt: new Date().toISOString(),
    sliceName: input.sliceName,
    sliceIntent: input.sliceIntent,
    executionPolicy: executionPolicy.executionPolicy,
    executionPolicyReason: executionPolicy.executionPolicyReason,
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    totals: {
      eligibleRows: candidates.length,
      selectedRows: candidates.length,
      skippedRows: excludedPriorProcessed + excludedSecondary + excludedLowConfidence,
      excludedPriorProcessed,
      excludedSecondary,
      excludedLowConfidence,
    },
    selectedPublicationIds: candidates.map(candidate => candidate.publicationId),
    candidates,
    groupedPublicationIds: grouped.groupedPublicationIds,
    groupedCounts: grouped.groupedCounts,
    selectionSanity: buildRuntimeSelectionSanity(
      candidates,
      input.targetedFindingKeys,
      excludedPriorProcessed,
      excludedSecondary,
      excludedLowConfidence,
    ),
    targetedFindingKeys: input.targetedFindingKeys,
    targetedFamilyIds: input.targetedFamilyIds,
  }
}

export function buildRuntimeFigureRetrySlice(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  priorOutcomes?: Record<string, RuntimeRetryPriorOutcome> | Map<string, RuntimeRetryPriorOutcome>
  manualOutcomeByPublicationId?: Map<string, ManualMitigationOutcomeRef>
}): RuntimeRetrySliceDocument {
  return buildRuntimeRetrySlice({
    ...input,
    sliceName: 'runtime-tail-figure-retry',
    sliceIntent: 'pass_rate_conversion',
    lane: 'figure',
    targetedFindingKeys: ['pdfua.figure_alt_or_artifact', 'category.alt_text'],
    targetedFamilyIds: ['native_figure_convergence'],
  })
}

export function buildRuntimeStructureRetrySlice(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  priorOutcomes?: Record<string, RuntimeRetryPriorOutcome> | Map<string, RuntimeRetryPriorOutcome>
  manualOutcomeByPublicationId?: Map<string, ManualMitigationOutcomeRef>
}): RuntimeRetrySliceDocument {
  return buildRuntimeRetrySlice({
    ...input,
    sliceName: 'runtime-tail-structure-retry',
    sliceIntent: 'pass_rate_conversion',
    lane: 'structure',
    targetedFindingKeys: ['pdfua.logical_structure', 'pdfua.heading_content_quality'],
    targetedFamilyIds: ['post_bootstrap_heading_convergence'],
  })
}

export function buildRuntimeMixedTerminalizationSlice(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  priorOutcomes?: Record<string, RuntimeRetryPriorOutcome> | Map<string, RuntimeRetryPriorOutcome>
  manualOutcomeByPublicationId?: Map<string, ManualMitigationOutcomeRef>
}): RuntimeRetrySliceDocument {
  return buildRuntimeRetrySlice({
    ...input,
    sliceName: 'runtime-tail-mixed-terminalization',
    sliceIntent: 'truth_hardening_terminalization',
    lane: 'mixed',
    targetedFindingKeys: ['pdfua.figure_alt_or_artifact', 'pdfua.logical_structure'],
    targetedFamilyIds: ['native_figure_convergence', 'post_bootstrap_heading_convergence'],
  })
}

export function buildRuntimeRetryWave(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manualOutcomeByPublicationId?: Map<string, ManualMitigationOutcomeRef>
}): RuntimeRetryWaveDocument {
  const rowById = new Map(input.artifacts.document.rows.map(row => [row.publicationId, row]))
  const candidates = input.artifacts.document.rows
    .map(row => {
      if (isRowManuallyMitigated(row, input.manualOutcomeByPublicationId)) return null
      const classified = classifyRuntimeTailRow(row)
      if (classified.disposition !== 'retryable_deterministic') return null
      return {
        ...classified,
        priorityRank: 0,
        passLikelihoodScore: computePassLikelihoodScore(row, dominantSelectionFamilyForRow(row) === 'font' ? 'font' : dominantSelectionFamilyForRow(row) === 'figure' ? 'figure' : 'structure'),
        priorityTier: priorityTierForRuntime(classified),
        recommendedAction: 'fix_first' as const,
        serverHost: row.serverHost,
        remotePath: row.remotePath,
        localCachePath: row.sourceMetadata.currentSourcePath,
        fileUrl: row.fileUrl,
        storageKind: row.storageKind,
        overallScore: row.classificationEvidence.overallScore,
        grade: row.classificationEvidence.grade,
        pageCount: safeNumber(row.classificationEvidence.pageCount, 0),
        isScanned: Boolean(row.classificationEvidence.isScanned),
        blockerFamilyCount: safeNumber(row.classificationEvidence.blockerFamilyCount, 0),
        blockingFindingCount: safeNumber(row.classificationEvidence.blockingFindingCount, 0),
        manualOnlyFailureModeCount: safeNumber(row.classificationEvidence.manualOnlyFailureModeCount, 0),
        autoRunnableOpportunityCount: safeNumber(row.classificationEvidence.autoRunnableOpportunityCount, 0),
        autoRunnableOpportunityKeys: row.classificationEvidence.autoRunnableOpportunityKeys,
        manualOnlyFailureModeKeys: row.classificationEvidence.manualOnlyFailureModeKeys,
        heuristicReasons: classified.notes,
        reportPath: row.statusEvidence.latestReportPath || row.statusEvidence.verificationReportPath || '',
      }
    })
    .filter((row): row is RuntimeRetryWaveCandidate => !!row)
    .sort((left, right) =>
      left.dominantFamily.localeCompare(right.dominantFamily)
      || safeNumber(right.overallScore, -1) - safeNumber(left.overallScore, -1)
      || left.publicationId.localeCompare(right.publicationId))
    .map((row, index) => ({ ...row, priorityRank: index + 1 }))

  const groupedPublicationIds = {
    figure: [] as string[],
    structure: [] as string[],
    font: [] as string[],
    mixed: [] as string[],
    unknown: [] as string[],
  }
  for (const candidate of candidates) {
    if (candidate.dominantFamily === 'manual') continue
    groupedPublicationIds[candidate.dominantFamily].push(candidate.publicationId)
  }

  return {
    generatedAt: new Date().toISOString(),
    sliceName: 'runtime-tail-retry-wave',
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    totals: {
      selectedRows: candidates.length,
    },
    selectedPublicationIds: candidates.map(candidate => candidate.publicationId),
    candidates: candidates.map(candidate => ({
      ...candidate,
      topBlockingResidualFamilyIds: rowById.get(candidate.publicationId)?.classificationEvidence.topBlockingResidualFamilyIds || candidate.topBlockingResidualFamilyIds,
    })),
    groupedPublicationIds,
    groupedCounts: {
      figure: groupedPublicationIds.figure.length,
      structure: groupedPublicationIds.structure.length,
      font: groupedPublicationIds.font.length,
      mixed: groupedPublicationIds.mixed.length,
      unknown: groupedPublicationIds.unknown.length,
    },
  }
}
