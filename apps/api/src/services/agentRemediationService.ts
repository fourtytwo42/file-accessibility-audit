import { createHash } from 'node:crypto'
import type { AnalysisResult } from './pdfAnalyzer.js'
import type {
  AppliedChange,
  DocumentModel,
  FailureProfile,
  ModelReviewFlag,
  PdfClassification,
  PipelineConfig,
  PlaybookEntry,
  PlaybookRun,
  ReconstructionOutput,
  RemediationActionRecord,
  RemediationIteration,
  RemediationToolCall,
  RemediationToolName,
  ResidualFamilyDecision,
  SemanticStrategy,
  SuggestedChange,
  VeraPdfSummary,
} from './documentModel.js'
import { average } from './documentModel.js'
import { analyzePDF } from './pdfAnalyzer.js'
import {
  buildRemediationContextFromSnapshot,
  executeRemediationTool,
  inspectPdfForRemediation,
  mergeManualReviewFlags,
  needsAltTextDeepInspection,
  toAppliedChange,
  toSuggestedChange,
  type PdfRemediationContext,
  type RemediationInspectMode,
  type RemediationInspectionCache,
} from './pdfRemediationTools.js'
import type { PdfjsResult } from './pdfjsService.js'
import type { QpdfResult } from './qpdfService.js'
import type { StructureBackendMutationResult } from './pdfStructureBackend.js'
import { buildFailureProfileArtifacts } from './failureProfileService.js'
import { planRemediationActions, TOOL_STAGE_ORDER } from './remediationPlanService.js'
import { bookmarkTargets, generateSemanticRepairBatches, hasSemanticRepairConfig, type SemanticBatchResult } from './semanticEnrichmentService.js'
import { isOcrAvailable, ocrPdfToSearchablePdf } from './ocrService.js'
import {
  runPdfStructureBackendBatch,
  type StructureBackendMutationRequest,
  type StructureBackendOperationResult,
} from './pdfStructureBackend.js'
import { REMEDIATION } from '#config'
import { classifyPdf, recordToolOutcomes, type PdfClass } from './toolReliabilityService.js'
import { recordFamilyOutcomes } from './familyOutcomeService.js'
import { buildPipelineConfig, classifyPdfFull, RECLASSIFICATION_TRIGGER_TOOLS } from './pdfClassificationService.js'
import {
  buildFailureSignature,
  createPlaybookRun,
  finalizePlaybookRun,
  findUsablePlaybookBySignatureHash,
  learnFromSuccessfulRemediation,
} from './playbookService.js'
import { deriveDeterministicCall, heuristicFigureAltText } from './remediationCallDerivationService.js'
import { ensureDisplayDocTitle } from './pdfOutputFinalizer.js'
import { evaluatePromotionGate } from './promotionGate.js'
import { loadAltTextSidecar, planAltTextSidecarDirectives, syncAltTextSidecar } from './altTextSidecarService.js'
import { draftFigureAltText } from './altTextDraftingService.js'
import { consumeOpenAiCompatAttemptRecords } from './openAiCompatService.js'
import {
  evaluateActionPostconditions,
  findSingleBlockingResidualFamilyConvergenceTarget,
  semanticSidecarEligibleFamilies,
} from './residualFamilyService.js'

function summarizeVeraPdf(result: AnalysisResult): VeraPdfSummary | null {
  const summary = result.verapdf
  if (!summary) return null
  return {
    status: summary.status,
    profile: summary.profile,
    flavour: summary.flavour,
    failedChecks: summary.failedChecks,
    passedChecks: summary.passedChecks,
    topFailures: summary.failures.slice(0, 3).map(failure => failure.message),
  }
}

async function analyzeIntermediatePdf(
  buffer: Buffer,
  filename: string,
  baselineResult: AnalysisResult,
  options?: {
    signal?: AbortSignal
    forceStructureForScoring?: boolean
    preferDeepStructureInspect?: boolean
  },
): Promise<AnalysisResult> {
  return analyzePDF(buffer, filename, {
    analysisProfile: 'remediation_fast',
    signal: options?.signal,
    skipAdobe: true,
    inheritedVeraPdf: baselineResult.verapdf,
    forceStructureForScoring: options?.forceStructureForScoring,
    preferDeepStructureInspect: options?.preferDeepStructureInspect,
  })
}

const NATIVE_TAGGED_RISKY_TOOLS = new Set<string>([
  'repair_structure_conformance',
  'repair_native_reading_order',
  'repair_native_figure_semantics',
  'repair_native_table_headers',
])

const EMPTY_REMEDIATION_CONTEXT: PdfRemediationContext = {
  analysis: {} as AnalysisResult,
  pdfjs: {} as PdfjsResult,
  qpdf: {} as QpdfResult,
  headingCandidates: [],
  figureCandidates: [],
  tableCandidates: [],
  linkCandidates: [],
  pages: [],
  readingOrderCandidates: [],
  readingOrderParentCandidates: [],
  structure: {} as StructureBackendMutationResult,
}

const STAGE_BATCHABLE_TOOLS = new Set<RemediationToolCall['tool_name']>([
  'bootstrap_struct_tree',
  'repair_malformed_bdc_operators',
  'repair_note_tag_ids',
  'repair_native_marked_content_refs',
  'repair_bootstrapped_chart_content_refs',
  'repair_structure_conformance',
  'repair_native_link_structure',
  'set_link_annotation_contents',
  'normalize_annotation_tab_order',
  'repair_annotation_alt_text',
  'set_tabs_all_annotated_pages',
])

const DEEP_DIRTY_TOOLS = new Set<string>([
  'bootstrap_struct_tree',
  'repair_structure_conformance',
  'repair_native_marked_content_refs',
  'repair_bootstrapped_chart_content_refs',
  'repair_native_figure_semantics',
  'set_figure_alt_text',
  'mark_figure_decorative',
  'normalize_nested_figure_containers',
  'repair_annotation_alt_text',
  'repair_native_link_structure',
  'normalize_annotation_tab_order',
  'set_tabs_all_annotated_pages',
  'set_table_header_cells',
  'create_heading_from_candidate',
])

const DEEP_STRUCTURE_SCORING_TOOLS = new Set<string>([
  'repair_structure_conformance',
  'bootstrap_struct_tree',
  'artifact_nonsemantic_page_elements',
  'repair_bootstrapped_chart_content_refs',
  'repair_native_marked_content_refs',
  'set_figure_alt_text',
  'retag_as_figure_and_set_alt',
  'mark_figure_decorative',
  'repair_native_figure_semantics',
  'repair_other_elements_alt_text',
  'normalize_heading_hierarchy',
  'normalize_nested_figure_containers',
])

const LONG_REPORT_STRUCTURE_CONVERGENCE_TOOLS = new Set<string>([
  'bootstrap_struct_tree',
  'artifact_nonsemantic_page_elements',
  'repair_bootstrapped_chart_content_refs',
  'repair_native_marked_content_refs',
  'normalize_heading_hierarchy',
  'repair_structure_conformance',
])

const CANDIDATE_SENSITIVE_TOOLS = new Set<string>([
  'create_heading_from_candidate',
  'set_table_header_cells',
  'set_figure_alt_text',
  'retag_as_figure_and_set_alt',
  'mark_figure_decorative',
  'reorder_structure_children',
  'set_link_annotation_contents',
])

const METADATA_ONLY_TOOLS = new Set<string>([
  'set_document_title',
  'set_document_language',
  'normalize_document_metadata',
])

type InspectionDirtinessState = {
  bufferSha256?: string
  lastInspectMode?: RemediationInspectMode
  structureDirty: boolean
  deepAltDirty: boolean
  semanticDirty: boolean
}

type RemediationTimingSummary = {
  totalMs: number
  intermediateAnalyses: number
  lightInspections: number
  deepInspections: number
  roundsExecuted: number
  stagesExecuted: number
}

type InspectionPhase = 'ownership_state' | 'figure_description_state' | 'structure_state'

type InspectionPhaseTracker = {
  lastSignature?: string
  stableRepeats: number
  downgradedToLight: boolean
  freshDeepInspections: number
  reusedInspections: number
  lateConverged: boolean
  focusedRescueRan?: boolean
  focusedRescueSkippedBecauseLateConverged?: boolean
  finalStopReason?: FigureDescriptionStopReason
  residualFinalStopReason?: ResidualCleanupStopReason
}

type PhaseProgressSnapshot = {
  phase: InspectionPhase
  signature: string
  blockingKeys: string[]
  unresolvedIssueLabels: string[]
  categoryScores: {
    altText: number | null
    pdfUa: number | null
    headingStructure: number | null
    readingOrder: number | null
    textExtractability: number | null
    tableMarkup: number | null
  }
  ownershipRiskCount: number
  informativeFigureMissingAltCount: number
  decorativeFigureCount: number
  structureOpportunityCount: number | null
}

type LatePhaseConvergenceTracker = {
  converged: boolean
  lastSnapshot: PhaseProgressSnapshot | null
  lastMutationChangedDocument: boolean
  lastProgressed: boolean | null
  noProgressPasses: number
}

type LateFigureSweepDecision = {
  allowed: boolean
  reason:
    | 'phase_converged'
    | 'alt_text_already_clean'
    | 'no_recent_mutation'
    | 'stable_no_progress'
    | 'no_candidates'
    | 'no_candidate_progress'
    | null
  snapshot: PhaseProgressSnapshot | null
  candidateCount: number
}

type FigureDescriptionStopReason =
  | 'no_mutation'
  | 'no_debt_reduction'
  | 'same_blocking_keys'
  | 'budget_exhausted'
  | 'completed'
  | 'figure_tail_plateau'

type FigureRescueMethod = 'native_semantics' | 'authoritative_alt' | 'heuristic_candidates'
type SpecializedTailMode = 'figure_tail' | 'font_tail' | 'annotation_table_tail' | 'figure_structure_tail' | 'none'

type ResidualCleanupFamilyBucket = 'structure' | 'figure' | 'mixed' | 'unknown'

type ResidualCleanupFamilyPressure = 'structure_primary' | 'figure_primary' | 'irreducibly_mixed' | 'single_family' | 'unknown'

type ResidualCleanupStopReason =
  | 'same_family_no_progress'
  | 'no_mutation'
  | 'family_shifted'
  | 'budget_exhausted'
  | 'completed'
  | 'structure_debt_cleared_figure_debt_remaining'
  | 'figure_debt_cleared_structure_debt_remaining'
  | 'mixed_figure_structure_separation_required'
  | 'mixed_runtime_churn_without_family_shrink'
  | 'mixed_large_runtime_profile_requires_serial_terminalization'
  | 'tail_signature_plateau_after_specialized_rescue'
  | 'font_tail_plateau'
  | 'figure_tail_plateau'
  | 'annotation_table_tail_plateau'

type ResidualCleanupProgressSnapshot = {
  bucket: ResidualCleanupFamilyBucket
  pressure: ResidualCleanupFamilyPressure
  signature: string
  structureBlockingKeys: string[]
  structureUnresolvedIssueLabels: string[]
  structureCategoryScores: {
    pdfUa: number | null
    headingStructure: number | null
    readingOrder: number | null
    textExtractability: number | null
  }
  structureOpportunityCount: number | null
  figureBlockingKeys: string[]
  figureUnresolvedIssueLabels: string[]
  informativeFigureMissingAltCount: number
}

type ResidualCleanupTracker = {
  lastFamilyId?: ResidualFamilyDecision['id'] | null
  lastBucket: ResidualCleanupFamilyBucket
  lastSnapshot: ResidualCleanupProgressSnapshot | null
  lastMutationChangedDocument: boolean
  lastProgressed: boolean | null
  convergedBuckets: Record<'structure' | 'figure' | 'mixed', boolean>
}

type LightVerificationLoopState = {
  lastSignature?: string
  lastMutationChangedDocument: boolean
}

type RemediationMetricsState = {
  inspections: {
    lightFresh: number
    lightReused: number
    deepFresh: number
    deepReused: number
    deepDowngradedToLight: number
  }
  phases: Record<InspectionPhase, InspectionPhaseTracker>
  ownershipRiskInitial: number | null
  figureMissingAltInitial: number | null
  decorativeFigureInitial: number | null
  structureDeepFreshAnalyses: number
  structureDeepAnalysesDowngraded: number
  residualCleanup: {
    dominantFamily: ResidualCleanupFamilyBucket
    finalStopReason?: ResidualCleanupStopReason
  }
  providerRouting: {
    byEndpointLabel: Record<string, number>
    byService: Record<string, number>
    livenessBypassCount: number
  }
  runtimeSummary?: {
    lightInspectionCount: number
    deepInspectionCount: number
    semanticCallCount: number
    providerCallCount: number
    focusedRescuePassCount?: number
    mixedRuntimeGovernorFired?: boolean
    compactFinalRescueFallback?: boolean
    authoritativeFinalScoringReached?: boolean
    specializedTailMode?: SpecializedTailMode
    specializedTailAttempted?: boolean
    specializedTailImproved?: boolean
  }
}

type StageAcceptanceDecision = {
  accept: boolean
  reason: string | null
  standardsImproved: boolean
  worstTargetedRegression: number
}

function createInspectionPhaseTracker(): InspectionPhaseTracker {
  return {
    stableRepeats: 0,
    downgradedToLight: false,
    freshDeepInspections: 0,
    reusedInspections: 0,
    lateConverged: false,
  }
}

function createLatePhaseConvergenceTracker(): LatePhaseConvergenceTracker {
  return {
    converged: false,
    lastSnapshot: null,
    lastMutationChangedDocument: false,
    lastProgressed: null,
    noProgressPasses: 0,
  }
}

function createResidualCleanupTracker(): ResidualCleanupTracker {
  return {
    lastBucket: 'unknown',
    lastSnapshot: null,
    lastMutationChangedDocument: true,
    lastProgressed: null,
    convergedBuckets: {
      structure: false,
      figure: false,
      mixed: false,
    },
  }
}

function getBufferSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function actionHasMeaningfulProgress(action: RemediationActionRecord): boolean {
  if (action.postconditionStatus === 'satisfied') return true
  return (action.scoreDelta || []).some(delta =>
    typeof delta.before === 'number'
    && typeof delta.after === 'number'
    && (delta.after - delta.before) >= REMEDIATION.MIN_SCORE_IMPROVEMENT_TO_CONTINUE,
  )
}

function markInspectionDirtyFromAction(state: InspectionDirtinessState, action: RemediationActionRecord): void {
  if (!action.changedDocumentBytes || action.outcome === 'rejected') return
  state.semanticDirty = true
  if (METADATA_ONLY_TOOLS.has(action.tool)) return
  state.structureDirty = true
  if (DEEP_DIRTY_TOOLS.has(action.tool)) {
    state.deepAltDirty = true
  }
}

function actionHistoryKeys(action: Pick<RemediationActionRecord, 'tool' | 'candidateGroupId' | 'candidateId' | 'target' | 'targetRef' | 'generationSource'>): string[] {
  const keys = [`${action.tool}:${action.candidateGroupId || action.candidateId || action.target}`]
  if (action.targetRef) {
    keys.push(`${action.tool}_target:${action.targetRef}`)
  }
  if (action.generationSource === 'heuristic_fallback') {
    keys.push(`heuristic_fallback:${action.candidateGroupId || action.candidateId || action.target}`)
    if (action.targetRef) {
      keys.push(`heuristic_fallback_target:${action.targetRef}`)
    }
  }
  return keys
}

function applyMetadataCallHints(
  calls: RemediationToolCall[],
  actions: RemediationActionRecord[],
  current: { title: string; language: string },
): { title: string; language: string } {
  let title = current.title
  let language = current.language

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    const action = actions[index]
    if (!call || !action || action.outcome === 'rejected') continue
    if ((call.tool_name === 'set_document_title' || call.tool_name === 'normalize_document_metadata') && typeof call.arguments?.title === 'string' && call.arguments.title.trim()) {
      title = call.arguments.title.trim()
    }
    if ((call.tool_name === 'set_document_language' || call.tool_name === 'normalize_document_metadata') && typeof call.arguments?.language === 'string' && call.arguments.language.trim()) {
      language = call.arguments.language.trim()
    }
  }

  return { title, language }
}

function normalizeStageBatchHeadingText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function looksLikeStageBatchProseHeadingText(text: string): boolean {
  const normalized = normalizeStageBatchHeadingText(text)
  if (!normalized) return true
  if (normalized.length < 3 || normalized.length > 120) return true
  if (normalized.endsWith('.')) return true
  const words = normalized.match(/\b[\p{L}\p{N}&/-]+\b/gu) || []
  if (words.length > 12) return true
  const sentencePunctuationCount = (normalized.match(/[.;!?]/g) || []).length
  if (sentencePunctuationCount > 0 && words.length > 6) return true
  if (/,/.test(normalized) && words.length > 7) return true
  if (/[()]/.test(normalized) && words.length > 9) return true
  if (/\b(and|or|but|because|while|although|since|were|was|are|have|has)\b/i.test(normalized) && words.length > 8) return true

  const significantWords = words.filter(word => /[A-Za-z]/.test(word))
  const lowercaseWords = significantWords.filter(word => /^[a-z]/.test(word))
  const uppercaseWords = significantWords.filter(word => /^[A-Z0-9]/.test(word) || word === word.toUpperCase())
  return significantWords.length >= 6 && lowercaseWords.length > uppercaseWords.length
}

function stageBatchBootstrapFigureAltText(candidate: PdfRemediationContext['figureCandidates'][number]): string {
  return draftFigureAltText({
    pageNumber: candidate.pageNumber,
    surroundingText: candidate.surroundingText,
    decorative: candidate.informativeHint === 'decorative',
  })
}

function batchActionCategoryTargets(tool: RemediationToolCall['tool_name']): string[] {
  switch (tool) {
    case 'bootstrap_struct_tree':
      return ['text_extractability', 'heading_structure', 'alt_text', 'reading_order']
    case 'repair_malformed_bdc_operators':
      return ['text_extractability', 'pdf_ua_compliance']
    case 'repair_note_tag_ids':
      return ['reading_order']
    case 'repair_native_marked_content_refs':
      return ['text_extractability', 'reading_order']
    case 'repair_bootstrapped_chart_content_refs':
      return ['text_extractability', 'link_quality', 'reading_order']
    case 'repair_structure_conformance':
      return ['text_extractability', 'heading_structure', 'alt_text', 'link_quality', 'reading_order']
    case 'repair_native_link_structure':
      return ['link_quality', 'reading_order']
    case 'normalize_annotation_tab_order':
      return ['link_quality', 'reading_order']
    case 'repair_annotation_alt_text':
      return ['alt_text', 'link_quality', 'reading_order']
    case 'set_tabs_all_annotated_pages':
      return ['link_quality', 'reading_order']
    default:
      return []
  }
}

function batchActionDetails(
  tool: RemediationToolCall['tool_name'],
  appliedMutations: Array<{ details: string }>,
  warnings: string[],
  fallbackDetails: string,
): string {
  const mutationDetails = appliedMutations.map(mutation => mutation.details).filter(Boolean)
  if (mutationDetails.length) return mutationDetails.join(' ')
  if (warnings.length) return warnings[0] || fallbackDetails
  switch (tool) {
    case 'bootstrap_struct_tree':
      return 'Bootstrapped the structure tree with heading and figure seeds.'
    case 'repair_malformed_bdc_operators':
      return 'Repaired malformed BDC operators.'
    case 'repair_note_tag_ids':
      return 'Repaired missing Note tag IDs.'
    case 'repair_native_marked_content_refs':
      return 'Repaired native marked-content references.'
    case 'repair_bootstrapped_chart_content_refs':
      return 'Repaired bootstrapped chart content references.'
    case 'repair_structure_conformance':
      return 'Repaired structure conformance issues.'
    case 'repair_native_link_structure':
      return 'Repaired native link structure.'
    case 'normalize_annotation_tab_order':
      return 'Normalized annotation tab order.'
    case 'repair_annotation_alt_text':
      return 'Repaired annotation alternate text.'
    case 'set_tabs_all_annotated_pages':
      return 'Set /Tabs /S on all annotated pages.'
    default:
      return fallbackDetails
  }
}

function requiresDeepStructureScoring(actions: Array<Pick<RemediationActionRecord, 'tool' | 'categoryTargets'>>): boolean {
  return actions.some(action =>
    DEEP_STRUCTURE_SCORING_TOOLS.has(action.tool),
  )
}

function requiresDeepStructureInspect(actions: Array<Pick<RemediationActionRecord, 'tool'>>): boolean {
  return actions.some(action =>
    action.tool === 'repair_structure_conformance'
    || action.tool === 'artifact_nonsemantic_page_elements'
    || action.tool === 'repair_bootstrapped_chart_content_refs'
    || action.tool === 'repair_native_marked_content_refs',
  )
}

function requiresLongReportStructureInspect(
  actions: Array<Pick<RemediationActionRecord, 'tool'>>,
  baselineResult: AnalysisResult,
): boolean {
  return baselineResult.pageCount >= 20
    && actions.some(action => LONG_REPORT_STRUCTURE_CONVERGENCE_TOOLS.has(action.tool))
}

function hasDeterministicAcrobatOwnershipRisk(context: Awaited<ReturnType<typeof inspectPdfForRemediation>> | null): boolean {
  return (context?.structure?.acrobatAltRiskNodes || []).some(node => {
    const unresolved = ['duplicate_mcid_ownership', 'container_with_graphics_descendants', 'graphics_only_nonfigure', 'untagged_image_mcid', 'untagged_image_direct'].includes(node.ownershipMode || '')
      || (node.ownershipMode === 'mixed_text_graphics_same_mcid' && !!node.splitSafe)
      || (node.ownershipMode === 'orphaned_alt_empty_element' && !!node.hasAlt)
      || (node.ownershipMode === 'nonfigure_with_alt' && !!node.hasAlt)
    return unresolved
  })
}

function buildBatchMutationForCall(
  call: RemediationToolCall,
  context: Awaited<ReturnType<typeof inspectPdfForRemediation>>,
): StructureBackendMutationRequest | null {
  switch (call.tool_name) {
    case 'bootstrap_struct_tree': {
      const headingCandidates = context.headingCandidates.length
        ? context.headingCandidates
        : context.pages.flatMap(page => {
            const fontSizes = page.textLines.map(line => line.fontSize).sort((a, b) => a - b)
            const medianFont = fontSizes.length ? fontSizes[Math.floor(fontSizes.length / 2)] : 12
            return page.textLines
              .filter(line =>
                normalizeStageBatchHeadingText(line.text).length >= 3
                && normalizeStageBatchHeadingText(line.text).length <= 140
                && !/^(https?:\/\/|www\.)/i.test(normalizeStageBatchHeadingText(line.text))
                && !normalizeStageBatchHeadingText(line.text).startsWith('â€¢')
                && !looksLikeStageBatchProseHeadingText(normalizeStageBatchHeadingText(line.text))
                && (line.fontWeight === 'bold' || line.fontSize >= medianFont + 1),
              )
              .slice(0, page.pageNumber === 1 ? 3 : 2)
              .map(line => ({
                pageNumber: page.pageNumber,
                text: normalizeStageBatchHeadingText(line.text),
              }))
          })
      const selectedHeadingCandidates = headingCandidates.slice(0, 6)
      const headingLevels = selectedHeadingCandidates.map((candidate, index) => (candidate.pageNumber === 1 && index === 0) ? 'H1' : 'H2')
      const headings = selectedHeadingCandidates.map((candidate, index) => ({
        text: candidate.text,
        level: headingLevels[index] || 'H2',
        pageNumber: candidate.pageNumber,
      }))
      const figures = context.figureCandidates
        .filter(candidate =>
          candidate.pageImageCount > 0
          && candidate.targetTag !== '/Figure'
          && candidate.informativeHint !== 'decorative'
          && Number.isFinite(candidate.pageNumber),
        )
        .slice(0, 24)
        .map(candidate => ({
          pageNumber: candidate.pageNumber,
          altText: stageBatchBootstrapFigureAltText(candidate),
        }))
      return {
        operation: 'bootstrap_struct_tree',
        headings,
        figures,
      }
    }
    case 'repair_malformed_bdc_operators':
    case 'repair_note_tag_ids':
    case 'repair_native_marked_content_refs':
    case 'repair_bootstrapped_chart_content_refs':
    case 'repair_structure_conformance':
    case 'repair_native_link_structure':
    case 'normalize_annotation_tab_order':
    case 'repair_annotation_alt_text':
    case 'set_tabs_all_annotated_pages':
      return { operation: call.tool_name }
    case 'set_link_annotation_contents': {
      const candidateId = typeof call.arguments?.candidateId === 'string' ? call.arguments.candidateId : null
      const candidate = candidateId
        ? context.linkCandidates.find(entry => entry.id === candidateId)
        : null
      const pageNumber = Number(call.arguments?.pageNumber ?? candidate?.pageNumber)
      const annotationIndex = Number(call.arguments?.annotationIndex ?? candidate?.annotationIndex)
      const contents = typeof call.arguments?.contents === 'string'
        ? call.arguments.contents.trim()
        : ''
      if (!Number.isFinite(pageNumber) || pageNumber < 1 || !Number.isFinite(annotationIndex) || annotationIndex < 0 || !contents) {
        return null
      }
      return {
        operation: 'set_link_annotation_contents',
        pageNumber,
        annotationIndex,
        contents,
      }
    }
    default:
      return null
  }
}

function toBatchActionRecord(input: {
  call: RemediationToolCall
  operationResult: StructureBackendOperationResult | undefined
}): {
  action: RemediationActionRecord
  manualReviewFlags: ModelReviewFlag[]
} {
  const args = input.call.arguments || {}
  const target = typeof args.target === 'string'
    ? args.target
    : typeof args.pageNumber === 'number'
      ? `page ${args.pageNumber}`
      : 'document'
  const baseAction = {
    tool: input.call.tool_name,
    target,
    candidateId: typeof args.candidateId === 'string' ? args.candidateId : undefined,
    candidateGroupId: typeof args.candidateGroupId === 'string' ? args.candidateGroupId : undefined,
    details: input.call.rationale || `${input.call.tool_name} executed.`,
    confidence: Math.max(0, Math.min(1, Number(input.call.confidence) || 0.5)),
    autoApplied: true,
    changedVisibleContent: false,
    generationSource: args.generationSource === 'semantic_ai' || args.generationSource === 'heuristic_fallback' || args.generationSource === 'manual_deferred'
      ? args.generationSource
      : undefined,
    categoryTargets: batchActionCategoryTargets(input.call.tool_name),
    changedDocumentBytes: false,
    familyId: input.call.familyId,
    familyStep: input.call.familyStep,
    expectedPostconditions: input.call.expectedPostconditions,
  } satisfies Omit<RemediationActionRecord, 'outcome'>

  const status: 'applied' | 'no_effect' | 'unsupported' | 'failed' =
    input.operationResult?.status === 'applied' || input.operationResult?.status === 'no_effect' || input.operationResult?.status === 'unsupported'
      ? input.operationResult.status
      : 'failed'
  const warnings = Array.from(new Set((input.operationResult?.warnings || []).map(warning => warning.trim()).filter(Boolean)))
  const details = batchActionDetails(
    input.call.tool_name,
    input.operationResult?.appliedMutations || [],
    warnings,
    baseAction.details,
  )
  const before = (input.operationResult?.appliedMutations || []).map(entry => `${entry.ref}:${entry.before || ''}`).join(', ') || null
  const after = (input.operationResult?.appliedMutations || []).map(entry => `${entry.ref}:${entry.after || ''}`).join(', ') || null

  if (status === 'applied') {
    return {
      action: {
        ...baseAction,
        before,
        after,
        details,
        changedDocumentBytes: !!input.operationResult?.changedDocumentBytes,
        validationWarnings: warnings,
        outcome: 'applied',
      },
      manualReviewFlags: [],
    }
  }

  const outcome = status === 'no_effect' ? 'no_effect' : status === 'unsupported' ? 'unsupported' : 'failed'
  return {
    action: {
      ...baseAction,
      details,
      autoApplied: false,
      changedDocumentBytes: false,
      validationWarnings: warnings,
      outcome,
    },
    manualReviewFlags: warnings.map((warning, index) => ({
      code: `${baseAction.tool}_${outcome}_${index + 1}`,
      label: 'Manual review required',
      severity: 'warning',
      details: warning,
    })),
  }
}

function inferSourceType(originalResult: AnalysisResult): DocumentModel['sourceType'] {
  if (originalResult.isScanned) return 'flattened'
  const score = originalResult.categories.find(category => category.id === 'text_extractability')?.score
  return score === 100 ? 'native-text' : 'mixed'
}

function addFlag(flags: ModelReviewFlag[], next: ModelReviewFlag): ModelReviewFlag[] {
  return mergeManualReviewFlags(flags, [next])
}

function collectCategoryFlags(result: AnalysisResult, existing: ModelReviewFlag[]): ModelReviewFlag[] {
  let flags = [...existing]
  const category = (id: string) => result.categories.find(entry => entry.id === id)

  if (result.isScanned) {
    flags = addFlag(flags, {
      code: 'manual_rebuild_required',
      label: 'Manual reconstruction may be required',
      severity: 'critical',
      details: 'This PDF appears to be scanned or image-only. Automatic page reconstruction is disabled, so deeper repair may require manual remediation or future patch tools.',
    })
  }
  if (category('heading_structure')?.score !== null && (category('heading_structure')?.score || 0) < 100) {
    flags = addFlag(flags, {
      code: 'heading_semantics_manual_review',
      label: 'Heading structure requires manual review',
      severity: 'warning',
      details: 'Heading hierarchy or semantics still need manual review.',
    })
  }
  if (category('table_markup')?.score !== null && (category('table_markup')?.score || 0) < 100) {
    flags = addFlag(flags, {
      code: 'table_semantics_manual_review',
      label: 'Table semantics require manual review',
      severity: 'warning',
      details: 'Table header and structure issues remain unresolved.',
    })
  }
  if (category('link_quality')?.score !== null && (category('link_quality')?.score || 0) < 100) {
    flags = addFlag(flags, {
      code: 'link_text_manual_review',
      label: 'Link text requires manual review',
      severity: 'warning',
      details: 'Some links still need descriptive visible text or semantic review.',
    })
  }
  if (category('alt_text')?.score !== null && (category('alt_text')?.score || 0) < 100) {
    flags = addFlag(flags, {
      code: 'alt_text_manual_review',
      label: 'Image descriptions require manual review',
      severity: 'warning',
      details: 'Image alt text is still incomplete or missing.',
    })
  }
  if (category('bookmarks')?.score !== null && (category('bookmarks')?.score || 0) < 100) {
    flags = addFlag(flags, {
      code: 'bookmarks_manual_review',
      label: 'Bookmarks require manual review',
      severity: 'warning',
      details: 'Bookmarks remain missing or incomplete.',
    })
  }
  if (category('form_accessibility')?.score !== null && (category('form_accessibility')?.score || 0) < 100) {
    flags = addFlag(flags, {
      code: 'form_labels_manual_review',
      label: 'Form labels require manual review',
      severity: 'warning',
      details: 'Form fields still need accessible labels or tooltips.',
    })
  }
  if (category('reading_order')?.score !== null && (category('reading_order')?.score || 0) < 100) {
    flags = addFlag(flags, {
      code: 'reading_order_manual_review',
      label: 'Reading order requires manual review',
      severity: 'warning',
      details: 'Reading order issues remain unresolved.',
    })
  }
  if (category('title_language')?.score !== null && (category('title_language')?.score || 0) < 100) {
    flags = addFlag(flags, {
      code: 'metadata_manual_review',
      label: 'Metadata requires manual review',
      severity: 'warning',
      details: 'Title or language metadata still needs manual confirmation.',
    })
  }
  return flags
}

function confidenceSummary(actions: RemediationActionRecord[]) {
  const confidences = actions.length
    ? actions.map(action => Math.round(action.confidence * 100))
    : [60]
  const overall = average(confidences)
  return {
    overall,
    textRecovery: overall,
    structureRecovery: overall,
    tableRecovery: overall,
    visualFidelity: 100,
  }
}

function unresolvedIssues(result: AnalysisResult): string[] {
  return result.categories
    .filter(category => typeof category.score === 'number' && category.score < 100)
    .map(category => category.label)
}

function blockingLocalFindingKeys(result: AnalysisResult): string[] {
  return (result.localStandards?.findings ?? [])
    .filter(finding => finding.blocking)
    .map(finding => finding.key)
    .sort((left, right) => left.localeCompare(right))
}

function hasBlockingLocalFinding(result: AnalysisResult, key: string): boolean {
  return blockingLocalFindingKeys(result).includes(key)
}

function hasUnresolvedCategoryLabel(result: AnalysisResult, label: string): boolean {
  return unresolvedIssues(result).includes(label)
}

function informativeFigureMissingAltCount(context: PdfRemediationContext | null | undefined): number {
  return (context?.figureCandidates || []).filter(candidate =>
    candidate.informativeHint !== 'decorative'
    && !candidate.graphicsLikelyDecorative
    && !candidate.hasAlt,
  ).length
}

function decorativeFigureCount(context: PdfRemediationContext | null | undefined): number {
  return (context?.figureCandidates || []).filter(candidate =>
    candidate.informativeHint === 'decorative' || !!candidate.graphicsLikelyDecorative,
  ).length
}

function categoryScoreImproved(before: number | null | undefined, after: number | null | undefined): boolean {
  return typeof before === 'number' && typeof after === 'number' && after > before
}

function structureOpportunityCount(context: PdfRemediationContext | null | undefined): number | null {
  if (!context) return null
  const hasReadingOrderSurface = Array.isArray(context.readingOrderParentCandidates)
  const hasHeadingSurface = Array.isArray(context.headingCandidates)
  if (!hasReadingOrderSurface && !hasHeadingSurface) return null
  const mutableReadingOrderGroups = (context.readingOrderParentCandidates || []).filter(candidate =>
    candidate.mutableKids && candidate.suggestedChildCandidateIds.length > 1,
  ).length
  const safeHeadingCandidates = (context.headingCandidates || []).filter(candidate =>
    candidate.repairMode === 'safe',
  ).length
  return mutableReadingOrderGroups + safeHeadingCandidates
}

function ownershipStateSignature(
  result: AnalysisResult,
  context: PdfRemediationContext | null | undefined,
): string {
  const blockingKeys = blockingLocalFindingKeys(result).filter(key =>
    key === 'pdfua.untagged_rendered_images'
    || key === 'pdfua.nested_alt_text'
    || key === 'pdfua.figure_alt_or_artifact',
  )
  return JSON.stringify({
    blockingKeys,
    acrobatOwnershipRiskCount: acrobatOwnershipRiskCount(context ?? null),
  })
}

function figureDescriptionStateSignature(
  result: AnalysisResult,
  context: PdfRemediationContext | null | undefined,
): string {
  return JSON.stringify({
    altTextScore: scoreForCategory(result, 'alt_text'),
    pdfUaScore: scoreForCategory(result, 'pdf_ua_compliance'),
    blockingKeys: blockingLocalFindingKeys(result).filter(key =>
      key === 'pdfua.figure_alt_or_artifact'
      || key === 'pdfua.nested_alt_text'
      || key === 'pdfua.untagged_rendered_images',
    ),
    informativeFiguresMissingAlt: informativeFigureMissingAltCount(context),
    decorativeFigures: decorativeFigureCount(context),
  })
}

function structureStateSignature(result: AnalysisResult): string {
  return JSON.stringify({
    blockingKeys: blockingLocalFindingKeys(result).filter(key =>
      key === 'pdfua.logical_structure'
      || key === 'pdfua.heading_content_quality'
      || key === 'pdfua.table_regularity',
    ),
    unresolvedIssues: unresolvedIssues(result).filter(label =>
      label === 'Heading Structure'
      || label === 'Reading Order'
      || label === 'Table Markup'
      || label === 'PDF/UA Compliance',
    ),
    textExtractability: scoreForCategory(result, 'text_extractability'),
    pdfUaScore: scoreForCategory(result, 'pdf_ua_compliance'),
    headingStructureScore: scoreForCategory(result, 'heading_structure'),
    readingOrderScore: scoreForCategory(result, 'reading_order'),
    tableMarkupScore: scoreForCategory(result, 'table_markup'),
  })
}

function relevantBlockingKeysForPhase(
  phase: InspectionPhase,
  result: AnalysisResult,
): string[] {
  const blockingKeys = blockingLocalFindingKeys(result)
  switch (phase) {
    case 'ownership_state':
      return blockingKeys.filter(key =>
        key === 'pdfua.untagged_rendered_images'
        || key === 'pdfua.nested_alt_text'
        || key === 'pdfua.figure_alt_or_artifact',
      )
    case 'figure_description_state':
      return blockingKeys.filter(key =>
        key === 'pdfua.figure_alt_or_artifact'
        || key === 'pdfua.nested_alt_text'
        || key === 'pdfua.untagged_rendered_images',
      )
    case 'structure_state':
      return blockingKeys.filter(key =>
        key === 'pdfua.logical_structure'
        || key === 'pdfua.heading_content_quality'
        || key === 'pdfua.table_regularity',
      )
  }
}

function relevantUnresolvedIssueLabelsForPhase(
  phase: InspectionPhase,
  result: AnalysisResult,
): string[] {
  const unresolved = unresolvedIssues(result)
  switch (phase) {
    case 'ownership_state':
    case 'figure_description_state':
      return unresolved.filter(label =>
        label === 'Alt Text on Images'
        || label === 'PDF/UA Compliance',
      )
    case 'structure_state':
      return unresolved.filter(label =>
        label === 'Heading Structure'
        || label === 'Reading Order'
        || label === 'Table Markup'
        || label === 'PDF/UA Compliance',
      )
  }
}

function buildPhaseProgressSnapshot(
  phase: InspectionPhase,
  result: AnalysisResult,
  context: PdfRemediationContext | null | undefined,
): PhaseProgressSnapshot {
  return {
    phase,
    signature: phase === 'ownership_state'
      ? ownershipStateSignature(result, context)
      : phase === 'figure_description_state'
        ? figureDescriptionStateSignature(result, context)
        : structureStateSignature(result),
    blockingKeys: relevantBlockingKeysForPhase(phase, result),
    unresolvedIssueLabels: relevantUnresolvedIssueLabelsForPhase(phase, result),
    categoryScores: {
      altText: scoreForCategory(result, 'alt_text'),
      pdfUa: scoreForCategory(result, 'pdf_ua_compliance'),
      headingStructure: scoreForCategory(result, 'heading_structure'),
      readingOrder: scoreForCategory(result, 'reading_order'),
      textExtractability: scoreForCategory(result, 'text_extractability'),
      tableMarkup: scoreForCategory(result, 'table_markup'),
    },
    ownershipRiskCount: acrobatOwnershipRiskCount(context ?? null),
    informativeFigureMissingAltCount: informativeFigureMissingAltCount(context),
    decorativeFigureCount: decorativeFigureCount(context),
    structureOpportunityCount: structureOpportunityCount(context),
  }
}

function didLatePhaseProgressImprove(
  previous: PhaseProgressSnapshot,
  next: PhaseProgressSnapshot,
  changedDocumentBytes: boolean,
): boolean {
  if (!changedDocumentBytes) return false
  switch (previous.phase) {
    case 'ownership_state':
      return next.ownershipRiskCount < previous.ownershipRiskCount
        || next.blockingKeys.length < previous.blockingKeys.length
    case 'figure_description_state':
      return next.informativeFigureMissingAltCount < previous.informativeFigureMissingAltCount
        || next.blockingKeys.length < previous.blockingKeys.length
    case 'structure_state':
      return next.blockingKeys.length < previous.blockingKeys.length
        || categoryScoreImproved(previous.categoryScores.headingStructure, next.categoryScores.headingStructure)
        || categoryScoreImproved(previous.categoryScores.readingOrder, next.categoryScores.readingOrder)
        || categoryScoreImproved(previous.categoryScores.textExtractability, next.categoryScores.textExtractability)
        || categoryScoreImproved(previous.categoryScores.pdfUa, next.categoryScores.pdfUa)
        || categoryScoreImproved(previous.categoryScores.tableMarkup, next.categoryScores.tableMarkup)
        || next.unresolvedIssueLabels.length < previous.unresolvedIssueLabels.length
        || (
          typeof previous.structureOpportunityCount === 'number'
          && typeof next.structureOpportunityCount === 'number'
          && next.structureOpportunityCount < previous.structureOpportunityCount
        )
  }
}

export const __test_buildPhaseProgressSnapshot = buildPhaseProgressSnapshot
export const __test_didLatePhaseProgressImprove = didLatePhaseProgressImprove

function lightVerificationSignature(result: AnalysisResult): string {
  return JSON.stringify({
    blockingKeys: blockingLocalFindingKeys(result),
    unresolvedIssues: unresolvedIssues(result).sort((left, right) => left.localeCompare(right)),
    scores: {
      altText: scoreForCategory(result, 'alt_text'),
      pdfUa: scoreForCategory(result, 'pdf_ua_compliance'),
      headingStructure: scoreForCategory(result, 'heading_structure'),
      readingOrder: scoreForCategory(result, 'reading_order'),
      textExtractability: scoreForCategory(result, 'text_extractability'),
    },
  })
}

function shouldShortCircuitStableLightVerification(input: {
  state: LightVerificationLoopState
  nextSignature: string
}): boolean {
  return !input.state.lastMutationChangedDocument
    && !!input.state.lastSignature
    && input.state.lastSignature === input.nextSignature
}

export const __test_shouldShortCircuitStableLightVerification = shouldShortCircuitStableLightVerification

function remediationStateSignature(result: AnalysisResult): string {
  const categoryScores = (result.categories ?? [])
    .map(category => ({
      id: category.id,
      score: typeof category.score === 'number' ? category.score : null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  return JSON.stringify({
    overallScore: result.overallScore,
    grade: result.grade,
    isScanned: result.isScanned,
    unresolvedIssues: unresolvedIssues(result).sort((left, right) => left.localeCompare(right)),
    blockingLocalFindingKeys: blockingLocalFindingKeys(result),
    categoryScores,
  })
}

function remediationCoarseStateSignature(result: AnalysisResult): string {
  return JSON.stringify({
    grade: result.grade,
    isScanned: result.isScanned,
    unresolvedIssues: unresolvedIssues(result).sort((left, right) => left.localeCompare(right)),
    blockingLocalFindingKeys: blockingLocalFindingKeys(result),
  })
}

function residualBlockingSignature(result: AnalysisResult): string {
  const blockingKeys = blockingLocalFindingKeys(result)
  return blockingKeys.length ? [...blockingKeys].sort((left, right) => left.localeCompare(right)).join(' + ') : '(none)'
}

function residualBlockingFamilies(result: AnalysisResult): string[] {
  const families = new Set<string>()
  for (const key of blockingLocalFindingKeys(result)) {
    if (
      key === 'pdfua.logical_structure'
      || key === 'pdfua.heading_content_quality'
      || key === 'pdfua.reading_order'
    ) {
      families.add('structure')
    }
    if (
      key === 'pdfua.figure_alt_or_artifact'
      || key === 'pdfua.nested_alt_text'
      || key === 'pdfua.untagged_rendered_images'
    ) {
      families.add('figure')
    }
    if (
      key === 'pdfua.font_embedding'
      || key === 'pdfua.font_unicode'
      || key === 'pdfua.type1_unicode'
      || key === 'pdfua.truetype_encoding_differences'
      || key === 'pdfua.font_widths'
    ) {
      families.add('font')
    }
    if (key === 'pdfua.annotation_alt_contents' || key === 'pdfua.link_tagging') {
      families.add('annotation')
    }
    if (key === 'pdfua.table_regularity') {
      families.add('table')
    }
  }
  return [...families].sort((left, right) => left.localeCompare(right))
}

function specializedTailModeForResult(
  analysis: AnalysisResult,
  context: PdfRemediationContext | null | undefined,
): SpecializedTailMode {
  const signature = residualBlockingSignature(analysis)
  const families = residualBlockingFamilies(analysis)
  if (signature === 'pdfua.figure_alt_or_artifact + pdfua.logical_structure') return 'figure_structure_tail'
  if (
    signature === 'pdfua.annotation_alt_contents + pdfua.figure_alt_or_artifact'
    || signature === 'pdfua.figure_alt_or_artifact + pdfua.table_regularity'
    || (families.includes('figure') && (families.includes('annotation') || families.includes('table')))
  ) {
    return 'annotation_table_tail'
  }
  if (families.includes('font') && !families.includes('structure')) return 'font_tail'
  if (families.includes('figure')) return 'figure_tail'
  if (residualCleanupDominantFamily(analysis, context) === 'mixed') return 'figure_structure_tail'
  return 'none'
}

function isNearPassTailEligible(input: {
  analysis: AnalysisResult
  context: PdfRemediationContext | null | undefined
}): boolean {
  const blockingKeys = blockingLocalFindingKeys(input.analysis)
  const signature = residualBlockingSignature(input.analysis)
  if ((input.analysis.overallScore ?? 0) >= 70 && (input.analysis.overallScore ?? 0) <= 79) return true
  if (blockingKeys.length <= 2) return true
  return signature === 'pdfua.figure_alt_or_artifact'
    || signature === 'pdfua.font_embedding'
    || signature === 'pdfua.annotation_alt_contents + pdfua.figure_alt_or_artifact'
    || signature === 'pdfua.figure_alt_or_artifact + pdfua.logical_structure'
    || signature === 'pdfua.figure_alt_or_artifact + pdfua.table_regularity'
}

const MAX_STABLE_STATE_REPEATS = 2
const MAX_COARSE_STABLE_STATE_REPEATS = 1
const MAX_LIGHT_INSPECTIONS_PER_FILE = Number(process.env.ICJIA_MAX_LIGHT_INSPECTIONS || 8)
const MAX_DEEP_INSPECTIONS_PER_FILE = Number(process.env.ICJIA_MAX_DEEP_INSPECTIONS || 8)
const MAX_TOTAL_INSPECTIONS_PER_FILE = Number(process.env.ICJIA_MAX_TOTAL_INSPECTIONS || 14)
const MAX_POST_OWNERSHIP_FIGURE_REPAIRS = 8
// Large residual figure debt rarely converges with repeated deep rescue.
// Once we stop making measurable progress, fail honestly instead of re-spending
// the deep inspection budget on another broad rescue loop.
const MASS_UNRESOLVED_FIGURE_DEBT_THRESHOLD = 24

const OWNERSHIP_STATE_TOOLS = new Set<string>([
  'repair_other_elements_alt_text',
  'repair_native_figure_semantics',
  'normalize_nested_figure_containers',
  'repair_structure_conformance',
])

const FIGURE_DESCRIPTION_STATE_TOOLS = new Set<string>([
  'repair_other_elements_alt_text',
  'repair_native_figure_semantics',
  'normalize_nested_figure_containers',
  'set_figure_alt_text',
  'retag_as_figure_and_set_alt',
  'mark_figure_decorative',
])

const STRUCTURE_STATE_TOOLS = new Set<string>([
  'bootstrap_struct_tree',
  'artifact_nonsemantic_page_elements',
  'repair_native_marked_content_refs',
  'repair_bootstrapped_chart_content_refs',
  'normalize_heading_hierarchy',
  'create_heading_from_candidate',
  'repair_structure_conformance',
  'reorder_structure_children',
  'repair_native_reading_order',
])

function scoreForCategory(result: AnalysisResult, categoryId: string): number | null {
  if (!Array.isArray(result?.categories)) return null
  const category = result.categories.find(entry => entry.id === categoryId)
  return typeof category?.score === 'number' ? category.score : null
}

function isNativeTaggedSafeContext(context: Awaited<ReturnType<typeof inspectPdfForRemediation>>, result: AnalysisResult): boolean {
  return !result.isScanned
    && context.qpdf.hasStructTree
    && context.qpdf.structTreeDepth > 0
    && (context.structure.structuralNodes?.length || 0) > 0
}

function hasNativeStandardsRegression(previous: AnalysisResult, next: AnalysisResult, toolName: string): string | null {
  if (!NATIVE_TAGGED_RISKY_TOOLS.has(toolName)) return null
  const previousStatus = previous.verapdf?.status || 'failed'
  const nextStatus = next.verapdf?.status || 'failed'
  if (previousStatus === 'passed' && nextStatus !== 'passed') {
    return 'regressed veraPDF compliance status'
  }
  const previousFailedChecks = previous.verapdf?.failedChecks
  const nextFailedChecks = next.verapdf?.failedChecks
  if (typeof previousFailedChecks === 'number'
    && typeof nextFailedChecks === 'number'
    && nextFailedChecks > previousFailedChecks) {
    return `increased veraPDF failed checks from ${previousFailedChecks} to ${nextFailedChecks}`
  }
  return null
}

function shouldRejectNativeVisibleRewrite(
  previous: AnalysisResult,
  next: AnalysisResult,
  action: { changedVisibleContent?: boolean; tool: string },
): string | null {
  if (!action.changedVisibleContent) return null
  if (next.overallScore > previous.overallScore) return null
  return 'changed visible page content without improving the overall accessibility score'
}

function categoryRegression(previous: AnalysisResult, next: AnalysisResult, categoryId: string): boolean {
  const before = scoreForCategory(previous, categoryId)
  const after = scoreForCategory(next, categoryId)
  return before !== null && after !== null && after < before
}

function hasDeterministicRegression(previous: AnalysisResult, next: AnalysisResult): boolean {
  return next.overallScore < previous.overallScore
    || previous.categories.some(category => categoryRegression(previous, next, category.id))
}

function standardsValidationImproved(previous: AnalysisResult, next: AnalysisResult): boolean {
  if (next.overallScore > previous.overallScore) return true
  const previousStatus = previous.verapdf?.status || 'failed'
  const nextStatus = next.verapdf?.status || 'failed'
  if (previousStatus !== 'passed' && nextStatus === 'passed') return true
  const previousFailedChecks = previous.verapdf?.failedChecks
  const nextFailedChecks = next.verapdf?.failedChecks
  if (typeof previousFailedChecks === 'number'
    && typeof nextFailedChecks === 'number'
    && nextFailedChecks < previousFailedChecks) {
    return true
  }

  const previousLocalBlocking = previous.localStandards?.findings
    ?.filter(finding => finding.blocking)
    .reduce((sum, finding) => sum + Math.max(1, finding.count || 1), 0) ?? 0
  const nextLocalBlocking = next.localStandards?.findings
    ?.filter(finding => finding.blocking)
    .reduce((sum, finding) => sum + Math.max(1, finding.count || 1), 0) ?? 0
  if (nextLocalBlocking < previousLocalBlocking) return true

  const previousBlockingKeys = new Set(
    previous.localStandards?.findings
      ?.filter(finding => finding.blocking)
      .map(finding => finding.key) ?? [],
  )
  const nextBlockingKeys = new Set(
    next.localStandards?.findings
      ?.filter(finding => finding.blocking)
      .map(finding => finding.key) ?? [],
  )
  return [...previousBlockingKeys].some(key => !nextBlockingKeys.has(key))
}

function applyScoreDelta(action: RemediationActionRecord, previous: AnalysisResult, next: AnalysisResult): boolean {
  const targets = action.categoryTargets || []
  action.scoreDelta = targets.map(categoryId => ({
    categoryId,
    before: scoreForCategory(previous, categoryId),
    after: scoreForCategory(next, categoryId),
  }))
  const postconditions = evaluateActionPostconditions({
    action,
    previous,
    next,
  })
  action.familyId = action.familyId || postconditions.familyId
  action.postconditionStatus = postconditions.status
  action.postconditionSignals = postconditions.signals
  return action.scoreDelta.some(delta =>
    typeof delta.before === 'number'
    && typeof delta.after === 'number'
    && (delta.after - delta.before) >= 2,
  )
    || action.postconditionStatus === 'satisfied'
}

function actionScoreDelta(action: RemediationActionRecord, previous: AnalysisResult, next: AnalysisResult): Array<{ categoryId: string; before: number | null; after: number | null }> {
  if (!action.categoryTargets?.length) return []
  if (!action.scoreDelta?.length) {
    applyScoreDelta(action, previous, next)
  }
  return action.scoreDelta || []
}

function worstTargetedRegression(stageActions: RemediationActionRecord[], previous: AnalysisResult, next: AnalysisResult): number {
  const deltas = stageActions.flatMap(action => actionScoreDelta(action, previous, next))
  if (!deltas.length) return 0
  return deltas.reduce((worst, delta) => {
    const before = delta.before
    const after = delta.after
    if (before === null || after === null) return worst
    return Math.min(worst, after - before)
  }, 0)
}

function hasTargetedCategoryImprovement(previous: AnalysisResult, next: AnalysisResult, stageActions: RemediationActionRecord[]): boolean {
  const targetedCategories = [...new Set(stageActions.flatMap(action => action.categoryTargets || []))]
  return targetedCategories.some(categoryId => {
    const before = scoreForCategory(previous, categoryId)
    const after = scoreForCategory(next, categoryId)
    return typeof before === 'number' && typeof after === 'number' && after > before
  })
}

function hasLongReportStructureImprovement(previous: AnalysisResult, next: AnalysisResult, stageActions: RemediationActionRecord[]): boolean {
  const includesLongReportCleanupTool = stageActions.some(action =>
    action.tool === 'artifact_nonsemantic_page_elements'
    || action.tool === 'repair_bootstrapped_chart_content_refs'
    || action.tool === 'repair_native_marked_content_refs'
    || action.tool === 'repair_structure_conformance',
  )
  if (!includesLongReportCleanupTool) return false

  const structureCategories: Array<'heading_structure' | 'reading_order' | 'pdf_ua_compliance'> = [
    'heading_structure',
    'reading_order',
    'pdf_ua_compliance',
  ]
  const categoryImproved = structureCategories.some(categoryId => {
    const before = scoreForCategory(previous, categoryId)
    const after = scoreForCategory(next, categoryId)
    return typeof before === 'number' && typeof after === 'number' && after > before
  })
  if (categoryImproved) return true

  const previousLogicalStructureBlocking = previous.localStandards?.findings?.some(finding =>
    finding.blocking && finding.key === 'pdfua.logical_structure',
  ) ?? false
  const nextLogicalStructureBlocking = next.localStandards?.findings?.some(finding =>
    finding.blocking && finding.key === 'pdfua.logical_structure',
  ) ?? false
  return previousLogicalStructureBlocking && !nextLogicalStructureBlocking
}

function nativeStageRegressionReason(
  previous: AnalysisResult,
  next: AnalysisResult,
  stageActions: RemediationActionRecord[],
  options?: { includeOverallScoreRegression?: boolean },
): string | null {
  const structureConformanceSurfacedAcrobatOwnershipDebt =
    stageActions.some(action => action.tool === 'repair_structure_conformance' && action.outcome === 'applied')
    && (next.categories.find(category => category.id === 'alt_text')?.findings || []).some(finding =>
      /acrobat.risk|acrobat-risk|other-elements alternate text|graphics content is still owned by non-\/figure|acrobat-style|non-figure.*graphics|graphics.*non-figure/i.test(String(finding || '')),
    )

  if (options?.includeOverallScoreRegression && next.overallScore < previous.overallScore) {
    return `overall score regressed from ${previous.overallScore} to ${next.overallScore}`
  }

  const targetedCategories = [...new Set(stageActions.flatMap(action => action.categoryTargets || []))]
  const regressedCategory = targetedCategories.find(categoryId => categoryRegression(previous, next, categoryId))
  if (regressedCategory) {
    if (structureConformanceSurfacedAcrobatOwnershipDebt && regressedCategory === 'alt_text') {
      return null
    }
    const before = scoreForCategory(previous, regressedCategory)
    const after = scoreForCategory(next, regressedCategory)
    return `${regressedCategory} score regressed from ${before} to ${after}`
  }

  const standardsRegression = stageActions.find(action =>
    !!hasNativeStandardsRegression(previous, next, action.tool),
  )
  if (standardsRegression) {
    return hasNativeStandardsRegression(previous, next, standardsRegression.tool)
  }

  const visibleRegression = stageActions.find(action =>
    !!shouldRejectNativeVisibleRewrite(previous, next, action),
  )
  if (visibleRegression) {
    return shouldRejectNativeVisibleRewrite(previous, next, visibleRegression)
  }

  return null
}

export const __test_nativeStageRegressionReason = nativeStageRegressionReason

function evaluateStageAcceptance(previous: AnalysisResult, next: AnalysisResult, stageActions: RemediationActionRecord[]): StageAcceptanceDecision {
  const visibleRegression = stageActions.find(action =>
    !!shouldRejectNativeVisibleRewrite(previous, next, action),
  )
  if (visibleRegression) {
    return {
      accept: false,
      reason: shouldRejectNativeVisibleRewrite(previous, next, visibleRegression),
      standardsImproved: false,
      worstTargetedRegression: worstTargetedRegression(stageActions, previous, next),
    }
  }

  const standardsImproved = standardsValidationImproved(previous, next)
  const worstRegression = worstTargetedRegression(stageActions, previous, next)
  const targetedCategoryImproved = hasTargetedCategoryImprovement(previous, next, stageActions)
  const longReportStructureImproved = hasLongReportStructureImprovement(previous, next, stageActions)
  const structureConformanceActions = stageActions.filter(action =>
    action.tool === 'repair_structure_conformance' && action.outcome === 'applied',
  )
  const nonAltTargetedImprovement = hasTargetedCategoryImprovement(previous, next, stageActions.filter(action =>
    !(action.categoryTargets || []).includes('alt_text'),
  ))
  const structureConformanceSurfacedAcrobatOwnershipDebt =
    structureConformanceActions.length > 0
    && worstRegression < 0
    && (next.categories.find(category => category.id === 'alt_text')?.findings || []).some(finding =>
      /acrobat.risk|acrobat-risk|other-elements alternate text|graphics content is still owned by non-\/figure|acrobat-style|non-figure.*graphics|graphics.*non-figure/i.test(String(finding || '')),
    )
    && !nonAltTargetedImprovement
  if (worstRegression <= -REMEDIATION.NET_BENEFIT_MAX_CATEGORY_REGRESSION) {
    if (structureConformanceSurfacedAcrobatOwnershipDebt) {
      return {
        accept: true,
        reason: null,
        standardsImproved,
        worstTargetedRegression: worstRegression,
      }
    }
    return {
      accept: false,
      reason: `targeted category regressed by ${Math.abs(worstRegression)} points`,
      standardsImproved,
      worstTargetedRegression: worstRegression,
    }
  }
  if (next.overallScore > previous.overallScore || standardsImproved || targetedCategoryImproved || longReportStructureImproved) {
    return {
      accept: true,
      reason: null,
      standardsImproved,
      worstTargetedRegression: worstRegression,
    }
  }

  return {
    accept: false,
    reason: `overall score did not improve from ${previous.overallScore} to ${next.overallScore}`,
    standardsImproved,
    worstTargetedRegression: worstRegression,
  }
}

export const __test_evaluateStageAcceptance = evaluateStageAcceptance

function shouldRunLateFigureSweep(input: {
  tracker: LatePhaseConvergenceTracker
  analysis: AnalysisResult
  context: PdfRemediationContext | null | undefined
  candidateCount: number
}): LateFigureSweepDecision {
  if (input.tracker.converged) {
    return { allowed: false, reason: 'phase_converged', snapshot: input.tracker.lastSnapshot, candidateCount: input.candidateCount }
  }
  if ((scoreForCategory(input.analysis, 'alt_text') ?? 100) >= 100) {
    return { allowed: false, reason: 'alt_text_already_clean', snapshot: input.tracker.lastSnapshot, candidateCount: input.candidateCount }
  }
  const snapshot = buildPhaseProgressSnapshot('figure_description_state', input.analysis, input.context)
  if (input.candidateCount <= 0) {
    return { allowed: false, reason: 'no_candidates', snapshot, candidateCount: input.candidateCount }
  }
  if (input.tracker.lastSnapshot && !input.tracker.lastMutationChangedDocument) {
    return { allowed: false, reason: 'no_recent_mutation', snapshot, candidateCount: input.candidateCount }
  }
  if (input.tracker.lastProgressed === false && input.tracker.noProgressPasses > 0) {
    return { allowed: false, reason: 'stable_no_progress', snapshot, candidateCount: input.candidateCount }
  }
  if (input.tracker.lastSnapshot && snapshot.signature === input.tracker.lastSnapshot.signature && input.tracker.lastProgressed !== true) {
    return { allowed: false, reason: 'no_candidate_progress', snapshot, candidateCount: input.candidateCount }
  }
  return { allowed: true, reason: null, snapshot, candidateCount: input.candidateCount }
}

export const __test_shouldRunLateFigureSweep = shouldRunLateFigureSweep

function shouldUseFigureOnlyLateRescuePath(input: {
  analysis: AnalysisResult
  context: PdfRemediationContext | null | undefined
}): boolean {
  if (acrobatOwnershipRiskCount(input.context ?? null) > 0) return false
  const blockingKeys = blockingLocalFindingKeys(input.analysis)
  const structureBlockingKeys = blockingKeys.filter(key =>
    key === 'pdfua.logical_structure'
    || key === 'pdfua.heading_content_quality',
  )
  const figureBlockingKeys = blockingKeys.filter(key =>
    key === 'pdfua.figure_alt_or_artifact'
    || key === 'pdfua.nested_alt_text'
    || key === 'pdfua.untagged_rendered_images',
  )
  if (!figureBlockingKeys.length) return false
  if (figureBlockingKeys.length === blockingKeys.length) return true
  if (structureBlockingKeys.length > 0 && informativeFigureMissingAltCount(input.context) <= 0) {
    return false
  }
  const structureDebtCount =
    structureBlockingKeys.length
    + unresolvedIssues(input.analysis).filter(label =>
      label === 'Heading Structure'
      || label === 'Reading Order'
      || label === 'PDF/UA Compliance'
    ).length
  const figureDebtCount =
    figureBlockingKeys.length
    + unresolvedIssues(input.analysis).filter(label => label === 'Alt Text on Images').length
    + informativeFigureMissingAltCount(input.context)
  return figureDebtCount >= structureDebtCount
}

type FocusedFigureRescueStopDecision = {
  stop: boolean
  reason: FigureDescriptionStopReason | null
}

function shouldStopFocusedFigureRescue(input: {
  before: PhaseProgressSnapshot
  after: PhaseProgressSnapshot
  changedDocumentBytes: boolean
  noProgressMethods: Set<FigureRescueMethod>
  attemptedMethods: Set<FigureRescueMethod>
  largeResidualDebt: boolean
}): FocusedFigureRescueStopDecision {
  const figureCategoryImproved =
    categoryScoreImproved(input.before.categoryScores.altText, input.after.categoryScores.altText)
    || categoryScoreImproved(input.before.categoryScores.pdfUa, input.after.categoryScores.pdfUa)
  const figureIssueSurfaceImproved =
    input.after.unresolvedIssueLabels.length < input.before.unresolvedIssueLabels.length
    || input.after.blockingKeys.length < input.before.blockingKeys.length

  if (!input.changedDocumentBytes) {
    return {
      stop: true,
      reason: 'no_mutation',
    }
  }
  if (figureCategoryImproved || figureIssueSurfaceImproved) {
    return {
      stop: false,
      reason: null,
    }
  }
  if (input.after.informativeFigureMissingAltCount >= input.before.informativeFigureMissingAltCount) {
    const blockingKeysUnchanged = JSON.stringify([...input.after.blockingKeys].sort())
      === JSON.stringify([...input.before.blockingKeys].sort())
    if (blockingKeysUnchanged) {
      return {
        stop: true,
        reason: 'same_blocking_keys',
      }
    }
    return {
      stop: true,
      reason: 'no_debt_reduction',
    }
  }
  if (input.largeResidualDebt && [...input.attemptedMethods].some(method => input.noProgressMethods.has(method))) {
    return {
      stop: true,
      reason: 'no_debt_reduction',
    }
  }
  return {
    stop: false,
    reason: null,
  }
}

export const __test_shouldUseFigureOnlyLateRescuePath = shouldUseFigureOnlyLateRescuePath
export const __test_shouldStopFocusedFigureRescue = shouldStopFocusedFigureRescue

function isHeadingOnlyResidualState(
  analysis: AnalysisResult,
  context: PdfRemediationContext | null | undefined,
): boolean {
  const blockingKeys = blockingLocalFindingKeys(analysis)
  const unresolved = unresolvedIssues(analysis)
  const hasHeadingDebt =
    blockingKeys.includes('pdfua.heading_content_quality')
    || unresolved.includes('Heading Structure')
  const hasFigureDebt =
    blockingKeys.includes('pdfua.figure_alt_or_artifact')
    || blockingKeys.includes('pdfua.untagged_rendered_images')
    || blockingKeys.includes('pdfua.nested_alt_text')
    || unresolved.includes('Alt Text on Images')
    || informativeFigureMissingAltCount(context) > 0
  const hasNonHeadingStructureDebt =
    blockingKeys.includes('pdfua.logical_structure')
    || unresolved.includes('Reading Order')
    || blockingKeys.includes('pdfua.table_regularity')
    || unresolved.includes('Table Markup')
  return hasHeadingDebt && !hasFigureDebt && !hasNonHeadingStructureDebt
}

function shouldPreferLightFocusedRescueContext(input: {
  canAttemptAltRescue: boolean
  rescuePasses: number
  currentResult: AnalysisResult
  currentLightContext: PdfRemediationContext | null | undefined
  tracker: ResidualCleanupTracker
  timings: RemediationTimingSummary
}): boolean {
  if (!input.canAttemptAltRescue) return false
  const familyState = residualCleanupFamilyState(input.currentResult, input.currentLightContext)
  const mixedLikeState =
    familyState.bucket === 'mixed'
    || (familyState.bucket === 'figure' && familyState.pressure === 'figure_primary')
  if (!mixedLikeState) return false
  if (input.timings.deepInspections < 4) return false
  return input.rescuePasses > 0
    || (input.tracker.lastBucket === 'mixed' && input.tracker.lastMutationChangedDocument && input.tracker.lastProgressed === false)
}

function shouldUseCompactMixedFinalRescue(input: {
  analysis: AnalysisResult
  context: PdfRemediationContext | null | undefined
  timings: RemediationTimingSummary
}): boolean {
  const dominantFamily = residualCleanupDominantFamily(input.analysis, input.context)
  if (dominantFamily !== 'mixed') return false
  return (input.analysis.pageCount ?? 0) >= 40
    || input.timings.deepInspections >= 6
    || (input.timings.lightInspections + input.timings.deepInspections) >= 12
}

function isRuntimeHeavyMixedProfile(input: {
  analysis: AnalysisResult
  context: PdfRemediationContext | null | undefined
  timings: RemediationTimingSummary
  tracker: ResidualCleanupTracker
}): boolean {
  if (residualCleanupDominantFamily(input.analysis, input.context) !== 'mixed') return false
  const pageCount = input.analysis.pageCount ?? 0
  return pageCount >= 80
    || input.timings.deepInspections >= 4
    || (
      input.tracker.lastBucket === 'mixed'
      && input.tracker.lastMutationChangedDocument === true
      && input.tracker.lastProgressed === false
    )
}

function shouldUseNearPassFigureFastLane(input: {
  analysis: AnalysisResult
  context: PdfRemediationContext | null | undefined
}): boolean {
  const blockingKeys = blockingLocalFindingKeys(input.analysis)
  const unresolved = unresolvedIssues(input.analysis)
  const figureDominant = residualCleanupDominantFamily(input.analysis, input.context) === 'figure'
  const disallowedStructureDebt =
    blockingKeys.includes('pdfua.logical_structure')
    || unresolved.includes('Reading Order')
    || blockingKeys.includes('pdfua.table_regularity')
    || unresolved.includes('Table Markup')
  return figureDominant
    && (input.analysis.pageCount ?? 0) <= 12
    && (input.analysis.overallScore ?? 0) >= 80
    && !disallowedStructureDebt
}

function shouldTripMixedRuntimeGovernor(input: {
  analysis: AnalysisResult
  context: PdfRemediationContext | null | undefined
  timings: RemediationTimingSummary
  rescuePasses: number
  mixedNoShrinkPasses: number
  tracker: ResidualCleanupTracker
}): boolean {
  if (residualCleanupDominantFamily(input.analysis, input.context) !== 'mixed') return false
  if (!isRuntimeHeavyMixedProfile(input)) return false
  if (input.timings.deepInspections < 6) return false
  if (input.mixedNoShrinkPasses >= 2) return true
  return input.rescuePasses > 1
    && input.tracker.lastBucket === 'mixed'
    && input.tracker.lastMutationChangedDocument === true
    && input.tracker.lastProgressed === false
}

function shouldSerialTerminalizeLargeMixedProfile(input: {
  analysis: AnalysisResult
  context: PdfRemediationContext | null | undefined
  timings: RemediationTimingSummary
  rescuePasses: number
  mixedNoShrinkPasses: number
  tracker: ResidualCleanupTracker
}): boolean {
  if (residualCleanupDominantFamily(input.analysis, input.context) !== 'mixed') return false
  const pageCount = input.analysis.pageCount ?? 0
  const isLargeRuntimeProfile = pageCount >= 80
  if (!isLargeRuntimeProfile) return false
  return input.timings.deepInspections >= 4
    || input.mixedNoShrinkPasses >= 2
    || input.rescuePasses > 1
    || (
      input.tracker.lastBucket === 'mixed'
      && input.tracker.lastMutationChangedDocument === true
      && input.tracker.lastProgressed === false
    )
}

function shouldAllowLargeMixedDominantFamilyRescue(input: {
  family: 'figure' | 'structure'
  rescuePasses: number
  currentSnapshot: ResidualCleanupProgressSnapshot
  tracker: ResidualCleanupTracker
  runtimeHeavyMixedProfile: boolean
  familySpecificOpportunityExposed: boolean
}): boolean {
  if (!input.runtimeHeavyMixedProfile) return true
  const expectedPressure = input.family === 'figure' ? 'figure_primary' : 'structure_primary'
  if (input.currentSnapshot.pressure !== expectedPressure) return false
  if (input.rescuePasses === 0) return input.familySpecificOpportunityExposed
  if (
    input.tracker.lastBucket !== 'mixed'
    || !input.tracker.lastSnapshot
    || input.tracker.lastMutationChangedDocument !== true
  ) {
    return false
  }
  return input.family === 'figure'
    ? didFigureDebtShrink(input.tracker.lastSnapshot, input.currentSnapshot)
    : didStructureDebtShrink(input.tracker.lastSnapshot, input.currentSnapshot)
}

function shouldSkipRescueCallInCompactMixedRescue(input: {
  call: RemediationToolCall
  context: PdfRemediationContext
  previousActionNames: string[]
}): boolean {
  const key = `${input.call.tool_name}:${input.call.arguments?.candidateGroupId || input.call.arguments?.candidateId || input.call.arguments?.target || 'document'}`
  if (input.previousActionNames.includes(key)) return true

  const candidateId = typeof input.call.arguments?.candidateId === 'string' ? input.call.arguments.candidateId : null
  if (!candidateId) return false

  const targetRef =
    input.context.figureCandidates.find(entry => entry.id === candidateId)?.targetRef
    || input.context.headingCandidates.find(entry => entry.id === candidateId)?.targetRef
    || null
  return !!targetRef && input.previousActionNames.includes(`${input.call.tool_name}_target:${targetRef}`)
}

function buildFigureOnlyFinalMileCalls(input: {
  context: PdfRemediationContext
  previousActionNames: string[]
  currentScore?: number
  blockerCount?: number
  maxCandidates?: number
}): RemediationToolCall[] {
  const candidates = [
    ...heuristicEligibleFigureCandidates(input.context)
      .filter(candidate => shouldRetryLateHeuristicFigureCandidate(candidate, input.previousActionNames)),
    ...input.context.figureCandidates.filter(candidate =>
      (candidate.informativeHint === 'decorative' || candidate.graphicsLikelyDecorative === true)
      && (!candidate.hasAlt || candidate.repairMode !== 'defer')
      && shouldRetryLateHeuristicFigureCandidate(candidate, input.previousActionNames),
    ),
  ]
    .sort((left, right) => {
      const strictPriority = (candidate: PdfRemediationContext['figureCandidates'][number]): number => {
        const unresolvedInformative = candidate.informativeHint !== 'decorative' && !candidate.hasAlt
        const needsRetag = !!candidate.targetTag && candidate.targetTag !== '/Figure'
        if (unresolvedInformative && needsRetag) return 0
        if (unresolvedInformative) return 1
        if (needsRetag) return 2
        if (candidate.hasLowQualityAlt) return 3
        return 4
      }
      const boostedNearPass = (input.blockerCount ?? Number.POSITIVE_INFINITY) <= 1 || (input.currentScore ?? 0) >= 75
      const priorityDelta = strictPriority(left) - strictPriority(right)
      if (priorityDelta !== 0) return priorityDelta
      if (boostedNearPass) {
        const pageDelta = left.pageNumber - right.pageNumber
        if (pageDelta !== 0) return pageDelta
      }
      return left.id.localeCompare(right.id)
    })
    .slice(0, Math.max(1, input.maxCandidates ?? 4))

  return candidates.map(candidate => {
    const likelyDecorative = candidate.informativeHint === 'decorative' || candidate.graphicsLikelyDecorative === true
    const needsRetag = !!candidate.targetTag && candidate.targetTag !== '/Figure'
    if (likelyDecorative) {
      return {
        tool_name: 'mark_figure_decorative' as const,
        arguments: { candidateId: candidate.id },
        rationale: `Focused final rescue: mark decorative figure candidate ${candidate.id} as Artifact before final verification.`,
        confidence: 0.78,
        familyId: 'native_figure_convergence' as const,
        expectedPostconditions: ['figure_blocking_keys_shrink', 'alt_text_improves'],
      }
    }
    if (needsRetag) {
      return {
        tool_name: 'retag_as_figure_and_set_alt' as const,
        arguments: {
          candidateId: candidate.id,
          altText: heuristicFigureAltText(candidate.id, input.context),
          generationSource: 'heuristic_fallback' as const,
        },
        rationale: `Focused final rescue: retag figure candidate ${candidate.id} as /Figure and set bounded fallback alt text.`,
        confidence: 0.72,
        familyId: 'native_figure_convergence' as const,
        expectedPostconditions: ['figure_blocking_keys_shrink', 'alt_text_improves'],
      }
    }
    return {
      tool_name: 'set_figure_alt_text' as const,
      arguments: {
        candidateId: candidate.id,
        altText: heuristicFigureAltText(candidate.id, input.context),
        generationSource: 'heuristic_fallback' as const,
      },
      rationale: `Focused final rescue: set bounded fallback alt text for figure candidate ${candidate.id}.`,
      confidence: 0.7,
      familyId: 'native_figure_convergence' as const,
      expectedPostconditions: ['figure_blocking_keys_shrink', 'alt_text_improves'],
    }
  })
}

export const __test_isHeadingOnlyResidualState = isHeadingOnlyResidualState
export const __test_shouldPreferLightFocusedRescueContext = shouldPreferLightFocusedRescueContext
export const __test_shouldUseCompactMixedFinalRescue = shouldUseCompactMixedFinalRescue
export const __test_shouldUseNearPassFigureFastLane = shouldUseNearPassFigureFastLane
export const __test_shouldTripMixedRuntimeGovernor = shouldTripMixedRuntimeGovernor
export const __test_shouldSerialTerminalizeLargeMixedProfile = shouldSerialTerminalizeLargeMixedProfile
export const __test_shouldAllowLargeMixedDominantFamilyRescue = shouldAllowLargeMixedDominantFamilyRescue
export const __test_shouldSkipRescueCallInCompactMixedRescue = shouldSkipRescueCallInCompactMixedRescue
export const __test_buildFigureOnlyFinalMileCalls = buildFigureOnlyFinalMileCalls
export const __test_specializedTailModeForResult = specializedTailModeForResult
export const __test_isNearPassTailEligible = isNearPassTailEligible
export const __test_buildFontTailFinalMileCalls = buildFontTailFinalMileCalls
export const __test_buildAnnotationTableTailCalls = buildAnnotationTableTailCalls

function buildFontTailFinalMileCalls(input: {
  context: PdfRemediationContext
  hasResidualFontDebt: boolean
}): RemediationToolCall[] {
  const calls: RemediationToolCall[] = []
  if ((input.context.qpdf.unembeddedFontCount ?? 0) > 0) {
    calls.push({
      tool_name: 'embed_missing_fonts_in_place',
      arguments: { target: 'document' },
      rationale: 'Specialized font tail: embed any remaining unembedded fonts before final verification.',
      confidence: 0.95,
    })
  }
  if (input.hasResidualFontDebt) {
    calls.push(
      {
        tool_name: 'repair_font_unicode_maps',
        arguments: { target: 'document' },
        rationale: 'Specialized font tail: rebuild missing ToUnicode maps on remaining font residue.',
        confidence: 0.95,
      },
      {
        tool_name: 'repair_type1_font_unicode_maps',
        arguments: { target: 'document' },
        rationale: 'Specialized font tail: repair remaining Type1 font Unicode maps.',
        confidence: 0.92,
      },
      {
        tool_name: 'substitute_legacy_fonts_in_place',
        arguments: { target: 'document' },
        rationale: 'Specialized font tail: substitute unresolved legacy fonts once embedding and Unicode repairs plateau.',
        confidence: 0.88,
      },
      {
        tool_name: 'finalize_substituted_font_conformance',
        arguments: { target: 'document', reportedWidthFixes: [] },
        rationale: 'Specialized font tail: finalize substituted font conformance after final deterministic font cleanup.',
        confidence: 0.9,
      },
    )
  }
  return calls
}

function buildAnnotationTableTailCalls(input: {
  context: PdfRemediationContext
  analysis: AnalysisResult
  compactMixedFinalRescue: boolean
}): RemediationToolCall[] {
  const calls: RemediationToolCall[] = []
  if (
    hasBlockingLocalFinding(input.analysis, 'pdfua.annotation_alt_contents')
    || hasBlockingLocalFinding(input.analysis, 'pdfua.link_tagging')
  ) {
    calls.push(
      {
        tool_name: 'repair_annotation_alt_text',
        arguments: { target: 'document' },
        rationale: 'Specialized tail cleanup: repair remaining annotation alternate text before terminalization.',
        confidence: 0.92,
      },
      {
        tool_name: 'repair_native_link_structure',
        arguments: { target: 'document' },
        rationale: 'Specialized tail cleanup: repair native link structure before final scoring.',
        confidence: 0.9,
      },
    )
    for (const candidate of (input.context.linkCandidates || []).filter(entry => !(entry.annotationContents || '').trim()).slice(0, input.compactMixedFinalRescue ? 3 : 6)) {
      calls.push({
        tool_name: 'set_link_annotation_contents',
        arguments: {
          candidateId: candidate.id,
          pageNumber: candidate.pageNumber,
          annotationIndex: candidate.annotationIndex,
          contents: candidate.suggestedText || candidate.text || candidate.url,
        },
        rationale: `Specialized tail cleanup: set /Contents for link annotation ${candidate.id} before terminalization.`,
        confidence: 0.87,
      })
    }
  }
  if (hasBlockingLocalFinding(input.analysis, 'pdfua.table_regularity') || hasUnresolvedCategoryLabel(input.analysis, 'Table Markup')) {
    calls.push({
      tool_name: 'repair_native_table_headers',
      arguments: { target: 'document' },
      rationale: 'Specialized tail cleanup: repair native table headers in the remaining table residue.',
      confidence: 0.9,
    })
    for (const candidate of (input.context.tableCandidates || []).filter(entry => entry.repairMode === 'safe' && !entry.hasHeaders && !!entry.ref).slice(0, input.compactMixedFinalRescue ? 2 : 4)) {
      calls.push({
        tool_name: 'set_table_header_cells',
        arguments: { targets: [candidate.ref] },
        rationale: `Specialized tail cleanup: set header cells for table ${candidate.ref}.`,
        confidence: 0.87,
      })
    }
  }
  return calls
}

function residualFamilyBucketFromDecision(
  family: Pick<ResidualFamilyDecision, 'id'> | null | undefined,
): ResidualCleanupFamilyBucket {
  switch (family?.id) {
    case 'post_bootstrap_heading_convergence':
    case 'logical_structure_marked_content':
      return 'structure'
    case 'native_figure_convergence':
      return 'figure'
    default:
      return 'unknown'
  }
}

function residualCleanupDominantFamily(
  analysis: AnalysisResult,
  context: PdfRemediationContext | null | undefined,
): ResidualCleanupFamilyBucket {
  return residualCleanupFamilyState(analysis, context).bucket
}

function residualCleanupFamilyState(
  analysis: AnalysisResult,
  context: PdfRemediationContext | null | undefined,
): {
  bucket: ResidualCleanupFamilyBucket
  pressure: ResidualCleanupFamilyPressure
  structureDebtCount: number
  figureDebtCount: number
} {
  const blockingKeys = blockingLocalFindingKeys(analysis)
  const structureDebtCount =
    blockingKeys.filter(key =>
      key === 'pdfua.logical_structure'
      || key === 'pdfua.heading_content_quality'
      || key === 'pdfua.reading_order'
    ).length
    + unresolvedIssues(analysis).filter(label =>
      label === 'Heading Structure'
      || label === 'Reading Order'
      || label === 'PDF/UA Compliance'
    ).length
  const figureDebtCount =
    blockingKeys.filter(key =>
      key === 'pdfua.figure_alt_or_artifact'
      || key === 'pdfua.untagged_rendered_images'
      || key === 'pdfua.nested_alt_text'
      || key === 'pdfua.figure_alt_quality'
    ).length
    + unresolvedIssues(analysis).filter(label => label === 'Alt Text on Images').length
    + informativeFigureMissingAltCount(context)
  const hasStructureDebt = structureDebtCount > 0
  const hasFigureDebt = figureDebtCount > 0
  if (hasStructureDebt && hasFigureDebt) {
    if (figureDebtCount >= structureDebtCount + 2) {
      return {
        bucket: 'figure',
        pressure: 'figure_primary',
        structureDebtCount,
        figureDebtCount,
      }
    }
    if (structureDebtCount >= figureDebtCount + 2) {
      return {
        bucket: 'structure',
        pressure: 'structure_primary',
        structureDebtCount,
        figureDebtCount,
      }
    }
    return {
      bucket: 'mixed',
      pressure: 'irreducibly_mixed',
      structureDebtCount,
      figureDebtCount,
    }
  }
  if (hasStructureDebt) {
    return {
      bucket: 'structure',
      pressure: 'single_family',
      structureDebtCount,
      figureDebtCount,
    }
  }
  if (hasFigureDebt) {
    return {
      bucket: 'figure',
      pressure: 'single_family',
      structureDebtCount,
      figureDebtCount,
    }
  }
  return {
    bucket: 'unknown',
    pressure: 'unknown',
    structureDebtCount,
    figureDebtCount,
  }
}

function buildResidualCleanupProgressSnapshot(
  bucket: ResidualCleanupFamilyBucket,
  result: AnalysisResult,
  context: PdfRemediationContext | null | undefined,
): ResidualCleanupProgressSnapshot {
  const familyState = residualCleanupFamilyState(result, context)
  const structureSnapshot = buildPhaseProgressSnapshot('structure_state', result, context)
  const figureSnapshot = buildPhaseProgressSnapshot('figure_description_state', result, context)
  return {
    bucket,
    pressure: familyState.pressure,
    signature: JSON.stringify({
      bucket,
      pressure: familyState.pressure,
      structureBlockingKeys: structureSnapshot.blockingKeys,
      structureUnresolvedIssueLabels: structureSnapshot.unresolvedIssueLabels,
      structureCategoryScores: structureSnapshot.categoryScores,
      structureOpportunityCount: structureSnapshot.structureOpportunityCount,
      figureBlockingKeys: figureSnapshot.blockingKeys,
      figureUnresolvedIssueLabels: figureSnapshot.unresolvedIssueLabels,
      informativeFigureMissingAltCount: figureSnapshot.informativeFigureMissingAltCount,
    }),
    structureBlockingKeys: structureSnapshot.blockingKeys,
    structureUnresolvedIssueLabels: structureSnapshot.unresolvedIssueLabels,
    structureCategoryScores: {
      pdfUa: structureSnapshot.categoryScores.pdfUa,
      headingStructure: structureSnapshot.categoryScores.headingStructure,
      readingOrder: structureSnapshot.categoryScores.readingOrder,
      textExtractability: structureSnapshot.categoryScores.textExtractability,
    },
    structureOpportunityCount: structureSnapshot.structureOpportunityCount,
    figureBlockingKeys: figureSnapshot.blockingKeys,
    figureUnresolvedIssueLabels: figureSnapshot.unresolvedIssueLabels,
    informativeFigureMissingAltCount: figureSnapshot.informativeFigureMissingAltCount,
  }
}

function didResidualCleanupProgressImprove(
  previous: ResidualCleanupProgressSnapshot,
  next: ResidualCleanupProgressSnapshot,
  changedDocumentBytes: boolean,
): boolean {
  if (!changedDocumentBytes) return false
  const structureCategoryImproved =
    categoryScoreImproved(previous.structureCategoryScores.headingStructure, next.structureCategoryScores.headingStructure)
    || categoryScoreImproved(previous.structureCategoryScores.readingOrder, next.structureCategoryScores.readingOrder)
    || categoryScoreImproved(previous.structureCategoryScores.pdfUa, next.structureCategoryScores.pdfUa)
    || categoryScoreImproved(previous.structureCategoryScores.textExtractability, next.structureCategoryScores.textExtractability)
  const structureOpportunityReduced =
    typeof previous.structureOpportunityCount === 'number'
    && typeof next.structureOpportunityCount === 'number'
    && next.structureOpportunityCount < previous.structureOpportunityCount
  switch (previous.bucket) {
    case 'structure':
      return next.structureBlockingKeys.length < previous.structureBlockingKeys.length
        || next.structureUnresolvedIssueLabels.length < previous.structureUnresolvedIssueLabels.length
        || structureCategoryImproved
        || structureOpportunityReduced
    case 'figure':
      return next.figureBlockingKeys.length < previous.figureBlockingKeys.length
        || next.informativeFigureMissingAltCount < previous.informativeFigureMissingAltCount
        || next.figureUnresolvedIssueLabels.length < previous.figureUnresolvedIssueLabels.length
    case 'mixed':
      return (
        (next.structureBlockingKeys.length + next.figureBlockingKeys.length)
          < (previous.structureBlockingKeys.length + previous.figureBlockingKeys.length)
      ) || next.informativeFigureMissingAltCount < previous.informativeFigureMissingAltCount
        || structureCategoryImproved
        || structureOpportunityReduced
        || next.pressure !== previous.pressure
    case 'unknown':
      return next.signature !== previous.signature
  }
}

function didStructureDebtShrink(
  previous: ResidualCleanupProgressSnapshot,
  next: ResidualCleanupProgressSnapshot,
): boolean {
  const structureOpportunityReduced =
    typeof previous.structureOpportunityCount === 'number'
    && typeof next.structureOpportunityCount === 'number'
    && next.structureOpportunityCount < previous.structureOpportunityCount
  return next.structureBlockingKeys.length < previous.structureBlockingKeys.length
    || next.structureUnresolvedIssueLabels.length < previous.structureUnresolvedIssueLabels.length
    || structureOpportunityReduced
    || categoryScoreImproved(previous.structureCategoryScores.headingStructure, next.structureCategoryScores.headingStructure)
    || categoryScoreImproved(previous.structureCategoryScores.readingOrder, next.structureCategoryScores.readingOrder)
    || categoryScoreImproved(previous.structureCategoryScores.pdfUa, next.structureCategoryScores.pdfUa)
    || categoryScoreImproved(previous.structureCategoryScores.textExtractability, next.structureCategoryScores.textExtractability)
}

function didFigureDebtShrink(
  previous: ResidualCleanupProgressSnapshot,
  next: ResidualCleanupProgressSnapshot,
): boolean {
  return next.figureBlockingKeys.length < previous.figureBlockingKeys.length
    || next.figureUnresolvedIssueLabels.length < previous.figureUnresolvedIssueLabels.length
    || next.informativeFigureMissingAltCount < previous.informativeFigureMissingAltCount
}

function deriveResidualCleanupTransitionStopReason(input: {
  beforeBucket: ResidualCleanupFamilyBucket
  afterBucket: ResidualCleanupFamilyBucket
  improved: boolean
}): ResidualCleanupStopReason | null {
  if (!input.improved && input.beforeBucket === 'mixed' && input.afterBucket === 'mixed') {
    return 'mixed_runtime_churn_without_family_shrink'
  }
  if (
    (input.beforeBucket === 'structure' || input.beforeBucket === 'mixed')
    && input.afterBucket === 'figure'
  ) {
    return 'structure_debt_cleared_figure_debt_remaining'
  }
  if (
    (input.beforeBucket === 'figure' || input.beforeBucket === 'mixed')
    && input.afterBucket === 'structure'
  ) {
    return 'figure_debt_cleared_structure_debt_remaining'
  }
  return null
}

export const __test_deriveResidualCleanupTransitionStopReason = deriveResidualCleanupTransitionStopReason

function shouldAllowResidualFamilyDeepFollowUp(input: {
  tracker: ResidualCleanupTracker
  bucket: ResidualCleanupFamilyBucket
  pressure?: ResidualCleanupFamilyPressure
  snapshot?: ResidualCleanupProgressSnapshot | null
  familyId?: ResidualFamilyDecision['id'] | null
  stageIntroducedNewFamily: boolean
}): boolean {
  if (input.bucket === 'unknown') return true
  if (input.bucket !== 'mixed' && input.tracker.convergedBuckets[input.bucket]) return false
  if (input.bucket === 'mixed' && input.tracker.convergedBuckets.mixed) return false
  if (input.stageIntroducedNewFamily) return true
  if (
    input.pressure === 'figure_primary'
    && input.familyId === 'logical_structure_marked_content'
  ) {
    return !!input.tracker.lastSnapshot
      && !!input.snapshot
      && didStructureDebtShrink(input.tracker.lastSnapshot, input.snapshot)
  }
  if (
    input.pressure === 'structure_primary'
    && input.familyId === 'native_figure_convergence'
  ) {
    return false
  }
  if (
    input.pressure === 'irreducibly_mixed'
    && input.tracker.lastBucket === 'mixed'
    && input.tracker.lastSnapshot?.pressure === 'irreducibly_mixed'
    && input.tracker.lastMutationChangedDocument
    && input.tracker.lastProgressed === false
    && !!input.snapshot
    && !didStructureDebtShrink(input.tracker.lastSnapshot, input.snapshot)
    && !didFigureDebtShrink(input.tracker.lastSnapshot, input.snapshot)
  ) {
    return false
  }
  return !(
    input.tracker.lastBucket === input.bucket
    && input.tracker.lastMutationChangedDocument
    && input.tracker.lastProgressed === false
    && input.tracker.lastFamilyId === (input.familyId || null)
  )
}

export const __test_residualFamilyBucketFromDecision = residualFamilyBucketFromDecision
export const __test_residualCleanupDominantFamily = residualCleanupDominantFamily
export const __test_didResidualCleanupProgressImprove = didResidualCleanupProgressImprove
export const __test_shouldAllowResidualFamilyDeepFollowUp = shouldAllowResidualFamilyDeepFollowUp

function shouldStopStructureChurnEarly(input: {
  previousCoarseStableStateSignature: string
  currentCoarseStableStateSignature: string
  coarseStableStateRepeats: number
  stableStateRepeats: number
  tracker: ResidualCleanupTracker
  stageActions: RemediationActionRecord[]
  currentResult: AnalysisResult
  context: PdfRemediationContext | null | undefined
  stageAppliedAcrobatAltRepair: boolean
}): boolean {
  if (input.stageAppliedAcrobatAltRepair) return false
  if (input.currentCoarseStableStateSignature !== input.previousCoarseStableStateSignature) return false
  if (input.tracker.lastBucket !== 'structure' && input.tracker.lastBucket !== 'mixed') return false
  if (input.tracker.lastMutationChangedDocument !== true || input.tracker.lastProgressed !== false) return false
  const familyState = residualCleanupFamilyState(input.currentResult, input.context)
  const dominantFamily = familyState.bucket
  const currentBlockingKeys = blockingLocalFindingKeys(input.currentResult)
  const retainsStructureDebt = currentBlockingKeys.some(key =>
    key === 'pdfua.logical_structure'
    || key === 'pdfua.heading_content_quality',
  )
  const structureDebtCount = familyState.structureDebtCount
  const figureDebtCount = familyState.figureDebtCount
  const repeatedMixedNoProgress =
    input.tracker.lastBucket === 'mixed'
    && (input.coarseStableStateRepeats >= 1 || input.stableStateRepeats >= 1)
    && figureDebtCount > structureDebtCount
    && retainsStructureDebt
    && (dominantFamily === 'mixed' || dominantFamily === 'figure')
  const repeatedIrreducibleMixedNoProgress =
    input.tracker.lastBucket === 'mixed'
    && (input.coarseStableStateRepeats >= 1 || input.stableStateRepeats >= 1)
    && familyState.pressure === 'irreducibly_mixed'
    && retainsStructureDebt

  if (dominantFamily !== 'structure' && dominantFamily !== 'mixed' && !repeatedMixedNoProgress && !repeatedIrreducibleMixedNoProgress) {
    return false
  }
  return requiresDeepStructureInspect(input.stageActions)
    && (
      input.tracker.lastBucket === 'structure'
      || repeatedMixedNoProgress
      || repeatedIrreducibleMixedNoProgress
      || (familyState.pressure === 'figure_primary' && figureDebtCount > structureDebtCount)
    )
}

export const __test_shouldStopStructureChurnEarly = shouldStopStructureChurnEarly

function shouldStopFocusedStructureRescueLoop(input: {
  rescuePasses: number
  beforeSnapshot: ResidualCleanupProgressSnapshot
  afterAnalysis: AnalysisResult
  afterContext: PdfRemediationContext | null | undefined
  stageActions: RemediationActionRecord[]
}): boolean {
  if (input.rescuePasses < 1) return false
  if (!requiresDeepStructureInspect(input.stageActions)) return false
  const familyState = residualCleanupFamilyState(input.afterAnalysis, input.afterContext)
  const afterBucket = familyState.bucket
  if (afterBucket !== 'mixed' && afterBucket !== 'figure') return false
  const afterSnapshot = buildResidualCleanupProgressSnapshot(afterBucket, input.afterAnalysis, input.afterContext)
  const retainsStructureDebt =
    afterSnapshot.structureBlockingKeys.length > 0
    || afterSnapshot.structureUnresolvedIssueLabels.length > 0
  if (!retainsStructureDebt) return false
  const structureDebtCount = familyState.structureDebtCount
  const figureDebtCount = familyState.figureDebtCount
  const residualImproved = didResidualCleanupProgressImprove(input.beforeSnapshot, afterSnapshot, true)
  const changedDocumentBytes = input.stageActions.some(action => action.changedDocumentBytes && action.outcome !== 'rejected')
  const allowAdditionalMixedPass =
    afterBucket === 'mixed'
    && (input.afterAnalysis.pageCount ?? 0) < 80
    && changedDocumentBytes
    && input.rescuePasses < 2
  if (familyState.pressure === 'irreducibly_mixed') {
    if (!residualImproved && allowAdditionalMixedPass) return false
    return !residualImproved
  }
  if (figureDebtCount <= structureDebtCount) return false
  if (familyState.pressure === 'figure_primary') {
    if (allowAdditionalMixedPass) return false
    return true
  }
  if (!residualImproved && allowAdditionalMixedPass) return false
  return !residualImproved
}

export const __test_shouldStopFocusedStructureRescueLoop = shouldStopFocusedStructureRescueLoop

export function __test_isInspectionBudgetExhausted(timings: { deepInspections: number; lightInspections: number }): boolean {
  return timings.deepInspections >= MAX_DEEP_INSPECTIONS_PER_FILE
    || timings.lightInspections >= MAX_LIGHT_INSPECTIONS_PER_FILE
    || (timings.lightInspections + timings.deepInspections) >= MAX_TOTAL_INSPECTIONS_PER_FILE
}

function shouldDeferLateFigureWorkUntilStructureConverges(input: {
  analysis: AnalysisResult
  context: PdfRemediationContext | null | undefined
  tracker: ResidualCleanupTracker
}): boolean {
  const dominantFamily = residualCleanupDominantFamily(input.analysis, input.context)
  return (dominantFamily === 'structure' || dominantFamily === 'mixed')
    && !input.tracker.convergedBuckets.structure
}

export const __test_shouldDeferLateFigureWorkUntilStructureConverges = shouldDeferLateFigureWorkUntilStructureConverges

function cleanupEligibleCategoryIds(): Set<string> {
  return new Set([
    'title_language',
    'pdf_ua_compliance',
    'heading_structure',
    'alt_text',
    'table_markup',
    'link_quality',
    'reading_order',
  ])
}

function canExitEarlyToFinalCleanup(result: AnalysisResult, threshold: number = REMEDIATION.EARLY_EXIT_SCORE_THRESHOLD): boolean {
  if (result.overallScore < threshold) return false
  const remaining = result.categories
    .filter(category => typeof category.score === 'number' && category.score < 100)
    .map(category => category.id)
  if (!remaining.length) return false
  if (remaining.includes('bookmarks')) return false
  const cleanupEligible = cleanupEligibleCategoryIds()
  return remaining.every(categoryId => cleanupEligible.has(categoryId))
}

function dedupeToolCalls(calls: RemediationToolCall[]): RemediationToolCall[] {
  const seen = new Set<string>()
  const next: RemediationToolCall[] = []
  for (const call of calls) {
    const key = JSON.stringify([call.tool_name, call.arguments])
    if (seen.has(key)) continue
    seen.add(key)
    next.push(call)
  }
  return next
}

function shouldAllowPipelineExcludedFamilyCall(
  call: RemediationToolCall,
  convergenceFamilies: ResidualFamilyDecision[] | null | undefined,
): boolean {
  if (!convergenceFamilies?.length) return false
  return convergenceFamilies.some(family =>
    call.familyId === family.id
    && family.preferredTools.includes(call.tool_name),
  )
}

export const __test_shouldAllowPipelineExcludedFamilyCall = shouldAllowPipelineExcludedFamilyCall

function familyCompletionTarget(
  failureProfile: Pick<FailureProfile, 'residualFamilies'> | null | undefined,
) {
  return findSingleBlockingResidualFamilyConvergenceTarget(failureProfile?.residualFamilies || [])
}

function sortResidualCleanupFamilies(left: ResidualFamilyDecision, right: ResidualFamilyDecision): number {
  return Number(right.blocking) - Number(left.blocking)
    || left.priority - right.priority
    || right.evidenceStrength - left.evidenceStrength
    || left.id.localeCompare(right.id)
}

function selectResidualCleanupFamilyTarget(
  failureProfile: Pick<FailureProfile, 'residualFamilies'> | null | undefined,
  analysis?: Pick<AnalysisResult, 'overallScore' | 'localStandards'> | null,
  context?: PdfRemediationContext | null,
): ResidualFamilyDecision | null {
  const figureFinalMile = selectFigureFinalMileResidualCleanupTarget(failureProfile, analysis)
  if (figureFinalMile) return figureFinalMile
  const single = familyCompletionTarget(failureProfile)
  if (single) return single

  const candidates = [...(failureProfile?.residualFamilies || [])]
    .filter(family =>
      family.blocking
      && family.convergenceStatus === 'preferred_tools_available'
      && family.preferredAutoRunnableOpportunityKeys.length > 0,
    )
    .sort(sortResidualCleanupFamilies)

  if (analysis && context && candidates.length > 1) {
    const familyState = residualCleanupFamilyState(analysis as AnalysisResult, context)
    if (familyState.pressure === 'figure_primary') {
      const figureCandidate = candidates.find(candidate => candidate.id === 'native_figure_convergence')
      if (figureCandidate) return figureCandidate
    }
    if (familyState.pressure === 'structure_primary') {
      const structureCandidate = candidates.find(candidate => STRUCTURAL_RESIDUAL_FAMILY_IDS.has(candidate.id))
      if (structureCandidate) return structureCandidate
    }
  }

  return candidates[0] || null
}

function selectFigureFinalMileResidualCleanupTarget(
  failureProfile: Pick<FailureProfile, 'residualFamilies'> | null | undefined,
  analysis?: Pick<AnalysisResult, 'overallScore' | 'localStandards'> | null,
): ResidualFamilyDecision | null {
  if (!failureProfile?.residualFamilies?.length || !analysis) return null
  const figureFamily = failureProfile.residualFamilies.find(family =>
    family.id === 'native_figure_convergence'
    && family.blocking
    && family.convergenceStatus === 'preferred_tools_available',
  )
  if (!figureFamily) return null

  const blockingKeys = (analysis.localStandards?.findings || [])
    .filter(finding => finding.blocking)
    .map(finding => finding.key)

  if (!blockingKeys.length) return null
  const figureFinalMileOnly = blockingKeys.every(key =>
    key === 'pdfua.figure_alt_or_artifact'
    || key === 'pdfua.nested_alt_text'
    || key === 'pdfua.figure_alt_quality'
    || key === 'category.alt_text'
    || key === 'context.long_report_figure_residue'
    || key === 'context.figure_candidates_blocked',
  )
  if (!figureFinalMileOnly) return null
  if ((analysis.overallScore || 0) < 75) return null
  return figureFamily
}

export function __test_needsFamilyCompleteConvergence(
  failureProfile: Pick<FailureProfile, 'residualFamilies'> | null | undefined,
): boolean {
  return !!familyCompletionTarget(failureProfile)
}

export const __test_selectResidualCleanupFamilyTarget = selectResidualCleanupFamilyTarget
export const __test_selectFigureFinalMileResidualCleanupTarget = selectFigureFinalMileResidualCleanupTarget

const STRUCTURAL_RESIDUAL_FAMILY_IDS = new Set<ResidualFamilyDecision['id']>([
  'metadata_normalization',
  'link_tabs_and_annotation_cleanup',
  'post_bootstrap_heading_convergence',
  'logical_structure_marked_content',
])

const MIXED_STRUCTURE_FIGURE_CLEANUP_TOOL_ORDER: RemediationToolName[] = [
  'normalize_heading_hierarchy',
  'repair_native_marked_content_refs',
  'repair_structure_conformance',
  'normalize_nested_figure_containers',
  'repair_native_figure_semantics',
  'repair_other_elements_alt_text',
  'set_figure_alt_text',
  'retag_as_figure_and_set_alt',
  'mark_figure_decorative',
]

const STRUCTURAL_RESIDUAL_CLEANUP_TOOL_ORDER: RemediationToolName[] = [
  'set_document_title',
  'normalize_document_metadata',
  'set_document_language',
  'set_pdfua_identification',
  'repair_native_link_structure',
  'tag_unowned_annotations',
  'set_link_annotation_contents',
  'normalize_annotation_tab_order',
  'set_tabs_all_annotated_pages',
  'artifact_nonsemantic_page_elements',
  'normalize_heading_hierarchy',
  'create_heading_from_candidate',
  'repair_native_reading_order',
  'reorder_structure_children',
  'repair_native_marked_content_refs',
  'repair_bootstrapped_chart_content_refs',
  'repair_structure_conformance',
]

function shouldUseMixedStructureFigureCleanupFamilyChain(
  failureProfile: Pick<FailureProfile, 'residualFamilies'> | null | undefined,
): boolean {
  const residualFamilies = failureProfile?.residualFamilies || []
  const hasBlockingStructureFamily = residualFamilies.some(family =>
    family.blocking
    && family.convergenceStatus === 'preferred_tools_available'
    && STRUCTURAL_RESIDUAL_FAMILY_IDS.has(family.id),
  )
  const hasBlockingFigureFamily = residualFamilies.some(family =>
    family.blocking
    && family.convergenceStatus === 'preferred_tools_available'
    && family.id === 'native_figure_convergence',
  )
  return hasBlockingStructureFamily && hasBlockingFigureFamily
}

function residualCleanupFamilyChain(
  failureProfile: Pick<FailureProfile, 'residualFamilies'> | null | undefined,
  family: ResidualFamilyDecision,
): ResidualFamilyDecision[] {
  if (
    shouldUseMixedStructureFigureCleanupFamilyChain(failureProfile)
    && (STRUCTURAL_RESIDUAL_FAMILY_IDS.has(family.id) || family.id === 'native_figure_convergence')
  ) {
    const relatedFamilies = (failureProfile?.residualFamilies || [])
      .filter(candidate =>
        candidate.blocking
        && candidate.convergenceStatus === 'preferred_tools_available'
        && (STRUCTURAL_RESIDUAL_FAMILY_IDS.has(candidate.id) || candidate.id === 'native_figure_convergence'),
      )
      .sort(sortResidualCleanupFamilies)

    return relatedFamilies.length ? relatedFamilies : [family]
  }

  if (!STRUCTURAL_RESIDUAL_FAMILY_IDS.has(family.id)) {
    return [family]
  }

  const relatedFamilies = (failureProfile?.residualFamilies || [])
    .filter(candidate =>
      candidate.blocking
      && candidate.convergenceStatus === 'preferred_tools_available'
      && STRUCTURAL_RESIDUAL_FAMILY_IDS.has(candidate.id),
    )
    .sort(sortResidualCleanupFamilies)

  return relatedFamilies.length ? relatedFamilies : [family]
}

function residualCleanupToolOrder(families: ResidualFamilyDecision[]): RemediationToolName[] {
  if (
    families.some(family => STRUCTURAL_RESIDUAL_FAMILY_IDS.has(family.id))
    && families.some(family => family.id === 'native_figure_convergence')
  ) {
    return MIXED_STRUCTURE_FIGURE_CLEANUP_TOOL_ORDER
  }
  if (families.some(family => STRUCTURAL_RESIDUAL_FAMILY_IDS.has(family.id))) {
    return STRUCTURAL_RESIDUAL_CLEANUP_TOOL_ORDER
  }

  const order: RemediationToolName[] = []
  for (const family of families) {
    for (const tool of family.preferredTools) {
      if (!order.includes(tool)) {
        order.push(tool)
      }
    }
  }
  return order
}

export const __test_residualCleanupFamilyChain = residualCleanupFamilyChain

function buildResidualCleanupFamilyCalls(input: {
  filename: string
  analysis: AnalysisResult
  context: PdfRemediationContext
  failureProfile: Pick<FailureProfile, 'toolOpportunities' | 'residualFamilies'>
  family: ResidualFamilyDecision
  plannedCalls: RemediationToolCall[]
}): RemediationToolCall[] {
  const families = residualCleanupFamilyChain(input.failureProfile, input.family)
  const targetFamilyIds = new Set(families.map(family => family.id))
  const toolOrder = residualCleanupToolOrder(families)
  const toolOrderIndex = new Map(toolOrder.map((tool, index) => [tool, index]))

  const plannedFamilyCalls = input.plannedCalls.filter(call =>
    targetFamilyIds.has(call.familyId as ResidualFamilyDecision['id'])
    && toolOrder.includes(call.tool_name),
  )
    .sort((left, right) =>
      (toolOrderIndex.get(left.tool_name) ?? Number.MAX_SAFE_INTEGER) - (toolOrderIndex.get(right.tool_name) ?? Number.MAX_SAFE_INTEGER)
      || (left.familyStep ?? Number.MAX_SAFE_INTEGER) - (right.familyStep ?? Number.MAX_SAFE_INTEGER)
      || (TOOL_STAGE_ORDER.get(left.tool_name) ?? 99) - (TOOL_STAGE_ORDER.get(right.tool_name) ?? 99)
      || right.confidence - left.confidence,
    )

  const candidateCalls: RemediationToolCall[] = []
  const familyOpportunities = input.failureProfile.toolOpportunities
    .filter(opportunity =>
      targetFamilyIds.has(opportunity.familyId as ResidualFamilyDecision['id'])
      && toolOrder.includes(opportunity.toolName)
      && opportunity.status === 'auto_runnable',
    )
    .sort((left, right) =>
      (toolOrderIndex.get(left.toolName) ?? Number.MAX_SAFE_INTEGER) - (toolOrderIndex.get(right.toolName) ?? Number.MAX_SAFE_INTEGER)
      || (left.familyStep ?? Number.MAX_SAFE_INTEGER) - (right.familyStep ?? Number.MAX_SAFE_INTEGER)
      || (TOOL_STAGE_ORDER.get(left.toolName) ?? 99) - (TOOL_STAGE_ORDER.get(right.toolName) ?? 99)
      || (left.scope === 'document' ? 0 : 1) - (right.scope === 'document' ? 0 : 1)
      || right.confidence - left.confidence
      || left.key.localeCompare(right.key),
    )

  for (const opportunity of familyOpportunities) {
    const call = deriveDeterministicCall({
      filename: input.filename,
      analysis: input.analysis,
      context: input.context,
      opportunity,
      selectedActions: [...plannedFamilyCalls, ...candidateCalls],
    })
    if (!call) continue
    candidateCalls.push(call)
  }

  return dedupeToolCalls([
    ...plannedFamilyCalls,
    ...candidateCalls,
  ]).sort((left, right) =>
    (toolOrderIndex.get(left.tool_name) ?? Number.MAX_SAFE_INTEGER) - (toolOrderIndex.get(right.tool_name) ?? Number.MAX_SAFE_INTEGER)
    || (left.familyStep ?? Number.MAX_SAFE_INTEGER) - (right.familyStep ?? Number.MAX_SAFE_INTEGER)
    || (TOOL_STAGE_ORDER.get(left.tool_name) ?? 99) - (TOOL_STAGE_ORDER.get(right.tool_name) ?? 99)
    || right.confidence - left.confidence,
  )
}

export const __test_buildResidualCleanupFamilyCalls = buildResidualCleanupFamilyCalls

type ResidualCleanupExecutionMode = 'current' | 'baseline' | 'seeded' | 'refresh'

function residualCleanupExecutionMode(input: {
  hasBaselineFamily: boolean
  hasSeededPlanningState: boolean
  familyPasses: number
}): ResidualCleanupExecutionMode {
  if (!input.hasBaselineFamily) return 'current'
  if (input.familyPasses === 0) {
    return input.hasSeededPlanningState ? 'seeded' : 'baseline'
  }
  return 'refresh'
}

export const __test_residualCleanupExecutionMode = residualCleanupExecutionMode

function rejectAction(input: {
  action: RemediationActionRecord
  reason: string
}): RemediationActionRecord {
  return {
    ...input.action,
    details: `${input.action.details} Rejected because it ${input.reason}.`,
    outcome: 'rejected',
    autoApplied: false,
    changedDocumentBytes: false,
  }
}

function rejectActionForRegression(
  action: RemediationActionRecord,
  reason: string,
  isolated: boolean,
): RemediationActionRecord {
  return {
    ...action,
    details: isolated
      ? `${action.details} Rejected because it was isolated as the regressing action: ${reason}.`
      : `${action.details} Rejected because ${reason}.`,
    outcome: 'rejected',
    autoApplied: false,
    changedDocumentBytes: false,
  }
}

function isolationCandidateIndexes(stageActions: RemediationActionRecord[]): number[] {
  return stageActions
    .map((action, index) => ({
      action,
      index,
    }))
    .filter(({ action }) => !!action.changedDocumentBytes || action.outcome === 'no_effect')
    .map(({ index }) => index)
}

function semanticThreshold(batchType: SemanticBatchResult['batchType']): number {
  return batchType === 'figures' ? 0.75 : 0.8
}

const SEMANTIC_CATEGORY_IDS = ['heading_structure', 'alt_text', 'table_markup', 'link_quality', 'bookmarks'] as const

function isFullyDone(result: AnalysisResult): boolean {
  return result.grade === 'A'
}

function hasRemainingSemanticWork(result: AnalysisResult): boolean {
  return SEMANTIC_CATEGORY_IDS.some(categoryId => {
    const score = scoreForCategory(result, categoryId)
    return score !== null && score < 100
  })
}

function shouldRunBookmarkCleanup(
  result: AnalysisResult,
  originalResult: AnalysisResult,
  context: Awaited<ReturnType<typeof inspectPdfForRemediation>> | null,
): boolean {
  if (!context) return false
  const bookmarkCategory = result.categories.find(category => category.id === 'bookmarks')
  if (bookmarkCategory?.score === null) return false
  if ((context.pdfjs.pageCount || 0) < 8) return false
  const headingCount = context.headingCandidates.filter(candidate => candidate.text.trim()).length
  const outlineCount = context.qpdf.outlineTitles?.filter(title => title.trim()).length || 0
  return Math.max(headingCount, outlineCount) >= 4
}

function bookmarkCleanupTriggerAnalysis(result: AnalysisResult): AnalysisResult {
  return {
    ...result,
    grade: result.grade === 'A' ? 'B' : result.grade,
    categories: result.categories.map(category => {
      if (category.id === 'bookmarks') return { ...category, score: 0, grade: 'F' }
      if (category.id === 'heading_structure') return { ...category, score: 100, grade: 'A' }
      if (category.id === 'alt_text' || category.id === 'table_markup' || category.id === 'link_quality') {
        if (category.score === null) return category
        return { ...category, score: 100, grade: 'A' }
      }
      return category
    }),
  }
}

function hasAcrobatAltRiskFindings(result: AnalysisResult): boolean {
  if (!Array.isArray(result?.categories)) return false
  const altTextCategory = result.categories.find(category => category.id === 'alt_text')
  return (altTextCategory?.findings || []).some(finding =>
    /acrobat.risk|acrobat-risk|other-elements alternate text|graphics content is still owned by non-\/figure|acrobat-style|non-figure.*graphics|graphics.*non-figure/i.test(finding),
  )
}

function inspectModeForResult(result: AnalysisResult): RemediationInspectMode {
  if (!Array.isArray(result?.categories)) return 'light'
  return needsAltTextDeepInspection(result) || hasAcrobatAltRiskFindings(result)
    ? 'alt_text_deep'
    : 'light'
}

function acrobatOwnershipRiskCount(context: Awaited<ReturnType<typeof inspectPdfForRemediation>> | null): number {
  return context?.structure?.acrobatAltRiskNodes?.length ?? 0
}

function untaggedVisualTableCount(result: AnalysisResult): number {
  const category = result.categories.find(entry => entry.id === 'table_markup')
  if (!category) return 0
  return category.findings.reduce((count, finding) => {
    const match = /(\d+)\s+table\(s\)\s+detected visually that have no PDF tags/i.exec(finding)
    return match ? count + Number(match[1]) : count
  }, 0)
}

function needsStructuralPersistenceRound(
  result: AnalysisResult,
  context: Awaited<ReturnType<typeof inspectPdfForRemediation>> | null,
): boolean {
  return acrobatOwnershipRiskCount(context) > 0 || untaggedVisualTableCount(result) > 0
}

function finalCleanupCategoryTargets(tool: string): string[] {
  switch (tool) {
    case 'normalize_document_metadata':
      return ['title_language', 'pdf_ua_compliance']
    case 'normalize_heading_hierarchy':
      return ['heading_structure']
    case 'normalize_nested_figure_containers':
      return ['alt_text']
    case 'repair_native_table_headers':
    case 'set_table_header_cells':
      return ['table_markup']
    case 'set_link_annotation_contents':
      return ['link_quality', 'pdf_ua_compliance']
    case 'repair_native_link_structure':
      return ['link_quality', 'reading_order']
    case 'normalize_annotation_tab_order':
    case 'set_tabs_all_annotated_pages':
      return ['reading_order']
    default:
      return []
  }
}

function hasResultCategories(result: AnalysisResult | null | undefined): result is AnalysisResult {
  return Array.isArray(result?.categories)
}

function hasInspectionPayload(
  context: Awaited<ReturnType<typeof inspectPdfForRemediation>> | null | undefined,
): context is Awaited<ReturnType<typeof inspectPdfForRemediation>> {
  return !!context
    && !!context.qpdf
    && !!context.pdfjs
    && Array.isArray(context.pages)
}

function finalCleanupDetails(tool: string, appliedMutations: Array<{ details: string }>, warnings: string[]): string {
  const mutationDetails = appliedMutations.map(mutation => mutation.details).filter(Boolean)
  if (mutationDetails.length) return mutationDetails.join(' ')
  if (warnings.length) return warnings[0] || `Final cleanup ${tool} completed with warnings.`
  switch (tool) {
    case 'normalize_document_metadata':
      return 'Normalized document metadata and PDF/UA identification during final cleanup.'
    case 'normalize_heading_hierarchy':
      return 'Normalized heading hierarchy during final cleanup.'
    case 'normalize_nested_figure_containers':
      return 'Normalized nested figure containers during final cleanup.'
    case 'repair_native_table_headers':
      return 'Repaired native table headers during final cleanup.'
    case 'set_table_header_cells':
      return 'Promoted detected table header cells during final cleanup.'
    case 'set_link_annotation_contents':
      return 'Set link annotation alternate descriptions during final cleanup.'
    case 'repair_native_link_structure':
      return 'Repaired native link structure during final cleanup.'
    case 'normalize_annotation_tab_order':
      return 'Normalized annotation tab order during final cleanup.'
    case 'set_tabs_all_annotated_pages':
      return 'Set /Tabs /S on annotated pages during final cleanup.'
    default:
      return `Applied final cleanup operation ${tool}.`
  }
}

function heuristicEligibleFigureCandidates(context: Awaited<ReturnType<typeof inspectPdfForRemediation>> | null): PdfRemediationContext['figureCandidates'] {
  if (!context) return []
  return context.figureCandidates
    .filter(candidate =>
      candidate.repairMode !== 'defer'
      && candidate.informativeHint !== 'decorative'
      && (!candidate.hasAlt || !!candidate.hasLowQualityAlt || candidate.repairMode === 'retag_then_set_alt')
    )
    .sort((left, right) => {
      const priority = (candidate: PdfRemediationContext['figureCandidates'][number]): number => {
        if (candidate.repairMode === 'retag_then_set_alt' && !candidate.hasAlt) return 0
        if (candidate.repairMode === 'set_alt' && !candidate.hasAlt) return 1
        if (candidate.repairMode === 'set_alt' && candidate.hasLowQualityAlt) return 2
        if (candidate.repairMode === 'retag_then_set_alt') return 3
        return 4
      }
      return priority(left) - priority(right)
    })
}

function shouldRetryLateHeuristicFigureCandidate(
  candidate: PdfRemediationContext['figureCandidates'][number],
  previousActionNames: string[],
): boolean {
  const attemptedSetAlt = candidate.targetRef
    ? previousActionNames.includes(`set_figure_alt_text_target:${candidate.targetRef}`)
    : previousActionNames.includes(`set_figure_alt_text:${candidate.id}`)
  const attemptedHeuristicFallback = candidate.targetRef
    ? previousActionNames.includes(`heuristic_fallback_target:${candidate.targetRef}`)
    : previousActionNames.includes(`heuristic_fallback:${candidate.id}`)
  if (!attemptedSetAlt) return true
  return candidate.repairMode === 'retag_then_set_alt'
    || (!!candidate.hasLowQualityAlt && !attemptedHeuristicFallback)
    || (candidate.repairMode === 'set_alt' && candidate.targetTag === '/Figure' && !candidate.hasAlt)
}

function aiEligibleFigureCandidates(context: Awaited<ReturnType<typeof inspectPdfForRemediation>> | null): PdfRemediationContext['figureCandidates'] {
  if (!context) return []
  return context.figureCandidates.filter(candidate =>
    candidate.informativeHint !== 'decorative'
    && (
      candidate.repairMode !== 'defer'
      || (
        candidate.repairMode === 'defer'
        && (candidate.imageEvidence === 'strong' || candidate.imageEvidence === 'vector')
        && !!candidate.targetTag
        && candidate.unsafeReason?.startsWith('text_heavy_candidate:')
      )
    )
  )
}

function aiFirstFigureCandidates(context: Awaited<ReturnType<typeof inspectPdfForRemediation>> | null): PdfRemediationContext['figureCandidates'] {
  if (!hasSemanticRepairConfig()) return []
  return aiEligibleFigureCandidates(context)
}

function shouldRunSemanticStage(
  result: AnalysisResult,
  originalResult: AnalysisResult,
  context: Awaited<ReturnType<typeof inspectPdfForRemediation>> | null,
  semanticStrategy: SemanticStrategy = 'full_ai',
): boolean {
  if (semanticStrategy === 'skip') return false
  if (originalResult.isScanned) return false
  if ((semanticStrategy === 'heuristic_only' ? heuristicEligibleFigureCandidates(context) : aiFirstFigureCandidates(context)).length > 0) return true
  if (isFullyDone(result)) return false
  if (semanticStrategy === 'heuristic_only') return false
  return hasRemainingSemanticWork(result)
}

function isSemanticStageTooLargeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /context_length_exceeded|length limit exceeded|request too large|payload too large|semantic repair request failed:\s*413/i.test(message)
}

function isSemanticStageRecoverableProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return isSemanticStageTooLargeError(error)
    || /fetch failed|networkerror|econnreset|econnrefused|etimedout|timeout|timed out|socket hang up|\b50[234]\b|all candidate accounts are cooling down|provider request failed|invalid_request_error/i.test(message)
}

function semanticDeferredAction(input: {
  tool: RemediationActionRecord['tool']
  target: string
  candidateId: string
  confidence: number
  details: string
  categoryTargets: string[]
  generationSource?: RemediationActionRecord['generationSource']
}): RemediationActionRecord {
  return {
    tool: input.tool,
    target: input.target,
    candidateId: input.candidateId,
    details: input.details,
    confidence: input.confidence,
    autoApplied: false,
    changedVisibleContent: input.tool === 'rewrite_link_visible_text' || input.tool === 'update_link_visible_text',
    categoryTargets: input.categoryTargets,
    changedDocumentBytes: false,
    generationSource: input.generationSource,
    outcome: 'deferred',
  }
}

async function runHeuristicFigureFallbackStage(input: {
  buffer: Buffer
  result: AnalysisResult
  context: Awaited<ReturnType<typeof inspectPdfForRemediation>>
  previousActionNames: string[]
  inspectionCache: RemediationInspectionCache
  maxCandidates?: number
}): Promise<{
  buffer: Buffer
  result: AnalysisResult
  actions: RemediationActionRecord[]
  manualReviewFlags: ModelReviewFlag[]
  usedInheritedVeraPdf: boolean
}> {
  if (!heuristicEligibleFigureCandidates(input.context).length) {
    return { buffer: input.buffer, result: input.result, actions: [], manualReviewFlags: [], usedInheritedVeraPdf: false }
  }

  let workingBuffer = input.buffer
  let currentResult = input.result
  const actions: RemediationActionRecord[] = []
  let context = input.context
  let usedInheritedVeraPdf = false
  const attemptedTargets = new Set<string>()
  const maxCandidates = Math.max(1, input.maxCandidates ?? Number.MAX_SAFE_INTEGER)

  while (attemptedTargets.size < maxCandidates) {
    const candidate = heuristicEligibleFigureCandidates(context).find(entry => {
      const stableKey = entry.targetRef || entry.id
      return !attemptedTargets.has(stableKey)
        && shouldRetryLateHeuristicFigureCandidate(entry, input.previousActionNames)
    })
    if (!candidate) break
    attemptedTargets.add(candidate.targetRef || candidate.id)
    const call = {
      tool_name: 'set_figure_alt_text' as const,
      arguments: {
        candidateId: candidate.id,
        altText: heuristicFigureAltText(candidate.id, context),
        generationSource: 'heuristic_fallback' as const,
      },
      rationale: `Heuristic fallback after AI figure generation was unavailable for page ${candidate.pageNumber}.`,
      confidence: 0.55,
      familyId: 'native_figure_convergence' as const,
      expectedPostconditions: ['figure_blocking_keys_shrink', 'alt_text_improves'],
    }
    const outcome = await executeRemediationTool({ buffer: workingBuffer, context, call })
    workingBuffer = outcome.buffer
    actions.push(outcome.action)
    if (outcome.action.changedDocumentBytes) {
      currentResult = await analyzeIntermediatePdf(workingBuffer, currentResult.filename || 'document.pdf', currentResult)
      usedInheritedVeraPdf = true
      context = await inspectPdfForRemediation(workingBuffer, currentResult, {
        inspectMode: 'light',
        cache: input.inspectionCache,
      })
    }
  }

  return { buffer: workingBuffer, result: currentResult, actions, manualReviewFlags: [], usedInheritedVeraPdf }
}

async function runSemanticEnrichmentStage(input: {
  buffer: Buffer
  filename: string
  result: AnalysisResult
  context: Awaited<ReturnType<typeof inspectPdfForRemediation>>
  originalResult: AnalysisResult
  currentTitle: string
  currentLanguage: string
  previousActionNames: string[]
  inspectionCache: RemediationInspectionCache
  signal?: AbortSignal
  onProgress?: (progress: { stage: string; percent: number }) => void
  rejectedActions: RemediationActionRecord[]
  semanticStrategy?: SemanticStrategy
}): Promise<{
  buffer: Buffer
  result: AnalysisResult
  actions: RemediationActionRecord[]
  manualReviewFlags: ModelReviewFlag[]
  usedInheritedVeraPdf: boolean
}> {
  const semanticStrategy = input.semanticStrategy || 'full_ai'
  if (!shouldRunSemanticStage(input.result, input.originalResult, input.context, semanticStrategy)) {
    return { buffer: input.buffer, result: input.result, actions: [], manualReviewFlags: [], usedInheritedVeraPdf: false }
  }
  const semanticArtifacts = buildFailureProfileArtifacts({
    analysis: input.result,
    context: input.context,
    actions: [],
    rejectedActions: input.rejectedActions,
  })
  const optionalSemanticFamilies = semanticArtifacts.failureProfile.residualFamilies.filter(family =>
    family.semanticPolicy === 'optional_after_deterministic' && family.blocking,
  )
  const implicitAiFigureWork = aiFirstFigureCandidates(input.context).length > 0
  const implicitBookmarkWork = bookmarkTargets(input.context).length > 0
  if (
    optionalSemanticFamilies.length > 0
    && !semanticSidecarEligibleFamilies(semanticArtifacts.failureProfile).length
    && !implicitAiFigureWork
    && !implicitBookmarkWork
  ) {
    return { buffer: input.buffer, result: input.result, actions: [], manualReviewFlags: [], usedInheritedVeraPdf: false }
  }

  if (semanticStrategy === 'heuristic_only') {
    const fallback = await runHeuristicFigureFallbackStage({
      buffer: input.buffer,
      result: input.result,
      context: input.context,
      previousActionNames: input.previousActionNames,
      inspectionCache: input.inspectionCache,
    })
    return {
      ...fallback,
      manualReviewFlags: fallback.actions.length
        ? [{
            code: 'semantic_strategy_heuristic_only',
            label: 'Heuristic semantic fallback applied',
            severity: 'warning',
            details: 'Classification selected heuristic-only semantic routing, so AI semantic generation was skipped.',
          }]
        : [],
    }
  }

  let context = input.context
  const originalAiFirstFigureCandidates = aiFirstFigureCandidates(context)
  input.onProgress?.({ stage: 'Generating semantic fixes', percent: 86 })
  let generated
  try {
    generated = await generateSemanticRepairBatches({
      buffer: input.buffer,
      filename: input.filename,
      title: input.currentTitle,
      language: input.currentLanguage,
      analysis: input.result,
      context,
    })
  } catch (error) {
    if (!isSemanticStageRecoverableProviderError(error)) {
      throw error
    }
    if (aiFirstFigureCandidates(context).length > 0) {
      const fallback = await runHeuristicFigureFallbackStage({
        buffer: input.buffer,
        result: input.result,
        context,
        previousActionNames: input.previousActionNames,
        inspectionCache: input.inspectionCache,
      })
      return {
        ...fallback,
        manualReviewFlags: [{
          code: 'semantic_sidecar_unavailable',
          label: 'Semantic sidecar unavailable',
          severity: 'warning',
          details: `${isSemanticStageTooLargeError(error) ? 'Semantic figure generation overflowed' : 'Semantic figure generation failed'}; heuristic alt-text fallback was used instead: ${error instanceof Error ? error.message : String(error || 'unknown error')}`,
        }],
      }
    }
    return {
      buffer: input.buffer,
      result: input.result,
      actions: [],
      manualReviewFlags: [{
        code: 'semantic_sidecar_unavailable',
        label: 'Semantic sidecar unavailable',
        severity: 'warning',
        details: `${isSemanticStageTooLargeError(error) ? 'Skipped semantic enrichment because the provider rejected the request as too large' : 'Skipped semantic enrichment because the provider request failed'}: ${error instanceof Error ? error.message : String(error || 'unknown error')}`,
      }],
      usedInheritedVeraPdf: false,
    }
  }
  const batches = generated.batches
  if (!batches.length) {
    if (aiFirstFigureCandidates(context).length > 0) {
      const fallback = await runHeuristicFigureFallbackStage({
        buffer: input.buffer,
        result: input.result,
        context,
        previousActionNames: input.previousActionNames,
        inspectionCache: input.inspectionCache,
      })
      return {
        ...fallback,
        manualReviewFlags: generated.reviewFlags,
      }
    }
    return { buffer: input.buffer, result: input.result, actions: [], manualReviewFlags: generated.reviewFlags, usedInheritedVeraPdf: false }
  }

  const manualReviewFlags: ModelReviewFlag[] = [...generated.reviewFlags]
  const acceptedActions: RemediationActionRecord[] = []
  let workingBuffer = input.buffer
  let currentResult = input.result
  let usedInheritedVeraPdf = false

  const executeSemanticCalls = async (
    plannedCalls: Array<{
      key: string
      categoryTargets: string[]
      call: Parameters<typeof executeRemediationTool>[0]['call']
    }>,
    batchContext: Awaited<ReturnType<typeof inspectPdfForRemediation>>,
    executionOptions?: {
      startBuffer?: Buffer
      baselineResult?: AnalysisResult
    },
  ): Promise<{
    buffer: Buffer
    actions: RemediationActionRecord[]
    manualReviewFlags: ModelReviewFlag[]
    changedDocument: boolean
    context: Awaited<ReturnType<typeof inspectPdfForRemediation>>
  }> => {
    const baselineResult = executionOptions?.baselineResult || currentResult
    let working = executionOptions?.startBuffer || workingBuffer
    let context = batchContext
    let changedDocument = false
    const actions: RemediationActionRecord[] = []
    let flags: ModelReviewFlag[] = []
    let index = 0

    while (index < plannedCalls.length) {
      const current = plannedCalls[index]!
      const currentCall = current.call as RemediationToolCall
      const currentMutation = buildBatchMutationForCall(currentCall, context)

      if (!currentMutation) {
        const outcome = await executeRemediationTool({
          buffer: working,
          context,
          call: current.call,
        })
        working = outcome.buffer
        actions.push(outcome.action)
        flags = mergeManualReviewFlags(flags, outcome.manualReviewFlags)
        changedDocument = changedDocument || !!outcome.action.changedDocumentBytes
        if (outcome.action.changedDocumentBytes) {
          context = await inspectPdfForRemediation(working, baselineResult, {
            cache: input.inspectionCache,
          })
        }
        index += 1
        continue
      }

      const cluster: typeof plannedCalls = [current]
      let lookahead = index + 1
      while (lookahead < plannedCalls.length) {
        const next = plannedCalls[lookahead]!
        const nextMutation = buildBatchMutationForCall(next.call as RemediationToolCall, context)
        if (!nextMutation) break
        cluster.push(next)
        lookahead += 1
      }

      if (cluster.length === 1) {
        const outcome = await executeRemediationTool({
          buffer: working,
          context,
          call: current.call,
        })
        working = outcome.buffer
        actions.push(outcome.action)
        flags = mergeManualReviewFlags(flags, outcome.manualReviewFlags)
        changedDocument = changedDocument || !!outcome.action.changedDocumentBytes
        if (outcome.action.changedDocumentBytes) {
          context = await inspectPdfForRemediation(working, baselineResult, {
            cache: input.inspectionCache,
          })
        }
        index += 1
        continue
      }

      const mutations = cluster.map(entry => buildBatchMutationForCall(entry.call as RemediationToolCall, context)!)
      const batchResult = await runPdfStructureBackendBatch({
        buffer: working,
        mutations,
        includeSnapshot: false,
        inspectMode: inspectModeForResult(baselineResult),
      })
      const operationResults = batchResult.operationResults || []
      const validBatch = batchResult.status !== 'failed'
        && operationResults.length === cluster.length
        && (!operationResults.some(result => result.changedDocumentBytes) || !!batchResult.outputBuffer)

      if (!validBatch) {
        for (const planned of cluster) {
          const outcome = await executeRemediationTool({
            buffer: working,
            context,
            call: planned.call,
          })
          working = outcome.buffer
          actions.push(outcome.action)
          flags = mergeManualReviewFlags(flags, outcome.manualReviewFlags)
          changedDocument = changedDocument || !!outcome.action.changedDocumentBytes
          if (outcome.action.changedDocumentBytes) {
            context = await inspectPdfForRemediation(working, baselineResult, {
              cache: input.inspectionCache,
            })
          }
        }
        index = lookahead
        continue
      }

      const batchActions = cluster.map((planned, clusterIndex) => {
        const translated = toBatchActionRecord({
          call: planned.call as RemediationToolCall,
          operationResult: operationResults[clusterIndex],
        })
        flags = mergeManualReviewFlags(flags, translated.manualReviewFlags)
        return translated.action
      })
      actions.push(...batchActions)
      if (batchResult.outputBuffer) {
        working = batchResult.outputBuffer
      }
      if (operationResults.some(result => result.changedDocumentBytes)) {
        changedDocument = true
        context = buildRemediationContextFromSnapshot({
          analysis: baselineResult,
          qpdf: context.qpdf,
          pdfjs: context.pdfjs,
          pages: context.pages,
          structure: batchResult,
          inspectMode: inspectModeForResult(baselineResult),
          cache: input.inspectionCache,
        })
      }
      index = lookahead
    }

    return { buffer: working, actions, manualReviewFlags: flags, changedDocument, context }
  }

  for (const batch of batches) {
    const batchThreshold = semanticThreshold(batch.batchType)
    const deferredActions: RemediationActionRecord[] = []
    const plannedCalls: Array<{
      key: string
      categoryTargets: string[]
      call: Parameters<typeof executeRemediationTool>[0]['call']
    }> = []

    if (batch.batchType === 'headings') {
      for (const proposal of batch.headings) {
        const candidate = context.headingCandidates.find(entry => entry.id === proposal.candidateId)
        const key = `create_heading_from_candidate:${proposal.candidateId}`
        const details = `AI heading proposal (${Math.round(proposal.confidence * 100)}%): ${proposal.rationale || `Use ${proposal.level} for "${candidate?.text || proposal.candidateId}".`}`
        if (!candidate || candidate.repairMode !== 'safe' || input.previousActionNames.includes(key) || proposal.confidence < batchThreshold) {
          deferredActions.push(semanticDeferredAction({
            tool: 'create_heading_from_candidate',
            target: `page ${candidate?.pageNumber || 0}`,
            candidateId: proposal.candidateId,
            confidence: proposal.confidence,
            details,
            categoryTargets: ['heading_structure'],
          }))
          continue
        }
        plannedCalls.push({
          key,
          categoryTargets: ['heading_structure'],
          call: {
            tool_name: 'create_heading_from_candidate',
            arguments: { candidateId: proposal.candidateId, level: proposal.level },
            rationale: details,
            confidence: proposal.confidence,
            familyId: 'post_bootstrap_heading_convergence',
            expectedPostconditions: ['heading_structure_improves'],
          },
        })
      }
    } else if (batch.batchType === 'figures') {
      for (const proposal of batch.figures) {
        const candidate = context.figureCandidates.find(entry => entry.id === proposal.candidateId)
        const tool = proposal.decorative ? 'mark_figure_decorative' : 'set_figure_alt_text'
        const key = `${tool}:${proposal.candidateId}`
        const details = proposal.decorative
          ? `AI figure proposal (${Math.round(proposal.confidence * 100)}%): mark as decorative. ${proposal.rationale}`
          : `AI figure proposal (${Math.round(proposal.confidence * 100)}%): ${proposal.altText}. ${proposal.rationale}`
        const semanticAiEligibleDeferredCandidate = !!candidate
          && candidate.repairMode === 'defer'
          && (candidate.imageEvidence === 'strong' || candidate.imageEvidence === 'vector')
          && !!candidate.targetTag
          && candidate.unsafeReason?.startsWith('text_heavy_candidate:')
        if (!candidate || (candidate.repairMode === 'defer' && !semanticAiEligibleDeferredCandidate) || input.previousActionNames.includes(key) || proposal.confidence < batchThreshold || (!proposal.decorative && !proposal.altText)) {
          deferredActions.push(semanticDeferredAction({
            tool,
            target: `page ${candidate?.pageNumber || 0}`,
            candidateId: proposal.candidateId,
            confidence: proposal.confidence,
            details,
            categoryTargets: ['alt_text'],
            generationSource: 'manual_deferred',
          }))
          continue
        }
        plannedCalls.push({
          key,
          categoryTargets: ['alt_text'],
          call: {
            tool_name: tool,
            arguments: { candidateId: proposal.candidateId, altText: proposal.altText, generationSource: 'semantic_ai' },
            rationale: details,
            confidence: proposal.confidence,
            familyId: 'native_figure_convergence',
            expectedPostconditions: ['figure_blocking_keys_shrink', 'alt_text_improves'],
          },
        })
      }
    } else if (batch.batchType === 'tables') {
      for (const proposal of batch.tables) {
        const candidate = context.tableCandidates.find(entry => entry.id === proposal.candidateId)
        const key = `set_table_header_cells:${proposal.candidateId}`
        const details = `AI table proposal (${Math.round(proposal.confidence * 100)}%): ${proposal.useFirstRowAsHeader ? 'promote first row to headers' : 'do not auto-promote first row'}. ${proposal.rationale}`
        if (
          !candidate
          || candidate.repairMode !== 'safe'
          || input.previousActionNames.includes(key)
          || proposal.confidence < batchThreshold
          || !proposal.useFirstRowAsHeader
        ) {
          deferredActions.push(semanticDeferredAction({
            tool: 'set_table_header_cells',
            target: candidate ? `table ${candidate.ref}` : 'document',
            candidateId: proposal.candidateId,
            confidence: proposal.confidence,
            details,
            categoryTargets: ['table_markup'],
          }))
          continue
        }
        plannedCalls.push({
          key,
          categoryTargets: ['table_markup'],
          call: {
            tool_name: 'set_table_header_cells',
            arguments: { targets: [candidate.ref] },
            rationale: details,
            confidence: proposal.confidence,
            familyId: 'table_structure_recovery',
            expectedPostconditions: ['table_blocking_keys_shrink', 'table_markup_improves'],
          },
        })
      }
    } else if (batch.batchType === 'links') {
      for (const proposal of batch.links) {
        const candidate = context.linkCandidates.find(entry => entry.id === proposal.candidateId)
        const details = `AI link proposal (${Math.round(proposal.confidence * 100)}%): "${proposal.replacementText || proposal.annotationContents}". ${proposal.rationale}`
        if (!candidate || proposal.confidence < batchThreshold) {
          deferredActions.push(semanticDeferredAction({
            tool: 'set_link_annotation_contents',
            target: `page ${candidate?.pageNumber || 0}`,
            candidateId: proposal.candidateId,
            confidence: proposal.confidence,
            details,
            categoryTargets: ['link_quality'],
          }))
          continue
        }
        if (candidate.rawUrl && proposal.replacementText && proposal.replacementText !== candidate.text && !input.previousActionNames.includes(`rewrite_link_visible_text:${proposal.candidateId}`)) {
          plannedCalls.push({
            key: `rewrite_link_visible_text:${proposal.candidateId}`,
            categoryTargets: ['link_quality'],
            call: {
              tool_name: 'rewrite_link_visible_text',
              arguments: { candidateId: proposal.candidateId, replacementText: proposal.replacementText },
              rationale: details,
              confidence: proposal.confidence,
              familyId: 'link_tabs_and_annotation_cleanup',
              expectedPostconditions: ['link_blocking_keys_shrink'],
            },
          })
        }
        if (proposal.annotationContents && (!candidate.annotationContents || candidate.annotationContents !== proposal.annotationContents) && !input.previousActionNames.includes(`set_link_annotation_contents:${proposal.candidateId}`)) {
          plannedCalls.push({
            key: `set_link_annotation_contents:${proposal.candidateId}`,
            categoryTargets: ['link_quality'],
            call: {
              tool_name: 'set_link_annotation_contents',
              arguments: {
                candidateId: proposal.candidateId,
                pageNumber: candidate.pageNumber,
                annotationIndex: candidate.annotationIndex,
                contents: proposal.annotationContents,
              },
              rationale: details,
              confidence: proposal.confidence,
              familyId: 'link_tabs_and_annotation_cleanup',
              expectedPostconditions: ['annotation_alt_clear', 'link_blocking_keys_shrink'],
            },
          })
        }
      }
    } else if (batch.batchType === 'bookmarks') {
      const headings = batch.bookmarks
        .filter(proposal => proposal.confidence >= batchThreshold && proposal.title)
        .map(proposal => {
          const candidate = context.headingCandidates.find(entry => entry.id === proposal.candidateId)
          const pageNumber = proposal.pageNumber ?? candidate?.pageNumber
          const targetRef = proposal.targetRef ?? candidate?.targetRef ?? null
          if (!Number.isFinite(pageNumber)) return null
          return {
            text: proposal.title,
            level: proposal.level,
            targetRef,
            pageNumber,
          }
        })
        .filter(Boolean)
      const fallbackHeadings = bookmarkTargets(context)
        .map(candidate => ({
          text: candidate.text,
          level: candidate.pageNumber === 1 ? 'H1' as const : 'H2' as const,
          targetRef: candidate.targetRef || undefined,
          pageNumber: candidate.pageNumber,
        }))
      const selectedHeadings = headings.length ? headings : fallbackHeadings
      const key = 'replace_bookmarks_from_headings:document'
      const proposalConfidence = batch.bookmarks.length ? Math.max(...batch.bookmarks.map(entry => entry.confidence)) : 0.55
      if (!selectedHeadings.length || input.previousActionNames.includes(key)) {
        deferredActions.push(semanticDeferredAction({
          tool: 'replace_bookmarks_from_headings',
          target: 'document',
          candidateId: 'document',
          confidence: batch.bookmarks.length ? proposalConfidence : 0,
          details: 'Bookmark proposal did not produce usable bookmark titles.',
          categoryTargets: ['bookmarks'],
        }))
      } else {
        plannedCalls.push({
          key,
          categoryTargets: ['bookmarks'],
          call: {
            tool_name: 'replace_bookmarks_from_headings',
            arguments: { headings: selectedHeadings },
            rationale: headings.length
              ? `AI bookmark cleanup (${selectedHeadings.length} entries): replace noisy bookmark titles with concise semantic labels.`
              : `Deterministic bookmark cleanup (${selectedHeadings.length} entries): synthesize bookmarks from cleaned heading targets.`,
            confidence: headings.length ? Math.min(0.98, proposalConfidence) : 0.55,
            familyId: 'bookmark_language_outline_cleanup',
            expectedPostconditions: ['bookmark_blocking_keys_shrink', 'bookmark_score_improves'],
          },
        })
      }
    }

    acceptedActions.push(...deferredActions)
    if (!plannedCalls.length) continue

    input.onProgress?.({ stage: `Applying semantic fixes: ${batch.batchType}`, percent: 89 })
    const batchStartBuffer = workingBuffer
    const batchStartResult = currentResult
    const batchStartContext = context
    const batchActions: RemediationActionRecord[] = []
    const executedBatch = await executeSemanticCalls(plannedCalls, context)
    const batchBuffer = executedBatch.buffer
    const batchChanged = executedBatch.changedDocument
    const batchFlags = executedBatch.manualReviewFlags
    batchActions.push(...executedBatch.actions)

    if (!batchChanged) {
      acceptedActions.push(...batchActions)
      manualReviewFlags.push(...batchFlags)
      context = executedBatch.context
      continue
    }

    const analyzedBatch = await analyzePDF(batchBuffer, input.filename, {
      analysisProfile: 'remediation_fast',
      signal: input.signal,
      skipAdobe: true,
      inheritedVeraPdf: batchStartResult.verapdf,
    })
    usedInheritedVeraPdf = true
    const targetedCategories = [...new Set(batchActions.flatMap(action => action.categoryTargets || []))]
    const hasCategoryRegression = targetedCategories.some(categoryId => categoryRegression(batchStartResult, analyzedBatch, categoryId))
    const hasVisibleRegression = batchActions.some(action =>
      !!shouldRejectNativeVisibleRewrite(batchStartResult, analyzedBatch, action)
    )
    const hasStandardsRegression = batchActions.some(action =>
      !!hasNativeStandardsRegression(batchStartResult, analyzedBatch, action.tool)
    )

    if (hasCategoryRegression || hasVisibleRegression || hasStandardsRegression) {
      const candidateIndexes = isolationCandidateIndexes(batchActions)
      let isolated = false

      if (candidateIndexes.length >= 2) {
        for (let removeCount = 1; removeCount <= candidateIndexes.length; removeCount += 1) {
          const removedIndexes = new Set(candidateIndexes.slice(-removeCount))
          const retainedCalls = plannedCalls.filter((_, index) => !removedIndexes.has(index))
          if (!retainedCalls.length) continue

          const replayedBatch = await executeSemanticCalls(retainedCalls, context, {
            startBuffer: batchStartBuffer,
            baselineResult: batchStartResult,
          })

          if (!replayedBatch.changedDocument) {
            const rejectedActions = batchActions
              .filter((_, index) => removedIndexes.has(index))
              .map(action => rejectActionForRegression(
                action,
                'the semantic batch regressed validation or targeted scores',
                true,
              ))
            acceptedActions.push(...replayedBatch.actions, ...rejectedActions)
            input.rejectedActions.push(...rejectedActions)
            manualReviewFlags.push(...mergeManualReviewFlags(replayedBatch.manualReviewFlags, [{
              code: `semantic_${batch.batchType}_isolated_regression`,
              label: 'AI semantic repair isolated',
              severity: 'warning',
              details: `Rejected isolated ${batch.batchType} semantic repairs after replay showed the remaining calls were safe.`,
            }]))
            workingBuffer = batchStartBuffer
            currentResult = batchStartResult
            context = batchStartContext
            usedInheritedVeraPdf = false
            isolated = true
            break
          }

          const analyzedReplay = await analyzePDF(replayedBatch.buffer, input.filename, {
            analysisProfile: 'remediation_fast',
            signal: input.signal,
            skipAdobe: true,
            inheritedVeraPdf: batchStartResult.verapdf,
          })
          usedInheritedVeraPdf = true
          const replayTargetedCategories = [...new Set(replayedBatch.actions.flatMap(action => action.categoryTargets || []))]
          const replayHasCategoryRegression = replayTargetedCategories.some(categoryId => categoryRegression(batchStartResult, analyzedReplay, categoryId))
          const replayHasVisibleRegression = replayedBatch.actions.some(action =>
            !!shouldRejectNativeVisibleRewrite(batchStartResult, analyzedReplay, action)
          )
          const replayHasStandardsRegression = replayedBatch.actions.some(action =>
            !!hasNativeStandardsRegression(batchStartResult, analyzedReplay, action.tool)
          )
          if (replayHasCategoryRegression || replayHasVisibleRegression || replayHasStandardsRegression) {
            continue
          }

          for (const action of replayedBatch.actions) {
            const targets = action.categoryTargets || []
            action.scoreDelta = targets.map(categoryId => ({
              categoryId,
              before: scoreForCategory(batchStartResult, categoryId),
              after: scoreForCategory(analyzedReplay, categoryId),
            }))
            if (action.outcome === 'applied' && action.scoreDelta.length && !action.scoreDelta.some(delta => (delta.after ?? -1) > (delta.before ?? -1))) {
              action.outcome = 'no_effect'
            }
          }

          const rejectedActions = batchActions
            .filter((_, index) => removedIndexes.has(index))
            .map(action => rejectActionForRegression(
              action,
              'the semantic batch regressed validation or targeted scores',
              true,
            ))
          acceptedActions.push(...replayedBatch.actions, ...rejectedActions)
          input.rejectedActions.push(...rejectedActions)
          manualReviewFlags.push(...mergeManualReviewFlags(replayedBatch.manualReviewFlags, [{
            code: `semantic_${batch.batchType}_isolated_regression`,
            label: 'AI semantic repair isolated',
            severity: 'warning',
            details: `Rejected isolated ${batch.batchType} semantic repairs after replay showed the remaining calls were safe.`,
          }]))
          workingBuffer = replayedBatch.buffer
          currentResult = analyzedReplay
          context = replayedBatch.context
          usedInheritedVeraPdf = true
          isolated = true
          break
        }
      }

      if (isolated) continue

      for (const action of batchActions) {
        const rejected = rejectActionForRegression(
          action,
          'the semantic batch regressed validation or category scores',
          false,
        )
        acceptedActions.push(rejected)
        input.rejectedActions.push(rejected)
      }
      manualReviewFlags.push(...mergeManualReviewFlags(batchFlags, [{
        code: `semantic_${batch.batchType}_rejected`,
        label: 'AI semantic repair rejected',
        severity: 'warning',
        details: `Rejected ${batch.batchType} semantic repairs because they regressed validation or targeted scores.`,
      }]))
      workingBuffer = batchStartBuffer
      currentResult = batchStartResult
      context = await inspectPdfForRemediation(workingBuffer, currentResult, {
        cache: input.inspectionCache,
      })
      usedInheritedVeraPdf = false
      continue
    }

    for (const action of batchActions) {
      const targets = action.categoryTargets || []
      action.scoreDelta = targets.map(categoryId => ({
        categoryId,
        before: scoreForCategory(batchStartResult, categoryId),
        after: scoreForCategory(analyzedBatch, categoryId),
      }))
      if (action.outcome === 'applied' && action.scoreDelta.length && !action.scoreDelta.some(delta => (delta.after ?? -1) > (delta.before ?? -1))) {
        action.outcome = 'no_effect'
      }
    }

    acceptedActions.push(...batchActions)
    manualReviewFlags.push(...batchFlags)
    workingBuffer = batchBuffer
    currentResult = analyzedBatch
    context = await inspectPdfForRemediation(workingBuffer, currentResult, {
      cache: input.inspectionCache,
    })
  }

  const skippedFigureSemanticWork = generated.reviewFlags.some(flag =>
    (flag.code === 'semantic_enrichment_skipped' || flag.code === 'semantic_sidecar_unavailable')
      && /figures semantic enrichment/i.test(flag.details),
  )
  const hasAltTextActions = acceptedActions.some(action =>
    action.categoryTargets?.includes('alt_text') && (action.generationSource === 'semantic_ai' || action.generationSource === 'heuristic_fallback'),
  )
  if (skippedFigureSemanticWork && originalAiFirstFigureCandidates.length > 0) {
    const fallback = await runHeuristicFigureFallbackStage({
      buffer: workingBuffer,
      result: currentResult,
      context,
      previousActionNames: [
        ...input.previousActionNames,
        ...acceptedActions.map(action => `${action.tool}:${action.candidateGroupId || action.candidateId || action.target}`),
      ],
      inspectionCache: input.inspectionCache,
    })
    workingBuffer = fallback.buffer
    currentResult = fallback.result
    acceptedActions.push(...fallback.actions)
    manualReviewFlags.push(...fallback.manualReviewFlags)
    usedInheritedVeraPdf = usedInheritedVeraPdf || fallback.usedInheritedVeraPdf
    if (!hasAltTextActions && fallback.actions.length) {
      manualReviewFlags.push({
        code: 'semantic_figure_fallback_applied',
        label: 'Heuristic figure fallback applied',
        severity: 'warning',
        details: 'Semantic figure generation was skipped for one or more targets, so heuristic figure alt text was applied as a last resort.',
      })
    }
  }

  return {
    buffer: workingBuffer,
    result: currentResult,
    actions: acceptedActions,
    manualReviewFlags: mergeManualReviewFlags([], manualReviewFlags),
    usedInheritedVeraPdf,
  }
}

export async function remediatePdfWithAgent(
  originalBuffer: Buffer,
  filename: string,
  originalResult: AnalysisResult,
  options?: {
    artifactsDir?: string
    signal?: AbortSignal
    onProgress?: (progress: { stage: string; percent: number }) => void
    onCheckpoint?: (model: DocumentModel) => Promise<void> | void
  },
): Promise<ReconstructionOutput & {
  buffer: Buffer
  finalResult: AnalysisResult
}> {
  const remediationStartedAt = Date.now()
  let workingBuffer = originalBuffer
  let currentResult = originalResult
  let currentResultHasFreshVeraPdf = true
  let previousActionNames: string[] = []
  let currentTitle = filename.replace(/\.pdf$/i, '')
  let currentLanguage = 'en'
  let pathFallbacks: string[] = []
  let visibleContentChangePolicy: DocumentModel['visibleContentChangePolicy'] = 'limited_text_rewrites'
  const iterations: RemediationIteration[] = []
  const actions: RemediationActionRecord[] = []
  const rejectedActions: RemediationActionRecord[] = []
  let manualReviewFlags: ModelReviewFlag[] = []
  let nativeTaggedSafeMode = false
  let skipDirectToFinalCleanup = false
  let matchedPlaybook: PlaybookEntry | null = null
  let matchedPlaybookRun: PlaybookRun | null = null
  let playbookFastPathSucceeded = false
  let playbookInitialArtifacts: ReturnType<typeof buildFailureProfileArtifacts> | null = null
  let playbookInitialAnalysis: AnalysisResult | null = null
  let playbookInitialContext: Awaited<ReturnType<typeof inspectPdfForRemediation>> | null = null
  let playbookInitialSignature: ReturnType<typeof buildFailureSignature> | null = null
  let latestContext: Awaited<ReturnType<typeof inspectPdfForRemediation>> | null = null
  let altTextSidecar = await loadAltTextSidecar(options?.artifactsDir)
  let currentClassification: PdfClassification | undefined
  let currentPipelineConfig: PipelineConfig | undefined
  const stagesRun = new Set<number>()
  const inspectionCache: RemediationInspectionCache = {}
  const inspectionState: InspectionDirtinessState = {
    structureDirty: true,
    deepAltDirty: true,
    semanticDirty: true,
  }
  const remediationTimings: RemediationTimingSummary = {
    totalMs: 0,
    intermediateAnalyses: 0,
    lightInspections: 0,
    deepInspections: 0,
    roundsExecuted: 0,
    stagesExecuted: 0,
  }
  const remediationMetrics: RemediationMetricsState = {
    inspections: {
      lightFresh: 0,
      lightReused: 0,
      deepFresh: 0,
      deepReused: 0,
      deepDowngradedToLight: 0,
    },
    phases: {
      ownership_state: createInspectionPhaseTracker(),
      figure_description_state: createInspectionPhaseTracker(),
      structure_state: createInspectionPhaseTracker(),
    },
    ownershipRiskInitial: null,
    figureMissingAltInitial: null,
    decorativeFigureInitial: null,
    structureDeepFreshAnalyses: 0,
    structureDeepAnalysesDowngraded: 0,
    residualCleanup: {
      dominantFamily: 'unknown',
    },
    providerRouting: {
      byEndpointLabel: {},
      byService: {},
      livenessBypassCount: 0,
    },
  }
  const latePhaseConvergence: Record<InspectionPhase, LatePhaseConvergenceTracker> = {
    ownership_state: createLatePhaseConvergenceTracker(),
    figure_description_state: createLatePhaseConvergenceTracker(),
    structure_state: createLatePhaseConvergenceTracker(),
  }
  const residualCleanupTracker = createResidualCleanupTracker()
  const lightVerificationLoopState: LightVerificationLoopState = {
    lastMutationChangedDocument: true,
  }
  const absorbProviderTelemetry = (serviceName: string): void => {
    const records = consumeOpenAiCompatAttemptRecords(serviceName)
    for (const record of records) {
      remediationMetrics.providerRouting.byService[serviceName] = (remediationMetrics.providerRouting.byService[serviceName] || 0) + 1
      if (record.outcome === 'success') {
        remediationMetrics.providerRouting.byEndpointLabel[record.label] = (remediationMetrics.providerRouting.byEndpointLabel[record.label] || 0) + 1
      }
      if (record.outcome === 'skipped_unreachable') {
        remediationMetrics.providerRouting.livenessBypassCount += 1
      }
    }
  }
  let pdfClass: PdfClass = classifyPdf({ analysis: originalResult, context: null })

  const refreshClassification = (analysis: AnalysisResult, context: Awaited<ReturnType<typeof inspectPdfForRemediation>> | null): void => {
    currentClassification = classifyPdfFull({
      analysis,
      context: context
        ? {
            qpdf: context.qpdf,
            pdfjs: context.pdfjs,
          }
        : null,
    })
    currentPipelineConfig = buildPipelineConfig(currentClassification)
    pdfClass = classifyPdf({ analysis, context })
  }

  const resetInspectionPhasesForTool = (tool: string): void => {
    const resetPhase = (phase: InspectionPhase) => {
      remediationMetrics.phases[phase].stableRepeats = 0
      remediationMetrics.phases[phase].lastSignature = undefined
      remediationMetrics.phases[phase].downgradedToLight = false
    }
    if (OWNERSHIP_STATE_TOOLS.has(tool)) resetPhase('ownership_state')
    if (FIGURE_DESCRIPTION_STATE_TOOLS.has(tool)) resetPhase('figure_description_state')
    if (STRUCTURE_STATE_TOOLS.has(tool)) resetPhase('structure_state')
  }

  const recordInspectionPhaseState = (
    phase: InspectionPhase,
    signature: string,
    options: { fresh: boolean },
  ): void => {
    const tracker = remediationMetrics.phases[phase]
    if (options.fresh) {
      tracker.freshDeepInspections += 1
    } else {
      tracker.reusedInspections += 1
    }
    if (tracker.lastSignature === signature) {
      tracker.stableRepeats += 1
    } else {
      tracker.lastSignature = signature
      tracker.stableRepeats = 0
    }
    if (tracker.stableRepeats >= 1) {
      tracker.downgradedToLight = true
    }
  }

  const activeDeepInspectionPhase = (
    analysis: AnalysisResult,
    context: PdfRemediationContext | null | undefined,
  ): InspectionPhase | null => {
    const blockingKeys = blockingLocalFindingKeys(analysis)
    if (
      acrobatOwnershipRiskCount(context ?? null) > 0
      || blockingKeys.includes('pdfua.untagged_rendered_images')
      || blockingKeys.includes('pdfua.nested_alt_text')
    ) {
      return 'ownership_state'
    }
    if (
      blockingKeys.includes('pdfua.figure_alt_or_artifact')
      || hasUnresolvedCategoryLabel(analysis, 'Alt Text on Images')
    ) {
      return 'figure_description_state'
    }
    if (
      blockingKeys.includes('pdfua.logical_structure')
      || blockingKeys.includes('pdfua.heading_content_quality')
      || blockingKeys.includes('pdfua.table_regularity')
      || hasUnresolvedCategoryLabel(analysis, 'Heading Structure')
      || hasUnresolvedCategoryLabel(analysis, 'Reading Order')
      || hasUnresolvedCategoryLabel(analysis, 'Table Markup')
    ) {
      return 'structure_state'
    }
    return null
  }

  const deepInspectionSignatureForPhase = (
    phase: InspectionPhase,
    analysis: AnalysisResult,
    context: PdfRemediationContext | null | undefined,
  ): string => {
    switch (phase) {
      case 'ownership_state':
        return ownershipStateSignature(analysis, context)
      case 'figure_description_state':
        return figureDescriptionStateSignature(analysis, context)
      case 'structure_state':
        return structureStateSignature(analysis)
    }
  }

  const shouldDowngradeDeepInspectToLight = (
    analysis: AnalysisResult,
    context: PdfRemediationContext | null | undefined,
  ): boolean => {
    const phase = activeDeepInspectionPhase(analysis, context)
    if (!phase) return false
    return remediationMetrics.phases[phase].downgradedToLight
  }

  const shouldPreferDeepStructureInspect = (
    requested: boolean,
    result: AnalysisResult,
  ): boolean => {
    if (!requested) return false
    if (!remediationMetrics.phases.structure_state.downgradedToLight) {
      remediationMetrics.structureDeepFreshAnalyses += 1
      return true
    }
    remediationMetrics.structureDeepAnalysesDowngraded += 1
    return false
  }

  const noteDocumentMutation = (action: RemediationActionRecord): void => {
    markInspectionDirtyFromAction(inspectionState, action)
    if (action.changedDocumentBytes && action.outcome !== 'rejected') {
      lightVerificationLoopState.lastMutationChangedDocument = true
      if (OWNERSHIP_STATE_TOOLS.has(action.tool)) latePhaseConvergence.ownership_state.lastMutationChangedDocument = true
      if (FIGURE_DESCRIPTION_STATE_TOOLS.has(action.tool)) latePhaseConvergence.figure_description_state.lastMutationChangedDocument = true
      if (STRUCTURE_STATE_TOOLS.has(action.tool)) latePhaseConvergence.structure_state.lastMutationChangedDocument = true
      resetInspectionPhasesForTool(action.tool)
    }
  }

  const markLatePhaseConverged = (phase: InspectionPhase): void => {
    latePhaseConvergence[phase].converged = true
    remediationMetrics.phases[phase].lateConverged = true
  }

  const setFigureDescriptionStopReason = (reason: FigureDescriptionStopReason): void => {
    remediationMetrics.phases.figure_description_state.finalStopReason = reason
  }

  const setResidualCleanupStopReason = (reason: ResidualCleanupStopReason): void => {
    remediationMetrics.residualCleanup.finalStopReason = reason
    if (
      reason === 'same_family_no_progress'
      || reason === 'no_mutation'
      || reason === 'budget_exhausted'
      || reason === 'structure_debt_cleared_figure_debt_remaining'
      || reason === 'figure_debt_cleared_structure_debt_remaining'
      || reason === 'mixed_figure_structure_separation_required'
      || reason === 'mixed_runtime_churn_without_family_shrink'
      || reason === 'mixed_large_runtime_profile_requires_serial_terminalization'
    ) {
      remediationMetrics.phases.structure_state.residualFinalStopReason = reason
    }
  }

  const markResidualCleanupBucketConverged = (bucket: ResidualCleanupFamilyBucket): void => {
    if (bucket === 'unknown') return
    if (bucket === 'mixed') {
      residualCleanupTracker.convergedBuckets.mixed = true
      return
    }
    residualCleanupTracker.convergedBuckets[bucket] = true
  }

  const updateResidualCleanupProgress = (input: {
    familyId?: ResidualFamilyDecision['id'] | null
    bucket: ResidualCleanupFamilyBucket
    before: ResidualCleanupProgressSnapshot
    afterAnalysis: AnalysisResult
    afterContext: PdfRemediationContext | null | undefined
    changedDocumentBytes: boolean
  }): boolean => {
    const previousFamilyId = residualCleanupTracker.lastFamilyId || null
    const afterDominantFamily = residualCleanupDominantFamily(input.afterAnalysis, input.afterContext)
    const after = buildResidualCleanupProgressSnapshot(input.bucket, input.afterAnalysis, input.afterContext)
    const improved = didResidualCleanupProgressImprove(input.before, after, input.changedDocumentBytes)
    residualCleanupTracker.lastFamilyId = input.familyId || null
    residualCleanupTracker.lastBucket = input.bucket
    residualCleanupTracker.lastSnapshot = after
    residualCleanupTracker.lastMutationChangedDocument = input.changedDocumentBytes
    residualCleanupTracker.lastProgressed = improved
    remediationMetrics.residualCleanup.dominantFamily = afterDominantFamily
    if (!input.changedDocumentBytes) {
      markResidualCleanupBucketConverged(input.bucket)
      setResidualCleanupStopReason('no_mutation')
      return false
    }
    if (!improved) {
      markResidualCleanupBucketConverged(input.bucket)
      setResidualCleanupStopReason(
        deriveResidualCleanupTransitionStopReason({
          beforeBucket: input.bucket,
          afterBucket: afterDominantFamily,
          improved,
        }) || 'same_family_no_progress',
      )
      return false
    }
    if (afterDominantFamily !== 'unknown' && afterDominantFamily !== input.bucket) {
      setResidualCleanupStopReason(
        deriveResidualCleanupTransitionStopReason({
          beforeBucket: input.bucket,
          afterBucket: afterDominantFamily,
          improved,
        }) || 'family_shifted',
      )
    } else if (input.familyId && previousFamilyId && previousFamilyId !== input.familyId) {
      setResidualCleanupStopReason('family_shifted')
    }
    return true
  }

  const updateLatePhaseProgress = (input: {
    phase: InspectionPhase
    before: PhaseProgressSnapshot
    afterAnalysis: AnalysisResult
    afterContext: PdfRemediationContext | null | undefined
    changedDocumentBytes: boolean
    noProgressLimit: number
  }): boolean => {
    const tracker = latePhaseConvergence[input.phase]
    const after = buildPhaseProgressSnapshot(input.phase, input.afterAnalysis, input.afterContext)
    const improved = didLatePhaseProgressImprove(input.before, after, input.changedDocumentBytes)
    tracker.lastSnapshot = after
    tracker.lastMutationChangedDocument = false
    tracker.lastProgressed = improved
    if (improved) {
      tracker.noProgressPasses = 0
      return true
    }
    tracker.noProgressPasses += 1
    if (tracker.noProgressPasses >= input.noProgressLimit) {
      markLatePhaseConverged(input.phase)
    }
    return false
  }

  const stageEnabled = (stageNum: number): boolean => {
    if (!currentPipelineConfig) return true
    switch (stageNum) {
      case 1: return currentPipelineConfig.stages.metadata
      case 2: return currentPipelineConfig.stages.structureBootstrap
      case 3: return currentPipelineConfig.stages.linkStructure
      case 4: return currentPipelineConfig.stages.fonts
      case 5: return currentPipelineConfig.stages.nativeStructure
      case 6: return currentPipelineConfig.stages.safeCandidates
      default: return true
    }
  }

  const filterCallsForPipeline = (calls: RemediationToolCall[]): RemediationToolCall[] => {
    if (!currentPipelineConfig) return calls
    const excluded = new Set(currentPipelineConfig.excludedTools)
    return calls.filter(call => !excluded.has(call.tool_name))
  }

  const filterCallsForPipelineWithFamilyOverride = (
    calls: RemediationToolCall[],
    convergenceFamilies?: ResidualFamilyDecision[] | null,
  ): RemediationToolCall[] => {
    if (!currentPipelineConfig) return calls
    const excluded = new Set(currentPipelineConfig.excludedTools)
    return calls.filter(call =>
      !excluded.has(call.tool_name)
      || shouldAllowPipelineExcludedFamilyCall(call, convergenceFamilies),
    )
  }

  const maybeRefreshClassificationFromStage = async (stageActions: RemediationActionRecord[]): Promise<void> => {
    if (!stageActions.some(action =>
      action.changedDocumentBytes
      && action.outcome !== 'rejected'
      && RECLASSIFICATION_TRIGGER_TOOLS.has(action.tool),
    )) {
      return
    }
    stageContext = await inspectRemediationContext(workingBuffer, currentResult, inspectModeForResult(currentResult))
    currentTitle = stageContext.pdfjs.title || currentTitle
    currentLanguage = stageContext.qpdf.lang || stageContext.pdfjs.lang || currentLanguage
    refreshClassification(currentResult, stageContext)
  }

  const currentPipelineSummary = (): NonNullable<DocumentModel['pipelineConfig']> | null => {
    if (!currentPipelineConfig) return null
    return {
      stagesRun: [...stagesRun].sort((a, b) => a - b),
      excludedToolCount: currentPipelineConfig.excludedTools.length,
      maxRounds: currentPipelineConfig.maxRounds,
      earlyExitScore: currentPipelineConfig.earlyExitScore,
      semanticStrategy: currentPipelineConfig.semanticStrategy,
      structuralClass: currentClassification?.structuralClass || 'untagged_digital',
      authoringTool: currentClassification?.authoringTool || 'unknown',
      fontProfile: currentClassification?.fontProfile || 'needs_embedding',
    }
  }

  const persistStageToolOutcomes = (
    stageActions: RemediationActionRecord[],
    input: {
      previous: AnalysisResult
      next: AnalysisResult
      roundNumber: number
      stageNumber: number
      standardsImproved: boolean
      playbookId?: string | null
      playbookRunId?: string | null
    },
  ): void => {
    const previousBlockingKeys = (input.previous.localStandards?.findings ?? [])
      .filter(finding => finding.blocking)
      .map(finding => finding.key)
      .sort()
    const nextBlockingKeys = (input.next.localStandards?.findings ?? [])
      .filter(finding => finding.blocking)
      .map(finding => finding.key)
      .sort()
    const records = stageActions
      .filter(action =>
        action.outcome === 'applied'
        || action.outcome === 'no_effect'
        || action.outcome === 'rejected'
        || action.outcome === 'failed'
        || action.outcome === 'unsupported',
      )
      .map(action => {
        const categoryDeltas = actionScoreDelta(action, input.previous, input.next)
        const positiveTargetDelta = categoryDeltas.some(delta =>
          typeof delta.before === 'number'
          && typeof delta.after === 'number'
          && delta.after > delta.before,
        )
        return {
          toolName: action.tool,
          pdfClass,
          outcome: action.outcome as 'applied' | 'no_effect' | 'rejected' | 'failed' | 'unsupported',
          roundNumber: input.roundNumber,
          stageNumber: input.stageNumber,
          overallScoreBefore: input.previous.overallScore,
          overallScoreAfter: input.next.overallScore,
          categoryDeltas,
          reliabilitySuccess: (
            (action.outcome === 'applied' || action.outcome === 'no_effect')
            && (
              input.next.overallScore > input.previous.overallScore
              || positiveTargetDelta
              || input.standardsImproved
              || action.postconditionStatus === 'satisfied'
            )
          ),
          playbookId: input.playbookId || null,
          playbookRunId: input.playbookRunId || null,
        }
      })
    recordToolOutcomes(records)
    const familyRecords = stageActions
      .filter(action =>
        !!action.familyId
        && (
          action.outcome === 'applied'
          || action.outcome === 'no_effect'
          || action.outcome === 'rejected'
          || action.outcome === 'failed'
          || action.outcome === 'unsupported'
        ),
      )
      .map(action => ({
        familyId: action.familyId!,
        pdfClass,
        stepTool: action.tool,
        postconditionStatus: action.postconditionStatus || 'unknown',
        roundNumber: input.roundNumber,
        stageNumber: input.stageNumber,
        overallScoreBefore: input.previous.overallScore,
        overallScoreAfter: input.next.overallScore,
        blockingKeysBefore: previousBlockingKeys,
        blockingKeysAfter: nextBlockingKeys,
        playbookId: input.playbookId || null,
        playbookRunId: input.playbookRunId || null,
      }))
    recordFamilyOutcomes(familyRecords)
  }

  const syncInspectionCache = (
    context: Awaited<ReturnType<typeof inspectPdfForRemediation>>,
  ): void => {
    if (!hasInspectionPayload(context)) return
    inspectionCache.qpdf = context.qpdf
    inspectionCache.pdfjs = context.pdfjs
    inspectionCache.pages = context.pages
  }

  const rebindContextFromCache = (
    analysis: AnalysisResult,
    inspectMode: RemediationInspectMode = inspectModeForResult(analysis),
  ): Awaited<ReturnType<typeof inspectPdfForRemediation>> | null => {
    const payload = inspectionCache.contextsByMode?.[inspectMode]
      || inspectionCache.contextsByMode?.light
      || inspectionCache.contextsByMode?.alt_text_deep

    if (!payload) return null

    const rebound = buildRemediationContextFromSnapshot({
      analysis,
      qpdf: payload.qpdf,
      pdfjs: payload.pdfjs,
      pages: payload.pages,
      structure: payload.structure,
      inspectMode,
      cache: inspectionCache,
    })
    latestContext = rebound
    syncInspectionCache(rebound)
    refreshClassification(analysis, rebound)
    inspectionState.bufferSha256 = getBufferSha256(workingBuffer)
    inspectionState.lastInspectMode = inspectMode
    return rebound
  }

  const inspectRemediationContext = async (
    buffer: Buffer,
    analysis: AnalysisResult,
    inspectMode: RemediationInspectMode = inspectModeForResult(analysis),
  ): Promise<Awaited<ReturnType<typeof inspectPdfForRemediation>>> => {
    const activePhase = activeDeepInspectionPhase(analysis, latestContext)
    const requestedDeepInspect = inspectMode === 'alt_text_deep'
    const effectiveInspectMode: RemediationInspectMode = requestedDeepInspect && shouldDowngradeDeepInspectToLight(analysis, latestContext)
      ? 'light'
      : inspectMode
    if (requestedDeepInspect && effectiveInspectMode === 'light') {
      remediationMetrics.inspections.deepDowngradedToLight += 1
    }
    const requestedPayload = inspectionCache.contextsByMode?.[effectiveInspectMode]
    const nextBufferSha256 = getBufferSha256(buffer)
    const dirtyForMode = effectiveInspectMode === 'alt_text_deep'
      ? inspectionState.deepAltDirty
      : inspectionState.structureDirty
    const cacheMatchesCurrentBuffer = inspectionState.bufferSha256 === nextBufferSha256
      && inspectionCache.bufferSha256 === nextBufferSha256
    const nextLightSignature = effectiveInspectMode === 'light'
      ? lightVerificationSignature(analysis)
      : null

    if (effectiveInspectMode === 'light' && nextLightSignature) {
      const rebound = rebindContextFromCache(analysis, 'light')
      if (rebound && shouldShortCircuitStableLightVerification({
        state: lightVerificationLoopState,
        nextSignature: nextLightSignature,
      })) {
        latestContext = rebound
        refreshClassification(analysis, rebound)
        remediationMetrics.inspections.lightReused += 1
        lightVerificationLoopState.lastSignature = nextLightSignature
        lightVerificationLoopState.lastMutationChangedDocument = false
        return rebound
      }
    }

    if (!dirtyForMode && requestedPayload && cacheMatchesCurrentBuffer) {
      const reused = buildRemediationContextFromSnapshot({
        analysis,
        qpdf: requestedPayload.qpdf,
        pdfjs: requestedPayload.pdfjs,
        pages: requestedPayload.pages,
        structure: requestedPayload.structure,
        inspectMode: effectiveInspectMode,
        cache: inspectionCache,
      })
      latestContext = reused
      syncInspectionCache(reused)
      refreshClassification(analysis, reused)
      inspectionState.bufferSha256 = nextBufferSha256
      inspectionState.lastInspectMode = effectiveInspectMode
      inspectionState.semanticDirty = false
      if (effectiveInspectMode === 'alt_text_deep') {
        remediationMetrics.inspections.deepReused += 1
      } else {
        remediationMetrics.inspections.lightReused += 1
        if (nextLightSignature) {
          lightVerificationLoopState.lastSignature = nextLightSignature
          lightVerificationLoopState.lastMutationChangedDocument = false
        }
      }
      if (activePhase) {
        recordInspectionPhaseState(activePhase, deepInspectionSignatureForPhase(activePhase, analysis, reused), {
          fresh: false,
        })
      }
      return reused
    }

    const metricKey = effectiveInspectMode === 'alt_text_deep' ? 'deepInspections' : 'lightInspections'
    remediationTimings[metricKey] += 1
    if (effectiveInspectMode === 'alt_text_deep') {
      remediationMetrics.inspections.deepFresh += 1
    } else {
      remediationMetrics.inspections.lightFresh += 1
      if (nextLightSignature) {
        lightVerificationLoopState.lastSignature = nextLightSignature
        lightVerificationLoopState.lastMutationChangedDocument = false
      }
    }
    const totalInspections = remediationTimings.lightInspections + remediationTimings.deepInspections
    const inspectionBudgetExceeded = remediationTimings.lightInspections > MAX_LIGHT_INSPECTIONS_PER_FILE
      || remediationTimings.deepInspections > MAX_DEEP_INSPECTIONS_PER_FILE
      || totalInspections > MAX_TOTAL_INSPECTIONS_PER_FILE
    if (inspectionBudgetExceeded) {
      const error = new Error(
        `Inspection budget exceeded (light=${remediationTimings.lightInspections}, deep=${remediationTimings.deepInspections}, total=${totalInspections}).`,
      ) as Error & { code?: string }
      error.code = 'EXCESSIVE_RUNTIME'
      throw error
    }

    const inspected = await inspectPdfForRemediation(buffer, analysis, {
      inspectMode: effectiveInspectMode,
      cache: inspectionCache,
    })
    if (!hasInspectionPayload(inspected)) {
      const rebound = rebindContextFromCache(analysis, effectiveInspectMode)
      if (rebound) return rebound
      throw new Error(`inspectPdfForRemediation returned an invalid context for ${filename}`)
    }
    latestContext = inspected
    syncInspectionCache(inspected)
    refreshClassification(analysis, inspected)
    inspectionState.bufferSha256 = nextBufferSha256
    inspectionState.lastInspectMode = effectiveInspectMode
    inspectionState.structureDirty = false
    if (effectiveInspectMode === 'alt_text_deep') {
      inspectionState.deepAltDirty = false
    }
    inspectionState.semanticDirty = false
    if (activePhase) {
      recordInspectionPhaseState(activePhase, deepInspectionSignatureForPhase(activePhase, analysis, inspected), {
        fresh: true,
      })
    }
    return inspected
  }

  const analyzeIntermediate = async (
    buffer: Buffer,
    baselineResult: AnalysisResult,
    analysisOptions?: {
      forceStructureForScoring?: boolean
      preferDeepStructureInspect?: boolean
    },
  ): Promise<AnalysisResult> => {
    remediationTimings.intermediateAnalyses += 1
    const analyzed = await analyzeIntermediatePdf(buffer, filename, baselineResult, {
      signal: options?.signal,
      forceStructureForScoring: analysisOptions?.forceStructureForScoring,
      preferDeepStructureInspect: analysisOptions?.preferDeepStructureInspect,
    })
    const next = hasResultCategories(analyzed) ? analyzed : baselineResult
    if (analysisOptions?.preferDeepStructureInspect && hasResultCategories(next)) {
      recordInspectionPhaseState('structure_state', structureStateSignature(next), { fresh: true })
    }
    return next
  }

  const analyzeAuthoritative = async (
    buffer: Buffer,
    baselineResult: AnalysisResult,
  ): Promise<AnalysisResult> => {
    const analyzed = await analyzePDF(buffer, filename, {
      analysisProfile: 'full_final',
      signal: options?.signal,
      skipAdobe: true,
      skipVeraPdf: true,
    })
    return hasResultCategories(analyzed) ? analyzed : baselineResult
  }

  const ensureAuthoritativeResultForCurrentBuffer = async (): Promise<void> => {
    const titledBuffer = await ensureDisplayDocTitle(workingBuffer)
    const titleMutationChangedDocument = !titledBuffer.equals(workingBuffer)
    workingBuffer = titledBuffer
    if (!currentResultHasFreshVeraPdf || titleMutationChangedDocument) {
      currentResult = await analyzeAuthoritative(workingBuffer, currentResult)
      currentResultHasFreshVeraPdf = true
    }
  }

  const inspectRemediationContextSafely = async (
    buffer: Buffer,
    analysis: AnalysisResult,
    inspectMode: RemediationInspectMode = inspectModeForResult(analysis),
  ): Promise<Awaited<ReturnType<typeof inspectPdfForRemediation>> | null> => {
    if (!hasResultCategories(analysis)) return null
    try {
      return await inspectRemediationContext(buffer, analysis, inspectMode)
    } catch {
      return rebindContextFromCache(analysis, inspectMode)
    }
  }

  const isInspectionBudgetExhausted = (): boolean => {
    return remediationTimings.deepInspections >= MAX_DEEP_INSPECTIONS_PER_FILE
      || remediationTimings.lightInspections >= MAX_LIGHT_INSPECTIONS_PER_FILE
      || (remediationTimings.lightInspections + remediationTimings.deepInspections) >= MAX_TOTAL_INSPECTIONS_PER_FILE
  }

  const syncAltTextReviewSidecar = async (
    context: Awaited<ReturnType<typeof inspectPdfForRemediation>> | null,
  ): Promise<void> => {
    if (!options?.artifactsDir || !context) return
    altTextSidecar = await syncAltTextSidecar({
      artifactsDir: options.artifactsDir,
      filename,
      context,
    })
  }

  const applyReviewedAltTextSidecar = async (): Promise<void> => {
    if (!options?.artifactsDir) return
    const context = latestContext || await inspectRemediationContext(workingBuffer, currentResult, 'light')
    await syncAltTextReviewSidecar(context)
    const directives = planAltTextSidecarDirectives({
      context,
      sidecar: altTextSidecar,
    })
    if (!directives.length) return

    const reviewedAltStartResult = currentResult
    const reviewedAltActions: RemediationActionRecord[] = []
    let reviewedContext = context

    stagesRun.add(95)
    for (const directive of directives) {
      const candidate = reviewedContext.figureCandidates.find(entry => entry.id === directive.candidateId)
      if (!candidate) continue
      const outcome = await executeRemediationTool({
        buffer: workingBuffer,
        context: reviewedContext,
        call: {
          tool_name: directive.toolName,
          arguments: directive.toolName === 'mark_figure_decorative'
            ? { candidateId: directive.candidateId, decorative: true, generationSource: 'manual_deferred' }
            : { candidateId: directive.candidateId, altText: directive.altText, generationSource: 'manual_deferred' },
          rationale: directive.status === 'decorative'
            ? `Apply reviewed decorative figure decision for canonical image ${directive.imageId}.`
            : `Apply reviewed alternate text for canonical image ${directive.imageId}.`,
          confidence: 0.99,
        },
      })
      reviewedAltActions.push(outcome.action)
      actions.push(outcome.action)
      allExecutedActions.push(outcome.action)
      manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, outcome.manualReviewFlags)
      previousActionNames = Array.from(new Set([
        ...previousActionNames,
        ...actionHistoryKeys(outcome.action),
      ]))
      if (!outcome.action.changedDocumentBytes || outcome.action.outcome === 'rejected') continue
      workingBuffer = outcome.buffer
      noteDocumentMutation(outcome.action)
      currentResult = await analyzeIntermediate(workingBuffer, currentResult)
      currentResultHasFreshVeraPdf = false
      reviewedContext = await inspectRemediationContext(workingBuffer, currentResult, 'light')
      await syncAltTextReviewSidecar(reviewedContext)
    }

    if (reviewedAltActions.length) {
      latestContext = reviewedContext
      persistStageToolOutcomes(reviewedAltActions, {
        previous: reviewedAltStartResult,
        next: currentResult,
        roundNumber: round,
        stageNumber: 95,
        standardsImproved: standardsValidationImproved(reviewedAltStartResult, currentResult),
      })
    }
  }

  const runAcrobatOwnershipConvergence = async (): Promise<void> => {
    let passes = 0
    let stagnantPasses = 0
    let previousRiskCount = -1

    while (passes < REMEDIATION.MAX_ACROBAT_OWNERSHIP_PASSES_PER_ROUND) {
      if (latePhaseConvergence.ownership_state.converged) break
      const deepContext = await inspectRemediationContext(workingBuffer, currentResult, 'alt_text_deep')
      const beforeSnapshot = buildPhaseProgressSnapshot('ownership_state', currentResult, deepContext)
      latePhaseConvergence.ownership_state.lastSnapshot = beforeSnapshot
      const currentRiskCount = acrobatOwnershipRiskCount(deepContext)
      if (currentRiskCount <= 0) break

      options?.onProgress?.({
        stage: `Converging Acrobat ownership risks (${passes + 1}/${REMEDIATION.MAX_ACROBAT_OWNERSHIP_PASSES_PER_ROUND})`,
        percent: 68,
      })

      const repairCall: RemediationToolCall = {
        tool_name: 'repair_other_elements_alt_text',
        arguments: { target: 'document' },
        rationale: 'Repeat Acrobat ownership repair while alternate-text ownership risks are still shrinking.',
        confidence: 0.92,
      }
      const outcome = await executeRemediationTool({
        buffer: workingBuffer,
        context: deepContext,
        call: repairCall,
      })
      actions.push(outcome.action)
      allExecutedActions.push(outcome.action)
      manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, outcome.manualReviewFlags)
      previousActionNames = Array.from(new Set([
        ...previousActionNames,
        ...actionHistoryKeys(outcome.action),
      ]))

      if (!outcome.action.changedDocumentBytes || outcome.action.outcome === 'rejected') break

      workingBuffer = outcome.buffer
      noteDocumentMutation(outcome.action)
      currentResult = await analyzeIntermediate(workingBuffer, currentResult)
      currentResultHasFreshVeraPdf = false

      const afterContext = await inspectRemediationContext(workingBuffer, currentResult, 'alt_text_deep')
      const nextRiskCount = acrobatOwnershipRiskCount(afterContext)
      const reduction = currentRiskCount - nextRiskCount
      passes += 1
      const improved = updateLatePhaseProgress({
        phase: 'ownership_state',
        before: beforeSnapshot,
        afterAnalysis: currentResult,
        afterContext,
        changedDocumentBytes: outcome.action.changedDocumentBytes,
        noProgressLimit: 2,
      })

      if (reduction >= REMEDIATION.MIN_ACROBAT_RISK_REDUCTION_TO_CONTINUE) {
        stagnantPasses = 0
      } else {
        stagnantPasses += 1
      }
      if (!improved) {
        stagnantPasses += 1
      }

      if (nextRiskCount <= 0) break
      if (stagnantPasses >= 2) break
      if (previousRiskCount >= 0 && nextRiskCount >= previousRiskCount) break

      previousRiskCount = nextRiskCount
    }
  }

  const runBoundedPostOwnershipFigureRepairPass = async (input: {
    stageNumber: number
    stageLabel: string
    maxCandidates?: number
  }): Promise<void> => {
    if (latePhaseConvergence.figure_description_state.converged) return
    if ((scoreForCategory(currentResult, 'alt_text') ?? 100) >= 100) return
    const contextForDecision = latestContext || await inspectRemediationContext(workingBuffer, currentResult, 'light')
    if (shouldDeferLateFigureWorkUntilStructureConverges({
      analysis: currentResult,
      context: contextForDecision,
      tracker: residualCleanupTracker,
    })) {
      return
    }
    const followupCandidates = heuristicEligibleFigureCandidates(contextForDecision)
      .filter(candidate => shouldRetryLateHeuristicFigureCandidate(candidate, previousActionNames))
    const sweepDecision = shouldRunLateFigureSweep({
      tracker: latePhaseConvergence.figure_description_state,
      analysis: currentResult,
      context: contextForDecision,
      candidateCount: followupCandidates.length,
    })
    if (!sweepDecision.allowed) {
      if (sweepDecision.reason === 'stable_no_progress' || sweepDecision.reason === 'no_candidate_progress') {
        markLatePhaseConverged('figure_description_state')
      }
      return
    }
    const altContext = await inspectRemediationContext(workingBuffer, currentResult, 'alt_text_deep')
    const beforeSnapshot = buildPhaseProgressSnapshot('figure_description_state', currentResult, altContext)
    latePhaseConvergence.figure_description_state.lastSnapshot = beforeSnapshot

    stagesRun.add(input.stageNumber)
    const stageStartResult = currentResult
    const followupStage = await runHeuristicFigureFallbackStage({
      buffer: workingBuffer,
      result: currentResult,
      context: altContext,
      previousActionNames,
      inspectionCache,
      maxCandidates: input.maxCandidates ?? MAX_POST_OWNERSHIP_FIGURE_REPAIRS,
    })
    if (!followupStage.actions.length) return

    if (!followupStage.buffer.equals(workingBuffer)) {
      workingBuffer = followupStage.buffer
    }
    currentResult = followupStage.result
    currentResultHasFreshVeraPdf = !followupStage.usedInheritedVeraPdf
    actions.push(...followupStage.actions)
    allExecutedActions.push(...followupStage.actions)
    manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, followupStage.manualReviewFlags)
    for (const action of followupStage.actions) noteDocumentMutation(action)
    previousActionNames = Array.from(new Set([
      ...previousActionNames,
      ...followupStage.actions.flatMap(actionHistoryKeys),
    ]))
    latestContext = await inspectRemediationContext(workingBuffer, currentResult, 'alt_text_deep')
    const changedFigureBytes = followupStage.actions.some(action => action.changedDocumentBytes)
    updateLatePhaseProgress({
      phase: 'figure_description_state',
      before: beforeSnapshot,
      afterAnalysis: currentResult,
      afterContext: latestContext,
      changedDocumentBytes: changedFigureBytes,
      noProgressLimit: 1,
    })
    persistStageToolOutcomes(followupStage.actions, {
      previous: stageStartResult,
      next: currentResult,
      roundNumber: round,
      stageNumber: input.stageNumber,
      standardsImproved: standardsValidationImproved(stageStartResult, currentResult),
    })
    options?.onProgress?.({
      stage: input.stageLabel,
      percent: 96,
    })
  }

  const familyCompletionTargetForState = (analysis: AnalysisResult, context: PdfRemediationContext) => familyCompletionTarget(buildFailureProfileArtifacts({
    analysis,
    context,
    actions,
    rejectedActions,
    iterations,
  }).failureProfile)
  const currentFamilyCompletionTarget = (context: PdfRemediationContext) => familyCompletionTargetForState(currentResult, context)

  const runFinalResidualRepairs = async (): Promise<void> => {
    if (isFullyDone(currentResult)) return
    const baseInspectMode = inspectModeForResult(currentResult)
    let context = latestContext
      || rebindContextFromCache(currentResult, baseInspectMode)
      || await inspectRemediationContextSafely(workingBuffer, currentResult, baseInspectMode)
    if (!context) return

    const currentResidualArtifacts = buildFailureProfileArtifacts({
      analysis: currentResult,
      context,
      actions,
      rejectedActions,
      iterations,
    })
    let baselineConvergenceFamily = selectResidualCleanupFamilyTarget(currentResidualArtifacts.failureProfile, currentResult, context)
    let seededPlanningState: {
      result: AnalysisResult
      context: PdfRemediationContext
      artifacts: ReturnType<typeof buildFailureProfileArtifacts>
    } | null = null

    if (!baselineConvergenceFamily) {
      const seededPlanningResult = await analyzeIntermediate(workingBuffer, currentResult)
      if (hasResultCategories(seededPlanningResult)) {
        const seededPlanningContext = rebindContextFromCache(seededPlanningResult, inspectModeForResult(seededPlanningResult))
          || await inspectRemediationContextSafely(workingBuffer, seededPlanningResult, inspectModeForResult(seededPlanningResult))
        if (seededPlanningContext) {
          const seededPlanningArtifacts = buildFailureProfileArtifacts({
            analysis: seededPlanningResult,
            context: seededPlanningContext,
            actions,
            rejectedActions,
            iterations,
          })
          const seededFamily = selectResidualCleanupFamilyTarget(seededPlanningArtifacts.failureProfile, seededPlanningResult, seededPlanningContext)
          if (seededFamily) {
            baselineConvergenceFamily = seededFamily
            seededPlanningState = {
              result: seededPlanningResult,
              context: seededPlanningContext,
              artifacts: seededPlanningArtifacts,
            }
          }
        }
      }
    }

    let familyPasses = 0

    while (familyPasses < 2) {
      const executionMode = residualCleanupExecutionMode({
        hasBaselineFamily: !!baselineConvergenceFamily,
        hasSeededPlanningState: !!seededPlanningState,
        familyPasses,
      })
      const useSeededPlanningState = executionMode === 'seeded'
      const useBaselineState = executionMode === 'baseline'
      const shouldRefreshPlanningState = executionMode === 'refresh'
      const planningResult = useSeededPlanningState
        ? seededPlanningState!.result
        : shouldRefreshPlanningState
          ? await analyzeIntermediate(workingBuffer, currentResult)
          : currentResult
      if (!hasResultCategories(planningResult)) return

      const planningContext = useSeededPlanningState
        ? seededPlanningState!.context
        : shouldRefreshPlanningState
        ? (
            rebindContextFromCache(planningResult, inspectModeForResult(planningResult))
            || await inspectRemediationContextSafely(workingBuffer, planningResult, inspectModeForResult(planningResult))
          )
        : context
      if (!planningContext) return

      const residualArtifacts = useSeededPlanningState
        ? seededPlanningState!.artifacts
        : shouldRefreshPlanningState
        ? buildFailureProfileArtifacts({
            analysis: planningResult,
            context: planningContext,
            actions,
            rejectedActions,
            iterations,
          })
        : currentResidualArtifacts
      const convergenceFamily = useBaselineState
        ? baselineConvergenceFamily
        : useSeededPlanningState || shouldRefreshPlanningState
        ? selectResidualCleanupFamilyTarget(residualArtifacts.failureProfile, planningResult, planningContext)
        : baselineConvergenceFamily
      const convergenceFamilies = convergenceFamily
        ? residualCleanupFamilyChain(residualArtifacts.failureProfile, convergenceFamily)
        : []
      const residualBucket = convergenceFamily
        ? residualFamilyBucketFromDecision(convergenceFamily)
        : residualCleanupDominantFamily(planningResult, planningContext)
      const residualBeforeSnapshot = buildResidualCleanupProgressSnapshot(residualBucket, planningResult, planningContext)
      const residualCalls: RemediationToolCall[] = []
      const cleanupCalls: RemediationToolCall[] = []

      if (convergenceFamily) {
        const familyPlan = await planRemediationActions({
          filename,
          analysis: planningResult,
          context: planningContext,
          iteration: round,
          actions,
          rejectedActions,
          pipelineConfig: currentPipelineConfig,
        })
        absorbProviderTelemetry('remediationPlanService')
        const familyCalls = buildResidualCleanupFamilyCalls({
          filename,
          analysis: planningResult,
          context: planningContext,
          failureProfile: residualArtifacts.failureProfile,
          family: convergenceFamily,
          plannedCalls: familyPlan?.actions || [],
        })

        residualCalls.push(...familyCalls)
      }

      const titleLanguageScore = currentResult.categories.find(entry => entry.id === 'title_language')?.score ?? 100
      const pdfUaScore = currentResult.categories.find(entry => entry.id === 'pdf_ua_compliance')?.score ?? 100
      if (titleLanguageScore < 100 || pdfUaScore < 100) {
        cleanupCalls.push({
          tool_name: 'normalize_document_metadata',
          arguments: {
            title: currentTitle || context.pdfjs.title || filename.replace(/\.pdf$/i, ''),
            language: currentLanguage || context.qpdf.lang || context.pdfjs.lang || 'en',
          },
          rationale: 'Final cleanup: normalize metadata and PDF/UA identification before authoritative analysis.',
          confidence: 0.98,
        })
      }

      if ((context.qpdf.unembeddedFontCount ?? 0) > 0) {
        cleanupCalls.push({
          tool_name: 'embed_missing_fonts_in_place',
          arguments: { target: 'document' },
          rationale: 'Final cleanup: retry embedding for any fonts still lacking embedded programs after later mutations.',
          confidence: 0.9,
        })
      }

      if ((context.qpdf.fontsMissingToUnicodeBlocking ?? context.qpdf.fontsMissingToUnicode ?? 0) > 0) {
        cleanupCalls.push({
          tool_name: 'repair_font_unicode_maps',
          arguments: { target: 'document' },
          rationale: 'Final cleanup: add ToUnicode maps for fonts still missing Unicode coverage after later mutations.',
          confidence: 0.92,
        })
      }

      if ((context.qpdf.type1FontsMissingToUnicode ?? 0) > 0) {
        cleanupCalls.push({
          tool_name: 'repair_type1_font_unicode_maps',
          arguments: { target: 'document' },
          rationale: 'Final cleanup: retry Type1/Type3 Unicode recovery after later font cleanup changed the remaining font set.',
          confidence: 0.9,
        })
      }

      if (context.linkCandidates.some(candidate => !(candidate.annotationContents || '').trim())) {
        for (const candidate of context.linkCandidates.filter(entry => !(entry.annotationContents || '').trim())) {
          cleanupCalls.push({
            tool_name: 'set_link_annotation_contents',
            arguments: {
              candidateId: candidate.id,
              pageNumber: candidate.pageNumber,
              annotationIndex: candidate.annotationIndex,
              contents: candidate.suggestedText || candidate.text || candidate.url,
            },
            rationale: `Final cleanup: ensure link annotation ${candidate.id} exposes /Contents.`,
            confidence: 0.92,
          })
        }
      }

      if (hasBlockingLocalFinding(currentResult, 'pdfua.annotation_alt_contents')) {
        cleanupCalls.push({
          tool_name: 'repair_annotation_alt_text',
          arguments: { target: 'document' },
          rationale: 'Final cleanup: ensure non-link annotations expose alternate text before terminalizing the file.',
          confidence: 0.9,
          familyId: 'link_tabs_and_annotation_cleanup',
        })
      }

      if (hasBlockingLocalFinding(currentResult, 'pdfua.link_tagging')) {
        cleanupCalls.push({
          tool_name: 'repair_native_link_structure',
          arguments: { target: 'document' },
          rationale: 'Final cleanup: repair remaining link tagging structure after mixed structure/figure convergence.',
          confidence: 0.9,
          familyId: 'link_tabs_and_annotation_cleanup',
        })
      }

      if ((currentResult.categories.find(entry => entry.id === 'table_markup')?.score ?? 100) < 100) {
        cleanupCalls.push({
          tool_name: 'repair_native_table_headers',
          arguments: { target: 'document' },
          rationale: 'Final cleanup: repair native table headers before authoritative scoring.',
          confidence: 0.88,
        })
        for (const candidate of context.tableCandidates.filter(entry => entry.repairMode === 'safe' && !entry.hasHeaders && !!entry.ref)) {
          cleanupCalls.push({
            tool_name: 'set_table_header_cells',
            arguments: { targets: [candidate.ref] },
            rationale: `Final cleanup: promote first row to headers for ${candidate.ref}.`,
            confidence: 0.86,
          })
        }
      }

      if (hasBlockingLocalFinding(currentResult, 'pdfua.table_regularity')) {
        cleanupCalls.push({
          tool_name: 'repair_native_table_headers',
          arguments: { target: 'document' },
          rationale: 'Final cleanup: retry table header normalization for remaining regularity debt before terminalizing the file.',
          confidence: 0.9,
          familyId: 'table_structure_recovery',
        })
      }

      const filteredResidualCalls = dedupeToolCalls([
        ...filterCallsForPipelineWithFamilyOverride(
          residualCalls,
          convergenceFamilies,
        ),
        ...cleanupCalls,
      ])
      if (!filteredResidualCalls.length) return

      const allowResidualFollowUp = cleanupCalls.length > 0 || shouldAllowResidualFamilyDeepFollowUp({
        tracker: residualCleanupTracker,
        bucket: residualBucket,
        pressure: residualBeforeSnapshot.pressure,
        snapshot: residualBeforeSnapshot,
        familyId: convergenceFamily?.id || null,
        stageIntroducedNewFamily: !!convergenceFamily && residualCleanupTracker.lastFamilyId !== convergenceFamily.id,
      })
      if (!allowResidualFollowUp) {
        markResidualCleanupBucketConverged(residualBucket)
        setResidualCleanupStopReason(
          residualBucket === 'mixed'
            ? 'mixed_figure_structure_separation_required'
            : 'same_family_no_progress',
        )
        return
      }

      let changed = false
      for (const call of filteredResidualCalls) {
        const previous = currentResult
        const outcome = await executeRemediationTool({
          buffer: workingBuffer,
          context,
          call,
        })
        actions.push(outcome.action)
        allExecutedActions.push(outcome.action)
        manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, outcome.manualReviewFlags)
        previousActionNames = Array.from(new Set([
          ...previousActionNames,
          ...actionHistoryKeys(outcome.action),
        ]))
        if (!outcome.action.changedDocumentBytes || outcome.action.outcome === 'rejected') continue
        changed = true
        workingBuffer = outcome.buffer
        noteDocumentMutation(outcome.action)
        currentResult = await analyzeIntermediate(workingBuffer, currentResult)
        currentResultHasFreshVeraPdf = false
        const refreshedContext = rebindContextFromCache(currentResult, inspectModeForResult(currentResult))
          || await inspectRemediationContextSafely(workingBuffer, currentResult)
        if (!refreshedContext) return
        context = refreshedContext
        const improvedTargets = applyScoreDelta(outcome.action, previous, currentResult)
        if (!improvedTargets && outcome.action.outcome === 'applied') {
          outcome.action.outcome = 'no_effect'
        }
      }

      if (changed) {
        latestContext = context
        updateResidualCleanupProgress({
          familyId: convergenceFamily?.id || null,
          bucket: residualBucket,
          before: residualBeforeSnapshot,
          afterAnalysis: currentResult,
          afterContext: context,
          changedDocumentBytes: true,
        })
      } else if (convergenceFamily || residualBucket !== 'unknown') {
        residualCleanupTracker.lastFamilyId = convergenceFamily?.id || null
        residualCleanupTracker.lastBucket = residualBucket
        residualCleanupTracker.lastSnapshot = residualBeforeSnapshot
        residualCleanupTracker.lastMutationChangedDocument = false
        residualCleanupTracker.lastProgressed = false
        markResidualCleanupBucketConverged(residualBucket)
        setResidualCleanupStopReason('no_mutation')
      }

      if (!convergenceFamily || !changed) {
        return
      }
      const activeDominantFamilyAfterPass = residualCleanupDominantFamily(currentResult, context)
      if (familyPasses === 0 && residualBucket !== 'unknown' && activeDominantFamilyAfterPass !== residualBucket && activeDominantFamilyAfterPass !== 'unknown') {
        remediationMetrics.residualCleanup.dominantFamily = activeDominantFamilyAfterPass
        setResidualCleanupStopReason(
          deriveResidualCleanupTransitionStopReason({
            beforeBucket: residualBucket,
            afterBucket: activeDominantFamilyAfterPass,
            improved: true,
          }) || 'family_shifted',
        )
        familyPasses += 1
        continue
      }
      if (residualCleanupTracker.lastProgressed !== true) {
        return
      }
      familyPasses += 1
    }
  }

  const runFocusedFinalRescue = async (): Promise<void> => {
    let rescuePasses = 0
    let executedRescuePasses = 0
    let lastSignature = remediationStateSignature(currentResult)
    let mixedNoShrinkPasses = 0
    let mixedRuntimeGovernorFired = false
    let compactFinalRescueFallback = false
    let forceSpecializedTailMode: SpecializedTailMode | null = null
    let lastSpecializedTailModeUsed: SpecializedTailMode = 'none'
    let specializedTailAttempted = false
    let specializedTailImproved = false
    const figureMethodsWithNoProgress = new Set<FigureRescueMethod>()
    const figureMethodsAttempted = new Set<FigureRescueMethod>()

    while (rescuePasses < 4) {
      const needsAltRescue =
        hasBlockingLocalFinding(currentResult, 'pdfua.untagged_rendered_images')
        || hasBlockingLocalFinding(currentResult, 'pdfua.nested_alt_text')
        || hasBlockingLocalFinding(currentResult, 'pdfua.figure_alt_or_artifact')
        || hasUnresolvedCategoryLabel(currentResult, 'Alt Text on Images')
      const needsFontRescue =
        hasBlockingLocalFinding(currentResult, 'pdfua.font_unicode')
        || hasUnresolvedCategoryLabel(currentResult, 'Text Extractability')
      const needsStructureRescue =
        hasBlockingLocalFinding(currentResult, 'pdfua.logical_structure')
        || hasBlockingLocalFinding(currentResult, 'pdfua.heading_content_quality')
        || hasUnresolvedCategoryLabel(currentResult, 'Heading Structure')
        || hasUnresolvedCategoryLabel(currentResult, 'Reading Order')
      const needsTableRescue =
        hasBlockingLocalFinding(currentResult, 'pdfua.table_regularity')
        || hasUnresolvedCategoryLabel(currentResult, 'Table Markup')

      if (!needsAltRescue && !needsFontRescue && !needsStructureRescue && !needsTableRescue) {
        setFigureDescriptionStopReason('completed')
        break
      }

      const currentLightContext = latestContext
        || rebindContextFromCache(currentResult, 'light')
        || await inspectRemediationContextSafely(workingBuffer, currentResult, 'light')
      const hasResidualFontDebt =
        (currentLightContext?.qpdf.unembeddedFontCount ?? 0) > 0
        || (currentLightContext?.qpdf.fontsMissingToUnicodeBlocking ?? currentLightContext?.qpdf.fontsMissingToUnicode ?? 0) > 0
        || (currentLightContext?.qpdf.type1FontsMissingToUnicode ?? 0) > 0
      const nearPassTailEligible = isNearPassTailEligible({
        analysis: currentResult,
        context: currentLightContext,
      })
      const specializedTailMode: SpecializedTailMode = forceSpecializedTailMode || specializedTailModeForResult(currentResult, currentLightContext)
      const figureOnlyRescuePath = needsAltRescue && shouldUseFigureOnlyLateRescuePath({
        analysis: currentResult,
        context: currentLightContext,
      })
      const headingOnlyRescuePath = isHeadingOnlyResidualState(currentResult, currentLightContext)
      const nearPassFigureFastLane = shouldUseNearPassFigureFastLane({
        analysis: currentResult,
        context: currentLightContext,
      })
      const compactMixedFinalRescue = shouldUseCompactMixedFinalRescue({
        analysis: currentResult,
        context: currentLightContext,
        timings: remediationTimings,
      })
      const serialLargeMixedTerminalization = shouldSerialTerminalizeLargeMixedProfile({
        analysis: currentResult,
        context: currentLightContext,
        timings: remediationTimings,
        rescuePasses,
        mixedNoShrinkPasses,
        tracker: residualCleanupTracker,
      })
      const mixedRuntimeGovernorTripped = shouldTripMixedRuntimeGovernor({
        analysis: currentResult,
        context: currentLightContext,
        timings: remediationTimings,
        rescuePasses,
        mixedNoShrinkPasses,
        tracker: residualCleanupTracker,
      })
      const shouldPreferSpecializedTailPass =
        specializedTailMode !== 'none'
        && nearPassTailEligible
        && (forceSpecializedTailMode !== null || rescuePasses > 0)
      if (serialLargeMixedTerminalization) {
        residualCleanupTracker.lastBucket = 'mixed'
        residualCleanupTracker.lastSnapshot = buildResidualCleanupProgressSnapshot('mixed', currentResult, currentLightContext)
        residualCleanupTracker.lastMutationChangedDocument = false
        residualCleanupTracker.lastProgressed = false
        markResidualCleanupBucketConverged('mixed')
        markLatePhaseConverged('structure_state')
        setResidualCleanupStopReason('mixed_large_runtime_profile_requires_serial_terminalization')
        manualReviewFlags = addFlag(manualReviewFlags, {
          code: 'mixed_large_runtime_profile_requires_serial_terminalization',
          label: 'Large mixed runtime profile terminalized early',
          severity: 'warning',
          details: 'Stopped late mixed rescue because a large mixed document with repeated bounded-runtime evidence should be terminalized serially instead of re-entering expensive deep rescue.',
        })
        break
      }
      if (mixedRuntimeGovernorTripped) {
        mixedRuntimeGovernorFired = true
        compactFinalRescueFallback = true
        setResidualCleanupStopReason('mixed_runtime_churn_without_family_shrink')
        markResidualCleanupBucketConverged('mixed')
      }
      const altPhaseAlreadyConverged = latePhaseConvergence.figure_description_state.converged
      const mixedFigureFollowUpOverride = altPhaseAlreadyConverged
        && needsAltRescue
        && needsStructureRescue
        && rescuePasses === 0
        && !!currentLightContext
        && shouldUseFigureOnlyLateRescuePath({
          analysis: currentResult,
          context: currentLightContext,
        })
      const smallFigureDebtOverride = altPhaseAlreadyConverged
        && needsAltRescue
        && informativeFigureMissingAltCount(currentLightContext) <= 8
        && informativeFigureMissingAltCount(currentLightContext) > 0
      const canAttemptAltRescue = needsAltRescue && (!altPhaseAlreadyConverged || smallFigureDebtOverride || mixedFigureFollowUpOverride)
      if (needsAltRescue && altPhaseAlreadyConverged && !smallFigureDebtOverride && !mixedFigureFollowUpOverride) {
        remediationMetrics.phases.figure_description_state.focusedRescueSkippedBecauseLateConverged = true
        setFigureDescriptionStopReason(remediationMetrics.phases.figure_description_state.finalStopReason || 'same_blocking_keys')
      }

      const inspectMode: RemediationInspectMode = shouldPreferLightFocusedRescueContext({
        canAttemptAltRescue,
        rescuePasses,
        currentResult,
        currentLightContext,
        tracker: residualCleanupTracker,
        timings: remediationTimings,
      })
        ? 'light'
        : canAttemptAltRescue && !mixedRuntimeGovernorTripped
          ? 'alt_text_deep'
          : inspectModeForResult(currentResult)
      let context = latestContext
        || rebindContextFromCache(currentResult, inspectMode)
        || await inspectRemediationContextSafely(workingBuffer, currentResult, inspectMode)
      if (!context) break
      const beforeResidualBucket = residualCleanupDominantFamily(currentResult, context)
      const beforeResidualSnapshot = buildResidualCleanupProgressSnapshot(beforeResidualBucket, currentResult, context)
      const runtimeHeavyMixedProfile = isRuntimeHeavyMixedProfile({
        analysis: currentResult,
        context,
        timings: remediationTimings,
        tracker: residualCleanupTracker,
      })
      const allowLargeMixedFigureRescue = shouldAllowLargeMixedDominantFamilyRescue({
        family: 'figure',
        rescuePasses,
        currentSnapshot: beforeResidualSnapshot,
        tracker: residualCleanupTracker,
        runtimeHeavyMixedProfile,
        familySpecificOpportunityExposed:
          heuristicEligibleFigureCandidates(context).length > 0
          || informativeFigureMissingAltCount(context) > 0,
      })
      const allowLargeMixedStructureRescue = shouldAllowLargeMixedDominantFamilyRescue({
        family: 'structure',
        rescuePasses,
        currentSnapshot: beforeResidualSnapshot,
        tracker: residualCleanupTracker,
        runtimeHeavyMixedProfile,
        familySpecificOpportunityExposed:
          (context.readingOrderParentCandidates?.length ?? 0) > 0
          || (context.headingCandidates?.some(candidate => candidate.repairMode === 'safe') ?? false)
          || (context.tableCandidates?.some(candidate => candidate.repairMode === 'safe') ?? false),
      })

      const rescueCalls: RemediationToolCall[] = []
      const usingSpecializedFigureTail =
        shouldPreferSpecializedTailPass
        && (
          specializedTailMode === 'figure_tail'
          || specializedTailMode === 'annotation_table_tail'
          || specializedTailMode === 'figure_structure_tail'
        )
      const usingSpecializedFontTail =
        shouldPreferSpecializedTailPass && specializedTailMode === 'font_tail'
      const usingSpecializedAnnotationTableTail =
        shouldPreferSpecializedTailPass
        && (specializedTailMode === 'annotation_table_tail' || specializedTailMode === 'figure_structure_tail')
      if (shouldPreferSpecializedTailPass) {
        lastSpecializedTailModeUsed = specializedTailMode
      }

      if ((canAttemptAltRescue || usingSpecializedFigureTail) && !mixedRuntimeGovernorTripped && allowLargeMixedFigureRescue) {
        remediationMetrics.phases.figure_description_state.focusedRescueRan = true
        if (usingSpecializedFigureTail) specializedTailAttempted = true
        rescueCalls.push(
          {
            tool_name: 'normalize_nested_figure_containers',
            arguments: { target: 'document' },
            rationale: 'Focused final rescue: normalize nested figure wrappers before re-checking Acrobat-style figure ownership.',
            confidence: 0.97,
          },
          {
            tool_name: 'repair_native_figure_semantics',
            arguments: { target: 'document' },
            rationale: 'Focused final rescue: retag native figure ownership to reduce non-/Figure graphics parents.',
            confidence: 0.96,
          },
          {
            tool_name: 'repair_other_elements_alt_text',
            arguments: { target: 'document' },
            rationale: 'Focused final rescue: repair Acrobat-style alternate-text ownership risks on non-/Figure graphics containers.',
            confidence: 0.97,
          },
        )
        if (figureOnlyRescuePath || nearPassFigureFastLane || usingSpecializedFigureTail) {
          rescueCalls.push(...buildFigureOnlyFinalMileCalls({
            context,
            previousActionNames,
            currentScore: currentResult.overallScore,
            blockerCount: blockingLocalFindingKeys(currentResult).length,
            maxCandidates: nearPassFigureFastLane ? 3 : usingSpecializedFigureTail ? 5 : 4,
          }))
        }
      }

      if (((needsFontRescue || hasResidualFontDebt) && !figureOnlyRescuePath && !nearPassFigureFastLane) || usingSpecializedFontTail) {
        if (usingSpecializedFontTail) specializedTailAttempted = true
        rescueCalls.push(...buildFontTailFinalMileCalls({
          context,
          hasResidualFontDebt: needsFontRescue || hasResidualFontDebt,
        }))
      }

      if ((needsStructureRescue || needsTableRescue || usingSpecializedAnnotationTableTail) && !figureOnlyRescuePath && !nearPassFigureFastLane && allowLargeMixedStructureRescue) {
        // If the logical_structure failure is driven by untagged text-bearing top-level
        // content groups, inject a targeted artifact_nonsemantic_page_elements call with
        // includeTextGroups=true BEFORE the standard conformance repair chain.
        const logicalStructureFinding = currentResult.localStandards?.findings?.find(
          f => f.key === 'pdfua.logical_structure' && f.blocking,
        )
        const hasUntaggedTextGroups = logicalStructureFinding?.evidence?.some(
          e => /untagged top-level page content group/i.test(e),
        ) ?? false
        if (hasUntaggedTextGroups) {
          rescueCalls.push({
            tool_name: 'artifact_nonsemantic_page_elements',
            arguments: { target: 'document', includeTextGroups: true },
            rationale: 'Focused rescue: wrap text-bearing untagged top-level content groups as Artifact to resolve logical_structure failure.',
            confidence: 0.85,
          })
        }
        if (needsStructureRescue && !headingOnlyRescuePath) {
          rescueCalls.push({
            tool_name: 'repair_native_reading_order',
            arguments: { target: 'document' },
            rationale: 'Focused final rescue: repair native reading order before the final structure-conformance pass.',
            confidence: 0.95,
          })
          for (const group of (context.readingOrderParentCandidates || []).filter(entry =>
            entry.mutableKids && entry.suggestedChildCandidateIds.length > 1,
          ).slice(0, compactMixedFinalRescue ? 1 : 3)) {
            rescueCalls.push({
              tool_name: 'reorder_structure_children',
              arguments: { candidateGroupId: group.id, parentRef: group.parentRef },
              rationale: `Focused final rescue: reorder structure children for ${group.parentRef} to reduce reading-order disorder.`,
              confidence: 0.9,
            })
          }
        }
        if (
          (hasBlockingLocalFinding(currentResult, 'pdfua.heading_content_quality')
            || hasUnresolvedCategoryLabel(currentResult, 'Heading Structure'))
          && (context.headingCandidates || []).some(candidate => candidate.repairMode === 'safe')
        ) {
          for (const candidate of (context.headingCandidates || []).filter(entry => entry.repairMode === 'safe' && entry.targetRef).slice(0, headingOnlyRescuePath ? 4 : compactMixedFinalRescue ? 1 : 3)) {
            rescueCalls.push({
              tool_name: 'create_heading_from_candidate',
              arguments: { candidateId: candidate.id, level: candidate.pageNumber === 1 ? 'H1' : 'H2' },
              rationale: `Focused final rescue: promote heading candidate ${candidate.id} before final hierarchy normalization.`,
              confidence: 0.86,
            })
          }
        }
        if (context.linkCandidates.some(candidate => !(candidate.annotationContents || '').trim()) && !usingSpecializedAnnotationTableTail) {
          for (const candidate of (context.linkCandidates || []).filter(entry => !(entry.annotationContents || '').trim()).slice(0, 6)) {
            rescueCalls.push({
              tool_name: 'set_link_annotation_contents',
              arguments: {
                candidateId: candidate.id,
                pageNumber: candidate.pageNumber,
                annotationIndex: candidate.annotationIndex,
                contents: candidate.suggestedText || candidate.text || candidate.url,
              },
              rationale: `Focused final rescue: set /Contents for link annotation ${candidate.id}.`,
              confidence: 0.9,
            })
          }
        }
        rescueCalls.push(
          {
            tool_name: 'normalize_heading_hierarchy',
            arguments: { target: 'document' },
            rationale: 'Focused final rescue: normalize heading hierarchy before final structural repair.',
            confidence: 0.95,
          },
        )
        if (!headingOnlyRescuePath) {
          rescueCalls.push(
            {
              tool_name: 'repair_native_marked_content_refs',
              arguments: { target: 'document' },
              rationale: 'Focused final rescue: repair marked-content references that still block structure conformance.',
              confidence: 0.94,
            },
            {
              tool_name: 'repair_bootstrapped_chart_content_refs',
              arguments: { target: 'document' },
              rationale: 'Focused final rescue: reconcile residual bootstrapped content references before final validation.',
              confidence: 0.9,
            },
          )
        }
        rescueCalls.push({
          tool_name: 'repair_structure_conformance',
          arguments: { target: 'document' },
          rationale: headingOnlyRescuePath
            ? 'Focused final rescue: run one final structure-conformance pass after bounded heading cleanup.'
            : 'Focused final rescue: run one last structure-conformance repair on the exact final document state.',
          confidence: 0.96,
        })
        if (needsTableRescue && !usingSpecializedAnnotationTableTail) {
          rescueCalls.push({
            tool_name: 'repair_native_table_headers',
            arguments: { target: 'document' },
            rationale: 'Focused final rescue: repair native table headers before authoritative final scoring.',
            confidence: 0.9,
          })
          for (const candidate of (context.tableCandidates || []).filter(entry => entry.repairMode === 'safe' && !entry.hasHeaders && !!entry.ref).slice(0, compactMixedFinalRescue ? 2 : 4)) {
            rescueCalls.push({
              tool_name: 'set_table_header_cells',
              arguments: { targets: [candidate.ref] },
              rationale: `Focused final rescue: set header cells for table ${candidate.ref}.`,
              confidence: 0.87,
            })
          }
        }

        const needsBookmarkRescue =
          hasBlockingLocalFinding(currentResult, 'pdfua.bookmark_language')
          || hasUnresolvedCategoryLabel(currentResult, 'Bookmarks / Navigation')
        if (needsBookmarkRescue && !compactMixedFinalRescue && !mixedRuntimeGovernorTripped && (context.headingCandidates ?? []).length > 0) {
          const bookmarkHeadingCandidates = (context.headingCandidates ?? []).slice(0, 30)
          rescueCalls.push({
            tool_name: 'replace_bookmarks_from_headings',
            arguments: {
              headings: bookmarkHeadingCandidates.map((c, i) => ({
                text: c.text,
                level: (c.pageNumber === 1 && i === 0) ? 'H1' : 'H2',
                pageNumber: c.pageNumber,
                targetRef: c.targetRef ?? undefined,
              })),
            },
            rationale: 'Rescue: rebuild bookmark tree from heading structure to resolve Bookmarks/Navigation failure.',
            confidence: 0.82,
          })
        }
      }

      if (usingSpecializedAnnotationTableTail) {
        specializedTailAttempted = true
        rescueCalls.push(...buildAnnotationTableTailCalls({
          context,
          analysis: currentResult,
          compactMixedFinalRescue,
        }))
      }

      const stageActions: RemediationActionRecord[] = []
      let changedDocument = false
      const beforeFigureSnapshot = canAttemptAltRescue
        ? buildPhaseProgressSnapshot('figure_description_state', currentResult, context)
        : null
      const attemptedFigureMethodsThisPass = new Set<FigureRescueMethod>()
      const largeResidualDebt = canAttemptAltRescue
        && beforeFigureSnapshot !== null
        && beforeFigureSnapshot.informativeFigureMissingAltCount >= MASS_UNRESOLVED_FIGURE_DEBT_THRESHOLD

      for (const call of dedupeToolCalls(rescueCalls)) {
        if (compactMixedFinalRescue && shouldSkipRescueCallInCompactMixedRescue({
          call,
          context,
          previousActionNames,
        })) {
          continue
        }
        if (call.tool_name === 'normalize_nested_figure_containers' || call.tool_name === 'repair_native_figure_semantics') {
          if (figureMethodsWithNoProgress.has('native_semantics')) continue
          attemptedFigureMethodsThisPass.add('native_semantics')
        }
        if (call.tool_name === 'repair_other_elements_alt_text') {
          if (figureMethodsWithNoProgress.has('authoritative_alt')) continue
          attemptedFigureMethodsThisPass.add('authoritative_alt')
        }
        const outcome = await executeRemediationTool({
          buffer: workingBuffer,
          context,
          call,
        })
        stageActions.push(outcome.action)
        actions.push(outcome.action)
        allExecutedActions.push(outcome.action)
        manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, outcome.manualReviewFlags)
        if (!outcome.action.changedDocumentBytes || outcome.action.outcome === 'rejected') continue
        workingBuffer = outcome.buffer
        changedDocument = true
        noteDocumentMutation(outcome.action)
        context = await inspectRemediationContextSafely(
          workingBuffer,
          currentResult,
          (needsAltRescue && !mixedRuntimeGovernorTripped && !nearPassFigureFastLane) ? 'alt_text_deep' : 'light',
        ) || context
      }

      if (canAttemptAltRescue && !nearPassFigureFastLane && !mixedRuntimeGovernorTripped && !figureMethodsWithNoProgress.has('heuristic_candidates')) {
        const lateCandidates = heuristicEligibleFigureCandidates(context)
          .filter(candidate => shouldRetryLateHeuristicFigureCandidate(candidate, previousActionNames))

        if (lateCandidates.length > 0 && (!largeResidualDebt || attemptedFigureMethodsThisPass.size === 0 || latePhaseConvergence.figure_description_state.lastProgressed === true)) {
          attemptedFigureMethodsThisPass.add('heuristic_candidates')
          const heuristicStage = await runHeuristicFigureFallbackStage({
            buffer: workingBuffer,
            result: currentResult,
            context,
            previousActionNames,
            inspectionCache,
          })
          if (!heuristicStage.buffer.equals(workingBuffer)) {
            workingBuffer = heuristicStage.buffer
            changedDocument = true
          }
          currentResult = heuristicStage.result
          currentResultHasFreshVeraPdf = !heuristicStage.usedInheritedVeraPdf
          actions.push(...heuristicStage.actions)
          allExecutedActions.push(...heuristicStage.actions)
          stageActions.push(...heuristicStage.actions)
          manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, heuristicStage.manualReviewFlags)
          for (const action of heuristicStage.actions) noteDocumentMutation(action)
          context = await inspectRemediationContextSafely(
            workingBuffer,
            currentResult,
            (needsAltRescue && !mixedRuntimeGovernorTripped) ? 'alt_text_deep' : 'light',
          ) || context
        }
      }

      previousActionNames = Array.from(new Set([
        ...previousActionNames,
        ...stageActions.flatMap(actionHistoryKeys),
      ]))

      if (!changedDocument) {
        if (canAttemptAltRescue) {
          markLatePhaseConverged('figure_description_state')
          setFigureDescriptionStopReason(
            shouldPreferSpecializedTailPass && specializedTailMode === 'figure_tail'
              ? 'figure_tail_plateau'
              : 'no_mutation',
          )
        }
        if (shouldPreferSpecializedTailPass) {
          setResidualCleanupStopReason(
            specializedTailMode === 'font_tail'
              ? 'font_tail_plateau'
              : specializedTailMode === 'annotation_table_tail'
                ? 'annotation_table_tail_plateau'
                : specializedTailMode === 'figure_tail'
                  ? 'figure_tail_plateau'
                  : 'tail_signature_plateau_after_specialized_rescue',
          )
        }
        break
      }

      const rescueStartResult = currentResult
      await ensureAuthoritativeResultForCurrentBuffer()
      latestContext = rebindContextFromCache(currentResult, inspectModeForResult(currentResult))
        || await inspectRemediationContextSafely(workingBuffer, currentResult, inspectModeForResult(currentResult))
        || latestContext
      if (latestContext) {
        refreshClassification(currentResult, latestContext)
      }
      persistStageToolOutcomes(stageActions, {
        previous: rescueStartResult,
        next: currentResult,
        roundNumber: round,
        stageNumber: 98,
        standardsImproved: standardsValidationImproved(rescueStartResult, currentResult),
      })
      executedRescuePasses += 1

      if (latestContext && shouldStopFocusedStructureRescueLoop({
        rescuePasses,
        beforeSnapshot: beforeResidualSnapshot,
        afterAnalysis: currentResult,
        afterContext: latestContext,
        stageActions,
      })) {
        const afterResidualBucket = residualCleanupDominantFamily(currentResult, latestContext)
        residualCleanupTracker.lastBucket = afterResidualBucket
        residualCleanupTracker.lastSnapshot = buildResidualCleanupProgressSnapshot(afterResidualBucket, currentResult, latestContext)
        residualCleanupTracker.lastMutationChangedDocument = true
        residualCleanupTracker.lastProgressed = false
        markResidualCleanupBucketConverged(afterResidualBucket)
        markLatePhaseConverged('structure_state')
        setResidualCleanupStopReason(
          afterResidualBucket === 'figure'
            ? 'structure_debt_cleared_figure_debt_remaining'
            : 'mixed_figure_structure_separation_required',
        )
        manualReviewFlags = addFlag(manualReviewFlags, {
          code: 'focused_final_rescue_structure_same_family_no_progress',
          label: 'Focused structure rescue stopped early',
          severity: 'warning',
          details: 'Stopped focused final rescue because repeated structure-conformance cycles kept the same mixed residual family while figure debt remained dominant.',
        })
        break
      }

      if (beforeFigureSnapshot && latestContext) {
        const afterFigureSnapshot = buildPhaseProgressSnapshot('figure_description_state', currentResult, latestContext)
        const stopDecision = shouldStopFocusedFigureRescue({
          before: beforeFigureSnapshot,
          after: afterFigureSnapshot,
          changedDocumentBytes: true,
          noProgressMethods: figureMethodsWithNoProgress,
          attemptedMethods: attemptedFigureMethodsThisPass,
          largeResidualDebt,
        })
        if (stopDecision.stop) {
          // Allow one extra pass when the same_blocking_keys signal fires on the very
          // first rescue pass but the document bytes actually changed — structure repair
          // may have created new opportunities that a second pass can address.
          const suppressEarlyExit =
            rescuePasses === 0
            && stopDecision.reason === 'same_blocking_keys'
            && changedDocument

          if (!suppressEarlyExit) {
            for (const method of attemptedFigureMethodsThisPass) {
              figureMethodsWithNoProgress.add(method)
            }
            updateLatePhaseProgress({
              phase: 'figure_description_state',
              before: beforeFigureSnapshot,
              afterAnalysis: currentResult,
              afterContext: latestContext,
              changedDocumentBytes: true,
              noProgressLimit: 1,
            })
            setFigureDescriptionStopReason(stopDecision.reason || 'same_blocking_keys')
            break
          }
        }
        for (const method of attemptedFigureMethodsThisPass) {
          figureMethodsAttempted.add(method)
        }
      }

      if (latestContext) {
        const afterResidualBucket = residualCleanupDominantFamily(currentResult, latestContext)
        const afterResidualSnapshot = buildResidualCleanupProgressSnapshot(afterResidualBucket, currentResult, latestContext)
        const residualImproved = didResidualCleanupProgressImprove(
          beforeResidualSnapshot,
          afterResidualSnapshot,
          true,
        )
        const specializedImprovedThisPass =
          currentResult.overallScore > rescueStartResult.overallScore
          || residualImproved
          || residualBlockingSignature(currentResult) !== residualBlockingSignature(rescueStartResult)
        if (shouldPreferSpecializedTailPass && specializedImprovedThisPass) {
          specializedTailImproved = true
        }
        if (beforeResidualBucket === 'mixed' && afterResidualBucket === 'mixed' && !residualImproved) {
          mixedNoShrinkPasses += 1
        } else {
          mixedNoShrinkPasses = 0
        }
      }

      const nextSignature = remediationStateSignature(currentResult)
      const repeatedResidualSignature = residualBlockingSignature(currentResult) === residualBlockingSignature(rescueStartResult)
      if (nextSignature === lastSignature) {
        if (!shouldPreferSpecializedTailPass && specializedTailMode !== 'none' && nearPassTailEligible) {
          forceSpecializedTailMode = specializedTailMode
          rescuePasses += 1
          continue
        }
        if (canAttemptAltRescue) {
          markLatePhaseConverged('figure_description_state')
          setFigureDescriptionStopReason(
            shouldPreferSpecializedTailPass && specializedTailMode === 'figure_tail'
              ? 'figure_tail_plateau'
              : 'same_blocking_keys',
          )
        }
        if (shouldPreferSpecializedTailPass) {
          setResidualCleanupStopReason(
            specializedTailMode === 'font_tail'
              ? 'font_tail_plateau'
              : specializedTailMode === 'annotation_table_tail'
                ? 'annotation_table_tail_plateau'
                : specializedTailMode === 'figure_tail'
                  ? 'figure_tail_plateau'
                  : 'tail_signature_plateau_after_specialized_rescue',
          )
        }
        break
      }
      if (repeatedResidualSignature && !shouldPreferSpecializedTailPass && specializedTailMode !== 'none' && nearPassTailEligible) {
        forceSpecializedTailMode = specializedTailMode
        lastSignature = nextSignature
        rescuePasses += 1
        continue
      }
      if (headingOnlyRescuePath || nearPassFigureFastLane || mixedRuntimeGovernorTripped) {
        if (mixedRuntimeGovernorTripped) {
          compactFinalRescueFallback = true
        }
        break
      }
      forceSpecializedTailMode = null
      lastSignature = nextSignature
      rescuePasses += 1
    }

    remediationMetrics.runtimeSummary = {
      lightInspectionCount: remediationMetrics.runtimeSummary?.lightInspectionCount ?? 0,
      deepInspectionCount: remediationMetrics.runtimeSummary?.deepInspectionCount ?? 0,
      semanticCallCount: remediationMetrics.runtimeSummary?.semanticCallCount ?? 0,
      providerCallCount: remediationMetrics.runtimeSummary?.providerCallCount ?? 0,
      focusedRescuePassCount: executedRescuePasses,
      mixedRuntimeGovernorFired,
      compactFinalRescueFallback,
      authoritativeFinalScoringReached: false,
      specializedTailMode: lastSpecializedTailModeUsed,
      specializedTailAttempted,
      specializedTailImproved,
    }

    if (
      remediationMetrics.phases.figure_description_state.focusedRescueRan
      && !remediationMetrics.phases.figure_description_state.finalStopReason
      && figureMethodsAttempted.size > 0
    ) {
      setFigureDescriptionStopReason('completed')
    }
  }

  if (originalResult.isScanned && await isOcrAvailable()) {
    options?.onProgress?.({ stage: 'Running OCR on scanned PDF', percent: 8 })
    const ocrBuffer = await ocrPdfToSearchablePdf(workingBuffer, {
      signal: options?.signal,
      onProgress: options?.onProgress,
    })
    const ocrResult = await analyzeIntermediate(ocrBuffer, currentResult)
    const ocrAction: RemediationActionRecord = {
      tool: 'ocr_scanned_pdf',
      target: 'document',
      details: 'Converted the scanned PDF into a searchable PDF with an invisible OCR text layer while preserving page appearance.',
      confidence: 0.92,
      autoApplied: true,
      changedVisibleContent: false,
      categoryTargets: ['text_extractability', 'reading_order', 'pdf_ua_compliance'],
      changedDocumentBytes: true,
      outcome: 'applied',
      scoreDelta: [
        {
          categoryId: 'text_extractability',
          before: scoreForCategory(currentResult, 'text_extractability'),
          after: scoreForCategory(ocrResult, 'text_extractability'),
        },
      ],
    }
    workingBuffer = ocrBuffer
    currentResult = ocrResult
    currentResultHasFreshVeraPdf = false
    inspectionState.structureDirty = true
    inspectionState.deepAltDirty = true
    inspectionState.semanticDirty = true
    actions.push(ocrAction)
    previousActionNames.push('ocr_scanned_pdf:document')
    pathFallbacks = [...pathFallbacks, 'ocr_searchable_pdf']
    visibleContentChangePolicy = 'no_visible_changes'
  }

  if (options?.signal?.aborted) {
    const error = new Error('Remediation cancelled') as Error & { aborted?: boolean }
    error.aborted = true
    throw error
  }

  // Single inspection pass
  options?.onProgress?.({ stage: 'Inspecting PDF structure', percent: 20 })
  let stageContext = await inspectRemediationContext(workingBuffer, currentResult)
  await syncAltTextReviewSidecar(stageContext)
  remediationMetrics.ownershipRiskInitial = acrobatOwnershipRiskCount(stageContext)
  remediationMetrics.figureMissingAltInitial = informativeFigureMissingAltCount(stageContext)
  remediationMetrics.decorativeFigureInitial = decorativeFigureCount(stageContext)

  nativeTaggedSafeMode = isNativeTaggedSafeContext(stageContext, currentResult)
  currentTitle = stageContext.pdfjs.title || currentTitle
  currentLanguage = stageContext.qpdf.lang || stageContext.pdfjs.lang || currentLanguage

  type PlanResult = Awaited<ReturnType<typeof planRemediationActions>>
  let plan: PlanResult
  const allExecutedActions: RemediationActionRecord[] = []
  let round = 1

  type StageExecutionEntry = {
    call: RemediationToolCall
    action: RemediationActionRecord
    beforeBuffer: Buffer
    afterBuffer: Buffer
    afterContext: Awaited<ReturnType<typeof inspectPdfForRemediation>>
    afterTitle: string
    afterLanguage: string
    manualReviewFlags: ModelReviewFlag[]
    batchCluster?: {
      id: number
      calls: RemediationToolCall[]
      beforeBuffer: Buffer
      beforeContext: Awaited<ReturnType<typeof inspectPdfForRemediation>>
      beforeTitle: string
      beforeLanguage: string
    }
  }

  let nextBatchClusterId = 1

  const clusterStageCalls = (
    calls: RemediationToolCall[],
    context: Awaited<ReturnType<typeof inspectPdfForRemediation>>,
  ): RemediationToolCall[][] => {
    const clusters: RemediationToolCall[][] = []
    let currentCluster: RemediationToolCall[] = []

    for (const call of calls) {
      const mutation = buildBatchMutationForCall(call, context)
      if (STAGE_BATCHABLE_TOOLS.has(call.tool_name) && mutation) {
        currentCluster.push(call)
        continue
      }
      if (currentCluster.length) {
        clusters.push(currentCluster)
        currentCluster = []
      }
      clusters.push([call])
    }

    if (currentCluster.length) clusters.push(currentCluster)
    return clusters
  }

  const executeSingleCall = async (
    call: RemediationToolCall,
    buffer: Buffer,
    context: Awaited<ReturnType<typeof inspectPdfForRemediation>>,
  ) => executeRemediationTool({ buffer, context, call })

  const executeBatchedCluster = async (
    calls: RemediationToolCall[],
    buffer: Buffer,
    context: Awaited<ReturnType<typeof inspectPdfForRemediation>>,
  ): Promise<{
    buffer: Buffer
    actions: RemediationActionRecord[]
    manualReviewFlags: ModelReviewFlag[]
    changedDocument: boolean
    usedBatch: boolean
    afterContext?: Awaited<ReturnType<typeof inspectPdfForRemediation>>
    batchCluster?: NonNullable<StageExecutionEntry['batchCluster']>
  }> => {
    if (calls.length <= 1) {
      const outcome = await executeSingleCall(calls[0]!, buffer, context)
      return {
        buffer: outcome.buffer,
        actions: [outcome.action],
        manualReviewFlags: outcome.manualReviewFlags,
        changedDocument: !!outcome.action.changedDocumentBytes && outcome.action.outcome !== 'rejected',
        usedBatch: false,
      }
    }

    const mutations = calls.map(call => buildBatchMutationForCall(call, context))
    if (mutations.some(mutation => !mutation)) {
      let working = buffer
      let flags: ModelReviewFlag[] = []
      const actions: RemediationActionRecord[] = []
      let changedDocument = false
      for (const call of calls) {
        const outcome = await executeSingleCall(call, working, context)
        working = outcome.buffer
        actions.push(outcome.action)
        flags = mergeManualReviewFlags(flags, outcome.manualReviewFlags)
        changedDocument = changedDocument || (!!outcome.action.changedDocumentBytes && outcome.action.outcome !== 'rejected')
      }
      return { buffer: working, actions, manualReviewFlags: flags, changedDocument, usedBatch: false }
    }

    const batchResult = await runPdfStructureBackendBatch({
      buffer,
      mutations: mutations as StructureBackendMutationRequest[],
      includeSnapshot: false,
      inspectMode: inspectModeForResult(currentResult),
    })
    const operationResults = batchResult.operationResults || []
    const changedDocument = operationResults.some(result => result.changedDocumentBytes)
    const invalidBatch = batchResult.status === 'failed'
      || operationResults.length !== calls.length
      || (changedDocument && !batchResult.outputBuffer)

    if (invalidBatch) {
      let working = buffer
      let flags: ModelReviewFlag[] = []
      const actions: RemediationActionRecord[] = []
      let changed = false
      for (const call of calls) {
        const outcome = await executeSingleCall(call, working, context)
        working = outcome.buffer
        actions.push(outcome.action)
        flags = mergeManualReviewFlags(flags, outcome.manualReviewFlags)
        changed = changed || (!!outcome.action.changedDocumentBytes && outcome.action.outcome !== 'rejected')
      }
      return { buffer: working, actions, manualReviewFlags: flags, changedDocument: changed, usedBatch: false }
    }

    let manualReviewFlags: ModelReviewFlag[] = []
    const actions = calls.map((call, index) => {
      const translated = toBatchActionRecord({ call, operationResult: operationResults[index] })
      manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, translated.manualReviewFlags)
      return translated.action
    })
    const outputBuffer = batchResult.outputBuffer || buffer
    const afterContext = changedDocument && batchResult.outputBuffer
      ? buildRemediationContextFromSnapshot({
          analysis: currentResult,
          qpdf: context.qpdf,
          pdfjs: context.pdfjs,
          pages: context.pages,
          structure: batchResult,
          inspectMode: inspectModeForResult(currentResult),
          cache: inspectionCache,
        })
      : undefined

    return {
      buffer: outputBuffer,
      actions,
      manualReviewFlags,
      changedDocument,
      usedBatch: true,
      afterContext,
      batchCluster: {
        id: nextBatchClusterId++,
        calls,
        beforeBuffer: buffer,
        beforeContext: context,
        beforeTitle: currentTitle,
        beforeLanguage: currentLanguage,
      },
    }
  }

  const replayBatchClusterIndividually = async (
    cluster: NonNullable<StageExecutionEntry['batchCluster']>,
    checkpointResult: AnalysisResult,
  ): Promise<StageExecutionEntry[]> => {
    let replayBuffer = cluster.beforeBuffer
    let replayContext = cluster.beforeContext
    let replayTitle = cluster.beforeTitle
    let replayLanguage = cluster.beforeLanguage
    const entries: StageExecutionEntry[] = []

    for (const call of cluster.calls) {
      const outcome = await executeSingleCall(call, replayBuffer, replayContext)
      let afterContext = replayContext
      let afterTitle = replayTitle
      let afterLanguage = replayLanguage
      if (outcome.action.changedDocumentBytes && outcome.action.outcome !== 'rejected') {
        afterContext = await inspectRemediationContext(outcome.buffer, checkpointResult)
        afterTitle = afterContext.pdfjs.title || replayTitle
        afterLanguage = afterContext.qpdf.lang || afterContext.pdfjs.lang || replayLanguage
      }
      entries.push({
        call,
        action: outcome.action,
        beforeBuffer: replayBuffer,
        afterBuffer: outcome.buffer,
        afterContext,
        afterTitle,
        afterLanguage,
        manualReviewFlags: outcome.manualReviewFlags,
      })
      replayBuffer = outcome.buffer
      replayContext = afterContext
      replayTitle = afterTitle
      replayLanguage = afterLanguage
    }

    return entries
  }

  const expandBatchedAttemptEntries = async (
    entries: StageExecutionEntry[],
    checkpointResult: AnalysisResult,
  ): Promise<StageExecutionEntry[]> => {
    const expanded: StageExecutionEntry[] = []
    const replayedClusterIds = new Set<number>()
    for (const entry of entries) {
      if (!entry.batchCluster) {
        expanded.push(entry)
        continue
      }
      if (replayedClusterIds.has(entry.batchCluster.id)) continue
      replayedClusterIds.add(entry.batchCluster.id)
      expanded.push(...await replayBatchClusterIndividually(entry.batchCluster, checkpointResult))
    }
    return expanded
  }

  const executeNativeSafeStage = async (
    stageCalls: RemediationToolCall[],
    stageOptions?: {
      includeOverallScoreRegression?: boolean
      rejectionFlagCodePrefix?: string
    },
  ): Promise<{ stageActions: RemediationActionRecord[]; stageChangedDocument: boolean }> => {
    const stageStartBuffer = workingBuffer
    let checkpointBuffer = workingBuffer
    let checkpointResult = currentResult
    let checkpointContext = stageContext
    let checkpointTitle = currentTitle
    let checkpointLanguage = currentLanguage
    let remainingCalls = [...stageCalls]
    let committedActions: RemediationActionRecord[] = []
    let committedFlags: ModelReviewFlag[] = []
    let stageChangedDocument = false
    let replayCount = 0

    while (remainingCalls.length) {
      replayCount += 1
      if (replayCount > stageCalls.length + 1) break

      let attemptBuffer = checkpointBuffer
      let attemptContext = checkpointContext
      let attemptTitle = checkpointTitle
      let attemptLanguage = checkpointLanguage
      let attemptEntries: StageExecutionEntry[] = []
      let attemptChangedDocument = false

      for (const cluster of clusterStageCalls(remainingCalls, attemptContext)) {
        if (options?.signal?.aborted) {
          const error = new Error('Remediation cancelled') as Error & { aborted?: boolean }
          error.aborted = true
          throw error
        }

        const clusterStartBuffer = attemptBuffer
        const clusterStartContext = attemptContext
        const clusterStartTitle = attemptTitle
        const clusterStartLanguage = attemptLanguage
        const execution = await executeBatchedCluster(cluster, attemptBuffer, attemptContext)
        const clusterAppliedStructureConformance = execution.actions.some(action =>
          action.tool === 'repair_structure_conformance' && action.outcome === 'applied' && action.changedDocumentBytes,
        )
        let afterContext = attemptContext
        let afterTitle = attemptTitle
        let afterLanguage = attemptLanguage

        if (execution.changedDocument) {
          const requestedInspectMode = clusterAppliedStructureConformance ? 'alt_text_deep' : inspectModeForResult(checkpointResult)
          afterContext = execution.afterContext && requestedInspectMode === inspectModeForResult(checkpointResult)
            ? execution.afterContext
            : (
              await inspectRemediationContextSafely(
                execution.buffer,
                checkpointResult,
                clusterAppliedStructureConformance ? 'alt_text_deep' : undefined,
              )
              || checkpointContext
            )
          afterTitle = afterContext.pdfjs.title || attemptTitle
          afterLanguage = afterContext.qpdf.lang || afterContext.pdfjs.lang || attemptLanguage
          attemptChangedDocument = true
        }

        for (let index = 0; index < execution.actions.length; index += 1) {
          attemptEntries.push({
            call: cluster[index]!,
            action: execution.actions[index]!,
            beforeBuffer: clusterStartBuffer,
            afterBuffer: execution.buffer,
            afterContext,
            afterTitle,
            afterLanguage,
            manualReviewFlags: index === execution.actions.length - 1 ? execution.manualReviewFlags : [],
            batchCluster: execution.usedBatch ? {
              ...(execution.batchCluster!),
              beforeBuffer: clusterStartBuffer,
              beforeContext: clusterStartContext,
              beforeTitle: clusterStartTitle,
              beforeLanguage: clusterStartLanguage,
            } : undefined,
          })
        }

        let latestClusterBuffer = execution.buffer
        if (
          clusterAppliedStructureConformance
          && !cluster.some(call => call.tool_name === 'repair_other_elements_alt_text')
          && hasDeterministicAcrobatOwnershipRisk(afterContext)
        ) {
          const followUp = await executeRemediationTool({
            buffer: latestClusterBuffer,
            context: afterContext,
            call: {
              tool_name: 'repair_other_elements_alt_text',
              arguments: { target: 'document' },
              rationale: 'Resolve Acrobat-style ownership risks surfaced by structure conformance before stage validation.',
              confidence: 0.92,
            },
          })
          attemptEntries.push({
            call: {
              tool_name: 'repair_other_elements_alt_text',
              arguments: { target: 'document' },
              rationale: 'Resolve Acrobat-style ownership risks surfaced by structure conformance before stage validation.',
              confidence: 0.92,
            },
            action: followUp.action,
            beforeBuffer: latestClusterBuffer,
            afterBuffer: followUp.buffer,
            afterContext,
            afterTitle,
            afterLanguage,
            manualReviewFlags: followUp.manualReviewFlags,
            batchCluster: undefined,
          })
          if (followUp.action.changedDocumentBytes && followUp.action.outcome !== 'rejected') {
            latestClusterBuffer = followUp.buffer
            afterContext = await inspectRemediationContext(followUp.buffer, checkpointResult, 'alt_text_deep')
            afterTitle = afterContext.pdfjs.title || afterTitle
            afterLanguage = afterContext.qpdf.lang || afterContext.pdfjs.lang || afterLanguage
            attemptChangedDocument = true
          }
        }

        attemptBuffer = latestClusterBuffer
        attemptContext = afterContext
        attemptTitle = afterTitle
        attemptLanguage = afterLanguage
      }

      if (!attemptChangedDocument) {
        committedActions = [...committedActions, ...attemptEntries.map(entry => entry.action)]
        committedFlags = mergeManualReviewFlags(committedFlags, attemptEntries.flatMap(entry => entry.manualReviewFlags))
        remainingCalls = []
        break
      }

      const analyzedAttempt = await analyzeIntermediate(attemptBuffer, checkpointResult, {
        forceStructureForScoring: requiresDeepStructureScoring(attemptEntries.map(entry => entry.action)),
        preferDeepStructureInspect: shouldPreferDeepStructureInspect(
          requiresDeepStructureInspect(attemptEntries.map(entry => entry.action))
            || requiresLongReportStructureInspect(attemptEntries.map(entry => entry.action), checkpointResult),
          checkpointResult,
        ),
      })
      const attemptRegressionReason = nativeStageRegressionReason(
        checkpointResult,
        analyzedAttempt,
        attemptEntries.map(entry => entry.action),
        { includeOverallScoreRegression: stageOptions?.includeOverallScoreRegression },
      )

      if (!attemptRegressionReason) {
        const stageImprovedStandards = standardsValidationImproved(checkpointResult, analyzedAttempt)
        for (const entry of attemptEntries) {
          if (entry.action.changedDocumentBytes) {
            const improved = applyScoreDelta(entry.action, checkpointResult, analyzedAttempt)
            if (!improved && !stageImprovedStandards && entry.action.outcome === 'applied') {
              entry.action.outcome = 'no_effect'
            }
          }
        }
        committedActions = [...committedActions, ...attemptEntries.map(entry => entry.action)]
        committedFlags = mergeManualReviewFlags(committedFlags, attemptEntries.flatMap(entry => entry.manualReviewFlags))
        checkpointBuffer = attemptBuffer
        checkpointResult = analyzedAttempt
        checkpointContext = await inspectRemediationContextSafely(attemptBuffer, analyzedAttempt)
          || attemptContext
        checkpointTitle = checkpointContext.pdfjs.title || attemptTitle
        checkpointLanguage = checkpointContext.qpdf.lang || checkpointContext.pdfjs.lang || attemptLanguage
        stageChangedDocument = stageChangedDocument || !checkpointBuffer.equals(stageStartBuffer)
        remainingCalls = []
        break
      }

      attemptEntries = await expandBatchedAttemptEntries(attemptEntries, checkpointResult)

      const changedEntries = attemptEntries
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.action.changedDocumentBytes && entry.action.outcome !== 'rejected')

      let culpritIndex = changedEntries.at(-1)?.index ?? 0
      let culpritReason = attemptRegressionReason
      let lastGoodResult = checkpointResult
      let priorResultForEntry = checkpointResult

      for (const [position, { entry, index }] of changedEntries.entries()) {
        const analyzedEntry = position === changedEntries.length - 1
          ? analyzedAttempt
          : await analyzeIntermediate(entry.afterBuffer, checkpointResult, {
              forceStructureForScoring: requiresDeepStructureScoring([entry.action]),
              preferDeepStructureInspect: shouldPreferDeepStructureInspect(
                requiresDeepStructureInspect([entry.action])
                  || requiresLongReportStructureInspect([entry.action], checkpointResult),
                checkpointResult,
              ),
            })
        const entryRegressionReason = nativeStageRegressionReason(
          priorResultForEntry,
          analyzedEntry,
          [entry.action],
          { includeOverallScoreRegression: stageOptions?.includeOverallScoreRegression },
        )
        if (entryRegressionReason) {
          culpritIndex = index
          culpritReason = entryRegressionReason
          break
        }
        lastGoodResult = analyzedEntry
        priorResultForEntry = analyzedEntry
      }

      const acceptedEntries = attemptEntries.slice(0, culpritIndex)
      const acceptedStandardsImproved = standardsValidationImproved(checkpointResult, lastGoodResult)
      for (const entry of acceptedEntries) {
        if (entry.action.changedDocumentBytes) {
          const improved = applyScoreDelta(entry.action, checkpointResult, lastGoodResult)
          if (!improved && !acceptedStandardsImproved && entry.action.outcome === 'applied') {
            entry.action.outcome = 'no_effect'
          }
          stageChangedDocument = true
        }
      }
      committedActions = [...committedActions, ...acceptedEntries.map(entry => entry.action)]
      committedFlags = mergeManualReviewFlags(committedFlags, acceptedEntries.flatMap(entry => entry.manualReviewFlags))

      const culpritEntry = attemptEntries[culpritIndex]
      const rejectedAction: RemediationActionRecord = {
        ...culpritEntry.action,
        details: `${culpritEntry.action.details} Rejected because it ${culpritReason}.`,
        outcome: 'rejected',
        autoApplied: false,
        changedDocumentBytes: false,
      }
      committedActions.push(rejectedAction)
      rejectedActions.push(rejectedAction)
      committedFlags = mergeManualReviewFlags(committedFlags, culpritEntry.manualReviewFlags)
      if (stageOptions?.rejectionFlagCodePrefix) {
        committedFlags = addFlag(committedFlags, {
          code: `${stageOptions.rejectionFlagCodePrefix}_${culpritEntry.action.tool}`,
          label: 'Native structure repair rejected',
          severity: 'warning',
          details: `Rejected ${culpritEntry.action.tool} because it ${culpritReason}.`,
        })
      }

      if (culpritIndex > 0) {
        const priorEntry = attemptEntries[culpritIndex - 1]
        checkpointBuffer = priorEntry.afterBuffer
        checkpointResult = lastGoodResult
        checkpointContext = priorEntry.afterContext
        checkpointTitle = priorEntry.afterTitle
        checkpointLanguage = priorEntry.afterLanguage
      }

      remainingCalls = attemptEntries.slice(culpritIndex + 1).map(entry => entry.call)
    }

    workingBuffer = checkpointBuffer
    currentResult = checkpointResult
    stageContext = checkpointContext
    latestContext = checkpointContext
    const metadataHints = applyMetadataCallHints(stageCalls, committedActions, {
      title: checkpointTitle,
      language: checkpointLanguage,
    })
    currentTitle = metadataHints.title
    currentLanguage = metadataHints.language
    manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, committedFlags)

    return {
      stageActions: committedActions,
      stageChangedDocument,
    }
  }

  const replaceStageActionsInHistory = (
    history: RemediationActionRecord[],
    originalActions: RemediationActionRecord[],
    replacementActions: RemediationActionRecord[],
  ): void => {
    if (!originalActions.length) {
      history.push(...replacementActions)
      return
    }
    const startIndex = history.indexOf(originalActions[0]!)
    if (startIndex < 0) return
    history.splice(startIndex, originalActions.length, ...replacementActions)
  }

  const executeNonNativeStageCalls = async (
    stageCalls: RemediationToolCall[],
    stageExecutionContext: Awaited<ReturnType<typeof inspectPdfForRemediation>>,
    startBuffer: Buffer,
  ): Promise<{
    buffer: Buffer
    actions: RemediationActionRecord[]
    manualReviewFlags: ModelReviewFlag[]
    changedDocument: boolean
  }> => {
    let attemptBuffer = startBuffer
    let changedDocument = false
    const attemptActions: RemediationActionRecord[] = []
    let attemptFlags: ModelReviewFlag[] = []

    for (const cluster of clusterStageCalls(stageCalls, stageExecutionContext)) {
      if (options?.signal?.aborted) {
        const error = new Error('Remediation cancelled') as Error & { aborted?: boolean }
        error.aborted = true
        throw error
      }

      const execution = await executeBatchedCluster(cluster, attemptBuffer, stageExecutionContext)
      attemptBuffer = execution.buffer
      if (execution.changedDocument) changedDocument = true
      attemptActions.push(...execution.actions)
      attemptFlags = mergeManualReviewFlags(attemptFlags, execution.manualReviewFlags)
    }

    return {
      buffer: attemptBuffer,
      actions: attemptActions,
      manualReviewFlags: attemptFlags,
      changedDocument,
    }
  }

  const persistResolvedStageToolOutcomes = (
    acceptedActions: RemediationActionRecord[],
    rejectedStageActions: RemediationActionRecord[],
    input: {
      previous: AnalysisResult
      next: AnalysisResult
      roundNumber: number
      stageNumber: number
      standardsImproved: boolean
      playbookId?: string | null
      playbookRunId?: string | null
    },
  ): void => {
    if (acceptedActions.length) {
      persistStageToolOutcomes(acceptedActions, input)
    }
    if (rejectedStageActions.length) {
      persistStageToolOutcomes(rejectedStageActions, {
        ...input,
        next: input.previous,
        standardsImproved: false,
      })
    }
  }

  const tryIsolateNonNativeStageRegression = async (input: {
    stageCalls: RemediationToolCall[]
    stageActions: RemediationActionRecord[]
    stageStartBuffer: Buffer
    stageStartResult: AnalysisResult
    stageStartContext: Awaited<ReturnType<typeof inspectPdfForRemediation>>
    stageStartTitle: string
    stageStartLanguage: string
    rejectionReason: string
  }): Promise<null | {
    stageActions: RemediationActionRecord[]
    acceptedActions: RemediationActionRecord[]
    rejectedActions: RemediationActionRecord[]
    buffer: Buffer
    result: AnalysisResult
    context: Awaited<ReturnType<typeof inspectPdfForRemediation>>
    title: string
    language: string
    manualReviewFlags: ModelReviewFlag[]
    changedDocument: boolean
    improvedStandards: boolean
    improvedTargets: boolean
    appliedAcrobatAltRepair: boolean
  }> => {
    const candidateIndexes = isolationCandidateIndexes(input.stageActions)
    if (candidateIndexes.length < 2) return null

    for (let removeCount = 1; removeCount <= candidateIndexes.length; removeCount += 1) {
      const removedIndexes = new Set(candidateIndexes.slice(-removeCount))
      const retainedCalls = input.stageCalls.filter((_, index) => !removedIndexes.has(index))
      if (!retainedCalls.length) continue

      const replay = await executeNonNativeStageCalls(
        retainedCalls,
        input.stageStartContext,
        input.stageStartBuffer,
      )

      if (!replay.changedDocument) {
        const rejectedActions = input.stageActions
          .filter((_, index) => removedIndexes.has(index))
          .map(action => rejectActionForRegression(action, input.rejectionReason, true))
        return {
          stageActions: [...replay.actions, ...rejectedActions],
          acceptedActions: replay.actions,
          rejectedActions,
          buffer: input.stageStartBuffer,
          result: input.stageStartResult,
          context: input.stageStartContext,
          title: input.stageStartTitle,
          language: input.stageStartLanguage,
          manualReviewFlags: replay.manualReviewFlags,
          changedDocument: false,
          improvedStandards: false,
          improvedTargets: false,
          appliedAcrobatAltRepair: false,
        }
      }

      const analyzedReplay = await analyzeIntermediate(replay.buffer, input.stageStartResult, {
        forceStructureForScoring: requiresDeepStructureScoring(replay.actions),
        preferDeepStructureInspect: shouldPreferDeepStructureInspect(
          requiresDeepStructureInspect(replay.actions)
            || requiresLongReportStructureInspect(replay.actions, input.stageStartResult),
          input.stageStartResult,
        ),
      })
      const appliedAcrobatAltRepair = replay.actions.some(action =>
        action.tool === 'repair_other_elements_alt_text' && action.outcome === 'applied',
      )
      const acceptanceDecision = evaluateStageAcceptance(input.stageStartResult, analyzedReplay, replay.actions)
      const improvedStandards = acceptanceDecision.standardsImproved
      let improvedTargets = false
      for (const action of replay.actions) {
        improvedTargets = applyScoreDelta(action, input.stageStartResult, analyzedReplay) || improvedTargets
        if (!improvedTargets && action.outcome === 'applied') action.outcome = 'no_effect'
      }

      if (!appliedAcrobatAltRepair && !acceptanceDecision.accept) {
        continue
      }

      const replayContext = await inspectRemediationContext(replay.buffer, analyzedReplay)
      const rejectedActions = input.stageActions
        .filter((_, index) => removedIndexes.has(index))
        .map(action => rejectActionForRegression(action, input.rejectionReason, true))

      return {
        stageActions: [...replay.actions, ...rejectedActions],
        acceptedActions: replay.actions,
        rejectedActions,
        buffer: replay.buffer,
        result: analyzedReplay,
        context: replayContext,
        title: replayContext.pdfjs.title || input.stageStartTitle,
        language: replayContext.qpdf.lang || replayContext.pdfjs.lang || input.stageStartLanguage,
        manualReviewFlags: replay.manualReviewFlags,
        changedDocument: true,
        improvedStandards,
        improvedTargets,
        appliedAcrobatAltRepair,
      }
    }

    return null
  }

  const buildOrderedStages = (calls: RemediationToolCall[]): [number, RemediationToolCall[]][] => {
    const stageMap = new Map<number, RemediationToolCall[]>()
    for (const call of filterCallsForPipeline(calls)) {
      const stageNum = TOOL_STAGE_ORDER.get(call.tool_name as any) ?? 99
      if (!stageEnabled(stageNum)) continue
      if (!stageMap.has(stageNum)) stageMap.set(stageNum, [])
      stageMap.get(stageNum)!.push(call)
    }
    return [...stageMap.entries()].sort(([a], [b]) => a - b)
  }

  const derivePlaybookStageCalls = (playbook: PlaybookEntry, steps: PlaybookEntry['toolSequence']): RemediationToolCall[] => {
    const artifacts = buildFailureProfileArtifacts({
      analysis: currentResult,
      context: stageContext,
      actions,
      rejectedActions,
    })
    const usedOpportunityKeys = new Set<string>()
    const selectedCalls: RemediationToolCall[] = []

    for (const step of steps) {
      const opportunity = artifacts.failureProfile.toolOpportunities.find(entry =>
        entry.status === 'auto_runnable'
        && entry.toolName === step.tool
        && entry.scope === step.scope
        && !usedOpportunityKeys.has(entry.key),
      )
      if (!opportunity) continue
      const call = deriveDeterministicCall({
        filename,
        analysis: currentResult,
        context: stageContext,
        opportunity,
        selectedActions: selectedCalls,
      })
      if (!call) continue
      usedOpportunityKeys.add(opportunity.key)
      selectedCalls.push(call)
    }

    return filterCallsForPipeline(selectedCalls)
  }

  const executePlaybookStages = async (playbook: PlaybookEntry): Promise<boolean> => {
    const playbookStages = [...new Set(playbook.toolSequence.map(step => step.stage))].sort((a, b) => a - b)
    for (const stageNum of playbookStages) {
      if (!stageEnabled(stageNum)) continue
      stagesRun.add(stageNum)
      const stageSteps = playbook.toolSequence.filter(step => step.stage === stageNum)
      stageContext = await inspectRemediationContext(workingBuffer, currentResult, inspectModeForResult(currentResult))
      const stageCalls = derivePlaybookStageCalls(playbook, stageSteps)
      if (!stageCalls.length) continue

      const stageStartBuffer = workingBuffer
      const stageStartResult = currentResult
      const stageActions: RemediationActionRecord[] = []
      let stageChangedDocument = false
      let stageImprovedStandards = false
      let stageImprovedTargets = false
      let stageAppliedAcrobatAltRepair = false

      if (nativeTaggedSafeMode) {
        const nativeStage = await executeNativeSafeStage(stageCalls, {
          rejectionFlagCodePrefix: 'playbook_native_rejected',
        })
        stageActions.push(...nativeStage.stageActions)
        actions.push(...nativeStage.stageActions)
        allExecutedActions.push(...nativeStage.stageActions)
        stageChangedDocument = nativeStage.stageChangedDocument
        if (stageChangedDocument) {
          stageImprovedStandards = standardsValidationImproved(stageStartResult, currentResult)
          stageImprovedTargets = stageActions.some(action => actionHasMeaningfulProgress(action))
        }
      } else {
        for (const cluster of clusterStageCalls(stageCalls, stageContext)) {
          const execution = await executeBatchedCluster(cluster, workingBuffer, stageContext)
          workingBuffer = execution.buffer
          if (execution.changedDocument) stageChangedDocument = true
          stageActions.push(...execution.actions)
          actions.push(...execution.actions)
          allExecutedActions.push(...execution.actions)
          manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, execution.manualReviewFlags)
          for (const action of execution.actions) noteDocumentMutation(action)
        }
      }

      if (!nativeTaggedSafeMode && stageChangedDocument) {
        const activeResidualFamily = currentFamilyCompletionTarget(stageContext)
        const residualBucket = activeResidualFamily
          ? residualFamilyBucketFromDecision(activeResidualFamily)
          : residualCleanupDominantFamily(stageStartResult, stageContext)
        const residualBeforeSnapshot = buildResidualCleanupProgressSnapshot(residualBucket, stageStartResult, stageContext)
        const allowResidualDeepFollowUp = shouldAllowResidualFamilyDeepFollowUp({
          tracker: residualCleanupTracker,
          bucket: residualBucket,
          pressure: residualBeforeSnapshot.pressure,
          snapshot: residualBeforeSnapshot,
          familyId: activeResidualFamily?.id || null,
          stageIntroducedNewFamily:
            !!activeResidualFamily
            && residualCleanupTracker.lastFamilyId !== activeResidualFamily.id,
        })
        const analyzedStage = await analyzeIntermediate(workingBuffer, stageStartResult, {
          forceStructureForScoring: requiresDeepStructureScoring(stageActions),
          preferDeepStructureInspect: allowResidualDeepFollowUp && shouldPreferDeepStructureInspect(
            requiresDeepStructureInspect(stageActions)
              || requiresLongReportStructureInspect(stageActions, stageStartResult),
            stageStartResult,
          ),
        })
        const isAcrobatAltRepair = stageActions.some(
          action => action.tool === 'repair_other_elements_alt_text' && action.outcome === 'applied',
        )
        stageAppliedAcrobatAltRepair = isAcrobatAltRepair
        const acceptanceDecision = evaluateStageAcceptance(stageStartResult, analyzedStage, stageActions)
        stageImprovedStandards = acceptanceDecision.standardsImproved
        for (const action of stageActions) {
          stageImprovedTargets = applyScoreDelta(action, stageStartResult, analyzedStage) || stageImprovedTargets
          if (!stageImprovedTargets && action.outcome === 'applied') action.outcome = 'no_effect'
        }
        if (!isAcrobatAltRepair && !acceptanceDecision.accept) {
          for (const action of stageActions) {
            if (action.changedDocumentBytes || action.outcome === 'no_effect') {
              const rejected = {
                ...action,
                details: `${action.details} Rejected because ${acceptanceDecision.reason || 'the playbook stage failed the net-benefit acceptance policy'}.`,
                outcome: 'rejected' as const,
                autoApplied: false,
                changedDocumentBytes: false,
              }
              const idx = actions.indexOf(action)
              if (idx >= 0) actions[idx] = rejected
              const stageIdx = stageActions.indexOf(action)
              if (stageIdx >= 0) stageActions[stageIdx] = rejected
              rejectedActions.push(rejected)
            }
          }
          workingBuffer = stageStartBuffer
          currentResult = stageStartResult
          persistStageToolOutcomes(stageActions, {
            previous: stageStartResult,
            next: stageStartResult,
            roundNumber: 0,
            stageNumber: stageNum,
            standardsImproved: false,
            playbookId: playbook.id,
            playbookRunId: matchedPlaybookRun?.id || null,
          })
	      } else {
	        currentResult = analyzedStage
	        currentResultHasFreshVeraPdf = false
          if (activeResidualFamily || residualBucket !== 'unknown') {
            updateResidualCleanupProgress({
              familyId: activeResidualFamily?.id || null,
              bucket: residualBucket,
              before: residualBeforeSnapshot,
              afterAnalysis: analyzedStage,
              afterContext: stageContext,
              changedDocumentBytes: true,
            })
          }
	        persistStageToolOutcomes(stageActions, {
	          previous: stageStartResult,
	          next: analyzedStage,
            roundNumber: 0,
            stageNumber: stageNum,
            standardsImproved: stageImprovedStandards,
            playbookId: playbook.id,
            playbookRunId: matchedPlaybookRun?.id || null,
          })
        }
        stageContext = await inspectRemediationContext(workingBuffer, currentResult)
        currentTitle = stageContext.pdfjs.title || currentTitle
        currentLanguage = stageContext.qpdf.lang || stageContext.pdfjs.lang || currentLanguage
        await maybeRefreshClassificationFromStage(stageActions)
      } else if (stageChangedDocument) {
        persistStageToolOutcomes(stageActions, {
          previous: stageStartResult,
          next: currentResult,
          roundNumber: 0,
          stageNumber: stageNum,
          standardsImproved: stageImprovedStandards,
          playbookId: playbook.id,
          playbookRunId: matchedPlaybookRun?.id || null,
        })
        await maybeRefreshClassificationFromStage(stageActions)
      }

      previousActionNames = Array.from(new Set([
        ...previousActionNames,
        ...stageActions.flatMap(actionHistoryKeys),
      ]))

      if (currentResult.grade === 'A') return true
      if (workingBuffer.equals(stageStartBuffer) && !stageAppliedAcrobatAltRepair && !stageImprovedStandards && !stageImprovedTargets) {
        return false
      }
    }

    return currentResult.grade === 'A'
  }

  const initialProfileArtifacts = buildFailureProfileArtifacts({
    analysis: currentResult,
    context: stageContext,
    actions,
    rejectedActions,
  })
  plan = {
    done: false,
    actions: [],
    unresolvedIssues: unresolvedIssues(currentResult),
    failureProfile: initialProfileArtifacts.failureProfile,
    plannerEvidence: initialProfileArtifacts.plannerEvidence,
  }
  playbookInitialArtifacts = initialProfileArtifacts
  playbookInitialAnalysis = currentResult
  playbookInitialContext = stageContext
  const initialFailureSignature = buildFailureSignature({
    failureProfile: initialProfileArtifacts.failureProfile,
    analysis: currentResult,
    context: stageContext,
  })
  playbookInitialSignature = initialFailureSignature
  matchedPlaybook = findUsablePlaybookBySignatureHash(initialFailureSignature.hash)

  if (matchedPlaybook) {
    options?.onProgress?.({ stage: 'Applying learned playbook', percent: 28 })
    matchedPlaybookRun = createPlaybookRun({
      playbook: matchedPlaybook,
      failureSignature: initialFailureSignature,
      initialScore: currentResult.overallScore,
    })
    const playbookSucceeded = await executePlaybookStages(matchedPlaybook)
    if (playbookSucceeded) {
      playbookFastPathSucceeded = true
      skipDirectToFinalCleanup = true
      plan = {
        done: true,
        actions: [],
        unresolvedIssues: unresolvedIssues(currentResult),
        failureProfile: initialProfileArtifacts.failureProfile,
        plannerEvidence: initialProfileArtifacts.plannerEvidence,
      }
    } else {
      matchedPlaybookRun = finalizePlaybookRun({
        playbook: matchedPlaybook,
        run: matchedPlaybookRun,
        outcome: 'failed',
        finalScore: currentResult.overallScore,
      })
    }
  }

  if (!playbookFastPathSucceeded) {
    // Grade-then-fix rounds: after each round we re-analyze and re-plan to catch regressions and new fixable issues.
    options?.onProgress?.({ stage: 'Planning remediation', percent: 32 })
  plan = await planRemediationActions({
    filename,
    analysis: currentResult,
    context: stageContext,
    iteration: 1,
    actions,
    rejectedActions,
    pipelineConfig: currentPipelineConfig,
  })
  absorbProviderTelemetry('remediationPlanService')
  }

  let consecutiveNoProgressStages = 0
  let lastPlanSignature = JSON.stringify(plan.actions.map(call => `${call.tool_name}:${JSON.stringify(call.arguments || {})}`))
  let stableStateRepeats = 0
  let lastStableStateSignature = remediationStateSignature(currentResult)
  let coarseStableStateRepeats = 0
  let lastCoarseStableStateSignature = remediationCoarseStateSignature(currentResult)

  while (!playbookFastPathSucceeded && round <= (currentPipelineConfig?.maxRounds || REMEDIATION.MAX_REMEDIATION_ROUNDS)) {
    remediationTimings.roundsExecuted += 1
    let orderedStages: [number, PlanResult['actions']][]
    if (round === 1) {
      orderedStages = buildOrderedStages(plan.actions)
    } else {
      // Quality shortcircuit: if the PDF is already fully compliant, stop before re-inspecting.
      if (isFullyDone(currentResult)) break
      options?.onProgress?.({ stage: `Re-analyzing and planning (round ${round})`, percent: 35 + (round - 1) * 10 })
      const planningInspectMode = inspectModeForResult(currentResult)
      stageContext = await inspectRemediationContextSafely(workingBuffer, currentResult, planningInspectMode)
        || stageContext
      plan = await planRemediationActions({
        filename,
        analysis: currentResult,
        context: stageContext,
        iteration: round,
        actions,
        rejectedActions,
        pipelineConfig: currentPipelineConfig,
      })
      absorbProviderTelemetry('remediationPlanService')
      if (plan.actions.length === 0 || plan.done) break
      const planSignature = JSON.stringify(plan.actions.map(call => `${call.tool_name}:${JSON.stringify(call.arguments || {})}`))
      if (round > 1 && planSignature === lastPlanSignature && consecutiveNoProgressStages >= REMEDIATION.MAX_NO_PROGRESS_STAGES && planningInspectMode !== 'alt_text_deep') {
        break
      }
      lastPlanSignature = planSignature
      orderedStages = buildOrderedStages(plan.actions)
    }

	    let roundChangedDocument = false
	    let stopAfterRound = false
	    for (const [stageNum, stageCalls] of orderedStages) {
	      if (!stageEnabled(stageNum)) continue
      if (roundChangedDocument || stageCalls.some(call => CANDIDATE_SENSITIVE_TOOLS.has(call.tool_name))) {
        stageContext = await inspectRemediationContext(workingBuffer, currentResult, inspectModeForResult(currentResult))
      }
	      remediationTimings.stagesExecuted += 1
      if (options?.signal?.aborted) {
        const error = new Error('Remediation cancelled') as Error & { aborted?: boolean }
        error.aborted = true
        throw error
      }

	      options?.onProgress?.({ stage: `Applying PDF fixes (stage ${stageNum})`, percent: 35 + stageNum * 5 })
	      stagesRun.add(stageNum)
    const stageStartBuffer = workingBuffer
    const stageStartResult = currentResult
    const stageActions: RemediationActionRecord[] = []
    let stageChangedDocument = false
    let stageImprovedStandards = false
    let stageImprovedTargets = false
    let stageAppliedAcrobatAltRepair = false

    if (nativeTaggedSafeMode) {
      const nativeStage = await executeNativeSafeStage(stageCalls, {
        rejectionFlagCodePrefix: 'native_safe_rejected',
      })
      stageActions.push(...nativeStage.stageActions)
      actions.push(...nativeStage.stageActions)
      allExecutedActions.push(...nativeStage.stageActions)
      stageChangedDocument = nativeStage.stageChangedDocument
      if (stageChangedDocument) {
        stageImprovedStandards = standardsValidationImproved(stageStartResult, currentResult)
        stageImprovedTargets = stageActions.some(action => actionHasMeaningfulProgress(action))
      }
    } else {
      const execution = await executeNonNativeStageCalls(stageCalls, stageContext, workingBuffer)
      workingBuffer = execution.buffer
      if (execution.changedDocument) stageChangedDocument = true
      stageActions.push(...execution.actions)
      actions.push(...execution.actions)
      manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, execution.manualReviewFlags)
      for (const action of execution.actions) noteDocumentMutation(action)
    }

    // Non-native mode: single analysis per stage (instead of per action)
    if (!nativeTaggedSafeMode && stageChangedDocument) {
      const analyzedStage = await analyzeIntermediate(workingBuffer, stageStartResult, {
        forceStructureForScoring: requiresDeepStructureScoring(stageActions),
        preferDeepStructureInspect: shouldPreferDeepStructureInspect(
          requiresDeepStructureInspect(stageActions)
            || requiresLongReportStructureInspect(stageActions, stageStartResult),
          stageStartResult,
        ),
      })
      // repair_other_elements_alt_text fixes Adobe Acrobat issues not reflected in our score model
      const isAcrobatAltRepair = stageActions.some(
        a => a.tool === 'repair_other_elements_alt_text' && a.outcome === 'applied',
      )
      stageAppliedAcrobatAltRepair = isAcrobatAltRepair
      const acceptanceDecision = evaluateStageAcceptance(stageStartResult, analyzedStage, stageActions)
      stageImprovedStandards = acceptanceDecision.standardsImproved
      for (const action of stageActions) {
        stageImprovedTargets = applyScoreDelta(action, stageStartResult, analyzedStage) || stageImprovedTargets
        if (!stageImprovedTargets && action.outcome === 'applied') action.outcome = 'no_effect'
      }

      if (!isAcrobatAltRepair && !acceptanceDecision.accept) {
        const isolationReason = acceptanceDecision.reason || 'the stage failed the net-benefit acceptance policy'
        const isolatedStage = await tryIsolateNonNativeStageRegression({
          stageCalls,
          stageActions,
          stageStartBuffer,
          stageStartResult,
          stageStartContext: stageContext,
          stageStartTitle: currentTitle,
          stageStartLanguage: currentLanguage,
          rejectionReason: isolationReason,
        })

        if (isolatedStage) {
          replaceStageActionsInHistory(actions, stageActions, isolatedStage.stageActions)
          stageActions.splice(0, stageActions.length, ...isolatedStage.stageActions)
          rejectedActions.push(...isolatedStage.rejectedActions)
          workingBuffer = isolatedStage.buffer
          currentResult = isolatedStage.result
          stageContext = isolatedStage.context
          currentTitle = isolatedStage.title
          currentLanguage = isolatedStage.language
          manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, isolatedStage.manualReviewFlags)
          manualReviewFlags = addFlag(manualReviewFlags, {
            code: `stage_${stageNum}_isolated_regression`,
            label: 'Regressive tool isolated',
            severity: 'warning',
            details: `Rejected isolated tool changes from stage ${stageNum} because ${isolationReason}.`,
          })
          stageChangedDocument = isolatedStage.changedDocument
          stageImprovedStandards = isolatedStage.improvedStandards
          stageImprovedTargets = isolatedStage.improvedTargets
          stageAppliedAcrobatAltRepair = isolatedStage.appliedAcrobatAltRepair
          currentResultHasFreshVeraPdf = false
          persistResolvedStageToolOutcomes(isolatedStage.acceptedActions, isolatedStage.rejectedActions, {
            previous: stageStartResult,
            next: isolatedStage.result,
            roundNumber: round,
            stageNumber: stageNum,
            standardsImproved: isolatedStage.improvedStandards,
          })
          await maybeRefreshClassificationFromStage(stageActions)
        } else {
          // Rollback entire stage
          const rejectedStageActions = stageActions.map(action =>
            (action.changedDocumentBytes || action.outcome === 'no_effect')
              ? rejectActionForRegression(action, isolationReason, false)
              : action,
          )
          replaceStageActionsInHistory(actions, stageActions, rejectedStageActions)
          stageActions.splice(0, stageActions.length, ...rejectedStageActions)
          for (const action of rejectedStageActions) {
            if (action.outcome === 'rejected') rejectedActions.push(action)
          }
          manualReviewFlags = addFlag(manualReviewFlags, {
            code: `stage_${stageNum}_regressed`,
            label: 'Regressive stage rejected',
            severity: 'warning',
            details: `Rejected remediation stage ${stageNum} because ${acceptanceDecision.reason || 'it failed the net-benefit acceptance policy'}.`,
          })
          workingBuffer = stageStartBuffer
          currentResult = stageStartResult
          persistStageToolOutcomes(stageActions, {
            previous: stageStartResult,
            next: stageStartResult,
            roundNumber: round,
            stageNumber: stageNum,
            standardsImproved: false,
          })
        }
      } else {
        currentResult = analyzedStage
        currentResultHasFreshVeraPdf = false
        persistStageToolOutcomes(stageActions, {
          previous: stageStartResult,
          next: analyzedStage,
          roundNumber: round,
	        stageNumber: stageNum,
	        standardsImproved: stageImprovedStandards,
	      })
	      await maybeRefreshClassificationFromStage(stageActions)
	    }
      stageContext = await inspectRemediationContext(workingBuffer, currentResult)
      currentTitle = stageContext.pdfjs.title || currentTitle
      currentLanguage = stageContext.qpdf.lang || stageContext.pdfjs.lang || currentLanguage
    } else if (stageChangedDocument) {
      persistStageToolOutcomes(stageActions, {
        previous: stageStartResult,
        next: currentResult,
        roundNumber: round,
        stageNumber: stageNum,
        standardsImproved: stageImprovedStandards,
      })
    }

    const stageMetadataHints = applyMetadataCallHints(stageCalls, stageActions, {
      title: currentTitle,
      language: currentLanguage,
    })
    currentTitle = stageMetadataHints.title
    currentLanguage = stageMetadataHints.language

    allExecutedActions.push(...stageActions)
    previousActionNames = Array.from(new Set([
      ...previousActionNames,
      ...stageActions.flatMap(actionHistoryKeys),
    ]))
    if (stageChangedDocument) roundChangedDocument = true
    if (stageChangedDocument && !stageImprovedStandards && !stageImprovedTargets) {
      consecutiveNoProgressStages += 1
      if (requiresDeepStructureInspect(stageActions)) {
        const currentStableStateSignature = remediationStateSignature(currentResult)
        const currentCoarseStableStateSignature = remediationCoarseStateSignature(currentResult)
        const structureChurnStop = shouldStopStructureChurnEarly({
          previousCoarseStableStateSignature: lastCoarseStableStateSignature,
          currentCoarseStableStateSignature,
          coarseStableStateRepeats,
          stableStateRepeats,
          tracker: residualCleanupTracker,
          stageActions,
          currentResult,
          context: stageContext,
          stageAppliedAcrobatAltRepair,
        })
        if (currentStableStateSignature === lastStableStateSignature) {
          stableStateRepeats += 1
        } else {
          stableStateRepeats = 0
          lastStableStateSignature = currentStableStateSignature
        }
        if (currentCoarseStableStateSignature === lastCoarseStableStateSignature) {
          coarseStableStateRepeats += 1
        } else {
          coarseStableStateRepeats = 0
          lastCoarseStableStateSignature = currentCoarseStableStateSignature
        }
        if (stableStateRepeats >= MAX_STABLE_STATE_REPEATS) {
          stopAfterRound = true
          manualReviewFlags = addFlag(manualReviewFlags, {
            code: `stage_${stageNum}_stable_state_loop`,
            label: 'Stable remediation state loop detected',
            severity: 'warning',
            details: `Stopped after repeated no-progress remediation cycles where the analyzed accessibility state did not change ${stableStateRepeats + 1} times.`,
          })
        } else if (structureChurnStop) {
          stopAfterRound = true
          markLatePhaseConverged('structure_state')
          setResidualCleanupStopReason('same_family_no_progress')
          manualReviewFlags = addFlag(manualReviewFlags, {
            code: `stage_${stageNum}_structure_same_family_no_progress`,
            label: 'Structure churn stopped early',
            severity: 'warning',
            details: 'Stopped early because structure-heavy remediation repeated the same blocking families after a deep-structure stage without measurable progress.',
          })
        } else if (coarseStableStateRepeats >= MAX_COARSE_STABLE_STATE_REPEATS) {
          stopAfterRound = true
          manualReviewFlags = addFlag(manualReviewFlags, {
            code: `stage_${stageNum}_coarse_stable_state_loop`,
            label: 'Coarse remediation state loop detected',
            severity: 'warning',
            details: `Stopped after repeated no-progress remediation cycles where the blocking findings and unresolved categories stayed the same ${coarseStableStateRepeats + 1} times${stageAppliedAcrobatAltRepair ? ', including Acrobat-style alt-text repair passes that did not reduce blockers' : ''}.`,
          })
        }
      }
      if (round > 1 && consecutiveNoProgressStages >= REMEDIATION.MAX_NO_PROGRESS_STAGES) {
        stopAfterRound = true
      }
    } else if (stageChangedDocument) {
      consecutiveNoProgressStages = 0
      stableStateRepeats = 0
      coarseStableStateRepeats = 0
      lastStableStateSignature = remediationStateSignature(currentResult)
      lastCoarseStableStateSignature = remediationCoarseStateSignature(currentResult)
    }

	    if (stageChangedDocument) {
	      const checkpointModel: DocumentModel = {
	        version: '6',
        processingPath: 'agent_patch',
        pathFallbacks,
        title: currentTitle,
        language: currentLanguage,
        sourceType: inferSourceType(originalResult),
        confidenceSummary: confidenceSummary(actions),
        iterations: [],
        actions: [...actions],
        rejectedActions: [...rejectedActions],
        nativeTaggedSafeMode,
        visibleContentChangePolicy,
        originalVeraPdf: summarizeVeraPdf(originalResult),
        remediatedVeraPdf: summarizeVeraPdf(currentResult),
	        failureProfile: plan.failureProfile,
	        plannerEvidence: plan.plannerEvidence,
	        classification: currentClassification || null,
	        pipelineConfig: currentPipelineSummary(),
	        finalAudit: {
	          overallScore: currentResult.overallScore,
          grade: currentResult.grade,
          unresolvedIssues: unresolvedIssues(currentResult),
        },
        manualReviewFlags: collectCategoryFlags(currentResult, manualReviewFlags),
        aiAppliedChanges: actions.map(toAppliedChange).filter(Boolean) as AppliedChange[],
        aiSuggestedChanges: actions.map(toSuggestedChange).filter(Boolean) as SuggestedChange[],
      }
      await options?.onCheckpoint?.(checkpointModel)
    }

    if (stopAfterRound) break
  }

    const bootstrapWasApplied = actions.some(a => a.tool === 'bootstrap_struct_tree' && a.outcome === 'applied')
    const altTextStillBroken = (scoreForCategory(currentResult, 'alt_text') ?? 100) < 100
    const semanticFigureCandidates = aiFirstFigureCandidates(stageContext)
    const altRepairAlreadyApplied = actions.some(a => a.tool === 'repair_other_elements_alt_text' && (a.outcome === 'applied' || a.outcome === 'no_effect'))
      if (canExitEarlyToFinalCleanup(currentResult, currentPipelineConfig?.earlyExitScore || REMEDIATION.EARLY_EXIT_SCORE_THRESHOLD)) {
        const blockingFamilyTarget = currentFamilyCompletionTarget(stageContext)
        if (!blockingFamilyTarget) {
          skipDirectToFinalCleanup = true
          break
        }
      }
    if (round > 1 && !roundChangedDocument && (!needsStructuralPersistenceRound(currentResult, latestContext) || round >= REMEDIATION.MIN_STRUCTURAL_ROUNDS)) break
    if (stopAfterRound) break
    // Post-bootstrap / post-alt-text second pass (round 1 only): when alt text is still broken
    // and figure candidates remain, re-inspect and run stages 5+ so semantic figure labeling
    // can follow structural alt-text repair instead of being suppressed by it.
    if (round === 1 && altTextStillBroken && semanticFigureCandidates.length > 0) {
    if (options?.signal?.aborted) {
      const error = new Error('Remediation cancelled') as Error & { aborted?: boolean }
      error.aborted = true
      throw error
    }
    options?.onProgress?.({ stage: 'Post-bootstrap alt-text inspection', percent: 73 })
    stageContext = await inspectRemediationContext(workingBuffer, currentResult, 'alt_text_deep')
    currentTitle = stageContext.pdfjs.title || currentTitle
    currentLanguage = stageContext.qpdf.lang || stageContext.pdfjs.lang || currentLanguage

    const postBootstrapPlan = await planRemediationActions({
      filename,
      analysis: currentResult,
      context: stageContext,
      iteration: 2,
	      actions,
	      rejectedActions,
	      pipelineConfig: currentPipelineConfig,
	    })
    absorbProviderTelemetry('remediationPlanService')

    // Only execute stages 5+ (alt text, figures, semantic fixes)
    const postBootstrapStageMap = new Map<number, typeof postBootstrapPlan.actions>()
    for (const call of postBootstrapPlan.actions) {
      const stageNum = TOOL_STAGE_ORDER.get(call.tool_name as any) ?? 99
      if (stageNum < 5) continue // skip already-run stages
      if (!postBootstrapStageMap.has(stageNum)) postBootstrapStageMap.set(stageNum, [])
      postBootstrapStageMap.get(stageNum)!.push(call)
    }
    const postBootstrapStages = [...postBootstrapStageMap.entries()].sort(([a], [b]) => a - b)

	    for (const [stageNum, stageCalls] of postBootstrapStages) {
	      if (!stageEnabled(stageNum)) continue
	      if (options?.signal?.aborted) {
        const error = new Error('Remediation cancelled') as Error & { aborted?: boolean }
        error.aborted = true
        throw error
      }
	      options?.onProgress?.({ stage: `Post-bootstrap fixes (stage ${stageNum})`, percent: 75 + stageNum })
	      stagesRun.add(stageNum)
      const stageStartBuffer = workingBuffer
      const stageStartResult = currentResult
      const stageActions: RemediationActionRecord[] = []
      let stageChangedDocument = false

      if (nativeTaggedSafeMode) {
        const nativeStage = await executeNativeSafeStage(stageCalls)
        stageActions.push(...nativeStage.stageActions)
        actions.push(...nativeStage.stageActions)
        allExecutedActions.push(...nativeStage.stageActions)
        stageChangedDocument = nativeStage.stageChangedDocument
      } else {
        const execution = await executeNonNativeStageCalls(stageCalls, stageContext, workingBuffer)
        workingBuffer = execution.buffer
        if (execution.changedDocument) stageChangedDocument = true
        stageActions.push(...execution.actions)
        actions.push(...execution.actions)
        allExecutedActions.push(...execution.actions)
        manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, execution.manualReviewFlags)
        for (const action of execution.actions) noteDocumentMutation(action)
      }

      if (!nativeTaggedSafeMode && stageChangedDocument) {
        const analyzedStage = await analyzeIntermediate(workingBuffer, stageStartResult, {
          forceStructureForScoring: requiresDeepStructureScoring(stageActions),
          preferDeepStructureInspect: shouldPreferDeepStructureInspect(
            requiresDeepStructureInspect(stageActions)
              || requiresLongReportStructureInspect(stageActions, stageStartResult),
            stageStartResult,
          ),
        })
        const isAcrobatAltRepair = stageActions.some(a => a.tool === 'repair_other_elements_alt_text' && a.outcome === 'applied')
        const acceptanceDecision = evaluateStageAcceptance(stageStartResult, analyzedStage, stageActions)
        const stageImprovedStandards = acceptanceDecision.standardsImproved
        let stageImprovedTargets = false
        for (const action of stageActions) {
          stageImprovedTargets = applyScoreDelta(action, stageStartResult, analyzedStage) || stageImprovedTargets
          if (!stageImprovedTargets && action.outcome === 'applied') action.outcome = 'no_effect'
        }
        if (!isAcrobatAltRepair && !acceptanceDecision.accept) {
          const isolationReason = acceptanceDecision.reason || `post-bootstrap stage ${stageNum} failed the net-benefit acceptance policy`
          const isolatedStage = await tryIsolateNonNativeStageRegression({
            stageCalls,
            stageActions,
            stageStartBuffer,
            stageStartResult,
            stageStartContext: stageContext,
            stageStartTitle: currentTitle,
            stageStartLanguage: currentLanguage,
            rejectionReason: isolationReason,
          })

          if (isolatedStage) {
            replaceStageActionsInHistory(actions, stageActions, isolatedStage.stageActions)
            replaceStageActionsInHistory(allExecutedActions, stageActions, isolatedStage.stageActions)
            stageActions.splice(0, stageActions.length, ...isolatedStage.stageActions)
            rejectedActions.push(...isolatedStage.rejectedActions)
            workingBuffer = isolatedStage.buffer
            currentResult = isolatedStage.result
            currentTitle = isolatedStage.title
            currentLanguage = isolatedStage.language
            manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, isolatedStage.manualReviewFlags)
            manualReviewFlags = addFlag(manualReviewFlags, {
              code: `stage_${stageNum}_isolated_regression`,
              label: 'Regressive tool isolated',
              severity: 'warning',
              details: `Rejected isolated post-bootstrap tool changes from stage ${stageNum} because ${isolationReason}.`,
            })
            currentResultHasFreshVeraPdf = false
            persistResolvedStageToolOutcomes(isolatedStage.acceptedActions, isolatedStage.rejectedActions, {
              previous: stageStartResult,
              next: isolatedStage.result,
              roundNumber: round,
              stageNumber: stageNum,
              standardsImproved: isolatedStage.improvedStandards,
            })
          } else {
            const rejectedStageActions = stageActions.map(action =>
              (action.changedDocumentBytes || action.outcome === 'no_effect')
                ? rejectActionForRegression(action, isolationReason, false)
                : action,
            )
            replaceStageActionsInHistory(actions, stageActions, rejectedStageActions)
            replaceStageActionsInHistory(allExecutedActions, stageActions, rejectedStageActions)
            stageActions.splice(0, stageActions.length, ...rejectedStageActions)
            for (const action of rejectedStageActions) {
              if (action.outcome === 'rejected') rejectedActions.push(action)
            }
            workingBuffer = stageStartBuffer
            currentResult = stageStartResult
            persistStageToolOutcomes(stageActions, {
              previous: stageStartResult,
              next: stageStartResult,
              roundNumber: round,
              stageNumber: stageNum,
              standardsImproved: false,
            })
          }
        } else {
          currentResult = analyzedStage
          currentResultHasFreshVeraPdf = false
          persistStageToolOutcomes(stageActions, {
            previous: stageStartResult,
            next: analyzedStage,
            roundNumber: round,
            stageNumber: stageNum,
            standardsImproved: stageImprovedStandards,
          })
        }
	        stageContext = await inspectRemediationContext(workingBuffer, currentResult)
	        const postBootstrapMetadataHints = applyMetadataCallHints(stageCalls, stageActions, {
	          title: currentTitle,
	          language: currentLanguage,
	        })
	        currentTitle = postBootstrapMetadataHints.title
	        currentLanguage = postBootstrapMetadataHints.language
	        await maybeRefreshClassificationFromStage(stageActions)
	      } else if (stageChangedDocument) {
	        persistStageToolOutcomes(stageActions, {
          previous: stageStartResult,
          next: currentResult,
          roundNumber: round,
	          stageNumber: stageNum,
	          standardsImproved: false,
	        })
	        await maybeRefreshClassificationFromStage(stageActions)
	      }

      previousActionNames = Array.from(new Set([
        ...previousActionNames,
        ...stageActions.map(a => `${a.tool}:${a.candidateGroupId || a.candidateId || a.target}`),
      ]))
    }
    }
    if (canExitEarlyToFinalCleanup(currentResult, currentPipelineConfig?.earlyExitScore || REMEDIATION.EARLY_EXIT_SCORE_THRESHOLD)) {
      const blockingFamilyTarget = currentFamilyCompletionTarget(stageContext)
      if (!blockingFamilyTarget) {
        skipDirectToFinalCleanup = true
        break
      }
    }
    if (needsStructuralPersistenceRound(currentResult, latestContext) && round < REMEDIATION.MIN_STRUCTURAL_ROUNDS) {
      round += 1
      continue
    }
    round++
  }

  if (acrobatOwnershipRiskCount(latestContext) > 0) {
    await runAcrobatOwnershipConvergence()
    latestContext = await inspectRemediationContext(workingBuffer, currentResult, inspectModeForResult(currentResult))
    await runBoundedPostOwnershipFigureRepairPass({
      stageNumber: 89,
      stageLabel: 'Applying bounded post-ownership figure alt repairs',
    })
  }

  // Record as a single iteration for model compatibility
  iterations.push({
    iteration: 1,
    plannedActions: plan.actions,
    executedActions: allExecutedActions,
    changedDocument: !workingBuffer.equals(originalBuffer),
  })

  let semanticStageChangedDocument = false
  if (!skipDirectToFinalCleanup && shouldRunSemanticStage(currentResult, originalResult, latestContext, currentPipelineConfig?.semanticStrategy || 'full_ai')) {
    stagesRun.add(90)
    const semanticStageStartResult = currentResult
    const semanticContext = inspectModeForResult(currentResult) === 'alt_text_deep'
      ? await inspectRemediationContext(workingBuffer, currentResult, 'alt_text_deep')
      : latestContext || await inspectRemediationContext(workingBuffer, currentResult, 'light')

    const semanticStage = await runSemanticEnrichmentStage({
      buffer: workingBuffer,
      filename,
      result: currentResult,
      context: semanticContext,
      originalResult,
      currentTitle,
      currentLanguage,
      previousActionNames,
      inspectionCache,
      signal: options?.signal,
      onProgress: options?.onProgress,
      rejectedActions,
      semanticStrategy: currentPipelineConfig?.semanticStrategy || 'full_ai',
    })
    absorbProviderTelemetry('semanticEnrichmentService')
    semanticStageChangedDocument = !semanticStage.buffer.equals(workingBuffer)
    if (semanticStageChangedDocument) {
      workingBuffer = semanticStage.buffer
    }
    currentResult = semanticStage.result
    currentResultHasFreshVeraPdf = !semanticStage.usedInheritedVeraPdf
    actions.push(...semanticStage.actions)
    manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, semanticStage.manualReviewFlags)
    for (const action of semanticStage.actions) noteDocumentMutation(action)
    previousActionNames = Array.from(new Set([
      ...previousActionNames,
      ...semanticStage.actions.flatMap(actionHistoryKeys),
    ]))
    persistResolvedStageToolOutcomes(
      semanticStage.actions.filter(action => action.outcome !== 'rejected'),
      semanticStage.actions.filter(action => action.outcome === 'rejected'),
      {
      previous: semanticStageStartResult,
      next: currentResult,
      roundNumber: round,
      stageNumber: 90,
      standardsImproved: standardsValidationImproved(semanticStageStartResult, currentResult),
      },
    )
  }

  if (!skipDirectToFinalCleanup && (currentPipelineConfig?.semanticStrategy || 'full_ai') === 'full_ai' && shouldRunBookmarkCleanup(currentResult, originalResult, latestContext)) {
    stagesRun.add(91)
    const bookmarkStageStartResult = currentResult
    const bookmarkContext = latestContext || await inspectRemediationContext(workingBuffer, currentResult, 'light')

    const bookmarkStage = await runSemanticEnrichmentStage({
      buffer: workingBuffer,
      filename,
      result: bookmarkCleanupTriggerAnalysis(currentResult),
      context: bookmarkContext,
      originalResult: {
        ...originalResult,
        isScanned: false,
      },
      currentTitle,
      currentLanguage,
      previousActionNames,
      inspectionCache,
      signal: options?.signal,
      onProgress: options?.onProgress,
      rejectedActions,
      semanticStrategy: 'full_ai',
    })
    absorbProviderTelemetry('semanticEnrichmentService')

    if (!bookmarkStage.buffer.equals(workingBuffer)) {
      workingBuffer = bookmarkStage.buffer
      currentResult = bookmarkStage.result
      currentResultHasFreshVeraPdf = !bookmarkStage.usedInheritedVeraPdf
      actions.push(...bookmarkStage.actions)
      manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, bookmarkStage.manualReviewFlags)
      for (const action of bookmarkStage.actions) noteDocumentMutation(action)
      previousActionNames = Array.from(new Set([
        ...previousActionNames,
        ...bookmarkStage.actions.flatMap(actionHistoryKeys),
      ]))
      latestContext = await inspectRemediationContext(workingBuffer, currentResult)
    }
    persistResolvedStageToolOutcomes(
      bookmarkStage.actions.filter(action => action.outcome !== 'rejected'),
      bookmarkStage.actions.filter(action => action.outcome === 'rejected'),
      {
      previous: bookmarkStageStartResult,
      next: currentResult,
      roundNumber: round,
      stageNumber: 91,
      standardsImproved: standardsValidationImproved(bookmarkStageStartResult, currentResult),
      },
    )
  }

  const lateAltPassNeeded = !skipDirectToFinalCleanup
    && (scoreForCategory(currentResult, 'alt_text') ?? 100) < 100
  if (lateAltPassNeeded) {
    const lateDecisionContext = latestContext || await inspectRemediationContext(workingBuffer, currentResult, 'light')
    if (shouldDeferLateFigureWorkUntilStructureConverges({
      analysis: currentResult,
      context: lateDecisionContext,
      tracker: residualCleanupTracker,
    })) {
      markResidualCleanupBucketConverged('structure')
    } else {
    const lateHeuristicFigureCandidates = heuristicEligibleFigureCandidates(lateDecisionContext)
      .filter(candidate => shouldRetryLateHeuristicFigureCandidate(candidate, previousActionNames))
    const sweepDecision = shouldRunLateFigureSweep({
      tracker: latePhaseConvergence.figure_description_state,
      analysis: currentResult,
      context: lateDecisionContext,
      candidateCount: lateHeuristicFigureCandidates.length,
    })

    if (sweepDecision.allowed) {
      if (isInspectionBudgetExhausted()) {
        setFigureDescriptionStopReason('budget_exhausted')
        markLatePhaseConverged('figure_description_state')
      } else {
      const lateAltContext = await inspectRemediationContext(workingBuffer, currentResult, 'alt_text_deep')
      const beforeSnapshot = buildPhaseProgressSnapshot('figure_description_state', currentResult, lateAltContext)
      latePhaseConvergence.figure_description_state.lastSnapshot = beforeSnapshot
      stagesRun.add(92)
      const lateAltStageStartResult = currentResult
      const lateAltStage = await runHeuristicFigureFallbackStage({
        buffer: workingBuffer,
        result: currentResult,
        context: lateAltContext,
        previousActionNames,
        inspectionCache,
        maxCandidates: MAX_POST_OWNERSHIP_FIGURE_REPAIRS,
      })
      if (!lateAltStage.buffer.equals(workingBuffer)) {
        workingBuffer = lateAltStage.buffer
      }
      currentResult = lateAltStage.result
      currentResultHasFreshVeraPdf = !lateAltStage.usedInheritedVeraPdf
      actions.push(...lateAltStage.actions)
      manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, lateAltStage.manualReviewFlags)
      for (const action of lateAltStage.actions) noteDocumentMutation(action)
      previousActionNames = Array.from(new Set([
        ...previousActionNames,
        ...lateAltStage.actions.flatMap(actionHistoryKeys),
      ]))
      latestContext = await inspectRemediationContext(workingBuffer, currentResult)
      const changedFigureBytes = lateAltStage.actions.some(action => action.changedDocumentBytes)
      updateLatePhaseProgress({
        phase: 'figure_description_state',
        before: beforeSnapshot,
        afterAnalysis: currentResult,
        afterContext: latestContext,
        changedDocumentBytes: changedFigureBytes,
        noProgressLimit: 1,
      })
      persistStageToolOutcomes(lateAltStage.actions, {
        previous: lateAltStageStartResult,
        next: currentResult,
        roundNumber: round,
        stageNumber: 92,
        standardsImproved: standardsValidationImproved(lateAltStageStartResult, currentResult),
      })
      }
    } else if (sweepDecision.reason === 'stable_no_progress' || sweepDecision.reason === 'no_candidate_progress') {
      markLatePhaseConverged('figure_description_state')
    }
    }
  }

  const finalCleanupContext = semanticStageChangedDocument || !latestContext
    ? await inspectRemediationContext(workingBuffer, currentResult)
    : latestContext
  latestContext = finalCleanupContext
  const needsFinalCleanupStructureBaseline = nativeTaggedSafeMode && (
    (scoreForCategory(currentResult, 'heading_structure') ?? 100) < 100
    || acrobatOwnershipRiskCount(finalCleanupContext) > 0
  )
  if (needsFinalCleanupStructureBaseline) {
    currentResult = await analyzeIntermediate(workingBuffer, currentResult, {
      forceStructureForScoring: true,
    })
  }
  const finalCleanupStartResult = currentResult

  const finalCleanupCalls = filterCallsForPipeline([
    {
      tool_name: 'normalize_heading_hierarchy' as const,
      arguments: { target: 'document' },
      rationale: 'Final cleanup: normalize heading levels so the first heading is H1 and later headings do not skip levels.',
      confidence: 0.97,
    },
    {
      tool_name: 'normalize_nested_figure_containers' as const,
      arguments: { target: 'document' },
      rationale: 'Final cleanup: retag empty wrapper /Figure containers so only leaf figures require alternate text.',
      confidence: 0.97,
    },
    {
      tool_name: 'repair_native_link_structure' as const,
      arguments: { target: 'document' },
      rationale: 'Final cleanup: repair link annotation structure after any bootstrap or semantic tagging changes.',
      confidence: 0.97,
    },
    {
      tool_name: 'normalize_annotation_tab_order' as const,
      arguments: { target: 'document' },
      rationale: 'Final cleanup: normalize annotation order on annotated pages before saving the remediated PDF.',
      confidence: 0.95,
    },
    {
      tool_name: 'set_tabs_all_annotated_pages' as const,
      arguments: { target: 'document' },
      rationale: 'Final cleanup: set /Tabs /S on all annotated or tagged pages before saving the remediated PDF.',
      confidence: 0.98,
    },
  ])
  const batchedFinalCleanupCalls: RemediationToolCall[] = []
  for (const candidate of finalCleanupContext.linkCandidates.filter(entry => !(entry.annotationContents || '').trim())) {
    batchedFinalCleanupCalls.push({
      tool_name: 'set_link_annotation_contents',
      arguments: {
        candidateId: candidate.id,
        pageNumber: candidate.pageNumber,
        annotationIndex: candidate.annotationIndex,
        contents: candidate.suggestedText || candidate.text || candidate.url,
      },
      rationale: `Final cleanup: ensure link annotation ${candidate.id} exposes /Contents before the final save.`,
      confidence: 0.92,
    })
  }
  const directFinalCleanupCalls: RemediationToolCall[] = []
  if ((finalCleanupContext.qpdf.unembeddedFontCount ?? 0) > 0) {
    directFinalCleanupCalls.push({
      tool_name: 'embed_missing_fonts_in_place',
      arguments: { target: 'document' },
      rationale: 'Final cleanup: embed any remaining unembedded fonts before final verification.',
      confidence: 0.9,
    })
  }
  if ((finalCleanupContext.qpdf.fontsMissingToUnicodeBlocking ?? finalCleanupContext.qpdf.fontsMissingToUnicode ?? 0) > 0) {
    directFinalCleanupCalls.push({
      tool_name: 'repair_font_unicode_maps',
      arguments: { target: 'document' },
      rationale: 'Final cleanup: add missing ToUnicode maps before final verification.',
      confidence: 0.92,
    })
  }
  if ((finalCleanupContext.qpdf.type1FontsMissingToUnicode ?? 0) > 0) {
    directFinalCleanupCalls.push({
      tool_name: 'repair_type1_font_unicode_maps',
      arguments: { target: 'document' },
      rationale: 'Final cleanup: repair Type1/Type3 Unicode maps before final verification.',
      confidence: 0.9,
    })
  }

  let finalCleanupChangedDocument = false
  const finalCleanupActions: RemediationActionRecord[] = []
  let cleanupContext = finalCleanupContext
  stagesRun.add(99)
  if (!nativeTaggedSafeMode) {
    const batchResult = await runPdfStructureBackendBatch({
      buffer: workingBuffer,
      mutations: [...finalCleanupCalls, ...batchedFinalCleanupCalls].map(call =>
        buildBatchMutationForCall(call, finalCleanupContext)
        || { operation: call.tool_name as StructureBackendMutationRequest['operation'] },
      ),
      includeSnapshot: true,
      inspectMode: 'light',
    })
    const operationResults = batchResult.operationResults || []
    const allBatchedFinalCleanupCalls = [...finalCleanupCalls, ...batchedFinalCleanupCalls]
    for (let index = 0; index < allBatchedFinalCleanupCalls.length; index += 1) {
      const call = allBatchedFinalCleanupCalls[index]
      const operationResult = operationResults[index]
      const status: 'applied' | 'no_effect' | 'unsupported' | 'failed' =
        operationResult?.status === 'applied' || operationResult?.status === 'no_effect' || operationResult?.status === 'unsupported'
          ? operationResult.status
          : 'failed'
      const changedDocumentBytes = !!operationResult?.changedDocumentBytes
      const action: RemediationActionRecord = {
        tool: call.tool_name,
        target: 'document',
        details: finalCleanupDetails(call.tool_name, operationResult?.appliedMutations || [], operationResult?.warnings || []),
        confidence: call.confidence,
        autoApplied: status !== 'unsupported' && status !== 'failed',
        changedVisibleContent: false,
        changedDocumentBytes,
        categoryTargets: finalCleanupCategoryTargets(call.tool_name),
        outcome: status === 'applied'
          ? 'applied'
          : status === 'no_effect'
            ? 'no_effect'
            : 'deferred',
      }
      finalCleanupActions.push(action)
      actions.push(action)
      allExecutedActions.push(action)
      noteDocumentMutation(action)
    }
    if (batchResult.changedDocumentBytes && batchResult.outputBuffer) {
      workingBuffer = batchResult.outputBuffer
      finalCleanupChangedDocument = true
    }
    cleanupContext = buildRemediationContextFromSnapshot({
      analysis: currentResult,
      qpdf: finalCleanupContext.qpdf,
      pdfjs: finalCleanupContext.pdfjs,
      pages: finalCleanupContext.pages,
      structure: batchResult,
      inspectMode: 'light',
      cache: inspectionCache,
    })
    latestContext = cleanupContext
    for (const call of directFinalCleanupCalls) {
      const outcome = await executeRemediationTool({
        buffer: workingBuffer,
        context: cleanupContext,
        call,
      })
      finalCleanupActions.push(outcome.action)
      actions.push(outcome.action)
      allExecutedActions.push(outcome.action)
      noteDocumentMutation(outcome.action)
      if (!outcome.action.changedDocumentBytes || outcome.action.outcome === 'rejected') continue
      workingBuffer = outcome.buffer
      finalCleanupChangedDocument = true
      currentResult = await analyzeIntermediate(workingBuffer, currentResult)
      currentResultHasFreshVeraPdf = false
      cleanupContext = await inspectRemediationContextSafely(workingBuffer, currentResult)
        || cleanupContext
      latestContext = cleanupContext
    }
  } else {
    stageContext = cleanupContext
    // Native-safe-only additions: set_document_language and set_pdfua_identification are
    // only safe on native-tagged PDFs (they touch metadata in ways that can regress
    // non-native-tagged documents). Gate on nativeTaggedSafeMode AND the blocking key
    // still being present in the pre-cleanup result.
    const nativeOnlyCleanupCalls = filterCallsForPipeline([
      ...(hasBlockingLocalFinding(finalCleanupStartResult, 'pdfua.document_language') && currentLanguage
        ? [{
            tool_name: 'set_document_language' as const,
            arguments: { language: currentLanguage },
            rationale: 'Final cleanup (native-safe): set missing document language tag.',
            confidence: 0.95,
          }]
        : []),
      ...(hasBlockingLocalFinding(finalCleanupStartResult, 'pdfua.metadata_identification')
        ? [{
            tool_name: 'set_pdfua_identification' as const,
            arguments: { title: currentTitle, language: currentLanguage ?? 'en', part: 1 as const, conformance: 'B' as const },
            rationale: 'Final cleanup (native-safe): set PDF/UA identification metadata.',
            confidence: 0.95,
          }]
        : []),
    ])
    const nativeFinalCleanup = await executeNativeSafeStage([...finalCleanupCalls, ...batchedFinalCleanupCalls, ...directFinalCleanupCalls, ...nativeOnlyCleanupCalls], {
      includeOverallScoreRegression: true,
    })
    cleanupContext = latestContext || cleanupContext
    finalCleanupChangedDocument = nativeFinalCleanup.stageChangedDocument
    finalCleanupActions.push(...nativeFinalCleanup.stageActions)
    actions.push(...nativeFinalCleanup.stageActions)
    allExecutedActions.push(...nativeFinalCleanup.stageActions)
  }

  if (!nativeTaggedSafeMode && finalCleanupChangedDocument) {
    currentResult = await analyzeIntermediate(workingBuffer, currentResult)
    currentResultHasFreshVeraPdf = false
    cleanupContext = buildRemediationContextFromSnapshot({
      analysis: currentResult,
      qpdf: cleanupContext.qpdf,
      pdfjs: cleanupContext.pdfjs,
      pages: cleanupContext.pages,
      structure: cleanupContext.structure,
      inspectMode: inspectModeForResult(currentResult),
      cache: inspectionCache,
    })
    latestContext = cleanupContext
  }
  persistStageToolOutcomes(finalCleanupActions, {
    previous: finalCleanupStartResult,
    next: currentResult,
    roundNumber: round,
    stageNumber: 99,
    standardsImproved: finalCleanupChangedDocument
      ? standardsValidationImproved(finalCleanupStartResult, currentResult)
      : false,
    playbookId: playbookFastPathSucceeded ? matchedPlaybook?.id || null : null,
    playbookRunId: playbookFastPathSucceeded ? matchedPlaybookRun?.id || null : null,
  })

  await runFinalResidualRepairs()

  const postCleanupAltPassNeeded = !skipDirectToFinalCleanup
    && (scoreForCategory(currentResult, 'alt_text') ?? 100) < 100
  if (postCleanupAltPassNeeded) {
    const postCleanupDecisionContext = latestContext || await inspectRemediationContext(workingBuffer, currentResult, 'light')
    if (shouldDeferLateFigureWorkUntilStructureConverges({
      analysis: currentResult,
      context: postCleanupDecisionContext,
      tracker: residualCleanupTracker,
    })) {
      markResidualCleanupBucketConverged('structure')
    } else {
    const postCleanupHeuristicFigureCandidates = heuristicEligibleFigureCandidates(postCleanupDecisionContext)
      .filter(candidate => shouldRetryLateHeuristicFigureCandidate(candidate, previousActionNames))
    const sweepDecision = shouldRunLateFigureSweep({
      tracker: latePhaseConvergence.figure_description_state,
      analysis: currentResult,
      context: postCleanupDecisionContext,
      candidateCount: postCleanupHeuristicFigureCandidates.length,
    })

    if (sweepDecision.allowed) {
      if (isInspectionBudgetExhausted()) {
        setFigureDescriptionStopReason('budget_exhausted')
        markLatePhaseConverged('figure_description_state')
      } else {
      const postCleanupAltContext = await inspectRemediationContext(workingBuffer, currentResult, 'alt_text_deep')
      const beforeSnapshot = buildPhaseProgressSnapshot('figure_description_state', currentResult, postCleanupAltContext)
      latePhaseConvergence.figure_description_state.lastSnapshot = beforeSnapshot
      stagesRun.add(93)
      const postCleanupAltStageStartResult = currentResult
      const postCleanupAltStage = await runHeuristicFigureFallbackStage({
        buffer: workingBuffer,
        result: currentResult,
        context: postCleanupAltContext,
        previousActionNames,
        inspectionCache,
        maxCandidates: MAX_POST_OWNERSHIP_FIGURE_REPAIRS,
      })
      if (!postCleanupAltStage.buffer.equals(workingBuffer)) {
        workingBuffer = postCleanupAltStage.buffer
      }
      currentResult = postCleanupAltStage.result
      currentResultHasFreshVeraPdf = !postCleanupAltStage.usedInheritedVeraPdf
      actions.push(...postCleanupAltStage.actions)
      manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, postCleanupAltStage.manualReviewFlags)
      for (const action of postCleanupAltStage.actions) noteDocumentMutation(action)
      previousActionNames = Array.from(new Set([
        ...previousActionNames,
        ...postCleanupAltStage.actions.flatMap(actionHistoryKeys),
      ]))
      latestContext = await inspectRemediationContext(workingBuffer, currentResult)
      const changedFigureBytes = postCleanupAltStage.actions.some(action => action.changedDocumentBytes)
      updateLatePhaseProgress({
        phase: 'figure_description_state',
        before: beforeSnapshot,
        afterAnalysis: currentResult,
        afterContext: latestContext,
        changedDocumentBytes: changedFigureBytes,
        noProgressLimit: 1,
      })
      persistStageToolOutcomes(postCleanupAltStage.actions, {
        previous: postCleanupAltStageStartResult,
        next: currentResult,
        roundNumber: round,
        stageNumber: 93,
        standardsImproved: standardsValidationImproved(postCleanupAltStageStartResult, currentResult),
      })
      }
    } else if (sweepDecision.reason === 'stable_no_progress' || sweepDecision.reason === 'no_candidate_progress') {
      markLatePhaseConverged('figure_description_state')
    }
    }
  }

  if (!workingBuffer.equals(originalBuffer)) {
    await ensureAuthoritativeResultForCurrentBuffer()
    latestContext = rebindContextFromCache(currentResult, inspectModeForResult(currentResult))
  }

  await runFinalResidualRepairs()
  if (!workingBuffer.equals(originalBuffer)) {
    await ensureAuthoritativeResultForCurrentBuffer()
    latestContext = rebindContextFromCache(currentResult, inspectModeForResult(currentResult))
  }

  const postAnalysisAltPassNeeded = !skipDirectToFinalCleanup
    && (scoreForCategory(currentResult, 'alt_text') ?? 100) < 100
  if (postAnalysisAltPassNeeded) {
    let postAnalysisSweepCount = 0
    while (postAnalysisSweepCount < 2 && (scoreForCategory(currentResult, 'alt_text') ?? 100) < 100) {
      const postAnalysisDecisionContext = latestContext || await inspectRemediationContext(workingBuffer, currentResult, 'light')
      if (shouldDeferLateFigureWorkUntilStructureConverges({
        analysis: currentResult,
        context: postAnalysisDecisionContext,
        tracker: residualCleanupTracker,
      })) {
        markResidualCleanupBucketConverged('structure')
        break
      }
      const postAnalysisHeuristicFigureCandidates = heuristicEligibleFigureCandidates(postAnalysisDecisionContext)
        .filter(candidate => shouldRetryLateHeuristicFigureCandidate(candidate, previousActionNames))
      const sweepDecision = shouldRunLateFigureSweep({
        tracker: latePhaseConvergence.figure_description_state,
        analysis: currentResult,
        context: postAnalysisDecisionContext,
        candidateCount: postAnalysisHeuristicFigureCandidates.length,
      })
      if (!sweepDecision.allowed) {
        if (sweepDecision.reason === 'stable_no_progress' || sweepDecision.reason === 'no_candidate_progress') {
          markLatePhaseConverged('figure_description_state')
        }
        break
      }
      if (isInspectionBudgetExhausted()) {
        setFigureDescriptionStopReason('budget_exhausted')
        markLatePhaseConverged('figure_description_state')
        break
      }
      const postAnalysisAltContext = await inspectRemediationContext(workingBuffer, currentResult, 'alt_text_deep')
      const beforeSnapshot = buildPhaseProgressSnapshot('figure_description_state', currentResult, postAnalysisAltContext)
      latePhaseConvergence.figure_description_state.lastSnapshot = beforeSnapshot

      stagesRun.add(94)
      const postAnalysisAltStageStartResult = currentResult
      const postAnalysisAltStage = await runHeuristicFigureFallbackStage({
        buffer: workingBuffer,
        result: currentResult,
        context: postAnalysisAltContext,
        previousActionNames,
        inspectionCache,
        maxCandidates: MAX_POST_OWNERSHIP_FIGURE_REPAIRS,
      })
      const changedResidualFigures = postAnalysisAltStage.actions.some(action => action.changedDocumentBytes)
      if (!postAnalysisAltStage.buffer.equals(workingBuffer)) {
        workingBuffer = postAnalysisAltStage.buffer
      }
      currentResult = postAnalysisAltStage.result
      currentResultHasFreshVeraPdf = !postAnalysisAltStage.usedInheritedVeraPdf
      actions.push(...postAnalysisAltStage.actions)
      manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, postAnalysisAltStage.manualReviewFlags)
      for (const action of postAnalysisAltStage.actions) noteDocumentMutation(action)
      previousActionNames = Array.from(new Set([
        ...previousActionNames,
        ...postAnalysisAltStage.actions.flatMap(actionHistoryKeys),
      ]))
      const changedFigureBytes = postAnalysisAltStage.actions.some(action => action.changedDocumentBytes)
      persistStageToolOutcomes(postAnalysisAltStage.actions, {
        previous: postAnalysisAltStageStartResult,
        next: currentResult,
        roundNumber: round,
        stageNumber: 94,
        standardsImproved: standardsValidationImproved(postAnalysisAltStageStartResult, currentResult),
      })
      if (!changedResidualFigures) {
        updateLatePhaseProgress({
          phase: 'figure_description_state',
          before: beforeSnapshot,
          afterAnalysis: currentResult,
          afterContext: latestContext,
          changedDocumentBytes: changedFigureBytes,
          noProgressLimit: 1,
        })
        break
      }
      await ensureAuthoritativeResultForCurrentBuffer()
      latestContext = rebindContextFromCache(currentResult, inspectModeForResult(currentResult))
      updateLatePhaseProgress({
        phase: 'figure_description_state',
        before: beforeSnapshot,
        afterAnalysis: currentResult,
        afterContext: latestContext,
        changedDocumentBytes: changedFigureBytes,
        noProgressLimit: 1,
      })
      postAnalysisSweepCount += 1
    }
  }

  await applyReviewedAltTextSidecar()
  await runFinalResidualRepairs()
  if (
    hasBlockingLocalFinding(currentResult, 'pdfua.untagged_rendered_images')
    || hasBlockingLocalFinding(currentResult, 'pdfua.nested_alt_text')
    || hasBlockingLocalFinding(currentResult, 'pdfua.figure_alt_or_artifact')
    || hasUnresolvedCategoryLabel(currentResult, 'Alt Text on Images')
  ) {
    await runBoundedPostOwnershipFigureRepairPass({
      stageNumber: 96,
      stageLabel: 'Applying bounded final figure alt repairs',
    })
  }

  // Always re-analyze the exact final bytes we are about to save/stage.
  // Late cleanup steps can still mutate the PDF after earlier authoritative
  // audits, so the returned finalResult must reflect the actual final buffer.
  await ensureAuthoritativeResultForCurrentBuffer()
  latestContext = rebindContextFromCache(currentResult, inspectModeForResult(currentResult))
    || await inspectRemediationContextSafely(workingBuffer, currentResult, inspectModeForResult(currentResult))
    || latestContext
  if (latestContext) {
    refreshClassification(currentResult, latestContext)
  }
  await runFocusedFinalRescue()

  previousActionNames = Array.from(new Set([
    ...previousActionNames,
    ...finalCleanupActions.flatMap(actionHistoryKeys),
  ]))

  const finalContext = (!nativeTaggedSafeMode && cleanupContext)
    ? cleanupContext
    : (finalCleanupChangedDocument || !latestContext)
      ? (latestContext || await inspectRemediationContextSafely(workingBuffer, currentResult) || latestContext!)
      : latestContext
  refreshClassification(currentResult, finalContext)
  const finalProfileArtifacts = buildFailureProfileArtifacts({
    analysis: currentResult,
    context: finalContext || EMPTY_REMEDIATION_CONTEXT,
    actions,
    rejectedActions,
    iterations,
  })
  const specializedTailMode = remediationMetrics.runtimeSummary?.specializedTailMode || 'none'
  const specializedTailAttempted = remediationMetrics.runtimeSummary?.specializedTailAttempted || false
  const specializedTailImproved = remediationMetrics.runtimeSummary?.specializedTailImproved || false
  finalProfileArtifacts.failureProfile.summary.specializedTailMode = specializedTailMode
  finalProfileArtifacts.failureProfile.summary.specializedTailAttempted = specializedTailAttempted
  finalProfileArtifacts.failureProfile.summary.specializedTailImproved = specializedTailImproved
  finalProfileArtifacts.plannerEvidence.specializedTailMode = specializedTailMode
  finalProfileArtifacts.plannerEvidence.specializedTailAttempted = specializedTailAttempted
  finalProfileArtifacts.plannerEvidence.specializedTailImproved = specializedTailImproved
  const finalOwnershipRiskCount = acrobatOwnershipRiskCount(finalContext)
  const finalFigureMissingAltCount = informativeFigureMissingAltCount(finalContext)
  const finalDecorativeFigureCount = decorativeFigureCount(finalContext)
  const structureFinalStopReason =
    remediationMetrics.phases.structure_state.residualFinalStopReason === 'font_tail_plateau'
      ? 'tail_signature_plateau_after_specialized_rescue'
      : remediationMetrics.phases.structure_state.residualFinalStopReason

  const finalManualReviewFlags = collectCategoryFlags(currentResult, manualReviewFlags)
  const finalPromotionGate = evaluatePromotionGate({
    analysisResult: currentResult,
    manualReviewFlags: finalManualReviewFlags,
  })

  const finalModel: DocumentModel = {
    version: '6',
    processingPath: 'agent_patch',
    pathFallbacks,
    title: currentTitle,
    language: currentLanguage,
    sourceType: inferSourceType(originalResult),
    confidenceSummary: confidenceSummary(actions),
    iterations,
    actions,
    rejectedActions,
    nativeTaggedSafeMode,
    visibleContentChangePolicy,
    failureProfile: finalProfileArtifacts.failureProfile,
    plannerEvidence: finalProfileArtifacts.plannerEvidence,
    classification: currentClassification || null,
    pipelineConfig: currentPipelineSummary(),
    remediationMetrics: {
      inspections: { ...remediationMetrics.inspections },
      phases: {
        ownershipState: {
          initialRiskCount: remediationMetrics.ownershipRiskInitial ?? 0,
          finalRiskCount: finalOwnershipRiskCount,
          freshDeepInspections: remediationMetrics.phases.ownership_state.freshDeepInspections,
          reusedInspections: remediationMetrics.phases.ownership_state.reusedInspections,
          downgradedToLight: remediationMetrics.phases.ownership_state.downgradedToLight,
          lateConverged: remediationMetrics.phases.ownership_state.lateConverged,
        },
        figureDescriptionState: {
          initialMissingAltCount: remediationMetrics.figureMissingAltInitial ?? 0,
          finalMissingAltCount: finalFigureMissingAltCount,
          initialDecorativeFigureCount: remediationMetrics.decorativeFigureInitial ?? 0,
          finalDecorativeFigureCount: finalDecorativeFigureCount,
          freshDeepInspections: remediationMetrics.phases.figure_description_state.freshDeepInspections,
          reusedInspections: remediationMetrics.phases.figure_description_state.reusedInspections,
          downgradedToLight: remediationMetrics.phases.figure_description_state.downgradedToLight,
          lateConverged: remediationMetrics.phases.figure_description_state.lateConverged,
          focusedRescueRan: remediationMetrics.phases.figure_description_state.focusedRescueRan,
          focusedRescueSkippedBecauseLateConverged: remediationMetrics.phases.figure_description_state.focusedRescueSkippedBecauseLateConverged,
          finalStopReason: remediationMetrics.phases.figure_description_state.finalStopReason,
        },
        structureState: {
          freshDeepAnalyses: remediationMetrics.structureDeepFreshAnalyses,
          downgradedDeepAnalyses: remediationMetrics.structureDeepAnalysesDowngraded,
          lateConverged: remediationMetrics.phases.structure_state.lateConverged,
          finalStopReason: structureFinalStopReason,
          finalBlockingKeys: blockingLocalFindingKeys(currentResult).filter(key =>
            key === 'pdfua.logical_structure'
            || key === 'pdfua.heading_content_quality'
            || key === 'pdfua.table_regularity'
            || key === 'pdfua.figure_alt_or_artifact'
            || key === 'pdfua.untagged_rendered_images'
            || key === 'pdfua.nested_alt_text',
          ),
        },
      },
      residualCleanup: {
        dominantFamily: remediationMetrics.residualCleanup.dominantFamily,
        finalStopReason: remediationMetrics.residualCleanup.finalStopReason,
      },
      providerRouting: {
        byEndpointLabel: { ...remediationMetrics.providerRouting.byEndpointLabel },
        byService: { ...remediationMetrics.providerRouting.byService },
        livenessBypassCount: remediationMetrics.providerRouting.livenessBypassCount,
      },
      runtimeSummary: {
        lightInspectionCount: remediationTimings.lightInspections,
        deepInspectionCount: remediationTimings.deepInspections,
        semanticCallCount: remediationMetrics.providerRouting.byService.semanticEnrichmentService || 0,
        providerCallCount: Object.values(remediationMetrics.providerRouting.byService).reduce((sum, value) => sum + value, 0),
        focusedRescuePassCount: remediationMetrics.runtimeSummary?.focusedRescuePassCount,
        mixedRuntimeGovernorFired: remediationMetrics.runtimeSummary?.mixedRuntimeGovernorFired,
        compactFinalRescueFallback: remediationMetrics.runtimeSummary?.compactFinalRescueFallback,
        authoritativeFinalScoringReached: true,
        specializedTailMode,
        specializedTailAttempted,
        specializedTailImproved,
      },
    },
    finalAudit: {
      overallScore: currentResult.overallScore,
      grade: currentResult.grade,
      unresolvedIssues: unresolvedIssues(currentResult),
    },
    promotionGate: finalPromotionGate,
    manualReviewFlags: finalManualReviewFlags,
    aiAppliedChanges: actions.map(toAppliedChange).filter(Boolean) as AppliedChange[],
    aiSuggestedChanges: actions.map(toSuggestedChange).filter(Boolean) as SuggestedChange[],
  }

  remediationTimings.totalMs = Date.now() - remediationStartedAt
  console.log(JSON.stringify({
    scope: 'pdf_remediation_timing',
    filename,
    totalMs: remediationTimings.totalMs,
    intermediateAnalyses: remediationTimings.intermediateAnalyses,
    lightInspections: remediationTimings.lightInspections,
    deepInspections: remediationTimings.deepInspections,
    roundsExecuted: remediationTimings.roundsExecuted,
    stagesExecuted: remediationTimings.stagesExecuted,
    remediationMetrics: finalModel.remediationMetrics,
  }))

  if (matchedPlaybook && matchedPlaybookRun && playbookFastPathSucceeded) {
    matchedPlaybookRun = finalizePlaybookRun({
      playbook: matchedPlaybook,
      run: matchedPlaybookRun,
      outcome: currentResult.grade === 'A' ? 'succeeded' : 'failed',
      finalScore: currentResult.overallScore,
    })
  }
  if (!workingBuffer.equals(originalBuffer)) {
    workingBuffer = await ensureDisplayDocTitle(workingBuffer)
  }

  if (currentResult.grade === 'A' && playbookInitialArtifacts && playbookInitialAnalysis && playbookInitialContext && playbookInitialSignature) {
    learnFromSuccessfulRemediation({
      failureSignature: playbookInitialSignature,
      initialAnalysis: playbookInitialAnalysis,
      initialContext: playbookInitialContext,
      finalAnalysis: currentResult,
      model: finalModel,
      matchedPlaybookId: matchedPlaybook?.id || null,
      incrementStats: !matchedPlaybook,
    })
  }

  return {
    model: finalModel,
    artifacts: { pageImages: [] },
    buffer: workingBuffer,
    finalResult: currentResult,
  }
}
