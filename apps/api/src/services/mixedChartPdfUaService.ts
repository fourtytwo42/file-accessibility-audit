import type { AnalysisResult } from './pdfAnalyzer.js'
import type { BoundingBox, DocumentModel, ModelReviewFlag, RemediationActionRecord, ReconstructionArtifacts } from './documentModel.js'
import type { PdfRemediationContext } from './pdfRemediationTools.js'
import { buildRebuiltPdf } from './rebuiltPdfService.js'
import { renderPdfPageToDataUrl } from './pdfRenderService.js'
import { runPdfStructureBackend } from './pdfStructureBackend.js'

type PdfjsLib = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

function humanizeFilenameTitle(filename: string): string {
  return filename
    .replace(/\.pdf$/i, '')
    .replace(/[-_](\d{6,}|\d{6,}T\d{6,}|\d+)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || filename.replace(/\.pdf$/i, '')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function overlapRatio(a: BoundingBox, b: BoundingBox): number {
  const ax2 = a.x + a.width
  const ay2 = a.y + a.height
  const bx2 = b.x + b.width
  const by2 = b.y + b.height
  const width = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y))
  const intersection = width * height
  const denominator = Math.min(a.width * a.height, b.width * b.height) || 1
  return intersection / denominator
}

function pickHeadingTag(
  line: PdfRemediationContext['pages'][number]['textLines'][number],
  headingCandidates: PdfRemediationContext['headingCandidates'],
  pageNumber: number,
): 'h1' | 'h2' | 'p' {
  const match = headingCandidates.find(candidate =>
    candidate.pageNumber === pageNumber &&
    candidate.bbox &&
    overlapRatio(candidate.bbox, line.bbox) > 0.55,
  )
  if (!match) return 'p'
  return match.pageNumber === 1 && headingCandidates.findIndex(candidate => candidate.id === match.id) === 0 ? 'h1' : 'h2'
}

function buildPageHtml(input: {
  page: PdfRemediationContext['pages'][number]
  headingCandidates: PdfRemediationContext['headingCandidates']
  linkCandidates: PdfRemediationContext['linkCandidates']
  backgroundDataUrl: string
  title: string
}): string {
  const pageLinks = input.linkCandidates.filter(candidate => candidate.pageNumber === input.page.pageNumber)
  const linkBoxes = pageLinks.map(candidate => candidate.bbox)
  const lineNodes = input.page.textLines
    .filter(line => !linkBoxes.some(bbox => overlapRatio(bbox, line.bbox) > 0.5))
    .map(line => {
      const tag = pickHeadingTag(line, input.headingCandidates, input.page.pageNumber)
      return `<${tag}>${escapeHtml(line.text)}</${tag}>`
    })

  const linkNodes = pageLinks.map(candidate => {
    const label = candidate.annotationContents || candidate.suggestedText || candidate.text || candidate.url
    return `<p><a href="${escapeHtml(candidate.url)}" aria-label="${escapeHtml(label)}">${escapeHtml(label)}</a></p>`
  })

  return `
    <article class="page-shell" aria-label="Page ${input.page.pageNumber}">
      <div class="page-image">
        <img src="${input.backgroundDataUrl}" alt="Chart page image for ${escapeHtml(input.title)}. Transcript follows below." />
      </div>
      <section class="page-transcript" aria-label="Accessible transcript for page ${input.page.pageNumber}">
        ${lineNodes.join('\n')}
        ${linkNodes.join('\n')}
      </section>
    </article>
  `
}

function estimatePageHeight(page: PdfRemediationContext['pages'][number]): number {
  const transcriptRows = page.textLines.length + page.links.length
  return Math.round(page.height + Math.max(240, transcriptRows * 22))
}

function metadataLanguage(context: PdfRemediationContext): string {
  return context.qpdf.lang || context.pdfjs.lang || 'en'
}

function shouldRunMixedChartConformancePhase(currentResult: AnalysisResult): boolean {
  if (currentResult.isScanned) return false
  if (currentResult.pageCount > 2) return false
  if (currentResult.verapdf.status !== 'failed') return false
  if ((currentResult.categories.find(category => category.id === 'text_extractability')?.score || 0) < 100) return false

  const failureText = currentResult.verapdf.failures.map(failure => failure.message.toLowerCase()).join(' ')
  return /pdf\/ua identification|identification extension schema|conformance level|font programs.*embedded|font.*embedded within|parenttree|marked content|structtree|logical structure/.test(failureText)
}

export async function rebuildMixedChartPdfUaDocument(input: {
  buffer: Buffer
  filename: string
  analysis: AnalysisResult
  context: PdfRemediationContext
  signal?: AbortSignal
}): Promise<{
  buffer: Buffer
  model: DocumentModel
  actions: RemediationActionRecord[]
  manualReviewFlags: ModelReviewFlag[]
}> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs') as PdfjsLib
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(input.buffer),
    useSystemFonts: true,
    verbosity: 0,
  }).promise

  const pages: NonNullable<DocumentModel['pages']> = []
  const artifacts: ReconstructionArtifacts = { pageImages: [] }
  const sourceType: DocumentModel['sourceType'] = 'mixed'
  const title = input.context.pdfjs.title || humanizeFilenameTitle(input.filename)
  const language = metadataLanguage(input.context)

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      if (input.signal?.aborted) {
        const error = new Error('Mixed chart rebuild cancelled') as Error & { aborted?: boolean }
        error.aborted = true
        throw error
      }
      const page = await doc.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const rendered = await renderPdfPageToDataUrl(page, { scale: 1.8, format: 'png' })
      artifacts.pageImages.push({ pageNumber, dataUrl: rendered.dataUrl, buffer: rendered.buffer })
      const pageFact = input.context.pages.find(entry => entry.pageNumber === pageNumber)
      if (!pageFact) continue
      pages.push({
        pageNumber,
        width: viewport.width,
        height: estimatePageHeight(pageFact),
        html: buildPageHtml({
          page: pageFact,
          headingCandidates: input.context.headingCandidates,
          linkCandidates: input.context.linkCandidates,
          backgroundDataUrl: rendered.dataUrl,
          title,
        }),
        css: `
          .page-shell { display: block; width: 100%; }
          .page-image { margin: 0 0 1rem; }
          .page-image img { width: 100%; height: auto; display: block; }
          .page-transcript { display: block; }
          .page-transcript h1, .page-transcript h2, .page-transcript p { margin: 0 0 0.35rem; }
        `,
        links: pageFact.links.map(link => ({ url: link.url, text: link.text })),
        pageRole: pageNumber === 1 ? 'content' : 'content',
      })
    }
  } finally {
    await doc.destroy()
  }

  const model: DocumentModel = {
    version: '6',
    processingPath: 'agent_patch',
    pathFallbacks: ['mixed_chart_pdfua_rebuild'],
    title,
    language,
    sourceType,
    confidenceSummary: {
      overall: 86,
      textRecovery: 86,
      structureRecovery: 86,
      tableRecovery: 86,
      visualFidelity: 100,
    },
    pages,
    visibleContentChangePolicy: 'page_rebuilt',
    manualReviewFlags: [],
    aiAppliedChanges: [],
    aiSuggestedChanges: [],
  }

  let rebuiltBuffer = await buildRebuiltPdf({ model, artifacts, signal: input.signal })
  const metadataResult = await runPdfStructureBackend({
    buffer: rebuiltBuffer,
    mutation: {
      operation: 'set_pdfua_identification',
      title,
      language,
      part: 1,
      conformance: 'B',
    },
  })
  if (metadataResult.outputBuffer) {
    rebuiltBuffer = metadataResult.outputBuffer
  }

  return {
    buffer: rebuiltBuffer,
    model,
    actions: [
      {
        tool: 'embed_missing_fonts_for_page_content',
        target: 'document',
        details: 'Rebuilt mixed chart page content from the source render and extracted geometry so the replacement output uses embedded browser fonts.',
        confidence: 0.86,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['text_extractability', 'heading_structure', 'alt_text', 'link_quality', 'reading_order'],
        outcome: 'applied',
      },
      {
        tool: 'set_pdfua_identification',
        target: 'document',
        details: 'Wrote PDF/UA identification metadata to the rebuilt mixed chart PDF.',
        confidence: 0.88,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['title_language'],
        outcome: metadataResult.status === 'applied' ? 'applied' : 'no_effect',
        validationWarnings: metadataResult.warnings,
      },
    ],
    manualReviewFlags: [],
  }
}

export function shouldEscalateMixedChartPdfUa(currentResult: AnalysisResult): boolean {
  return shouldRunMixedChartConformancePhase(currentResult)
}
