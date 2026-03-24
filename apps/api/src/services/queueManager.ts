import fs from 'node:fs'
import { BATCH_QUEUE, REMEDIATION } from '#config'
import type { DocumentModel } from './documentModel.js'
import { remediatePdfWithAgent } from './agentRemediationService.js'
import { analyzePDF } from './pdfAnalyzer.js'
import { runAdobeAccessibilityCheck } from './adobePdfServices.js'
import { emitQueueItemDeleted, emitQueueItemUpsert } from './queueEvents.js'
import {
  getCurrentCodeVersion,
  getCurrentRuntimeGeneration,
  getQueueItemById,
  INTERNAL_QUEUE_MARKERS,
  listClientsWithQueuedItems,
  listInterruptedProcessingItems,
  listProcessingItems,
  nextQueuedItems,
  nowIso,
  queueItemDocumentModelPath,
  queueItemRebuiltDiskPath,
  queueItemReviewAssetsDir,
  QueueItemRecord,
  removeDiskDir,
  removeDiskFile,
  updateQueueItem,
} from './queueStore.js'
import { getActiveClientUploads } from './uploadActivity.js'

const activeControllers = new Map<string, AbortController>()
type QueueRequeueMode = 'remediate' | 'reanalyze'

function remapProgress(start: number, end: number, progress: number): number {
  return Math.max(start, Math.min(end, Math.round(start + ((end - start) * progress) / 100)))
}

async function persistModel(itemId: string, modelPath: string, reviewAssetsDir: string, model: DocumentModel): Promise<void> {
  await fs.promises.writeFile(modelPath, JSON.stringify(model, null, 2))
  updateQueueItem(itemId, {
    document_model_path: modelPath,
    review_assets_dir: reviewAssetsDir,
    manual_review_flags_json: JSON.stringify(model.manualReviewFlags),
    ai_applied_changes_json: JSON.stringify(model.aiAppliedChanges),
    ai_suggested_changes_json: JSON.stringify(model.aiSuggestedChanges),
    confidence_summary_json: JSON.stringify(model.confidenceSummary),
  })
  emitQueueItemUpsert(itemId)
}

async function runAgentPatchPipeline(
  item: QueueItemRecord,
  buffer: Buffer,
  originalResult: Awaited<ReturnType<typeof analyzePDF>>,
  controller: AbortController,
): Promise<void> {
  const modelPath = queueItemDocumentModelPath(item.id)
  const reviewAssetsDir = queueItemReviewAssetsDir(item.id)

  updateQueueItem(item.id, {
    processing_path: 'agent_patch',
    path_fallbacks_json: '[]',
    processing_progress: 32,
    processing_stage: 'Planning remediation',
    document_model_status: 'processing',
  })
  emitQueueItemUpsert(item.id)

  const remediation = await remediatePdfWithAgent(buffer, item.filename, originalResult, {
    artifactsDir: reviewAssetsDir,
    signal: controller.signal,
    onProgress(progress) {
      updateQueueItem(item.id, {
        processing_progress: remapProgress(32, 74, progress.percent),
        processing_stage: progress.stage,
      })
      emitQueueItemUpsert(item.id)
    },
    async onCheckpoint(model) {
      await persistModel(item.id, modelPath, reviewAssetsDir, model)
    },
  })

  await persistModel(item.id, modelPath, reviewAssetsDir, remediation.model)

  updateQueueItem(item.id, {
    document_model_status: 'completed',
    processing_progress: 78,
    processing_stage: 'Saving remediated PDF',
  })
  emitQueueItemUpsert(item.id)

  const rebuiltPath = queueItemRebuiltDiskPath(item.id, item.filename)
  await fs.promises.writeFile(rebuiltPath, remediation.buffer)

  updateQueueItem(item.id, {
    rebuilt_storage_path: rebuiltPath,
    processing_progress: 82,
    processing_stage: 'Analyzing remediated PDF',
  })
  emitQueueItemUpsert(item.id)

  const baseRebuiltResult = remediation.finalResult.overallScore === originalResult.overallScore && remediation.finalResult.grade === originalResult.grade
    ? await analyzePDF(remediation.buffer, item.filename, {
      signal: controller.signal,
      artifactsDir: reviewAssetsDir,
      skipAdobe: true,
      onProgress(progress) {
        updateQueueItem(item.id, {
          processing_progress: remapProgress(82, 96, progress.percent),
          processing_stage: `Remediated analysis: ${progress.stage}`,
        })
        emitQueueItemUpsert(item.id)
      },
    })
    : remediation.finalResult

  // Run the Adobe check exactly once on the final built PDF (when enabled).
  // All intermediate remediation passes use skipAdobe: true to conserve API quota.
  let rebuiltResult = baseRebuiltResult
  if (REMEDIATION.ENABLE_ADOBE_API) {
    updateQueueItem(item.id, { processing_progress: 97, processing_stage: 'Running Adobe Accessibility Check' })
    emitQueueItemUpsert(item.id)
    const finalAdobeResult = await runAdobeAccessibilityCheck({
      buffer: remediation.buffer,
      filename: item.filename,
      artifactsDir: reviewAssetsDir,
    })
    const finalAdobeSummary = {
      status: finalAdobeResult.status,
      summary: finalAdobeResult.summary,
      passed: finalAdobeResult.passed,
      issueCount: finalAdobeResult.issueCount,
      findings: finalAdobeResult.findings,
      warnings: finalAdobeResult.warnings,
      artifacts: finalAdobeResult.artifacts ?? null,
    }
    rebuiltResult = { ...baseRebuiltResult, adobe: finalAdobeSummary }
  }

  const reconstructionStatus = remediation.model.manualReviewFlags.length > 0 ? 'manual_review_required' : 'completed'
  updateQueueItem(item.id, {
    state: 'complete',
    processing_path: remediation.model.processingPath || 'agent_patch',
    path_fallbacks_json: JSON.stringify(remediation.model.pathFallbacks || []),
    remediation_status: reconstructionStatus,
    processing_progress: 100,
    processing_stage: 'Complete',
    result_json: JSON.stringify(rebuiltResult),
    rebuilt_result_json: JSON.stringify(rebuiltResult),
    adobe_summary_json: JSON.stringify(rebuiltResult.adobe || null),
    rebuilt_adobe_summary_json: JSON.stringify(rebuiltResult.adobe || null),
    rebuilt_page_count: rebuiltResult.pageCount,
    rebuilt_overall_score: rebuiltResult.overallScore,
    rebuilt_grade: rebuiltResult.grade,
    page_count: rebuiltResult.pageCount,
    overall_score: rebuiltResult.overallScore,
    grade: rebuiltResult.grade,
    completed_at: nowIso(),
    reconstruction_error_json: null,
    error_json: null,
  })
  emitQueueItemUpsert(item.id)
}

function isReanalyzeOnly(item: QueueItemRecord): boolean {
  try {
    const markers = JSON.parse(item.path_fallbacks_json || '[]') as string[]
    return Array.isArray(markers) && markers.includes(INTERNAL_QUEUE_MARKERS.REANALYZE_ONLY)
  } catch {
    return false
  }
}

function clearGeneratedArtifacts(item: QueueItemRecord): void {
  removeDiskFile(item.remediated_storage_path)
  removeDiskFile(item.rebuilt_storage_path)
  removeDiskFile(item.document_model_path)
  removeDiskDir(item.review_assets_dir)
}

async function processQueueItem(item: QueueItemRecord): Promise<void> {
  const controller = new AbortController()
  activeControllers.set(item.id, controller)
  const reanalyzeOnly = isReanalyzeOnly(item)

  updateQueueItem(item.id, {
    state: 'processing',
    remediation_status: 'processing',
    document_model_status: 'processing',
    runtime_generation: getCurrentRuntimeGeneration(),
    code_version: getCurrentCodeVersion(),
    result_freshness: 'fresh',
    promotion_status: 'unvalidated',
    promotion_rejection_reason: null,
    blocker_report_json: null,
    processing_progress: 1,
    processing_stage: 'Analyzing original PDF',
    upload_progress: 100,
    processing_started_at: nowIso(),
    completed_at: null,
    error_json: null,
    remediation_error_json: null,
    reconstruction_error_json: null,
  })
  emitQueueItemUpsert(item.id)

  try {
    const originalPath = item.original_storage_path || item.storage_path
    if (!originalPath || !fs.existsSync(originalPath)) {
      throw new Error('Stored original PDF file is missing.')
    }

    const buffer = await fs.promises.readFile(originalPath)
    const originalResult = await analyzePDF(buffer, item.filename, {
      signal: controller.signal,
      artifactsDir: queueItemReviewAssetsDir(item.id),
      onProgress(progress) {
        updateQueueItem(item.id, {
          processing_progress: remapProgress(5, 30, progress.percent),
          processing_stage: `Original analysis: ${progress.stage}`,
        })
        emitQueueItemUpsert(item.id)
      },
    })

    updateQueueItem(item.id, {
      original_result_json: JSON.stringify(originalResult),
      original_adobe_summary_json: JSON.stringify(originalResult.adobe || null),
      original_page_count: originalResult.pageCount,
      original_overall_score: originalResult.overallScore,
      original_grade: originalResult.grade,
      processing_path: 'agent_patch',
    })
    emitQueueItemUpsert(item.id)

    if (reanalyzeOnly) {
      updateQueueItem(item.id, {
        state: 'complete',
        remediation_status: 'completed',
        document_model_status: 'pending',
        processing_progress: 100,
        processing_stage: 'Complete',
        path_fallbacks_json: '[]',
        result_json: JSON.stringify(originalResult),
        adobe_summary_json: JSON.stringify(originalResult.adobe || null),
        rebuilt_result_json: null,
        rebuilt_adobe_summary_json: null,
        rebuilt_page_count: null,
        rebuilt_overall_score: null,
        rebuilt_grade: null,
        page_count: originalResult.pageCount,
        overall_score: originalResult.overallScore,
        grade: originalResult.grade,
        rebuilt_storage_path: null,
        remediated_storage_path: null,
        document_model_path: null,
        review_assets_dir: null,
        completed_at: nowIso(),
        reconstruction_error_json: null,
        error_json: null,
      })
      emitQueueItemUpsert(item.id)
      return
    }

    await runAgentPatchPipeline(item, buffer, originalResult, controller)
  } catch (err: any) {
    if (controller.signal.aborted) {
      const current = getQueueItemById(item.id)
      if (current) updateQueueItem(item.id, {
        state: 'cancelled',
        remediation_status: 'failed',
        document_model_status: current.document_model_path ? 'completed' : 'failed',
        processing_progress: 0,
        processing_stage: 'Cancelled',
        error_json: JSON.stringify({ error: 'Processing cancelled.' }),
        reconstruction_error_json: JSON.stringify({ error: 'Processing cancelled.' }),
        completed_at: nowIso(),
      })
      if (current) emitQueueItemUpsert(item.id)
      return
    }

    const existing = getQueueItemById(item.id)
    const hasOriginalResult = !!existing?.original_result_json

    if (existing) {
      updateQueueItem(item.id, {
        state: 'failed',
        remediation_status: 'failed',
        document_model_status: existing.document_model_path ? 'completed' : 'failed',
        processing_stage: 'Processing failed',
        error_json: JSON.stringify(err?.data || { error: err?.message || 'Processing failed.' }),
        reconstruction_error_json: JSON.stringify(err?.data || { error: err?.message || 'Processing failed.' }),
        result_json: hasOriginalResult ? existing.original_result_json ?? null : null,
        page_count: hasOriginalResult ? existing.original_page_count ?? null : null,
        overall_score: hasOriginalResult ? existing.original_overall_score ?? null : null,
        grade: hasOriginalResult ? existing.original_grade ?? null : null,
        completed_at: nowIso(),
      })
      emitQueueItemUpsert(item.id)
    }
  } finally {
    activeControllers.delete(item.id)
    scheduleClient(item.client_id)
  }
}

/** Max parallel processing jobs per client. Lower this (e.g. 1) when using SSH tunnels to avoid overloading the VM and dropping the connection. */
function maxParallelPerClient(): number {
  const env = process.env.QUEUE_MAX_PARALLEL
  if (env !== undefined && env !== '') {
    const n = parseInt(env, 10)
    if (Number.isFinite(n) && n >= 1) return Math.min(n, BATCH_QUEUE.MAX_PARALLEL_PER_CLIENT)
  }
  return BATCH_QUEUE.MAX_PARALLEL_PER_CLIENT
}

export function scheduleClient(clientId: string): void {
  const active = listProcessingItems(clientId).length
  const activeUploads = getActiveClientUploads(clientId)
  const cap = maxParallelPerClient()
  const concurrencyCap = activeUploads > 0
    ? Math.min(1, cap)
    : cap
  const available = Math.max(0, concurrencyCap - active)
  if (!available) return

  const queued = nextQueuedItems(clientId, available)
  for (const item of queued) {
    void processQueueItem(item)
  }
}

export function queueItemForProcessing(itemId: string): void {
  const item = getQueueItemById(itemId)
  if (!item || item.hidden || item.state !== 'queued') return
  scheduleClient(item.client_id)
}

export function requeueItem(itemId: string, mode: QueueRequeueMode): QueueItemRecord | null {
  const item = getQueueItemById(itemId)
  if (!item || item.hidden) return null
  if (item.state === 'uploading' || item.state === 'queued' || item.state === 'processing') return null
  if (!(item.original_storage_path || item.storage_path)) return null

  clearGeneratedArtifacts(item)
  const updated = updateQueueItem(itemId, {
    state: 'queued',
    remediation_status: 'pending',
    document_model_status: 'pending',
    runtime_generation: getCurrentRuntimeGeneration(),
    code_version: getCurrentCodeVersion(),
    result_freshness: 'fresh',
    promotion_status: 'unvalidated',
    promotion_rejection_reason: null,
    blocker_report_json: null,
    processing_progress: 0,
    processing_stage: mode === 'reanalyze' ? 'Queued for re-analysis' : 'Queued for remediation',
    processing_path: 'agent_patch',
    path_fallbacks_json: mode === 'reanalyze'
      ? JSON.stringify([INTERNAL_QUEUE_MARKERS.REANALYZE_ONLY])
      : '[]',
    remediated_storage_path: null,
    rebuilt_storage_path: null,
    document_model_path: null,
    review_assets_dir: null,
    result_json: null,
    remediated_result_json: null,
    rebuilt_result_json: null,
    remediation_error_json: null,
    reconstruction_error_json: null,
    applied_fixes_json: null,
    skipped_fixes_json: null,
    manual_review_flags_json: null,
    ai_applied_changes_json: null,
    ai_suggested_changes_json: null,
    confidence_summary_json: null,
    error_json: null,
    remediated_page_count: null,
    remediated_overall_score: null,
    remediated_grade: null,
    rebuilt_page_count: null,
    rebuilt_overall_score: null,
    rebuilt_grade: null,
    page_count: null,
    overall_score: null,
    grade: null,
    completed_at: null,
  })
  emitQueueItemUpsert(updated.id)
  queueItemForProcessing(updated.id)
  return updated
}

export function cancelQueueItem(itemId: string): void {
  const item = getQueueItemById(itemId)
  if (!item || item.hidden) return

  const controller = activeControllers.get(itemId)
  if (controller) {
    controller.abort()
    return
  }

  updateQueueItem(itemId, {
    state: 'cancelled',
    remediation_status: 'failed',
    document_model_status: item.document_model_path ? 'completed' : 'failed',
    processing_progress: 0,
    processing_stage: 'Cancelled',
    completed_at: nowIso(),
  })
  emitQueueItemUpsert(itemId)
}

export function removeQueueItemFromStreams(itemId: string): void {
  const item = getQueueItemById(itemId)
  if (!item) return

  const controller = activeControllers.get(itemId)
  if (controller) controller.abort()

  removeDiskFile(item.storage_path)
  removeDiskFile(item.original_storage_path)
  removeDiskFile(item.remediated_storage_path)
  removeDiskFile(item.rebuilt_storage_path)
  removeDiskFile(item.document_model_path)
  removeDiskDir(item.review_assets_dir)
  emitQueueItemDeleted(item.client_id, itemId)
}

export function recoverInterruptedProcessing(): number {
  const interrupted = listInterruptedProcessingItems()

  const clientIds = new Set<string>()
  for (const item of interrupted) {
    updateQueueItem(item.id, {
      state: 'queued',
      remediation_status: 'pending',
      document_model_status: item.document_model_path ? 'completed' : 'pending',
      processing_progress: 0,
      processing_stage: 'Queued for retry after API restart',
      completed_at: null,
      error_json: null,
      remediation_error_json: null,
      reconstruction_error_json: null,
    })
    emitQueueItemUpsert(item.id)
    clientIds.add(item.client_id)
  }

  // Also schedule clients that already have items in queued state (not just interrupted ones)
  for (const clientId of listClientsWithQueuedItems()) {
    clientIds.add(clientId)
  }

  for (const clientId of clientIds) {
    scheduleClient(clientId)
  }

  return interrupted.length
}
