import { Router, Response, type IRouter } from 'express'
import path from 'node:path'
import { authMiddleware, type AuthRequest } from '../middleware/authMiddleware.js'
import { uploadMiddleware } from '../middleware/uploadMiddleware.js'
import { FILENAME } from '#config'
import { analyzePdf, remediatePdf, verifyPdf, explainFailure, type AnalysisResult, type EngineRequestPolicy } from '../engine/index.js'
import {
  buildOpenAiCompatToolChoice,
  callWithOpenAiCompatFallbacks,
  getOpenAiCompatEndpoints,
  hasOpenAiCompatConfig,
  isEndpointAlive,
  listOpenAiCompatEndpointSummaries,
  openAiCompatFallbacksDisabled,
} from '../services/openAiCompatService.js'

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

// ─── GET /api/engine/llm-provider ─────────────────────────────────────────────
// Summarizes the configured OpenAI-compatible provider chain (no secrets).
// Optional: ?probe=1 hits each endpoint’s /v1/models with a short timeout.

router.get(
  '/engine/llm-provider',
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    try {
      const probe = req.query.probe === '1' || req.query.probe === 'true'
      const endpoints = listOpenAiCompatEndpointSummaries()
      const payload: {
        configured: boolean
        fallbacksDisabled: boolean
        endpoints: typeof endpoints
        probes?: Array<{ label: string; baseUrl: string; model: string; reachable: boolean }>
      } = {
        configured: hasOpenAiCompatConfig(),
        fallbacksDisabled: openAiCompatFallbacksDisabled(),
        endpoints,
      }

      if (probe) {
        const full = getOpenAiCompatEndpoints()
        payload.probes = await Promise.all(full.map(async endpoint => ({
          label: endpoint.label,
          baseUrl: endpoint.baseUrl,
          model: endpoint.model,
          reachable: await isEndpointAlive({
            baseUrl: endpoint.baseUrl,
            apiKey: endpoint.apiKey,
            timeoutMs: 2500,
          }),
        })))
      }

      res.json(payload)
    } catch (err: any) {
      console.error('[engine/llm-provider]', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ─── POST /api/engine/llm-tool-smoke ──────────────────────────────────────────
// Minimal tool-calling round-trip against the same provider chain as remediation.

router.post(
  '/engine/llm-tool-smoke',
  authMiddleware,
  async (_req: AuthRequest, res: Response) => {
    const SMOKE_TOOL = 'pdfaf_smoke_ping'
    try {
      if (!hasOpenAiCompatConfig()) {
        res.status(503).json({ error: 'OpenAI-compatible provider is not configured.' })
        return
      }

      const data = await callWithOpenAiCompatFallbacks({
        serviceName: 'engineLlmToolSmoke',
        invoke: async endpoint => {
          const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${endpoint.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: endpoint.model,
              temperature: 0,
              tools: [{
                type: 'function',
                function: {
                  name: SMOKE_TOOL,
                  description: 'Return a short ok payload.',
                  parameters: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['ok'],
                    properties: {
                      ok: { type: 'boolean' },
                    },
                  },
                },
              }],
              tool_choice: buildOpenAiCompatToolChoice({
                endpoint,
                functionName: SMOKE_TOOL,
              }),
              messages: [{
                role: 'user',
                content: 'Call pdfaf_smoke_ping with ok true.',
              }],
            }),
          })

          if (!response.ok) {
            const bodyText = await response.text().catch(() => '')
            throw new Error(`HTTP ${response.status}${bodyText ? ` ${bodyText.slice(0, 500)}` : ''}`)
          }

          return await response.json() as {
            choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>
          }
        },
      })

      const toolCall = data?.choices?.[0]?.message?.tool_calls?.find(entry => entry?.function?.name === SMOKE_TOOL)
      const raw = toolCall?.function?.arguments
      if (!raw || typeof raw !== 'string') {
        res.status(502).json({
          error: 'Provider did not return the expected tool call.',
          hint: 'For llama.cpp / LM Studio, set OPENAI_COMPAT_TOOL_CHOICE_MODE=required',
        })
        return
      }

      let parsed: { ok?: boolean } | null = null
      try {
        parsed = JSON.parse(raw) as { ok?: boolean }
      } catch {
        parsed = null
      }

      res.json({
        ok: parsed?.ok === true,
        toolArguments: raw,
      })
    } catch (err: any) {
      console.error('[engine/llm-tool-smoke]', err)
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Tool smoke request failed.',
      })
    }
  },
)

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
