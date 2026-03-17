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
import { planRemediationActions, TOOL_STAGE_ORDER } from './remediationPlanService.js'
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

const NATIVE_TAGGED_RISKY_TOOLS = new Set<string>([
  'repair_structure_conformance',
  'repair_native_reading_order',
  'repair_native_figure_semantics',
  'repair_native_table_headers',
])

/** Max number of grade-then-fix rounds. After each round we re-analyze and re-plan to catch regressions and new fixable issues. */
const MAX_REMEDIATION_ROUNDS = 5

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

function hasDeterministicRegression(previous: AnalysisResult, next: AnalysisResult): boolean {
  const previousFailed = previous.verapdf?.status === 'failed' ? previous.verapdf.failedChecks : 0
  const nextFailed = next.verapdf?.status === 'failed' ? next.verapdf.failedChecks : 0
  return next.overallScore < previous.overallScore
    || nextFailed > previousFailed
    || previous.categories.some(category => categoryRegression(previous, next, category.id))
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

function veraPdfNeedsAltTextAttention(result: AnalysisResult): boolean {
  return result.verapdf?.status === 'failed'
    && result.verapdf.failures.some(failure =>
      failure.categoryIds.includes('alt_text')
      || /alternate text|figure|artifact|decorative image|non-text content/i.test(failure.message),
    )
}

function hasAcrobatAltRiskFindings(result: AnalysisResult): boolean {
  const altTextCategory = result.categories.find(category => category.id === 'alt_text')
  return (altTextCategory?.findings || []).some(finding =>
    /acrobat.risk|acrobat-risk|other-elements alternate text|graphics content is still owned by non-\/figure|acrobat-style|non-figure.*graphics|graphics.*non-figure/i.test(finding),
  )
}

function inspectModeForResult(result: AnalysisResult): RemediationInspectMode {
  return needsAltTextDeepInspection(result) || veraPdfNeedsAltTextAttention(result) || hasAcrobatAltRiskFindings(result)
    ? 'alt_text_deep'
    : 'light'
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

    const analyzedBatch = await analyzePDF(batchBuffer, input.filename, { signal: input.signal, skipAdobe: true })
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
  let nativeTaggedSafeMode = false
  let latestContext: Awaited<ReturnType<typeof inspectPdfForRemediation>> | null = null
  const inspectionCache: RemediationInspectionCache = {}

  if (originalResult.isScanned && await isOcrAvailable()) {
    options?.onProgress?.({ stage: 'Running OCR on scanned PDF', percent: 8 })
    const ocrBuffer = await ocrPdfToSearchablePdf(workingBuffer, {
      signal: options?.signal,
      onProgress: options?.onProgress,
    })
    const ocrResult = await analyzePDF(ocrBuffer, filename, { signal: options?.signal, skipAdobe: true })
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

  if (options?.signal?.aborted) {
    const error = new Error('Remediation cancelled') as Error & { aborted?: boolean }
    error.aborted = true
    throw error
  }

  // Single inspection pass
  options?.onProgress?.({ stage: 'Inspecting PDF structure', percent: 20 })
  let stageContext = await inspectPdfForRemediation(workingBuffer, currentResult, {
    inspectMode: inspectModeForResult(currentResult),
    cache: inspectionCache,
  })
  inspectionCache.qpdf = stageContext.qpdf
  inspectionCache.pdfjs = stageContext.pdfjs
  inspectionCache.pages = stageContext.pages
  latestContext = stageContext

  nativeTaggedSafeMode = isNativeTaggedSafeContext(stageContext, currentResult)
  currentTitle = stageContext.pdfjs.title || currentTitle
  currentLanguage = stageContext.qpdf.lang || stageContext.pdfjs.lang || currentLanguage

  // Grade-then-fix rounds: after each round we re-analyze and re-plan to catch regressions and new fixable issues.
  type PlanResult = Awaited<ReturnType<typeof planRemediationActions>>
  options?.onProgress?.({ stage: 'Planning remediation', percent: 32 })
  let plan: PlanResult = await planRemediationActions({
    filename,
    analysis: currentResult,
    context: stageContext,
    iteration: 1,
    actions,
    rejectedActions,
  })
  const allExecutedActions: RemediationActionRecord[] = []
  let round = 1

  while (round <= MAX_REMEDIATION_ROUNDS) {
    let orderedStages: [number, PlanResult['actions']][]
    if (round === 1) {
      const stageMap = new Map<number, PlanResult['actions']>()
      for (const call of plan.actions) {
        const stageNum = TOOL_STAGE_ORDER.get(call.tool_name as any) ?? 99
        if (!stageMap.has(stageNum)) stageMap.set(stageNum, [])
        stageMap.get(stageNum)!.push(call)
      }
      orderedStages = [...stageMap.entries()].sort(([a], [b]) => a - b)
    } else {
      options?.onProgress?.({ stage: `Re-analyzing and planning (round ${round})`, percent: 35 + (round - 1) * 10 })
      stageContext = await inspectPdfForRemediation(workingBuffer, currentResult, {
        inspectMode: inspectModeForResult(currentResult),
        cache: inspectionCache,
      })
      latestContext = stageContext
      plan = await planRemediationActions({
        filename,
        analysis: currentResult,
        context: stageContext,
        iteration: round,
        actions,
        rejectedActions,
      })
      if (plan.actions.length === 0 || plan.done) break
      const stageMap = new Map<number, PlanResult['actions']>()
      for (const call of plan.actions) {
        const stageNum = TOOL_STAGE_ORDER.get(call.tool_name as any) ?? 99
        if (!stageMap.has(stageNum)) stageMap.set(stageNum, [])
        stageMap.get(stageNum)!.push(call)
      }
      orderedStages = [...stageMap.entries()].sort(([a], [b]) => a - b)
    }

    let roundChangedDocument = false
    for (const [stageNum, stageCalls] of orderedStages) {
      if (options?.signal?.aborted) {
        const error = new Error('Remediation cancelled') as Error & { aborted?: boolean }
        error.aborted = true
        throw error
      }

      options?.onProgress?.({ stage: `Applying PDF fixes (stage ${stageNum})`, percent: 35 + stageNum * 5 })
    const stageStartBuffer = workingBuffer
    const stageStartResult = currentResult
    const stageActions: RemediationActionRecord[] = []
    let stageChangedDocument = false
    let stageImprovedStandards = false

    for (const call of stageCalls) {
      if (options?.signal?.aborted) {
        const error = new Error('Remediation cancelled') as Error & { aborted?: boolean }
        error.aborted = true
        throw error
      }

      const prevResult = currentResult
      const prevBuffer = workingBuffer
      const outcome = await executeRemediationTool({ buffer: workingBuffer, context: stageContext, call })
      let adoptedAction = outcome.action
      let adoptedBuffer = outcome.buffer

      if (nativeTaggedSafeMode && outcome.action.changedDocumentBytes) {
        // Per-action regression check in native-tagged-safe context
        const candidateResult = await analyzePDF(outcome.buffer, filename, { signal: options?.signal, skipAdobe: true })
        const regressionReason =
          hasNativeStandardsRegression(prevResult, candidateResult, outcome.action.tool)
          || shouldRejectNativeVisibleRewrite(prevResult, candidateResult, outcome.action)
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
          adoptedBuffer = prevBuffer
        } else {
          if (outcome.action.categoryTargets?.length) {
            adoptedAction.scoreDelta = outcome.action.categoryTargets.map(categoryId => ({
              categoryId,
              before: scoreForCategory(prevResult, categoryId),
              after: scoreForCategory(candidateResult, categoryId),
            }))
            const improved = adoptedAction.scoreDelta.some(d => (d.after ?? -1) > (d.before ?? -1))
            if (!improved && adoptedAction.outcome === 'applied') adoptedAction.outcome = 'no_effect'
          }
          stageImprovedStandards = stageImprovedStandards || standardsValidationImproved(prevResult, candidateResult)
          currentResult = candidateResult
          stageChangedDocument = true
          stageContext = await inspectPdfForRemediation(adoptedBuffer, currentResult, {
            inspectMode: inspectModeForResult(currentResult),
            cache: inspectionCache,
          })
          latestContext = stageContext
          currentTitle = stageContext.pdfjs.title || currentTitle
          currentLanguage = stageContext.qpdf.lang || stageContext.pdfjs.lang || currentLanguage
        }
      } else if (outcome.action.changedDocumentBytes && outcome.action.outcome !== 'rejected') {
        stageChangedDocument = true
      }

      workingBuffer = adoptedBuffer
      stageActions.push(adoptedAction)
      actions.push(adoptedAction)
      manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, outcome.manualReviewFlags)
    }

    // Non-native mode: single analysis per stage (instead of per action)
    if (!nativeTaggedSafeMode && stageChangedDocument) {
      const analyzedStage = await analyzePDF(workingBuffer, filename, { signal: options?.signal, skipAdobe: true })
      // repair_other_elements_alt_text fixes Adobe Acrobat issues not reflected in our score model
      const isAcrobatAltRepair = stageActions.some(
        a => a.tool === 'repair_other_elements_alt_text' && a.outcome === 'applied',
      )
      stageImprovedStandards = standardsValidationImproved(stageStartResult, analyzedStage)
      let stageImprovedTargets = false
      for (const action of stageActions) {
        stageImprovedTargets = applyScoreDelta(action, stageStartResult, analyzedStage) || stageImprovedTargets
        if (!stageImprovedTargets && action.outcome === 'applied') action.outcome = 'no_effect'
      }

      if (!isAcrobatAltRepair && !stageImprovedStandards && !stageImprovedTargets
        && hasDeterministicRegression(stageStartResult, analyzedStage)) {
        // Rollback entire stage
        for (const action of stageActions) {
          if (action.changedDocumentBytes || action.outcome === 'no_effect') {
            const rejected = {
              ...action,
              details: `${action.details} Rejected because the stage regressed accessibility scores or standards outcomes without offsetting improvement.`,
              outcome: 'rejected' as const,
              autoApplied: false,
              changedDocumentBytes: false,
            }
            const idx = actions.indexOf(action)
            if (idx >= 0) actions[idx] = rejected
            rejectedActions.push(rejected)
          }
        }
        manualReviewFlags = addFlag(manualReviewFlags, {
          code: `stage_${stageNum}_regressed`,
          label: 'Regressive stage rejected',
          severity: 'warning',
          details: `Rejected remediation stage ${stageNum} because it regressed accessibility scores or standards outcomes without offsetting improvement.`,
        })
        workingBuffer = stageStartBuffer
        currentResult = stageStartResult
      } else {
        currentResult = analyzedStage
      }
      stageContext = await inspectPdfForRemediation(workingBuffer, currentResult, {
        inspectMode: inspectModeForResult(currentResult),
        cache: inspectionCache,
      })
      latestContext = stageContext
      currentTitle = stageContext.pdfjs.title || currentTitle
      currentLanguage = stageContext.qpdf.lang || stageContext.pdfjs.lang || currentLanguage
    }

    allExecutedActions.push(...stageActions)
    previousActionNames = Array.from(new Set([
      ...previousActionNames,
      ...stageActions.map(a => `${a.tool}:${a.candidateGroupId || a.candidateId || a.target}`),
    ]))
    if (stageChangedDocument) roundChangedDocument = true

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
  }

    const bootstrapWasApplied = actions.some(a => a.tool === 'bootstrap_struct_tree' && a.outcome === 'applied')
    const altTextStillBroken = (scoreForCategory(currentResult, 'alt_text') ?? 100) < 100
    const altRepairAlreadyApplied = actions.some(a => a.tool === 'repair_other_elements_alt_text' && (a.outcome === 'applied' || a.outcome === 'no_effect'))
    if (round > 1 && !roundChangedDocument) break
    // Post-bootstrap second pass (round 1 only): when bootstrap created a struct tree, re-inspect for alt risks and run stages 5+.
    if (round === 1 && bootstrapWasApplied && altTextStillBroken && !altRepairAlreadyApplied) {
    if (options?.signal?.aborted) {
      const error = new Error('Remediation cancelled') as Error & { aborted?: boolean }
      error.aborted = true
      throw error
    }
    options?.onProgress?.({ stage: 'Post-bootstrap alt-text inspection', percent: 73 })
    stageContext = await inspectPdfForRemediation(workingBuffer, currentResult, {
      inspectMode: 'alt_text_deep',
      cache: inspectionCache,
    })
    latestContext = stageContext
    inspectionCache.qpdf = stageContext.qpdf
    inspectionCache.pdfjs = stageContext.pdfjs
    inspectionCache.pages = stageContext.pages

    const postBootstrapPlan = await planRemediationActions({
      filename,
      analysis: currentResult,
      context: stageContext,
      iteration: 2,
      actions,
      rejectedActions,
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
      if (options?.signal?.aborted) {
        const error = new Error('Remediation cancelled') as Error & { aborted?: boolean }
        error.aborted = true
        throw error
      }
      options?.onProgress?.({ stage: `Post-bootstrap fixes (stage ${stageNum})`, percent: 75 + stageNum })
      const stageStartBuffer = workingBuffer
      const stageStartResult = currentResult
      const stageActions: RemediationActionRecord[] = []
      let stageChangedDocument = false

      for (const call of stageCalls) {
        const prevResult = currentResult
        const prevBuffer = workingBuffer
        const outcome = await executeRemediationTool({ buffer: workingBuffer, context: stageContext, call })
        let adoptedAction = outcome.action
        let adoptedBuffer = outcome.buffer

        if (nativeTaggedSafeMode && outcome.action.changedDocumentBytes) {
          const candidateResult = await analyzePDF(outcome.buffer, filename, { signal: options?.signal, skipAdobe: true })
          const regressionReason =
            hasNativeStandardsRegression(prevResult, candidateResult, outcome.action.tool)
            || shouldRejectNativeVisibleRewrite(prevResult, candidateResult, outcome.action)
          if (regressionReason) {
            adoptedAction = { ...outcome.action, details: `${outcome.action.details} Rejected because it ${regressionReason}.`, outcome: 'rejected', autoApplied: false, changedDocumentBytes: false }
            rejectedActions.push(adoptedAction)
            adoptedBuffer = prevBuffer
          } else {
            if (outcome.action.categoryTargets?.length) {
              adoptedAction.scoreDelta = outcome.action.categoryTargets.map(categoryId => ({
                categoryId,
                before: scoreForCategory(prevResult, categoryId),
                after: scoreForCategory(candidateResult, categoryId),
              }))
              if (!adoptedAction.scoreDelta.some(d => (d.after ?? -1) > (d.before ?? -1)) && adoptedAction.outcome === 'applied') adoptedAction.outcome = 'no_effect'
            }
            currentResult = candidateResult
            stageChangedDocument = true
            stageContext = await inspectPdfForRemediation(adoptedBuffer, currentResult, { inspectMode: inspectModeForResult(currentResult), cache: inspectionCache })
            latestContext = stageContext
          }
        } else if (outcome.action.changedDocumentBytes && outcome.action.outcome !== 'rejected') {
          stageChangedDocument = true
        }

        workingBuffer = adoptedBuffer
        stageActions.push(adoptedAction)
        actions.push(adoptedAction)
        allExecutedActions.push(adoptedAction)
        manualReviewFlags = mergeManualReviewFlags(manualReviewFlags, outcome.manualReviewFlags)
      }

      if (!nativeTaggedSafeMode && stageChangedDocument) {
        const analyzedStage = await analyzePDF(workingBuffer, filename, { signal: options?.signal, skipAdobe: true })
        const isAcrobatAltRepair = stageActions.some(a => a.tool === 'repair_other_elements_alt_text' && a.outcome === 'applied')
        const stageImprovedStandards = standardsValidationImproved(stageStartResult, analyzedStage)
        let stageImprovedTargets = false
        for (const action of stageActions) {
          stageImprovedTargets = applyScoreDelta(action, stageStartResult, analyzedStage) || stageImprovedTargets
          if (!stageImprovedTargets && action.outcome === 'applied') action.outcome = 'no_effect'
        }
        if (!isAcrobatAltRepair && !stageImprovedStandards && !stageImprovedTargets && hasDeterministicRegression(stageStartResult, analyzedStage)) {
          for (const action of stageActions) {
            if (action.changedDocumentBytes || action.outcome === 'no_effect') {
              const rejected = { ...action, details: `${action.details} Rejected (post-bootstrap stage ${stageNum} regressed).`, outcome: 'rejected' as const, autoApplied: false, changedDocumentBytes: false }
              const idx = actions.indexOf(action)
              if (idx >= 0) actions[idx] = rejected
              rejectedActions.push(rejected)
            }
          }
          workingBuffer = stageStartBuffer
          currentResult = stageStartResult
        } else {
          currentResult = analyzedStage
        }
        stageContext = await inspectPdfForRemediation(workingBuffer, currentResult, { inspectMode: inspectModeForResult(currentResult), cache: inspectionCache })
        latestContext = stageContext
      }

      previousActionNames = Array.from(new Set([
        ...previousActionNames,
        ...stageActions.map(a => `${a.tool}:${a.candidateGroupId || a.candidateId || a.target}`),
      ]))
    }
    }
    round++
  }

  // Record as a single iteration for model compatibility
  iterations.push({
    iteration: 1,
    plannedActions: plan.actions,
    executedActions: allExecutedActions,
    changedDocument: !workingBuffer.equals(originalBuffer),
  })

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
