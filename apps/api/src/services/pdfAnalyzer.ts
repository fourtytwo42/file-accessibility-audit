import { analyzeWithQpdf } from './qpdfService.js'
import { analyzeWithPdfjs, PdfMetadata } from './pdfjsService.js'
import { scoreDocument, ScoringResult, summarizeLinkTextQuality } from './scorer.js'
import { analyzeWithVeraPdf, type VeraPdfResult } from './veraPdfService.js'
import { runPdfStructureBackend } from './pdfStructureBackend.js'
import { ANALYSIS } from '#config'

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
  },
): Promise<AnalysisResult> {
  await acquireSemaphore()

  try {
    options?.onProgress?.({ stage: 'Inspecting PDF structure', percent: 10 })
    const [qpdfResult, veraPdfResult] = await Promise.all([
      analyzeWithQpdf(buffer, { signal: options?.signal }),
      analyzeWithVeraPdf(buffer, { signal: options?.signal }),
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

    // Score the document
    options?.onProgress?.({ stage: 'Scoring accessibility findings', percent: 92 })
    const scoringResult = scoreDocument(qpdfResult, pdfjsResult, veraPdfResult, structureForScoring)
    options?.onProgress?.({ stage: 'Finalizing report', percent: 100 })

    return {
      filename,
      pageCount: pdfjsResult.pageCount,
      fileType: 'pdf',
      pdfMetadata: pdfjsResult.metadata,
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
