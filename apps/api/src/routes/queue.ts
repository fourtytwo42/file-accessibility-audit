import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Router, type IRouter, type Response } from 'express'
import multer from 'multer'
import { BATCH_QUEUE } from '#config'
import { bootstrapClientSession, ClientSessionRequest, requireClientSession } from '../middleware/clientSession.js'
import { streamQueueArchive } from '../services/archiveService.js'
import { emitQueueItemDeleted, emitQueueItemUpsert, registerQueueSse } from '../services/queueEvents.js'
import { cancelQueueItem, queueItemForProcessing, removeQueueItemFromStreams, requeueItem, scheduleClient } from '../services/queueManager.js'
import {
  cleanupExpiredQueueItems,
  createQueueItem,
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
import { beginClientUpload } from '../services/uploadActivity.js'

const router: IRouter = Router()
const { stagingRoot } = getQueueStorageRoots()

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

router.get('/queue/items/:id', requireClientSession, (req: ClientSessionRequest, res: Response) => {
  const item = getQueueItemById(readItemId(req.params.id))
  if (!item || item.client_id !== req.clientId || item.hidden) {
    res.status(404).json({ error: 'Queue item not found' })
    return
  }
  res.json({ item: serializeQueueItemDetail(item) })
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
