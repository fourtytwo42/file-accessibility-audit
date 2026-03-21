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
    unownedAnnotationCount: 0,
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
    untaggedTopLevelContentGroups: [],
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

  it('emits tagged-annotations findings when visible annotations are missing StructParent ownership', () => {
    const report = buildLocalStandardsReport(makeQpdf(), makePdfjs(), {
      tabOrder: makeTabOrder({
        annotatedPageCount: 1,
        unownedAnnotationCount: 3,
      }),
      structure: makeStructure(),
    })

    const finding = report.findings.find(entry => entry.key === 'pdfua.tagged_annotations')
    expect(finding?.count).toBe(3)
    expect(finding?.blocking).toBe(true)
    expect(finding?.categoryIds).toContain('pdf_ua_compliance')
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

  it('downgrades proxy-only missing ToUnicode debt to an advisory finding', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        fontsMissingToUnicode: 2,
        fontsMissingToUnicodeBlocking: 0,
        fontsMissingToUnicodeProxy: 1,
        fontsMissingToUnicodeAdvisory: 1,
      }),
      makePdfjs(),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.font_unicode')
    expect(finding?.blocking).toBe(false)
    expect(finding?.severity).toBe('warning')
    expect(finding?.count).toBe(2)
  })

  it('keeps true text-font missing ToUnicode debt blocking', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        fontsMissingToUnicode: 2,
        fontsMissingToUnicodeBlocking: 2,
      }),
      makePdfjs(),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.font_unicode')
    expect(finding?.blocking).toBe(true)
    expect(finding?.severity).toBe('error')
    expect(finding?.count).toBe(2)
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

  it('emits blocking logical-structure findings for unmapped non-standard role tags', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        hasStructTree: true,
        hasMarkInfo: true,
        marked: true,
        unmappedRoleMapTagCount: 2,
        unmappedRoleMapTags: ['/Lbody', '/CustomThing'],
      }),
      makePdfjs({ textLength: 400, hasText: true }),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.logical_structure')
    expect(finding).toBeDefined()
    expect(finding?.blocking).toBe(true)
    expect(finding?.inferred).toBe(false)
    expect(finding?.count).toBe(2)
    expect(finding?.evidence.some(entry => entry.includes('/Lbody'))).toBe(true)
  })

  it('suppresses content-order-only logical-structure debt when other semantic structure is already present', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        hasStructTree: true,
        hasMarkInfo: true,
        marked: true,
        structTreeDepth: 2,
        contentOrder: [],
        headings: [{ tag: '/H1', text: 'Heading' }] as any,
      }),
      makePdfjs({ textLength: 400, hasText: true }),
      {
        structure: makeStructure({
          structuralNodes: [
            { ref: 'obj:1 0 R', tag: '/Document', orderIndex: 0 },
            { ref: 'obj:2 0 R', tag: '/H1', orderIndex: 1 },
          ] as any,
        }),
      },
    )

    expect(report.findings.some(entry =>
      entry.key === 'pdfua.logical_structure'
      && entry.evidence.some(evidence => evidence.includes('no content-order MCID trace'))
    )).toBe(false)
  })

  it('emits inferred logical-structure findings for untagged top-level page content groups', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        hasStructTree: true,
        hasMarkInfo: true,
        marked: true,
        structTreeDepth: 2,
        contentOrder: [0, 1, 2],
      }),
      makePdfjs({ textLength: 1200, hasText: true }),
      {
        structure: makeStructure({
          structuralNodes: [
            { ref: 'obj:1 0 R', tag: '/Document', orderIndex: 0 },
            { ref: 'obj:2 0 R', tag: '/Sect', orderIndex: 1 },
          ] as any,
          untaggedTopLevelContentGroups: [
            { ref: 'obj:7 0 R:group:0', pageRef: 'obj:7 0 R', pageNumber: 1, groupIndex: 0, hasText: true, hasGraphics: true, kind: 'text+graphics' },
            { ref: 'obj:8 0 R:group:0', pageRef: 'obj:8 0 R', pageNumber: 2, groupIndex: 0, hasText: true, hasGraphics: true, kind: 'text+graphics' },
          ] as any,
        }),
      },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.logical_structure')
    expect(finding).toBeDefined()
    expect(finding?.blocking).toBe(true)
    expect(finding?.inferred).toBe(true)
    expect(finding?.count).toBeGreaterThanOrEqual(2)
    expect(finding?.evidence.some(entry => entry.includes('untagged top-level page content group'))).toBe(true)
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

  it('does not emit inferred logical-structure findings solely because tagged files contain images without recovered image nodes', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        hasStructTree: true,
        hasMarkInfo: true,
        marked: true,
        images: [{ ref: 'obj:2 0 R', hasAlt: true }, { ref: 'obj:3 0 R', hasAlt: true }],
        contentOrder: [0, 1, 2],
        structTreeDepth: 3,
      }),
      makePdfjs({ textLength: 3000, hasText: true }),
      {
        structure: makeStructure({
          structuralNodes: [
            { ref: 'obj:1 0 R', tag: '/Document', orderIndex: 0 },
            { ref: 'obj:4 0 R', tag: '/Sect', orderIndex: 1 },
            { ref: 'obj:5 0 R', tag: '/P', orderIndex: 2 },
          ] as any,
          figures: [],
          imageStructNodes: [],
          acrobatAltRiskNodes: [],
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

  it('treats raw untagged image ownership as substantive logical-structure debt even when the image looks decorative', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        hasStructTree: true,
        hasMarkInfo: true,
        marked: true,
        images: [{ ref: 'obj:2 0 R', hasAlt: true }],
        contentOrder: [0, 1, 2],
      }),
      makePdfjs({ textLength: 4000, hasText: true }),
      {
        structure: makeStructure({
          structuralNodes: [{ ref: 'obj:1 0 R', tag: '/Document', orderIndex: 0 }] as any,
          figures: [{ ref: 'obj:3 0 R', pageNumber: 1, hasAlt: true, altText: 'Seal' }] as any,
          imageStructNodes: [{ ref: 'obj:4 0 R', tag: '/Figure', hasAlt: true }] as any,
          acrobatAltRiskNodes: [
            {
              ref: 'page:1:raw:/Im1',
              tag: '(untagged)',
              pageRef: 'obj:5 0 R',
              mcids: [],
              hasText: false,
              hasGraphics: true,
              hasAlt: false,
              splitSafe: false,
              graphicsLikelyDecorative: true,
              ownershipMode: 'untagged_image_direct',
            },
          ] as any,
          readingOrderNodes: [],
        }),
      },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.logical_structure')
    expect(finding).toBeDefined()
    expect(finding?.inferred).toBe(true)
    expect(finding?.blocking).toBe(true)
  })

  it('emits untagged-rendered-images findings for Acrobat untagged image ownership nodes', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({ images: [{ ref: 'obj:2 0 R', hasAlt: false }] }),
      makePdfjs({ imageCount: 1 }),
      {
        structure: makeStructure({
          acrobatAltRiskNodes: [{
            ref: 'page:1:raw:/Im1',
            tag: '(untagged)',
            pageRef: 'obj:5 0 R',
            mcids: [],
            hasText: false,
            hasGraphics: true,
            hasAlt: false,
            ownershipMode: 'untagged_image_direct',
          }] as any,
        }),
      },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.untagged_rendered_images')
    expect(finding?.count).toBe(1)
    expect(finding?.blocking).toBe(true)
  })

  it('emits nonfigure-with-alt findings for invalid Alt ownership', () => {
    const report = buildLocalStandardsReport(
      makeQpdf(),
      makePdfjs(),
      {
        structure: makeStructure({
          acrobatAltRiskNodes: [{
            ref: 'obj:11 0 R',
            tag: '/P',
            hasAlt: true,
            ownershipMode: 'nonfigure_with_alt',
          }] as any,
        }),
      },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.nonfigure_with_alt')
    expect(finding?.count).toBe(1)
    expect(finding?.blocking).toBe(true)
  })

  it('emits nested-alt findings when parent figure alt hides child semantic content', () => {
    const report = buildLocalStandardsReport(
      makeQpdf(),
      makePdfjs(),
      {
        structure: makeStructure({
          acrobatAltRiskNodes: [{
            ref: 'obj:12 0 R',
            tag: '/Figure',
            hasAlt: true,
            ownershipMode: 'nested_alt_text_hides_content',
          }] as any,
        }),
      },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.nested_alt_text')
    expect(finding?.count).toBe(1)
    expect(finding?.blocking).toBe(true)
  })

  it('emits table-regularity findings for irregular tagged tables', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        tables: [
          { hasHeaders: true, rowCellCounts: [6, 11, 11], dominantColumnCount: 11, isRegular: false },
          { hasHeaders: true, rowCellCounts: [4, 4, 4], dominantColumnCount: 4, isRegular: true },
        ],
      }),
      makePdfjs(),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.table_regularity')
    expect(finding).toBeDefined()
    expect(finding?.count).toBe(1)
    expect(finding?.categoryIds).toContain('table_markup')
    expect(finding?.blocking).toBe(true)
  })

  it('treats mostly regular short-row tables as advisory', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        tables: [
          { hasHeaders: true, rowCellCounts: [4, 5, 5, 5, 5, 5, 5, 2, 5, 5], dominantColumnCount: 5, isRegular: false, headerRowCount: 1, maxRowSpan: 1, maxColSpan: 1 },
        ],
      }),
      makePdfjs(),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.table_regularity')
    expect(finding).toBeUndefined()
  })

  it('emits figure alt-quality findings for generic alternate text', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        images: [
          { ref: '10 0 R', hasAlt: true, altText: 'image' },
        ],
      }),
      makePdfjs(),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.figure_alt_quality')
    expect(finding).toBeDefined()
    expect(finding?.categoryIds).toContain('alt_text')
    expect(finding?.blocking).toBe(false)
  })

  it('emits figure alt-quality findings for boilerplate alternate text', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        images: [
          { ref: '10 0 R', hasAlt: true, altText: 'Image of a county seal' },
        ],
      }),
      makePdfjs(),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.figure_alt_quality')
    expect(finding).toBeDefined()
    expect(finding?.count).toBe(1)
  })

  it('emits figure alt-quality findings for unreadable glyph-soup alternate text', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        images: [
          { ref: '10 0 R', hasAlt: true, altText: 'Ŗ œ œ h Ǝ Ǥ ™ † Ä Ü T â Ù e' },
        ],
      }),
      makePdfjs(),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.figure_alt_quality')
    expect(finding).toBeDefined()
    expect(finding?.count).toBe(1)
  })

  it('emits figure alt-quality findings for body-prose fragment alternate text', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        images: [
          { ref: '10 0 R', hasAlt: true, altText: 'emotional than men. 17 In addition, police culture may lead to skepticism, cynicism, and' },
        ],
      }),
      makePdfjs(),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.figure_alt_quality')
    expect(finding).toBeDefined()
    expect(finding?.count).toBe(1)
  })

  it('emits figure alt-quality findings for bibliography-like alternate text', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        images: [
          { ref: '10 0 R', hasAlt: true, altText: 'Management , 36 (1), 91-118' },
        ],
      }),
      makePdfjs(),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.figure_alt_quality')
    expect(finding).toBeDefined()
    expect(finding?.count).toBe(1)
  })

  it('emits heading-content findings for missing H1 and generic heading text', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        headings: [
          { level: 'H2', tag: '/H2' },
        ],
      }),
      makePdfjs(),
      {
        structure: makeStructure({
          headings: [
            { ref: 'obj:12 0 R', tag: '/H2', text: 'Heading' },
          ],
        }),
      },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.heading_content_quality')
    expect(finding).toBeDefined()
    expect(finding?.categoryIds).toContain('heading_structure')
  })

  it('does not treat all-unreadable heading snapshots as empty-heading failures by themselves', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        headings: [
          { level: 'H1', tag: '/H1' },
          { level: 'H2', tag: '/H2' },
        ],
      }),
      makePdfjs(),
      {
        structure: makeStructure({
          headings: [
            { ref: 'obj:50 0 R', tag: '/H1', text: null },
            { ref: 'obj:51 0 R', tag: '/H2', text: '' },
          ],
        }),
      },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.heading_content_quality')
    expect(finding).toBeUndefined()
  })

  it('does not treat mostly-unreadable heading snapshots as empty-heading failures without reliable text coverage', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        headings: [
          { level: 'H1', tag: '/H1' },
          { level: 'H1', tag: '/H1' },
          { level: 'H1', tag: '/H1' },
        ],
      }),
      makePdfjs(),
      {
        structure: makeStructure({
          headings: [
            { ref: 'obj:50 0 R', tag: '/H1', text: 'Juvenile Sentencing' },
            { ref: 'obj:51 0 R', tag: '/H1', text: '' },
            { ref: 'obj:81 0 R', tag: '/H1', text: null },
          ],
        }),
      },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.heading_content_quality')
    expect(finding).toBeUndefined()
  })

  it('ignores non-heading wrapper tags like /Story when evaluating heading-content quality', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        headings: [
          { level: 'H1', tag: '/H1' },
          { level: 'H1', tag: '/H1' },
        ],
      }),
      makePdfjs(),
      {
        structure: makeStructure({
          headings: [
            { ref: 'obj:45 0 R', tag: '/Story', text: null },
            { ref: 'obj:46 0 R', tag: '/Story', text: '' },
            { ref: 'obj:47 0 R', tag: '/H1', text: 'Juvenile records' },
          ],
        }),
      },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.heading_content_quality')
    expect(finding).toBeUndefined()
  })

  it('ignores empty heading wrappers that only act as parents for child structure', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        headings: [
          { level: 'H1', tag: '/H1' },
          { level: 'H2', tag: '/H2' },
          { level: 'H2', tag: '/H2' },
        ],
      }),
      makePdfjs(),
      {
        structure: makeStructure({
          headings: [
            { ref: 'obj:22 0 R', tag: '/H2', text: 'Figure 2' },
            { ref: 'obj:23 0 R', tag: '/H2', text: null },
            { ref: 'obj:25 0 R', tag: '/H2', text: '*Judges excluded due to small sample size.' },
          ],
          structuralNodes: [
            { ref: 'obj:24 0 R', tag: '/Span', parentRef: 'obj:23 0 R', orderIndex: 0 },
          ],
        }),
      },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.heading_content_quality')
    expect(finding).toBeUndefined()
  })

  it('ignores empty nested heading wrappers whose parent is another heading', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        headings: [
          { level: 'H1', tag: '/H1' },
          { level: 'H2', tag: '/H2' },
          { level: 'H2', tag: '/H2' },
          { level: 'H3', tag: '/H3' },
        ],
      }),
      makePdfjs(),
      {
        structure: makeStructure({
          headings: [
            { ref: 'obj:20 0 R', tag: '/H1', text: 'State criminal justice survey seeks input' },
            { ref: 'obj:22 0 R', tag: '/H2', text: 'Figure 2 Survey response analysis' },
            { ref: 'obj:23 0 R', tag: '/H2', parentRef: 'obj:22 0 R', text: null },
            { ref: 'obj:25 0 R', tag: '/H3', text: '*Judges excluded due to small sample size.' },
          ],
        }),
      },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.heading_content_quality')
    expect(finding).toBeUndefined()
  })

  it('emits complex-table findings for irregular grouped-header tables', () => {
    const report = buildLocalStandardsReport(
      makeQpdf({
        tables: [
          { hasHeaders: true, isRegular: false, rowCellCounts: [4, 6, 6], headerRowCount: 2, maxRowSpan: 2, maxColSpan: 3 },
        ],
      }),
      makePdfjs(),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.table_complexity')
    expect(finding).toBeDefined()
    expect(finding?.categoryIds).toContain('table_markup')
  })

  it('emits link-text quality findings for ambiguous link labels', () => {
    const report = buildLocalStandardsReport(
      makeQpdf(),
      makePdfjs({
        links: [
          { url: 'https://example.com', text: 'click here' },
        ],
      }),
      { structure: makeStructure() },
    )

    const finding = report.findings.find(entry => entry.key === 'pdfua.link_text_quality')
    expect(finding).toBeDefined()
    expect(finding?.categoryIds).toContain('link_quality')
  })
})
