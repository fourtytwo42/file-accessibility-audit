import { beforeEach, describe, expect, it, vi } from 'vitest'

const analyzeWithQpdf = vi.fn()
const analyzeWithPdfjs = vi.fn()
const analyzeWithVeraPdf = vi.fn()
const runPdfStructureBackend = vi.fn()
const runAdobeAccessibilityCheck = vi.fn()
const buildLocalStandardsReport = vi.fn()
const analyzeReadingOrder = vi.fn()
const analyzeColorContrast = vi.fn()
const analyzeTableStructure = vi.fn()
const analyzeTabOrder = vi.fn()
const scoreDocument = vi.fn()

vi.mock('../services/qpdfService.js', () => ({
  analyzeWithQpdf,
}))

vi.mock('../services/pdfjsService.js', () => ({
  analyzeWithPdfjs,
}))

vi.mock('../services/veraPdfService.js', () => ({
  analyzeWithVeraPdf,
  emptyVeraPdfResult: () => ({
    status: 'unavailable',
    executionStatus: 'missing_binary',
    profile: null,
    flavour: 'ua1',
    isCompliant: null,
    passedChecks: 0,
    failedChecks: 0,
    failures: [],
    message: 'veraPDF validation is unavailable.',
  }),
}))

vi.mock('../services/pdfStructureBackend.js', () => ({
  runPdfStructureBackend,
}))

vi.mock('../services/adobePdfServices.js', () => ({
  runAdobeAccessibilityCheck,
}))

vi.mock('../services/localStandardsService.js', () => ({
  buildLocalStandardsReport,
}))

vi.mock('../services/readingOrderService.js', () => ({
  analyzeReadingOrder,
}))

vi.mock('../services/colorContrastService.js', () => ({
  analyzeColorContrast,
}))

vi.mock('../services/tableStructureService.js', () => ({
  analyzeTableStructure,
}))

vi.mock('../services/tabOrderService.js', () => ({
  analyzeTabOrder,
}))

vi.mock('../services/scorer.js', () => ({
  summarizeLinkTextQuality: (links: Array<{ text: string }>) => ({
    linkCount: links.length,
    rawUrlLinkCount: 0,
    rawUrlLinkDensity: 0,
  }),
  scoreDocument,
}))

describe('pdfAnalyzer', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    analyzeWithQpdf.mockResolvedValue({
      error: null,
      hasStructTree: true,
      hasMarkInfo: true,
      marked: true,
      isTagged: true,
      structTreeDepth: 2,
      images: [],
      headings: [],
      tables: [{ hasHeaders: true }],
      contentOrder: [],
      outlineCount: 0,
      formFields: [],
      hasAcroForm: false,
    })
    analyzeWithPdfjs.mockResolvedValue({
      pageCount: 2,
      imageCount: 0,
      hasText: true,
      textLength: 100,
      title: 'Example',
      lang: 'en',
      metadata: {
        creator: null,
        producer: null,
        creationDate: null,
        modDate: null,
        pdfVersion: '1.7',
        isEncrypted: false,
        keywords: null,
        author: null,
        subject: null,
        pageCount: 2,
      },
      links: [],
      hasOutlines: false,
    })
    analyzeWithVeraPdf.mockResolvedValue({
      status: 'passed',
      executionStatus: 'ok',
      profile: 'PDF/UA-1',
      flavour: 'ua1',
      isCompliant: true,
      passedChecks: 1,
      failedChecks: 0,
      failures: [],
      message: 'veraPDF passed PDF/UA validation.',
    })
    runPdfStructureBackend.mockResolvedValue({
      structuralNodes: [],
      figures: [],
      imageStructNodes: [],
      acrobatAltRiskNodes: [],
      readingOrderNodes: [],
    })
    buildLocalStandardsReport.mockReturnValue({
      status: 'clear',
      findings: [],
      knownGapKeys: [],
    })
    analyzeReadingOrder.mockResolvedValue({ status: 'ok', disorderRatio: 0, pagesAnalyzed: 0, totalBlocks: 0, disorderedBlockCount: 0, disorderedBlocks: [], warnings: [] })
    analyzeColorContrast.mockResolvedValue({ status: 'ok', pagesAnalyzed: 0, totalSamples: 0, failingContrastCount: 0, failRatio: 0, failures: [], warnings: [] })
    analyzeTableStructure.mockResolvedValue({ status: 'ok', detectedTables: 1, taggedTables: 1, untaggedTables: 0, tableDetails: [], warnings: [] })
    analyzeTabOrder.mockResolvedValue({ status: 'ok', pagesAnalyzed: 2, annotatedPageCount: 0, missingTabsCount: 0, outOfOrderPageCount: 0, issues: [], warnings: [] })
    scoreDocument.mockImplementation((_qpdf: any, _pdfjs: any, verapdf: any, _structure: any, _adobe: any, localStandards: any, _extras: any, options?: any) => {
      const provisional = new Set(options?.provisionalCategoryIds || [])
      return {
        overallScore: 91,
        grade: 'A',
        isScanned: false,
        executiveSummary: 'ok',
        verapdf,
        localStandards,
        adobe: null,
        categories: [
          { id: 'reading_order', label: 'Reading Order', weight: 0.04, score: provisional.has('reading_order') ? null : 100, grade: provisional.has('reading_order') ? null : 'A', severity: provisional.has('reading_order') ? null : 'Pass', findings: [], explanation: '', helpLinks: [] },
          { id: 'color_contrast', label: 'Color Contrast', weight: 0.045, score: provisional.has('color_contrast') ? null : 100, grade: provisional.has('color_contrast') ? null : 'A', severity: provisional.has('color_contrast') ? null : 'Pass', findings: [], explanation: '', helpLinks: [] },
          { id: 'table_markup', label: 'Table Markup', weight: 0.085, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
        ],
        warnings: [],
      }
    })
  })

  it('uses remediation_fast to skip the heavy auxiliary analyzers and mark skipped categories provisional', async () => {
    const { analyzePDF } = await import('../services/pdfAnalyzer.js')

    const result = await analyzePDF(Buffer.from('pdf'), 'fast.pdf', {
      analysisProfile: 'remediation_fast',
      skipAdobe: true,
    })

    expect(analyzeReadingOrder).not.toHaveBeenCalled()
    expect(analyzeColorContrast).not.toHaveBeenCalled()
    expect(analyzeTableStructure).not.toHaveBeenCalled()
    expect(runPdfStructureBackend).not.toHaveBeenCalled()
    expect(scoreDocument.mock.calls[0]?.[7]).toEqual({
      provisionalCategoryIds: ['reading_order', 'color_contrast'],
    })
    expect(result.categories.find(category => category.id === 'reading_order')?.score).toBeNull()
    expect(result.categories.find(category => category.id === 'color_contrast')?.score).toBeNull()
    expect(result.categories.find(category => category.id === 'table_markup')?.score).toBe(100)
  })

  it('uses light structure inspection when remediation_fast forces structure scoring', async () => {
    const { analyzePDF } = await import('../services/pdfAnalyzer.js')
    analyzeWithQpdf.mockResolvedValue({
      error: null,
      hasStructTree: true,
      hasMarkInfo: true,
      marked: true,
      isTagged: true,
      structTreeDepth: 2,
      images: [{ ref: 'img1' }],
      headings: [],
      tables: [],
      contentOrder: [],
      outlineCount: 0,
      formFields: [],
      hasAcroForm: false,
    })
    analyzeWithPdfjs.mockResolvedValue({
      pageCount: 2,
      imageCount: 1,
      hasText: true,
      textLength: 100,
      title: 'Example',
      lang: 'en',
      metadata: {
        creator: null,
        producer: null,
        creationDate: null,
        modDate: null,
        pdfVersion: '1.7',
        isEncrypted: false,
        keywords: null,
        author: null,
        subject: null,
        pageCount: 2,
      },
      links: [],
      hasOutlines: false,
    })

    await analyzePDF(Buffer.from('pdf'), 'fast-structure.pdf', {
      analysisProfile: 'remediation_fast',
      skipAdobe: true,
      forceStructureForScoring: true,
    })

    expect(runPdfStructureBackend).toHaveBeenCalledTimes(1)
    expect(runPdfStructureBackend).toHaveBeenCalledWith({
      buffer: Buffer.from('pdf'),
      mutation: {
        operation: 'inspect',
        inspectMode: 'light',
      },
    })
  })

  it('falls back to light structure inspection when deep final inspection fails', async () => {
    const { analyzePDF } = await import('../services/pdfAnalyzer.js')
    analyzeWithQpdf.mockResolvedValue({
      error: null,
      hasStructTree: true,
      hasMarkInfo: true,
      marked: true,
      isTagged: true,
      structTreeDepth: 2,
      images: [{ ref: 'img1' }],
      headings: [],
      tables: [],
      contentOrder: [],
      outlineCount: 0,
      formFields: [],
      hasAcroForm: false,
    })
    analyzeWithPdfjs.mockResolvedValue({
      pageCount: 2,
      imageCount: 1,
      hasText: true,
      textLength: 100,
      title: 'Example',
      lang: 'en',
      metadata: {
        creator: null,
        producer: null,
        creationDate: null,
        modDate: null,
        pdfVersion: '1.7',
        isEncrypted: false,
        keywords: null,
        author: null,
        subject: null,
        pageCount: 2,
      },
      links: [],
      hasOutlines: false,
    })
    runPdfStructureBackend
      .mockResolvedValueOnce({
        status: 'failed',
        changedDocumentBytes: false,
        appliedMutations: [],
        warnings: ['timed out'],
        structuralNodes: [],
        figures: [],
        imageStructNodes: [],
        acrobatAltRiskNodes: [],
        readingOrderNodes: [],
        readingOrderParents: [],
        headings: [],
        tables: [],
      })
      .mockResolvedValueOnce({
        status: 'no_effect',
        changedDocumentBytes: false,
        appliedMutations: [],
        warnings: [],
        structuralNodes: [],
        figures: [],
        imageStructNodes: [],
        acrobatAltRiskNodes: [],
        readingOrderNodes: [],
        readingOrderParents: [],
        headings: [],
        tables: [],
      })

    await analyzePDF(Buffer.from('pdf'), 'full-fallback.pdf', {
      analysisProfile: 'full_final',
      skipAdobe: true,
    })

    expect(runPdfStructureBackend).toHaveBeenNthCalledWith(1, {
      buffer: Buffer.from('pdf'),
      mutation: {
        operation: 'inspect',
        inspectMode: 'alt_text_deep',
      },
    })
    expect(runPdfStructureBackend).toHaveBeenNthCalledWith(2, {
      buffer: Buffer.from('pdf'),
      mutation: {
        operation: 'inspect',
        inspectMode: 'light',
      },
    })
  })

  it('keeps full_final on the full analysis path while still skipping veraPDF by default', async () => {
    const { analyzePDF } = await import('../services/pdfAnalyzer.js')

    await analyzePDF(Buffer.from('pdf'), 'full.pdf', {
      analysisProfile: 'full_final',
      skipAdobe: true,
    })

    expect(analyzeWithVeraPdf).not.toHaveBeenCalled()
    expect(analyzeReadingOrder).toHaveBeenCalledTimes(1)
    expect(analyzeColorContrast).toHaveBeenCalledTimes(1)
    expect(analyzeTableStructure).toHaveBeenCalledTimes(1)
    expect(scoreDocument.mock.calls[0]?.[2]?.status).toBe('unavailable')
    expect(scoreDocument.mock.calls[0]?.[7]).toEqual({
      provisionalCategoryIds: [],
    })
  })
})
