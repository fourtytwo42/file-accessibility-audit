import type { AnalysisResult } from './pdfAnalyzer.js'
import type {
  AppliedChange,
  BoundingBox,
  DocumentModel,
  ModelReviewFlag,
  ReconstructionOutput,
  SuggestedChange,
} from './documentModel.js'
import { average } from './documentModel.js'
import { buildBasicHtmlFromText, hasHtmlTags, sanitizeCssFragment, sanitizeHtmlFragment } from './htmlPageService.js'
import { hasOpenRouterConfig, isRequestTooLargeError, reconstructPageWithOpenRouter, type PageAiContext } from './openRouterService.js'
import { renderPdfPageToDataUrl } from './pdfRenderService.js'

type PdfjsLib = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

function inferSourceType(originalResult: AnalysisResult): DocumentModel['sourceType'] {
  if (originalResult.isScanned) return 'flattened'
  const score = originalResult.categories.find(category => category.id === 'text_extractability')?.score
  return score === 100 ? 'native-text' : 'mixed'
}

function escapedHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function extractNativeText(textContent: any): string {
  return (textContent.items || [])
    .map((item: any) => String(item?.str || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

function toNormalizedBbox(x: number, y: number, width: number, height: number, pageWidth: number, pageHeight: number): BoundingBox {
  return {
    x: clamp(x / pageWidth),
    y: clamp(y / pageHeight),
    width: clamp(width / pageWidth, 0.001, 1),
    height: clamp(height / pageHeight, 0.001, 1),
  }
}

function extractTextLines(textContent: any, pageWidth: number, pageHeight: number): PageAiContext['textLines'] {
  const items = (textContent.items || [])
    .filter((item: any) => String(item?.str || '').trim())
    .map((item: any) => {
      const text = String(item.str).trim()
      const width = Math.max(1, Number(item.width) || (text.length * 5))
      const height = Math.max(8, Math.abs(Number(item.height)) || 12)
      const x = Number(item.transform?.[4]) || 0
      const y = Number(item.transform?.[5]) || 0
      return {
        text,
        x,
        y,
        width,
        height,
        fontSize: Math.max(8, Math.round(height)),
      }
    })
    .sort((a: { y: number; x: number }, b: { y: number; x: number }) => (b.y - a.y) || (a.x - b.x))

  const lines: Array<typeof items> = []
  for (const item of items) {
    const anchor = lines.at(-1)?.[0]
    if (anchor && Math.abs(anchor.y - item.y) < 8) {
      lines.at(-1)!.push(item)
    } else {
      lines.push([item])
    }
  }

  const medianFont = items.length
    ? [...items].map(item => item.fontSize).sort((a: number, b: number) => a - b)[Math.floor(items.length / 2)]
    : 12

  return lines.map(line => {
    const ordered = [...line].sort((a, b) => a.x - b.x)
    const text = ordered.map(item => item.text).join(' ').replace(/\s+/g, ' ').trim()
    const fontSize = Math.round(ordered.reduce((sum, item) => sum + item.fontSize, 0) / ordered.length)
    const minX = Math.min(...ordered.map(item => item.x))
    const maxX = Math.max(...ordered.map(item => item.x + item.width))
    const maxY = Math.max(...ordered.map(item => item.y))
    const minY = Math.min(...ordered.map(item => item.y - item.height))
    return {
      text,
      bbox: toNormalizedBbox(minX, minY, maxX - minX, maxY - minY, pageWidth, pageHeight),
      fontSize,
      fontWeight: fontSize > medianFont * 1.15 ? 'bold' as const : 'normal' as const,
    }
  }).slice(0, 160)
}

function findLinkTextFromRect(rect: number[], items: any[]): string {
  const [x1, y1, x2, y2] = rect
  return items
    .filter((item: any) => String(item?.str || '').trim())
    .filter((item: any) => {
      const tx = Number(item.transform?.[4]) || 0
      const ty = Number(item.transform?.[5]) || 0
      return tx >= x1 - 6 && tx <= x2 + 6 && ty >= y1 - 6 && ty <= y2 + 6
    })
    .map((item: any) => String(item.str).trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function extractPageLinks(page: any, textContent: any, pageWidth: number, pageHeight: number): Promise<PageAiContext['links']> {
  const annotations = await page.getAnnotations().catch(() => [])
  return annotations
    .filter((annotation: any) => annotation?.subtype === 'Link' && annotation?.url && Array.isArray(annotation?.rect) && annotation.rect.length === 4)
    .map((annotation: any) => {
      const [x1, y1, x2, y2] = annotation.rect
      return {
        url: String(annotation.url),
        text: findLinkTextFromRect(annotation.rect, textContent.items as any[]) || String(annotation.url),
        bbox: toNormalizedBbox(
          Math.min(x1, x2),
          Math.min(y1, y2),
          Math.abs(x2 - x1),
          Math.abs(y2 - y1),
          pageWidth,
          pageHeight,
        ),
      }
    })
}

async function countPageImages(pdfjsLib: PdfjsLib, page: any): Promise<number> {
  const OPS = pdfjsLib.OPS as Record<string, number>
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintImageXObjectRepeat].filter(value => value !== undefined))
  const ops = await page.getOperatorList()
  return ops.fnArray.filter((fn: number) => imageOps.has(fn)).length
}

function parseLanguage(originalResult: AnalysisResult): string | null {
  const category = originalResult.categories.find(entry => entry.id === 'title_language')
  const finding = category?.findings.find(entry => entry.toLowerCase().startsWith('language declared:'))
  return finding?.split(':').slice(1).join(':').trim() || null
}

function defaultTitle(filename: string): string {
  return filename.replace(/\.pdf$/i, '')
}

function collectPageLinks(html: string): Array<{ url: string; text: string }> {
  const links: Array<{ url: string; text: string }> = []
  const regex = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  for (const match of html.matchAll(regex)) {
    const url = match[1]?.trim()
    const text = match[2]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (url) links.push({ url, text: text || url })
  }
  return links
}

function validateImageAltText(html: string, pageNumber: number): ModelReviewFlag[] {
  const flags: ModelReviewFlag[] = []
  for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = match[1] || ''
    const alt = attrs.match(/\balt="([^"]*)"/i)?.[1]
    if (alt === undefined) {
      flags.push({
        code: 'image_alt_missing',
        label: 'Image alt text requires review',
        severity: 'warning',
        details: 'An image is present in the reconstructed HTML without alt text.',
        pageNumber,
      })
    }
  }
  return flags
}

function confidenceSummary(confidences: number[]) {
  const overall = average(confidences)
  return {
    overall,
    textRecovery: overall,
    structureRecovery: overall,
    tableRecovery: 0,
    visualFidelity: overall,
  }
}

function summarizePageSemantics(ai: Awaited<ReturnType<typeof reconstructPageWithOpenRouter>>, pageNumber: number): ModelReviewFlag[] {
  const flags: ModelReviewFlag[] = []

  if ((ai.headingCandidates?.length || 0) === 0 && ai.pageRole !== 'toc') {
    flags.push({
      code: 'heading_candidates_review',
      label: 'Heading inference requires review',
      severity: 'warning',
      details: 'The page reconstruction did not identify confident heading candidates for this page.',
      pageNumber,
    })
  }

  for (const table of ai.tableCandidates || []) {
    if (!table.hasHeaderRow && table.confidence < 0.75) {
      flags.push({
        code: 'table_headers_review',
        label: 'Table headers require review',
        severity: 'warning',
        details: `A detected table may be missing a reliable header row: ${table.summary}.`,
        pageNumber,
      })
    }
  }

  for (const image of ai.imageCandidates || []) {
    if (!image.decorative && image.confidence < 0.7) {
      flags.push({
        code: 'image_alt_review',
        label: 'Image alt text requires review',
        severity: 'warning',
        details: `An image description on this page has low confidence: "${image.altText}".`,
        pageNumber,
      })
    }
  }

  return flags
}

const PAGE_RECONSTRUCTION_ATTEMPTS = [
  { scale: 1.8, maxNativeTextChars: 8000, maxTextLines: 160, maxLinks: 40 },
  { scale: 1.25, maxNativeTextChars: 5000, maxTextLines: 120, maxLinks: 24 },
  { scale: 1.0, maxNativeTextChars: 2500, maxTextLines: 80, maxLinks: 16 },
  { scale: 0.75, maxNativeTextChars: 1200, maxTextLines: 48, maxLinks: 8 },
] as const

async function reconstructPageWithFallbacks(input: {
  page: any
  pageNumber: number
  nativeText: string
  filename: string
  pageContext: PageAiContext
}): Promise<{
  ai: Awaited<ReturnType<typeof reconstructPageWithOpenRouter>>
  rendered: Awaited<ReturnType<typeof renderPdfPageToDataUrl>>
  attemptIndex: number
}> {
  let lastError: unknown = null

  for (let attemptIndex = 0; attemptIndex < PAGE_RECONSTRUCTION_ATTEMPTS.length; attemptIndex++) {
    const attempt = PAGE_RECONSTRUCTION_ATTEMPTS[attemptIndex]
    const rendered = await renderPdfPageToDataUrl(input.page, { scale: attempt.scale, format: 'png' })

    try {
      const ai = await reconstructPageWithOpenRouter({
        pageNumber: input.pageNumber,
        imageDataUrl: rendered.dataUrl,
        nativeText: input.nativeText,
        filename: input.filename,
        pageContext: input.pageContext,
        promptBudget: {
          maxNativeTextChars: attempt.maxNativeTextChars,
          maxTextLines: attempt.maxTextLines,
          maxLinks: attempt.maxLinks,
        },
      })

      return { ai, rendered, attemptIndex }
    } catch (error) {
      lastError = error
      if (!isRequestTooLargeError(error) || attemptIndex === PAGE_RECONSTRUCTION_ATTEMPTS.length - 1) {
        throw error
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('OpenAI-compatible page reconstruction failed.')
}

export async function reconstructDocumentModel(
  buffer: Buffer,
  filename: string,
  originalResult: AnalysisResult,
  options: {
    reviewAssetsDir: string
    processingPath?: 'ai_html'
    pathFallbacks?: string[]
    signal?: AbortSignal
    onProgress?: (progress: { stage: string; percent: number }) => void
    onCheckpoint?: (model: DocumentModel) => Promise<void> | void
  },
): Promise<ReconstructionOutput> {
  if (!hasOpenRouterConfig()) {
    throw new Error('OpenRouter is not configured for AI HTML reconstruction.')
  }

  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs') as PdfjsLib
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, verbosity: 0 }).promise
  const sourceType = inferSourceType(originalResult)
  const processingPath = options.processingPath || 'ai_html'
  const pages: DocumentModel['pages'] = []
  const pageImages: ReconstructionOutput['artifacts']['pageImages'] = []
  const manualReviewFlags: ModelReviewFlag[] = []
  const aiAppliedChanges: AppliedChange[] = []
  const aiSuggestedChanges: SuggestedChange[] = []
  const titleCandidates: Array<{ value: string; confidence: number }> = []
  const languageCandidates: Array<{ value: string; confidence: number }> = []
  const pageConfidences: number[] = []

  try {
    for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex++) {
      if (options.signal?.aborted) {
        const error = new Error('Reconstruction cancelled') as Error & { aborted?: boolean }
        error.aborted = true
        throw error
      }

      const pageNumber = pageIndex + 1
      const page = await doc.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const textContent = await page.getTextContent()
      const nativeText = extractNativeText(textContent)
      const textLines = extractTextLines(textContent, viewport.width, viewport.height)
      const links = await extractPageLinks(page, textContent, viewport.width, viewport.height)
      const imageCount = await countPageImages(pdfjsLib, page)
      const pageContext = {
        width: viewport.width,
        height: viewport.height,
        textLength: nativeText.length,
        imageCount,
        textLines,
        links,
      }
      const { ai, rendered, attemptIndex } = await reconstructPageWithFallbacks({
        page,
        pageNumber,
        nativeText,
        filename,
        pageContext,
      })
      pageImages.push({ pageNumber, dataUrl: rendered.dataUrl, buffer: rendered.buffer })

      if (ai.documentTitleHint) titleCandidates.push({ value: ai.documentTitleHint, confidence: 0.9 })
      if (ai.titleSuggestion) titleCandidates.push({ value: ai.titleSuggestion, confidence: 0.84 })
      if (ai.languageSuggestion) languageCandidates.push({ value: ai.languageSuggestion, confidence: 0.82 })
      if (attemptIndex > 0) {
        aiSuggestedChanges.push({
          type: 'structure',
          label: 'Vision request downscaled',
          details: `Page ${pageNumber} was retried with a smaller image payload after the OpenAI-compatible endpoint rejected the original request size.`,
          pageNumber,
          confidence: 0.74,
          autoApplied: true,
          reason: 'The initial page image exceeded the endpoint request-body size limit.',
        })
      }

      let html = sanitizeHtmlFragment(ai.html)
      const css = sanitizeCssFragment(ai.css)

      if (html && !hasHtmlTags(html)) {
        html = buildBasicHtmlFromText(html)
        aiSuggestedChanges.push({
          type: 'structure',
          label: 'Plain text HTML normalized',
          details: `Page ${pageNumber} returned plain text instead of HTML, so it was normalized into paragraph markup.`,
          pageNumber,
          confidence: 0.7,
          autoApplied: true,
          reason: 'AI returned text content without HTML tags.',
        })
      }

      if (!html) {
        html = nativeText ? buildBasicHtmlFromText(nativeText) : '<p>Manual review required for this page.</p>'
        aiSuggestedChanges.push({
          type: 'structure',
          label: 'Basic HTML fallback',
          details: `Page ${pageNumber} used a basic HTML fallback because the AI response was empty after sanitization.`,
          pageNumber,
          confidence: 0.55,
          autoApplied: false,
          reason: 'AI output was empty or unsafe after sanitization.',
        })
      }

      const pageFlags = [...ai.reviewFlags, ...summarizePageSemantics(ai, pageNumber), ...validateImageAltText(html, pageNumber)].map(flag => ({
        ...flag,
        pageNumber: flag.pageNumber || pageNumber,
      }))
      manualReviewFlags.push(...pageFlags)

      const htmlLinks = collectPageLinks(html)
      pages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        html,
        css: css || null,
        links: htmlLinks.length ? htmlLinks : links,
        pageRole: ai.pageRole || 'unknown',
        headingCandidates: ai.headingCandidates || [],
        tableCandidates: ai.tableCandidates || [],
        imageCandidates: ai.imageCandidates || [],
      })

      const confidence = Math.round((ai.confidence ?? (html.includes('<table') ? 0.8 : 0.82)) * 100)
      pageConfidences.push(confidence)
      options.onProgress?.({ stage: `Reconstructing page HTML ${pageNumber} of ${doc.numPages}`, percent: Math.round(((pageIndex + 1) / doc.numPages) * 100) })

      await options.onCheckpoint?.({
        version: '6',
        processingPath,
        pathFallbacks: options.pathFallbacks || [],
        title: null,
        language: null,
        sourceType,
        confidenceSummary: confidenceSummary(pageConfidences),
        pages: [...pages],
        manualReviewFlags: [...manualReviewFlags],
        aiAppliedChanges: [...aiAppliedChanges],
        aiSuggestedChanges: [...aiSuggestedChanges],
      })
    }
  } finally {
    await doc.destroy()
  }

  const title = titleCandidates.sort((a, b) => b.confidence - a.confidence)[0]?.value || defaultTitle(filename)
  const language = languageCandidates.sort((a, b) => b.confidence - a.confidence)[0]?.value || parseLanguage(originalResult) || 'en'

  aiAppliedChanges.push({
    type: 'title',
    label: 'Set rebuilt document title',
    details: `Used "${title}" as the rebuilt document title.`,
    confidence: title === defaultTitle(filename) ? 0.82 : 0.9,
    autoApplied: true,
  })
  aiAppliedChanges.push({
    type: 'language',
    label: 'Set rebuilt document language',
    details: `Used "${language}" as the rebuilt document language.`,
    confidence: language === 'en' ? 0.78 : 0.9,
    autoApplied: true,
  })

  const model: DocumentModel = {
    version: '6',
    processingPath,
    pathFallbacks: options.pathFallbacks || [],
    title,
    language,
    sourceType,
    confidenceSummary: confidenceSummary(pageConfidences),
    pages,
    manualReviewFlags,
    aiAppliedChanges,
    aiSuggestedChanges,
  }

  return {
    model,
    artifacts: { pageImages },
  }
}
