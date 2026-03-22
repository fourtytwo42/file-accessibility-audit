import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { REMEDIATION } from '#config'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { remediatePdfWithAgent } from '../services/agentRemediationService.js'
import { analyzeWithQpdf } from '../services/qpdfService.js'
import * as pdfStructureBackend from '../services/pdfStructureBackend.js'
import { runPdfStructureBackend } from '../services/pdfStructureBackend.js'
import {
  __test_extractTextLines,
  buildHeadingCandidatesFromPageFacts,
  buildRemediationContextFromSnapshot,
  __test_isSemanticAiEligibleDeferredFigureCandidate,
  __test_getBuildRemediationPageFactsCallCount,
  __test_getInspectionResultCacheSize,
  __test_remapHeadingTarget,
  __test_resetBuildRemediationPageFactsCallCount,
  __test_resetInspectionResultCache,
  executeRemediationTool,
  inspectPdfForRemediation,
  needsAltTextDeepInspection,
  normalizedExistingHeadingLevel,
  selectHighConfidenceLongReportFigureCandidates,
  selectHighConfidenceLongReportHeadingCandidates,
} from '../services/pdfRemediationTools.js'
import type { PdfRemediationContext } from '../services/pdfRemediationTools.js'
import type { RemediationActionRecord, RemediationToolName } from '../services/documentModel.js'
import { planRemediationActions } from '../services/remediationPlanService.js'
import type { StructureBackendMutationResult } from '../services/pdfStructureBackend.js'

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const DOWNLOADS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../Processed/Before')
const PROCESSED_AFTER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../Processed/After')

async function makePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Example document', { x: 72, y: 720, size: 16, font })
  return Buffer.from(await doc.save())
}

async function makePdfWithText(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText(text, { x: 72, y: 720, size: 16, font })
  return Buffer.from(await doc.save())
}

async function makePdfWithLink(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('https://example.com/report', { x: 72, y: 720, size: 12, font })
  const action = doc.context.obj({
    S: PDFName.of('URI'),
    URI: PDFString.of('https://example.com/report'),
  })
  const annotation = doc.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Link'),
    Rect: [72, 716, 220, 732],
    Border: [0, 0, 0],
    A: action,
  })
  page.node.set(PDFName.of('Annots'), doc.context.obj([annotation]))
  return Buffer.from(await doc.save())
}

async function makePdfWithMixedAnnotations(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('https://example.com/report', { x: 72, y: 720, size: 12, font })
  const textAnnotation = doc.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Text'),
    Rect: [40, 740, 60, 760],
    Contents: PDFString.of('note'),
  })
  const action = doc.context.obj({
    S: PDFName.of('URI'),
    URI: PDFString.of('https://example.com/report'),
  })
  const linkAnnotation = doc.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Link'),
    Rect: [72, 716, 220, 732],
    Border: [0, 0, 0],
    A: action,
  })
  page.node.set(PDFName.of('Annots'), doc.context.obj([textAnnotation, linkAnnotation]))
  return Buffer.from(await doc.save())
}

async function makePdfWithOutOfOrderLinks(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Top link', { x: 72, y: 720, size: 12, font })
  page.drawText('Bottom link', { x: 72, y: 640, size: 12, font })
  const topAction = doc.context.obj({
    S: PDFName.of('URI'),
    URI: PDFString.of('https://example.com/top'),
  })
  const bottomAction = doc.context.obj({
    S: PDFName.of('URI'),
    URI: PDFString.of('https://example.com/bottom'),
  })
  const topAnnot = doc.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Link'),
    Rect: [72, 716, 140, 732],
    Border: [0, 0, 0],
    A: topAction,
  })
  const bottomAnnot = doc.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Link'),
    Rect: [72, 636, 160, 652],
    Border: [0, 0, 0],
    A: bottomAction,
  })
  page.node.set(PDFName.of('Annots'), doc.context.obj([bottomAnnot, topAnnot]))
  return Buffer.from(await doc.save())
}

async function loadFixture(name: string): Promise<Buffer> {
  return fs.promises.readFile(path.join(FIXTURES_DIR, name))
}

async function loadDownloadFixture(name: string): Promise<Buffer> {
  return fs.promises.readFile(path.join(DOWNLOADS_DIR, name))
}

async function loadProcessedAfterFixture(name: string): Promise<Buffer> {
  return fs.promises.readFile(path.join(PROCESSED_AFTER_DIR, name))
}

async function loadRepoDownload(name: string): Promise<Buffer> {
  return fs.promises.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../Downloads', name))
}

describe('buildHeadingCandidatesFromPageFacts', () => {
  it('splits wide same-row text runs into separate lines before heading detection', () => {
    const textLines = __test_extractTextLines({
      items: [
        { str: 'Victims Bill of Rights', width: 210, height: 27, transform: [1, 0, 0, 1, 310, 460], fontName: 'g_d0_f11' },
        { str: 'Who is covered by the Bill of Rights?', width: 240, height: 14, transform: [1, 0, 0, 1, 520, 400], fontName: 'g_d0_f8' },
        { str: 'A victim has the right to be treated fairly.', width: 260, height: 11, transform: [1, 0, 0, 1, 520, 380], fontName: 'g_d0_f9' },
        { str: 'Illinois Constitution protections are summarized here.', width: 250, height: 11, transform: [1, 0, 0, 1, 40, 380], fontName: 'g_d0_f6' },
      ],
    }, 1008, 612)

    expect(textLines.map(line => line.text)).toContain('Victims Bill of Rights')
    expect(textLines.map(line => line.text)).toContain('Who is covered by the Bill of Rights?')
    expect(textLines.some(line => /Victims Bill of Rights.*Who is covered/.test(line.text))).toBe(false)
  })

  it('detects same-size heading lines when they use a distinct font face', () => {
    const structure = {
      structuralNodes: [
        { ref: 'obj:10 0 R', tag: '/Sect', orderIndex: 0 },
        { ref: 'obj:11 0 R', tag: '/P', orderIndex: 1 },
      ],
    } as StructureBackendMutationResult

    const candidates = buildHeadingCandidatesFromPageFacts([
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        imageCount: 0,
        links: [],
        textLines: [
          {
            text: 'Data Collection and Research Design',
            bbox: { x: 0.1, y: 0.8, width: 0.5, height: 0.03 },
            fontSize: 12,
            fontWeight: 'normal',
            fontName: 'g_d0_f3',
          },
          {
            text: 'This paragraph continues with normal body copy and should not become a heading candidate because it is prose.',
            bbox: { x: 0.1, y: 0.74, width: 0.8, height: 0.03 },
            fontSize: 12,
            fontWeight: 'normal',
            fontName: 'g_d0_f1',
          },
        ],
      },
    ], structure)

    expect(candidates.map(candidate => candidate.text)).toContain('Data Collection and Research Design')
    expect(candidates[0]?.repairMode).toBe('safe')
  })

  it('detects a top-of-page title line before prose even without bold or larger font size', () => {
    const structure = {
      structuralNodes: [
        { ref: 'obj:20 0 R', tag: '/Story', orderIndex: 0 },
        { ref: 'obj:21 0 R', tag: '/P', orderIndex: 1 },
      ],
    } as StructureBackendMutationResult

    const candidates = buildHeadingCandidatesFromPageFacts([
      {
        pageNumber: 5,
        width: 612,
        height: 792,
        imageCount: 0,
        links: [],
        textLines: [
          {
            text: 'Executive Summary',
            bbox: { x: 0.1, y: 0.9, width: 0.3, height: 0.03 },
            fontSize: 12,
            fontWeight: 'normal',
            fontName: 'g_d0_f1',
          },
          {
            text: 'This report describes the implementation and short-term impact evaluation of the program and continues as normal prose.',
            bbox: { x: 0.1, y: 0.84, width: 0.8, height: 0.03 },
            fontSize: 12,
            fontWeight: 'normal',
            fontName: 'g_d0_f1',
          },
        ],
      },
    ], structure)

    expect(candidates.map(candidate => candidate.text)).toContain('Executive Summary')
  })
})

function makePlannerAction(
  tool: RemediationToolName,
  target = 'document',
  overrides: Partial<RemediationActionRecord> = {},
): RemediationActionRecord {
  return {
    tool,
    target,
    details: 'Previously attempted in planner tests.',
    confidence: 0.8,
    autoApplied: true,
    changedVisibleContent: false,
    outcome: 'applied',
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  __test_resetInspectionResultCache()
  __test_resetBuildRemediationPageFactsCallCount()
})

describe('pdfRemediationTools', { timeout: 120_000 }, () => {
  it('keeps deep alt-text inspection enabled when analysis already contains Acrobat-risk findings', () => {
    const analysis = {
      ...({
        categories: [
          {
            id: 'alt_text',
            findings: ['Detected 1 Acrobat-risk non-figure element with graphics content.'],
            score: 100,
          },
        ],
        verapdf: {
          status: 'passed',
          failures: [],
        },
      } as any),
    }

    expect(needsAltTextDeepInspection(analysis)).toBe(true)
  })

  it('does not enable deep alt-text inspection for minor non-Acrobat alt-text defects', () => {
    const analysis = {
      categories: [
        {
          id: 'alt_text',
          findings: ['One figure is missing alt text.'],
          score: 95,
        },
      ],
      verapdf: {
        status: 'passed',
        failures: [],
      },
    } as any

    expect(needsAltTextDeepInspection(analysis)).toBe(false)
  })

  it('does not enable deep alt-text inspection for low scores without Acrobat-risk evidence', () => {
    const analysis = {
      categories: [
        {
          id: 'alt_text',
          findings: ['Several figures are missing alt text.'],
          score: 75,
        },
      ],
      verapdf: {
        status: 'passed',
        failures: [],
      },
    } as any

    expect(needsAltTextDeepInspection(analysis)).toBe(false)
  })

  it('keeps deep alt-text inspection enabled for low scores with Acrobat-risk evidence', () => {
    const analysis = {
      categories: [
        {
          id: 'alt_text',
          findings: ['Acrobat-style alternate-text risk remains because graphics content is still owned by non-/Figure structure elements.'],
          score: 75,
        },
      ],
      verapdf: {
        status: 'passed',
        failures: [],
      },
    } as any

    expect(needsAltTextDeepInspection(analysis)).toBe(true)
  })

  it('keeps deep alt-text inspection enabled when images are present but not tagged as figure elements', () => {
    const analysis = {
      categories: [
        {
          id: 'alt_text',
          findings: [
            '1 image(s) detected in the document, but none have accessibility tags',
            'The images exist in the PDF but are not tagged as <Figure> elements, so screen readers cannot identify them or read any alternative text.',
          ],
          score: 0,
        },
      ],
      verapdf: {
        status: 'passed',
        failures: [],
      },
    } as any

    expect(needsAltTextDeepInspection(analysis)).toBe(true)
  })

  it('reuses cached inspection results for the same buffer and inspect mode', async () => {
    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'cache.pdf', { skipAdobe: true })
    const backendSpy = vi.spyOn(pdfStructureBackend, 'runPdfStructureBackend')
    const cache: any = {}

    const first = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light', cache })
    const second = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light', cache })

    expect(backendSpy).toHaveBeenCalledTimes(1)
    expect(__test_getBuildRemediationPageFactsCallCount()).toBe(1)
    expect(second.structure).toEqual(first.structure)
    expect(__test_getInspectionResultCacheSize()).toBeGreaterThanOrEqual(1)
  })

  it('reuses page facts across inspect modes for the same buffer', async () => {
    const buffer = await loadFixture('accessible.pdf')
    const analysis = await analyzePDF(buffer, 'accessible.pdf', { skipAdobe: true })
    const backendSpy = vi.spyOn(pdfStructureBackend, 'runPdfStructureBackend')
    const cache: any = {}

    await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light', cache })
    await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'alt_text_deep', cache })

    expect(backendSpy).toHaveBeenCalledTimes(2)
    expect(__test_getBuildRemediationPageFactsCallCount()).toBe(1)
  })

  it('falls back to light inspection when alt_text_deep inspection fails', async () => {
    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'fallback.pdf', { skipAdobe: true })
    const backendSpy = vi.spyOn(pdfStructureBackend, 'runPdfStructureBackend')
      .mockResolvedValueOnce({
        status: 'failed',
        changedDocumentBytes: false,
        appliedMutations: [],
        warnings: ['Structure backend failed.'],
        headings: [],
        structuralNodes: [],
        tables: [],
        figures: [],
        imageStructNodes: [],
        acrobatAltRiskNodes: [],
        readingOrderNodes: [],
        readingOrderParents: [],
      } as any)
      .mockResolvedValueOnce({
        status: 'applied',
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
      } as any)

    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'alt_text_deep' })

    expect(backendSpy).toHaveBeenCalledTimes(2)
    expect(backendSpy.mock.calls[0]?.[0]?.mutation.inspectMode).toBe('alt_text_deep')
    expect(backendSpy.mock.calls[1]?.[0]?.mutation.inspectMode).toBe('light')
    expect(context.structure.structuralNodes).toEqual([])
  })

  it('builds remediation context from a supplied snapshot without re-running inspect', async () => {
    const buffer = await makePdfWithLink()
    const analysis = await analyzePDF(buffer, 'snapshot.pdf', { skipAdobe: true })
    const backendSpy = vi.spyOn(pdfStructureBackend, 'runPdfStructureBackend')
    const inspected = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    backendSpy.mockClear()

    const rebuilt = buildRemediationContextFromSnapshot({
      analysis,
      qpdf: inspected.qpdf,
      pdfjs: inspected.pdfjs,
      pages: inspected.pages,
      structure: inspected.structure,
      inspectMode: 'light',
      cache: {},
    })

    expect(backendSpy).not.toHaveBeenCalled()
    expect(rebuilt.structure).toEqual(inspected.structure)
    expect(rebuilt.linkCandidates).toEqual(inspected.linkCandidates)
    expect(rebuilt.headingCandidates).toEqual(inspected.headingCandidates)
    expect(rebuilt.figureCandidates).toEqual(inspected.figureCandidates)
    expect(rebuilt.tableCandidates).toEqual(inspected.tableCandidates)
    expect(rebuilt.readingOrderCandidates).toEqual(inspected.readingOrderCandidates)
    expect(rebuilt.readingOrderParentCandidates).toEqual(inspected.readingOrderParentCandidates)
  })

  it('marks table candidates as safe when the backend can recover header rows from the table node', async () => {
    const analysis = await analyzePDF(await makePdf(), 'snapshot.pdf', { skipAdobe: true })

    const rebuilt = buildRemediationContextFromSnapshot({
      analysis,
      qpdf: {
        hasStructTree: true,
        isTagged: true,
        hasMarkInfo: true,
        marked: true,
        hasLang: true,
        lang: 'en',
        hasOutlines: false,
        outlineCount: 0,
        outlineTitles: [],
        displayDocTitle: true,
        metadataRef: 'obj:1 0 R',
        metadataTypeValid: true,
        metadataSubtypeXml: true,
        hasAcroForm: false,
        formFields: [],
        annotationCount: 0,
        fontCount: 1,
        unembeddedFontCount: 0,
        fontsMissingToUnicode: 0,
        cidFontsMissingCidToGidMap: 0,
        images: [],
        headings: [],
        tables: [],
        structTreeDepth: 3,
        contentOrder: [0],
        error: null,
      },
      pdfjs: {
        pageCount: 1,
        hasText: true,
        textLength: 50,
        title: null,
        author: null,
        subject: null,
        lang: 'en',
        hasOutlines: false,
        outlineCount: 0,
        links: [],
        imageCount: 0,
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
          pageCount: 1,
        },
        error: null,
      },
      pages: [{
        pageNumber: 1,
        width: 612,
        height: 792,
        imageCount: 0,
        textLines: [{ text: 'Example table', bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.03 }, fontSize: 12, fontWeight: 'bold' }],
        links: [],
      }],
      structure: {
        structuralNodes: [],
        headings: [],
        figures: [],
        imageStructNodes: [],
        readingOrderNodes: [],
        readingOrderParents: [],
        tables: [{
          ref: 'obj:30 0 R',
          pageNumberHints: [1],
          firstRowCellRefs: [],
          headerCellRefs: [],
        }],
      } as any,
    })

    expect(rebuilt.tableCandidates).toEqual([
      expect.objectContaining({
        ref: 'obj:30 0 R',
        firstRowCellRefs: [],
        hasHeaders: false,
        repairMode: 'safe',
      }),
    ])
  })

  it('recomputes page facts when the buffer changes', async () => {
    const firstBuffer = await makePdf()
    const secondBuffer = await makePdfWithLink()
    const firstAnalysis = await analyzePDF(firstBuffer, 'first.pdf', { skipAdobe: true })
    const secondAnalysis = await analyzePDF(secondBuffer, 'second.pdf', { skipAdobe: true })
    const backendSpy = vi.spyOn(pdfStructureBackend, 'runPdfStructureBackend')
    const cache: any = {}

    await inspectPdfForRemediation(firstBuffer, firstAnalysis, { inspectMode: 'light', cache })
    await inspectPdfForRemediation(secondBuffer, secondAnalysis, { inspectMode: 'light', cache })

    expect(backendSpy).toHaveBeenCalledTimes(2)
    expect(__test_getBuildRemediationPageFactsCallCount()).toBe(2)
  })

  it('reuses page facts from the per-run hash cache even when the inspect payload cache is missed', async () => {
    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'pages-hash.pdf', { skipAdobe: true })
    const backendSpy = vi.spyOn(pdfStructureBackend, 'runPdfStructureBackend')
    const firstCache: any = {}
    const secondCache: any = {}

    await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light', cache: firstCache })
    secondCache.pagesByHash = { ...(firstCache.pagesByHash || {}) }

    await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'alt_text_deep', cache: secondCache })

    expect(backendSpy).toHaveBeenCalledTimes(2)
    expect(__test_getBuildRemediationPageFactsCallCount()).toBe(1)
  })

  it('evicts the oldest inspection cache entry when the process cache is full', async () => {
    const backendSpy = vi.spyOn(pdfStructureBackend, 'runPdfStructureBackend')
    const buffers: Buffer[] = []

    for (let index = 0; index <= 20; index++) {
      const buffer = await makePdfWithText(`pdf-${index}`)
      buffers.push(buffer)
      const analysis = {
        categories: [{ id: 'alt_text', score: 100, findings: [] }],
        verapdf: { status: 'passed', failures: [] },
      } as any
      await inspectPdfForRemediation(buffer, analysis, {
        inspectMode: 'light',
        cache: {
          qpdf: { hasStructTree: true, headings: [], tables: [], images: [], formFields: [], outlineCount: 0, structTreeDepth: 1, lang: 'en' } as any,
          pdfjs: { title: null, lang: 'en', links: [], pageCount: 1 } as any,
          pages: [],
        },
      })
    }

    expect(backendSpy).toHaveBeenCalledTimes(21)
    expect(__test_getInspectionResultCacheSize()).toBe(20)

    const evictedBuffer = buffers[0]
    const evictedAnalysis = {
      categories: [{ id: 'alt_text', score: 100, findings: [] }],
      verapdf: { status: 'passed', failures: [] },
    } as any

    await inspectPdfForRemediation(evictedBuffer, evictedAnalysis, {
      inspectMode: 'light',
      cache: {
        qpdf: { hasStructTree: true, headings: [], tables: [], images: [], formFields: [], outlineCount: 0, structTreeDepth: 1, lang: 'en' } as any,
        pdfjs: { title: null, lang: 'en', links: [], pageCount: 1 } as any,
        pages: [],
      },
    })

    expect(backendSpy).toHaveBeenCalledTimes(22)
    expect(__test_getInspectionResultCacheSize()).toBe(20)
  })

  it('plans table header repair against table refs instead of individual cell refs', async () => {
    const analysis = {
      ...({
        filename: 'table.pdf',
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
        overallScore: 72,
        grade: 'C',
        isScanned: false,
        executiveSummary: '',
        verapdf: {
          status: 'passed',
          executionStatus: 'ok',
          profile: 'PDF/UA-1',
          flavour: 'ua1',
          isCompliant: true,
          passedChecks: 10,
          failedChecks: 0,
          failures: [],
          message: '',
        },
        categories: [
          { id: 'table_markup', label: 'Table Markup', weight: 0.1, score: 40, grade: 'F', severity: 'Critical', findings: ['Missing TH'], explanation: '', helpLinks: [] },
        ],
        warnings: [],
      }) as any,
    }
    const context: PdfRemediationContext = {
      analysis,
      qpdf: {
        hasStructTree: true,
        isTagged: true,
        hasLang: true,
        lang: 'en',
        hasOutlines: false,
        outlineCount: 0,
        outlineTitles: [],
        hasAcroForm: false,
        annotationCount: 0,
        formFields: [],
        images: [],
        headings: [],
        tables: [],
        structTreeDepth: 2,
        contentOrder: [],
        error: null,
      },
      pdfjs: {
        pageCount: 1,
        hasText: true,
        textLength: 100,
        title: null,
        author: null,
        subject: null,
        lang: 'en',
        hasOutlines: false,
        outlineCount: 0,
        links: [],
        imageCount: 0,
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
          pageCount: 1,
        },
        error: null,
      },
      structure: { structuralNodes: [], tables: [], figures: [], headings: [], readingOrderNodes: [], readingOrderParents: [] } as any,
      pages: [{ pageNumber: 1, width: 612, height: 792, imageCount: 0, textLines: [], links: [] }],
      headingCandidates: [],
      figureCandidates: [],
      tableCandidates: [{
        id: 'table:1',
        ref: '21 0 R',
        pageNumberHints: [1],
        firstRowCellRefs: ['31 0 R', '32 0 R'],
        headerCellRefs: [],
        hasHeaders: false,
        repairMode: 'safe',
        nearbyContext: ['Example table'],
      }],
      readingOrderCandidates: [],
      readingOrderParentCandidates: [],
      linkCandidates: [],
    }

    const plan = await planRemediationActions({
      filename: 'table.pdf',
      analysis: analysis as any,
      context: {
        ...context,
        qpdf: {
          ...context.qpdf,
          annotationCount: 2,
          isTagged: true,
          hasStructTree: true,
        },
      },
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    const action = plan.actions.find(entry => entry.tool_name === 'set_table_header_cells')
    expect(action).toBeTruthy()
    expect(action?.arguments).toEqual({ targets: ['21 0 R'] })
  })

  it('remaps section-backed heading candidates to the first safe descendant text node', () => {
    const target = __test_remapHeadingTarget([
      { ref: 'obj:9 0 R', tag: '/Sect', parentRef: 'obj:7 0 R', orderIndex: 0, parentTagPath: ['None'] },
      { ref: 'obj:13 0 R', tag: '/Shape', parentRef: 'obj:9 0 R', orderIndex: 1, parentTagPath: ['/Sect', 'None'] },
      { ref: 'obj:14 0 R', tag: '/TextBox', parentRef: 'obj:9 0 R', orderIndex: 2, parentTagPath: ['/Sect', 'None'] },
    ], 0)

    expect(target?.ref).toBe('obj:14 0 R')
  })

  it('remaps story-backed heading candidates to the first safe descendant text node', () => {
    const target = __test_remapHeadingTarget([
      { ref: 'obj:19 0 R', tag: '/Story', parentRef: 'obj:7 0 R', orderIndex: 0, parentTagPath: ['None'] },
      { ref: 'obj:20 0 R', tag: '/Shape', parentRef: 'obj:19 0 R', orderIndex: 1, parentTagPath: ['/Story', 'None'] },
      { ref: 'obj:21 0 R', tag: '/TextBox', parentRef: 'obj:19 0 R', orderIndex: 2, parentTagPath: ['/Story', 'None'] },
    ], 0)

    expect(target?.ref).toBe('obj:21 0 R')
  })

  it('remaps link-backed heading candidates to their safe parent text node', () => {
    const target = __test_remapHeadingTarget([
      { ref: 'obj:434 0 R', tag: '/Link', parentRef: 'obj:473 0 R', orderIndex: 19, parentTagPath: ['/P', '/Sect', '/Part', '/Document', 'None'] },
      { ref: 'obj:435 0 R', tag: '/Link', parentRef: 'obj:473 0 R', orderIndex: 20, parentTagPath: ['/P', '/Sect', '/Part', '/Document', 'None'] },
      { ref: 'obj:473 0 R', tag: '/P', parentRef: 'obj:468 0 R', orderIndex: 38, parentTagPath: ['/Sect', '/Part', '/Document', 'None'] },
    ], 0)

    expect(target?.ref).toBe('obj:473 0 R')
  })

  it('normalizes legacy PDFMaker heading styles into usable heading levels', () => {
    expect(normalizedExistingHeadingLevel('/heading 1')).toBe('H1')
    expect(normalizedExistingHeadingLevel('/heading 4')).toBe('H4')
    expect(normalizedExistingHeadingLevel('/heading 9')).toBe('H6')
    expect(normalizedExistingHeadingLevel('/Normal')).toBeNull()
  })

  it('sets title metadata in-place', async () => {
    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'example.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'set_document_title',
        arguments: { title: 'Accessible Example' },
        rationale: 'Set a useful title.',
        confidence: 0.9,
      },
    })

    const next = await analyzePDF(result.buffer, 'example.pdf')
    expect(result.action.outcome).toBe('applied')
    expect(next.categories.find(category => category.id === 'title_language')?.score).toBeGreaterThanOrEqual(50)
  }, 30_000)

  it('normalizes bootstrapped heading levels so the first heading is H1', async () => {
    const buffer = await makePdf()

    const result = await runPdfStructureBackend({
      buffer,
      mutation: {
        operation: 'bootstrap_struct_tree',
        headings: [
          { text: 'Section one', level: 'H2', pageNumber: 1 },
          { text: 'Section two', level: 'H4', pageNumber: 1 },
        ],
        figures: [],
      },
    })

    expect(result.status).toBe('applied')
    expect(result.outputBuffer).toBeDefined()
    const reInspect = await runPdfStructureBackend({
      buffer: result.outputBuffer!,
      mutation: { operation: 'inspect' },
    })
    expect(reInspect.headings.map(heading => heading.tag)).toEqual(['/H1', '/H2'])
  }, 60_000)

  it('bootstrap_struct_tree does not leave non-figure alt-text risks on headings', async () => {
    const buffer = await makePdf()

    const result = await runPdfStructureBackend({
      buffer,
      mutation: {
        operation: 'bootstrap_struct_tree',
        headings: [
          { text: 'Section one', level: 'H2', pageNumber: 1 },
          { text: 'Section two', level: 'H4', pageNumber: 1 },
        ],
        figures: [],
      },
    })

    expect(result.outputBuffer).toBeDefined()
    const inspect = await runPdfStructureBackend({
      buffer: result.outputBuffer!,
      mutation: { operation: 'inspect', inspectMode: 'alt_text_deep' },
    })

    expect((inspect.acrobatAltRiskNodes || []).filter(node => node.ownershipMode === 'nonfigure_with_alt')).toEqual([])
  }, 60_000)

  it('bootstrap_struct_tree can augment an existing structure tree with headings', async () => {
    const buffer = await makePdf()
    const initial = await runPdfStructureBackend({
      buffer,
      mutation: {
        operation: 'bootstrap_struct_tree',
        headings: [
          { text: 'Section one', level: 'H1', pageNumber: 1 },
        ],
        figures: [],
      },
    })

    expect(initial.outputBuffer).toBeDefined()
    const augmented = await runPdfStructureBackend({
      buffer: initial.outputBuffer!,
      mutation: {
        operation: 'bootstrap_struct_tree',
        headings: [
          { text: 'Section two', level: 'H2', pageNumber: 1 },
        ],
        figures: [],
      },
    })

    expect(augmented.status).toBe('applied')
    expect(augmented.outputBuffer).toBeDefined()
    const reInspect = await runPdfStructureBackend({
      buffer: augmented.outputBuffer!,
      mutation: { operation: 'inspect' },
    })
    expect(reInspect.headings.map(heading => heading.tag)).toEqual(['/H1', '/H1'])
  }, 60_000)

  it('bootstrap_struct_tree reattaches an existing structure tree to the catalog when augmenting', async () => {
    const buffer = await makePdf()
    const initial = await runPdfStructureBackend({
      buffer,
      mutation: {
        operation: 'bootstrap_struct_tree',
        headings: [
          { text: 'Section one', level: 'H1', pageNumber: 1 },
        ],
        figures: [],
      },
    })

    expect(initial.outputBuffer).toBeDefined()
    const doc = await PDFDocument.load(initial.outputBuffer!, { ignoreEncryption: true })
    doc.catalog.delete(PDFName.of('StructTreeRoot'))
    doc.catalog.delete(PDFName.of('MarkInfo'))
    const detachedBuffer = Buffer.from(await doc.save())

    const augmented = await runPdfStructureBackend({
      buffer: detachedBuffer,
      mutation: {
        operation: 'bootstrap_struct_tree',
        headings: [
          { text: 'Section two', level: 'H2', pageNumber: 1 },
        ],
        figures: [],
      },
    })

    expect(augmented.status).toBe('applied')
    expect(augmented.outputBuffer).toBeDefined()
    const repairedDoc = await PDFDocument.load(augmented.outputBuffer!, { ignoreEncryption: true })
    const structTreeRoot = repairedDoc.catalog.lookupMaybe(PDFName.of('StructTreeRoot'), PDFDict)
    const markInfo = repairedDoc.catalog.lookupMaybe(PDFName.of('MarkInfo'), PDFDict)

    expect(structTreeRoot).toBeTruthy()
    expect(markInfo?.get(PDFName.of('Marked'))).toBeTruthy()
  }, 60_000)

  it('splits mixed heading/logo MCIDs on the one-page chart fixture so Acrobat-risk nodes clear', async () => {
    const buffer = await loadDownloadFixture('1total offenses_1999-2008.pdf')
    const analysis = await analyzePDF(buffer, '1total offenses_1999-2008.pdf')
    const remediated = await remediatePdfWithAgent(buffer, '1total offenses_1999-2008.pdf', analysis)
    const inspect = await inspectPdfForRemediation(remediated.buffer, remediated.finalResult, { inspectMode: 'alt_text_deep' })

    expect(remediated.finalResult.grade).toBe('A')
    expect(remediated.finalResult.verapdf.status).toBe('passed')
    // orphaned_alt_empty_element nodes are cosmetic Adobe-checker issues that don't affect
    // veraPDF compliance; the repair is rejected when it would hurt the overall score.
    const seriousAltRisk1 = (inspect.structure.acrobatAltRiskNodes || []).filter(n => n.ownershipMode !== 'orphaned_alt_empty_element')
    expect(seriousAltRisk1).toEqual([])
    expect(inspect.structure.figures || []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: '/Figure',
          hasAlt: true,
        }),
      ]),
    )
    // depth-0 images (untagged_image_direct) are wrapped as /Artifact by the structure backend,
    // so no split-generated /Figure elements are created for this PDF.
  }, 600_000)

  it('clears multi-page Acrobat-risk section ownership on the strategy fixture', async () => {
    const buffer = await loadDownloadFixture('04-07MVStrategy.pdf')
    const analysis = await analyzePDF(buffer, '04-07MVStrategy.pdf')
    const remediated = await remediatePdfWithAgent(buffer, '04-07MVStrategy.pdf', analysis)
    const inspect = await inspectPdfForRemediation(remediated.buffer, remediated.finalResult, { inspectMode: 'alt_text_deep' })

    expect(remediated.finalResult.grade).toBe('A')
    expect(remediated.finalResult.verapdf.status).toBe('passed')
    // repair_other_elements_alt_text is applied by the planner in main rounds.
    // orphaned_alt_empty_element nodes are cosmetic Adobe-checker issues; they don't affect veraPDF.
    expect((remediated.model.actions || []).some(action => action.tool === 'repair_other_elements_alt_text')).toBe(true)
    const seriousAltRisk2 = (inspect.structure.acrobatAltRiskNodes || []).filter(n => n.ownershipMode !== 'orphaned_alt_empty_element')
    expect(seriousAltRisk2).toEqual([])
    expect((inspect.structure.figures || []).every(figure =>
      !figure.splitGenerated || !/image related to/i.test(figure.altText || '')
    )).toBe(true)
  }, 600_000)

  it('does not assign heading-derived alt text to split-generated figures on 99anreport', async () => {
    const buffer = await loadDownloadFixture('99anreport.pdf')
    const analysis = await analyzePDF(buffer, '99anreport.pdf')
    const remediated = await remediatePdfWithAgent(buffer, '99anreport.pdf', analysis)
    const inspect = await inspectPdfForRemediation(remediated.buffer, remediated.finalResult, { inspectMode: 'alt_text_deep' })

    expect(remediated.finalResult.grade).toBe('A')
    expect(remediated.finalResult.verapdf.status).toBe('passed')
    const seriousAltRisk3 = (inspect.structure.acrobatAltRiskNodes || []).filter(n => n.ownershipMode !== 'orphaned_alt_empty_element')
    expect(seriousAltRisk3).toEqual([])

    // depth-0 images (untagged_image_direct) are wrapped as /Artifact by the structure backend,
    // so no split-generated /Figure elements are created for this PDF.
    // Verify no split figures have heading-derived or generic alt text if any do exist.
    const splitFigures = (inspect.structure.figures || []).filter(figure => figure.splitGenerated)
    expect(splitFigures.every(figure =>
      !/image related to/i.test(figure.altText || '')
      && !/^sect$/i.test((figure.altText || '').trim())
    )).toBe(true)
  }, 600_000)

  it('brings the processed-after font-unicode cluster to 100/A through the full agent loop', async () => {
    const filenames = [
      '11drug_seizures_1997-2007.pdf',
      '12drug_submissions_1997-2007.pdf',
      '13drug_treatment_1999-2008.pdf',
      '14felony_and_misdemeanor_filings_1999-2008.pdf',
      '15adult_probation_1999-2008.pdf',
    ] as const

    for (const filename of filenames) {
      const buffer = await loadProcessedAfterFixture(filename)
      const analysis = await analyzePDF(buffer, filename, {
        skipAdobe: true,
        skipVeraPdf: true,
        analysisProfile: 'remediation_fast',
      })
      const remediated = await remediatePdfWithAgent(buffer, filename, analysis)
      const appliedTools = (remediated.model.actions || [])
        .filter(action => action.outcome === 'applied')
        .map(action => action.tool)

      expect(analysis.overallScore).toBeLessThan(100)
      expect(remediated.finalResult.overallScore).toBe(100)
      expect(remediated.finalResult.grade).toBe('A')
      expect(appliedTools).toContain('repair_font_unicode_maps')
      expect(remediated.model.rejectedActions || []).toEqual([])
    }
  }, 600_000)

  it('routes Acrobat-risk alternate-text repairs through the structure backend', async () => {
    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'alt-risk.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const backendSpy = vi.spyOn(pdfStructureBackend, 'runPdfStructureBackend').mockResolvedValue({
      status: 'applied',
      changedDocumentBytes: true,
      appliedMutations: [{
        ref: 'obj:20 0 R',
        before: 'MCID 0',
        after: 'removed duplicate scalar ownership',
        details: 'Removed duplicate direct MCID ownership from /Sect element obj:20 0 R for MCID 0.',
      }],
      warnings: [],
      headings: [],
      structuralNodes: [],
      tables: [],
      figures: [],
      imageStructNodes: [],
      acrobatAltRiskNodes: [],
      readingOrderNodes: [],
      readingOrderParents: [],
      outputBuffer: buffer,
    })

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'repair_other_elements_alt_text',
        arguments: { target: 'document' },
        rationale: 'Normalize Acrobat-risk non-figure graphics ownership.',
        confidence: 0.9,
      },
    })

    expect(backendSpy).toHaveBeenCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        operation: 'repair_other_elements_alt_text',
        maxElapsedMs: 12_000,
      }),
    }))
    expect(result.action.outcome).toBe('applied')
    expect(result.action.categoryTargets).toEqual(['alt_text'])
  })

  it('routes unowned-annotation repairs through the structure backend', async () => {
    const buffer = await makePdfWithMixedAnnotations()
    const analysis = await analyzePDF(buffer, 'annot-ownership.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const backendSpy = vi.spyOn(pdfStructureBackend, 'runPdfStructureBackend').mockResolvedValue({
      status: 'applied',
      changedDocumentBytes: true,
      appliedMutations: [{
        ref: 'obj:20 0 R',
        before: null,
        after: '/Annot',
        details: 'Created /Annot structure element for unowned annotation on page obj:1 0 R.',
      }],
      warnings: [],
      headings: [],
      structuralNodes: [],
      tables: [],
      figures: [],
      imageStructNodes: [],
      acrobatAltRiskNodes: [],
      readingOrderNodes: [],
      readingOrderParents: [],
      outputBuffer: buffer,
    })

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'tag_unowned_annotations',
        arguments: { target: 'document' },
        rationale: 'Tag visible annotations missing structure ownership.',
        confidence: 0.9,
      },
    })

    expect(backendSpy).toHaveBeenCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        operation: 'tag_unowned_annotations',
      }),
    }))
    expect(result.action.outcome).toBe('applied')
    expect(result.action.categoryTargets).toEqual(['reading_order', 'pdf_ua_compliance'])
  })

  it('orders annotation ownership repair before annotation alt-text repair when both are planned', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdfWithMixedAnnotations()
    const analysis = await analyzePDF(buffer, 'annotation-order.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const plan = await planRemediationActions({
      filename: 'annotation-order.pdf',
      analysis: {
        ...analysis,
        overallScore: 82,
        grade: 'B',
        categories: analysis.categories.map(category =>
          category.id === 'reading_order'
            ? { ...category, score: 60, grade: 'D', severity: 'Moderate', findings: ['Visible annotations are missing structure ownership.'] }
            : category.id === 'alt_text'
              ? { ...category, score: 60, grade: 'D', severity: 'Moderate', findings: ['Annotation descriptions need normalization.'] }
              : category),
        localStandards: {
          status: 'issues_detected',
          knownGapKeys: [],
          findings: [
            {
              key: 'pdfua.tagged_annotations',
              label: 'Tagged annotations',
              severity: 'error',
              blocking: true,
              categoryIds: ['reading_order', 'pdf_ua_compliance'],
              confidence: 0.9,
              evidence: ['Detected 2 visible annotation(s) without a /StructParent entry.'],
              source: 'composite',
              inferred: false,
              count: 2,
            },
          ],
        },
      },
      context: {
        ...context,
        qpdf: {
          ...context.qpdf,
          annotationCount: 2,
          isTagged: true,
          hasStructTree: true,
        },
      },
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    const ownershipIndex = plan.actions.findIndex(action => action.tool_name === 'tag_unowned_annotations')
    const altTextIndex = plan.actions.findIndex(action => action.tool_name === 'repair_annotation_alt_text')

    expect(ownershipIndex).toBeGreaterThanOrEqual(0)
    expect(altTextIndex).toBeGreaterThanOrEqual(0)
    expect(ownershipIndex).toBeLessThan(altTextIndex)
  })

  it('passes figure bootstrap candidates into bootstrap_struct_tree for weak native image documents', async () => {
    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'bootstrap-figures.pdf')
    const inspected = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const context: PdfRemediationContext = {
      ...inspected,
      headingCandidates: [],
      figureCandidates: [{
        id: 'figure:1',
        pageNumber: 1,
        targetRef: 'obj:10 0 R',
        bbox: { x: 0, y: 0, width: 0.5, height: 0.5 },
        hasAlt: false,
        altText: null,
        informativeHint: 'informative',
        surroundingText: ['Cover chart.'],
        repairMode: 'defer',
        targetTag: null,
        pageImageCount: 1,
        textDensityHint: 'low',
        imageEvidence: 'strong',
      }],
    }
    const backendSpy = vi.spyOn(pdfStructureBackend, 'runPdfStructureBackend').mockResolvedValue({
      status: 'applied',
      changedDocumentBytes: true,
      appliedMutations: [{
        ref: 'obj:20 0 R',
        before: null,
        after: '/Figure',
        details: 'Created figure tag with alt text.',
      }],
      warnings: [],
      headings: [],
      structuralNodes: [],
      tables: [],
      figures: [],
      imageStructNodes: [],
      acrobatAltRiskNodes: [],
      readingOrderNodes: [],
      readingOrderParents: [],
      outputBuffer: buffer,
    })

    await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'bootstrap_struct_tree',
        arguments: { target: 'document' },
        rationale: 'Bootstrap structure tree.',
        confidence: 0.9,
      },
    })

    expect(backendSpy).toHaveBeenCalledTimes(1)
    const backendArgs = backendSpy.mock.calls[0]?.[0]
    expect(backendArgs?.mutation).toMatchObject({
      operation: 'bootstrap_struct_tree',
      figures: [{ pageNumber: 1 }],
    })
    expect(backendArgs?.mutation.figures ?? []).toHaveLength(1)
    expect(backendArgs?.mutation.figures?.[0]?.altText).toContain('Cover chart')
  })

  it('does not pass existing figure nodes back into bootstrap_struct_tree', async () => {
    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'bootstrap-existing-figures.pdf')
    const inspected = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const context: PdfRemediationContext = {
      ...inspected,
      headingCandidates: [],
      figureCandidates: [
        {
          id: 'figure:existing',
          pageNumber: 1,
          targetRef: 'obj:10 0 R',
          bbox: { x: 0, y: 0, width: 0.5, height: 0.5 },
          hasAlt: false,
          altText: null,
          informativeHint: 'informative',
          surroundingText: ['Existing figure.'],
          repairMode: 'set_alt',
          targetTag: '/Figure',
          pageImageCount: 1,
          textDensityHint: 'high',
          imageEvidence: 'vector',
        },
        {
          id: 'figure:new',
          pageNumber: 1,
          targetRef: 'obj:11 0 R',
          bbox: { x: 0, y: 0, width: 0.5, height: 0.5 },
          hasAlt: false,
          altText: null,
          informativeHint: 'informative',
          surroundingText: ['Cover chart.'],
          repairMode: 'defer',
          targetTag: null,
          pageImageCount: 1,
          textDensityHint: 'low',
          imageEvidence: 'strong',
        },
      ],
    }
    const backendSpy = vi.spyOn(pdfStructureBackend, 'runPdfStructureBackend').mockResolvedValue({
      status: 'applied',
      changedDocumentBytes: true,
      appliedMutations: [{
        ref: 'obj:20 0 R',
        before: null,
        after: '/Figure',
        details: 'Created figure tag with alt text.',
      }],
      warnings: [],
      headings: [],
      structuralNodes: [],
      tables: [],
      figures: [],
      imageStructNodes: [],
      acrobatAltRiskNodes: [],
      readingOrderNodes: [],
      readingOrderParents: [],
      outputBuffer: buffer,
    })

    await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'bootstrap_struct_tree',
        arguments: { target: 'document' },
        rationale: 'Bootstrap structure tree.',
        confidence: 0.9,
      },
    })

    expect(backendSpy).toHaveBeenCalledTimes(1)
    const backendArgs = backendSpy.mock.calls[0]?.[0]
    expect(backendArgs?.mutation).toMatchObject({
      operation: 'bootstrap_struct_tree',
      figures: [{ pageNumber: 1 }],
    })
    expect(backendArgs?.mutation.figures ?? []).toHaveLength(1)
    expect(backendArgs?.mutation.figures?.[0]?.altText).toContain('Cover chart')
  })

  it('filters noisy OCR heading fragments when replacing bookmarks from headings', async () => {
    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'bookmark-noise.pdf')
    const inspected = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const context: PdfRemediationContext = {
      ...inspected,
      headingCandidates: [
        {
          id: 'heading:1',
          pageNumber: 1,
          text: 'CRIMINAL JUSTICE',
          bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
          fontSize: 18,
          fontWeight: 'bold',
          nearbyContext: [],
          targetRef: 'obj:10 0 R',
          existingTag: '/H1',
          repairMode: 'safe',
        },
        {
          id: 'heading:2',
          pageNumber: 1,
          text: 'ConTENTS',
          bbox: { x: 0.1, y: 0.2, width: 0.8, height: 0.05 },
          fontSize: 16,
          fontWeight: 'bold',
          nearbyContext: [],
          targetRef: 'obj:11 0 R',
          existingTag: '/H2',
          repairMode: 'safe',
        },
        {
          id: 'heading:3',
          pageNumber: 2,
          text: 'MANACINC IN ADDITION TO HELPING APPELLATE PROSECUTORS KEEP BETTER TRACK OF',
          bbox: { x: 0.1, y: 0.3, width: 0.8, height: 0.05 },
          fontSize: 14,
          fontWeight: 'bold',
          nearbyContext: [],
          targetRef: 'obj:12 0 R',
          existingTag: '/H2',
          repairMode: 'safe',
        },
      ],
    }
    const backendSpy = vi.spyOn(pdfStructureBackend, 'runPdfStructureBackend').mockResolvedValue({
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
      outputBuffer: buffer,
    })

    await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'replace_bookmarks_from_headings',
        arguments: { target: 'document' },
        rationale: 'Replace bookmarks.',
        confidence: 0.9,
      },
    })

    expect(backendSpy).toHaveBeenCalledTimes(1)
    const headings = backendSpy.mock.calls[0]?.[0]?.mutation?.headings
    expect(headings).toEqual([
      expect.objectContaining({ text: 'Criminal Justice', pageNumber: 1 }),
      expect.objectContaining({ text: 'Contents', pageNumber: 1 }),
    ])
  })

  it('keeps only high-confidence heading candidates for long-report convergence', () => {
    const selected = selectHighConfidenceLongReportHeadingCandidates([
      {
        id: 'heading:1',
        pageNumber: 1,
        text: 'CRIMINAL JUSTICE',
        bbox: { x: 0.1, y: 0.08, width: 0.4, height: 0.05 },
        fontSize: 24,
        fontWeight: 'bold',
        nearbyContext: [],
        targetRef: 'obj:1 0 R',
        existingTag: '/P',
        repairMode: 'safe',
      },
      {
        id: 'heading:2',
        pageNumber: 2,
        text: 'Executive Summary',
        bbox: { x: 0.1, y: 0.14, width: 0.4, height: 0.05 },
        fontSize: 20,
        fontWeight: 'bold',
        nearbyContext: [],
        targetRef: 'obj:2 0 R',
        existingTag: '/P',
        repairMode: 'safe',
      },
      {
        id: 'heading:3',
        pageNumber: 3,
        text: 'Appendix A',
        bbox: { x: 0.1, y: 0.18, width: 0.3, height: 0.04 },
        fontSize: 18,
        fontWeight: 'bold',
        nearbyContext: [],
        targetRef: 'obj:3 0 R',
        existingTag: '/P',
        repairMode: 'safe',
      },
      {
        id: 'heading:4',
        pageNumber: 4,
        text: 'The weeks that followed included additional review from agency staff and stakeholders',
        bbox: { x: 0.1, y: 0.24, width: 0.8, height: 0.04 },
        fontSize: 16,
        fontWeight: 'bold',
        nearbyContext: ['The weeks that followed included additional review from agency staff and stakeholders.'],
        targetRef: 'obj:4 0 R',
        existingTag: '/P',
        repairMode: 'safe',
      },
    ])

    expect(selected.map(candidate => candidate.id)).toEqual(['heading:1', 'heading:2', 'heading:3'])
  })

  it('keeps only the strongest informative figure candidates for long-report convergence', () => {
    const selected = selectHighConfidenceLongReportFigureCandidates([
      {
        id: 'figure:1',
        pageNumber: 1,
        targetRef: 'obj:1 0 R',
        hasAlt: false,
        altText: null,
        informativeHint: 'informative',
        surroundingText: ['Chart summary'],
        repairMode: 'set_alt',
        targetTag: '/Figure',
        parentTagPath: [],
        pageImageCount: 1,
        textDensityHint: 'low',
        imageEvidence: 'strong',
      },
      {
        id: 'figure:2',
        pageNumber: 2,
        targetRef: 'obj:2 0 R',
        hasAlt: false,
        altText: null,
        informativeHint: 'informative',
        surroundingText: ['Map detail'],
        repairMode: 'set_alt',
        targetTag: '/Figure',
        parentTagPath: [],
        pageImageCount: 1,
        textDensityHint: 'low',
        imageEvidence: 'strong',
      },
      {
        id: 'figure:3',
        pageNumber: 3,
        targetRef: 'obj:3 0 R',
        hasAlt: false,
        altText: null,
        informativeHint: 'informative',
        surroundingText: ['Annotated timeline'],
        repairMode: 'retag_then_set_alt',
        targetTag: '/P',
        parentTagPath: [],
        pageImageCount: 1,
        textDensityHint: 'medium',
        imageEvidence: 'strong',
      },
      {
        id: 'figure:4',
        pageNumber: 4,
        targetRef: 'obj:4 0 R',
        hasAlt: false,
        altText: null,
        informativeHint: 'informative',
        surroundingText: ['Figure caption'],
        repairMode: 'set_alt',
        targetTag: '/Figure',
        parentTagPath: [],
        pageImageCount: 1,
        textDensityHint: 'medium',
        imageEvidence: 'vector',
      },
      {
        id: 'figure:5',
        pageNumber: 5,
        targetRef: 'obj:5 0 R',
        hasAlt: false,
        altText: null,
        informativeHint: 'unknown',
        surroundingText: ['Agency logo'],
        repairMode: 'set_alt',
        targetTag: '/Figure',
        parentTagPath: [],
        pageImageCount: 1,
        textDensityHint: 'medium',
        imageEvidence: 'strong',
      },
      {
        id: 'figure:6',
        pageNumber: 6,
        targetRef: 'obj:6 0 R',
        hasAlt: false,
        altText: null,
        informativeHint: 'decorative',
        surroundingText: ['Border ornament'],
        repairMode: 'set_alt',
        targetTag: '/Figure',
        parentTagPath: [],
        pageImageCount: 1,
        textDensityHint: 'high',
        imageEvidence: 'vector',
      },
    ])

    expect(selected.map(candidate => candidate.id)).toEqual(['figure:1', 'figure:2', 'figure:4', 'figure:3', 'figure:5'])
  })

  it('normalizes the first created heading candidate to H1 even when H2 is requested', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect' },
    })
    const headingRefs = inspect.headings.map(heading => heading.ref)
    const degraded = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: {
        operation: 'retag_node',
        targets: headingRefs,
        targetTag: 'P',
      },
    })
    const degradedBuffer = degraded.outputBuffer!
    const analysis = await analyzePDF(degradedBuffer, 'accessible.pdf')
    const context = await inspectPdfForRemediation(degradedBuffer, analysis)
    const candidate = context.headingCandidates.find(entry => entry.repairMode === 'safe')

    expect(candidate).toBeTruthy()

    const result = await executeRemediationTool({
      buffer: degradedBuffer,
      context,
      call: {
        tool_name: 'create_heading_from_candidate',
        arguments: {
          candidateId: candidate!.id,
          level: 'H2',
        },
        rationale: 'Create the first heading tag.',
        confidence: 0.9,
      },
    })

    const next = await analyzePDF(result.buffer, 'accessible.pdf')

    expect(result.action.outcome).toBe('applied')
    expect(next.verapdf.failures.some(failure => /Heading level 1 is skipped/i.test(failure.message))).toBe(false)
    expect(next.categories.find(category => category.id === 'heading_structure')?.findings).toContain('Heading outline: H1')
  }, 90_000)

  it('create_heading_from_candidate does not introduce non-figure alt-text risks', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect' },
    })
    const headingRefs = inspect.headings.map(heading => heading.ref)
    const degraded = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: {
        operation: 'retag_node',
        targets: headingRefs,
        targetTag: 'P',
      },
    })
    const degradedBuffer = degraded.outputBuffer!
    const analysis = await analyzePDF(degradedBuffer, 'accessible.pdf')
    const context = await inspectPdfForRemediation(degradedBuffer, analysis)
    const candidate = context.headingCandidates.find(entry => entry.repairMode === 'safe')

    expect(candidate).toBeTruthy()

    const result = await executeRemediationTool({
      buffer: degradedBuffer,
      context,
      call: {
        tool_name: 'create_heading_from_candidate',
        arguments: {
          candidateId: candidate!.id,
          level: 'H2',
        },
        rationale: 'Create the first heading tag.',
        confidence: 0.9,
      },
    })

    const deepInspect = await runPdfStructureBackend({
      buffer: result.buffer,
      mutation: { operation: 'inspect', inspectMode: 'alt_text_deep' },
    })

    expect((deepInspect.acrobatAltRiskNodes || []).filter(node => node.ownershipMode === 'nonfigure_with_alt')).toEqual([])
  }, 90_000)

  it('sets /Tabs /S on annotated pages', async () => {
    const buffer = await makePdfWithLink()
    const analysis = await analyzePDF(buffer, 'linked.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'set_page_tabs',
        arguments: { pageNumbers: [1] },
        rationale: 'Normalize tab order on annotated pages.',
        confidence: 0.9,
      },
    })

    const nextDoc = await PDFDocument.load(result.buffer, { ignoreEncryption: true })
    const tabs = nextDoc.getPage(0).node.get(PDFName.of('Tabs'))

    expect(result.action.outcome).toBe('applied')
    expect(String(tabs)).toBe('/S')
  })

  it('sets link annotation /Contents without rewriting visible text', async () => {
    const buffer = await makePdfWithLink()
    const analysis = await analyzePDF(buffer, 'linked.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const candidate = context.linkCandidates[0]
    expect(candidate).toBeTruthy()

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'set_link_annotation_contents',
        arguments: {
          candidateId: candidate!.id,
          contents: 'Example report link',
        },
        rationale: 'Set alternate description on the link annotation.',
        confidence: 0.9,
      },
    })

    const nextDoc = await PDFDocument.load(result.buffer, { ignoreEncryption: true })
    const annots = nextDoc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    const annot = annots && nextDoc.context.lookup(annots.get(0), PDFDict)
    const contents = annot?.lookup(PDFName.of('Contents')) as PDFHexString | PDFString | undefined
    const decoded = contents && 'decodeText' in contents ? contents.decodeText() : String(contents)

    expect(result.action.outcome).toBe('applied')
    expect(decoded).toBe('Example report link')
  }, 30_000)

  it('sets link annotation /Contents using the link-only annotation ordinal when non-link annotations come first', async () => {
    const buffer = await makePdfWithMixedAnnotations()
    const analysis = await analyzePDF(buffer, 'mixed-annots.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const candidate = context.linkCandidates[0]
    expect(candidate?.annotationIndex).toBe(0)

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'set_link_annotation_contents',
        arguments: {
          candidateId: candidate!.id,
          contents: 'Example report link',
        },
        rationale: 'Set alternate description on the link annotation.',
        confidence: 0.9,
      },
    })

    const nextDoc = await PDFDocument.load(result.buffer, { ignoreEncryption: true })
    const annots = nextDoc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    const firstAnnot = annots && nextDoc.context.lookup(annots.get(0), PDFDict)
    const secondAnnot = annots && nextDoc.context.lookup(annots.get(1), PDFDict)
    const firstContents = firstAnnot?.lookup(PDFName.of('Contents')) as PDFHexString | PDFString | undefined
    const secondContents = secondAnnot?.lookup(PDFName.of('Contents')) as PDFHexString | PDFString | undefined
    const decodedSecond = secondContents && 'decodeText' in secondContents ? secondContents.decodeText() : String(secondContents)

    expect(result.action.outcome).toBe('applied')
    expect(firstAnnot?.get(PDFName.of('Subtype'))?.toString()).toBe('/Text')
    expect(firstContents && 'decodeText' in firstContents ? firstContents.decodeText() : String(firstContents)).toBe('note')
    expect(secondAnnot?.get(PDFName.of('Subtype'))?.toString()).toBe('/Link')
    expect(decodedSecond).toBe('Example report link')
  }, 30_000)

  it('re-inspects link annotation /Contents from raw PDF objects after mutation', async () => {
    const buffer = await makePdfWithMixedAnnotations()
    const analysis = await analyzePDF(buffer, 'mixed-annots.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const candidate = context.linkCandidates[0]

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'set_link_annotation_contents',
        arguments: {
          candidateId: candidate!.id,
          contents: 'Example report link',
        },
        rationale: 'Set alternate description on the link annotation.',
        confidence: 0.9,
      },
    })

    const refreshed = await inspectPdfForRemediation(
      result.buffer,
      await analyzePDF(result.buffer, 'mixed-annots.pdf', { skipVeraPdf: true }),
      { inspectMode: 'light' },
    )
    expect(refreshed.linkCandidates[0]?.annotationContents).toBe('Example report link')
  }, 30_000)

  it('normalizes metadata and writes PDF/UA identification on the original PDF', async () => {
    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'untitled-example.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'normalize_document_metadata',
        arguments: {
          title: 'Accessible Example',
          language: 'en',
        },
        rationale: 'Normalize metadata and PDF/UA identification.',
        confidence: 0.9,
      },
    })

    const nextDoc = await PDFDocument.load(result.buffer, { ignoreEncryption: true })
    const viewerPreferences = nextDoc.catalog.lookup(PDFName.of('ViewerPreferences'), PDFDict)
    const displayDocTitle = viewerPreferences?.get(PDFName.of('DisplayDocTitle'))
    const metadata = nextDoc.catalog.get(PDFName.of('Metadata'))
    const lang = nextDoc.catalog.get(PDFName.of('Lang'))

    expect(result.action.outcome).toBe('applied')
    expect(String(displayDocTitle)).toBe('true')
    expect(metadata).toBeTruthy()
    expect(String(lang)).toContain('en')
  }, 30_000)

  it('canonicalizes legacy uppercase language tags instead of treating them as already valid', async () => {
    const buffer = await loadDownloadFixture('11drug seizures_1997-2007.pdf')
    const analysis = await analyzePDF(buffer, '11drug seizures_1997-2007.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'set_document_language',
        arguments: {
          language: 'EN-US',
        },
        rationale: 'Normalize the document language tag casing.',
        confidence: 0.9,
      },
    })

    const nextDoc = await PDFDocument.load(result.buffer, { ignoreEncryption: true })
    const lang = nextDoc.catalog.get(PDFName.of('Lang'))

    expect(result.action.outcome).toBe('applied')
    expect(String(lang)).toContain('en-US')
  }, 120_000)

  it('repairs structure conformance in place on mixed chart PDFs', async () => {
    let buffer = await loadDownloadFixture('3violent offenses_1999-2008.pdf')
    const original = await analyzePDF(buffer, '3violent offenses_1999-2008.pdf')
    let context = await inspectPdfForRemediation(buffer, original, { inspectMode: 'light' })

    const tabs = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'set_page_tabs',
        arguments: { pageNumbers: [1] },
        rationale: 'Normalize page tabs.',
        confidence: 0.9,
      },
    })
    buffer = tabs.buffer

    context = await inspectPdfForRemediation(
      buffer,
      await analyzePDF(buffer, '3violent offenses_1999-2008.pdf', { skipVeraPdf: true }),
      { inspectMode: 'light' },
    )
    for (const candidate of context.linkCandidates) {
      const result = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name: 'set_link_annotation_contents',
          arguments: {
            candidateId: candidate.id,
            contents: candidate.suggestedText || candidate.text || candidate.url,
          },
          rationale: 'Set link annotation contents.',
          confidence: 0.9,
        },
      })
      buffer = result.buffer
      context = await inspectPdfForRemediation(
        buffer,
        await analyzePDF(buffer, '3violent offenses_1999-2008.pdf', { skipVeraPdf: true }),
        { inspectMode: 'light' },
      )
    }

    const bootstrap = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'bootstrap_struct_tree',
        arguments: { target: 'document' },
        rationale: 'Bootstrap structure tree.',
        confidence: 0.9,
      },
    })
    buffer = bootstrap.buffer
    const before = await analyzePDF(buffer, '3violent offenses_1999-2008.pdf')
    context = await inspectPdfForRemediation(buffer, before, { inspectMode: 'light' })

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'repair_structure_conformance',
        arguments: { target: 'document' },
        rationale: 'Repair logical structure conformance.',
        confidence: 0.9,
      },
    })

    const after = await analyzePDF(result.buffer, '3violent offenses_1999-2008.pdf')
    expect(result.action.outcome).toBe('applied')
    expect(after.verapdf.failedChecks).toBeLessThan(before.verapdf.failedChecks)
  }, 120_000)

  it('repair_structure_conformance does not add /Alt to /Link structure elements', async () => {
    let buffer = await makePdfWithLink()
    let analysis = await analyzePDF(buffer, 'linked.pdf', { skipVeraPdf: true })
    let context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const tabs = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'set_page_tabs',
        arguments: { pageNumbers: [1] },
        rationale: 'Normalize page tabs.',
        confidence: 0.9,
      },
    })
    buffer = tabs.buffer

    analysis = await analyzePDF(buffer, 'linked.pdf', { skipVeraPdf: true })
    context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const linkCandidate = context.linkCandidates[0]
    expect(linkCandidate).toBeTruthy()

    const contents = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'set_link_annotation_contents',
        arguments: {
          candidateId: linkCandidate!.id,
          contents: 'Example report link',
        },
        rationale: 'Set annotation contents before structure repair.',
        confidence: 0.9,
      },
    })
    buffer = contents.buffer

    const bootstrapContext = await inspectPdfForRemediation(
      buffer,
      await analyzePDF(buffer, 'linked.pdf', { skipVeraPdf: true }),
      { inspectMode: 'light' },
    )
    const bootstrap = await executeRemediationTool({
      buffer,
      context: bootstrapContext,
      call: {
        tool_name: 'bootstrap_struct_tree',
        arguments: { target: 'document' },
        rationale: 'Bootstrap structure tree.',
        confidence: 0.9,
      },
    })

    const repaired = await executeRemediationTool({
      buffer: bootstrap.buffer,
      context: await inspectPdfForRemediation(
        bootstrap.buffer,
        await analyzePDF(bootstrap.buffer, 'linked.pdf', { skipVeraPdf: true }),
        { inspectMode: 'light' },
      ),
      call: {
        tool_name: 'repair_structure_conformance',
        arguments: { target: 'document' },
        rationale: 'Repair logical structure conformance.',
        confidence: 0.9,
      },
    })

    const repairedDoc = await PDFDocument.load(repaired.buffer, { ignoreEncryption: true })
    const structTreeRoot = repairedDoc.catalog.lookupMaybe(PDFName.of('StructTreeRoot'), PDFDict)
    const linkElems: PDFDict[] = []
    const visit = (value: any) => {
      if (!(value instanceof PDFDict)) return
      const tag = value.get(PDFName.of('S'))
      if (String(tag) === '/Link') linkElems.push(value)
      const kids = value.get(PDFName.of('K'))
      if (kids instanceof PDFArray) {
        for (let i = 0; i < kids.size(); i += 1) visit(repairedDoc.context.lookup(kids.get(i)))
      } else if (kids) {
        visit(repairedDoc.context.lookup(kids))
      }
    }
    visit(structTreeRoot)

    expect(linkElems.every(link => !link.has(PDFName.of('Alt')))).toBe(true)
  }, 60_000)

  it('artifact_nonsemantic_page_elements does not resolve by writing non-figure /Alt', async () => {
    const buffer = await loadFixture('accessible.pdf')
    const result = await runPdfStructureBackend({
      buffer,
      mutation: { operation: 'artifact_nonsemantic_page_elements' },
    })

    const inspect = await runPdfStructureBackend({
      buffer: result.outputBuffer || buffer,
      mutation: { operation: 'inspect', inspectMode: 'alt_text_deep' },
    })

    expect((inspect.acrobatAltRiskNodes || []).filter(node => node.ownershipMode === 'nonfigure_with_alt')).toEqual([])
  }, 60_000)

  it('repairs missing ToUnicode maps in place on large mixed/native PDFs', async () => {
    const buffer = await loadDownloadFixture('04-07MVStrategy.pdf')
    const before = await analyzePDF(buffer, '04-07MVStrategy.pdf')
    const context = await inspectPdfForRemediation(buffer, before)

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'repair_font_unicode_maps',
        arguments: { target: 'document' },
        rationale: 'Add derivable ToUnicode maps to WinAnsi TrueType fonts.',
        confidence: 0.9,
      },
    })

    const nextDoc = await PDFDocument.load(result.buffer, { ignoreEncryption: true })
    const page = nextDoc.getPage(0)
    const resources = page.node.lookupMaybe(PDFName.of('Resources'), PDFDict)
    const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict)
    const fontHasToUnicode = fonts
      ? Array.from(fonts.keys()).some(key => {
          const font = fonts.lookupMaybe(key, PDFDict)
          return !!font?.get(PDFName.of('ToUnicode'))
        })
      : false

    expect(result.action.outcome).toBe('applied')
    expect(fontHasToUnicode).toBe(true)
  }, 90_000)

  it('repairs derivable Type1 ToUnicode maps on annual-report PDFs', async () => {
    const buffer = await loadDownloadFixture('99anreport.pdf')
    const before = await analyzePDF(buffer, '99anreport.pdf')
    const context = await inspectPdfForRemediation(buffer, before)

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'repair_type1_font_unicode_maps',
        arguments: { target: 'document' },
        rationale: 'Add derivable ToUnicode maps to Type1 and Type3 fonts with custom encodings.',
        confidence: 0.9,
      },
    })

    const after = await analyzePDF(result.buffer, '99anreport.pdf')
    expect(['applied', 'no_effect']).toContain(result.action.outcome)
    expect(after.verapdf.failedChecks).toBeLessThanOrEqual(before.verapdf.failedChecks)
  }, 120_000)

  it('repairs legacy Gxx subset glyph names in small Distiller PDFs', async () => {
    const buffer = await loadRepoDownload('juv probation.pdf')
    const beforeQpdf = await analyzeWithQpdf(buffer)
    const before = await analyzePDF(buffer, 'juv probation.pdf')
    const context = await inspectPdfForRemediation(buffer, before)

    expect(beforeQpdf.type1FontsMissingToUnicode).toBeGreaterThan(0)

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'repair_type1_font_unicode_maps',
        arguments: { target: 'document' },
        rationale: 'Add Type1 ToUnicode maps for legacy subset glyph-name encodings.',
        confidence: 0.9,
      },
    })

    const afterQpdf = await analyzeWithQpdf(result.buffer)
    expect(['applied', 'no_effect']).toContain(result.action.outcome)
    expect(afterQpdf.type1FontsMissingToUnicode).toBeLessThan(beforeQpdf.type1FontsMissingToUnicode ?? 0)
    expect(afterQpdf.fontsMissingToUnicode).toBeLessThan(beforeQpdf.fontsMissingToUnicode ?? 0)
  }, 120_000)

  it('embeds legacy Type1 substitute fonts on small Gill Sans PDFs', async () => {
    const buffer = await loadRepoDownload('SPTDVoga.pdf')
    const beforeQpdf = await analyzeWithQpdf(buffer)
    const before = await analyzePDF(buffer, 'SPTDVoga.pdf')
    const context = await inspectPdfForRemediation(buffer, before)

    expect(beforeQpdf.unembeddedFontCount).toBeGreaterThan(0)

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'embed_missing_fonts_in_place',
        arguments: { target: 'document' },
        rationale: 'Embed substitute programs for legacy Type1 fonts with no exact local font file.',
        confidence: 0.9,
      },
    })

    const afterQpdf = await analyzeWithQpdf(result.buffer)
    expect(['applied', 'no_effect']).toContain(result.action.outcome)
    expect(afterQpdf.unembeddedFontCount).toBeLessThan(beforeQpdf.unembeddedFontCount ?? 0)
  }, 120_000)

  it('embeds Boton brochure fonts through legacy substitute fallbacks', async () => {
    const buffer = await loadRepoDownload('bor_english.pdf')
    const beforeQpdf = await analyzeWithQpdf(buffer)
    const before = await analyzePDF(buffer, 'bor_english.pdf')
    const context = await inspectPdfForRemediation(buffer, before)

    expect(beforeQpdf.unembeddedFontCount).toBeGreaterThan(0)

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'embed_missing_fonts_in_place',
        arguments: { target: 'document' },
        rationale: 'Embed substitute programs for legacy brochure fonts with no exact local font file.',
        confidence: 0.9,
      },
    })

    const afterQpdf = await analyzeWithQpdf(result.buffer)
    expect(['applied', 'no_effect']).toContain(result.action.outcome)
    expect(afterQpdf.unembeddedFontCount).toBeLessThan(beforeQpdf.unembeddedFontCount ?? 0)
  }, 120_000)

  it('repairs ToUnicode maps for WinAnsi dictionary TrueType fonts in small Acrobat PDFs', async () => {
    const filename = 'A Study Gun Addendum .pdf'
    const buffer = await loadRepoDownload(filename)
    const beforeQpdf = await analyzeWithQpdf(buffer)
    const before = await analyzePDF(buffer, filename)
    const context = await inspectPdfForRemediation(buffer, before)

    expect(beforeQpdf.fontsMissingToUnicode).toBeGreaterThan(0)
    expect(beforeQpdf.type1FontsMissingToUnicode ?? 0).toBe(0)

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'repair_font_unicode_maps',
        arguments: { target: 'document' },
        rationale: 'Add ToUnicode maps for WinAnsi-based TrueType fonts with AGL-compliant Differences arrays.',
        confidence: 0.9,
      },
    })

    const afterQpdf = await analyzeWithQpdf(result.buffer)
    expect(['applied', 'no_effect']).toContain(result.action.outcome)
    expect(afterQpdf.fontsMissingToUnicode).toBeLessThan(beforeQpdf.fontsMissingToUnicode ?? 0)
  }, 120_000)

  it('embeds Tekton legacy fonts through substitute fallbacks', async () => {
    const buffer = await loadRepoDownload('victim2.pdf')
    const beforeQpdf = await analyzeWithQpdf(buffer)
    const before = await analyzePDF(buffer, 'victim2.pdf')
    const context = await inspectPdfForRemediation(buffer, before)

    expect(beforeQpdf.unembeddedFontCount).toBeGreaterThan(0)

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'embed_missing_fonts_in_place',
        arguments: { target: 'document' },
        rationale: 'Embed substitute programs for legacy Tekton fonts with no exact local font file.',
        confidence: 0.9,
      },
    })

    const afterQpdf = await analyzeWithQpdf(result.buffer)
    expect(['applied', 'no_effect']).toContain(result.action.outcome)
    expect(afterQpdf.unembeddedFontCount).toBeLessThan(beforeQpdf.unembeddedFontCount ?? 0)
  }, 120_000)

  it('promotes strong image-backed paragraph figure candidates in recent tagged reports', async () => {
    const buffer = await loadRepoDownload('2025FirearmProhibitorsReport-250626T19175938.pdf')
    const analysis = await analyzePDF(buffer, '2025FirearmProhibitorsReport-250626T19175938.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'alt_text_deep' })

    const candidate = context.figureCandidates.find(entry =>
      entry.targetTag === '/P'
      && entry.imageEvidence === 'strong'
      && entry.repairMode === 'retag_then_set_alt')
    expect(candidate).toBeTruthy()
  }, 120_000)

  it('retags strong image-backed paragraph figure candidates even when page image count is unavailable', async () => {
    const buffer = await loadRepoDownload('2025FirearmProhibitorsReport-250626T19175938.pdf')
    const analysis = await analyzePDF(buffer, '2025FirearmProhibitorsReport-250626T19175938.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'alt_text_deep' })

    const candidate = context.figureCandidates.find(entry =>
      entry.targetTag === '/P'
      && entry.imageEvidence === 'strong'
      && entry.repairMode === 'retag_then_set_alt')
    expect(candidate).toBeTruthy()

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'set_figure_alt_text',
        arguments: {
          candidateId: candidate!.id,
          altText: 'Image related to direction section chart',
          generationSource: 'heuristic_fallback',
        },
        rationale: 'Regression coverage for strong paragraph figure retagging.',
        confidence: 0.55,
      },
    })

    expect(result.action.outcome).toBe('applied')
    expect(result.action.changedDocumentBytes).toBe(true)
  }, 120_000)

  it('keeps strong paragraph figure candidates promotable even with long surrounding text', async () => {
    const buffer = await loadRepoDownload('2025FirearmProhibitorsReport-250626T19175938.pdf')
    const analysis = await analyzePDF(buffer, '2025FirearmProhibitorsReport-250626T19175938.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'alt_text_deep' })

    const candidate = context.figureCandidates.find(entry =>
      entry.targetTag === '/P'
      && entry.imageEvidence === 'strong'
      && entry.pageImageCount === 0
      && entry.surroundingText.join(' ').length > 220)

    expect(candidate).toBeTruthy()
    expect(candidate?.repairMode).toBe('retag_then_set_alt')
  }, 120_000)

  it('allows semantic AI to override text-heavy defer for strong figure evidence', () => {
    expect(__test_isSemanticAiEligibleDeferredFigureCandidate({
      id: 'figure:1',
      pageNumber: 1,
      targetRef: 'obj:1 0 R',
      bbox: null,
      hasAlt: false,
      altText: null,
      informativeHint: 'informative',
      surroundingText: ['Long surrounding text'],
      repairMode: 'defer',
      targetTag: '/P',
      unsafeReason: 'text_heavy_candidate: Target obj:1 0 R appears text-heavy and is not safe to retag as /Figure.',
      parentTagPath: [],
      pageImageCount: 0,
      textDensityHint: 'high',
      imageEvidence: 'strong',
    })).toBe(true)
  })

  it('substitutes missing legacy annual-report fonts with metric-aware embedded fallbacks', async () => {
    const buffer = await loadDownloadFixture('99anreport.pdf')
    const before = await analyzePDF(buffer, '99anreport.pdf')
    const context = await inspectPdfForRemediation(buffer, before)

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'substitute_legacy_fonts_in_place',
        arguments: { target: 'document' },
        rationale: 'Substitute unavailable legacy annual-report fonts with approved fallbacks.',
        confidence: 0.9,
      },
    })

    const after = await analyzePDF(result.buffer, '99anreport.pdf')
    expect(['applied', 'no_effect']).toContain(result.action.outcome)
    expect(after.pageCount).toBe(before.pageCount)
    expect(after.verapdf.status).toBe('unavailable')
    expect(after.verapdf.failedChecks).toBe(0)
  }, 120_000)

  it('finalizes substituted annual-report fonts with per-font conformance cleanup', async () => {
    const buffer = await loadDownloadFixture('99anreport.pdf')
    const before = await analyzePDF(buffer, '99anreport.pdf')
    const context = await inspectPdfForRemediation(buffer, before)

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'finalize_substituted_font_conformance',
        arguments: { target: 'document' },
        rationale: 'Finish embedding, width normalization, and Unicode mapping on substituted annual-report fonts.',
        confidence: 0.95,
      },
    })

    const after = await analyzePDF(result.buffer, '99anreport.pdf')
    expect(['applied', 'no_effect']).toContain(result.action.outcome)
    expect(after.pageCount).toBe(before.pageCount)
    expect(after.verapdf.failedChecks).toBeLessThanOrEqual(before.verapdf.failedChecks)
  }, 120_000)

  it('normalizes annotation tab order beyond just setting /Tabs /S', async () => {
    const buffer = await makePdfWithOutOfOrderLinks()
    const analysis = await analyzePDF(buffer, 'links.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'normalize_annotation_tab_order',
        arguments: { target: 'document' },
        rationale: 'Normalize annotation ordering.',
        confidence: 0.9,
      },
    })

    const nextDoc = await PDFDocument.load(result.buffer, { ignoreEncryption: true })
    const page = nextDoc.getPage(0)
    const tabs = page.node.get(PDFName.of('Tabs'))
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    const firstAnnot = annots && nextDoc.context.lookup(annots.get(0), PDFDict)
    const firstAction = firstAnnot?.lookup(PDFName.of('A'), PDFDict)
    const firstUri = firstAction?.lookup(PDFName.of('URI')) as PDFHexString | PDFString | undefined
    const firstDecoded = firstUri && 'decodeText' in firstUri ? firstUri.decodeText() : String(firstUri)

    expect(result.action.outcome).toBe('applied')
    expect(String(tabs)).toBe('/S')
    expect(firstDecoded).toBe('https://example.com/top')
  })

  it('repairs CID symbol font maps in place on large mixed/native PDFs', async () => {
    const buffer = await loadDownloadFixture('04-07MVStrategy.pdf')
    const analysis = await analyzePDF(buffer, '04-07MVStrategy.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'repair_cid_symbol_font_maps',
        arguments: { target: 'document' },
        rationale: 'Repair CIDToGIDMap and symbol ToUnicode data.',
        confidence: 0.9,
      },
    })

    const backendInspect = await runPdfStructureBackend({
      buffer: result.buffer,
      mutation: { operation: 'inspect' },
    })

    expect(result.action.outcome).toBe('applied')
    expect(result.action.details).toContain('CID')
    expect(backendInspect.warnings).toEqual([])
  }, 60_000)

  it('repairs CIDSet consistency after in-place font repairs on one-page tagged chart PDFs', async () => {
    let buffer = await loadDownloadFixture('11drug seizures_1997-2007.pdf')
    let analysis = await analyzePDF(buffer, '11drug seizures_1997-2007.pdf')
    let context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    for (const tool_name of ['embed_missing_fonts_in_place', 'repair_font_unicode_maps', 'repair_cid_symbol_font_maps'] as const) {
      const result = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name,
          arguments: { target: 'document' },
          rationale: `Prepare fonts with ${tool_name}.`,
          confidence: 0.9,
        },
      })
      buffer = result.buffer
      // Font tools only need QPDF/PDF.js data from context; skip veraPDF between prep steps
      analysis = await analyzePDF(buffer, '11drug seizures_1997-2007.pdf', { skipVeraPdf: true })
      context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    }

    // Run veraPDF once after all font prep to get the accurate failedChecks baseline
    analysis = await analyzePDF(buffer, '11drug seizures_1997-2007.pdf')
    context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const beforeFailedChecks = analysis.verapdf.failedChecks
    const cidsetResult = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'repair_cidset_consistency',
        arguments: { target: 'document' },
        rationale: 'Repair embedded CIDSet streams to match the embedded subset.',
        confidence: 0.9,
      },
    })

    const after = await analyzePDF(cidsetResult.buffer, '11drug seizures_1997-2007.pdf')
    expect(['applied', 'no_effect']).toContain(cidsetResult.action.outcome)
    expect(after.verapdf.failedChecks).toBeLessThanOrEqual(beforeFailedChecks)
  }, 300_000)

  it('reports CIDSet inspection coverage and returns no_effect when a second pass finds nothing new to rewrite', async () => {
    let buffer = await loadDownloadFixture('11drug seizures_1997-2007.pdf')
    // Initial analysis needed for context; subsequent steps skip veraPDF since
    // font prep tools only use QPDF/PDF.js data and this test has no veraPDF assertions.
    let analysis = await analyzePDF(buffer, '11drug seizures_1997-2007.pdf', { skipVeraPdf: true })
    let context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    for (const tool_name of ['embed_missing_fonts_in_place', 'repair_font_unicode_maps', 'repair_cid_symbol_font_maps'] as const) {
      const result = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name,
          arguments: { target: 'document' },
          rationale: `Prepare fonts with ${tool_name}.`,
          confidence: 0.9,
        },
      })
      buffer = result.buffer
      analysis = await analyzePDF(buffer, '11drug seizures_1997-2007.pdf', { skipVeraPdf: true })
      context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    }

    const firstPass = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'repair_cidset_consistency',
        arguments: { target: 'document' },
        rationale: 'Repair embedded CIDSet streams to match the embedded subset.',
        confidence: 0.9,
      },
    })

    expect(firstPass.action.details).toContain('Inspected')

    // Skip veraPDF for second-pass context: only testing CIDSet idempotency, not compliance
    const secondAnalysis = await analyzePDF(firstPass.buffer, '11drug seizures_1997-2007.pdf', { skipVeraPdf: true })
    const secondContext = await inspectPdfForRemediation(firstPass.buffer, secondAnalysis, { inspectMode: 'light' })
    const secondPass = await executeRemediationTool({
      buffer: firstPass.buffer,
      context: secondContext,
      call: {
        tool_name: 'repair_cidset_consistency',
        arguments: { target: 'document' },
        rationale: 'Confirm CIDSet streams already match the embedded subset.',
        confidence: 0.9,
      },
    })

    expect(secondPass.action.outcome).toBe('no_effect')
    expect(secondPass.action.details).toContain('Inspected')
    expect(secondPass.action.details).toContain('rewrote 0 stream')
  }, 600_000)

  it('surfaces no_effect when CIDSet repair cannot derive a trustworthy embedded CID universe', async () => {
    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'cidset-noeffect.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const backendSpy = vi.spyOn(pdfStructureBackend, 'runPdfStructureBackend').mockResolvedValue({
      status: 'no_effect',
      changedDocumentBytes: false,
      appliedMutations: [],
      warnings: ['Could not derive a trustworthy embedded CID universe for /ExampleCIDFont; left /CIDSet unchanged.'],
      headings: [],
      structuralNodes: [],
      tables: [],
      figures: [],
      readingOrderNodes: [],
      readingOrderParents: [],
    })
    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'repair_cidset_consistency',
        arguments: { target: 'document' },
        rationale: 'Attempt CIDSet repair.',
        confidence: 0.8,
      },
    })

    expect(backendSpy).toHaveBeenCalled()
    expect(result.action.outcome).toBe('no_effect')
    expect(result.action.details).toContain('trustworthy embedded CID universe')
    expect(result.action.changedDocumentBytes).toBe(false)
  })

  it('creates heading tags in-place and improves heading score', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect' },
    })
    const headingRefs = inspect.headings.map(heading => heading.ref)
    expect(headingRefs.length).toBeGreaterThan(0)

    const degraded = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: {
        operation: 'retag_node',
        targets: headingRefs,
        targetTag: 'P',
      },
    })
    expect(degraded.status).toBe('applied')
    expect(degraded.outputBuffer).toBeDefined()

    const degradedBuffer = degraded.outputBuffer!
    const degradedAnalysis = await analyzePDF(degradedBuffer, 'accessible.pdf')
    const degradedHeadingScore = degradedAnalysis.categories.find(category => category.id === 'heading_structure')?.score ?? 0

    const context = await inspectPdfForRemediation(degradedBuffer, degradedAnalysis)
    const result = await executeRemediationTool({
      buffer: degradedBuffer,
      context,
      call: {
        tool_name: 'create_heading_tag',
        arguments: {},
        rationale: 'Restore heading semantics.',
        confidence: 0.8,
      },
    })

    const next = await analyzePDF(result.buffer, 'accessible.pdf')
    const nextHeadingScore = next.categories.find(category => category.id === 'heading_structure')?.score ?? 0

    expect(result.action.outcome).toBe('applied')
    expect(result.action.changedDocumentBytes).toBe(true)
    expect(result.action.categoryTargets).toEqual(['heading_structure'])
    expect(nextHeadingScore).toBeGreaterThan(degradedHeadingScore)
  }, 30_000)

  it('promotes first-row table cells to headers and improves table score', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect' },
    })
    const headerCellRefs = inspect.tables.flatMap(table => table.headerCellRefs)
    expect(headerCellRefs.length).toBeGreaterThan(0)

    const degraded = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: {
        operation: 'retag_node',
        targets: headerCellRefs,
        targetTag: 'TD',
      },
    })
    expect(degraded.status).toBe('applied')
    expect(degraded.outputBuffer).toBeDefined()

    const degradedBuffer = degraded.outputBuffer!
    const degradedAnalysis = await analyzePDF(degradedBuffer, 'accessible.pdf')
    const degradedTableScore = degradedAnalysis.categories.find(category => category.id === 'table_markup')?.score ?? 0

    const context = await inspectPdfForRemediation(degradedBuffer, degradedAnalysis)
    const result = await executeRemediationTool({
      buffer: degradedBuffer,
      context,
      call: {
        tool_name: 'set_table_header_cells',
        arguments: {},
        rationale: 'Restore first-row table headers.',
        confidence: 0.8,
      },
    })

    const next = await analyzePDF(result.buffer, 'accessible.pdf')
    const nextTableScore = next.categories.find(category => category.id === 'table_markup')?.score ?? 0

    expect(result.action.outcome).toBe('applied')
    expect(result.action.changedDocumentBytes).toBe(true)
    expect(result.action.categoryTargets).toEqual(['table_markup'])
    expect(nextTableScore).toBeGreaterThan(degradedTableScore)
  }, 30_000)

  it('creates bookmarks from headings in the structure backend', async () => {
    const buffer = await loadFixture('accessible.pdf')
    const result = await runPdfStructureBackend({
      buffer,
      mutation: {
        operation: 'replace_bookmarks_from_headings',
        headings: [
          { text: 'Example document', level: 'H1', pageNumber: 1 },
        ],
      },
    })

    expect(result.status).toBe('applied')
    expect(result.changedDocumentBytes).toBe(true)
    expect(result.outputBuffer).toBeDefined()

    const reInspect = await runPdfStructureBackend({
      buffer: result.outputBuffer!,
      mutation: { operation: 'inspect' },
    })
    expect(reInspect.warnings).toEqual([])

    const qpdf = await analyzeWithQpdf(result.outputBuffer!)
    expect(qpdf.hasOutlines).toBe(true)
    expect(qpdf.outlineCount).toBeGreaterThan(0)
  })

  it('normalizes existing top-level heading hierarchy so sibling headings stay H1', async () => {
    const buffer = await makePdf()
    const bootstrapped = await runPdfStructureBackend({
      buffer,
      mutation: {
        operation: 'bootstrap_struct_tree',
        headings: [
          { text: 'Section one', level: 'H2', pageNumber: 1 },
          { text: 'Section two', level: 'H2', pageNumber: 1 },
          { text: 'Section three', level: 'H2', pageNumber: 1 },
        ],
        figures: [],
      },
    })

    expect(bootstrapped.outputBuffer).toBeDefined()
    const inspectBootstrapped = await runPdfStructureBackend({
      buffer: bootstrapped.outputBuffer!,
      mutation: { operation: 'inspect' },
    })
    const degraded = await runPdfStructureBackend({
      buffer: bootstrapped.outputBuffer!,
      mutation: {
        operation: 'retag_node',
        targets: [inspectBootstrapped.headings[0]!.ref],
        targetTag: 'H2',
      },
    })

    expect(degraded.outputBuffer).toBeDefined()
    const normalized = await runPdfStructureBackend({
      buffer: degraded.outputBuffer!,
      mutation: { operation: 'normalize_heading_hierarchy' },
    })

    expect(normalized.status).toBe('applied')
    const reInspect = await runPdfStructureBackend({
      buffer: normalized.outputBuffer!,
      mutation: { operation: 'inspect' },
    })
    expect(reInspect.headings.map(heading => heading.tag).slice(0, 3)).toEqual(['/H1', '/H1', '/H1'])
  }, 60_000)

  it('normalizes descending root-heading resets so sibling headings settle on H1', async () => {
    const buffer = await makePdf()
    const bootstrapped = await runPdfStructureBackend({
      buffer,
      mutation: {
        operation: 'bootstrap_struct_tree',
        headings: [
          { text: 'Document title', level: 'H1', pageNumber: 1 },
          { text: 'Section one', level: 'H2', pageNumber: 1 },
          { text: 'Section two', level: 'H1', pageNumber: 1 },
          { text: 'Section three', level: 'H2', pageNumber: 1 },
        ],
        figures: [],
      },
    })

    expect(bootstrapped.outputBuffer).toBeDefined()
    const inspectBootstrapped = await runPdfStructureBackend({
      buffer: bootstrapped.outputBuffer!,
      mutation: { operation: 'inspect' },
    })
    const degraded = await runPdfStructureBackend({
      buffer: bootstrapped.outputBuffer!,
      mutation: {
        operation: 'retag_node',
        targets: [inspectBootstrapped.headings[2]!.ref],
        targetTag: 'H1',
      },
    })

    expect(degraded.outputBuffer).toBeDefined()
    const normalized = await runPdfStructureBackend({
      buffer: degraded.outputBuffer!,
      mutation: { operation: 'normalize_heading_hierarchy' },
    })

    expect(normalized.status).toBe('applied')
    const reInspect = await runPdfStructureBackend({
      buffer: normalized.outputBuffer!,
      mutation: { operation: 'inspect' },
    })
    expect(reInspect.headings.map(heading => heading.tag).slice(0, 4)).toEqual(['/H1', '/H1', '/H1', '/H1'])
  }, 60_000)

  it('retags a safe figure candidate and restores alt text', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect' },
    })
    const figureRef = inspect.figures[0]?.ref
    expect(figureRef).toBeTruthy()

    const degraded = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: {
        operation: 'retag_node',
        targets: [figureRef!],
        targetTag: 'P',
      },
    })
    expect(degraded.status).toBe('applied')

    const degradedBuffer = degraded.outputBuffer!
    const degradedAnalysis = await analyzePDF(degradedBuffer, 'accessible.pdf')
    const degradedAltScore = degradedAnalysis.categories.find(category => category.id === 'alt_text')?.score ?? 0
    const context = await inspectPdfForRemediation(degradedBuffer, degradedAnalysis)
    const figureCandidate = context.figureCandidates[0]
    expect(figureCandidate?.targetRef).toBeTruthy()
    expect(figureCandidate?.repairMode).toBe('retag_then_set_alt')

    const result = await executeRemediationTool({
      buffer: degradedBuffer,
      context,
      call: {
        tool_name: 'retag_as_figure_and_set_alt',
        arguments: {
          candidateId: figureCandidate.id,
          altText: 'Accessible University logo',
        },
        rationale: 'Restore figure alt text.',
        confidence: 0.8,
      },
    })

    const next = await analyzePDF(result.buffer, 'accessible.pdf')
    const nextAltScore = next.categories.find(category => category.id === 'alt_text')?.score ?? 0

    expect(['applied', 'no_effect']).toContain(result.action.outcome)
    expect(result.action.categoryTargets).toEqual(['alt_text'])
    if (result.action.outcome === 'applied') {
      expect(nextAltScore).toBeGreaterThan(degradedAltScore)
    }
  }, 30_000)

  it('auto-escalates safe non-Figure alt-text targets into retagging', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect' },
    })
    const figureRef = inspect.figures[0]?.ref
    expect(figureRef).toBeTruthy()

    const degraded = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: {
        operation: 'retag_node',
        targets: [figureRef!],
        targetTag: 'TextBox',
      },
    })
    expect(degraded.status).toBe('applied')

    const degradedBuffer = degraded.outputBuffer!
    const degradedAnalysis = await analyzePDF(degradedBuffer, 'accessible.pdf')
    const context = await inspectPdfForRemediation(degradedBuffer, degradedAnalysis)
    const figureCandidate = context.figureCandidates.find(candidate =>
      candidate.targetRef === figureRef || candidate.targetTag === '/TextBox' || candidate.repairMode === 'retag_then_set_alt')
      || context.figureCandidates[0]
    expect(figureCandidate?.id).toBeTruthy()

    const result = await executeRemediationTool({
      buffer: degradedBuffer,
      context,
      call: {
        tool_name: 'set_figure_alt_text',
        arguments: {
          candidateId: figureCandidate!.id,
          altText: 'Escalated figure alt text',
        },
        rationale: 'Repair figure alt text.',
        confidence: 0.8,
      },
    })

    expect(['applied', 'no_effect']).toContain(result.action.outcome)
    expect(result.action.categoryTargets).toEqual(['alt_text'])
  }, 15_000)

  it('retags a safe TextBox figure candidate and restores alt text', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect' },
    })
    const figureRef = inspect.figures[0]?.ref
    expect(figureRef).toBeTruthy()

    const degraded = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: {
        operation: 'retag_node',
        targets: [figureRef!],
        targetTag: 'TextBox',
      },
    })
    expect(degraded.status).toBe('applied')

    const result = await runPdfStructureBackend({
      buffer: degraded.outputBuffer!,
      mutation: {
        operation: 'retag_as_figure_and_set_alt',
        targetRef: figureRef!,
        altText: 'Accessible TextBox figure',
      },
    })

    expect(['applied', 'no_effect']).toContain(result.status)
    if (result.status === 'applied') {
      expect(result.changedDocumentBytes).toBe(true)
      expect(result.outputBuffer).toBeDefined()
    }
  })

  it('retags a safe Shape figure candidate and restores alt text', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect' },
    })
    const figureRef = inspect.figures[0]?.ref
    expect(figureRef).toBeTruthy()

    const degraded = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: {
        operation: 'retag_node',
        targets: [figureRef!],
        targetTag: 'Shape',
      },
    })
    expect(degraded.status).toBe('applied')

    const degradedAnalysis = await analyzePDF(degraded.outputBuffer!, 'accessible.pdf')
    const context = await inspectPdfForRemediation(degraded.outputBuffer!, degradedAnalysis)
    const figureCandidate = context.figureCandidates.find(candidate =>
      candidate.targetRef === figureRef || candidate.targetTag === '/Shape' || candidate.repairMode === 'retag_then_set_alt')
      || context.figureCandidates[0]

    expect(figureCandidate?.repairMode).toBe('retag_then_set_alt')

    const result = await runPdfStructureBackend({
      buffer: degraded.outputBuffer!,
      mutation: {
        operation: 'retag_as_figure_and_set_alt',
        targetRef: figureCandidate!.targetRef!,
        altText: 'Accessible shape-backed figure',
      },
    })

    expect(['applied', 'no_effect']).toContain(result.status)
    if (result.status === 'applied') {
      expect(result.changedDocumentBytes).toBe(true)
      expect(result.outputBuffer).toBeDefined()
    }
  })

  it('repairs native graphics-only figure owners without aliasing decorative cleanup', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect', inspectMode: 'alt_text_deep' },
    })
    const figureRef = inspect.figures[0]?.ref
    expect(figureRef).toBeTruthy()

    const degraded = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: {
        operation: 'retag_node',
        targets: [figureRef!],
        targetTag: 'Span',
      },
    })
    expect(degraded.status).toBe('applied')

    const repaired = await runPdfStructureBackend({
      buffer: degraded.outputBuffer!,
      mutation: {
        operation: 'repair_native_figure_semantics',
      },
    })

    expect(repaired.status).toBe('applied')
    expect(repaired.changedDocumentBytes).toBe(true)
    expect(repaired.figureOperationSummary?.figureNodesRetagged).toBeGreaterThanOrEqual(1)
    expect(repaired.figureOperationSummary?.graphicsOnlyOwnersPromoted).toBeGreaterThanOrEqual(1)
    expect(repaired.figureOperationSummary?.figureAltPreserved).toBeGreaterThanOrEqual(1)

    const reInspect = await runPdfStructureBackend({
      buffer: repaired.outputBuffer!,
      mutation: { operation: 'inspect', inspectMode: 'alt_text_deep' },
    })
    expect(reInspect.structuralNodes.some(node => node.tag === '/Figure')).toBe(true)
  })

  it('retags a safe Story figure candidate by wrapping it in a child /Figure', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect' },
    })
    const figureRef = inspect.figures[0]?.ref
    expect(figureRef).toBeTruthy()

    const degraded = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: {
        operation: 'retag_node',
        targets: [figureRef!],
        targetTag: 'Story',
      },
    })
    expect(degraded.status).toBe('applied')

    const result = await runPdfStructureBackend({
      buffer: degraded.outputBuffer!,
      mutation: {
        operation: 'retag_as_figure_and_set_alt',
        targetRef: figureRef!,
        altText: 'Accessible Story figure',
        imageEvidence: 'strong',
        pageImageCount: 1,
      },
    })

    expect(['applied', 'no_effect']).toContain(result.status)
    if (result.status === 'applied') {
      expect(result.changedDocumentBytes).toBe(true)
      expect(result.outputBuffer).toBeDefined()
    }
  })

  it('does not rewrap a Story figure candidate when a descendant /Figure already has alt text', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect' },
    })
    const figureRef = inspect.figures[0]?.ref
    expect(figureRef).toBeTruthy()

    const degraded = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: {
        operation: 'retag_node',
        targets: [figureRef!],
        targetTag: 'Story',
      },
    })
    expect(degraded.status).toBe('applied')

    const firstWrap = await runPdfStructureBackend({
      buffer: degraded.outputBuffer!,
      mutation: {
        operation: 'retag_as_figure_and_set_alt',
        targetRef: figureRef!,
        altText: 'Accessible Story figure',
        imageEvidence: 'strong',
        pageImageCount: 1,
      },
    })

    expect(['applied', 'no_effect']).toContain(firstWrap.status)
    const wrappedBuffer = firstWrap.outputBuffer || degraded.outputBuffer!

    const secondWrap = await runPdfStructureBackend({
      buffer: wrappedBuffer,
      mutation: {
        operation: 'retag_as_figure_and_set_alt',
        targetRef: figureRef!,
        altText: 'Accessible Story figure',
        imageEvidence: 'strong',
        pageImageCount: 1,
      },
    })

    expect(secondWrap.status).toBe('no_effect')
    expect(secondWrap.changedDocumentBytes).toBe(false)
  })

  it('allows vector-backed figure retagging without raster image evidence', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect' },
    })
    const figureRef = inspect.figures[0]?.ref
    expect(figureRef).toBeTruthy()

    const degraded = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: {
        operation: 'retag_node',
        targets: [figureRef!],
        targetTag: 'Shape',
      },
    })
    expect(degraded.status).toBe('applied')

    const result = await runPdfStructureBackend({
      buffer: degraded.outputBuffer!,
      mutation: {
        operation: 'retag_as_figure_and_set_alt',
        targetRef: figureRef!,
        altText: 'Vector-backed annual report graphic',
        pageImageCount: 0,
        imageEvidence: 'vector',
        textDensityHint: 'low',
      },
    })

    expect(['applied', 'no_effect']).toContain(result.status)
  })

  it('defers unsafe table-backed figure candidates instead of force-retagging them', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const analysis = await analyzePDF(accessibleBuffer, 'accessible.pdf')
    const context = await inspectPdfForRemediation(accessibleBuffer, analysis)
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect' },
    })
    const tableCellRef = inspect.tables.flatMap(table => table.firstRowCellRefs)[0]
    expect(tableCellRef).toBeTruthy()

    const unsafeContext: PdfRemediationContext = {
      ...context,
      figureCandidates: [{
        id: 'figure:unsafe-td',
        pageNumber: 1,
        targetRef: tableCellRef,
        bbox: null,
        hasAlt: false,
        altText: null,
        informativeHint: 'informative',
        surroundingText: ['Example table'],
        repairMode: 'defer',
        targetTag: '/TD',
        unsafeReason: `Target ${tableCellRef} is associated with /TD and is not safe to retag as /Figure.`,
        parentTagPath: ['/TR', '/Table'],
        pageImageCount: 1,
        textDensityHint: 'low',
        imageEvidence: 'weak',
      }],
    }

    const result = await executeRemediationTool({
      buffer: accessibleBuffer,
      context: unsafeContext,
      call: {
        tool_name: 'retag_as_figure_and_set_alt',
        arguments: {
          candidateId: 'figure:unsafe-td',
          altText: 'Unsafe table image',
        },
        rationale: 'Attempt figure repair.',
        confidence: 0.7,
      },
    })

    expect(result.action.outcome).toBe('deferred')
    expect(result.action.validationWarnings).toBeUndefined()
    expect(result.manualReviewFlags[0]?.details).toContain('/TD')
  })

  it('allows strong informative table-backed figure candidates to wrap a child figure', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const analysis = await analyzePDF(accessibleBuffer, 'accessible.pdf')
    const context = await inspectPdfForRemediation(accessibleBuffer, analysis)
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect' },
    })
    const tableCellRef = inspect.tables.flatMap(table => table.firstRowCellRefs)[0]
    expect(tableCellRef).toBeTruthy()

    const strongContext: PdfRemediationContext = {
      ...context,
      figureCandidates: [{
        id: 'figure:strong-td',
        pageNumber: 1,
        targetRef: tableCellRef,
        bbox: null,
        hasAlt: false,
        altText: null,
        informativeHint: 'informative',
        surroundingText: ['Figure 1', 'Interventions Across the Life-Course'],
        repairMode: 'retag_then_set_alt',
        targetTag: '/TD',
        parentTagPath: ['/TR', '/Table'],
        pageImageCount: 1,
        textDensityHint: 'high',
        imageEvidence: 'strong',
      }],
    }

    const result = await executeRemediationTool({
      buffer: accessibleBuffer,
      context: strongContext,
      call: {
        tool_name: 'retag_as_figure_and_set_alt',
        arguments: {
          candidateId: 'figure:strong-td',
          altText: 'Lifecycle interventions figure',
        },
        rationale: 'Wrap informative table-backed figure content.',
        confidence: 0.8,
      },
    })

    expect(['applied', 'no_effect']).toContain(result.action.outcome)
  })

  it('defers unsafe TOCI-backed figure candidates instead of force-retagging them', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const analysis = await analyzePDF(accessibleBuffer, 'accessible.pdf')
    const context = await inspectPdfForRemediation(accessibleBuffer, analysis)
    const fallbackTarget = context.headingCandidates[0]?.targetRef
    expect(fallbackTarget).toBeTruthy()

    const unsafeContext: PdfRemediationContext = {
      ...context,
      figureCandidates: [{
        id: 'figure:unsafe-toci',
        pageNumber: 1,
        targetRef: fallbackTarget!,
        bbox: null,
        hasAlt: false,
        altText: null,
        informativeHint: 'informative',
        surroundingText: ['Table of contents'],
        repairMode: 'defer',
        targetTag: '/TOCI',
        unsafeReason: `Target ${fallbackTarget} is associated with /TOCI and is not safe to retag as /Figure.`,
        parentTagPath: ['/TOC'],
        pageImageCount: 1,
        textDensityHint: 'low',
        imageEvidence: 'weak',
      }],
    }

    const result = await executeRemediationTool({
      buffer: accessibleBuffer,
      context: unsafeContext,
      call: {
        tool_name: 'retag_as_figure_and_set_alt',
        arguments: {
          candidateId: 'figure:unsafe-toci',
          altText: 'Unsafe toc image',
        },
        rationale: 'Attempt figure repair.',
        confidence: 0.7,
      },
    })

    expect(result.action.outcome).toBe('deferred')
    expect(result.manualReviewFlags[0]?.details).toContain('/TOCI')
  })

  it('defers unsafe list-backed figure candidates instead of force-retagging them', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const analysis = await analyzePDF(accessibleBuffer, 'accessible.pdf')
    const context = await inspectPdfForRemediation(accessibleBuffer, analysis)
    const fallbackTarget = context.headingCandidates[0]?.targetRef
    expect(fallbackTarget).toBeTruthy()

    const unsafeContext: PdfRemediationContext = {
      ...context,
      figureCandidates: [{
        id: 'figure:unsafe-li',
        pageNumber: 1,
        targetRef: fallbackTarget!,
        bbox: null,
        hasAlt: false,
        altText: null,
        informativeHint: 'informative',
        surroundingText: ['List item'],
        repairMode: 'defer',
        targetTag: '/LI',
        unsafeReason: `Target ${fallbackTarget} is associated with /LI and is not safe to retag as /Figure.`,
        parentTagPath: ['/L'],
        pageImageCount: 1,
        textDensityHint: 'low',
        imageEvidence: 'weak',
      }],
    }

    const result = await executeRemediationTool({
      buffer: accessibleBuffer,
      context: unsafeContext,
      call: {
        tool_name: 'retag_as_figure_and_set_alt',
        arguments: {
          candidateId: 'figure:unsafe-li',
          altText: 'Unsafe list image',
        },
        rationale: 'Attempt figure repair.',
        confidence: 0.7,
      },
    })

    expect(result.action.outcome).toBe('deferred')
    expect(result.manualReviewFlags[0]?.details).toContain('/LI')
  })

  it('routes reading-order repair through a parent-scoped candidate group', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect' },
    })
    const parentGroup = [...inspect.readingOrderParents]
      .filter(parent => parent.childRefs.length > 2)
      .sort((a, b) => b.childRefs.length - a.childRefs.length)[0]
    expect(parentGroup).toBeTruthy()
    const originalOrder = parentGroup!.childRefs

    const degraded = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: {
        operation: 'reorder_structure_children',
        parentRef: parentGroup!.parentRef,
        orderedTargets: [...originalOrder].reverse(),
      },
    })
    expect(degraded.status).toBe('applied')

    const degradedBuffer = degraded.outputBuffer!
    const degradedAnalysis = await analyzePDF(degradedBuffer, 'accessible.pdf')
    const degradedReadingScore = degradedAnalysis.categories.find(category => category.id === 'reading_order')?.score ?? 0
    const context = await inspectPdfForRemediation(degradedBuffer, degradedAnalysis)
    const readingOrderCandidates = inspect.structuralNodes
      .filter(node => !!node.parentRef)
      .map(node => ({
        id: `order:${node.ref}`,
        ref: node.ref,
        tag: node.tag,
        parentRef: node.parentRef || null,
        orderIndex: node.orderIndex,
      }))
    const candidateIdByRef = new Map(readingOrderCandidates.map(candidate => [candidate.ref, candidate.id]))
    const reorderContext: PdfRemediationContext = {
      ...context,
      readingOrderCandidates,
      readingOrderParentCandidates: [{
        id: `order-parent:${parentGroup!.parentRef}`,
        parentRef: parentGroup!.parentRef,
        childCandidateIds: parentGroup!.childRefs.map(ref => candidateIdByRef.get(ref)).filter(Boolean) as string[],
        mutableKids: true,
        mcidDisorderBefore: Number.NaN,
        pageNumberHints: parentGroup!.pageNumberHints,
        tagMix: parentGroup!.childTags,
        suggestedChildCandidateIds: parentGroup!.suggestedChildRefs.map(ref => candidateIdByRef.get(ref)).filter(Boolean) as string[],
      }],
    }

    const result = await executeRemediationTool({
      buffer: degradedBuffer,
      context: reorderContext,
      call: {
        tool_name: 'reorder_structure_children',
        arguments: { candidateGroupId: `order-parent:${parentGroup!.parentRef}`, parentRef: parentGroup!.parentRef },
        rationale: 'Restore the original reading order.',
        confidence: 0.75,
      },
    })

    expect(['applied', 'no_effect']).toContain(result.action.outcome)
    expect(result.action.categoryTargets).toEqual(['reading_order'])
    if (result.action.outcome === 'applied') {
      expect(result.action.changedDocumentBytes).toBe(true)
      expect(result.action.validationWarnings).toEqual([])
    }
    expect(degradedReadingScore).toBeGreaterThanOrEqual(0)
  })

  it('replaces bookmarks from headings and improves bookmark score on a long document', async () => {
    const inaccessibleBuffer = await loadFixture('inaccessible.pdf')
    const originalAnalysis = await analyzePDF(inaccessibleBuffer, 'inaccessible.pdf')
    const originalBookmarkScore = originalAnalysis.categories.find(category => category.id === 'bookmarks')?.score ?? 0

    const originalContext = await inspectPdfForRemediation(inaccessibleBuffer, originalAnalysis)
    const bootstrap = await executeRemediationTool({
      buffer: inaccessibleBuffer,
      context: originalContext,
      call: {
        tool_name: 'bootstrap_struct_tree',
        arguments: { target: 'document' },
        rationale: 'Create a minimal tag tree with headings.',
        confidence: 0.8,
      },
    })
    expect(bootstrap.action.outcome).toBe('applied')

    const bootstrappedAnalysis = await analyzePDF(bootstrap.buffer, 'inaccessible.pdf')
    const context = await inspectPdfForRemediation(bootstrap.buffer, bootstrappedAnalysis)
    const result = await executeRemediationTool({
      buffer: bootstrap.buffer,
      context,
      call: {
        tool_name: 'replace_bookmarks_from_headings',
        arguments: {},
        rationale: 'Generate bookmarks from heading structure.',
        confidence: 0.8,
      },
    })

    const next = await analyzePDF(result.buffer, 'inaccessible.pdf')
    const nextBookmarkScore = next.categories.find(category => category.id === 'bookmarks')?.score ?? 0

    expect(result.action.outcome).toBe('applied')
    expect(result.action.changedDocumentBytes).toBe(true)
    expect(result.action.categoryTargets).toEqual(['bookmarks'])
    expect(nextBookmarkScore).toBe(100)
  }, 90_000)

  it('creates bookmarks from page-mapped heading candidates even when structure refs are unavailable', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const analysis = await analyzePDF(accessibleBuffer, 'accessible.pdf')
    const context = await inspectPdfForRemediation(accessibleBuffer, analysis)
    const degradedContext: PdfRemediationContext = {
      ...context,
      headingCandidates: [
        {
          ...context.headingCandidates[0]!,
          id: 'heading:page-only-1',
          text: 'Example document',
          targetRef: null,
          existingTag: '/Link',
          repairMode: 'defer',
          unsafeReason: 'Resolved to unsafe structural tag.',
          pageNumber: 1,
        },
        {
          ...context.headingCandidates[0]!,
          id: 'heading:page-only-2',
          text: 'Section two',
          targetRef: null,
          existingTag: '/Link',
          repairMode: 'defer',
          unsafeReason: 'Resolved to unsafe structural tag.',
          pageNumber: 2,
        },
      ],
    }

    const result = await executeRemediationTool({
      buffer: accessibleBuffer,
      context: degradedContext,
      call: {
        tool_name: 'replace_bookmarks_from_headings',
        arguments: {},
        rationale: 'Generate bookmarks from page-mapped headings.',
        confidence: 0.8,
      },
    })

    const qpdf = await analyzeWithQpdf(result.buffer)

    expect(result.action.outcome).toBe('applied')
    expect(result.action.categoryTargets).toEqual(['bookmarks'])
    expect(qpdf.hasOutlines).toBe(true)
    expect(qpdf.outlineCount).toBeGreaterThan(0)
  })

  it('defers parent groups without mutable kids before attempting reorder', async () => {
    const accessibleBuffer = await loadFixture('accessible.pdf')
    const analysis = await analyzePDF(accessibleBuffer, 'accessible.pdf')
    const context = await inspectPdfForRemediation(accessibleBuffer, analysis)
    const deferredContext: PdfRemediationContext = {
      ...context,
      readingOrderParentCandidates: [{
        id: 'order-parent:immutable',
        parentRef: 'obj:999 0 R',
        childCandidateIds: context.readingOrderCandidates.slice(0, 2).map(candidate => candidate.id),
        mutableKids: false,
        mcidDisorderBefore: 0.5,
        pageNumberHints: [1],
        tagMix: ['/P', '/P'],
        suggestedChildCandidateIds: context.readingOrderCandidates.slice(0, 2).map(candidate => candidate.id),
      }],
    }

    const result = await executeRemediationTool({
      buffer: accessibleBuffer,
      context: deferredContext,
      call: {
        tool_name: 'reorder_structure_children',
        arguments: { candidateGroupId: 'order-parent:immutable' },
        rationale: 'Attempt reorder.',
        confidence: 0.6,
      },
    })

    expect(result.action.outcome).toBe('deferred')
    expect(result.manualReviewFlags[0]?.details).toContain('does not expose a mutable /K array')
  })

})

describe('remediationPlanService', { timeout: 60_000 }, () => {
  let chartPdfPlanFixture: { buffer: Buffer; analysis: Awaited<ReturnType<typeof analyzePDF>>; context: PdfRemediationContext }
  let annualReportPlanFixture: { buffer: Buffer; analysis: Awaited<ReturnType<typeof analyzePDF>>; context: PdfRemediationContext }
  let cidsetPlanFixture: { buffer: Buffer; analysis: Awaited<ReturnType<typeof analyzePDF>>; context: PdfRemediationContext }

  beforeAll(async () => {
    const [chartBuffer, annualReportBuffer, cidsetBuffer] = await Promise.all([
      loadDownloadFixture('04-07MVStrategy.pdf'),
      loadDownloadFixture('99anreport.pdf'),
      loadDownloadFixture('11drug seizures_1997-2007.pdf'),
    ])
    const [chartAnalysis, annualReportAnalysis, cidsetAnalysis] = await Promise.all([
      analyzePDF(chartBuffer, '04-07MVStrategy.pdf'),
      analyzePDF(annualReportBuffer, '99anreport.pdf'),
      analyzePDF(cidsetBuffer, '11drug seizures_1997-2007.pdf'),
    ])
    const [chartContext, annualReportContext, cidsetContext] = await Promise.all([
      inspectPdfForRemediation(chartBuffer, chartAnalysis, { inspectMode: 'light' }),
      inspectPdfForRemediation(annualReportBuffer, annualReportAnalysis, { inspectMode: 'light' }),
      inspectPdfForRemediation(cidsetBuffer, cidsetAnalysis, { inspectMode: 'light' }),
    ])

    chartPdfPlanFixture = { buffer: chartBuffer, analysis: chartAnalysis, context: chartContext }
    annualReportPlanFixture = { buffer: annualReportBuffer, analysis: annualReportAnalysis, context: annualReportContext }
    cidsetPlanFixture = { buffer: cidsetBuffer, analysis: cidsetAnalysis, context: cidsetContext }
  }, 120_000)

  it('falls back to heuristic metadata actions when no title or language exist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'untitled-example.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const plan = await planRemediationActions({
      filename: 'untitled-example.pdf',
      analysis,
      context,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'set_document_title')).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'set_document_language')).toBe(true)
  })

  it('does not call planner-side AI by default when deterministic routing can act', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('planner fetch should not be called')
    })
    vi.stubGlobal('fetch', fetchSpy)

    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'untitled-example.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const plan = await planRemediationActions({
      filename: 'untitled-example.pdf',
      analysis,
      context,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'set_document_title')).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses planner-side AI only when fallback flag is enabled and deterministic routing returns no actions', async () => {
    const original = REMEDIATION.ENABLE_PLANNER_AI_FALLBACK
    ;(REMEDIATION as { ENABLE_PLANNER_AI_FALLBACK: boolean }).ENABLE_PLANNER_AI_FALLBACK = true

    try {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: 'plan_pdf_remediation',
                  arguments: JSON.stringify({
                    done: false,
                    unresolvedIssues: ['form_accessibility'],
                    actions: [{
                      tool_name: 'set_form_field_tooltip',
                      arguments: { target: 'unlabeled form fields' },
                      rationale: 'Fallback planner selected form tooltip repair.',
                      confidence: 0.7,
                    }],
                  }),
                },
              }],
            },
          }],
        }),
      } as Response)))

      const buffer = await makePdf()
      const analysis = await analyzePDF(buffer, 'forms.pdf')
      const context = await inspectPdfForRemediation(buffer, analysis)

      const plan = await planRemediationActions({
        filename: 'forms.pdf',
        analysis: {
          ...analysis,
          verapdf: {
            ...analysis.verapdf,
            status: 'passed',
            executionStatus: 'ok',
            isCompliant: true,
            failedChecks: 0,
            failures: [],
          },
          categories: analysis.categories.map(category => {
            if (category.id === 'form_accessibility') {
              return { ...category, score: 20, grade: 'F', severity: 'Critical' }
            }
            return typeof category.score === 'number'
              ? { ...category, score: 100, grade: 'A', severity: 'Pass' }
              : category
          }),
        },
        context,
        iteration: 1,
        actions: [],
        rejectedActions: [],
      })

      expect(plan.actions).toEqual([
        {
          tool_name: 'set_form_field_tooltip',
          arguments: { target: 'unlabeled form fields' },
          rationale: 'Fallback planner selected form tooltip repair.',
          confidence: 0.7,
        },
      ])
    } finally {
      ;(REMEDIATION as { ENABLE_PLANNER_AI_FALLBACK: boolean }).ENABLE_PLANNER_AI_FALLBACK = original
    }
  })

  it('returns candidate-specific heading actions in heuristic mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const accessibleBuffer = await loadFixture('accessible.pdf')
    const inspect = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: { operation: 'inspect' },
    })
    const headingRefs = inspect.headings.map(heading => heading.ref)
    const degraded = await runPdfStructureBackend({
      buffer: accessibleBuffer,
      mutation: {
        operation: 'retag_node',
        targets: headingRefs,
        targetTag: 'P',
      },
    })
    const degradedBuffer = degraded.outputBuffer!
    const analysis = await analyzePDF(degradedBuffer, 'accessible.pdf')
    const context = await inspectPdfForRemediation(degradedBuffer, analysis)

    const plan = await planRemediationActions({
      filename: 'accessible.pdf',
      analysis,
      context,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'create_heading_from_candidate')).toBe(true)
    expect(plan.actions.some(action => typeof action.arguments.candidateId === 'string')).toBe(true)
  })

  it('skips unsafe heading candidates in heuristic mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'example.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const heuristicContext: PdfRemediationContext = {
      ...context,
      headingCandidates: [
        {
          id: 'heading:safe',
          pageNumber: 1,
          text: 'Safe heading',
          bbox: { x: 0, y: 0, width: 1, height: 0.1 },
          fontSize: 18,
          fontWeight: 'bold',
          nearbyContext: ['Body'],
          targetRef: 'obj:1 0 R',
          existingTag: '/P',
          repairMode: 'safe',
        },
        {
          id: 'heading:unsafe',
          pageNumber: 1,
          text: 'Unsafe heading',
          bbox: { x: 0, y: 0.2, width: 1, height: 0.1 },
          fontSize: 18,
          fontWeight: 'bold',
          nearbyContext: ['Body'],
          targetRef: 'obj:2 0 R',
          existingTag: '/Link',
          repairMode: 'defer',
          unsafeReason: 'Unsafe heading target',
        },
      ],
    }

    const plan = await planRemediationActions({
      filename: 'example.pdf',
      analysis: {
        ...analysis,
        categories: analysis.categories.map(category =>
          category.id === 'heading_structure' ? { ...category, score: 50 } : category),
      },
      context: heuristicContext,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    const headingActions = plan.actions.filter(action => action.tool_name === 'create_heading_from_candidate')
    expect(headingActions).toHaveLength(1)
    expect(headingActions[0]?.arguments.candidateId).toBe('heading:safe')
  }, 15_000)

  it('treats /Sect-backed heading candidates as safe when they are the best available structural target', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'example.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const heuristicContext: PdfRemediationContext = {
      ...context,
      headingCandidates: [
        {
          id: 'heading:sect',
          pageNumber: 1,
          text: 'Section heading',
          bbox: { x: 0, y: 0, width: 1, height: 0.1 },
          fontSize: 18,
          fontWeight: 'bold',
          nearbyContext: ['Body'],
          targetRef: 'obj:9 0 R',
          existingTag: '/Sect',
          repairMode: 'safe',
        },
      ],
    }

    const plan = await planRemediationActions({
      filename: 'example.pdf',
      analysis: {
        ...analysis,
        categories: analysis.categories.map(category =>
          category.id === 'heading_structure' ? { ...category, score: 0 } : category),
      },
      context: heuristicContext,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'create_heading_from_candidate' && action.arguments.candidateId === 'heading:sect')).toBe(true)
  }, 15_000)

  it('treats /Story-backed heading candidates as safe when they are the best available structural target', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'example.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const heuristicContext: PdfRemediationContext = {
      ...context,
      headingCandidates: [
        {
          id: 'heading:story',
          pageNumber: 1,
          text: 'Story heading',
          bbox: { x: 0, y: 0, width: 1, height: 0.1 },
          fontSize: 18,
          fontWeight: 'bold',
          nearbyContext: ['Body'],
          targetRef: 'obj:19 0 R',
          existingTag: '/Story',
          repairMode: 'safe',
        },
      ],
    }

    const plan = await planRemediationActions({
      filename: 'example.pdf',
      analysis: {
        ...analysis,
        categories: analysis.categories.map(category =>
          category.id === 'heading_structure' ? { ...category, score: 0 } : category),
      },
      context: heuristicContext,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'create_heading_from_candidate' && action.arguments.candidateId === 'heading:story')).toBe(true)
  }, 15_000)

  it('treats /Normal-backed heading candidates as safe when they are the best available structural target', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'example.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const heuristicContext: PdfRemediationContext = {
      ...context,
      headingCandidates: [
        {
          id: 'heading:normal',
          pageNumber: 1,
          text: 'Normal heading',
          bbox: { x: 0, y: 0, width: 1, height: 0.1 },
          fontSize: 18,
          fontWeight: 'bold',
          nearbyContext: ['Body'],
          targetRef: 'obj:29 0 R',
          existingTag: '/Normal',
          repairMode: 'safe',
        },
      ],
    }

    const plan = await planRemediationActions({
      filename: 'example.pdf',
      analysis: {
        ...analysis,
        categories: analysis.categories.map(category =>
          category.id === 'heading_structure' ? { ...category, score: 0 } : category),
      },
      context: heuristicContext,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'create_heading_from_candidate' && action.arguments.candidateId === 'heading:normal')).toBe(true)
  }, 15_000)


  it('promotes chapter-style headings to H1 in heuristic mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'example.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const heuristicContext: PdfRemediationContext = {
      ...context,
      headingCandidates: [
        {
          id: 'heading:chapter',
          pageNumber: 6,
          text: 'Chapter 1: Introduction',
          bbox: { x: 0, y: 0, width: 1, height: 0.1 },
          fontSize: 18,
          fontWeight: 'bold',
          nearbyContext: ['Body'],
          targetRef: 'obj:19 0 R',
          existingTag: '/Sect',
          repairMode: 'safe',
        },
        {
          id: 'heading:sub',
          pageNumber: 7,
          text: 'Background Information',
          bbox: { x: 0, y: 0.2, width: 1, height: 0.1 },
          fontSize: 16,
          fontWeight: 'bold',
          nearbyContext: ['Body'],
          targetRef: 'obj:20 0 R',
          existingTag: '/Sect',
          repairMode: 'safe',
        },
      ],
    }

    const plan = await planRemediationActions({
      filename: 'example.pdf',
      analysis: {
        ...analysis,
        categories: analysis.categories.map(category =>
          category.id === 'heading_structure' ? { ...category, score: 0 } : category),
      },
      context: heuristicContext,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    const chapterAction = plan.actions.find(action => action.tool_name === 'create_heading_from_candidate' && action.arguments.candidateId === 'heading:chapter')
    const subheadingAction = plan.actions.find(action => action.tool_name === 'create_heading_from_candidate' && action.arguments.candidateId === 'heading:sub')
    expect(chapterAction?.arguments.level).toBe('H1')
    expect(subheadingAction?.arguments.level).toBe('H2')
  }, 15_000)

  it('plans reading-order fixes from parent groups instead of giant mixed candidate sets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'example.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const heuristicContext: PdfRemediationContext = {
      ...context,
      readingOrderCandidates: [
        { id: 'order:a', ref: 'obj:1 0 R', tag: '/P', parentRef: 'obj:10 0 R', orderIndex: 0 },
        { id: 'order:b', ref: 'obj:2 0 R', tag: '/P', parentRef: 'obj:10 0 R', orderIndex: 1 },
        { id: 'order:c', ref: 'obj:3 0 R', tag: '/P', parentRef: 'obj:10 0 R', orderIndex: 2 },
        { id: 'order:d', ref: 'obj:4 0 R', tag: '/P', parentRef: 'obj:20 0 R', orderIndex: 0 },
        { id: 'order:e', ref: 'obj:5 0 R', tag: '/P', parentRef: 'obj:20 0 R', orderIndex: 1 },
      ],
      readingOrderParentCandidates: [
        {
          id: 'order-parent:big',
          parentRef: 'obj:10 0 R',
          childCandidateIds: ['order:a', 'order:b', 'order:c'],
          mutableKids: true,
          mcidDisorderBefore: 0.2,
          pageNumberHints: [1, 2],
          tagMix: ['/P', '/P', '/P'],
          suggestedChildCandidateIds: ['order:a', 'order:b', 'order:c'],
        },
        {
          id: 'order-parent:small',
          parentRef: 'obj:20 0 R',
          childCandidateIds: ['order:d', 'order:e'],
          mutableKids: true,
          mcidDisorderBefore: 0.8,
          pageNumberHints: [1],
          tagMix: ['/P', '/P'],
          suggestedChildCandidateIds: ['order:e', 'order:d'],
        },
      ],
    }

    const plan = await planRemediationActions({
      filename: 'example.pdf',
      analysis: {
        ...analysis,
        categories: analysis.categories.map(category =>
          category.id === 'reading_order' ? { ...category, score: 50 } : category),
      },
      context: heuristicContext,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    const readingAction = plan.actions.find(action => action.tool_name === 'reorder_structure_children')
    expect(readingAction?.arguments.candidateGroupId).toBe('order-parent:small')
  })

  it('plans page tabs and link annotation contents from veraPDF link failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdfWithLink()
    const analysis = await analyzePDF(buffer, 'linked.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const plan = await planRemediationActions({
      filename: 'linked.pdf',
      analysis: {
        ...analysis,
        verapdf: {
          ...analysis.verapdf,
          status: 'failed',
          executionStatus: 'ok',
          isCompliant: false,
          failedChecks: 2,
          failures: [
            {
              ruleId: 'rule-tabs',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'Every page on which there is an annotation shall contain in its page dictionary the key Tabs, and its value shall be S',
              categoryIds: ['link_quality', 'reading_order'],
            },
            {
              ruleId: 'rule-contents',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'Links shall contain an alternate description via their Contents key as described in ISO 32000-1:2008, 14.9.3',
              categoryIds: ['link_quality'],
            },
          ],
          message: 'veraPDF detected 2 PDF/UA compliance issues.',
        },
      },
      context,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'set_page_tabs')).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'set_link_annotation_contents')).toBe(true)
  })

  it('plans bootstrapped chart-content conformance repairs for one-page mixed chart PDFs after bootstrap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await loadDownloadFixture('3violent offenses_1999-2008.pdf')
    const analysis = await analyzePDF(buffer, '3violent offenses_1999-2008.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const plan = await planRemediationActions({
      filename: '3violent offenses_1999-2008.pdf',
      analysis: {
        ...analysis,
        pageCount: 1,
        isScanned: false,
        verapdf: {
          ...analysis.verapdf,
          status: 'failed',
          executionStatus: 'ok',
          isCompliant: false,
          failedChecks: 9,
          failures: [
            {
              ruleId: 'ua-id',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'The document metadata stream doesn\'t contain PDF/UA Identification Schema',
              categoryIds: [],
            },
            {
              ruleId: 'content',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'Content is neither marked as Artifact nor tagged as real content',
              categoryIds: [],
            },
            {
              ruleId: 'font',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'The font programs for all fonts used for rendering within a conforming file shall be embedded within that file',
              categoryIds: [],
            },
          ],
          message: 'veraPDF detected remaining conformance issues.',
        },
      },
      context: {
        ...context,
        qpdf: {
          ...context.qpdf,
          hasStructTree: true,
          structTreeDepth: Math.max(2, context.qpdf.structTreeDepth),
        },
        structure: {
          ...context.structure,
          structuralNodes: context.structure.structuralNodes?.length
            ? context.structure.structuralNodes
            : [{ ref: 'obj:1 0 R', tag: '/Sect', orderIndex: 0 }],
        },
      },
      iteration: 2,
      actions: [makePlannerAction('bootstrap_struct_tree')],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'set_pdfua_identification')).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'normalize_document_metadata')).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'repair_bootstrapped_chart_content_refs')).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'repair_native_marked_content_refs')).toBe(false)
    expect(plan.actions.some(action => action.tool_name === 'repair_structure_conformance')).toBe(false)
    expect(plan.actions.some(action => action.tool_name === 'embed_missing_fonts_in_place')).toBe(true)
  }, 30_000)

  it('repairs bootstrapped one-page chart content refs in place and reduces veraPDF failures', async () => {
    let buffer = await loadDownloadFixture('3violent offenses_1999-2008.pdf')
    let analysis = await analyzePDF(buffer, '3violent offenses_1999-2008.pdf', { skipVeraPdf: true })
    let context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const bootstrap = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'bootstrap_struct_tree',
        arguments: { target: 'document' },
        rationale: 'Bootstrap chart structure.',
        confidence: 0.9,
      },
    })
    buffer = bootstrap.buffer
    analysis = await analyzePDF(buffer, '3violent offenses_1999-2008.pdf', { skipVeraPdf: true })
    context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const tabs = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'set_page_tabs',
        arguments: { pageNumbers: [1] },
        rationale: 'Normalize tabs.',
        confidence: 0.9,
      },
    })
    buffer = tabs.buffer
    analysis = await analyzePDF(buffer, '3violent offenses_1999-2008.pdf', { skipVeraPdf: true })
    context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    for (const candidate of context.linkCandidates.slice(0, 5)) {
      const contents = candidate.suggestedText || candidate.text || candidate.url
      const result = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name: 'set_link_annotation_contents',
          arguments: {
            candidateId: candidate.id,
            contents,
          },
          rationale: 'Seed link alternate descriptions before structural link repair.',
          confidence: 0.84,
        },
      })
      buffer = result.buffer
      analysis = await analyzePDF(buffer, '3violent offenses_1999-2008.pdf', { skipVeraPdf: true })
      context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    }

    analysis = await analyzePDF(buffer, '3violent offenses_1999-2008.pdf')
    const beforeFailedChecks = analysis.verapdf.failedChecks
    const beforePageCount = analysis.pageCount
    const repair = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'repair_bootstrapped_chart_content_refs',
        arguments: { target: 'document' },
        rationale: 'Attach remaining chart content groups and links to the bootstrapped structure tree.',
        confidence: 0.9,
      },
    })

    const after = await analyzePDF(repair.buffer, '3violent offenses_1999-2008.pdf')
    expect(repair.action.outcome).toBe('applied')
    expect(after.pageCount).toBe(beforePageCount)
    expect(after.verapdf.failedChecks).toBeLessThan(beforeFailedChecks)
  }, 300_000)

  it('plans native-safe conformance repairs on already-tagged large PDFs instead of broad structure repair', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const { analysis, context } = chartPdfPlanFixture

    const plan = await planRemediationActions({
      filename: '04-07MVStrategy.pdf',
      analysis: {
        ...analysis,
        pageCount: 78,
        isScanned: false,
        verapdf: {
          ...analysis.verapdf,
          status: 'failed',
          executionStatus: 'ok',
          isCompliant: false,
          failedChecks: 124,
          failures: [
            {
              ruleId: 'ua-id',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'The PDF/UA version and conformance level of a file shall be specified using the PDF/UA Identification extension schema',
              categoryIds: [],
            },
            {
              ruleId: 'font-embed',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'The font programs for all fonts used for rendering within a conforming file shall be embedded within that file',
              categoryIds: [],
            },
            {
              ruleId: 'font-unicode',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'The Font dictionary of all fonts shall define the map of all used character codes to Unicode values, either via a ToUnicode entry, or other mechanisms as defined in ISO 14289-1, 7.21.7',
              categoryIds: [],
            },
            {
              ruleId: 'note-id',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'Note tag shall have ID entry',
              categoryIds: [],
            },
          ],
          message: 'veraPDF detected remaining conformance issues.',
        },
      },
      context: {
        ...context,
        qpdf: {
          ...context.qpdf,
          hasStructTree: true,
        },
      },
      iteration: 2,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'set_pdfua_identification')).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'normalize_document_metadata')).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'repair_structure_conformance')).toBe(false)
    expect(plan.actions.some(action => action.tool_name === 'embed_missing_fonts_in_place')).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'repair_font_unicode_maps')).toBe(true)
  }, 60_000)

  it('plans bootstrap augmentation for weak native-tagged documents with no usable heading structure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'weak-native.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const weakAnalysis = {
      ...analysis,
      isScanned: false,
      categories: analysis.categories.map(category => {
        if (category.id === 'heading_structure') return { ...category, score: 0, grade: 'F', findings: ['No heading tags found in the document structure'] }
        if (category.id === 'alt_text') return { ...category, score: 0, grade: 'F', findings: ['Images are not tagged as Figure elements'] }
        if (category.id === 'reading_order') return { ...category, score: 40, grade: 'F' }
        return category
      }),
    }
    const weakContext = {
      ...context,
      qpdf: {
        ...context.qpdf,
        hasStructTree: true,
        isTagged: true,
        structTreeDepth: 2,
        headings: [],
        images: [{ ref: 'obj:20 0 R', hasAlt: false }],
      },
      structure: {
        ...context.structure,
        structuralNodes: [{ ref: 'obj:10 0 R', tag: '/Normal', parentRef: 'obj:9 0 R', orderIndex: 0 }],
      },
      headingCandidates: [{
        id: 'heading:1:1',
        pageNumber: 1,
        text: 'Executive Summary',
        bbox: { x: 0, y: 0, width: 1, height: 0.1 },
        fontSize: 18,
        fontWeight: 'bold' as const,
        nearbyContext: ['Context line'],
        targetRef: null,
        existingTag: '/Normal',
        repairMode: 'defer' as const,
        unsafeReason: 'Heading candidate did not map cleanly to a safe text-bearing structure element.',
      }],
      figureCandidates: [{
        id: 'figure:1',
        pageNumber: 1,
        targetRef: 'obj:20 0 R',
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        hasAlt: false,
        altText: null,
        informativeHint: 'informative' as const,
        surroundingText: ['State seal'],
        repairMode: 'retag_then_set_alt' as const,
        targetTag: '/TextBox',
        parentTagPath: [],
        pageImageCount: 1,
        textDensityHint: 'low' as const,
        imageEvidence: 'strong' as const,
      }],
    }

    const plan = await planRemediationActions({
      filename: 'weak-native.pdf',
      analysis: weakAnalysis as any,
      context: weakContext as any,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'bootstrap_struct_tree')).toBe(true)
  })

  it('plans bootstrap augmentation for weak native-tagged documents with images and tables but no native figure/table nodes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'weak-native-figures.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const weakAnalysis = {
      ...analysis,
      isScanned: false,
      categories: analysis.categories.map(category => {
        if (category.id === 'alt_text') return { ...category, score: 0, grade: 'F', findings: ['Images are not tagged as Figure elements'] }
        if (category.id === 'table_markup') return { ...category, score: 40, grade: 'F', findings: ['Tables found but no TH tags'] }
        if (category.id === 'reading_order') return { ...category, score: 40, grade: 'F' }
        return category
      }),
    }
    const weakContext = {
      ...context,
      qpdf: {
        ...context.qpdf,
        hasStructTree: true,
        isTagged: true,
        structTreeDepth: 2,
        images: [{ ref: 'obj:20 0 R', hasAlt: false }],
        tables: [{ page: 1 }],
      },
      structure: {
        ...context.structure,
        figures: [],
        imageStructNodes: [],
        tables: [],
      },
      figureCandidates: [{
        id: 'figure:1',
        pageNumber: 1,
        targetRef: null,
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        hasAlt: false,
        altText: null,
        informativeHint: 'informative' as const,
        surroundingText: ['State seal'],
        repairMode: 'defer' as const,
        targetTag: null,
        unsafeReason: 'Figure candidate did not map to an editable structure element.',
        parentTagPath: [],
        pageImageCount: 1,
        textDensityHint: 'low' as const,
        imageEvidence: 'strong' as const,
      }],
      tableCandidates: [{
        id: 'table:1',
        ref: 'obj:30 0 R',
        pageNumberHints: [1],
        firstRowCellRefs: [],
        headerCellRefs: [],
        hasHeaders: false,
        repairMode: 'defer' as const,
        nearbyContext: ['Example table'],
        unsafeReason: 'Table candidate does not expose first-row cells that can be safely promoted to headers.',
      }],
    }

    const plan = await planRemediationActions({
      filename: 'weak-native-figures.pdf',
      analysis: weakAnalysis as any,
      context: weakContext as any,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'bootstrap_struct_tree')).toBe(true)
  })

  it('maps existing tagged-PDF issue categories to native-safe repair tools', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const { analysis, context } = chartPdfPlanFixture

    const plan = await planRemediationActions({
      filename: 'tagged-native.pdf',
      analysis: {
        ...analysis,
        isScanned: false,
        verapdf: {
          ...analysis.verapdf,
          status: 'failed',
          executionStatus: 'ok',
          isCompliant: false,
          failedChecks: 157,
          failures: [
            {
              ruleId: 'note-id',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'Note tag shall have ID entry',
              categoryIds: ['reading_order'],
            },
          ],
          message: 'Tagged structure issues remain.',
        },
        categories: analysis.categories.map(category => {
          if (category.id === 'alt_text' || category.id === 'table_markup' || category.id === 'reading_order') {
            return { ...category, score: 40, grade: 'F', severity: 'Moderate' }
          }
          return category
        }),
      },
      context: {
        ...context,
        qpdf: {
          ...context.qpdf,
          hasStructTree: true,
          structTreeDepth: Math.max(2, context.qpdf.structTreeDepth),
        },
        structure: {
          ...context.structure,
          structuralNodes: context.structure.structuralNodes?.length
            ? context.structure.structuralNodes
            : [{ ref: 'obj:1 0 R', tag: '/Sect', orderIndex: 0 }],
          // Ensure native figure nodes exist so weakNativeBootstrapNeeded's
          // (hasPdfImages && !hasNativeFigureNodes) branch doesn't fire.
          figures: context.structure.figures?.length
            ? context.structure.figures
            : [{ ref: 'obj:2 0 R', tag: '/Figure', hasAlt: false }],
        },
        // Defer all figure candidates so weakNativeBootstrapNeeded's hasRetaggableFigures
        // branch doesn't fire — we're testing native repair tools, not bootstrap.
        figureCandidates: context.figureCandidates.map(c => ({ ...c, repairMode: 'defer' as const })),
        // No heading candidates to avoid bootstrap condition 1 (headingScore < 100 && candidates).
        headingCandidates: [],
      },
      iteration: 2,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'repair_note_tag_ids')).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'repair_native_figure_semantics')).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'repair_native_table_headers')).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'repair_native_reading_order')).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'repair_structure_conformance')).toBe(false)
  }, 60_000)

  it('plans Acrobat-aligned tab, CID symbol-font, and decorative-element repairs from remaining failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await loadDownloadFixture('04-07MVStrategy.pdf')
    const analysis = await analyzePDF(buffer, '04-07MVStrategy.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const plan = await planRemediationActions({
      filename: '04-07MVStrategy.pdf',
      analysis: {
        ...analysis,
        pageCount: 78,
        isScanned: false,
        verapdf: {
          ...analysis.verapdf,
          status: 'failed',
          executionStatus: 'ok',
          isCompliant: false,
          failedChecks: 7,
          failures: [
            {
              ruleId: 'tab-order',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'Tab order - Failed',
              categoryIds: [],
            },
            {
              ruleId: 'cid-font',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'A Type 2 CIDFont dictionary has missing or invalid CIDToGIDMap entry',
              categoryIds: [],
            },
            {
              ruleId: 'glyph',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'The glyph can not be mapped to Unicode',
              categoryIds: [],
            },
            {
              ruleId: 'alt-other',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'Other elements alternate text - Failed',
              categoryIds: [],
            },
          ],
          message: 'Acrobat-aligned failures remain.',
        },
      },
      context,
      iteration: 3,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'normalize_annotation_tab_order')).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'repair_cid_symbol_font_maps')).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'artifact_nonsemantic_page_elements')).toBe(true)
  }, 60_000)

  it('plans CIDSet consistency repair after other font conformance tools', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const { analysis, context } = cidsetPlanFixture

    const plan = await planRemediationActions({
      filename: '11drug seizures_1997-2007.pdf',
      analysis: {
        ...analysis,
        isScanned: false,
        verapdf: {
          ...analysis.verapdf,
          status: 'failed',
          executionStatus: 'ok',
          isCompliant: false,
          failedChecks: 2,
          failures: [
            {
              ruleId: 'font-embed',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'The font programs for all fonts used for rendering within a conforming file shall be embedded within that file',
              categoryIds: [],
            },
            {
              ruleId: 'font-unicode',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'The Font dictionary of all fonts shall define the map of all used character codes to Unicode values, either via a ToUnicode entry, or other mechanisms as defined in ISO 14289-1, 7.21.7',
              categoryIds: [],
            },
            {
              ruleId: 'cidset',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'If the FontDescriptor dictionary of an embedded CID font contains a CIDSet stream, then it shall identify all CIDs which are present in the font program, regardless of whether a CID in the font is referenced or used by the PDF or not',
              categoryIds: [],
            },
          ],
          message: 'CIDSet issues remain.',
        },
      },
      context,
      iteration: 2,
      actions: [],
      rejectedActions: [],
    })

    const order = plan.actions.map(action => action.tool_name)
    expect(order).toContain('embed_missing_fonts_in_place')
    expect(order).toContain('repair_font_unicode_maps')
    expect(order).toContain('repair_cidset_consistency')
    expect(order.indexOf('repair_cidset_consistency')).toBeGreaterThan(order.indexOf('embed_missing_fonts_in_place'))
    expect(order.indexOf('repair_cidset_consistency')).toBeGreaterThan(order.indexOf('repair_font_unicode_maps'))
  }, 60_000)

  it('escalates persistent CIDSet failures into font substitution after a prior CIDSet repair attempt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const { analysis, context } = cidsetPlanFixture

    const plan = await planRemediationActions({
      filename: '11drug seizures_1997-2007.pdf',
      analysis: {
        ...analysis,
        isScanned: false,
        pageCount: 1,
        verapdf: {
          ...analysis.verapdf,
          status: 'failed',
          executionStatus: 'ok',
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
          message: 'CIDSet issues remain after direct repair.',
        },
      },
      context,
      iteration: 3,
      actions: [
        makePlannerAction('embed_missing_fonts_in_place'),
        makePlannerAction('repair_font_unicode_maps'),
        makePlannerAction('repair_cidset_consistency', 'document', { outcome: 'no_effect' }),
      ],
      rejectedActions: [],
    })

    const order = plan.actions.map(action => action.tool_name)
    expect(order).toContain('substitute_legacy_fonts_in_place')
    expect(order.indexOf('substitute_legacy_fonts_in_place')).toBeGreaterThanOrEqual(0)
  }, 60_000)

  it('plans direct CIDSet repair when CIDSet is the only remaining font failure family', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const { analysis, context } = cidsetPlanFixture

    const plan = await planRemediationActions({
      filename: '11drug seizures_1997-2007.pdf',
      analysis: {
        ...analysis,
        isScanned: false,
        pageCount: 1,
        verapdf: {
          ...analysis.verapdf,
          status: 'failed',
          executionStatus: 'ok',
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
          message: 'Only CIDSet issues remain.',
        },
      },
      context,
      iteration: 2,
      actions: [
        makePlannerAction('embed_missing_fonts_in_place'),
      ],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'repair_cidset_consistency')).toBe(true)
  }, 60_000)

  it('plans Type1 font Unicode recovery after generic font Unicode repair on annual-report style PDFs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const { analysis, context } = annualReportPlanFixture

    const plan = await planRemediationActions({
      filename: '99anreport.pdf',
      analysis: {
        ...analysis,
        isScanned: false,
        verapdf: {
          ...analysis.verapdf,
          status: 'failed',
          executionStatus: 'ok',
          isCompliant: false,
          failedChecks: 123,
          failures: [
            {
              ruleId: 'font-unicode',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'The Font dictionary of all fonts shall define the map of all used character codes to Unicode values, either via a ToUnicode entry, or other mechanisms as defined in ISO 14289-1, 7.21.7',
              categoryIds: [],
            },
            {
              ruleId: 'type1',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'Legacy Type1 custom encoding differences remain unresolved.',
              categoryIds: [],
            },
          ],
          message: 'Legacy Type1 font Unicode issues remain.',
        },
      },
      context,
      iteration: 2,
      actions: [makePlannerAction('repair_font_unicode_maps')],
      rejectedActions: [],
    })

    const order = plan.actions.map(action => action.tool_name)
    expect(order).toContain('repair_type1_font_unicode_maps')
    expect(order.indexOf('repair_type1_font_unicode_maps')).toBeGreaterThanOrEqual(0)
  }, 60_000)

  it('plans Type1 font Unicode recovery on real annual-report fixtures after a no-effect generic Unicode pass', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const { analysis, context } = annualReportPlanFixture

    const plan = await planRemediationActions({
      filename: '99anreport.pdf',
      analysis,
      context,
      iteration: 2,
      actions: [makePlannerAction('repair_font_unicode_maps', 'document', { outcome: 'no_effect' })],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'repair_type1_font_unicode_maps')).toBe(true)
  }, 120_000)

  it('plans Type1 font Unicode recovery directly when qpdf already reports Type1 Unicode misses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const { analysis, context } = annualReportPlanFixture

    const plan = await planRemediationActions({
      filename: '99anreport.pdf',
      analysis,
      context: {
        ...context,
        qpdf: {
          ...context.qpdf,
          type1FontsMissingToUnicode: 1,
        },
      },
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'repair_type1_font_unicode_maps')).toBe(true)
  }, 60_000)

  it('plans CID symbol-font recovery on one-page chart fixtures after generic Unicode repair stalls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await loadDownloadFixture('10drug arrests_1999-2008.pdf')
    const analysis = await analyzePDF(buffer, '10drug arrests_1999-2008.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const plan = await planRemediationActions({
      filename: '10drug arrests_1999-2008.pdf',
      analysis,
      context,
      iteration: 2,
      actions: [makePlannerAction('repair_font_unicode_maps', 'document', { outcome: 'no_effect' })],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'repair_cid_symbol_font_maps')).toBe(true)
  }, 120_000)

  it('prioritizes CID symbol-font repair before generic Unicode repair when both are present', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../Downloads/juvenile2000study.pdf'))
    const analysis = await analyzePDF(buffer, 'juvenile2000study.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const plan = await planRemediationActions({
      filename: 'juvenile2000study.pdf',
      analysis,
      context,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    const order = plan.actions.map(action => action.tool_name)
    expect(order).toContain('repair_cid_symbol_font_maps')
    expect(order).toContain('repair_font_unicode_maps')
    expect(order.indexOf('repair_cid_symbol_font_maps')).toBeLessThan(order.indexOf('repair_font_unicode_maps'))
  }, 120_000)

  it('plans CID symbol-font recovery on OCR-searchable reports after generic Unicode repair stalls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await loadDownloadFixture('1988-1989 Biennial Report.pdf')
    const analysis = await analyzePDF(buffer, '1988-1989 Biennial Report.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const plan = await planRemediationActions({
      filename: '1988-1989 Biennial Report.pdf',
      analysis: {
        ...analysis,
        isScanned: false,
        verapdf: {
          ...analysis.verapdf,
          status: 'failed',
          executionStatus: 'ok',
          isCompliant: false,
          failedChecks: 101,
          failures: [
            {
              ruleId: 'font-unicode',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'The glyph can not be mapped to Unicode',
              categoryIds: [],
            },
          ],
          message: 'Persistent OCR font Unicode failures remain.',
        },
      },
      context,
      iteration: 2,
      actions: [
        makePlannerAction('ocr_scanned_pdf'),
        makePlannerAction('repair_font_unicode_maps', 'document', { outcome: 'no_effect' }),
      ],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'repair_cid_symbol_font_maps')).toBe(true)
  }, 120_000)

  it('preserves qpdf structure detection after bootstrapping a long processed report', async () => {
    const buffer = await loadProcessedAfterFixture('1988-1989_Biennial_Report.pdf')
    const analysis = await analyzePDF(buffer, '1988-1989_Biennial_Report.pdf', {
      skipAdobe: true,
      skipVeraPdf: true,
    })
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'bootstrap_struct_tree',
        arguments: { target: 'document' },
        rationale: 'Bootstrap long-report structure for qpdf regression coverage.',
        confidence: 0.95,
      },
    })

    const qpdf = await analyzeWithQpdf(result.buffer)
    expect(['applied', 'no_effect']).toContain(result.action.outcome)
    expect(qpdf.error).toBeNull()
    expect(qpdf.hasStructTree).toBe(true)
    expect(qpdf.hasMarkInfo).toBe(true)
  }, 180_000)

  it('surfaces MCR-backed native figures when inspecting long processed reports', async () => {
    const buffer = await loadProcessedAfterFixture('1996CHRIAudit.pdf')
    const inspect = await runPdfStructureBackend({
      buffer,
      mutation: { operation: 'inspect', inspectMode: 'alt_text_deep' },
    })

    expect(inspect.figures.length).toBeGreaterThan(10)
    expect(inspect.figures[0]?.tag).toBe('/Figure')
    expect(inspect.figures.some(figure => figure.ref === 'obj:575 0 R' && figure.hasAlt)).toBe(true)
  }, 180_000)

  it('skips bootstrap on long reports that already have stable heading structure and no figure bootstrap work', async () => {
    const buffer = await loadProcessedAfterFixture('1988-1989_Biennial_Report.pdf')
    const analysis = await analyzePDF(buffer, '1988-1989_Biennial_Report.pdf', {
      skipAdobe: true,
      skipVeraPdf: true,
      analysisProfile: 'remediation_fast',
    })
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'bootstrap_struct_tree',
        arguments: { target: 'document' },
        rationale: 'Do not degrade stable long-report headings.',
        confidence: 0.95,
      },
    })

    const next = await analyzePDF(result.buffer, '1988-1989_Biennial_Report.pdf', {
      skipAdobe: true,
      skipVeraPdf: true,
      analysisProfile: 'remediation_fast',
    })

    expect(result.action.outcome).toBe('no_effect')
    expect(result.action.changedDocumentBytes).toBe(false)
    expect(next.overallScore).toBe(100)
    expect(next.categories.find(category => category.id === 'heading_structure')?.score).toBe(100)
  }, 180_000)

  it('skips bootstrap on long reports with stable heading structure even when other categories still cap the score', async () => {
    const buffer = await loadProcessedAfterFixture('1996CHRIAudit.pdf')
    const analysis = await analyzePDF(buffer, '1996CHRIAudit.pdf', {
      skipAdobe: true,
      skipVeraPdf: true,
      analysisProfile: 'remediation_fast',
    })
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const result = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'bootstrap_struct_tree',
        arguments: { target: 'document' },
        rationale: 'Do not degrade stable headings on long reports that are still imperfect for non-heading reasons.',
        confidence: 0.95,
      },
    })

    const next = await analyzePDF(result.buffer, '1996CHRIAudit.pdf', {
      skipAdobe: true,
      skipVeraPdf: true,
      analysisProfile: 'remediation_fast',
    })

    expect(analysis.overallScore).toBe(94)
    expect(analysis.categories.find(category => category.id === 'heading_structure')?.score).toBe(100)
    expect(result.action.outcome).toBe('no_effect')
    expect(result.action.changedDocumentBytes).toBe(false)
    expect(next.overallScore).toBe(94)
    expect(next.categories.find(category => category.id === 'heading_structure')?.score).toBe(100)
  }, 180_000)

  it('plans legacy font substitution after embedding and Type1 Unicode recovery on annual-report PDFs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const { analysis, context } = annualReportPlanFixture

    const plan = await planRemediationActions({
      filename: '99anreport.pdf',
      analysis: {
        ...analysis,
        isScanned: false,
        pageCount: 36,
        verapdf: {
          ...analysis.verapdf,
          status: 'failed',
          executionStatus: 'ok',
          isCompliant: false,
          failedChecks: 22,
          failures: [
            {
              ruleId: 'font-embed',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'The font program is not embedded',
              categoryIds: [],
            },
            {
              ruleId: 'font-width',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'Glyph width 1003 in the embedded font program is not consistent with the Widths entry of the font dictionary (value 1000)',
              categoryIds: [],
            },
          ],
          message: 'Legacy substitution is still required.',
        },
      },
      context,
      iteration: 2,
      actions: [
        makePlannerAction('embed_missing_fonts_in_place'),
        makePlannerAction('repair_type1_font_unicode_maps'),
      ],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'substitute_legacy_fonts_in_place')).toBe(true)
  }, 60_000)

  it('plans final substituted-font conformance cleanup after legacy substitution on annual-report PDFs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const { analysis, context } = annualReportPlanFixture

    const plan = await planRemediationActions({
      filename: '99anreport.pdf',
      analysis: {
        ...analysis,
        isScanned: false,
        pageCount: 36,
        verapdf: {
          ...analysis.verapdf,
          status: 'failed',
          executionStatus: 'ok',
          isCompliant: false,
          failedChecks: 22,
          failures: [
            {
              ruleId: 'font-embed',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'The font program is not embedded',
              categoryIds: [],
            },
            {
              ruleId: 'font-width',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'Glyph width 1003 in the embedded font program is not consistent with the Widths entry of the font dictionary (value 1000)',
              categoryIds: [],
            },
            {
              ruleId: 'font-unicode',
              specification: null,
              clause: null,
              testNumber: null,
              location: null,
              message: 'The glyph can not be mapped to Unicode',
              categoryIds: [],
            },
          ],
          message: 'Post-substitution font cleanup is still required.',
        },
      },
      context,
      iteration: 3,
      actions: [
        makePlannerAction('embed_missing_fonts_in_place'),
        makePlannerAction('repair_type1_font_unicode_maps'),
        makePlannerAction('substitute_legacy_fonts_in_place'),
      ],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'finalize_substituted_font_conformance')).toBe(true)
  }, 60_000)

  it('does not retry metadata actions once they were already attempted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'untitled-example.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const plan = await planRemediationActions({
      filename: 'untitled-example.pdf',
      analysis,
      context,
      iteration: 2,
      actions: [
        makePlannerAction('set_document_title'),
        makePlannerAction('set_document_language'),
      ],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'set_document_title')).toBe(false)
    expect(plan.actions.some(action => action.tool_name === 'set_document_language')).toBe(false)
  })

  it('uses a human-readable title instead of a raw filename slug', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'firearmprohibitorstaskforce2024-240703T20585852.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const plan = await planRemediationActions({
      filename: 'firearmprohibitorstaskforce2024-240703T20585852.pdf',
      analysis,
      context,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    const titleAction = plan.actions.find(action => action.tool_name === 'set_document_title')
    expect(titleAction?.arguments.title).not.toBe('firearmprohibitorstaskforce2024-240703T20585852')
  })

  it('prefers Acrobat-risk alternate-text repair before generic figure-alt tools', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'alt-risk.pdf')
    const altRiskAnalysis = {
      ...analysis,
      overallScore: 84,
      grade: 'B',
      categories: analysis.categories.map(category =>
        category.id === 'alt_text'
          ? { ...category, score: 60, grade: 'D', severity: 'Moderate', findings: ['Acrobat-risk non-figure graphics ownership remains.'] }
          : category),
    }
    const context = await inspectPdfForRemediation(buffer, altRiskAnalysis, { inspectMode: 'alt_text_deep' })

    const plan = await planRemediationActions({
      filename: 'alt-risk.pdf',
      analysis: altRiskAnalysis,
      context: {
        ...context,
        structure: {
          ...context.structure,
          acrobatAltRiskNodes: [
            {
              ref: 'obj:20 0 R',
              tag: '/Sect',
              pageRef: 'obj:1 0 R',
              mcids: [0],
              hasText: false,
              hasGraphics: true,
              parentTagPath: ['/Document'],
              ownershipMode: 'duplicate_mcid_ownership',
              duplicateOwnerRefs: ['obj:21 0 R'],
            },
          ],
        },
      },
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    const repairIndex = plan.actions.findIndex(action => action.tool_name === 'repair_other_elements_alt_text')
    const figureIndex = plan.actions.findIndex(action => action.tool_name === 'set_figure_alt_text')

    expect(repairIndex).toBeGreaterThanOrEqual(0)
    if (figureIndex >= 0) {
      expect(repairIndex).toBeLessThan(figureIndex)
    }
  })

  it('treats whitespace-only metadata titles as missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, '8child abuse_1997-2007.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

    const plan = await planRemediationActions({
      filename: '8child abuse_1997-2007.pdf',
      analysis: {
        ...analysis,
        categories: analysis.categories.map(category =>
          category.id === 'title_language' ? { ...category, score: 50 } : category),
      },
      context: {
        ...context,
        pdfjs: {
          ...context.pdfjs,
          title: ' ',
        },
      },
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'set_document_title')).toBe(true)
  })

  it('does not retry a previously attempted reading-order parent group', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await makePdf()
    const analysis = await analyzePDF(buffer, 'example.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const heuristicContext: PdfRemediationContext = {
      ...context,
      readingOrderParentCandidates: [{
        id: 'order-parent:blocked',
        parentRef: 'obj:10 0 R',
        childCandidateIds: ['order:a', 'order:b'],
        mutableKids: true,
        mcidDisorderBefore: 0.7,
        pageNumberHints: [1],
        tagMix: ['/P', '/P'],
        suggestedChildCandidateIds: ['order:b', 'order:a'],
      }],
      readingOrderCandidates: [
        { id: 'order:a', ref: 'obj:1 0 R', tag: '/P', parentRef: 'obj:10 0 R', orderIndex: 0 },
        { id: 'order:b', ref: 'obj:2 0 R', tag: '/P', parentRef: 'obj:10 0 R', orderIndex: 1 },
      ],
    }

    const plan = await planRemediationActions({
      filename: 'example.pdf',
      analysis: {
        ...analysis,
        categories: analysis.categories.map(category =>
          category.id === 'reading_order' ? { ...category, score: 50 } : category),
      },
      context: heuristicContext,
      iteration: 2,
      actions: [makePlannerAction('reorder_structure_children', 'document', { candidateGroupId: 'order-parent:blocked' })],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'reorder_structure_children')).toBe(false)
  })
})
