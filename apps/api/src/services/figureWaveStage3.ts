import fs from 'node:fs'
import path from 'node:path'
import type {
  CohortLabel,
  CorpusControlPlaneArtifacts,
  CorpusControlPlaneCanariesDocument,
  CorpusControlPlaneDocument,
  CorpusControlPlaneRow,
  CorpusControlPlaneSources,
  CorpusStatus,
  FigureWaveBucket,
} from './corpusControlPlane.ts'

export interface Stage3FigureWaveCandidate {
  priorityRank: number
  passLikelihoodScore: number
  priorityTier: 'highest' | 'high' | 'medium' | 'low'
  recommendedAction: 'fix_first'
  publicationId: string | null
  publicationTitle: string | null
  serverHost: string | null
  remotePath: string | null
  localCachePath: string | null
  fileUrl: string | null
  storageKind: string | null
  currentCorpusStatus: CorpusStatus
  figureWaveBucket: FigureWaveBucket
  selectionReasons: string[]
  reportPath: string
  pageCount: number
  isScanned: boolean
  blockerFamilyCount: number
  blockingFindingCount: number
  topBlockingResidualFamilyIds: string[]
  blockingFindingKeys: string[]
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

export interface Stage3FigureWaveSkippedRow {
  publicationId: string
  publicationTitle: string | null
  currentCorpusStatus: CorpusStatus
  figureWaveBucket: FigureWaveBucket | null
  skipReasons: string[]
}

export interface Stage3FigureWaveDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  waveName: 'stage3-figure-wave'
  cohortLabel: 'figure_heavy'
  maxCandidates: number
  totals: {
    eligibleRows: number
    selectedRows: number
    skippedRows: number
    pendingRows: number
  }
  selectedPublicationIds: string[]
  pendingPublicationIds: string[]
  candidates: Stage3FigureWaveCandidate[]
  skippedRows: Stage3FigureWaveSkippedRow[]
}

export interface Stage3FigureWaveSummaryDocument {
  generatedAt: string
  waveManifestPath: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  totals: Stage3FigureWaveDocument['totals']
  selectedPublicationIds: string[]
  pendingPublicationIds: string[]
  selectedByTier: Record<'highest' | 'high' | 'medium' | 'low', number>
  selectedByStatus: Record<CorpusStatus, number>
  selectedByFigureWaveBucket: Record<FigureWaveBucket, number>
}

export interface Stage3FigureThroughputSummaryDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  waveManifestPath: string
  waveOutcomesPath: string | null
  cohortLabel: 'figure_heavy'
  totals: {
    totalFigureHeavyRows: number
    verifiedPassRowsInCohort: number
    newlyVerifiedPassRowsFromWave: number
    remainingFigureHeavyRows: number
    processingErrorsInWave: number
    hardFailsInWave: number
    ownershipClearedFigureDebtRows: number
    mixedFigureStructureDebtRows: number
    massUnresolvedFigureDebtRows: number
    figureProcessingErrorRetryRows: number
    genericTimeoutRows: number
    pendingWaveRows: number
  }
  rows: {
    newlyVerifiedPassPublicationIds: string[]
    remainingPublicationIds: string[]
    processingErrorPublicationIds: string[]
    hardFailPublicationIds: string[]
    ownershipClearedFigureDebtPublicationIds: string[]
    mixedFigureStructureDebtPublicationIds: string[]
    massUnresolvedFigureDebtPublicationIds: string[]
    figureProcessingErrorRetryPublicationIds: string[]
    genericTimeoutPublicationIds: string[]
    pendingPublicationIds: string[]
    nextWaveFigureOnlyPublicationIds: string[]
    mixedFollowupPublicationIds: string[]
    boundedRuntimeRetryPublicationIds: string[]
    reclassifiedOutOfFigureHeavyPublicationIds: string[]
  }
}

export interface Stage3FigureCanaryRow {
  publicationId: string | null
  publicationTitle: string | null
  source: 'benchmark' | 'cohort_representative'
  benchmarkName: string | null
  stage3RepresentativeKind: 'ownership_cleared_figure_debt_remains' | 'mass_unresolved_figure_debt' | 'mixed_figure_structure_debt' | 'figure_processing_error_retry' | 'short_flyer_or_infographic' | null
  currentCorpusStatus: CorpusStatus | null
  currentCohortLabel: string | null
  figureWaveBucket: FigureWaveBucket | null
  hasGenericTimeoutWording: boolean
  benchmarkTerminalState: string | null
  notes: string[]
}

export interface Stage3FigureCanariesDocument {
  generatedAt: string
  summary: {
    totalCanaries: number
    bySource: Record<'benchmark' | 'cohort_representative', number>
    byFigureWaveBucket: Record<FigureWaveBucket, number>
    withGenericTimeoutWording: number
  }
  rows: Stage3FigureCanaryRow[]
}

type OutcomeLike = {
  publicationId: string | null
  status: string | null
}

const ALL_BUCKETS: FigureWaveBucket[] = [
  'ownership_cleared_figure_debt_remains',
  'mass_unresolved_figure_debt',
  'figure_processing_error_retry',
  'mixed_figure_structure_debt',
]

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort()
}

function emptyStatusCounts(): Record<CorpusStatus, number> {
  return {
    verified_pass: 0,
    discovered: 0,
    analyzed: 0,
    queued_for_remediation: 0,
    remediated_fail: 0,
    processing_error: 0,
    deferred_manual: 0,
    staged_for_replacement: 0,
    replaced_remote: 0,
  }
}

function emptyBucketCounts(): Record<FigureWaveBucket, number> {
  return {
    ownership_cleared_figure_debt_remains: 0,
    mixed_figure_structure_debt: 0,
    mass_unresolved_figure_debt: 0,
    figure_processing_error_retry: 0,
  }
}

function loadJsonIfExists(filePath: string | null) {
  if (!filePath || !fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function safeNumber(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

function pendingPublicationIdsFromExistingArtifacts(
  waveDoc: Stage3FigureWaveDocument | null,
  outcomesDoc: { outcomes?: OutcomeLike[] } | null,
): string[] {
  if (!waveDoc) return []
  const completed = new Set((outcomesDoc?.outcomes || []).map(outcome => outcome.publicationId).filter((value): value is string => Boolean(value)))
  return waveDoc.selectedPublicationIds.filter(publicationId => !completed.has(publicationId))
}

function shouldCarryForwardPendingFigureWave(input: {
  existingWave: Stage3FigureWaveDocument | null
  existingOutcomes: { outcomes?: OutcomeLike[] } | null
  pendingPublicationIds: string[]
  rowsById: Map<string, CorpusControlPlaneRow>
}): boolean {
  const { existingWave, existingOutcomes, pendingPublicationIds, rowsById } = input
  if (!existingWave || pendingPublicationIds.length === 0) return false

  const selectedIds = existingWave.selectedPublicationIds || []
  const currentWaveOutcomes = (existingOutcomes?.outcomes || []).filter(outcome => outcome.publicationId && selectedIds.includes(outcome.publicationId))
  if (currentWaveOutcomes.length === 0) return true

  const newlyVerifiedPassCount = selectedIds.filter(publicationId => {
    const row = rowsById.get(publicationId)
    return Boolean(row?.currentCorpusStatus === 'verified_pass' && row?.promotionTruth.ledgerRowPresent)
  }).length

  const pendingRowsAreBucketed = pendingPublicationIds.every(publicationId => {
    const row = rowsById.get(publicationId)
    return Boolean(row?.cohortLabel === 'figure_heavy' && row?.stage3FigureDiagnostics.figureWaveBucket)
  })

  if (newlyVerifiedPassCount === 0 && pendingRowsAreBucketed) {
    return false
  }

  return true
}

function bucketRank(bucket: FigureWaveBucket): number {
  return {
    ownership_cleared_figure_debt_remains: 0,
    mass_unresolved_figure_debt: 1,
    figure_processing_error_retry: 2,
    mixed_figure_structure_debt: 3,
  }[bucket]
}

function priorityTierForBucket(bucket: FigureWaveBucket): 'highest' | 'high' | 'medium' | 'low' {
  return ({
    ownership_cleared_figure_debt_remains: 'highest',
    mass_unresolved_figure_debt: 'high',
    figure_processing_error_retry: 'medium',
    mixed_figure_structure_debt: 'low',
  } as const)[bucket]
}

function compareWaveRows(left: CorpusControlPlaneRow, right: CorpusControlPlaneRow): number {
  const leftBucket = left.stage3FigureDiagnostics.figureWaveBucket
  const rightBucket = right.stage3FigureDiagnostics.figureWaveBucket
  if (leftBucket && rightBucket) {
    const bucketDiff = bucketRank(leftBucket) - bucketRank(rightBucket)
    if (bucketDiff !== 0) return bucketDiff
  }

  const blockerDiff = safeNumber(left.classificationEvidence.blockerFamilyCount, 0) - safeNumber(right.classificationEvidence.blockerFamilyCount, 0)
  if (blockerDiff !== 0) return blockerDiff

  const pageDiff = safeNumber(left.classificationEvidence.pageCount, Number.MAX_SAFE_INTEGER) - safeNumber(right.classificationEvidence.pageCount, Number.MAX_SAFE_INTEGER)
  if (pageDiff !== 0) return pageDiff

  const leftFigureDebt = safeNumber(left.stage3FigureDiagnostics.missingAltCountFinal, safeNumber(left.stage3FigureDiagnostics.missingAltCountInitial, Number.MAX_SAFE_INTEGER))
  const rightFigureDebt = safeNumber(right.stage3FigureDiagnostics.missingAltCountFinal, safeNumber(right.stage3FigureDiagnostics.missingAltCountInitial, Number.MAX_SAFE_INTEGER))
  if (leftFigureDebt !== rightFigureDebt) return leftFigureDebt - rightFigureDebt

  const scannedDiff = Number(Boolean(left.classificationEvidence.isScanned)) - Number(Boolean(right.classificationEvidence.isScanned))
  if (scannedDiff !== 0) return scannedDiff

  return left.publicationId.localeCompare(right.publicationId)
}

function computePassLikelihoodScore(row: CorpusControlPlaneRow): number {
  const bucket = row.stage3FigureDiagnostics.figureWaveBucket
  const base = bucket === 'ownership_cleared_figure_debt_remains'
    ? 84
    : bucket === 'mass_unresolved_figure_debt'
      ? 72
      : bucket === 'figure_processing_error_retry'
        ? 58
        : 46
  const pagePenalty = Math.min(18, Math.floor(safeNumber(row.classificationEvidence.pageCount, 0) / 10))
  const blockerPenalty = Math.min(24, safeNumber(row.classificationEvidence.blockerFamilyCount, 0) * 4)
  const missingAltPenalty = Math.min(20, Math.floor(safeNumber(row.stage3FigureDiagnostics.missingAltCountFinal, safeNumber(row.stage3FigureDiagnostics.missingAltCountInitial, 0)) / 10))
  const scannedPenalty = row.classificationEvidence.isScanned ? 12 : 0
  return Math.max(1, Math.min(99, base - pagePenalty - blockerPenalty - missingAltPenalty - scannedPenalty))
}

function emptyCohortCounts(): Record<CohortLabel, number> {
  return {
    short_high_likelihood: 0,
    figure_heavy: 0,
    structure_heavy: 0,
    font_heavy: 0,
    long_report: 0,
    manual_tail: 0,
  }
}

function buildSummary(rows: CorpusControlPlaneRow[], ledgerRowCount: number): CorpusControlPlaneDocument['summary'] {
  const byCurrentCorpusStatus = emptyStatusCounts()
  const byCohortLabel = emptyCohortCounts()
  const byStorageKind: Record<string, number> = {}
  const statusByCohort = {
    short_high_likelihood: emptyStatusCounts(),
    figure_heavy: emptyStatusCounts(),
    structure_heavy: emptyStatusCounts(),
    font_heavy: emptyStatusCounts(),
    long_report: emptyStatusCounts(),
    manual_tail: emptyStatusCounts(),
  }

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

function buildByCohort(rows: CorpusControlPlaneRow[]): CorpusControlPlaneArtifacts['byCohort'] {
  const cohorts = {
    short_high_likelihood: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] as string[] },
    figure_heavy: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] as string[] },
    structure_heavy: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] as string[] },
    font_heavy: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] as string[] },
    long_report: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] as string[] },
    manual_tail: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] as string[] },
  }

  for (const row of rows) {
    const bucket = cohorts[row.cohortLabel]
    bucket.totalRows += 1
    bucket.byCurrentCorpusStatus[row.currentCorpusStatus] += 1
    if (bucket.samplePublicationIds.length < 10) bucket.samplePublicationIds.push(row.publicationId)
  }

  return { generatedAt: new Date().toISOString(), cohorts }
}

function updateCanaries(canaries: CorpusControlPlaneCanariesDocument, rows: CorpusControlPlaneRow[]): CorpusControlPlaneCanariesDocument {
  const rowByPublicationId = new Map(rows.map(row => [row.publicationId, row]))
  const nextRows = canaries.rows.map(row => {
    if (!row.publicationId) return row
    const matched = rowByPublicationId.get(row.publicationId)
    if (!matched) return row
    return {
      ...row,
      cohortLabel: matched.cohortLabel,
      currentCorpusStatus: matched.currentCorpusStatus,
    }
  })

  const byCohortLabel = emptyCohortCounts()
  for (const row of nextRows) byCohortLabel[row.cohortLabel] += 1

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalCanaries: nextRows.length,
      matchedPublicationIds: nextRows.filter(row => !!row.publicationId).length,
      unmatchedCanaries: nextRows.filter(row => !row.publicationId).length,
      byCohortLabel,
    },
    rows: nextRows,
  }
}

function applyStage3RoutingToRow(row: CorpusControlPlaneRow): CorpusControlPlaneRow {
  if (row.cohortLabel !== 'figure_heavy' || row.currentCorpusStatus === 'verified_pass') return row

  const nextReasonCodes = [...row.reasonCodes]
  const nextNotes = [...row.notes]
  let nextCohortLabel: CohortLabel = row.cohortLabel
  let nextStatus = row.currentCorpusStatus

  const latestOutcomeStatus = row.statusEvidence.outcomeStatus
  const blockingKeys = row.classificationEvidence.blockingFindingKeys
  const structureOnly = latestOutcomeStatus === 'failed_after_remediation'
    && row.stage3FigureDiagnostics.figureWaveBucket === null
    && blockingKeys.includes('pdfua.logical_structure')
  const runtimeRetry = latestOutcomeStatus === 'processing_error'
    && row.stage3FigureDiagnostics.figureWaveBucket === 'figure_processing_error_retry'

  if (structureOnly) {
    nextCohortLabel = 'structure_heavy'
    nextReasonCodes.push('stage3:reclassified_from_figure_heavy', 'stage3:structure_dominant_after_figure_wave')
    nextNotes.push('Stage 3 reclassified this row from figure_heavy to structure_heavy after a structure-only first-wave outcome.')
  } else if (row.stage3FigureDiagnostics.figureWaveBucket === 'mixed_figure_structure_debt') {
    nextReasonCodes.push('stage3:mixed_figure_structure_after_wave')
  } else if (row.stage3FigureDiagnostics.figureWaveBucket === 'mass_unresolved_figure_debt') {
    nextReasonCodes.push('stage3:mass_figure_debt_after_wave')
  } else if (row.stage3FigureDiagnostics.figureWaveBucket === 'figure_processing_error_retry') {
    nextReasonCodes.push('stage3:bounded_runtime_figure_retry')
  }

  if (runtimeRetry) {
    nextStatus = 'processing_error'
  }

  return {
    ...row,
    currentCorpusStatus: nextStatus,
    cohortLabel: nextCohortLabel,
    reasonCodes: uniqueStrings(nextReasonCodes),
    notes: uniqueStrings(nextNotes),
  }
}

export function applyStage3FigureWaveReclassification(artifacts: CorpusControlPlaneArtifacts): CorpusControlPlaneArtifacts {
  const rows = artifacts.document.rows.map(applyStage3RoutingToRow)
  return {
    document: {
      generatedAt: artifacts.document.generatedAt,
      summary: buildSummary(rows, artifacts.document.summary.verifiedPassRowsFromLedger),
      rows,
    },
    byCohort: buildByCohort(rows),
    canaries: updateCanaries(artifacts.canaries, rows),
  }
}

function selectionReasonsForRow(row: CorpusControlPlaneRow): string[] {
  const bucket = row.stage3FigureDiagnostics.figureWaveBucket
  return uniqueStrings([
    bucket ? 'stage3_bucket:' + bucket : null,
    bucket === 'ownership_cleared_figure_debt_remains' ? 'ownership_resolved_but_figure_debt_remains' : null,
    bucket === 'mixed_figure_structure_debt' ? 'mixed_figure_and_structure_follow_up' : null,
    bucket === 'figure_processing_error_retry' ? 'retry_bounded_figure_processing_error' : null,
    bucket === 'mass_unresolved_figure_debt' ? 'mass_figure_debt_candidate' : null,
    row.stage3FigureDiagnostics.hasGenericTimeoutWording ? 'contains_generic_timeout_wording' : null,
    ...row.reasonCodes,
  ])
}

function representativeCanaryRows(artifacts: CorpusControlPlaneArtifacts): Stage3FigureCanaryRow[] {
  const rows = artifacts.document.rows.filter(row => row.cohortLabel === 'figure_heavy')
  const picks: Array<{ kind: Stage3FigureCanaryRow['stage3RepresentativeKind']; row: CorpusControlPlaneRow | undefined }> = [
    {
      kind: 'ownership_cleared_figure_debt_remains',
      row: rows.find(row => row.publicationId === '3614')
        || rows.find(row => row.stage3FigureDiagnostics.figureWaveBucket === 'ownership_cleared_figure_debt_remains'),
    },
    {
      kind: 'mass_unresolved_figure_debt',
      row: rows.find(row => row.publicationId === '3682')
        || rows.find(row => row.reasonCodes.includes('stage3:mass_figure_debt_after_wave'))
        || rows.find(row => row.stage3FigureDiagnostics.figureWaveBucket === 'mass_unresolved_figure_debt'),
    },
    {
      kind: 'figure_processing_error_retry',
      row: rows.find(row => ['4487', '4657', '4693'].includes(row.publicationId))
        || rows.find(row => row.reasonCodes.includes('stage3:bounded_runtime_figure_retry'))
        || rows.find(row => row.stage3FigureDiagnostics.figureWaveBucket === 'figure_processing_error_retry'),
    },
    { kind: 'short_flyer_or_infographic', row: rows.find(row => (row.classificationEvidence.pageCount || 0) <= 4) },
  ]

  const seen = new Set<string>()
  const result: Stage3FigureCanaryRow[] = []
  for (const pick of picks) {
    if (!pick.row) continue
    const key = [pick.row.publicationId, pick.kind || ''].join(':')
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      publicationId: pick.row.publicationId,
      publicationTitle: pick.row.title,
      source: 'cohort_representative',
      benchmarkName: null,
      stage3RepresentativeKind: pick.kind,
      currentCorpusStatus: pick.row.currentCorpusStatus,
      currentCohortLabel: pick.row.cohortLabel,
      figureWaveBucket: pick.row.stage3FigureDiagnostics.figureWaveBucket,
      hasGenericTimeoutWording: pick.row.stage3FigureDiagnostics.hasGenericTimeoutWording,
      benchmarkTerminalState: null,
      notes: uniqueStrings([
        pick.kind === 'short_flyer_or_infographic' ? 'Short figure-heavy representative for flyers/infographics.' : null,
        pick.kind === 'mixed_figure_structure_debt' ? 'Mixed figure-and-structure follow-up representative.' : null,
        pick.kind === 'mass_unresolved_figure_debt' ? 'Mass unresolved figure-debt representative.' : null,
        pick.kind === 'figure_processing_error_retry' ? 'Bounded-runtime retry representative from the latest figure wave.' : null,
        pick.row.statusEvidence.latestReportPath || null,
      ]),
    })
  }
  return result
}

export function buildStage3FigureCanaries(input: {
  artifacts: CorpusControlPlaneArtifacts
  sources: CorpusControlPlaneSources
}): Stage3FigureCanariesDocument {
  const rowByPublicationId = new Map(input.artifacts.document.rows.map(row => [row.publicationId, row]))
  const publicationIdByLocalPath = new Map<string, string>()
  for (const replacementRow of input.sources.replacementMap) {
    const localPath = replacementRow.checksumState?.localCurrentFilePath
    if (localPath) publicationIdByLocalPath.set(localPath, replacementRow.publicationId)
  }

  const benchmarkNames = new Set([
    'Kendall County Profile',
    'CSEC 2008 Research Bulletin',
    'Criminal Sentencing Layout',
  ])

  const benchmarkRows: Stage3FigureCanaryRow[] = input.sources.regressionBenchmarkOutcomes
    .filter(outcome => benchmarkNames.has(outcome.name))
    .map(outcome => {
      const publicationId = publicationIdByLocalPath.get(outcome.filePath) || null
      const matched = publicationId ? rowByPublicationId.get(publicationId) || null : null
      return {
        publicationId,
        publicationTitle: matched?.title || null,
        source: 'benchmark',
        benchmarkName: outcome.name,
        stage3RepresentativeKind: null,
        currentCorpusStatus: matched?.currentCorpusStatus || null,
        currentCohortLabel: matched?.cohortLabel || null,
        figureWaveBucket: matched?.stage3FigureDiagnostics.figureWaveBucket || null,
        hasGenericTimeoutWording: matched?.stage3FigureDiagnostics.hasGenericTimeoutWording || false,
        benchmarkTerminalState: outcome.terminalState || null,
        notes: uniqueStrings([
          outcome.category ? 'benchmark_category:' + outcome.category : null,
          outcome.error?.message || null,
        ]),
      }
    })

  const rows = [...benchmarkRows, ...representativeCanaryRows(input.artifacts)]
  const deduped: Stage3FigureCanaryRow[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const key = [row.source, row.publicationId || '', row.benchmarkName || '', row.stage3RepresentativeKind || ''].join(':')
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(row)
  }

  const bySource = { benchmark: 0, cohort_representative: 0 }
  const byFigureWaveBucket = emptyBucketCounts()
  for (const row of deduped) {
    bySource[row.source] += 1
    if (row.figureWaveBucket) byFigureWaveBucket[row.figureWaveBucket] += 1
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalCanaries: deduped.length,
      bySource,
      byFigureWaveBucket,
      withGenericTimeoutWording: deduped.filter(row => row.hasGenericTimeoutWording).length,
    },
    rows: deduped,
  }
}

export function buildStage3FigureWaveArtifacts(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manifestsRoot: string
  maxCandidates?: number
}): {
  wave: Stage3FigureWaveDocument
  summary: Stage3FigureWaveSummaryDocument
} {
  const maxCandidates = Math.max(1, input.maxCandidates || 8)
  const currentWavePath = path.join(input.manifestsRoot, 'stage3-figure-wave.json')
  const currentOutcomesPath = path.join(input.manifestsRoot, 'stage3-figure-wave.outcomes.json')
  const existingWave = loadJsonIfExists(currentWavePath) as Stage3FigureWaveDocument | null
  const existingOutcomes = loadJsonIfExists(currentOutcomesPath) as { outcomes?: OutcomeLike[] } | null
  const rowsById = new Map(input.artifacts.document.rows.map(row => [row.publicationId, row]))
  const activeEligiblePublicationIds = new Set(
    input.artifacts.document.rows
      .filter(row => row.cohortLabel === 'figure_heavy' && row.currentCorpusStatus !== 'verified_pass' && row.stage3FigureDiagnostics.figureWaveBucket)
      .map(row => row.publicationId),
  )
  const pendingPublicationIds = pendingPublicationIdsFromExistingArtifacts(existingWave, existingOutcomes)
    .filter(publicationId => activeEligiblePublicationIds.has(publicationId))

  if (shouldCarryForwardPendingFigureWave({
    existingWave,
    existingOutcomes,
    pendingPublicationIds,
    rowsById,
  })) {
    const selectedByTier = { highest: 0, high: 0, medium: 0, low: 0 }
    const selectedByStatus = emptyStatusCounts()
    const selectedByFigureWaveBucket = emptyBucketCounts()
    for (const candidate of existingWave!.candidates) {
      selectedByTier[candidate.priorityTier] += 1
      selectedByStatus[candidate.currentCorpusStatus] += 1
      selectedByFigureWaveBucket[candidate.figureWaveBucket] += 1
    }
    return {
      wave: {
        ...existingWave!,
        pendingPublicationIds,
        totals: { ...existingWave!.totals, pendingRows: pendingPublicationIds.length },
      },
      summary: {
        generatedAt: new Date().toISOString(),
        waveManifestPath: currentWavePath,
        sourceControlPlanePath: existingWave!.sourceControlPlanePath,
        sourceControlPlaneGeneratedAt: existingWave!.sourceControlPlaneGeneratedAt,
        totals: { ...existingWave!.totals, pendingRows: pendingPublicationIds.length },
        selectedPublicationIds: existingWave!.selectedPublicationIds,
        pendingPublicationIds,
        selectedByTier,
        selectedByStatus,
        selectedByFigureWaveBucket,
      },
    }
  }

  const stage3Rows = input.artifacts.document.rows
    .filter(row => row.cohortLabel === 'figure_heavy' && row.currentCorpusStatus !== 'verified_pass')
    .sort(compareWaveRows)

  const skippedRows: Stage3FigureWaveSkippedRow[] = []
  const eligibleRows: CorpusControlPlaneRow[] = []
  for (const row of stage3Rows) {
    const skipReasons: string[] = []
    if (!row.stage3FigureDiagnostics.figureWaveBucket) skipReasons.push('missing_figure_wave_bucket')
    if (!row.sourceMetadata.currentSourcePath) skipReasons.push('missing_local_source_path')
    if (!row.remotePath) skipReasons.push('missing_remote_path')
    if (skipReasons.length) {
      skippedRows.push({
        publicationId: row.publicationId,
        publicationTitle: row.title,
        currentCorpusStatus: row.currentCorpusStatus,
        figureWaveBucket: row.stage3FigureDiagnostics.figureWaveBucket,
        skipReasons,
      })
      continue
    }
    eligibleRows.push(row)
  }

  const selectedRows = eligibleRows.slice(0, maxCandidates)
  for (const row of eligibleRows.slice(maxCandidates)) {
    skippedRows.push({
      publicationId: row.publicationId,
      publicationTitle: row.title,
      currentCorpusStatus: row.currentCorpusStatus,
      figureWaveBucket: row.stage3FigureDiagnostics.figureWaveBucket,
      skipReasons: [
        'not_in_current_wave_capacity',
        row.stage3FigureDiagnostics.figureWaveBucket ? 'stage3_bucket:' + row.stage3FigureDiagnostics.figureWaveBucket : 'stage3_bucket:none',
        row.statusEvidence.outcomeStatus ? 'latest_outcome_status:' + row.statusEvidence.outcomeStatus : 'latest_outcome_status:none',
      ],
    })
  }

  const candidates: Stage3FigureWaveCandidate[] = selectedRows.map((row, index) => ({
    priorityRank: index + 1,
    passLikelihoodScore: computePassLikelihoodScore(row),
    priorityTier: priorityTierForBucket(row.stage3FigureDiagnostics.figureWaveBucket as FigureWaveBucket),
    recommendedAction: 'fix_first',
    publicationId: row.publicationId,
    publicationTitle: row.title,
    serverHost: row.serverHost,
    remotePath: row.remotePath,
    localCachePath: row.sourceMetadata.currentSourcePath,
    fileUrl: row.fileUrl,
    storageKind: row.storageKind,
    currentCorpusStatus: row.currentCorpusStatus,
    figureWaveBucket: row.stage3FigureDiagnostics.figureWaveBucket as FigureWaveBucket,
    selectionReasons: selectionReasonsForRow(row),
    reportPath: row.statusEvidence.latestReportPath || row.statusEvidence.verificationReportPath || input.sourceControlPlanePath,
    pageCount: safeNumber(row.classificationEvidence.pageCount, 0),
    isScanned: Boolean(row.classificationEvidence.isScanned),
    blockerFamilyCount: safeNumber(row.classificationEvidence.blockerFamilyCount, 0),
    blockingFindingCount: safeNumber(row.classificationEvidence.blockingFindingCount, 0),
    topBlockingResidualFamilyIds: row.classificationEvidence.topBlockingResidualFamilyIds,
    blockingFindingKeys: row.classificationEvidence.blockingFindingKeys,
    ownershipRiskKnown: row.stage3FigureDiagnostics.ownershipRiskKnown,
    ownershipRiskCountInitial: row.stage3FigureDiagnostics.ownershipRiskCountInitial,
    ownershipRiskCountFinal: row.stage3FigureDiagnostics.ownershipRiskCountFinal,
    missingAltCountInitial: row.stage3FigureDiagnostics.missingAltCountInitial,
    missingAltCountFinal: row.stage3FigureDiagnostics.missingAltCountFinal,
    decorativeFigureCountInitial: row.stage3FigureDiagnostics.decorativeFigureCountInitial,
    decorativeFigureCountFinal: row.stage3FigureDiagnostics.decorativeFigureCountFinal,
    dominantFigurePhase: row.stage3FigureDiagnostics.dominantFigurePhase,
    inspectionPattern: row.stage3FigureDiagnostics.inspectionPattern,
    hasGenericTimeoutWording: row.stage3FigureDiagnostics.hasGenericTimeoutWording,
  }))

  const nextPendingPublicationIds: string[] = []

  const wave: Stage3FigureWaveDocument = {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    waveName: 'stage3-figure-wave',
    cohortLabel: 'figure_heavy',
    maxCandidates,
    totals: {
      eligibleRows: eligibleRows.length,
      selectedRows: candidates.length,
      skippedRows: skippedRows.length,
      pendingRows: nextPendingPublicationIds.length,
    },
    selectedPublicationIds: candidates.map(candidate => candidate.publicationId).filter((value): value is string => Boolean(value)),
    pendingPublicationIds: nextPendingPublicationIds,
    candidates,
    skippedRows: skippedRows.sort((left, right) => left.publicationId.localeCompare(right.publicationId)),
  }

  const selectedByTier = { highest: 0, high: 0, medium: 0, low: 0 }
  const selectedByStatus = emptyStatusCounts()
  const selectedByFigureWaveBucket = emptyBucketCounts()
  for (const candidate of candidates) {
    selectedByTier[candidate.priorityTier] += 1
    selectedByStatus[candidate.currentCorpusStatus] += 1
    selectedByFigureWaveBucket[candidate.figureWaveBucket] += 1
  }

  return {
    wave,
    summary: {
      generatedAt: wave.generatedAt,
      waveManifestPath: currentWavePath,
      sourceControlPlanePath: input.sourceControlPlanePath,
      sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
      totals: wave.totals,
      selectedPublicationIds: wave.selectedPublicationIds,
      pendingPublicationIds: nextPendingPublicationIds,
      selectedByTier,
      selectedByStatus,
      selectedByFigureWaveBucket,
    },
  }
}

export function buildStage3FigureThroughputSummary(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  waveManifestPath: string
  wave: Stage3FigureWaveDocument | null
  outcomesPath: string | null
  outcomes: { outcomes?: OutcomeLike[] } | null
}): Stage3FigureThroughputSummaryDocument {
  const figureRows = input.artifacts.document.rows.filter(row => row.cohortLabel === 'figure_heavy')
  const waveIds = new Set(input.wave?.selectedPublicationIds || [])
  const rowsById = new Map(input.artifacts.document.rows.map(row => [row.publicationId, row]))

  const newlyVerifiedPassPublicationIds = Array.from(waveIds)
    .filter(publicationId => {
      const row = rowsById.get(publicationId)
      return Boolean(row?.currentCorpusStatus === 'verified_pass' && row.promotionTruth.ledgerRowPresent)
    })
    .sort()

  const remainingPublicationIds = figureRows
    .filter(row => row.currentCorpusStatus !== 'verified_pass')
    .map(row => row.publicationId)
    .sort()

  const processingErrorPublicationIds = uniqueStrings((input.outcomes?.outcomes || []).filter(outcome => outcome.status === 'processing_error').map(outcome => outcome.publicationId))
  const hardFailPublicationIds = uniqueStrings((input.outcomes?.outcomes || []).filter(outcome => outcome.status === 'failed_after_remediation').map(outcome => outcome.publicationId))
  const pendingPublicationIds = (input.wave?.pendingPublicationIds || []).slice().sort()

  const bucketIds = {
    ownership_cleared_figure_debt_remains: figureRows.filter(row => row.stage3FigureDiagnostics.figureWaveBucket === 'ownership_cleared_figure_debt_remains' && row.currentCorpusStatus !== 'verified_pass').map(row => row.publicationId).sort(),
    mixed_figure_structure_debt: figureRows.filter(row => row.stage3FigureDiagnostics.figureWaveBucket === 'mixed_figure_structure_debt' && row.currentCorpusStatus !== 'verified_pass').map(row => row.publicationId).sort(),
    mass_unresolved_figure_debt: figureRows.filter(row => row.stage3FigureDiagnostics.figureWaveBucket === 'mass_unresolved_figure_debt' && row.currentCorpusStatus !== 'verified_pass').map(row => row.publicationId).sort(),
    figure_processing_error_retry: figureRows.filter(row => row.stage3FigureDiagnostics.figureWaveBucket === 'figure_processing_error_retry' && row.currentCorpusStatus !== 'verified_pass').map(row => row.publicationId).sort(),
  }
  const genericTimeoutPublicationIds = figureRows.filter(row => row.stage3FigureDiagnostics.hasGenericTimeoutWording).map(row => row.publicationId).sort()
  const nextWaveFigureOnlyPublicationIds = uniqueStrings([
    ...bucketIds.ownership_cleared_figure_debt_remains,
    ...bucketIds.mass_unresolved_figure_debt,
  ])
  const mixedFollowupPublicationIds = bucketIds.mixed_figure_structure_debt
  const boundedRuntimeRetryPublicationIds = bucketIds.figure_processing_error_retry
  const reclassifiedOutOfFigureHeavyPublicationIds = input.artifacts.document.rows
    .filter(row => row.reasonCodes.includes('stage3:reclassified_from_figure_heavy'))
    .map(row => row.publicationId)
    .sort()

  return {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    waveManifestPath: input.waveManifestPath,
    waveOutcomesPath: input.outcomesPath,
    cohortLabel: 'figure_heavy',
    totals: {
      totalFigureHeavyRows: figureRows.length,
      verifiedPassRowsInCohort: figureRows.filter(row => row.currentCorpusStatus === 'verified_pass').length,
      newlyVerifiedPassRowsFromWave: newlyVerifiedPassPublicationIds.length,
      remainingFigureHeavyRows: remainingPublicationIds.length,
      processingErrorsInWave: processingErrorPublicationIds.length,
      hardFailsInWave: hardFailPublicationIds.length,
      ownershipClearedFigureDebtRows: bucketIds.ownership_cleared_figure_debt_remains.length,
      mixedFigureStructureDebtRows: bucketIds.mixed_figure_structure_debt.length,
      massUnresolvedFigureDebtRows: bucketIds.mass_unresolved_figure_debt.length,
      figureProcessingErrorRetryRows: bucketIds.figure_processing_error_retry.length,
      genericTimeoutRows: genericTimeoutPublicationIds.length,
      pendingWaveRows: pendingPublicationIds.length,
    },
    rows: {
      newlyVerifiedPassPublicationIds,
      remainingPublicationIds,
      processingErrorPublicationIds,
      hardFailPublicationIds,
      ownershipClearedFigureDebtPublicationIds: bucketIds.ownership_cleared_figure_debt_remains,
      mixedFigureStructureDebtPublicationIds: bucketIds.mixed_figure_structure_debt,
      massUnresolvedFigureDebtPublicationIds: bucketIds.mass_unresolved_figure_debt,
      figureProcessingErrorRetryPublicationIds: bucketIds.figure_processing_error_retry,
      genericTimeoutPublicationIds,
      pendingPublicationIds,
      nextWaveFigureOnlyPublicationIds,
      mixedFollowupPublicationIds,
      boundedRuntimeRetryPublicationIds,
      reclassifiedOutOfFigureHeavyPublicationIds,
    },
  }
}
