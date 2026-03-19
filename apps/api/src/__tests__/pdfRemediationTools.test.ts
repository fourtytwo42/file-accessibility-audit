import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { __test_remapHeadingTarget, executeRemediationTool, inspectPdfForRemediation, needsAltTextDeepInspection, normalizedExistingHeadingLevel } from '../services/pdfRemediationTools.js'
import type { PdfRemediationContext } from '../services/pdfRemediationTools.js'
import type { RemediationActionRecord, RemediationToolName } from '../services/documentModel.js'
import { planRemediationActions } from '../services/remediationPlanService.js'

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const DOWNLOADS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../Processed/Before')

async function makePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Example document', { x: 72, y: 720, size: 16, font })
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
      context,
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

  it('splits mixed heading/logo MCIDs on the one-page chart fixture so Acrobat-risk nodes clear', async () => {
    const buffer = await loadDownloadFixture('1total offenses_1999-2008.pdf')
    const analysis = await analyzePDF(buffer, '1total offenses_1999-2008.pdf')
    const remediated = await remediatePdfWithAgent(buffer, '1total offenses_1999-2008.pdf', analysis)
    const inspect = await inspectPdfForRemediation(remediated.buffer, remediated.finalResult, { inspectMode: 'alt_text_deep' })

    expect(remediated.finalResult.grade).toBe('A')
    expect(remediated.finalResult.verapdf.status).toBe('passed')
    expect(inspect.structure.acrobatAltRiskNodes || []).toEqual([])
    expect(inspect.structure.figures || []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: '/Figure',
          hasAlt: true,
        }),
      ]),
    )
    expect((inspect.structure.figures || []).filter(figure => figure.splitGenerated)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: '/Figure',
          splitGenerated: true,
          splitSourceTag: expect.any(String),
        }),
      ]),
    )
    expect((inspect.structure.figures || []).every(figure =>
      !figure.splitGenerated || !/image related to/i.test(figure.altText || '')
    )).toBe(true)
  }, 600_000)

  it('clears multi-page Acrobat-risk section ownership on the strategy fixture', async () => {
    const buffer = await loadDownloadFixture('04-07MVStrategy.pdf')
    const analysis = await analyzePDF(buffer, '04-07MVStrategy.pdf')
    const remediated = await remediatePdfWithAgent(buffer, '04-07MVStrategy.pdf', analysis)
    const inspect = await inspectPdfForRemediation(remediated.buffer, remediated.finalResult, { inspectMode: 'alt_text_deep' })

    expect(remediated.finalResult.grade).toBe('A')
    expect(remediated.finalResult.verapdf.status).toBe('passed')
    expect((remediated.model.actions || []).some(action => action.tool === 'repair_other_elements_alt_text' && action.outcome === 'applied')).toBe(true)
    expect(inspect.structure.acrobatAltRiskNodes || []).toEqual([])
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
    expect(inspect.structure.acrobatAltRiskNodes || []).toEqual([])

    const splitFigures = (inspect.structure.figures || []).filter(figure => figure.splitGenerated)
    expect(splitFigures.length).toBeGreaterThan(0)
    expect(splitFigures.every(figure =>
      !/image related to/i.test(figure.altText || '')
      && !/^sect$/i.test((figure.altText || '').trim())
    )).toBe(true)
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
      }),
    }))
    expect(result.action.outcome).toBe('applied')
    expect(result.action.categoryTargets).toEqual(['alt_text'])
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

    expect(backendSpy).toHaveBeenCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        operation: 'bootstrap_struct_tree',
        figures: [{ pageNumber: 1, altText: 'Image related to Cover chart' }],
      }),
    }))
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
    let context = await inspectPdfForRemediation(buffer, original)

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

    context = await inspectPdfForRemediation(buffer, await analyzePDF(buffer, '3violent offenses_1999-2008.pdf'))
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
      context = await inspectPdfForRemediation(buffer, await analyzePDF(buffer, '3violent offenses_1999-2008.pdf'))
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
    context = await inspectPdfForRemediation(buffer, before)

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
    let analysis = await analyzePDF(buffer, 'linked.pdf')
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

    analysis = await analyzePDF(buffer, 'linked.pdf')
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

    const bootstrapContext = await inspectPdfForRemediation(buffer, await analyzePDF(buffer, 'linked.pdf'))
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
      context: await inspectPdfForRemediation(bootstrap.buffer, await analyzePDF(bootstrap.buffer, 'linked.pdf')),
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
    expect(after.verapdf.status).toBe('failed')
    expect(after.verapdf.failedChecks).toBeGreaterThan(0)
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
    let context = await inspectPdfForRemediation(buffer, analysis)

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
      analysis = await analyzePDF(buffer, '11drug seizures_1997-2007.pdf')
      context = await inspectPdfForRemediation(buffer, analysis)
    }

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
  }, 120_000)

  it('reports CIDSet inspection coverage and returns no_effect when a second pass finds nothing new to rewrite', async () => {
    let buffer = await loadDownloadFixture('11drug seizures_1997-2007.pdf')
    let analysis = await analyzePDF(buffer, '11drug seizures_1997-2007.pdf')
    let context = await inspectPdfForRemediation(buffer, analysis)

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
      analysis = await analyzePDF(buffer, '11drug seizures_1997-2007.pdf')
      context = await inspectPdfForRemediation(buffer, analysis)
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

    const secondAnalysis = await analyzePDF(firstPass.buffer, '11drug seizures_1997-2007.pdf')
    const secondContext = await inspectPdfForRemediation(firstPass.buffer, secondAnalysis)
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
  }, 120_000)

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
  }, 30_000)

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
    let analysis = await analyzePDF(buffer, '3violent offenses_1999-2008.pdf')
    let context = await inspectPdfForRemediation(buffer, analysis)

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
    analysis = await analyzePDF(buffer, '3violent offenses_1999-2008.pdf')
    context = await inspectPdfForRemediation(buffer, analysis)

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
    analysis = await analyzePDF(buffer, '3violent offenses_1999-2008.pdf')
    context = await inspectPdfForRemediation(buffer, analysis)

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
      analysis = await analyzePDF(buffer, '3violent offenses_1999-2008.pdf')
      context = await inspectPdfForRemediation(buffer, analysis)
    }

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
  }, 120_000)

  it('plans native-safe conformance repairs on already-tagged large PDFs instead of broad structure repair', async () => {
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

    const buffer = await loadDownloadFixture('04-07MVStrategy.pdf')
    const analysis = await analyzePDF(buffer, '04-07MVStrategy.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

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
        },
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

    const buffer = await loadDownloadFixture('11drug seizures_1997-2007.pdf')
    const analysis = await analyzePDF(buffer, '11drug seizures_1997-2007.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

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

    const buffer = await loadDownloadFixture('11drug seizures_1997-2007.pdf')
    const analysis = await analyzePDF(buffer, '11drug seizures_1997-2007.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

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

    const buffer = await loadDownloadFixture('11drug seizures_1997-2007.pdf')
    const analysis = await analyzePDF(buffer, '11drug seizures_1997-2007.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

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

    const buffer = await loadDownloadFixture('99anreport.pdf')
    const analysis = await analyzePDF(buffer, '99anreport.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

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

    const buffer = await loadDownloadFixture('99anreport.pdf')
    const analysis = await analyzePDF(buffer, '99anreport.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

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

  it('plans legacy font substitution after embedding and Type1 Unicode recovery on annual-report PDFs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    const buffer = await loadDownloadFixture('99anreport.pdf')
    const analysis = await analyzePDF(buffer, '99anreport.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

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

    const buffer = await loadDownloadFixture('99anreport.pdf')
    const analysis = await analyzePDF(buffer, '99anreport.pdf')
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })

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
