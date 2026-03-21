import { createHash } from 'node:crypto'
import type { AnalysisResult } from './pdfAnalyzer.js'
import type {
  AppliedChange,
  DocumentModel,
  ModelReviewFlag,
  PdfClassification,
  PipelineConfig,
  PlaybookEntry,
  PlaybookRun,
  ReconstructionOutput,
  RemediationActionRecord,
  RemediationIteration,
  RemediationToolCall,
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
import { buildFailureProfileArtifacts } from './failureProfileService.js'
import { planRemediationActions, TOOL_STAGE_ORDER } from './remediationPlanService.js'
import { generateSemanticRepairBatches, hasSemanticRepairConfig, type SemanticBatchResult } from './semanticEnrichmentService.js'
import { isOcrAvailable, ocrPdfToSearchablePdf } from './ocrService.js'
import {
  runPdfStructureBackendBatch,
  type StructureBackendMutationRequest,
  type StructureBackendOperationResult,
} from './pdfStructureBackend.js'
import { REMEDIATION } from '#config'
import { classifyPdf, recordToolOutcomes, type PdfClass } from './toolReliabilityService.js'
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
import { loadAltTextSidecar, planAltTextSidecarDirectives, syncAltTextSidecar } from './altTextSidecarService.js'
import { draftFigureAltText } from './altTextDraftingService.js'

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
  'set_figure_alt_text',
  'retag_as_figure_and_set_alt',
  'mark_figure_decorative',
  'repair_native_figure_semantics',
  'repair_other_elements_alt_text',
  'normalize_heading_hierarchy',
  'normalize_nested_figure_containers',
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

type StageAcceptanceDecision = {
  accept: boolean
  reason: string | null
  standardsImproved: boolean
  worstTargetedRegression: number
}

function getBufferSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function actionHasMeaningfulProgress(action: RemediationActionRecord): boolean {
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
    decorative: candidate.splitGenerated || candidate.informativeHint === 'decorative',
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
    action.tool === 'repair_structure_conformance',
  )
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

function scoreForCategory(result: AnalysisResult, categoryId: string): number | null {
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
  if (!targets.length) return false
  action.scoreDelta = targets.map(categoryId => ({
    categoryId,
    before: scoreForCategory(previous, categoryId),
    after: scoreForCategory(next, categoryId),
  }))
  return action.scoreDelta.some(delta => (delta.after ?? -1) > (delta.before ?? -1))
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
  if (next.overallScore > previous.overallScore || standardsImproved || targetedCategoryImproved) {
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
  const altTextCategory = result.categories.find(category => category.id === 'alt_text')
  return (altTextCategory?.findings || []).some(finding =>
    /acrobat.risk|acrobat-risk|other-elements alternate text|graphics content is still owned by non-\/figure|acrobat-style|non-figure.*graphics|graphics.*non-figure/i.test(finding),
  )
}

function inspectModeForResult(result: AnalysisResult): RemediationInspectMode {
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
    || /fetch failed|networkerror|econnreset|econnrefused|etimedout|socket hang up/i.test(message)
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

  while (true) {
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
          code: 'semantic_enrichment_skipped',
          label: 'Semantic enrichment skipped',
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
        code: 'semantic_enrichment_skipped',
        label: 'Semantic enrichment skipped',
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
        context = await inspectPdfForRemediation(working, baselineResult, {
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
      const key = `replace_bookmarks_from_headings:${headings.length}`
      if (!headings.length || input.previousActionNames.includes(key)) {
        deferredActions.push(semanticDeferredAction({
          tool: 'replace_bookmarks_from_headings',
          target: 'document',
          candidateId: 'document',
          confidence: headings.length ? batch.bookmarks[0]?.confidence || 0 : 0,
          details: 'AI bookmark proposal did not produce enough confident bookmark titles.',
          categoryTargets: ['bookmarks'],
        }))
      } else {
        plannedCalls.push({
          key,
          categoryTargets: ['bookmarks'],
          call: {
            tool_name: 'replace_bookmarks_from_headings',
            arguments: { headings },
            rationale: `AI bookmark cleanup (${headings.length} entries): replace noisy bookmark titles with concise semantic labels.`,
            confidence: Math.min(0.98, Math.max(...batch.bookmarks.map(entry => entry.confidence))),
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
    flag.code === 'semantic_enrichment_skipped' && /figures semantic enrichment/i.test(flag.details),
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
            )
          ),
          playbookId: input.playbookId || null,
          playbookRunId: input.playbookRunId || null,
        }
      })
    recordToolOutcomes(records)
  }

  const syncInspectionCache = (
    context: Awaited<ReturnType<typeof inspectPdfForRemediation>>,
  ): void => {
    inspectionCache.qpdf = context.qpdf
    inspectionCache.pdfjs = context.pdfjs
    inspectionCache.pages = context.pages
  }

  const inspectRemediationContext = async (
    buffer: Buffer,
    analysis: AnalysisResult,
    inspectMode: RemediationInspectMode = inspectModeForResult(analysis),
  ): Promise<Awaited<ReturnType<typeof inspectPdfForRemediation>>> => {
    const metricKey = inspectMode === 'alt_text_deep' ? 'deepInspections' : 'lightInspections'
    remediationTimings[metricKey] += 1
    const requestedPayload = inspectionCache.contextsByMode?.[inspectMode]
    const nextBufferSha256 = getBufferSha256(buffer)
    const dirtyForMode = inspectMode === 'alt_text_deep'
      ? inspectionState.deepAltDirty
      : inspectionState.structureDirty
    const cacheMatchesCurrentBuffer = inspectionState.bufferSha256 === nextBufferSha256
      && inspectionCache.bufferSha256 === nextBufferSha256

    if (!dirtyForMode && requestedPayload && cacheMatchesCurrentBuffer) {
      const reused = buildRemediationContextFromSnapshot({
        analysis,
        qpdf: requestedPayload.qpdf,
        pdfjs: requestedPayload.pdfjs,
        pages: requestedPayload.pages,
        structure: requestedPayload.structure,
        inspectMode,
        cache: inspectionCache,
      })
      latestContext = reused
      syncInspectionCache(reused)
      refreshClassification(analysis, reused)
      inspectionState.bufferSha256 = nextBufferSha256
      inspectionState.lastInspectMode = inspectMode
      inspectionState.semanticDirty = false
      return reused
    }

    const inspected = await inspectPdfForRemediation(buffer, analysis, {
      inspectMode,
      cache: inspectionCache,
    })
    latestContext = inspected
    syncInspectionCache(inspected)
    refreshClassification(analysis, inspected)
    inspectionState.bufferSha256 = nextBufferSha256
    inspectionState.lastInspectMode = inspectMode
    inspectionState.structureDirty = false
    if (inspectMode === 'alt_text_deep') {
      inspectionState.deepAltDirty = false
    }
    inspectionState.semanticDirty = false
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
    return analyzeIntermediatePdf(buffer, filename, baselineResult, {
      signal: options?.signal,
      forceStructureForScoring: analysisOptions?.forceStructureForScoring,
      preferDeepStructureInspect: analysisOptions?.preferDeepStructureInspect,
    })
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
      markInspectionDirtyFromAction(inspectionState, outcome.action)
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
      const deepContext = await inspectRemediationContext(workingBuffer, currentResult, 'alt_text_deep')
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
      markInspectionDirtyFromAction(inspectionState, outcome.action)
      currentResult = await analyzeIntermediate(workingBuffer, currentResult)
      currentResultHasFreshVeraPdf = false

      const afterContext = await inspectRemediationContext(workingBuffer, currentResult, 'alt_text_deep')
      const nextRiskCount = acrobatOwnershipRiskCount(afterContext)
      const reduction = currentRiskCount - nextRiskCount
      passes += 1

      if (reduction >= REMEDIATION.MIN_ACROBAT_RISK_REDUCTION_TO_CONTINUE) {
        stagnantPasses = 0
      } else {
        stagnantPasses += 1
      }

      if (nextRiskCount <= 0) break
      if (stagnantPasses >= 2) break
      if (previousRiskCount >= 0 && nextRiskCount >= previousRiskCount) break

      previousRiskCount = nextRiskCount
    }
  }

  const runFinalResidualRepairs = async (): Promise<void> => {
    let context = latestContext || await inspectRemediationContext(workingBuffer, currentResult, inspectModeForResult(currentResult))
    const residualCalls: RemediationToolCall[] = []

    const titleLanguageScore = currentResult.categories.find(entry => entry.id === 'title_language')?.score ?? 100
    const pdfUaScore = currentResult.categories.find(entry => entry.id === 'pdf_ua_compliance')?.score ?? 100
    if (titleLanguageScore < 100 || pdfUaScore < 100) {
      residualCalls.push({
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
      residualCalls.push({
        tool_name: 'embed_missing_fonts_in_place',
        arguments: { target: 'document' },
        rationale: 'Final cleanup: retry embedding for any fonts still lacking embedded programs after later mutations.',
        confidence: 0.9,
      })
    }

    if ((context.qpdf.fontsMissingToUnicode ?? 0) > 0) {
      residualCalls.push({
        tool_name: 'repair_font_unicode_maps',
        arguments: { target: 'document' },
        rationale: 'Final cleanup: add ToUnicode maps for fonts still missing Unicode coverage after later mutations.',
        confidence: 0.92,
      })
    }

    if ((context.qpdf.type1FontsMissingToUnicode ?? 0) > 0) {
      residualCalls.push({
        tool_name: 'repair_type1_font_unicode_maps',
        arguments: { target: 'document' },
        rationale: 'Final cleanup: retry Type1/Type3 Unicode recovery after later font cleanup changed the remaining font set.',
        confidence: 0.9,
      })
    }

    if (context.linkCandidates.some(candidate => !(candidate.annotationContents || '').trim())) {
      for (const candidate of context.linkCandidates.filter(entry => !(entry.annotationContents || '').trim())) {
        residualCalls.push({
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

    if ((currentResult.categories.find(entry => entry.id === 'table_markup')?.score ?? 100) < 100) {
      residualCalls.push({
        tool_name: 'repair_native_table_headers',
        arguments: { target: 'document' },
        rationale: 'Final cleanup: repair native table headers before authoritative scoring.',
        confidence: 0.88,
      })
      for (const candidate of context.tableCandidates.filter(entry => entry.repairMode === 'safe' && !entry.hasHeaders && !!entry.ref)) {
        residualCalls.push({
          tool_name: 'set_table_header_cells',
          arguments: { targets: [candidate.ref] },
          rationale: `Final cleanup: promote first row to headers for ${candidate.ref}.`,
          confidence: 0.86,
        })
      }
    }

    const filteredResidualCalls = filterCallsForPipeline(residualCalls)
    if (!filteredResidualCalls.length) return

    let changed = false
    for (const call of filteredResidualCalls) {
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
      markInspectionDirtyFromAction(inspectionState, outcome.action)
      currentResult = await analyzeIntermediate(workingBuffer, currentResult)
      currentResultHasFreshVeraPdf = false
      context = await inspectRemediationContext(workingBuffer, currentResult)
    }

    if (changed) {
      latestContext = context
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

    return {
      buffer: batchResult.outputBuffer || buffer,
      actions,
      manualReviewFlags,
      changedDocument,
      usedBatch: true,
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
          afterContext = await inspectRemediationContext(
            execution.buffer,
            checkpointResult,
            clusterAppliedStructureConformance ? 'alt_text_deep' : undefined,
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
        preferDeepStructureInspect: requiresDeepStructureInspect(attemptEntries.map(entry => entry.action)),
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
        checkpointContext = await inspectRemediationContext(attemptBuffer, analyzedAttempt)
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
              preferDeepStructureInspect: requiresDeepStructureInspect([entry.action]),
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
        preferDeepStructureInspect: requiresDeepStructureInspect(replay.actions),
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
          for (const action of execution.actions) markInspectionDirtyFromAction(inspectionState, action)
        }
      }

      if (!nativeTaggedSafeMode && stageChangedDocument) {
        const analyzedStage = await analyzeIntermediate(workingBuffer, stageStartResult, {
          forceStructureForScoring: requiresDeepStructureScoring(stageActions),
          preferDeepStructureInspect: requiresDeepStructureInspect(stageActions),
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
  }

  let consecutiveNoProgressStages = 0
  let lastPlanSignature = JSON.stringify(plan.actions.map(call => `${call.tool_name}:${JSON.stringify(call.arguments || {})}`))

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
      stageContext = await inspectRemediationContext(workingBuffer, currentResult, planningInspectMode)
      plan = await planRemediationActions({
        filename,
        analysis: currentResult,
        context: stageContext,
        iteration: round,
        actions,
        rejectedActions,
        pipelineConfig: currentPipelineConfig,
      })
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
      for (const action of execution.actions) markInspectionDirtyFromAction(inspectionState, action)
    }

    // Non-native mode: single analysis per stage (instead of per action)
    if (!nativeTaggedSafeMode && stageChangedDocument) {
      const analyzedStage = await analyzeIntermediate(workingBuffer, stageStartResult, {
        forceStructureForScoring: requiresDeepStructureScoring(stageActions),
        preferDeepStructureInspect: requiresDeepStructureInspect(stageActions),
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
    if (stageChangedDocument && !stageImprovedStandards && !stageImprovedTargets && !stageAppliedAcrobatAltRepair) {
      consecutiveNoProgressStages += 1
      if (round > 1 && consecutiveNoProgressStages >= REMEDIATION.MAX_NO_PROGRESS_STAGES) {
        stopAfterRound = true
      }
    } else if (stageChangedDocument) {
      consecutiveNoProgressStages = 0
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
    const altRepairAlreadyApplied = actions.some(a => a.tool === 'repair_other_elements_alt_text' && (a.outcome === 'applied' || a.outcome === 'no_effect'))
	    if (canExitEarlyToFinalCleanup(currentResult, currentPipelineConfig?.earlyExitScore || REMEDIATION.EARLY_EXIT_SCORE_THRESHOLD)) {
	      skipDirectToFinalCleanup = true
	      break
	    }
    if (round > 1 && !roundChangedDocument && (!needsStructuralPersistenceRound(currentResult, latestContext) || round >= REMEDIATION.MIN_STRUCTURAL_ROUNDS)) break
    if (stopAfterRound) break
    // Post-bootstrap second pass (round 1 only): when bootstrap created a struct tree, re-inspect for alt risks and run stages 5+.
    if (round === 1 && bootstrapWasApplied && altTextStillBroken && !altRepairAlreadyApplied) {
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
        for (const action of execution.actions) markInspectionDirtyFromAction(inspectionState, action)
      }

      if (!nativeTaggedSafeMode && stageChangedDocument) {
        const analyzedStage = await analyzeIntermediate(workingBuffer, stageStartResult, {
          forceStructureForScoring: requiresDeepStructureScoring(stageActions),
          preferDeepStructureInspect: requiresDeepStructureInspect(stageActions),
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
	      skipDirectToFinalCleanup = true
	      break
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
    semanticStageChangedDocument = !semanticStage.buffer.equals(workingBuffer)
    if (semanticStageChangedDocument) {
      workingBuffer = semanticStage.buffer
    }
    currentResult = semanticStage.result
    currentResultHasFreshVeraPdf = !semanticStage.usedInheritedVeraPdf
    actions.push(...semanticStage.actions)
    manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, semanticStage.manualReviewFlags)
    for (const action of semanticStage.actions) markInspectionDirtyFromAction(inspectionState, action)
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

    if (!bookmarkStage.buffer.equals(workingBuffer)) {
      workingBuffer = bookmarkStage.buffer
      currentResult = bookmarkStage.result
      currentResultHasFreshVeraPdf = !bookmarkStage.usedInheritedVeraPdf
      actions.push(...bookmarkStage.actions)
      manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, bookmarkStage.manualReviewFlags)
      for (const action of bookmarkStage.actions) markInspectionDirtyFromAction(inspectionState, action)
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
    const lateAltContext = await inspectRemediationContext(workingBuffer, currentResult, 'alt_text_deep')
    const lateHeuristicFigureCandidates = heuristicEligibleFigureCandidates(lateAltContext)
      .filter(candidate => shouldRetryLateHeuristicFigureCandidate(candidate, previousActionNames))

    if (lateHeuristicFigureCandidates.length > 0) {
      stagesRun.add(92)
      const lateAltStageStartResult = currentResult
      const lateAltStage = await runHeuristicFigureFallbackStage({
        buffer: workingBuffer,
        result: currentResult,
        context: lateAltContext,
        previousActionNames,
        inspectionCache,
      })
      if (!lateAltStage.buffer.equals(workingBuffer)) {
        workingBuffer = lateAltStage.buffer
      }
      currentResult = lateAltStage.result
      currentResultHasFreshVeraPdf = !lateAltStage.usedInheritedVeraPdf
      actions.push(...lateAltStage.actions)
      manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, lateAltStage.manualReviewFlags)
      for (const action of lateAltStage.actions) markInspectionDirtyFromAction(inspectionState, action)
      previousActionNames = Array.from(new Set([
        ...previousActionNames,
        ...lateAltStage.actions.flatMap(actionHistoryKeys),
      ]))
      latestContext = await inspectRemediationContext(workingBuffer, currentResult)
      persistStageToolOutcomes(lateAltStage.actions, {
        previous: lateAltStageStartResult,
        next: currentResult,
        roundNumber: round,
        stageNumber: 92,
        standardsImproved: standardsValidationImproved(lateAltStageStartResult, currentResult),
      })
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

  let finalCleanupChangedDocument = false
  const finalCleanupActions: RemediationActionRecord[] = []
  let cleanupContext = finalCleanupContext
  stagesRun.add(99)
  if (!nativeTaggedSafeMode) {
    const batchResult = await runPdfStructureBackendBatch({
      buffer: workingBuffer,
      mutations: finalCleanupCalls.map(call => ({
        operation: call.tool_name as StructureBackendMutationRequest['operation'],
      })),
      includeSnapshot: true,
      inspectMode: 'light',
    })
    const operationResults = batchResult.operationResults || []
    for (let index = 0; index < finalCleanupCalls.length; index += 1) {
      const call = finalCleanupCalls[index]
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
      markInspectionDirtyFromAction(inspectionState, action)
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
  } else {
    stageContext = cleanupContext
    const nativeFinalCleanup = await executeNativeSafeStage(finalCleanupCalls, {
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
    const postCleanupAltContext = await inspectRemediationContext(workingBuffer, currentResult, 'alt_text_deep')
    const postCleanupHeuristicFigureCandidates = heuristicEligibleFigureCandidates(postCleanupAltContext)
      .filter(candidate => shouldRetryLateHeuristicFigureCandidate(candidate, previousActionNames))

    if (postCleanupHeuristicFigureCandidates.length > 0) {
      stagesRun.add(93)
      const postCleanupAltStageStartResult = currentResult
      const postCleanupAltStage = await runHeuristicFigureFallbackStage({
        buffer: workingBuffer,
        result: currentResult,
        context: postCleanupAltContext,
        previousActionNames,
        inspectionCache,
      })
      if (!postCleanupAltStage.buffer.equals(workingBuffer)) {
        workingBuffer = postCleanupAltStage.buffer
      }
      currentResult = postCleanupAltStage.result
      currentResultHasFreshVeraPdf = !postCleanupAltStage.usedInheritedVeraPdf
      actions.push(...postCleanupAltStage.actions)
      manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, postCleanupAltStage.manualReviewFlags)
      for (const action of postCleanupAltStage.actions) markInspectionDirtyFromAction(inspectionState, action)
      previousActionNames = Array.from(new Set([
        ...previousActionNames,
        ...postCleanupAltStage.actions.flatMap(actionHistoryKeys),
      ]))
      latestContext = await inspectRemediationContext(workingBuffer, currentResult)
      persistStageToolOutcomes(postCleanupAltStage.actions, {
        previous: postCleanupAltStageStartResult,
        next: currentResult,
        roundNumber: round,
        stageNumber: 93,
        standardsImproved: standardsValidationImproved(postCleanupAltStageStartResult, currentResult),
      })
    }
  }

  if (!workingBuffer.equals(originalBuffer)) {
    workingBuffer = await ensureDisplayDocTitle(workingBuffer)
    currentResult = await analyzePDF(workingBuffer, filename, {
      analysisProfile: 'full_final',
      signal: options?.signal,
      skipAdobe: true,
      skipVeraPdf: true,
    })
    currentResultHasFreshVeraPdf = true
    latestContext = null
  }

  const postAnalysisAltPassNeeded = !skipDirectToFinalCleanup
    && (scoreForCategory(currentResult, 'alt_text') ?? 100) < 100
  if (postAnalysisAltPassNeeded) {
    let postAnalysisSweepCount = 0
    while (postAnalysisSweepCount < 3 && (scoreForCategory(currentResult, 'alt_text') ?? 100) < 100) {
      const postAnalysisAltContext = await inspectRemediationContext(workingBuffer, currentResult, 'alt_text_deep')
      const postAnalysisHeuristicFigureCandidates = heuristicEligibleFigureCandidates(postAnalysisAltContext)
        .filter(candidate => shouldRetryLateHeuristicFigureCandidate(candidate, previousActionNames))

      if (postAnalysisHeuristicFigureCandidates.length === 0) break

      stagesRun.add(94)
      const postAnalysisAltStageStartResult = currentResult
      const postAnalysisAltStage = await runHeuristicFigureFallbackStage({
        buffer: workingBuffer,
        result: currentResult,
        context: postAnalysisAltContext,
        previousActionNames,
        inspectionCache,
      })
      const changedResidualFigures = postAnalysisAltStage.actions.some(action => action.changedDocumentBytes)
      if (!postAnalysisAltStage.buffer.equals(workingBuffer)) {
        workingBuffer = postAnalysisAltStage.buffer
      }
      currentResult = postAnalysisAltStage.result
      currentResultHasFreshVeraPdf = !postAnalysisAltStage.usedInheritedVeraPdf
      actions.push(...postAnalysisAltStage.actions)
      manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, postAnalysisAltStage.manualReviewFlags)
      for (const action of postAnalysisAltStage.actions) markInspectionDirtyFromAction(inspectionState, action)
      previousActionNames = Array.from(new Set([
        ...previousActionNames,
        ...postAnalysisAltStage.actions.flatMap(actionHistoryKeys),
      ]))
      persistStageToolOutcomes(postAnalysisAltStage.actions, {
        previous: postAnalysisAltStageStartResult,
        next: currentResult,
        roundNumber: round,
        stageNumber: 94,
        standardsImproved: standardsValidationImproved(postAnalysisAltStageStartResult, currentResult),
      })
      if (!changedResidualFigures) break
      workingBuffer = await ensureDisplayDocTitle(workingBuffer)
      currentResult = await analyzePDF(workingBuffer, filename, {
        analysisProfile: 'full_final',
        signal: options?.signal,
        skipAdobe: true,
        skipVeraPdf: true,
      })
      currentResultHasFreshVeraPdf = true
      latestContext = null
      postAnalysisSweepCount += 1
    }
  }

  await applyReviewedAltTextSidecar()

  previousActionNames = Array.from(new Set([
    ...previousActionNames,
    ...finalCleanupActions.flatMap(actionHistoryKeys),
  ]))

  const finalContext = (!nativeTaggedSafeMode && cleanupContext)
    ? cleanupContext
    : finalCleanupChangedDocument || !latestContext
    ? await inspectRemediationContext(workingBuffer, currentResult)
    : latestContext
  refreshClassification(currentResult, finalContext)
  const finalProfileArtifacts = buildFailureProfileArtifacts({
    analysis: currentResult,
    context: finalContext,
    actions,
    rejectedActions,
    iterations,
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
    finalAudit: {
      overallScore: currentResult.overallScore,
      grade: currentResult.grade,
      unresolvedIssues: unresolvedIssues(currentResult),
    },
    manualReviewFlags: collectCategoryFlags(currentResult, manualReviewFlags),
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
