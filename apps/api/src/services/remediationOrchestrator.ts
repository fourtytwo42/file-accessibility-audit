import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { analyzeWithQpdf } from './qpdfService.js'
import { renderPdfPageToDataUrl } from './pdfRenderService.js'
import type { PlannerResidualFamilySummary, ResidualFamilyId } from './documentModel.js'
import { markQueueItemsResultFreshness } from './queueStore.js'

type PdfjsLib = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

export type OrchestratorLifecycleState =
  | 'queued'
  | 'uploading'
  | 'remediating'
  | 'analyzing'
  | 'autofixing'
  | 'visual_compare'
  | 'needs_fix'
  | 'awaiting_restart'
  | 'rerunning'
  | 'done'
  | 'blocked'

export type ValidationStage =
  | 'idle'
  | 'downloading_output'
  | 'rendering_original_page_1'
  | 'rendering_remediated_page_1'
  | 'visual_compare'
  | 'bookmark_validation'
  | 'finalizing'

export interface ApiClientSession {
  clientId: string
  cookie: string
  expiresAt: string | null
  restored: boolean
}

export interface QueueCounts {
  active: number
  history: number
  processing: number
  failed: number
  complete: number
}

export interface QueueStatusSummary {
  id: string
  filename: string
  state: 'uploading' | 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled'
  uploadProgress: number
  processingProgress: number
  processingStage: string | null
  overallScore: number | null
  grade: string | null
  originalScore: number | null
  originalGrade: string | null
  rebuiltScore: number | null
  rebuiltGrade: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  canDownloadRebuilt: boolean
}

export interface QueueStatusResponse {
  items: QueueStatusSummary[]
  counts: QueueCounts
  generatedAt: string
}

export interface QueueFailureModeSummary {
  key: string
  label: string
  count: number
  classification: 'deterministic' | 'semantic' | 'manual_only'
  blocking: boolean
}

export interface QueueItemDetail {
  id: string
  filename: string
  state: QueueStatusSummary['state']
  processingProgress: number
  processingStage: string | null
  overallScore: number | null
  grade: string | null
  rebuiltScore: number | null
  rebuiltGrade: string | null
  completedAt: string | null
  result: any | null
  originalResult: any | null
  rebuiltResult: any | null
  documentModel: any | null
  aiAppliedChanges: Array<{
    type: string
    label: string
    details: string
    generationSource?: 'semantic_ai' | 'heuristic_fallback' | 'manual_deferred'
  }>
  manualReviewFlags?: Array<{
    code: string
    label: string
    severity: 'warning' | 'critical'
    details: string
  }>
  standardsDetail?: {
    failureModes?: QueueFailureModeSummary[]
    plannerEvidence?: {
      topBlockingResidualFamilyIds?: ResidualFamilyId[]
      topResidualFamilySummaries?: PlannerResidualFamilySummary[]
    }
    veraPdf?: {
      current?: {
        status: string | null
        failedChecks: number | null
        topFailures: string[]
      }
    }
  } | null
}

export interface VisualComparisonResult {
  passed: boolean
  reason: string
  originalWidth: number
  originalHeight: number
  remediatedWidth: number
  remediatedHeight: number
  sameDimensions: boolean
  changedPixelRatio: number
  meanChannelDelta: number
  originalNonWhiteRatio: number
  remediatedNonWhiteRatio: number
  originalBlank: boolean
  remediatedBlank: boolean
}

export interface BookmarkValidationResult {
  passed: boolean
  usedAiCleanup: boolean
  reason: string
  titles: string[]
  flaggedTitles: string[]
}

export interface ValidationResult {
  passed: boolean
  scorePassed: boolean
  gradePassed: boolean
  veraPdfPassed: boolean
  blockingFailureModesClear: boolean
  blockingResidualFamiliesClear: boolean
  criticalManualReviewClear: boolean
  visualComparison: VisualComparisonResult
  bookmarkValidation: BookmarkValidationResult
}

export interface FailurePacket {
  filename: string
  queueItemId: string
  latestAttemptPath: string | null
  latestQueueSummary: {
    score: number | null
    grade: string | null
    verapdfStatus: string | null
    failedChecks: number | null
  }
  topFailureModes: QueueFailureModeSummary[]
  topBlockingResidualFamilyIds?: ResidualFamilyId[]
  topResidualFamilies?: PlannerResidualFamilySummary[]
  semanticSidecarState?: 'unknown' | 'not_flagged' | 'semantic_sidecar_unavailable'
  visualComparison: VisualComparisonResult | null
  bookmarkValidation: BookmarkValidationResult | null
  freshPostRestartRemediation: boolean
  generatedAt: string
}

export interface AttemptArtifactPaths {
  directory: string
  pdfPath: string
  originalPage1PngPath: string
  remediatedPage1PngPath: string
  visualComparisonJsonPath: string
  failurePacketJsonPath: string
}

export interface TrackedPdfState {
  filename: string
  sourcePath: string
  queueItemId: string | null
  attemptNumber: number
  loopCount: number
  lifecycleState: OrchestratorLifecycleState
  validationStage: ValidationStage
  latestOutputPath: string | null
  latestFailurePacketPath: string | null
  latestScore: number | null
  latestGrade: string | null
  latestVeraPdfStatus: string | null
  latestProcessingStage: string | null
  latestProcessingProgress: number
  latestVisualComparison: VisualComparisonResult | null
  latestBookmarkValidation: BookmarkValidationResult | null
  latestValidationPassed: boolean
  resultProvenance: 'unknown' | 'current_session' | 'stale_after_restart'
  queuedAt: string | null
  lastUpdatedAt: string
}

export interface CampaignState {
  version: 1
  createdAt: string
  updatedAt: string
  apiBaseUrl: string
  session: ApiClientSession | null
  files: Record<string, TrackedPdfState>
  recentEvents: string[]
  lastApiRestartAt: string | null
  currentConcurrencyCap: number
}

export interface DashboardRow {
  filename: string
  lifecycleState: OrchestratorLifecycleState
  validationStage: ValidationStage
  progressPercent: number
  stageLabel: string
  loopCount: number
  score: number | null
  grade: string | null
}

export interface SystemHealth {
  apiStatus: 'ok' | 'unavailable'
  cpuCount: number
  loadAverage1m: number
  loadRatio: number
  totalMemoryBytes: number
  freeMemoryBytes: number
  usedMemoryBytes: number
  memoryUsageRatio: number
  activeConcurrency: number
  concurrencyCap: number
}

export interface OrchestratorConfig {
  repoRoot: string
  apiBaseUrl: string
  downloadsDir: string
  completeDir: string
  attemptsRootDir: string
  stateFilePath: string
  progressTrackerPath: string
  maxConcurrency: number
  targetScore: number
  cpuLoadThreshold: number
  memoryUsageThreshold: number
  page1RenderScale: number
  page1DiffThreshold: number
  pollIntervalMs: number
  dashboardRefreshMs: number
  validateOnly: boolean
  autoFixEnabled: boolean
  codexBinary: string
  pm2AppName: string
  autoFixBatchSize: number
  apiRestartWaitMs: number
}

export interface QueueApiClientOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
}

function nowIso(): string {
  return new Date().toISOString()
}

export function defaultOrchestratorConfig(repoRoot = process.cwd()): OrchestratorConfig {
  return {
    repoRoot,
    apiBaseUrl: process.env.ORCHESTRATOR_API_BASE_URL || 'http://127.0.0.1:6103',
    downloadsDir: path.join(repoRoot, 'Downloads'),
    completeDir: path.join(repoRoot, 'Complete'),
    attemptsRootDir: path.join(repoRoot, 'MitigationAttempts'),
    stateFilePath: path.join(repoRoot, 'MitigationAttempts', 'orchestrator-state.json'),
    progressTrackerPath: path.join(repoRoot, 'REMEDIATION_PROGRESS.md'),
    maxConcurrency: Math.max(1, Number(process.env.ORCHESTRATOR_MAX_CONCURRENCY || 6)),
    targetScore: Math.max(1, Number(process.env.ORCHESTRATOR_TARGET_SCORE || 95)),
    cpuLoadThreshold: Math.max(0.1, Number(process.env.ORCHESTRATOR_CPU_LOAD_THRESHOLD || 0.85)),
    memoryUsageThreshold: Math.max(0.1, Number(process.env.ORCHESTRATOR_MEMORY_USAGE_THRESHOLD || 0.85)),
    page1RenderScale: Math.max(1, Number(process.env.ORCHESTRATOR_PAGE1_RENDER_SCALE || 1.5)),
    page1DiffThreshold: Math.max(0.001, Number(process.env.ORCHESTRATOR_PAGE1_DIFF_THRESHOLD || 0.12)),
    pollIntervalMs: Math.max(1000, Number(process.env.ORCHESTRATOR_POLL_INTERVAL_MS || 5000)),
    dashboardRefreshMs: Math.max(250, Number(process.env.ORCHESTRATOR_DASHBOARD_REFRESH_MS || 1000)),
    validateOnly: process.argv.includes('--validate-only'),
    autoFixEnabled: process.env.ORCHESTRATOR_ENABLE_AUTOFIX !== 'false',
    codexBinary: process.env.ORCHESTRATOR_CODEX_BIN || 'codex',
    pm2AppName: process.env.ORCHESTRATOR_PM2_APP_NAME || 'file-audit-api',
    autoFixBatchSize: Math.max(1, Number(process.env.ORCHESTRATOR_AUTOFIX_BATCH_SIZE || 2)),
    apiRestartWaitMs: Math.max(5000, Number(process.env.ORCHESTRATOR_API_RESTART_WAIT_MS || 60000)),
  }
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function progressBar(percent: number, width = 28): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  const filled = Math.round((clamped / 100) * width)
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

export function trimForDisplay(value: string, maxLength = 72): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`
}

function sanitizeStem(filename: string): string {
  const stem = path.basename(filename, path.extname(filename)).trim() || 'untitled'
  return stem.replace(/[\\/:*?"<>|]/g, '_')
}

export function buildAttemptArtifactPaths(attemptsRootDir: string, filename: string, attemptNumber: number): AttemptArtifactPaths {
  const directory = path.join(attemptsRootDir, sanitizeStem(filename))
  const suffix = String(attemptNumber).padStart(3, '0')
  return {
    directory,
    pdfPath: path.join(directory, `attempt-${suffix}.pdf`),
    originalPage1PngPath: path.join(directory, `attempt-${suffix}-original-page-1.png`),
    remediatedPage1PngPath: path.join(directory, `attempt-${suffix}-remediated-page-1.png`),
    visualComparisonJsonPath: path.join(directory, `attempt-${suffix}-visual-compare.json`),
    failurePacketJsonPath: path.join(directory, `attempt-${suffix}-failure-packet.json`),
  }
}

export function discoverDownloadPdfs(downloadsDir: string): string[] {
  if (!fs.existsSync(downloadsDir)) return []
  return fs.readdirSync(downloadsDir)
    .filter(name => name.toLowerCase().endsWith('.pdf'))
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
    .map(name => path.join(downloadsDir, name))
}

export function createEmptyCampaignState(apiBaseUrl: string): CampaignState {
  return {
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    apiBaseUrl,
    session: null,
    files: {},
    recentEvents: [],
    lastApiRestartAt: null,
    currentConcurrencyCap: 1,
  }
}

export function loadCampaignState(filePath: string, apiBaseUrl: string): CampaignState {
  if (!fs.existsSync(filePath)) return createEmptyCampaignState(apiBaseUrl)
  const raw = parseJson<CampaignState | null>(fs.readFileSync(filePath, 'utf8'), null)
  if (!raw || raw.version !== 1) return createEmptyCampaignState(apiBaseUrl)
  return {
    ...raw,
    apiBaseUrl,
    files: raw.files || {},
    recentEvents: Array.isArray(raw.recentEvents) ? raw.recentEvents.slice(-120) : [],
  }
}

export function recoverInterruptedCampaignState(state: CampaignState): CampaignState {
  const next: CampaignState = {
    ...state,
    files: { ...state.files },
  }
  const recovered: string[] = []

  for (const [filename, entry] of Object.entries(state.files)) {
    if (entry.lifecycleState !== 'autofixing') continue
    const completedAutofix = state.recentEvents.some(event =>
      event.includes('Autofix batch completed:')
      && event.includes(filename),
    )
    next.files[filename] = {
      ...entry,
      lifecycleState: completedAutofix ? 'awaiting_restart' : (entry.latestFailurePacketPath ? 'needs_fix' : 'blocked'),
      latestProcessingStage: completedAutofix
        ? 'Recovered after completed autofix; awaiting rerun'
        : 'Recovered after interrupted orchestrator run',
      latestProcessingProgress: 0,
      validationStage: 'idle',
      resultProvenance: completedAutofix ? 'stale_after_restart' : entry.resultProvenance,
      lastUpdatedAt: nowIso(),
    }
    recovered.push(filename)
  }

  if (recovered.length > 0) {
    next.recentEvents = [
      ...next.recentEvents,
      `${nowIso()} Recovered interrupted autofix state for: ${recovered.join(', ')}`,
    ].slice(-120)
  }

  return next
}

export function saveCampaignState(filePath: string, state: CampaignState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const next = {
    ...state,
    updatedAt: nowIso(),
    recentEvents: state.recentEvents.slice(-120),
  }
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8')
}

export function syncCampaignFiles(state: CampaignState, downloadsDir: string): CampaignState {
  const discovered = discoverDownloadPdfs(downloadsDir)
  const nextFiles = { ...state.files }
  for (const sourcePath of discovered) {
    const filename = path.basename(sourcePath)
    if (nextFiles[filename]) {
      nextFiles[filename] = {
        ...nextFiles[filename],
        sourcePath,
      }
      continue
    }
    nextFiles[filename] = {
      filename,
      sourcePath,
      queueItemId: null,
      attemptNumber: 0,
      loopCount: 0,
      lifecycleState: 'queued',
      validationStage: 'idle',
      latestOutputPath: null,
      latestFailurePacketPath: null,
      latestScore: null,
      latestGrade: null,
      latestVeraPdfStatus: null,
      latestProcessingStage: null,
      latestProcessingProgress: 0,
      latestVisualComparison: null,
      latestBookmarkValidation: null,
      latestValidationPassed: false,
      resultProvenance: 'unknown',
      queuedAt: null,
      lastUpdatedAt: nowIso(),
    }
  }
  return { ...state, files: nextFiles }
}

export function appendEvent(state: CampaignState, message: string): CampaignState {
  return {
    ...state,
    recentEvents: [...state.recentEvents, `${nowIso()} ${message}`].slice(-120),
    updatedAt: nowIso(),
  }
}

function parseCookieHeader(setCookieHeader: string | null): string {
  if (!setCookieHeader) throw new Error('Missing set-cookie header from API bootstrap')
  return setCookieHeader.split(';')[0] || setCookieHeader
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`API request failed (${response.status}): ${text || response.statusText}`)
  }
  return await response.json() as T
}

export function isExpiredSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /API request failed \(401\)/.test(error.message) && /Client session expired/i.test(error.message)
}

export class QueueApiClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private session: ApiClientSession | null = null

  constructor(options: QueueApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl || fetch
  }

  getSession(): ApiClientSession | null {
    return this.session
  }

  setSession(session: ApiClientSession | null): void {
    this.session = session
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    if (!this.session) throw new Error('API client session is not initialized')
    return {
      'x-client-id': this.session.clientId,
      cookie: this.session.cookie,
      ...extra,
    }
  }

  async bootstrap(clientId?: string): Promise<ApiClientSession> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/client/bootstrap`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(clientId ? { 'x-client-id': clientId } : {}),
        ...(this.session?.cookie ? { cookie: this.session.cookie } : {}),
      },
      body: JSON.stringify(clientId ? { clientId } : {}),
    })
    const payload = await parseJsonResponse<{ clientId: string; expiresAt?: string | null; restored: boolean }>(response)
    const nextSession: ApiClientSession = {
      clientId: payload.clientId,
      cookie: parseCookieHeader(response.headers.get('set-cookie') || this.session?.cookie || null),
      expiresAt: payload.expiresAt ?? null,
      restored: payload.restored,
    }
    this.session = nextSession
    return nextSession
  }

  async health(): Promise<{ status: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/health`)
    return parseJsonResponse<{ status: string }>(response)
  }

  async queueStatus(): Promise<QueueStatusResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/queue/status`, {
      headers: this.authHeaders(),
    })
    return parseJsonResponse<QueueStatusResponse>(response)
  }

  async queueItemDetail(itemId: string): Promise<QueueItemDetail> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/queue/items/${itemId}`, {
      headers: this.authHeaders(),
    })
    const payload = await parseJsonResponse<{ item: QueueItemDetail }>(response)
    return payload.item
  }

  async uploadPdf(filePath: string): Promise<{ id: string; filename: string }> {
    const form = new FormData()
    const filename = path.basename(filePath)
    const buffer = await fs.promises.readFile(filePath)
    form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename)
    const response = await this.fetchImpl(`${this.baseUrl}/api/queue/upload`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
    })
    const payload = await parseJsonResponse<{ item: { id: string; filename: string } }>(response)
    return payload.item
  }

  async remediateMany(itemIds: string[]): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/queue/remediate-many`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ itemIds }),
    })
    await parseJsonResponse<{ ok: boolean }>(response)
  }

  async downloadRebuilt(itemId: string): Promise<Buffer> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/queue/items/${itemId}/download`, {
      headers: this.authHeaders(),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Download failed (${response.status}): ${text || response.statusText}`)
    }
    return Buffer.from(await response.arrayBuffer())
  }
}

export function determineConcurrencyCap(config: OrchestratorConfig): number {
  const cpuCount = Math.max(1, os.cpus().length)
  const loadRatio = os.loadavg()[0] / cpuCount
  const memoryUsageRatio = 1 - (os.freemem() / Math.max(1, os.totalmem()))
  let cap = config.maxConcurrency

  if (loadRatio >= config.cpuLoadThreshold || memoryUsageRatio >= config.memoryUsageThreshold) {
    cap = Math.max(1, Math.floor(config.maxConcurrency / 2))
  }
  if (loadRatio >= config.cpuLoadThreshold * 1.15 || memoryUsageRatio >= config.memoryUsageThreshold * 1.1) {
    cap = 1
  }

  return Math.max(1, Math.min(config.maxConcurrency, cap))
}

export function collectSystemHealth(apiStatus: 'ok' | 'unavailable', activeConcurrency: number, concurrencyCap: number): SystemHealth {
  const totalMemoryBytes = os.totalmem()
  const freeMemoryBytes = os.freemem()
  const usedMemoryBytes = Math.max(0, totalMemoryBytes - freeMemoryBytes)
  const cpuCount = Math.max(1, os.cpus().length)
  const loadAverage1m = os.loadavg()[0]
  return {
    apiStatus,
    cpuCount,
    loadAverage1m,
    loadRatio: loadAverage1m / cpuCount,
    totalMemoryBytes,
    freeMemoryBytes,
    usedMemoryBytes,
    memoryUsageRatio: usedMemoryBytes / Math.max(1, totalMemoryBytes),
    activeConcurrency,
    concurrencyCap,
  }
}

export function deriveDashboardRow(entry: TrackedPdfState): DashboardRow {
  if (entry.lifecycleState === 'uploading') {
    return {
      filename: entry.filename,
      lifecycleState: entry.lifecycleState,
      validationStage: entry.validationStage,
      progressPercent: Math.max(1, Math.min(10, entry.latestProcessingProgress || 1)),
      stageLabel: entry.latestProcessingStage || 'Uploading',
      loopCount: entry.loopCount,
      score: entry.latestScore,
      grade: entry.latestGrade,
    }
  }

  if (entry.lifecycleState === 'autofixing') {
    return {
      filename: entry.filename,
      lifecycleState: entry.lifecycleState,
      validationStage: entry.validationStage,
      progressPercent: 12,
      stageLabel: entry.latestProcessingStage || 'Running Codex autofix',
      loopCount: entry.loopCount,
      score: entry.latestScore,
      grade: entry.latestGrade,
    }
  }

  if (entry.lifecycleState === 'remediating' || entry.lifecycleState === 'analyzing' || entry.lifecycleState === 'rerunning') {
    return {
      filename: entry.filename,
      lifecycleState: entry.lifecycleState,
      validationStage: entry.validationStage,
      progressPercent: Math.max(1, Math.min(80, Math.round(entry.latestProcessingProgress * 0.8))),
      stageLabel: entry.latestProcessingStage || 'Processing',
      loopCount: entry.loopCount,
      score: entry.latestScore,
      grade: entry.latestGrade,
    }
  }

  const validationPercent: Record<ValidationStage, number> = {
    idle: entry.lifecycleState === 'done' ? 100 : 0,
    downloading_output: 82,
    rendering_original_page_1: 86,
    rendering_remediated_page_1: 90,
    visual_compare: 94,
    bookmark_validation: 97,
    finalizing: 99,
  }

  const validationLabel: Record<ValidationStage, string> = {
    idle: entry.latestProcessingStage || entry.lifecycleState,
    downloading_output: 'Downloading output',
    rendering_original_page_1: 'Rendering original page 1',
    rendering_remediated_page_1: 'Rendering remediated page 1',
    visual_compare: 'Visual compare',
    bookmark_validation: 'Bookmark validation',
    finalizing: 'Finalizing',
  }

  return {
    filename: entry.filename,
    lifecycleState: entry.lifecycleState,
    validationStage: entry.validationStage,
    progressPercent: entry.lifecycleState === 'done' ? 100 : validationPercent[entry.validationStage],
    stageLabel: validationLabel[entry.validationStage],
    loopCount: entry.loopCount,
    score: entry.latestScore,
    grade: entry.latestGrade,
  }
}

export function renderDashboard(state: CampaignState, health: SystemHealth): string {
  const rows = Object.values(state.files)
    .sort((a, b) => a.filename.localeCompare(b.filename, 'en', { sensitivity: 'base' }))
    .map(deriveDashboardRow)
  const total = rows.length
  const completed = rows.filter(row => row.lifecycleState === 'done').length
  const left = Math.max(0, total - completed)
  const overallPercent = total === 0 ? 0 : Math.round((completed / total) * 100)
  const activeRows = rows.filter(row =>
    row.lifecycleState === 'uploading'
    || row.lifecycleState === 'autofixing'
    || row.lifecycleState === 'remediating'
    || row.lifecycleState === 'analyzing'
    || row.lifecycleState === 'rerunning'
    || row.lifecycleState === 'visual_compare'
  ).slice(0, 8)
  const pausedRows = rows.filter(row =>
    row.lifecycleState === 'needs_fix'
    || row.lifecycleState === 'awaiting_restart'
    || row.lifecycleState === 'blocked',
  ).slice(0, 8)
  const recentEvents = state.recentEvents.slice(-10)

  const lines: string[] = []
  lines.push('PDF Remediation Orchestrator')
  lines.push('='.repeat(80))
  lines.push(`Overall: ${completed}/${total} completed | ${left} left`)
  lines.push(`[${progressBar(overallPercent, 40)}] ${String(overallPercent).padStart(3, ' ')}%`)
  lines.push('')
  lines.push(`API: ${health.apiStatus} | CPU load: ${health.loadAverage1m.toFixed(2)} (${(health.loadRatio * 100).toFixed(0)}%) | Memory: ${formatBytes(health.usedMemoryBytes)} / ${formatBytes(health.totalMemoryBytes)} (${(health.memoryUsageRatio * 100).toFixed(0)}%) | Concurrency: ${health.activeConcurrency}/${health.concurrencyCap}`)
  lines.push('')
  lines.push('Active PDFs')
  lines.push('-'.repeat(80))
  if (activeRows.length === 0) {
    lines.push('No active PDFs.')
  } else {
    for (const row of activeRows) {
      const score = row.score === null ? '--' : String(row.score)
      const grade = row.grade || '--'
      lines.push(trimForDisplay(row.filename, 80))
      lines.push(`  [${progressBar(row.progressPercent, 28)}] ${String(row.progressPercent).padStart(3, ' ')}% | ${row.lifecycleState} | ${trimForDisplay(row.stageLabel, 38)} | score ${score} | grade ${grade} | loop ${row.loopCount}`)
    }
  }
  lines.push('')
  lines.push('Paused / Blocked PDFs')
  lines.push('-'.repeat(80))
  if (pausedRows.length === 0) {
    lines.push('No paused or blocked PDFs.')
  } else {
    for (const row of pausedRows) {
      const score = row.score === null ? '--' : String(row.score)
      const grade = row.grade || '--'
      lines.push(trimForDisplay(row.filename, 80))
      lines.push(`  [${progressBar(row.progressPercent, 28)}] ${String(row.progressPercent).padStart(3, ' ')}% | ${row.lifecycleState} | ${trimForDisplay(row.stageLabel, 38)} | score ${score} | grade ${grade} | loop ${row.loopCount}`)
    }
  }
  lines.push('')
  lines.push('Recent Events')
  lines.push('-'.repeat(80))
  if (recentEvents.length === 0) {
    lines.push('No events yet.')
  } else {
    for (const event of recentEvents) lines.push(trimForDisplay(event, 80))
  }
  return lines.join('\n')
}

type ImageStats = {
  width: number
  height: number
  nonWhiteRatio: number
  blank: boolean
}

async function loadPngPixelData(buffer: Buffer): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const image = await loadImage(buffer)
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image as any, 0, 0, image.width, image.height)
  const imageData = context.getImageData(0, 0, image.width, image.height)
  return { width: image.width, height: image.height, data: imageData.data }
}

function computeImageStats(image: { width: number; height: number; data: Uint8ClampedArray }): ImageStats {
  let nonWhitePixels = 0
  const totalPixels = Math.max(1, image.width * image.height)
  for (let index = 0; index < image.data.length; index += 4) {
    const r = image.data[index]
    const g = image.data[index + 1]
    const b = image.data[index + 2]
    const a = image.data[index + 3]
    if (a > 0 && (r < 248 || g < 248 || b < 248)) nonWhitePixels++
  }
  const nonWhiteRatio = nonWhitePixels / totalPixels
  return {
    width: image.width,
    height: image.height,
    nonWhiteRatio,
    blank: nonWhiteRatio < 0.005,
  }
}

export async function compareRenderedPageImages(originalPng: Buffer, remediatedPng: Buffer, diffThreshold: number): Promise<VisualComparisonResult> {
  const original = await loadPngPixelData(originalPng)
  const remediated = await loadPngPixelData(remediatedPng)
  const originalStats = computeImageStats(original)
  const remediatedStats = computeImageStats(remediated)
  const sameDimensions = original.width === remediated.width && original.height === remediated.height

  if (!sameDimensions) {
    return {
      passed: false,
      reason: 'Rendered page 1 PNG dimensions differ.',
      originalWidth: original.width,
      originalHeight: original.height,
      remediatedWidth: remediated.width,
      remediatedHeight: remediated.height,
      sameDimensions,
      changedPixelRatio: 1,
      meanChannelDelta: 255,
      originalNonWhiteRatio: originalStats.nonWhiteRatio,
      remediatedNonWhiteRatio: remediatedStats.nonWhiteRatio,
      originalBlank: originalStats.blank,
      remediatedBlank: remediatedStats.blank,
    }
  }

  let changedPixels = 0
  let totalChannelDelta = 0
  const totalPixels = Math.max(1, original.width * original.height)

  for (let index = 0; index < original.data.length; index += 4) {
    const dr = Math.abs(original.data[index] - remediated.data[index])
    const dg = Math.abs(original.data[index + 1] - remediated.data[index + 1])
    const db = Math.abs(original.data[index + 2] - remediated.data[index + 2])
    const da = Math.abs(original.data[index + 3] - remediated.data[index + 3])
    totalChannelDelta += dr + dg + db + da
    if (dr + dg + db + da >= 32) changedPixels++
  }

  const changedPixelRatio = changedPixels / totalPixels
  const meanChannelDelta = totalChannelDelta / Math.max(1, totalPixels * 4)
  const nonWhiteDelta = Math.abs(originalStats.nonWhiteRatio - remediatedStats.nonWhiteRatio)
  const passed = !originalStats.blank
    && !remediatedStats.blank
    && changedPixelRatio <= diffThreshold
    && nonWhiteDelta <= 0.12

  let reason = 'Page 1 visual comparison passed.'
  if (originalStats.blank) reason = 'Original page 1 rendered blank.'
  else if (remediatedStats.blank) reason = 'Remediated page 1 rendered blank.'
  else if (changedPixelRatio > diffThreshold) reason = 'Page 1 differs beyond the configured threshold.'
  else if (nonWhiteDelta > 0.12) reason = 'Page 1 non-white coverage changed too much.'

  return {
    passed,
    reason,
    originalWidth: original.width,
    originalHeight: original.height,
    remediatedWidth: remediated.width,
    remediatedHeight: remediated.height,
    sameDimensions,
    changedPixelRatio,
    meanChannelDelta,
    originalNonWhiteRatio: originalStats.nonWhiteRatio,
    remediatedNonWhiteRatio: remediatedStats.nonWhiteRatio,
    originalBlank: originalStats.blank,
    remediatedBlank: remediatedStats.blank,
  }
}

export async function renderPdfPage1ToPng(pdfBuffer: Buffer, scale: number): Promise<Buffer> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs') as PdfjsLib
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer), useSystemFonts: true, verbosity: 0 }).promise
  try {
    const page = await doc.getPage(1)
    try {
      const rendered = await renderPdfPageToDataUrl(page, { scale, format: 'png' })
      return rendered.buffer
    } finally {
      page.cleanup()
    }
  } finally {
    await doc.destroy()
  }
}

function normalizeOutlineTitle(title: string): string {
  return title
    .replace(/^u:/i, '')
    .replace(/^b:[0-9a-f]+$/i, match => match)
    .replace(/\s+/g, ' ')
    .trim()
}

function titleLooksBad(title: string): boolean {
  if (!title.trim()) return true
  if (/^b:[0-9a-f]+$/i.test(title)) return true
  if (/\.{4,}\s*\d+\s*$/.test(title)) return true
  if (/^\d+\s*$/.test(title)) return true
  if (/\btable of contents\b/i.test(title) && /\.{3,}/.test(title)) return true
  if (/[^\w)\]]\s*\d+\s*$/.test(title) && title.length < 8) return true
  return false
}

export function validateBookmarkTitles(outlineTitles: string[], detail: Pick<QueueItemDetail, 'aiAppliedChanges' | 'documentModel'>): BookmarkValidationResult {
  const cleanedTitles = outlineTitles
    .map(normalizeOutlineTitle)
    .filter(Boolean)
  const flaggedTitles = cleanedTitles.filter(titleLooksBad)
  const aiApplied = (detail.aiAppliedChanges || []).some(change =>
    change.type === 'bookmark'
    && change.generationSource === 'semantic_ai',
  )
  const semanticActionTrace = Array.isArray(detail.documentModel?.actions)
    && detail.documentModel.actions.some((action: any) =>
      action?.tool === 'replace_bookmarks_from_headings'
      && action?.generationSource === 'semantic_ai',
    )

  const usedAiCleanup = aiApplied || semanticActionTrace
  const passed = cleanedTitles.length > 0 && flaggedTitles.length === 0 && usedAiCleanup

  let reason = 'Bookmark validation passed.'
  if (cleanedTitles.length === 0) reason = 'No bookmark titles were found in the remediated PDF.'
  else if (!usedAiCleanup) reason = 'Bookmark cleanup did not appear to use the semantic AI path.'
  else if (flaggedTitles.length > 0) reason = 'Bookmark titles still contain noisy OCR or table-of-contents artifacts.'

  return {
    passed,
    usedAiCleanup,
    reason,
    titles: cleanedTitles,
    flaggedTitles,
  }
}

function currentVeraPdfStatus(detail: QueueItemDetail): { status: string | null; failedChecks: number | null } {
  return {
    status: detail.standardsDetail?.veraPdf?.current?.status ?? detail.result?.verapdf?.status ?? null,
    failedChecks: detail.standardsDetail?.veraPdf?.current?.failedChecks ?? detail.result?.verapdf?.failedChecks ?? null,
  }
}

function currentBlockingFailureModes(detail: QueueItemDetail): QueueFailureModeSummary[] {
  return (detail.standardsDetail?.failureModes || []).filter(mode => mode.blocking)
}

function currentBlockingResidualFamilies(detail: QueueItemDetail): PlannerResidualFamilySummary[] {
  return (detail.standardsDetail?.plannerEvidence?.topResidualFamilySummaries || []).filter(family => family.blocking)
}

function hasCriticalManualReviewFlags(detail: QueueItemDetail): boolean {
  return (detail.manualReviewFlags || []).some(flag => flag.severity === 'critical')
}

export async function runValidationPipeline(
  client: QueueApiClient,
  entry: TrackedPdfState,
  config: OrchestratorConfig,
): Promise<{
  validation: ValidationResult
  downloadedPdfPath: string
  visualPaths: AttemptArtifactPaths
  failurePacket: FailurePacket | null
}> {
  if (!entry.queueItemId) throw new Error(`Missing queue item id for ${entry.filename}`)
  const detail = await client.queueItemDetail(entry.queueItemId)
  const artifactPaths = buildAttemptArtifactPaths(config.attemptsRootDir, entry.filename, entry.attemptNumber)
  await fs.promises.mkdir(artifactPaths.directory, { recursive: true })

  const rebuiltBuffer = await client.downloadRebuilt(entry.queueItemId)
  await fs.promises.writeFile(artifactPaths.pdfPath, rebuiltBuffer)

  const originalBuffer = await fs.promises.readFile(entry.sourcePath)
  const originalPage1 = await renderPdfPage1ToPng(originalBuffer, config.page1RenderScale)
  const rebuiltPage1 = await renderPdfPage1ToPng(rebuiltBuffer, config.page1RenderScale)
  await fs.promises.writeFile(artifactPaths.originalPage1PngPath, originalPage1)
  await fs.promises.writeFile(artifactPaths.remediatedPage1PngPath, rebuiltPage1)

  const visualComparison = await compareRenderedPageImages(originalPage1, rebuiltPage1, config.page1DiffThreshold)
  await fs.promises.writeFile(artifactPaths.visualComparisonJsonPath, JSON.stringify(visualComparison, null, 2), 'utf8')

  const qpdf = await analyzeWithQpdf(rebuiltBuffer)
  const bookmarkValidation = validateBookmarkTitles(qpdf.outlineTitles || [], detail)
  const veraPdf = currentVeraPdfStatus(detail)
  const blockingFailureModes = currentBlockingFailureModes(detail)
  const blockingResidualFamilies = currentBlockingResidualFamilies(detail)
  const criticalManualReviewClear = !hasCriticalManualReviewFlags(detail)
  const scorePassed = (detail.overallScore || 0) >= config.targetScore
  const gradePassed = detail.grade === 'A'
  const veraPdfPassed = veraPdf.status !== 'failed'
  const blockingFailureModesClear = blockingFailureModes.length === 0
  const blockingResidualFamiliesClear = blockingResidualFamilies.length === 0
  const validation: ValidationResult = {
    passed: scorePassed
      && gradePassed
      && veraPdfPassed
      && blockingFailureModesClear
      && blockingResidualFamiliesClear
      && criticalManualReviewClear
      && visualComparison.passed,
    scorePassed,
    gradePassed,
    veraPdfPassed,
    blockingFailureModesClear,
    blockingResidualFamiliesClear,
    criticalManualReviewClear,
    visualComparison,
    bookmarkValidation,
  }

  let failurePacket: FailurePacket | null = null
  if (!validation.passed) {
    const manualReviewFlags = detail.manualReviewFlags || []
    failurePacket = {
      filename: entry.filename,
      queueItemId: entry.queueItemId,
      latestAttemptPath: artifactPaths.pdfPath,
      latestQueueSummary: {
        score: detail.overallScore,
        grade: detail.grade,
        verapdfStatus: veraPdf.status,
        failedChecks: veraPdf.failedChecks,
      },
      topFailureModes: (detail.standardsDetail?.failureModes || []).slice(0, 8),
      topBlockingResidualFamilyIds: detail.standardsDetail?.plannerEvidence?.topBlockingResidualFamilyIds || [],
      topResidualFamilies: detail.standardsDetail?.plannerEvidence?.topResidualFamilySummaries || [],
      semanticSidecarState: manualReviewFlags.some(flag => flag.code === 'semantic_sidecar_unavailable')
        ? 'semantic_sidecar_unavailable'
        : manualReviewFlags.length
          ? 'not_flagged'
          : 'unknown',
      visualComparison,
      bookmarkValidation,
      freshPostRestartRemediation: entry.resultProvenance === 'current_session',
      generatedAt: nowIso(),
    }
    await fs.promises.writeFile(artifactPaths.failurePacketJsonPath, JSON.stringify(failurePacket, null, 2), 'utf8')
  }

  return {
    validation,
    downloadedPdfPath: artifactPaths.pdfPath,
    visualPaths: artifactPaths,
    failurePacket,
  }
}

export function shouldAcceptValidation(validation: ValidationResult): boolean {
  return validation.passed
}

export async function copyPassingOutputToComplete(downloadedPdfPath: string, completeDir: string, filename: string): Promise<string> {
  await fs.promises.mkdir(completeDir, { recursive: true })
  const destination = path.join(completeDir, filename)
  await fs.promises.copyFile(downloadedPdfPath, destination)
  return destination
}

export function buildFailurePacketSummary(packet: FailurePacket): string {
  const topFamily = (packet.topResidualFamilies || []).find(family => family.blocking) || packet.topResidualFamilies?.[0]
  if (topFamily) {
    const reason = topFamily.blockingReason || topFamily.evidenceSignals[0] || 'family_evidence'
    return `${packet.filename}: ${topFamily.id} (${reason}) | score ${packet.latestQueueSummary.score ?? '--'} | grade ${packet.latestQueueSummary.grade ?? '--'}`
  }
  const topFailure = packet.topFailureModes[0]?.label || 'validation failure'
  return `${packet.filename}: ${topFailure} | score ${packet.latestQueueSummary.score ?? '--'} | grade ${packet.latestQueueSummary.grade ?? '--'}`
}

export function updateTrackedEntryFromQueue(entry: TrackedPdfState, summary: QueueStatusSummary): TrackedPdfState {
  let lifecycleState: OrchestratorLifecycleState = entry.lifecycleState
  if (summary.state === 'uploading') lifecycleState = 'uploading'
  else if (summary.state === 'queued') lifecycleState = entry.loopCount > 0 ? 'rerunning' : 'queued'
  else if (summary.state === 'processing') {
    lifecycleState = /analysis|analyzing|finalizing/i.test(summary.processingStage || '') ? 'analyzing' : 'remediating'
  } else if (summary.state === 'complete' && lifecycleState !== 'done' && lifecycleState !== 'needs_fix') {
    lifecycleState = 'visual_compare'
  } else if (summary.state === 'failed') {
    lifecycleState = 'needs_fix'
  }

  return {
    ...entry,
    queueItemId: summary.id,
    lifecycleState,
    latestScore: summary.overallScore,
    latestGrade: summary.grade,
    latestProcessingStage: summary.processingStage,
    latestProcessingProgress: summary.processingProgress,
    lastUpdatedAt: nowIso(),
  }
}

export async function createInitialCampaignState(config: OrchestratorConfig): Promise<CampaignState> {
  const state = syncCampaignFiles(createEmptyCampaignState(config.apiBaseUrl), config.downloadsDir)
  saveCampaignState(config.stateFilePath, state)
  return state
}

export interface OrchestratorRunDependencies {
  client?: QueueApiClient
  sleep?: (ms: number) => Promise<void>
  stdout?: NodeJS.WriteStream
}

function readCurrentGitBranch(repoRoot: string): string {
  try {
    return fs.readFileSync(path.join(repoRoot, '.git', 'HEAD'), 'utf8').trim().split('/').at(-1) || 'unknown'
  } catch {
    return 'unknown'
  }
}

function entrySummaryLine(entry: TrackedPdfState): string {
  return `- ${entry.filename}: state=${entry.lifecycleState}, score=${entry.latestScore ?? '--'}, grade=${entry.latestGrade ?? '--'}, veraPDF=${entry.latestVeraPdfStatus ?? '--'}, attempt=${entry.attemptNumber}, loop=${entry.loopCount}`
}

function buildFailurePacketSummaryFromEntry(entry: TrackedPdfState): string {
  if (entry.latestFailurePacketPath) {
    try {
      const packet = JSON.parse(fs.readFileSync(entry.latestFailurePacketPath, 'utf8')) as FailurePacket
      return buildFailurePacketSummary(packet)
    } catch {
      // Fall through to the compact score summary when the packet is unavailable.
    }
  }
  return `${entry.filename}: score ${entry.latestScore ?? '--'}, grade ${entry.latestGrade ?? '--'}, veraPDF ${entry.latestVeraPdfStatus ?? '--'}`
}

export function renderProgressTrackerMarkdown(state: CampaignState, config: OrchestratorConfig, health: SystemHealth): string {
  const entries = Object.values(state.files).sort((a, b) => a.filename.localeCompare(b.filename, 'en', { sensitivity: 'base' }))
  const completed = entries.filter(entry => entry.lifecycleState === 'done')
  const active = entries.filter(entry => ['uploading', 'autofixing', 'remediating', 'analyzing', 'rerunning', 'visual_compare'].includes(entry.lifecycleState))
  const blocked = entries.filter(entry => entry.lifecycleState === 'blocked' || entry.lifecycleState === 'needs_fix' || entry.lifecycleState === 'awaiting_restart')
  const activeDisplay = active.slice(0, 4).map(entry => `\`${entry.filename}\``).join(', ') || 'None'
  const latestAttemptPaths = active
    .map(entry => entry.latestOutputPath || buildAttemptArtifactPaths(config.attemptsRootDir, entry.filename, entry.attemptNumber || 1).pdfPath)
    .map(filePath => `\`${path.relative(config.repoRoot, filePath)}\``)
    .join(', ') || 'None'
  const resultSummary = completed.length
    ? `${completed.length} file(s) accepted into Complete/; latest completed: ${completed.at(-1)?.filename || 'n/a'}`
    : 'No files accepted into Complete/ yet in this campaign state.'
  const lines: string[] = []
  lines.push('# Remediation Progress')
  lines.push('')
  lines.push('## Run Summary')
  lines.push('')
  lines.push('- Status: In progress')
  lines.push(`- Branch: \`${readCurrentGitBranch(config.repoRoot)}\``)
  lines.push('- Input folder: `Downloads/`')
  lines.push('- Final output folder: `Complete/`')
  lines.push('- Intermediate output folder: `MitigationAttempts/`')
  lines.push('- Mantra: ABI — Always Be Improving')
    lines.push(`- Completion threshold: score >= \`${config.targetScore}/100\`, grade \`A\`, no blocking accessibility debt, no critical manual-review debt, and visual page-1 fidelity`)
  lines.push('')
  lines.push('## Current Session Snapshot')
  lines.push('')
  lines.push(`- Active PDF: ${activeDisplay}`)
  lines.push(`- Latest attempt path: ${latestAttemptPaths}`)
  lines.push(`- Latest result summary: ${resultSummary}`)
  lines.push(`- Latest validation source: ${completed.length ? 'Fresh API remediation plus blocker-free accessibility validation plus visual compare; bookmark/process improvements may continue after Complete placement' : 'Awaiting first passing validation in current campaign state'}`)
  lines.push(`- Next action: ${blocked.length > 0 ? 'Autofix the current blocker batch, restart API, and rerun affected PDFs' : active.length > 0 ? 'Let the active API batch finish and validate outputs' : 'Queue the next PDFs from Downloads through the API'}`)
  lines.push(`- Next hypothesis: ${blocked[0] ? trimForDisplay(blocked[0].latestBookmarkValidation?.reason || blocked[0].latestVisualComparison?.reason || 'Generic remediation gap needs a system fix', 160) : 'Keep improving shared remediation quality while preserving visual fidelity.'}`)
  lines.push(`- API restart status: ${state.lastApiRestartAt ? `Last restart recorded at ${state.lastApiRestartAt}` : 'No orchestrator-managed restart recorded yet'}`)
  lines.push('- Build status: Restart preferred; rebuild only if stale behavior persists after restart')
  lines.push('')
  lines.push('## Current Concurrency')
  lines.push('')
  lines.push(`- Active parallel PDF jobs: ${health.activeConcurrency} active`)
  lines.push(`- CPU/memory notes: load ${(health.loadRatio * 100).toFixed(0)}%, memory ${(health.memoryUsageRatio * 100).toFixed(0)}%`)
  lines.push(`- Last adjustment: current cap ${state.currentConcurrencyCap}`)
  lines.push(`- In-flight PDFs before restart: ${activeDisplay}`)
  lines.push('')
  lines.push('## Current Focus')
  lines.push('')
  lines.push(`- Active PDF: ${activeDisplay}`)
  lines.push(`- Current phase: ${blocked.length > 0 ? 'Autofix / rerun loop' : active.length > 0 ? 'API remediation and validation' : 'Queue preparation'}`)
  lines.push(`- Immediate next step: ${blocked.length > 0 ? 'Run Codex autofix on failure packets, then restart PM2 API and rerun' : active.length > 0 ? 'Validate the next completed outputs and move any >= target score matches into Complete immediately' : 'Upload the next eligible PDFs from Downloads'}`)
  lines.push(`- API restart/rerun confirmed for active file: ${state.lastApiRestartAt ? 'Yes' : 'No'}`)
  lines.push('- Rebuild required for active file: No')
  lines.push(`- Active remediation loop count: ${active.map(entry => `${entry.filename}=${entry.loopCount}`).join(', ') || 'None'}`)
  lines.push(`- Next hypothesis: ${blocked[0] ? trimForDisplay(buildFailurePacketSummaryFromEntry(blocked[0]), 160) : 'Continue batch remediation and validation.'}`)
  lines.push('')
  lines.push('## Pending Files')
  lines.push('')
  lines.push('- Default order: alphabetical unless reprioritized here.')
  lines.push(`- Remaining files: ${entries.filter(entry => entry.lifecycleState !== 'done').length}`)
  lines.push('')
  lines.push('## In Progress')
  lines.push('')
  if (active.length === 0) lines.push('- None')
  else active.forEach(entry => lines.push(entrySummaryLine(entry)))
  lines.push('')
  lines.push('## Blockers')
  lines.push('')
  if (blocked.length === 0) lines.push('- None')
  else blocked.forEach(entry => lines.push(entrySummaryLine(entry)))
  lines.push('')
  lines.push('## Completed Files')
  lines.push('')
  if (completed.length === 0) lines.push('- None')
  else completed.forEach(entry => lines.push(entrySummaryLine(entry)))
  lines.push('')
  lines.push('## Recent Events')
  lines.push('')
  if (state.recentEvents.length === 0) lines.push('- None')
  else state.recentEvents.slice(-15).forEach(event => lines.push(`- ${event}`))
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- This file is orchestrator-managed and updated continuously during unattended runs.')
  lines.push('- Use `MitigationAttempts/orchestrator-state.json` for the full machine-readable campaign state.')
  return lines.join('\n')
}

async function writeProgressTracker(state: CampaignState, config: OrchestratorConfig, health: SystemHealth): Promise<void> {
  const markdown = renderProgressTrackerMarkdown(state, config, health)
  await fs.promises.writeFile(config.progressTrackerPath, markdown, 'utf8')
}

async function runCommand(command: string, args: string[], options: {
  cwd: string
  stdinText?: string
  outputPath?: string
  heartbeatMs?: number
  onHeartbeat?: (payload: { elapsedMs: number; stdout: string; stderr: string }) => Promise<void> | void
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    let settled = false
    const startedAt = Date.now()
    const finish = async (payload: { code: number; stdout: string; stderr: string }) => {
      if (settled) return
      settled = true
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (options.outputPath) {
        await fs.promises.mkdir(path.dirname(options.outputPath), { recursive: true })
        await fs.promises.writeFile(options.outputPath, `${payload.stdout}${payload.stderr}`, 'utf8')
      }
      resolve(payload)
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const heartbeatTimer = options.onHeartbeat
      ? setInterval(() => {
          void options.onHeartbeat?.({
            elapsedMs: Date.now() - startedAt,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
          })
        }, Math.max(1000, options.heartbeatMs ?? 5000))
      : null
    child.stdout.on('data', chunk => stdoutChunks.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderrChunks.push(Buffer.from(chunk)))
    child.on('error', async error => {
      await finish({
        code: 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `${Buffer.concat(stderrChunks).toString('utf8')}\n${error instanceof Error ? error.stack || error.message : String(error)}`.trim(),
      })
    })
    child.on('close', async code => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      await finish({ code: code ?? 1, stdout, stderr })
    })
    if (options.stdinText) child.stdin.end(options.stdinText)
    else child.stdin.end()
  })
}

function buildAutofixPrompt(state: CampaignState, config: OrchestratorConfig, entries: TrackedPdfState[]): string {
  const packetPaths = entries.map(entry => entry.latestFailurePacketPath).filter((value): value is string => !!value)
  const attemptPaths = entries.map(entry => entry.latestOutputPath || buildAttemptArtifactPaths(config.attemptsRootDir, entry.filename, entry.attemptNumber).pdfPath)
  return [
    'Follow AGENTS.md and keep ABI: Always Be Improving.',
    'Work on the current blocker batch for the unattended remediation campaign.',
    'Use the API/frontend remediation path, not direct one-off PDF edits.',
    'Target PDFs:',
    ...entries.map(entry => `- ${entry.filename}`),
    'Failure packets:',
    ...packetPaths.map(filePath => `- ${filePath}`),
    'Latest attempt PDFs:',
    ...attemptPaths.map(filePath => `- ${filePath}`),
    'Required outcome for this fix pass:',
    '- Inspect the failure packets and latest attempts.',
    '- Update API/services/scripts generically so this blocker family is handled in future runs.',
    '- Run the most relevant targeted verification.',
    '- Update REMEDIATION_PROGRESS.md.',
    '- Commit and push any system fix you make.',
    '- Do not start a long-running server.',
    '- Do not directly mutate source PDFs in Downloads.',
    'When finished, summarize: what changed, what was verified, and whether the orchestrator should restart the API and rerun the affected PDFs.',
  ].join('\n')
}

function latestAutofixLogPath(config: OrchestratorConfig): string {
  return path.join(config.attemptsRootDir, 'autofix-last.log')
}

async function runAutofixPass(
  state: CampaignState,
  config: OrchestratorConfig,
  entries: TrackedPdfState[],
  onHeartbeat?: (payload: { elapsedMs: number; stdout: string; stderr: string }) => Promise<void> | void,
): Promise<{ success: boolean; output: string }> {
  const prompt = buildAutofixPrompt(state, config, entries)
  const outputPath = latestAutofixLogPath(config)
  const result = await runCommand(config.codexBinary, [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '-C',
    config.repoRoot,
    '-o',
    path.join(config.attemptsRootDir, 'autofix-last-message.txt'),
    '-',
  ], {
    cwd: config.repoRoot,
    stdinText: prompt,
    outputPath,
    heartbeatMs: 5000,
    onHeartbeat,
  })
  return {
    success: result.code === 0,
    output: `${result.stdout}\n${result.stderr}`.trim(),
  }
}

async function restartApi(config: OrchestratorConfig): Promise<void> {
  const result = await runCommand('pm2', ['restart', config.pm2AppName], { cwd: config.repoRoot })
  if (result.code !== 0) throw new Error(`PM2 restart failed: ${result.stderr || result.stdout}`)
}

async function waitForApiHealthy(client: QueueApiClient, timeoutMs: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const health = await client.health()
      if (health.status === 'ok') return
    } catch {}
    await sleep(2000)
  }
  throw new Error(`API did not become healthy within ${timeoutMs}ms`)
}

function markEntriesAwaitingRestart(state: CampaignState, filenames: string[]): CampaignState {
  const next = { ...state, files: { ...state.files } }
  for (const filename of filenames) {
    const entry = next.files[filename]
    if (!entry) continue
    next.files[filename] = {
      ...entry,
      lifecycleState: 'awaiting_restart',
      resultProvenance: 'stale_after_restart',
      validationStage: 'idle',
      lastUpdatedAt: nowIso(),
    }
  }
  return next
}

async function queueAwaitingRestartEntries(client: QueueApiClient, state: CampaignState): Promise<CampaignState> {
  const next = { ...state, files: { ...state.files } }
  const awaiting = Object.values(state.files).filter(entry => entry.lifecycleState === 'awaiting_restart')
  if (!awaiting.length) return state

  const rerunIds = awaiting.filter(entry => entry.queueItemId).map(entry => entry.queueItemId!)
  if (rerunIds.length) {
    await client.remediateMany(rerunIds)
  }

  for (const entry of awaiting) {
    if (entry.queueItemId) {
      next.files[entry.filename] = {
        ...entry,
        lifecycleState: 'rerunning',
        validationStage: 'idle',
        resultProvenance: 'current_session',
        latestProcessingStage: 'Queued post-fix rerun',
        latestProcessingProgress: 1,
        lastUpdatedAt: nowIso(),
      }
      continue
    }

    const uploaded = await client.uploadPdf(entry.sourcePath)
    next.files[entry.filename] = {
      ...entry,
      queueItemId: uploaded.id,
      attemptNumber: entry.attemptNumber + 1,
      loopCount: entry.loopCount + 1,
      lifecycleState: 'uploading',
      validationStage: 'idle',
      resultProvenance: 'current_session',
      latestProcessingStage: 'Uploading post-fix rerun',
      latestProcessingProgress: 1,
      queuedAt: nowIso(),
      lastUpdatedAt: nowIso(),
    }
  }
  return next
}

function markAffectedQueueItemsStale(state: CampaignState, filenames: string[]): void {
  const ids = filenames
    .map(filename => state.files[filename]?.queueItemId)
    .filter((value): value is string => !!value)
  if (!ids.length) return
  markQueueItemsResultFreshness(ids, 'stale_after_restart')
}


export async function runRemediationOrchestrator(config: OrchestratorConfig, deps: OrchestratorRunDependencies = {}): Promise<void> {
  const client = deps.client || new QueueApiClient({ baseUrl: config.apiBaseUrl })
  const sleep = deps.sleep || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  const stdout = deps.stdout || process.stdout

  let state = recoverInterruptedCampaignState(
    syncCampaignFiles(loadCampaignState(config.stateFilePath, config.apiBaseUrl), config.downloadsDir),
  )
  if (!client.getSession()) {
    const session = await client.bootstrap(state.session?.clientId || undefined)
    state.session = session
    state = appendEvent(state, `API session ready for client ${session.clientId}`)
    saveCampaignState(config.stateFilePath, state)
  } else {
    state.session = client.getSession()
  }

  while (true) {
    let apiStatus: 'ok' | 'unavailable' = 'ok'
    let concurrencyCap = state.currentConcurrencyCap
    try {
      let scheduledRerunsThisLoop = false
      try {
        await client.health()
      } catch {
        apiStatus = 'unavailable'
      }

      concurrencyCap = determineConcurrencyCap(config)
      state.currentConcurrencyCap = concurrencyCap
      const queueStatus = apiStatus === 'ok' ? await client.queueStatus() : { items: [], counts: { active: 0, history: 0, processing: 0, failed: 0, complete: 0 }, generatedAt: nowIso() }
      const queueByFilename = new Map(queueStatus.items.map(item => [item.filename, item]))

      for (const [filename, entry] of Object.entries(state.files)) {
        const summary = queueByFilename.get(filename)
        if (summary) {
          state.files[filename] = updateTrackedEntryFromQueue(entry, summary)
        }
      }

      const activeCount = Object.values(state.files).filter(entry =>
        entry.lifecycleState === 'uploading'
        || entry.lifecycleState === 'autofixing'
        || entry.lifecycleState === 'remediating'
        || entry.lifecycleState === 'analyzing'
        || entry.lifecycleState === 'rerunning',
      ).length
      const hasRerunBarrier = Object.values(state.files).some(entry => entry.lifecycleState === 'awaiting_restart')

      if (!config.validateOnly && apiStatus === 'ok' && activeCount === 0) {
        const awaitingRestart = Object.values(state.files).filter(entry => entry.lifecycleState === 'awaiting_restart' && entry.queueItemId)
        const awaitingAnyRestart = Object.values(state.files).filter(entry => entry.lifecycleState === 'awaiting_restart')
        if (awaitingAnyRestart.length > 0) {
          state = appendEvent(state, `Scheduling reruns after restart: ${awaitingAnyRestart.map(entry => entry.filename).join(', ')}`)
          state = await queueAwaitingRestartEntries(client, state)
          scheduledRerunsThisLoop = true
        } else if (config.autoFixEnabled) {
          const needsFix = Object.values(state.files)
            .filter(entry => (entry.lifecycleState === 'needs_fix' || entry.lifecycleState === 'blocked') && entry.latestFailurePacketPath)
            .sort((a, b) => a.filename.localeCompare(b.filename, 'en', { sensitivity: 'base' }))
            .slice(0, config.autoFixBatchSize)
          if (needsFix.length > 0) {
            for (const entry of needsFix) {
              state.files[entry.filename] = {
                ...state.files[entry.filename],
                lifecycleState: 'autofixing',
                latestProcessingStage: 'Running Codex autofix',
                lastUpdatedAt: nowIso(),
              }
            }
            state = appendEvent(state, `Autofix batch started: ${needsFix.map(entry => entry.filename).join(', ')}`)
            saveCampaignState(config.stateFilePath, state)
            const preAutofixHealth = collectSystemHealth(apiStatus, activeCount, concurrencyCap)
            await writeProgressTracker(state, config, preAutofixHealth)
            stdout.write('\x1b[2J\x1b[H')
            stdout.write(`${renderDashboard(state, preAutofixHealth)}\n`)
            const autofix = await runAutofixPass(state, config, needsFix, async ({ elapsedMs, stdout: childStdout, stderr: childStderr }) => {
              const elapsedSeconds = Math.floor(elapsedMs / 1000)
              const mm = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')
              const ss = String(elapsedSeconds % 60).padStart(2, '0')
              const lastOutputLine = `${childStdout}\n${childStderr}`
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)
                .at(-1)
              for (const entry of needsFix) {
                state.files[entry.filename] = {
                  ...state.files[entry.filename],
                  latestProcessingStage: `Running Codex autofix (${mm}:${ss})${lastOutputLine ? ` - ${trimForDisplay(lastOutputLine, 48)}` : ''}`,
                  latestProcessingProgress: 100,
                  lastUpdatedAt: nowIso(),
                }
              }
              state = appendEvent(
                state,
                `Autofix heartbeat (${mm}:${ss}) for: ${needsFix.map(entry => entry.filename).join(', ')}${lastOutputLine ? ` | ${trimForDisplay(lastOutputLine, 80)}` : ''}`,
              )
              saveCampaignState(config.stateFilePath, state)
              const heartbeatHealth = collectSystemHealth(apiStatus, needsFix.length, concurrencyCap)
              await writeProgressTracker(state, config, heartbeatHealth)
              stdout.write('\x1b[2J\x1b[H')
              stdout.write(`${renderDashboard(state, heartbeatHealth)}\n`)
            })
            if (autofix.success) {
              state = appendEvent(state, `Autofix batch completed: ${needsFix.map(entry => entry.filename).join(', ')}`)
              state = markEntriesAwaitingRestart(state, needsFix.map(entry => entry.filename))
              markAffectedQueueItemsStale(state, needsFix.map(entry => entry.filename))
              state = appendEvent(state, `Autofix completed; restart and rerun required for: ${needsFix.map(entry => entry.filename).join(', ')}`)
              saveCampaignState(config.stateFilePath, state)
              try {
                await restartApi(config)
                state.lastApiRestartAt = nowIso()
                const session = await client.bootstrap(state.session?.clientId || undefined)
                state.session = session
                await waitForApiHealthy(client, config.apiRestartWaitMs, sleep)
                state = appendEvent(state, `API restarted successfully; reruns pending for: ${needsFix.map(entry => entry.filename).join(', ')}`)
              } catch (restartError) {
                state = appendEvent(state, `Restart/rerun staging failed: ${trimForDisplay(restartError instanceof Error ? restartError.stack || restartError.message : String(restartError), 160)}`)
              }
            } else {
              state = appendEvent(state, `Autofix batch failed: ${trimForDisplay(autofix.output || 'codex exec failed', 140)}`)
              for (const entry of needsFix) {
                state.files[entry.filename] = {
                  ...state.files[entry.filename],
                  lifecycleState: 'blocked',
                  latestProcessingStage: 'Autofix failed',
                  lastUpdatedAt: nowIso(),
                }
              }
            }
          }
        }
      }

      if (!config.validateOnly && apiStatus === 'ok' && activeCount < concurrencyCap && !hasRerunBarrier && !scheduledRerunsThisLoop) {
        const available = concurrencyCap - activeCount
        const candidates = Object.values(state.files)
          .filter(entry => entry.lifecycleState === 'queued' && !entry.queueItemId)
          .sort((a, b) => a.filename.localeCompare(b.filename, 'en', { sensitivity: 'base' }))
          .slice(0, available)
        for (const entry of candidates) {
          const uploaded = await client.uploadPdf(entry.sourcePath)
          state.files[entry.filename] = {
            ...entry,
            queueItemId: uploaded.id,
            attemptNumber: entry.attemptNumber + 1,
            loopCount: entry.loopCount + 1,
            lifecycleState: 'uploading',
            latestProcessingStage: 'Uploading',
            latestProcessingProgress: 1,
            resultProvenance: 'current_session',
            queuedAt: nowIso(),
            lastUpdatedAt: nowIso(),
          }
          state = appendEvent(state, `Upload started: ${entry.filename}`)
        }
      }

      const completedEntries = Object.values(state.files).filter(entry =>
        entry.queueItemId
        && entry.lifecycleState === 'visual_compare'
        && entry.validationStage === 'idle',
      )

      for (const entry of completedEntries) {
        state.files[entry.filename] = { ...entry, validationStage: 'downloading_output', lastUpdatedAt: nowIso() }
        saveCampaignState(config.stateFilePath, state)
        try {
          state.files[entry.filename] = { ...state.files[entry.filename], validationStage: 'rendering_original_page_1' }
          saveCampaignState(config.stateFilePath, state)
          state.files[entry.filename] = { ...state.files[entry.filename], validationStage: 'rendering_remediated_page_1' }
          saveCampaignState(config.stateFilePath, state)
          state.files[entry.filename] = { ...state.files[entry.filename], validationStage: 'visual_compare' }
          saveCampaignState(config.stateFilePath, state)
          state.files[entry.filename] = { ...state.files[entry.filename], validationStage: 'bookmark_validation' }
          saveCampaignState(config.stateFilePath, state)
          const outcome = await runValidationPipeline(client, state.files[entry.filename], config)
          state.files[entry.filename] = {
            ...state.files[entry.filename],
            validationStage: 'finalizing',
            latestOutputPath: outcome.downloadedPdfPath,
            latestFailurePacketPath: outcome.visualPaths.failurePacketJsonPath,
            latestVisualComparison: outcome.validation.visualComparison,
            latestBookmarkValidation: outcome.validation.bookmarkValidation,
            latestValidationPassed: outcome.validation.passed,
            latestVeraPdfStatus: currentVeraPdfStatus(await client.queueItemDetail(entry.queueItemId!)).status,
          }
          if (shouldAcceptValidation(outcome.validation)) {
            await copyPassingOutputToComplete(outcome.downloadedPdfPath, config.completeDir, entry.filename)
            state.files[entry.filename] = {
              ...state.files[entry.filename],
              lifecycleState: 'done',
              validationStage: 'idle',
              latestFailurePacketPath: null,
              lastUpdatedAt: nowIso(),
            }
            state = appendEvent(state, `Moved to Complete: ${entry.filename}`)
          } else {
            state.files[entry.filename] = {
              ...state.files[entry.filename],
              lifecycleState: 'needs_fix',
              validationStage: 'idle',
              latestFailurePacketPath: outcome.failurePacket ? outcome.visualPaths.failurePacketJsonPath : null,
              lastUpdatedAt: nowIso(),
            }
            if (outcome.failurePacket) {
              state = appendEvent(state, `Needs fix: ${buildFailurePacketSummary(outcome.failurePacket)}`)
            }
          }
        } catch (error) {
          state.files[entry.filename] = {
            ...state.files[entry.filename],
            lifecycleState: 'blocked',
            validationStage: 'idle',
            lastUpdatedAt: nowIso(),
          }
          state = appendEvent(state, `Blocked: ${entry.filename} (${error instanceof Error ? error.message : String(error)})`)
        }
      }

      saveCampaignState(config.stateFilePath, state)
      const health = collectSystemHealth(apiStatus, activeCount, concurrencyCap)
      await writeProgressTracker(state, config, health)
      stdout.write('\x1b[2J\x1b[H')
      stdout.write(`${renderDashboard(state, health)}\n`)

      const allDone = Object.values(state.files).length > 0 && Object.values(state.files).every(entry => entry.lifecycleState === 'done')
      if (allDone) return
    } catch (error) {
      if (isExpiredSessionError(error)) {
        try {
          const session = await client.bootstrap(state.session?.clientId || undefined)
          state.session = session
          state = appendEvent(state, `API session renewed for client ${session.clientId}`)
          saveCampaignState(config.stateFilePath, state)
          await writeProgressTracker(state, config, collectSystemHealth('ok', 0, concurrencyCap))
          stdout.write('\x1b[2J\x1b[H')
          stdout.write(`${renderDashboard(state, collectSystemHealth('ok', 0, concurrencyCap))}\n`)
          await sleep(1000)
          continue
        } catch (renewError) {
          state = appendEvent(
            state,
            `Session renewal failed: ${trimForDisplay(renewError instanceof Error ? renewError.stack || renewError.message : String(renewError), 180)}`,
          )
          saveCampaignState(config.stateFilePath, state)
          await writeProgressTracker(state, config, collectSystemHealth('unavailable', 0, concurrencyCap))
          await sleep(config.pollIntervalMs)
          continue
        }
      }
      state = appendEvent(state, `Loop error recovered: ${trimForDisplay(error instanceof Error ? error.stack || error.message : String(error), 180)}`)
      saveCampaignState(config.stateFilePath, state)
      await writeProgressTracker(state, config, collectSystemHealth(apiStatus, 0, concurrencyCap))
    }

    await sleep(config.pollIntervalMs)
  }
}
