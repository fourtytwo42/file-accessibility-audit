import type { CorpusControlPlaneArtifacts, CorpusControlPlaneRow } from './corpusControlPlane.ts'
import { isManualMitigationStatus, type ManualWorklistStatus } from './manualWorklist.ts'

export type CandidateEngineSliceTag =
  | 'figure_final_mile_closure'
  | 'mixed_figure_structure_separation'
  | 'font_symbol_closure'
  | 'manual_scanned_deferred'
  | 'large_mixed_runtime_reduction'

export interface HistoricalClosureOutcome {
  publicationId: string
  status: string
  processedAt: string | null
  blockingFindingShrink: boolean
  blockingLocalFindingKeys: string[]
}

export interface ResidualFamilyClosureReportCandidate {
  publicationId: string
  publicationTitle: string | null
  currentCorpusStatus: string
  cohortLabel: string
  overallScore: number | null
  grade: string | null
  pageCount: number
  runtimeWeightBucket: 'light' | 'medium' | 'heavy'
  dominantResidualFamily: 'figure' | 'structure' | 'font' | 'mixed' | 'metadata' | 'manual'
  familyPressure: 'figure_primary' | 'structure_primary' | 'irreducibly_mixed' | 'single_family' | 'unknown'
  topBlockingKeys: string[]
  blockerFamilyCount: number
  candidateEngineSliceTag: CandidateEngineSliceTag
  latestObservedStatus: string | null
  latestObservedProcessedAt: string | null
  observedBlockingFindingShrink: boolean
}

export interface ResidualFamilyClosureCohort {
  candidateEngineSliceTag: CandidateEngineSliceTag
  rowCount: number
  observedOutcomeCount: number
  observedShrinkCount: number
  dominantResidualFamilies: Record<string, number>
  topBlockingKeys: Array<{ key: string; count: number }>
}

export interface ResidualFamilyClosureReportDocument {
  generatedAt: string
  sourceControlPlaneGeneratedAt: string
  totals: {
    remainingNonPassRows: number
    rowsWithObservedOutcomes: number
    rowsWithObservedBlockingShrink: number
  }
  manualMitigation: {
    manualReadyCount: number
    manualTerminalizedCount: number
    manualInProgressCount: number
    manualDeferredCount: number
    reasonsByFrequency: Record<string, number>
    excludedPublicationIds: string[]
  }
  recommendedNextEngineSlice: CandidateEngineSliceTag
  rankedCohorts: ResidualFamilyClosureCohort[]
  figureFinalMileRows: string[]
  candidates: ResidualFamilyClosureReportCandidate[]
}

interface ManualMitigationRef {
  status: ManualWorklistStatus
  manualResolutionReason?: string | null
}

function safeNumber(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

function familyScore(row: CorpusControlPlaneRow, family: 'figure' | 'font' | 'structure' | 'metadata'): number {
  const joined = [
    ...(row.classificationEvidence.topBlockingResidualFamilyIds || []),
    ...(row.classificationEvidence.blockingFindingKeys || []),
    ...(row.reasonCodes || []),
  ].join(' ')

  if (family === 'figure') {
    return (
      (row.classificationEvidence.topBlockingResidualFamilyIds.includes('native_figure_convergence') ? 4 : 0)
      + (row.classificationEvidence.blockingFindingKeys.includes('pdfua.figure_alt_or_artifact') ? 3 : 0)
      + (row.classificationEvidence.blockingFindingKeys.includes('category.alt_text') ? 2 : 0)
      + (row.classificationEvidence.blockingFindingKeys.includes('pdfua.nested_alt_text') ? 2 : 0)
      + (/figure|alt|artifact|image|ownership/i.test(joined) ? 1 : 0)
    )
  }
  if (family === 'font') {
    return (
      (row.classificationEvidence.topBlockingResidualFamilyIds.includes('font_embedding_and_unicode') ? 4 : 0)
      + (row.classificationEvidence.blockingFindingKeys.includes('pdfua.font_unicode') ? 3 : 0)
      + (row.classificationEvidence.blockingFindingKeys.includes('pdfua.cid_symbol_fonts') ? 3 : 0)
      + (/font|unicode|cid/i.test(joined) ? 1 : 0)
    )
  }
  if (family === 'structure') {
    return (
      (row.classificationEvidence.topBlockingResidualFamilyIds.includes('post_bootstrap_heading_convergence') ? 4 : 0)
      + (row.classificationEvidence.blockingFindingKeys.includes('pdfua.logical_structure') ? 3 : 0)
      + (row.classificationEvidence.blockingFindingKeys.includes('pdfua.heading_content_quality') ? 2 : 0)
      + (/logical_structure|heading|reading_order|structure/i.test(joined) ? 1 : 0)
    )
  }
  return (
    (row.classificationEvidence.blockingFindingKeys.includes('pdfua.display_doc_title') ? 2 : 0)
    + (row.classificationEvidence.blockingFindingKeys.includes('pdfua.document_language') ? 2 : 0)
    + (/bookmark|title|language|metadata/i.test(joined) ? 1 : 0)
  )
}

function dominantResidualFamilyForRow(row: CorpusControlPlaneRow): ResidualFamilyClosureReportCandidate['dominantResidualFamily'] {
  return familyStateForRow(row).dominantResidualFamily
}

function familyStateForRow(row: CorpusControlPlaneRow): {
  dominantResidualFamily: ResidualFamilyClosureReportCandidate['dominantResidualFamily']
  familyPressure: ResidualFamilyClosureReportCandidate['familyPressure']
  structureDebtCount: number
  figureDebtCount: number
} {
  if (row.classificationEvidence.isScanned || row.cohortLabel === 'manual_tail') {
    return {
      dominantResidualFamily: 'manual',
      familyPressure: 'unknown',
      structureDebtCount: 0,
      figureDebtCount: 0,
    }
  }
  const structureDebtCount =
    (row.classificationEvidence.blockingFindingKeys || []).filter(key =>
      key === 'pdfua.logical_structure'
      || key === 'pdfua.heading_content_quality'
      || key === 'pdfua.reading_order'
      || key === 'category.heading_structure'
      || key === 'category.reading_order'
    ).length
  const figureDebtCount =
    (row.classificationEvidence.blockingFindingKeys || []).filter(key =>
      key === 'pdfua.figure_alt_or_artifact'
      || key === 'pdfua.nested_alt_text'
      || key === 'pdfua.figure_alt_quality'
      || key === 'pdfua.untagged_rendered_images'
      || key === 'category.alt_text'
    ).length
  const scores = {
    figure: familyScore(row, 'figure'),
    font: familyScore(row, 'font'),
    structure: familyScore(row, 'structure'),
    metadata: familyScore(row, 'metadata'),
  }
  const entries = Object.entries(scores).sort((left, right) => right[1] - left[1])
  const [bestFamily, bestScore] = entries[0] || ['metadata', 0]
  const [, secondScore] = entries[1] || ['metadata', 0]
  if (bestScore <= 0) {
    return {
      dominantResidualFamily: 'metadata',
      familyPressure: 'unknown',
      structureDebtCount,
      figureDebtCount,
    }
  }
  if (bestScore === secondScore) {
    if (figureDebtCount >= structureDebtCount + 2) {
      return {
        dominantResidualFamily: 'figure',
        familyPressure: 'figure_primary',
        structureDebtCount,
        figureDebtCount,
      }
    }
    if (structureDebtCount >= figureDebtCount + 2) {
      return {
        dominantResidualFamily: 'structure',
        familyPressure: 'structure_primary',
        structureDebtCount,
        figureDebtCount,
      }
    }
    return {
      dominantResidualFamily: 'mixed',
      familyPressure: 'irreducibly_mixed',
      structureDebtCount,
      figureDebtCount,
    }
  }
  return {
    dominantResidualFamily: bestFamily as ResidualFamilyClosureReportCandidate['dominantResidualFamily'],
    familyPressure: 'single_family',
    structureDebtCount,
    figureDebtCount,
  }
}

function runtimeWeightBucketForRow(row: CorpusControlPlaneRow): 'light' | 'medium' | 'heavy' {
  const pageCount = safeNumber(row.classificationEvidence.pageCount, 0)
  const repeatedRuntimeSignals = Number(Boolean(row.stage3FigureDiagnostics.hasGenericTimeoutWording))
    + Number(Boolean(row.stage4StructureDiagnostics.hasBoundedRuntimeWording))
    + Number(row.currentCorpusStatus === 'processing_error')
  const joined = [row.title || '', row.remotePath || '', row.statusEvidence.latestReportPath || ''].join(' ')
  const knownLarge = /caps3|annual report|safe[_ ]from[_ ]the[_ ]start/i.test(joined)
  if (knownLarge || pageCount >= 80 || repeatedRuntimeSignals >= 2) return 'heavy'
  if (pageCount >= 25 || repeatedRuntimeSignals >= 1) return 'medium'
  return 'light'
}

function topBlockingKeys(row: CorpusControlPlaneRow): string[] {
  return [...(row.classificationEvidence.blockingFindingKeys || [])].slice(0, 5)
}

function candidateEngineSliceTag(row: CorpusControlPlaneRow): CandidateEngineSliceTag {
  const familyState = familyStateForRow(row)
  const dominantFamily = familyState.dominantResidualFamily
  const blockingKeys = row.classificationEvidence.blockingFindingKeys || []
  const figureFinalMileOnly = blockingKeys.length > 0
    && blockingKeys.every(key =>
      key === 'pdfua.figure_alt_or_artifact'
      || key === 'pdfua.nested_alt_text'
      || key === 'category.alt_text'
      || key === 'pdfua.figure_alt_quality'
      || key === 'context.long_report_figure_residue'
      || key === 'context.figure_candidates_blocked'
    )

  if (row.classificationEvidence.isScanned || row.cohortLabel === 'manual_tail') return 'manual_scanned_deferred'
  if (figureFinalMileOnly && dominantFamily !== 'structure' && dominantFamily !== 'font') return 'figure_final_mile_closure'
  if (
    familyState.familyPressure === 'figure_primary'
    && familyState.figureDebtCount > 0
    && runtimeWeightBucketForRow(row) !== 'heavy'
  ) {
    return 'figure_final_mile_closure'
  }
  if (dominantFamily === 'font') return 'font_symbol_closure'
  if (dominantFamily === 'mixed') return runtimeWeightBucketForRow(row) === 'heavy'
    ? 'large_mixed_runtime_reduction'
    : 'mixed_figure_structure_separation'
  if (dominantFamily === 'structure' && runtimeWeightBucketForRow(row) === 'heavy') return 'large_mixed_runtime_reduction'
  if (dominantFamily === 'figure') return 'figure_final_mile_closure'
  return 'mixed_figure_structure_separation'
}

function compareCandidates(left: ResidualFamilyClosureReportCandidate, right: ResidualFamilyClosureReportCandidate): number {
  return Number(right.observedBlockingFindingShrink) - Number(left.observedBlockingFindingShrink)
    || (right.overallScore || 0) - (left.overallScore || 0)
    || left.blockerFamilyCount - right.blockerFamilyCount
    || left.pageCount - right.pageCount
    || left.publicationId.localeCompare(right.publicationId)
}

function buildRankedCohorts(candidates: ResidualFamilyClosureReportCandidate[]): ResidualFamilyClosureCohort[] {
  const byTag = new Map<CandidateEngineSliceTag, ResidualFamilyClosureReportCandidate[]>()
  for (const candidate of candidates) {
    const list = byTag.get(candidate.candidateEngineSliceTag) || []
    list.push(candidate)
    byTag.set(candidate.candidateEngineSliceTag, list)
  }
  return [...byTag.entries()]
    .map(([tag, rows]) => {
      const dominantResidualFamilies: Record<string, number> = {}
      const blockingCounts = new Map<string, number>()
      let observedOutcomeCount = 0
      let observedShrinkCount = 0
      for (const row of rows) {
        dominantResidualFamilies[row.dominantResidualFamily] = (dominantResidualFamilies[row.dominantResidualFamily] || 0) + 1
        if (row.latestObservedStatus) observedOutcomeCount += 1
        if (row.observedBlockingFindingShrink) observedShrinkCount += 1
        for (const key of row.topBlockingKeys) {
          blockingCounts.set(key, (blockingCounts.get(key) || 0) + 1)
        }
      }
      return {
        candidateEngineSliceTag: tag,
        rowCount: rows.length,
        observedOutcomeCount,
        observedShrinkCount,
        dominantResidualFamilies,
        topBlockingKeys: [...blockingCounts.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .slice(0, 5)
          .map(([key, count]) => ({ key, count })),
      }
    })
    .sort((left, right) =>
      right.rowCount - left.rowCount
      || right.observedShrinkCount - left.observedShrinkCount
      || left.candidateEngineSliceTag.localeCompare(right.candidateEngineSliceTag))
}

function recommendNextEngineSlice(candidates: ResidualFamilyClosureReportCandidate[]): CandidateEngineSliceTag {
  const counts = new Map<CandidateEngineSliceTag, number>()
  for (const candidate of candidates) {
    counts.set(candidate.candidateEngineSliceTag, (counts.get(candidate.candidateEngineSliceTag) || 0) + 1)
  }
  const figureFinalMile = counts.get('figure_final_mile_closure') || 0
  const mixedFigureStructure = counts.get('mixed_figure_structure_separation') || 0
  if (mixedFigureStructure > figureFinalMile * 1.5) return 'mixed_figure_structure_separation'
  return 'figure_final_mile_closure'
}

export function buildResidualFamilyClosureReport(input: {
  artifacts: CorpusControlPlaneArtifacts
  latestOutcomeByPublicationId: Map<string, HistoricalClosureOutcome>
  manualOutcomeByPublicationId?: Map<string, ManualMitigationRef>
}): ResidualFamilyClosureReportDocument {
  const manualEntries = [...(input.manualOutcomeByPublicationId || new Map()).entries()]
  const excludedPublicationIds = manualEntries
    .filter(([, value]) => isManualMitigationStatus(value.status))
    .map(([publicationId]) => publicationId)
    .sort()
  const manualReasonCounts = manualEntries.reduce<Record<string, number>>((counts, [, value]) => {
    if (!isManualMitigationStatus(value.status) || !value.manualResolutionReason) return counts
    counts[value.manualResolutionReason] = (counts[value.manualResolutionReason] || 0) + 1
    return counts
  }, {})
  const candidates = input.artifacts.document.rows
    .filter(row => !isManualMitigationStatus(input.manualOutcomeByPublicationId?.get(row.publicationId)?.status || row.statusEvidence.outcomeStatus || null))
    .filter(row => row.currentCorpusStatus !== 'verified_pass')
    .map(row => {
      const observed = input.latestOutcomeByPublicationId.get(row.publicationId)
      const familyState = familyStateForRow(row)
      return {
        publicationId: row.publicationId,
        publicationTitle: row.title,
        currentCorpusStatus: row.currentCorpusStatus,
        cohortLabel: row.cohortLabel,
        overallScore: row.classificationEvidence.overallScore,
        grade: row.classificationEvidence.grade,
        pageCount: safeNumber(row.classificationEvidence.pageCount, 0),
        runtimeWeightBucket: runtimeWeightBucketForRow(row),
        dominantResidualFamily: familyState.dominantResidualFamily,
        familyPressure: familyState.familyPressure,
        topBlockingKeys: topBlockingKeys(row),
        blockerFamilyCount: safeNumber(row.classificationEvidence.blockerFamilyCount, 0),
        candidateEngineSliceTag: candidateEngineSliceTag(row),
        latestObservedStatus: observed?.status || null,
        latestObservedProcessedAt: observed?.processedAt || null,
        observedBlockingFindingShrink: Boolean(observed?.blockingFindingShrink),
      }
    })
    .sort(compareCandidates)

  const rowsWithObservedOutcomes = candidates.filter(candidate => candidate.latestObservedStatus).length
  const rowsWithObservedBlockingShrink = candidates.filter(candidate => candidate.observedBlockingFindingShrink).length

  return {
    generatedAt: new Date().toISOString(),
    sourceControlPlaneGeneratedAt: input.artifacts.document.generatedAt,
    totals: {
      remainingNonPassRows: candidates.length,
      rowsWithObservedOutcomes,
      rowsWithObservedBlockingShrink,
    },
    manualMitigation: {
      manualReadyCount: manualEntries.filter(([, value]) => value.status === 'manual_ready_to_replace').length,
      manualTerminalizedCount: manualEntries.filter(([, value]) => value.status === 'manual_terminalized').length,
      manualInProgressCount: manualEntries.filter(([, value]) => value.status === 'manual_in_progress').length,
      manualDeferredCount: manualEntries.filter(([, value]) => value.status === 'manual_deferred').length,
      reasonsByFrequency: manualReasonCounts,
      excludedPublicationIds,
    },
    recommendedNextEngineSlice: recommendNextEngineSlice(candidates),
    rankedCohorts: buildRankedCohorts(candidates),
    figureFinalMileRows: candidates
      .filter(candidate => candidate.candidateEngineSliceTag === 'figure_final_mile_closure')
      .slice(0, 32)
      .map(candidate => candidate.publicationId),
    candidates,
  }
}
