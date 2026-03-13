import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisResult } from '../services/pdfAnalyzer.js'
import type { VeraPdfResult } from '../services/veraPdfService.js'

const reconstructPageWithOpenRouter = vi.fn()
const hasOpenRouterConfig = vi.fn()
const isRequestTooLargeError = vi.fn()
const renderPdfPageToDataUrl = vi.fn()

vi.mock('../services/openRouterService.js', () => ({
  reconstructPageWithOpenRouter,
  hasOpenRouterConfig,
  isRequestTooLargeError,
}))

vi.mock('../services/pdfRenderService.js', () => ({
  renderPdfPageToDataUrl,
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  OPS: {
    paintImageXObject: 1,
    paintJpegXObject: 2,
    paintImageXObjectRepeat: 3,
  },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: vi.fn(async () => ({
        getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale })),
        getTextContent: vi.fn(async () => ({
          items: [{
            str: 'Heading',
            width: 80,
            height: 18,
            transform: [1, 0, 0, 1, 72, 700],
          }],
        })),
        getAnnotations: vi.fn(async () => []),
        getOperatorList: vi.fn(async () => ({ fnArray: [] })),
        render: vi.fn(() => ({ promise: Promise.resolve() })),
      })),
      destroy: vi.fn(async () => {}),
    }),
  })),
}))

function makeVeraPdfResult(overrides: Partial<VeraPdfResult> = {}): VeraPdfResult {
  return {
    status: 'passed',
    executionStatus: 'ok',
    profile: 'PDF/UA-1',
    flavour: 'ua1',
    isCompliant: true,
    passedChecks: 1,
    failedChecks: 0,
    failures: [],
    message: 'veraPDF passed PDF/UA validation.',
    ...overrides,
  }
}

describe('documentReconstructionService', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    hasOpenRouterConfig.mockReturnValue(true)
  })

  it('retries page reconstruction with a smaller payload after a 413 response', async () => {
    const { reconstructDocumentModel } = await import('../services/documentReconstructionService.js')

    renderPdfPageToDataUrl
      .mockResolvedValueOnce({
        width: 1102,
        height: 1426,
        buffer: Buffer.from('large-image'),
        dataUrl: 'data:image/png;base64,bGFyZ2U=',
      })
      .mockResolvedValueOnce({
        width: 765,
        height: 990,
        buffer: Buffer.from('small-image'),
        dataUrl: 'data:image/png;base64,c21hbGw=',
      })

    const tooLargeError = new Error('OpenAI-compatible request failed: 413 Failed to buffer the request body: length limit exceeded')

    reconstructPageWithOpenRouter
      .mockRejectedValueOnce(tooLargeError)
      .mockResolvedValueOnce({
        html: '<h1>Heading</h1><p>Recovered content.</p>',
        css: null,
        reviewFlags: [],
        headingCandidates: [{ text: 'Heading', level: 'H1', confidence: 0.92 }],
        tableCandidates: [],
        imageCandidates: [],
        pageRole: 'content',
        confidence: 0.88,
      })

    isRequestTooLargeError.mockImplementation((error: unknown) => error === tooLargeError)

    const originalResult: AnalysisResult = {
      filename: 'scan.pdf',
      pageCount: 1,
      fileType: 'pdf',
      pdfMetadata: {
        creator: null,
        producer: null,
        creationDate: null,
        modDate: null,
        pdfVersion: '1.7',
        isEncrypted: false,
        keywords: null,
        author: null,
        subject: null,
        pageCount: 1,
      },
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 0,
      grade: 'F',
      isScanned: true,
      executiveSummary: '',
      verapdf: makeVeraPdfResult(),
      categories: [],
      warnings: [],
    } as AnalysisResult

    const output = await reconstructDocumentModel(Buffer.from('pdf'), 'scan.pdf', originalResult, {
      reviewAssetsDir: 'tmp',
    })

    expect(renderPdfPageToDataUrl).toHaveBeenCalledTimes(2)
    expect(renderPdfPageToDataUrl.mock.calls[0]?.[1]).toEqual({ scale: 1.8, format: 'png' })
    expect(renderPdfPageToDataUrl.mock.calls[1]?.[1]).toEqual({ scale: 1.25, format: 'png' })
    expect(reconstructPageWithOpenRouter).toHaveBeenCalledTimes(2)
    expect(reconstructPageWithOpenRouter.mock.calls[0]?.[0]?.promptBudget).toEqual({
      maxNativeTextChars: 8000,
      maxTextLines: 160,
      maxLinks: 40,
    })
    expect(reconstructPageWithOpenRouter.mock.calls[1]?.[0]?.promptBudget).toEqual({
      maxNativeTextChars: 5000,
      maxTextLines: 120,
      maxLinks: 24,
    })
    expect(output.artifacts.pageImages[0]?.buffer.equals(Buffer.from('small-image'))).toBe(true)
    expect(output.model.aiSuggestedChanges.some(change => change.label === 'Vision request downscaled')).toBe(true)
  })
})
