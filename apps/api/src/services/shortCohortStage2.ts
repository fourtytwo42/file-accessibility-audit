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
} from './corpusControlPlane.ts'

export interface Stage2ShortCohortWaveCandidate {
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
  reportPath: string
  currentCorpusStatus: CorpusStatus
  currentCohortLabel: CohortLabel
  selectionBucket: 'analyzed' | 'processing_error' | 'remediated_fail'
  selectionReasons: string[]
}

export interface Stage2ShortCohortWaveSkippedRow {
  publicationId: string
  publicationTitle: string | null
  currentCorpusStatus: CorpusStatus
  currentCohortLabel: CohortLabel
  skipReasons: string[]
}

export interface Stage2ShortCohortWaveDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  waveName: string
  cohortLabel: 'short_high_likelihood'
  maxCandidates: number
  totals: {
    eligibleRows: number
    selectedRows: number
    skippedRows: number
    pendingRows: number
  }
  selectedPublicationIds: string[]
  pendingPublicationIds: string[]
  candidates: Stage2ShortCohortWaveCandidate[]
  skippedRows: Stage2ShortCohortWaveSkippedRow[]
}

export interface Stage2ShortCohortWaveSummaryDocument {
  generatedAt: string
  waveManifestPath: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  totals: Stage2ShortCohortWaveDocument['totals']
  selectedPublicationIds: string[]
  pendingPublicationIds: string[]
  selectedByTier: Record<'highest' | 'high' | 'medium', number>
  selectedByStatus: Record<CorpusStatus, number>
}

export interface Stage2ShortCohortThroughputSummaryDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  waveManifestPath: string
  waveOutcomesPath: string | null
  cohortLabel: 'short_high_likelihood'
  totals: {
    totalRowsInCohort: number
    verifiedPassRowsInCohort: number
    newlyVerifiedPassRowsFromWave: number
    remainingRowsInCohort: number
    reclassifiedOutOfCohort: number
    processingErrorsInWave: number
    hardFailsInWave: number
    pendingWaveRows: number
  }
  rows: {
    newlyVerifiedPassPublicationIds: string[]
    remainingPublicationIds: string[]
    reclassifiedPublicationIds: string[]
    processingErrorPublicationIds: string[]
    hardFailPublicationIds: string[]
    pendingPublicationIds: string[]
  }
}

type OutcomeLike = {
  publicationId: string | null
  status: string | null
}

type BenchmarkCategory = 'figure' | 'structure' | 'long_report' | null

const LONG_REPORT_PAGE_THRESHOLD = 40
const FIGURE_FAMILY_PATTERN = /(figure|alt|ownership|artifact|image)/i
const STRUCTURE_FAMILY_PATTERN = /(logical_structure|heading|reading_order|marked_content|page_tabs|structure|bookmark|language)/i
const FONT_FAMILY_PATTERN = /(font|unicode|charenc)/i
const ANNUAL_REPORT_TITLE_PATTERN = /annual report/i
const STAGE4_STRUCTURE_TERMINAL_SURVIVOR_TO_STAGE2_COHORT: Partial<Record<NonNullable<CorpusControlPlaneRow['stage4StructureDiagnostics']['terminalSurvivorClass']>, CohortLabel>> = {
  near_pass_grade_only: 'structure_heavy',
  font_text_extractability_survivor: 'font_heavy',
  metadata_title_survivor: 'structure_heavy',
  reading_order_only_survivor: 'structure_heavy',
  metadata_font_structure_survivor: 'structure_heavy',
  figure_spillover_survivor: 'structure_heavy',
}

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
  const blockerFamilyBacklog: Record<string, number> = {}
  const blockingFindingBacklog: Record<string, number> = {}
  const runtimeDeferredRowsByCohort = emptyCohortCounts()
  let runtimeDeferredRowsTotal = 0

  for (const row of rows) {
    byCurrentCorpusStatus[row.currentCorpusStatus] += 1
    byCohortLabel[row.cohortLabel] += 1
    byStorageKind[row.storageKind || 'unknown'] = (byStorageKind[row.storageKind || 'unknown'] || 0) + 1
    statusByCohort[row.cohortLabel][row.currentCorpusStatus] += 1

    if (row.currentCorpusStatus === 'verified_pass') continue

    for (const familyId of row.classificationEvidence.topBlockingResidualFamilyIds) {
      blockerFamilyBacklog[familyId] = (blockerFamilyBacklog[familyId] || 0) + 1
    }
    for (const findingKey of row.classificationEvidence.blockingFindingKeys) {
      blockingFindingBacklog[findingKey] = (blockingFindingBacklog[findingKey] || 0) + 1
    }
    if (row.stage3FigureDiagnostics.hasGenericTimeoutWording || row.stage4StructureDiagnostics.hasBoundedRuntimeWording) {
      runtimeDeferredRowsTotal += 1
      runtimeDeferredRowsByCohort[row.cohortLabel] += 1
    }
  }

  return {
    totalRows: rows.length,
    byCurrentCorpusStatus,
    byCohortLabel,
    byStorageKind,
    statusByCohort,
    verifiedPassRowsFromLedger: ledgerRowCount,
    remainingRowsExcludingVerifiedPass: rows.filter(row => row.currentCorpusStatus !== 'verified_pass').length,
    blockerFamilyBacklog: Object.fromEntries(Object.entries(blockerFamilyBacklog).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))),
    blockingFindingBacklog: Object.fromEntries(Object.entries(blockingFindingBacklog).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))),
    runtimeDeferredRows: {
      total: runtimeDeferredRowsTotal,
      byCohortLabel: runtimeDeferredRowsByCohort,
    },
  }
}

function buildByCohort(rows: CorpusControlPlaneRow[]): CorpusControlPlaneArtifacts['byCohort'] {
  const cohorts = {
    short_high_likelihood: {
      totalRows: 0,
      byCurrentCorpusStatus: emptyStatusCounts(),
      samplePublicationIds: [] as string[],
    },
    figure_heavy: {
      totalRows: 0,
      byCurrentCorpusStatus: emptyStatusCounts(),
      samplePublicationIds: [] as string[],
    },
    structure_heavy: {
      totalRows: 0,
      byCurrentCorpusStatus: emptyStatusCounts(),
      samplePublicationIds: [] as string[],
    },
    font_heavy: {
      totalRows: 0,
      byCurrentCorpusStatus: emptyStatusCounts(),
      samplePublicationIds: [] as string[],
    },
    long_report: {
      totalRows: 0,
      byCurrentCorpusStatus: emptyStatusCounts(),
      samplePublicationIds: [] as string[],
    },
    manual_tail: {
      totalRows: 0,
      byCurrentCorpusStatus: emptyStatusCounts(),
      samplePublicationIds: [] as string[],
    },
  }

  for (const row of rows) {
    const bucket = cohorts[row.cohortLabel]
    bucket.totalRows += 1
    bucket.byCurrentCorpusStatus[row.currentCorpusStatus] += 1
    if (bucket.samplePublicationIds.length < 10) bucket.samplePublicationIds.push(row.publicationId)
  }

  return {
    generatedAt: new Date().toISOString(),
    cohorts,
  }
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

function benchmarkCategoryByPublicationId(sources: CorpusControlPlaneSources): Map<string, BenchmarkCategory> {
  const publicationIdByLocalPath = new Map<string, string>()
  for (const row of sources.replacementMap) {
    const localPath = row.checksumState?.localCurrentFilePath
    if (localPath) publicationIdByLocalPath.set(localPath, row.publicationId)
  }

  const categoryByPublicationId = new Map<string, BenchmarkCategory>()
  for (const outcome of sources.regressionBenchmarkOutcomes) {
    const publicationId = publicationIdByLocalPath.get(outcome.filePath)
    if (!publicationId) continue
    const category = outcome.category === 'structure'
      ? 'structure'
      : outcome.category === 'long_report'
        ? 'long_report'
        : outcome.category === 'figure'
          ? 'figure'
          : null
    if (category) categoryByPublicationId.set(publicationId, category)
  }
  return categoryByPublicationId
}

function determineEscalatedCohort(row: CorpusControlPlaneRow, benchmarkCategory: BenchmarkCategory): { cohort: CohortLabel | null; reason: string | null } {
  if (row.cohortLabel !== 'short_high_likelihood' || row.currentCorpusStatus === 'verified_pass') {
    return { cohort: null, reason: null }
  }

  const stage4TerminalSurvivorClass = row.stage4StructureDiagnostics.terminalSurvivorClass
  if (stage4TerminalSurvivorClass) {
    const escalatedCohort = STAGE4_STRUCTURE_TERMINAL_SURVIVOR_TO_STAGE2_COHORT[stage4TerminalSurvivorClass] || 'structure_heavy'
    return {
      cohort: escalatedCohort,
      reason: `stage2:stage4_terminal_survivor_${stage4TerminalSurvivorClass}`,
    }
  }

  const isOperationalRetry = row.reasonCodes.includes('stage2:operational_retry_after_tempdir_failure')
  if (isOperationalRetry) {
    if ((row.classificationEvidence.pageCount || 0) >= LONG_REPORT_PAGE_THRESHOLD || row.classificationEvidence.isScanned) {
      return { cohort: 'long_report', reason: 'stage2:operational_retry_not_short_profile' }
    }
    return { cohort: null, reason: null }
  }

  if (benchmarkCategory === 'structure') return { cohort: 'structure_heavy', reason: 'stage2:benchmark_structure' }
  if (benchmarkCategory === 'figure') return { cohort: 'figure_heavy', reason: 'stage2:benchmark_figure' }
  if (benchmarkCategory === 'long_report') return { cohort: 'long_report', reason: 'stage2:benchmark_long_report' }

  const blockingText = [
    ...row.classificationEvidence.topBlockingResidualFamilyIds,
    ...row.classificationEvidence.blockingFindingKeys,
    ...row.notes,
  ].join(' ')

  if ((row.classificationEvidence.manualOnlyFailureModeCount || 0) > 0 || row.classificationEvidence.isScanned) {
    return { cohort: 'manual_tail', reason: 'stage2:manual_or_scanned_tail' }
  }

  if (FIGURE_FAMILY_PATTERN.test(blockingText)) return { cohort: 'figure_heavy', reason: 'stage2:figure_residuals' }
  if (STRUCTURE_FAMILY_PATTERN.test(blockingText)) return { cohort: 'structure_heavy', reason: 'stage2:structure_residuals' }
  if (FONT_FAMILY_PATTERN.test(blockingText)) return { cohort: 'font_heavy', reason: 'stage2:font_residuals' }

  if ((row.classificationEvidence.pageCount || 0) >= LONG_REPORT_PAGE_THRESHOLD) {
    return { cohort: 'long_report', reason: 'stage2:long_report_page_count' }
  }

  if (ANNUAL_REPORT_TITLE_PATTERN.test(row.title || '') && (row.classificationEvidence.pageCount || 0) >= 24) {
    return { cohort: 'long_report', reason: 'stage2:annual_report_escalation' }
  }

  if (
    row.currentCorpusStatus === 'processing_error'
    && (row.classificationEvidence.autoRunnableOpportunityCount || 0) <= 0
  ) {
    return { cohort: 'manual_tail', reason: 'stage2:bounded_processing_error_tail' }
  }

  return { cohort: null, reason: null }
}

export function applyStage2ShortCohortReclassification(
  artifacts: CorpusControlPlaneArtifacts,
  sources: CorpusControlPlaneSources,
): CorpusControlPlaneArtifacts {
  const benchmarkByPublicationId = benchmarkCategoryByPublicationId(sources)

  const rows = artifacts.document.rows.map(row => {
    const reclassified = determineEscalatedCohort(row, benchmarkByPublicationId.get(row.publicationId) || null)
    if (!reclassified.cohort || reclassified.cohort === row.cohortLabel) return row
    return {
      ...row,
      cohortLabel: reclassified.cohort,
      reasonCodes: uniqueStrings([
        ...row.reasonCodes,
        'stage2:reclassified_from_short_high_likelihood',
        reclassified.reason,
      ]),
      notes: uniqueStrings([
        ...row.notes,
        `Stage 2 reclassified this row from short_high_likelihood to ${reclassified.cohort}.`,
      ]),
    }
  })

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

function safeNumber(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

function selectionBucketFor(row: CorpusControlPlaneRow): 'analyzed' | 'processing_error' | 'remediated_fail' {
  if (row.currentCorpusStatus === 'analyzed') return 'analyzed'
  if (row.currentCorpusStatus === 'processing_error') return 'processing_error'
  return 'remediated_fail'
}

function compareWaveRows(left: CorpusControlPlaneRow, right: CorpusControlPlaneRow): number {
  const bucketRank = { analyzed: 0, processing_error: 1, remediated_fail: 2 } as const
  const leftBucket = selectionBucketFor(left)
  const rightBucket = selectionBucketFor(right)
  if (bucketRank[leftBucket] !== bucketRank[rightBucket]) return bucketRank[leftBucket] - bucketRank[rightBucket]

  const blockerDiff = safeNumber(left.classificationEvidence.blockerFamilyCount, 0) - safeNumber(right.classificationEvidence.blockerFamilyCount, 0)
  if (blockerDiff !== 0) return blockerDiff

  const pageDiff = safeNumber(left.classificationEvidence.pageCount, Number.MAX_SAFE_INTEGER) - safeNumber(right.classificationEvidence.pageCount, Number.MAX_SAFE_INTEGER)
  if (pageDiff !== 0) return pageDiff

  const scannedDiff = Number(Boolean(left.classificationEvidence.isScanned)) - Number(Boolean(right.classificationEvidence.isScanned))
  if (scannedDiff !== 0) return scannedDiff

  const autoRunnableDiff = safeNumber(right.classificationEvidence.autoRunnableOpportunityCount, 0) - safeNumber(left.classificationEvidence.autoRunnableOpportunityCount, 0)
  if (autoRunnableDiff !== 0) return autoRunnableDiff

  return left.publicationId.localeCompare(right.publicationId)
}

function computePassLikelihoodScore(row: CorpusControlPlaneRow): number {
  const bucket = selectionBucketFor(row)
  const base = bucket === 'analyzed' ? 96 : bucket === 'processing_error' ? 82 : 68
  const autoRunnableBonus = Math.min(12, safeNumber(row.classificationEvidence.autoRunnableOpportunityCount, 0) * 2)
  const pagePenalty = Math.min(18, Math.floor(safeNumber(row.classificationEvidence.pageCount, 0) / 6))
  const blockerPenalty = Math.min(20, safeNumber(row.classificationEvidence.blockerFamilyCount, 0) * 4)
  const scannedPenalty = row.classificationEvidence.isScanned ? 15 : 0
  return Math.max(1, Math.min(99, base + autoRunnableBonus - pagePenalty - blockerPenalty - scannedPenalty))
}

function heuristicReasonsForRow(row: CorpusControlPlaneRow): string[] {
  const reasons = [
    `stage2_bucket:${selectionBucketFor(row)}`,
    ...row.reasonCodes,
  ]
  if ((row.classificationEvidence.blockerFamilyCount || 0) === 0) reasons.push('low_blocker_family_count')
  if ((row.classificationEvidence.pageCount || 0) > 0 && (row.classificationEvidence.pageCount || 0) <= 12) reasons.push('short_page_count')
  if (row.currentCorpusStatus === 'processing_error') reasons.push('retry_after_bounded_processing_error')
  if (row.currentCorpusStatus === 'analyzed') reasons.push('no_prior_remediation_attempt_recorded')
  return uniqueStrings(reasons)
}

function loadJsonIfExists<T>(filePath: string | null): T | null {
  if (!filePath || !fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function pendingPublicationIdsFromExistingArtifacts(
  waveDoc: Stage2ShortCohortWaveDocument | null,
  outcomesDoc: { outcomes?: OutcomeLike[] } | null,
): string[] {
  if (!waveDoc) return []
  const completed = new Set((outcomesDoc?.outcomes || []).map(outcome => outcome.publicationId).filter((value): value is string => Boolean(value)))
  return waveDoc.selectedPublicationIds.filter(publicationId => !completed.has(publicationId))
}

export function buildStage2ShortCohortWaveArtifacts(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manifestsRoot: string
  maxCandidates?: number
}): {
  wave: Stage2ShortCohortWaveDocument
  summary: Stage2ShortCohortWaveSummaryDocument
} {
  const maxCandidates = Math.max(1, input.maxCandidates || 8)
  const currentWavePath = path.join(input.manifestsRoot, 'stage2-short-cohort-wave.json')
  const currentOutcomesPath = path.join(input.manifestsRoot, 'stage2-short-cohort-wave.outcomes.json')
  const existingWave = loadJsonIfExists<Stage2ShortCohortWaveDocument>(currentWavePath)
  const existingOutcomes = loadJsonIfExists<{ outcomes?: OutcomeLike[] }>(currentOutcomesPath)
  const activeEligiblePublicationIds = new Set(
    input.artifacts.document.rows
      .filter(row => row.cohortLabel === 'short_high_likelihood' && row.currentCorpusStatus !== 'verified_pass')
      .map(row => row.publicationId),
  )
  const pendingPublicationIds = pendingPublicationIdsFromExistingArtifacts(existingWave, existingOutcomes)
    .filter(publicationId => activeEligiblePublicationIds.has(publicationId))
  if (existingWave && pendingPublicationIds.length > 0) {
    const selectedByTier = { highest: 0, high: 0, medium: 0 }
    const selectedByStatus = emptyStatusCounts()
    for (const candidate of existingWave.candidates) {
      selectedByTier[candidate.priorityTier] += 1
      selectedByStatus[candidate.currentCorpusStatus] += 1
    }

    return {
      wave: {
        ...existingWave,
        pendingPublicationIds,
        totals: {
          ...existingWave.totals,
          pendingRows: pendingPublicationIds.length,
        },
      },
      summary: {
        generatedAt: new Date().toISOString(),
        waveManifestPath: currentWavePath,
        sourceControlPlanePath: existingWave.sourceControlPlanePath,
        sourceControlPlaneGeneratedAt: existingWave.sourceControlPlaneGeneratedAt,
        totals: {
          ...existingWave.totals,
          pendingRows: pendingPublicationIds.length,
        },
        selectedPublicationIds: existingWave.selectedPublicationIds,
        pendingPublicationIds,
        selectedByTier,
        selectedByStatus,
      },
    }
  }

  const pendingSet = new Set(pendingPublicationIds)

  const stage2Rows = input.artifacts.document.rows
    .filter(row => row.cohortLabel === 'short_high_likelihood' && row.currentCorpusStatus !== 'verified_pass')
    .sort(compareWaveRows)

  const skippedRows: Stage2ShortCohortWaveSkippedRow[] = []
  const eligibleRows: CorpusControlPlaneRow[] = []
  for (const row of stage2Rows) {
    const skipReasons: string[] = []
    if (pendingSet.has(row.publicationId)) skipReasons.push('already_in_pending_stage2_wave')
    if (!row.sourceMetadata.currentSourcePath) skipReasons.push('missing_local_source_path')
    if (!row.remotePath) skipReasons.push('missing_remote_path')
    if (skipReasons.length) {
      skippedRows.push({
        publicationId: row.publicationId,
        publicationTitle: row.title,
        currentCorpusStatus: row.currentCorpusStatus,
        currentCohortLabel: row.cohortLabel,
        skipReasons,
      })
      continue
    }
    eligibleRows.push(row)
  }

  const selectedRows = eligibleRows.slice(0, maxCandidates)
  const overflowRows = eligibleRows.slice(maxCandidates)
  for (const row of overflowRows) {
    skippedRows.push({
      publicationId: row.publicationId,
      publicationTitle: row.title,
      currentCorpusStatus: row.currentCorpusStatus,
      currentCohortLabel: row.cohortLabel,
      skipReasons: ['not_in_current_wave_capacity'],
    })
  }

  const candidates: Stage2ShortCohortWaveCandidate[] = selectedRows.map((row, index) => {
    const bucket = selectionBucketFor(row)
    const priorityTier = bucket === 'analyzed' ? 'highest' : bucket === 'processing_error' ? 'high' : 'medium'
    return {
      priorityRank: index + 1,
      passLikelihoodScore: computePassLikelihoodScore(row),
      priorityTier,
      recommendedAction: 'fix_first',
      publicationId: row.publicationId,
      publicationTitle: row.title,
      serverHost: row.serverHost,
      remotePath: row.remotePath,
      localCachePath: row.sourceMetadata.currentSourcePath,
      fileUrl: row.fileUrl,
      storageKind: row.storageKind,
      overallScore: safeNumber(row.classificationEvidence.overallScore, 0),
      grade: row.classificationEvidence.grade || 'unknown',
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
      heuristicReasons: heuristicReasonsForRow(row),
      reportPath: row.statusEvidence.latestReportPath || row.statusEvidence.verificationReportPath || input.sourceControlPlanePath,
      currentCorpusStatus: row.currentCorpusStatus,
      currentCohortLabel: row.cohortLabel,
      selectionBucket: bucket,
      selectionReasons: uniqueStrings([
        `selection_bucket:${bucket}`,
        ...(bucket === 'analyzed' ? ['prefer_unattempted_short_candidate'] : []),
        ...(bucket === 'processing_error' ? ['retry_non_manual_processing_error'] : []),
        ...(bucket === 'remediated_fail' ? ['retry_low_risk_remediated_fail'] : []),
        ...heuristicReasonsForRow(row),
      ]),
    }
  })

  const wave: Stage2ShortCohortWaveDocument = {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    waveName: 'stage2-short-cohort-wave',
    cohortLabel: 'short_high_likelihood',
    maxCandidates,
    totals: {
      eligibleRows: eligibleRows.length,
      selectedRows: candidates.length,
      skippedRows: skippedRows.length,
      pendingRows: pendingPublicationIds.length,
    },
    selectedPublicationIds: candidates.map(candidate => candidate.publicationId).filter((value): value is string => Boolean(value)),
    pendingPublicationIds,
    candidates,
    skippedRows: skippedRows.sort((left, right) => left.publicationId.localeCompare(right.publicationId)),
  }

  const selectedByTier = { highest: 0, high: 0, medium: 0 }
  const selectedByStatus = emptyStatusCounts()
  for (const candidate of candidates) {
    selectedByTier[candidate.priorityTier] += 1
    selectedByStatus[candidate.currentCorpusStatus] += 1
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
      pendingPublicationIds,
      selectedByTier,
      selectedByStatus,
    },
  }
}

export function buildStage2ShortCohortThroughputSummary(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  waveManifestPath: string
  wave: Stage2ShortCohortWaveDocument | null
  outcomesPath: string | null
  outcomes: { outcomes?: OutcomeLike[] } | null
}): Stage2ShortCohortThroughputSummaryDocument {
  const shortRows = input.artifacts.document.rows.filter(row => row.cohortLabel === 'short_high_likelihood')
  const waveIds = new Set(input.wave?.selectedPublicationIds || [])
  const rowsById = new Map(input.artifacts.document.rows.map(row => [row.publicationId, row]))

  const newlyVerifiedPassPublicationIds = Array.from(waveIds)
    .filter(publicationId => {
      const row = rowsById.get(publicationId)
      return Boolean(row?.currentCorpusStatus === 'verified_pass' && row.promotionTruth.ledgerRowPresent)
    })
    .sort()

  const reclassifiedPublicationIds = Array.from(waveIds)
    .filter(publicationId => {
      const row = rowsById.get(publicationId)
      return Boolean(row && row.cohortLabel !== 'short_high_likelihood' && row.currentCorpusStatus !== 'verified_pass')
    })
    .sort()

  const remainingPublicationIds = shortRows
    .filter(row => row.currentCorpusStatus !== 'verified_pass')
    .map(row => row.publicationId)
    .sort()

  const processingErrorPublicationIds = uniqueStrings(
    (input.outcomes?.outcomes || [])
      .filter(outcome => outcome.status === 'processing_error')
      .map(outcome => outcome.publicationId),
  )
  const hardFailPublicationIds = uniqueStrings(
    (input.outcomes?.outcomes || [])
      .filter(outcome => outcome.status === 'failed_after_remediation')
      .map(outcome => outcome.publicationId),
  )
  const completedWaveIds = new Set((input.outcomes?.outcomes || []).map(outcome => outcome.publicationId).filter((value): value is string => Boolean(value)))
  const pendingPublicationIds = (input.wave?.selectedPublicationIds || []).filter(publicationId => !completedWaveIds.has(publicationId)).sort()

  return {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    waveManifestPath: input.waveManifestPath,
    waveOutcomesPath: input.outcomesPath,
    cohortLabel: 'short_high_likelihood',
    totals: {
      totalRowsInCohort: shortRows.length,
      verifiedPassRowsInCohort: shortRows.filter(row => row.currentCorpusStatus === 'verified_pass').length,
      newlyVerifiedPassRowsFromWave: newlyVerifiedPassPublicationIds.length,
      remainingRowsInCohort: remainingPublicationIds.length,
      reclassifiedOutOfCohort: reclassifiedPublicationIds.length,
      processingErrorsInWave: processingErrorPublicationIds.length,
      hardFailsInWave: hardFailPublicationIds.length,
      pendingWaveRows: pendingPublicationIds.length,
    },
    rows: {
      newlyVerifiedPassPublicationIds,
      remainingPublicationIds,
      reclassifiedPublicationIds,
      processingErrorPublicationIds,
      hardFailPublicationIds,
      pendingPublicationIds,
    },
  }
}
