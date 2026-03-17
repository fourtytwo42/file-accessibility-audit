import { analyzeWithQpdf } from './qpdfService.js'
import { analyzeWithPdfjs, PdfMetadata } from './pdfjsService.js'
import { scoreDocument, ScoringResult, summarizeLinkTextQuality } from './scorer.js'
import { analyzeWithVeraPdf, type VeraPdfResult } from './veraPdfService.js'
import { runPdfStructureBackend } from './pdfStructureBackend.js'
import { runAdobeAccessibilityCheck } from './adobePdfServices.js'
import type { AdobeSummary } from './documentModel.js'
import { analyzeReadingOrder, type ReadingOrderResult } from './readingOrderService.js'
import { analyzeColorContrast, type ColorContrastResult } from './colorContrastService.js'
import { analyzeTableStructure, type TableStructureResult } from './tableStructureService.js'
import { ANALYSIS, REMEDIATION } from '#config'

// Simple semaphore for concurrency limiting
let activeAnalyses = 0
const waitQueue: Array<() => void> = []

async function acquireSemaphore(): Promise<void> {
  if (activeAnalyses < ANALYSIS.MAX_CONCURRENT_ANALYSES) {
    activeAnalyses++
    return
  }
  return new Promise(resolve => {
    waitQueue.push(resolve)
  })
}

function releaseSemaphore(): void {
  activeAnalyses--
  const next = waitQueue.shift()
  if (next) {
    activeAnalyses++
    next()
  }
}

export interface AnalysisResult extends ScoringResult {
  filename: string
  pageCount: number
  fileType: 'pdf'
  pdfMetadata: PdfMetadata
  verapdf: VeraPdfResult
  adobe?: AdobeSummary | null
  routingSignals: {
    headingCount: number
    linkCount: number
    rawUrlLinkCount: number
    rawUrlLinkDensity: number
  }
}

export async function analyzePDF(
  buffer: Buffer,
  filename: string,
  options?: {
    signal?: AbortSignal
    onProgress?: (progress: { stage: string; percent: number }) => void
    artifactsDir?: string
    skipAdobe?: boolean
  },
): Promise<AnalysisResult> {
  await acquireSemaphore()

  try {
    options?.onProgress?.({ stage: 'Inspecting PDF structure', percent: 10 })
    const [qpdfResult, veraPdfResult, adobeResult] = await Promise.all([
      analyzeWithQpdf(buffer, { signal: options?.signal }),
      analyzeWithVeraPdf(buffer, { signal: options?.signal }),
      (options?.skipAdobe || !REMEDIATION.ENABLE_ADOBE_API)
        ? Promise.resolve(null)
        : runAdobeAccessibilityCheck({
            buffer,
            filename,
            artifactsDir: options?.artifactsDir,
          }),
    ])

    if (options?.signal?.aborted) {
      const error = new Error('Analysis cancelled') as any
      error.aborted = true
      throw error
    }

    options?.onProgress?.({ stage: 'Extracting text and metadata', percent: 20 })
    const pdfjsResult = await analyzeWithPdfjs(buffer, {
      signal: options?.signal,
      onProgress(progress) {
        const scaled = 20 + Math.round(progress.percent * 0.65)
        options?.onProgress?.({
          stage: progress.stage,
          percent: Math.min(85, scaled),
        })
      },
    })

    const linkSummary = summarizeLinkTextQuality(pdfjsResult.links)
    const structureForScoring = qpdfResult.hasStructTree && (pdfjsResult.imageCount > 0 || qpdfResult.images.length > 0 || qpdfResult.headings.length > 0)
      ? await runPdfStructureBackend({
          buffer,
          mutation: {
            operation: 'inspect',
            inspectMode: 'alt_text_deep',
          },
        })
      : null

    // Run new accessibility detection modules in parallel
    const [readingOrderResult, colorContrastResult, tableStructureResult] = await Promise.all([
      analyzeReadingOrder(buffer, { signal: options?.signal }),
      analyzeColorContrast(buffer, { signal: options?.signal }),
      analyzeTableStructure(buffer, qpdfResult.tables?.length ?? 0, { signal: options?.signal }),
    ])

    // Score the document
    options?.onProgress?.({ stage: 'Scoring accessibility findings', percent: 92 })
    const adobeSummary: AdobeSummary | null = adobeResult
      ? {
          status: adobeResult.status,
          summary: adobeResult.summary,
          passed: adobeResult.passed,
          issueCount: adobeResult.issueCount,
          findings: adobeResult.findings,
          warnings: adobeResult.warnings,
          artifacts: adobeResult.artifacts ?? null,
        }
      : null
    const scoringResult = scoreDocument(qpdfResult, pdfjsResult, veraPdfResult, structureForScoring, adobeSummary, {
      readingOrder: readingOrderResult,
      colorContrast: colorContrastResult,
      tableStructure: tableStructureResult,
    })
    options?.onProgress?.({ stage: 'Finalizing report', percent: 100 })

    return {
      filename,
      pageCount: pdfjsResult.pageCount,
      fileType: 'pdf',
      pdfMetadata: pdfjsResult.metadata,
      adobe: adobeSummary,
      routingSignals: {
        headingCount: qpdfResult.headings.length,
        linkCount: linkSummary.linkCount,
        rawUrlLinkCount: linkSummary.rawUrlLinkCount,
        rawUrlLinkDensity: linkSummary.rawUrlLinkDensity,
      },
      ...scoringResult,
    }
  } finally {
    releaseSemaphore()
  }
}
