import path from 'node:path'
import type {
  FailureProfile,
  ModelReviewFlag,
  PlannerEvidenceSummary,
  ResidualFamilyDecision,
  ResidualFamilyId,
} from './documentModel.js'

export type SemanticSidecarState = 'unknown' | 'not_flagged' | 'semantic_sidecar_unavailable'

export interface LiveResidualFamilySummary {
  id: ResidualFamilyId
  label: string
  blocking: boolean
  blockingReason?: string
  currentStep: number | null
  evidenceSignals: string[]
  evidenceStrength: number
  activeOpportunityKeys: string[]
}

export interface LiveResidualFamilyState {
  path: string
  filename: string
  overallScore: number
  grade: string
  blockingFindingKeys: string[]
  topBlockingResidualFamilyIds: ResidualFamilyId[]
  topResidualFamilies: LiveResidualFamilySummary[]
  autoRunnableOpportunityKeys: string[]
  manualOnlyFailureModeKeys: string[]
  semanticSidecarState: SemanticSidecarState
}

export interface LiveResidualFamilyDiff {
  addedBlockingFamilies: ResidualFamilyId[]
  removedBlockingFamilies: ResidualFamilyId[]
  persistentBlockingFamilies: ResidualFamilyId[]
  sourceTopBlocker: ResidualFamilyId | null
  attemptTopBlocker: ResidualFamilyId | null
}

export interface LiveResidualFamilyPairReport {
  source: LiveResidualFamilyState
  attempt: LiveResidualFamilyState
  familyDiff: LiveResidualFamilyDiff
}

export interface LiveResidualFamilyDiagnosisArtifact {
  generatedAt: string
  pairs: LiveResidualFamilyPairReport[]
  controls: LiveResidualFamilyState[]
}

function familySort(left: ResidualFamilyDecision, right: ResidualFamilyDecision): number {
  return Number(right.blocking) - Number(left.blocking)
    || left.priority - right.priority
    || right.evidenceStrength - left.evidenceStrength
    || left.id.localeCompare(right.id)
}

function semanticSidecarStateFromFlags(flags: ModelReviewFlag[] | null | undefined): SemanticSidecarState {
  if (!flags) return 'unknown'
  return flags.some(flag => flag.code === 'semantic_sidecar_unavailable')
    ? 'semantic_sidecar_unavailable'
    : 'not_flagged'
}

function summarizeFamily(family: ResidualFamilyDecision): LiveResidualFamilySummary {
  return {
    id: family.id,
    label: family.label,
    blocking: family.blocking,
    blockingReason: family.blockingReason,
    currentStep: family.currentStep,
    evidenceSignals: family.evidenceSignals.slice(0, 5),
    evidenceStrength: family.evidenceStrength,
    activeOpportunityKeys: family.activeOpportunityKeys.slice(0, 10),
  }
}

export function buildLiveResidualFamilyState(input: {
  filePath: string
  overallScore: number
  grade: string
  failureProfile: FailureProfile
  plannerEvidence: PlannerEvidenceSummary
  manualReviewFlags?: ModelReviewFlag[] | null
}): LiveResidualFamilyState {
  const residualFamilies = [...(input.failureProfile.residualFamilies || [])].sort(familySort)
  return {
    path: input.filePath,
    filename: path.basename(input.filePath),
    overallScore: input.overallScore,
    grade: input.grade,
    blockingFindingKeys: (input.failureProfile.failureModes || [])
      .filter(mode => mode.blocking)
      .map(mode => mode.key)
      .sort(),
    topBlockingResidualFamilyIds: (input.plannerEvidence.topBlockingResidualFamilyIds || residualFamilies.filter(family => family.blocking).map(family => family.id)).slice(0, 5),
    topResidualFamilies: residualFamilies.slice(0, 5).map(summarizeFamily),
    autoRunnableOpportunityKeys: input.failureProfile.toolOpportunities
      .filter(opportunity => opportunity.status === 'auto_runnable')
      .map(opportunity => opportunity.key)
      .sort(),
    manualOnlyFailureModeKeys: (input.failureProfile.failureModes || [])
      .filter(mode => mode.classification === 'manual_only')
      .map(mode => mode.key)
      .sort(),
    semanticSidecarState: semanticSidecarStateFromFlags(input.manualReviewFlags),
  }
}

export function buildLiveResidualFamilyDiff(
  source: LiveResidualFamilyState,
  attempt: LiveResidualFamilyState,
): LiveResidualFamilyDiff {
  const sourceBlocking = new Set(source.topBlockingResidualFamilyIds)
  const attemptBlocking = new Set(attempt.topBlockingResidualFamilyIds)
  return {
    addedBlockingFamilies: [...attemptBlocking].filter(id => !sourceBlocking.has(id)).sort(),
    removedBlockingFamilies: [...sourceBlocking].filter(id => !attemptBlocking.has(id)).sort(),
    persistentBlockingFamilies: [...attemptBlocking].filter(id => sourceBlocking.has(id)).sort(),
    sourceTopBlocker: source.topBlockingResidualFamilyIds[0] || null,
    attemptTopBlocker: attempt.topBlockingResidualFamilyIds[0] || null,
  }
}

export function buildLiveResidualFamilyDiagnosisArtifact(input: {
  pairs: Array<{ source: LiveResidualFamilyState; attempt: LiveResidualFamilyState }>
  controls?: LiveResidualFamilyState[]
  generatedAt?: string
}): LiveResidualFamilyDiagnosisArtifact {
  return {
    generatedAt: input.generatedAt || new Date().toISOString(),
    pairs: input.pairs.map(pair => ({
      source: pair.source,
      attempt: pair.attempt,
      familyDiff: buildLiveResidualFamilyDiff(pair.source, pair.attempt),
    })),
    controls: [...(input.controls || [])],
  }
}
