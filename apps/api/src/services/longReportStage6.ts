import fs from 'node:fs'
import path from 'node:path'
import type {
  CorpusControlPlaneArtifacts,
  CorpusControlPlaneRow,
  CorpusStatus,
} from './corpusControlPlane.ts'

export type Stage6LongReportDisposition =
  | 'long_report_verified_pass'
  | 'long_report_stable_hard_fail'
  | 'long_report_processing_retry'
  | 'long_report_mixed_residual'
  | 'long_report_remediation_candidate'

export interface Stage6LongReportForensicsRow {
  publicationId: string
  publicationTitle: string | null
  currentCorpusStatus: CorpusStatus
  currentCohortLabel: string
  forensicsDisposition: Stage6LongReportDisposition
  blockingFindingKeys: readonly string[]
  reportFindingKeys: readonly string[]
  reasonCodes: readonly string[]
  latestReportPath: string | null
  notes: readonly string[]
}

export interface Stage6LongReportForensicsDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  cohortLabel: 'long_report'
  includePublicationIds: string[]
  summaryPath: string
  rows: Stage6LongReportForensicsRow[]
}

export interface Stage6LongReportForensicsSummaryDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  forensicsManifestPath: string
  cohortLabel: 'long_report'
  totals: {
    totalLongReportRows: number
    analyzedRows: number
    stillUnclassifiedRows: number
  }
  publicationIdsByDisposition: Record<Stage6LongReportDisposition, string[]>
  includePublicationIds: string[]
  stillUnclassifiedPublicationIds: string[]
}

export interface Stage6LongReportWaveCandidate {
  priorityRank: number
  priorityTier: 'highest' | 'high' | 'medium' | 'low'
  recommendedAction: 'fix_first' | 'manual_review'
  publicationId: string
  publicationTitle: string | null
  serverHost: string | null
  remotePath: string | null
  localCachePath: string | null
  fileUrl: string | null
  storageKind: string | null
  currentCorpusStatus: CorpusStatus
  stage6LongReportDisposition: Stage6LongReportDisposition
  selectionReasons: string[]
  reportPath: string | null
  pageCount: number
  isScanned: boolean
  overallScore: number | null
  grade: string | null
  blockingFindingKeys: string[]
}

export interface Stage6LongReportWaveSkippedRow {
  publicationId: string
  publicationTitle: string | null
  currentCorpusStatus: CorpusStatus
  stage6LongReportDisposition: Stage6LongReportDisposition | null
  skipReasons: string[]
}

export interface Stage6LongReportWaveDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  waveName: 'stage6-long-report-wave'
  cohortLabel: 'long_report'
  maxCandidates: number
  totals: {
    eligibleRows: number
    selectedRows: number
    skippedRows: number
    pendingRows: number
  }
  selectedPublicationIds: string[]
  pendingPublicationIds: string[]
  candidates: Stage6LongReportWaveCandidate[]
  skippedRows: Stage6LongReportWaveSkippedRow[]
}

export interface Stage6LongReportWaveSummaryDocument {
  generatedAt: string
  waveManifestPath: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  totals: Stage6LongReportWaveDocument['totals']
  selectedPublicationIds: string[]
  pendingPublicationIds: string[]
  selectedByTier: Record<'highest' | 'high' | 'medium' | 'low', number>
  selectedByStatus: Record<CorpusStatus, number>
  selectedByDisposition: Record<Stage6LongReportDisposition, number>
}

export interface Stage6LongReportThroughputSummaryDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  waveManifestPath: string
  waveOutcomesPath: string | null
  forensicsManifestPath: string
  cohortLabel: 'long_report'
  benchmarkLeadCase: {
    name: string
    category: 'long_report'
    terminalState: 'pass' | 'hard_fail' | 'processing_error'
    durationMs: number
    dominantFamily: 'structure' | 'figure' | 'mixed' | 'unknown' | null
    finalStopReason: 'same_family_no_progress' | 'no_mutation' | 'family_shifted' | 'budget_exhausted' | 'completed' | null
    processingError: boolean
  } | null
  totals: {
    totalLongReportRows: number
    verifiedPassRowsInCohort: number
    remainingLongReportRows: number
    newlyVerifiedPassRowsFromWave: number
    processingErrorsInWave: number
    hardFailsInWave: number
    pendingWaveRows: number
    verifiedPassDispositionRows: number
    stableHardFailRows: number
    processingRetryRows: number
    mixedResidualRows: number
    remediationCandidateRows: number
    stillUnclassifiedRows: number
  }
  rows: {
    newlyVerifiedPassPublicationIds: string[]
    remainingPublicationIds: string[]
    processingErrorPublicationIds: string[]
    hardFailPublicationIds: string[]
    pendingPublicationIds: string[]
    activeWaveSelectedPublicationIds: string[]
    verifiedPassDispositionPublicationIds: string[]
    stableHardFailPublicationIds: string[]
    processingRetryPublicationIds: string[]
    mixedResidualPublicationIds: string[]
    remediationCandidatePublicationIds: string[]
    stillUnclassifiedPublicationIds: string[]
  }
}

interface LocalStandardsFindingLike {
  key?: string | null
}

type OutcomeLike = {
  publicationId?: string | null
  status?: string | null
}

type ReportLike = {
  gate?: {
    blockingLocalFindingKeys?: string[] | null
  } | null
  result?: {
    localStandards?: {
      findings?: LocalStandardsFindingLike[] | null
    } | null
  } | null
}

type BenchmarkSummaryLike = {
  outcomes?: Array<{
    name?: string | null
    category?: string | null
    terminalState?: 'pass' | 'hard_fail' | 'processing_error'
    durationMs?: number | null
    residualCleanupDiagnostic?: {
      dominantFamily?: 'structure' | 'figure' | 'mixed' | 'unknown' | null
      finalStopReason?: 'same_family_no_progress' | 'no_mutation' | 'family_shifted' | 'budget_exhausted' | 'completed' | null
    } | null
  }>
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort()
}

function safeNumber(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

function readJsonIfExists<T>(filePath: string | null): T | null {
  if (!filePath || !fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function normalizeFindingKey(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function readLatestReport(row: CorpusControlPlaneRow): ReportLike | null {
  return readJsonIfExists<ReportLike>(row.statusEvidence.latestReportPath)
}

function terminalStatus(status: string | null | undefined): boolean {
  return ['failed_after_remediation', 'processing_error', 'ready_to_replace', 'remediated_pass_candidate', 'source_missing'].includes(status || '')
}

function pendingPublicationIdsFromExistingArtifacts(
  waveDoc: Stage6LongReportWaveDocument | null,
  outcomesDoc: { outcomes?: OutcomeLike[] } | null,
): string[] {
  if (!waveDoc) return []
  const completed = new Set(
    (outcomesDoc?.outcomes || [])
      .filter(outcome => terminalStatus(outcome.status))
      .map(outcome => outcome.publicationId)
      .filter((value): value is string => Boolean(value)),
  )
  return waveDoc.selectedPublicationIds.filter(publicationId => !completed.has(publicationId))
}

function compareForensicsRows(left: Stage6LongReportForensicsRow, right: Stage6LongReportForensicsRow, rowById: Map<string, CorpusControlPlaneRow>): number {
  const dispositionRank = {
    long_report_processing_retry: 0,
    long_report_mixed_residual: 1,
    long_report_remediation_candidate: 2,
    long_report_stable_hard_fail: 3,
    long_report_verified_pass: 4,
  } satisfies Record<Stage6LongReportDisposition, number>
  const dispositionDiff = dispositionRank[left.forensicsDisposition] - dispositionRank[right.forensicsDisposition]
  if (dispositionDiff !== 0) return dispositionDiff
  const leftRow = rowById.get(left.publicationId)
  const rightRow = rowById.get(right.publicationId)
  const pageDiff = safeNumber(rightRow?.classificationEvidence.pageCount, 0) - safeNumber(leftRow?.classificationEvidence.pageCount, 0)
  if (pageDiff !== 0) return pageDiff
  return left.publicationId.localeCompare(right.publicationId)
}

function priorityTierForDisposition(disposition: Stage6LongReportDisposition): 'highest' | 'high' | 'medium' | 'low' {
  return ({
    long_report_processing_retry: 'highest',
    long_report_mixed_residual: 'high',
    long_report_remediation_candidate: 'high',
    long_report_stable_hard_fail: 'low',
    long_report_verified_pass: 'low',
  } as const)[disposition]
}

function classifyLongReportDisposition(row: CorpusControlPlaneRow, reportFindingKeys: string[]): Stage6LongReportDisposition {
  if (row.currentCorpusStatus === 'verified_pass' && row.promotionTruth.ledgerRowPresent) return 'long_report_verified_pass'
  const blockingFindingKeys = row.classificationEvidence.blockingFindingKeys || []
  const combinedKeys = uniqueStrings([...blockingFindingKeys, ...reportFindingKeys])
  const hasFigureDebt = combinedKeys.includes('pdfua.figure_alt_or_artifact')
  const hasStructureDebt = combinedKeys.includes('pdfua.logical_structure')
  if (row.currentCorpusStatus === 'processing_error' || row.statusEvidence.outcomeStatus === 'processing_error') {
    return 'long_report_processing_retry'
  }
  if (hasFigureDebt && hasStructureDebt) return 'long_report_mixed_residual'
  const neverActuallyRemediated = !row.statusEvidence.outcomeStatus
  if (row.statusEvidence.verificationClassification === 'hard_fail' && neverActuallyRemediated && reportFindingKeys.length > 0) {
    return 'long_report_remediation_candidate'
  }
  if (row.statusEvidence.verificationClassification === 'hard_fail') return 'long_report_stable_hard_fail'
  return 'long_report_stable_hard_fail'
}

function benchmarkLeadCase(manifestsRoot: string): Stage6LongReportThroughputSummaryDocument['benchmarkLeadCase'] {
  const summary = readJsonIfExists<BenchmarkSummaryLike>(path.join(manifestsRoot, 'remediation-regression-benchmark.summary.json'))
  const entry = summary?.outcomes?.find(outcome => outcome.category === 'long_report')
  if (!entry?.name || !entry.terminalState || typeof entry.durationMs !== 'number') return null
  return {
    name: entry.name,
    category: 'long_report',
    terminalState: entry.terminalState,
    durationMs: entry.durationMs,
    dominantFamily: entry.residualCleanupDiagnostic?.dominantFamily || null,
    finalStopReason: entry.residualCleanupDiagnostic?.finalStopReason || null,
    processingError: entry.terminalState === 'processing_error',
  }
}

export function buildStage6LongReportForensicsArtifacts(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manifestsRoot: string
  includePublicationIds?: string[]
}): {
  document: Stage6LongReportForensicsDocument
  summary: Stage6LongReportForensicsSummaryDocument
} {
  const { artifacts, sourceControlPlanePath, sourceControlPlaneGeneratedAt, manifestsRoot, includePublicationIds = [] } = input
  const includeSet = new Set(includePublicationIds.filter(Boolean))
  const targetRows = artifacts.document.rows.filter(row =>
    row.cohortLabel === 'long_report'
    && (includeSet.size === 0 || includeSet.has(row.publicationId)),
  )

  const rows = targetRows.map(row => {
    const report = readLatestReport(row)
    const reportFindings = (report?.result?.localStandards?.findings || []).filter(Boolean)
    const reportFindingKeys = uniqueStrings(reportFindings.map(finding => normalizeFindingKey(finding.key)))
    const blockingFindingKeys = uniqueStrings([
      ...(row.classificationEvidence.blockingFindingKeys || []),
      ...((report?.gate?.blockingLocalFindingKeys || []).filter(Boolean)),
    ])
    const disposition = classifyLongReportDisposition(row, reportFindingKeys)
    return {
      publicationId: row.publicationId,
      publicationTitle: row.title,
      currentCorpusStatus: row.currentCorpusStatus,
      currentCohortLabel: row.cohortLabel,
      forensicsDisposition: disposition,
      blockingFindingKeys,
      reportFindingKeys,
      reasonCodes: uniqueStrings([
        ...row.reasonCodes,
        `stage6:${disposition}`,
      ]),
      latestReportPath: row.statusEvidence.latestReportPath,
      notes: uniqueStrings([
        row.statusEvidence.verificationClassification ? `verification:${row.statusEvidence.verificationClassification}` : null,
        row.statusEvidence.outcomeStatus ? `outcome:${row.statusEvidence.outcomeStatus}` : null,
      ]),
    } satisfies Stage6LongReportForensicsRow
  }).sort((left, right) => left.publicationId.localeCompare(right.publicationId))

  const publicationIdsByDisposition = {
    long_report_verified_pass: uniqueStrings(rows.filter(row => row.forensicsDisposition === 'long_report_verified_pass').map(row => row.publicationId)),
    long_report_stable_hard_fail: uniqueStrings(rows.filter(row => row.forensicsDisposition === 'long_report_stable_hard_fail').map(row => row.publicationId)),
    long_report_processing_retry: uniqueStrings(rows.filter(row => row.forensicsDisposition === 'long_report_processing_retry').map(row => row.publicationId)),
    long_report_mixed_residual: uniqueStrings(rows.filter(row => row.forensicsDisposition === 'long_report_mixed_residual').map(row => row.publicationId)),
    long_report_remediation_candidate: uniqueStrings(rows.filter(row => row.forensicsDisposition === 'long_report_remediation_candidate').map(row => row.publicationId)),
  } satisfies Record<Stage6LongReportDisposition, string[]>

  const allLongReportIds = artifacts.document.rows
    .filter(row => row.cohortLabel === 'long_report' && (includeSet.size === 0 || includeSet.has(row.publicationId)))
    .map(row => row.publicationId)
  const classifiedIds = new Set(rows.map(row => row.publicationId))
  const stillUnclassifiedPublicationIds = uniqueStrings(allLongReportIds.filter(publicationId => !classifiedIds.has(publicationId)))

  const document: Stage6LongReportForensicsDocument = {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt,
    cohortLabel: 'long_report',
    includePublicationIds: uniqueStrings(includePublicationIds),
    summaryPath: path.join(manifestsRoot, 'stage6-long-report-forensics.summary.json'),
    rows,
  }

  const summary: Stage6LongReportForensicsSummaryDocument = {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt,
    forensicsManifestPath: path.join(manifestsRoot, 'stage6-long-report-forensics.json'),
    cohortLabel: 'long_report',
    totals: {
      totalLongReportRows: artifacts.document.rows.filter(row => row.cohortLabel === 'long_report').length,
      analyzedRows: rows.length,
      stillUnclassifiedRows: stillUnclassifiedPublicationIds.length,
    },
    publicationIdsByDisposition,
    includePublicationIds: uniqueStrings(includePublicationIds),
    stillUnclassifiedPublicationIds,
  }

  return { document, summary }
}

export function buildStage6LongReportWaveArtifacts(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manifestsRoot: string
  maxCandidates: number
  forensicsRows: Stage6LongReportForensicsRow[]
  includePublicationIds?: string[]
}): {
  wave: Stage6LongReportWaveDocument
  summary: Stage6LongReportWaveSummaryDocument
} {
  const { artifacts, sourceControlPlanePath, sourceControlPlaneGeneratedAt, manifestsRoot, maxCandidates, forensicsRows, includePublicationIds = [] } = input
  const includeSet = new Set(includePublicationIds.filter(Boolean))
  const rowsById = new Map(artifacts.document.rows.map(row => [row.publicationId, row]))
  const forensicsById = new Map(forensicsRows.map(row => [row.publicationId, row]))
  const wavePath = path.join(manifestsRoot, 'stage6-long-report-wave.json')
  const outcomesPath = path.join(manifestsRoot, 'stage6-long-report-wave.outcomes.json')
  const existingWave = readJsonIfExists<Stage6LongReportWaveDocument>(wavePath)
  const existingOutcomes = readJsonIfExists<{ outcomes?: OutcomeLike[] }>(outcomesPath)

  const pendingPublicationIds = pendingPublicationIdsFromExistingArtifacts(existingWave, existingOutcomes)
    .filter(publicationId => {
      const row = rowsById.get(publicationId)
      return Boolean(row && row.cohortLabel === 'long_report' && row.currentCorpusStatus !== 'verified_pass')
    })

  const eligibleForensics = forensicsRows
    .filter(forensics => {
      const row = rowsById.get(forensics.publicationId)
      return Boolean(
        row
        && row.cohortLabel === 'long_report'
        && row.currentCorpusStatus !== 'verified_pass'
        && forensics.forensicsDisposition !== 'long_report_stable_hard_fail'
        && forensics.forensicsDisposition !== 'long_report_verified_pass'
        && (includeSet.size === 0 || includeSet.has(forensics.publicationId)),
      )
    })
    .sort((left, right) => compareForensicsRows(left, right, rowsById))

  const selectedPublicationIds: string[] = []
  for (const publicationId of pendingPublicationIds) {
    if (selectedPublicationIds.includes(publicationId)) continue
    if (selectedPublicationIds.length >= maxCandidates) break
    selectedPublicationIds.push(publicationId)
  }
  for (const forensics of eligibleForensics) {
    if (selectedPublicationIds.includes(forensics.publicationId)) continue
    if (selectedPublicationIds.length >= maxCandidates) break
    selectedPublicationIds.push(forensics.publicationId)
  }

  const candidates = selectedPublicationIds.map((publicationId, index) => {
    const row = rowsById.get(publicationId)!
    const forensics = forensicsById.get(publicationId)
    const disposition = forensics?.forensicsDisposition || 'long_report_stable_hard_fail'
    return {
      priorityRank: index + 1,
      priorityTier: priorityTierForDisposition(disposition),
      recommendedAction: disposition === 'long_report_processing_retry' ? 'fix_first' : 'manual_review',
      publicationId,
      publicationTitle: row.title,
      serverHost: row.serverHost,
      remotePath: row.remotePath,
      localCachePath: row.sourceMetadata.currentSourcePath,
      fileUrl: row.fileUrl,
      storageKind: row.storageKind,
      currentCorpusStatus: row.currentCorpusStatus,
      stage6LongReportDisposition: disposition,
      selectionReasons: uniqueStrings([`stage6:${disposition}`, ...(forensics?.reasonCodes || [])]),
      reportPath: row.statusEvidence.latestReportPath,
      pageCount: safeNumber(row.classificationEvidence.pageCount, 0),
      isScanned: Boolean(row.classificationEvidence.isScanned),
      overallScore: row.classificationEvidence.overallScore,
      grade: row.classificationEvidence.grade,
      blockingFindingKeys: row.classificationEvidence.blockingFindingKeys || [],
    } satisfies Stage6LongReportWaveCandidate
  })

  const skippedRows = artifacts.document.rows
    .filter(row => row.cohortLabel === 'long_report' && (includeSet.size === 0 || includeSet.has(row.publicationId)))
    .filter(row => !selectedPublicationIds.includes(row.publicationId))
    .map(row => {
      const forensics = forensicsById.get(row.publicationId)
      const skipReasons = row.currentCorpusStatus === 'verified_pass'
        ? ['already_verified_pass']
        : forensics?.forensicsDisposition === 'long_report_stable_hard_fail'
          ? ['stage6:stable_hard_fail_not_selected']
        : forensics?.forensicsDisposition === 'long_report_verified_pass'
          ? ['stage6:verified_pass_not_selected']
          : ['not_selected_in_current_wave']
      return {
        publicationId: row.publicationId,
        publicationTitle: row.title,
        currentCorpusStatus: row.currentCorpusStatus,
        stage6LongReportDisposition: forensics?.forensicsDisposition || null,
        skipReasons,
      } satisfies Stage6LongReportWaveSkippedRow
    })
    .sort((left, right) => left.publicationId.localeCompare(right.publicationId))

  const wave: Stage6LongReportWaveDocument = {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt,
    waveName: 'stage6-long-report-wave',
    cohortLabel: 'long_report',
    maxCandidates,
    totals: {
      eligibleRows: eligibleForensics.length,
      selectedRows: selectedPublicationIds.length,
      skippedRows: skippedRows.length,
      pendingRows: pendingPublicationIds.filter(publicationId => selectedPublicationIds.includes(publicationId)).length,
    },
    selectedPublicationIds,
    pendingPublicationIds: pendingPublicationIds.filter(publicationId => selectedPublicationIds.includes(publicationId)),
    candidates,
    skippedRows,
  }

  const selectedByTier = { highest: 0, high: 0, medium: 0, low: 0 } as Record<'highest' | 'high' | 'medium' | 'low', number>
  const selectedByStatus = {
    verified_pass: 0,
    discovered: 0,
    analyzed: 0,
    queued_for_remediation: 0,
    remediated_fail: 0,
    processing_error: 0,
    deferred_manual: 0,
    staged_for_replacement: 0,
    replaced_remote: 0,
  } as Record<CorpusStatus, number>
  const selectedByDisposition = {
    long_report_verified_pass: 0,
    long_report_stable_hard_fail: 0,
    long_report_processing_retry: 0,
    long_report_mixed_residual: 0,
    long_report_remediation_candidate: 0,
  } as Record<Stage6LongReportDisposition, number>
  for (const candidate of candidates) {
    selectedByTier[candidate.priorityTier] += 1
    selectedByStatus[candidate.currentCorpusStatus] += 1
    selectedByDisposition[candidate.stage6LongReportDisposition] += 1
  }

  return {
    wave,
    summary: {
      generatedAt: new Date().toISOString(),
      waveManifestPath: wavePath,
      sourceControlPlanePath,
      sourceControlPlaneGeneratedAt,
      totals: wave.totals,
      selectedPublicationIds: wave.selectedPublicationIds,
      pendingPublicationIds: wave.pendingPublicationIds,
      selectedByTier,
      selectedByStatus,
      selectedByDisposition,
    },
  }
}

export function buildStage6LongReportThroughputSummary(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manifestsRoot: string
  waveManifestPath: string
  wave: Stage6LongReportWaveDocument
  waveOutcomesPath: string | null
  outcomes: { outcomes?: OutcomeLike[] } | null
  forensicsManifestPath: string
  forensicsRows: Stage6LongReportForensicsRow[]
}): Stage6LongReportThroughputSummaryDocument {
  const { artifacts, sourceControlPlanePath, sourceControlPlaneGeneratedAt, manifestsRoot, waveManifestPath, wave, waveOutcomesPath, outcomes, forensicsManifestPath, forensicsRows } = input
  const longRows = artifacts.document.rows.filter(row => row.cohortLabel === 'long_report')
  const outcomeById = new Map((outcomes?.outcomes || []).map(outcome => [outcome.publicationId, outcome.status]))
  const verifiedPassPublicationIds = uniqueStrings(longRows.filter(row => row.currentCorpusStatus === 'verified_pass').map(row => row.publicationId))
  const remainingPublicationIds = uniqueStrings(longRows.filter(row => row.currentCorpusStatus !== 'verified_pass').map(row => row.publicationId))
  const newlyVerifiedPassPublicationIds = uniqueStrings(wave.selectedPublicationIds.filter(publicationId => verifiedPassPublicationIds.includes(publicationId)))
  const processingErrorPublicationIds = uniqueStrings(wave.selectedPublicationIds.filter(publicationId => outcomeById.get(publicationId) === 'processing_error'))
  const hardFailPublicationIds = uniqueStrings(wave.selectedPublicationIds.filter(publicationId => outcomeById.get(publicationId) === 'failed_after_remediation'))
  const pendingPublicationIds = uniqueStrings(wave.selectedPublicationIds.filter(publicationId => !outcomeById.has(publicationId)))
  const verifiedPassDispositionPublicationIds = uniqueStrings(forensicsRows.filter(row => row.forensicsDisposition === 'long_report_verified_pass').map(row => row.publicationId))
  const stableHardFailPublicationIds = uniqueStrings(forensicsRows.filter(row => row.forensicsDisposition === 'long_report_stable_hard_fail').map(row => row.publicationId))
  const processingRetryPublicationIds = uniqueStrings(forensicsRows.filter(row => row.forensicsDisposition === 'long_report_processing_retry').map(row => row.publicationId))
  const mixedResidualPublicationIds = uniqueStrings(forensicsRows.filter(row => row.forensicsDisposition === 'long_report_mixed_residual').map(row => row.publicationId))
  const remediationCandidatePublicationIds = uniqueStrings(forensicsRows.filter(row => row.forensicsDisposition === 'long_report_remediation_candidate').map(row => row.publicationId))
  const stillUnclassifiedPublicationIds = uniqueStrings(longRows.filter(row => !forensicsRows.some(forensics => forensics.publicationId === row.publicationId) && row.currentCorpusStatus !== 'verified_pass').map(row => row.publicationId))

  return {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt,
    waveManifestPath,
    waveOutcomesPath,
    forensicsManifestPath,
    cohortLabel: 'long_report',
    benchmarkLeadCase: benchmarkLeadCase(manifestsRoot),
    totals: {
      totalLongReportRows: longRows.length,
      verifiedPassRowsInCohort: verifiedPassPublicationIds.length,
      remainingLongReportRows: remainingPublicationIds.length,
      newlyVerifiedPassRowsFromWave: newlyVerifiedPassPublicationIds.length,
      processingErrorsInWave: processingErrorPublicationIds.length,
      hardFailsInWave: hardFailPublicationIds.length,
      pendingWaveRows: pendingPublicationIds.length,
      verifiedPassDispositionRows: verifiedPassDispositionPublicationIds.length,
      stableHardFailRows: stableHardFailPublicationIds.length,
      processingRetryRows: processingRetryPublicationIds.length,
      mixedResidualRows: mixedResidualPublicationIds.length,
      remediationCandidateRows: remediationCandidatePublicationIds.length,
      stillUnclassifiedRows: stillUnclassifiedPublicationIds.length,
    },
    rows: {
      newlyVerifiedPassPublicationIds,
      remainingPublicationIds,
      processingErrorPublicationIds,
      hardFailPublicationIds,
      pendingPublicationIds,
      activeWaveSelectedPublicationIds: wave.selectedPublicationIds,
      verifiedPassDispositionPublicationIds,
      stableHardFailPublicationIds,
      processingRetryPublicationIds,
      mixedResidualPublicationIds,
      remediationCandidatePublicationIds,
      stillUnclassifiedPublicationIds,
    },
  }
}
