'use client'

import SparkMD5 from 'spark-md5'

export type QueueState = 'uploading' | 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled'
export type ReconstructionStatus = 'pending' | 'processing' | 'completed' | 'manual_review_required' | 'failed'
export type DocumentModelStatus = 'pending' | 'processing' | 'completed' | 'failed'
export type VeraPdfStatus = 'passed' | 'failed' | 'unavailable' | 'timeout' | 'parse_error' | 'error'

export interface QueueFailureModeSummary {
  key: string
  label: string
  count: number
  classification: 'deterministic' | 'semantic' | 'manual_only'
  blocking: boolean
}

export interface QueueItemSummary {
  id: string
  clientId: string
  filename: string
  md5: string
  sizeBytes: number
  mimeType: string | null
  state: QueueState
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
  standardsSummary?: {
    gradeBasis: {
      currentGrade: string | null
      currentScore: number | null
      gradeReducedByStandards: boolean
      scoreCappedByStandards: boolean
    }
    veraPdf: {
      status: VeraPdfStatus | null
      failedChecks: number | null
    }
    failureOverview: {
      topFailureModes: QueueFailureModeSummary[]
    }
    plannerOverview: {
      autoRunnableOpportunityCount: number
      blockedOpportunityCount: number
      deterministicIssueCount: number
      semanticIssueCount: number
      manualOnlyIssueCount: number
    }
  } | null
  error: { error?: string } | null
  reconstructionError: { error?: string } | null
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

export interface QueueItem extends QueueItemSummary {
  result: any | null
  originalResult: any | null
  rebuiltResult: any | null
  documentModel: any | null
  standardsDetail?: {
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
      current: { status: VeraPdfStatus | null; failedChecks: number | null; profile: string | null; flavour: string | null; topFailures: string[] }
      original: { status: VeraPdfStatus | null; failedChecks: number | null; profile: string | null; flavour: string | null; topFailures: string[] }
      rebuilt: { status: VeraPdfStatus | null; failedChecks: number | null; profile: string | null; flavour: string | null; topFailures: string[] }
    }
    failureModes: Array<{ key: string; label: string; classification: string; blocking: boolean; count: number; evidence: string[] }>
    plannerEvidence: {
      topFailureModeKeys: string[]
      topAutoRunnableOpportunityKeys: string[]
      skippedReasonCounts: Array<{ reason: string; count: number }>
      attemptedKeys: string[]
      rejectedKeys: string[]
      noEffectKeys: string[]
    } | null
    remediationSummary: {
      deterministicIssueCount: number
      semanticIssueCount: number
      manualOnlyIssueCount: number
      autoRunnableOpportunityCount: number
      blockedOpportunityCount: number
      manualReviewRequired: boolean
    }
  } | null
  aiAppliedChanges: Array<{ label: string; details: string }>
  aiSuggestedChanges: Array<{ label: string; details: string; reason?: string }>
  confidenceSummary: null | Record<string, number>
  manualReviewFlags: Array<{ code: string; label: string; details: string; severity: string }>
}

export interface QueueStatusResponse {
  items: QueueItemSummary[]
  counts: {
    active: number
    history: number
    processing: number
    failed: number
    complete: number
  }
  generatedAt: string
}

export interface QueueItemResponse {
  item: QueueItem
}

export interface QueueVersionsResponse {
  itemId: string
  versions: Array<{
    key: 'original' | 'rebuilt' | 'current'
    label: string
    createdAt: string | null
    score: number | null
    grade: string | null
    veraPdfStatus: VeraPdfStatus | null
    veraPdfFailedChecks: number | null
    downloadUrl: string | null
    kind: 'input' | 'output'
  }>
}

export interface QueueBulkActionResponse {
  ok: true
  count: number
  items: QueueItemSummary[]
}

export interface AuthConfigResponse {
  requireLogin: boolean
}

export interface AuthMeResponse {
  email: string
  isAdmin: boolean
}

export interface SharedReportResponse {
  report: any
  sharedBy: string
  createdAt: string
  expiresAt: string
}

export interface LocalUploadItem {
  id: string
  filename: string
  progress: number
  stage: string
  error: string | null
}

const CLIENT_ID_KEY = 'file-accessibility-audit-client-id'

function ensureClientId(): string {
  if (typeof window === 'undefined') return ''
  const existing = window.localStorage.getItem(CLIENT_ID_KEY)
  if (existing) return existing
  const next = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  window.localStorage.setItem(CLIENT_ID_KEY, next)
  return next
}

function setStoredClientId(clientId: string): void {
  if (typeof window === 'undefined' || !clientId) return
  window.localStorage.setItem(CLIENT_ID_KEY, clientId)
}

export async function apiJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: 'include',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null)
    throw new Error(errorBody?.error || `Request failed: ${response.status}`)
  }
  return response.json() as Promise<T>
}

export async function ensureClientSession(): Promise<string> {
  try {
    const restored = await apiJson<{ clientId: string }>('/api/client/bootstrap', {
      method: 'POST',
      headers: {},
      body: JSON.stringify({}),
    })
    if (restored.clientId) {
      setStoredClientId(restored.clientId)
      return restored.clientId
    }
  } catch {}

  const clientId = ensureClientId()
  const session = await apiJson<{ clientId: string }>('/api/client/bootstrap', {
    method: 'POST',
    headers: { 'x-client-id': clientId },
    body: JSON.stringify({ clientId }),
  })
  setStoredClientId(session.clientId || clientId)
  return session.clientId || clientId
}

function withClientHeaders(clientId: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      ...(init?.headers || {}),
      'x-client-id': clientId,
    },
  }
}

export async function fetchQueueStatus(): Promise<QueueStatusResponse> {
  const clientId = await ensureClientSession()
  return apiJson<QueueStatusResponse>('/api/queue/status', withClientHeaders(clientId))
}

export async function fetchQueueItem(itemId: string): Promise<QueueItemResponse> {
  const clientId = await ensureClientSession()
  return apiJson<QueueItemResponse>(`/api/queue/items/${itemId}`, withClientHeaders(clientId))
}

export async function fetchQueueVersions(itemId: string): Promise<QueueVersionsResponse> {
  const clientId = await ensureClientSession()
  return apiJson<QueueVersionsResponse>(`/api/queue/items/${itemId}/versions`, withClientHeaders(clientId))
}

export async function retryQueueItem(itemId: string): Promise<void> {
  const clientId = await ensureClientSession()
  await apiJson(`/api/queue/items/${itemId}/retry`, withClientHeaders(clientId, { method: 'POST' }))
}

export async function deleteQueueItems(itemIds: string[]): Promise<void> {
  const clientId = await ensureClientSession()
  await apiJson('/api/queue/delete-many', withClientHeaders(clientId, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  }))
}

export async function remediateQueueItems(itemIds: string[]): Promise<QueueBulkActionResponse> {
  const clientId = await ensureClientSession()
  return apiJson<QueueBulkActionResponse>('/api/queue/remediate-many', withClientHeaders(clientId, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  }))
}

export async function reanalyzeQueueItems(itemIds: string[]): Promise<QueueBulkActionResponse> {
  const clientId = await ensureClientSession()
  return apiJson<QueueBulkActionResponse>('/api/queue/reanalyze-many', withClientHeaders(clientId, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  }))
}

export async function downloadMany(itemIds: string[]): Promise<Blob> {
  const clientId = await ensureClientSession()
  const response = await fetch('/api/queue/download-many', withClientHeaders(clientId, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-client-id': clientId,
    },
    body: JSON.stringify({ itemIds }),
  }))
  if (!response.ok) throw new Error('Download failed')
  return response.blob()
}

function fileNameFromDisposition(value: string | null, fallback: string): string {
  if (!value) return fallback
  const utfMatch = value.match(/filename\*=UTF-8''([^;]+)/i)
  if (utfMatch?.[1]) return decodeURIComponent(utfMatch[1])
  const plainMatch = value.match(/filename="([^"]+)"/i) || value.match(/filename=([^;]+)/i)
  if (plainMatch?.[1]) return plainMatch[1].trim()
  return fallback
}

export async function downloadQueueFile(path: string, fallbackFilename: string): Promise<void> {
  const clientId = await ensureClientSession()
  const response = await fetch(path, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'x-client-id': clientId,
    },
  })
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null)
    throw new Error(errorBody?.error || 'Download failed')
  }

  const blob = await response.blob()
  const filename = fileNameFromDisposition(response.headers.get('content-disposition'), fallbackFilename)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function queueEventUrl(clientId: string): string {
  return `/api/queue/events?clientId=${encodeURIComponent(clientId)}`
}

export async function uploadFile(
  file: File,
  onProgress: (value: number, stage: string) => void,
): Promise<void> {
  const clientId = await ensureClientSession()
  const preflightMd5 = SparkMD5.ArrayBuffer.hash(await file.arrayBuffer())

  const preflight = await apiJson<{ item: QueueItemSummary }>('/api/queue/preflight', withClientHeaders(clientId, {
    method: 'POST',
    body: JSON.stringify({
      filename: file.name,
      sizeBytes: file.size,
      mimeType: file.type || 'application/pdf',
      md5: preflightMd5,
    }),
  }))

  await new Promise<void>((resolve, reject) => {
    const form = new FormData()
    form.append('file', file)
    const request = new XMLHttpRequest()
    request.withCredentials = true
    request.open('POST', `/api/queue/items/${preflight.item.id}/upload`)
    request.setRequestHeader('x-client-id', clientId)
    request.upload.onprogress = event => {
      if (!event.lengthComputable) return
      onProgress(Math.round((event.loaded / event.total) * 100), 'Uploading')
    }
    request.onerror = () => reject(new Error('Upload failed'))
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve()
        return
      }
      try {
        const parsed = JSON.parse(request.responseText)
        reject(new Error(parsed.error || 'Upload failed'))
      } catch {
        reject(new Error('Upload failed'))
      }
    }
    request.send(form)
  })
}

export async function getAuthConfig(): Promise<AuthConfigResponse> {
  return apiJson<AuthConfigResponse>('/api/auth/config', { headers: {} })
}

export async function getAuthMe(): Promise<AuthMeResponse> {
  return apiJson<AuthMeResponse>('/api/auth/me', { headers: {} })
}

export async function requestOtp(email: string): Promise<void> {
  await apiJson('/api/auth/request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export async function verifyOtp(email: string, otp: string): Promise<void> {
  await apiJson('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ email, otp }),
  })
}

export async function logout(): Promise<void> {
  await apiJson('/api/auth/logout', {
    method: 'POST',
    headers: {},
    body: JSON.stringify({}),
  })
}

export async function fetchSharedReport(id: string): Promise<SharedReportResponse> {
  return apiJson<SharedReportResponse>(`/api/reports/${id}`, { headers: {} })
}

export async function createSharedReport(report: any): Promise<{ id: string; expiresAt: string }> {
  return apiJson('/api/reports', {
    method: 'POST',
    body: JSON.stringify({ report }),
  })
}
