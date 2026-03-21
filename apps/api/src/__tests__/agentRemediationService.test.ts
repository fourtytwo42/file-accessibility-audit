import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AnalysisResult } from '../services/pdfAnalyzer.js'
import type { PdfMetadata } from '../services/pdfjsService.js'
import type { VeraPdfResult } from '../services/veraPdfService.js'

const analyzePDF = vi.fn()
const inspectPdfForRemediation = vi.fn()
const executeRemediationTool = vi.fn()
const planRemediationActions = vi.fn()
const generateSemanticRepairBatches = vi.fn()
const isOcrAvailable = vi.fn()
const ocrPdfToSearchablePdf = vi.fn()
const runPdfStructureBackendBatch = vi.fn()
const recordToolOutcomes = vi.fn()
const classifyPdf = vi.fn(() => 'native_tagged')
const buildFailureSignature = vi.fn(() => ({ failureModeKeys: [], pdfClass: 'tagged', hash: 'sig' }))
const findUsablePlaybookBySignatureHash = vi.fn(() => null)
const createPlaybookRun = vi.fn((input: any) => ({
  id: 'playbook-run-1',
  playbookId: input.playbook.id,
  failureSignatureHash: input.failureSignature.hash,
  pdfClass: input.failureSignature.pdfClass,
  matchedExact: true,
  outcome: 'pending',
  initialScore: input.initialScore,
  finalScore: null,
  createdAt: '2026-03-20T00:00:00.000Z',
  updatedAt: '2026-03-20T00:00:00.000Z',
  completedAt: null,
}))
const finalizePlaybookRun = vi.fn((input: any) => ({
  ...input.run,
  outcome: input.outcome,
  finalScore: input.finalScore,
}))
const learnFromSuccessfulRemediation = vi.fn()
const deriveDeterministicCall = vi.fn()
const ensureDisplayDocTitle = vi.fn(async (buffer: Buffer) => buffer)

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
  buildRemediationContextFromSnapshot: ({ analysis, qpdf, pdfjs, pages, structure }: any) => ({
    analysis,
    qpdf,
    pdfjs,
    pages,
    structure,
    headingCandidates: [],
    figureCandidates: [],
    tableCandidates: [],
    readingOrderCandidates: [],
    readingOrderParentCandidates: [],
    linkCandidates: pages?.flatMap((page: any) => page.links || []) || [],
  }),
  needsAltTextDeepInspection: (analysis: any) => {
    const findings = analysis?.categories?.find((category: any) => category.id === 'alt_text')?.findings || []
    const hasAcrobatAltRiskFindings = findings.some((finding: any) =>
      /acrobat.risk|acrobat-risk|other-elements alternate text|graphics content is still owned by non-\/figure|acrobat-style|non-figure.*graphics|graphics.*non-figure/i.test(String(finding || '')))
    if (hasAcrobatAltRiskFindings) return true
    if (analysis?.verapdf?.status !== 'failed') return false
    return (analysis?.verapdf?.failures || []).some((failure: any) =>
      (failure?.categoryIds || []).includes('alt_text')
      || /alternate text|figure|artifact|decorative image|non-text content/i.test(String(failure?.message || '')),
    )
  },
  mergeManualReviewFlags: (existing: any[], next: any[]) => [...existing, ...next],
  toAppliedChange: () => null,
  toSuggestedChange: () => null,
}))

vi.mock('../services/remediationPlanService.js', () => ({
  planRemediationActions,
  TOOL_STAGE_ORDER: new Map([
    ['set_document_title', 1],
    ['normalize_document_metadata', 1],
    ['set_document_language', 1],
    ['bootstrap_struct_tree', 2],
    ['repair_malformed_bdc_operators', 2],
    ['repair_note_tag_ids', 2],
    ['repair_native_marked_content_refs', 2],
    ['repair_bootstrapped_chart_content_refs', 2],
    ['repair_structure_conformance', 1],
    ['repair_native_link_structure', 3],
    ['set_link_annotation_contents', 3],
    ['set_page_tabs', 3],
    ['normalize_annotation_tab_order', 3],
    ['repair_annotation_alt_text', 3],
    ['set_tabs_all_annotated_pages', 3],
    ['set_figure_alt_text', 5],
    ['repair_other_elements_alt_text', 5],
    ['repair_cidset_consistency', 2],
    ['substitute_legacy_fonts_in_place', 2],
  ]),
}))

vi.mock('../services/semanticEnrichmentService.js', () => ({
  generateSemanticRepairBatches,
  hasSemanticRepairConfig: () => true,
}))

vi.mock('../services/ocrService.js', () => ({
  isOcrAvailable,
  ocrPdfToSearchablePdf,
}))

vi.mock('../services/pdfStructureBackend.js', () => ({
  runPdfStructureBackendBatch,
}))

vi.mock('../services/toolReliabilityService.js', () => ({
  recordToolOutcomes,
  classifyPdf,
}))

vi.mock('../services/playbookService.js', () => ({
  buildFailureSignature,
  findUsablePlaybookBySignatureHash,
  createPlaybookRun,
  finalizePlaybookRun,
  learnFromSuccessfulRemediation,
}))

vi.mock('../services/remediationCallDerivationService.js', () => ({
  heuristicFigureAltText: (_candidateId: string, _context: unknown) => 'Image related to County outcomes chart',
  deriveDeterministicCall,
}))

vi.mock('../services/pdfOutputFinalizer.js', () => ({
  ensureDisplayDocTitle,
}))

describe('agentRemediationService', { timeout: 15_000 }, () => {
  beforeEach(() => {
    vi.resetAllMocks()
    generateSemanticRepairBatches.mockResolvedValue({ batches: [], reviewFlags: [] })
    isOcrAvailable.mockResolvedValue(false)
    classifyPdf.mockReturnValue('native_tagged')
    buildFailureSignature.mockReturnValue({ failureModeKeys: [], pdfClass: 'tagged', hash: 'sig' })
    findUsablePlaybookBySignatureHash.mockReturnValue(null)
    deriveDeterministicCall.mockImplementation(({ opportunity }: any) => ({
      tool_name: opportunity.toolName,
      arguments: { target: 'document' },
      rationale: opportunity.reason,
      confidence: opportunity.confidence,
    }))
    executeRemediationTool.mockResolvedValue({
      buffer: Buffer.from('pdf'),
      action: {
        tool: 'normalize_annotation_tab_order',
        target: 'document',
        details: 'no-op',
        confidence: 0.9,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: false,
        categoryTargets: ['reading_order'],
        outcome: 'no_effect',
      },
      manualReviewFlags: [],
    })
    runPdfStructureBackendBatch.mockResolvedValue({
      status: 'no_effect',
      changedDocumentBytes: false,
      appliedMutations: [],
      warnings: [],
      headings: [],
      structuralNodes: [],
      tables: [],
      figures: [],
      imageStructNodes: [],
      acrobatAltRiskNodes: [],
      readingOrderNodes: [],
      readingOrderParents: [],
      operationResults: [],
    })
  })

  it('keeps metadata-only updates on cached inspection context and uses fast intermediate analysis', async () => {
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
        buffer: Buffer.concat([buffer, Buffer.from('2')]),
        action: {
          tool: 'set_figure_alt_text',
          target: 'document',
          candidateId: 'figure:1',
          details: context.figureCandidates[0].targetRef,
          confidence: 0.8,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['alt_text'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      }))

    analyzePDF.mockResolvedValue(refreshedResult)

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'example.pdf', originalResult)

    expect(inspectPdfForRemediation).toHaveBeenCalledTimes(4)
    expect(planRemediationActions).toHaveBeenCalled()
    expect(planRemediationActions.mock.calls.some(call => Array.isArray(call[0]?.actions))).toBe(true)
    expect(planRemediationActions.mock.calls.some(call => Array.isArray(call[0]?.rejectedActions))).toBe(true)
    expect(analyzePDF).toHaveBeenCalledTimes(3)
    expect(analyzePDF.mock.calls[0]?.[2]).toMatchObject({
      analysisProfile: 'remediation_fast',
      skipAdobe: true,
      inheritedVeraPdf: originalResult.verapdf,
    })
    expect(analyzePDF.mock.calls[1]?.[2]).toMatchObject({
      analysisProfile: 'remediation_fast',
      skipAdobe: true,
      inheritedVeraPdf: refreshedResult.verapdf,
    })
    expect(analyzePDF.mock.calls.at(-1)?.[2]).toMatchObject({
      analysisProfile: 'full_final',
      skipAdobe: true,
    })
    expect(analyzePDF.mock.calls.at(-1)?.[2]?.inheritedVeraPdf).toBeUndefined()
    expect(executeRemediationTool.mock.calls[1]?.[0]?.context?.figureCandidates?.[0]?.targetRef).toBe('obj:new 0 R')
    expect(result.model.actions?.slice(0, 2).map(action => action.outcome)).toEqual(['applied', 'applied'])
    expect(result.model.failureProfile?.version).toBe('1')
    expect(result.model.failureProfile?.toolOpportunities.length).toBeGreaterThanOrEqual(0)
    expect(result.model.plannerEvidence).toBeTruthy()
    expect(result.finalResult.overallScore).toBe(90)
  })

  it('uses light inspection for non-alt-text fixes and batches safe document-scoped actions before one refresh', async () => {
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
      filename: 'batched.pdf',
      pageCount: 4,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 72,
      grade: 'C',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 2,
        failures: [{ ruleId: 'meta', specification: null, clause: null, testNumber: null, location: null, message: 'Metadata issue', categoryIds: [] }],
      }),
      categories: [
        { id: 'title_language', label: 'Document Title & Language', weight: 0.15, score: 50, grade: 'F', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'reading_order', label: 'Reading Order', weight: 0.045, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    const lightContext = {
      pdfjs: { title: 'Batched', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2, noteTagCount: 1 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [{
        id: 'link:1',
        pageNumber: 1,
        annotationIndex: 0,
        text: 'Example',
        url: 'https://example.com',
        annotationContents: null,
      }],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    }

    inspectPdfForRemediation
      .mockResolvedValueOnce(lightContext)
      .mockResolvedValueOnce({
        ...lightContext,
        pdfjs: { title: 'Batched Fixed', lang: 'en' },
      })
      .mockResolvedValueOnce({
        ...lightContext,
        pdfjs: { title: 'Batched Fixed', lang: 'en' },
      })
      .mockResolvedValueOnce({
        ...lightContext,
        pdfjs: { title: 'Batched Fixed', lang: 'en' },
      })

    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['title_language'],
        actions: [
          { tool_name: 'normalize_document_metadata', arguments: { title: 'Batched Fixed', language: 'en' }, rationale: 'Normalize metadata', confidence: 0.9 },
          { tool_name: 'set_page_tabs', arguments: { target: 'document' }, rationale: 'Set tabs', confidence: 0.8 },
        ],
      })
      .mockResolvedValueOnce({ done: true, unresolvedIssues: [], actions: [] })

    executeRemediationTool
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf-meta'),
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
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf-tabs'),
        action: {
          tool: 'set_page_tabs',
          target: 'document',
          details: 'tabs normalized',
          confidence: 0.8,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['reading_order'],
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
        { ...originalResult.categories[1] },
      ],
    })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'batched.pdf', originalResult)

    expect(inspectPdfForRemediation).toHaveBeenCalledTimes(4)
    expect(inspectPdfForRemediation.mock.calls.map(call => call[2]?.inspectMode)).toEqual(['light', 'light', 'light', 'light'])
    expect(analyzePDF).toHaveBeenCalledTimes(3)
    expect(result.finalResult.grade).toBe('A')
    expect(generateSemanticRepairBatches).not.toHaveBeenCalled()
  })

  it('batches contiguous document-scoped stage repairs and preserves per-tool actions', async () => {
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
      filename: 'stage-batch.pdf',
      pageCount: 3,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 70,
      grade: 'C',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({ status: 'failed', isCompliant: false, failedChecks: 2, failures: [] }),
      categories: [
        { id: 'text_extractability', label: 'Text Extractability', weight: 0.2, score: 70, grade: 'C', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'reading_order', label: 'Reading Order', weight: 0.045, score: 75, grade: 'C', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    const context = {
      pdfjs: { title: 'Stage Batch', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: false, outlineCount: 0, structTreeDepth: 0, noteTagCount: 1 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    }

    inspectPdfForRemediation.mockResolvedValue(context)
    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['text_extractability', 'reading_order'],
        actions: [
          { tool_name: 'repair_malformed_bdc_operators', arguments: { target: 'document' }, rationale: 'Repair BDC', confidence: 0.9 },
          { tool_name: 'repair_note_tag_ids', arguments: { target: 'document' }, rationale: 'Repair note ids', confidence: 0.88 },
        ],
      })
      .mockResolvedValueOnce({ done: true, unresolvedIssues: [], actions: [] })

    runPdfStructureBackendBatch.mockResolvedValueOnce({
      status: 'applied',
      changedDocumentBytes: true,
      appliedMutations: [],
      warnings: [],
      headings: [],
      structuralNodes: [],
      tables: [],
      figures: [],
      imageStructNodes: [],
      acrobatAltRiskNodes: [],
      readingOrderNodes: [],
      readingOrderParents: [],
      outputBuffer: Buffer.from('pdf-stage-batch'),
      operationResults: [
        {
          operation: 'repair_malformed_bdc_operators',
          status: 'applied',
          changedDocumentBytes: true,
          appliedMutations: [{ ref: 'obj:1 0 R', details: 'bdc repaired' }],
          warnings: [],
        },
        {
          operation: 'repair_note_tag_ids',
          status: 'applied',
          changedDocumentBytes: true,
          appliedMutations: [{ ref: 'obj:2 0 R', details: 'note ids repaired' }],
          warnings: [],
        },
      ],
    })
    analyzePDF.mockResolvedValue({
      ...originalResult,
      overallScore: 100,
      grade: 'A',
      verapdf: makeVeraPdfResult(),
      categories: [
        { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass' },
        { ...originalResult.categories[1], score: 100, grade: 'A', severity: 'Pass' },
      ],
    })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'stage-batch.pdf', originalResult)

    expect(runPdfStructureBackendBatch.mock.calls.some(call =>
      JSON.stringify(call[0]?.mutations) === JSON.stringify([
        { operation: 'repair_malformed_bdc_operators' },
        { operation: 'repair_note_tag_ids' },
      ]),
    )).toBe(true)
    expect(runPdfStructureBackendBatch.mock.calls.some(call =>
      JSON.stringify(call[0]?.mutations) === JSON.stringify([
        { operation: 'repair_malformed_bdc_operators' },
        { operation: 'repair_note_tag_ids' },
      ]) && call[0]?.includeSnapshot === false,
    )).toBe(true)
    expect(executeRemediationTool).not.toHaveBeenCalledWith(expect.objectContaining({
      call: expect.objectContaining({ tool_name: 'repair_malformed_bdc_operators' }),
    }))
    expect(result.model.actions?.some(action => action.tool === 'repair_malformed_bdc_operators' && action.outcome === 'applied')).toBe(true)
    expect(result.model.actions?.some(action => action.tool === 'repair_note_tag_ids' && action.outcome === 'applied')).toBe(true)
  })

  it('splits stage batching around non-eligible JS helpers and falls back to per-tool execution when a stage batch fails', async () => {
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
      filename: 'stage-mixed.pdf',
      pageCount: 3,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 1, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 74,
      grade: 'C',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({ status: 'failed', isCompliant: false, failedChecks: 2, failures: [] }),
      categories: [
        { id: 'link_quality', label: 'Links', weight: 0.1, score: 70, grade: 'C', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'reading_order', label: 'Reading Order', weight: 0.045, score: 70, grade: 'C', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    const context = {
      pdfjs: { title: 'Stage Mixed', lang: 'en', links: [{ url: 'https://example.com', text: 'Example' }], imageCount: 0, metadata: pdfMetadata },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: false, outlineCount: 0, structTreeDepth: 0 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [{ id: 'link:1', pageNumber: 1, annotationIndex: 0, text: 'Example', url: 'https://example.com' }],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    }

    inspectPdfForRemediation.mockResolvedValue(context)
    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['link_quality', 'reading_order'],
        actions: [
          { tool_name: 'repair_native_link_structure', arguments: { target: 'document' }, rationale: 'Repair links', confidence: 0.9 },
          { tool_name: 'normalize_annotation_tab_order', arguments: { target: 'document' }, rationale: 'Normalize order', confidence: 0.9 },
          { tool_name: 'set_page_tabs', arguments: { target: 'document' }, rationale: 'Set page tabs', confidence: 0.8 },
          { tool_name: 'repair_annotation_alt_text', arguments: { target: 'document' }, rationale: 'Repair annotation alt', confidence: 0.88 },
          { tool_name: 'set_tabs_all_annotated_pages', arguments: { target: 'document' }, rationale: 'Set tabs all pages', confidence: 0.88 },
        ],
      })
      .mockResolvedValueOnce({ done: true, unresolvedIssues: [], actions: [] })

    runPdfStructureBackendBatch
      .mockResolvedValueOnce({
        status: 'failed',
        changedDocumentBytes: false,
        appliedMutations: [],
        warnings: ['batch failed'],
        headings: [],
        structuralNodes: [],
        tables: [],
        figures: [],
        imageStructNodes: [],
        acrobatAltRiskNodes: [],
        readingOrderNodes: [],
        readingOrderParents: [],
        operationResults: [],
      })
      .mockResolvedValueOnce({
        status: 'applied',
        changedDocumentBytes: true,
        appliedMutations: [],
        warnings: [],
        headings: [],
        structuralNodes: [],
        tables: [],
        figures: [],
        imageStructNodes: [],
        acrobatAltRiskNodes: [],
        readingOrderNodes: [],
        readingOrderParents: [],
        outputBuffer: Buffer.from('pdf-mixed-final'),
        operationResults: [
          {
            operation: 'repair_annotation_alt_text',
            status: 'applied',
            changedDocumentBytes: true,
            appliedMutations: [{ ref: 'obj:3 0 R', details: 'annotation alt repaired' }],
            warnings: [],
          },
          {
            operation: 'set_tabs_all_annotated_pages',
            status: 'applied',
            changedDocumentBytes: true,
            appliedMutations: [{ ref: 'obj:4 0 R', details: 'all tabs set' }],
            warnings: [],
          },
        ],
      })

    executeRemediationTool
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf-links'),
        action: {
          tool: 'repair_native_link_structure',
          target: 'document',
          details: 'links repaired',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['link_quality', 'reading_order'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf-links-order'),
        action: {
          tool: 'normalize_annotation_tab_order',
          target: 'document',
          details: 'annotation order normalized',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['link_quality', 'reading_order'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf-page-tabs'),
        action: {
          tool: 'set_page_tabs',
          target: 'document',
          details: 'page tabs set',
          confidence: 0.8,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['reading_order'],
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
        { ...originalResult.categories[1], score: 100, grade: 'A', severity: 'Pass' },
      ],
    })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'stage-mixed.pdf', originalResult)

    expect(runPdfStructureBackendBatch).toHaveBeenCalled()
    expect(runPdfStructureBackendBatch.mock.calls.some(call =>
      JSON.stringify(call[0]?.mutations) === JSON.stringify([
        { operation: 'repair_annotation_alt_text' },
        { operation: 'set_tabs_all_annotated_pages' },
      ]) && call[0]?.includeSnapshot === false,
    )).toBe(true)
    expect(executeRemediationTool).toHaveBeenCalledWith(expect.objectContaining({
      call: expect.objectContaining({ tool_name: 'set_page_tabs' }),
    }))
    expect(executeRemediationTool.mock.calls.some(call => call[0].call.tool_name === 'repair_native_link_structure')).toBe(false)
    expect(result.finalResult.grade).toBe('A')
  })

  it('batches native-safe stage analysis and rejects only the regressive action', async () => {
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
      filename: 'tagged-stage.pdf',
      pageCount: 4,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 84,
      grade: 'B',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 4,
        failures: [{ ruleId: 'ro', specification: null, clause: null, testNumber: null, location: null, message: 'Reading order issue', categoryIds: ['reading_order'] }],
      }),
      categories: [
        { id: 'text_extractability', label: 'Text Extractability', weight: 0.2, score: 75, grade: 'C', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'reading_order', label: 'Reading Order', weight: 0.045, score: 80, grade: 'B', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    const taggedContext = {
      pdfjs: { title: 'Tagged Stage', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [{ ref: 'obj:1 0 R' }] },
    }

    inspectPdfForRemediation.mockResolvedValue(taggedContext)

    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['text_extractability', 'reading_order'],
        actions: [
          { tool_name: 'repair_malformed_bdc_operators', arguments: { target: 'document' }, rationale: 'Repair BDC', confidence: 0.9 },
          { tool_name: 'repair_note_tag_ids', arguments: { target: 'document' }, rationale: 'Repair note ids', confidence: 0.9 },
        ],
      })
      .mockResolvedValueOnce({ done: true, unresolvedIssues: [], actions: [] })

    runPdfStructureBackendBatch.mockResolvedValueOnce({
      status: 'applied',
      changedDocumentBytes: true,
      appliedMutations: [],
      warnings: [],
      headings: [],
      structuralNodes: [],
      tables: [],
      figures: [],
      imageStructNodes: [],
      acrobatAltRiskNodes: [],
      readingOrderNodes: [],
      readingOrderParents: [],
      outputBuffer: Buffer.from('pdf12'),
      operationResults: [
        {
          operation: 'repair_malformed_bdc_operators',
          status: 'applied',
          changedDocumentBytes: true,
          appliedMutations: [{ ref: 'obj:1 0 R', details: 'bdc repaired' }],
          warnings: [],
        },
        {
          operation: 'repair_note_tag_ids',
          status: 'applied',
          changedDocumentBytes: true,
          appliedMutations: [{ ref: 'obj:2 0 R', details: 'note ids repaired' }],
          warnings: [],
        },
      ],
    })

    executeRemediationTool
      .mockImplementationOnce(async ({ buffer }: any) => ({
        buffer: Buffer.concat([buffer, Buffer.from('1')]),
        action: {
          tool: 'repair_malformed_bdc_operators',
          target: 'document',
          details: 'bdc repaired',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['text_extractability', 'pdf_ua_compliance'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      }))
      .mockImplementationOnce(async ({ buffer }: any) => ({
        buffer: Buffer.concat([buffer, Buffer.from('2')]),
        action: {
          tool: 'repair_note_tag_ids',
          target: 'document',
          details: 'note ids repaired',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['reading_order'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      }))

    analyzePDF
      .mockResolvedValueOnce({
        ...originalResult,
        overallScore: 79,
        grade: 'C',
        verapdf: makeVeraPdfResult({
          status: 'failed',
          isCompliant: false,
          failedChecks: 6,
          failures: [
            { ruleId: 'ro', specification: null, clause: null, testNumber: null, location: null, message: 'Reading order issue', categoryIds: ['reading_order'] },
            { ruleId: 'note', specification: null, clause: null, testNumber: null, location: null, message: 'Note tag shall have ID entry', categoryIds: [] },
          ],
        }),
        categories: [
          { ...originalResult.categories[0] },
          { ...originalResult.categories[1], score: 70, grade: 'C', severity: 'Moderate' },
        ],
      })
      .mockResolvedValueOnce({
        ...originalResult,
        overallScore: 93,
        grade: 'A',
        verapdf: makeVeraPdfResult({
          status: 'failed',
          isCompliant: false,
          failedChecks: 3,
          failures: [{ ruleId: 'ro', specification: null, clause: null, testNumber: null, location: null, message: 'Reading order issue', categoryIds: ['reading_order'] }],
        }),
        categories: [
        { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass' },
          { ...originalResult.categories[1] },
        ],
      })
      .mockResolvedValue({
        ...originalResult,
        overallScore: 93,
        grade: 'A',
        verapdf: makeVeraPdfResult({
          status: 'failed',
          isCompliant: false,
          failedChecks: 3,
          failures: [{ ruleId: 'ro', specification: null, clause: null, testNumber: null, location: null, message: 'Reading order issue', categoryIds: ['reading_order'] }],
        }),
        categories: [
          { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass' },
          { ...originalResult.categories[1] },
        ],
      })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'tagged-stage.pdf', originalResult)

    expect(analyzePDF).toHaveBeenCalledTimes(3)
    expect(runPdfStructureBackendBatch).toHaveBeenCalled()
    expect(runPdfStructureBackendBatch).toHaveBeenCalled()
    expect(executeRemediationTool.mock.calls.filter(call =>
      ['repair_malformed_bdc_operators', 'repair_note_tag_ids'].includes(call[0]?.call?.tool_name),
    ).length).toBeGreaterThanOrEqual(1)
    expect(result.buffer.equals(Buffer.from('pdf'))).toBe(false)
    expect(result.model.nativeTaggedSafeMode).toBe(true)
    expect(result.finalResult.overallScore).toBe(93)
  })

  it('always runs final tab-order cleanup before returning the remediated PDF', async () => {
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
      pageCount: 2,
    }
    const originalResult: AnalysisResult = {
      filename: 'cleanup.pdf',
      pageCount: 2,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 96,
      grade: 'A',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult(),
      categories: [
        { id: 'reading_order', label: 'Reading Order', weight: 0.045, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    const context = {
      pdfjs: { title: 'Cleanup', lang: 'en', links: [{ url: 'https://example.com', text: 'Example' }], imageCount: 1, metadata: pdfMetadata },
      qpdf: { lang: 'en', headings: [], tables: [], images: [{ ref: 'obj:img 0 R', hasAlt: false }], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [{ id: 'figure:1', pageNumber: 1, surroundingText: [], splitGenerated: false, informativeHint: 'informative', repairMode: 'safe' }],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [{ id: 'link:1', pageNumber: 1, annotationIndex: 0, text: 'Example', url: 'https://example.com' }],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    }

    inspectPdfForRemediation.mockResolvedValue(context)
    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: [], actions: [] })

    runPdfStructureBackendBatch.mockResolvedValueOnce({
      status: 'applied',
      changedDocumentBytes: true,
      appliedMutations: [],
      warnings: [],
      headings: [],
      structuralNodes: [],
      tables: [],
      figures: [],
      imageStructNodes: [],
      acrobatAltRiskNodes: [],
      readingOrderNodes: [],
      readingOrderParents: [],
      outputBuffer: Buffer.from('pdf-cleanup-batch'),
      operationResults: [
        {
          operation: 'normalize_heading_hierarchy',
          status: 'no_effect',
          changedDocumentBytes: false,
          appliedMutations: [],
          warnings: [],
        },
        {
          operation: 'normalize_nested_figure_containers',
          status: 'no_effect',
          changedDocumentBytes: false,
          appliedMutations: [],
          warnings: [],
        },
        {
          operation: 'repair_native_link_structure',
          status: 'applied',
          changedDocumentBytes: true,
          appliedMutations: [{ ref: 'obj:1 0 R', details: 'link structure normalized' }],
          warnings: [],
        },
        {
          operation: 'normalize_annotation_tab_order',
          status: 'applied',
          changedDocumentBytes: true,
          appliedMutations: [{ ref: 'obj:2 0 R', details: 'annotation order normalized' }],
          warnings: [],
        },
        {
          operation: 'set_tabs_all_annotated_pages',
          status: 'applied',
          changedDocumentBytes: true,
          appliedMutations: [{ ref: 'obj:3 0 R', details: 'tabs normalized' }],
          warnings: [],
        },
      ],
    })

    analyzePDF.mockResolvedValue({
      ...originalResult,
      overallScore: 100,
      grade: 'A',
      categories: [
        { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass', findings: ['Annotated pages use /Tabs /S and annotation arrays already follow reading order.'] },
      ],
    })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'cleanup.pdf', originalResult)

    expect(runPdfStructureBackendBatch).toHaveBeenCalledTimes(1)
    expect(runPdfStructureBackendBatch.mock.calls[0]?.[0]?.mutations).toEqual([
      { operation: 'normalize_heading_hierarchy' },
      { operation: 'normalize_nested_figure_containers' },
      { operation: 'repair_native_link_structure' },
      { operation: 'normalize_annotation_tab_order' },
      { operation: 'set_tabs_all_annotated_pages' },
    ])
    expect(runPdfStructureBackendBatch.mock.calls[0]?.[0]?.includeSnapshot).toBe(true)
    expect(runPdfStructureBackendBatch.mock.calls[0]?.[0]?.inspectMode).toBe('light')
    expect(result.model.actions?.slice(-3).map(action => action.tool)).toEqual([
      'repair_native_link_structure',
      'normalize_annotation_tab_order',
      'set_tabs_all_annotated_pages',
    ])
    expect(result.buffer.equals(Buffer.from('pdf-cleanup-batch'))).toBe(true)
    expect(analyzePDF.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(inspectPdfForRemediation).toHaveBeenCalledTimes(1)
  })

  it('batches native-safe final cleanup into one analysis pass', async () => {
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
      pageCount: 2,
    }
    const originalResult: AnalysisResult = {
      filename: 'native-cleanup.pdf',
      pageCount: 2,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 97,
      grade: 'A',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult(),
      categories: [
        { id: 'reading_order', label: 'Reading Order', weight: 0.045, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    const taggedContext = {
      pdfjs: { title: 'Native Cleanup', lang: 'en', links: [{ url: 'https://example.com', text: 'Example' }], imageCount: 1, metadata: pdfMetadata },
      qpdf: { lang: 'en', headings: [], tables: [], images: [{ ref: 'obj:img 0 R', hasAlt: false }], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [{ id: 'figure:1', pageNumber: 1, surroundingText: [], splitGenerated: false, informativeHint: 'informative', repairMode: 'safe' }],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [{ id: 'link:1', pageNumber: 1, annotationIndex: 0, text: 'Example', url: 'https://example.com' }],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [{ ref: 'obj:1 0 R' }] },
    }

    inspectPdfForRemediation.mockResolvedValue(taggedContext)
    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: [], actions: [] })

    executeRemediationTool.mockImplementation(async ({ buffer, call }: any) => ({
      buffer: Buffer.concat([buffer, Buffer.from(call.tool_name[0])]),
      action: {
        tool: call.tool_name,
        target: 'document',
        details: `${call.tool_name} applied`,
        confidence: 0.95,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: call.tool_name.includes('tab') || call.tool_name.includes('link') ? ['reading_order'] : [],
        outcome: 'applied',
      },
      manualReviewFlags: [],
    }))

    analyzePDF.mockResolvedValue({
      ...originalResult,
      overallScore: 100,
      grade: 'A',
    })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'native-cleanup.pdf', originalResult)

    expect(analyzePDF.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(executeRemediationTool.mock.calls.length).toBeGreaterThanOrEqual(5)
    const finalTools = result.model.actions?.slice(-6).map(action => action.tool) || []
    expect(finalTools).toContain('normalize_nested_figure_containers')
    expect(finalTools).toContain('repair_native_link_structure')
    expect(finalTools).toContain('normalize_annotation_tab_order')
    expect(finalTools).toContain('set_tabs_all_annotated_pages')
    expect(finalTools).toContain('set_link_annotation_contents')
  })

  it('keeps heading normalization when native-safe validation needs deep structure scoring', async () => {
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
      pageCount: 2,
    }
    const originalResult: AnalysisResult = {
      filename: 'heading-cleanup.pdf',
      pageCount: 2,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 97,
      grade: 'A',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult(),
      categories: [
        { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
        { id: 'heading_structure', label: 'Heading Structure', weight: 0.1, score: 60, grade: 'D', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'reading_order', label: 'Reading Order', weight: 0.045, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    const taggedContext = {
      pdfjs: { title: 'Heading Cleanup', lang: 'en', links: [], imageCount: 1, metadata: pdfMetadata },
      qpdf: { lang: 'en', headings: [], tables: [], images: [{ ref: 'obj:img 0 R', hasAlt: true }], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [{ id: 'figure:1', pageNumber: 1, surroundingText: [], splitGenerated: false, informativeHint: 'informative', repairMode: 'safe' }],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [{ ref: 'obj:1 0 R' }] },
    }

    inspectPdfForRemediation.mockResolvedValue(taggedContext)
    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: [], actions: [] })

    executeRemediationTool
      .mockImplementationOnce(async ({ buffer }: any) => ({
        buffer: Buffer.concat([buffer, Buffer.from('h')]),
        action: {
          tool: 'normalize_heading_hierarchy',
          target: 'document',
          details: 'heading normalized',
          confidence: 0.97,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['heading_structure'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      }))
      .mockImplementation(async ({ buffer, call }: any) => ({
        buffer,
        action: {
          tool: call.tool_name,
          target: 'document',
          details: `${call.tool_name} no-op`,
          confidence: 0.95,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: false,
          categoryTargets: call.tool_name === 'normalize_nested_figure_containers'
            ? ['alt_text']
            : call.tool_name === 'repair_native_link_structure'
              ? ['link_quality', 'reading_order']
              : ['reading_order'],
          outcome: 'no_effect',
        },
        manualReviewFlags: [],
      }))

    analyzePDF.mockImplementation(async (_buffer: Buffer, _filename: string, options?: any) => {
      const usedDeepScoring = !!options?.forceStructureForScoring
      return {
        ...originalResult,
        overallScore: usedDeepScoring ? 100 : 92,
        grade: 'A',
        categories: [
          { ...originalResult.categories[0], score: usedDeepScoring ? 100 : 75, grade: usedDeepScoring ? 'A' : 'C', severity: usedDeepScoring ? 'Pass' : 'Moderate' },
          { ...originalResult.categories[1], score: 100, grade: 'A', severity: 'Pass' },
          { ...originalResult.categories[2] },
        ],
      }
    })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'heading-cleanup.pdf', originalResult)

    expect(analyzePDF.mock.calls.some(call => call[2]?.forceStructureForScoring === true)).toBe(true)
    expect(result.model.rejectedActions?.some(action => action.tool === 'normalize_heading_hierarchy')).toBe(false)
    expect(result.model.actions?.some(action => action.tool === 'normalize_heading_hierarchy' && action.outcome !== 'rejected')).toBe(true)
  })

  it('does not force deep structure scoring for annotation-only alt-text cleanup', async () => {
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
      pageCount: 1,
    }
    const originalResult: AnalysisResult = {
      filename: 'annotation-alt-only.pdf',
      pageCount: 1,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 1, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 82,
      grade: 'B',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult(),
      categories: [
        { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 60, grade: 'D', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'reading_order', label: 'Reading Order', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Annotation alt', lang: 'en', links: [], imageCount: 0, metadata: pdfMetadata },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [{ ref: 'obj:1 0 R' }] },
    })

    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['alt_text'],
        actions: [
          { tool_name: 'repair_annotation_alt_text', arguments: { target: 'annotations' }, rationale: 'annotation alt', confidence: 0.95 },
        ],
      })
      .mockResolvedValueOnce({ done: true, unresolvedIssues: [], actions: [] })

    executeRemediationTool.mockResolvedValueOnce({
      buffer: Buffer.from('annotation-alt'),
      action: {
        tool: 'repair_annotation_alt_text',
        target: 'document',
        details: 'annotation alt repaired',
        confidence: 0.95,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['alt_text'],
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })

    analyzePDF.mockImplementation(async (_buffer: Buffer, _filename: string, options?: any) => ({
      ...originalResult,
      overallScore: options?.analysisProfile === 'remediation_fast' ? 90 : 90,
      grade: 'A',
      categories: [
        { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass' },
        { ...originalResult.categories[1] },
      ],
    }))

    await remediatePdfWithAgent(Buffer.from('pdf'), 'annotation-alt-only.pdf', originalResult)

    expect(analyzePDF.mock.calls.some(([, , options]) =>
      options?.analysisProfile === 'remediation_fast'
      && options?.forceStructureForScoring === true,
    )).toBe(false)
  })

  it('retries residual font cleanup before final scoring when qpdf still reports font debt', async () => {
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
      pageCount: 2,
    }
    const originalResult: AnalysisResult = {
      filename: 'font-cleanup.pdf',
      pageCount: 2,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 97,
      grade: 'A',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({ status: 'unavailable', executionStatus: 'missing_binary', isCompliant: null }),
      categories: [
        { id: 'pdf_ua_compliance', label: 'PDF/UA Compliance', weight: 0.095, score: 90, grade: 'B', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Font Cleanup', lang: 'en', links: [], imageCount: 0, metadata: pdfMetadata },
      qpdf: {
        lang: 'en',
        headings: [],
        tables: [],
        images: [],
        formFields: [],
        hasStructTree: true,
        outlineCount: 0,
        structTreeDepth: 2,
        unembeddedFontCount: 1,
        fontsMissingToUnicode: 2,
        type1FontsMissingToUnicode: 1,
      },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [{ ref: 'obj:1 0 R' }] },
    })
    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: [], actions: [] })
    analyzePDF.mockResolvedValue(originalResult)

    await remediatePdfWithAgent(Buffer.from('pdf'), 'font-cleanup.pdf', originalResult)

    const calledTools = executeRemediationTool.mock.calls
      .map(call => call?.[0]?.call?.tool_name)
      .filter(Boolean)
    expect(calledTools).toContain('embed_missing_fonts_in_place')
    expect(calledTools).toContain('repair_font_unicode_maps')
    expect(calledTools).toContain('repair_type1_font_unicode_maps')
  })

  it('requests deep inspection only when figure or alt-text work remains', async () => {
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
      pageCount: 2,
    }
    const originalResult: AnalysisResult = {
      filename: 'alt-text.pdf',
      pageCount: 2,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 61,
      grade: 'D',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 1,
        failures: [{ ruleId: 'alt', specification: null, clause: null, testNumber: null, location: null, message: 'Alternate text missing', categoryIds: ['alt_text'] }],
      }),
      categories: [
        { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 0, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    const deepContext = {
      pdfjs: { title: 'Alt Text', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [{ id: 'figure:1', targetRef: 'obj:1 0 R' }],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    }

    inspectPdfForRemediation.mockResolvedValue(deepContext)

    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['alt_text'],
        actions: [
          { tool_name: 'set_figure_alt_text', arguments: { candidateId: 'figure:1', altText: 'County logo' }, rationale: 'Add alt text', confidence: 0.9 },
        ],
      })
      .mockResolvedValueOnce({ done: true, unresolvedIssues: [], actions: [] })

    executeRemediationTool.mockResolvedValueOnce({
      buffer: Buffer.from('figure-fixed'),
      action: {
        tool: 'set_figure_alt_text',
        target: 'page 1',
        candidateId: 'figure:1',
        details: 'alt text updated',
        confidence: 0.9,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['alt_text'],
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

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'alt-text.pdf', originalResult)

    expect(inspectPdfForRemediation.mock.calls[0]?.[2]?.inspectMode).toBe('alt_text_deep')
    expect(result.finalResult.grade).toBe('A')
  })

  it('keeps minor alt-text defects on light inspection without Acrobat-risk evidence', async () => {
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
      pageCount: 2,
    }
    const originalResult: AnalysisResult = {
      filename: 'minor-alt-text.pdf',
      pageCount: 2,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 96,
      grade: 'B',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult(),
      categories: [
        { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 95, grade: 'B', severity: 'Moderate', findings: ['One figure is missing alt text.'], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    const lightContext = {
      pdfjs: { title: 'Minor Alt Text', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    }

    inspectPdfForRemediation.mockResolvedValue(lightContext)
    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: ['alt_text'], actions: [] })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'minor-alt-text.pdf', originalResult)

    expect(inspectPdfForRemediation.mock.calls[0]?.[2]?.inspectMode).toBe('light')
    expect(result.finalResult.grade).toBe('B')
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

  it('runs OCR first for scanned documents when tesseract is available', async () => {
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
      pageCount: 2,
    }
    const scannedResult: AnalysisResult = {
      filename: 'scan.pdf',
      pageCount: 2,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 0,
      grade: 'F',
      isScanned: true,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({ status: 'failed', failedChecks: 20, failures: [] }),
      categories: [
        { id: 'text_extractability', label: 'Text Extractability', weight: 0.2, score: 0, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult
    const ocrResult: AnalysisResult = {
      ...scannedResult,
      isScanned: false,
      overallScore: 50,
      grade: 'D',
      verapdf: makeVeraPdfResult({ status: 'failed', failedChecks: 4, failures: [] }),
      categories: [
        { id: 'text_extractability', label: 'Text Extractability', weight: 0.2, score: 50, grade: 'D', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
    }
    isOcrAvailable.mockResolvedValue(true)
    ocrPdfToSearchablePdf.mockResolvedValue(Buffer.from('ocr-pdf'))
    analyzePDF.mockResolvedValue(ocrResult)
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
    // 5 cleanup tools always run; ensure they pass through the OCR buffer unchanged
    const ocrBuffer = Buffer.from('ocr-pdf')
    for (let i = 0; i < 5; i++) {
      executeRemediationTool.mockResolvedValueOnce({
        buffer: ocrBuffer,
        action: {
          tool: 'normalize_annotation_tab_order',
          target: 'document',
          details: 'no-op',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: false,
          categoryTargets: ['reading_order'],
          outcome: 'no_effect',
        },
        manualReviewFlags: [],
      })
    }

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'scan.pdf', scannedResult)

    expect(ocrPdfToSearchablePdf).toHaveBeenCalledTimes(1)
    expect(analyzePDF.mock.calls[0]?.[2]).toMatchObject({
      skipAdobe: true,
      inheritedVeraPdf: scannedResult.verapdf,
    })
    expect(result.buffer.equals(Buffer.from('ocr-pdf'))).toBe(true)
    expect(result.model.pathFallbacks).toContain('ocr_searchable_pdf')
    expect(result.model.visibleContentChangePolicy).toBe('no_visible_changes')
    expect(result.model.actions?.some(action => action.tool === 'ocr_scanned_pdf' && action.outcome === 'applied')).toBe(true)
    expect(result.finalResult.grade).toBe('D')
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

    expect(result.buffer.equals(Buffer.from('pdf'))).toBe(true)
    expect(result.model.processingPath).toBe('agent_patch')
    expect(result.model.pathFallbacks).toEqual([])
    expect(result.finalResult.grade).toBe('F')
  })

  it('continues to a second deterministic iteration when CIDSet repair changes bytes but leaves substitution opportunities', async () => {
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
      pageCount: 1,
    }

    const originalResult: AnalysisResult = {
      filename: 'cidset.pdf',
      pageCount: 1,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 90,
      grade: 'B',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 2,
        failures: [
          {
            ruleId: 'cidset',
            specification: null,
            clause: null,
            testNumber: null,
            location: null,
            message: 'A CIDSet entry in the Font descriptor does not correctly identify all glyphs present in the embedded font subset',
            categoryIds: [],
          },
        ],
      }),
      categories: [
        { id: 'text_extractability', label: 'Text Extractability', weight: 0.18, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
        { id: 'pdf_ua_compliance', label: 'PDF/UA Compliance', weight: 0.1, score: 85, grade: 'B', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    const sameCidsetResult: AnalysisResult = {
      ...originalResult,
      executiveSummary: 'CIDSet issues remain after direct repair.',
    }

    const passedResult: AnalysisResult = {
      ...originalResult,
      overallScore: 100,
      grade: 'A',
      executiveSummary: 'veraPDF passed PDF/UA validation.',
      verapdf: makeVeraPdfResult(),
      categories: [
        { ...originalResult.categories[0] },
        { ...originalResult.categories[1], score: 100, grade: 'A', severity: 'Pass' },
      ],
    }

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'CIDSet Report', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [{ ref: 'obj:1 0 R', tag: '/Document', parentRef: null, orderIndex: 0 }] },
    })

    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['pdf_ua_compliance'],
        actions: [
          { tool_name: 'repair_cidset_consistency', arguments: { target: 'document' }, rationale: 'Repair CIDSet.', confidence: 0.9 },
        ],
      })
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['pdf_ua_compliance'],
        actions: [
          { tool_name: 'substitute_legacy_fonts_in_place', arguments: { target: 'document' }, rationale: 'Escalate font repair.', confidence: 0.9 },
        ],
      })
      .mockResolvedValueOnce({
        done: true,
        unresolvedIssues: [],
        actions: [],
      })

    executeRemediationTool
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf-cidset'),
        action: {
          tool: 'repair_cidset_consistency',
          target: 'document',
          details: 'Regenerated /CIDSet but veraPDF failures remain.',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['text_extractability'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf-substituted'),
        action: {
          tool: 'substitute_legacy_fonts_in_place',
          target: 'document',
          details: 'Substituted legacy CID font.',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: true,
          changedDocumentBytes: true,
          categoryTargets: ['text_extractability', 'pdf_ua_compliance'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      })

    analyzePDF
      .mockResolvedValueOnce(sameCidsetResult)
      .mockResolvedValueOnce(passedResult)
      .mockResolvedValue(passedResult)

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'cidset.pdf', originalResult)

    expect(planRemediationActions).toHaveBeenCalledTimes(2)
    expect((result.model.actions || []).slice(0, 2).map(action => action.tool)).toEqual([
      'repair_cidset_consistency',
      'substitute_legacy_fonts_in_place',
    ])
    expect(result.finalResult.grade).toBe('A')
    expect(result.finalResult.verapdf.status).toBe('passed')
  })

  it('rolls back a later deterministic iteration that regresses scores without improving standards', async () => {
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
      pageCount: 1,
    }

    const originalResult: AnalysisResult = {
      filename: 'rollback.pdf',
      pageCount: 1,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 23,
      grade: 'F',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 10,
        failures: [{ ruleId: 'struct', specification: null, clause: null, testNumber: null, location: null, message: 'Structure issue', categoryIds: ['heading_structure'] }],
      }),
      categories: [
        { id: 'heading_structure', label: 'Heading Structure', weight: 0.135, score: 0, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
        { id: 'reading_order', label: 'Reading Order', weight: 0.045, score: 0, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    const stabilizedResult: AnalysisResult = {
      ...originalResult,
      overallScore: 97,
      grade: 'B',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 1,
        failures: [{ ruleId: 'remaining', specification: null, clause: null, testNumber: null, location: null, message: 'Remaining standards issue', categoryIds: ['pdf_ua_compliance'] }],
      }),
      categories: [
        { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass' },
        { ...originalResult.categories[1], score: 100, grade: 'A', severity: 'Pass' },
      ],
    }

    const regressedResult: AnalysisResult = {
      ...stabilizedResult,
      overallScore: 76,
      grade: 'C',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 2,
        failures: [{ ruleId: 'heading-order', specification: null, clause: null, testNumber: null, location: null, message: 'Heading level 1 is skipped', categoryIds: ['heading_structure'] }],
      }),
      categories: [
        { ...stabilizedResult.categories[0], score: 40, grade: 'F', severity: 'Moderate' },
        { ...stabilizedResult.categories[1], score: 60, grade: 'D', severity: 'Moderate' },
      ],
    }

    const initialContext = {
      pdfjs: { title: 'Rollback', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: false, outlineCount: 0, structTreeDepth: 0 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [] },
    }
    const healthyContext = {
      pdfjs: { title: 'Rollback', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [{ ref: 'obj:42 0 R', tag: '/H1', parentRef: null, orderIndex: 0 }] },
    }

    inspectPdfForRemediation
      .mockResolvedValueOnce(initialContext)
      .mockResolvedValueOnce(healthyContext)
      .mockResolvedValueOnce(healthyContext)
      .mockResolvedValueOnce(healthyContext)
      .mockResolvedValueOnce(healthyContext)
      .mockResolvedValueOnce(healthyContext)

    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['heading_structure', 'reading_order'],
        actions: [
          { tool_name: 'bootstrap_struct_tree', arguments: { target: 'document' }, rationale: 'bootstrap', confidence: 0.8 },
        ],
      })
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['pdf_ua_compliance'],
        actions: [
          { tool_name: 'repair_bootstrapped_chart_content_refs', arguments: { target: 'document' }, rationale: 'repair bootstrapped refs', confidence: 0.8 },
        ],
      })
      .mockResolvedValueOnce({
        done: true,
        unresolvedIssues: [],
        actions: [],
      })

    const pdfABuffer = Buffer.from('pdf-a')
    executeRemediationTool
      .mockResolvedValueOnce({
        buffer: pdfABuffer,
        action: {
          tool: 'bootstrap_struct_tree',
          target: 'document',
          details: 'bootstrap applied',
          confidence: 0.8,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['heading_structure', 'reading_order'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf-c'),
        action: {
          tool: 'repair_bootstrapped_chart_content_refs',
          target: 'document',
          details: 'repair refs applied',
          confidence: 0.8,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['heading_structure', 'reading_order'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      })
    // 5 final cleanup tools; pass through the rolled-back buffer unchanged
    for (let i = 0; i < 5; i++) {
      executeRemediationTool.mockResolvedValueOnce({
        buffer: pdfABuffer,
        action: {
          tool: 'normalize_annotation_tab_order',
          target: 'document',
          details: 'no-op',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: false,
          categoryTargets: ['reading_order'],
          outcome: 'no_effect',
        },
        manualReviewFlags: [],
      })
    }

    analyzePDF
      .mockResolvedValueOnce(stabilizedResult)
      .mockResolvedValueOnce(regressedResult)
      .mockResolvedValue(stabilizedResult)

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'rollback.pdf', originalResult)

    expect(result.buffer.equals(Buffer.from('pdf-a'))).toBe(true)
    expect(result.finalResult.grade).toBe('B')
    expect(result.finalResult.verapdf.status).toBe('failed')
    expect((result.model.rejectedActions || []).some(action => action.tool === 'repair_bootstrapped_chart_content_refs')).toBe(true)
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

  it('short-circuits additional deterministic replanning at 98+ and goes straight to final cleanup', async () => {
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
      pageCount: 2,
    }
    const originalResult: AnalysisResult = {
      filename: 'early-exit.pdf',
      pageCount: 2,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 90,
      grade: 'B',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 2,
      }),
      categories: [
        { id: 'reading_order', label: 'Reading Order', weight: 0.045, score: 90, grade: 'B', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'bookmarks', label: 'Bookmarks', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Early Exit', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: false, outlineCount: 0, structTreeDepth: 0 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [] },
    })

    planRemediationActions.mockResolvedValueOnce({
      done: false,
      unresolvedIssues: ['reading_order'],
      actions: [
        { tool_name: 'normalize_annotation_tab_order', arguments: { target: 'document' }, rationale: 'Normalize tabs', confidence: 0.9 },
      ],
    })

    executeRemediationTool
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf-98'),
        action: {
          tool: 'normalize_annotation_tab_order',
          target: 'document',
          details: 'normalized',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['reading_order'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      })

    for (let i = 0; i < 5; i += 1) {
      executeRemediationTool.mockResolvedValueOnce({
        buffer: Buffer.from('pdf-clean-final'),
        action: {
          tool: 'normalize_annotation_tab_order',
          target: 'document',
          details: 'cleanup',
          confidence: 0.95,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: false,
          categoryTargets: ['reading_order'],
          outcome: 'no_effect',
        },
        manualReviewFlags: [],
      })
    }

    analyzePDF
      .mockResolvedValueOnce({
        ...originalResult,
        overallScore: 98,
        grade: 'A',
        categories: [
          { ...originalResult.categories[0], score: 98, grade: 'A', severity: 'Pass' },
          { ...originalResult.categories[1] },
        ],
      })
      .mockResolvedValue({
        ...originalResult,
        overallScore: 100,
        grade: 'A',
        verapdf: makeVeraPdfResult(),
        categories: [
          { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass' },
          { ...originalResult.categories[1] },
        ],
      })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'early-exit.pdf', originalResult)

    expect(planRemediationActions).toHaveBeenCalledTimes(1)
    expect(generateSemanticRepairBatches).not.toHaveBeenCalled()
    expect(result.finalResult.overallScore).toBe(100)
  })

  it('uses an exact-match playbook fast path before calling the planner', async () => {
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
      pageCount: 2,
    }
    const originalResult: AnalysisResult = {
      filename: 'playbook.pdf',
      pageCount: 2,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 60,
      grade: 'D',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 3,
      }),
      categories: [
        { id: 'title_language', label: 'Document Title & Language', weight: 0.15, score: 50, grade: 'F', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: null, lang: '' },
      qpdf: { lang: '', headings: [], tables: [], images: [], formFields: [], hasStructTree: false, hasMarkInfo: false, outlineCount: 0, structTreeDepth: 0 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [] },
    })

    findUsablePlaybookBySignatureHash.mockReturnValue({
      id: 'playbook-1',
      failureSignatureHash: 'sig',
      failureModeKeys: ['category.title_language'],
      pdfClass: 'untagged',
      toolSequence: [{ tool: 'set_document_title', scope: 'document', stage: 1 }],
      hasImages: false,
      hasForms: false,
      hasTables: false,
      pageCountRange: 'small',
      initialScore: 60,
      finalScore: 100,
      successCount: 2,
      failureCount: 0,
      totalAttempts: 2,
      avgRounds: 1,
      status: 'validated',
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-20T00:00:00.000Z',
      lastUsedAt: null,
    } as any)

    executeRemediationTool
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf-playbook'),
        action: {
          tool: 'set_document_title',
          target: 'document',
          details: 'title updated',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['title_language'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      })

    for (let i = 0; i < 5; i += 1) {
      executeRemediationTool.mockResolvedValueOnce({
        buffer: Buffer.from('pdf-playbook'),
        action: {
          tool: 'normalize_annotation_tab_order',
          target: 'document',
          details: 'cleanup',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: false,
          categoryTargets: ['reading_order'],
          outcome: 'no_effect',
        },
        manualReviewFlags: [],
      })
    }

    analyzePDF
      .mockResolvedValueOnce({
        ...originalResult,
        overallScore: 100,
        grade: 'A',
        verapdf: makeVeraPdfResult(),
        categories: [
          { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass' },
        ],
      })
      .mockResolvedValue({
        ...originalResult,
        overallScore: 100,
        grade: 'A',
        verapdf: makeVeraPdfResult(),
        categories: [
          { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass' },
        ],
      })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'playbook.pdf', originalResult)

    expect(findUsablePlaybookBySignatureHash).toHaveBeenCalledWith('sig')
    expect(planRemediationActions).not.toHaveBeenCalled()
    expect(createPlaybookRun).toHaveBeenCalled()
    expect(finalizePlaybookRun).toHaveBeenCalled()
    expect(result.finalResult.grade).toBe('A')
  })

  it('falls back to the planner when an exact-match playbook does not finish remediation', async () => {
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
      pageCount: 2,
    }
    const originalResult: AnalysisResult = {
      filename: 'playbook-fallback.pdf',
      pageCount: 2,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 60,
      grade: 'D',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 3,
      }),
      categories: [
        { id: 'title_language', label: 'Document Title & Language', weight: 0.15, score: 50, grade: 'F', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: null, lang: '' },
      qpdf: { lang: '', headings: [], tables: [], images: [], formFields: [], hasStructTree: false, hasMarkInfo: false, outlineCount: 0, structTreeDepth: 0 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [] },
    })

    findUsablePlaybookBySignatureHash.mockReturnValue({
      id: 'playbook-2',
      failureSignatureHash: 'sig',
      failureModeKeys: ['category.title_language'],
      pdfClass: 'untagged',
      toolSequence: [{ tool: 'set_document_title', scope: 'document', stage: 1 }],
      hasImages: false,
      hasForms: false,
      hasTables: false,
      pageCountRange: 'small',
      initialScore: 60,
      finalScore: 100,
      successCount: 2,
      failureCount: 0,
      totalAttempts: 2,
      avgRounds: 1,
      status: 'validated',
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-20T00:00:00.000Z',
      lastUsedAt: null,
    } as any)

    executeRemediationTool.mockResolvedValue({
      buffer: Buffer.from('pdf-failed-playbook'),
      action: {
        tool: 'set_document_title',
        target: 'document',
        details: 'title updated',
        confidence: 0.9,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['title_language'],
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })

    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['title_language'],
        actions: [{ tool_name: 'set_document_language', arguments: { language: 'en' }, rationale: 'planner fallback', confidence: 0.9 }],
      })
      .mockResolvedValueOnce({ done: true, unresolvedIssues: [], actions: [] })

    analyzePDF
      .mockResolvedValueOnce(originalResult)
      .mockResolvedValueOnce({
        ...originalResult,
        overallScore: 100,
        grade: 'A',
        verapdf: makeVeraPdfResult(),
        categories: [
          { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass' },
        ],
      })
      .mockResolvedValue({
        ...originalResult,
        overallScore: 100,
        grade: 'A',
        verapdf: makeVeraPdfResult(),
        categories: [
          { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass' },
        ],
      })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'playbook-fallback.pdf', originalResult)

    expect(finalizePlaybookRun).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failed',
    }))
    expect(planRemediationActions).toHaveBeenCalled()
    expect(result.finalResult.grade).toBe('A')
  })

  it('accepts a non-native stage with positive net benefit despite a small targeted regression', async () => {
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
      pageCount: 1,
    }
    const originalResult: AnalysisResult = {
      filename: 'net-benefit.pdf',
      pageCount: 1,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 97,
      grade: 'A',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 2,
      }),
      categories: [
        { id: 'heading_structure', label: 'Heading Structure', weight: 0.135, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
        { id: 'reading_order', label: 'Reading Order', weight: 0.045, score: 97, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Net Benefit', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: false, outlineCount: 0, structTreeDepth: 0 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [] },
    })

    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['reading_order'],
        actions: [
          { tool_name: 'set_document_title', arguments: { title: 'Net Benefit' }, rationale: 'adjust', confidence: 0.9 },
        ],
      })
      .mockResolvedValueOnce({ done: true, unresolvedIssues: [], actions: [] })

    executeRemediationTool
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf-net-benefit'),
        action: {
          tool: 'set_document_title',
          target: 'document',
          details: 'title updated',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['heading_structure', 'reading_order'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      })

    for (let i = 0; i < 5; i += 1) {
      executeRemediationTool.mockResolvedValueOnce({
        buffer: Buffer.from('pdf-net-benefit'),
        action: {
          tool: 'normalize_annotation_tab_order',
          target: 'document',
          details: 'cleanup',
          confidence: 0.95,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: false,
          categoryTargets: ['reading_order'],
          outcome: 'no_effect',
        },
        manualReviewFlags: [],
      })
    }

    analyzePDF
      .mockResolvedValueOnce({
        ...originalResult,
        overallScore: 100,
        grade: 'A',
        verapdf: makeVeraPdfResult(),
        categories: [
          { ...originalResult.categories[0], score: 96, grade: 'A', severity: 'Pass' },
          { ...originalResult.categories[1], score: 100, grade: 'A', severity: 'Pass' },
        ],
      })
      .mockResolvedValue({
        ...originalResult,
        overallScore: 100,
        grade: 'A',
        verapdf: makeVeraPdfResult(),
        categories: [
          { ...originalResult.categories[0], score: 96, grade: 'A', severity: 'Pass' },
          { ...originalResult.categories[1], score: 100, grade: 'A', severity: 'Pass' },
        ],
      })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'net-benefit.pdf', originalResult)

    expect(result.model.rejectedActions || []).toHaveLength(0)
    expect(result.model.actions?.some(action => action.tool === 'set_document_title' && action.outcome === 'applied')).toBe(true)
    expect(result.finalResult.overallScore).toBe(100)
  })

  it('accepts a flat-score stage when blocking local standards findings improve', async () => {
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
      pageCount: 1,
    }
    const originalResult: AnalysisResult = {
      filename: 'local-standards-flat.pdf',
      pageCount: 1,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 75,
      grade: 'B',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
        passedChecks: 0,
        failedChecks: 0,
        failures: [],
      }),
      localStandards: {
        status: 'issues_detected',
        findings: [
          {
            key: 'pdfua.font_unicode',
            label: 'Font Unicode mapping',
            severity: 'error',
            blocking: true,
            categoryIds: ['text_extractability', 'pdf_ua_compliance'],
            confidence: 0.9,
            evidence: ['Detected 13 font object(s) without a ToUnicode map.'],
            source: 'qpdf',
            inferred: false,
            count: 13,
          },
        ],
        knownGapKeys: [],
      },
      categories: [
        { id: 'text_extractability', label: 'Text Extractability', weight: 0.175, score: 40, grade: 'F', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'pdf_ua_compliance', label: 'PDF/UA Compliance', weight: 0.095, score: 40, grade: 'F', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Local Standards Flat', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: false, outlineCount: 0, structTreeDepth: 0 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [] },
    })

    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['pdf_ua_compliance'],
        actions: [
          { tool_name: 'repair_font_unicode_maps', arguments: {}, rationale: 'repair fonts', confidence: 0.9 },
        ],
      })
      .mockResolvedValueOnce({ done: true, unresolvedIssues: [], actions: [] })

    executeRemediationTool.mockResolvedValueOnce({
      buffer: Buffer.from('pdf-font-fix'),
      action: {
        tool: 'repair_font_unicode_maps',
        target: 'document',
        details: 'fonts updated',
        confidence: 0.9,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['text_extractability', 'pdf_ua_compliance'],
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })

    for (let i = 0; i < 5; i += 1) {
      executeRemediationTool.mockResolvedValueOnce({
        buffer: Buffer.from('pdf-font-fix'),
        action: {
          tool: 'normalize_annotation_tab_order',
          target: 'document',
          details: 'cleanup',
          confidence: 0.95,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: false,
          categoryTargets: ['reading_order'],
          outcome: 'no_effect',
        },
        manualReviewFlags: [],
      })
    }

    analyzePDF
      .mockResolvedValueOnce({
        ...originalResult,
        overallScore: 75,
        grade: 'B',
        localStandards: {
          status: 'issues_detected',
          findings: [],
          knownGapKeys: [],
        },
        categories: [
          { ...originalResult.categories[0], score: 40, grade: 'F', severity: 'Moderate' },
          { ...originalResult.categories[1], score: 40, grade: 'F', severity: 'Moderate' },
        ],
      })
      .mockResolvedValue({
        ...originalResult,
        overallScore: 75,
        grade: 'B',
        localStandards: {
          status: 'issues_detected',
          findings: [],
          knownGapKeys: [],
        },
        categories: [
          { ...originalResult.categories[0], score: 40, grade: 'F', severity: 'Moderate' },
          { ...originalResult.categories[1], score: 40, grade: 'F', severity: 'Moderate' },
        ],
      })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'local-standards-flat.pdf', originalResult)

    expect(result.model.rejectedActions || []).toHaveLength(0)
    expect(result.buffer.equals(Buffer.from('pdf-font-fix'))).toBe(true)
  })

  it('skips semantic AI when semantic categories are already all complete and no AI-first figures exist', async () => {
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
      figureCandidates: [],
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

  it('still runs semantic AI for eligible figures even when semantic categories are complete', async () => {
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
      filename: 'figure-semantic.pdf',
      pageCount: 4,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 95,
      grade: 'A',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult(),
      categories: [
        { id: 'heading_structure', label: 'Heading Structure', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
        { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
        { id: 'table_markup', label: 'Table Markup', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
        { id: 'link_quality', label: 'Link Quality', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Figure Semantic', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [{
        id: 'figure:1',
        pageNumber: 1,
        targetRef: 'obj:1 0 R',
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        hasAlt: true,
        altText: 'Old text',
        informativeHint: 'informative',
        surroundingText: ['County services chart'],
        repairMode: 'set_alt',
        targetTag: '/Figure',
        pageImageCount: 1,
        textDensityHint: 'low',
        imageEvidence: 'strong',
      }],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    })
    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: [], actions: [] })
    generateSemanticRepairBatches.mockResolvedValue({ batches: [{
      batchType: 'figures',
      headings: [],
      figures: [{ candidateId: 'figure:1', decorative: false, altText: 'Bar chart showing county services by year', confidence: 0.92, rationale: 'Vision identifies a bar chart.' }],
      tables: [],
      links: [],
      bookmarks: [],
    }], reviewFlags: [] })
    executeRemediationTool.mockResolvedValue({
      buffer: Buffer.from('figure-fixed'),
      action: {
        tool: 'set_figure_alt_text',
        target: 'page 1',
        candidateId: 'figure:1',
        details: 'AI figure proposal',
        confidence: 0.92,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['alt_text'],
        generationSource: 'semantic_ai',
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })
    analyzePDF.mockResolvedValue(originalResult)

    await remediatePdfWithAgent(Buffer.from('pdf'), 'figure-semantic.pdf', originalResult)

    expect(generateSemanticRepairBatches).toHaveBeenCalledTimes(1)
    expect(executeRemediationTool).toHaveBeenCalled()
    expect(executeRemediationTool.mock.calls[0][0].call.arguments.generationSource).toBe('semantic_ai')
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
    const semanticFixedBuffer = Buffer.from('semantic-fixed')
    executeRemediationTool
      .mockResolvedValueOnce({
        buffer: semanticFixedBuffer,
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
    // 5 final cleanup tools; pass through the semantic-fixed buffer unchanged
    for (let i = 0; i < 5; i++) {
      executeRemediationTool.mockResolvedValueOnce({
        buffer: semanticFixedBuffer,
        action: {
          tool: 'normalize_annotation_tab_order',
          target: 'document',
          details: 'no-op',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: false,
          categoryTargets: ['reading_order'],
          outcome: 'no_effect',
        },
        manualReviewFlags: [],
      })
    }
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
    expect(executeRemediationTool.mock.calls.some(call => call[0].call.tool_name === 'create_heading_from_candidate')).toBe(true)
    expect(inspectPdfForRemediation.mock.calls.some(call =>
      call[0]?.equals?.(semanticFixedBuffer)
      && call[1]?.overallScore === 81
      && call[2]?.cache
      && !call[2]?.inspectMode,
    )).toBe(true)
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
    executeRemediationTool.mockResolvedValueOnce({
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
    analyzePDF.mockImplementation(async (_buffer: Buffer, _filename: string, options?: { inheritedVeraPdf?: VeraPdfResult }) => ({
      ...originalResult,
      verapdf: options?.inheritedVeraPdf ?? makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 16,
        failures: [
          { ruleId: 'links', specification: null, clause: null, testNumber: null, location: null, message: 'Link issue', categoryIds: [] },
          { ruleId: 'new', specification: null, clause: null, testNumber: null, location: null, message: 'New issue', categoryIds: [] },
        ],
      }),
    }))

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'links.pdf', originalResult)

    expect(result.buffer.equals(Buffer.from('pdf'))).toBe(true)
    expect(inspectPdfForRemediation.mock.calls.some(call =>
      call[0]?.equals?.(Buffer.from('pdf'))
      && call[1] === originalResult
      && call[2]?.cache
      && !call[2]?.inspectMode,
    )).toBe(true)
    expect(result.model.rejectedActions?.some(action => action.tool === 'rewrite_link_visible_text')).toBe(true)
    expect(result.finalResult.verapdf.failedChecks).toBe(12)
  })

  it('batches semantic link annotation content repairs through the structure backend', async () => {
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
      filename: 'semantic-links.pdf',
      pageCount: 4,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 2, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 70,
      grade: 'C',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 4,
        failures: [{ ruleId: 'links', specification: null, clause: null, testNumber: null, location: null, message: 'Link issue', categoryIds: [] }],
      }),
      categories: [
        { id: 'link_quality', label: 'Link Quality', weight: 0.15, score: 60, grade: 'D', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    const context = {
      pdfjs: { title: 'Links', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [
        { id: 'link:1', pageNumber: 1, annotationIndex: 0, text: 'First', url: 'https://example.com/1', annotationContents: null, rawUrl: false, suggestedText: 'First link' },
        { id: 'link:2', pageNumber: 1, annotationIndex: 1, text: 'Second', url: 'https://example.com/2', annotationContents: null, rawUrl: false, suggestedText: 'Second link' },
      ],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    }

    inspectPdfForRemediation.mockResolvedValue(context)
    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: ['link_quality'], actions: [] })
    generateSemanticRepairBatches.mockResolvedValue({
      batches: [{
        batchType: 'links',
        headings: [],
        figures: [],
        tables: [],
        links: [
          { candidateId: 'link:1', replacementText: 'First', annotationContents: 'First link', confidence: 0.92, rationale: 'First label.' },
          { candidateId: 'link:2', replacementText: 'Second', annotationContents: 'Second link', confidence: 0.91, rationale: 'Second label.' },
        ],
      }],
      reviewFlags: [],
    })
    runPdfStructureBackendBatch.mockResolvedValueOnce({
      status: 'applied',
      changedDocumentBytes: true,
      appliedMutations: [],
      warnings: [],
      headings: [],
      structuralNodes: [],
      tables: [],
      figures: [],
      imageStructNodes: [],
      acrobatAltRiskNodes: [],
      readingOrderNodes: [],
      readingOrderParents: [],
      outputBuffer: Buffer.from('semantic-links-batched'),
      operationResults: [
        {
          operation: 'set_link_annotation_contents',
          status: 'applied',
          changedDocumentBytes: true,
          appliedMutations: [{ ref: 'obj:1 0 R', details: 'first link contents repaired' }],
          warnings: [],
        },
        {
          operation: 'set_link_annotation_contents',
          status: 'applied',
          changedDocumentBytes: true,
          appliedMutations: [{ ref: 'obj:2 0 R', details: 'second link contents repaired' }],
          warnings: [],
        },
      ],
    })
    analyzePDF.mockImplementation(async (_buffer: Buffer, _filename: string, options?: { inheritedVeraPdf?: VeraPdfResult }) => ({
      ...originalResult,
      overallScore: 100,
      grade: 'A',
      verapdf: options?.inheritedVeraPdf ?? makeVeraPdfResult(),
      categories: [
        { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass' },
      ],
    }))

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'semantic-links.pdf', originalResult)

    expect(runPdfStructureBackendBatch.mock.calls.some(call =>
      Array.isArray(call[0]?.mutations)
      && call[0].mutations.filter((mutation: any) => mutation?.operation === 'set_link_annotation_contents').length === 2,
    )).toBe(true)
    expect(executeRemediationTool).not.toHaveBeenCalledWith(expect.objectContaining({
      call: expect.objectContaining({ tool_name: 'set_link_annotation_contents' }),
    }))
    expect(result.model.actions?.filter(action => action.tool === 'set_link_annotation_contents' && action.outcome === 'applied')).toHaveLength(2)
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

    const taggedContext = {
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
    }
    inspectPdfForRemediation.mockResolvedValue(taggedContext)

    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['reading_order'],
        actions: [
          { tool_name: 'repair_structure_conformance', arguments: { target: 'document' }, rationale: 'repair', confidence: 0.9 },
        ],
      })
      .mockResolvedValueOnce({ done: true, unresolvedIssues: [], actions: [] })

    executeRemediationTool.mockResolvedValueOnce({
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
    }).mockResolvedValue(originalResult)

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

  it('uses heuristic alt-text fallback only after AI figure generation fails', async () => {
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
      pageCount: 2,
    }
    const originalResult: AnalysisResult = {
      filename: 'figure-fallback.pdf',
      pageCount: 2,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 75,
      grade: 'C',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 2,
        failures: [{ ruleId: 'alt', specification: null, clause: null, testNumber: null, location: null, message: 'Missing alt text', categoryIds: ['alt_text'] }],
      }),
      categories: [
        { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 40, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Fallback', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [{
        id: 'figure:1',
        pageNumber: 2,
        targetRef: 'obj:21 0 R',
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        hasAlt: false,
        altText: null,
        informativeHint: 'informative',
        surroundingText: ['County outcomes chart'],
        repairMode: 'set_alt',
        targetTag: '/Figure',
        pageImageCount: 1,
        textDensityHint: 'low',
        imageEvidence: 'strong',
      }],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    })
    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: [], actions: [] })
    generateSemanticRepairBatches.mockRejectedValue(new Error('OpenAI-compatible semantic repair request failed: 413 {"error":{"message":"context_length_exceeded"}}'))
    executeRemediationTool.mockResolvedValue({
      buffer: Buffer.from('pdf'),
      action: {
        tool: 'set_figure_alt_text',
        target: 'page 2',
        candidateId: 'figure:1',
        details: 'heuristic fallback',
        confidence: 0.55,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: false,
        categoryTargets: ['alt_text'],
        generationSource: 'heuristic_fallback',
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'figure-fallback.pdf', originalResult)

    expect(generateSemanticRepairBatches).toHaveBeenCalledTimes(1)
    expect(executeRemediationTool.mock.calls.some(call => call[0].call.arguments.generationSource === 'heuristic_fallback')).toBe(true)
    expect(inspectPdfForRemediation.mock.calls.every(call => !call[2] || call[2].cache)).toBe(true)
    expect(result.model.actions?.some(action => action.generationSource === 'heuristic_fallback')).toBe(true)
  })

  it('uses heuristic alt-text fallback when semantic provider fetch fails', async () => {
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
      pageCount: 2,
    }
    const originalResult: AnalysisResult = {
      filename: 'figure-fetch-fallback.pdf',
      pageCount: 2,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 75,
      grade: 'C',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'unavailable',
        isCompliant: null,
        failedChecks: 0,
        failures: [],
      }),
      categories: [
        { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 40, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Fallback', lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [{
        id: 'figure:1',
        pageNumber: 2,
        targetRef: 'obj:21 0 R',
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        hasAlt: false,
        altText: null,
        informativeHint: 'informative',
        surroundingText: ['County outcomes chart'],
        repairMode: 'set_alt',
        targetTag: '/Figure',
        pageImageCount: 1,
        textDensityHint: 'low',
        imageEvidence: 'strong',
      }],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    })
    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: [], actions: [] })
    generateSemanticRepairBatches.mockRejectedValue(new Error('fetch failed'))
    executeRemediationTool.mockResolvedValue({
      buffer: Buffer.from('pdf'),
      action: {
        tool: 'set_figure_alt_text',
        target: 'page 2',
        candidateId: 'figure:1',
        details: 'heuristic fallback after provider failure',
        confidence: 0.55,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: false,
        categoryTargets: ['alt_text'],
        generationSource: 'heuristic_fallback',
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'figure-fetch-fallback.pdf', originalResult)

    expect(generateSemanticRepairBatches).toHaveBeenCalledTimes(1)
    expect(executeRemediationTool.mock.calls.some(call => call[0].call.arguments.generationSource === 'heuristic_fallback')).toBe(true)
    expect(result.model.manualReviewFlags.some(flag => flag.code === 'semantic_enrichment_skipped')).toBe(true)
    expect(result.model.manualReviewFlags.some(flag => /semantic figure generation failed.*fetch failed/i.test(flag.details))).toBe(true)
  })

  it('retries a late figure candidate when it becomes retaggable after an earlier blocked attempt', async () => {
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
      pageCount: 7,
    }
    const originalResult: AnalysisResult = {
      filename: 'late-retag.pdf',
      pageCount: 7,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 82,
      grade: 'B',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 1,
        failures: [{ ruleId: 'alt', specification: null, clause: null, testNumber: null, location: null, message: 'Missing alt text', categoryIds: ['alt_text'] }],
      }),
      categories: [
        { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 40, grade: 'F', severity: 'Critical', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation
      .mockResolvedValueOnce({
        pdfjs: { title: 'Late retry', lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [{ ref: 'obj:48 0 R', hasAlt: false }], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
        figureCandidates: [{
          id: 'figure:1',
          pageNumber: 7,
          targetRef: 'obj:48 0 R',
          bbox: { x: 0, y: 0, width: 1, height: 1 },
          hasAlt: false,
          altText: null,
          informativeHint: 'informative',
          surroundingText: ['Direction section chart'],
          repairMode: 'defer',
          targetTag: '/P',
          unsafeReason: 'text_heavy_candidate: Target obj:48 0 R appears text-heavy and is not safe to retag as /Figure.',
          pageImageCount: 0,
          textDensityHint: 'high',
          imageEvidence: 'strong',
        }],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: {},
      })
      .mockResolvedValue({
        pdfjs: { title: 'Late retry', lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [{ ref: 'obj:48 0 R', hasAlt: false }], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
        figureCandidates: [{
          id: 'figure:1',
          pageNumber: 7,
          targetRef: 'obj:48 0 R',
          bbox: { x: 0, y: 0, width: 1, height: 1 },
          hasAlt: false,
          altText: null,
          informativeHint: 'informative',
          surroundingText: ['Direction section chart'],
          repairMode: 'retag_then_set_alt',
          targetTag: '/P',
          pageImageCount: 0,
          textDensityHint: 'high',
          imageEvidence: 'strong',
        }],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: {},
      })

    planRemediationActions.mockResolvedValue({
      done: false,
      unresolvedIssues: ['alt_text'],
      actions: [
        { tool_name: 'set_figure_alt_text', arguments: { candidateId: 'figure:1', altText: 'Initial alt text' }, rationale: 'Initial figure pass', confidence: 0.8 },
      ],
    })
    generateSemanticRepairBatches.mockResolvedValue({ batches: [], reviewFlags: [] })
    executeRemediationTool
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf'),
        action: {
          tool: 'set_figure_alt_text',
          target: 'page 7',
          candidateId: 'figure:1',
          details: 'text_heavy_candidate: Target obj:48 0 R appears text-heavy and is not safe to retag as /Figure.',
          confidence: 0.8,
          autoApplied: false,
          changedVisibleContent: false,
          changedDocumentBytes: false,
          categoryTargets: ['alt_text'],
          outcome: 'no_effect',
        },
        manualReviewFlags: [],
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf'),
        action: {
          tool: 'set_figure_alt_text',
          target: 'page 7',
          candidateId: 'figure:1',
          details: 'late heuristic retry',
          confidence: 0.55,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: false,
          categoryTargets: ['alt_text'],
          generationSource: 'heuristic_fallback',
          outcome: 'applied',
        },
        manualReviewFlags: [],
      })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'late-retag.pdf', originalResult)

    expect(executeRemediationTool.mock.calls.some(call =>
      call[0].call.arguments?.candidateId === 'figure:1'
      && call[0].call.arguments?.generationSource === 'heuristic_fallback'
    )).toBe(true)
    expect(result.model.actions?.some(action =>
      action.candidateId === 'figure:1' && action.generationSource === 'heuristic_fallback'
    )).toBe(true)
  })

  it('does not stop at A/pass when deterministic Acrobat-risk repair is still auto-runnable', async () => {
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
      pageCount: 1,
    }
    const originalResult: AnalysisResult = {
      filename: 'acrobat-risk.pdf',
      pageCount: 1,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 85,
      grade: 'B',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({
        status: 'failed',
        isCompliant: false,
        failedChecks: 1,
        failures: [{ ruleId: 'alt-text', specification: null, clause: null, testNumber: null, location: null, message: 'Figure tags shall include an alternative representation', categoryIds: ['alt_text'] }],
      }),
      categories: [
        { id: 'alt_text', label: 'Alt Text on Images', weight: 0.15, score: 40, grade: 'F', severity: 'Critical', findings: ['Acrobat-risk non-figure graphics ownership remains.'], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    const afterPrimaryPass: AnalysisResult = {
      ...originalResult,
      overallScore: 100,
      grade: 'A',
      verapdf: makeVeraPdfResult(),
      categories: [
        { ...originalResult.categories[0], score: 100, grade: 'A', severity: 'Pass', findings: ['Detected 1 Acrobat-risk non-figure element with graphics content.'] },
      ],
    }
    const afterAcrobatRepair: AnalysisResult = {
      ...afterPrimaryPass,
      categories: [
        { ...afterPrimaryPass.categories[0], findings: [] },
      ],
    }

    inspectPdfForRemediation
      .mockResolvedValueOnce({
        pdfjs: { title: null, lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [{ ref: 'obj:38 0 R', hasAlt: false }], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 1 },
        figureCandidates: [{ id: 'figure:1', pageNumber: 1, surroundingText: ['County chart'], splitGenerated: false, informativeHint: 'informative', repairMode: 'safe' }],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: { acrobatAltRiskNodes: [{ ref: 'obj:38 0 R', tag: '/H1', ownershipMode: 'mixed_text_graphics_same_mcid', splitSafe: true, mcids: [0] }] },
      })
      .mockResolvedValueOnce({
        pdfjs: { title: null, lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [{ ref: 'obj:38 0 R', hasAlt: false }], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 1 },
        figureCandidates: [{ id: 'figure:1', pageNumber: 1, surroundingText: ['County chart'], splitGenerated: false, informativeHint: 'informative', repairMode: 'safe' }],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: { acrobatAltRiskNodes: [{ ref: 'obj:38 0 R', tag: '/H1', ownershipMode: 'mixed_text_graphics_same_mcid', splitSafe: true, mcids: [0] }] },
      })
      .mockResolvedValueOnce({
        pdfjs: { title: null, lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [{ ref: 'obj:38 0 R', hasAlt: false }], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 1 },
        figureCandidates: [{ id: 'figure:1', pageNumber: 1, surroundingText: ['County chart'], splitGenerated: false, informativeHint: 'informative', repairMode: 'safe' }],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: { acrobatAltRiskNodes: [] },
      })
      .mockResolvedValue({
        pdfjs: { title: null, lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 1 },
        figureCandidates: [],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: { acrobatAltRiskNodes: [] },
      })

    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['alt_text'],
        actions: [
          { tool_name: 'set_figure_alt_text', arguments: { candidateId: 'figure:1', altText: 'Chart image' }, rationale: 'Primary repair', confidence: 0.9 },
          { tool_name: 'repair_other_elements_alt_text', arguments: {}, rationale: 'Fix Acrobat-only logo ownership', confidence: 0.9 },
        ],
      })
      .mockResolvedValueOnce({
        done: true,
        unresolvedIssues: [],
        actions: [],
      })

    const acrobatPassBuffer = Buffer.from('acrobat-pass')
    executeRemediationTool
      .mockResolvedValueOnce({
        buffer: Buffer.from('primary-pass'),
        action: {
          tool: 'set_figure_alt_text',
          target: 'page 1',
          candidateId: 'figure:1',
          details: 'primary repair',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['alt_text'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      })
      .mockResolvedValueOnce({
        buffer: acrobatPassBuffer,
        action: {
          tool: 'repair_other_elements_alt_text',
          target: 'document',
          details: 'acrobat ownership repaired',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['alt_text'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      })
    // 5 final cleanup tools; pass through the acrobat-fixed buffer unchanged
    for (let i = 0; i < 5; i++) {
      executeRemediationTool.mockResolvedValueOnce({
        buffer: acrobatPassBuffer,
        action: {
          tool: 'normalize_annotation_tab_order',
          target: 'document',
          details: 'no-op',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: false,
          categoryTargets: ['reading_order'],
          outcome: 'no_effect',
        },
        manualReviewFlags: [],
      })
    }

    analyzePDF.mockResolvedValue(afterAcrobatRepair)

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'acrobat-risk.pdf', originalResult)

    expect(planRemediationActions).toHaveBeenCalledTimes(1)
    expect(executeRemediationTool.mock.calls.slice(0, 2).map(call => call[0].call.tool_name)).toEqual(['set_figure_alt_text', 'repair_other_elements_alt_text'])
    expect(result.buffer.equals(Buffer.from('acrobat-pass'))).toBe(true)
  })

  it('applies semantic bookmark cleanup from outline-backed targets without matching heading candidates', async () => {
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
      pageCount: 24,
    }
    const originalResult: AnalysisResult = {
      filename: 'outline-backed-bookmarks.pdf',
      pageCount: 24,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 94,
      grade: 'A',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult(),
      categories: [
        { id: 'bookmarks', label: 'Bookmarks / Navigation', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Annual report', lang: 'en', pageCount: 24 },
      qpdf: {
        lang: 'en',
        headings: [],
        tables: [],
        images: [],
        formFields: [],
        hasStructTree: true,
        outlineCount: 6,
        outlineTitles: ['Raw outline 6', 'Raw outline 7', 'Raw outline 8', 'Raw outline 9'],
        structTreeDepth: 2,
      },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    })
    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: [], actions: [] })
    generateSemanticRepairBatches.mockResolvedValue({
      batches: [{
        batchType: 'bookmarks',
        headings: [],
        figures: [],
        tables: [],
        links: [],
        bookmarks: [{
          candidateId: 'bookmark:outline:1',
          title: 'Council members',
          level: 'H2',
          confidence: 0.96,
          rationale: 'Clean outline label.',
          pageNumber: 6,
          targetRef: null,
        }],
      }],
      reviewFlags: [],
    })
    executeRemediationTool.mockResolvedValue({
      buffer: Buffer.from('bookmark-fixed'),
      action: {
        tool: 'replace_bookmarks_from_headings',
        target: 'document',
        details: 'AI bookmark cleanup',
        confidence: 0.96,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['bookmarks'],
        generationSource: 'semantic_ai',
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })
    analyzePDF.mockResolvedValue(originalResult)

    await remediatePdfWithAgent(Buffer.from('pdf'), 'outline-backed-bookmarks.pdf', originalResult)

    expect(executeRemediationTool).toHaveBeenCalled()
    expect(inspectPdfForRemediation.mock.calls.some(call =>
      call[0]?.equals?.(Buffer.from('bookmark-fixed'))
      && call[1] === originalResult
      && call[2]?.cache
      && !call[2]?.inspectMode,
    )).toBe(true)
    const bookmarkCall = executeRemediationTool.mock.calls
      .map(call => call[0].call)
      .find(call => call.tool_name === 'replace_bookmarks_from_headings')
    expect(bookmarkCall).toMatchObject({
      tool_name: 'replace_bookmarks_from_headings',
      arguments: {
        headings: [{
          text: 'Council members',
          level: 'H2',
          pageNumber: 6,
          targetRef: null,
        }],
      },
    })
  })

  it('applies semantic table-header repair using the table ref when first-row cells were not extracted', async () => {
    const { remediatePdfWithAgent } = await import('../services/agentRemediationService.js')
    const originalResult: AnalysisResult = {
      filename: 'outline-backed-table.pdf',
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
      overallScore: 82,
      grade: 'B',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult(),
      categories: [
        { id: 'table_markup', label: 'Table Markup', weight: 0.1, score: 40, grade: 'F', severity: 'Critical', findings: ['Missing table headers'], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Annual report', lang: 'en', pageCount: 1 },
      qpdf: {
        lang: 'en',
        headings: [],
        tables: [],
        images: [],
        formFields: [],
        hasStructTree: true,
        outlineCount: 0,
        outlineTitles: [],
        structTreeDepth: 2,
      },
      figureCandidates: [],
      tableCandidates: [{
        id: 'table:1',
        ref: 'obj:30 0 R',
        pageNumberHints: [1],
        firstRowCellRefs: [],
        headerCellRefs: [],
        hasHeaders: false,
        repairMode: 'safe',
        nearbyContext: ['Example table'],
      }],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    })
    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: [], actions: [] })
    generateSemanticRepairBatches.mockResolvedValue({
      batches: [{
        batchType: 'tables',
        headings: [],
        figures: [],
        tables: [{
          candidateId: 'table:1',
          useFirstRowAsHeader: true,
          confidence: 0.96,
          rationale: 'The first visible row is the header row.',
        }],
        links: [],
        bookmarks: [],
      }],
      reviewFlags: [],
    })
    executeRemediationTool.mockResolvedValue({
      buffer: Buffer.from('table-fixed'),
      action: {
        tool: 'set_table_header_cells',
        target: 'table obj:30 0 R',
        details: 'AI table cleanup',
        confidence: 0.96,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['table_markup'],
        generationSource: 'semantic_ai',
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })
    analyzePDF.mockResolvedValue(originalResult)

    await remediatePdfWithAgent(Buffer.from('pdf'), 'outline-backed-table.pdf', originalResult)

    const tableCall = executeRemediationTool.mock.calls
      .map(call => call[0].call)
      .find(call => call.tool_name === 'set_table_header_cells')
    expect(tableCall).toMatchObject({
      tool_name: 'set_table_header_cells',
      arguments: { targets: ['obj:30 0 R'] },
    })
  })

  it('skips bootstrap-stage execution for well-tagged documents even if a planner result includes it', async () => {
    const { remediatePdfWithAgent } = await import('../services/agentRemediationService.js')
    const pdfMetadata: PdfMetadata = {
      creator: 'Microsoft Word',
      producer: 'Microsoft Word',
      creationDate: null,
      modDate: null,
      pdfVersion: '1.7',
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 1,
    }
    const originalResult: AnalysisResult = {
      filename: 'well-tagged.pdf',
      pageCount: 1,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 1, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 92,
      grade: 'B',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({ status: 'failed', isCompliant: false, failedChecks: 1 }),
      categories: [
        { id: 'title_language', label: 'Title', weight: 0.15, score: 85, grade: 'B', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'heading_structure', label: 'Headings', weight: 0.15, score: 90, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
        { id: 'reading_order', label: 'Reading Order', weight: 0.15, score: 92, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Tagged', lang: 'en', hasText: true, textLength: 600, links: [], imageCount: 0, metadata: pdfMetadata },
      qpdf: {
        lang: 'en',
        headings: [{ level: 'H1', tag: 'H1' }],
        tables: [],
        images: [],
        formFields: [],
        hasStructTree: true,
        hasMarkInfo: true,
        outlineCount: 0,
        outlineTitles: [],
        structTreeDepth: 3,
      },
      figureCandidates: [],
      tableCandidates: [],
      headingCandidates: [{ id: 'heading:1', pageNumber: 1, text: 'Annual report', existingTag: 'H1' }],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [{ ref: '1 0 R' }] },
    })

    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['title_language'],
        actions: [
          { tool_name: 'bootstrap_struct_tree', arguments: { target: 'document' }, rationale: 'bootstrap', confidence: 0.9 },
          { tool_name: 'set_document_title', arguments: { title: 'Tagged' }, rationale: 'title', confidence: 0.9 },
        ],
      })
      .mockResolvedValueOnce({ done: true, unresolvedIssues: [], actions: [] })

    executeRemediationTool.mockResolvedValueOnce({
      buffer: Buffer.from('tagged-fixed'),
      action: {
        tool: 'set_document_title',
        target: 'document',
        details: 'title fixed',
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
      categories: originalResult.categories.map(category => ({ ...category, score: 100, grade: 'A', severity: 'Pass' })),
    })

    await remediatePdfWithAgent(Buffer.from('pdf'), 'well-tagged.pdf', originalResult)

    expect(executeRemediationTool.mock.calls.some(call => call[0].call.tool_name === 'bootstrap_struct_tree')).toBe(false)
    expect(executeRemediationTool.mock.calls.some(call => call[0].call.tool_name === 'set_document_title')).toBe(true)
  })

  it('forces deep structure scoring when validating bootstrap stages', async () => {
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
      pageCount: 2,
    }
    const originalResult: AnalysisResult = {
      filename: 'untagged-bootstrap.pdf',
      pageCount: 2,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 43,
      grade: 'F',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({ status: 'failed', isCompliant: false, failedChecks: 10 }),
      categories: [
        { id: 'text_extractability', label: 'Text', weight: 0.2, score: 50, grade: 'F', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'title_language', label: 'Title', weight: 0.1, score: 100, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
        { id: 'heading_structure', label: 'Headings', weight: 0.1, score: 0, grade: 'F', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'alt_text', label: 'Alt', weight: 0.15, score: 0, grade: 'F', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'reading_order', label: 'Reading', weight: 0.15, score: 0, grade: 'F', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'pdf_ua_compliance', label: 'PDF/UA', weight: 0.3, score: 70, grade: 'C', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      localStandards: { status: 'issues_detected', findings: [], knownGapKeys: [] },
      failureModes: [],
      detectedIssues: [],
      warnings: [],
      categoryScores: {
        text_extractability: 50,
        title_language: 100,
        heading_structure: 0,
        alt_text: 0,
        reading_order: 0,
        pdf_ua_compliance: 70,
      },
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Newsletter 5', lang: 'en', hasText: true, textLength: 1200, links: [], imageCount: 6, metadata: pdfMetadata },
      qpdf: {
        lang: 'en',
        headings: [],
        tables: [],
        images: [{ ref: 'img:1' }],
        formFields: [],
        hasStructTree: false,
        hasMarkInfo: false,
        outlineCount: 0,
        outlineTitles: [],
        structTreeDepth: 0,
      },
      figureCandidates: [{ id: 'figure:1', pageNumber: 1, targetRef: '10 0 R', existingTag: 'P', bbox: { x: 0, y: 0, width: 1, height: 1 }, pageImageCount: 1, pageHasText: true, informativeHint: 'informative', imageEvidence: 'strong', surroundingText: '', pageTextSnippet: '', pageLineCount: 2, pageGraphicGroupCount: 1, pageStructuredFigureCount: 0, targetHasText: false, targetTextLength: 0, parentTagPath: [], repairMode: 'retag_then_set_alt' }],
      tableCandidates: [],
      headingCandidates: [{ id: 'heading:1', pageNumber: 1, text: 'Juvenile sentencing', existingTag: null }],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [] },
    })

    planRemediationActions
      .mockResolvedValueOnce({
        done: false,
        unresolvedIssues: ['logical_structure'],
        actions: [
          { tool_name: 'bootstrap_struct_tree', arguments: { target: 'document' }, rationale: 'bootstrap', confidence: 0.95 },
        ],
      })
      .mockResolvedValueOnce({ done: true, unresolvedIssues: [], actions: [] })

    executeRemediationTool.mockResolvedValueOnce({
      buffer: Buffer.from('bootstrapped'),
      action: {
        tool: 'bootstrap_struct_tree',
        target: 'document',
        details: 'bootstrapped',
        confidence: 0.95,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['text_extractability', 'heading_structure', 'alt_text', 'reading_order', 'pdf_ua_compliance'],
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })

    analyzePDF.mockImplementation(async (_buffer: Buffer, _filename: string, options?: any) => {
      if (options?.analysisProfile === 'remediation_fast') {
        return {
          ...originalResult,
          overallScore: options?.forceStructureForScoring ? 98 : 73,
          categories: originalResult.categories.map((category: any) => {
            if (category.id === 'text_extractability') return { ...category, score: options?.forceStructureForScoring ? 100 : 40, grade: 'A', severity: 'Pass' }
            if (category.id === 'heading_structure') return { ...category, score: 100, grade: 'A', severity: 'Pass' }
            if (category.id === 'alt_text') return { ...category, score: 100, grade: 'A', severity: 'Pass' }
            if (category.id === 'reading_order') return { ...category, score: 40, grade: 'D', severity: 'Moderate' }
            if (category.id === 'pdf_ua_compliance') return { ...category, score: options?.forceStructureForScoring ? 85 : 20, grade: 'B', severity: 'Moderate' }
            return category
          }),
        }
      }
      return {
        ...originalResult,
        overallScore: 98,
        grade: 'A',
        categories: originalResult.categories.map((category: any) => ({ ...category, score: category.id === 'reading_order' ? 40 : 100, grade: 'A', severity: 'Pass' })),
      }
    })

    await remediatePdfWithAgent(Buffer.from('pdf'), 'untagged-bootstrap.pdf', originalResult)

    expect(analyzePDF.mock.calls.some(([, , options]) =>
      options?.analysisProfile === 'remediation_fast'
      && options?.forceStructureForScoring === true,
    )).toBe(true)
  })

  it('uses heuristic-only semantic routing for well-tagged figure cleanup without calling AI enrichment', async () => {
    const { remediatePdfWithAgent } = await import('../services/agentRemediationService.js')
    const pdfMetadata: PdfMetadata = {
      creator: 'Adobe Acrobat',
      producer: 'Adobe Acrobat',
      creationDate: null,
      modDate: null,
      pdfVersion: '1.7',
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 1,
    }
    const originalResult: AnalysisResult = {
      filename: 'heuristic-only.pdf',
      pageCount: 1,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 1, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 90,
      grade: 'B',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({ status: 'failed', isCompliant: false, failedChecks: 1 }),
      categories: [
        { id: 'alt_text', label: 'Alt Text', weight: 0.15, score: 80, grade: 'B', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
        { id: 'heading_structure', label: 'Headings', weight: 0.15, score: 90, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
        { id: 'reading_order', label: 'Reading Order', weight: 0.15, score: 92, grade: 'A', severity: 'Pass', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: 'Tagged', lang: 'en', hasText: true, textLength: 800, links: [], imageCount: 1, metadata: pdfMetadata },
      qpdf: {
        lang: 'en',
        headings: [{ level: 'H1', tag: 'H1' }],
        tables: [],
        images: [{ ref: 'obj:1 0 R', hasAlt: false }],
        formFields: [],
        hasStructTree: true,
        hasMarkInfo: true,
        outlineCount: 0,
        outlineTitles: [],
        structTreeDepth: 3,
      },
      figureCandidates: [{
        id: 'figure:1',
        pageNumber: 1,
        surroundingText: ['County outcomes chart'],
        splitGenerated: false,
        informativeHint: 'informative',
        repairMode: 'safe',
      }],
      tableCandidates: [],
      headingCandidates: [{ id: 'heading:1', pageNumber: 1, text: 'Annual report', existingTag: 'H1' }],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: { structuralNodes: [{ ref: '1 0 R' }] },
    })

    planRemediationActions.mockResolvedValue({ done: true, unresolvedIssues: [], actions: [] })
    executeRemediationTool.mockResolvedValueOnce({
      buffer: Buffer.from('heuristic-fixed'),
      action: {
        tool: 'set_figure_alt_text',
        target: 'page 1',
        candidateId: 'figure:1',
        details: 'heuristic alt text',
        confidence: 0.55,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['alt_text'],
        generationSource: 'heuristic_fallback',
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })
    analyzePDF.mockResolvedValue(originalResult)

    await remediatePdfWithAgent(Buffer.from('pdf'), 'heuristic-only.pdf', originalResult)

    expect(generateSemanticRepairBatches).not.toHaveBeenCalled()
    expect(executeRemediationTool.mock.calls.some(call =>
      call[0].call.tool_name === 'set_figure_alt_text'
      && call[0].call.arguments.generationSource === 'heuristic_fallback',
    )).toBe(true)
  })

  it('accepts a flat-score stage when a targeted category improves without regressions', async () => {
    const { __test_evaluateStageAcceptance } = await import('../services/agentRemediationService.js')
    const previous = {
      overallScore: 52,
      verapdf: { status: 'unavailable', failures: [] },
      categories: [
        { id: 'bookmarks', score: 0, grade: 'F', severity: 'Moderate' },
        { id: 'heading_structure', score: 100, grade: 'A', severity: 'Pass' },
      ],
    } as any
    const next = {
      overallScore: 52,
      verapdf: { status: 'unavailable', failures: [] },
      categories: [
        { id: 'bookmarks', score: 100, grade: 'A', severity: 'Pass' },
        { id: 'heading_structure', score: 100, grade: 'A', severity: 'Pass' },
      ],
    } as any
    const decision = __test_evaluateStageAcceptance(previous, next, [{
      tool: 'replace_bookmarks_from_headings',
      target: 'document',
      details: 'Created bookmarks.',
      confidence: 0.8,
      autoApplied: true,
      changedVisibleContent: false,
      changedDocumentBytes: true,
      categoryTargets: ['bookmarks'],
      outcome: 'applied',
    }] as any)

    expect(decision.accept).toBe(true)
    expect(decision.reason).toBeNull()
  })

  it('retries unresolved set_alt figure candidates during the late heuristic pass', async () => {
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
      pageCount: 1,
    }
    const originalResult: AnalysisResult = {
      filename: 'late-set-alt.pdf',
      pageCount: 1,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 80,
      grade: 'B',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({ status: 'unavailable', executionStatus: 'missing_binary', failedChecks: 0, failures: [] }),
      categories: [
        { id: 'alt_text', label: 'Alt Text', weight: 0.15, score: 60, grade: 'D', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation
      .mockResolvedValueOnce({
        pdfjs: { title: null, lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [{ ref: 'obj:435 0 R', hasAlt: false }], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
        figureCandidates: [{
          id: 'figure:7',
          pageNumber: 7,
          targetRef: 'obj:435 0 R',
          hasAlt: false,
          altText: null,
          informativeHint: 'informative',
          repairMode: 'set_alt',
          targetTag: '/Figure',
          pageImageCount: 1,
          textDensityHint: 'high',
          imageEvidence: 'strong',
          surroundingText: ['County outcomes chart'],
          parentTagPath: ['/Figure', '/Story'],
        }],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: {},
      })
      .mockResolvedValue({
        pdfjs: { title: null, lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [{ ref: 'obj:435 0 R', hasAlt: false }], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
        figureCandidates: [{
          id: 'figure:7',
          pageNumber: 7,
          targetRef: 'obj:435 0 R',
          hasAlt: false,
          altText: null,
          informativeHint: 'informative',
          repairMode: 'set_alt',
          targetTag: '/Figure',
          pageImageCount: 1,
          textDensityHint: 'high',
          imageEvidence: 'strong',
          surroundingText: ['County outcomes chart'],
          parentTagPath: ['/Figure', '/Story'],
        }],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: {},
      })

    planRemediationActions.mockResolvedValue({
      done: false,
      unresolvedIssues: ['alt_text'],
      actions: [
        { tool_name: 'set_figure_alt_text', arguments: { candidateId: 'figure:7', altText: 'Initial alt text' }, rationale: 'Initial figure pass', confidence: 0.8 },
      ],
    })
    generateSemanticRepairBatches.mockResolvedValue({ batches: [], reviewFlags: [] })
    executeRemediationTool
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf'),
        action: {
          tool: 'set_figure_alt_text',
          target: 'page 7',
          candidateId: 'figure:7',
          details: 'first pass no effect',
          confidence: 0.8,
          autoApplied: false,
          changedVisibleContent: false,
          changedDocumentBytes: false,
          categoryTargets: ['alt_text'],
          outcome: 'no_effect',
        },
        manualReviewFlags: [],
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf'),
        action: {
          tool: 'set_figure_alt_text',
          target: 'page 7',
          candidateId: 'figure:7',
          details: 'late heuristic retry for unresolved /Figure',
          confidence: 0.55,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: false,
          categoryTargets: ['alt_text'],
          generationSource: 'heuristic_fallback',
          outcome: 'applied',
        },
        manualReviewFlags: [],
      })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'late-set-alt.pdf', originalResult)

    expect(executeRemediationTool.mock.calls.some(call =>
      call[0].call.arguments?.candidateId === 'figure:7'
      && call[0].call.arguments?.generationSource === 'heuristic_fallback'
    )).toBe(true)
    expect(result.model.actions?.some(action =>
      action.candidateId === 'figure:7' && action.generationSource === 'heuristic_fallback'
    )).toBe(true)
  })

  it('tracks late heuristic figure retries by stable targetRef instead of recycled candidate ids', async () => {
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
      pageCount: 1,
    }
    const originalResult: AnalysisResult = {
      filename: 'stable-target-ref.pdf',
      pageCount: 1,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 80,
      grade: 'B',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({ status: 'unavailable', executionStatus: 'missing_binary', failedChecks: 0, failures: [] }),
      categories: [
        { id: 'alt_text', label: 'Alt Text', weight: 0.15, score: 60, grade: 'D', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation
      .mockResolvedValueOnce({
        pdfjs: { title: null, lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [{ ref: 'obj:78 0 R', hasAlt: false }], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
        figureCandidates: [{
          id: 'figure:6',
          pageNumber: 5,
          targetRef: 'obj:78 0 R',
          hasAlt: false,
          altText: null,
          informativeHint: 'informative',
          repairMode: 'set_alt',
          targetTag: '/Figure',
          pageImageCount: 1,
          textDensityHint: 'high',
          imageEvidence: 'strong',
          surroundingText: ['Initial figure'],
          parentTagPath: ['/Figure'],
        }],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: {},
      })
      .mockResolvedValue({
        pdfjs: { title: null, lang: 'en' },
        qpdf: { lang: 'en', headings: [], tables: [], images: [{ ref: 'obj:76 0 R', hasAlt: false }], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
        figureCandidates: [{
          id: 'figure:6',
          pageNumber: 4,
          targetRef: 'obj:76 0 R',
          hasAlt: false,
          altText: null,
          informativeHint: 'informative',
          repairMode: 'set_alt',
          targetTag: '/Figure',
          pageImageCount: 1,
          textDensityHint: 'high',
          imageEvidence: 'strong',
          surroundingText: ['Recycled candidate id on a new target'],
          parentTagPath: ['/Figure'],
        }],
        tableCandidates: [],
        headingCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: {},
      })

    planRemediationActions.mockResolvedValue({
      done: false,
      unresolvedIssues: ['alt_text'],
      actions: [
        { tool_name: 'set_figure_alt_text', arguments: { candidateId: 'figure:6', altText: 'Initial alt text' }, rationale: 'Initial figure pass', confidence: 0.8 },
      ],
    })
    generateSemanticRepairBatches.mockResolvedValue({ batches: [], reviewFlags: [] })
    executeRemediationTool
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf'),
        action: {
          tool: 'set_figure_alt_text',
          target: 'page 5',
          targetRef: 'obj:78 0 R',
          candidateId: 'figure:6',
          details: 'first pass no effect',
          confidence: 0.8,
          autoApplied: false,
          changedVisibleContent: false,
          changedDocumentBytes: false,
          categoryTargets: ['alt_text'],
          outcome: 'no_effect',
        },
        manualReviewFlags: [],
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('pdf'),
        action: {
          tool: 'set_figure_alt_text',
          target: 'page 4',
          targetRef: 'obj:76 0 R',
          candidateId: 'figure:6',
          details: 'late heuristic retry for recycled candidate id',
          confidence: 0.55,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: false,
          categoryTargets: ['alt_text'],
          generationSource: 'heuristic_fallback',
          outcome: 'applied',
        },
        manualReviewFlags: [],
      })

    const result = await remediatePdfWithAgent(Buffer.from('pdf'), 'stable-target-ref.pdf', originalResult)

    expect(executeRemediationTool.mock.calls.some(call =>
      call[0].call.arguments?.candidateId === 'figure:6'
      && call[0].call.arguments?.generationSource === 'heuristic_fallback'
    )).toBe(true)
    expect(result.model.actions?.some(action =>
      action.targetRef === 'obj:76 0 R' && action.generationSource === 'heuristic_fallback'
    )).toBe(true)
  })

  it('prioritizes unresolved retag candidates before already-tagged figures in late heuristic passes', async () => {
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
      pageCount: 1,
    }
    const originalResult: AnalysisResult = {
      filename: 'prioritized-retag.pdf',
      pageCount: 1,
      fileType: 'pdf',
      pdfMetadata,
      routingSignals: { headingCount: 0, linkCount: 0, rawUrlLinkCount: 0, rawUrlLinkDensity: 0 },
      overallScore: 80,
      grade: 'B',
      isScanned: false,
      executiveSummary: '',
      verapdf: makeVeraPdfResult({ status: 'unavailable', executionStatus: 'missing_binary', failedChecks: 0, failures: [] }),
      categories: [
        { id: 'alt_text', label: 'Alt Text', weight: 0.15, score: 60, grade: 'D', severity: 'Moderate', findings: [], explanation: '', helpLinks: [] },
      ],
      warnings: [],
    } as AnalysisResult

    inspectPdfForRemediation.mockResolvedValue({
      pdfjs: { title: null, lang: 'en' },
      qpdf: { lang: 'en', headings: [], tables: [], images: [], formFields: [], hasStructTree: true, outlineCount: 0, structTreeDepth: 2 },
      figureCandidates: [
        {
          id: 'figure:1',
          pageNumber: 1,
          targetRef: 'obj:336 0 R',
          hasAlt: true,
          altText: 'existing alt',
          informativeHint: 'informative',
          repairMode: 'set_alt',
          targetTag: '/Figure',
          pageImageCount: 1,
          textDensityHint: 'medium',
          imageEvidence: 'strong',
          surroundingText: ['Already tagged figure'],
          parentTagPath: ['/Figure'],
        },
        {
          id: 'figure:4',
          pageNumber: 4,
          targetRef: 'obj:74 0 R',
          hasAlt: false,
          altText: null,
          informativeHint: 'informative',
          repairMode: 'retag_then_set_alt',
          targetTag: '/TD',
          pageImageCount: 1,
          textDensityHint: 'medium',
          imageEvidence: 'strong',
          surroundingText: ['Needs wrapper figure'],
          parentTagPath: ['/Table', '/TR', '/TD'],
        },
      ],
      tableCandidates: [],
      headingCandidates: [],
      pages: [],
      linkCandidates: [],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      structure: {},
    })

    planRemediationActions.mockResolvedValue({
      done: false,
      unresolvedIssues: ['alt_text'],
      actions: [],
    })
    generateSemanticRepairBatches.mockResolvedValue({ batches: [], reviewFlags: [] })
    executeRemediationTool.mockResolvedValue({
      buffer: Buffer.from('pdf'),
      action: {
        tool: 'set_figure_alt_text',
        target: 'page 4',
        targetRef: 'obj:74 0 R',
        candidateId: 'figure:4',
        details: 'late heuristic retry prioritized unresolved wrapper',
        confidence: 0.55,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: false,
        categoryTargets: ['alt_text'],
        generationSource: 'heuristic_fallback',
        outcome: 'applied',
      },
      manualReviewFlags: [],
    })

    await remediatePdfWithAgent(Buffer.from('pdf'), 'prioritized-retag.pdf', originalResult)

    const heuristicCall = executeRemediationTool.mock.calls.find(call =>
      call[0].call.arguments?.generationSource === 'heuristic_fallback',
    )
    expect(heuristicCall?.[0].call.arguments?.candidateId).toBe('figure:4')
  })

})
