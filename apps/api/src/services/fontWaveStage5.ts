import fs from 'node:fs'
import path from 'node:path'
import type {
  CorpusControlPlaneArtifacts,
  CorpusControlPlaneRow,
  CorpusStatus,
} from './corpusControlPlane.ts'

export type Stage5FontForensicsDisposition =
  | 'embedded_font_repairable'
  | 'deterministic_unicode_map_repair_available'
  | 'type1_unicode_fallback_candidate'
  | 'font_unicode_terminal_survivor'
  | 'font_processing_error_retry'
  | 'font_unicode_manual_residual'

export interface Stage5FontForensicsRow {
  publicationId: string
  publicationTitle: string | null
  currentCorpusStatus: CorpusStatus
  currentCohortLabel: string
  forensicsDisposition: Stage5FontForensicsDisposition
  blockingFindingKeys: string[]
  reportFindingKeys: string[]
  reasonCodes: string[]
  latestReportPath: string | null
  fontUnicodeCount: number
  fontEmbeddingCount: number
  type1UnicodeCount: number
  cidsetConsistencyCount: number
  recommendedRepairOrder: Array<'embed_missing_fonts_in_place' | 'repair_font_unicode_maps' | 'repair_type1_font_unicode_maps'>
  notes: string[]
}

export interface Stage5FontForensicsDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  cohortLabel: 'font_heavy'
  includePublicationIds: string[]
  summaryPath: string
  rows: Stage5FontForensicsRow[]
}

export interface Stage5FontForensicsSummaryDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  forensicsManifestPath: string
  cohortLabel: 'font_heavy'
  totals: {
    totalFontHeavyRows: number
    analyzedRows: number
    stillUnclassifiedRows: number
  }
  publicationIdsByDisposition: Record<Stage5FontForensicsDisposition, string[]>
  includePublicationIds: string[]
  stillUnclassifiedPublicationIds: string[]
}

export interface Stage5FontWaveCandidate {
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
  stage5FontDisposition: Stage5FontForensicsDisposition
  selectionReasons: string[]
  reportPath: string | null
  pageCount: number
  isScanned: boolean
  overallScore: number | null
  grade: string | null
  blockingFindingKeys: string[]
  fontUnicodeCount: number
  fontEmbeddingCount: number
  type1UnicodeCount: number
}

export interface Stage5FontWaveSkippedRow {
  publicationId: string
  publicationTitle: string | null
  currentCorpusStatus: CorpusStatus
  stage5FontDisposition: Stage5FontForensicsDisposition | null
  skipReasons: string[]
}

export interface Stage5FontWaveDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  waveName: 'stage5-font-wave'
  cohortLabel: 'font_heavy'
  maxCandidates: number
  totals: {
    eligibleRows: number
    selectedRows: number
    skippedRows: number
    pendingRows: number
  }
  selectedPublicationIds: string[]
  pendingPublicationIds: string[]
  candidates: Stage5FontWaveCandidate[]
  skippedRows: Stage5FontWaveSkippedRow[]
}

export interface Stage5FontWaveSummaryDocument {
  generatedAt: string
  waveManifestPath: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  totals: Stage5FontWaveDocument['totals']
  selectedPublicationIds: string[]
  pendingPublicationIds: string[]
  selectedByTier: Record<'highest' | 'high' | 'medium' | 'low', number>
  selectedByStatus: Record<CorpusStatus, number>
  selectedByDisposition: Record<Stage5FontForensicsDisposition, number>
}

export interface Stage5FontThroughputSummaryDocument {
  generatedAt: string
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  waveManifestPath: string
  waveOutcomesPath: string | null
  forensicsManifestPath: string
  cohortLabel: 'font_heavy'
  totals: {
    totalFontHeavyRows: number
    verifiedPassRowsInCohort: number
    remainingFontHeavyRows: number
    newlyVerifiedPassRowsFromWave: number
    processingErrorsInWave: number
    hardFailsInWave: number
    pendingWaveRows: number
    embeddedFontRepairableRows: number
    deterministicUnicodeRepairRows: number
    type1FallbackRows: number
    terminalSurvivorRows: number
    processingRetryRows: number
    manualResidualRows: number
    stillUnclassifiedRows: number
  }
  rows: {
    newlyVerifiedPassPublicationIds: string[]
    remainingPublicationIds: string[]
    processingErrorPublicationIds: string[]
    hardFailPublicationIds: string[]
    pendingPublicationIds: string[]
    activeWaveSelectedPublicationIds: string[]
    embeddedFontRepairablePublicationIds: string[]
    deterministicUnicodeRepairPublicationIds: string[]
    type1FallbackPublicationIds: string[]
    terminalSurvivorPublicationIds: string[]
    processingRetryPublicationIds: string[]
    manualResidualPublicationIds: string[]
    stillUnclassifiedPublicationIds: string[]
  }
}

interface LocalStandardsFindingLike {
  key?: string | null
  blocking?: boolean | null
  count?: number | null
  evidence?: string[] | null
}

type OutcomeLike = {
  publicationId?: string | null
  status?: string | null
  deferred?: {
    reasonCode?: string | null
    skipNextBatch?: boolean | null
    notes?: string | null
  } | null
}

type ReportLike = {
  candidate?: {
    plannerEvidence?: {
      attemptedKeys?: string[] | null
      noEffectKeys?: string[] | null
    } | null
  } | null
  gate?: {
    blockingLocalFindingKeys?: string[] | null
    criticalManualReviewFlagCodes?: string[] | null
  } | null
  result?: {
    localStandards?: {
      findings?: LocalStandardsFindingLike[] | null
    } | null
  } | null
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

function emptyDispositionCounts(): Record<Stage5FontForensicsDisposition, number> {
  return {
    embedded_font_repairable: 0,
    deterministic_unicode_map_repair_available: 0,
    type1_unicode_fallback_candidate: 0,
    font_unicode_terminal_survivor: 0,
    font_processing_error_retry: 0,
    font_unicode_manual_residual: 0,
  }
}

function safeNumber(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

function readJsonIfExists<T>(filePath: string | null): T | null {
  if (!filePath || !fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function terminalStatus(status: string | null | undefined): boolean {
  return ['failed_after_remediation', 'processing_error', 'ready_to_replace', 'remediated_pass_candidate', 'source_missing'].includes(status || '')
}

function pendingPublicationIdsFromExistingArtifacts(
  waveDoc: Stage5FontWaveDocument | null,
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

function compareForensicsRows(left: Stage5FontForensicsRow, right: Stage5FontForensicsRow, rowById: Map<string, CorpusControlPlaneRow>): number {
  const dispositionRank = {
    embedded_font_repairable: 0,
    deterministic_unicode_map_repair_available: 1,
    type1_unicode_fallback_candidate: 2,
    font_processing_error_retry: 3,
    font_unicode_terminal_survivor: 4,
    font_unicode_manual_residual: 5,
  } satisfies Record<Stage5FontForensicsDisposition, number>

  const dispositionDiff = dispositionRank[left.forensicsDisposition] - dispositionRank[right.forensicsDisposition]
  if (dispositionDiff !== 0) return dispositionDiff

  const unicodeDiff = left.fontUnicodeCount - right.fontUnicodeCount
  if (unicodeDiff !== 0) return unicodeDiff

  const leftRow = rowById.get(left.publicationId)
  const rightRow = rowById.get(right.publicationId)
  const pageDiff = safeNumber(leftRow?.classificationEvidence.pageCount, Number.MAX_SAFE_INTEGER) - safeNumber(rightRow?.classificationEvidence.pageCount, Number.MAX_SAFE_INTEGER)
  if (pageDiff !== 0) return pageDiff

  return left.publicationId.localeCompare(right.publicationId)
}

function priorityTierForDisposition(disposition: Stage5FontForensicsDisposition): 'highest' | 'high' | 'medium' | 'low' {
  return ({
    embedded_font_repairable: 'highest',
    deterministic_unicode_map_repair_available: 'high',
    type1_unicode_fallback_candidate: 'medium',
    font_processing_error_retry: 'medium',
    font_unicode_terminal_survivor: 'low',
    font_unicode_manual_residual: 'low',
  } as const)[disposition]
}

function recommendedRepairOrderForDisposition(disposition: Stage5FontForensicsDisposition): Array<'embed_missing_fonts_in_place' | 'repair_font_unicode_maps' | 'repair_type1_font_unicode_maps'> {
  switch (disposition) {
    case 'embedded_font_repairable':
      return ['embed_missing_fonts_in_place', 'repair_font_unicode_maps', 'repair_type1_font_unicode_maps']
    case 'type1_unicode_fallback_candidate':
      return ['repair_font_unicode_maps', 'repair_type1_font_unicode_maps']
    case 'font_processing_error_retry':
      return ['repair_font_unicode_maps']
    case 'deterministic_unicode_map_repair_available':
      return ['repair_font_unicode_maps']
    case 'font_unicode_terminal_survivor':
    case 'font_unicode_manual_residual':
      return []
  }
}

function normalizeFindingKey(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function readLatestReport(row: CorpusControlPlaneRow): ReportLike | null {
  const latestReportPath = row.statusEvidence.latestReportPath
  return readJsonIfExists<ReportLike>(latestReportPath)
}

function readLatestOutcome(row: CorpusControlPlaneRow): OutcomeLike | null {
  const outcomeManifestPath = row.statusEvidence.outcomeManifestPath
  if (!outcomeManifestPath) return null
  const doc = readJsonIfExists<{ outcomes?: OutcomeLike[] }>(outcomeManifestPath)
  if (!doc?.outcomes?.length) return null
  return doc.outcomes.find(outcome => outcome.publicationId === row.publicationId) || null
}

function findingCount(findingsByKey: Map<string, LocalStandardsFindingLike>, key: string): number {
  return safeNumber(findingsByKey.get(key)?.count, 0)
}

function findingEvidence(findingsByKey: Map<string, LocalStandardsFindingLike>, key: string): string[] {
  return (findingsByKey.get(key)?.evidence || []).filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

function remediationAttemptSignals(report: ReportLike | null): {
  attemptedGenericUnicodeRepair: boolean
  noEffectGenericUnicodeRepair: boolean
  attemptedType1UnicodeRepair: boolean
  noEffectType1UnicodeRepair: boolean
} {
  const attemptedKeys = report?.candidate?.plannerEvidence?.attemptedKeys || []
  const noEffectKeys = report?.candidate?.plannerEvidence?.noEffectKeys || []
  const hasTool = (entries: string[], tool: string) => entries.some(entry => typeof entry === 'string' && entry.startsWith(`${tool}:`))
  return {
    attemptedGenericUnicodeRepair: hasTool(attemptedKeys, 'repair_font_unicode_maps'),
    noEffectGenericUnicodeRepair: hasTool(noEffectKeys, 'repair_font_unicode_maps'),
    attemptedType1UnicodeRepair: hasTool(attemptedKeys, 'repair_type1_font_unicode_maps'),
    noEffectType1UnicodeRepair: hasTool(noEffectKeys, 'repair_type1_font_unicode_maps'),
  }
}

function onlyUnicodeStyleBlockingKeys(blockingFindingKeys: string[]): boolean {
  if (!blockingFindingKeys.length) return false
  return blockingFindingKeys.every(key => key === 'pdfua.font_unicode')
}

function classifyFontDisposition(row: CorpusControlPlaneRow, findingsByKey: Map<string, LocalStandardsFindingLike>, reportFindingKeys: string[]): Stage5FontForensicsDisposition {
  const report = readLatestReport(row)
  const latestOutcome = readLatestOutcome(row)
  const blockingFindingKeys = row.classificationEvidence.blockingFindingKeys || []
  const combinedKeys = uniqueStrings([...blockingFindingKeys, ...reportFindingKeys])
  const combinedEvidence = [
    ...findingEvidence(findingsByKey, 'pdfua.font_unicode'),
    ...findingEvidence(findingsByKey, 'pdfua.font_embedding'),
    ...findingEvidence(findingsByKey, 'pdfua.type1_unicode'),
  ].join('\n')
  const attemptSignals = remediationAttemptSignals(report)
  const latestOutcomeStatus = row.statusEvidence.outcomeStatus || null

  const hasEmbeddingDebt = combinedKeys.includes('pdfua.font_embedding')
  if (hasEmbeddingDebt) return 'embedded_font_repairable'

  const hasType1Debt = combinedKeys.includes('pdfua.type1_unicode') || /type\s*1/i.test(combinedEvidence)
  if (hasType1Debt) return 'type1_unicode_fallback_candidate'

  const exhaustedRuntimeRetry = latestOutcomeStatus === 'processing_error'
    && latestOutcome?.deferred?.reasonCode === 'excessive_runtime_loop'
    && latestOutcome?.deferred?.skipNextBatch === true

  if (
    exhaustedRuntimeRetry
    && onlyUnicodeStyleBlockingKeys(blockingFindingKeys)
    && !hasEmbeddingDebt
    && !hasType1Debt
  ) {
    return 'font_unicode_manual_residual'
  }

  if (row.currentCorpusStatus === 'processing_error' || latestOutcomeStatus === 'processing_error') {
    return 'font_processing_error_retry'
  }

  const hasUnicodeDebt = combinedKeys.includes('pdfua.font_unicode')
  if (
    hasUnicodeDebt
    && onlyUnicodeStyleBlockingKeys(blockingFindingKeys)
    && row.statusEvidence.verificationClassification === 'hard_fail'
    && latestOutcomeStatus === 'remediated_pass_candidate'
    && !hasEmbeddingDebt
    && !hasType1Debt
  ) {
    return 'font_unicode_terminal_survivor'
  }

  if (
    hasUnicodeDebt
    && onlyUnicodeStyleBlockingKeys(blockingFindingKeys)
    && (latestOutcomeStatus === 'failed_after_remediation' || attemptSignals.noEffectGenericUnicodeRepair)
    && !hasEmbeddingDebt
    && !hasType1Debt
  ) {
    return 'font_unicode_terminal_survivor'
  }
  if (hasUnicodeDebt) return 'deterministic_unicode_map_repair_available'

  if ((report?.gate?.criticalManualReviewFlagCodes || []).length > 0) return 'font_unicode_manual_residual'

  return 'font_unicode_manual_residual'
}

export function buildStage5FontForensicsArtifacts(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manifestsRoot: string
  includePublicationIds?: string[]
}): {
  document: Stage5FontForensicsDocument
  summary: Stage5FontForensicsSummaryDocument
} {
  const { artifacts, sourceControlPlanePath, sourceControlPlaneGeneratedAt, manifestsRoot, includePublicationIds = [] } = input
  const includeSet = new Set(includePublicationIds.filter(Boolean))
  const targetRows = artifacts.document.rows.filter(row =>
    row.cohortLabel === 'font_heavy'
    && (includeSet.size === 0 || includeSet.has(row.publicationId)),
  )

  const rows = targetRows.map(row => {
    const report = readLatestReport(row)
    const reportFindings = (report?.result?.localStandards?.findings || []).filter(Boolean)
    const findingsByKey = new Map(
      reportFindings
        .map(finding => [normalizeFindingKey(finding.key), finding] as const)
        .filter((entry): entry is readonly [string, LocalStandardsFindingLike] => Boolean(entry[0])),
    )
    const reportFindingKeys = uniqueStrings(reportFindings.map(finding => normalizeFindingKey(finding.key)))
    const disposition = classifyFontDisposition(row, findingsByKey, reportFindingKeys)
    const blockingFindingKeys = uniqueStrings([
      ...(row.classificationEvidence.blockingFindingKeys || []),
      ...((report?.gate?.blockingLocalFindingKeys || []).filter(Boolean)),
    ])

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
        disposition === 'embedded_font_repairable'
          ? 'stage5:embedded_font_repairable'
          : disposition === 'type1_unicode_fallback_candidate'
            ? 'stage5:type1_unicode_fallback_candidate'
            : disposition === 'font_unicode_terminal_survivor'
              ? 'stage5:font_unicode_terminal_survivor'
              : disposition === 'font_processing_error_retry'
                ? 'stage5:font_processing_error_retry'
            : disposition === 'deterministic_unicode_map_repair_available'
              ? 'stage5:deterministic_unicode_map_repair_available'
              : 'stage5:font_unicode_manual_residual',
      ]),
      latestReportPath: row.statusEvidence.latestReportPath,
      fontUnicodeCount: findingCount(findingsByKey, 'pdfua.font_unicode'),
      fontEmbeddingCount: findingCount(findingsByKey, 'pdfua.font_embedding'),
      type1UnicodeCount: findingCount(findingsByKey, 'pdfua.type1_unicode'),
      cidsetConsistencyCount: findingCount(findingsByKey, 'pdfua.cidset_consistency'),
      recommendedRepairOrder: recommendedRepairOrderForDisposition(disposition),
      notes: uniqueStrings([
        row.statusEvidence.latestReportPath ? `latest_report:${path.basename(row.statusEvidence.latestReportPath)}` : null,
        ...findingEvidence(findingsByKey, 'pdfua.font_unicode').slice(0, 1),
        ...findingEvidence(findingsByKey, 'pdfua.font_embedding').slice(0, 1),
        ...findingEvidence(findingsByKey, 'pdfua.type1_unicode').slice(0, 1),
      ]),
    } satisfies Stage5FontForensicsRow
  }).sort((left, right) => left.publicationId.localeCompare(right.publicationId))

  const publicationIdsByDisposition = {
    embedded_font_repairable: uniqueStrings(rows.filter(row => row.forensicsDisposition === 'embedded_font_repairable').map(row => row.publicationId)),
    deterministic_unicode_map_repair_available: uniqueStrings(rows.filter(row => row.forensicsDisposition === 'deterministic_unicode_map_repair_available').map(row => row.publicationId)),
    type1_unicode_fallback_candidate: uniqueStrings(rows.filter(row => row.forensicsDisposition === 'type1_unicode_fallback_candidate').map(row => row.publicationId)),
    font_unicode_terminal_survivor: uniqueStrings(rows.filter(row => row.forensicsDisposition === 'font_unicode_terminal_survivor').map(row => row.publicationId)),
    font_processing_error_retry: uniqueStrings(rows.filter(row => row.forensicsDisposition === 'font_processing_error_retry').map(row => row.publicationId)),
    font_unicode_manual_residual: uniqueStrings(rows.filter(row => row.forensicsDisposition === 'font_unicode_manual_residual').map(row => row.publicationId)),
  } satisfies Record<Stage5FontForensicsDisposition, string[]>

  const allFontHeavyIds = artifacts.document.rows
    .filter(row => row.cohortLabel === 'font_heavy' && (includeSet.size === 0 || includeSet.has(row.publicationId)))
    .map(row => row.publicationId)
  const classifiedIds = new Set(rows.map(row => row.publicationId))
  const stillUnclassifiedPublicationIds = uniqueStrings(allFontHeavyIds.filter(publicationId => !classifiedIds.has(publicationId)))

  const summaryPath = path.join(manifestsRoot, 'stage5-font-forensics.summary.json')
  const document: Stage5FontForensicsDocument = {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt,
    cohortLabel: 'font_heavy',
    includePublicationIds: uniqueStrings(includePublicationIds),
    summaryPath,
    rows,
  }

  const summary: Stage5FontForensicsSummaryDocument = {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt,
    forensicsManifestPath: path.join(manifestsRoot, 'stage5-font-forensics.json'),
    cohortLabel: 'font_heavy',
    totals: {
      totalFontHeavyRows: artifacts.document.rows.filter(row => row.cohortLabel === 'font_heavy').length,
      analyzedRows: rows.length,
      stillUnclassifiedRows: stillUnclassifiedPublicationIds.length,
    },
    publicationIdsByDisposition,
    includePublicationIds: uniqueStrings(includePublicationIds),
    stillUnclassifiedPublicationIds,
  }

  return { document, summary }
}

export function buildStage5FontWaveArtifacts(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  manifestsRoot: string
  maxCandidates: number
  forensicsRows: Stage5FontForensicsRow[]
  includePublicationIds?: string[]
}): {
  wave: Stage5FontWaveDocument
  summary: Stage5FontWaveSummaryDocument
} {
  const { artifacts, sourceControlPlanePath, sourceControlPlaneGeneratedAt, manifestsRoot, maxCandidates, forensicsRows, includePublicationIds = [] } = input
  const includeSet = new Set(includePublicationIds.filter(Boolean))
  const rowsById = new Map(artifacts.document.rows.map(row => [row.publicationId, row]))
  const forensicsById = new Map(forensicsRows.map(row => [row.publicationId, row]))
  const wavePath = path.join(manifestsRoot, 'stage5-font-wave.json')
  const outcomesPath = path.join(manifestsRoot, 'stage5-font-wave.outcomes.json')
  const existingWave = readJsonIfExists<Stage5FontWaveDocument>(wavePath)
  const existingOutcomes = readJsonIfExists<{ outcomes?: OutcomeLike[] }>(outcomesPath)

  const pendingPublicationIds = pendingPublicationIdsFromExistingArtifacts(existingWave, existingOutcomes)
    .filter(publicationId => {
      const row = rowsById.get(publicationId)
      return Boolean(row && row.cohortLabel === 'font_heavy' && row.currentCorpusStatus !== 'verified_pass')
    })

  const eligibleForensics = forensicsRows
    .filter(forensics => {
      const row = rowsById.get(forensics.publicationId)
      return Boolean(
        row
        && row.cohortLabel === 'font_heavy'
        && row.currentCorpusStatus !== 'verified_pass'
        && (forensics.forensicsDisposition !== 'font_processing_error_retry' || (includeSet.size > 0 && includeSet.has(forensics.publicationId)))
        && (forensics.forensicsDisposition !== 'font_unicode_manual_residual' || (includeSet.size > 0 && includeSet.has(forensics.publicationId)))
        && forensics.forensicsDisposition !== 'font_unicode_terminal_survivor'
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
    const disposition = forensics?.forensicsDisposition || 'font_unicode_manual_residual'
    return {
      priorityRank: index + 1,
      priorityTier: priorityTierForDisposition(disposition),
      recommendedAction: disposition === 'font_unicode_manual_residual' ? 'manual_review' : 'fix_first',
      publicationId,
      publicationTitle: row.title,
      serverHost: row.serverHost,
      remotePath: row.remotePath,
      localCachePath: row.sourceMetadata.currentSourcePath,
      fileUrl: row.fileUrl,
      storageKind: row.storageKind,
      currentCorpusStatus: row.currentCorpusStatus,
      stage5FontDisposition: disposition,
      selectionReasons: uniqueStrings([
        `stage5:${disposition}`,
        ...(forensics?.reasonCodes || []),
      ]),
      reportPath: row.statusEvidence.latestReportPath,
      pageCount: safeNumber(row.classificationEvidence.pageCount, 0),
      isScanned: Boolean(row.classificationEvidence.isScanned),
      overallScore: row.classificationEvidence.overallScore,
      grade: row.classificationEvidence.grade,
      blockingFindingKeys: row.classificationEvidence.blockingFindingKeys || [],
      fontUnicodeCount: forensics?.fontUnicodeCount || 0,
      fontEmbeddingCount: forensics?.fontEmbeddingCount || 0,
      type1UnicodeCount: forensics?.type1UnicodeCount || 0,
    } satisfies Stage5FontWaveCandidate
  })

  const skippedRows = artifacts.document.rows
    .filter(row => row.cohortLabel === 'font_heavy' && (includeSet.size === 0 || includeSet.has(row.publicationId)))
    .filter(row => !selectedPublicationIds.includes(row.publicationId))
    .map(row => {
      const forensics = forensicsById.get(row.publicationId)
      const skipReasons = row.currentCorpusStatus === 'verified_pass'
        ? ['already_verified_pass']
        : forensics?.forensicsDisposition === 'font_processing_error_retry'
          ? ['stage5:processing_retry_not_selected']
        : forensics?.forensicsDisposition === 'font_unicode_terminal_survivor'
          ? ['stage5:terminal_survivor_not_selected']
        : forensics?.forensicsDisposition === 'font_unicode_manual_residual'
          ? ['stage5:manual_residual_not_selected']
          : ['not_selected_in_current_wave']
      return {
        publicationId: row.publicationId,
        publicationTitle: row.title,
        currentCorpusStatus: row.currentCorpusStatus,
        stage5FontDisposition: forensics?.forensicsDisposition || null,
        skipReasons,
      } satisfies Stage5FontWaveSkippedRow
    })
    .sort((left, right) => left.publicationId.localeCompare(right.publicationId))

  const wave: Stage5FontWaveDocument = {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt,
    waveName: 'stage5-font-wave',
    cohortLabel: 'font_heavy',
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

  const selectedByTier = { highest: 0, high: 0, medium: 0, low: 0 }
  const selectedByStatus = emptyStatusCounts()
  const selectedByDisposition = emptyDispositionCounts()
  for (const candidate of candidates) {
    selectedByTier[candidate.priorityTier] += 1
    selectedByStatus[candidate.currentCorpusStatus] += 1
    selectedByDisposition[candidate.stage5FontDisposition] += 1
  }

  const summary: Stage5FontWaveSummaryDocument = {
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
  }

  return { wave, summary }
}

export function buildStage5FontThroughputSummary(input: {
  artifacts: CorpusControlPlaneArtifacts
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  waveManifestPath: string
  wave: Stage5FontWaveDocument
  waveOutcomesPath: string | null
  outcomes: { outcomes?: OutcomeLike[] } | null
  forensicsManifestPath: string
  forensicsRows: Stage5FontForensicsRow[]
}): Stage5FontThroughputSummaryDocument {
  const {
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt,
    waveManifestPath,
    wave,
    waveOutcomesPath,
    outcomes,
    forensicsManifestPath,
    forensicsRows,
  } = input
  const fontRows = artifacts.document.rows.filter(row => row.cohortLabel === 'font_heavy')
  const forensicsById = new Map(forensicsRows.map(row => [row.publicationId, row]))
  const outcomeById = new Map(
    (outcomes?.outcomes || [])
      .filter(outcome => Boolean(outcome.publicationId))
      .map(outcome => [String(outcome.publicationId), String(outcome.status || '')]),
  )

  const verifiedPassPublicationIds = uniqueStrings(fontRows.filter(row => row.currentCorpusStatus === 'verified_pass').map(row => row.publicationId))
  const remainingPublicationIds = uniqueStrings(fontRows.filter(row => row.currentCorpusStatus !== 'verified_pass').map(row => row.publicationId))
  const newlyVerifiedPassPublicationIds = uniqueStrings(wave.selectedPublicationIds.filter(publicationId => verifiedPassPublicationIds.includes(publicationId)))
  const processingErrorPublicationIds = uniqueStrings(wave.selectedPublicationIds.filter(publicationId => outcomeById.get(publicationId) === 'processing_error'))
  const hardFailPublicationIds = uniqueStrings(wave.selectedPublicationIds.filter(publicationId => outcomeById.get(publicationId) === 'failed_after_remediation'))
  const pendingPublicationIds = uniqueStrings(wave.selectedPublicationIds.filter(publicationId => !outcomeById.has(publicationId)))

  const embeddedFontRepairablePublicationIds = uniqueStrings(forensicsRows.filter(row => row.forensicsDisposition === 'embedded_font_repairable').map(row => row.publicationId))
  const deterministicUnicodeRepairPublicationIds = uniqueStrings(forensicsRows.filter(row => row.forensicsDisposition === 'deterministic_unicode_map_repair_available').map(row => row.publicationId))
  const type1FallbackPublicationIds = uniqueStrings(forensicsRows.filter(row => row.forensicsDisposition === 'type1_unicode_fallback_candidate').map(row => row.publicationId))
  const terminalSurvivorPublicationIds = uniqueStrings(forensicsRows.filter(row => row.forensicsDisposition === 'font_unicode_terminal_survivor').map(row => row.publicationId))
  const processingRetryPublicationIds = uniqueStrings(forensicsRows.filter(row => row.forensicsDisposition === 'font_processing_error_retry').map(row => row.publicationId))
  const manualResidualPublicationIds = uniqueStrings(forensicsRows.filter(row => row.forensicsDisposition === 'font_unicode_manual_residual').map(row => row.publicationId))
  const stillUnclassifiedPublicationIds = uniqueStrings(fontRows.filter(row => !forensicsById.has(row.publicationId) && row.currentCorpusStatus !== 'verified_pass').map(row => row.publicationId))

  return {
    generatedAt: new Date().toISOString(),
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt,
    waveManifestPath,
    waveOutcomesPath,
    forensicsManifestPath,
    cohortLabel: 'font_heavy',
    totals: {
      totalFontHeavyRows: fontRows.length,
      verifiedPassRowsInCohort: verifiedPassPublicationIds.length,
      remainingFontHeavyRows: remainingPublicationIds.length,
      newlyVerifiedPassRowsFromWave: newlyVerifiedPassPublicationIds.length,
      processingErrorsInWave: processingErrorPublicationIds.length,
      hardFailsInWave: hardFailPublicationIds.length,
      pendingWaveRows: pendingPublicationIds.length,
      embeddedFontRepairableRows: embeddedFontRepairablePublicationIds.length,
      deterministicUnicodeRepairRows: deterministicUnicodeRepairPublicationIds.length,
      type1FallbackRows: type1FallbackPublicationIds.length,
      terminalSurvivorRows: terminalSurvivorPublicationIds.length,
      processingRetryRows: processingRetryPublicationIds.length,
      manualResidualRows: manualResidualPublicationIds.length,
      stillUnclassifiedRows: stillUnclassifiedPublicationIds.length,
    },
    rows: {
      newlyVerifiedPassPublicationIds,
      remainingPublicationIds,
      processingErrorPublicationIds,
      hardFailPublicationIds,
      pendingPublicationIds,
      activeWaveSelectedPublicationIds: wave.selectedPublicationIds,
      embeddedFontRepairablePublicationIds,
      deterministicUnicodeRepairPublicationIds,
      type1FallbackPublicationIds,
      terminalSurvivorPublicationIds,
      processingRetryPublicationIds,
      manualResidualPublicationIds,
      stillUnclassifiedPublicationIds,
    },
  }
}
