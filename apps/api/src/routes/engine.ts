import { Router, Response, type IRouter } from 'express'
import path from 'node:path'
import { authMiddleware, type AuthRequest } from '../middleware/authMiddleware.js'
import { uploadMiddleware } from '../middleware/uploadMiddleware.js'
import { FILENAME } from '#config'
import { analyzePdf, remediatePdf, verifyPdf, explainFailure, type AnalysisResult, type EngineRequestPolicy } from '../engine/index.js'

const router: IRouter = Router()

function sanitizeFilename(raw: string): string {
  let name = path.basename(raw)
  name = name.slice(0, FILENAME.MAX_LENGTH)
  name = name.replace(new RegExp(`[^${FILENAME.ALLOWED_CHARS.source.slice(1, -1)}]`, 'g'), '_')
  return name || 'unnamed.pdf'
}

function assertPdfMagicBytes(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString('ascii') === '%PDF-'
}

function parseRequestPolicy(input: Record<string, unknown>): EngineRequestPolicy {
  const maxRuntimeMs = Number(input.maxRuntimeMs)
  const artifactRetention: NonNullable<EngineRequestPolicy['artifactRetention']> = input.artifactRetention === 'none' || input.artifactRetention === 'debug'
    ? input.artifactRetention
    : 'summary'
  return {
    remediationPolicy: {
      visualPreservation: 'strict' as const,
    },
    artifactRetention,
    benchmarkLabel: typeof input.benchmarkLabel === 'string' ? input.benchmarkLabel : null,
    canaryLabel: typeof input.canaryLabel === 'string' ? input.canaryLabel : null,
    maxRuntimeMs: Number.isFinite(maxRuntimeMs) ? maxRuntimeMs : null,
  }
}

function requestTimeoutMs(policy: EngineRequestPolicy): number | null {
  return policy.maxRuntimeMs ?? null
}

async function withOptionalTimeout<T>(maxRuntimeMs: number | null, task: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  if (!maxRuntimeMs || maxRuntimeMs <= 0) return task()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), maxRuntimeMs)
  try {
    return await task(controller.signal)
  } finally {
    clearTimeout(timeout)
  }
}

// ─── POST /api/engine/analyze ────────────────────────────────────────────────

router.post(
  '/engine/analyze',
  authMiddleware,
  uploadMiddleware.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      const file = req.file
      if (!file) {
        res.status(400).json({ error: 'No file uploaded.' })
        return
      }
      if (!assertPdfMagicBytes(file.buffer)) {
        res.status(400).json({
          error: 'This file does not appear to be a valid PDF.',
          details: 'The file header is missing or incorrect. Verify you are uploading a .pdf file.',
        })
        return
      }

      const filename = sanitizeFilename(file.originalname)
      const requestPolicy = parseRequestPolicy(req.body as Record<string, unknown>)
      const result = await withOptionalTimeout<Awaited<ReturnType<typeof analyzePdf>>>(requestTimeoutMs(requestPolicy), signal =>
        analyzePdf(file.buffer, filename, {
          signal,
          ...requestPolicy,
        }))
      res.json(result)
    } catch (err: any) {
      console.error('[engine/analyze]', err)
      if (err.message?.includes('encrypted') || err.message?.includes('password')) {
        res.status(422).json({
          error: 'This PDF is password-protected.',
          details: 'Remove password protection before analyzing.',
        })
        return
      }
      if (err.code === 'ETIMEDOUT' || err.killed) {
        res.status(504).json({ error: 'Analysis timed out. The PDF may be too complex.' })
        return
      }
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ─── POST /api/engine/remediate ──────────────────────────────────────────────

router.post(
  '/engine/remediate',
  authMiddleware,
  uploadMiddleware.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      const file = req.file
      if (!file) {
        res.status(400).json({ error: 'No file uploaded.' })
        return
      }
      if (!assertPdfMagicBytes(file.buffer)) {
        res.status(400).json({
          error: 'This file does not appear to be a valid PDF.',
          details: 'The file header is missing or incorrect. Verify you are uploading a .pdf file.',
        })
        return
      }

      const filename = sanitizeFilename(file.originalname)
      const requestPolicy = parseRequestPolicy(req.body as Record<string, unknown>)

      // Analyze first, then attempt remediation.
      // NOTE: remediatePdf is long-running (seconds to minutes depending on document complexity).
      const analysis = await withOptionalTimeout<Awaited<ReturnType<typeof analyzePdf>>>(requestTimeoutMs(requestPolicy), signal =>
        analyzePdf(file.buffer, filename, {
          signal,
          ...requestPolicy,
        }))
      const result = await withOptionalTimeout<Awaited<ReturnType<typeof remediatePdf>>>(requestTimeoutMs(requestPolicy), signal =>
        remediatePdf(file.buffer, filename, analysis, {
          signal,
          ...requestPolicy,
        }))

      // Exclude buffer from HTTP response — bytes are not JSON-serializable.
      // Callers who need the remediated PDF bytes should use the queue route instead.
      const { buffer: _buffer, ...jsonSafe } = result
      res.json(jsonSafe)
    } catch (err: any) {
      console.error('[engine/remediate]', err)
      if (err.message?.includes('encrypted') || err.message?.includes('password')) {
        res.status(422).json({
          error: 'This PDF is password-protected.',
          details: 'Remove password protection before remediating.',
        })
        return
      }
      if (err.code === 'ETIMEDOUT' || err.killed || err.name === 'AbortError') {
        res.status(504).json({ error: 'Remediation timed out or was aborted.' })
        return
      }
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ─── POST /api/engine/verify ─────────────────────────────────────────────────

router.post(
  '/engine/verify',
  authMiddleware,
  uploadMiddleware.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      const file = req.file
      if (!file) {
        res.status(400).json({ error: 'No file uploaded.' })
        return
      }
      if (!assertPdfMagicBytes(file.buffer)) {
        res.status(400).json({
          error: 'This file does not appear to be a valid PDF.',
          details: 'The file header is missing or incorrect. Verify you are uploading a .pdf file.',
        })
        return
      }

      const filename = sanitizeFilename(file.originalname)
      const requestPolicy = parseRequestPolicy(req.body as Record<string, unknown>)
      const analysis = await withOptionalTimeout<Awaited<ReturnType<typeof analyzePdf>>>(requestTimeoutMs(requestPolicy), signal =>
        analyzePdf(file.buffer, filename, {
          signal,
          ...requestPolicy,
        }))
      const result = verifyPdf(analysis, requestPolicy)
      res.json(result)
    } catch (err: any) {
      console.error('[engine/verify]', err)
      if (err.message?.includes('encrypted') || err.message?.includes('password')) {
        res.status(422).json({ error: 'This PDF is password-protected.' })
        return
      }
      if (err.code === 'ETIMEDOUT' || err.killed) {
        res.status(504).json({ error: 'Analysis timed out. The PDF may be too complex.' })
        return
      }
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ─── POST /api/engine/explain ────────────────────────────────────────────────

router.post(
  '/engine/explain',
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const { analysisResult, model } = req.body as {
        analysisResult?: AnalysisResult
        model?: Parameters<typeof explainFailure>[1]
      }

      if (!analysisResult || typeof analysisResult !== 'object') {
        res.status(400).json({
          error: 'Missing required field: analysisResult.',
          details: 'POST a JSON body with { "analysisResult": <AnalysisResult from /engine/analyze> }.',
        })
        return
      }

      const requestPolicy = parseRequestPolicy(req.body as Record<string, unknown>)
      const result = explainFailure(analysisResult, model ?? null, requestPolicy)
      res.json(result)
    } catch (err: any) {
      console.error('[engine/explain]', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

export default router
