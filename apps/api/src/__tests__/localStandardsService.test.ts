import { describe, expect, it } from 'vitest'
import { buildLocalStandardsReport } from '../services/localStandardsService.js'
import type { QpdfResult } from '../services/qpdfService.js'
import type { PdfjsResult } from '../services/pdfjsService.js'
import type { TabOrderResult } from '../services/tabOrderService.js'
import type { StructureBackendMutationResult } from '../services/pdfStructureBackend.js'

function makeQpdf(overrides: Partial<QpdfResult> = {}): QpdfResult {
  return {
    hasStructTree: true,
    isTagged: true,
    hasMarkInfo: true,
    marked: true,
    hasLang: true,
    lang: 'en-US',
    hasOutlines: false,
    outlineCount: 0,
    outlineTitles: [],
    displayDocTitle: true,
    metadataRef: 'obj:1 0 R',
    metadataTypeValid: true,
    metadataSubtypeXml: true,
    hasAcroForm: false,
    formFields: [],
    fontCount: 1,
    unembeddedFontCount: 0,
    fontsMissingToUnicode: 0,
    cidFontsMissingCidToGidMap: 0,
    legacyWidthRiskFontCount: 0,
    linkAnnotationCount: 0,
    linkAnnotationsMissingContents: 0,
    images: [],
    headings: [],
    tables: [],
    structTreeDepth: 3,
    contentOrder: [0, 1],
    annotationCount: 0,
    error: null,
    ...overrides,
  }
}

function makePdfjs(overrides: Partial<PdfjsResult> = {}): PdfjsResult {
  return {
    pageCount: 1,
    hasText: true,
    textLength: 100,
    title: 'Example',
    author: null,
    subject: null,
    lang: 'en-US',
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
    ...overrides,
  }
}

function makeTabOrder(overrides: Partial<TabOrderResult> = {}): TabOrderResult {
  return {
    status: 'ok',
    pagesAnalyzed: 1,
    annotatedPageCount: 0,
    missingTabsCount: 0,
    outOfOrderPageCount: 0,
    issues: [],
    warnings: [],
    ...overrides,
  }
}

function makeStructure(overrides: Partial<StructureBackendMutationResult> = {}): StructureBackendMutationResult {
  return {
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
    ...overrides,
  }
}

describe('buildLocalStandardsReport', () => {
  it('emits page-tabs findings from tab-order analysis', () => {
    const report = buildLocalStandardsReport(makeQpdf(), makePdfjs(), {
      tabOrder: makeTabOrder({
        annotatedPageCount: 2,
        missingTabsCount: 1,
        outOfOrderPageCount: 1,
      }),
      structure: makeStructure(),
    })

    const finding = report.findings.find(entry => entry.key === 'pdfua.page_tabs')
    expect(finding?.count).toBe(2)
    expect(finding?.categoryIds).toContain('reading_order')
  })

  it('emits annotation-contents findings for links with missing /Contents', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({ linkAnnotationCount: 2, linkAnnotationsMissingContents: 2 }),
      makePdfjs({
        links: [
          { url: 'https://example.com/a', text: 'Example A', contents: null },
          { url: 'https://example.com/b', text: 'Example B', contents: '' },
        ],
      }),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.annotation_alt_contents')
    expect(finding?.count).toBe(2)
    expect(finding?.categoryIds).toContain('link_quality')
  })

  it('emits link-tagging findings when links exist without /Link structure nodes', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({ hasStructTree: true, linkAnnotationCount: 3 }),
      makePdfjs({
        links: [
          { url: 'https://example.com/a', text: 'A', contents: 'A' },
          { url: 'https://example.com/b', text: 'B', contents: 'B' },
          { url: 'https://example.com/c', text: 'C', contents: 'C' },
        ],
      }),
      { structure: makeStructure({ structuralNodes: [{ ref: 'obj:1 0 R', tag: '/P', orderIndex: 0 }] as any }) },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.link_tagging')
    expect(finding).toBeDefined()
    expect(finding?.categoryIds).toContain('reading_order')
  })

  it('emits inferred font-width findings from risky legacy simple fonts', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({ legacyWidthRiskFontCount: 4 }),
      makePdfjs(),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.font_widths')
    expect(finding?.count).toBe(4)
    expect(finding?.inferred).toBe(true)
  })
})
