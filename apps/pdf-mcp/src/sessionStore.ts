import { createHash, randomUUID } from 'node:crypto'
import type { AnalysisResult } from '../../api/src/services/pdfAnalyzer.ts'
import type {
  PdfRemediationContext,
  RemediationInspectionCache,
} from '../../api/src/services/pdfRemediationTools.ts'

export interface PdfSession {
  id: string
  buffer: Buffer
  filename: string
  /** Shared with inspectPdfForRemediation for cache hits within a session. */
  inspectionCache: RemediationInspectionCache
  /** Cleared after successful mutation. */
  contextCache: PdfRemediationContext | null
  lastAnalysis: AnalysisResult | null
  actionLog: Array<{
    at: string
    tool: string
    outcome: string
    details: string
  }>
}

const sessions = new Map<string, PdfSession>()

export function maxSessions(): number {
  const raw = process.env.PDF_MCP_MAX_SESSIONS
  const n = raw ? Number.parseInt(raw, 10) : 16
  return Number.isFinite(n) && n > 0 ? n : 16
}

export function maxUndoDepth(): number {
  const raw = process.env.PDF_MCP_MAX_UNDO
  const n = raw ? Number.parseInt(raw, 10) : 8
  return Number.isFinite(n) && n > 0 ? Math.min(n, 32) : 8
}

export function maxBytes(): number {
  const raw = process.env.PDF_MCP_MAX_BYTES
  const n = raw ? Number.parseInt(raw, 10) : 80 * 1024 * 1024
  return Number.isFinite(n) && n > 0 ? n : 80 * 1024 * 1024
}

export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export function createSession(buffer: Buffer, filename: string): PdfSession {
  if (buffer.length > maxBytes()) {
    throw new Error(`PDF exceeds PDF_MCP_MAX_BYTES (${maxBytes()}): ${buffer.length} bytes`)
  }
  if (sessions.size >= maxSessions()) {
    throw new Error(`Too many open sessions (max ${maxSessions()}). Close a session with pdf_close.`)
  }
  const id = randomUUID()
  const session: PdfSession = {
    id,
    buffer,
    filename,
    inspectionCache: {},
    contextCache: null,
    lastAnalysis: null,
    actionLog: [],
  }
  sessions.set(id, session)
  return session
}

export function getSession(sessionId: string): PdfSession {
  const s = sessions.get(sessionId)
  if (!s) throw new Error(`Unknown sessionId: ${sessionId}`)
  return s
}

export function closeSession(sessionId: string): boolean {
  return sessions.delete(sessionId)
}

export function invalidateContextCache(session: PdfSession): void {
  session.contextCache = null
  session.inspectionCache = {}
}

/** Push previous buffer for undo. */
const undoStacks = new Map<string, Buffer[]>()

export function pushUndo(sessionId: string, previous: Buffer): void {
  const depth = maxUndoDepth()
  const stack = undoStacks.get(sessionId) || []
  stack.push(previous)
  while (stack.length > depth) stack.shift()
  undoStacks.set(sessionId, stack)
}

export function popUndo(sessionId: string): Buffer | null {
  const stack = undoStacks.get(sessionId)
  if (!stack?.length) return null
  const b = stack.pop()!
  if (!stack.length) undoStacks.delete(sessionId)
  return b
}

export function clearUndo(sessionId: string): void {
  undoStacks.delete(sessionId)
}
