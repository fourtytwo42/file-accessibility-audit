export type RuntimeTailOvernightRecommendation =
  | 'continue_same_lane'
  | 'switch_to_terminalization'
  | 'stop_and_replan_engine'

export type RuntimeWeightBucket = 'light' | 'medium' | 'heavy'

export interface RuntimeTailChunkCandidate {
  publicationId: string
  runtimeWeightBucket?: RuntimeWeightBucket
  runtimeProfileKey?: string | null
  passLikelihoodScore?: number
}

export interface RuntimeTailChunkMetrics {
  sliceIntent: 'pass_rate_conversion' | 'truth_hardening_terminalization'
  selectedCount: number
  passCandidates: number
  processingErrorCount: number
  processingErrorToStableHardFail: number
  unchangedProcessingError: number
  targetedFindingDeltas: Record<string, number>
  targetedFamilyDeltas: Record<string, number>
  remainingRetryWorthyRows: number
  consecutiveLowYieldChunks: number
  exitCode?: number | null
  processingErrorRateThreshold?: number
}

export interface RuntimeTailChunkSummary {
  passRateSummary: {
    passCandidates: number
    blockerReductionObserved: boolean
    remainingRetryWorthyRows: number
  }
  truthHardeningSummary: {
    processingErrorToFailedAfterRemediation: number
    rowsRemovedFromRetryBudget: number
    stillUnresolvedRows: number
  }
}

export interface RuntimeTailChunkPlan {
  selectedPublicationIds: string[]
  chunkSizeCap: number
  concurrency: number
  runtimeWeightBucket: RuntimeWeightBucket
  isolatedHeavyProfileKeys: string[]
}

function hasTargetedReduction(deltas: Record<string, number>): boolean {
  return Object.values(deltas).some(value => Number(value) < 0)
}

function runtimeWeightRank(bucket: RuntimeWeightBucket | undefined): number {
  return bucket === 'light' ? 0 : bucket === 'medium' ? 1 : 2
}

function chunkCapForWeight(bucket: RuntimeWeightBucket): number {
  if (bucket === 'heavy') return 1
  if (bucket === 'medium') return 4
  return 8
}

export function planRuntimeTailChunk(input: {
  candidates: RuntimeTailChunkCandidate[]
  nominalChunkSize: number
  sliceIntent: 'pass_rate_conversion' | 'truth_hardening_terminalization'
}): RuntimeTailChunkPlan {
  if (!input.candidates.length) {
    return {
      selectedPublicationIds: [],
      chunkSizeCap: input.nominalChunkSize,
      concurrency: 1,
      runtimeWeightBucket: 'light',
      isolatedHeavyProfileKeys: [],
    }
  }

  const sorted = [...input.candidates].sort((left, right) => {
    const weightDiff = runtimeWeightRank(left.runtimeWeightBucket) - runtimeWeightRank(right.runtimeWeightBucket)
    if (weightDiff !== 0) return weightDiff
    const scoreDiff = Number(right.passLikelihoodScore || 0) - Number(left.passLikelihoodScore || 0)
    if (scoreDiff !== 0) return scoreDiff
    return left.publicationId.localeCompare(right.publicationId)
  })

  const firstBucket = sorted[0]?.runtimeWeightBucket || 'light'
  const chunkSizeCap = Math.min(input.nominalChunkSize, chunkCapForWeight(firstBucket))
  const selected: RuntimeTailChunkCandidate[] = []
  const heavyProfileKeys = new Set<string>()

  for (const candidate of sorted) {
    if (selected.length >= chunkSizeCap) break
    const bucket = candidate.runtimeWeightBucket || 'light'
    if (bucket === 'heavy') {
      const profileKey = candidate.runtimeProfileKey || candidate.publicationId
      if (heavyProfileKeys.size > 0) continue
      heavyProfileKeys.add(profileKey)
      selected.push(candidate)
      continue
    }
    if (firstBucket === 'heavy' && selected.length >= 1) continue
    selected.push(candidate)
  }

  const runtimeWeightBucket = selected.some(candidate => candidate.runtimeWeightBucket === 'heavy')
    ? 'heavy'
    : selected.some(candidate => candidate.runtimeWeightBucket === 'medium')
      ? 'medium'
      : 'light'

  const concurrency = runtimeWeightBucket === 'heavy'
    ? 1
    : input.sliceIntent === 'truth_hardening_terminalization'
      ? 2
      : 8

  return {
    selectedPublicationIds: selected.map(candidate => candidate.publicationId),
    chunkSizeCap,
    concurrency,
    runtimeWeightBucket,
    isolatedHeavyProfileKeys: [...heavyProfileKeys].sort(),
  }
}

export function summarizeRuntimeTailChunkMetrics(input: RuntimeTailChunkMetrics): RuntimeTailChunkSummary {
  const blockerReductionObserved = hasTargetedReduction(input.targetedFindingDeltas)
    || hasTargetedReduction(input.targetedFamilyDeltas)

  return {
    passRateSummary: {
      passCandidates: input.passCandidates,
      blockerReductionObserved,
      remainingRetryWorthyRows: input.remainingRetryWorthyRows,
    },
    truthHardeningSummary: {
      processingErrorToFailedAfterRemediation: input.processingErrorToStableHardFail,
      rowsRemovedFromRetryBudget: input.processingErrorToStableHardFail + input.passCandidates,
      stillUnresolvedRows: input.unchangedProcessingError + input.processingErrorCount,
    },
  }
}

export function recommendRuntimeTailOvernightAction(input: RuntimeTailChunkMetrics): RuntimeTailOvernightRecommendation {
  if (input.exitCode === 137) return 'stop_and_replan_engine'

  const processingErrorRateThreshold = input.processingErrorRateThreshold ?? 0.35
  const processingErrorRate = input.selectedCount > 0
    ? input.processingErrorCount / input.selectedCount
    : 0
  if (processingErrorRate > processingErrorRateThreshold) {
    return input.sliceIntent === 'pass_rate_conversion'
      ? 'switch_to_terminalization'
      : 'stop_and_replan_engine'
  }

  const summary = summarizeRuntimeTailChunkMetrics(input)
  const lowYield = summary.passRateSummary.passCandidates === 0
    && !summary.passRateSummary.blockerReductionObserved
  if (lowYield && input.consecutiveLowYieldChunks >= 2) {
    return input.sliceIntent === 'pass_rate_conversion'
      ? 'switch_to_terminalization'
      : 'stop_and_replan_engine'
  }

  return 'continue_same_lane'
}
