import fs from 'node:fs/promises'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { analyzePDF } from '../../api/src/services/pdfAnalyzer.ts'
import {
  executeRemediationTool,
  inspectPdfForRemediation,
} from '../../api/src/services/pdfRemediationTools.ts'
import type { RemediationToolCall } from '../../api/src/services/documentModel.ts'
import { isRemediationToolName, REMEDIATION_TOOL_NAMES } from './allowedTools.ts'
import { defaultAllowPathRoots, resolveAllowedPath } from './repoRoot.ts'
import {
  clearUndo,
  closeSession,
  createSession,
  getSession,
  invalidateContextCache,
  maxBytes,
  popUndo,
  pushUndo,
  sha256Buffer,
} from './sessionStore.ts'
import { serializeRemediationContext, summarizeAnalysis } from './serialize.ts'

function jsonText(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }
}

function errText(message: string) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: message }],
  }
}

async function ensureAnalysis(session: ReturnType<typeof getSession>) {
  if (!session.lastAnalysis) {
    throw new Error('Call pdf_analyze on this session before pdf_inspect or pdf_apply_tool.')
  }
}

async function getOrBuildContext(session: ReturnType<typeof getSession>) {
  await ensureAnalysis(session)
  if (session.contextCache) return session.contextCache
  const ctx = await inspectPdfForRemediation(session.buffer, session.lastAnalysis!, {
    cache: session.inspectionCache,
  })
  session.contextCache = ctx
  return ctx
}

export function registerPdfTools(mcp: McpServer): void {
  const allowRoots = defaultAllowPathRoots()

  mcp.registerTool(
    'pdf_open',
    {
      title: 'Open PDF session',
      description:
        'Load a PDF from an allowed filesystem path or base64. Returns sessionId for other tools. Paths must be under PDF_MCP_ALLOW_PATHS or the repo root / HOME.',
      inputSchema: z
        .object({
          filename: z.string().describe('Logical filename for logging and analysis.'),
          path: z.string().optional().describe('Absolute or relative path to PDF (allowlisted).'),
          base64: z.string().optional().describe('PDF bytes as standard base64.'),
        })
        .refine(data => Boolean(data.path) !== Boolean(data.base64), {
          message: 'Provide exactly one of path or base64.',
        }),
    },
    async ({ filename, path: filePath, base64 }) => {
      try {
        let buffer: Buffer
        if (filePath) {
          const real = resolveAllowedPath(filePath, allowRoots)
          buffer = await fs.readFile(real)
        } else {
          buffer = Buffer.from(base64!, 'base64')
        }
        if (buffer.length > maxBytes()) {
          return errText(`PDF exceeds PDF_MCP_MAX_BYTES (${maxBytes()}).`)
        }
        const session = createSession(buffer, filename)
        clearUndo(session.id)
        return jsonText({
          sessionId: session.id,
          byteSize: buffer.length,
          sha256: sha256Buffer(buffer),
          filename: session.filename,
        })
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e))
      }
    },
  )

  mcp.registerTool(
    'pdf_close',
    {
      title: 'Close PDF session',
      description: 'Release session memory.',
      inputSchema: z.object({
        sessionId: z.string(),
      }),
    },
    async ({ sessionId }) => {
      clearUndo(sessionId)
      const ok = closeSession(sessionId)
      return jsonText({ closed: ok })
    },
  )

  mcp.registerTool(
    'pdf_analyze',
    {
      title: 'Analyze PDF',
      description:
        'Run full accessibility/scoring pipeline (qpdf, VeraPDF if enabled, pdfjs, …). Slow. Call pdf_inspect after mutations; candidate ids may change.',
      inputSchema: z.object({
        sessionId: z.string(),
        full: z.boolean().optional().describe('If true, return full AnalysisResult JSON (large).'),
        skipVeraPdf: z.boolean().optional(),
        skipAdobe: z.boolean().optional(),
        analysisProfile: z.enum(['full_final', 'remediation_fast']).optional(),
      }),
    },
    async ({ sessionId, full, skipVeraPdf, skipAdobe, analysisProfile }) => {
      try {
        const session = getSession(sessionId)
        const result = await analyzePDF(session.buffer, session.filename, {
          skipVeraPdf: skipVeraPdf ?? false,
          skipAdobe: skipAdobe ?? true,
          analysisProfile: analysisProfile ?? 'full_final',
        })
        session.lastAnalysis = result
        invalidateContextCache(session)
        return jsonText(summarizeAnalysis(result, Boolean(full)))
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e))
      }
    },
  )

  mcp.registerTool(
    'pdf_inspect',
    {
      title: 'Inspect remediation context',
      description:
        'Build figure/heading/table/link candidates and structure summary. Requires pdf_analyze first. Re-run after pdf_apply_tool when the PDF changed.',
      inputSchema: z.object({
        sessionId: z.string(),
      }),
    },
    async ({ sessionId }) => {
      try {
        const session = getSession(sessionId)
        const ctx = await getOrBuildContext(session)
        return jsonText(serializeRemediationContext(ctx))
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e))
      }
    },
  )

  mcp.registerTool(
    'pdf_apply_tool',
    {
      title: 'Apply remediation tool',
      description:
        'Execute one RemediationToolName with arguments (same contract as internal agent). Prefer pdf_inspect for candidate ids. Use pdf_undo if needed.',
      inputSchema: z.object({
        sessionId: z.string(),
        tool_name: z.string(),
        arguments: z.record(z.unknown()).optional(),
        rationale: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
      }),
    },
    async ({ sessionId, tool_name, arguments: args, rationale, confidence }) => {
      try {
        if (!isRemediationToolName(tool_name)) {
          return errText(`Unknown tool_name. Use pdf_list_remediation_tools for valid names.`)
        }
        const session = getSession(sessionId)
        const context = await getOrBuildContext(session)
        pushUndo(sessionId, Buffer.from(session.buffer))

        const call: RemediationToolCall = {
          tool_name,
          arguments: (args && typeof args === 'object' ? args : {}) as Record<string, unknown>,
          rationale: rationale || 'mcp pdf_apply_tool',
          confidence: confidence ?? 0.9,
        }

        let buffer: Buffer
        let action: Awaited<ReturnType<typeof executeRemediationTool>>['action']
        let manualReviewFlags: Awaited<ReturnType<typeof executeRemediationTool>>['manualReviewFlags']
        try {
          const out = await executeRemediationTool({
            buffer: session.buffer,
            context,
            call,
          })
          buffer = out.buffer
          action = out.action
          manualReviewFlags = out.manualReviewFlags
        } catch (e) {
          popUndo(sessionId)
          throw e
        }

        session.buffer = buffer
        const mutated =
          action.outcome === 'applied'
          || action.changedDocumentBytes === true
        if (mutated) {
          invalidateContextCache(session)
          session.lastAnalysis = null
        }

        session.actionLog.push({
          at: new Date().toISOString(),
          tool: tool_name,
          outcome: action.outcome,
          details: action.details?.slice(0, 2000) || '',
        })

        return jsonText({
          outcome: action.outcome,
          changedDocumentBytes: action.changedDocumentBytes,
          details: action.details,
          target: action.target,
          manualReviewFlags,
          actionLogTail: session.actionLog.slice(-12),
          note: mutated
            ? 'PDF changed; call pdf_analyze and pdf_inspect before using old candidate ids.'
            : undefined,
        })
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e))
      }
    },
  )

  mcp.registerTool(
    'pdf_undo',
    {
      title: 'Undo last pdf_apply_tool',
      description: 'Restore buffer from before the last apply (stack depth from PDF_MCP_MAX_UNDO).',
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      try {
        const session = getSession(sessionId)
        const prev = popUndo(sessionId)
        if (!prev) return errText('No undo state for this session.')
        session.buffer = prev
        invalidateContextCache(session)
        session.lastAnalysis = null
        return jsonText({ undone: true, byteSize: session.buffer.length })
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e))
      }
    },
  )

  mcp.registerTool(
    'pdf_write',
    {
      title: 'Write session PDF to disk',
      description: 'Save current buffer to an allowlisted path.',
      inputSchema: z.object({
        sessionId: z.string(),
        path: z.string(),
      }),
    },
    async ({ sessionId, path: outPath }) => {
      try {
        const session = getSession(sessionId)
        const real = resolveAllowedPath(outPath, allowRoots)
        await fs.writeFile(real, session.buffer)
        return jsonText({ written: true, path: real, byteSize: session.buffer.length })
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e))
      }
    },
  )

  mcp.registerTool(
    'pdf_list_remediation_tools',
    {
      title: 'List remediation tool names',
      description: 'Valid tool_name values for pdf_apply_tool.',
    },
    async () => jsonText({ tools: [...REMEDIATION_TOOL_NAMES] }),
  )

  mcp.registerTool(
    'pdf_session_info',
    {
      title: 'Session info',
      description: 'Current buffer hash/size and action log length.',
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      try {
        const session = getSession(sessionId)
        return jsonText({
          sessionId,
          filename: session.filename,
          byteSize: session.buffer.length,
          sha256: sha256Buffer(session.buffer),
          hasAnalysis: Boolean(session.lastAnalysis),
          actionLogLength: session.actionLog.length,
        })
      } catch (e) {
        return errText(e instanceof Error ? e.message : String(e))
      }
    },
  )
}
