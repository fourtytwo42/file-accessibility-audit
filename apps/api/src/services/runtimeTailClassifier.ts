import type { CohortLabel, CorpusControlPlaneArtifacts, CorpusControlPlaneRow } from './corpusControlPlane.js'

export type RuntimeTailDisposition =
  | 'retryable_deterministic'
  | 'stable_hard_fail'
  | 'manual_residual'
  | 'not_runtime_tail'

export type RuntimeTailDominantFamily =
  | 'figure'
  | 'structure'
  | 'font'
  | 'mixed'
  | 'manual'
  | 'unknown'

export interface RuntimeTailClassification {
  publicationId: string
  publicationTitle: string | null
  currentCorpusStatus: CorpusControlPlaneRow['currentCorpusStatus']
  cohortLabel: CohortLabel
  disposition: RuntimeTailDisposition
  dominantFamily: RuntimeTailDominantFamily
  safeToRetry: boolean
  reasonCode: string
  blockingFindingKeys: string[]
  topBlockingResidualFamilyIds: string[]
  notes: string[]
}

export interface RuntimeTailAnalysisSummary {
  generatedAt: string
  totals: {
    runtimeTailRows: number
    retryableDeterministicRows: number
    stableHardFailRows: number
    manualResidualRows: number
  }
  byDisposition: Record<Exclude<RuntimeTailDisposition, 'not_runtime_tail'>, string[]>
  byDominantFamily: Record<RuntimeTailDominantFamily, string[]>
}

const FIGURE_PATTERN = /(figure|alt|artifact|image|ownership)/i
const STRUCTURE_PATTERN = /(logical_structure|heading|reading_order|marked_content|page_tabs|structure|metadata|bookmark|title|language)/i
const FONT_PATTERN = /(font|unicode|charenc|cidset)/i
const MANUAL_PATTERN = /(manual|scanned|missing|unrecoverable|terminal_survivor)/i

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort()
}

function dominantFamilyForRow(row: CorpusControlPlaneRow): RuntimeTailDominantFamily {
  const joined = [
    ...row.classificationEvidence.topBlockingResidualFamilyIds,
    ...row.classificationEvidence.blockingFindingKeys,
    ...row.reasonCodes,
    ...row.notes,
  ].join(' ')

  const hasFigure = FIGURE_PATTERN.test(joined)
  const hasStructure = STRUCTURE_PATTERN.test(joined)
  const hasFont = FONT_PATTERN.test(joined)
  const hasManual = MANUAL_PATTERN.test(joined) || row.cohortLabel === 'manual_tail'

  if ((hasFigure && hasStructure) || (hasFigure && hasFont) || (hasStructure && hasFont)) return 'mixed'
  if (hasManual && !hasFigure && !hasStructure && !hasFont) return 'manual'
  if (hasFigure) return 'figure'
  if (hasStructure) return 'structure'
  if (hasFont) return 'font'
  if (hasManual) return 'manual'
  return 'unknown'
}

export function classifyRuntimeTailRow(row: CorpusControlPlaneRow): RuntimeTailClassification {
  const dominantFamily = dominantFamilyForRow(row)
  const blockingFindingKeys = uniqueStrings(row.classificationEvidence.blockingFindingKeys)
  const topBlockingResidualFamilyIds = uniqueStrings(row.classificationEvidence.topBlockingResidualFamilyIds)
  const isRuntimeTail = row.currentCorpusStatus === 'processing_error' || row.cohortLabel === 'manual_tail'
  const hasBoundedRuntime = row.stage3FigureDiagnostics.hasGenericTimeoutWording || row.stage4StructureDiagnostics.hasBoundedRuntimeWording || row.currentCorpusStatus === 'processing_error'
  const hasDeterministicSurface = (row.classificationEvidence.autoRunnableOpportunityCount || 0) > 0
    || dominantFamily === 'figure'
    || dominantFamily === 'structure'
    || dominantFamily === 'font'
  const lowSignalManual = row.cohortLabel === 'manual_tail'
    && !hasDeterministicSurface
    && (row.classificationEvidence.isScanned === true || blockingFindingKeys.length === 0)

  let disposition: RuntimeTailDisposition = 'not_runtime_tail'
  let reasonCode = 'runtime_tail:not_applicable'
  let safeToRetry = false

  if (isRuntimeTail) {
    if (hasBoundedRuntime && hasDeterministicSurface && !lowSignalManual) {
      disposition = 'retryable_deterministic'
      reasonCode = `runtime_tail:retry_${dominantFamily}`
      safeToRetry = true
    } else if (lowSignalManual || dominantFamily === 'manual') {
      disposition = 'manual_residual'
      reasonCode = 'runtime_tail:explicit_manual_residual'
    } else {
      disposition = 'stable_hard_fail'
      reasonCode = `runtime_tail:stable_${dominantFamily}`
    }
  }

  return {
    publicationId: row.publicationId,
    publicationTitle: row.title,
    currentCorpusStatus: row.currentCorpusStatus,
    cohortLabel: row.cohortLabel,
    disposition,
    dominantFamily,
    safeToRetry,
    reasonCode,
    blockingFindingKeys,
    topBlockingResidualFamilyIds,
    notes: uniqueStrings([
      hasBoundedRuntime ? 'bounded_runtime_detected' : null,
      hasDeterministicSurface ? 'deterministic_surface_present' : null,
      lowSignalManual ? 'low_signal_manual_tail' : null,
      ...row.reasonCodes,
    ]),
  }
}

export function buildRuntimeTailAnalysisSummary(artifacts: CorpusControlPlaneArtifacts): RuntimeTailAnalysisSummary {
  const rows = artifacts.document.rows
    .map(classifyRuntimeTailRow)
    .filter(row => row.disposition !== 'not_runtime_tail')

  const byDisposition = {
    retryable_deterministic: [] as string[],
    stable_hard_fail: [] as string[],
    manual_residual: [] as string[],
  }
  const byDominantFamily = {
    figure: [] as string[],
    structure: [] as string[],
    font: [] as string[],
    mixed: [] as string[],
    manual: [] as string[],
    unknown: [] as string[],
  }

  for (const row of rows) {
    if (row.disposition !== 'not_runtime_tail') byDisposition[row.disposition].push(row.publicationId)
    byDominantFamily[row.dominantFamily].push(row.publicationId)
  }

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      runtimeTailRows: rows.length,
      retryableDeterministicRows: byDisposition.retryable_deterministic.length,
      stableHardFailRows: byDisposition.stable_hard_fail.length,
      manualResidualRows: byDisposition.manual_residual.length,
    },
    byDisposition,
    byDominantFamily,
  }
}
