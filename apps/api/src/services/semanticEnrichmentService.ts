import { cropDataUrlRegion, renderPdfPageToDataUrl } from './pdfRenderService.js'
import type { AnalysisResult } from './pdfAnalyzer.js'
import type { ModelReviewFlag } from './documentModel.js'
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
const FIGURE_BATCH_SIZE = 1
const TABLE_BATCH_SIZE = 3
const BOOKMARK_BATCH_SIZE = 10
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
  const response = await fetch(`${OPENAI_COMPAT_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_COMPAT_API_KEY}`,
      'Content-Type': 'application/json',
    },
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
  const figures = Array.isArray(payload?.figures)
    ? payload.figures
      .filter((entry: any) => allowedIds.has(String(entry?.candidateId || '')))
      .map((entry: any) => ({
        candidateId: String(entry.candidateId),
        decorative: Boolean(entry.decorative),
        altText: sanitizeText(entry.altText, MAX_ALT_TEXT),
        confidence: clampConfidence(entry.confidence),
        rationale: sanitizeText(entry.rationale, MAX_TEXT),
      }))
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
      .map((entry: any) => ({
        candidateId: String(entry.candidateId),
        title: sanitizeText(entry.title, 120),
        level: allowedLevel(entry.level),
        confidence: clampConfidence(entry.confidence),
        rationale: sanitizeText(entry.rationale, MAX_TEXT),
      }))
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
    for (const pageNumber of unique) {
      if (pageNumber > doc.numPages) continue
      const page = await doc.getPage(pageNumber)
      const rendered = await renderPdfPageToDataUrl(page, { scale: SEMANTIC_PAGE_RENDER_SCALE, format: 'png' })
      images.set(pageNumber, rendered.dataUrl)
    }
  } finally {
    await doc.destroy()
  }
  return images
}

function figureTargets(context: PdfRemediationContext): FigureCandidate[] {
  return context.figureCandidates.filter(candidate =>
    candidate.repairMode !== 'defer'
    && candidate.informativeHint !== 'decorative'
  )
}

function hasFigureSemanticWork(context: PdfRemediationContext): boolean {
  return figureTargets(context).length > 0
}

function headingTargets(context: PdfRemediationContext): HeadingCandidate[] {
  return context.headingCandidates.filter(candidate => candidate.repairMode === 'safe')
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

function bookmarkTargets(context: PdfRemediationContext): HeadingCandidate[] {
  const outlineTitles = (context.qpdf.outlineTitles || [])
    .map(title => decodeOutlineTitleForPrompt(String(title || '')))
    .filter(Boolean)

  return context.headingCandidates
    .filter(candidate =>
      candidate.text.trim()
      && (candidate.targetRef || Number.isFinite(candidate.pageNumber))
    )
    .map((candidate, index) => {
      const outlineTitle = outlineTitles[index]
      if (!outlineTitle) return candidate
      return {
        ...candidate,
        text: outlineTitle,
      }
    })
}

function tableTargets(context: PdfRemediationContext): TableCandidate[] {
  return context.tableCandidates.filter(candidate => candidate.repairMode === 'safe' && !candidate.hasHeaders)
}

function linkTargets(context: PdfRemediationContext): LinkCandidate[] {
  return context.linkCandidates.filter(candidate => candidate.rawUrl || !candidate.annotationContents)
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
    return batch.figures.map(figure => ({ ...batch, figures: [figure] }))
  }
  if (batch.batchType === 'tables' && batch.tables.length > 1) {
    return batch.tables.map(table => ({ ...batch, tables: [table] }))
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
}): Promise<{ results: SemanticBatchResult[]; reviewFlags: ModelReviewFlag[] }> {
  const prepared = await buildBatchInputs(input.batch, input.pageImages)
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
        })
        results.push(...resolved.results)
        reviewFlags.push(...resolved.reviewFlags)
      }
      return { results, reviewFlags }
    }

    return {
      results: [],
      reviewFlags: [skippedSemanticFlag(input.batch, 'request exceeded the semantic prompt size budget')],
    }
  }

  try {
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
      results: [normalizeBatchResult(input.batch.batchType, payload, prepared.allowedIds)],
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
        })
        results.push(...resolved.results)
        reviewFlags.push(...resolved.reviewFlags)
      }
      return { results, reviewFlags }
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

  const results: SemanticBatchResult[] = []
  const reviewFlags: ModelReviewFlag[] = []
  for (const batch of batches) {
    const resolved = await resolveBatchWithFallbacks({ batch, document, pageImages })
    results.push(...resolved.results)
    reviewFlags.push(...resolved.reviewFlags)
  }

  return { batches: results, reviewFlags }
}
