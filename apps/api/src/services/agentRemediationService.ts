import type { AnalysisResult } from './pdfAnalyzer.js'
import type {
  AppliedChange,
  DocumentModel,
  ModelReviewFlag,
  ReconstructionOutput,
  RemediationActionRecord,
  RemediationIteration,
  SuggestedChange,
  VeraPdfSummary,
} from './documentModel.js'
import { average } from './documentModel.js'
import { analyzePDF } from './pdfAnalyzer.js'
import {
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
import { planRemediationActions } from './remediationPlanService.js'
import { generateSemanticRepairBatches, type SemanticBatchResult } from './semanticEnrichmentService.js'
import { isOcrAvailable, ocrPdfToSearchablePdf } from './ocrService.js'

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

const MAX_ITERATIONS = 5
const NATIVE_TAGGED_RISKY_TOOLS = new Set<string>([
  'repair_structure_conformance',
  'repair_native_reading_order',
  'repair_native_figure_semantics',
  'repair_native_table_headers',
])

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
  if (result.verapdf?.status === 'failed' && result.verapdf.failedChecks > 0) {
    flags = addFlag(flags, {
      code: 'verapdf_manual_review',
      label: 'PDF/UA compliance requires manual review',
      severity: 'warning',
      details: result.verapdf.failures[0]?.message || `veraPDF reported ${result.verapdf.failedChecks} remaining PDF/UA compliance issues.`,
    })
  }
  if (result.verapdf?.status && result.verapdf.status !== 'passed' && result.verapdf.status !== 'failed') {
    flags = addFlag(flags, {
      code: 'verapdf_unavailable',
      label: 'PDF/UA validation incomplete',
      severity: 'warning',
      details: result.verapdf.message || 'veraPDF validation could not be completed for this document.',
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

function hasRemainingDeterministicOpportunities(model: DocumentModel): boolean {
  return (model.failureProfile?.toolOpportunities || []).some(opportunity => opportunity.status === 'auto_runnable')
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

function veraPdfFailureMessages(result: AnalysisResult): string[] {
  return result.verapdf?.status === 'failed'
    ? result.verapdf.failures.map(failure => failure.message).filter(Boolean)
    : []
}

function hasNativeStandardsRegression(previous: AnalysisResult, next: AnalysisResult, toolName: string): string | null {
  const previousFailed = previous.verapdf?.status === 'failed' ? previous.verapdf.failedChecks : 0
  const nextFailed = next.verapdf?.status === 'failed' ? next.verapdf.failedChecks : 0
  if (nextFailed > previousFailed) {
    return `veraPDF failures increased from ${previousFailed} to ${nextFailed}`
  }
  if (!NATIVE_TAGGED_RISKY_TOOLS.has(toolName)) {
    return null
  }
  const previousMessages = new Set(veraPdfFailureMessages(previous))
  const newStructuralFailure = veraPdfFailureMessages(next).find(message =>
    !previousMessages.has(message)
    && /note tag shall have id entry|logical structure|parenttree|marked content|artifact|tagged as real content|\/link|table|reading order/i.test(message),
  )
  return newStructuralFailure ? `introduced a new structural standards failure: ${newStructuralFailure}` : null
}

function shouldRejectNativeVisibleRewrite(
  previous: AnalysisResult,
  next: AnalysisResult,
  action: { changedVisibleContent?: boolean; tool: string },
): string | null {
  if (!action.changedVisibleContent) return null
  const previousFailed = previous.verapdf?.status === 'failed' ? previous.verapdf.failedChecks : 0
  const nextFailed = next.verapdf?.status === 'failed' ? next.verapdf.failedChecks : 0
  if (nextFailed < previousFailed) return null
  return `changed visible page content without improving standards validation (${previousFailed} -> ${nextFailed} veraPDF failures)`
}

function categoryRegression(previous: AnalysisResult, next: AnalysisResult, categoryId: string): boolean {
  const before = scoreForCategory(previous, categoryId)
  const after = scoreForCategory(next, categoryId)
  return before !== null && after !== null && after < before
}

function hasAnyCategoryRegression(previous: AnalysisResult, next: AnalysisResult): boolean {
  return previous.categories.some(category => categoryRegression(previous, next, category.id))
}

function hasDeterministicIterationRegression(previous: AnalysisResult, next: AnalysisResult): boolean {
  const previousFailed = previous.verapdf?.status === 'failed' ? previous.verapdf.failedChecks : 0
  const nextFailed = next.verapdf?.status === 'failed' ? next.verapdf.failedChecks : 0
  return next.overallScore < previous.overallScore
    || nextFailed > previousFailed
    || hasAnyCategoryRegression(previous, next)
}

function standardsValidationImproved(previous: AnalysisResult, next: AnalysisResult): boolean {
  return (
    (next.verapdf?.status === 'failed'
      && previous.verapdf?.status === 'failed'
      && next.verapdf.failedChecks < previous.verapdf.failedChecks)
    || (next.verapdf?.status === 'passed' && previous.verapdf?.status !== 'passed')
  )
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

function semanticThreshold(batchType: SemanticBatchResult['batchType']): number {
  return batchType === 'figures' ? 0.75 : 0.8
}

const SEMANTIC_CATEGORY_IDS = ['heading_structure', 'alt_text', 'table_markup', 'link_quality'] as const

function isFullyDone(result: AnalysisResult): boolean {
  return result.grade === 'A' && result.verapdf?.status === 'passed'
}

function hasRemainingSemanticWork(result: AnalysisResult): boolean {
  return SEMANTIC_CATEGORY_IDS.some(categoryId => {
    const score = scoreForCategory(result, categoryId)
    return score !== null && score < 100
  })
}

type ContextRefreshPolicy = {
  inspectMode: RemediationInspectMode
  reuseQpdf: boolean
  reusePdfjs: boolean
  reusePages: boolean
  batchSafe: boolean
}

const BATCH_SAFE_TOOLS = new Set([
  'set_document_title',
  'set_document_language',
  'normalize_document_metadata',
  'set_pdfua_identification',
  'set_page_tabs',
  'normalize_annotation_tab_order',
  'set_link_annotation_contents',
])

const FIGURE_TOOLS = new Set([
  'repair_other_elements_alt_text',
  'set_figure_alt_text',
  'retag_as_figure_and_set_alt',
  'mark_figure_decorative',
  'repair_native_figure_semantics',
  'artifact_nonsemantic_page_elements',
])

const HEADING_TOOLS = new Set([
  'create_heading_tag',
  'create_heading_from_candidate',
  'retag_node',
])

const FONT_TOOLS = new Set([
  'embed_missing_fonts_in_place',
  'repair_font_unicode_maps',
  'repair_type1_font_unicode_maps',
  'repair_cid_symbol_font_maps',
  'repair_cidset_consistency',
  'substitute_legacy_fonts_in_place',
  'finalize_substituted_font_conformance',
])

function veraPdfNeedsAltTextAttention(result: AnalysisResult): boolean {
  return result.verapdf?.status === 'failed'
    && result.verapdf.failures.some(failure =>
      failure.categoryIds.includes('alt_text')
      || /alternate text|figure|artifact|decorative image|non-text content/i.test(failure.message),
    )
}

function inspectModeForResult(result: AnalysisResult): RemediationInspectMode {
  return needsAltTextDeepInspection(result) || veraPdfNeedsAltTextAttention(result)
    ? 'alt_text_deep'
    : 'light'
}

function refreshPolicyForTool(tool: string, currentResult: AnalysisResult): ContextRefreshPolicy {
  if (FIGURE_TOOLS.has(tool)) {
    return {
      inspectMode: 'alt_text_deep',
      reuseQpdf: true,
      reusePdfjs: true,
      reusePages: true,
      batchSafe: false,
    }
  }

  if (HEADING_TOOLS.has(tool)) {
    return {
      inspectMode: 'light',
      reuseQpdf: true,
      reusePdfjs: true,
      reusePages: true,
      batchSafe: false,
    }
  }

  if (FONT_TOOLS.has(tool)) {
    return {
      inspectMode: 'light',
      reuseQpdf: true,
      reusePdfjs: true,
      reusePages: true,
      batchSafe: false,
    }
  }

  if (BATCH_SAFE_TOOLS.has(tool)) {
    return {
      inspectMode: 'light',
      reuseQpdf: ['set_document_title', 'set_document_language', 'normalize_document_metadata', 'set_pdfua_identification'].includes(tool) ? false : true,
      reusePdfjs: ['set_document_title', 'set_document_language', 'normalize_document_metadata', 'set_pdfua_identification'].includes(tool) ? false : true,
      reusePages: true,
      batchSafe: true,
    }
  }

  return {
    inspectMode: inspectModeForResult(currentResult),
    reuseQpdf: false,
    reusePdfjs: false,
    reusePages: false,
    batchSafe: false,
  }
}

async function refreshInspectionContext(input: {
  buffer: Buffer
  analysis: AnalysisResult
  previousContext: PdfRemediationContext | null
  policy: ContextRefreshPolicy
  cache: RemediationInspectionCache
}): Promise<PdfRemediationContext> {
  const nextCache: RemediationInspectionCache = {
    qpdf: input.policy.reuseQpdf ? (input.previousContext?.qpdf || input.cache.qpdf) : undefined,
    pdfjs: input.policy.reusePdfjs ? (input.previousContext?.pdfjs || input.cache.pdfjs) : undefined,
    pages: input.policy.reusePages ? (input.previousContext?.pages || input.cache.pages) : undefined,
  }

  const context = await inspectPdfForRemediation(input.buffer, input.analysis, {
    inspectMode: input.policy.inspectMode,
    cache: nextCache,
  })
  input.cache.qpdf = context.qpdf
  input.cache.pdfjs = context.pdfjs
  input.cache.pages = context.pages
  return context
}

function shouldRunSemanticStage(result: AnalysisResult, originalResult: AnalysisResult): boolean {
  if (originalResult.isScanned) return false
  if (isFullyDone(result)) return false
  return hasRemainingSemanticWork(result)
}

function isSemanticStageTooLargeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /context_length_exceeded|length limit exceeded|request too large|payload too large|semantic repair request failed:\s*413/i.test(message)
}

function semanticDeferredAction(input: {
  tool: RemediationActionRecord['tool']
  target: string
  candidateId: string
  confidence: number
  details: string
  categoryTargets: string[]
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
    outcome: 'deferred',
  }
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
  signal?: AbortSignal
  onProgress?: (progress: { stage: string; percent: number }) => void
  rejectedActions: RemediationActionRecord[]
}): Promise<{
  buffer: Buffer
  result: AnalysisResult
  actions: RemediationActionRecord[]
  manualReviewFlags: ModelReviewFlag[]
}> {
  if (!shouldRunSemanticStage(input.result, input.originalResult)) {
    return { buffer: input.buffer, result: input.result, actions: [], manualReviewFlags: [] }
  }

  let context = input.context
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
    if (!isSemanticStageTooLargeError(error)) {
      throw error
    }
    return {
      buffer: input.buffer,
      result: input.result,
      actions: [],
      manualReviewFlags: [{
        code: 'semantic_enrichment_skipped',
        label: 'Semantic enrichment skipped',
        severity: 'warning',
        details: `Skipped semantic enrichment because the provider rejected the request as too large: ${error instanceof Error ? error.message : String(error || 'unknown error')}`,
      }],
    }
  }
  const batches = generated.batches
  if (!batches.length) {
    return { buffer: input.buffer, result: input.result, actions: [], manualReviewFlags: generated.reviewFlags }
  }

  const manualReviewFlags: ModelReviewFlag[] = [...generated.reviewFlags]
  const acceptedActions: RemediationActionRecord[] = []
  let workingBuffer = input.buffer
  let currentResult = input.result

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
        if (!candidate || candidate.repairMode === 'defer' || input.previousActionNames.includes(key) || proposal.confidence < batchThreshold || (!proposal.decorative && !proposal.altText)) {
          deferredActions.push(semanticDeferredAction({
            tool,
            target: `page ${candidate?.pageNumber || 0}`,
            candidateId: proposal.candidateId,
            confidence: proposal.confidence,
            details,
            categoryTargets: ['alt_text'],
          }))
          continue
        }
        plannedCalls.push({
          key,
          categoryTargets: ['alt_text'],
          call: {
            tool_name: tool,
            arguments: { candidateId: proposal.candidateId, altText: proposal.altText },
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
          || !candidate.firstRowCellRefs.length
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
            arguments: { targets: candidate.firstRowCellRefs },
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
              arguments: { candidateId: proposal.candidateId, contents: proposal.annotationContents },
              rationale: details,
              confidence: proposal.confidence,
            },
          })
        }
      }
    }

    acceptedActions.push(...deferredActions)
    if (!plannedCalls.length) continue

    input.onProgress?.({ stage: `Applying semantic fixes: ${batch.batchType}`, percent: 89 })
    const batchStartBuffer = workingBuffer
    const batchStartResult = currentResult
    let batchContext = context
    const batchActions: RemediationActionRecord[] = []
    let batchBuffer = workingBuffer
    let batchChanged = false
    let batchFlags: ModelReviewFlag[] = []

    for (const planned of plannedCalls) {
      const outcome = await executeRemediationTool({
        buffer: batchBuffer,
        context: batchContext,
        call: planned.call,
      })
      batchBuffer = outcome.buffer
      batchActions.push(outcome.action)
      batchFlags = mergeManualReviewFlags(batchFlags, outcome.manualReviewFlags)
      batchChanged = batchChanged || !!outcome.action.changedDocumentBytes
      if (outcome.action.changedDocumentBytes) {
        batchContext = await inspectPdfForRemediation(batchBuffer, batchStartResult)
      }
    }

    if (!batchChanged) {
      acceptedActions.push(...batchActions)
      manualReviewFlags.push(...batchFlags)
      continue
    }

    const analyzedBatch = await analyzePDF(batchBuffer, input.filename, { signal: input.signal })
    const targetedCategories = [...new Set(batchActions.flatMap(action => action.categoryTargets || []))]
    const hasCategoryRegression = targetedCategories.some(categoryId => categoryRegression(batchStartResult, analyzedBatch, categoryId))
    const hasVisibleRegression = batchActions.some(action =>
      !!shouldRejectNativeVisibleRewrite(batchStartResult, analyzedBatch, action)
    )
    const hasStandardsRegression = batchActions.some(action =>
      !!hasNativeStandardsRegression(batchStartResult, analyzedBatch, action.tool)
    )

    if (hasCategoryRegression || hasVisibleRegression || hasStandardsRegression) {
      for (const action of batchActions) {
        const rejected = {
          ...action,
          details: `${action.details} Rejected because the semantic batch regressed validation or category scores.`,
          outcome: 'rejected' as const,
          autoApplied: false,
          changedDocumentBytes: false,
        }
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
      context = await inspectPdfForRemediation(workingBuffer, currentResult)
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
    context = await inspectPdfForRemediation(workingBuffer, currentResult)
  }

  return {
    buffer: workingBuffer,
    result: currentResult,
    actions: acceptedActions,
    manualReviewFlags: mergeManualReviewFlags([], manualReviewFlags),
  }
}

export async function remediatePdfWithAgent(
  originalBuffer: Buffer,
  filename: string,
  originalResult: AnalysisResult,
  options?: {
    signal?: AbortSignal
    onProgress?: (progress: { stage: string; percent: number }) => void
    onCheckpoint?: (model: DocumentModel) => Promise<void> | void
  },
): Promise<ReconstructionOutput & {
  buffer: Buffer
  finalResult: AnalysisResult
}> {
  let workingBuffer = originalBuffer
  let currentResult = originalResult
  let previousActionNames: string[] = []
  let currentTitle = filename.replace(/\.pdf$/i, '')
  let currentLanguage = 'en'
  let pathFallbacks: string[] = []
  let visibleContentChangePolicy: DocumentModel['visibleContentChangePolicy'] = 'limited_text_rewrites'
  const iterations: RemediationIteration[] = []
  const actions: RemediationActionRecord[] = []
  const rejectedActions: RemediationActionRecord[] = []
  let manualReviewFlags: ModelReviewFlag[] = []
  let shouldStop = false
  let nativeTaggedSafeMode = false
  let latestContext: Awaited<ReturnType<typeof inspectPdfForRemediation>> | null = null
  const inspectionCache: RemediationInspectionCache = {}

  if (originalResult.isScanned && await isOcrAvailable()) {
    options?.onProgress?.({ stage: 'Running OCR on scanned PDF', percent: 8 })
    const ocrBuffer = await ocrPdfToSearchablePdf(workingBuffer, {
      signal: options?.signal,
      onProgress: options?.onProgress,
    })
    const ocrResult = await analyzePDF(ocrBuffer, filename, { signal: options?.signal })
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
    actions.push(ocrAction)
    previousActionNames.push('ocr_scanned_pdf:document')
    pathFallbacks = [...pathFallbacks, 'ocr_searchable_pdf']
    visibleContentChangePolicy = 'no_visible_changes'
  }

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    if (options?.signal?.aborted) {
      const error = new Error('Remediation cancelled') as Error & { aborted?: boolean }
      error.aborted = true
      throw error
    }

    options?.onProgress?.({ stage: `Planning remediation iteration ${iteration}`, percent: 20 + ((iteration - 1) * 20) })
    let context = await inspectPdfForRemediation(workingBuffer, currentResult, {
      inspectMode: inspectModeForResult(currentResult),
      cache: inspectionCache,
    })
    inspectionCache.qpdf = context.qpdf
    inspectionCache.pdfjs = context.pdfjs
    inspectionCache.pages = context.pages
    latestContext = context
    const bootstrapPreviouslyAttempted = previousActionNames.some(name => name.startsWith('bootstrap_struct_tree:'))
    const iterationNativeTaggedSafeMode = isNativeTaggedSafeContext(context, currentResult) && !bootstrapPreviouslyAttempted
    nativeTaggedSafeMode = nativeTaggedSafeMode || iterationNativeTaggedSafeMode
    currentTitle = context.pdfjs.title || currentTitle
    currentLanguage = context.qpdf.lang || context.pdfjs.lang || currentLanguage
    const plan = await planRemediationActions({
      filename,
      analysis: currentResult,
      context,
      iteration,
      actions,
      rejectedActions,
    })

    const iterationStartBuffer = workingBuffer
    const iterationStartResult = currentResult
    const executedActions: RemediationActionRecord[] = []
    let changedDocument = false
    let improvedTargetedCategories = false
    let improvedStandardsValidation = false
    let analyzedDuringIteration = false

    for (let actionIndex = 0; actionIndex < plan.actions.length; actionIndex++) {
      const call = plan.actions[actionIndex]
      if (options?.signal?.aborted) {
        const error = new Error('Remediation cancelled') as Error & { aborted?: boolean }
        error.aborted = true
        throw error
      }

      options?.onProgress?.({ stage: `Applying PDF fixes (iteration ${iteration})`, percent: 25 + ((iteration - 1) * 20) })
      const policy = refreshPolicyForTool(call.tool_name, currentResult)

      if (!iterationNativeTaggedSafeMode && policy.batchSafe) {
        const batchStartBuffer = workingBuffer
        const batchStartResult = currentResult
        const batchStartGlobalActionIndex = actions.length
        const batchCalls = [call]
        while (actionIndex + 1 < plan.actions.length && refreshPolicyForTool(plan.actions[actionIndex + 1].tool_name, currentResult).batchSafe) {
          batchCalls.push(plan.actions[actionIndex + 1])
          actionIndex++
        }

        let batchChangedDocument = false
        const batchStartActionIndex = executedActions.length
        for (const batchedCall of batchCalls) {
          const outcome = await executeRemediationTool({
            buffer: workingBuffer,
            context,
            call: batchedCall,
          })
          workingBuffer = outcome.buffer
          batchChangedDocument = batchChangedDocument || (!!outcome.action.changedDocumentBytes && outcome.action.outcome !== 'rejected')
          executedActions.push(outcome.action)
          actions.push(outcome.action)
          manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, outcome.manualReviewFlags)
        }

        if (batchChangedDocument) {
          const analyzedBatch = await analyzePDF(workingBuffer, filename, { signal: options?.signal })
          analyzedDuringIteration = true
          const batchImprovedStandards = standardsValidationImproved(batchStartResult, analyzedBatch)
          let batchImprovedTargets = false
          for (const action of executedActions.slice(batchStartActionIndex)) {
            batchImprovedTargets = applyScoreDelta(action, batchStartResult, analyzedBatch) || batchImprovedTargets
            if (!batchImprovedTargets && action.outcome === 'applied') {
              action.outcome = 'no_effect'
            }
          }
          if (!batchImprovedStandards && !batchImprovedTargets && hasDeterministicIterationRegression(batchStartResult, analyzedBatch)) {
            for (let index = batchStartActionIndex; index < executedActions.length; index++) {
              const rejected = rejectAction({
                action: executedActions[index],
                reason: 'regressed accessibility scores or standards outcomes without offsetting improvement',
              })
              executedActions[index] = rejected
              actions[batchStartGlobalActionIndex + (index - batchStartActionIndex)] = rejected
              rejectedActions.push(rejected)
            }
            manualReviewFlags = addFlag(manualReviewFlags, {
              code: `batch_${iteration}_${batchStartActionIndex}_regressed`,
              label: 'Regressive deterministic batch rejected',
              severity: 'warning',
              details: `Rejected a deterministic batch in iteration ${iteration} because it regressed accessibility scores or standards outcomes without offsetting improvement.`,
            })
            workingBuffer = batchStartBuffer
            currentResult = batchStartResult
            context = await inspectPdfForRemediation(workingBuffer, currentResult, {
              inspectMode: inspectModeForResult(currentResult),
              cache: inspectionCache,
            })
            latestContext = context
            continue
          }
          changedDocument = true
          currentResult = analyzedBatch
          improvedStandardsValidation = improvedStandardsValidation || batchImprovedStandards
          improvedTargetedCategories = improvedTargetedCategories || batchImprovedTargets
          const batchPolicy = batchCalls.reduce<ContextRefreshPolicy>((current, candidate) => {
            const nextPolicy = refreshPolicyForTool(candidate.tool_name, currentResult)
            return {
              inspectMode: current.inspectMode === 'alt_text_deep' || nextPolicy.inspectMode === 'alt_text_deep' ? 'alt_text_deep' : 'light',
              reuseQpdf: current.reuseQpdf && nextPolicy.reuseQpdf,
              reusePdfjs: current.reusePdfjs && nextPolicy.reusePdfjs,
              reusePages: current.reusePages && nextPolicy.reusePages,
              batchSafe: true,
            }
          }, policy)
          context = await refreshInspectionContext({
            buffer: workingBuffer,
            analysis: currentResult,
            previousContext: context,
            policy: batchPolicy,
            cache: inspectionCache,
          })
          latestContext = context
          currentTitle = context.pdfjs.title || currentTitle
          currentLanguage = context.qpdf.lang || context.pdfjs.lang || currentLanguage
        }
        continue
      }

      const previousResultForAction = currentResult
      const previousBufferForAction = workingBuffer
      const outcome = await executeRemediationTool({
        buffer: workingBuffer,
        context,
        call,
      })
      let adoptedAction = outcome.action
      let adoptedBuffer = outcome.buffer
      let adoptedResult = currentResult

      if (iterationNativeTaggedSafeMode && outcome.action.changedDocumentBytes) {
        const candidateResult = await analyzePDF(outcome.buffer, filename, { signal: options?.signal })
        const regressionReason =
          hasNativeStandardsRegression(previousResultForAction, candidateResult, outcome.action.tool)
          || shouldRejectNativeVisibleRewrite(previousResultForAction, candidateResult, outcome.action)
        if (regressionReason) {
          adoptedAction = {
            ...outcome.action,
            details: `${outcome.action.details} Rejected because it ${regressionReason}.`,
            outcome: 'rejected',
            autoApplied: false,
            changedDocumentBytes: false,
          }
          rejectedActions.push(adoptedAction)
          manualReviewFlags = addFlag(manualReviewFlags, {
            code: `native_safe_rejected_${outcome.action.tool}`,
            label: 'Native structure repair rejected',
            severity: 'warning',
            details: `Rejected ${outcome.action.tool} because it ${regressionReason}.`,
          })
          adoptedBuffer = previousBufferForAction
          adoptedResult = previousResultForAction
        } else {
          adoptedResult = candidateResult
          if (outcome.action.categoryTargets?.length) {
            adoptedAction.scoreDelta = outcome.action.categoryTargets.map(categoryId => ({
              categoryId,
              before: scoreForCategory(previousResultForAction, categoryId),
              after: scoreForCategory(candidateResult, categoryId),
            }))
            const improved = adoptedAction.scoreDelta.some(delta => (delta.after ?? -1) > (delta.before ?? -1))
            improvedTargetedCategories = improvedTargetedCategories || improved
            if (!improved && adoptedAction.outcome === 'applied') {
              adoptedAction.outcome = 'no_effect'
            }
          }
          improvedStandardsValidation = improvedStandardsValidation
            || (candidateResult.verapdf?.status === 'failed'
              && previousResultForAction.verapdf?.status === 'failed'
              && candidateResult.verapdf.failedChecks < previousResultForAction.verapdf.failedChecks)
            || (candidateResult.verapdf?.status === 'passed' && previousResultForAction.verapdf?.status !== 'passed')
          workingBuffer = adoptedBuffer
          currentResult = adoptedResult
          changedDocument = changedDocument || (!!adoptedAction.changedDocumentBytes && adoptedAction.outcome !== 'rejected')
          context = await refreshInspectionContext({
            buffer: workingBuffer,
            analysis: currentResult,
            previousContext: context,
            policy,
            cache: inspectionCache,
          })
          latestContext = context
          currentTitle = context.pdfjs.title || currentTitle
          currentLanguage = context.qpdf.lang || context.pdfjs.lang || currentLanguage
        }
      } else {
        workingBuffer = adoptedBuffer
        if (adoptedAction.changedDocumentBytes) {
          const candidateResult = await analyzePDF(adoptedBuffer, filename, { signal: options?.signal })
          analyzedDuringIteration = true
          const improvedTargets = applyScoreDelta(adoptedAction, previousResultForAction, candidateResult)
          const improvedStandards = standardsValidationImproved(previousResultForAction, candidateResult)
          if (
            !improvedStandards
            && !improvedTargets
            && hasDeterministicIterationRegression(previousResultForAction, candidateResult)
          ) {
            adoptedAction = rejectAction({
              action: adoptedAction,
              reason: 'regressed accessibility scores or standards outcomes without offsetting improvement',
            })
            rejectedActions.push(adoptedAction)
            workingBuffer = previousBufferForAction
            currentResult = previousResultForAction
          } else {
            if (!improvedTargets && adoptedAction.outcome === 'applied') {
              adoptedAction.outcome = 'no_effect'
            }
            changedDocument = true
            currentResult = candidateResult
            improvedTargetedCategories = improvedTargetedCategories || improvedTargets
            improvedStandardsValidation = improvedStandardsValidation || improvedStandards
            context = await refreshInspectionContext({
              buffer: workingBuffer,
              analysis: currentResult,
              previousContext: context,
              policy,
              cache: inspectionCache,
            })
            latestContext = context
            currentTitle = context.pdfjs.title || currentTitle
            currentLanguage = context.qpdf.lang || context.pdfjs.lang || currentLanguage
          }
        }
      }

      executedActions.push(adoptedAction)
      actions.push(adoptedAction)
      manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, outcome.manualReviewFlags)
    }

    iterations.push({
      iteration,
      plannedActions: plan.actions,
      executedActions,
      changedDocument,
    })

    previousActionNames = Array.from(new Set([
      ...previousActionNames,
      ...executedActions.map(action => `${action.tool}:${action.candidateGroupId || action.candidateId || action.target}`),
    ]))
    if (changedDocument && !iterationNativeTaggedSafeMode && !analyzedDuringIteration) {
      const previousResult = currentResult
      options?.onProgress?.({ stage: `Re-analyzing remediated PDF (iteration ${iteration})`, percent: 35 + ((iteration - 1) * 20) })
      currentResult = await analyzePDF(workingBuffer, filename, { signal: options?.signal })
      improvedStandardsValidation = improvedStandardsValidation
        || (currentResult.verapdf?.status === 'failed'
          && previousResult.verapdf?.status === 'failed'
          && currentResult.verapdf.failedChecks < previousResult.verapdf.failedChecks)
        || (currentResult.verapdf?.status === 'passed' && previousResult.verapdf?.status !== 'passed')

      for (const action of executedActions) {
        const targets = action.categoryTargets || []
        if (!targets.length) continue
        action.scoreDelta = targets.map(categoryId => ({
          categoryId,
          before: scoreForCategory(previousResult, categoryId),
          after: scoreForCategory(currentResult, categoryId),
        }))
        const improved = action.scoreDelta.some(delta => (delta.after ?? -1) > (delta.before ?? -1))
        improvedTargetedCategories = improvedTargetedCategories || improved
        if (!improved && action.outcome === 'applied') {
          action.outcome = 'no_effect'
        }
      }

      if (!improvedStandardsValidation && hasDeterministicIterationRegression(previousResult, currentResult)) {
        workingBuffer = iterationStartBuffer
        currentResult = iterationStartResult
        changedDocument = false
        improvedTargetedCategories = false
        for (let actionIndex = 0; actionIndex < executedActions.length; actionIndex++) {
          const action = executedActions[actionIndex]
          if (action.changedDocumentBytes || action.outcome === 'no_effect') {
            const rejected = {
              ...action,
              details: `${action.details} Rejected because the iteration regressed accessibility scores or standards outcomes without offsetting improvement.`,
              outcome: 'rejected' as const,
              autoApplied: false,
              changedDocumentBytes: false,
            }
            const index = actions.indexOf(action)
            if (index >= 0) actions[index] = rejected
            executedActions[actionIndex] = rejected
            rejectedActions.push(rejected)
          }
        }
        latestContext = null
        context = await inspectPdfForRemediation(workingBuffer, currentResult, {
          inspectMode: inspectModeForResult(currentResult),
          cache: inspectionCache,
        })
        latestContext = context
        manualReviewFlags = addFlag(manualReviewFlags, {
          code: `iteration_${iteration}_regressed`,
          label: 'Regressive iteration rejected',
          severity: 'warning',
          details: `Rejected remediation iteration ${iteration} because it regressed accessibility scores or standards outcomes without offsetting improvement.`,
        })
      }
    }

    const profileArtifacts = buildFailureProfileArtifacts({
      analysis: currentResult,
      context,
      actions,
      rejectedActions,
      iterations,
    })

    const model: DocumentModel = {
      version: '6',
      processingPath: 'agent_patch',
      pathFallbacks,
      title: currentTitle,
      language: context.qpdf.lang || context.pdfjs.lang || currentLanguage,
      sourceType: inferSourceType(originalResult),
      confidenceSummary: confidenceSummary(actions),
      iterations: [...iterations],
      actions: [...actions],
      rejectedActions: [...rejectedActions],
      nativeTaggedSafeMode,
      visibleContentChangePolicy,
      originalVeraPdf: summarizeVeraPdf(originalResult),
      remediatedVeraPdf: summarizeVeraPdf(currentResult),
      failureProfile: profileArtifacts.failureProfile,
      plannerEvidence: profileArtifacts.plannerEvidence,
      finalAudit: {
        overallScore: currentResult.overallScore,
        grade: currentResult.grade,
        unresolvedIssues: unresolvedIssues(currentResult),
        veraPdf: summarizeVeraPdf(currentResult),
      },
      manualReviewFlags: collectCategoryFlags(currentResult, manualReviewFlags),
      aiAppliedChanges: actions.map(toAppliedChange).filter(Boolean) as AppliedChange[],
      aiSuggestedChanges: actions.map(toSuggestedChange).filter(Boolean) as SuggestedChange[],
    }

    await options?.onCheckpoint?.(model)

    if (isFullyDone(currentResult) && !hasRemainingDeterministicOpportunities(model)) {
      manualReviewFlags = model.manualReviewFlags
      break
    }

    if (changedDocument && !improvedTargetedCategories && !improvedStandardsValidation) {
      shouldStop = !hasRemainingDeterministicOpportunities(model)
    }

    if (plan.done || !plan.actions.length || !changedDocument || shouldStop) {
      manualReviewFlags = model.manualReviewFlags
      break
    }
  }

  let semanticStageChangedDocument = false
  if (shouldRunSemanticStage(currentResult, originalResult)) {
    const semanticContext = inspectModeForResult(currentResult) === 'alt_text_deep'
      ? await inspectPdfForRemediation(workingBuffer, currentResult, {
        inspectMode: 'alt_text_deep',
        cache: inspectionCache,
      })
      : latestContext || await inspectPdfForRemediation(workingBuffer, currentResult, {
        inspectMode: 'light',
        cache: inspectionCache,
      })
    latestContext = semanticContext
    inspectionCache.qpdf = semanticContext.qpdf
    inspectionCache.pdfjs = semanticContext.pdfjs
    inspectionCache.pages = semanticContext.pages

    const semanticStage = await runSemanticEnrichmentStage({
      buffer: workingBuffer,
      filename,
      result: currentResult,
      context: semanticContext,
      originalResult,
      currentTitle,
      currentLanguage,
      previousActionNames,
      signal: options?.signal,
      onProgress: options?.onProgress,
      rejectedActions,
    })
    semanticStageChangedDocument = !semanticStage.buffer.equals(workingBuffer)
    if (semanticStageChangedDocument) {
      workingBuffer = semanticStage.buffer
    }
    currentResult = semanticStage.result
    actions.push(...semanticStage.actions)
    manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, semanticStage.manualReviewFlags)
  }

  const finalContext = semanticStageChangedDocument || !latestContext
    ? await inspectPdfForRemediation(workingBuffer, currentResult, {
      inspectMode: inspectModeForResult(currentResult),
      cache: inspectionCache,
    })
    : latestContext
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
    finalAudit: {
      overallScore: currentResult.overallScore,
      grade: currentResult.grade,
      unresolvedIssues: unresolvedIssues(currentResult),
    },
    manualReviewFlags: collectCategoryFlags(currentResult, manualReviewFlags),
    aiAppliedChanges: actions.map(toAppliedChange).filter(Boolean) as AppliedChange[],
    aiSuggestedChanges: actions.map(toSuggestedChange).filter(Boolean) as SuggestedChange[],
  }

  return {
    model: finalModel,
    artifacts: { pageImages: [] },
    buffer: workingBuffer,
    finalResult: currentResult,
  }
}
