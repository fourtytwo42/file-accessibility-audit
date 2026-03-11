import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import db from '../db/sqlite.js'
import { BATCH_QUEUE } from '#config'

export type QueueItemState =
  | 'uploading'
  | 'queued'
  | 'processing'
  | 'complete'
  | 'failed'
  | 'cancelled'

export type RemediationStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'manual_review_required'
  | 'failed'

export interface ManualReviewFlag {
  code: string
  label: string
  severity: 'warning' | 'critical'
  details: string
}

export interface QueueItemRecord {
  id: string
  client_id: string
  filename: string
  md5: string
  size_bytes: number
  mime_type: string | null
  state: QueueItemState
  storage_path: string | null
  original_storage_path: string | null
  remediated_storage_path: string | null
  upload_progress: number
  processing_progress: number
  processing_stage: string | null
  hidden: number
  result_json: string | null
  original_result_json: string | null
  remediated_result_json: string | null
  error_json: string | null
  remediation_status: RemediationStatus
  remediation_error_json: string | null
  page_count: number | null
  overall_score: number | null
  grade: string | null
  original_page_count: number | null
  original_overall_score: number | null
  original_grade: string | null
  remediated_page_count: number | null
  remediated_overall_score: number | null
  remediated_grade: string | null
  applied_fixes_json: string | null
  skipped_fixes_json: string | null
  manual_review_flags_json: string | null
  created_at: string
  updated_at: string
  upload_started_at: string | null
  upload_completed_at: string | null
  processing_started_at: string | null
  completed_at: string | null
  expires_at: string
}

export interface QueueItem {
  id: string
  clientId: string
  filename: string
  md5: string
  sizeBytes: number
  mimeType: string | null
  state: QueueItemState
  uploadProgress: number
  processingProgress: number
  processingStage: string | null
  remediationStatus: RemediationStatus
  pageCount: number | null
  overallScore: number | null
  grade: string | null
  result: any | null
  originalResult: any | null
  remediatedResult: any | null
  originalScore: number | null
  originalGrade: string | null
  remediatedScore: number | null
  remediatedGrade: string | null
  error: any | null
  remediationError: any | null
  appliedFixes: string[]
  skippedFixes: string[]
  manualReviewFlags: ManualReviewFlag[]
  createdAt: string
  updatedAt: string
  uploadStartedAt: string | null
  uploadCompletedAt: string | null
  processingStartedAt: string | null
  completedAt: string | null
  expiresAt: string
  canRetry: boolean
  canCancel: boolean
  canDownload: boolean
  canDownloadRemediated: boolean
}

const DATA_ROOT = path.resolve(process.cwd(), 'apps/api/data')
const STORAGE_ROOT = process.env.QUEUE_STORAGE_DIR
  ? path.resolve(process.env.QUEUE_STORAGE_DIR)
  : path.join(DATA_ROOT, 'queue-storage')
const ORIGINAL_ROOT = path.join(STORAGE_ROOT, 'originals')
const REMEDIATED_ROOT = path.join(STORAGE_ROOT, 'remediated')
const STAGING_ROOT = path.join(STORAGE_ROOT, 'staging')

for (const dir of [STORAGE_ROOT, ORIGINAL_ROOT, REMEDIATED_ROOT, STAGING_ROOT]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function getQueueStorageRoots() {
  return {
    storageRoot: STORAGE_ROOT,
    originalRoot: ORIGINAL_ROOT,
    remediatedRoot: REMEDIATED_ROOT,
    stagingRoot: STAGING_ROOT,
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

export function queueExpiryIso(): string {
  return addDays(new Date(), BATCH_QUEUE.RETENTION_DAYS).toISOString()
}

export function sessionExpiryIso(): string {
  return addDays(new Date(), BATCH_QUEUE.SESSION_DAYS).toISOString()
}

export function serializeQueueItem(row: QueueItemRecord): QueueItem {
  return {
    id: row.id,
    clientId: row.client_id,
    filename: row.filename,
    md5: row.md5,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    state: row.state,
    uploadProgress: row.upload_progress,
    processingProgress: row.processing_progress,
    processingStage: row.processing_stage,
    remediationStatus: row.remediation_status,
    pageCount: row.page_count,
    overallScore: row.overall_score,
    grade: row.grade,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    originalResult: row.original_result_json ? JSON.parse(row.original_result_json) : null,
    remediatedResult: row.remediated_result_json ? JSON.parse(row.remediated_result_json) : null,
    originalScore: row.original_overall_score,
    originalGrade: row.original_grade,
    remediatedScore: row.remediated_overall_score,
    remediatedGrade: row.remediated_grade,
    error: row.error_json ? JSON.parse(row.error_json) : null,
    remediationError: row.remediation_error_json ? JSON.parse(row.remediation_error_json) : null,
    appliedFixes: row.applied_fixes_json ? JSON.parse(row.applied_fixes_json) : [],
    skippedFixes: row.skipped_fixes_json ? JSON.parse(row.skipped_fixes_json) : [],
    manualReviewFlags: row.manual_review_flags_json ? JSON.parse(row.manual_review_flags_json) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    uploadStartedAt: row.upload_started_at,
    uploadCompletedAt: row.upload_completed_at,
    processingStartedAt: row.processing_started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    canRetry: row.state === 'failed' && !!row.original_storage_path,
    canCancel: row.state === 'uploading' || row.state === 'queued' || row.state === 'processing',
    canDownload: !!row.remediated_storage_path,
    canDownloadRemediated: !!row.remediated_storage_path,
  }
}

export function createClient(clientId: string): void {
  db.prepare(`
    INSERT INTO browser_clients (client_id, last_seen_at)
    VALUES (?, ?)
    ON CONFLICT(client_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).run(clientId, nowIso())
}

export function touchClient(clientId: string): void {
  db.prepare('UPDATE browser_clients SET last_seen_at = ? WHERE client_id = ?').run(nowIso(), clientId)
}

export function createBrowserSession(clientId: string): { id: string; expiresAt: string } {
  createClient(clientId)
  const id = crypto.randomUUID()
  const expiresAt = sessionExpiryIso()
  db.prepare('INSERT INTO browser_sessions (id, client_id, expires_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run(id, clientId, expiresAt, nowIso())
  return { id, expiresAt }
}

export function getBrowserSession(sessionId: string): { id: string; client_id: string; expires_at: string } | undefined {
  return db.prepare('SELECT id, client_id, expires_at FROM browser_sessions WHERE id = ?').get(sessionId) as any
}

export function touchBrowserSession(sessionId: string, expiresAt?: string): void {
  if (expiresAt) {
    db.prepare('UPDATE browser_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(nowIso(), expiresAt, sessionId)
    return
  }
  db.prepare('UPDATE browser_sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), sessionId)
}

export function deleteExpiredSessions(): void {
  db.prepare("DELETE FROM browser_sessions WHERE expires_at < datetime('now')").run()
}

export function getQueueItemById(id: string): QueueItemRecord | undefined {
  return db.prepare('SELECT * FROM queue_items WHERE id = ?').get(id) as QueueItemRecord | undefined
}

export function getQueueItemByMd5(clientId: string, md5: string): QueueItemRecord | undefined {
  return db.prepare('SELECT * FROM queue_items WHERE client_id = ? AND md5 = ?').get(clientId, md5) as QueueItemRecord | undefined
}

export function createQueueItem(input: {
  clientId: string
  filename: string
  md5: string
  sizeBytes: number
  mimeType?: string | null
}): QueueItemRecord {
  const id = crypto.randomUUID()
  const timestamp = nowIso()
  const expiresAt = queueExpiryIso()
  db.prepare(`
    INSERT INTO queue_items (
      id, client_id, filename, md5, size_bytes, mime_type, state,
      upload_progress, processing_progress, processing_stage, hidden,
      remediation_status, created_at, updated_at, upload_started_at, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'uploading', 0, 0, 'Waiting for upload', 0, 'pending', ?, ?, ?, ?)
  `).run(id, input.clientId, input.filename, input.md5, input.sizeBytes, input.mimeType ?? null, timestamp, timestamp, timestamp, expiresAt)
  return getQueueItemById(id)!
}

export function restoreHiddenQueueItem(id: string): QueueItemRecord {
  db.prepare(`
    UPDATE queue_items
    SET hidden = 0, updated_at = ?, expires_at = ?
    WHERE id = ?
  `).run(nowIso(), queueExpiryIso(), id)
  return getQueueItemById(id)!
}

export function updateQueueItem(id: string, patch: Partial<QueueItemRecord> & {
  result_json?: string | null
  original_result_json?: string | null
  remediated_result_json?: string | null
  error_json?: string | null
  remediation_error_json?: string | null
  applied_fixes_json?: string | null
  skipped_fixes_json?: string | null
  manual_review_flags_json?: string | null
}): QueueItemRecord {
  const row = getQueueItemById(id)
  if (!row) throw new Error(`Queue item not found: ${id}`)
  const next = {
    ...row,
    ...patch,
    updated_at: nowIso(),
  }
  db.prepare(`
    UPDATE queue_items
    SET
      filename = ?,
      md5 = ?,
      size_bytes = ?,
      mime_type = ?,
      state = ?,
      storage_path = ?,
      original_storage_path = ?,
      remediated_storage_path = ?,
      upload_progress = ?,
      processing_progress = ?,
      processing_stage = ?,
      hidden = ?,
      result_json = ?,
      original_result_json = ?,
      remediated_result_json = ?,
      error_json = ?,
      remediation_status = ?,
      remediation_error_json = ?,
      page_count = ?,
      overall_score = ?,
      grade = ?,
      original_page_count = ?,
      original_overall_score = ?,
      original_grade = ?,
      remediated_page_count = ?,
      remediated_overall_score = ?,
      remediated_grade = ?,
      applied_fixes_json = ?,
      skipped_fixes_json = ?,
      manual_review_flags_json = ?,
      updated_at = ?,
      upload_started_at = ?,
      upload_completed_at = ?,
      processing_started_at = ?,
      completed_at = ?,
      expires_at = ?
    WHERE id = ?
  `).run(
    next.filename,
    next.md5,
    next.size_bytes,
    next.mime_type,
    next.state,
    next.storage_path,
    next.original_storage_path,
    next.remediated_storage_path,
    next.upload_progress,
    next.processing_progress,
    next.processing_stage,
    next.hidden,
    next.result_json,
    next.original_result_json,
    next.remediated_result_json,
    next.error_json,
    next.remediation_status,
    next.remediation_error_json,
    next.page_count,
    next.overall_score,
    next.grade,
    next.original_page_count,
    next.original_overall_score,
    next.original_grade,
    next.remediated_page_count,
    next.remediated_overall_score,
    next.remediated_grade,
    next.applied_fixes_json,
    next.skipped_fixes_json,
    next.manual_review_flags_json,
    next.updated_at,
    next.upload_started_at,
    next.upload_completed_at,
    next.processing_started_at,
    next.completed_at,
    next.expires_at,
    id,
  )
  return getQueueItemById(id)!
}

export function listActiveQueueItems(clientId: string): QueueItem[] {
  const rows = db.prepare(`
    SELECT * FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state IN ('uploading', 'queued', 'processing')
    ORDER BY created_at DESC
  `).all(clientId) as QueueItemRecord[]
  return rows.map(serializeQueueItem)
}

export function listHistoryQueueItems(clientId: string, page: number, limit: number): { items: QueueItem[]; total: number } {
  const offset = Math.max(0, (page - 1) * limit)
  const total = (db.prepare(`
    SELECT COUNT(*) as count FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state IN ('complete', 'failed', 'cancelled')
  `).get(clientId) as any).count as number
  const rows = db.prepare(`
    SELECT * FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state IN ('complete', 'failed', 'cancelled')
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(clientId, limit, offset) as QueueItemRecord[]
  return { items: rows.map(serializeQueueItem), total }
}

export function countProcessingItems(clientId: string): number {
  return (db.prepare(`
    SELECT COUNT(*) as count FROM queue_items
    WHERE client_id = ? AND state = 'processing' AND hidden = 0
  `).get(clientId) as any).count as number
}

export function nextQueuedItems(clientId: string, limit: number): QueueItemRecord[] {
  return db.prepare(`
    SELECT * FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state = 'queued' AND storage_path IS NOT NULL
    ORDER BY created_at ASC
    LIMIT ?
  `).all(clientId, limit) as QueueItemRecord[]
}

export function listProcessingItems(clientId: string): QueueItemRecord[] {
  return db.prepare(`
    SELECT * FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state = 'processing'
  `).all(clientId) as QueueItemRecord[]
}

export function markQueueItemHidden(id: string): QueueItemRecord {
  return updateQueueItem(id, { hidden: 1 })
}

export function sanitizeBasename(filename: string): string {
  const base = path.basename(filename || 'unnamed.pdf').trim()
  return base || 'unnamed.pdf'
}

export function queueItemDiskPath(id: string, filename: string): string {
  const ext = path.extname(filename).toLowerCase() === '.pdf' ? '.pdf' : '.pdf'
  return path.join(ORIGINAL_ROOT, `${id}${ext}`)
}

export function queueItemRemediatedDiskPath(id: string, filename: string): string {
  const ext = path.extname(filename).toLowerCase() === '.pdf' ? '.pdf' : '.pdf'
  return path.join(REMEDIATED_ROOT, `${id}${ext}`)
}

export function removeDiskFile(filePath: string | null | undefined): void {
  if (!filePath) return
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {}
}

export function cleanupExpiredQueueItems(): void {
  const expiredRows = db.prepare(`
    SELECT id, storage_path, original_storage_path, remediated_storage_path FROM queue_items
    WHERE expires_at < datetime('now')
  `).all() as Array<{
    id: string
    storage_path: string | null
    original_storage_path: string | null
    remediated_storage_path: string | null
  }>

  for (const row of expiredRows) {
    removeDiskFile(row.storage_path)
    removeDiskFile(row.original_storage_path)
    removeDiskFile(row.remediated_storage_path)
  }

  db.prepare(`DELETE FROM queue_items WHERE expires_at < datetime('now')`).run()
}

export function failStaleUploads(): void {
  const staleCutoff = new Date(Date.now() - BATCH_QUEUE.STALE_UPLOAD_MINUTES * 60 * 1000).toISOString()
  const rows = db.prepare(`
    SELECT id FROM queue_items
    WHERE state = 'uploading' AND storage_path IS NULL AND updated_at < ?
  `).all(staleCutoff) as Array<{ id: string }>

  for (const row of rows) {
    updateQueueItem(row.id, {
      state: 'failed',
      processing_stage: 'Upload interrupted',
      error_json: JSON.stringify({
        error: 'Upload interrupted before the file reached the server.',
      }),
      completed_at: nowIso(),
    })
  }
}
