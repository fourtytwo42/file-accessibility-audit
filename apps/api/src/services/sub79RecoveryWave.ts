export type RecoveryRuntimeWeight = 'light' | 'medium' | 'heavy'
export type RecoveryLaneName =
  | 'all-sub79-recovery'
  | 'sub79-tail-canary'
  | 'mixed-structure-figure-core'
  | 'mixed-structure-figure-plus'
  | 'font-led-deterministic'

export type RecoveryLaneIntent = 'pass_rate_conversion'

export interface RecoveryWaveOutcome {
  publicationId: string | null
  publicationTitle?: string | null
  priorityRank?: number | null
  priorityTier?: 'highest' | 'high' | 'medium' | null
  passLikelihoodScore?: number | null
  currentCorpusStatus?: string | null
  dominantSelectionFamily?: string | null
  runtimeWeightBucket?: RecoveryRuntimeWeight | null
  runtimeProfileKey?: string | null
  blockingFindingKeys?: string[] | null
  serverHost?: string | null
  remotePath?: string | null
  fileUrl?: string | null
  storageKind?: string | null
  originalReportPath?: string | null
  status?: string | null
  resultBand?: string | null
  processedAt?: string | null
  original?: {
    overallScore?: number | null
    grade?: string | null
    pageCount?: number | null
    isScanned?: boolean | null
  } | null
  final?: {
    overallScore?: number | null
    grade?: string | null
    pageCount?: number | null
    isScanned?: boolean | null
  } | null
  gate?: {
    blockingLocalFindingKeys?: string[] | null
  } | null
  seed?: {
    priorOverallScore?: number | null
    priorGrade?: string | null
    priorResultBand?: string | null
    priorProcessedAt?: string | null
  } | null
  artifacts?: {
    remediatedPdfPath?: string | null
    detailedReportPath?: string | null
    failureReportPath?: string | null
  } | null
}

export interface RecoveryWaveCandidate {
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
  currentCorpusStatus: string | null
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
  dominantSelectionFamily: string | null
  runtimeWeightBucket: RecoveryRuntimeWeight | null
  runtimeProfileKey: string | null
  laneIntent: RecoveryLaneIntent
  blockerSignature: string
  blockerFamilies: string[]
  scoreDeltaFromPrior: number | null
  blockerCountDeltaFromPrior: number | null
  blockerFamilyShrinkFromPrior: boolean
  plateaued: boolean
  seedOverallScore: number | null
  seedGrade: string | null
  seedResultBand: string | null
  seedProcessedAt: string | null
  reportPath: string
}

export interface RecoveryWaveManifest {
  generatedAt: string
  laneName: RecoveryLaneName
  laneIntent: RecoveryLaneIntent
  executionPolicy: 'active'
  executionPolicyReason: string
  recommendedConcurrency: number
  initialAnalysisProfile: 'full_final'
  verificationPolicy: 'terminal_candidates_only'
  sourceOutcomesPaths: string[]
  sourceOutcomesGeneratedAt: string | null
  scorePolicy: {
    minPassOverallScore: number
    minKeepOverallScore: null
  }
  totals: {
    scannedReportsConsidered: number
    selectedCandidates: number
    byTier: Record<string, number>
    plateauedCandidates: number
    nonPlateauedCandidates: number
    excludedNonTerminal: number
    excludedAbove79: number
    excludedMissingArtifact: number
    excludedMissingRemote: number
    excludedLaneMismatch: number
  }
  blockerSignatureCounts: Record<string, number>
  plateauCounts: {
    plateaued: number
    nonPlateaued: number
  }
  candidates: RecoveryWaveCandidate[]
}

export interface RecoveryWaveManifestInput {
  laneName: RecoveryLaneName
  sourceOutcomesPaths: string[]
  sourceOutcomesGeneratedAt?: string | null
  latestOutcomes: RecoveryWaveOutcome[]
  historyByPublicationId: Map<string, RecoveryWaveOutcome[]>
}

const STRUCTURE_KEYS = new Set([
  'pdfua.logical_structure',
  'pdfua.heading_content_quality',
  'pdfua.reading_order',
])

const FIGURE_KEYS = new Set([
  'pdfua.figure_alt_or_artifact',
  'pdfua.nested_alt_text',
  'pdfua.untagged_rendered_images',
  'pdfua.figure_alt_quality',
])

const FONT_KEYS = new Set([
  'pdfua.font_embedding',
  'pdfua.font_unicode',
  'pdfua.type1_unicode',
  'pdfua.truetype_encoding_differences',
  'pdfua.font_widths',
  'pdfua.cid_symbol_fonts',
  'pdfua.cidset_consistency',
])

const ANNOTATION_KEYS = new Set([
  'pdfua.annotation_alt_contents',
  'pdfua.link_tagging',
  'pdfua.tagged_annotations',
])

const TABLE_KEYS = new Set([
  'pdfua.table_regularity',
  'pdfua.table_complexity',
])

function safeNumber(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

function runtimeRank(value: RecoveryRuntimeWeight | null | undefined): number {
  if (value === 'light') return 0
  if (value === 'medium') return 1
  if (value === 'heavy') return 2
  return 3
}

function parseTime(value: string | null | undefined): number {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export function blockingFindingKeysForOutcome(outcome: RecoveryWaveOutcome): string[] {
  const keys = Array.isArray(outcome.gate?.blockingLocalFindingKeys) && outcome.gate?.blockingLocalFindingKeys.length
    ? outcome.gate.blockingLocalFindingKeys
    : Array.isArray(outcome.blockingFindingKeys)
      ? outcome.blockingFindingKeys
      : []
  return [...new Set(keys.map(String).filter(Boolean))].sort()
}

export function blockerFamiliesForKeys(keys: string[]): string[] {
  const families = new Set<string>()
  for (const key of keys) {
    if (STRUCTURE_KEYS.has(key)) families.add('structure')
    if (FIGURE_KEYS.has(key)) families.add('figure')
    if (FONT_KEYS.has(key)) families.add('font')
    if (ANNOTATION_KEYS.has(key)) families.add('annotation')
    if (TABLE_KEYS.has(key)) families.add('table')
  }
  return [...families].sort()
}

export function blockerSignatureForKeys(keys: string[]): string {
  return keys.length ? [...keys].sort().join(' + ') : '(none)'
}

function familyShrinkFrom(previousKeys: string[], nextKeys: string[]): boolean {
  const previousFamilies = blockerFamiliesForKeys(previousKeys)
  const nextFamilies = blockerFamiliesForKeys(nextKeys)
  return nextFamilies.length < previousFamilies.length
}

function derivePriorityTier(input: {
  overallScore: number
  scoreDeltaFromPrior: number | null
  plateaued: boolean
}): 'highest' | 'high' | 'medium' {
  if (!input.plateaued && ((input.scoreDeltaFromPrior ?? 0) >= 8 || input.overallScore >= 72)) return 'highest'
  if (!input.plateaued && ((input.scoreDeltaFromPrior ?? 0) >= 3 || input.overallScore >= 66)) return 'high'
  return 'medium'
}

function buildHistoryIndex(outcomes: RecoveryWaveOutcome[]): Map<string, RecoveryWaveOutcome[]> {
  const byId = new Map<string, RecoveryWaveOutcome[]>()
  for (const outcome of outcomes) {
    const publicationId = String(outcome.publicationId || '')
    if (!publicationId) continue
    const existing = byId.get(publicationId) || []
    existing.push(outcome)
    byId.set(publicationId, existing)
  }
  for (const entry of byId.values()) {
    entry.sort((left, right) => parseTime(left.processedAt) - parseTime(right.processedAt))
  }
  return byId
}

export function isPlateauedHistory(history: RecoveryWaveOutcome[]): boolean {
  if (history.length < 3) return false
  const last = history[history.length - 1]!
  const previous = history[history.length - 2]!
  const prior = history[history.length - 3]!
  const lastScore = safeNumber(last.final?.overallScore, Number.NaN)
  const previousScore = safeNumber(previous.final?.overallScore, Number.NaN)
  const priorScore = safeNumber(prior.final?.overallScore, Number.NaN)
  const noScoreImprovementLast = !Number.isFinite(lastScore) || !Number.isFinite(previousScore) || lastScore <= previousScore
  const noScoreImprovementPrevious = !Number.isFinite(previousScore) || !Number.isFinite(priorScore) || previousScore <= priorScore
  const noFamilyShrinkLast = !familyShrinkFrom(blockingFindingKeysForOutcome(previous), blockingFindingKeysForOutcome(last))
  const noFamilyShrinkPrevious = !familyShrinkFrom(blockingFindingKeysForOutcome(prior), blockingFindingKeysForOutcome(previous))
  return noScoreImprovementLast && noScoreImprovementPrevious && noFamilyShrinkLast && noFamilyShrinkPrevious
}

function isTerminalSub79Outcome(outcome: RecoveryWaveOutcome): boolean {
  const finalScore = outcome.final?.overallScore
  return outcome.status === 'failed_after_remediation'
    && typeof finalScore === 'number'
    && finalScore <= 79
}

function matchesLane(keys: string[], laneName: RecoveryLaneName): boolean {
  const keySet = new Set(keys)
  const exactCore =
    keySet.size === 2
    && keySet.has('pdfua.logical_structure')
    && keySet.has('pdfua.figure_alt_or_artifact')
  const plusKeyCount = ['pdfua.annotation_alt_contents', 'pdfua.nested_alt_text', 'pdfua.heading_content_quality']
    .filter(key => keySet.has(key))
    .length
  switch (laneName) {
    case 'all-sub79-recovery':
      return true
    case 'sub79-tail-canary':
      return true
    case 'mixed-structure-figure-core':
      return exactCore
    case 'mixed-structure-figure-plus':
      return keySet.has('pdfua.logical_structure')
        && keySet.has('pdfua.figure_alt_or_artifact')
        && plusKeyCount > 0
    case 'font-led-deterministic': {
      const families = blockerFamiliesForKeys(keys)
      const hasStructureDebt = families.includes('structure')
      const hasFontDebt = families.includes('font')
      return hasFontDebt && !hasStructureDebt
    }
  }
}

function executionReasonForLane(laneName: RecoveryLaneName): string {
  switch (laneName) {
    case 'all-sub79-recovery':
      return 'target_all_remediated_sub79_outputs_with_mixed_convergence_strategy'
    case 'sub79-tail-canary':
      return 'target_tail_canary_one_blocker_near_pass_annotation_figure_and_figure_table_residue'
    case 'mixed-structure-figure-core':
      return 'target_exact_structure_plus_figure_core_residue'
    case 'mixed-structure-figure-plus':
      return 'target_structure_plus_figure_residue_with_annotation_nested_or_heading_tail'
    case 'font-led-deterministic':
      return 'target_remaining_font_led_residue_without_structure_debt'
  }
}

function selectTailCanaryCandidates(candidates: RecoveryWaveCandidate[]): RecoveryWaveCandidate[] {
  const ordered = [...candidates].sort((left, right) =>
    runtimeRank(left.runtimeWeightBucket) - runtimeRank(right.runtimeWeightBucket)
    || Number(right.blockerFamilyShrinkFromPrior) - Number(left.blockerFamilyShrinkFromPrior)
    || (right.scoreDeltaFromPrior ?? Number.NEGATIVE_INFINITY) - (left.scoreDeltaFromPrior ?? Number.NEGATIVE_INFINITY)
    || right.overallScore - left.overallScore
    || String(left.publicationId || '').localeCompare(String(right.publicationId || '')),
  )
  const oneBlockerAndNearPass = ordered.filter(candidate =>
    candidate.blockingFindingCount <= 1 || candidate.overallScore >= 70,
  ).slice(0, 20)
  const annotationFigure = ordered.filter(candidate =>
    candidate.blockerFamilies.includes('annotation') && candidate.blockerFamilies.includes('figure'),
  ).slice(0, 10)
  const figureTable = ordered.filter(candidate =>
    candidate.blockerFamilies.includes('figure') && candidate.blockerFamilies.includes('table'),
  ).slice(0, 10)
  const byId = new Map<string, RecoveryWaveCandidate>()
  for (const candidate of [...oneBlockerAndNearPass, ...annotationFigure, ...figureTable]) {
    const key = String(candidate.publicationId || '')
    if (!key || byId.has(key)) continue
    byId.set(key, candidate)
  }
  return [...byId.values()]
}

function toCandidate(
  outcome: RecoveryWaveOutcome,
  history: RecoveryWaveOutcome[],
): RecoveryWaveCandidate {
  const blockingFindingKeys = blockingFindingKeysForOutcome(outcome)
  const blockerSignature = blockerSignatureForKeys(blockingFindingKeys)
  const blockerFamilies = blockerFamiliesForKeys(blockingFindingKeys)
  const previousOutcome = history.length >= 2 ? history[history.length - 2]! : null
  const previousKeys = previousOutcome ? blockingFindingKeysForOutcome(previousOutcome) : []
  const overallScore = safeNumber(outcome.final?.overallScore, 0)
  const seedOverallScore = Number.isFinite(outcome.seed?.priorOverallScore) ? Number(outcome.seed?.priorOverallScore) : previousOutcome?.final?.overallScore ?? null
  const scoreDeltaFromPrior = seedOverallScore == null ? null : overallScore - seedOverallScore
  const blockerCountDeltaFromPrior = previousOutcome ? blockingFindingKeys.length - previousKeys.length : null
  const blockerFamilyShrinkFromPrior = previousOutcome ? familyShrinkFrom(previousKeys, blockingFindingKeys) : false
  const plateaued = isPlateauedHistory(history)
  const priorityTier = derivePriorityTier({ overallScore, scoreDeltaFromPrior, plateaued })

  return {
    priorityRank: safeNumber(outcome.priorityRank, 0),
    passLikelihoodScore: Math.max(0, Math.min(100, overallScore)),
    priorityTier,
    recommendedAction: 'fix_first',
    publicationId: outcome.publicationId ?? null,
    publicationTitle: outcome.publicationTitle ?? null,
    serverHost: outcome.serverHost ?? null,
    remotePath: outcome.remotePath ?? null,
    localCachePath: outcome.artifacts?.remediatedPdfPath ?? null,
    fileUrl: outcome.fileUrl ?? null,
    storageKind: outcome.storageKind ?? null,
    currentCorpusStatus: outcome.currentCorpusStatus ?? 'remediated_fail',
    overallScore,
    grade: outcome.final?.grade == null ? '' : String(outcome.final.grade),
    pageCount: safeNumber(outcome.final?.pageCount ?? outcome.original?.pageCount, 0),
    isScanned: Boolean(outcome.final?.isScanned ?? outcome.original?.isScanned),
    blockerFamilyCount: blockerFamilies.length,
    blockingFindingCount: blockingFindingKeys.length,
    manualOnlyFailureModeCount: 0,
    autoRunnableOpportunityCount: 0,
    topBlockingResidualFamilyIds: [],
    blockingFindingKeys,
    autoRunnableOpportunityKeys: [],
    manualOnlyFailureModeKeys: [],
    heuristicReasons: [
      `blocker_signature:${blockerSignature}`,
      blockerFamilies.length ? `blocker_families:${blockerFamilies.join('+')}` : 'blocker_families:none',
      scoreDeltaFromPrior == null ? 'prior_delta:unknown' : `prior_delta:${scoreDeltaFromPrior >= 0 ? '+' : ''}${scoreDeltaFromPrior}`,
      plateaued ? 'plateaued:true' : 'plateaued:false',
    ],
    dominantSelectionFamily: outcome.dominantSelectionFamily ?? null,
    runtimeWeightBucket: outcome.runtimeWeightBucket ?? null,
    runtimeProfileKey: outcome.runtimeProfileKey ?? null,
    laneIntent: 'pass_rate_conversion',
    blockerSignature,
    blockerFamilies,
    scoreDeltaFromPrior,
    blockerCountDeltaFromPrior,
    blockerFamilyShrinkFromPrior,
    plateaued,
    seedOverallScore,
    seedGrade: outcome.seed?.priorGrade == null ? null : String(outcome.seed.priorGrade),
    seedResultBand: outcome.seed?.priorResultBand == null ? null : String(outcome.seed.priorResultBand),
    seedProcessedAt: outcome.seed?.priorProcessedAt == null ? null : String(outcome.seed.priorProcessedAt),
    reportPath: outcome.artifacts?.detailedReportPath || outcome.artifacts?.failureReportPath || outcome.originalReportPath || '',
  }
}

export function buildRecoveryWaveManifest(input: RecoveryWaveManifestInput): RecoveryWaveManifest {
  let excludedNonTerminal = 0
  let excludedAbove79 = 0
  let excludedMissingArtifact = 0
  let excludedMissingRemote = 0
  let excludedLaneMismatch = 0

  const baseSelected = input.latestOutcomes
    .filter(outcome => {
      if (!isTerminalSub79Outcome(outcome)) {
        if (outcome.status === 'failed_after_remediation' && typeof outcome.final?.overallScore === 'number' && outcome.final.overallScore > 79) {
          excludedAbove79 += 1
        } else {
          excludedNonTerminal += 1
        }
        return false
      }
      if (!outcome.artifacts?.remediatedPdfPath) {
        excludedMissingArtifact += 1
        return false
      }
      if (!outcome.remotePath) {
        excludedMissingRemote += 1
        return false
      }
      const keys = blockingFindingKeysForOutcome(outcome)
      if (!matchesLane(keys, input.laneName)) {
        excludedLaneMismatch += 1
        return false
      }
      return true
    })
    .map(outcome => toCandidate(
      outcome,
      input.historyByPublicationId.get(String(outcome.publicationId || '')) || [outcome],
    ))
    .sort((left, right) =>
      Number(left.plateaued) - Number(right.plateaued)
      || runtimeRank(left.runtimeWeightBucket) - runtimeRank(right.runtimeWeightBucket)
      || Number(right.blockerFamilyShrinkFromPrior) - Number(left.blockerFamilyShrinkFromPrior)
      || (right.scoreDeltaFromPrior ?? Number.NEGATIVE_INFINITY) - (left.scoreDeltaFromPrior ?? Number.NEGATIVE_INFINITY)
      || right.overallScore - left.overallScore
      || String(left.publicationId || '').localeCompare(String(right.publicationId || '')),
    )
  const selectedBaseForLane = input.laneName === 'sub79-tail-canary'
    ? selectTailCanaryCandidates(baseSelected)
    : baseSelected
  const selected = selectedBaseForLane.map((candidate, index) => ({ ...candidate, priorityRank: index + 1 }))

  const byTier = selected.reduce<Record<string, number>>((acc, candidate) => {
    acc[candidate.priorityTier] = (acc[candidate.priorityTier] || 0) + 1
    return acc
  }, {})
  const blockerSignatureCounts = selected.reduce<Record<string, number>>((acc, candidate) => {
    acc[candidate.blockerSignature] = (acc[candidate.blockerSignature] || 0) + 1
    return acc
  }, {})
  const plateauedCandidates = selected.filter(candidate => candidate.plateaued).length

  return {
    generatedAt: new Date().toISOString(),
    laneName: input.laneName,
    laneIntent: 'pass_rate_conversion',
    executionPolicy: 'active',
    executionPolicyReason: executionReasonForLane(input.laneName),
    recommendedConcurrency: 4,
    initialAnalysisProfile: 'full_final',
    verificationPolicy: 'terminal_candidates_only',
    sourceOutcomesPaths: input.sourceOutcomesPaths,
    sourceOutcomesGeneratedAt: input.sourceOutcomesGeneratedAt ?? null,
    scorePolicy: {
      minPassOverallScore: 90,
      minKeepOverallScore: null,
    },
    totals: {
      scannedReportsConsidered: input.latestOutcomes.length,
      selectedCandidates: selected.length,
      byTier,
      plateauedCandidates,
      nonPlateauedCandidates: selected.length - plateauedCandidates,
      excludedNonTerminal,
      excludedAbove79,
      excludedMissingArtifact,
      excludedMissingRemote,
      excludedLaneMismatch,
    },
    blockerSignatureCounts,
    plateauCounts: {
      plateaued: plateauedCandidates,
      nonPlateaued: selected.length - plateauedCandidates,
    },
    candidates: selected,
  }
}

export function latestOutcomePerPublication(outcomes: RecoveryWaveOutcome[]): RecoveryWaveOutcome[] {
  const latest = new Map<string, RecoveryWaveOutcome>()
  for (const outcome of outcomes) {
    const publicationId = String(outcome.publicationId || '')
    if (!publicationId) continue
    const current = latest.get(publicationId)
    if (!current || parseTime(outcome.processedAt) > parseTime(current.processedAt)) {
      latest.set(publicationId, outcome)
    }
  }
  return [...latest.values()]
}

export function buildRecoveryWaveHistory(outcomes: RecoveryWaveOutcome[]): Map<string, RecoveryWaveOutcome[]> {
  return buildHistoryIndex(outcomes)
}
