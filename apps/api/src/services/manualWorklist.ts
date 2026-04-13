export const INITIAL_MANUAL_WORKLIST_PUBLICATION_IDS = [
  '4481',
  '4186',
  '4593',
  '3691',
  '3705',
  '3703',
  '3710',
  '3698',
  '3707',
  '3694',
  '3706',
  '3700',
] as const

export type ManualWorklistStatus =
  | 'manual_ready_to_replace'
  | 'manual_terminalized'
  | 'manual_in_progress'
  | 'manual_deferred'

export type ManualWorklistResolutionReason =
  | 'cleared_final_blockers'
  | 'cleared_min_overall_score'
  | 'manual_object_level_repair_exhausted'
  | 'manual_rebuild_required_not_patchable'
  | 'manual_scanned_or_source_limited'
  | 'manual_runtime_cost_not_worth_continuing'

export interface ManualWorklistCandidateInput {
  publicationId: string
  publicationTitle: string | null
  serverHost: string
  localCachePath: string | null
  bestManualInputPath?: string | null
  dominantResidualFamily: 'figure' | 'structure' | 'font' | 'mixed' | 'metadata' | 'manual' | 'unknown'
  blockingFindingKeys: string[]
  pageCount: number
  runtimeWeightBucket: 'light' | 'medium' | 'heavy'
}

export interface ManualWorklistCandidate extends ManualWorklistCandidateInput {
  manualPriorityRank: number
  queueIntent: 'manual_remediation'
  manualRationale: string
}

export interface ManualWorklistDocument {
  generatedAt: string
  queueName: 'manual-worklist'
  queueIntent: 'manual_remediation'
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  sourceFigureFinalMileClosurePath: string
  totals: {
    selectedRows: number
  }
  selectedPublicationIds: string[]
  candidates: ManualWorklistCandidate[]
}

export interface ManualWorklistOutcomeRecord {
  publicationId: string
  publicationTitle: string | null
  status: ManualWorklistStatus
  processedAt: string
  inputPath: string | null
  outputPath: string | null
  reportPath: string | null
  stagedReplacementPath: string | null
  beforeScore: number | null
  afterScore: number | null
  beforeGrade: string | null
  afterGrade: string | null
  beforeBlockingFindingKeys: string[]
  afterBlockingFindingKeys: string[]
  manualResolutionReason: ManualWorklistResolutionReason
  manualResolutionNotes: string
  lastValidatedAt: string | null
  gate?: {
    passed?: boolean | null
    blockingLocalFindingKeys?: string[]
    unresolvedCategoryLabels?: string[]
    criticalManualReviewFlagCodes?: string[]
    reasons?: string[]
  } | null
  original?: {
    overallScore?: number | null
    grade?: string | null
  } | null
  final?: {
    overallScore?: number | null
    grade?: string | null
  } | null
  artifacts?: {
    remediatedPdfPath?: string | null
    stagedReplacementPath?: string | null
    detailedReportPath?: string | null
  } | null
}

export interface ManualWorklistOutcomeDocument {
  generatedAt: string
  queueName: 'manual-worklist'
  outcomes: ManualWorklistOutcomeRecord[]
}

export interface ManualWorklistOutcomeSummary {
  generatedAt: string
  queueName: 'manual-worklist'
  totals: {
    totalOutcomes: number
    manualReadyToReplace: number
    manualTerminalized: number
    manualInProgress: number
    manualDeferred: number
  }
  reasonsByFrequency: Record<string, number>
  statusByPublicationId: Record<string, ManualWorklistStatus>
}

export function isManualMitigationStatus(status: string | null | undefined): status is ManualWorklistStatus {
  return status === 'manual_ready_to_replace'
    || status === 'manual_terminalized'
    || status === 'manual_in_progress'
    || status === 'manual_deferred'
}

export function buildManualWorklist(input: {
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  sourceFigureFinalMileClosurePath: string
  candidates: ManualWorklistCandidateInput[]
}): ManualWorklistDocument {
  const candidateByPublicationId = new Map(input.candidates.map(candidate => [candidate.publicationId, candidate]))
  const selected = INITIAL_MANUAL_WORKLIST_PUBLICATION_IDS
    .map((publicationId, index) => {
      const candidate = candidateByPublicationId.get(publicationId)
      if (!candidate) return null
      return {
        ...candidate,
        manualPriorityRank: index + 1,
        queueIntent: 'manual_remediation' as const,
        manualRationale: index < 3
          ? 'phase_a_calibration_object_level_figure_surgery'
          : 'phase_b_automation_relief_heavy_figure_final_mile',
      }
    })
    .filter((candidate): candidate is ManualWorklistCandidate => !!candidate)

  return {
    generatedAt: new Date().toISOString(),
    queueName: 'manual-worklist',
    queueIntent: 'manual_remediation',
    sourceControlPlanePath: input.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: input.sourceControlPlaneGeneratedAt,
    sourceFigureFinalMileClosurePath: input.sourceFigureFinalMileClosurePath,
    totals: {
      selectedRows: selected.length,
    },
    selectedPublicationIds: selected.map(candidate => candidate.publicationId),
    candidates: selected,
  }
}

export function summarizeManualWorklistOutcomes(document: ManualWorklistOutcomeDocument): ManualWorklistOutcomeSummary {
  const reasonsByFrequency: Record<string, number> = {}
  const statusByPublicationId: Record<string, ManualWorklistStatus> = {}
  for (const outcome of document.outcomes) {
    statusByPublicationId[outcome.publicationId] = outcome.status
    reasonsByFrequency[outcome.manualResolutionReason] = (reasonsByFrequency[outcome.manualResolutionReason] || 0) + 1
  }

  return {
    generatedAt: document.generatedAt,
    queueName: document.queueName,
    totals: {
      totalOutcomes: document.outcomes.length,
      manualReadyToReplace: document.outcomes.filter(outcome => outcome.status === 'manual_ready_to_replace').length,
      manualTerminalized: document.outcomes.filter(outcome => outcome.status === 'manual_terminalized').length,
      manualInProgress: document.outcomes.filter(outcome => outcome.status === 'manual_in_progress').length,
      manualDeferred: document.outcomes.filter(outcome => outcome.status === 'manual_deferred').length,
    },
    reasonsByFrequency,
    statusByPublicationId,
  }
}
