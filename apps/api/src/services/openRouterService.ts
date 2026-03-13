import type { BoundingBox, ModelReviewFlag } from './documentModel.js'
import type { PageHeadingCandidate, PageImageCandidate, PageTableCandidate } from './documentModel.js'

const OPENAI_COMPAT_BASE_URL = process.env.OPENAI_COMPAT_BASE_URL || process.env.OPENROUTER_BASE_URL || 'http://192.168.50.239:51824/v1'
const OPENAI_COMPAT_API_KEY = process.env.OPENAI_COMPAT_API_KEY || process.env.OPENROUTER_API_KEY || 'hs_a9a29d90a35c4b1c8a709e17c8c76dcf'
const OPENAI_COMPAT_MODEL = process.env.OPENAI_COMPAT_MODEL || process.env.OPENROUTER_MODEL || 'gpt-5.1-codex-mini'
const RECONSTRUCT_PAGE_TOOL = 'reconstruct_pdf_page'

function clampBox(box?: Partial<BoundingBox> | null): BoundingBox {
  return {
    x: Math.max(0, Math.min(1, Number(box?.x) || 0)),
    y: Math.max(0, Math.min(1, Number(box?.y) || 0)),
    width: Math.max(0.01, Math.min(1, Number(box?.width) || 0.1)),
    height: Math.max(0.01, Math.min(1, Number(box?.height) || 0.05)),
  }
}

export interface AiPageReconstruction {
  html: string
  css?: string | null
  reviewFlags: ModelReviewFlag[]
  titleSuggestion?: string | null
  documentTitleHint?: string | null
  languageSuggestion?: string | null
  confidence?: number | null
  pageRole?: 'cover' | 'toc' | 'section' | 'appendix' | 'content' | 'unknown' | null
  headingCandidates?: PageHeadingCandidate[]
  tableCandidates?: PageTableCandidate[]
  imageCandidates?: PageImageCandidate[]
}

export interface PageAiContext {
  width: number
  height: number
  textLength: number
  imageCount: number
  textLines: Array<{
    text: string
    bbox: BoundingBox
    fontSize: number
    fontWeight?: 'normal' | 'bold'
  }>
  links: Array<{
    url: string
    text: string
    bbox: BoundingBox
  }>
}

export class OpenAiCompatRequestError extends Error {
  statusCode: number
  responseBody: string

  constructor(statusCode: number, responseBody = '') {
    const detail = responseBody ? ` ${responseBody}` : ''
    super(`OpenAI-compatible request failed: ${statusCode}${detail}`)
    this.name = 'OpenAiCompatRequestError'
    this.statusCode = statusCode
    this.responseBody = responseBody
  }
}

export function normalizeAiPageReconstruction(parsed: any): AiPageReconstruction {
  const reviewFlags = Array.isArray(parsed.reviewFlags)
    ? parsed.reviewFlags.map((flag: any) => ({
      code: String(flag.code || 'manual_review'),
      label: String(flag.label || 'Manual review required'),
      severity: flag.severity === 'critical' ? 'critical' : 'warning',
      details: String(flag.details || 'This page needs manual review.'),
      pageNumber: Number(flag.pageNumber) || undefined,
      region: flag.region ? clampBox(flag.region) : null,
      asset: null,
    }))
    : []

  const confidence = Number(parsed.confidence)

  return {
    html: typeof parsed.html === 'string' ? parsed.html.trim() : '',
    css: typeof parsed.css === 'string' ? parsed.css.trim() : null,
    reviewFlags,
    titleSuggestion: typeof parsed.titleSuggestion === 'string' ? parsed.titleSuggestion.trim() : null,
    documentTitleHint: typeof parsed.documentTitleHint === 'string' ? parsed.documentTitleHint.trim() : null,
    languageSuggestion: typeof parsed.languageSuggestion === 'string' ? parsed.languageSuggestion.trim() : null,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    pageRole: ['cover', 'toc', 'section', 'appendix', 'content', 'unknown'].includes(parsed.pageRole)
      ? parsed.pageRole
      : null,
    headingCandidates: Array.isArray(parsed.headingCandidates)
      ? parsed.headingCandidates
        .map((candidate: any) => ({
          text: String(candidate?.text || '').trim(),
          level: ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(String(candidate?.level || '').toUpperCase())
            ? String(candidate.level).toUpperCase() as PageHeadingCandidate['level']
            : 'H2',
          confidence: Math.max(0, Math.min(1, Number(candidate?.confidence) || 0.5)),
        }))
        .filter((candidate: PageHeadingCandidate) => candidate.text)
      : [],
    tableCandidates: Array.isArray(parsed.tableCandidates)
      ? parsed.tableCandidates
        .map((candidate: any) => ({
          summary: String(candidate?.summary || '').trim() || 'Detected table',
          hasHeaderRow: Boolean(candidate?.hasHeaderRow),
          confidence: Math.max(0, Math.min(1, Number(candidate?.confidence) || 0.5)),
        }))
      : [],
    imageCandidates: Array.isArray(parsed.imageCandidates)
      ? parsed.imageCandidates
        .map((candidate: any) => ({
          altText: String(candidate?.altText || '').trim(),
          decorative: Boolean(candidate?.decorative),
          confidence: Math.max(0, Math.min(1, Number(candidate?.confidence) || 0.5)),
        }))
        .filter((candidate: PageImageCandidate) => candidate.altText || candidate.decorative)
      : [],
  }
}

async function openRouterJsonResponse(messages: any[]): Promise<any> {
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
          name: RECONSTRUCT_PAGE_TOOL,
          description: 'Return a semantic HTML/CSS reconstruction for a single PDF page.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['html', 'reviewFlags'],
            properties: {
              html: { type: 'string' },
              css: { type: ['string', 'null'] },
              titleSuggestion: { type: ['string', 'null'] },
              documentTitleHint: { type: ['string', 'null'] },
              languageSuggestion: { type: ['string', 'null'] },
              confidence: { type: ['number', 'null'] },
              pageRole: {
                type: ['string', 'null'],
                enum: ['cover', 'toc', 'section', 'appendix', 'content', 'unknown', null],
              },
              headingCandidates: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['text', 'level', 'confidence'],
                  properties: {
                    text: { type: 'string' },
                    level: { type: 'string', enum: ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'] },
                    confidence: { type: 'number' },
                  },
                },
              },
              tableCandidates: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['summary', 'hasHeaderRow', 'confidence'],
                  properties: {
                    summary: { type: 'string' },
                    hasHeaderRow: { type: 'boolean' },
                    confidence: { type: 'number' },
                  },
                },
              },
              imageCandidates: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['altText', 'decorative', 'confidence'],
                  properties: {
                    altText: { type: 'string' },
                    decorative: { type: 'boolean' },
                    confidence: { type: 'number' },
                  },
                },
              },
              reviewFlags: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['code', 'label', 'severity', 'details'],
                  properties: {
                    code: { type: 'string' },
                    label: { type: 'string' },
                    severity: { type: 'string', enum: ['warning', 'critical'] },
                    details: { type: 'string' },
                    pageNumber: { type: ['number', 'null'] },
                    region: {
                      type: ['object', 'null'],
                      additionalProperties: false,
                      required: ['x', 'y', 'width', 'height'],
                      properties: {
                        x: { type: 'number' },
                        y: { type: 'number' },
                        width: { type: 'number' },
                        height: { type: 'number' },
                      },
                    },
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
          name: RECONSTRUCT_PAGE_TOOL,
        },
      },
      messages,
    }),
  })

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '')
    throw new OpenAiCompatRequestError(response.status, bodyText)
  }

  const payload = await response.json() as any
  const toolCall = payload?.choices?.[0]?.message?.tool_calls?.find((entry: any) => entry?.function?.name === RECONSTRUCT_PAGE_TOOL)
  const rawArguments = toolCall?.function?.arguments

  if (!rawArguments || typeof rawArguments !== 'string') {
    throw new Error('OpenAI-compatible endpoint did not return function call arguments.')
  }

  try {
    return JSON.parse(rawArguments)
  } catch {
    throw new Error('OpenAI-compatible endpoint returned invalid function call arguments.')
  }
}

export function hasOpenRouterConfig(): boolean {
  return !!OPENAI_COMPAT_API_KEY
}

export function isRequestTooLargeError(error: unknown): boolean {
  if (error instanceof OpenAiCompatRequestError) {
    return error.statusCode === 413 || /length limit exceeded/i.test(error.responseBody)
  }

  const message = error instanceof Error ? error.message : String(error || '')
  return /openai-compatible request failed:\s*413/i.test(message) || /length limit exceeded/i.test(message)
}

export function buildPageReconstructionPrompt(input: {
  pageNumber: number
  nativeText: string
  filename: string
  pageContext: PageAiContext
  maxNativeTextChars?: number
  maxTextLines?: number
  maxLinks?: number
}): string {
  const maxTextLines = Math.max(1, input.maxTextLines || 160)
  const maxLinks = Math.max(1, input.maxLinks || 40)
  const maxNativeTextChars = Math.max(256, input.maxNativeTextChars || 8000)
  const compactContext = {
    page: {
      number: input.pageNumber,
      width: input.pageContext.width,
      height: input.pageContext.height,
      textLength: input.pageContext.textLength,
      imageCount: input.pageContext.imageCount,
    },
    textLines: input.pageContext.textLines.slice(0, maxTextLines),
    links: input.pageContext.links.slice(0, maxLinks),
  }

  return [
    'You are recreating one PDF page as accessible semantic HTML and CSS.',
    'Return JSON only.',
    'The structured page_context JSON is the source of truth for text content, link targets, and approximate layout.',
    'Use the screenshot only for visual styling and ambiguity resolution.',
    'Do not invent text that is not present in page_context or native extracted text unless you add a review flag.',
    'Use semantic HTML such as h1-h6, p, ul, ol, table, thead, tbody, tr, th, td, a, figure, figcaption, and img.',
    'The html field must be a valid HTML fragment containing tags like <p>, <h1>, <table>, <a>, or <img>. Plain text without tags is invalid.',
    'Do not use absolute positioned text over a page screenshot.',
    'Do not include markdown fences.',
    'Use classes and CSS for visual styling when useful.',
    'Preserve links as real anchors with href values from page_context.links whenever possible.',
    'If the page contains a figure or image region that must remain visible, emit an <img> tag with either data-bbox="x,y,width,height" using normalized 0-1 coordinates, or data-full-page="true" for a full-page image page.',
    'Every emitted <img> must have alt text. Use empty alt text only for decorative images.',
    'Preserve tables as HTML tables instead of screenshots whenever possible.',
    'If anything is uncertain, add a review flag instead of inventing details.',
    'Return JSON with keys: html, css, titleSuggestion, documentTitleHint, languageSuggestion, pageRole, headingCandidates, tableCandidates, imageCandidates, reviewFlags, confidence.',
    'Use headingCandidates to summarize the headings you used in the HTML, with inferred levels.',
    'Use tableCandidates for each meaningful table and mark whether a header row is present.',
    'Use imageCandidates for each meaningful image or figure and provide alt text or mark decorative.',
    'Use pageRole to describe whether the page is cover, table-of-contents-like, section divider, appendix, or regular content.',
    `Filename: ${input.filename}`,
    `Page number: ${input.pageNumber}`,
    `Native extracted text (may be partial): ${input.nativeText.slice(0, maxNativeTextChars) || '[none]'}`,
    `page_context: ${JSON.stringify(compactContext)}`,
  ].join('\n')
}

export async function reconstructPageWithOpenRouter(input: {
  pageNumber: number
  imageDataUrl: string
  nativeText: string
  filename: string
  pageContext: PageAiContext
  promptBudget?: {
    maxNativeTextChars?: number
    maxTextLines?: number
    maxLinks?: number
  }
}): Promise<AiPageReconstruction> {
  if (!OPENAI_COMPAT_API_KEY) {
    throw new Error('OpenAI-compatible endpoint is not configured.')
  }

  const prompt = buildPageReconstructionPrompt({
    pageNumber: input.pageNumber,
    nativeText: input.nativeText,
    filename: input.filename,
    pageContext: input.pageContext,
    maxNativeTextChars: input.promptBudget?.maxNativeTextChars,
    maxTextLines: input.promptBudget?.maxTextLines,
    maxLinks: input.promptBudget?.maxLinks,
  })

  const parsed = await openRouterJsonResponse([{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: input.imageDataUrl } },
    ],
  }])

  return normalizeAiPageReconstruction(parsed)
}
