import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import db from '../db/sqlite.js'
import { BATCH_QUEUE } from '#config'
import type {
  AdobeSummary,
  AppliedChange,
  ConfidenceSummary,
  DocumentModel,
  DocumentModelStatus,
  FailureMode,
  ModelReviewFlag,
  PlannerEvidenceSummary,
  SuggestedChange,
  VeraPdfSummary,
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
  adobe_summary_json: string | null
  original_adobe_summary_json: string | null
  rebuilt_adobe_summary_json: string | null
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
  standardsDetail?: QueueItemStandardsDetail | null
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
  standardsSummary?: QueueItemStandardsSummary | null
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

export interface QueueFailureModeSummary {
  key: string
  label: string
  count: number
  classification: 'deterministic' | 'semantic' | 'manual_only'
  blocking: boolean
}

export interface QueueGradeBasisSummary {
  currentGrade: string | null
  currentScore: number | null
  gradeReducedByStandards: boolean
  scoreCappedByStandards: boolean
}

export interface QueueVeraPdfCompactSummary {
  status: VeraPdfSummary['status'] | null
  failedChecks: number | null
}

export interface QueueAdobeCompactSummary {
  status: AdobeSummary['status'] | null
  issueCount: number | null
  summary: string | null
}

export interface QueuePlannerOverview {
  autoRunnableOpportunityCount: number
  blockedOpportunityCount: number
  deterministicIssueCount: number
  semanticIssueCount: number
  manualOnlyIssueCount: number
}

export interface QueueItemStandardsSummary {
  gradeBasis: QueueGradeBasisSummary
  veraPdf: QueueVeraPdfCompactSummary
  adobe?: QueueAdobeCompactSummary
  failureOverview: {
    topFailureModes: QueueFailureModeSummary[]
  }
  plannerOverview: QueuePlannerOverview
}

export interface QueueVeraPdfDetailSummary {
  status: VeraPdfSummary['status'] | null
  failedChecks: number | null
  profile: string | null
  flavour: string | null
  topFailures: string[]
}

export interface QueueItemStandardsDetail {
  gradeBasis: {
    currentScore: number | null
    currentGrade: string | null
    originalScore: number | null
    originalGrade: string | null
    rebuiltScore: number | null
    rebuiltGrade: string | null
    gradeReducedByStandards: boolean
    scoreCappedByStandards: boolean
    summaryText: string
  }
  veraPdf: {
    current: QueueVeraPdfDetailSummary
    original: QueueVeraPdfDetailSummary
    rebuilt: QueueVeraPdfDetailSummary
  }
  adobe?: {
    current: AdobeSummary | null
    original: AdobeSummary | null
    rebuilt: AdobeSummary | null
  }
  failureModes: FailureMode[]
  plannerEvidence: PlannerEvidenceSummary | null
  remediationSummary: QueuePlannerOverview & {
    manualReviewRequired: boolean
  }
}

export interface QueueItemVersion {
  key: 'original' | 'rebuilt' | 'current'
  label: string
  createdAt: string | null
  score: number | null
  grade: string | null
  veraPdfStatus: VeraPdfSummary['status'] | null
  veraPdfFailedChecks: number | null
  downloadUrl: string | null
  kind: 'input' | 'output'
}

export const INTERNAL_QUEUE_MARKERS = {
  REANALYZE_ONLY: '__reanalyze_only__',
} as const

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

function normalizeQueueFilename(filename: string): string {
  return filename.trim().toLowerCase()
}

function isTransientQueuePlaceholder(row: QueueItemRecord): boolean {
  return !row.storage_path
    && !row.original_storage_path
    && !row.remediated_storage_path
    && !row.rebuilt_storage_path
    && !row.document_model_path
    && !row.review_assets_dir
}

function transientDuplicatePriority(row: QueueItemRecord): number {
  switch (row.state) {
    case 'uploading':
      return 0
    case 'queued':
      return 1
    case 'processing':
      return 2
    case 'failed':
      return 3
    case 'cancelled':
      return 4
    default:
      return 5
  }
}

function collapseTransientFilenameDuplicates(rows: QueueItemRecord[]): QueueItemRecord[] {
  const kept = new Map<string, QueueItemRecord>()
  const passthrough: QueueItemRecord[] = []

  for (const row of rows) {
    if (!isTransientQueuePlaceholder(row)) {
      passthrough.push(row)
      continue
    }

    const key = normalizeQueueFilename(row.filename)
    const existing = kept.get(key)
    if (!existing) {
      kept.set(key, row)
      continue
    }

    const priorityDiff = transientDuplicatePriority(row) - transientDuplicatePriority(existing)
    if (priorityDiff < 0) {
      kept.set(key, row)
      continue
    }
    if (priorityDiff > 0) continue

    const updatedDiff = new Date(row.updated_at).getTime() - new Date(existing.updated_at).getTime()
    if (updatedDiff > 0) {
      kept.set(key, row)
      continue
    }
    if (updatedDiff < 0) continue

    if (new Date(row.created_at).getTime() > new Date(existing.created_at).getTime()) {
      kept.set(key, row)
    }
  }

  return [...passthrough, ...kept.values()].sort((a, b) => {
    const createdDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    if (createdDiff !== 0) return createdDiff
    return a.id.localeCompare(b.id)
  })
}

function parseResult(rowValue: string | null | undefined): any | null {
  return parseJson<any | null>(rowValue, null)
}

function parsePublicPathFallbacks(rowValue: string | null | undefined): string[] {
  return parseJson<string[]>(rowValue, []).filter(value => !Object.values(INTERNAL_QUEUE_MARKERS).includes(value as any))
}

function extractVeraPdfSummary(candidate: any): QueueVeraPdfDetailSummary {
  const verapdf = candidate?.verapdf
  if (!verapdf || typeof verapdf !== 'object') {
    return {
      status: null,
      failedChecks: null,
      profile: null,
      flavour: null,
      topFailures: [],
    }
  }

  const topFailures = Array.isArray(verapdf.topFailures)
    ? verapdf.topFailures.filter((entry: unknown): entry is string => typeof entry === 'string')
    : Array.isArray(verapdf.failures)
      ? verapdf.failures
        .map((failure: any) => typeof failure?.message === 'string' ? failure.message : null)
        .filter((entry: string | null): entry is string => !!entry)
        .slice(0, 5)
      : []

  return {
    status: typeof verapdf.status === 'string' ? verapdf.status as VeraPdfSummary['status'] : null,
    failedChecks: typeof verapdf.failedChecks === 'number' ? verapdf.failedChecks : null,
    profile: typeof verapdf.profile === 'string' ? verapdf.profile : null,
    flavour: typeof verapdf.flavour === 'string' ? verapdf.flavour : null,
    topFailures,
  }
}

function detailSummaryFromModel(candidate: VeraPdfSummary | null | undefined): QueueVeraPdfDetailSummary {
  if (!candidate) {
    return {
      status: null,
      failedChecks: null,
      profile: null,
      flavour: null,
      topFailures: [],
    }
  }

  return {
    status: candidate.status,
    failedChecks: candidate.failedChecks,
    profile: candidate.profile,
    flavour: candidate.flavour,
    topFailures: candidate.topFailures || [],
  }
}

function extractAdobeSummary(candidate: any): AdobeSummary | null {
  const adobe = candidate?.adobe
  if (!adobe || typeof adobe !== 'object') return null
  return {
    status: typeof adobe.status === 'string' ? adobe.status as AdobeSummary['status'] : 'error',
    summary: typeof adobe.summary === 'string' ? adobe.summary : 'Adobe summary unavailable.',
    passed: typeof adobe.passed === 'boolean' ? adobe.passed : null,
    issueCount: typeof adobe.issueCount === 'number' ? adobe.issueCount : 0,
    findings: Array.isArray(adobe.findings) ? adobe.findings : [],
    warnings: Array.isArray(adobe.warnings) ? adobe.warnings : [],
    artifacts: adobe.artifacts && typeof adobe.artifacts === 'object' ? adobe.artifacts : null,
  }
}

function compactFailureModes(failureModes: FailureMode[] | null | undefined, limit: number): QueueFailureModeSummary[] {
  if (!failureModes?.length) return []
  return [...failureModes]
    .sort((a, b) => {
      const blockingDiff = Number(b.blocking) - Number(a.blocking)
      if (blockingDiff !== 0) return blockingDiff
      const countDiff = b.count - a.count
      if (countDiff !== 0) return countDiff
      return a.label.localeCompare(b.label)
    })
    .slice(0, limit)
    .map(mode => ({
      key: mode.key,
      label: mode.label,
      count: mode.count,
      classification: mode.classification,
      blocking: mode.blocking,
    }))
}

function gradeReducedByStandards(score: number | null, grade: string | null, verapdfStatus: VeraPdfSummary['status'] | null): boolean {
  return typeof score === 'number'
    && score >= 90
    && grade !== 'A'
    && !!verapdfStatus
    && verapdfStatus !== 'passed'
}

function scoreCappedByStandards(score: number | null, verapdfStatus: VeraPdfSummary['status'] | null): boolean {
  return score === 99 && !!verapdfStatus && verapdfStatus !== 'passed'
}

function plannerOverviewFromModel(documentModel: DocumentModel | null | undefined): QueuePlannerOverview {
  const summary = documentModel?.failureProfile?.summary
  return {
    autoRunnableOpportunityCount: summary?.autoRunnableOpportunityCount ?? 0,
    blockedOpportunityCount: summary?.blockedOpportunityCount ?? 0,
    deterministicIssueCount: summary?.deterministicIssueCount ?? 0,
    semanticIssueCount: summary?.semanticIssueCount ?? 0,
    manualOnlyIssueCount: summary?.manualOnlyIssueCount ?? 0,
  }
}

function synthesizeSummaryText(input: {
  grade: string | null
  score: number | null
  verapdfStatus: VeraPdfSummary['status'] | null
  topFailureMode: QueueFailureModeSummary | null
}): string {
  const parts: string[] = []
  if (input.grade || typeof input.score === 'number') {
    const scoreText = typeof input.score === 'number' ? `${input.score}/100` : 'unknown score'
    const gradeText = input.grade ? `grade ${input.grade}` : 'no grade'
    parts.push(`Current result is ${gradeText} at ${scoreText}.`)
  }
  if (input.verapdfStatus) {
    parts.push(input.verapdfStatus === 'passed'
      ? 'veraPDF passed.'
      : `veraPDF status is ${input.verapdfStatus}.`)
  }
  if (input.topFailureMode) {
    parts.push(`Top remaining issue: ${input.topFailureMode.label}.`)
  }
  return parts.join(' ').trim() || 'No standards summary is available yet.'
}

function buildStandardsSummary(row: QueueItemRecord): QueueItemStandardsSummary {
  const result = parseResult(row.result_json)
  const veraPdf = extractVeraPdfSummary(result)
  const adobe = parseJson<AdobeSummary | null>(row.adobe_summary_json, extractAdobeSummary(result))
  return {
    gradeBasis: {
      currentGrade: row.grade,
      currentScore: row.overall_score,
      gradeReducedByStandards: gradeReducedByStandards(row.overall_score, row.grade, veraPdf.status),
      scoreCappedByStandards: scoreCappedByStandards(row.overall_score, veraPdf.status),
    },
    veraPdf: {
      status: veraPdf.status,
      failedChecks: veraPdf.failedChecks,
    },
    adobe: adobe ? {
      status: adobe.status,
      issueCount: adobe.issueCount,
      summary: adobe.summary,
    } : undefined,
    failureOverview: {
      topFailureModes: [],
    },
    plannerOverview: {
      autoRunnableOpportunityCount: 0,
      blockedOpportunityCount: 0,
      deterministicIssueCount: 0,
      semanticIssueCount: 0,
      manualOnlyIssueCount: 0,
    },
  }
}

function buildStandardsDetail(row: QueueItemRecord, documentModel: DocumentModel | null): QueueItemStandardsDetail {
  const currentResult = parseResult(row.result_json)
  const originalResult = parseResult(row.original_result_json)
  const rebuiltResult = parseResult(row.rebuilt_result_json || row.remediated_result_json)
  const currentVeraPdf = documentModel?.finalAudit?.veraPdf
    ? detailSummaryFromModel(documentModel.finalAudit.veraPdf)
    : extractVeraPdfSummary(currentResult)
  const originalVeraPdf = documentModel?.originalVeraPdf
    ? detailSummaryFromModel(documentModel.originalVeraPdf)
    : extractVeraPdfSummary(originalResult)
  const rebuiltVeraPdf = documentModel?.remediatedVeraPdf
    ? detailSummaryFromModel(documentModel.remediatedVeraPdf)
    : extractVeraPdfSummary(rebuiltResult)
  const topFailureModes = compactFailureModes(documentModel?.failureProfile?.failureModes, 1)
  const overview = plannerOverviewFromModel(documentModel)
  const currentAdobe = parseJson<AdobeSummary | null>(row.adobe_summary_json, documentModel?.finalAudit?.adobe || extractAdobeSummary(currentResult))
  const originalAdobe = parseJson<AdobeSummary | null>(row.original_adobe_summary_json, documentModel?.originalAdobe || extractAdobeSummary(originalResult))
  const rebuiltAdobe = parseJson<AdobeSummary | null>(row.rebuilt_adobe_summary_json, documentModel?.remediatedAdobe || extractAdobeSummary(rebuiltResult))

  return {
    gradeBasis: {
      currentScore: row.overall_score,
      currentGrade: row.grade,
      originalScore: row.original_overall_score,
      originalGrade: row.original_grade,
      rebuiltScore: row.rebuilt_overall_score ?? row.remediated_overall_score,
      rebuiltGrade: row.rebuilt_grade ?? row.remediated_grade,
      gradeReducedByStandards: gradeReducedByStandards(row.overall_score, row.grade, currentVeraPdf.status),
      scoreCappedByStandards: scoreCappedByStandards(row.overall_score, currentVeraPdf.status),
      summaryText: typeof currentResult?.executiveSummary === 'string' && currentResult.executiveSummary.trim()
        ? currentResult.executiveSummary.trim()
        : synthesizeSummaryText({
          grade: row.grade,
          score: row.overall_score,
          verapdfStatus: currentVeraPdf.status,
          topFailureMode: topFailureModes[0] || null,
        }),
    },
    veraPdf: {
      current: currentVeraPdf,
      original: originalVeraPdf,
      rebuilt: rebuiltVeraPdf,
    },
    adobe: {
      current: currentAdobe,
      original: originalAdobe,
      rebuilt: rebuiltAdobe,
    },
    failureModes: documentModel?.failureProfile?.failureModes || [],
    plannerEvidence: documentModel?.plannerEvidence || null,
    remediationSummary: {
      ...overview,
      manualReviewRequired: row.remediation_status === 'manual_review_required',
    },
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
    sizeBytes: row.size_bytes ?? 0,
    mimeType: row.mime_type,
    state: row.state,
    uploadProgress: row.upload_progress ?? 0,
    processingProgress: row.processing_progress ?? 0,
    processingStage: row.processing_stage,
    processingPath: (row.processing_path === 'ai_html' || row.processing_path === 'agent_patch' ? row.processing_path : 'agent_patch'),
    pathFallbacks: parsePublicPathFallbacks(row.path_fallbacks_json),
    reconstructionStatus: row.remediation_status ?? 'pending',
    documentModelStatus: row.document_model_status ?? 'pending',
    pageCount: row.page_count,
    overallScore: row.overall_score,
    grade: row.grade,
    originalScore: row.original_overall_score,
    originalGrade: row.original_grade,
    rebuiltScore: row.rebuilt_overall_score ?? row.remediated_overall_score,
    rebuiltGrade: row.rebuilt_grade ?? row.remediated_grade,
    standardsSummary: buildStandardsSummary(row),
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
    result: parseResult(row.result_json),
    originalResult: parseResult(row.original_result_json),
    rebuiltResult: parseResult(row.rebuilt_result_json || row.remediated_result_json),
    standardsDetail: buildStandardsDetail(row, documentModel),
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

export function listQueueItemsByMd5(clientId: string, md5: string): QueueItemRecord[] {
  return db.prepare(`
    SELECT * FROM queue_items
    WHERE client_id = ? AND md5 = ?
    ORDER BY
      hidden ASC,
      CASE
        WHEN state IN ('uploading', 'queued', 'processing') THEN 0
        WHEN state = 'failed' THEN 1
        WHEN state = 'complete' THEN 2
        ELSE 3
      END ASC,
      updated_at DESC,
      created_at DESC
  `).all(clientId, md5) as QueueItemRecord[]
}

export function getQueueItemByMd5(clientId: string, md5: string): QueueItemRecord | undefined {
  return listQueueItemsByMd5(clientId, md5)[0]
}

export function listVisibleQueueItemsByFilename(clientId: string, filename: string): QueueItemRecord[] {
  return db.prepare(`
    SELECT * FROM queue_items
    WHERE client_id = ?
      AND filename = ?
      AND hidden = 0
    ORDER BY
      CASE
        WHEN state IN ('uploading', 'queued', 'processing') THEN 0
        WHEN state = 'failed' THEN 1
        WHEN state = 'complete' THEN 2
        ELSE 3
      END ASC,
      updated_at DESC,
      created_at DESC
  `).all(clientId, filename) as QueueItemRecord[]
}

export function listTransientQueueItemsByFilename(clientId: string, filename: string): QueueItemRecord[] {
  return db.prepare(`
    SELECT * FROM queue_items
    WHERE client_id = ?
      AND filename = ?
      AND storage_path IS NULL
      AND original_storage_path IS NULL
      AND remediated_storage_path IS NULL
      AND rebuilt_storage_path IS NULL
      AND document_model_path IS NULL
      AND review_assets_dir IS NULL
    ORDER BY updated_at DESC, created_at DESC
  `).all(clientId, filename) as QueueItemRecord[]
}

export function createQueueItem(input: {
  clientId: string
  filename: string
  md5?: string
  sizeBytes: number
  mimeType?: string | null
}): QueueItemRecord {
  const id = crypto.randomUUID()
  const timestamp = nowIso()
  const expiresAt = queueExpiryIso()
  const dedupeToken = /^[a-f0-9]{32}$/i.test(input.md5 || '') ? String(input.md5).toLowerCase() : crypto.randomBytes(16).toString('hex')
  db.prepare(`
    INSERT INTO queue_items (
      id, client_id, filename, md5, size_bytes, mime_type, state,
      upload_progress, processing_progress, processing_stage, hidden,
      processing_path, path_fallbacks_json,
      remediation_status, document_model_status, created_at, updated_at, upload_started_at, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'uploading', 0, 0, 'Waiting for upload', 0, 'agent_patch', '[]', 'pending', 'pending', ?, ?, ?, ?)
  `).run(id, input.clientId, input.filename, dedupeToken, input.sizeBytes, input.mimeType ?? null, timestamp, timestamp, timestamp, expiresAt)
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
      adobe_summary_json = ?,
      original_adobe_summary_json = ?,
      rebuilt_adobe_summary_json = ?,
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
    next.adobe_summary_json,
    next.original_adobe_summary_json,
    next.rebuilt_adobe_summary_json,
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
  return collapseTransientFilenameDuplicates(rows).map(serializeQueueItemSummary)
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
    const rows = (db.prepare(`
      SELECT id FROM queue_items
      WHERE client_id = ? AND hidden = 0 AND state IN ('uploading', 'queued', 'processing', 'failed')
      ORDER BY created_at DESC
    `).all(clientId) as Array<{ id: string }>).map(row => getQueueItemById(row.id)).filter(Boolean) as QueueItemRecord[]
    return collapseTransientFilenameDuplicates(rows).map(row => row.id)
  }

  return (db.prepare(`
    SELECT id FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state = 'complete'
    ORDER BY updated_at DESC
  `).all(clientId) as Array<{ id: string }>).map(row => row.id)
}

export function getQueueCounts(clientId: string): { active: number; complete: number } {
  const activeRows = db.prepare(`
    SELECT * FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state IN ('uploading', 'queued', 'processing', 'failed')
  `).all(clientId) as QueueItemRecord[]
  const active = collapseTransientFilenameDuplicates(activeRows).length

  const complete = (db.prepare(`
    SELECT COUNT(*) as count FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state = 'complete'
  `).get(clientId) as any).count as number

  return { active, complete }
}

export function getQueueStatusCounts(clientId: string): {
  active: number
  history: number
  processing: number
  failed: number
  complete: number
} {
  const activeRows = db.prepare(`
    SELECT * FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state IN ('uploading', 'queued', 'processing', 'failed')
  `).all(clientId) as QueueItemRecord[]
  const activeCollapsed = collapseTransientFilenameDuplicates(activeRows)
  const historyCount = (db.prepare(`
    SELECT COUNT(*) as count FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state = 'complete'
  `).get(clientId) as any).count as number

  return {
    active: activeCollapsed.length,
    history: historyCount,
    processing: activeCollapsed.filter(item => item.state === 'processing').length,
    failed: activeCollapsed.filter(item => item.state === 'failed').length,
    complete: historyCount,
  }
}

export function listQueueStatusItems(clientId: string): QueueItemSummary[] {
  const activeRows = db.prepare(`
    SELECT * FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state IN ('uploading', 'queued', 'processing', 'failed')
    ORDER BY updated_at DESC
  `).all(clientId) as QueueItemRecord[]
  const historyRows = db.prepare(`
    SELECT * FROM queue_items
    WHERE client_id = ? AND hidden = 0 AND state = 'complete'
    ORDER BY updated_at DESC
  `).all(clientId) as QueueItemRecord[]
  return [...collapseTransientFilenameDuplicates(activeRows), ...historyRows].map(serializeQueueItemSummary)
}

export function serializeQueueItemVersions(row: QueueItemRecord): QueueItemVersion[] {
  const documentModel = readDocumentModel(row.document_model_path)
  const originalResult = parseResult(row.original_result_json)
  const rebuiltResult = parseResult(row.rebuilt_result_json || row.remediated_result_json)
  const currentResult = parseResult(row.result_json)
  const versions: QueueItemVersion[] = []

  if (row.original_storage_path || row.storage_path) {
    const originalVeraPdf = documentModel?.originalVeraPdf
      ? detailSummaryFromModel(documentModel.originalVeraPdf)
      : extractVeraPdfSummary(originalResult)
    versions.push({
      key: 'original',
      label: 'Original',
      createdAt: row.upload_completed_at || row.upload_started_at || row.created_at,
      score: row.original_overall_score ?? originalResult?.overallScore ?? null,
      grade: row.original_grade ?? originalResult?.grade ?? null,
      veraPdfStatus: originalVeraPdf.status,
      veraPdfFailedChecks: originalVeraPdf.failedChecks,
      downloadUrl: `/api/queue/items/${row.id}/download-original`,
      kind: 'input',
    })
  }

  if (row.rebuilt_storage_path || row.remediated_storage_path) {
    const rebuiltVeraPdf = documentModel?.remediatedVeraPdf
      ? detailSummaryFromModel(documentModel.remediatedVeraPdf)
      : extractVeraPdfSummary(rebuiltResult)
    versions.push({
      key: 'rebuilt',
      label: 'Remediated',
      createdAt: row.completed_at || row.updated_at,
      score: row.rebuilt_overall_score ?? row.remediated_overall_score ?? rebuiltResult?.overallScore ?? null,
      grade: row.rebuilt_grade ?? row.remediated_grade ?? rebuiltResult?.grade ?? null,
      veraPdfStatus: rebuiltVeraPdf.status,
      veraPdfFailedChecks: rebuiltVeraPdf.failedChecks,
      downloadUrl: `/api/queue/items/${row.id}/download`,
      kind: 'output',
    })
  }

  const currentArtifactPath = row.storage_path
  const rebuiltArtifactPath = row.rebuilt_storage_path || row.remediated_storage_path
  const originalArtifactPath = row.original_storage_path || row.storage_path
  const hasDistinctCurrentArtifact = !!currentArtifactPath
    && currentArtifactPath !== rebuiltArtifactPath
    && currentArtifactPath !== originalArtifactPath

  if (hasDistinctCurrentArtifact) {
    const currentVeraPdf = documentModel?.finalAudit?.veraPdf
      ? detailSummaryFromModel(documentModel.finalAudit.veraPdf)
      : extractVeraPdfSummary(currentResult)
    versions.push({
      key: 'current',
      label: 'Current',
      createdAt: row.updated_at,
      score: row.overall_score ?? currentResult?.overallScore ?? null,
      grade: row.grade ?? currentResult?.grade ?? null,
      veraPdfStatus: currentVeraPdf.status,
      veraPdfFailedChecks: currentVeraPdf.failedChecks,
      downloadUrl: `/api/queue/items/${row.id}/download`,
      kind: 'output',
    })
  }

  return versions
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

export function listClientsWithQueuedItems(): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT client_id FROM queue_items
    WHERE hidden = 0 AND state = 'queued' AND storage_path IS NOT NULL
  `).all() as { client_id: string }[]
  return rows.map(r => r.client_id)
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
