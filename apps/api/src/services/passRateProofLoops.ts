import type { CorpusControlPlaneArtifacts, CorpusControlPlaneRow, CorpusStatus } from './corpusControlPlane.ts'
import type {
  PassRateFigureCanaryDocument,
  PassRateFontCanaryDocument,
  RuntimeRetryWaveDocument,
  RuntimeRetrySliceDocument,
} from './passRateWaveSlices.ts'
import { classifyRuntimeTailRow } from './runtimeTailClassifier.ts'

type SliceStatusCounts = Record<CorpusStatus, number>

export interface PassRateProofSummary {
  generatedAt: string
  sliceName:
    | 'pass-rate-figure-canary'
    | 'pass-rate-font-canary'
    | 'runtime-tail-retry-wave'
    | 'runtime-tail-figure-retry'
    | 'runtime-tail-structure-retry'
    | 'runtime-tail-mixed-terminalization'
  sliceIntent?: 'pass_rate_conversion' | 'truth_hardening_terminalization'
  selectedPublicationIds: string[]
  before: {
    byStatus: Partial<SliceStatusCounts>
    targetedFindingCounts: Record<string, number>
    targetedFamilyCounts: Record<string, number>
  }
  after: {
    byStatus: Partial<SliceStatusCounts>
    targetedFindingCounts: Record<string, number>
    targetedFamilyCounts: Record<string, number>
  }
  deltas: {
    verifiedPass: number
    processingError: number
    targetedFindingCounts: Record<string, number>
    targetedFamilyCounts: Record<string, number>
  }
  runtimeTransitions?: {
    processingErrorToVerifiedPass: string[]
    processingErrorToStableHardFail: string[]
    unchangedProcessingError: string[]
    dominantFamilyShifts: Array<{
      publicationId: string
      before: string
      after: string
    }>
  }
  unchangedRows: string[]
  worsenedRows: string[]
}

function emptyStatusCounts(): Partial<SliceStatusCounts> {
  return {}
}

function countByStatus(rows: Array<{ currentCorpusStatus: CorpusStatus }>): Partial<SliceStatusCounts> {
  const counts = emptyStatusCounts()
  for (const row of rows) {
    counts[row.currentCorpusStatus] = (counts[row.currentCorpusStatus] || 0) + 1
  }
  return counts
}

function getBlockingFindingKeys(row: { blockingFindingKeys?: string[], classificationEvidence?: { blockingFindingKeys?: string[] } }): string[] {
  return row.blockingFindingKeys || row.classificationEvidence?.blockingFindingKeys || []
}

function getTopBlockingResidualFamilyIds(row: { topBlockingResidualFamilyIds?: string[], classificationEvidence?: { topBlockingResidualFamilyIds?: string[] } }): string[] {
  return row.topBlockingResidualFamilyIds || row.classificationEvidence?.topBlockingResidualFamilyIds || []
}

function getOverallScore(row: { overallScore?: number | null, classificationEvidence?: { overallScore?: number | null } }): number | null {
  return row.overallScore ?? row.classificationEvidence?.overallScore ?? null
}

function countTargetedFindings(rows: Array<{ blockingFindingKeys?: string[], classificationEvidence?: { blockingFindingKeys?: string[] } }>, keys: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const key of keys) counts[key] = 0
  for (const row of rows) {
    const blockingFindingKeys = getBlockingFindingKeys(row)
    for (const key of keys) {
      if (blockingFindingKeys.includes(key)) counts[key] += 1
    }
  }
  return counts
}

function countTargetedFamilies(rows: Array<{ topBlockingResidualFamilyIds?: string[], classificationEvidence?: { topBlockingResidualFamilyIds?: string[] } }>, familyIds: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const familyId of familyIds) counts[familyId] = 0
  for (const row of rows) {
    const topBlockingResidualFamilyIds = getTopBlockingResidualFamilyIds(row)
    for (const familyId of familyIds) {
      if (topBlockingResidualFamilyIds.includes(familyId)) counts[familyId] += 1
    }
  }
  return counts
}

function rowStateSignature(input: {
  currentCorpusStatus: string
  blockingFindingKeys?: string[]
  topBlockingResidualFamilyIds?: string[]
  classificationEvidence?: {
    blockingFindingKeys?: string[]
    topBlockingResidualFamilyIds?: string[]
  }
}): string {
  return JSON.stringify({
    status: input.currentCorpusStatus,
    findings: [...getBlockingFindingKeys(input)].sort(),
    families: [...getTopBlockingResidualFamilyIds(input)].sort(),
  })
}

function scoreForWorsening(row: {
  currentCorpusStatus: CorpusStatus
  overallScore?: number | null
  blockingFindingKeys?: string[]
  topBlockingResidualFamilyIds?: string[]
  classificationEvidence?: {
    overallScore?: number | null
    blockingFindingKeys?: string[]
    topBlockingResidualFamilyIds?: string[]
  }
}): number {
  const statusScore = row.currentCorpusStatus === 'verified_pass'
    ? 1000
    : row.currentCorpusStatus === 'staged_for_replacement'
      ? 900
      : row.currentCorpusStatus === 'remediated_fail'
        ? 600
        : row.currentCorpusStatus === 'processing_error'
          ? 400
          : 500
  return statusScore + (getOverallScore(row) || 0) - getBlockingFindingKeys(row).length * 10 - getTopBlockingResidualFamilyIds(row).length * 8
}

function rowMap(artifacts: CorpusControlPlaneArtifacts): Map<string, CorpusControlPlaneRow> {
  return new Map(artifacts.document.rows.map(row => [row.publicationId, row]))
}

function summarizeGenericProofLoop(input: {
  sliceName: PassRateProofSummary['sliceName']
  selectedRows: Array<{
    publicationId: string
    currentCorpusStatus: CorpusStatus
    overallScore: number | null
    blockingFindingKeys: string[]
    topBlockingResidualFamilyIds: string[]
  }>
  artifacts: CorpusControlPlaneArtifacts
  targetedFindingKeys: string[]
  targetedFamilyIds: string[]
}): PassRateProofSummary {
  const rowsById = rowMap(input.artifacts)
  const afterRows = input.selectedRows.map(row => rowsById.get(row.publicationId)).filter((row): row is CorpusControlPlaneRow => !!row)

  const beforeByStatus = countByStatus(input.selectedRows)
  const afterByStatus = countByStatus(afterRows)
  const beforeFindingCounts = countTargetedFindings(input.selectedRows, input.targetedFindingKeys)
  const afterFindingCounts = countTargetedFindings(afterRows, input.targetedFindingKeys)
  const beforeFamilyCounts = countTargetedFamilies(input.selectedRows, input.targetedFamilyIds)
  const afterFamilyCounts = countTargetedFamilies(afterRows, input.targetedFamilyIds)

  const unchangedRows: string[] = []
  const worsenedRows: string[] = []
  for (const beforeRow of input.selectedRows) {
    const afterRow = rowsById.get(beforeRow.publicationId)
    if (!afterRow) continue
    if (rowStateSignature(beforeRow) === rowStateSignature(afterRow)) unchangedRows.push(beforeRow.publicationId)
    if (scoreForWorsening(beforeRow) > scoreForWorsening(afterRow)) worsenedRows.push(beforeRow.publicationId)
  }

  return {
    generatedAt: new Date().toISOString(),
    sliceName: input.sliceName,
    selectedPublicationIds: input.selectedRows.map(row => row.publicationId),
    before: {
      byStatus: beforeByStatus,
      targetedFindingCounts: beforeFindingCounts,
      targetedFamilyCounts: beforeFamilyCounts,
    },
    after: {
      byStatus: afterByStatus,
      targetedFindingCounts: afterFindingCounts,
      targetedFamilyCounts: afterFamilyCounts,
    },
    deltas: {
      verifiedPass: (afterByStatus.verified_pass || 0) - (beforeByStatus.verified_pass || 0),
      processingError: (afterByStatus.processing_error || 0) - (beforeByStatus.processing_error || 0),
      targetedFindingCounts: Object.fromEntries(input.targetedFindingKeys.map(key => [key, (afterFindingCounts[key] || 0) - (beforeFindingCounts[key] || 0)])),
      targetedFamilyCounts: Object.fromEntries(input.targetedFamilyIds.map(familyId => [familyId, (afterFamilyCounts[familyId] || 0) - (beforeFamilyCounts[familyId] || 0)])),
    },
    unchangedRows: unchangedRows.sort(),
    worsenedRows: worsenedRows.sort(),
  }
}

export function summarizeFigureCanaryProofLoop(input: {
  slice: PassRateFigureCanaryDocument
  artifacts: CorpusControlPlaneArtifacts
}): PassRateProofSummary {
  return summarizeGenericProofLoop({
    sliceName: 'pass-rate-figure-canary',
    selectedRows: input.slice.candidates,
    artifacts: input.artifacts,
    targetedFindingKeys: ['pdfua.figure_alt_or_artifact', 'category.alt_text'],
    targetedFamilyIds: ['native_figure_convergence'],
  })
}

export function summarizeFontCanaryProofLoop(input: {
  slice: PassRateFontCanaryDocument
  artifacts: CorpusControlPlaneArtifacts
}): PassRateProofSummary {
  return summarizeGenericProofLoop({
    sliceName: 'pass-rate-font-canary',
    selectedRows: input.slice.candidates,
    artifacts: input.artifacts,
    targetedFindingKeys: ['pdfua.font_unicode', 'pdfua.cid_symbol_fonts', 'pdfua.font_embedding'],
    targetedFamilyIds: ['font_embedding_and_unicode'],
  })
}

export function summarizeRuntimeRetryProofLoop(input: {
  slice: RuntimeRetryWaveDocument
  artifacts: CorpusControlPlaneArtifacts
}): PassRateProofSummary {
  return summarizeRuntimeLikeProofLoop({
    sliceName: 'runtime-tail-retry-wave',
    sliceIntent: 'pass_rate_conversion',
    selectedRows: input.slice.candidates,
    artifacts: input.artifacts,
    targetedFindingKeys: [],
    targetedFamilyIds: [],
  })
}

export function summarizeRuntimeSliceProofLoop(input: {
  slice: RuntimeRetrySliceDocument
  artifacts: CorpusControlPlaneArtifacts
}): PassRateProofSummary {
  return summarizeRuntimeLikeProofLoop({
    sliceName: input.slice.sliceName,
    sliceIntent: input.slice.sliceIntent,
    selectedRows: input.slice.candidates,
    artifacts: input.artifacts,
    targetedFindingKeys: input.slice.targetedFindingKeys,
    targetedFamilyIds: input.slice.targetedFamilyIds,
  })
}

function summarizeRuntimeLikeProofLoop(input: {
  sliceName: PassRateProofSummary['sliceName']
  sliceIntent: 'pass_rate_conversion' | 'truth_hardening_terminalization'
  selectedRows: RuntimeRetryWaveDocument['candidates'] | RuntimeRetrySliceDocument['candidates']
  artifacts: CorpusControlPlaneArtifacts
  targetedFindingKeys: string[]
  targetedFamilyIds: string[]
}): PassRateProofSummary {
  const summary = summarizeGenericProofLoop({
    sliceName: input.sliceName,
    selectedRows: input.selectedRows,
    artifacts: input.artifacts,
    targetedFindingKeys: input.targetedFindingKeys,
    targetedFamilyIds: input.targetedFamilyIds,
  })

  const rowsById = rowMap(input.artifacts)
  const processingErrorToVerifiedPass: string[] = []
  const processingErrorToStableHardFail: string[] = []
  const unchangedProcessingError: string[] = []
  const dominantFamilyShifts: Array<{ publicationId: string, before: string, after: string }> = []

  for (const beforeRow of input.selectedRows) {
    const afterRow = rowsById.get(beforeRow.publicationId)
    if (!afterRow) continue
    if (beforeRow.currentCorpusStatus === 'processing_error' && afterRow.currentCorpusStatus === 'verified_pass') {
      processingErrorToVerifiedPass.push(beforeRow.publicationId)
    } else if (beforeRow.currentCorpusStatus === 'processing_error' && afterRow.currentCorpusStatus === 'remediated_fail') {
      processingErrorToStableHardFail.push(beforeRow.publicationId)
    } else if (beforeRow.currentCorpusStatus === 'processing_error' && afterRow.currentCorpusStatus === 'processing_error') {
      unchangedProcessingError.push(beforeRow.publicationId)
    }

    const afterClassification = classifyRuntimeTailRow(afterRow)
    if (beforeRow.dominantFamily !== afterClassification.dominantFamily) {
      dominantFamilyShifts.push({
        publicationId: beforeRow.publicationId,
        before: beforeRow.dominantFamily,
        after: afterClassification.dominantFamily,
      })
    }
  }

  return {
    ...summary,
    sliceIntent: input.sliceIntent,
    runtimeTransitions: {
      processingErrorToVerifiedPass: processingErrorToVerifiedPass.sort(),
      processingErrorToStableHardFail: processingErrorToStableHardFail.sort(),
      unchangedProcessingError: unchangedProcessingError.sort(),
      dominantFamilyShifts: dominantFamilyShifts.sort((left, right) => left.publicationId.localeCompare(right.publicationId)),
    },
  }
}
