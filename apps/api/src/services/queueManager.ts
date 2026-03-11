import fs from 'node:fs'
import { BATCH_QUEUE } from '#config'
import { analyzePDF } from './pdfAnalyzer.js'
import { emitQueueItemDeleted, emitQueueItemUpsert } from './queueEvents.js'
import { remediatePdf } from './remediationService.js'
import {
  getQueueItemById,
  listProcessingItems,
  nextQueuedItems,
  nowIso,
  queueItemRemediatedDiskPath,
  QueueItemRecord,
  removeDiskFile,
  updateQueueItem,
} from './queueStore.js'

const activeControllers = new Map<string, AbortController>()

function remapProgress(start: number, end: number, progress: number): number {
  return Math.max(start, Math.min(end, Math.round(start + ((end - start) * progress) / 100)))
}

async function processQueueItem(item: QueueItemRecord): Promise<void> {
  const controller = new AbortController()
  activeControllers.set(item.id, controller)

  updateQueueItem(item.id, {
    state: 'processing',
    remediation_status: 'processing',
    processing_progress: 1,
    processing_stage: 'Analyzing original PDF',
    upload_progress: 100,
    processing_started_at: nowIso(),
    completed_at: null,
    error_json: null,
    remediation_error_json: null,
  })
  emitQueueItemUpsert(item.id)

  let remediatedPath: string | null = null

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
          processing_progress: remapProgress(5, 45, progress.percent),
          processing_stage: `Original analysis: ${progress.stage}`,
        })
        emitQueueItemUpsert(item.id)
      },
    })

    const originalPatch = {
      original_result_json: JSON.stringify(originalResult),
      original_page_count: originalResult.pageCount,
      original_overall_score: originalResult.overallScore,
      original_grade: originalResult.grade,
    }
    updateQueueItem(item.id, originalPatch)
    emitQueueItemUpsert(item.id)

    updateQueueItem(item.id, {
      processing_progress: 50,
      processing_stage: 'Applying safe automatic fixes',
      remediation_status: 'processing',
    })
    emitQueueItemUpsert(item.id)

    const remediation = await remediatePdf(buffer, originalResult, { signal: controller.signal })
    remediatedPath = queueItemRemediatedDiskPath(item.id, item.filename)
    await fs.promises.writeFile(remediatedPath, remediation.buffer)

    updateQueueItem(item.id, {
      remediated_storage_path: remediatedPath,
      remediation_status: remediation.remediationStatus,
      applied_fixes_json: JSON.stringify(remediation.appliedFixes),
      skipped_fixes_json: JSON.stringify(remediation.skippedFixes),
      manual_review_flags_json: JSON.stringify(remediation.manualReviewFlags),
      processing_progress: 60,
      processing_stage: 'Analyzing remediated PDF',
    })
    emitQueueItemUpsert(item.id)

    const remediatedResult = await analyzePDF(remediation.buffer, item.filename, {
      signal: controller.signal,
      onProgress(progress) {
        updateQueueItem(item.id, {
          processing_progress: remapProgress(60, 98, progress.percent),
          processing_stage: `Remediated analysis: ${progress.stage}`,
        })
        emitQueueItemUpsert(item.id)
      },
    })

    updateQueueItem(item.id, {
      state: 'complete',
      processing_progress: 100,
      processing_stage: 'Complete',
      result_json: JSON.stringify(remediatedResult),
      remediated_result_json: JSON.stringify(remediatedResult),
      error_json: null,
      remediation_error_json: null,
      page_count: remediatedResult.pageCount,
      overall_score: remediatedResult.overallScore,
      grade: remediatedResult.grade,
      remediated_page_count: remediatedResult.pageCount,
      remediated_overall_score: remediatedResult.overallScore,
      remediated_grade: remediatedResult.grade,
      completed_at: nowIso(),
    })
    emitQueueItemUpsert(item.id)
  } catch (err: any) {
    if (controller.signal.aborted) {
      updateQueueItem(item.id, {
        state: 'cancelled',
        remediation_status: 'failed',
        processing_progress: 0,
        processing_stage: 'Cancelled',
        error_json: JSON.stringify({ error: 'Processing cancelled.' }),
        remediation_error_json: JSON.stringify({ error: 'Processing cancelled.' }),
        completed_at: nowIso(),
      })
      emitQueueItemUpsert(item.id)
      return
    }

    const existing = getQueueItemById(item.id)
    const hasOriginalResult = !!existing?.original_result_json
    const remediationStage = existing?.processing_stage?.includes('Remediated') || existing?.processing_stage?.includes('automatic fixes')

    if (remediationStage && hasOriginalResult) {
      removeDiskFile(remediatedPath)
      updateQueueItem(item.id, {
        state: 'failed',
        remediation_status: 'failed',
        processing_stage: 'Remediation failed',
        remediation_error_json: JSON.stringify(err?.data || { error: err?.message || 'Remediation failed.' }),
        result_json: existing?.original_result_json ?? null,
        page_count: existing?.original_page_count ?? null,
        overall_score: existing?.original_overall_score ?? null,
        grade: existing?.original_grade ?? null,
        completed_at: nowIso(),
      })
      emitQueueItemUpsert(item.id)
      return
    }

    updateQueueItem(item.id, {
      state: 'failed',
      remediation_status: 'failed',
      processing_stage: 'Failed',
      error_json: JSON.stringify(err?.data || { error: err?.message || 'Processing failed.' }),
      remediation_error_json: remediationStage
        ? JSON.stringify(err?.data || { error: err?.message || 'Remediation failed.' })
        : null,
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

export function cancelQueueItem(itemId: string): { changed: boolean; clientId?: string } {
  const item = getQueueItemById(itemId)
  if (!item || item.hidden) return { changed: false }

  const controller = activeControllers.get(itemId)
  if (controller) {
    controller.abort()
    return { changed: true, clientId: item.client_id }
  }

  if (item.state === 'uploading' || item.state === 'queued') {
    updateQueueItem(itemId, {
      state: 'cancelled',
      remediation_status: 'failed',
      processing_stage: 'Cancelled',
      completed_at: nowIso(),
      error_json: JSON.stringify({ error: 'Processing cancelled.' }),
      remediation_error_json: JSON.stringify({ error: 'Processing cancelled.' }),
    })
    emitQueueItemUpsert(item.id)
    return { changed: true, clientId: item.client_id }
  }

  return { changed: false, clientId: item.client_id }
}

export function removeQueueItemFromStreams(itemId: string): void {
  const item = getQueueItemById(itemId)
  if (!item) return
  emitQueueItemDeleted(item.client_id, itemId)
}

export function getActiveUploadCount(_clientId: string): number {
  return 0
}
