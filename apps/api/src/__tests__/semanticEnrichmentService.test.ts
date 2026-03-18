import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisResult } from '../services/pdfAnalyzer.js'
import type { PdfRemediationContext } from '../services/pdfRemediationTools.js'
import type { VeraPdfResult } from '../services/veraPdfService.js'

const renderPdfPageToDataUrl = vi.fn()
const cropDataUrlRegion = vi.fn()

vi.mock('../services/pdfRenderService.js', () => ({
  renderPdfPageToDataUrl,
  cropDataUrlRegion,
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 3,
      getPage: vi.fn(async () => ({})),
      destroy: vi.fn(async () => {}),
    }),
  })),
}))

function makeVeraPdfResult(overrides: Partial<VeraPdfResult> = {}): VeraPdfResult {
  return {
    status: 'failed',
    executionStatus: 'ok',
    profile: 'PDF/UA-1',
    flavour: 'ua1',
    isCompliant: false,
    passedChecks: 1,
    failedChecks: 2,
    failures: [{ ruleId: 'rule-a', specification: null, clause: null, testNumber: null, location: null, message: 'Missing alt text', categoryIds: [] }],
    message: 'veraPDF failed PDF/UA validation.',
    ...overrides,
  }
}

function makeAnalysisResult(): AnalysisResult {
  return {
    filename: 'test.pdf',
    pageCount: 3,
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
      pageCount: 3,
    },
    routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
    overallScore: 44,
    grade: 'F',
    isScanned: false,
    executiveSummary: '',
    verapdf: makeVeraPdfResult(),
    categories: [
      { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 40, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
      { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 30, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
      { id: 'table_markup', label: 'Table Markup', weight: 0.1, score: 50, grade: 'F', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      { id: 'link_quality', label: 'Link Quality', weight: 0.1, score: 25, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
    ],
    warnings: [],
  } as AnalysisResult
}

function makeContext(): PdfRemediationContext {
  return {
    analysis: makeAnalysisResult(),
    qpdf: {
      hasStructTree: true,
      isTagged: true,
      hasLang: true,
      lang: 'en',
      hasOutlines: false,
      outlineCount: 0,
      outlineTitles: [],
      hasAcroForm: false,
      formFields: [],
      images: [],
      headings: [],
      tables: [],
      structTreeDepth: 2,
      contentOrder: [],
      annotationCount: 0,
      error: null,
    },
    pdfjs: { title: 'Sample', lang: 'en' } as any,
    structure: {
      status: 'applied',
      changedDocumentBytes: false,
      appliedMutations: [],
      warnings: [],
      headings: [],
      structuralNodes: [],
      tables: [],
      figures: [],
      readingOrderNodes: [],
      readingOrderParents: [],
    },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        imageCount: 1,
        textLines: [{ text: 'Executive Summary', bbox: { x: 0, y: 0, width: 1, height: 0.1 }, fontSize: 18, fontWeight: 'bold' }],
        links: [{ url: 'https://example.com/report', text: 'https://example.com/report', bbox: { x: 0, y: 0.2, width: 0.4, height: 0.05 }, annotationIndex: 0 }],
      },
    ],
    headingCandidates: Array.from({ length: 9 }, (_, index) => ({
      id: `heading:1:${index + 1}`,
      pageNumber: 1,
      text: `Heading ${index + 1}`,
      bbox: { x: 0, y: 0.1 * index, width: 0.5, height: 0.05 },
      fontSize: 16,
      fontWeight: 'bold' as const,
      nearbyContext: ['Context line'],
      targetRef: `obj:${index + 1} 0 R`,
      existingTag: '/P',
      repairMode: 'safe' as const,
    })),
    figureCandidates: Array.from({ length: 4 }, (_, index) => ({
      id: `figure:${index + 1}`,
      pageNumber: 1,
      targetRef: `obj:${index + 20} 0 R`,
      bbox: { x: 0, y: 0, width: 1, height: 1 },
      hasAlt: false,
      altText: null,
      informativeHint: 'unknown' as const,
      surroundingText: ['Chart of outcomes'],
      repairMode: 'set_alt' as const,
      targetTag: '/Figure',
      parentTagPath: [],
      pageImageCount: 1,
      textDensityHint: 'low' as const,
      imageEvidence: 'strong' as const,
    })),
    tableCandidates: [{
      id: 'table:1',
      ref: 'obj:50 0 R',
      pageNumberHints: [1],
      firstRowCellRefs: ['obj:51 0 R', 'obj:52 0 R'],
      headerCellRefs: [],
      hasHeaders: false,
      repairMode: 'safe',
      nearbyContext: ['Table 1 demographics'],
    }],
    readingOrderCandidates: [],
    readingOrderParentCandidates: [],
    linkCandidates: Array.from({ length: 9 }, (_, index) => ({
      id: `link:1:${index + 1}`,
      pageNumber: 1,
      url: `https://example.com/${index + 1}`,
      text: `https://example.com/${index + 1}`,
      bbox: { x: 0, y: 0.2, width: 0.4, height: 0.05 },
      annotationIndex: index,
      annotationContents: null,
      rawUrl: true,
      suggestedText: 'example resource',
    })),
  }
}

describe('semanticEnrichmentService', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.resetModules()
    vi.unstubAllGlobals()
    renderPdfPageToDataUrl.mockResolvedValue({
      width: 100,
      height: 100,
      buffer: Buffer.from('png'),
      dataUrl: `data:image/png;base64,${Buffer.from('png').toString('base64')}`,
    })
    cropDataUrlRegion.mockResolvedValue('data:image/png;base64,Y3JvcA==')
  })

  it('chunks semantic targets by type-specific batch sizes', async () => {
    const { buildSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const batches = buildSemanticRepairBatches({ context: makeContext(), analysis: makeAnalysisResult() })
    expect(batches.map(batch => `${batch.batchType}:${batch.headings.length || batch.figures.length || batch.tables.length || batch.links.length}`)).toEqual([
      'headings:8',
      'headings:1',
      'figures:1',
      'figures:1',
      'figures:1',
      'figures:1',
      'tables:1',
      'links:8',
      'links:1',
    ])
  })

  it('normalizes AI responses and drops unknown candidate ids', async () => {
    const { generateSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            tool_calls: [{
              function: {
                name: 'propose_semantic_repairs',
                arguments: JSON.stringify({
                  headings: [
                    { candidateId: 'heading:1:1', level: 'h3', confidence: 0.91, rationale: 'Looks like a subsection heading.' },
                    { candidateId: 'heading:999', level: 'H1', confidence: 1, rationale: 'bad' },
                  ],
                }),
              },
            }],
          },
        }],
      }),
    })) as any)

    const generated = await generateSemanticRepairBatches({
      buffer: Buffer.from('pdf'),
      filename: 'test.pdf',
      title: 'Test',
      language: 'en',
      analysis: makeAnalysisResult(),
      context: {
        ...makeContext(),
        figureCandidates: [],
        tableCandidates: [],
        linkCandidates: [],
        headingCandidates: [makeContext().headingCandidates[0]],
      },
    })

    expect(generated.reviewFlags).toEqual([])
    expect(generated.batches).toHaveLength(1)
    expect(generated.batches[0]?.headings).toEqual([{
      candidateId: 'heading:1:1',
      level: 'H3',
      confidence: 0.91,
      rationale: 'Looks like a subsection heading.',
    }])
  })

  it('routes each eligible figure as its own vision request with cropped image data', async () => {
    const { generateSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const fetchMock = vi.fn(async (_url, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'))
      const prompt = String(body.messages?.[0]?.content || '')
      expect(prompt).toContain('Batch type: figures')
      expect(prompt).toContain('"imageDataUrl":"data:image/png;base64,Y3JvcA=="')
      expect((prompt.match(/"candidateId":"figure:/g) || []).length).toBe(1)
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: 'propose_semantic_repairs',
                  arguments: JSON.stringify({
                    figures: [{ candidateId: 'figure:1', decorative: false, altText: 'Chart of outcomes', confidence: 0.9, rationale: 'Visible chart.' }],
                  }),
                },
              }],
            },
          }],
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock as any)

    await generateSemanticRepairBatches({
      buffer: Buffer.from('pdf'),
      filename: 'test.pdf',
      title: 'Test',
      language: 'en',
      analysis: makeAnalysisResult(),
      context: {
        ...makeContext(),
        headingCandidates: [],
        tableCandidates: [],
        linkCandidates: [],
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(cropDataUrlRegion).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ x: 0, y: 0, width: 1, height: 1 }),
      expect.objectContaining({ maxDimension: 768, maxBytes: 90000 }),
    )
  })

  it('includes informative figures even when they already have alt text', async () => {
    const { buildSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const context = makeContext()
    context.figureCandidates = [{
      ...context.figureCandidates[0],
      hasAlt: true,
      altText: 'Older alt text',
      informativeHint: 'informative',
    }]
    const batches = buildSemanticRepairBatches({ context, analysis: makeAnalysisResult() })
    expect(batches.filter(batch => batch.batchType === 'figures')).toHaveLength(1)
    expect(batches.find(batch => batch.batchType === 'figures')?.figures[0]?.id).toBe('figure:1')
  })

  it('skips clean categories even when candidates exist', async () => {
    const { buildSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const analysis = makeAnalysisResult()
    analysis.categories = [
      { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 40, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
      { id: 'table_markup', label: 'Table Markup', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'link_quality', label: 'Link Quality', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
    ] as any
    const batches = buildSemanticRepairBatches({ context: makeContext(), analysis })
    expect(batches.map(batch => batch.batchType)).toEqual(['figures', 'figures', 'figures', 'figures'])
  })

  it('still returns bookmark cleanup batches when bookmarks are the only remaining semantic work', async () => {
    const { buildSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const analysis = makeAnalysisResult()
    analysis.grade = 'B'
    analysis.verapdf = makeVeraPdfResult({ status: 'passed', isCompliant: true, failedChecks: 0, failures: [] })
    analysis.categories = [
      { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'table_markup', label: 'Table Markup', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'link_quality', label: 'Link Quality', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'bookmarks', label: 'Bookmarks / Navigation', weight: 0.1, score: 0, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
    ] as any
    const batches = buildSemanticRepairBatches({ context: makeContext(), analysis })
    expect(batches.map(batch => batch.batchType)).toEqual(['figures', 'figures', 'figures', 'figures', 'bookmarks'])
  })

  it('uses existing outline titles as bookmark AI input when available', async () => {
    const { generateSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const fetchMock = vi.fn(async (_url, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'))
      const prompt = String(body.messages?.[0]?.content || '')
      expect(prompt).toContain('Batch type: bookmarks')
      expect(prompt).toContain('Council members')
      expect(prompt).not.toContain('Heading 1')
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: 'propose_semantic_repairs',
                  arguments: JSON.stringify({
                    bookmarks: [{ candidateId: 'heading:1:1', title: 'Council members', level: 'H2', confidence: 0.92, rationale: 'Clean section label.' }],
                  }),
                },
              }],
            },
          }],
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock as any)

    const context = makeContext()
    context.figureCandidates = []
    context.tableCandidates = []
    context.linkCandidates = []
    context.qpdf.outlineTitles = ['b:436f756e63696c206d656d62657273']
    context.headingCandidates = [context.headingCandidates[0]]
    const analysis = makeAnalysisResult()
    analysis.categories = [
      { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'table_markup', label: 'Table Markup', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'link_quality', label: 'Link Quality', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'bookmarks', label: 'Bookmarks / Navigation', weight: 0.1, score: 0, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
    ] as any

    const generated = await generateSemanticRepairBatches({
      buffer: Buffer.from('pdf'),
      filename: 'test.pdf',
      title: 'Test',
      language: 'en',
      analysis,
      context,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(generated.batches).toHaveLength(1)
    expect(generated.batches[0]?.bookmarks[0]?.title).toBe('Council members')
  })

  it('keeps cleaner heading text when existing outline titles are raw toc noise', async () => {
    const { generateSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const fetchMock = vi.fn(async (_url, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'))
      const prompt = String(body.messages?.[0]?.content || '')
      expect(prompt).toContain('Batch type: bookmarks')
      expect(prompt).toContain('"text":"Council members"')
      expect(prompt).not.toContain('Council members .............. 6')
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: 'propose_semantic_repairs',
                  arguments: JSON.stringify({
                    bookmarks: [{ candidateId: 'heading:1:1', title: 'Council members', level: 'H2', confidence: 0.92, rationale: 'Clean section label.' }],
                  }),
                },
              }],
            },
          }],
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock as any)

    const context = makeContext()
    context.figureCandidates = []
    context.tableCandidates = []
    context.linkCandidates = []
    context.qpdf.outlineTitles = ['Council members .............. 6']
    context.headingCandidates = [{
      ...context.headingCandidates[0],
      text: 'Council members',
    }]
    const analysis = makeAnalysisResult()
    analysis.categories = [
      { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'table_markup', label: 'Table Markup', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'link_quality', label: 'Link Quality', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'bookmarks', label: 'Bookmarks / Navigation', weight: 0.1, score: 0, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
    ] as any

    await generateSemanticRepairBatches({
      buffer: Buffer.from('pdf'),
      filename: 'test.pdf',
      title: 'Test',
      language: 'en',
      analysis,
      context,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('strips decoded dot leaders and page numbers from outline bookmark seeds', async () => {
    const { generateSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const fetchMock = vi.fn(async (_url, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'))
      const prompt = String(body.messages?.[0]?.content || '')
      expect(prompt).toContain('"text":"2007 trust fund contributors"')
      expect(prompt).not.toContain('8383')
      expect(prompt).not.toContain(' 18"')
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: 'propose_semantic_repairs',
                  arguments: JSON.stringify({
                    bookmarks: [{ candidateId: 'heading:1:1', title: '2007 trust fund contributors', level: 'H2', confidence: 0.92, rationale: 'Clean section label.' }],
                  }),
                },
              }],
            },
          }],
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock as any)

    const context = makeContext()
    context.figureCandidates = []
    context.tableCandidates = []
    context.linkCandidates = []
    context.qpdf.outlineTitles = ['b:323030372074727573742066756e6420636f6e7472696275746f727320838383838383838383838383832e2e203138']
    context.headingCandidates = [{
      ...context.headingCandidates[0],
      text: 'Heading 1',
    }]
    const analysis = makeAnalysisResult()
    analysis.categories = [
      { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'table_markup', label: 'Table Markup', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'link_quality', label: 'Link Quality', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'bookmarks', label: 'Bookmarks / Navigation', weight: 0.1, score: 0, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
    ] as any

    await generateSemanticRepairBatches({
      buffer: Buffer.from('pdf'),
      filename: 'test.pdf',
      title: 'Test',
      language: 'en',
      analysis,
      context,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('builds bookmark cleanup targets from outline titles when heading candidates are sparse', async () => {
    const { generateSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const fetchMock = vi.fn(async (_url, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'))
      const prompt = String(body.messages?.[0]?.content || '')
      expect(prompt).toContain('"candidateId":"bookmark:outline:1"')
      expect(prompt).toContain('"pageNumber":6')
      expect(prompt).toContain('"text":"2008 Council members"')
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: 'propose_semantic_repairs',
                  arguments: JSON.stringify({
                    bookmarks: [
                      { candidateId: 'bookmark:outline:1', title: 'Council members', level: 'H2', confidence: 0.94, rationale: 'Clean section title.' },
                    ],
                  }),
                },
              }],
            },
          }],
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock as any)

    const context = makeContext()
    context.figureCandidates = []
    context.tableCandidates = []
    context.linkCandidates = []
    context.headingCandidates = []
    context.qpdf.outlineTitles = [
      'b:3230303820436f756e63696c206d656d62657273208383838383838383838383838383832e2036',
      'u:2008 programs and participating agencies………………….. 15',
    ]
    const analysis = makeAnalysisResult()
    analysis.categories = [
      { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'table_markup', label: 'Table Markup', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'link_quality', label: 'Link Quality', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'bookmarks', label: 'Bookmarks / Navigation', weight: 0.1, score: 0, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
    ] as any

    const generated = await generateSemanticRepairBatches({
      buffer: Buffer.from('pdf'),
      filename: 'annual-report.pdf',
      title: 'Annual report',
      language: 'en',
      analysis,
      context,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(generated.batches[0]?.bookmarks[0]).toMatchObject({
      candidateId: 'bookmark:outline:1',
      pageNumber: 6,
      title: 'Council members',
    })
  })

  it('still returns figure batches for fully compliant results when AI-first figures are eligible', async () => {
    const { buildSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const analysis = makeAnalysisResult()
    analysis.grade = 'A'
    analysis.verapdf = makeVeraPdfResult({ status: 'passed', isCompliant: true, failedChecks: 0, failures: [] })
    analysis.categories = [
      { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'table_markup', label: 'Table Markup', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'link_quality', label: 'Link Quality', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
    ] as any
    const batches = buildSemanticRepairBatches({ context: makeContext(), analysis })
    expect(batches.map(batch => batch.batchType)).toEqual(['figures', 'figures', 'figures', 'figures'])
  })

  it('retries oversized heading batches with smaller requests', async () => {
    const { generateSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 413,
        text: async () => '{"error":{"message":"context_length_exceeded"}}',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: 'propose_semantic_repairs',
                  arguments: JSON.stringify({
                    headings: [{ candidateId: 'heading:1:1', level: 'H2', confidence: 0.9, rationale: 'Section heading' }],
                  }),
                },
              }],
            },
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: 'propose_semantic_repairs',
                  arguments: JSON.stringify({
                    headings: [{ candidateId: 'heading:1:2', level: 'H3', confidence: 0.88, rationale: 'Subsection heading' }],
                  }),
                },
              }],
            },
          }],
        }),
      })
    vi.stubGlobal('fetch', fetchMock as any)

    const generated = await generateSemanticRepairBatches({
      buffer: Buffer.from('pdf'),
      filename: 'test.pdf',
      title: 'Test',
      language: 'en',
      analysis: makeAnalysisResult(),
      context: {
        ...makeContext(),
        figureCandidates: [],
        tableCandidates: [],
        linkCandidates: [],
        headingCandidates: makeContext().headingCandidates.slice(0, 2),
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(generated.reviewFlags).toEqual([])
    expect(generated.batches.flatMap(batch => batch.headings.map(item => item.candidateId))).toEqual(['heading:1:1', 'heading:1:2'])
  })

  it('skips oversized single-target figure requests instead of throwing', async () => {
    const { generateSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 413,
      text: async () => '{"error":{"message":"context_length_exceeded"}}',
    })) as any)

    const generated = await generateSemanticRepairBatches({
      buffer: Buffer.from('pdf'),
      filename: 'test.pdf',
      title: 'Test',
      language: 'en',
      analysis: makeAnalysisResult(),
      context: {
        ...makeContext(),
        headingCandidates: [],
        tableCandidates: [],
        linkCandidates: [],
        figureCandidates: [makeContext().figureCandidates[0]],
      },
    })

    expect(generated.batches).toEqual([])
    expect(generated.reviewFlags.some(flag => flag.code === 'semantic_enrichment_skipped')).toBe(true)
  })

  it('returns partial results when some semantic retries succeed and others are skipped', async () => {
    const { generateSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: 'propose_semantic_repairs',
                  arguments: JSON.stringify({
                    headings: [{ candidateId: 'heading:1:1', level: 'H2', confidence: 0.93, rationale: 'Heading' }],
                  }),
                },
              }],
            },
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 413,
        text: async () => '{"error":{"message":"context_length_exceeded"}}',
      })
    vi.stubGlobal('fetch', fetchMock as any)

    const generated = await generateSemanticRepairBatches({
      buffer: Buffer.from('pdf'),
      filename: 'test.pdf',
      title: 'Test',
      language: 'en',
      analysis: makeAnalysisResult(),
      context: {
        ...makeContext(),
        headingCandidates: [makeContext().headingCandidates[0]],
        figureCandidates: [makeContext().figureCandidates[0]],
        tableCandidates: [],
        linkCandidates: [],
      },
    })

    expect(generated.batches).toHaveLength(1)
    expect(generated.batches[0]?.batchType).toBe('headings')
    expect(generated.reviewFlags.some(flag => flag.code === 'semantic_enrichment_skipped')).toBe(true)
  })
})
