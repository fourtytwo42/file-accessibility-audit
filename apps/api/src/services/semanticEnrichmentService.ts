import { cropDataUrlRegion, renderPdfPageToDataUrl } from './pdfRenderService.js'
import type { AnalysisResult } from './pdfAnalyzer.js'
import type { ModelReviewFlag } from './documentModel.js'
import { draftFigureAltText } from './altTextDraftingService.js'
import type {
  FigureCandidate,
  HeadingCandidate,
  LinkCandidate,
  PdfRemediationContext,
  TableCandidate,
} from './pdfRemediationTools.js'

type PdfjsLib = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

const OPENAI_COMPAT_BASE_URL = process.env.OPENAI_COMPAT_BASE_URL || process.env.OPENROUTER_BASE_URL || 'http://192.168.50.239:51824/v1'
const OPENAI_COMPAT_API_KEY = process.env.OPENAI_COMPAT_API_KEY || process.env.OPENROUTER_API_KEY || 'hs_a9a29d90a35c4b1c8a709e17c8c76dcf'
const OPENAI_COMPAT_MODEL = process.env.OPENAI_COMPAT_MODEL || process.env.OPENROUTER_MODEL || 'gpt-5.1-codex-mini'
const PROPOSE_SEMANTIC_REPAIRS_TOOL = 'propose_semantic_repairs'
const HEADING_BATCH_SIZE = 8
const LINK_BATCH_SIZE = 8
const FIGURE_BATCH_SIZE = 4
const TABLE_BATCH_SIZE = 3
const BOOKMARK_BATCH_SIZE = 10
const MAX_SEMANTIC_LINK_TARGETS = 32
const SEMANTIC_REQUEST_CONCURRENCY = 3
const SEMANTIC_REQUEST_TIMEOUT_MS = Number(process.env.SEMANTIC_REQUEST_TIMEOUT_MS || 45_000)
const MAX_TEXT = 240
const MAX_ALT_TEXT = 180
const TOP_FAILURE_LIMIT = 2
const HEADING_CONTEXT_LIMIT = 2
const FIGURE_CONTEXT_LIMIT = 2
const TABLE_CONTEXT_LIMIT = 3
const TEXT_ONLY_SOFT_BUDGET = 7_500
const IMAGE_BATCH_SOFT_BUDGET = 180_000
const SEMANTIC_PAGE_RENDER_SCALE = 1.0
const SEMANTIC_FIGURE_MAX_DIMENSION = 768
const SEMANTIC_FIGURE_MAX_BYTES = 90_000

type SemanticRepairBatch = ReturnType<typeof buildSemanticRepairBatches>[number]

export interface SemanticHeadingProposal {
  candidateId: string
  level: 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6'
  confidence: number
  rationale: string
}

export interface SemanticFigureProposal {
  candidateId: string
  decorative: boolean
  altText: string
  confidence: number
  rationale: string
}

export interface SemanticTableProposal {
  candidateId: string
  useFirstRowAsHeader: boolean
  confidence: number
  rationale: string
}

export interface SemanticLinkProposal {
  candidateId: string
  replacementText: string
  annotationContents: string
  confidence: number
  rationale: string
}

export interface SemanticBookmarkProposal {
  candidateId: string
  title: string
  level: 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6'
  confidence: number
  rationale: string
  pageNumber?: number
  targetRef?: string | null
}

export interface SemanticBatchResult {
  batchType: 'headings' | 'figures' | 'tables' | 'links' | 'bookmarks'
  headings: SemanticHeadingProposal[]
  figures: SemanticFigureProposal[]
  tables: SemanticTableProposal[]
  links: SemanticLinkProposal[]
  bookmarks: SemanticBookmarkProposal[]
}

interface SemanticHeadingTarget {
  candidateId: string
  pageNumber: number
  text: string
  nearbyContext: string[]
  existingTag: string | null
  repairMode: string
}

interface SemanticFigureTarget {
  candidateId: string
  pageNumber: number
  surroundingText: string[]
  informativeHint: string
  repairMode: string
  targetTag: string | null
  imageDataUrl: string | null
}

interface SemanticTableTarget {
  candidateId: string
  pageNumberHints: number[]
  hasHeaders: boolean
  firstRowCellCount: number
  nearbyContext: string[]
  imageDataUrl: string | null
}

interface SemanticLinkTarget {
  candidateId: string
  pageNumber: number
  url: string
  text: string
  suggestedText: string | null
  annotationContents: string | null
}

interface SemanticBookmarkTarget {
  candidateId: string
  pageNumber: number
  text: string
  nearbyContext: string[]
  existingTag: string | null
  targetRef?: string | null
}

interface SemanticDocumentSummary {
  filename: string
  title: string | null
  language: string | null
  overallScore: number
  grade: string
  topFailures: string[]
}

class SemanticRepairRequestError extends Error {
  statusCode: number
  responseBody: string

  constructor(statusCode: number, responseBody = '') {
    const detail = responseBody ? ` ${responseBody}` : ''
    super(`OpenAI-compatible semantic repair request failed: ${statusCode}${detail}`)
    this.name = 'SemanticRepairRequestError'
    this.statusCode = statusCode
    this.responseBody = responseBody
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const limit = Math.max(1, Math.min(concurrency, items.length))
  const results = new Array<R>(items.length)
  let nextIndex = 0

  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex
      if (currentIndex >= items.length) return
      nextIndex += 1
      results[currentIndex] = await worker(items[currentIndex]!, currentIndex)
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()))
  return results
}

function clampConfidence(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.min(1, numeric))
}

function sanitizeText(value: unknown, maxLength: number): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function allowedLevel(value: unknown): SemanticHeadingProposal['level'] {
  const level = String(value || '').toUpperCase()
  return ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(level)
    ? level as SemanticHeadingProposal['level']
    : 'H2'
}

function topFailures(result: AnalysisResult): string[] {
  return result.verapdf?.status === 'failed'
    ? result.verapdf.failures.map(failure => sanitizeText(failure.message, MAX_TEXT)).filter(Boolean).slice(0, TOP_FAILURE_LIMIT)
    : []
}

function categoryScore(result: AnalysisResult, categoryId: string): number | null {
  const category = result.categories.find(entry => entry.id === categoryId)
  return typeof category?.score === 'number' ? category.score : null
}

function categoryNeedsWork(result: AnalysisResult, categoryId: string): boolean {
  const score = categoryScore(result, categoryId)
  return score !== null && score < 100
}

function semanticWorkComplete(result: AnalysisResult): boolean {
  if (result.verapdf?.status === 'passed' && result.grade === 'A') return true
  return !['heading_structure', 'alt_text', 'table_markup', 'link_quality', 'bookmarks'].some(categoryId => categoryNeedsWork(result, categoryId))
}

function summarizeDocument(filename: string, title: string | null, language: string | null, result: AnalysisResult): SemanticDocumentSummary {
  return {
    filename,
    title,
    language,
    overallScore: result.overallScore,
    grade: result.grade,
    topFailures: topFailures(result),
  }
}

export function hasSemanticRepairConfig(): boolean {
  return !!OPENAI_COMPAT_API_KEY
}

function buildPrompt(input: {
  document: SemanticDocumentSummary
  batchType: SemanticBatchResult['batchType']
  headings: SemanticHeadingTarget[]
  figures: SemanticFigureTarget[]
  tables: SemanticTableTarget[]
  links: SemanticLinkTarget[]
  bookmarks: SemanticBookmarkTarget[]
}): string {
  return [
    'You are proposing semantic accessibility repairs for an existing native PDF.',
    'Do not rewrite the whole document. Only return semantic decisions for the provided targets.',
    'Prefer conservative outputs. If a target is ambiguous, lower confidence and keep text short.',
    'For figures: if decorative is true, altText should be empty.',
    'For figures: use the cropped image as the primary evidence and use nearby text only as supporting context.',
    'For figures: avoid generic labels like "Image related to..." or "Image on page...". Describe the figure content or purpose specifically and concisely.',
    'For links: replacementText should be short visible text, annotationContents can be a slightly longer accessible label.',
    'For tables: only set useFirstRowAsHeader when the first row clearly behaves like column headers.',
    'For bookmarks: return concise, section-like sidebar labels. Clean up noisy OCR or fragmented heading text. Do not invent sections.',
    `Document summary: ${JSON.stringify(input.document)}`,
    `Batch type: ${input.batchType}`,
    JSON.stringify({
      headings: input.headings,
      figures: input.figures,
      tables: input.tables,
      links: input.links,
      bookmarks: input.bookmarks,
    }),
  ].join('\n')
}

async function openAiCompatJsonResponse(messages: any[]): Promise<any> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`semantic request timed out after ${SEMANTIC_REQUEST_TIMEOUT_MS}ms`)), SEMANTIC_REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${OPENAI_COMPAT_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_COMPAT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: OPENAI_COMPAT_MODEL,
        temperature: 0.1,
        tools: [{
          type: 'function',
          function: {
            name: PROPOSE_SEMANTIC_REPAIRS_TOOL,
            description: 'Return semantic accessibility repair proposals for specific PDF targets.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                headings: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['candidateId', 'level', 'confidence', 'rationale'],
                    properties: {
                      candidateId: { type: 'string' },
                      level: { type: 'string', enum: ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'] },
                      confidence: { type: 'number' },
                      rationale: { type: 'string' },
                    },
                  },
                },
                figures: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['candidateId', 'decorative', 'altText', 'confidence', 'rationale'],
                    properties: {
                      candidateId: { type: 'string' },
                      decorative: { type: 'boolean' },
                      altText: { type: 'string' },
                      confidence: { type: 'number' },
                      rationale: { type: 'string' },
                    },
                  },
                },
                tables: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['candidateId', 'useFirstRowAsHeader', 'confidence', 'rationale'],
                    properties: {
                      candidateId: { type: 'string' },
                      useFirstRowAsHeader: { type: 'boolean' },
                      confidence: { type: 'number' },
                      rationale: { type: 'string' },
                    },
                  },
                },
                links: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['candidateId', 'replacementText', 'annotationContents', 'confidence', 'rationale'],
                    properties: {
                      candidateId: { type: 'string' },
                      replacementText: { type: 'string' },
                      annotationContents: { type: 'string' },
                      confidence: { type: 'number' },
                      rationale: { type: 'string' },
                    },
                  },
                },
                bookmarks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['candidateId', 'title', 'level', 'confidence', 'rationale'],
                    properties: {
                      candidateId: { type: 'string' },
                      title: { type: 'string' },
                      level: { type: 'string', enum: ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'] },
                      confidence: { type: 'number' },
                      rationale: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        }],
        tool_choice: {
          type: 'function',
          function: {
            name: PROPOSE_SEMANTIC_REPAIRS_TOOL,
          },
        },
        messages,
      }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '')
    if (/aborted|timed out/i.test(message)) {
      throw new Error(`semantic provider request timed out: ${message}`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '')
    throw new SemanticRepairRequestError(response.status, bodyText)
  }

  const payload = await response.json() as any
  const toolCall = payload?.choices?.[0]?.message?.tool_calls?.find((entry: any) => entry?.function?.name === PROPOSE_SEMANTIC_REPAIRS_TOOL)
  const rawArguments = toolCall?.function?.arguments
  if (!rawArguments || typeof rawArguments !== 'string') {
    throw new Error('OpenAI-compatible endpoint did not return semantic repair tool arguments.')
  }
  return JSON.parse(rawArguments)
}

function isSemanticPayloadTooLargeError(error: unknown): boolean {
  if (error instanceof SemanticRepairRequestError) {
    return error.statusCode === 413
      || /context_length_exceeded|length limit exceeded|request too large|payload too large/i.test(error.responseBody)
  }

  const message = error instanceof Error ? error.message : String(error || '')
  return /context_length_exceeded|length limit exceeded|request too large|payload too large|semantic repair request failed:\s*413/i.test(message)
}

function normalizeBatchResult(
  batchType: SemanticBatchResult['batchType'],
  payload: any,
  allowedIds: Set<string>,
  figureTargetsById: Map<string, SemanticFigureTarget> = new Map(),
  bookmarkTargetsById: Map<string, { pageNumber: number; targetRef?: string | null }> = new Map(),
): SemanticBatchResult {
  const headings = Array.isArray(payload?.headings)
    ? payload.headings
      .filter((entry: any) => allowedIds.has(String(entry?.candidateId || '')))
      .map((entry: any) => ({
        candidateId: String(entry.candidateId),
        level: allowedLevel(entry.level),
        confidence: clampConfidence(entry.confidence),
        rationale: sanitizeText(entry.rationale, MAX_TEXT),
      }))
    : []
  const figurePayloadById = new Map(
    Array.isArray(payload?.figures)
      ? payload.figures
        .filter((entry: any) => allowedIds.has(String(entry?.candidateId || '')))
        .map((entry: any) => [String(entry.candidateId), entry] as const)
      : [],
  )
  const figures = figureTargetsById.size
    ? [...figureTargetsById.values()].map(target => {
        const entry = figurePayloadById.get(target.candidateId) as any
        const decorative = entry ? Boolean(entry.decorative) : false
        const altText = (() => {
          const candidateAlt = sanitizeText(entry?.altText, MAX_ALT_TEXT)
          if (decorative || candidateAlt) return candidateAlt
          return draftFigureAltText({
            pageNumber: target.pageNumber,
            surroundingText: target.surroundingText,
            decorative,
          })
        })()
        return {
          candidateId: target.candidateId,
          decorative,
          altText,
          confidence: clampConfidence(entry?.confidence ?? 0.8),
          rationale: sanitizeText(entry?.rationale || (entry ? '' : 'Semantic model returned no figure proposal; using deterministic fallback alt text.'), MAX_TEXT),
        }
      })
    : []
  const tables = Array.isArray(payload?.tables)
    ? payload.tables
      .filter((entry: any) => allowedIds.has(String(entry?.candidateId || '')))
      .map((entry: any) => ({
        candidateId: String(entry.candidateId),
        useFirstRowAsHeader: Boolean(entry.useFirstRowAsHeader),
        confidence: clampConfidence(entry.confidence),
        rationale: sanitizeText(entry.rationale, MAX_TEXT),
      }))
    : []
  const links = Array.isArray(payload?.links)
    ? payload.links
      .filter((entry: any) => allowedIds.has(String(entry?.candidateId || '')))
      .map((entry: any) => ({
        candidateId: String(entry.candidateId),
        replacementText: sanitizeText(entry.replacementText, 120),
        annotationContents: sanitizeText(entry.annotationContents, MAX_TEXT),
        confidence: clampConfidence(entry.confidence),
        rationale: sanitizeText(entry.rationale, MAX_TEXT),
      }))
    : []
  const bookmarks = Array.isArray(payload?.bookmarks)
    ? payload.bookmarks
      .filter((entry: any) => allowedIds.has(String(entry?.candidateId || '')))
      .map((entry: any) => {
        const candidateId = String(entry.candidateId)
        const target = bookmarkTargetsById.get(candidateId)
        return {
          candidateId,
          title: sanitizeText(entry.title, 120),
          level: allowedLevel(entry.level),
          confidence: clampConfidence(entry.confidence),
          rationale: sanitizeText(entry.rationale, MAX_TEXT),
          pageNumber: target?.pageNumber,
          targetRef: target?.targetRef ?? null,
        }
      })
      .filter((entry: SemanticBookmarkProposal) => entry.title)
    : []

  return { batchType, headings, figures, tables, links, bookmarks }
}

async function renderPageImages(buffer: Buffer, pageNumbers: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(pageNumbers.filter(pageNumber => Number.isFinite(pageNumber) && pageNumber >= 1))]
  if (!unique.length) return new Map()
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs') as PdfjsLib
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    verbosity: 0,
  }).promise
  const images = new Map<number, string>()
  try {
    const renderedPages = await Promise.all(unique.map(async pageNumber => {
      if (pageNumber > doc.numPages) return null
      const page = await doc.getPage(pageNumber)
      const rendered = await renderPdfPageToDataUrl(page, { scale: SEMANTIC_PAGE_RENDER_SCALE, format: 'png' })
      return { pageNumber, dataUrl: rendered.dataUrl }
    }))
    for (const rendered of renderedPages) {
      if (!rendered) continue
      images.set(rendered.pageNumber, rendered.dataUrl)
    }
  } finally {
    await doc.destroy()
  }
  return images
}

function isSemanticAiEligibleDeferredFigureCandidate(candidate: FigureCandidate): boolean {
  return candidate.repairMode === 'defer'
    && candidate.informativeHint !== 'decorative'
    && (candidate.imageEvidence === 'strong' || candidate.imageEvidence === 'vector')
    && !!candidate.targetTag
    && ['/P', '/Span', '/Div', '/NonStruct', '/TextBox', '/Shape', '/InlineShape', '/Normal'].includes(candidate.targetTag)
    && !!candidate.unsafeReason?.startsWith('text_heavy_candidate:')
}

function figureTargets(context: PdfRemediationContext): FigureCandidate[] {
  return context.figureCandidates.filter(candidate =>
    (candidate.repairMode !== 'defer' || isSemanticAiEligibleDeferredFigureCandidate(candidate))
    && candidate.informativeHint !== 'decorative'
  )
}

function hasFigureSemanticWork(context: PdfRemediationContext): boolean {
  return figureTargets(context).length > 0
}

function isSpecificHeadingTag(tag: string | null | undefined): boolean {
  return /^\/?H[1-6]$/i.test(String(tag || '').trim())
}

function headingTargets(context: PdfRemediationContext): HeadingCandidate[] {
  return context.headingCandidates.filter(candidate =>
    candidate.repairMode === 'safe'
    && !isSpecificHeadingTag(candidate.existingTag)
  )
}

function decodeOutlineTitleForPrompt(title: string): string {
  const trimmed = title.trim()
  const hexMatch = /^b:([0-9a-f]+)$/i.exec(trimmed)
  if (!hexMatch) return trimmed
  try {
    const decoded = Buffer.from(hexMatch[1], 'hex')
      .toString('latin1')
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/[\x80-\x9f]/g, '…')
      .replace(/\s+/g, ' ')
      .trim()
    return decoded || trimmed
  } catch {
    return trimmed
  }
}

function normalizeBookmarkSeedText(text: string): string {
  return text
    .replace(/[•\u2022]+/g, ' ')
    .replace(/\s*[.·•…]{2,}.*$/g, '')
    .replace(/[.·•]{3,}\s*\d+\s*$/g, '')
    .replace(/(?:…\s*)+\d+\s*$/g, '')
    .replace(/(?:[.·•…]\s*){3,}\s*$/g, '')
    .replace(/\s+\d+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function looksLikeNoisyBookmarkSeed(text: string): boolean {
  if (!text) return true
  if (!/[A-Za-z]/.test(text)) return true
  if (text.length < 4 || text.length > 90) return true
  if ((text.match(/\b\w+\b/g) || []).length > 12) return true
  if (/^[a-z]/.test(text)) return true
  if (/^[A-Z]\s+[a-z].{12,}/.test(text)) return true
  if (/(we are pleased|under the leadership|for the agency|state fiscal year|provides statistical|the weeks that followed)/i.test(text)) return true
  return false
}

function isGenericHeadingPlaceholder(text: string): boolean {
  return /^(heading|section|chapter|part)\s*\d*$/i.test(text.trim())
}

function bookmarkSeedQuality(text: string): number {
  const normalized = normalizeBookmarkSeedText(text)
  if (!normalized) return -10
  let score = 0
  if (!looksLikeNoisyBookmarkSeed(normalized)) score += 3
  if (!isGenericHeadingPlaceholder(normalized)) score += 2
  if (!/[.·•…]{3,}\s*\d*$/.test(text)) score += 2
  if (!/\s\d+\s*$/.test(text)) score += 1
  if (normalized.length >= 6 && normalized.length <= 80) score += 1
  if (/[A-Za-z]/.test(normalized)) score += 1
  return score
}

function chooseBookmarkSeedText(candidateText: string, outlineTitle?: string): string {
  const candidateNormalized = normalizeBookmarkSeedText(candidateText)
  const outlineNormalized = normalizeBookmarkSeedText(outlineTitle || '')
  if (!outlineNormalized) return candidateNormalized
  if (!candidateNormalized) return outlineNormalized
  if (isGenericHeadingPlaceholder(candidateNormalized) && !isGenericHeadingPlaceholder(outlineNormalized)) {
    return outlineNormalized
  }
  return bookmarkSeedQuality(outlineTitle || '') > bookmarkSeedQuality(candidateText)
    ? outlineNormalized
    : candidateNormalized
}

export function bookmarkTargets(context: PdfRemediationContext): HeadingCandidate[] {
  const outlineTitles = (context.qpdf.outlineTitles || [])
    .map(title => decodeOutlineTitleForPrompt(String(title || '')))
    .filter(Boolean)
  const headingBackedTargets = context.headingCandidates
    .filter(candidate =>
      candidate.text.trim()
      && (candidate.targetRef || Number.isFinite(candidate.pageNumber))
    )
    .map((candidate, index) => {
      const outlineTitle = outlineTitles[index]
      if (!outlineTitle) {
        return {
          ...candidate,
          text: normalizeBookmarkSeedText(candidate.text),
        }
      }
      return {
        ...candidate,
        text: chooseBookmarkSeedText(candidate.text, outlineTitle),
      }
    })
    .filter(candidate => candidate.text)
  const outlineBackedTargets = outlineTitles
    .map((title, index) => {
      const pageMatch = title.match(/(?:[.·•…]\s*|\s+)(\d{1,4})\s*$/)
      const pageNumber = pageMatch ? Number(pageMatch[1]) : NaN
      const text = normalizeBookmarkSeedText(title)
      if (!Number.isFinite(pageNumber) || pageNumber < 1) return null
      if (!text || looksLikeNoisyBookmarkSeed(text)) return null
      return {
        id: `bookmark:outline:${index + 1}`,
        pageNumber,
        text,
        bbox: { x: 0, y: 0, width: 1, height: 0.05 },
        fontSize: 12,
        fontWeight: 'normal' as const,
        nearbyContext: [],
        targetRef: null,
        existingTag: null,
        repairMode: 'defer' as const,
      }
    })
    .filter(Boolean) as HeadingCandidate[]

  const seen = new Set<string>()
  return [...headingBackedTargets, ...outlineBackedTargets]
    .filter(candidate => {
      const key = `${candidate.pageNumber}:${normalizeBookmarkSeedText(candidate.text).toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function tableTargets(context: PdfRemediationContext): TableCandidate[] {
  return context.tableCandidates.filter(candidate => candidate.repairMode === 'safe' && !candidate.hasHeaders)
}

function linkTargets(context: PdfRemediationContext): LinkCandidate[] {
  return context.linkCandidates
    // Deterministic repair already handles missing annotation /Contents at scale.
    // Keep semantic link work focused on raw-URL links that may need visible-text cleanup.
    .filter(candidate => candidate.rawUrl)
    .slice(0, MAX_SEMANTIC_LINK_TARGETS)
}

export function buildSemanticRepairBatches(input: {
  context: PdfRemediationContext
  analysis?: AnalysisResult
}): Array<{
  batchType: SemanticBatchResult['batchType']
  headings: HeadingCandidate[]
  figures: FigureCandidate[]
  tables: TableCandidate[]
  links: LinkCandidate[]
}> {
  const analysis = input.analysis || input.context.analysis
  const figureSemanticWork = hasSemanticRepairConfig() && hasFigureSemanticWork(input.context)
  if (semanticWorkComplete(analysis) && !figureSemanticWork) return []

  return [
    ...(!categoryNeedsWork(analysis, 'heading_structure') ? [] : chunk(headingTargets(input.context), HEADING_BATCH_SIZE).map(headings => ({
      batchType: 'headings' as const,
      headings,
      figures: [],
      tables: [],
      links: [],
    }))),
    ...(!figureSemanticWork ? [] : chunk(figureTargets(input.context), FIGURE_BATCH_SIZE).map(figures => ({
      batchType: 'figures' as const,
      headings: [],
      figures,
      tables: [],
      links: [],
    }))),
    ...(!categoryNeedsWork(analysis, 'table_markup') ? [] : chunk(tableTargets(input.context), TABLE_BATCH_SIZE).map(tables => ({
      batchType: 'tables' as const,
      headings: [],
      figures: [],
      tables,
      links: [],
    }))),
    ...(!categoryNeedsWork(analysis, 'link_quality') ? [] : chunk(linkTargets(input.context), LINK_BATCH_SIZE).map(links => ({
      batchType: 'links' as const,
      headings: [],
      figures: [],
      tables: [],
      links,
    }))),
    ...(categoryNeedsWork(analysis, 'bookmarks') ? chunk(bookmarkTargets(input.context), BOOKMARK_BATCH_SIZE).map(headings => ({
      batchType: 'bookmarks' as const,
      headings,
      figures: [],
      tables: [],
      links: [],
    })) : []),
  ]
}

function softBudgetForBatch(batchType: SemanticBatchResult['batchType']): number {
  return batchType === 'figures' || batchType === 'tables'
    ? IMAGE_BATCH_SOFT_BUDGET
    : TEXT_ONLY_SOFT_BUDGET
}

function splitBatch(batch: SemanticRepairBatch): SemanticRepairBatch[] {
  if (batch.batchType === 'headings' && batch.headings.length > 1) {
    const midpoint = Math.ceil(batch.headings.length / 2)
    return [
      { ...batch, headings: batch.headings.slice(0, midpoint) },
      { ...batch, headings: batch.headings.slice(midpoint) },
    ].filter(entry => entry.headings.length)
  }
  if (batch.batchType === 'links' && batch.links.length > 1) {
    const midpoint = Math.ceil(batch.links.length / 2)
    return [
      { ...batch, links: batch.links.slice(0, midpoint) },
      { ...batch, links: batch.links.slice(midpoint) },
    ].filter(entry => entry.links.length)
  }
  if (batch.batchType === 'bookmarks' && batch.headings.length > 1) {
    const midpoint = Math.ceil(batch.headings.length / 2)
    return [
      { ...batch, headings: batch.headings.slice(0, midpoint) },
      { ...batch, headings: batch.headings.slice(midpoint) },
    ].filter(entry => entry.headings.length)
  }
  if (batch.batchType === 'figures' && batch.figures.length > 1) {
    const midpoint = Math.ceil(batch.figures.length / 2)
    return [
      { ...batch, figures: batch.figures.slice(0, midpoint) },
      { ...batch, figures: batch.figures.slice(midpoint) },
    ].filter(entry => entry.figures.length)
  }
  if (batch.batchType === 'tables' && batch.tables.length > 1) {
    const midpoint = Math.ceil(batch.tables.length / 2)
    return [
      { ...batch, tables: batch.tables.slice(0, midpoint) },
      { ...batch, tables: batch.tables.slice(midpoint) },
    ].filter(entry => entry.tables.length)
  }
  return []
}

async function buildBatchInputs(batch: SemanticRepairBatch, pageImages: Map<number, string>): Promise<{
  headings: SemanticHeadingTarget[]
  figures: SemanticFigureTarget[]
  tables: SemanticTableTarget[]
  links: SemanticLinkTarget[]
  bookmarks: SemanticBookmarkTarget[]
  allowedIds: Set<string>
}> {
  const headings: SemanticHeadingTarget[] = batch.headings.map(candidate => ({
    candidateId: candidate.id,
    pageNumber: candidate.pageNumber,
    text: sanitizeText(candidate.text, MAX_TEXT),
    nearbyContext: candidate.nearbyContext.map(value => sanitizeText(value, MAX_TEXT)).filter(Boolean).slice(0, HEADING_CONTEXT_LIMIT),
    existingTag: candidate.existingTag || null,
    repairMode: candidate.repairMode,
  }))
  const figures: SemanticFigureTarget[] = await Promise.all(batch.figures.map(async candidate => ({
    candidateId: candidate.id,
    pageNumber: candidate.pageNumber,
    surroundingText: candidate.surroundingText.map(value => sanitizeText(value, MAX_TEXT)).filter(Boolean).slice(0, FIGURE_CONTEXT_LIMIT),
    informativeHint: candidate.informativeHint,
    repairMode: candidate.repairMode,
    targetTag: candidate.targetTag || null,
    imageDataUrl: candidate.bbox && pageImages.has(candidate.pageNumber)
      ? await cropDataUrlRegion(
        Buffer.from(pageImages.get(candidate.pageNumber)!.split(',', 2)[1], 'base64'),
        candidate.bbox,
        { maxDimension: SEMANTIC_FIGURE_MAX_DIMENSION, maxBytes: SEMANTIC_FIGURE_MAX_BYTES },
      ).catch(() => null)
      : null,
  })))
  const tables: SemanticTableTarget[] = batch.tables.map(candidate => ({
    candidateId: candidate.id,
    pageNumberHints: candidate.pageNumberHints,
    hasHeaders: candidate.hasHeaders,
    firstRowCellCount: candidate.firstRowCellRefs.length,
    nearbyContext: candidate.nearbyContext.map(value => sanitizeText(value, MAX_TEXT)).filter(Boolean).slice(0, TABLE_CONTEXT_LIMIT),
    imageDataUrl: null,
  }))
  const links: SemanticLinkTarget[] = batch.links.map(candidate => ({
    candidateId: candidate.id,
    pageNumber: candidate.pageNumber,
    url: sanitizeText(candidate.url, MAX_TEXT),
    text: sanitizeText(candidate.text, MAX_TEXT),
    suggestedText: candidate.suggestedText ? sanitizeText(candidate.suggestedText, 120) : null,
    annotationContents: candidate.annotationContents ? sanitizeText(candidate.annotationContents, MAX_TEXT) : null,
  }))
  const bookmarks: SemanticBookmarkTarget[] = batch.batchType === 'bookmarks'
    ? batch.headings.map(candidate => ({
      candidateId: candidate.id,
      pageNumber: candidate.pageNumber,
      text: sanitizeText(candidate.text, MAX_TEXT),
      nearbyContext: candidate.nearbyContext.map(value => sanitizeText(value, MAX_TEXT)).filter(Boolean).slice(0, HEADING_CONTEXT_LIMIT),
      existingTag: candidate.existingTag || null,
      targetRef: candidate.targetRef || null,
    }))
    : []

  return {
    headings,
    figures,
    tables,
    links,
    bookmarks,
    allowedIds: new Set([
      ...headings.map(item => item.candidateId),
      ...figures.map(item => item.candidateId),
      ...tables.map(item => item.candidateId),
      ...links.map(item => item.candidateId),
      ...bookmarks.map(item => item.candidateId),
    ]),
  }
}

function estimateBatchSize(input: {
  document: SemanticDocumentSummary
  batchType: SemanticBatchResult['batchType']
  headings: SemanticHeadingTarget[]
  figures: SemanticFigureTarget[]
  tables: SemanticTableTarget[]
  links: SemanticLinkTarget[]
  bookmarks: SemanticBookmarkTarget[]
}): number {
  const promptBytes = JSON.stringify(input).length
  const imageBytes = input.figures.reduce((total, figure) => total + (figure.imageDataUrl?.length || 0), 0)
    + input.tables.reduce((total, table) => total + (table.imageDataUrl?.length || 0), 0)
  return promptBytes + imageBytes
}

function skippedSemanticFlag(batch: SemanticRepairBatch, reason: string): ModelReviewFlag {
  return {
    code: 'semantic_enrichment_skipped',
    label: 'Semantic enrichment skipped',
    severity: 'warning',
    details: `Skipped ${batch.batchType} semantic enrichment for ${batch.headings.length || batch.figures.length || batch.tables.length || batch.links.length} target(s): ${reason}.`,
  }
}

async function resolveBatchWithFallbacks(input: {
  batch: SemanticRepairBatch
  document: SemanticDocumentSummary
  pageImages: Map<number, string>
  stripImages?: boolean
}): Promise<{ results: SemanticBatchResult[]; reviewFlags: ModelReviewFlag[] }> {
  const prepared = await buildBatchInputs(input.batch, input.stripImages ? new Map() : input.pageImages)
  const figureTargetsById = new Map(prepared.figures.map(item => [item.candidateId, item]))
  const estimatedSize = estimateBatchSize({
    document: input.document,
    batchType: input.batch.batchType,
    headings: prepared.headings,
    figures: prepared.figures,
    tables: prepared.tables,
      links: prepared.links,
      bookmarks: prepared.bookmarks,
    })

  if (estimatedSize > softBudgetForBatch(input.batch.batchType)) {
    const smallerBatches = splitBatch(input.batch)
    if (smallerBatches.length) {
      const results: SemanticBatchResult[] = []
      const reviewFlags: ModelReviewFlag[] = []
      for (const smallerBatch of smallerBatches) {
        const resolved = await resolveBatchWithFallbacks({
          batch: smallerBatch,
          document: input.document,
          pageImages: input.pageImages,
          stripImages: input.stripImages,
        })
        results.push(...resolved.results)
        reviewFlags.push(...resolved.reviewFlags)
      }
      return { results, reviewFlags }
    }

    if (!input.stripImages && input.batch.batchType === 'figures' && prepared.figures.some(figure => Boolean(figure.imageDataUrl))) {
      return resolveBatchWithFallbacks({
        batch: input.batch,
        document: input.document,
        pageImages: input.pageImages,
        stripImages: true,
      })
    }

    return {
      results: [],
      reviewFlags: [skippedSemanticFlag(input.batch, 'request exceeded the semantic prompt size budget')],
    }
  }

  try {
    const bookmarkTargetsById = new Map(
      prepared.bookmarks.map(item => [item.candidateId, { pageNumber: item.pageNumber, targetRef: item.targetRef || null }]),
    )
    const payload = await openAiCompatJsonResponse([{
      role: 'user',
      content: buildPrompt({
        document: input.document,
        batchType: input.batch.batchType,
        headings: prepared.headings,
        figures: prepared.figures,
        tables: prepared.tables,
        links: prepared.links,
        bookmarks: prepared.bookmarks,
      }),
    }])
    return {
      results: [normalizeBatchResult(input.batch.batchType, payload, prepared.allowedIds, figureTargetsById, bookmarkTargetsById)],
      reviewFlags: [],
    }
  } catch (error) {
    if (!isSemanticPayloadTooLargeError(error)) {
      throw error
    }

    const smallerBatches = splitBatch(input.batch)
    if (smallerBatches.length) {
      const results: SemanticBatchResult[] = []
      const reviewFlags: ModelReviewFlag[] = []
      for (const smallerBatch of smallerBatches) {
        const resolved = await resolveBatchWithFallbacks({
          batch: smallerBatch,
          document: input.document,
          pageImages: input.pageImages,
          stripImages: input.stripImages,
        })
        results.push(...resolved.results)
        reviewFlags.push(...resolved.reviewFlags)
      }
      return { results, reviewFlags }
    }

    if (!input.stripImages && input.batch.batchType === 'figures' && prepared.figures.some(figure => Boolean(figure.imageDataUrl))) {
      return resolveBatchWithFallbacks({
        batch: input.batch,
        document: input.document,
        pageImages: input.pageImages,
        stripImages: true,
      })
    }

    return {
      results: [],
      reviewFlags: [skippedSemanticFlag(input.batch, 'provider rejected the request as too large after downsizing')],
    }
  }
}

export async function generateSemanticRepairBatches(input: {
  buffer: Buffer
  filename: string
  title: string | null
  language: string | null
  analysis: AnalysisResult
  context: PdfRemediationContext
}): Promise<{ batches: SemanticBatchResult[]; reviewFlags: ModelReviewFlag[] }> {
  if (!hasSemanticRepairConfig()) return { batches: [], reviewFlags: [] }

  const batches = buildSemanticRepairBatches({ context: input.context, analysis: input.analysis })
  if (!batches.length) return { batches: [], reviewFlags: [] }

  const pageNumbers = new Set<number>()
  for (const batch of batches) {
    for (const figure of batch.figures) pageNumbers.add(figure.pageNumber)
  }
  const pageImages = await renderPageImages(input.buffer, [...pageNumbers])
  const document = summarizeDocument(input.filename, input.title, input.language, input.analysis)

  const resolvedBatches = await mapWithConcurrency(
    batches,
    SEMANTIC_REQUEST_CONCURRENCY,
    async batch => resolveBatchWithFallbacks({ batch, document, pageImages }),
  )

  const results: SemanticBatchResult[] = []
  const reviewFlags: ModelReviewFlag[] = []
  for (const resolved of resolvedBatches) {
    results.push(...resolved.results)
    reviewFlags.push(...resolved.reviewFlags)
  }

  return { batches: results, reviewFlags }
}
