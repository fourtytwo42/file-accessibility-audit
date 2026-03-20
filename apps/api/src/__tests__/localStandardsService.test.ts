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
    unembeddedType3FontCount: 0,
    fontsMissingToUnicode: 0,
    cidFontsMissingCidToGidMap: 0,
    cidSetRiskFontCount: 0,
    cidSetExplicitFontCount: 0,
    legacyWidthRiskFontCount: 0,
    noteTagCount: 0,
    noteTagsMissingId: 0,
    linkAnnotationCount: 0,
    linkStructCount: 0,
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
  it('prefers qpdf link contents evidence over pdfjs null contents when qpdf sees populated annotations', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        linkAnnotationCount: 1,
        linkAnnotationsMissingContents: 0,
      }),
      makePdfjs({
        links: [{ url: 'https://example.com', text: 'Example', contents: null }],
      }),
      {
        tabOrder: makeTabOrder(),
        structure: makeStructure(),
      },
    )

    expect(report.findings.some(entry => entry.key === 'pdfua.annotation_alt_contents')).toBe(false)
  })

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

  it('suppresses link-tagging findings when qpdf confirms matching /Link structure nodes', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        hasStructTree: true,
        linkAnnotationCount: 3,
        linkStructCount: 3,
      }),
      makePdfjs({
        links: [
          { url: 'https://example.com/a', text: 'A', contents: 'A' },
          { url: 'https://example.com/b', text: 'B', contents: 'B' },
          { url: 'https://example.com/c', text: 'C', contents: 'C' },
        ],
      }),
      { structure: makeStructure({ structuralNodes: [] as any }) },
    )

    expect(report.findings.some(entry => entry.key === 'pdfua.link_tagging')).toBe(false)
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

  it('suppresses blocking font-embedding findings when only residual Type3 fonts remain and Unicode is intact', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        unembeddedFontCount: 3,
        unembeddedType3FontCount: 3,
        fontsMissingToUnicode: 0,
      }),
      makePdfjs(),
      { structure: makeStructure() },
    )

    expect(report.findings.some(entry => entry.key === 'pdfua.font_embedding')).toBe(false)
  })

  it('emits CIDSet consistency findings for explicit or inferred CID-font risk', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({ cidSetRiskFontCount: 2, cidSetExplicitFontCount: 1 }),
      makePdfjs(),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.cidset_consistency')
    expect(finding?.count).toBe(2)
    expect(finding?.categoryIds).toContain('text_extractability')
    expect(finding?.inferred).toBe(true)
  })

  it('emits note-tag ID findings when note structure elements are missing /ID', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({ noteTagCount: 3, noteTagsMissingId: 2 }),
      makePdfjs(),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.note_tag_id')
    expect(finding?.count).toBe(2)
    expect(finding?.inferred).toBe(false)
    expect(finding?.categoryIds).toContain('reading_order')
  })

  it('emits inferred logical-structure findings when tags are too weak to prove content coverage', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        hasStructTree: true,
        hasMarkInfo: true,
        marked: true,
        structTreeDepth: 1,
        contentOrder: [],
      }),
      makePdfjs({ textLength: 400, hasText: true }),
      { structure: makeStructure({ structuralNodes: [{ ref: 'obj:1 0 R', tag: '/Document', orderIndex: 0 }] as any }) },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.logical_structure')
    expect(finding).toBeDefined()
    expect(finding?.blocking).toBe(true)
    expect(finding?.inferred).toBe(true)
  })

  it('emits document-language findings when qpdf and pdfjs language signals are inconsistent', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({ hasLang: true, lang: 'en-US' }),
      makePdfjs({ lang: 'english_us' }),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.document_language')
    expect(finding).toBeDefined()
    expect(finding?.inferred).toBe(true)
  })

  it('emits document-language findings when language tags are non-canonical', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({ hasLang: true, lang: 'EN-US' }),
      makePdfjs({ lang: 'EN-US' }),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.document_language')
    expect(finding).toBeDefined()
    expect(finding?.inferred).toBe(true)
  })

  it('does not emit inferred logical-structure findings when figure nodes already exist without image structure nodes', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        hasStructTree: true,
        hasMarkInfo: true,
        marked: true,
        images: [{ ref: 'obj:2 0 R', hasAlt: false }],
      }),
      makePdfjs({ textLength: 2000, hasText: true }),
      {
        structure: makeStructure({
          structuralNodes: [
            { ref: 'obj:1 0 R', tag: '/Document', orderIndex: 0 },
            { ref: 'obj:2 0 R', tag: '/Sect', orderIndex: 1 },
          ] as any,
          figures: [{ ref: 'obj:3 0 R', pageNumber: 1, hasAlt: false, altText: null }] as any,
          imageStructNodes: [],
        }),
      },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.logical_structure')
    expect(finding).toBeUndefined()
  })

  it('emits inferred logical-structure findings for artifact-mixing risk in tagged image-heavy files', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        hasStructTree: true,
        hasMarkInfo: true,
        marked: true,
        images: [{ ref: 'obj:2 0 R', hasAlt: false }],
        contentOrder: [0, 1, 2],
      }),
      makePdfjs({ textLength: 4000, hasText: true }),
      {
        structure: makeStructure({
          structuralNodes: [{ ref: 'obj:1 0 R', tag: '/Document', orderIndex: 0 }] as any,
          figures: [{ ref: 'obj:3 0 R', pageNumber: 1, hasAlt: false, altText: null }] as any,
          imageStructNodes: [{ ref: 'obj:4 0 R', tag: '/Figure', hasAlt: false }] as any,
          acrobatAltRiskNodes: new Array(6).fill(null).map((_, index) => ({ ref: `obj:${index + 10} 0 R`, tag: '/P' })) as any,
          readingOrderNodes: [],
        }),
      },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.logical_structure')
    expect(finding).toBeDefined()
    expect(finding?.inferred).toBe(true)
    expect(finding?.blocking).toBe(true)
  })
})
