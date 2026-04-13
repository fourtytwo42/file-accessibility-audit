import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

export type RemediationResultBand =
  | 'pass_ge_90'
  | 'keep_fail_80_to_89'
  | 'drop_fail_lt_80'
  | 'processing_error'
  | 'source_missing'

export type RemediationProgressState = 'running' | 'completed' | 'stale'
export type RemediationVisibleRunState = 'not_started' | 'running' | 'stale' | 'completed'

export interface RemediationScorePolicy {
  minPassOverallScore: number | null
  minKeepOverallScore: number | null
}

export interface ProgressLastCompleted {
  publicationId: string | null
  publicationTitle: string | null
  status: string
  resultBand: RemediationResultBand
  finalOverallScore: number | null
  processedAt: string
  durationMs: number
}

export interface RemediationBatchProgressDocument {
  runId: string
  state: RemediationProgressState
  pid: number | null
  manifestPath: string
  outcomesPath: string
  firstStartedAt: string
  currentSessionStartedAt: string | null
  accumulatedActiveRuntimeMs: number
  lastHeartbeatAt: string
  totalCandidates: number
  processed: number
  remaining: number
  activeWorkers: number
  scorePolicy: RemediationScorePolicy
  countsByResultBand: Record<RemediationResultBand, number>
  lastCompleted: ProgressLastCompleted | null
}

export interface ProgressCompatibleOutcome {
  publicationId?: string | null
  publicationTitle?: string | null
  status?: string | null
  resultBand?: RemediationResultBand | null
  processedAt?: string | null
  durationMs?: number | null
  final?: {
    overallScore?: number | null
  } | null
  gate?: {
    passed?: boolean | null
  } | null
}

export interface RemediationBatchStatusSnapshot {
  runState: RemediationVisibleRunState
  runId: string | null
  pid: number | null
  manifestPath: string
  outcomesPath: string
  progressPath: string
  scorePolicy: RemediationScorePolicy
  firstStartedAt: string | null
  currentSessionStartedAt: string | null
  lastHeartbeatAt: string | null
  processed: number
  total: number
  remaining: number
  activeWorkers: number
  countsByResultBand: Record<RemediationResultBand, number>
  effectiveActiveRuntimeMs: number
  pdfsPerHour: number | null
  etaMs: number | null
  percentComplete: number
  lastCompleted: ProgressLastCompleted | null
}

export function emptyResultBandCounts(): Record<RemediationResultBand, number> {
  return {
    pass_ge_90: 0,
    keep_fail_80_to_89: 0,
    drop_fail_lt_80: 0,
    processing_error: 0,
    source_missing: 0,
  }
}

export function processIsAlive(pid: number | null | undefined): boolean {
  if (!Number.isFinite(pid) || Number(pid) <= 0) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function safeNumber(value: number | null | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

export function classifyOutcomeResultBand(input: {
  status: string | null | undefined
  finalOverallScore?: number | null
  gatePassed?: boolean | null
}): RemediationResultBand {
  const status = String(input.status || '').trim()
  if (status === 'source_missing') return 'source_missing'
  if (status === 'processing_error') return 'processing_error'
  if (input.gatePassed) return 'pass_ge_90'

  const score = safeNumber(input.finalOverallScore, Number.NaN)
  if (Number.isFinite(score) && score >= 80) return 'keep_fail_80_to_89'
  return 'drop_fail_lt_80'
}

export function inferOutcomeResultBand(outcome: ProgressCompatibleOutcome): RemediationResultBand {
  if (outcome.resultBand) return outcome.resultBand
  return classifyOutcomeResultBand({
    status: outcome.status,
    finalOverallScore: outcome.final?.overallScore ?? null,
    gatePassed: outcome.gate?.passed ?? null,
  })
}

export function countOutcomeResultBands(
  outcomes: ProgressCompatibleOutcome[],
): Record<RemediationResultBand, number> {
  const counts = emptyResultBandCounts()
  for (const outcome of outcomes) {
    counts[inferOutcomeResultBand(outcome)] += 1
  }
  return counts
}

function completedFromOutcome(outcome: ProgressCompatibleOutcome | null | undefined): ProgressLastCompleted | null {
  if (!outcome) return null
  return {
    publicationId: outcome.publicationId ?? null,
    publicationTitle: outcome.publicationTitle ?? null,
    status: String(outcome.status || ''),
    resultBand: inferOutcomeResultBand(outcome),
    finalOverallScore: outcome.final?.overallScore ?? null,
    processedAt: String(outcome.processedAt || ''),
    durationMs: safeNumber(outcome.durationMs, 0),
  }
}

function closedSessionRuntimeMs(progress: RemediationBatchProgressDocument): number {
  const startedAtMs = parseIsoMs(progress.currentSessionStartedAt)
  if (startedAtMs == null) return 0
  const heartbeatMs = parseIsoMs(progress.lastHeartbeatAt) ?? startedAtMs
  return Math.max(0, heartbeatMs - startedAtMs)
}

export function deriveVisibleRunState(
  progress: RemediationBatchProgressDocument | null | undefined,
  nowMs = Date.now(),
  isAlive: (pid: number | null | undefined) => boolean = processIsAlive,
): RemediationVisibleRunState {
  if (!progress) return 'not_started'
  if (progress.state === 'completed') return 'completed'
  if (isAlive(progress.pid)) return 'running'

  const startedAtMs = parseIsoMs(progress.currentSessionStartedAt)
  const heartbeatMs = parseIsoMs(progress.lastHeartbeatAt)
  if (startedAtMs != null && heartbeatMs != null && heartbeatMs >= startedAtMs && heartbeatMs <= nowMs) {
    return 'stale'
  }
  if (progress.processed > 0 || progress.totalCandidates > 0) return 'stale'
  return 'not_started'
}

export function effectiveActiveRuntimeMs(
  progress: RemediationBatchProgressDocument | null | undefined,
  nowMs = Date.now(),
  isAlive: (pid: number | null | undefined) => boolean = processIsAlive,
): number {
  if (!progress) return 0
  const base = safeNumber(progress.accumulatedActiveRuntimeMs, 0)
  const startedAtMs = parseIsoMs(progress.currentSessionStartedAt)
  if (startedAtMs == null) return base
  const visibleState = deriveVisibleRunState(progress, nowMs, isAlive)
  if (visibleState === 'running') return base + Math.max(0, nowMs - startedAtMs)
  return base + closedSessionRuntimeMs(progress)
}

export function createOrResumeProgressDocument(input: {
  existingProgress?: RemediationBatchProgressDocument | null
  manifestPath: string
  outcomesPath: string
  totalCandidates: number
  processed: number
  remaining: number
  countsByResultBand: Record<RemediationResultBand, number>
  scorePolicy: RemediationScorePolicy
  pid: number
  activeWorkers?: number
  lastCompleted?: ProgressLastCompleted | null
  now?: Date
  enforceSingleOwner?: boolean
  isAlive?: (pid: number | null | undefined) => boolean
}): RemediationBatchProgressDocument {
  const now = input.now || new Date()
  const nowIso = now.toISOString()
  const isAlive = input.isAlive || processIsAlive
  const existing = input.existingProgress || null
  const visibleState = deriveVisibleRunState(existing, now.getTime(), isAlive)

  if (input.enforceSingleOwner && existing && visibleState === 'running' && existing.pid && existing.pid !== input.pid) {
    throw new Error(`Another remediation run is already active (pid ${existing.pid}) for ${existing.manifestPath}.`)
  }

  const carriedRuntimeMs = existing
    ? safeNumber(existing.accumulatedActiveRuntimeMs, 0) + (visibleState === 'stale' ? closedSessionRuntimeMs(existing) : 0)
    : 0

  return {
    runId: existing && visibleState !== 'completed' ? existing.runId : crypto.randomUUID(),
    state: 'running',
    pid: input.pid,
    manifestPath: input.manifestPath,
    outcomesPath: input.outcomesPath,
    firstStartedAt: existing && visibleState !== 'completed' ? existing.firstStartedAt : nowIso,
    currentSessionStartedAt: nowIso,
    accumulatedActiveRuntimeMs: carriedRuntimeMs,
    lastHeartbeatAt: nowIso,
    totalCandidates: input.totalCandidates,
    processed: input.processed,
    remaining: input.remaining,
    activeWorkers: safeNumber(input.activeWorkers, 0),
    scorePolicy: input.scorePolicy,
    countsByResultBand: { ...input.countsByResultBand },
    lastCompleted: input.lastCompleted ?? existing?.lastCompleted ?? null,
  }
}

export function updateProgressDocument(
  progress: RemediationBatchProgressDocument,
  input: {
    state?: RemediationProgressState
    pid?: number | null
    totalCandidates: number
    processed: number
    remaining: number
    activeWorkers: number
    countsByResultBand: Record<RemediationResultBand, number>
    lastCompleted?: ProgressLastCompleted | null
    heartbeatAt?: Date
  },
): RemediationBatchProgressDocument {
  const heartbeatAt = (input.heartbeatAt || new Date()).toISOString()
  return {
    ...progress,
    state: input.state || progress.state,
    pid: input.pid === undefined ? progress.pid : input.pid,
    totalCandidates: input.totalCandidates,
    processed: input.processed,
    remaining: input.remaining,
    activeWorkers: input.activeWorkers,
    countsByResultBand: { ...input.countsByResultBand },
    lastCompleted: input.lastCompleted === undefined ? progress.lastCompleted : input.lastCompleted,
    lastHeartbeatAt: heartbeatAt,
  }
}

export function finalizeProgressDocument(
  progress: RemediationBatchProgressDocument,
  input: {
    state: 'completed' | 'stale'
    totalCandidates: number
    processed: number
    remaining: number
    activeWorkers: number
    countsByResultBand: Record<RemediationResultBand, number>
    lastCompleted?: ProgressLastCompleted | null
    endedAt?: Date
  },
): RemediationBatchProgressDocument {
  const endedAt = input.endedAt || new Date()
  const endedAtIso = endedAt.toISOString()
  const startedAtMs = parseIsoMs(progress.currentSessionStartedAt)
  const endedAtMs = endedAt.getTime()
  const sessionRuntimeMs = startedAtMs == null ? 0 : Math.max(0, endedAtMs - startedAtMs)

  return {
    ...progress,
    state: input.state,
    pid: null,
    currentSessionStartedAt: null,
    accumulatedActiveRuntimeMs: safeNumber(progress.accumulatedActiveRuntimeMs, 0) + sessionRuntimeMs,
    totalCandidates: input.totalCandidates,
    processed: input.processed,
    remaining: input.remaining,
    activeWorkers: input.activeWorkers,
    countsByResultBand: { ...input.countsByResultBand },
    lastCompleted: input.lastCompleted === undefined ? progress.lastCompleted : input.lastCompleted,
    lastHeartbeatAt: endedAtIso,
  }
}

export function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

export function buildBatchStatusSnapshot(input: {
  manifestPath: string
  outcomesPath: string
  progressPath: string
  totalCandidates: number
  outcomes: ProgressCompatibleOutcome[]
  progress?: RemediationBatchProgressDocument | null
  now?: Date
  isAlive?: (pid: number | null | undefined) => boolean
  defaultScorePolicy?: RemediationScorePolicy
}): RemediationBatchStatusSnapshot {
  const now = input.now || new Date()
  const isAlive = input.isAlive || processIsAlive
  const progress = input.progress || null
  const processed = input.outcomes.length || progress?.processed || 0
  const total = safeNumber(input.totalCandidates, progress?.totalCandidates || 0)
  const remaining = Math.max(0, total - processed)
  let runState = deriveVisibleRunState(progress, now.getTime(), isAlive)
  if (total > 0 && remaining === 0) runState = 'completed'
  else if (!progress && processed > 0) runState = 'stale'
  const countsByResultBand = input.outcomes.length
    ? countOutcomeResultBands(input.outcomes)
    : progress?.countsByResultBand || emptyResultBandCounts()
  const effectiveRuntime = effectiveActiveRuntimeMs(progress, now.getTime(), isAlive)
  const pdfsPerHour = processed > 0 && effectiveRuntime > 0
    ? Number(((processed * 60 * 60 * 1000) / effectiveRuntime).toFixed(2))
    : null
  const etaMs = pdfsPerHour && pdfsPerHour > 0 && remaining > 0
    ? Math.round((remaining / pdfsPerHour) * 60 * 60 * 1000)
    : null

  return {
    runState,
    runId: progress?.runId || null,
    pid: progress?.pid ?? null,
    manifestPath: input.manifestPath,
    outcomesPath: input.outcomesPath,
    progressPath: input.progressPath,
    scorePolicy: progress?.scorePolicy || input.defaultScorePolicy || {
      minPassOverallScore: 90,
      minKeepOverallScore: 80,
    },
    firstStartedAt: progress?.firstStartedAt || null,
    currentSessionStartedAt: progress?.currentSessionStartedAt || null,
    lastHeartbeatAt: progress?.lastHeartbeatAt || null,
    processed,
    total,
    remaining,
    activeWorkers: runState === 'running' ? safeNumber(progress?.activeWorkers, 0) : 0,
    countsByResultBand,
    effectiveActiveRuntimeMs: effectiveRuntime,
    pdfsPerHour,
    etaMs,
    percentComplete: total > 0 ? Number(((processed / total) * 100).toFixed(1)) : 0,
    lastCompleted: progress?.lastCompleted || completedFromOutcome(input.outcomes.at(-1)) || null,
  }
}

export function formatDurationCompact(durationMs: number | null | undefined): string {
  const ms = safeNumber(durationMs, 0)
  if (ms <= 0) return '0s'
  const totalSeconds = Math.round(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (parts.length === 0 || (days === 0 && hours === 0)) parts.push(`${seconds}s`)
  return parts.slice(0, 3).join(' ')
}
