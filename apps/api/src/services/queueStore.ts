import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import db from '../db/sqlite.js'
import { BATCH_QUEUE } from '#config'
import type {
  AppliedChange,
  ConfidenceSummary,
  DocumentModel,
  DocumentModelStatus,
  ModelReviewFlag,
  SuggestedChange,
} from './documentModel.js'

export type QueueItemState =
  | 'uploading'
  | 'queued'
  | 'processing'
  | 'complete'
  | 'failed'
  | 'cancelled'

export type ReconstructionStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'manual_review_required'
  | 'failed'

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
  rebuilt_storage_path: string | null
  document_model_path: string | null
  review_assets_dir: string | null
  upload_progress: number
  processing_progress: number
  processing_stage: string | null
  processing_path: 'ai_html' | 'agent_patch'
  path_fallbacks_json: string | null
  hidden: number
  result_json: string | null
  original_result_json: string | null
  remediated_result_json: string | null
  rebuilt_result_json: string | null
  error_json: string | null
  remediation_status: ReconstructionStatus
  document_model_status: DocumentModelStatus
  remediation_error_json: string | null
  reconstruction_error_json: string | null
  page_count: number | null
  overall_score: number | null
  grade: string | null
  original_page_count: number | null
  original_overall_score: number | null
  original_grade: string | null
  remediated_page_count: number | null
  remediated_overall_score: number | null
  remediated_grade: string | null
  rebuilt_page_count: number | null
  rebuilt_overall_score: number | null
  rebuilt_grade: string | null
  applied_fixes_json: string | null
  skipped_fixes_json: string | null
  manual_review_flags_json: string | null
  ai_applied_changes_json: string | null
  ai_suggested_changes_json: string | null
  confidence_summary_json: string | null
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
  processingPath: 'ai_html' | 'agent_patch'
  pathFallbacks: string[]
  reconstructionStatus: ReconstructionStatus
  documentModelStatus: DocumentModelStatus
  pageCount: number | null
  overallScore: number | null
  grade: string | null
  result: any | null
  originalResult: any | null
  rebuiltResult: any | null
  originalScore: number | null
  originalGrade: string | null
  rebuiltScore: number | null
  rebuiltGrade: string | null
  error: any | null
  reconstructionError: any | null
  documentModel: DocumentModel | null
  aiAppliedChanges: AppliedChange[]
  aiSuggestedChanges: SuggestedChange[]
  confidenceSummary: ConfidenceSummary | null
  manualReviewFlags: ModelReviewFlag[]
  createdAt: string
  updatedAt: string
  uploadStartedAt: string | null
  uploadCompletedAt: string | null
  processingStartedAt: string | null
  completedAt: string | null
  expiresAt: string
  canRetry: boolean
  canCancel: boolean
  canDownloadOriginal: boolean
  canDownloadRebuilt: boolean
}

export interface QueueItemSummary {
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
  processingPath: 'ai_html' | 'agent_patch'
  pathFallbacks: string[]
  reconstructionStatus: ReconstructionStatus
  documentModelStatus: DocumentModelStatus
  pageCount: number | null
  overallScore: number | null
  grade: string | null
  originalScore: number | null
  originalGrade: string | null
  rebuiltScore: number | null
  rebuiltGrade: string | null
  error: any | null
  reconstructionError: any | null
  createdAt: string
  updatedAt: string
  uploadStartedAt: string | null
  uploadCompletedAt: string | null
  processingStartedAt: string | null
  completedAt: string | null
  expiresAt: string
  canRetry: boolean
  canCancel: boolean
  canDownloadOriginal: boolean
  canDownloadRebuilt: boolean
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(moduleDir, '..', '..')
const DATA_ROOT = path.join(projectRoot, 'data')
const STORAGE_ROOT = process.env.QUEUE_STORAGE_DIR
  ? path.resolve(projectRoot, process.env.QUEUE_STORAGE_DIR)
  : path.join(DATA_ROOT, 'queue-storage')
const ORIGINAL_ROOT = path.join(STORAGE_ROOT, 'originals')
const REBUILT_ROOT = path.join(STORAGE_ROOT, 'rebuilt')
const MODEL_ROOT = path.join(STORAGE_ROOT, 'models')
const REVIEW_ROOT = path.join(STORAGE_ROOT, 'review-assets')
const STAGING_ROOT = path.join(STORAGE_ROOT, 'staging')

for (const dir of [STORAGE_ROOT, ORIGINAL_ROOT, REBUILT_ROOT, MODEL_ROOT, REVIEW_ROOT, STAGING_ROOT]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function readDocumentModel(modelPath: string | null | undefined): DocumentModel | null {
  if (!modelPath || !fs.existsSync(modelPath)) return null
  try {
    return JSON.parse(fs.readFileSync(modelPath, 'utf8')) as DocumentModel
  } catch {
    return null
  }
}

export function getQueueStorageRoots() {
  return {
    storageRoot: STORAGE_ROOT,
    originalRoot: ORIGINAL_ROOT,
    rebuiltRoot: REBUILT_ROOT,
    modelRoot: MODEL_ROOT,
    reviewRoot: REVIEW_ROOT,
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

export function serializeQueueItemSummary(row: QueueItemRecord): QueueItemSummary {
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
    processingPath: (row.processing_path as 'ai_html' | 'agent_patch') || 'agent_patch',
    pathFallbacks: parseJson<string[]>(row.path_fallbacks_json, []),
    reconstructionStatus: row.remediation_status,
    documentModelStatus: row.document_model_status,
    pageCount: row.page_count,
    overallScore: row.overall_score,
    grade: row.grade,
    originalScore: row.original_overall_score,
    originalGrade: row.original_grade,
    rebuiltScore: row.rebuilt_overall_score ?? row.remediated_overall_score,
    rebuiltGrade: row.rebuilt_grade ?? row.remediated_grade,
    error: parseJson<any | null>(row.error_json, null),
    reconstructionError: parseJson<any | null>(row.reconstruction_error_json || row.remediation_error_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    uploadStartedAt: row.upload_started_at,
    uploadCompletedAt: row.upload_completed_at,
    processingStartedAt: row.processing_started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    canRetry: row.state === 'failed' && !!row.original_storage_path,
    canCancel: row.state === 'uploading' || row.state === 'queued' || row.state === 'processing',
    canDownloadOriginal: !!row.original_storage_path,
    canDownloadRebuilt: !!(row.rebuilt_storage_path || row.remediated_storage_path),
  }
}

export function serializeQueueItemDetail(row: QueueItemRecord): QueueItem {
  const documentModel = readDocumentModel(row.document_model_path)
  return {
    ...serializeQueueItemSummary(row),
    result: parseJson<any | null>(row.result_json, null),
    originalResult: parseJson<any | null>(row.original_result_json, null),
    rebuiltResult: parseJson<any | null>(row.rebuilt_result_json || row.remediated_result_json, null),
    documentModel,
    aiAppliedChanges: parseJson<AppliedChange[]>(row.ai_applied_changes_json, documentModel?.aiAppliedChanges || []),
    aiSuggestedChanges: parseJson<SuggestedChange[]>(row.ai_suggested_changes_json, documentModel?.aiSuggestedChanges || []),
    confidenceSummary: parseJson<ConfidenceSummary | null>(row.confidence_summary_json, documentModel?.confidenceSummary || null),
    manualReviewFlags: parseJson<ModelReviewFlag[]>(row.manual_review_flags_json, documentModel?.manualReviewFlags || []),
  }
}

export const serializeQueueItem = serializeQueueItemDetail

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
      processing_path, path_fallbacks_json,
      remediation_status, document_model_status, created_at, updated_at, upload_started_at, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'uploading', 0, 0, 'Waiting for upload', 0, 'agent_patch', '[]', 'pending', 'pending', ?, ?, ?, ?)
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

export function updateQueueItem(id: string, patch: Partial<QueueItemRecord>): QueueItemRecord {
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
      rebuilt_storage_path = ?,
      document_model_path = ?,
      review_assets_dir = ?,
      upload_progress = ?,
      processing_progress = ?,
      processing_stage = ?,
      processing_path = ?,
      path_fallbacks_json = ?,
      hidden = ?,
      result_json = ?,
      original_result_json = ?,
      remediated_result_json = ?,
      rebuilt_result_json = ?,
      error_json = ?,
      remediation_status = ?,
      document_model_status = ?,
      remediation_error_json = ?,
      reconstruction_error_json = ?,
      page_count = ?,
      overall_score = ?,
      grade = ?,
      original_page_count = ?,
      original_overall_score = ?,
      original_grade = ?,
      remediated_page_count = ?,
      remediated_overall_score = ?,
      remediated_grade = ?,
      rebuilt_page_count = ?,
      rebuilt_overall_score = ?,
      rebuilt_grade = ?,
      applied_fixes_json = ?,
      skipped_fixes_json = ?,
      manual_review_flags_json = ?,
      ai_applied_changes_json = ?,
      ai_suggested_changes_json = ?,
      confidence_summary_json = ?,
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
    next.rebuilt_storage_path,
    next.document_model_path,
    next.review_assets_dir,
    next.upload_progress,
    next.processing_progress,
    next.processing_stage,
    next.processing_path,
    next.path_fallbacks_json,
    next.hidden,
    next.result_json,
    next.original_result_json,
    next.remediated_result_json,
    next.rebuilt_result_json,
    next.error_json,
    next.remediation_status,
    next.document_model_status,
    next.remediation_error_json,
    next.reconstruction_error_json,
    next.page_count,
    next.overall_score,
    next.grade,
    next.original_page_count,
    next.original_overall_score,
    next.original_grade,
    next.remediated_page_count,
    next.remediated_overall_score,
    next.remediated_grade,
    next.rebuilt_page_count,
    next.rebuilt_overall_score,
    next.rebuilt_grade,
    next.applied_fixes_json,
    next.skipped_fixes_json,
    next.manual_review_flags_json,
    next.ai_applied_changes_json,
    next.ai_suggested_changes_json,
    next.confidence_summary_json,
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

export function listActiveQueueItems(clientId: string): QueueItemSummary[] {
  const rows = db.prepare(`
    SELECT * FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state IN ('uploading', 'queued', 'processing', 'failed')
    ORDER BY created_at DESC
  `).all(clientId) as QueueItemRecord[]
  return rows.map(serializeQueueItemSummary)
}

export function listHistoryQueueItems(clientId: string, page: number, limit: number): { items: QueueItemSummary[]; total: number } {
  const offset = Math.max(0, (page - 1) * limit)
  const total = (db.prepare(`
    SELECT COUNT(*) as count FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state = 'complete'
  `).get(clientId) as any).count as number
  const rows = db.prepare(`
    SELECT * FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state = 'complete'
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(clientId, limit, offset) as QueueItemRecord[]
  return { items: rows.map(serializeQueueItemSummary), total }
}

export function listSelectableQueueItemIds(clientId: string, scope: 'active' | 'complete'): string[] {
  if (scope === 'active') {
    return (db.prepare(`
      SELECT id FROM queue_items
      WHERE client_id = ? AND hidden = 0 AND state IN ('uploading', 'queued', 'processing', 'failed')
      ORDER BY created_at DESC
    `).all(clientId) as Array<{ id: string }>).map(row => row.id)
  }

  return (db.prepare(`
    SELECT id FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state = 'complete'
    ORDER BY updated_at DESC
  `).all(clientId) as Array<{ id: string }>).map(row => row.id)
}

export function getQueueCounts(clientId: string): { active: number; complete: number } {
  const active = (db.prepare(`
    SELECT COUNT(*) as count FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state IN ('uploading', 'queued', 'processing', 'failed')
  `).get(clientId) as any).count as number

  const complete = (db.prepare(`
    SELECT COUNT(*) as count FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state = 'complete'
  `).get(clientId) as any).count as number

  return { active, complete }
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

export function listInterruptedProcessingItems(): QueueItemRecord[] {
  return db.prepare(`
    SELECT * FROM queue_items
    WHERE hidden = 0 AND state = 'processing'
    ORDER BY updated_at DESC
  `).all() as QueueItemRecord[]
}

export function markQueueItemHidden(id: string): QueueItemRecord {
  return updateQueueItem(id, { hidden: 1 })
}

export function deleteQueueItemPermanently(id: string): void {
  const row = getQueueItemById(id)
  if (!row) return

  removeDiskFile(row.storage_path)
  removeDiskFile(row.original_storage_path)
  removeDiskFile(row.remediated_storage_path)
  removeDiskFile(row.rebuilt_storage_path)
  removeDiskFile(row.document_model_path)
  removeDiskDir(row.review_assets_dir)

  db.prepare('DELETE FROM queue_items WHERE id = ?').run(id)
}

export function sanitizeBasename(filename: string): string {
  const base = path.basename(filename || 'unnamed.pdf').trim()
  return base || 'unnamed.pdf'
}

export function queueItemDiskPath(id: string, filename: string): string {
  const ext = path.extname(filename).toLowerCase() === '.pdf' ? '.pdf' : '.pdf'
  return path.join(ORIGINAL_ROOT, `${id}${ext}`)
}

export function queueItemRebuiltDiskPath(id: string, filename: string): string {
  const ext = path.extname(filename).toLowerCase() === '.pdf' ? '.pdf' : '.pdf'
  return path.join(REBUILT_ROOT, `${id}${ext}`)
}

export function queueItemDocumentModelPath(id: string): string {
  return path.join(MODEL_ROOT, `${id}.json`)
}

export function queueItemReviewAssetsDir(id: string): string {
  return path.join(REVIEW_ROOT, id)
}

export function removeDiskFile(filePath: string | null | undefined): void {
  if (!filePath) return
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {}
}

export function removeDiskDir(dirPath: string | null | undefined): void {
  if (!dirPath) return
  try {
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true })
  } catch {}
}

export function cleanupExpiredQueueItems(): void {
  const expiredRows = db.prepare(`
    SELECT id, storage_path, original_storage_path, remediated_storage_path, rebuilt_storage_path, document_model_path, review_assets_dir FROM queue_items
    WHERE expires_at < datetime('now')
  `).all() as Array<{
    id: string
    storage_path: string | null
    original_storage_path: string | null
    remediated_storage_path: string | null
    rebuilt_storage_path: string | null
    document_model_path: string | null
    review_assets_dir: string | null
  }>

  for (const row of expiredRows) {
    removeDiskFile(row.storage_path)
    removeDiskFile(row.original_storage_path)
    removeDiskFile(row.remediated_storage_path)
    removeDiskFile(row.rebuilt_storage_path)
    removeDiskFile(row.document_model_path)
    removeDiskDir(row.review_assets_dir)
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
