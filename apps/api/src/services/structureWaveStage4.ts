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
  Stage4ActiveAnalysisDisposition,
  Stage4PendingAnalysisDisposition,
  Stage4PendingAnalysisEvidenceStrength,
  Stage4StalledAnalysisDisposition,
  Stage4OverlapAnalysisDisposition,
  Stage4ActiveForensicsDisposition,
  Stage4TerminalSurvivorClass,
  StructureWaveBucket,
} from './corpusControlPlane.ts'

export interface Stage4StructureWaveCandidate {
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
  structureWaveBucket: StructureWaveBucket
  selectionReasons: string[]
  reportPath: string
  pageCount: number
  isScanned: boolean
  blockerFamilyCount: number
  blockingFindingCount: number
  topBlockingResidualFamilyIds: string[]
  blockingFindingKeys: string[]
  dominantStructurePhase: string | null
  hasLogicalStructureDebt: boolean | null
  hasHeadingDebt: boolean | null
  hasReadingOrderDebt: boolean | null
  hasMetadataNavigationDebt: boolean | null
  hasMixedFigureResiduals: boolean | null
  hasBoundedRuntimeWording: boolean
  originLane: 'native_structure_heavy' | 'reclassified_from_figure_heavy' | 'reclassified_from_short_high_likelihood'
}

export interface Stage4StructureWaveSkippedRow {
  publicationId: string
  publicationTitle: string | null
  currentCorpusStatus: CorpusStatus
  structureWaveBucket: StructureWaveBucket | null
  skipReasons: string[]
}

export interface Stage4StructureWaveDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  waveName: 'stage4-structure-wave'
  cohortLabel: 'structure_heavy'
  maxCandidates: number
  totals: {
    eligibleRows: number
    selectedRows: number
    skippedRows: number
    pendingRows: number
  }
  selectedPublicationIds: string[]
  pendingPublicationIds: string[]
  candidates: Stage4StructureWaveCandidate[]
  skippedRows: Stage4StructureWaveSkippedRow[]
}

export interface Stage4StructureWaveSummaryDocument {
  generatedAt: string
  waveManifestPath: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  totals: Stage4StructureWaveDocument['totals']
  selectedPublicationIds: string[]
  pendingPublicationIds: string[]
  activeWaveSelectedPublicationIds: string[]
  activeWavePendingPublicationIds: string[]
  activeWaveAttemptedButUnterminalizedPublicationIds: string[]
  selectedByTier: Record<'highest' | 'high' | 'medium' | 'low', number>
  selectedByStatus: Record<CorpusStatus, number>
  selectedByStructureWaveBucket: Record<StructureWaveBucket, number>
}

export interface Stage4StructureThroughputSummaryDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  waveManifestPath: string
  waveOutcomesPath: string | null
  cohortLabel: 'structure_heavy'
  totals: {
    totalStructureHeavyRows: number
    verifiedPassRowsInCohort: number
    newlyVerifiedPassRowsFromWave: number
    remainingStructureHeavyRows: number
    processingErrorsInWave: number
    hardFailsInWave: number
    metadataNavigationResidualRows: number
    structureOnlyResidualRows: number
    mixedStructureFigureResidualRows: number
    structureProcessingErrorRetryRows: number
    pendingWaveRows: number
    reclassifiedOutOfStructureHeavyRows: number
    genericTimeoutRows: number
  }
  rows: {
    newlyVerifiedPassPublicationIds: string[]
    stagedPassCandidatePublicationIds: string[]
    metadataTitleSurvivorPublicationIds: string[]
    remainingPublicationIds: string[]
    activeWaveSelectedPublicationIds: string[]
    activeWavePendingPublicationIds: string[]
    activeWaveAttemptedButUnterminalizedPublicationIds: string[]
    processingErrorPublicationIds: string[]
    hardFailPublicationIds: string[]
    readingOrderOnlyResidualPublicationIds: string[]
    metadataNavigationResidualPublicationIds: string[]
    structureOnlyResidualPublicationIds: string[]
    mixedStructureFigureResidualPublicationIds: string[]
    structureProcessingErrorRetryPublicationIds: string[]
    pendingPublicationIds: string[]
    nextWaveStructureOnlyPublicationIds: string[]
    mixedFollowupPublicationIds: string[]
    boundedRuntimeRetryPublicationIds: string[]
    reclassifiedOutOfStructureHeavyPublicationIds: string[]
    forensicallyResolvedPendingPublicationIds: string[]
    stillUnclassifiedPendingPublicationIds: string[]
    activeUnresolvedPublicationIds: string[]
    stalledForensicPublicationIds: string[]
    stalledForensicByDisposition: Record<Stage4StalledAnalysisDisposition, string[]>
    overlapAnalysisPublicationIds: string[]
    activeForensicsPublicationIds: string[]
    activeForensicsByDisposition: Record<Stage4ActiveForensicsDisposition, string[]>
    nearPassGradeOnlyPublicationIds: string[]
    fontTextExtractabilitySurvivorPublicationIds: string[]
    figureSpilloverSurvivorPublicationIds: string[]
    currentWaveProcessedPublicationIds: string[]
    currentWaveRemainingPublicationIds: string[]
    genericTimeoutPublicationIds: string[]
  }
}

export interface Stage4StructurePendingAnalysisRow {
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
}

export interface Stage4StructurePendingAnalysisDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  sourceWaveManifestPath: string
  sourceWaveOutcomesPath: string | null
  rows: Stage4StructurePendingAnalysisRow[]
}

export interface Stage4StructurePendingAnalysisSummaryDocument {
  generatedAt: string
  analysisManifestPath: string
  totals: {
    analyzedRows: number
    byDisposition: Record<Stage4PendingAnalysisDisposition, number>
    byEvidenceStrength: Record<Stage4PendingAnalysisEvidenceStrength, number>
  }
  publicationIdsByDisposition: Record<Stage4PendingAnalysisDisposition, string[]>
}

export interface Stage4StructureActiveAnalysisRow {
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
}

export interface Stage4StructureActiveAnalysisDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  sourceWaveManifestPath: string
  sourceWaveOutcomesPath: string | null
  rows: Stage4StructureActiveAnalysisRow[]
}

export interface Stage4StructureActiveAnalysisSummaryDocument {
  generatedAt: string
  analysisManifestPath: string
  totals: {
    analyzedRows: number
    byDisposition: Record<Stage4ActiveAnalysisDisposition, number>
    byEvidenceStrength: Record<Stage4PendingAnalysisEvidenceStrength, number>
  }
  publicationIdsByDisposition: Record<Stage4ActiveAnalysisDisposition, string[]>
}

export interface Stage4StructureStalledAnalysisRow {
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
}

export interface Stage4StructureStalledAnalysisDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  sourceWaveManifestPath: string
  sourceWaveOutcomesPath: string | null
  rows: Stage4StructureStalledAnalysisRow[]
}

export interface Stage4StructureStalledAnalysisSummaryDocument {
  generatedAt: string
  analysisManifestPath: string
  totals: {
    analyzedRows: number
    byDisposition: Record<Stage4StalledAnalysisDisposition, number>
    byEvidenceStrength: Record<Stage4PendingAnalysisEvidenceStrength, number>
  }
  publicationIdsByDisposition: Record<Stage4StalledAnalysisDisposition, string[]>
}

export interface Stage4StructureOverlapAnalysisRow {
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
}

export interface Stage4StructureOverlapAnalysisDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  sourceWaveManifestPath: string
  sourceWaveOutcomesPath: string | null
  rows: Stage4StructureOverlapAnalysisRow[]
}

export interface Stage4StructureOverlapAnalysisSummaryDocument {
  generatedAt: string
  analysisManifestPath: string
  totals: {
    analyzedRows: number
    byDisposition: Record<Stage4OverlapAnalysisDisposition, number>
    byEvidenceStrength: Record<Stage4PendingAnalysisEvidenceStrength, number>
  }
  publicationIdsByDisposition: Record<Stage4OverlapAnalysisDisposition, string[]>
}

export interface Stage4StructureActiveForensicsRow {
  publicationId: string
  publicationTitle: string | null
  priorStructureWaveBucket: StructureWaveBucket | null
  forensicsDisposition: Stage4ActiveForensicsDisposition
  evidenceStrength: Stage4PendingAnalysisEvidenceStrength
  evidencePaths: {
    latestStage4ReportPath: string | null
    latestStage4FailurePath: string | null
    latestStage4AttemptPath: string | null
    controlPlanePath: string
  }
  reasonCodes: string[]
  notes: string[]
}

export interface Stage4StructureActiveForensicsDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  sourceWaveManifestPath: string
  sourceWaveOutcomesPath: string | null
  rows: Stage4StructureActiveForensicsRow[]
}

export interface Stage4StructureActiveForensicsSummaryDocument {
  generatedAt: string
  analysisManifestPath: string
  totals: {
    analyzedRows: number
    byDisposition: Record<Stage4ActiveForensicsDisposition, number>
    byEvidenceStrength: Record<Stage4PendingAnalysisEvidenceStrength, number>
  }
  publicationIdsByDisposition: Record<Stage4ActiveForensicsDisposition, string[]>
}

export interface Stage4StructureCanaryRow {
  publicationId: string | null
  publicationTitle: string | null
  source: 'benchmark' | 'cohort_representative'
  benchmarkName: string | null
  stage4RepresentativeKind:
    | 'verified_pass'
    | 'staged_pass_candidate_survivor'
    | 'metadata_navigation_residuals'
    | 'structure_only_residuals'
    | 'mixed_structure_figure_residuals'
    | 'structure_processing_error_retry'
    | 'spillover_from_stage3'
    | 'near_pass_grade_only'
    | 'metadata_title_survivor'
    | 'font_text_extractability_survivor'
    | 'figure_spillover_survivor'
    | 'reading_order_only_survivor'
    | null
  currentCorpusStatus: CorpusStatus | null
  currentCohortLabel: string | null
  structureWaveBucket: StructureWaveBucket | null
  originLane: 'native_structure_heavy' | 'reclassified_from_figure_heavy' | 'reclassified_from_short_high_likelihood' | null
  hasGenericTimeoutWording: boolean
  benchmarkTerminalState: string | null
  notes: string[]
}

export interface Stage4StructureCanariesDocument {
  generatedAt: string
  summary: {
    totalCanaries: number
    bySource: Record<'benchmark' | 'cohort_representative', number>
    byStructureWaveBucket: Record<StructureWaveBucket, number>
    withGenericTimeoutWording: number
  }
  rows: Stage4StructureCanaryRow[]
}

type OutcomeLike = {
  publicationId: string | null
  status: string | null
  processedAt?: string | null
  gate?: {
    blockingLocalFindingKeys?: string[]
    unresolvedCategoryLabels?: string[]
    reasons?: string[]
  } | null
}

const STRUCTURE_PATTERN = /(logical_structure|heading|reading_order|marked_content|page_tabs|structure)/i
const METADATA_PATTERN = /(document_language|display_doc_title|metadata_identification|bookmark_language|page_tabs|language|bookmark|metadata|title)/i
const FIGURE_PATTERN = /(figure|artifact|image|untagged_rendered_images|alt)/i

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

function emptyBucketCounts(): Record<StructureWaveBucket, number> {
  return {
    metadata_navigation_residuals: 0,
    structure_only_residuals: 0,
    mixed_structure_figure_residuals: 0,
    structure_processing_error_retry: 0,
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

function safeNumber(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

function loadJsonIfExists<T>(filePath: string | null): T | null {
  if (!filePath || !fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function stage4DispositionBucket(value: Stage4PendingAnalysisDisposition): StructureWaveBucket | null {
  if (value === 'reclassify_to_figure_heavy') return null
  return value
}

function emptyPendingDispositionCounts(): Record<Stage4PendingAnalysisDisposition, number> {
  return {
    metadata_navigation_residuals: 0,
    structure_only_residuals: 0,
    mixed_structure_figure_residuals: 0,
    structure_processing_error_retry: 0,
    reclassify_to_figure_heavy: 0,
  }
}

function emptyPendingEvidenceStrengthCounts(): Record<Stage4PendingAnalysisEvidenceStrength, number> {
  return {
    terminal_report: 0,
    failure_report: 0,
    attempt_artifact_only: 0,
    control_plane_only: 0,
  }
}

function findAttemptArtifactPath(manifestsRoot: string, publicationId: string): string | null {
  const root = path.join(path.dirname(manifestsRoot), 'artifacts', 'remediation-attempts', 'stage4-structure-wave')
  if (!fs.existsSync(root)) return null
  const hosts = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
  for (const host of hosts) {
    const hostDir = path.join(root, host.name)
    const match = fs.readdirSync(hostDir, { withFileTypes: true }).find(entry => entry.isDirectory() && entry.name.startsWith(publicationId + '-'))
    if (!match) continue
    const sidecarPath = path.join(hostDir, match.name, 'alt-text-sidecar.json')
    if (fs.existsSync(sidecarPath)) return sidecarPath
  }
  return null
}

function classifyPendingRowFromEvidence(input: {
  row: CorpusControlPlaneRow
  attemptArtifactPath: string | null
  controlPlanePath: string
}): Stage4StructurePendingAnalysisRow {
  const { row, attemptArtifactPath, controlPlanePath } = input
  const blockingKeys = uniqueStrings(row.classificationEvidence.blockingFindingKeys)
  const combinedText = [
    ...blockingKeys,
    ...row.classificationEvidence.topBlockingResidualFamilyIds,
    ...row.reasonCodes,
    ...row.notes,
  ].join(' ')

  const metadataDebt = blockingKeys.some(key => METADATA_PATTERN.test(key)) || METADATA_PATTERN.test(combinedText)
  const figureDebt = blockingKeys.some(key => FIGURE_PATTERN.test(key)) || FIGURE_PATTERN.test(combinedText)
  const structureDebt = blockingKeys.some(key => STRUCTURE_PATTERN.test(key)) || STRUCTURE_PATTERN.test(combinedText)
  const readingOnly = row.stage4StructureDiagnostics.hasReadingOrderDebt && !row.stage4StructureDiagnostics.hasMetadataNavigationDebt && !row.stage4StructureDiagnostics.hasMixedFigureResiduals

  let analysisDisposition: Stage4PendingAnalysisDisposition
  const reasonCodes = [...row.reasonCodes]
  const notes = [...row.notes]

  if (figureDebt && !metadataDebt && !structureDebt) {
    analysisDisposition = 'reclassify_to_figure_heavy'
    reasonCodes.push('stage4.2:reclassify_to_figure_heavy')
    notes.push('Stage 4.2 classified this unresolved Stage 4 row as figure-dominant based on residual evidence.')
  } else if (metadataDebt && !figureDebt) {
    analysisDisposition = 'metadata_navigation_residuals'
    reasonCodes.push('stage4.2:metadata_navigation_residuals')
    notes.push('Stage 4.2 classified this unresolved Stage 4 row as metadata/navigation-dominant using current control-plane residual evidence.')
  } else if (readingOnly || (structureDebt && !metadataDebt && !figureDebt)) {
    analysisDisposition = 'structure_only_residuals'
    reasonCodes.push('stage4.2:structure_only_residuals')
    notes.push('Stage 4.2 classified this unresolved Stage 4 row as structure-only using current control-plane residual evidence.')
  } else if (structureDebt && figureDebt) {
    analysisDisposition = 'mixed_structure_figure_residuals'
    reasonCodes.push('stage4.2:mixed_structure_figure_residuals')
    notes.push('Stage 4.2 classified this unresolved Stage 4 row as mixed structure+figure residual debt.')
  } else {
    analysisDisposition = 'structure_processing_error_retry'
    reasonCodes.push('stage4.2:structure_processing_error_retry')
    notes.push('Stage 4.2 defaulted this unresolved Stage 4 row to bounded runtime retry because the forensic evidence stayed too weak to resolve a cleaner structure bucket.')
  }

  const evidenceStrength: Stage4PendingAnalysisEvidenceStrength = attemptArtifactPath ? 'attempt_artifact_only' : 'control_plane_only'

  return {
    publicationId: row.publicationId,
    publicationTitle: row.title,
    priorStructureWaveBucket: row.stage4StructureDiagnostics.structureWaveBucket,
    analysisDisposition,
    evidenceStrength,
    evidencePaths: {
      terminalReportPath: null,
      failureReportPath: null,
      attemptArtifactPath,
      controlPlanePath,
    },
    reasonCodes: uniqueStrings(reasonCodes),
    notes: uniqueStrings(notes),
  }
}

export function buildStage4StructurePendingAnalysis(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manifestsRoot: string
}): {
  analysis: Stage4StructurePendingAnalysisDocument
  summary: Stage4StructurePendingAnalysisSummaryDocument
} {
  const wavePath = path.join(input.manifestsRoot, 'stage4-structure-wave.json')
  const outcomesPath = path.join(input.manifestsRoot, 'stage4-structure-wave.outcomes.json')
  const existingWave = loadJsonIfExists(wavePath) as Stage4StructureWaveDocument | null
  const existingOutcomes = loadJsonIfExists(outcomesPath) as { outcomes?: OutcomeLike[] } | null
  const pendingPublicationIds = pendingPublicationIdsFromExistingArtifacts(existingWave, existingOutcomes)
  const rowByPublicationId = new Map(input.artifacts.document.rows.map(row => [row.publicationId, row]))
  const rows: Stage4StructurePendingAnalysisRow[] = pendingPublicationIds
    .map(publicationId => rowByPublicationId.get(publicationId))
    .filter((row): row is CorpusControlPlaneRow => Boolean(row))
    .map(row => classifyPendingRowFromEvidence({
      row,
      attemptArtifactPath: findAttemptArtifactPath(input.manifestsRoot, row.publicationId),
      controlPlanePath: input.sourceControlPlanePath,
    }))
    .sort((left, right) => left.publicationId.localeCompare(right.publicationId))

  const byDisposition = emptyPendingDispositionCounts()
  const byEvidenceStrength = emptyPendingEvidenceStrengthCounts()
  const publicationIdsByDisposition = {
    metadata_navigation_residuals: [] as string[],
    structure_only_residuals: [] as string[],
    mixed_structure_figure_residuals: [] as string[],
    structure_processing_error_retry: [] as string[],
    reclassify_to_figure_heavy: [] as string[],
  }
  for (const row of rows) {
    byDisposition[row.analysisDisposition] += 1
    byEvidenceStrength[row.evidenceStrength] += 1
    publicationIdsByDisposition[row.analysisDisposition].push(row.publicationId)
  }

  const analysis: Stage4StructurePendingAnalysisDocument = {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    sourceWaveManifestPath: wavePath,
    sourceWaveOutcomesPath: fs.existsSync(outcomesPath) ? outcomesPath : null,
    rows,
  }

  return {
    analysis,
    summary: {
      generatedAt: analysis.generatedAt,
      analysisManifestPath: path.join(input.manifestsRoot, 'stage4-structure-pending-analysis.json'),
      totals: {
        analyzedRows: rows.length,
        byDisposition,
        byEvidenceStrength,
      },
      publicationIdsByDisposition,
    },
  }
}

function isTerminalOutcomeStatus(status: string | null | undefined): boolean {
  return [
    'failed_after_remediation',
    'processing_error',
    'ready_to_replace',
    'remediated_pass_candidate',
    'source_missing',
  ].includes(status || '')
}

function terminalPublicationIdsFromOutcomes(outcomesDoc: { outcomes?: OutcomeLike[] } | null): Set<string> {
  return new Set(
    (outcomesDoc?.outcomes || [])
      .filter(outcome => isTerminalOutcomeStatus(outcome.status))
      .map(outcome => outcome.publicationId)
      .filter((value): value is string => Boolean(value)),
  )
}

function pendingPublicationIdsFromExistingArtifacts(
  waveDoc: Stage4StructureWaveDocument | null,
  outcomesDoc: { outcomes?: OutcomeLike[] } | null,
): string[] {
  if (!waveDoc) return []
  const completed = terminalPublicationIdsFromOutcomes(outcomesDoc)
  return waveDoc.selectedPublicationIds.filter(publicationId => !completed.has(publicationId))
}

function unresolvedActivePublicationIdsFromExistingArtifacts(
  waveDoc: Stage4StructureWaveDocument | null,
  outcomesDoc: { outcomes?: OutcomeLike[] } | null,
): string[] {
  return pendingPublicationIdsFromExistingArtifacts(waveDoc, outcomesDoc)
}

function terminalSurvivorClassFromRow(row: CorpusControlPlaneRow): Stage4TerminalSurvivorClass | null {
  return row.stage4StructureDiagnostics.terminalSurvivorClass || null
}


function countOutcomeStatuses(outcomes: OutcomeLike[] = []): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const outcome of outcomes) {
    const status = outcome.status || 'unknown'
    counts[status] = (counts[status] || 0) + 1
  }
  return counts
}

export function buildStage4StructureWaveOutcomesSummary(input: {
  wave: Stage4StructureWaveDocument | null
  outcomesPath: string
  outcomes: { outcomes?: OutcomeLike[] } | null
}): Record<string, unknown> | null {
  if (!input.wave || !input.outcomes) return null
  const outcomes = input.outcomes.outcomes || []
  const selectedIds = new Set(input.wave.selectedPublicationIds)
  const currentWaveOutcomes = outcomes.filter(outcome => outcome.publicationId && selectedIds.has(outcome.publicationId))
  const currentWaveCounts = countOutcomeStatuses(currentWaveOutcomes)
  const cumulativeCounts = countOutcomeStatuses(outcomes)
  const currentWaveTerminalIds = terminalPublicationIdsFromOutcomes({ outcomes: currentWaveOutcomes })
  const currentWaveProcessedPublicationIds = currentWaveOutcomes
    .map(outcome => outcome.publicationId)
    .filter((value): value is string => Boolean(value))
  const currentWaveRemainingPublicationIds = input.wave.selectedPublicationIds.filter(publicationId => !currentWaveTerminalIds.has(publicationId))
  const latestProcessed = currentWaveOutcomes.length
    ? currentWaveOutcomes[currentWaveOutcomes.length - 1]
    : outcomes.length
      ? outcomes[outcomes.length - 1]
      : null
  return {
    generatedAt: new Date().toISOString(),
    sourcePriorityManifestPath: input.wave.sourceControlPlanePath ? input.wave.sourceControlPlanePath.replace('corpus-control-plane.json', 'stage4-structure-wave.json') : null,
    concurrency: 8,
    totals: {
      targetCandidates: input.wave.selectedPublicationIds.length,
      processed: currentWaveOutcomes.length,
      readyToReplace: currentWaveCounts.ready_to_replace || 0,
      remediatedPassCandidates: currentWaveCounts.remediated_pass_candidate || 0,
      failedAfterRemediation: currentWaveCounts.failed_after_remediation || 0,
      sourceMissing: currentWaveCounts.source_missing || 0,
      processingError: currentWaveCounts.processing_error || 0,
      remaining: currentWaveRemainingPublicationIds.length,
    },
    currentWave: {
      processedPublicationIds: uniqueStrings(currentWaveProcessedPublicationIds),
      remainingPublicationIds: uniqueStrings(currentWaveRemainingPublicationIds),
      failedAfterRemediationPublicationIds: uniqueStrings(currentWaveOutcomes.filter(outcome => outcome.status === 'failed_after_remediation').map(outcome => outcome.publicationId)),
      processingErrorPublicationIds: uniqueStrings(currentWaveOutcomes.filter(outcome => outcome.status === 'processing_error').map(outcome => outcome.publicationId)),
    },
    cumulativeTotals: {
      processed: outcomes.length,
      readyToReplace: cumulativeCounts.ready_to_replace || 0,
      remediatedPassCandidates: cumulativeCounts.remediated_pass_candidate || 0,
      failedAfterRemediation: cumulativeCounts.failed_after_remediation || 0,
      sourceMissing: cumulativeCounts.source_missing || 0,
      processingError: cumulativeCounts.processing_error || 0,
    },
    latestProcessed,
  }
}

function emptyActiveDispositionCounts(): Record<Stage4ActiveAnalysisDisposition, number> {
  return {
    metadata_navigation_residuals: 0,
    structure_only_residuals: 0,
    mixed_structure_figure_residuals: 0,
    structure_processing_error_retry: 0,
  }
}

function classifyActiveRowFromEvidence(input: {
  row: CorpusControlPlaneRow
  attemptArtifactPath: string | null
  latestStage4OutcomePath: string | null
  controlPlanePath: string
}): Stage4StructureActiveAnalysisRow {
  const { row, attemptArtifactPath, latestStage4OutcomePath, controlPlanePath } = input
  const blockingKeys = uniqueStrings(row.classificationEvidence.blockingFindingKeys)
  const combinedText = [
    ...blockingKeys,
    ...row.classificationEvidence.topBlockingResidualFamilyIds,
    ...row.reasonCodes,
    ...row.notes,
  ].join(' ')

  const metadataDebt = row.stage4StructureDiagnostics.hasMetadataNavigationDebt
    || blockingKeys.some(key => METADATA_PATTERN.test(key))
    || METADATA_PATTERN.test(combinedText)
  const figureDebt = row.stage4StructureDiagnostics.hasMixedFigureResiduals
    || blockingKeys.some(key => FIGURE_PATTERN.test(key))
    || FIGURE_PATTERN.test(combinedText)
  const structureDebt = row.stage4StructureDiagnostics.hasLogicalStructureDebt
    || row.stage4StructureDiagnostics.hasReadingOrderDebt
    || blockingKeys.some(key => STRUCTURE_PATTERN.test(key))
    || STRUCTURE_PATTERN.test(combinedText)
  const boundedRuntime = row.stage4StructureDiagnostics.hasBoundedRuntimeWording || row.currentCorpusStatus === 'processing_error'
  const readingOnly = row.stage4StructureDiagnostics.hasReadingOrderDebt
    && !row.stage4StructureDiagnostics.hasMetadataNavigationDebt
    && !row.stage4StructureDiagnostics.hasMixedFigureResiduals
    && blockingKeys.every(key => !METADATA_PATTERN.test(key) && !FIGURE_PATTERN.test(key))

  let activeDisposition: Stage4ActiveAnalysisDisposition
  const reasonCodes = [...row.reasonCodes]
  const notes = [...row.notes]

  if (boundedRuntime) {
    activeDisposition = 'structure_processing_error_retry'
    reasonCodes.push('stage4.3:structure_processing_error_retry')
    notes.push('Stage 4.3 classified this active unresolved row as a bounded runtime retry.')
  } else if (structureDebt && figureDebt) {
    activeDisposition = 'mixed_structure_figure_residuals'
    reasonCodes.push('stage4.3:mixed_structure_figure_residuals')
    notes.push('Stage 4.3 classified this active unresolved row as mixed structure+figure residual debt.')
  } else if (readingOnly || (structureDebt && !metadataDebt && !figureDebt)) {
    activeDisposition = 'structure_only_residuals'
    reasonCodes.push('stage4.3:structure_only_residuals')
    notes.push('Stage 4.3 classified this active unresolved row as structure-only residual debt.')
  } else if (metadataDebt) {
    activeDisposition = 'metadata_navigation_residuals'
    reasonCodes.push('stage4.3:metadata_navigation_residuals')
    notes.push('Stage 4.3 classified this active unresolved row as metadata/navigation residual debt.')
  } else {
    activeDisposition = 'structure_processing_error_retry'
    reasonCodes.push('stage4.3:structure_processing_error_retry')
    notes.push('Stage 4.3 defaulted this active unresolved row to bounded runtime retry because the evidence stayed ambiguous.')
  }

  const evidenceStrength: Stage4PendingAnalysisEvidenceStrength = latestStage4OutcomePath
    ? 'terminal_report'
    : attemptArtifactPath
      ? 'attempt_artifact_only'
      : 'control_plane_only'

  return {
    publicationId: row.publicationId,
    publicationTitle: row.title,
    priorStructureWaveBucket: row.stage4StructureDiagnostics.structureWaveBucket,
    activeDisposition,
    evidenceStrength,
    evidencePaths: {
      latestStage4AttemptPath: attemptArtifactPath,
      latestStage4OutcomePath,
      controlPlanePath,
    },
    reasonCodes: uniqueStrings(reasonCodes),
    notes: uniqueStrings(notes),
  }
}

export function buildStage4StructureActiveAnalysis(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manifestsRoot: string
}): {
  analysis: Stage4StructureActiveAnalysisDocument
  summary: Stage4StructureActiveAnalysisSummaryDocument
} {
  const wavePath = path.join(input.manifestsRoot, 'stage4-structure-wave.json')
  const outcomesPath = path.join(input.manifestsRoot, 'stage4-structure-wave.outcomes.json')
  const existingWave = loadJsonIfExists(wavePath) as Stage4StructureWaveDocument | null
  const existingOutcomes = loadJsonIfExists(outcomesPath) as { outcomes?: OutcomeLike[] } | null
  const activePublicationIds = unresolvedActivePublicationIdsFromExistingArtifacts(existingWave, existingOutcomes)
  const rowByPublicationId = new Map(input.artifacts.document.rows.map(row => [row.publicationId, row]))
  const rows: Stage4StructureActiveAnalysisRow[] = activePublicationIds
    .map(publicationId => rowByPublicationId.get(publicationId))
    .filter((row): row is CorpusControlPlaneRow => Boolean(row))
    .map(row => classifyActiveRowFromEvidence({
      row,
      attemptArtifactPath: findAttemptArtifactPath(input.manifestsRoot, row.publicationId),
      latestStage4OutcomePath: row.statusEvidence.outcomeManifestPath && /stage4-structure-wave/.test(row.statusEvidence.outcomeManifestPath)
        ? row.statusEvidence.latestReportPath || row.statusEvidence.outcomeManifestPath
        : null,
      controlPlanePath: input.sourceControlPlanePath,
    }))
    .sort((left, right) => left.publicationId.localeCompare(right.publicationId))

  const byDisposition = emptyActiveDispositionCounts()
  const byEvidenceStrength = emptyPendingEvidenceStrengthCounts()
  const publicationIdsByDisposition = {
    metadata_navigation_residuals: [] as string[],
    structure_only_residuals: [] as string[],
    mixed_structure_figure_residuals: [] as string[],
    structure_processing_error_retry: [] as string[],
  }
  for (const row of rows) {
    byDisposition[row.activeDisposition] += 1
    byEvidenceStrength[row.evidenceStrength] += 1
    publicationIdsByDisposition[row.activeDisposition].push(row.publicationId)
  }

  const analysis: Stage4StructureActiveAnalysisDocument = {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    sourceWaveManifestPath: wavePath,
    sourceWaveOutcomesPath: fs.existsSync(outcomesPath) ? outcomesPath : null,
    rows,
  }

  return {
    analysis,
    summary: {
      generatedAt: analysis.generatedAt,
      analysisManifestPath: path.join(input.manifestsRoot, 'stage4-structure-active-analysis.json'),
      totals: {
        analyzedRows: rows.length,
        byDisposition,
        byEvidenceStrength,
      },
      publicationIdsByDisposition,
    },
  }
}

function emptyStalledDispositionCounts(): Record<Stage4StalledAnalysisDisposition, number> {
  return {
    metadata_title_survivor: 0,
    metadata_navigation_residuals: 0,
    font_text_extractability_survivor: 0,
    mixed_structure_figure_residuals: 0,
    structure_processing_error_retry: 0,
  }
}

function emptyOverlapDispositionCounts(): Record<Stage4OverlapAnalysisDisposition, number> {
  return {
    metadata_navigation_residuals: 0,
    reading_order_only_survivor: 0,
  }
}

function emptyActiveForensicsDispositionCounts(): Record<Stage4ActiveForensicsDisposition, number> {
  return {
    metadata_title_survivor: 0,
    metadata_navigation_residuals: 0,
    font_text_extractability_survivor: 0,
    reading_order_only_survivor: 0,
    mixed_structure_figure_residuals: 0,
    structure_processing_error_retry: 0,
  }
}

function findStage4ReportPath(manifestsRoot: string, publicationId: string): string | null {
  const root = path.join(path.dirname(manifestsRoot), 'reports', 'test-runs', 'stage4-structure-wave')
  if (!fs.existsSync(root)) return null
  for (const host of fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const hostDir = path.join(root, host.name)
    const match = fs.readdirSync(hostDir).find(name => name.startsWith(publicationId + '-') && name.endsWith('.remediation.json'))
    if (match) return path.join(hostDir, match)
  }
  return null
}

function findStage4FailurePath(manifestsRoot: string, publicationId: string): string | null {
  const root = path.join(path.dirname(manifestsRoot), 'reports', 'failures', 'stage4-structure-wave')
  if (!fs.existsSync(root)) return null
  for (const host of fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const hostDir = path.join(root, host.name)
    const match = fs.readdirSync(hostDir).find(name => name.startsWith(publicationId + '-') && name.endsWith('.failure.json'))
    if (match) return path.join(hostDir, match)
  }
  return null
}

function classifyStalledRowFromEvidence(input: {
  row: CorpusControlPlaneRow
  latestStage4ReportPath: string | null
  latestStage4FailurePath: string | null
  latestStage4AttemptPath: string | null
  controlPlanePath: string
}): Stage4StructureStalledAnalysisRow {
  const { row, latestStage4ReportPath, latestStage4FailurePath, latestStage4AttemptPath, controlPlanePath } = input
  const terminalClass = row.stage4StructureDiagnostics.terminalSurvivorClass
  const blockingKeys = uniqueStrings(row.classificationEvidence.blockingFindingKeys)
  const combinedText = [
    ...blockingKeys,
    ...row.classificationEvidence.topBlockingResidualFamilyIds,
    ...row.reasonCodes,
    ...row.notes,
  ].join(' ')

  let stalledDisposition: Stage4StalledAnalysisDisposition
  const reasonCodes = [...row.reasonCodes]
  const notes = [...row.notes]

  if (terminalClass === 'metadata_title_survivor') {
    stalledDisposition = 'metadata_title_survivor'
    reasonCodes.push('stage4.8:metadata_title_survivor')
    notes.push('Stage 4.8 classified this stalled row as a title-metadata survivor from existing evidence.')
  } else if (terminalClass === 'font_text_extractability_survivor') {
    stalledDisposition = 'font_text_extractability_survivor'
    reasonCodes.push('stage4.8:font_text_extractability_survivor')
    notes.push('Stage 4.8 classified this stalled row as a font/text-extractability survivor from existing evidence.')
  } else if (row.stage4StructureDiagnostics.hasBoundedRuntimeWording || row.currentCorpusStatus === 'processing_error') {
    stalledDisposition = 'structure_processing_error_retry'
    reasonCodes.push('stage4.8:structure_processing_error_retry')
    notes.push('Stage 4.8 classified this stalled row as a bounded runtime retry.')
  } else if (
    row.stage4StructureDiagnostics.structureWaveBucket === 'mixed_structure_figure_residuals'
    || row.stage4StructureDiagnostics.hasMixedFigureResiduals
    || blockingKeys.some(key => FIGURE_PATTERN.test(key))
    || FIGURE_PATTERN.test(combinedText)
  ) {
    stalledDisposition = 'mixed_structure_figure_residuals'
    reasonCodes.push('stage4.8:mixed_structure_figure_residuals')
    notes.push('Stage 4.8 classified this stalled row as mixed structure+figure residual debt.')
  } else if (row.stage4StructureDiagnostics.structureWaveBucket === 'metadata_navigation_residuals' || METADATA_PATTERN.test(combinedText)) {
    stalledDisposition = 'metadata_navigation_residuals'
    reasonCodes.push('stage4.8:metadata_navigation_residuals')
    notes.push('Stage 4.8 classified this stalled row as an unresolved metadata/navigation candidate.')
  } else {
    stalledDisposition = 'structure_processing_error_retry'
    reasonCodes.push('stage4.8:structure_processing_error_retry')
    notes.push('Stage 4.8 defaulted this stalled row to bounded runtime retry because the evidence stayed weak.')
  }

  const evidenceStrength: Stage4PendingAnalysisEvidenceStrength = latestStage4ReportPath
    ? 'terminal_report'
    : latestStage4FailurePath
      ? 'failure_report'
      : latestStage4AttemptPath
        ? 'attempt_artifact_only'
        : 'control_plane_only'

  return {
    publicationId: row.publicationId,
    publicationTitle: row.title,
    priorStructureWaveBucket: row.stage4StructureDiagnostics.structureWaveBucket,
    stalledDisposition,
    evidenceStrength,
    evidencePaths: {
      latestStage4ReportPath,
      latestStage4FailurePath,
      latestStage4AttemptPath,
      controlPlanePath,
    },
    reasonCodes: uniqueStrings(reasonCodes),
    notes: uniqueStrings(notes),
  }
}

export function buildStage4StructureStalledAnalysis(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manifestsRoot: string
  includePublicationIds?: string[]
}): {
  analysis: Stage4StructureStalledAnalysisDocument
  summary: Stage4StructureStalledAnalysisSummaryDocument
} {
  const wavePath = path.join(input.manifestsRoot, 'stage4-structure-wave.json')
  const outcomesPath = path.join(input.manifestsRoot, 'stage4-structure-wave.outcomes.json')
  const existingWave = loadJsonIfExists(wavePath) as Stage4StructureWaveDocument | null
  const existingOutcomes = loadJsonIfExists(outcomesPath) as { outcomes?: OutcomeLike[] } | null
  const stalledPublicationIds = uniqueStrings(input.includePublicationIds || []).length > 0
    ? uniqueStrings(input.includePublicationIds || [])
    : unresolvedActivePublicationIdsFromExistingArtifacts(existingWave, existingOutcomes)
  const rowByPublicationId = new Map(input.artifacts.document.rows.map(row => [row.publicationId, row]))
  const rows: Stage4StructureStalledAnalysisRow[] = stalledPublicationIds
    .map(publicationId => rowByPublicationId.get(publicationId))
    .filter((row): row is CorpusControlPlaneRow => Boolean(row))
    .map(row => classifyStalledRowFromEvidence({
      row,
      latestStage4ReportPath: findStage4ReportPath(input.manifestsRoot, row.publicationId),
      latestStage4FailurePath: findStage4FailurePath(input.manifestsRoot, row.publicationId),
      latestStage4AttemptPath: findAttemptArtifactPath(input.manifestsRoot, row.publicationId),
      controlPlanePath: input.sourceControlPlanePath,
    }))
    .sort((left, right) => left.publicationId.localeCompare(right.publicationId))

  const byDisposition = emptyStalledDispositionCounts()
  const byEvidenceStrength = emptyPendingEvidenceStrengthCounts()
  const publicationIdsByDisposition = {
    metadata_title_survivor: [] as string[],
    metadata_navigation_residuals: [] as string[],
    font_text_extractability_survivor: [] as string[],
    mixed_structure_figure_residuals: [] as string[],
    structure_processing_error_retry: [] as string[],
  }
  for (const row of rows) {
    byDisposition[row.stalledDisposition] += 1
    byEvidenceStrength[row.evidenceStrength] += 1
    publicationIdsByDisposition[row.stalledDisposition].push(row.publicationId)
  }

  const analysis: Stage4StructureStalledAnalysisDocument = {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    sourceWaveManifestPath: wavePath,
    sourceWaveOutcomesPath: fs.existsSync(outcomesPath) ? outcomesPath : null,
    rows,
  }

  return {
    analysis,
    summary: {
      generatedAt: analysis.generatedAt,
      analysisManifestPath: path.join(input.manifestsRoot, 'stage4-structure-stalled-analysis.json'),
      totals: {
        analyzedRows: rows.length,
        byDisposition,
        byEvidenceStrength,
      },
      publicationIdsByDisposition,
    },
  }
}

export function buildStage4StructureOverlapAnalysis(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manifestsRoot: string
  includePublicationIds?: string[]
}): {
  analysis: Stage4StructureOverlapAnalysisDocument
  summary: Stage4StructureOverlapAnalysisSummaryDocument
} {
  const wavePath = path.join(input.manifestsRoot, 'stage4-structure-wave.json')
  const outcomesPath = path.join(input.manifestsRoot, 'stage4-structure-wave.outcomes.json')
  const includePublicationIds = uniqueStrings(input.includePublicationIds || [])
  const rowByPublicationId = new Map(input.artifacts.document.rows.map(row => [row.publicationId, row]))
  const rows: Stage4StructureOverlapAnalysisRow[] = includePublicationIds
    .map(publicationId => rowByPublicationId.get(publicationId))
    .filter((row): row is CorpusControlPlaneRow => Boolean(row))
    .map(row => {
      const latestStage4ReportPath = row.statusEvidence.latestReportPath || findStage4ReportPath(input.manifestsRoot, row.publicationId)
      const derivedFailurePath = row.statusEvidence.latestReportPath
        ? row.statusEvidence.latestReportPath
            .replace('/reports/test-runs/', '/reports/failures/')
            .replace(/\.remediation\.json$/, '.failure.json')
        : null
      const latestStage4FailurePath = (derivedFailurePath && fs.existsSync(derivedFailurePath) ? derivedFailurePath : null) || findStage4FailurePath(input.manifestsRoot, row.publicationId)
      const latestStage4AttemptPath = findAttemptArtifactPath(input.manifestsRoot, row.publicationId)
      const failureDoc = latestStage4FailurePath ? loadJsonIfExists(latestStage4FailurePath) as any : null
      const remediationDoc = latestStage4ReportPath ? loadJsonIfExists(latestStage4ReportPath) as any : null
      const gateReasons = uniqueStrings([...(failureDoc?.gate?.reasons || []), ...(remediationDoc?.finalGate?.reasons || []), ...(remediationDoc?.gate?.reasons || [])])
      const gateCategories = uniqueStrings([...(failureDoc?.gate?.unresolvedCategoryLabels || []), ...(remediationDoc?.finalGate?.unresolvedCategoryLabels || []), ...(remediationDoc?.gate?.unresolvedCategoryLabels || [])])
      const readingOnly = gateCategories.length > 0 && gateCategories.every(label => /reading order/i.test(label))
      const overlapDisposition: Stage4OverlapAnalysisDisposition = readingOnly
        ? 'reading_order_only_survivor'
        : 'metadata_navigation_residuals'
      const reasonCodes = uniqueStrings([
        ...row.reasonCodes,
        overlapDisposition === 'reading_order_only_survivor' ? 'stage4.9:reading_order_only_survivor' : 'stage4.9:metadata_navigation_residuals',
      ])
      const notes = uniqueStrings([
        ...row.notes,
        overlapDisposition === 'reading_order_only_survivor'
          ? 'Stage 4.9 terminalized this overlap row as a reading-order-only survivor from prior remediation evidence.'
          : 'Stage 4.9 kept this overlap row in metadata/navigation residuals after review of prior remediation evidence.',
      ])
      const evidenceStrength: Stage4PendingAnalysisEvidenceStrength = latestStage4ReportPath
        ? 'terminal_report'
        : latestStage4FailurePath
          ? 'failure_report'
          : latestStage4AttemptPath
            ? 'attempt_artifact_only'
            : 'control_plane_only'
      return {
        publicationId: row.publicationId,
        publicationTitle: row.title,
        priorStructureWaveBucket: row.stage4StructureDiagnostics.structureWaveBucket,
        overlapDisposition,
        evidenceStrength,
        evidencePaths: {
          latestStage4ReportPath,
          latestStage4FailurePath,
          latestStage4AttemptPath,
          controlPlanePath: input.sourceControlPlanePath,
        },
        reasonCodes,
        notes,
      }
    })
    .sort((a,b) => a.publicationId.localeCompare(b.publicationId))

  const byDisposition = emptyOverlapDispositionCounts()
  const byEvidenceStrength = emptyPendingEvidenceStrengthCounts()
  const publicationIdsByDisposition = {
    metadata_navigation_residuals: [] as string[],
    reading_order_only_survivor: [] as string[],
  }
  for (const row of rows) {
    byDisposition[row.overlapDisposition] += 1
    byEvidenceStrength[row.evidenceStrength] += 1
    publicationIdsByDisposition[row.overlapDisposition].push(row.publicationId)
  }
  const analysis: Stage4StructureOverlapAnalysisDocument = {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    sourceWaveManifestPath: wavePath,
    sourceWaveOutcomesPath: fs.existsSync(outcomesPath) ? outcomesPath : null,
    rows,
  }
  return {
    analysis,
    summary: {
      generatedAt: analysis.generatedAt,
      analysisManifestPath: path.join(input.manifestsRoot, 'stage4-structure-overlap-analysis.json'),
      totals: { analyzedRows: rows.length, byDisposition, byEvidenceStrength },
      publicationIdsByDisposition,
    },
  }
}

export function buildStage4StructureActiveForensics(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manifestsRoot: string
  includePublicationIds?: string[]
}): {
  analysis: Stage4StructureActiveForensicsDocument
  summary: Stage4StructureActiveForensicsSummaryDocument
} {
  const wavePath = path.join(input.manifestsRoot, 'stage4-structure-wave.json')
  const outcomesPath = path.join(input.manifestsRoot, 'stage4-structure-wave.outcomes.json')
  const existingWave = loadJsonIfExists(wavePath) as Stage4StructureWaveDocument | null
  const existingOutcomes = loadJsonIfExists(outcomesPath) as { outcomes?: OutcomeLike[] } | null
  const includePublicationIds = uniqueStrings(input.includePublicationIds || [])
  const activePublicationIds = includePublicationIds.length > 0
    ? includePublicationIds
    : unresolvedActivePublicationIdsFromExistingArtifacts(existingWave, existingOutcomes)
  const rowByPublicationId = new Map(input.artifacts.document.rows.map(row => [row.publicationId, row]))
  const rows: Stage4StructureActiveForensicsRow[] = activePublicationIds
    .map(publicationId => rowByPublicationId.get(publicationId))
    .filter((row): row is CorpusControlPlaneRow => Boolean(row))
    .map(row => {
      const latestStage4ReportPath = row.statusEvidence.latestReportPath || findStage4ReportPath(input.manifestsRoot, row.publicationId)
      const derivedFailurePath = row.statusEvidence.latestReportPath
        ? row.statusEvidence.latestReportPath.replace('/reports/test-runs/', '/reports/failures/').replace(/.remediation.json$/, '.failure.json')
        : null
      const latestStage4FailurePath = (derivedFailurePath && fs.existsSync(derivedFailurePath) ? derivedFailurePath : null) || findStage4FailurePath(input.manifestsRoot, row.publicationId)
      const latestStage4AttemptPath = findAttemptArtifactPath(input.manifestsRoot, row.publicationId)
      const failureDoc = latestStage4FailurePath ? loadJsonIfExists(latestStage4FailurePath) as any : null
      const remediationDoc = latestStage4ReportPath ? loadJsonIfExists(latestStage4ReportPath) as any : null
      const gate = failureDoc?.gate || remediationDoc?.finalGate || remediationDoc?.gate || {}
      const unresolved = uniqueStrings(gate.unresolvedCategoryLabels || [])
      const blockingKeys = uniqueStrings(gate.blockingLocalFindingKeys || [])
      const combined = [...unresolved, ...blockingKeys, ...row.classificationEvidence.blockingFindingKeys, ...row.classificationEvidence.topBlockingResidualFamilyIds, ...row.reasonCodes, ...row.notes].join(' ')
      let forensicsDisposition: Stage4ActiveForensicsDisposition = 'metadata_navigation_residuals'
      if (unresolved.length > 0 && unresolved.every(label => /reading order/i.test(label))) {
        forensicsDisposition = 'reading_order_only_survivor'
      } else if (blockingKeys.some(key => FIGURE_PATTERN.test(key)) || row.stage4StructureDiagnostics.hasMixedFigureResiduals) {
        forensicsDisposition = 'mixed_structure_figure_residuals'
      } else if (/font|unicode|text extractability/i.test(combined) && /table markup/i.test(combined)) {
        forensicsDisposition = 'font_text_extractability_survivor'
      } else if (/font|unicode|text extractability/i.test(combined) && !/document title|language|bookmark/i.test(combined)) {
        forensicsDisposition = 'font_text_extractability_survivor'
      } else if (/document title|title language|document language|bookmark|metadata/i.test(combined)) {
        forensicsDisposition = 'metadata_title_survivor'
      } else if (row.currentCorpusStatus === 'processing_error' || row.stage4StructureDiagnostics.hasBoundedRuntimeWording) {
        forensicsDisposition = 'structure_processing_error_retry'
      }
      const reasonCodes = uniqueStrings([
        ...row.reasonCodes,
        'stage4.10:' + forensicsDisposition,
      ])
      const notes = uniqueStrings([
        ...row.notes,
        forensicsDisposition === 'reading_order_only_survivor'
          ? 'Stage 4.10 terminalized this active row as a reading-order-only survivor from prior remediation evidence.'
          : forensicsDisposition === 'metadata_title_survivor'
            ? 'Stage 4.10 classified this active row as a metadata/title survivor from prior remediation evidence.'
            : forensicsDisposition === 'font_text_extractability_survivor'
              ? 'Stage 4.10 classified this active row as a font/text-extractability survivor from prior remediation evidence.'
              : forensicsDisposition === 'mixed_structure_figure_residuals'
                ? 'Stage 4.10 classified this active row as mixed structure+figure residual debt from prior remediation evidence.'
                : forensicsDisposition === 'structure_processing_error_retry'
                  ? 'Stage 4.10 classified this active row as a bounded runtime retry.'
                  : 'Stage 4.10 kept this active row in metadata/navigation residuals after review of prior remediation evidence.',
      ])
      const evidenceStrength: Stage4PendingAnalysisEvidenceStrength = latestStage4ReportPath
        ? 'terminal_report'
        : latestStage4FailurePath
          ? 'failure_report'
          : latestStage4AttemptPath
            ? 'attempt_artifact_only'
            : 'control_plane_only'
      return {
        publicationId: row.publicationId,
        publicationTitle: row.title,
        priorStructureWaveBucket: row.stage4StructureDiagnostics.structureWaveBucket,
        forensicsDisposition,
        evidenceStrength,
        evidencePaths: {
          latestStage4ReportPath,
          latestStage4FailurePath,
          latestStage4AttemptPath,
          controlPlanePath: input.sourceControlPlanePath,
        },
        reasonCodes,
        notes,
      }
    })
    .sort((a,b) => a.publicationId.localeCompare(b.publicationId))

  const byDisposition = emptyActiveForensicsDispositionCounts()
  const byEvidenceStrength = emptyPendingEvidenceStrengthCounts()
  const publicationIdsByDisposition = {
    metadata_title_survivor: [] as string[],
    metadata_navigation_residuals: [] as string[],
    font_text_extractability_survivor: [] as string[],
    reading_order_only_survivor: [] as string[],
    mixed_structure_figure_residuals: [] as string[],
    structure_processing_error_retry: [] as string[],
  }
  for (const row of rows) {
    byDisposition[row.forensicsDisposition] += 1
    byEvidenceStrength[row.evidenceStrength] += 1
    publicationIdsByDisposition[row.forensicsDisposition].push(row.publicationId)
  }
  const analysis: Stage4StructureActiveForensicsDocument = {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    sourceWaveManifestPath: wavePath,
    sourceWaveOutcomesPath: fs.existsSync(outcomesPath) ? outcomesPath : null,
    rows,
  }
  return {
    analysis,
    summary: {
      generatedAt: analysis.generatedAt,
      analysisManifestPath: path.join(input.manifestsRoot, 'stage4-structure-active-forensics.json'),
      totals: { analyzedRows: rows.length, byDisposition, byEvidenceStrength },
      publicationIdsByDisposition,
    },
  }
}

function bucketRank(bucket: StructureWaveBucket): number {
  return {
    metadata_navigation_residuals: 0,
    structure_only_residuals: 1,
    mixed_structure_figure_residuals: 2,
    structure_processing_error_retry: 3,
  }[bucket]
}

function priorityTierForBucket(bucket: StructureWaveBucket): 'highest' | 'high' | 'medium' | 'low' {
  return ({
    metadata_navigation_residuals: 'highest',
    structure_only_residuals: 'high',
    mixed_structure_figure_residuals: 'medium',
    structure_processing_error_retry: 'low',
  } as const)[bucket]
}

function evidenceStrengthRank(row: CorpusControlPlaneRow): number {
  if (row.statusEvidence.verificationReportPath || row.statusEvidence.verificationTimestamp) return 0
  if (row.statusEvidence.outcomeManifestPath || row.statusEvidence.latestReportPath) return 1
  if (row.statusEvidence.candidateManifestPath) return 2
  return 3
}

function deriveStructureDiagnosticsFromRow(row: CorpusControlPlaneRow): CorpusControlPlaneRow['stage4StructureDiagnostics'] {
  const decisiveBlockingKeys = uniqueStrings(row.classificationEvidence.blockingFindingKeys)
  const joinedText = [
    ...row.classificationEvidence.topBlockingResidualFamilyIds,
    ...decisiveBlockingKeys,
    ...row.reasonCodes,
    ...row.notes,
  ].join(' ')

  const derivedLogicalStructureDebt = decisiveBlockingKeys.includes('pdfua.logical_structure')
    || decisiveBlockingKeys.includes('pdfua.heading_content_quality')
    || STRUCTURE_PATTERN.test(joinedText)
  const derivedHeadingDebt = decisiveBlockingKeys.some(key => /heading/i.test(key))
  const derivedReadingOrderDebt = decisiveBlockingKeys.some(key => /reading_order|page_tabs/i.test(key))
  const derivedMetadataNavigationDebt = decisiveBlockingKeys.some(key => /document_language|display_doc_title|metadata_identification|bookmark_language|page_tabs/i.test(key))
    || METADATA_PATTERN.test(joinedText)
  const derivedMixedFigureResiduals = decisiveBlockingKeys.some(key => FIGURE_PATTERN.test(key))
    || FIGURE_PATTERN.test(joinedText)

  const hasLogicalStructureDebt = row.stage4StructureDiagnostics.hasLogicalStructureDebt ?? derivedLogicalStructureDebt
  const hasHeadingDebt = row.stage4StructureDiagnostics.hasHeadingDebt ?? derivedHeadingDebt
  const hasReadingOrderDebt = row.stage4StructureDiagnostics.hasReadingOrderDebt ?? derivedReadingOrderDebt
  const hasMetadataNavigationDebt = row.stage4StructureDiagnostics.hasMetadataNavigationDebt ?? derivedMetadataNavigationDebt
  const hasMixedFigureResiduals = row.stage4StructureDiagnostics.hasMixedFigureResiduals ?? derivedMixedFigureResiduals
  const hasBoundedRuntimeWording = row.stage4StructureDiagnostics.hasBoundedRuntimeWording
    || (row.currentCorpusStatus === 'processing_error' && row.reasonCodes.includes('outcome:processing_error'))

  let structureWaveBucket: StructureWaveBucket | null = row.stage4StructureDiagnostics.structureWaveBucket
  if (row.cohortLabel === 'structure_heavy' || hasLogicalStructureDebt || hasMetadataNavigationDebt) {
    if (hasBoundedRuntimeWording || row.currentCorpusStatus === 'processing_error') {
      structureWaveBucket = 'structure_processing_error_retry'
    } else if (hasReadingOrderDebt && !hasMetadataNavigationDebt && !hasMixedFigureResiduals) {
      structureWaveBucket = 'structure_only_residuals'
    } else if (hasMetadataNavigationDebt && !hasMixedFigureResiduals) {
      structureWaveBucket = 'metadata_navigation_residuals'
    } else if ((hasLogicalStructureDebt || hasMetadataNavigationDebt) && hasMixedFigureResiduals) {
      structureWaveBucket = 'mixed_structure_figure_residuals'
    } else if (hasLogicalStructureDebt || hasMetadataNavigationDebt) {
      structureWaveBucket = 'structure_only_residuals'
    }
  }

  let originLane: CorpusControlPlaneRow['stage4StructureDiagnostics']['originLane'] = row.stage4StructureDiagnostics.originLane || 'native_structure_heavy'
  if (row.reasonCodes.includes('stage3:reclassified_from_figure_heavy')) {
    originLane = 'reclassified_from_figure_heavy'
  } else if (row.reasonCodes.includes('stage2:reclassified_from_short_high_likelihood')) {
    originLane = 'reclassified_from_short_high_likelihood'
  }

  return {
    structureWaveBucket,
    terminalSurvivorClass: row.stage4StructureDiagnostics.terminalSurvivorClass || null,
    dominantStructurePhase: row.stage4StructureDiagnostics.dominantStructurePhase,
    hasLogicalStructureDebt: hasLogicalStructureDebt || null,
    hasHeadingDebt: hasHeadingDebt || null,
    hasReadingOrderDebt: hasReadingOrderDebt || null,
    hasMetadataNavigationDebt: hasMetadataNavigationDebt || null,
    hasMixedFigureResiduals: hasMixedFigureResiduals || null,
    hasBoundedRuntimeWording,
    originLane,
  }
}

function compareWaveRows(left: CorpusControlPlaneRow, right: CorpusControlPlaneRow): number {
  const leftBucket = left.stage4StructureDiagnostics.structureWaveBucket
  const rightBucket = right.stage4StructureDiagnostics.structureWaveBucket
  if (leftBucket && rightBucket) {
    const bucketDiff = bucketRank(leftBucket) - bucketRank(rightBucket)
    if (bucketDiff !== 0) return bucketDiff
  }

  const blockerDiff = safeNumber(left.classificationEvidence.blockerFamilyCount, 0) - safeNumber(right.classificationEvidence.blockerFamilyCount, 0)
  if (blockerDiff !== 0) return blockerDiff

  const pageDiff = safeNumber(left.classificationEvidence.pageCount, Number.MAX_SAFE_INTEGER) - safeNumber(right.classificationEvidence.pageCount, Number.MAX_SAFE_INTEGER)
  if (pageDiff !== 0) return pageDiff

  const scannedDiff = Number(Boolean(left.classificationEvidence.isScanned)) - Number(Boolean(right.classificationEvidence.isScanned))
  if (scannedDiff !== 0) return scannedDiff

  const evidenceDiff = evidenceStrengthRank(left) - evidenceStrengthRank(right)
  if (evidenceDiff !== 0) return evidenceDiff

  return left.publicationId.localeCompare(right.publicationId)
}

function computePassLikelihoodScore(row: CorpusControlPlaneRow): number {
  const bucket = row.stage4StructureDiagnostics.structureWaveBucket
  const base = bucket === 'metadata_navigation_residuals'
    ? 86
    : bucket === 'structure_only_residuals'
      ? 76
      : bucket === 'mixed_structure_figure_residuals'
        ? 58
        : 44
  const pagePenalty = Math.min(18, Math.floor(safeNumber(row.classificationEvidence.pageCount, 0) / 10))
  const blockerPenalty = Math.min(20, safeNumber(row.classificationEvidence.blockerFamilyCount, 0) * 4)
  const scannedPenalty = row.classificationEvidence.isScanned ? 12 : 0
  return Math.max(1, Math.min(99, base - pagePenalty - blockerPenalty - scannedPenalty))
}

function selectionReasonsForRow(row: CorpusControlPlaneRow): string[] {
  const bucket = row.stage4StructureDiagnostics.structureWaveBucket
  return uniqueStrings([
    bucket ? 'stage4_bucket:' + bucket : null,
    row.stage4StructureDiagnostics.originLane ? 'origin_lane:' + row.stage4StructureDiagnostics.originLane : null,
    bucket === 'metadata_navigation_residuals' ? 'metadata_navigation_cleanup_candidate' : null,
    bucket === 'structure_only_residuals' ? 'structure_only_follow_up' : null,
    bucket === 'mixed_structure_figure_residuals' ? 'mixed_structure_figure_follow_up' : null,
    bucket === 'structure_processing_error_retry' ? 'retry_bounded_structure_processing_error' : null,
    ...row.reasonCodes,
  ])
}

function applyStage4RoutingToRow(
  row: CorpusControlPlaneRow,
  pendingAnalysisByPublicationId: Map<string, Stage4StructurePendingAnalysisRow>,
  activeAnalysisByPublicationId: Map<string, Stage4StructureActiveAnalysisRow>,
  stalledAnalysisByPublicationId: Map<string, Stage4StructureStalledAnalysisRow>,
  overlapAnalysisByPublicationId: Map<string, Stage4StructureOverlapAnalysisRow>,
  activeForensicsByPublicationId: Map<string, Stage4StructureActiveForensicsRow>,
): CorpusControlPlaneRow {
  const pendingAnalysis = pendingAnalysisByPublicationId.get(row.publicationId) || null
  const activeAnalysis = activeAnalysisByPublicationId.get(row.publicationId) || null
  const stalledAnalysis = stalledAnalysisByPublicationId.get(row.publicationId) || null
  const overlapAnalysis = overlapAnalysisByPublicationId.get(row.publicationId) || null
  const activeForensics = activeForensicsByPublicationId.get(row.publicationId) || null
  const hasStage4OutcomeEvidence = Boolean(row.statusEvidence.outcomeManifestPath && /stage4-structure-wave/.test(row.statusEvidence.outcomeManifestPath))
  const nextReasonCodes = [...row.reasonCodes]
  const nextNotes = [...row.notes]
  let nextDiagnostics = deriveStructureDiagnosticsFromRow(row)
  let nextCohortLabel: CohortLabel = row.cohortLabel
  let nextStatus = row.currentCorpusStatus

  if (hasStage4OutcomeEvidence && nextDiagnostics.structureWaveBucket && row.currentCorpusStatus !== 'verified_pass') {
    nextCohortLabel = 'structure_heavy'
    nextReasonCodes.push('stage4:adopted_into_structure_lane_after_wave')
  }

  if (hasStage4OutcomeEvidence && nextDiagnostics.terminalSurvivorClass) {
    if (nextDiagnostics.terminalSurvivorClass === 'figure_spillover_survivor') {
      nextCohortLabel = 'figure_heavy'
      nextReasonCodes.push('stage4.4:figure_spillover_survivor', 'stage4:reclassified_from_structure_heavy', 'stage4:figure_dominant_after_structure_wave')
      nextNotes.push('Stage 4.4 reclassified this terminal Stage 4 survivor back to figure_heavy because the latest truthful blocker is figure debt.')
    } else if (nextDiagnostics.terminalSurvivorClass === 'staged_pass_candidate_survivor') {
      nextStatus = 'staged_for_replacement'
      nextReasonCodes.push('stage4.5:staged_pass_candidate_survivor')
    } else if (nextDiagnostics.terminalSurvivorClass === 'near_pass_grade_only') {
      nextReasonCodes.push('stage4.4:near_pass_grade_only')
    } else if (nextDiagnostics.terminalSurvivorClass === 'metadata_title_survivor') {
      nextReasonCodes.push('stage4.7:metadata_title_survivor')
    } else if (nextDiagnostics.terminalSurvivorClass === 'font_text_extractability_survivor') {
      nextReasonCodes.push('stage4.4:font_text_extractability_survivor')
    } else if (nextDiagnostics.terminalSurvivorClass === 'reading_order_only_survivor') {
      nextReasonCodes.push('stage4.4:reading_order_only_survivor')
    }
  }

  if (!hasStage4OutcomeEvidence && pendingAnalysis) {
    const forensicBucket = stage4DispositionBucket(pendingAnalysis.analysisDisposition)
    nextDiagnostics = {
      ...nextDiagnostics,
      structureWaveBucket: forensicBucket,
      hasBoundedRuntimeWording: pendingAnalysis.analysisDisposition === 'structure_processing_error_retry'
        ? true
        : nextDiagnostics.hasBoundedRuntimeWording,
    }
    nextReasonCodes.push(...pendingAnalysis.reasonCodes)
    nextNotes.push(...pendingAnalysis.notes)

    if (pendingAnalysis.analysisDisposition === 'reclassify_to_figure_heavy') {
      nextCohortLabel = 'figure_heavy'
      nextReasonCodes.push('stage4:reclassified_from_structure_heavy', 'stage4:figure_dominant_after_structure_wave')
      nextNotes.push('Stage 4.2 reclassified this row from structure_heavy to figure_heavy based on figure-dominant forensic evidence.')
    } else if (pendingAnalysis.analysisDisposition === 'structure_processing_error_retry') {
      nextStatus = 'processing_error'
    }
  }

  if (!hasStage4OutcomeEvidence && activeAnalysis) {
    nextDiagnostics = {
      ...nextDiagnostics,
      structureWaveBucket: activeAnalysis.activeDisposition,
      hasBoundedRuntimeWording: activeAnalysis.activeDisposition === 'structure_processing_error_retry'
        ? true
        : nextDiagnostics.hasBoundedRuntimeWording,
    }
    nextReasonCodes.push(...activeAnalysis.reasonCodes)
    nextNotes.push(...activeAnalysis.notes)
    if (activeAnalysis.activeDisposition === 'structure_processing_error_retry') {
      nextStatus = 'processing_error'
    }
  }

  if (!hasStage4OutcomeEvidence && activeForensics) {
    if (activeForensics.forensicsDisposition === 'reading_order_only_survivor') {
      nextDiagnostics = { ...nextDiagnostics, structureWaveBucket: 'structure_only_residuals', terminalSurvivorClass: 'reading_order_only_survivor', hasReadingOrderDebt: true }
    } else if (activeForensics.forensicsDisposition === 'metadata_title_survivor') {
      nextDiagnostics = { ...nextDiagnostics, structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: 'metadata_title_survivor' }
    } else if (activeForensics.forensicsDisposition === 'font_text_extractability_survivor') {
      nextDiagnostics = { ...nextDiagnostics, structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: 'font_text_extractability_survivor' }
    } else if (activeForensics.forensicsDisposition === 'mixed_structure_figure_residuals') {
      nextDiagnostics = { ...nextDiagnostics, structureWaveBucket: 'mixed_structure_figure_residuals', terminalSurvivorClass: null }
    } else if (activeForensics.forensicsDisposition === 'structure_processing_error_retry') {
      nextDiagnostics = { ...nextDiagnostics, structureWaveBucket: 'structure_processing_error_retry', terminalSurvivorClass: null, hasBoundedRuntimeWording: true }
      nextStatus = 'processing_error'
    } else {
      nextDiagnostics = { ...nextDiagnostics, structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: null }
    }
    nextReasonCodes.push(...activeForensics.reasonCodes)
    nextNotes.push(...activeForensics.notes)
  }

  if (!hasStage4OutcomeEvidence && overlapAnalysis) {
    if (overlapAnalysis.overlapDisposition === 'reading_order_only_survivor') {
      nextDiagnostics = {
        ...nextDiagnostics,
        structureWaveBucket: 'structure_only_residuals',
        terminalSurvivorClass: 'reading_order_only_survivor',
        hasReadingOrderDebt: true,
      }
    } else {
      nextDiagnostics = {
        ...nextDiagnostics,
        structureWaveBucket: 'metadata_navigation_residuals',
        terminalSurvivorClass: null,
      }
    }
    nextReasonCodes.push(...overlapAnalysis.reasonCodes)
    nextNotes.push(...overlapAnalysis.notes)
  }

  if (!hasStage4OutcomeEvidence && !overlapAnalysis && stalledAnalysis) {
    if (stalledAnalysis.stalledDisposition === 'metadata_title_survivor') {
      nextDiagnostics = {
        ...nextDiagnostics,
        structureWaveBucket: 'metadata_navigation_residuals',
        terminalSurvivorClass: 'metadata_title_survivor',
      }
    } else if (stalledAnalysis.stalledDisposition === 'font_text_extractability_survivor') {
      nextDiagnostics = {
        ...nextDiagnostics,
        structureWaveBucket: 'metadata_navigation_residuals',
        terminalSurvivorClass: 'font_text_extractability_survivor',
      }
    } else if (stalledAnalysis.stalledDisposition === 'mixed_structure_figure_residuals') {
      nextDiagnostics = {
        ...nextDiagnostics,
        structureWaveBucket: 'mixed_structure_figure_residuals',
        terminalSurvivorClass: null,
      }
    } else if (stalledAnalysis.stalledDisposition === 'structure_processing_error_retry') {
      nextDiagnostics = {
        ...nextDiagnostics,
        structureWaveBucket: 'structure_processing_error_retry',
        terminalSurvivorClass: null,
        hasBoundedRuntimeWording: true,
      }
      nextStatus = 'processing_error'
    } else {
      nextDiagnostics = {
        ...nextDiagnostics,
        structureWaveBucket: 'metadata_navigation_residuals',
        terminalSurvivorClass: null,
      }
    }
    nextReasonCodes.push(...stalledAnalysis.reasonCodes)
    nextNotes.push(...stalledAnalysis.notes)
  }

  if (nextCohortLabel === 'structure_heavy' && nextDiagnostics.structureWaveBucket === null && nextDiagnostics.hasMixedFigureResiduals && !nextDiagnostics.hasLogicalStructureDebt && !nextDiagnostics.hasMetadataNavigationDebt) {
    nextCohortLabel = 'figure_heavy'
    nextReasonCodes.push('stage4:reclassified_from_structure_heavy', 'stage4:figure_dominant_after_structure_wave')
    nextNotes.push('Stage 4 reclassified this row from structure_heavy to figure_heavy after figure-dominant residual evidence.')
  } else if (nextCohortLabel === 'structure_heavy') {
    if (nextDiagnostics.structureWaveBucket === 'metadata_navigation_residuals') nextReasonCodes.push('stage4:metadata_navigation_after_wave')
    if (nextDiagnostics.structureWaveBucket === 'structure_only_residuals') nextReasonCodes.push('stage4:structure_only_after_wave')
    if (nextDiagnostics.structureWaveBucket === 'mixed_structure_figure_residuals') nextReasonCodes.push('stage4:mixed_structure_figure_after_wave')
    if (nextDiagnostics.structureWaveBucket === 'structure_processing_error_retry') nextReasonCodes.push('stage4:bounded_runtime_structure_retry')
  }

  if (nextCohortLabel === 'structure_heavy' && nextDiagnostics.structureWaveBucket === 'structure_processing_error_retry') {
    nextStatus = 'processing_error'
  }

  return {
    ...row,
    currentCorpusStatus: nextStatus,
    cohortLabel: nextCohortLabel,
    stage4StructureDiagnostics: nextDiagnostics,
    reasonCodes: uniqueStrings(nextReasonCodes),
    notes: uniqueStrings(nextNotes),
  }
}

export function applyStage4StructureWaveReclassification(
  artifacts: CorpusControlPlaneArtifacts,
  pendingAnalysisRows: Stage4StructurePendingAnalysisRow[] = [],
  activeAnalysisRows: Stage4StructureActiveAnalysisRow[] = [],
  stalledAnalysisRows: Stage4StructureStalledAnalysisRow[] = [],
  overlapAnalysisRows: Stage4StructureOverlapAnalysisRow[] = [],
  activeForensicsRows: Stage4StructureActiveForensicsRow[] = [],
): CorpusControlPlaneArtifacts {
  const pendingAnalysisByPublicationId = new Map(pendingAnalysisRows.map(row => [row.publicationId, row]))
  const activeAnalysisByPublicationId = new Map(activeAnalysisRows.map(row => [row.publicationId, row]))
  const stalledAnalysisByPublicationId = new Map(stalledAnalysisRows.map(row => [row.publicationId, row]))
  const overlapAnalysisByPublicationId = new Map(overlapAnalysisRows.map(row => [row.publicationId, row]))
  const activeForensicsByPublicationId = new Map(activeForensicsRows.map(row => [row.publicationId, row]))
  const rows = artifacts.document.rows.map(row => applyStage4RoutingToRow(row, pendingAnalysisByPublicationId, activeAnalysisByPublicationId, stalledAnalysisByPublicationId, overlapAnalysisByPublicationId, activeForensicsByPublicationId))
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

function representativeCanaryRows(artifacts: CorpusControlPlaneArtifacts, reportingWavePublicationIds: string[] = []): Stage4StructureCanaryRow[] {
  const structureRows = artifacts.document.rows.filter(row => row.cohortLabel === 'structure_heavy')
  const allRows = artifacts.document.rows
  const reportingWaveIds = new Set(reportingWavePublicationIds)
  const preferTerminalClass = (rows: CorpusControlPlaneRow[], terminalClass: Stage4TerminalSurvivorClass): CorpusControlPlaneRow | undefined => {
    return rows.find(row => reportingWaveIds.has(row.publicationId) && row.stage4StructureDiagnostics.terminalSurvivorClass === terminalClass)
      || rows.find(row => row.stage4StructureDiagnostics.terminalSurvivorClass === terminalClass && row.reasonCodes.includes('stage4.5:' + terminalClass))
      || rows.find(row => row.stage4StructureDiagnostics.terminalSurvivorClass === terminalClass && row.reasonCodes.includes('stage4.4:' + terminalClass))
      || rows.find(row => row.stage4StructureDiagnostics.terminalSurvivorClass === terminalClass)
  }
  const picks: Array<{ kind: Stage4StructureCanaryRow['stage4RepresentativeKind']; row: CorpusControlPlaneRow | undefined }> = [
    { kind: 'staged_pass_candidate_survivor', row: preferTerminalClass(allRows, 'staged_pass_candidate_survivor') },
    { kind: 'verified_pass', row: structureRows.find(row => row.currentCorpusStatus === 'verified_pass') },
    { kind: 'near_pass_grade_only', row: preferTerminalClass(allRows, 'near_pass_grade_only') },
    { kind: 'metadata_title_survivor', row: preferTerminalClass(allRows, 'metadata_title_survivor') },
    { kind: 'font_text_extractability_survivor', row: preferTerminalClass(allRows, 'font_text_extractability_survivor') },
    { kind: 'reading_order_only_survivor', row: preferTerminalClass(allRows, 'reading_order_only_survivor') || structureRows.find(row => row.stage4StructureDiagnostics.structureWaveBucket === 'structure_only_residuals' && (row.classificationEvidence.pageCount || 0) >= 40) || structureRows.find(row => row.stage4StructureDiagnostics.structureWaveBucket === 'structure_only_residuals') },
    { kind: 'figure_spillover_survivor', row: preferTerminalClass(allRows, 'figure_spillover_survivor') },
    { kind: 'structure_processing_error_retry', row: structureRows.find(row => row.stage4StructureDiagnostics.structureWaveBucket === 'structure_processing_error_retry') },
  ]

  const deduped: Stage4StructureCanaryRow[] = []
  const seen = new Set<string>()
  for (const pick of picks) {
    if (!pick.row) continue
    const key = [pick.kind || '', pick.row.publicationId].join(':')
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push({
      publicationId: pick.row.publicationId,
      publicationTitle: pick.row.title,
      source: 'cohort_representative',
      benchmarkName: null,
      stage4RepresentativeKind: pick.kind,
      currentCorpusStatus: pick.row.currentCorpusStatus,
      currentCohortLabel: pick.row.cohortLabel,
      structureWaveBucket: pick.row.stage4StructureDiagnostics.structureWaveBucket,
      originLane: pick.row.stage4StructureDiagnostics.originLane,
      hasGenericTimeoutWording: false,
      benchmarkTerminalState: null,
      notes: uniqueStrings([
        pick.kind === 'figure_spillover_survivor' ? 'Figure spillover survivor representative.' : null,
        pick.kind === 'structure_processing_error_retry' ? 'Bounded-runtime structure retry representative.' : null,
        pick.row.statusEvidence.latestReportPath || null,
      ]),
    })
  }
  return deduped
}

export function buildStage4StructureCanaries(input: {
  artifacts: CorpusControlPlaneArtifacts
  sources: CorpusControlPlaneSources
  reportingWavePublicationIds?: string[]
}): Stage4StructureCanariesDocument {
  const rowByPublicationId = new Map(input.artifacts.document.rows.map(row => [row.publicationId, row]))
  const publicationIdByLocalPath = new Map<string, string>()
  for (const replacementRow of input.sources.replacementMap) {
    const localPath = replacementRow.checksumState?.localCurrentFilePath
    if (localPath) publicationIdByLocalPath.set(localPath, replacementRow.publicationId)
  }

  const benchmarkRows: Stage4StructureCanaryRow[] = input.sources.regressionBenchmarkOutcomes
    .filter(outcome => outcome.category === 'structure')
    .slice(0, 3)
    .map(outcome => {
      const publicationId = publicationIdByLocalPath.get(outcome.filePath) || null
      const matched = publicationId ? rowByPublicationId.get(publicationId) || null : null
      return {
        publicationId,
        publicationTitle: matched?.title || null,
        source: 'benchmark',
        benchmarkName: outcome.name,
        stage4RepresentativeKind: null,
        currentCorpusStatus: matched?.currentCorpusStatus || null,
        currentCohortLabel: matched?.cohortLabel || null,
        structureWaveBucket: matched?.stage4StructureDiagnostics.structureWaveBucket || null,
        originLane: matched?.stage4StructureDiagnostics.originLane || null,
        hasGenericTimeoutWording: false,
        benchmarkTerminalState: outcome.terminalState || null,
        notes: uniqueStrings([
          outcome.category ? 'benchmark_category:' + outcome.category : null,
          outcome.error?.message || null,
        ]),
      }
    })

  const rows = [...benchmarkRows, ...representativeCanaryRows(input.artifacts, input.reportingWavePublicationIds || [])]
  const deduped: Stage4StructureCanaryRow[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const key = [row.source, row.publicationId || '', row.benchmarkName || '', row.stage4RepresentativeKind || ''].join(':')
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(row)
  }

  const bySource = { benchmark: 0, cohort_representative: 0 }
  const byStructureWaveBucket = emptyBucketCounts()
  for (const row of deduped) {
    bySource[row.source] += 1
    if (row.structureWaveBucket) byStructureWaveBucket[row.structureWaveBucket] += 1
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalCanaries: deduped.length,
      bySource,
      byStructureWaveBucket,
      withGenericTimeoutWording: 0,
    },
    rows: deduped,
  }
}

export function buildStage4StructureWaveArtifacts(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manifestsRoot: string
  maxCandidates?: number
  includePublicationIds?: string[]
  pendingAnalysisRows?: Stage4StructurePendingAnalysisRow[]
  activeAnalysisRows?: Stage4StructureActiveAnalysisRow[]
  stalledAnalysisRows?: Stage4StructureStalledAnalysisRow[]
  overlapAnalysisRows?: Stage4StructureOverlapAnalysisRow[]
  activeForensicsRows?: Stage4StructureActiveForensicsRow[]
}): {
  wave: Stage4StructureWaveDocument
  summary: Stage4StructureWaveSummaryDocument
} {
  const maxCandidates = Math.max(1, input.maxCandidates || 8)
  const includePublicationIds = uniqueStrings(input.includePublicationIds || [])
  const includePublicationIdSet = new Set(includePublicationIds)
  const currentWavePath = path.join(input.manifestsRoot, 'stage4-structure-wave.json')
  const currentOutcomesPath = path.join(input.manifestsRoot, 'stage4-structure-wave.outcomes.json')
  const existingWave = loadJsonIfExists(currentWavePath) as Stage4StructureWaveDocument | null
  const existingOutcomes = loadJsonIfExists(currentOutcomesPath) as { outcomes?: OutcomeLike[] } | null
  const terminalOutcomeIds = terminalPublicationIdsFromOutcomes(existingOutcomes)
  const forensicallyResolvedPendingIds = new Set((input.pendingAnalysisRows || []).map(row => row.publicationId))
  const activeAnalysisPublicationIds = uniqueStrings((input.activeAnalysisRows || []).map(row => row.publicationId))
  const stalledAnalysisPublicationIds = uniqueStrings((input.stalledAnalysisRows || []).map(row => row.publicationId))
  const overlapAnalysisPublicationIds = uniqueStrings((input.overlapAnalysisRows || []).map(row => row.publicationId))
  const activeForensicsPublicationIds = uniqueStrings((input.activeForensicsRows || []).map(row => row.publicationId))
  const activeAnalysisIds = new Set(activeAnalysisPublicationIds)
  const activeEligiblePublicationIds = new Set(
    input.artifacts.document.rows
      .filter(row => row.cohortLabel === 'structure_heavy' && row.currentCorpusStatus !== 'verified_pass' && row.stage4StructureDiagnostics.structureWaveBucket)
      .map(row => row.publicationId),
  )
  const existingUnresolvedPublicationIds = pendingPublicationIdsFromExistingArtifacts(existingWave, existingOutcomes)
    .filter(publicationId => activeEligiblePublicationIds.has(publicationId))
    .filter(publicationId => activeAnalysisIds.has(publicationId) || !forensicallyResolvedPendingIds.has(publicationId))
  const continuationPublicationIds = activeAnalysisPublicationIds.length > 0
    ? activeAnalysisPublicationIds.filter(publicationId => activeEligiblePublicationIds.has(publicationId) && !terminalOutcomeIds.has(publicationId))
    : existingUnresolvedPublicationIds
  const continueExistingActiveWave = includePublicationIds.length === 0 && continuationPublicationIds.length > 0
  const allowedPublicationIds = continueExistingActiveWave
    ? new Set(continuationPublicationIds)
    : includePublicationIdSet

  const stage4Rows = input.artifacts.document.rows
    .filter(row => row.cohortLabel === 'structure_heavy' && row.currentCorpusStatus !== 'verified_pass')
    .filter(row => !terminalOutcomeIds.has(row.publicationId))
    .filter(row => !terminalSurvivorClassFromRow(row))
    .filter(row => continueExistingActiveWave
      ? allowedPublicationIds.has(row.publicationId)
      : includePublicationIds.length === 0 || allowedPublicationIds.has(row.publicationId))
    .sort(compareWaveRows)

  const skippedRows: Stage4StructureWaveSkippedRow[] = []
  const eligibleRows: CorpusControlPlaneRow[] = []
  for (const row of stage4Rows) {
    const skipReasons: string[] = []
    if (!row.stage4StructureDiagnostics.structureWaveBucket) skipReasons.push('missing_structure_wave_bucket')
    if (!row.sourceMetadata.currentSourcePath) skipReasons.push('missing_local_source_path')
    if (!row.remotePath) skipReasons.push('missing_remote_path')
    if (skipReasons.length) {
      skippedRows.push({
        publicationId: row.publicationId,
        publicationTitle: row.title,
        currentCorpusStatus: row.currentCorpusStatus,
        structureWaveBucket: row.stage4StructureDiagnostics.structureWaveBucket,
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
      structureWaveBucket: row.stage4StructureDiagnostics.structureWaveBucket,
      skipReasons: [
        'not_in_current_wave_capacity',
        row.stage4StructureDiagnostics.structureWaveBucket ? 'stage4_bucket:' + row.stage4StructureDiagnostics.structureWaveBucket : 'stage4_bucket:none',
        row.statusEvidence.outcomeStatus ? 'latest_outcome_status:' + row.statusEvidence.outcomeStatus : 'latest_outcome_status:none',
        ...(activeAnalysisIds.has(row.publicationId) ? ['active_analysis_resolved'] : []),
        ...(stalledAnalysisPublicationIds.includes(row.publicationId) ? ['stalled_analysis_resolved'] : []),
        ...(overlapAnalysisPublicationIds.includes(row.publicationId) ? ['overlap_analysis_resolved'] : []),
        ...(activeForensicsPublicationIds.includes(row.publicationId) ? ['active_forensics_resolved'] : []),
      ],
    })
  }

  const candidates: Stage4StructureWaveCandidate[] = selectedRows.map((row, index) => ({
    priorityRank: index + 1,
    passLikelihoodScore: computePassLikelihoodScore(row),
    priorityTier: priorityTierForBucket(row.stage4StructureDiagnostics.structureWaveBucket as StructureWaveBucket),
    recommendedAction: 'fix_first',
    publicationId: row.publicationId,
    publicationTitle: row.title,
    serverHost: row.serverHost,
    remotePath: row.remotePath,
    localCachePath: row.sourceMetadata.currentSourcePath,
    fileUrl: row.fileUrl,
    storageKind: row.storageKind,
    currentCorpusStatus: row.currentCorpusStatus,
    structureWaveBucket: row.stage4StructureDiagnostics.structureWaveBucket as StructureWaveBucket,
    selectionReasons: selectionReasonsForRow(row),
    reportPath: row.statusEvidence.latestReportPath || row.statusEvidence.verificationReportPath || input.sourceControlPlanePath,
    pageCount: safeNumber(row.classificationEvidence.pageCount, 0),
    isScanned: Boolean(row.classificationEvidence.isScanned),
    blockerFamilyCount: safeNumber(row.classificationEvidence.blockerFamilyCount, 0),
    blockingFindingCount: safeNumber(row.classificationEvidence.blockingFindingCount, 0),
    topBlockingResidualFamilyIds: row.classificationEvidence.topBlockingResidualFamilyIds,
    blockingFindingKeys: row.classificationEvidence.blockingFindingKeys,
    dominantStructurePhase: row.stage4StructureDiagnostics.dominantStructurePhase,
    hasLogicalStructureDebt: row.stage4StructureDiagnostics.hasLogicalStructureDebt,
    hasHeadingDebt: row.stage4StructureDiagnostics.hasHeadingDebt,
    hasReadingOrderDebt: row.stage4StructureDiagnostics.hasReadingOrderDebt,
    hasMetadataNavigationDebt: row.stage4StructureDiagnostics.hasMetadataNavigationDebt,
    hasMixedFigureResiduals: row.stage4StructureDiagnostics.hasMixedFigureResiduals,
    hasBoundedRuntimeWording: row.stage4StructureDiagnostics.hasBoundedRuntimeWording,
    originLane: row.stage4StructureDiagnostics.originLane,
  }))

  const wave: Stage4StructureWaveDocument = {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    waveName: 'stage4-structure-wave',
    cohortLabel: 'structure_heavy',
    maxCandidates,
    totals: {
      eligibleRows: eligibleRows.length,
      selectedRows: candidates.length,
      skippedRows: skippedRows.length,
      pendingRows: candidates.map(candidate => candidate.publicationId).filter((value): value is string => Boolean(value)).length,
    },
    selectedPublicationIds: candidates.map(candidate => candidate.publicationId).filter((value): value is string => Boolean(value)),
    pendingPublicationIds: candidates.map(candidate => candidate.publicationId).filter((value): value is string => Boolean(value)),
    candidates,
    skippedRows: skippedRows.sort((left, right) => left.publicationId.localeCompare(right.publicationId)),
  }

  const selectedByTier = { highest: 0, high: 0, medium: 0, low: 0 }
  const selectedByStatus = emptyStatusCounts()
  const selectedByStructureWaveBucket = emptyBucketCounts()
  for (const candidate of candidates) {
    selectedByTier[candidate.priorityTier] += 1
    selectedByStatus[candidate.currentCorpusStatus] += 1
    selectedByStructureWaveBucket[candidate.structureWaveBucket] += 1
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
      pendingPublicationIds: candidates.map(candidate => candidate.publicationId).filter((value): value is string => Boolean(value)),
      activeWaveSelectedPublicationIds: wave.selectedPublicationIds,
      activeWavePendingPublicationIds: wave.pendingPublicationIds,
      activeWaveAttemptedButUnterminalizedPublicationIds: wave.pendingPublicationIds,
      selectedByTier,
      selectedByStatus,
      selectedByStructureWaveBucket,
    },
  }
}

export function buildStage4StructureThroughputSummary(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  waveManifestPath: string
  wave: Stage4StructureWaveDocument | null
  activeWave?: Stage4StructureWaveDocument | null
  outcomesPath: string | null
  outcomes: { outcomes?: OutcomeLike[] } | null
  pendingAnalysisRows?: Stage4StructurePendingAnalysisRow[]
  activeAnalysisRows?: Stage4StructureActiveAnalysisRow[]
  stalledAnalysisRows?: Stage4StructureStalledAnalysisRow[]
  overlapAnalysisRows?: Stage4StructureOverlapAnalysisRow[]
  activeForensicsRows?: Stage4StructureActiveForensicsRow[]
}): Stage4StructureThroughputSummaryDocument {
  const structureRows = input.artifacts.document.rows.filter(row => row.cohortLabel === 'structure_heavy')
  const allRows = input.artifacts.document.rows
  const waveIds = new Set(input.wave?.selectedPublicationIds || [])
  const activeWave = input.activeWave || input.wave
  const activeWaveIds = new Set(activeWave?.selectedPublicationIds || [])
  const rowsById = new Map(allRows.map(row => [row.publicationId, row]))
  const currentWaveOutcomes = (input.outcomes?.outcomes || []).filter(outcome => outcome.publicationId && waveIds.has(outcome.publicationId))
  const currentWaveProcessedPublicationIds = uniqueStrings(currentWaveOutcomes.map(outcome => outcome.publicationId))
  const currentWaveRemainingPublicationIds = uniqueStrings((input.wave?.selectedPublicationIds || []).filter(publicationId => !terminalPublicationIdsFromOutcomes({ outcomes: currentWaveOutcomes }).has(publicationId)))

  const newlyVerifiedPassPublicationIds = Array.from(waveIds)
    .filter(publicationId => {
      const row = rowsById.get(publicationId)
      return Boolean(row?.currentCorpusStatus === 'verified_pass' && row.promotionTruth.ledgerRowPresent)
    })
    .sort()

  const remainingPublicationIds = structureRows
    .filter(row => row.currentCorpusStatus !== 'verified_pass')
    .map(row => row.publicationId)
    .sort()

  const processingErrorPublicationIds = uniqueStrings(currentWaveOutcomes.filter(outcome => outcome.status === 'processing_error').map(outcome => outcome.publicationId))
  const hardFailPublicationIds = uniqueStrings(currentWaveOutcomes.filter(outcome => outcome.status === 'failed_after_remediation').map(outcome => outcome.publicationId))
  const forensicResolvedPublicationIds = uniqueStrings((input.pendingAnalysisRows || []).map(row => row.publicationId))
  const activeAnalysisPublicationIds = uniqueStrings((input.activeAnalysisRows || []).map(row => row.publicationId))
  const stalledAnalysisRows = input.stalledAnalysisRows || []
  const overlapAnalysisRows = input.overlapAnalysisRows || []
  const activeForensicsRows = input.activeForensicsRows || []
  const stalledForensicPublicationIds = uniqueStrings(stalledAnalysisRows.map(row => row.publicationId))
  const overlapAnalysisPublicationIds = uniqueStrings(overlapAnalysisRows.map(row => row.publicationId))
  const activeForensicsPublicationIds = uniqueStrings(activeForensicsRows.map(row => row.publicationId))
  const activeWaveSelectedPublicationIds = uniqueStrings(activeWave?.selectedPublicationIds || [])
  const activeWavePendingPublicationIds = uniqueStrings((activeWave?.selectedPublicationIds || []).filter(publicationId => !terminalPublicationIdsFromOutcomes({ outcomes: (input.outcomes?.outcomes || []).filter(outcome => outcome.publicationId && activeWaveIds.has(outcome.publicationId)) }).has(publicationId)))
  const activeWaveAttemptedButUnterminalizedPublicationIds = uniqueStrings(activeWavePendingPublicationIds.filter(publicationId => stalledForensicPublicationIds.includes(publicationId)))
  const stalledForensicByDisposition = {
    metadata_title_survivor: uniqueStrings(stalledAnalysisRows.filter(row => row.stalledDisposition === 'metadata_title_survivor').map(row => row.publicationId)),
    metadata_navigation_residuals: uniqueStrings(stalledAnalysisRows.filter(row => row.stalledDisposition === 'metadata_navigation_residuals').map(row => row.publicationId)),
    font_text_extractability_survivor: uniqueStrings(stalledAnalysisRows.filter(row => row.stalledDisposition === 'font_text_extractability_survivor').map(row => row.publicationId)),
    mixed_structure_figure_residuals: uniqueStrings(stalledAnalysisRows.filter(row => row.stalledDisposition === 'mixed_structure_figure_residuals').map(row => row.publicationId)),
    structure_processing_error_retry: uniqueStrings(stalledAnalysisRows.filter(row => row.stalledDisposition === 'structure_processing_error_retry').map(row => row.publicationId)),
  }
  const activeForensicsByDisposition = {
    metadata_title_survivor: uniqueStrings(activeForensicsRows.filter(row => row.forensicsDisposition === 'metadata_title_survivor').map(row => row.publicationId)),
    metadata_navigation_residuals: uniqueStrings(activeForensicsRows.filter(row => row.forensicsDisposition === 'metadata_navigation_residuals').map(row => row.publicationId)),
    font_text_extractability_survivor: uniqueStrings(activeForensicsRows.filter(row => row.forensicsDisposition === 'font_text_extractability_survivor').map(row => row.publicationId)),
    reading_order_only_survivor: uniqueStrings(activeForensicsRows.filter(row => row.forensicsDisposition === 'reading_order_only_survivor').map(row => row.publicationId)),
    mixed_structure_figure_residuals: uniqueStrings(activeForensicsRows.filter(row => row.forensicsDisposition === 'mixed_structure_figure_residuals').map(row => row.publicationId)),
    structure_processing_error_retry: uniqueStrings(activeForensicsRows.filter(row => row.forensicsDisposition === 'structure_processing_error_retry').map(row => row.publicationId)),
  }
  const pendingPublicationIds = activeWavePendingPublicationIds
  const activeUnresolvedPublicationIds = activeWavePendingPublicationIds
  const stillUnclassifiedPendingPublicationIds = activeWavePendingPublicationIds.filter(publicationId => !activeAnalysisPublicationIds.includes(publicationId) && !stalledForensicPublicationIds.includes(publicationId) && !overlapAnalysisPublicationIds.includes(publicationId) && !activeForensicsPublicationIds.includes(publicationId))

  const readingOrderOnlyResidualPublicationIds = uniqueStrings(allRows
    .filter(row => terminalSurvivorClassFromRow(row) === 'reading_order_only_survivor')
    .map(row => row.publicationId))
  const stagedPassCandidatePublicationIds = uniqueStrings(allRows
    .filter(row => terminalSurvivorClassFromRow(row) === 'staged_pass_candidate_survivor')
    .map(row => row.publicationId))
  const nearPassGradeOnlyPublicationIds = uniqueStrings(allRows
    .filter(row => terminalSurvivorClassFromRow(row) === 'near_pass_grade_only')
    .map(row => row.publicationId))
  const metadataTitleSurvivorPublicationIds = uniqueStrings(allRows
    .filter(row => terminalSurvivorClassFromRow(row) === 'metadata_title_survivor')
    .map(row => row.publicationId))
  const fontTextExtractabilitySurvivorPublicationIds = uniqueStrings(allRows
    .filter(row => terminalSurvivorClassFromRow(row) === 'font_text_extractability_survivor')
    .map(row => row.publicationId))
  const figureSpilloverSurvivorPublicationIds = uniqueStrings(allRows
    .filter(row => terminalSurvivorClassFromRow(row) === 'figure_spillover_survivor')
    .map(row => row.publicationId))

  const bucketIds = {
    metadata_navigation_residuals: structureRows.filter(row => row.stage4StructureDiagnostics.structureWaveBucket === 'metadata_navigation_residuals' && row.currentCorpusStatus !== 'verified_pass' && !terminalSurvivorClassFromRow(row)).map(row => row.publicationId).sort(),
    structure_only_residuals: structureRows.filter(row => row.stage4StructureDiagnostics.structureWaveBucket === 'structure_only_residuals' && row.currentCorpusStatus !== 'verified_pass' && !terminalSurvivorClassFromRow(row)).map(row => row.publicationId).sort(),
    mixed_structure_figure_residuals: structureRows.filter(row => row.stage4StructureDiagnostics.structureWaveBucket === 'mixed_structure_figure_residuals' && row.currentCorpusStatus !== 'verified_pass' && !terminalSurvivorClassFromRow(row)).map(row => row.publicationId).sort(),
    structure_processing_error_retry: structureRows.filter(row => row.stage4StructureDiagnostics.structureWaveBucket === 'structure_processing_error_retry' && row.currentCorpusStatus !== 'verified_pass' && !terminalSurvivorClassFromRow(row)).map(row => row.publicationId).sort(),
  }

  const nextWaveStructureOnlyPublicationIds = uniqueStrings([
    ...bucketIds.metadata_navigation_residuals,
    ...bucketIds.structure_only_residuals,
  ])
  const mixedFollowupPublicationIds = bucketIds.mixed_structure_figure_residuals
  const boundedRuntimeRetryPublicationIds = bucketIds.structure_processing_error_retry
  const reclassifiedOutOfStructureHeavyPublicationIds = allRows
    .filter(row => row.reasonCodes.includes('stage4:reclassified_from_structure_heavy'))
    .map(row => row.publicationId)
    .sort()

  return {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    waveManifestPath: input.waveManifestPath,
    waveOutcomesPath: input.outcomesPath,
    cohortLabel: 'structure_heavy',
    totals: {
      totalStructureHeavyRows: structureRows.length,
      verifiedPassRowsInCohort: structureRows.filter(row => row.currentCorpusStatus === 'verified_pass').length,
      newlyVerifiedPassRowsFromWave: newlyVerifiedPassPublicationIds.length,
      remainingStructureHeavyRows: remainingPublicationIds.length,
      processingErrorsInWave: processingErrorPublicationIds.length,
      hardFailsInWave: hardFailPublicationIds.length,
      metadataNavigationResidualRows: bucketIds.metadata_navigation_residuals.length,
      structureOnlyResidualRows: bucketIds.structure_only_residuals.length,
      mixedStructureFigureResidualRows: bucketIds.mixed_structure_figure_residuals.length,
      structureProcessingErrorRetryRows: bucketIds.structure_processing_error_retry.length,
      pendingWaveRows: activeWavePendingPublicationIds.length,
      reclassifiedOutOfStructureHeavyRows: reclassifiedOutOfStructureHeavyPublicationIds.length,
      genericTimeoutRows: 0,
    },
    rows: {
      newlyVerifiedPassPublicationIds,
      stagedPassCandidatePublicationIds,
      metadataTitleSurvivorPublicationIds,
      remainingPublicationIds,
      activeWaveSelectedPublicationIds,
      activeWavePendingPublicationIds,
      activeWaveAttemptedButUnterminalizedPublicationIds,
      processingErrorPublicationIds,
      hardFailPublicationIds,
      readingOrderOnlyResidualPublicationIds,
      metadataNavigationResidualPublicationIds: bucketIds.metadata_navigation_residuals,
      structureOnlyResidualPublicationIds: bucketIds.structure_only_residuals,
      mixedStructureFigureResidualPublicationIds: bucketIds.mixed_structure_figure_residuals,
      structureProcessingErrorRetryPublicationIds: bucketIds.structure_processing_error_retry,
      pendingPublicationIds,
      nextWaveStructureOnlyPublicationIds,
      mixedFollowupPublicationIds,
      boundedRuntimeRetryPublicationIds,
      reclassifiedOutOfStructureHeavyPublicationIds,
      forensicallyResolvedPendingPublicationIds: forensicResolvedPublicationIds,
      stillUnclassifiedPendingPublicationIds,
      activeUnresolvedPublicationIds,
      stalledForensicPublicationIds,
      stalledForensicByDisposition,
      overlapAnalysisPublicationIds,
      activeForensicsPublicationIds,
      activeForensicsByDisposition,
      nearPassGradeOnlyPublicationIds,
      fontTextExtractabilitySurvivorPublicationIds,
      figureSpilloverSurvivorPublicationIds,
      currentWaveProcessedPublicationIds,
      currentWaveRemainingPublicationIds,
      genericTimeoutPublicationIds: [],
    },
  }
}
