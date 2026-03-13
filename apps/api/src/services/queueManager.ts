import fs from 'node:fs'
import { BATCH_QUEUE } from '#config'
import type { DocumentModel } from './documentModel.js'
import { remediatePdfWithAgent } from './agentRemediationService.js'
import { analyzePDF } from './pdfAnalyzer.js'
import { emitQueueItemDeleted, emitQueueItemUpsert } from './queueEvents.js'
import {
  getQueueItemById,
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

const activeControllers = new Map<string, AbortController>()

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

  const rebuiltResult = remediation.finalResult.overallScore === originalResult.overallScore && remediation.finalResult.grade === originalResult.grade
    ? await analyzePDF(remediation.buffer, item.filename, {
      signal: controller.signal,
      onProgress(progress) {
        updateQueueItem(item.id, {
          processing_progress: remapProgress(82, 98, progress.percent),
          processing_stage: `Remediated analysis: ${progress.stage}`,
        })
        emitQueueItemUpsert(item.id)
      },
    })
    : remediation.finalResult

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

async function processQueueItem(item: QueueItemRecord): Promise<void> {
  const controller = new AbortController()
  activeControllers.set(item.id, controller)

  updateQueueItem(item.id, {
    state: 'processing',
    remediation_status: 'processing',
    document_model_status: 'processing',
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
      original_page_count: originalResult.pageCount,
      original_overall_score: originalResult.overallScore,
      original_grade: originalResult.grade,
      processing_path: 'agent_patch',
    })
    emitQueueItemUpsert(item.id)

    await runAgentPatchPipeline(item, buffer, originalResult, controller)
  } catch (err: any) {
    if (controller.signal.aborted) {
      updateQueueItem(item.id, {
        state: 'cancelled',
        remediation_status: 'failed',
        document_model_status: getQueueItemById(item.id)?.document_model_path ? 'completed' : 'failed',
        processing_progress: 0,
        processing_stage: 'Cancelled',
        error_json: JSON.stringify({ error: 'Processing cancelled.' }),
        reconstruction_error_json: JSON.stringify({ error: 'Processing cancelled.' }),
        completed_at: nowIso(),
      })
      emitQueueItemUpsert(item.id)
      return
    }

    const existing = getQueueItemById(item.id)
    const hasOriginalResult = !!existing?.original_result_json

    updateQueueItem(item.id, {
      state: 'failed',
      remediation_status: 'failed',
      document_model_status: existing?.document_model_path ? 'completed' : 'failed',
      processing_stage: 'Processing failed',
      error_json: JSON.stringify(err?.data || { error: err?.message || 'Processing failed.' }),
      reconstruction_error_json: JSON.stringify(err?.data || { error: err?.message || 'Processing failed.' }),
      result_json: hasOriginalResult ? existing?.original_result_json ?? null : null,
      page_count: hasOriginalResult ? existing?.original_page_count ?? null : null,
      overall_score: hasOriginalResult ? existing?.original_overall_score ?? null : null,
      grade: hasOriginalResult ? existing?.original_grade ?? null : null,
      completed_at: nowIso(),
    })
    emitQueueItemUpsert(item.id)
  } finally {
    activeControllers.delete(item.id)
    scheduleClient(item.client_id)
  }
}

export function scheduleClient(clientId: string): void {
  const active = listProcessingItems(clientId).length
  const available = Math.max(0, BATCH_QUEUE.MAX_PARALLEL_PER_CLIENT - active)
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
  if (!interrupted.length) return 0

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

  for (const clientId of clientIds) {
    scheduleClient(clientId)
  }

  return interrupted.length
}
