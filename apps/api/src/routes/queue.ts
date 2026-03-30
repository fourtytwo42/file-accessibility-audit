import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Router, type IRouter, type Response } from 'express'
import multer from 'multer'
import { BATCH_QUEUE } from '#config'
import { bootstrapClientSession, ClientSessionRequest, requireClientSession, requireClientSessionOrInternalWorker } from '../middleware/clientSession.js'
import { streamQueueArchive } from '../services/archiveService.js'
import { emitQueueItemDeleted, emitQueueItemUpsert, registerQueueSse } from '../services/queueEvents.js'
import { cancelQueueItem, queueItemForProcessing, removeQueueItemFromStreams, requeueItem, scheduleClient } from '../services/queueManager.js'
import {
  cleanupExpiredQueueItems,
  createQueueItem,
  getCurrentCodeVersion,
  getCurrentRuntimeGeneration,
  getFreshActiveQueueItemByFilename,
  getLatestVisibleQueueItemByFilename,
  deleteQueueItemPermanently,
  failStaleUploads,
  getQueueCounts,
  getQueueItemById,
  getQueueStatusCounts,
  getQueueStorageRoots,
  listActiveQueueItems,
  listQueueStatusItems,
  listHistoryQueueItems,
  listSelectableQueueItemIds,
  markQueueItemHidden,
  nowIso,
  queueItemDiskPath,
  QueueItemRecord,
  removeDiskFile,
  sanitizeBasename,
  serializeQueueItemDetail,
  serializeQueueItemVersions,
  serializeQueueItemSummary,
  updateQueueItem,
} from '../services/queueStore.js'
import { writeNeedsApiFixRecord } from '../services/needsApiFixService.js'
import { promoteQueueItemToComplete, validateQueueItemForComplete } from '../services/queuePromotionService.js'
import { appendRemediationLedgerEvent } from '../services/remediationLedgerService.js'
import { beginClientUpload } from '../services/uploadActivity.js'

const router: IRouter = Router()
const { stagingRoot } = getQueueStorageRoots()
const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDir, '..', '..', '..', '..')
const downloadsRoot = path.join(repoRoot, 'Downloads')

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, stagingRoot),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname) || '.pdf'}`),
  }),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true)
      return
    }
    cb(new Error('Only PDF files are accepted'))
  },
})

function queueHousekeeping(): void {
  cleanupExpiredQueueItems()
  failStaleUploads()
}

let lastHousekeepingAt = 0
const HOT_PATH_HOUSEKEEPING_INTERVAL_MS = 60_000

function queueHousekeepingThrottled(): void {
  const now = Date.now()
  if (now - lastHousekeepingAt < HOT_PATH_HOUSEKEEPING_INTERVAL_MS) return
  lastHousekeepingAt = now
  queueHousekeeping()
}

function readItemId(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : value || ''
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function classifyPipelineStage(stage: string | null): string | null {
  if (!stage) return null
  const normalized = stage.toLowerCase()
  if (normalized.includes('original analysis')) return 'original_analysis'
  if (normalized.includes('analy')) return 'analysis'
  if (normalized.includes('semantic')) return 'semantic_fixes'
  if (normalized.includes('post-bootstrap')) return 'post_bootstrap_fixes'
  if (normalized.includes('bookmark')) return 'bookmark_cleanup'
  if (normalized.includes('validate')) return 'validation'
  if (normalized.includes('promot')) return 'promotion'
  if (normalized.includes('fix')) return 'remediation'
  return 'other'
}

function classifyBlockerKind(blockerType: string, processingStage: string | null, topFailureModeKeys: string[], criticalManualReviewCount: number): string {
  if (blockerType === 'stalled_processing' || blockerType === 'runtime_stall') return 'runtime_stall'
  if (criticalManualReviewCount > 0) return 'manual_review_blocker'
  if (processingStage && processingStage.toLowerCase().includes('semantic')) return 'semantic_pipeline_gap'
  if (topFailureModeKeys.length > 0) return 'validation_failure'
  return 'planner_gap'
}

function classifyBookmarkState(detail: ReturnType<typeof serializeQueueItemDetail>): 'ai_clean' | 'raw_or_noisy' | 'not_run' | 'unknown' {
  const summaryText = detail.standardsDetail?.gradeBasis.summaryText?.toLowerCase() || ''
  if (!summaryText) return 'unknown'
  if (summaryText.includes('bookmark')) {
    if (summaryText.includes('noisy') || summaryText.includes('raw') || summaryText.includes('ocr')) return 'raw_or_noisy'
    if (summaryText.includes('ai')) return 'ai_clean'
  }
  return 'unknown'
}

function classifySemanticSidecarState(detail: ReturnType<typeof serializeQueueItemDetail>): 'unknown' | 'not_flagged' | 'semantic_sidecar_unavailable' {
  return (detail.manualReviewFlags || []).some(flag => flag.code === 'semantic_sidecar_unavailable')
    ? 'semantic_sidecar_unavailable'
    : (detail.manualReviewFlags || []).length
      ? 'not_flagged'
      : 'unknown'
}

function internalSourcePdfPath(filename: string): string | null {
  const candidate = path.join(downloadsRoot, sanitizeBasename(filename))
  return fs.existsSync(candidate) ? candidate : null
}

async function createQueueItemFromInternalSource(req: ClientSessionRequest, input: {
  filename: string
  ownerId?: string | null
  jobGroup?: string | null
  supersedesItemId?: string | null
}): Promise<QueueItemRecord> {
  const sourcePath = internalSourcePdfPath(input.filename)
  if (!sourcePath) throw new Error(`Source PDF not found in Downloads/: ${input.filename}`)
  const stat = await fs.promises.stat(sourcePath)
  const item = createQueueItem({
    clientId: req.clientId!,
    filename: sanitizeBasename(input.filename),
    sizeBytes: stat.size,
    mimeType: 'application/pdf',
    ownerKind: 'agent',
    ownerId: input.ownerId ?? null,
    jobGroup: input.jobGroup ?? null,
    supersedesItemId: input.supersedesItemId ?? null,
  })
  const destination = queueItemDiskPath(item.id, item.filename)
  await fs.promises.copyFile(sourcePath, destination)
  const queued = updateQueueItem(item.id, {
    state: 'queued',
    storage_path: destination,
    original_storage_path: destination,
    upload_progress: 100,
    processing_progress: 0,
    processing_stage: 'Queued for analysis',
    upload_completed_at: nowIso(),
    owner_kind: 'agent',
    owner_id: input.ownerId ?? null,
    job_group: input.jobGroup ?? null,
    supersedes_item_id: input.supersedesItemId ?? null,
    runtime_generation: getCurrentRuntimeGeneration(),
    code_version: getCurrentCodeVersion(),
    result_freshness: 'fresh',
    promotion_status: 'unvalidated',
    promotion_rejection_reason: null,
    blocker_report_json: null,
    error_json: null,
  })
  emitQueueItemUpsert(queued.id)
  setImmediate(() => queueItemForProcessing(queued.id))
  return queued
}

function claimQueueLineage(req: ClientSessionRequest, filename: string, ownerId?: string | null, jobGroup?: string | null): QueueItemRecord {
  const existing = getLatestVisibleQueueItemByFilename(req.clientId!, filename)
  if (existing) {
    return updateQueueItem(existing.id, {
      owner_kind: 'agent',
      owner_id: ownerId ?? null,
      job_group: jobGroup ?? null,
    })
  }

  const sourcePath = internalSourcePdfPath(filename)
  const placeholder = createQueueItem({
    clientId: req.clientId!,
    filename: sanitizeBasename(filename),
    sizeBytes: sourcePath ? fs.statSync(sourcePath).size : 0,
    mimeType: 'application/pdf',
    ownerKind: 'agent',
    ownerId: ownerId ?? null,
    jobGroup: jobGroup ?? null,
  })
  return updateQueueItem(placeholder.id, {
    state: 'queued',
    upload_progress: sourcePath ? 100 : 0,
    processing_stage: sourcePath ? 'Claimed awaiting internal start' : 'Claimed without source artifact',
    owner_kind: 'agent',
    owner_id: ownerId ?? null,
    job_group: jobGroup ?? null,
    runtime_generation: getCurrentRuntimeGeneration(),
    code_version: getCurrentCodeVersion(),
    result_freshness: 'fresh',
    promotion_status: 'unvalidated',
    promotion_rejection_reason: null,
  })
}

function allVisibleItemsForClient(clientId: string): QueueItemRecord[] {
  const active = listActiveQueueItems(clientId).map(item => getQueueItemById(item.id)).filter(Boolean) as QueueItemRecord[]
  const history = listHistoryQueueItems(clientId, 1, 10_000).items.map(item => getQueueItemById(item.id)).filter(Boolean) as QueueItemRecord[]
  return [...active, ...history]
}

router.post('/client/bootstrap', bootstrapClientSession)

function trackActiveUpload(req: ClientSessionRequest, res: Response, next: () => void): void {
  const clientId = req.clientId
  if (!clientId) {
    next()
    return
  }

  const release = beginClientUpload(clientId)
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    release()
    scheduleClient(clientId)
  }

  res.once('finish', cleanup)
  res.once('close', cleanup)
  next()
}

router.post('/queue/upload', requireClientSession, trackActiveUpload, upload.single('file'), async (req: ClientSessionRequest, res: Response) => {
  queueHousekeeping()

  const uploaded = req.file

  if (!uploaded) {
    res.status(400).json({ error: 'No file uploaded' })
    return
  }

  try {
    const filename = sanitizeBasename(uploaded.originalname)
    const header = fs.readFileSync(uploaded.path).subarray(0, 5).toString('ascii')
    if (header !== '%PDF-') {
      removeDiskFile(uploaded.path)
      res.status(400).json({ error: 'This file does not appear to be a valid PDF.' })
      return
    }

    const item = createQueueItem({
      clientId: req.clientId!,
      filename,
      sizeBytes: uploaded.size,
      mimeType: uploaded.mimetype,
    })

    const destination = queueItemDiskPath(item.id, item.filename)
    await fs.promises.rename(uploaded.path, destination)

    const queued = updateQueueItem(item.id, {
      state: 'queued',
      storage_path: destination,
      original_storage_path: destination,
      size_bytes: uploaded.size,
      mime_type: uploaded.mimetype,
      upload_progress: 100,
      processing_progress: 0,
      processing_stage: 'Queued for analysis',
      upload_completed_at: nowIso(),
      runtime_generation: getCurrentRuntimeGeneration(),
      code_version: getCurrentCodeVersion(),
      result_freshness: 'fresh',
      promotion_status: 'unvalidated',
      promotion_rejection_reason: null,
      blocker_report_json: null,
      error_json: null,
    })
    emitQueueItemUpsert(queued.id)
    res.json({ item: serializeQueueItemSummary(queued) })
    setImmediate(() => queueItemForProcessing(queued.id))
  } catch (err: any) {
    removeDiskFile(uploaded.path)
    res.status(500).json({ error: 'Upload failed.' })
  }
})

router.get('/queue/active', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  queueHousekeepingThrottled()
  res.json({ items: listActiveQueueItems(req.clientId!) })
})

router.get('/queue/history', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  queueHousekeepingThrottled()
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.max(1, Number(req.query.limit) || BATCH_QUEUE.INITIAL_PAGE_SIZE)
  const { items, total } = listHistoryQueueItems(req.clientId!, page, limit)
  res.json({
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore: page * limit < total,
    },
  })
})

router.get('/queue/counts', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  queueHousekeepingThrottled()
  res.json(getQueueCounts(req.clientId!))
})

router.get('/queue/status', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  queueHousekeepingThrottled()
  try {
    const items = listQueueStatusItems(req.clientId!)
    const counts = getQueueStatusCounts(req.clientId!)
    res.json({
      items,
      counts,
      generatedAt: nowIso(),
    })
  } catch (err) {
    console.error('[queue/status] Failed to load queue:', err)
    res.status(500).json({
      error: 'Failed to load your PDF queue.',
      ...(process.env.NODE_ENV !== 'production' && { details: err instanceof Error ? err.message : String(err) }),
    })
  }
})

router.get('/queue/selectable-ids', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  queueHousekeepingThrottled()
  const scope = req.query.scope === 'complete' ? 'complete' : req.query.scope === 'active' ? 'active' : null
  if (!scope) {
    res.status(400).json({ error: 'A valid selection scope is required' })
    return
  }
  res.json({ ids: listSelectableQueueItemIds(req.clientId!, scope) })
})

router.post('/queue/claim', requireClientSessionOrInternalWorker, (req: ClientSessionRequest, res: Response) => {
  queueHousekeepingThrottled()
  const filename = readOptionalString(req.body?.filename)
  if (!filename) {
    res.status(400).json({ error: 'filename is required' })
    return
  }
  const ownerId = readOptionalString(req.body?.ownerId)
  const jobGroup = readOptionalString(req.body?.jobGroup)
  const item = claimQueueLineage(req, filename, ownerId, jobGroup)
  emitQueueItemUpsert(item.id)
  res.json({ item: serializeQueueItemSummary(item) })
})

router.post('/queue/start-or-reuse', requireClientSessionOrInternalWorker, async (req: ClientSessionRequest, res: Response) => {
  queueHousekeepingThrottled()
  const filename = readOptionalString(req.body?.filename)
  const ownerId = readOptionalString(req.body?.ownerId)
  const jobGroup = readOptionalString(req.body?.jobGroup)
  if (!filename || !ownerId) {
    res.status(400).json({ error: 'filename and ownerId are required' })
    return
  }

  try {
    const freshActive = getFreshActiveQueueItemByFilename(req.clientId!, filename)
    if (freshActive) {
      const claimed = updateQueueItem(freshActive.id, {
        owner_kind: 'agent',
        owner_id: ownerId,
        job_group: jobGroup,
      })
      emitQueueItemUpsert(claimed.id)
      res.json({ reused: true, item: serializeQueueItemSummary(claimed) })
      return
    }

    const latest = getLatestVisibleQueueItemByFilename(req.clientId!, filename)
    if (latest && latest.state !== 'uploading' && latest.state !== 'queued' && latest.state !== 'processing' && (latest.original_storage_path || latest.storage_path)) {
      const requeued = requeueItem(latest.id, 'remediate')
      if (requeued) {
        const claimed = updateQueueItem(requeued.id, {
          owner_kind: 'agent',
          owner_id: ownerId,
          job_group: jobGroup,
          runtime_generation: getCurrentRuntimeGeneration(),
          code_version: getCurrentCodeVersion(),
          result_freshness: 'fresh',
          promotion_status: 'unvalidated',
          promotion_rejection_reason: null,
          blocker_report_json: null,
        })
        emitQueueItemUpsert(claimed.id)
        res.json({ reused: false, item: serializeQueueItemSummary(claimed) })
        return
      }
    }

    const created = await createQueueItemFromInternalSource(req, {
      filename,
      ownerId,
      jobGroup,
      supersedesItemId: latest?.id ?? null,
    })
    if (latest) {
      updateQueueItem(latest.id, { result_freshness: 'superseded' })
      emitQueueItemUpsert(latest.id)
    }
    res.json({ reused: false, item: serializeQueueItemSummary(created) })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to start or reuse queue item',
    })
  }
})

router.get('/queue/items/:id', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  const item = getQueueItemById(readItemId(req.params.id))
  if (!item || item.client_id !== req.clientId || item.hidden) {
    res.status(404).json({ error: 'Queue item not found' })
    return
  }
  res.json({ item: serializeQueueItemDetail(item) })
})

router.get('/queue/items/:id/freshness', requireClientSessionOrInternalWorker, (req: ClientSessionRequest, res: Response) => {
  const item = getQueueItemById(readItemId(req.params.id))
  if (!item || item.client_id !== req.clientId || item.hidden) {
    res.status(404).json({ error: 'Queue item not found' })
    return
  }
  res.json({
    itemId: item.id,
    runtimeGeneration: item.runtime_generation,
    currentRuntimeGeneration: getCurrentRuntimeGeneration(),
    codeVersion: item.code_version,
    currentCodeVersion: getCurrentCodeVersion(),
    resultFreshness: item.result_freshness || 'fresh',
    supersedesItemId: item.supersedes_item_id,
    promotionStatus: item.promotion_status || 'unvalidated',
    ownerKind: item.owner_kind,
    ownerId: item.owner_id,
    jobGroup: item.job_group,
  })
})

router.post('/queue/items/:id/validate-for-complete', requireClientSessionOrInternalWorker, async (req: ClientSessionRequest, res: Response) => {
  const item = getQueueItemById(readItemId(req.params.id))
  if (!item || item.client_id !== req.clientId || item.hidden) {
    res.status(404).json({ error: 'Queue item not found' })
    return
  }
  try {
    const outcome = await validateQueueItemForComplete(item)
    res.json({
      itemId: item.id,
      validation: outcome.validation,
      artifacts: outcome.artifacts,
      failurePacketPath: outcome.failurePacket ? outcome.artifacts.failurePacketJsonPath : null,
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to validate queue item for complete promotion',
    })
  }
})

router.post('/queue/items/:id/promote', requireClientSessionOrInternalWorker, async (req: ClientSessionRequest, res: Response) => {
  const item = getQueueItemById(readItemId(req.params.id))
  if (!item || item.client_id !== req.clientId || item.hidden) {
    res.status(404).json({ error: 'Queue item not found' })
    return
  }
  try {
    const promoted = await promoteQueueItemToComplete(item)
    try {
      const latest = getQueueItemById(item.id) || item
      const detail = serializeQueueItemDetail(latest)
      await appendRemediationLedgerEvent({
        recordedAt: nowIso(),
        outcome: 'complete',
        filename: latest.filename,
        queueItemId: latest.id,
        ownerId: latest.owner_id,
        jobGroup: latest.job_group,
        runtimeGeneration: latest.runtime_generation,
        codeVersion: latest.code_version,
        sourcePdfPath: internalSourcePdfPath(latest.filename),
        summary: 'Promoted to Complete after fresh WCAG 2.1 AA-aligned validation.',
        subsystem: null,
        completeDestinationPath: promoted.destinationPath,
        needsApiFixRecordPath: null,
        artifactPaths: [
          promoted.destinationPath,
          promoted.artifacts.visualComparisonJsonPath,
          promoted.artifacts.originalPage1PngPath,
          promoted.artifacts.remediatedPage1PngPath,
        ],
        classification: {
          fixFamily: null,
          blockerKind: 'complete',
          pipelineStage: 'promotion',
          structuralClass: detail.documentModel?.classification?.structuralClass || detail.documentModel?.pipelineConfig?.structuralClass || null,
          residualFamilyIds: [],
          topFailureModeKeys: [],
          visualFidelity: promoted.validation.visualComparison.passed ? 'passed' : 'failed',
          bookmarkState: promoted.validation.bookmarkValidation.usedAiCleanup
            ? 'ai_clean'
            : promoted.validation.bookmarkValidation.flaggedTitles.length > 0
              ? 'raw_or_noisy'
              : 'unknown',
          semanticSidecarState: classifySemanticSidecarState(detail),
          likelyNextGenericFix: 'none_required',
          generalizationConfidence: 'low',
        },
        validation: {
          promotionEligible: promoted.validation.promotionEligible,
          freshnessPassed: promoted.validation.freshnessPassed,
          blockingFailureModesClear: promoted.validation.blockingFailureModesClear,
          blockingResidualFamiliesClear: promoted.validation.blockingResidualFamiliesClear,
          criticalManualReviewClear: promoted.validation.criticalManualReviewClear,
          visualFidelityPassed: promoted.validation.visualComparison.passed,
        },
      })
    } catch (ledgerErr) {
      console.error('[queue/promote] Failed to write remediation ledger event:', ledgerErr)
    }
    res.json({
      itemId: item.id,
      destinationPath: promoted.destinationPath,
      validation: promoted.validation,
    })
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Queue item is not eligible for promotion',
    })
  }
})

router.post('/queue/items/:id/emit-blocker', requireClientSessionOrInternalWorker, async (req: ClientSessionRequest, res: Response) => {
  const item = getQueueItemById(readItemId(req.params.id))
  if (!item || item.client_id !== req.clientId || item.hidden) {
    res.status(404).json({ error: 'Queue item not found' })
    return
  }

  const blockerType = readOptionalString(req.body?.blockerType)
  const subsystem = readOptionalString(req.body?.subsystem)
  const summary = readOptionalString(req.body?.summary)
  const artifactPaths = Array.isArray(req.body?.artifactPaths)
    ? req.body.artifactPaths.filter((value: unknown): value is string => typeof value === 'string')
    : []
  const reusable = typeof req.body?.reusable === 'boolean' ? req.body.reusable : true

  const blockerReport = {
    generatedAt: nowIso(),
    blockerType: blockerType || 'unspecified',
    subsystem: subsystem || 'unknown',
    summary: summary || 'No blocker summary provided.',
    reusable,
    artifactPaths,
  }
  const detail = serializeQueueItemDetail(item)
  const topFailureModes = (detail.standardsDetail?.failureModes || [])
    .filter(mode => mode.blocking)
    .slice(0, 5)
    .map(mode => ({
      key: mode.key,
      label: mode.label,
      blocking: mode.blocking,
      count: mode.count,
    }))
  const criticalManualReviewFlags = (detail.manualReviewFlags || [])
    .filter(flag => flag.severity === 'critical')
    .slice(0, 5)
    .map(flag => ({
      code: flag.code,
      label: flag.label,
      details: flag.details,
    }))
  const likelyNextFixArea = topFailureModes[0]?.label
    || criticalManualReviewFlags[0]?.label
    || blockerReport.subsystem
    || 'unknown'
  const residualFamilyIds = detail.standardsDetail?.plannerEvidence?.topBlockingResidualFamilyIds
    || detail.standardsDetail?.plannerEvidence?.topResidualFamilyIds
    || []
  const topFailureModeKeys = topFailureModes.map(mode => mode.key)
  const pipelineStage = classifyPipelineStage(item.processing_stage)
  const blockerKind = classifyBlockerKind(blockerReport.blockerType, item.processing_stage, topFailureModeKeys, criticalManualReviewFlags.length)
  const structuralClass = detail.documentModel?.classification?.structuralClass
    || detail.documentModel?.pipelineConfig?.structuralClass
    || null
  const semanticSidecarState = classifySemanticSidecarState(detail)
  const fixFamily = residualFamilyIds[0]
    || topFailureModeKeys[0]
    || null
  const generalizationConfidence: 'low' | 'medium' | 'high' =
    blockerReport.reusable && (residualFamilyIds.length > 0 || topFailureModeKeys.length > 0)
      ? 'high'
      : blockerReport.reusable
        ? 'medium'
        : 'low'

  try {
    const needsApiFix = await writeNeedsApiFixRecord({
      filename: item.filename,
      queueItemId: item.id,
      blockerType: blockerReport.blockerType,
      subsystem: blockerReport.subsystem,
      summary: blockerReport.summary,
      classification: {
        fixFamily,
        blockerKind,
        pipelineStage,
        structuralClass,
        residualFamilyIds,
        topFailureModeKeys,
        visualFidelity: 'not_run',
        bookmarkState: classifyBookmarkState(detail),
        semanticSidecarState,
        likelyNextGenericFix: likelyNextFixArea,
        generalizationConfidence,
      },
      explanation: {
        queueState: item.state,
        processingStage: item.processing_stage,
        processingProgress: item.processing_progress,
        overallScore: item.overall_score,
        grade: item.grade,
        promotionStatus: item.promotion_status,
        likelyNextFixArea,
        topFailureModes,
        criticalManualReviewFlags,
      },
      reusable: blockerReport.reusable,
      artifactPaths: blockerReport.artifactPaths,
      ownerId: item.owner_id,
      jobGroup: item.job_group,
      runtimeGeneration: item.runtime_generation,
      codeVersion: item.code_version,
      sourcePdfPath: internalSourcePdfPath(item.filename),
      recordedAt: blockerReport.generatedAt,
    })

    const updated = updateQueueItem(item.id, {
      blocker_report_json: JSON.stringify({
        ...blockerReport,
        needsApiFixRecordPath: needsApiFix.recordPath,
      }),
      promotion_status: 'rejected',
      promotion_rejection_reason: blockerReport.summary,
    })
    emitQueueItemUpsert(updated.id)
    res.json({
      item: serializeQueueItemSummary(updated),
      blockerReport,
      needsApiFix,
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to write NeedsApiFix record',
    })
  }
})

router.get('/queue/items/:id/versions', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  const item = getQueueItemById(readItemId(req.params.id))
  if (!item || item.client_id !== req.clientId || item.hidden) {
    res.status(404).json({ error: 'Queue item not found' })
    return
  }
  res.json({
    itemId: item.id,
    versions: serializeQueueItemVersions(item),
  })
})

router.get('/queue/events', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })

  const cleanup = registerQueueSse(req.clientId!, res)
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n')
  }, 15_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    cleanup()
  })
})

router.post('/queue/items/:id/cancel', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  const item = getQueueItemById(readItemId(req.params.id))
  if (!item || item.client_id !== req.clientId || item.hidden) {
    res.status(404).json({ error: 'Queue item not found' })
    return
  }
  cancelQueueItem(item.id)
  res.json({ ok: true })
})

router.post('/queue/items/:id/retry', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  const item = getQueueItemById(readItemId(req.params.id))
  if (!item || item.client_id !== req.clientId || item.hidden) {
    res.status(404).json({ error: 'Queue item not found' })
    return
  }
  if (item.state !== 'failed' || !(item.original_storage_path || item.storage_path)) {
    res.status(400).json({ error: 'Only failed uploaded items can be retried' })
    return
  }

  const updated = updateQueueItem(item.id, {
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
    processing_stage: 'Queued for retry',
    processing_path: 'agent_patch',
    path_fallbacks_json: '[]',
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
  res.json({ item: serializeQueueItemSummary(updated) })
})

function hideItemForClient(itemId: string, clientId: string): void {
  const item = getQueueItemById(itemId)
  if (!item || item.client_id !== clientId || item.hidden) return

  const hasPersistedArtifacts = !!(
    item.storage_path
    || item.original_storage_path
    || item.remediated_storage_path
    || item.rebuilt_storage_path
    || item.document_model_path
    || item.review_assets_dir
  )

  if (item.state === 'failed' && !hasPersistedArtifacts) {
    deleteQueueItemPermanently(itemId)
    emitQueueItemDeleted(clientId, itemId)
    return
  }

  cancelQueueItem(itemId)
  markQueueItemHidden(itemId)
  removeQueueItemFromStreams(itemId)
}

router.post('/queue/items/:id/delete', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  const item = getQueueItemById(readItemId(req.params.id))
  if (!item || item.client_id !== req.clientId || item.hidden) {
    res.status(404).json({ error: 'Queue item not found' })
    return
  }
  hideItemForClient(item.id, req.clientId!)
  res.json({ ok: true })
})

router.post('/queue/delete-many', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  const itemIds = Array.isArray(req.body?.itemIds) ? req.body.itemIds.filter((id: unknown) => typeof id === 'string') : []
  for (const itemId of itemIds) hideItemForClient(itemId, req.clientId!)
  res.json({ ok: true, count: itemIds.length })
})

router.post('/queue/delete-all', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  const active = listActiveQueueItems(req.clientId!)
  const history = listHistoryQueueItems(req.clientId!, 1, 10_000).items
  for (const item of [...active, ...history]) hideItemForClient(item.id, req.clientId!)
  res.json({ ok: true })
})

function visibleOwnedItemIds(clientId: string): Set<string> {
  return new Set(allVisibleItemsForClient(clientId).map(item => item.id))
}

function bulkRequeue(req: ClientSessionRequest, res: Response, mode: 'remediate' | 'reanalyze'): void {
  const requestedIds = Array.isArray(req.body?.itemIds)
    ? req.body.itemIds.filter((id: unknown): id is string => typeof id === 'string')
    : []
  const visibleIds = visibleOwnedItemIds(req.clientId!)
  const matchingIds = requestedIds.filter((id: string) => visibleIds.has(id))

  if (!matchingIds.length) {
    res.status(404).json({ error: 'Queue items not found' })
    return
  }

  const updated = matchingIds
    .map((id: string) => requeueItem(id, mode))
    .filter((item: QueueItemRecord | null): item is QueueItemRecord => !!item)

  res.json({
    ok: true,
    count: updated.length,
    items: updated.map(serializeQueueItemSummary),
  })
}

router.post('/queue/remediate-many', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  bulkRequeue(req, res, 'remediate')
})

router.post('/queue/reanalyze-many', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  bulkRequeue(req, res, 'reanalyze')
})

router.get('/queue/items/:id/download', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  const item = getQueueItemById(readItemId(req.params.id))
  const rebuiltPath = item?.rebuilt_storage_path || item?.remediated_storage_path
  if (!item || item.client_id !== req.clientId || item.hidden || !rebuiltPath || !fs.existsSync(rebuiltPath)) {
    res.status(404).json({ error: 'Rebuilt PDF not found' })
    return
  }
  res.download(rebuiltPath, item.filename)
})

router.get('/queue/items/:id/download-original', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  const item = getQueueItemById(readItemId(req.params.id))
  const originalPath = item?.original_storage_path || item?.storage_path
  if (!item || item.client_id !== req.clientId || item.hidden || !originalPath || !fs.existsSync(originalPath)) {
    res.status(404).json({ error: 'Original PDF not found' })
    return
  }
  res.download(originalPath, item.filename)
})

router.post('/queue/download-many', requireClientSession, async (req: ClientSessionRequest, res: Response) => {
  const itemIds = Array.isArray(req.body?.itemIds) ? req.body.itemIds.filter((id: unknown) => typeof id === 'string') : []
  const items = itemIds
    .map((itemId: string) => getQueueItemById(itemId))
    .filter((item: QueueItemRecord | undefined): item is QueueItemRecord => !!item && item.client_id === req.clientId && !item.hidden)

  if (!items.length) {
    res.status(400).json({ error: 'No visible items selected for download' })
    return
  }

  await streamQueueArchive(res, items)
})

router.post('/queue/download-all', requireClientSession, async (req: ClientSessionRequest, res: Response) => {
  const items = allVisibleItemsForClient(req.clientId!)
  if (!items.length) {
    res.status(400).json({ error: 'No visible items available for download' })
    return
  }
  await streamQueueArchive(res, items)
})

export default router
