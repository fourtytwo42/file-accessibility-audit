import { createHash } from 'node:crypto'
import { analyzeWithQpdf } from './qpdfService.js'
import { analyzeWithPdfjs, PdfMetadata } from './pdfjsService.js'
import { scoreDocument, ScoringResult, summarizeLinkTextQuality } from './scorer.js'
import { analyzeWithVeraPdf, emptyVeraPdfResult, type VeraPdfResult } from './veraPdfService.js'
import { runPdfStructureBackend } from './pdfStructureBackend.js'
import { runAdobeAccessibilityCheck } from './adobePdfServices.js'
import type { AdobeSummary } from './documentModel.js'
import { buildLocalStandardsReport } from './localStandardsService.js'
import { analyzeReadingOrder, type ReadingOrderResult } from './readingOrderService.js'
import { analyzeColorContrast, type ColorContrastResult } from './colorContrastService.js'
import { analyzeTableStructure, type TableStructureResult } from './tableStructureService.js'
import { analyzeTabOrder } from './tabOrderService.js'
import { ANALYSIS, REMEDIATION } from '#config'

// Cache veraPDF results by buffer hash — same bytes always yield the same result,
// so we skip redundant 30–120s runs during multi-round remediation re-analysis.
const veraPdfResultCache = new Map<string, VeraPdfResult>()
const MAX_VERA_CACHE_ENTRIES = 20

function getVeraPdfCached(buffer: Buffer, signal?: AbortSignal): Promise<VeraPdfResult> {
  const key = createHash('sha256').update(buffer).digest('hex').slice(0, 32)
  const cached = veraPdfResultCache.get(key)
  if (cached) return Promise.resolve(cached)
  return analyzeWithVeraPdf(buffer, { signal }).then(result => {
    if (veraPdfResultCache.size >= MAX_VERA_CACHE_ENTRIES) {
      veraPdfResultCache.delete(veraPdfResultCache.keys().next().value!)
    }
    veraPdfResultCache.set(key, result)
    return result
  })
}

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

export type AnalysisProfile = 'full_final' | 'remediation_fast'

type AnalysisTimingKey =
  | 'qpdf'
  | 'verapdf'
  | 'adobe'
  | 'pdfjs'
  | 'structureInspect'
  | 'readingOrder'
  | 'colorContrast'
  | 'tableStructure'
  | 'tabOrder'
  | 'scoring'

function durationMs(start: number): number {
  return Date.now() - start
}

async function measure<T>(
  timings: Partial<Record<AnalysisTimingKey, number>>,
  key: AnalysisTimingKey,
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()
  try {
    return await work()
  } finally {
    timings[key] = durationMs(startedAt)
  }
}

function logAnalysisTimings(input: {
  filename: string
  analysisProfile: AnalysisProfile
  skipAdobe: boolean
  skipVeraPdf: boolean
  timings: Partial<Record<AnalysisTimingKey, number>>
  totalMs: number
}): void {
  console.log(JSON.stringify({
    scope: 'pdf_analysis_timing',
    filename: input.filename,
    analysisProfile: input.analysisProfile,
    skipAdobe: input.skipAdobe,
    skipVeraPdf: input.skipVeraPdf,
    totalMs: input.totalMs,
    timingsMs: input.timings,
  }))
}

export async function analyzePDF(
  buffer: Buffer,
  filename: string,
  options?: {
    signal?: AbortSignal
    onProgress?: (progress: { stage: string; percent: number }) => void
    artifactsDir?: string
    skipAdobe?: boolean
    skipVeraPdf?: boolean
    inheritedVeraPdf?: VeraPdfResult
    analysisProfile?: AnalysisProfile
    forceStructureForScoring?: boolean
  },
): Promise<AnalysisResult> {
  await acquireSemaphore()

  try {
    const startedAt = Date.now()
    const analysisProfile = options?.analysisProfile || 'full_final'
    const skipVeraPdf = options?.skipVeraPdf ?? ANALYSIS.DEFAULT_SKIP_VERAPDF
    const timings: Partial<Record<AnalysisTimingKey, number>> = {}
    options?.onProgress?.({ stage: 'Inspecting PDF structure', percent: 10 })
    const [qpdfResult, veraPdfResult, adobeResult, pdfjsResult] = await Promise.all([
      measure(timings, 'qpdf', () => analyzeWithQpdf(buffer, { signal: options?.signal })),
      options?.inheritedVeraPdf
        ? measure(timings, 'verapdf', () => Promise.resolve(options.inheritedVeraPdf))
        : skipVeraPdf
          ? measure(timings, 'verapdf', () => Promise.resolve(emptyVeraPdfResult()))
          : measure(timings, 'verapdf', () => getVeraPdfCached(buffer, options?.signal)),
      (options?.skipAdobe || !REMEDIATION.ENABLE_ADOBE_API)
        ? measure(timings, 'adobe', () => Promise.resolve(null))
        : measure(timings, 'adobe', () => runAdobeAccessibilityCheck({
            buffer,
            filename,
            artifactsDir: options?.artifactsDir,
          })),
      measure(timings, 'pdfjs', () => analyzeWithPdfjs(buffer, {
        signal: options?.signal,
        onProgress(progress) {
          const scaled = 20 + Math.round(progress.percent * 0.65)
          options?.onProgress?.({
            stage: progress.stage,
            percent: Math.min(85, scaled),
          })
        },
      })),
    ])

    if (options?.signal?.aborted) {
      const error = new Error('Analysis cancelled') as any
      error.aborted = true
      throw error
    }

    const linkSummary = summarizeLinkTextQuality(pdfjsResult.links)
    const structureForScoring = (analysisProfile === 'full_final' || options?.forceStructureForScoring)
      && qpdfResult.hasStructTree
      && (pdfjsResult.imageCount > 0 || qpdfResult.images.length > 0 || qpdfResult.headings.length > 0)
      ? await measure(timings, 'structureInspect', () => runPdfStructureBackend({
          buffer,
          mutation: {
            operation: 'inspect',
            inspectMode: 'alt_text_deep',
          },
        }))
      : null

    const [readingOrderResult, colorContrastResult, tableStructureResult, tabOrderResult] = await Promise.all([
      analysisProfile === 'remediation_fast'
        ? measure(timings, 'readingOrder', () => Promise.resolve(null))
        : measure(timings, 'readingOrder', () => analyzeReadingOrder(buffer, { signal: options?.signal })),
      analysisProfile === 'remediation_fast'
        ? measure(timings, 'colorContrast', () => Promise.resolve(null))
        : measure(timings, 'colorContrast', () => analyzeColorContrast(buffer, { signal: options?.signal })),
      analysisProfile === 'remediation_fast'
        ? measure(timings, 'tableStructure', () => Promise.resolve(null))
        : measure(timings, 'tableStructure', () => analyzeTableStructure(buffer, qpdfResult.tables?.length ?? 0, { signal: options?.signal })),
      measure(timings, 'tabOrder', () => analyzeTabOrder(buffer, { isTagged: qpdfResult.isTagged || qpdfResult.hasStructTree })),
    ])
    const localStandards = buildLocalStandardsReport(qpdfResult, pdfjsResult, {
      tabOrder: tabOrderResult,
      structure: structureForScoring,
    })

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
    const scoringResult = await measure(timings, 'scoring', () => Promise.resolve(scoreDocument(
      qpdfResult,
      pdfjsResult,
      veraPdfResult,
      structureForScoring,
      adobeSummary,
      localStandards,
      {
        readingOrder: readingOrderResult,
        colorContrast: colorContrastResult,
        tableStructure: tableStructureResult,
        tabOrder: tabOrderResult,
      },
      {
        provisionalCategoryIds: analysisProfile === 'remediation_fast'
          ? ['reading_order', 'color_contrast']
          : [],
      },
    )))
    options?.onProgress?.({ stage: 'Finalizing report', percent: 100 })

    const result: AnalysisResult = {
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
    logAnalysisTimings({
      filename,
      analysisProfile,
      skipAdobe: !!options?.skipAdobe || !REMEDIATION.ENABLE_ADOBE_API,
      skipVeraPdf,
      timings,
      totalMs: durationMs(startedAt),
    })
    return result
  } finally {
    releaseSemaphore()
  }
}
