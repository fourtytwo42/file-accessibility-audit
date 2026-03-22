import type { ResidualFamilyId } from './documentModel.js'
import type { LiveResidualFamilyState } from './liveResidualFamilyDiagnosisService.js'

export type ProcessedIntakeNextBlockingFamily = ResidualFamilyId | 'full_audit_tail' | null

export interface ProcessedIntakeParityDelta {
  scoreDelta: number
  planningGrade: string
  fullAuditGrade: string
  planningOnlyBlockingFamilies: ResidualFamilyId[]
  fullAuditOnlyBlockingFamilies: ResidualFamilyId[]
  planningOnlyBlockingFindingKeys: string[]
  fullAuditOnlyBlockingFindingKeys: string[]
  fullAuditTail: boolean
}

export interface ProcessedIntakeParityState {
  path: string
  filename: string
  planningProfile: LiveResidualFamilyState
  fullAudit: LiveResidualFamilyState
  planningProfileVsFullAuditDelta: ProcessedIntakeParityDelta
}

export interface ProcessedIntakeRuntimeParity {
  planningScoreDelta: number
  fullAuditScoreDelta: number
  planningParityReached: boolean
  fullAuditParityReached: boolean
  parityReached: boolean
  planningAddedBlockingFamilies: ResidualFamilyId[]
  planningRemovedBlockingFamilies: ResidualFamilyId[]
  fullAuditAddedBlockingFamilies: ResidualFamilyId[]
  fullAuditRemovedBlockingFamilies: ResidualFamilyId[]
}

export interface ProcessedIntakeParityPairReport {
  beforeFilename: string
  afterFilename: string
  before: ProcessedIntakeParityState
  runtime: ProcessedIntakeParityState
  storedAfter: ProcessedIntakeParityState
  runtimeVsStoredAfterParity: ProcessedIntakeRuntimeParity
  nextBlockingFamily: ProcessedIntakeNextBlockingFamily
  familyCompletionGap: boolean
}

export interface ProcessedIntakeParityArtifact {
  generatedAt: string
  summary: {
    pairCount: number
    parityReachedCount: number
    familyCompletionGapCount: number
    fullAuditTailCount: number
    nextBlockingFamilies: ProcessedIntakeNextBlockingFamily[]
  }
  pairs: ProcessedIntakeParityPairReport[]
}

function sortedUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort()
}

function diffKeys<T extends string>(left: T[], right: T[]): { leftOnly: T[]; rightOnly: T[] } {
  return {
    leftOnly: left.filter(value => !right.includes(value)).sort(),
    rightOnly: right.filter(value => !left.includes(value)).sort(),
  }
}

function gradeWeight(grade: string): number {
  return ['F', 'D', 'C', 'B', 'A'].indexOf(grade)
}

function blockingFamilies(state: LiveResidualFamilyState): ResidualFamilyId[] {
  return sortedUnique(state.topResidualFamilies.filter(family => family.blocking).map(family => family.id))
}

function hasMaterialFullAuditTail(input: {
  planningProfile: LiveResidualFamilyState
  fullAudit: LiveResidualFamilyState
}): boolean {
  const planningFamilies = blockingFamilies(input.planningProfile)
  const fullAuditFamilies = blockingFamilies(input.fullAudit)
  const scoreDelta = input.planningProfile.overallScore - input.fullAudit.overallScore
  return planningFamilies.length <= 1
    && (
      scoreDelta >= 5
      || gradeWeight(input.fullAudit.grade) < gradeWeight(input.planningProfile.grade)
      || fullAuditFamilies.length > planningFamilies.length
    )
}

export function buildProcessedIntakeParityState(input: {
  path: string
  filename: string
  planningProfile: LiveResidualFamilyState
  fullAudit: LiveResidualFamilyState
}): ProcessedIntakeParityState {
  const planningFamilies = blockingFamilies(input.planningProfile)
  const fullAuditFamilies = blockingFamilies(input.fullAudit)
  const blockingFindingDiff = diffKeys(
    input.planningProfile.blockingFindingKeys,
    input.fullAudit.blockingFindingKeys,
  )
  return {
    path: input.path,
    filename: input.filename,
    planningProfile: input.planningProfile,
    fullAudit: input.fullAudit,
    planningProfileVsFullAuditDelta: {
      scoreDelta: input.planningProfile.overallScore - input.fullAudit.overallScore,
      planningGrade: input.planningProfile.grade,
      fullAuditGrade: input.fullAudit.grade,
      planningOnlyBlockingFamilies: diffKeys(planningFamilies, fullAuditFamilies).leftOnly,
      fullAuditOnlyBlockingFamilies: diffKeys(planningFamilies, fullAuditFamilies).rightOnly,
      planningOnlyBlockingFindingKeys: blockingFindingDiff.leftOnly,
      fullAuditOnlyBlockingFindingKeys: blockingFindingDiff.rightOnly,
      fullAuditTail: hasMaterialFullAuditTail({
        planningProfile: input.planningProfile,
        fullAudit: input.fullAudit,
      }),
    },
  }
}

function runtimeParity(input: {
  runtime: ProcessedIntakeParityState
  storedAfter: ProcessedIntakeParityState
}): ProcessedIntakeRuntimeParity {
  const runtimePlanningFamilies = blockingFamilies(input.runtime.planningProfile)
  const storedAfterPlanningFamilies = blockingFamilies(input.storedAfter.planningProfile)
  const runtimeFullFamilies = blockingFamilies(input.runtime.fullAudit)
  const storedAfterFullFamilies = blockingFamilies(input.storedAfter.fullAudit)
  const planningScoreDelta = input.runtime.planningProfile.overallScore - input.storedAfter.planningProfile.overallScore
  const fullAuditScoreDelta = input.runtime.fullAudit.overallScore - input.storedAfter.fullAudit.overallScore
  const planningParityReached = planningScoreDelta >= 0
    && gradeWeight(input.runtime.planningProfile.grade) >= gradeWeight(input.storedAfter.planningProfile.grade)
  const fullAuditParityReached = fullAuditScoreDelta >= 0
    && gradeWeight(input.runtime.fullAudit.grade) >= gradeWeight(input.storedAfter.fullAudit.grade)
  return {
    planningScoreDelta,
    fullAuditScoreDelta,
    planningParityReached,
    fullAuditParityReached,
    parityReached: planningParityReached && fullAuditParityReached,
    planningAddedBlockingFamilies: diffKeys(storedAfterPlanningFamilies, runtimePlanningFamilies).rightOnly,
    planningRemovedBlockingFamilies: diffKeys(storedAfterPlanningFamilies, runtimePlanningFamilies).leftOnly,
    fullAuditAddedBlockingFamilies: diffKeys(storedAfterFullFamilies, runtimeFullFamilies).rightOnly,
    fullAuditRemovedBlockingFamilies: diffKeys(storedAfterFullFamilies, runtimeFullFamilies).leftOnly,
  }
}

function familyCompletionGap(state: ProcessedIntakeParityState): boolean {
  const blockingFamilies = state.planningProfile.topResidualFamilies.filter(family => family.blocking)
  return blockingFamilies.length === 1 && blockingFamilies[0]?.convergenceStatus === 'preferred_tools_available'
}

function nextBlockingFamily(state: ProcessedIntakeParityState): ProcessedIntakeNextBlockingFamily {
  const planningBlocker = state.planningProfile.topBlockingResidualFamilyIds[0] || null
  if (planningBlocker) return planningBlocker
  if (state.planningProfileVsFullAuditDelta.fullAuditTail) return 'full_audit_tail'
  return null
}

export function buildProcessedIntakeParityPairReport(input: {
  beforeFilename: string
  afterFilename: string
  before: ProcessedIntakeParityState
  runtime: ProcessedIntakeParityState
  storedAfter: ProcessedIntakeParityState
}): ProcessedIntakeParityPairReport {
  return {
    beforeFilename: input.beforeFilename,
    afterFilename: input.afterFilename,
    before: input.before,
    runtime: input.runtime,
    storedAfter: input.storedAfter,
    runtimeVsStoredAfterParity: runtimeParity({
      runtime: input.runtime,
      storedAfter: input.storedAfter,
    }),
    nextBlockingFamily: nextBlockingFamily(input.runtime),
    familyCompletionGap: familyCompletionGap(input.runtime),
  }
}

export function buildProcessedIntakeParityArtifact(input: {
  pairs: ProcessedIntakeParityPairReport[]
  generatedAt?: string
}): ProcessedIntakeParityArtifact {
  return {
    generatedAt: input.generatedAt || new Date().toISOString(),
    summary: {
      pairCount: input.pairs.length,
      parityReachedCount: input.pairs.filter(pair => pair.runtimeVsStoredAfterParity.parityReached).length,
      familyCompletionGapCount: input.pairs.filter(pair => pair.familyCompletionGap).length,
      fullAuditTailCount: input.pairs.filter(pair => pair.runtime.planningProfileVsFullAuditDelta.fullAuditTail).length,
      nextBlockingFamilies: sortedUnique(input.pairs.map(pair => pair.nextBlockingFamily).filter((value): value is Exclude<ProcessedIntakeNextBlockingFamily, null> => value !== null)),
    },
    pairs: input.pairs,
  }
}
