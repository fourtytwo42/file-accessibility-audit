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
      'figures:4',
      'tables:1',
      'links:8',
      'links:1',
    ])
  })

  it('caps semantic link batches on heavy-link documents', async () => {
    const { buildSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const context = makeContext()
    context.headingCandidates = []
    context.figureCandidates = []
    context.tableCandidates = []
    context.linkCandidates = Array.from({ length: 146 }, (_, index) => ({
      id: `link:1:${index + 1}`,
      pageNumber: 1 + Math.floor(index / 10),
      url: `https://example.com/${index + 1}`,
      text: `https://example.com/${index + 1}`,
      bbox: { x: 0, y: 0.2, width: 0.4, height: 0.05 },
      annotationIndex: index,
      annotationContents: null,
      rawUrl: true,
      suggestedText: 'example resource',
    }))
    const analysis = makeAnalysisResult()
    analysis.categories = [
      { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'table_markup', label: 'Table Markup', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'link_quality', label: 'Link Quality', weight: 0.1, score: 25, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
    ] as any

    const batches = buildSemanticRepairBatches({ context, analysis })
    expect(batches.map(batch => `${batch.batchType}:${batch.links.length}`)).toEqual([
      'links:8',
      'links:8',
      'links:8',
      'links:8',
    ])
  })

  it('skips semantic link batches for deterministic-only annotation contents debt', async () => {
    const { buildSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const context = makeContext()
    context.headingCandidates = []
    context.figureCandidates = []
    context.tableCandidates = []
    context.linkCandidates = Array.from({ length: 12 }, (_, index) => ({
      id: `link:det:${index + 1}`,
      pageNumber: 1,
      url: `https://example.com/det-${index + 1}`,
      text: `Reference ${index + 1}`,
      bbox: { x: 0, y: 0.2, width: 0.4, height: 0.05 },
      annotationIndex: index,
      annotationContents: null,
      rawUrl: false,
      suggestedText: null,
    }))
    const analysis = makeAnalysisResult()
    analysis.categories = [
      { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'table_markup', label: 'Table Markup', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      { id: 'link_quality', label: 'Link Quality', weight: 0.1, score: 25, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
    ] as any

    const batches = buildSemanticRepairBatches({ context, analysis })
    expect(batches).toEqual([])
  })

  it('skips candidates already tagged as specific headings', async () => {
    const { buildSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const context = makeContext()
    context.figureCandidates = []
    context.tableCandidates = []
    context.linkCandidates = []
    context.headingCandidates = [
      {
        ...context.headingCandidates[0],
        id: 'heading:already-h2',
        existingTag: '/H2',
      },
      {
        ...context.headingCandidates[1],
        id: 'heading:already-h1',
        existingTag: 'H1',
      },
      {
        ...context.headingCandidates[2],
        id: 'heading:generic-h',
        existingTag: '/H',
      },
      {
        ...context.headingCandidates[3],
        id: 'heading:paragraph',
        existingTag: '/P',
      },
    ]

    const batches = buildSemanticRepairBatches({ context, analysis: makeAnalysisResult() })
    expect(batches.filter(batch => batch.batchType === 'headings')).toHaveLength(1)
    expect(batches.find(batch => batch.batchType === 'headings')?.headings.map(entry => entry.id)).toEqual([
      'heading:generic-h',
      'heading:paragraph',
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

  it('batches eligible figures into one vision request with cropped image data', async () => {
    const { generateSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const fetchMock = vi.fn(async (_url, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'))
      const prompt = String(body.messages?.[0]?.content || '')
      expect(prompt).toContain('Batch type: figures')
      expect(prompt).toContain('"imageDataUrl":"data:image/png;base64,Y3JvcA=="')
      expect((prompt.match(/"candidateId":"figure:/g) || []).length).toBe(4)
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: 'propose_semantic_repairs',
                  arguments: JSON.stringify({
                    figures: [
                      { candidateId: 'figure:1', decorative: false, altText: 'Chart of outcomes 1', confidence: 0.9, rationale: 'Visible chart.' },
                      { candidateId: 'figure:2', decorative: false, altText: 'Chart of outcomes 2', confidence: 0.9, rationale: 'Visible chart.' },
                      { candidateId: 'figure:3', decorative: false, altText: 'Chart of outcomes 3', confidence: 0.9, rationale: 'Visible chart.' },
                      { candidateId: 'figure:4', decorative: false, altText: 'Chart of outcomes 4', confidence: 0.9, rationale: 'Visible chart.' },
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

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cropDataUrlRegion).toHaveBeenCalledTimes(4)
    expect(cropDataUrlRegion).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ x: 0, y: 0, width: 1, height: 1 }),
      expect.objectContaining({ maxDimension: 768, maxBytes: 90000 }),
    )
  })

  it('falls back to deterministic figure alt text when the model returns an empty alt string', async () => {
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
                  figures: [
                    { candidateId: 'figure:1', decorative: false, altText: '', confidence: 0.91, rationale: 'Image is meaningful but the model did not describe it.' },
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
        headingCandidates: [],
        tableCandidates: [],
        linkCandidates: [],
      },
    })

    expect(generated.batches).toHaveLength(1)
    expect(generated.batches[0]?.figures[0]).toMatchObject({
      candidateId: 'figure:1',
      decorative: false,
      altText: 'of outcomes',
    })
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
    expect(batches.map(batch => `${batch.batchType}:${batch.figures.length || batch.headings.length || batch.tables.length || batch.links.length}`)).toEqual(['figures:4'])
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
    expect(batches.map(batch => `${batch.batchType}:${batch.figures.length || batch.headings.length || batch.tables.length || batch.links.length}`)).toEqual(['figures:4', 'bookmarks:1'])
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
    expect(batches.map(batch => `${batch.batchType}:${batch.figures.length || batch.headings.length || batch.tables.length || batch.links.length}`)).toEqual(['figures:4'])
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

  it('retries oversized single-target figure requests without page images before skipping', async () => {
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
                    figures: [
                      { candidateId: 'figure:1', decorative: false, altText: 'Chart 1', confidence: 0.9, rationale: 'Visible chart.' },
                    ],
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
        headingCandidates: [],
        tableCandidates: [],
        linkCandidates: [],
        figureCandidates: [makeContext().figureCandidates[0]],
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstRequestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    const secondRequestBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    const firstPrompt = String(firstRequestBody.messages?.[0]?.content || '')
    const secondPrompt = String(secondRequestBody.messages?.[0]?.content || '')
    expect(firstPrompt).toContain('"imageDataUrl":"data:image/png;base64,Y3JvcA=="')
    expect(secondPrompt).not.toContain('"imageDataUrl":"data:image/png;base64,Y3JvcA=="')
    expect(generated.batches.flatMap(batch => batch.figures.map(item => item.candidateId))).toEqual(['figure:1'])
    expect(generated.reviewFlags).toEqual([])
  })

  it('splits oversized multi-figure requests before falling back to singletons', async () => {
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
                    figures: [
                      { candidateId: 'figure:1', decorative: false, altText: 'Chart 1', confidence: 0.9, rationale: 'Visible chart.' },
                      { candidateId: 'figure:2', decorative: false, altText: 'Chart 2', confidence: 0.9, rationale: 'Visible chart.' },
                    ],
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
                    figures: [
                      { candidateId: 'figure:3', decorative: false, altText: 'Chart 3', confidence: 0.9, rationale: 'Visible chart.' },
                      { candidateId: 'figure:4', decorative: false, altText: 'Chart 4', confidence: 0.9, rationale: 'Visible chart.' },
                    ],
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
        headingCandidates: [],
        tableCandidates: [],
        linkCandidates: [],
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const promptSizes = fetchMock.mock.calls.map(call => {
      const body = JSON.parse(String(call[1]?.body || '{}'))
      const prompt = String(body.messages?.[0]?.content || '')
      return (prompt.match(/"candidateId":"figure:/g) || []).length
    })
    expect(promptSizes).toEqual([4, 2, 2])
    expect(generated.batches.flatMap(batch => batch.figures.map(item => item.candidateId))).toEqual([
      'figure:1',
      'figure:2',
      'figure:3',
      'figure:4',
    ])
  })

  it('resolves independent semantic batch types concurrently while preserving output order', async () => {
    const { generateSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    const resolveOrder: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init: any) => {
      const body = JSON.parse(String(init?.body || '{}'))
      const prompt = String(body.messages?.[0]?.content || '')
      const batchType = /Batch type: (\w+)/.exec(prompt)?.[1] || 'unknown'
      const delayMs = batchType === 'figures' ? 40 : batchType === 'tables' ? 20 : 0
      await new Promise(resolve => setTimeout(resolve, delayMs))
      resolveOrder.push(batchType)
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: 'propose_semantic_repairs',
                  arguments: JSON.stringify({
                    headings: batchType === 'headings' ? [{ candidateId: 'heading:1:1', level: 'H2', confidence: 0.9, rationale: 'Heading' }] : [],
                    figures: batchType === 'figures' ? [{ candidateId: 'figure:1', decorative: false, altText: 'Chart 1', confidence: 0.9, rationale: 'Figure' }] : [],
                    tables: batchType === 'tables' ? [{ candidateId: 'table:1', useFirstRowAsHeader: true, confidence: 0.9, rationale: 'Table' }] : [],
                    links: batchType === 'links' ? [{ candidateId: 'link:1:1', replacementText: 'Resource', annotationContents: 'Resource link', confidence: 0.9, rationale: 'Link' }] : [],
                  }),
                },
              }],
            },
          }],
        }),
      }
    }) as any)

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
        tableCandidates: [makeContext().tableCandidates[0]],
        linkCandidates: [makeContext().linkCandidates[0]],
      },
    })

    expect(resolveOrder).not.toEqual(['headings', 'figures', 'tables', 'links'])
    expect(generated.batches.map(batch => batch.batchType)).toEqual(['headings', 'figures', 'tables', 'links'])
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

  it('treats semantic provider 5xx errors as a recoverable skipped sidecar', async () => {
    const { generateSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => 'bad gateway',
    })) as any)

    const generated = await generateSemanticRepairBatches({
      buffer: Buffer.from('pdf'),
      filename: 'test.pdf',
      title: 'Test',
      language: 'en',
      analysis: makeAnalysisResult(),
      context: {
        ...makeContext(),
        headingCandidates: [makeContext().headingCandidates[0]],
        figureCandidates: [],
        tableCandidates: [],
        linkCandidates: [],
      },
    })

    expect(generated.batches).toHaveLength(0)
    expect(generated.reviewFlags.some(flag => flag.code === 'semantic_enrichment_skipped')).toBe(true)
    expect(generated.reviewFlags.some(flag => /semantic provider unavailable/i.test(flag.details))).toBe(true)
  })

  it('times out hung semantic provider requests instead of waiting indefinitely', async () => {
    vi.useFakeTimers()
    process.env.SEMANTIC_REQUEST_TIMEOUT_MS = '5'
    const { generateSemanticRepairBatches } = await import('../services/semanticEnrichmentService.js')
    vi.stubGlobal('fetch', vi.fn((_url, init: any) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(init.signal.reason || new Error('aborted'))
      })
    })) as any)

    const promise = generateSemanticRepairBatches({
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

    await vi.advanceTimersByTimeAsync(10)
    const generated = await promise
    expect(generated.batches).toHaveLength(0)
    expect(generated.reviewFlags.some(flag => flag.code === 'semantic_enrichment_skipped')).toBe(true)
    expect(generated.reviewFlags.some(flag => /semantic provider unavailable/i.test(flag.details))).toBe(true)
    delete process.env.SEMANTIC_REQUEST_TIMEOUT_MS
    vi.useRealTimers()
  })
})
