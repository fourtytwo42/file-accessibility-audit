import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AnalysisResult } from '../services/pdfAnalyzer.js'
import type { PdfMetadata } from '../services/pdfjsService.js'
import type { VeraPdfResult } from '../services/veraPdfService.js'

const analyzePDF = vi.fn()
const inspectPdfForRemediation = vi.fn()
const executeRemediationTool = vi.fn()
const planRemediationActions = vi.fn()
const generateSemanticRepairBatches = vi.fn()

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

vi.mock('../services/pdfAnalyzer.js', () => ({
  analyzePDF,
}))

vi.mock('../services/pdfRemediationTools.js', () => ({
  inspectPdfForRemediation,
  executeRemediationTool,
  mergeManualReviewFlags: (existing: any[], next: any[]) => [...existing, ...next],
  toAppliedChange: () => null,
  toSuggestedChange: () => null,
}))

vi.mock('../services/remediationPlanService.js', () => ({
  planRemediationActions,
}))

vi.mock('../services/semanticEnrichmentService.js', () => ({
  generateSemanticRepairBatches,
}))

describe('agentRemediationService', { timeout: 15_000 }, () => {
  beforeEach(() => {
    vi.resetAllMocks()
    generateSemanticRepairBatches.mockResolvedValue({ batches: [], reviewFlags: [] })
  })

  it('refreshes inspection context after document-changing actions within the same iteration', async () => {
    const { remediatePdfWithAgent } = await import('../services/agentRemediationService.js')
    const pdfMetadata: PdfMetadata = {
      creator: null,
      producer: null,
      creationDate: null,
      modDate: null,
      pdfVersion: '1.7',
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 10,
    }
    const originalResult: AnalysisResult = {
      filename: 'example.pdf',
      pageCount: 10,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 58,
      grade: 'F',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult(),
      categories: [
        { id: 'title_language', label: 'Document Title & Language', weight: 0.15, score: 50, grade: 'F', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 0, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    const refreshedResult: AnalysisResult = {
      ...originalResult,
      overallScore: 90,
      grade: 'A',
      categories: [
        { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass' },
        { ...originalResult.categories[1], score: 100, grade: 'A', severity: 'Pass' },
      ],
    }

    inspectPdfForRemediation
      .mockResolvedValueOnce({
        pdfjs: { title: null, lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 1 },
        figureCandidates: [{ id: 'figure:1', targetRef: 'obj:old 0 R' }],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: {},
      })
      .mockResolvedValueOnce({
        pdfjs: { title: 'Updated title', lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 1 },
        figureCandidates: [{ id: 'figure:1', targetRef: 'obj:new 0 R' }],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: {},
      })
      .mockResolvedValueOnce({
        pdfjs: { title: 'Updated title', lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 1 },
        figureCandidates: [{ id: 'figure:1', targetRef: 'obj:new 0 R' }],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: {},
      })
      .mockResolvedValueOnce({
        pdfjs: { title: 'Updated title', lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 1 },
        figureCandidates: [{ id: 'figure:1', targetRef: 'obj:new 0 R' }],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: {},
      })

    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['title_language', 'alt_text'],
        actions: [
          { tool_name: 'set_document_title', arguments: { title: 'Updated title' }, rationale: 'Set title', confidence: 0.8 },
          { tool_name: 'set_figure_alt_text', arguments: { candidateId: 'figure:1', altText: 'Updated alt text' }, rationale: 'Set alt text', confidence: 0.8 },
        ],
      })
      .mockResolvedValueOnce({
        done: true,
        unresolvedIssues: [],
        actions: [],
      })

    executeRemediationTool
      .mockImplementationOnce(async ({ buffer }: any) => ({
        buffer: Buffer.concat([buffer, Buffer.from('1')]),
        action: {
          tool: 'set_document_title',
          target: 'document',
          details: 'title updated',
          confidence: 0.8,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['title_language'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      }))
      .mockImplementationOnce(async ({ context, buffer }: any) => ({
        buffer: Buffer.concat([buffer, Buffer.from(context.figureCandidates[0].targetRef === 'obj:new 0 R' ? '2' : 'x')]),
        action: {
          tool: 'set_figure_alt_text',
          target: 'document',
          candidateId: 'figure:1',
          details: context.figureCandidates[0].targetRef,
          confidence: 0.8,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: context.figureCandidates[0].targetRef === 'obj:new 0 R',
          categoryTargets: ['alt_text'],
          outcome: context.figureCandidates[0].targetRef === 'obj:new 0 R' ? 'applied' : 'no_effect',
        },
        manualReviewFlags: [],
      }))

    analyzePDF.mockResolvedValue(refreshedResult)

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'example.pdf', originalResult)

    expect(inspectPdfForRemediation).toHaveBeenCalledTimes(3)
    expect(executeRemediationTool.mock.calls[1]?.[0]?.context?.figureCandidates?.[0]?.targetRef).toBe('obj:new 0 R')
    expect(result.model.actions?.map(action => action.outcome)).toEqual(['applied', 'applied'])
    expect(result.model.failureProfile?.version).toBe('1')
    expect(result.model.failureProfile?.toolOpportunities.length).toBeGreaterThan(0)
    expect(result.model.plannerEvidence).toBeTruthy()
    expect(result.finalResult.overallScore).toBe(90)
  })

  it('keeps scanned documents on the patch path when no actions are available', async () => {
    const { remediatePdfWithAgent } = await import('../services/agentRemediationService.js')
    const pdfMetadata: PdfMetadata = {
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
    }
    const originalResult: AnalysisResult = {
      filename: 'scan.pdf',
      pageCount: 3,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 0,
      grade: 'F',
      isScanned: true,
      executiveSummary: '',
      verapdf: makeVeraPdfResult(),
      categories: [
        { id: 'text_extractability', label: 'Text Extractability', weight: 0.2, score: 0, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
        { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 0, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
        { id: 'bookmarks', label: 'Bookmarks / Navigation', weight: 0.1, score: 0, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: null, lang: 'en' },
      qpdf: { lang: null, headings: [], tables: [], images: [], formFields: [], hasStructTree: false, outlineCount: 0, structTreeDepth: 0 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    })
    planRemediationActions.mockResolvedValue({ done: false, unresolvedIssues: ['text_extractability'], actions: [] })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'scan.pdf', originalResult)

    expect(result.buffer.equals(Buffer.from('pdf'))).toBe(true)
    expect(result.model.processingPath).toBe('agent_patch')
    expect(result.model.pathFallbacks).toEqual([])
    expect(result.finalResult.grade).toBe('F')
    expect(result.model.manualReviewFlags.some(flag => flag.code === 'manual_rebuild_required')).toBe(true)
  })

  it('does not escalate native documents after no-effect structural remediation', async () => {
    const { remediatePdfWithAgent } = await import('../services/agentRemediationService.js')
    const pdfMetadata: PdfMetadata = {
      creator: null,
      producer: null,
      creationDate: null,
      modDate: null,
      pdfVersion: '1.7',
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 12,
    }
    const originalResult: AnalysisResult = {
      filename: 'native.pdf',
      pageCount: 12,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 49,
      grade: 'F',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult(),
      categories: [
        { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 0, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
        { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 0, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Native Report', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 4 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    })
    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['heading_structure', 'alt_text'],
        actions: [
          { tool_name: 'set_document_language', arguments: { language: 'en' }, rationale: 'Set language', confidence: 0.6 },
        ],
      })
      .mockResolvedValueOnce({ done: true, unresolvedIssues: [], actions: [] })
    executeRemediationTool.mockResolvedValue({
      buffer: Buffer.from('pdf-1'),
      action: {
        tool: 'set_document_language',
        target: 'document',
        details: 'language updated',
        confidence: 0.6,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['title_language'],
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })
    analyzePDF
      .mockResolvedValueOnce(originalResult)
      .mockResolvedValueOnce({
        ...originalResult,
        overallScore: 49,
        grade: 'F',
        categories: originalResult.categories,
      })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'native.pdf', originalResult)

    expect(result.buffer.equals(Buffer.from('pdf-1'))).toBe(true)
    expect(result.model.processingPath).toBe('agent_patch')
    expect(result.model.pathFallbacks).toEqual([])
    expect(result.finalResult.grade).toBe('F')
  })

  it('exits before semantic AI when native remediation reaches A and veraPDF passes', async () => {
    const { remediatePdfWithAgent } = await import('../services/agentRemediationService.js')
    const pdfMetadata: PdfMetadata = {
      creator: null,
      producer: null,
      creationDate: null,
      modDate: null,
      pdfVersion: '1.7',
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 5,
    }
    const originalResult: AnalysisResult = {
      filename: 'fast.pdf',
      pageCount: 5,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 64,
      grade: 'D',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 6,
        failures: [{ ruleId: 'meta', specification: null, clause: null, testNumber: null, location: null, message: 'Metadata issue', categoryIds: [] }],
      }),
      categories: [
        { id: 'title_language', label: 'Document Title & Language', weight: 0.15, score: 50, grade: 'F', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Fast', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    })
    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['title_language'],
        actions: [
          { tool_name: 'normalize_document_metadata', arguments: { title: 'Fast', language: 'en' }, rationale: 'metadata', confidence: 0.9 },
        ],
      })
      .mockResolvedValueOnce({ done: true, unresolvedIssues: [], actions: [] })
    executeRemediationTool.mockResolvedValue({
      buffer: Buffer.from('fast-fixed'),
      action: {
        tool: 'normalize_document_metadata',
        target: 'document',
        details: 'metadata normalized',
        confidence: 0.9,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['title_language'],
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })
    analyzePDF.mockResolvedValue({
      ...originalResult,
      overallScore: 100,
      grade: 'A',
      verapdf: makeVeraPdfResult(),
      categories: [
        { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass' },
      ],
    })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'fast.pdf', originalResult)

    expect(generateSemanticRepairBatches).not.toHaveBeenCalled()
    expect(result.finalResult.grade).toBe('A')
    expect(result.finalResult.verapdf.status).toBe('passed')
  })

  it('skips semantic AI when semantic categories are already all complete', async () => {
    const { remediatePdfWithAgent } = await import('../services/agentRemediationService.js')
    const pdfMetadata: PdfMetadata = {
      creator: null,
      producer: null,
      creationDate: null,
      modDate: null,
      pdfVersion: '1.7',
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 4,
    }
    const originalResult: AnalysisResult = {
      filename: 'done-semantics.pdf',
      pageCount: 4,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 2, linkCount: 2, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 80,
      grade: 'B',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 4,
        failures: [{ ruleId: 'other', specification: null, clause: null, testNumber: null, location: null, message: 'Other issue', categoryIds: [] }],
      }),
      categories: [
        { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
        { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
        { id: 'table_markup', label: 'Table Markup', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
        { id: 'link_quality', label: 'Link Quality', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Done Semantics', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [{ id: 'figure:1', targetRef: 'obj:1 0 R' }],
      tableCandidates: [],
      headingCandidates: [{ id: 'heading:1:1', pageNumber: 1, text: 'Done', bbox: { x: 0, y: 0, width: 0.2, height: 0.05 }, fontSize: 18, fontWeight: 'bold', nearbyContext: [], targetRef: 'obj:2 0 R', existingTag: '/H1', repairMode: 'safe' }],
      pages: [],
      linkCandidates: [{ id: 'link:1:1', pageNumber: 1, url: 'https://example.com', text: 'Example', bbox: { x: 0, y: 0, width: 0.2, height: 0.02 }, annotationIndex: 0, rawUrl: false, annotationContents: 'Example', suggestedText: null }],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    })
    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: [], actions: [] })

    await remediatePdfWithAgent(Buffer.from('pdf'), 'done-semantics.pdf', originalResult)

    expect(generateSemanticRepairBatches).not.toHaveBeenCalled()
  })

  it('applies post-native semantic AI fixes through native tools', async () => {
    const { remediatePdfWithAgent } = await import('../services/agentRemediationService.js')
    const pdfMetadata: PdfMetadata = {
      creator: null,
      producer: null,
      creationDate: null,
      modDate: null,
      pdfVersion: '1.7',
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 6,
    }
    const originalResult: AnalysisResult = {
      filename: 'semantic.pdf',
      pageCount: 6,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 2, rawUrlLinkCount: 1, rawUrlLinkDensity: 0.5 },
      overallScore: 62,
      grade: 'D',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 10,
        failures: [{ ruleId: 'headings', specification: null, clause: null, testNumber: null, location: null, message: 'Heading semantics missing', categoryIds: [] }],
      }),
      categories: [
        { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 40, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    const context = {
      pdfjs: { title: 'Semantic Report', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 3 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [{
        id: 'heading:1:1',
        pageNumber: 1,
        text: 'Executive Summary',
        bbox: { x: 0, y: 0, width: 0.3, height: 0.05 },
        fontSize: 18,
        fontWeight: 'bold',
        nearbyContext: ['This report summarizes findings.'],
        targetRef: 'obj:10 0 R',
        existingTag: '/P',
        repairMode: 'safe',
      }],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [{ ref: 'obj:10 0 R', tag: '/P', orderIndex: 0 }] },
    }

    inspectPdfForRemediation.mockResolvedValue(context)
    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: ['heading_structure'], actions: [] })
    generateSemanticRepairBatches.mockResolvedValue({ batches: [{
      batchType: 'headings',
      headings: [{ candidateId: 'heading:1:1', level: 'H1', confidence: 0.91, rationale: 'Top-level section heading.' }],
      figures: [],
      tables: [],
      links: [],
    }], reviewFlags: [] })
    executeRemediationTool.mockResolvedValue({
      buffer: Buffer.from('semantic-fixed'),
      action: {
        tool: 'create_heading_from_candidate',
        target: 'page 1',
        candidateId: 'heading:1:1',
        details: 'AI heading proposal',
        confidence: 0.91,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['heading_structure'],
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })
    analyzePDF.mockResolvedValue({
      ...originalResult,
      overallScore: 81,
      grade: 'B',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 4,
        failures: [{ ruleId: 'remaining', specification: null, clause: null, testNumber: null, location: null, message: 'Remaining issue', categoryIds: [] }],
      }),
      categories: [
        { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass' },
      ],
    })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'semantic.pdf', originalResult)

    expect(generateSemanticRepairBatches).toHaveBeenCalledTimes(1)
    expect(executeRemediationTool).toHaveBeenCalledTimes(1)
    expect(result.buffer.equals(Buffer.from('semantic-fixed'))).toBe(true)
    expect(result.model.actions?.some(action => action.tool === 'create_heading_from_candidate' && action.outcome === 'applied')).toBe(true)
    expect(result.finalResult.overallScore).toBe(81)
  })

  it('rejects regressive semantic AI batches', async () => {
    const { remediatePdfWithAgent } = await import('../services/agentRemediationService.js')
    const pdfMetadata: PdfMetadata = {
      creator: null,
      producer: null,
      creationDate: null,
      modDate: null,
      pdfVersion: '1.7',
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 4,
    }
    const originalResult: AnalysisResult = {
      filename: 'links.pdf',
      pageCount: 4,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 1, rawUrlLinkCount: 1, rawUrlLinkDensity: 1 },
      overallScore: 70,
      grade: 'C',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 12,
        failures: [{ ruleId: 'links', specification: null, clause: null, testNumber: null, location: null, message: 'Link issue', categoryIds: [] }],
      }),
      categories: [
        { id: 'link_quality', label: 'Link Quality', weight: 0.15, score: 65, grade: 'D', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Links', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [{
        id: 'link:1:1',
        pageNumber: 1,
        url: 'https://example.com',
        text: 'https://example.com',
        bbox: { x: 0, y: 0, width: 0.2, height: 0.03 },
        annotationIndex: 0,
        annotationContents: null,
        rawUrl: true,
        suggestedText: 'example resource',
      }],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    })
    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: ['link_quality'], actions: [] })
    generateSemanticRepairBatches.mockResolvedValue({ batches: [{
      batchType: 'links',
      headings: [],
      figures: [],
      tables: [],
      links: [{ candidateId: 'link:1:1', replacementText: 'Example', annotationContents: 'Example link', confidence: 0.92, rationale: 'Short descriptive label.' }],
    }], reviewFlags: [] })
    executeRemediationTool.mockResolvedValue({
      buffer: Buffer.from('worse-links'),
      action: {
        tool: 'rewrite_link_visible_text',
        target: 'page 1',
        candidateId: 'link:1:1',
        details: 'AI link proposal',
        confidence: 0.92,
        autoApplied: true,
        changedVisibleContent: true,
        changedDocumentBytes: true,
        categoryTargets: ['link_quality'],
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })
    analyzePDF.mockResolvedValue({
      ...originalResult,
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 16,
        failures: [
          { ruleId: 'links', specification: null, clause: null, testNumber: null, location: null, message: 'Link issue', categoryIds: [] },
          { ruleId: 'new', specification: null, clause: null, testNumber: null, location: null, message: 'New issue', categoryIds: [] },
        ],
      }),
    })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'links.pdf', originalResult)

    expect(result.buffer.equals(Buffer.from('pdf'))).toBe(true)
    expect(result.model.rejectedActions?.some(action => action.tool === 'rewrite_link_visible_text')).toBe(true)
    expect(result.finalResult.verapdf.failedChecks).toBe(12)
  })

  it('rejects regressive structure mutations for already-tagged native PDFs', async () => {
    const { remediatePdfWithAgent } = await import('../services/agentRemediationService.js')
    const pdfMetadata: PdfMetadata = {
      creator: null,
      producer: null,
      creationDate: null,
      modDate: null,
      pdfVersion: '1.7',
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 37,
    }
    const originalResult: AnalysisResult = {
      filename: 'tagged.pdf',
      pageCount: 37,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 5, linkCount: 20, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 67,
      grade: 'D',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 157,
        failures: [{ ruleId: 'rule-a', specification: null, clause: null, testNumber: null, location: null, message: 'Existing issue', categoryIds: [] }],
      }),
      categories: [
        { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 40, grade: 'F', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'reading_order', label: 'Reading Order', weight: 0.15, score: 40, grade: 'F', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation
      .mockResolvedValueOnce({
        pdfjs: { title: 'Tagged PDF', lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 5 },
        figureCandidates: [],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: { structuralNodes: [{ ref: 'obj:1 0 R', tag: '/Sect', orderIndex: 0 }] },
      })
      .mockResolvedValueOnce({
        pdfjs: { title: 'Tagged PDF', lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 5 },
        figureCandidates: [],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: { structuralNodes: [{ ref: 'obj:1 0 R', tag: '/Sect', orderIndex: 0 }] },
      })

    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['reading_order'],
        actions: [
          { tool_name: 'repair_structure_conformance', arguments: { target: 'document' }, rationale: 'repair', confidence: 0.9 },
        ],
      })
      .mockResolvedValueOnce({ done: true, unresolvedIssues: [], actions: [] })

    executeRemediationTool.mockResolvedValue({
      buffer: Buffer.from('pdf-regressive'),
      action: {
        tool: 'repair_structure_conformance',
        target: 'document',
        details: 'structure repaired',
        confidence: 0.9,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['reading_order'],
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })

    analyzePDF.mockResolvedValueOnce({
      ...originalResult,
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 185,
        failures: [
          { ruleId: 'rule-a', specification: null, clause: null, testNumber: null, location: null, message: 'Existing issue', categoryIds: [] },
          { ruleId: 'rule-note', specification: null, clause: null, testNumber: null, location: null, message: 'Note tag shall have ID entry', categoryIds: [] },
        ],
      }),
    })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'tagged.pdf', originalResult)

    expect(result.buffer.equals(Buffer.from('pdf'))).toBe(true)
    expect(result.model.nativeTaggedSafeMode).toBe(true)
    expect(result.model.rejectedActions?.some(action => action.tool === 'repair_structure_conformance')).toBe(true)
    expect(result.model.plannerEvidence?.rejectedKeys.some(key => key === 'repair_structure_conformance:document')).toBe(true)
    expect(result.model.actions?.[0]?.outcome).toBe('rejected')
    expect(result.finalResult.verapdf.failedChecks).toBe(157)
  })

  it('keeps the native result when semantic generation overflows', async () => {
    const { remediatePdfWithAgent } = await import('../services/agentRemediationService.js')
    const pdfMetadata: PdfMetadata = {
      creator: null,
      producer: null,
      creationDate: null,
      modDate: null,
      pdfVersion: '1.7',
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 4,
    }
    const originalResult: AnalysisResult = {
      filename: 'semantic-overflow.pdf',
      pageCount: 4,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 1, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 70,
      grade: 'C',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 8,
        failures: [{ ruleId: 'headings', specification: null, clause: null, testNumber: null, location: null, message: 'Heading issue', categoryIds: [] }],
      }),
      categories: [
        { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 60, grade: 'D', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Overflow', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [{
        id: 'heading:1:1',
        pageNumber: 1,
        text: 'Overview',
        bbox: { x: 0, y: 0, width: 0.3, height: 0.05 },
        fontSize: 18,
        fontWeight: 'bold',
        nearbyContext: ['Nearby context'],
        targetRef: 'obj:10 0 R',
        existingTag: '/P',
        repairMode: 'safe',
      }],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    })
    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: ['heading_structure'], actions: [] })
    generateSemanticRepairBatches.mockRejectedValue(new Error('OpenAI-compatible semantic repair request failed: 413 {"error":{"message":"context_length_exceeded"}}'))

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'semantic-overflow.pdf', originalResult)

    expect(result.buffer.equals(Buffer.from('pdf'))).toBe(true)
    expect(result.finalResult).toBe(originalResult)
    expect(result.model.manualReviewFlags.some(flag => flag.code === 'semantic_enrichment_skipped')).toBe(true)
  })

})
