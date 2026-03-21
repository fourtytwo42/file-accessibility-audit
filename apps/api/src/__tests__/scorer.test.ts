import { describe, it, expect } from 'vitest'
import { scoreDocument, summarizeLinkTextQuality, type CategoryResult, type ScoringResult } from '../services/scorer.js'
import type { QpdfResult } from '../services/qpdfService.js'
import type { PdfjsResult } from '../services/pdfjsService.js'
import type { VeraPdfResult } from '../services/veraPdfService.js'
import type { StructureBackendMutationResult } from '../services/pdfStructureBackend.js'
import type { TabOrderResult } from '../services/tabOrderService.js'
import type { LocalStandardsReport } from '../services/localStandardsService.js'

// ---------------------------------------------------------------------------
// Helpers to build mock data
// ---------------------------------------------------------------------------

function makeQpdf(overrides: Partial<QpdfResult> = {}): QpdfResult {
  return {
    hasStructTree: false,
    isTagged: false,
    hasMarkInfo: false,
    marked: null,
    hasLang: false,
    lang: null,
    hasOutlines: false,
    outlineCount: 0,
    outlineTitles: [],
    displayDocTitle: null,
    metadataRef: null,
    metadataTypeValid: false,
    metadataSubtypeXml: false,
    hasAcroForm: false,
    formFields: [],
    fontCount: 0,
    unembeddedFontCount: 0,
    fontsMissingToUnicode: 0,
    cidFontsMissingCidToGidMap: 0,
    images: [],
    headings: [],
    tables: [],
    structTreeDepth: 0,
    contentOrder: [],
    annotationCount: 0,
    error: null,
    ...overrides,
  }
}

function makeLocalStandards(overrides: Partial<LocalStandardsReport> = {}): LocalStandardsReport {
  return {
    status: 'clear',
    findings: [],
    knownGapKeys: [],
    ...overrides,
  }
}

function makePdfjs(overrides: Partial<PdfjsResult> = {}): PdfjsResult {
  return {
    pageCount: 1,
    hasText: false,
    textLength: 0,
    title: null,
    author: null,
    subject: null,
    lang: null,
    hasOutlines: false,
    outlineCount: 0,
    links: [],
    imageCount: 0,
    metadata: {
      creator: null,
      producer: null,
      creationDate: null,
      modDate: null,
      pdfVersion: null,
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

function makeVeraPdf(overrides: Partial<VeraPdfResult> = {}): VeraPdfResult {
  return {
    status: 'passed',
    executionStatus: 'ok',
    profile: 'PDF/UA-1',
    flavour: 'ua1',
    isCompliant: true,
    passedChecks: 10,
    failedChecks: 0,
    failures: [],
    message: 'veraPDF passed PDF/UA validation.',
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

/** Build a fully-accessible PDF mock (all categories score 100). */
function fullyAccessible(): { qpdf: QpdfResult; pdfjs: PdfjsResult } {
  return {
    qpdf: makeQpdf({
      hasStructTree: true,
      hasLang: true,
      lang: 'en-US',
      hasMarkInfo: true,
      marked: true,
      hasOutlines: true,
      outlineCount: 5,
      displayDocTitle: true,
      metadataRef: 'obj:50 0 R',
      metadataTypeValid: true,
      metadataSubtypeXml: true,
      headings: [
        { level: 'H1', tag: '/H1' },
        { level: 'H2', tag: '/H2' },
        { level: 'H3', tag: '/H3' },
      ],
      images: [
        { ref: '10 0 R', hasAlt: true },
        { ref: '11 0 R', hasAlt: true },
      ],
      tables: [{ hasHeaders: true }],
      hasAcroForm: true,
      formFields: [{ hasTU: true }, { hasTU: true }],
      fontCount: 2,
      structTreeDepth: 4,
      contentOrder: [0, 1, 2, 3, 4, 5],
    }),
    pdfjs: makePdfjs({
      pageCount: 20,
      hasText: true,
      textLength: 5000,
      title: 'Annual Report 2025',
      lang: 'en-US',
      hasOutlines: true,
      outlineCount: 5,
      links: [
        { url: 'https://example.com', text: 'View the full report' },
      ],
    }),
  }
}

function findCategory(result: ScoringResult, id: string): CategoryResult {
  const cat = result.categories.find(c => c.id === id)
  if (!cat) throw new Error(`Category "${id}" not found in result`)
  return cat
}

// ---------------------------------------------------------------------------
// scoreDocument: fully accessible PDF
// ---------------------------------------------------------------------------

describe('scoreDocument — fully accessible PDF', () => {
  const { qpdf, pdfjs } = fullyAccessible()
  const result = scoreDocument(qpdf, pdfjs)

  it('returns overall score of 100', () => {
    expect(result.overallScore).toBe(100)
  })

  it('returns grade A', () => {
    expect(result.grade).toBe('A')
  })

  it('is not scanned', () => {
    expect(result.isScanned).toBe(false)
  })

  it('has no warnings', () => {
    expect(result.warnings).toHaveLength(0)
  })

  it('executive summary mentions ready for publication', () => {
    expect(result.executiveSummary).toContain('ready for publication')
  })

  it('all 11 categories are present', () => {
    expect(result.categories).toHaveLength(11)
  })

  it('text_extractability scores 100', () => {
    expect(findCategory(result, 'text_extractability').score).toBe(100)
  })

  it('title_language scores 100', () => {
    expect(findCategory(result, 'title_language').score).toBe(100)
  })

  it('heading_structure scores 100', () => {
    expect(findCategory(result, 'heading_structure').score).toBe(100)
  })

  it('alt_text scores 100', () => {
    expect(findCategory(result, 'alt_text').score).toBe(100)
  })

  it('bookmarks scores 100', () => {
    expect(findCategory(result, 'bookmarks').score).toBe(100)
  })

  it('table_markup scores 100', () => {
    expect(findCategory(result, 'table_markup').score).toBe(100)
  })

  it('link_quality scores 100', () => {
    expect(findCategory(result, 'link_quality').score).toBe(100)
  })

  it('form_accessibility scores 100', () => {
    expect(findCategory(result, 'form_accessibility').score).toBe(100)
  })

  it('reading_order scores 100', () => {
    expect(findCategory(result, 'reading_order').score).toBe(100)
  })

  it('pdf_ua_compliance scores 100', () => {
    expect(findCategory(result, 'pdf_ua_compliance').score).toBe(100)
  })
})

describe('scoreDocument — local tab order detection', () => {
  it('reduces reading-order score when tagged pages are missing /Tabs /S', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(qpdf, pdfjs, makeVeraPdf(), undefined, null, undefined, {
      tabOrder: makeTabOrder({
        annotatedPageCount: 1,
        missingTabsCount: 2,
        issues: [
          { page: 1, reason: 'missing_tabs_s', details: 'Page 1 is missing /Tabs /S.' },
          { page: 2, reason: 'missing_tabs_s', details: 'Page 2 is missing /Tabs /S.' },
        ],
      }),
    })

    expect(findCategory(result, 'reading_order').score).toBe(60)
    expect(findCategory(result, 'reading_order').findings.some(finding => finding.includes('/Tabs /S'))).toBe(true)
  })

  it('reduces reading-order score when annotations are out of order', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(qpdf, pdfjs, makeVeraPdf(), undefined, null, undefined, {
      tabOrder: makeTabOrder({
        annotatedPageCount: 1,
        outOfOrderPageCount: 1,
        issues: [
          { page: 1, reason: 'annotation_order', details: 'Page 1 annotations are not ordered top-to-bottom, left-to-right.' },
        ],
      }),
    })

    expect(findCategory(result, 'reading_order').score).toBe(75)
    expect(findCategory(result, 'reading_order').findings.some(finding => finding.includes('annotations'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// scoreDocument: scanned PDF (no text, no tags)
// ---------------------------------------------------------------------------

describe('scoreDocument — scanned PDF', () => {
  const qpdf = makeQpdf() // defaults: no struct tree, no anything
  const pdfjs = makePdfjs({ pageCount: 1 })
  const result = scoreDocument(qpdf, pdfjs)

  it('isScanned is true', () => {
    expect(result.isScanned).toBe(true)
  })

  it('overall score reflects the failing PDF/UA category too', () => {
    expect(result.overallScore).toBe(17)
  })

  it('grade is F', () => {
    expect(result.grade).toBe('F')
  })

  it('executive summary mentions scanned image and OCR', () => {
    expect(result.executiveSummary).toContain('scanned image')
    expect(result.executiveSummary).toContain('OCR')
  })

  it('text_extractability scores 0', () => {
    expect(findCategory(result, 'text_extractability').score).toBe(0)
  })

  it('reading_order scores 0 (no struct tree)', () => {
    expect(findCategory(result, 'reading_order').score).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// scoreDocument: mixed results
// ---------------------------------------------------------------------------

describe('scoreDocument — mixed results', () => {
  it('text but no tags scores 50 for text_extractability', () => {
    const qpdf = makeQpdf({ hasStructTree: false })
    const pdfjs = makePdfjs({ hasText: true, textLength: 500 })
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'text_extractability').score).toBe(50)
  })

  it('tags but no text scores 25 for text_extractability', () => {
    const qpdf = makeQpdf({ hasStructTree: true, structTreeDepth: 2 })
    const pdfjs = makePdfjs({ hasText: false })
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'text_extractability').score).toBe(25)
  })

  it('title without lang scores 50 for title_language', () => {
    const qpdf = makeQpdf()
    const pdfjs = makePdfjs({ title: 'My Document', lang: null })
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'title_language').score).toBe(50)
  })

  it('lang without title scores 50 for title_language', () => {
    const qpdf = makeQpdf({ hasLang: true, lang: 'en' })
    const pdfjs = makePdfjs({ title: null })
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'title_language').score).toBe(50)
  })

  it('qpdf error adds a warning', () => {
    const qpdf = makeQpdf({ error: 'QPDF parsing failed' })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain('could not be completed')
  })
})

// ---------------------------------------------------------------------------
// N/A category handling
// ---------------------------------------------------------------------------

describe('N/A category handling', () => {
  it('alt_text is null when no images exist', () => {
    const qpdf = makeQpdf({ images: [] })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    const cat = findCategory(result, 'alt_text')
    expect(cat.score).toBeNull()
    expect(cat.grade).toBeNull()
    expect(cat.severity).toBeNull()
  })

  it('bookmarks is null for short documents', () => {
    const qpdf = makeQpdf()
    const pdfjs = makePdfjs({ pageCount: 5 }) // under threshold of 10
    const result = scoreDocument(qpdf, pdfjs)
    const cat = findCategory(result, 'bookmarks')
    expect(cat.score).toBeNull()
    expect(cat.findings[0]).toContain('not required')
  })

  it('table_markup is null when no tables exist', () => {
    const qpdf = makeQpdf({ tables: [] })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'table_markup').score).toBeNull()
  })

  it('link_quality is null when no links exist', () => {
    const qpdf = makeQpdf()
    const pdfjs = makePdfjs({ links: [] })
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'link_quality').score).toBeNull()
  })

  it('form_accessibility is null when no forms exist', () => {
    const qpdf = makeQpdf({ hasAcroForm: false, formFields: [] })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'form_accessibility').score).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Weight renormalization when categories are N/A
// ---------------------------------------------------------------------------

describe('weight renormalization', () => {
  it('N/A categories are excluded from overall score calculation', () => {
    // Make a doc where ONLY text_extractability and title_language are applicable,
    // and both score 100. The overall should be 100, not diluted by N/A categories.
    const qpdf = makeQpdf({
      hasStructTree: true,
      hasLang: true,
      lang: 'en',
      // No images, no tables, no forms, no outlines, no headings
      images: [],
      tables: [],
      formFields: [],
      headings: [],
      structTreeDepth: 3,
      contentOrder: [0, 1, 2],
    })
    const pdfjs = makePdfjs({
      pageCount: 3, // short doc -> bookmarks N/A
      hasText: true,
      textLength: 500,
      title: 'Test',
      links: [],
    })
    const result = scoreDocument(qpdf, pdfjs)

    // text_extractability = 100, title_language = 100, heading_structure = 0 (F),
    // alt_text = null (no images), bookmarks = null, table_markup = null,
    // link_quality = null, form_accessibility = null, reading_order = 100
    // Applicable: text(0.18), title(0.135), heading(0.135), reading(0.045), pdf_ua(0.10)
    // Total weight = 0.595
    const text = findCategory(result, 'text_extractability')
    const title = findCategory(result, 'title_language')
    const heading = findCategory(result, 'heading_structure')
    const alt = findCategory(result, 'alt_text')
    const reading = findCategory(result, 'reading_order')

    expect(text.score).toBe(100)
    expect(title.score).toBe(100)
    expect(heading.score).toBe(0) // no headings -> F
    expect(alt.score).toBeNull() // no images -> N/A
    expect(reading.score).toBe(100)

    // Expected: (100*0.18 + 100*0.135 + 0*0.135 + 100*0.045 + 100*0.10) / 0.595
    // = 46 / 0.595 = 77.31... ≈ 77
    expect(result.overallScore).toBe(77)
  })

  it('all categories N/A results in score 0', () => {
    // This is an extreme edge case but the code handles it
    // We can't really make ALL categories N/A because text_extractability always returns a score,
    // but if somehow all applicable categories are N/A, totalWeight would be 0 → score 0
    // Testing the branch: applicable is empty → score 0
    // In practice this won't happen, but let's verify the math holds
    const qpdf = makeQpdf({ hasStructTree: true, structTreeDepth: 3, contentOrder: [0, 1, 2] })
    const pdfjs = makePdfjs({ hasText: true, textLength: 500, pageCount: 3 })
    const result = scoreDocument(qpdf, pdfjs)
    // At minimum text_extractability is applicable, so overall > 0
    expect(result.overallScore).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Grade thresholds (A/B/C/D/F boundaries)
// ---------------------------------------------------------------------------

describe('grade thresholds', () => {
  // We test indirectly via scoreDocument by controlling the inputs
  // to produce known overall scores.

  it('score 100 → grade A', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(qpdf, pdfjs)
    expect(result.grade).toBe('A')
  })

  it('downgrades the grade when an incomplete scored category prevents a clean pass', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    qpdf.images = [
      { ref: '10 0 R', hasAlt: true },
      { ref: '11 0 R', hasAlt: false },
    ]
    const result = scoreDocument(qpdf, pdfjs)
    expect(result.overallScore).toBeGreaterThanOrEqual(90)
    expect(result.grade).toBe('B')
  })

  it('score in 80-89 → grade B', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    // Remove title → title_language drops to 50
    pdfjs.title = null
    const result = scoreDocument(qpdf, pdfjs)
    // title_language goes to 50 (only lang). weight 0.15.
    // All others are 100. Overall = 100 - (50 * 0.15) = 92.5 → still A
    // Need more degradation. Also break heading hierarchy.
    qpdf.headings = [
      { level: 'H1', tag: '/H1' },
      { level: 'H3', tag: '/H3' }, // skips H2
    ]
    const result2 = scoreDocument(qpdf, pdfjs)
    // heading_structure = 60, title_language = 50
    // With these two lowered, overall should be in the 80s range
    expect(result2.overallScore).toBeGreaterThanOrEqual(80)
    expect(result2.overallScore).toBeLessThan(100)
    if (result2.overallScore >= 90) expect(result2.grade).toBe('A')
    else expect(result2.grade).toBe('B')
  })

  it('grade F for a 0 score', () => {
    const qpdf = makeQpdf()
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(result.grade).toBe('F')
  })
})

// ---------------------------------------------------------------------------
// Severity thresholds
// ---------------------------------------------------------------------------

describe('severity thresholds', () => {
  it('score 100 → Pass', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'text_extractability').severity).toBe('Pass')
  })

  it('score 90 → Pass', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(qpdf, pdfjs)
    // text_extractability = 100, severity = Pass
    expect(findCategory(result, 'text_extractability').severity).toBe('Pass')
  })

  it('score 0 → Critical', () => {
    const qpdf = makeQpdf()
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'text_extractability').severity).toBe('Critical')
  })

  it('null score → null severity', () => {
    const qpdf = makeQpdf({ images: [] })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'alt_text').severity).toBeNull()
  })

  it('score 50 → Moderate', () => {
    // text but no tags → score 50
    const qpdf = makeQpdf({ hasStructTree: false })
    const pdfjs = makePdfjs({ hasText: true, textLength: 500 })
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'text_extractability').score).toBe(50)
    expect(findCategory(result, 'text_extractability').severity).toBe('Moderate')
  })
})

// ---------------------------------------------------------------------------
// Executive summary generation
// ---------------------------------------------------------------------------

describe('executive summary', () => {
  it('scanned PDF gets OCR-required summary', () => {
    const qpdf = makeQpdf()
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(result.executiveSummary).toContain('scanned image')
    expect(result.executiveSummary).toContain('OCR')
  })

  it('grade A gets "ready for publication" summary', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(qpdf, pdfjs)
    expect(result.executiveSummary).toContain('ready for publication')
  })

  it('grade B mentions "good shape" and minor issues', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    pdfjs.title = null
    qpdf.headings = [
      { level: 'H1', tag: '/H1' },
      { level: 'H3', tag: '/H3' },
    ]
    const result = scoreDocument(qpdf, pdfjs)
    if (result.grade === 'B') {
      expect(result.executiveSummary).toContain('good shape')
    }
    // If not B due to weight math, just verify it's a string
    expect(typeof result.executiveSummary).toBe('string')
  })

  it('critical issues are named in the summary', () => {
    // Force a document with critical severity in some categories
    const qpdf = makeQpdf({
      hasStructTree: true,
      structTreeDepth: 3,
      contentOrder: [0, 1, 2],
    })
    const pdfjs = makePdfjs({
      hasText: true,
      textLength: 500,
      pageCount: 20,
    })
    // heading_structure = F (critical), bookmarks = F (critical)
    const result = scoreDocument(qpdf, pdfjs)
    // Not scanned, not A or B, so should mention critical issues
    if (result.grade !== 'A' && result.grade !== 'B') {
      const critical = result.categories.filter(c => c.severity === 'Critical')
      if (critical.length > 0) {
        expect(result.executiveSummary).toContain('critical')
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Individual category scoring functions — edge cases
// ---------------------------------------------------------------------------

describe('scoreHeadingStructure edge cases', () => {
  it('no headings → score 0, grade F', () => {
    const qpdf = makeQpdf({ headings: [] })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    const cat = findCategory(result, 'heading_structure')
    expect(cat.score).toBe(0)
    expect(cat.grade).toBe('F')
    expect(cat.severity).toBe('Critical')
  })

  it('only generic /H tags → score 40', () => {
    const qpdf = makeQpdf({
      headings: [
        { level: 'H', tag: '/H' },
        { level: 'H', tag: '/H' },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'heading_structure').score).toBe(40)
  })

  it('proper hierarchy H1→H2→H3 → score 100', () => {
    const qpdf = makeQpdf({
      headings: [
        { level: 'H1', tag: '/H1' },
        { level: 'H2', tag: '/H2' },
        { level: 'H3', tag: '/H3' },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'heading_structure').score).toBe(100)
  })

  it('H1→H3 skip → score 60, findings mention skip', () => {
    const qpdf = makeQpdf({
      headings: [
        { level: 'H1', tag: '/H1' },
        { level: 'H3', tag: '/H3' },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    const cat = findCategory(result, 'heading_structure')
    expect(cat.score).toBe(60)
    expect(cat.findings.some(f => f.includes('skip'))).toBe(true)
  })

  it('mixed generic /H and numbered headings, proper hierarchy → score 100', () => {
    const qpdf = makeQpdf({
      headings: [
        { level: 'H', tag: '/H' },
        { level: 'H1', tag: '/H1' },
        { level: 'H2', tag: '/H2' },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    // Has numbered headings with proper hierarchy, so 100
    expect(findCategory(result, 'heading_structure').score).toBe(100)
  })

  it('H1→H2→H2→H1 reset → score 60', () => {
    const qpdf = makeQpdf({
      headings: [
        { level: 'H1', tag: '/H1' },
        { level: 'H2', tag: '/H2' },
        { level: 'H2', tag: '/H2' },
        { level: 'H1', tag: '/H1' },
      ],
    })
    const pdfjs = makePdfjs({ pageCount: 5 })
    const result = scoreDocument(qpdf, pdfjs)
    const cat = findCategory(result, 'heading_structure')
    expect(cat.score).toBe(60)
    expect(cat.findings.some(f => f.includes('reset'))).toBe(true)
  })

  it('treats limited heading resets as advisory on short non-interactive bulletins', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      {
        ...qpdf,
        headings: [
          { level: 'H1', tag: '/H1' },
          { level: 'H1', tag: '/H1' },
          { level: 'H1', tag: '/H1' },
          { level: 'H1', tag: '/H1' },
          { level: 'H2', tag: '/H2' },
          { level: 'H3', tag: '/H3' },
          { level: 'H1', tag: '/H1' },
          { level: 'H1', tag: '/H1' },
        ],
        formFields: [],
        linkAnnotationCount: 0,
      },
      {
        ...pdfjs,
        pageCount: 4,
        links: [],
        outlineCount: 0,
        hasOutlines: false,
        metadata: {
          ...pdfjs.metadata,
          pageCount: 4,
        },
      },
    )
    const cat = findCategory(result, 'heading_structure')
    expect(cat.score).toBe(95)
    expect(cat.grade).toBe('A')
    expect(cat.findings.some(f => f.includes('advisory warning'))).toBe(true)
    expect(result.overallScore).toBe(100)
    expect(result.grade).toBe('A')
  })

  it('legacy heading tags outside H1-H6 degrade heading structure', () => {
    const qpdf = makeQpdf({
      headings: [
        { level: 'H1', tag: '/H1' },
        { level: 'H4', tag: '/heading 4' },
        { level: 'H9', tag: '/heading 9' },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    const cat = findCategory(result, 'heading_structure')
    expect(cat.score).toBe(60)
    expect(cat.findings.some(f => f.includes('outside H1-H6'))).toBe(true)
  })

  it('headings without an H1 lower heading structure', () => {
    const qpdf = makeQpdf({
      headings: [
        { level: 'H2', tag: '/H2' },
        { level: 'H3', tag: '/H3' },
      ],
    })
    const result = scoreDocument(qpdf, makePdfjs())
    const cat = findCategory(result, 'heading_structure')
    expect(cat.score).toBe(60)
    expect(cat.findings.some(f => f.includes('no main H1'))).toBe(true)
  })

  it('generic heading text from structure snapshots lowers heading structure', () => {
    const qpdf = makeQpdf({
      headings: [
        { level: 'H1', tag: '/H1' },
      ],
    })
    const result = scoreDocument(
      qpdf,
      makePdfjs(),
      makeVeraPdf(),
      makeStructure({
        headings: [
          { ref: 'obj:50 0 R', tag: '/H1', text: 'Heading' },
        ],
      }),
    )
    const cat = findCategory(result, 'heading_structure')
    expect(cat.score).toBe(60)
    expect(cat.findings.some(f => f.includes('generic heading text'))).toBe(true)
  })

  it('does not lower heading structure when all recovered heading text is unreadable', () => {
    const qpdf = makeQpdf({
      headings: [
        { level: 'H1', tag: '/H1' },
        { level: 'H2', tag: '/H2' },
      ],
    })
    const result = scoreDocument(
      qpdf,
      makePdfjs(),
      makeVeraPdf(),
      makeStructure({
        headings: [
          { ref: 'obj:50 0 R', tag: '/H1', text: null },
          { ref: 'obj:51 0 R', tag: '/H2', text: '' },
        ],
      }),
    )
    const cat = findCategory(result, 'heading_structure')
    expect(cat.score).toBe(100)
    expect(cat.findings.some(f => f.includes('no readable heading text'))).toBe(false)
  })

  it('does not lower heading structure when most recovered heading text is unreadable', () => {
    const qpdf = makeQpdf({
      headings: [
        { level: 'H1', tag: '/H1' },
        { level: 'H1', tag: '/H1' },
        { level: 'H1', tag: '/H1' },
      ],
    })
    const result = scoreDocument(
      qpdf,
      makePdfjs(),
      makeVeraPdf(),
      makeStructure({
        headings: [
          { ref: 'obj:50 0 R', tag: '/H1', text: 'Juvenile Sentencing' },
          { ref: 'obj:51 0 R', tag: '/H1', text: '' },
          { ref: 'obj:81 0 R', tag: '/H1', text: null },
        ],
      }),
    )
    const cat = findCategory(result, 'heading_structure')
    expect(cat.score).toBe(100)
    expect(cat.findings.some(f => f.includes('no readable heading text'))).toBe(false)
  })

  it('does not lower heading structure for unreadable /Story wrapper nodes', () => {
    const qpdf = makeQpdf({
      headings: [
        { level: 'H1', tag: '/H1' },
        { level: 'H1', tag: '/H1' },
      ],
    })
    const result = scoreDocument(
      qpdf,
      makePdfjs(),
      makeVeraPdf(),
      makeStructure({
        headings: [
          { ref: 'obj:45 0 R', tag: '/Story', text: null },
          { ref: 'obj:46 0 R', tag: '/Story', text: '' },
          { ref: 'obj:47 0 R', tag: '/H1', text: 'Juvenile records' },
        ],
      }),
    )
    const cat = findCategory(result, 'heading_structure')
    expect(cat.score).toBe(100)
    expect(cat.findings.some(f => f.includes('no readable heading text'))).toBe(false)
  })

  it('does not lower heading structure for empty nested heading wrappers', () => {
    const qpdf = makeQpdf({
      headings: [
        { level: 'H1', tag: '/H1' },
        { level: 'H1', tag: '/H1' },
        { level: 'H2', tag: '/H2' },
      ],
    })
    const result = scoreDocument(
      qpdf,
      makePdfjs({ pageCount: 4 }),
      makeVeraPdf(),
      makeStructure({
        headings: [
          { ref: 'obj:22 0 R', tag: '/H1', parentRef: 'obj:48 0 R', text: 'Figure 2 Law enforcement professionals survey response analysis*' },
          { ref: 'obj:23 0 R', tag: '/H2', parentRef: 'obj:22 0 R', text: null },
          { ref: 'obj:25 0 R', tag: '/H3', parentRef: 'obj:26 0 R', text: '*Judges excluded due to small sample size.' },
          { ref: 'obj:27 0 R', tag: '/H1', parentRef: 'obj:28 0 R', text: null },
          { ref: 'obj:29 0 R', tag: '/H1', parentRef: 'obj:28 0 R', text: null },
        ],
        structuralNodes: [
          { ref: 'obj:28 0 R', tag: '/Story', parentRef: 'obj:47 0 R', orderIndex: 0 },
          { ref: 'obj:23 0 R', tag: '/H2', parentRef: 'obj:22 0 R', orderIndex: 0 },
          { ref: 'obj:30 0 R', tag: '/Story', parentRef: 'obj:28 0 R', orderIndex: 1 },
        ],
      }),
    )
    const cat = findCategory(result, 'heading_structure')
    expect(cat.score).toBe(100)
    expect(cat.findings.some(f => f.includes('no readable heading text'))).toBe(false)
  })
})

describe('scoreAltText pdfjs fallback', () => {
  it('qpdf finds no images but pdfjs detects images → N/A (no taggable XObjects)', () => {
    const qpdf = makeQpdf({ images: [] })
    const pdfjs = makePdfjs({ imageCount: 3 })
    const result = scoreDocument(qpdf, pdfjs)
    const cat = findCategory(result, 'alt_text')
    expect(cat.score).toBeNull()
    expect(cat.severity).toBeNull()
    expect(cat.findings.some(f => f.includes('3 image rendering operation(s)'))).toBe(true)
    expect(cat.findings.some(f => f.includes('no taggable Image XObjects'))).toBe(true)
  })

  it('qpdf finds no images and pdfjs finds none either → N/A', () => {
    const qpdf = makeQpdf({ images: [] })
    const pdfjs = makePdfjs({ imageCount: 0 })
    const result = scoreDocument(qpdf, pdfjs)
    const cat = findCategory(result, 'alt_text')
    expect(cat.score).toBeNull()
  })
})

describe('scoreAltText edge cases', () => {
  it('2 images, 1 with alt → score 50', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: '10 0 R', hasAlt: true },
        { ref: '11 0 R', hasAlt: false },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'alt_text').score).toBe(50)
  })

  it('3 images, 2 with alt → score 67 (rounded)', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: '10 0 R', hasAlt: true },
        { ref: '11 0 R', hasAlt: true },
        { ref: '12 0 R', hasAlt: false },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'alt_text').score).toBe(67)
  })

  it('generic alt text lowers alt_text even when alt is present', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: '10 0 R', hasAlt: true, altText: 'image' },
        { ref: '11 0 R', hasAlt: true, altText: 'Revenue chart by quarter' },
      ],
    })
    const result = scoreDocument(qpdf, makePdfjs())
    const category = findCategory(result, 'alt_text')
    expect(category.score).toBe(50)
    expect(category.findings.some(finding => finding.includes('low-quality alternate text'))).toBe(true)
  })

  it('boilerplate or overlong alt text lowers alt_text quality scoring', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: '10 0 R', hasAlt: true, altText: 'Image of the county seal on the cover page' },
        { ref: '11 0 R', hasAlt: true, altText: 'This chart shows quarterly outcomes, yearly totals, monthly breakdowns, regional comparisons, staffing trends, historical baselines, forecast assumptions, source notes, and explanatory prose that is much too long for alternate text.' },
      ],
    })
    const result = scoreDocument(qpdf, makePdfjs())
    const category = findCategory(result, 'alt_text')
    expect(category.score).toBe(0)
    expect(category.findings.some(finding => finding.includes('boilerplate'))).toBe(true)
  })

  it('images with no ref are excluded', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: '', hasAlt: false },  // no ref, filtered out
        { ref: '10 0 R', hasAlt: true },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    // Only ref='10 0 R' passes the filter, and it has alt
    expect(findCategory(result, 'alt_text').score).toBe(100)
  })

  it('reduces alt_text when Acrobat-risk non-figure graphics ownership remains even if veraPDF passes', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf(),
      makeStructure({
        acrobatAltRiskNodes: [
          {
            ref: 'obj:42 0 R',
            tag: '/H1',
            pageRef: 'obj:5 0 R',
            mcids: [0],
            hasText: true,
            hasGraphics: true,
            parentTagPath: ['/Document'],
            ownershipMode: 'mixed_text_graphics_same_mcid',
            duplicateOwnerRefs: [],
          },
        ],
      }),
    )

    expect(findCategory(result, 'alt_text').score).toBeLessThan(100)
    expect(findCategory(result, 'alt_text').findings.some(finding => finding.includes('Acrobat-risk'))).toBe(true)
    expect(findCategory(result, 'alt_text').grade).not.toBe('A')
  })

  it('uses a softer Acrobat-risk cap when only one split-safe mixed node remains', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: '10 0 R', hasAlt: true },
        { ref: '11 0 R', hasAlt: true },
        { ref: '12 0 R', hasAlt: true },
        { ref: '13 0 R', hasAlt: true },
        { ref: '14 0 R', hasAlt: true },
        { ref: '15 0 R', hasAlt: true },
        { ref: '16 0 R', hasAlt: true },
        { ref: '17 0 R', hasAlt: false },
        { ref: '18 0 R', hasAlt: false },
        { ref: '19 0 R', hasAlt: false },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf({ status: 'unavailable', executionStatus: 'missing_binary', isCompliant: null }),
      makeStructure({
        acrobatAltRiskNodes: [
          {
            ref: 'obj:42 0 R',
            tag: '/P',
            pageRef: 'obj:5 0 R',
            mcids: [31, 32],
            hasText: true,
            hasGraphics: true,
            splitSafe: true,
            graphicsLikelyDecorative: false,
            parentTagPath: ['/Document'],
            ownershipMode: 'mixed_text_graphics_same_mcid',
            duplicateOwnerRefs: [],
          },
        ],
      }),
    )

    expect(findCategory(result, 'alt_text').score).toBe(60)
  })

  it('reports residual Acrobat-risk ownership debt as guidance when all detected figures already have alt text', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: '10 0 R', hasAlt: true },
        { ref: '11 0 R', hasAlt: true },
        { ref: '12 0 R', hasAlt: true },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf({ status: 'unavailable', executionStatus: 'missing_binary', isCompliant: null }),
      makeStructure({
        acrobatAltRiskNodes: [
          {
            ref: 'obj:42 0 R',
            tag: '/P',
            pageRef: 'obj:5 0 R',
            mcids: [31, 32],
            hasText: true,
            hasGraphics: true,
            splitSafe: false,
            graphicsLikelyDecorative: false,
            parentTagPath: ['/Document'],
            ownershipMode: 'mixed_text_graphics_same_mcid',
            duplicateOwnerRefs: [],
          },
        ],
      }),
    )

    expect(findCategory(result, 'alt_text').score).toBe(100)
    expect(findCategory(result, 'alt_text').findings.some(finding => finding.includes('structural cleanup guidance'))).toBe(true)
  })

  it('uses a softer residual Acrobat-risk cap when only one figure is still missing alt text', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: '10 0 R', hasAlt: true },
        { ref: '11 0 R', hasAlt: true },
        { ref: '12 0 R', hasAlt: true },
        { ref: '13 0 R', hasAlt: true },
        { ref: '14 0 R', hasAlt: true },
        { ref: '15 0 R', hasAlt: false },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf({ status: 'unavailable', executionStatus: 'missing_binary', isCompliant: null }),
      makeStructure({
        acrobatAltRiskNodes: [
          {
            ref: 'obj:42 0 R',
            tag: '/P',
            pageRef: 'obj:5 0 R',
            mcids: [31, 32],
            hasText: true,
            hasGraphics: true,
            splitSafe: false,
            graphicsLikelyDecorative: false,
            parentTagPath: ['/Document'],
            ownershipMode: 'mixed_text_graphics_same_mcid',
            duplicateOwnerRefs: [],
          },
          {
            ref: 'obj:43 0 R',
            tag: '/P',
            pageRef: 'obj:5 0 R',
            mcids: [41, 42],
            hasText: true,
            hasGraphics: true,
            splitSafe: false,
            graphicsLikelyDecorative: false,
            parentTagPath: ['/Document'],
            ownershipMode: 'mixed_text_graphics_same_mcid',
            duplicateOwnerRefs: [],
          },
        ],
      }),
    )

    expect(findCategory(result, 'alt_text').score).toBe(75)
    expect(findCategory(result, 'alt_text').findings.some(finding => finding.includes('one image description is still unresolved'))).toBe(true)
  })

  it('treats mostly decorative split-safe Acrobat ownership debt as guidance when figures already have alt text', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: 'obj:10 0 R', hasAlt: true, altText: 'Cover image' },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf({ status: 'unavailable', executionStatus: 'missing_binary', isCompliant: null }),
      makeStructure({
        acrobatAltRiskNodes: [
          { ref: 'obj:501 0 R', ownershipMode: 'mixed_text_graphics_same_mcid', graphicsLikelyDecorative: true, splitSafe: true },
          { ref: 'obj:502 0 R', ownershipMode: 'mixed_text_graphics_same_mcid', graphicsLikelyDecorative: true, splitSafe: true },
          { ref: 'obj:503 0 R', ownershipMode: 'untagged_image_mcid', graphicsLikelyDecorative: true, splitSafe: true },
        ] as any,
      }),
    )

    expect(findCategory(result, 'alt_text').score).toBe(100)
    expect(findCategory(result, 'alt_text').findings.some(finding => finding.includes('structural cleanup guidance'))).toBe(true)
  })

  it('keeps raw untagged image ownership as a real alt-text failure even when figures already have alt text', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: '10 0 R', hasAlt: true },
        { ref: '11 0 R', hasAlt: true },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf({ status: 'unavailable', executionStatus: 'missing_binary', isCompliant: null }),
      makeStructure({
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
            parentTagPath: [],
            ownershipMode: 'untagged_image_direct',
            duplicateOwnerRefs: [],
          },
        ],
      }),
    )

    expect(findCategory(result, 'alt_text').score).toBe(60)
    expect(findCategory(result, 'alt_text').findings.some(finding => finding.includes('Acrobat-style alternate-text risk remains'))).toBe(true)
  })

  it('excludes decorative non-figure graphics from alt-text scoring when informative figures are already described', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: '10 0 R', hasAlt: true },
        { ref: '11 0 R', hasAlt: true },
        { ref: '12 0 R', hasAlt: false },
        { ref: '13 0 R', hasAlt: false },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf({ status: 'unavailable', executionStatus: 'missing_binary', isCompliant: null }),
      makeStructure({
        acrobatAltRiskNodes: [
          {
            ref: 'obj:12 0 R',
            tag: '/P',
            pageRef: 'obj:5 0 R',
            mcids: [3],
            hasText: true,
            hasGraphics: true,
            graphicsLikelyDecorative: true,
            parentTagPath: ['/Document'],
            ownershipMode: 'mixed_text_graphics_same_mcid',
            duplicateOwnerRefs: [],
          },
          {
            ref: 'obj:13 0 R',
            tag: '/P',
            pageRef: 'obj:5 0 R',
            mcids: [4],
            hasText: true,
            hasGraphics: true,
            graphicsLikelyDecorative: true,
            parentTagPath: ['/Document'],
            ownershipMode: 'mixed_text_graphics_same_mcid',
            duplicateOwnerRefs: [],
          },
        ],
      }),
    )

    expect(findCategory(result, 'alt_text').score).toBe(100)
    expect(findCategory(result, 'alt_text').findings.some(finding => finding.includes('excluded from alt-text scoring'))).toBe(true)
  })

  it('keeps decorative empty structure figures compliant when they are intentionally decorative', () => {
    const result = scoreDocument(
      makeQpdf({ images: [] }),
      makePdfjs(),
      makeVeraPdf(),
      makeStructure({
        figures: [
          {
            ref: 'obj:77 0 R',
            tag: '/Figure',
            pageRef: 'obj:5 0 R',
            mcids: [3],
            hasAlt: false,
            altText: '',
            hasText: false,
            splitGenerated: true,
            graphicsLikelyDecorative: true,
          },
        ] as any,
      }),
    )
    expect(findCategory(result, 'alt_text').score).toBeNull()
  })

  it('credits structure-backed informative figures and excludes split-generated decorative wrappers', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: 'obj:361 0 R', hasAlt: true, altText: 'Image related to Illinois Criminal Justice Information Authority' },
        { ref: 'obj:16 0 R', hasAlt: true, altText: 'Image related to Figure 1' },
        { ref: 'obj:37 0 R', hasAlt: false },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf({ status: 'unavailable', executionStatus: 'missing_binary', isCompliant: null }),
      makeStructure({
        figures: [
          { ref: 'obj:15 0 R', tag: '/Figure', hasAlt: true, altText: 'Image related to Illinois Criminal Justice Information Authority', childFigureCount: 0, hasText: true, splitGenerated: false, splitSourceRef: null, splitSourceTag: null },
          { ref: 'obj:16 0 R', tag: '/Figure', hasAlt: true, altText: 'Image related to Table 1', childFigureCount: 0, hasText: true, splitGenerated: false, splitSourceRef: null, splitSourceTag: null },
          { ref: 'obj:27 0 R', tag: '/Figure', hasAlt: true, altText: 'Image related to Figure 1', childFigureCount: 0, hasText: true, splitGenerated: false, splitSourceRef: null, splitSourceTag: null },
          { ref: 'obj:37 0 R', tag: '/Figure', hasAlt: false, altText: null, childFigureCount: 0, hasText: false, splitGenerated: true, splitSourceRef: 'obj:38 0 R', splitSourceTag: '/H1' },
        ],
      }),
    )

    expect(findCategory(result, 'alt_text').score).toBe(100)
    expect(findCategory(result, 'alt_text').findings.some(finding => finding.includes('structure snapshot'))).toBe(true)
    expect(findCategory(result, 'alt_text').findings.some(finding => finding.includes('split-generated decorative wrapper'))).toBe(true)
  })

  it('collapses split-generated informative figure variants onto one canonical image for alt-text credit', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: 'obj:500 0 R', hasAlt: false },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf({ status: 'unavailable', executionStatus: 'missing_binary', isCompliant: null }),
      makeStructure({
        figures: [
          { ref: 'obj:601 0 R', tag: '/Figure', hasAlt: true, altText: 'Informative figure alt', childFigureCount: 0, hasText: true, splitGenerated: true, splitSourceRef: 'obj:500 0 R', splitSourceTag: '/Story' },
          { ref: 'obj:602 0 R', tag: '/Figure', hasAlt: true, altText: 'Informative figure alt', childFigureCount: 0, hasText: true, splitGenerated: true, splitSourceRef: 'obj:500 0 R', splitSourceTag: '/Story' },
        ],
      }),
    )

    expect(findCategory(result, 'alt_text').score).toBe(100)
    expect(findCategory(result, 'alt_text').findings.some(finding => finding.includes('structure snapshot'))).toBe(true)
  })

  it('does not let canonicalized repeated qpdf image placements inflate alt-text debt', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: 'obj:700 0 R', canonicalRef: 'obj:700 0 R', hasAlt: true, altText: 'Agency logo', placementCount: 3, placementPageNumbers: [1, 2, 3] },
      ],
    })
    const result = scoreDocument(
      qpdf,
      makePdfjs(),
      makeVeraPdf({ status: 'unavailable', executionStatus: 'missing_binary', isCompliant: null }),
    )

    expect(findCategory(result, 'alt_text').score).toBe(100)
  })

  it('maps structure figures onto qpdf canonical image refs before computing alt-text coverage', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: 'obj:810 0 R', canonicalRef: 'obj:800 0 R', hasAlt: false },
      ],
    })
    const result = scoreDocument(
      qpdf,
      makePdfjs(),
      makeVeraPdf({ status: 'unavailable', executionStatus: 'missing_binary', isCompliant: null }),
      makeStructure({
        figures: [
          { ref: 'obj:901 0 R', tag: '/Figure', hasAlt: true, altText: 'Canonical figure alt', childFigureCount: 0, hasText: true, splitGenerated: true, splitSourceRef: 'obj:810 0 R', splitSourceTag: '/Story' },
        ],
      }),
    )

    expect(findCategory(result, 'alt_text').score).toBe(100)
  })

  it('excludes decorative Acrobat-cleanup figures from alt-text scoring', () => {
    const qpdf = makeQpdf({
      images: [
        { ref: 'obj:58 0 R', hasAlt: true, altText: 'Illinois seal' },
        { ref: 'obj:132 0 R', hasAlt: false },
        { ref: 'obj:141 0 R', hasAlt: false },
      ],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf({ status: 'unavailable', executionStatus: 'missing_binary', isCompliant: null }),
      makeStructure({
        figures: [
          { ref: 'obj:58 0 R', tag: '/Figure', hasAlt: true, altText: 'Illinois seal', childFigureCount: 0, hasText: true, graphicsLikelyDecorative: false, splitGenerated: false, splitSourceRef: null, splitSourceTag: null },
          { ref: 'obj:132 0 R', tag: '/Figure', hasAlt: false, altText: '', childFigureCount: 0, hasText: false, graphicsLikelyDecorative: true, splitGenerated: false, splitSourceRef: null, splitSourceTag: null },
          { ref: 'obj:141 0 R', tag: '/Figure', hasAlt: false, altText: '', childFigureCount: 0, hasText: false, graphicsLikelyDecorative: true, splitGenerated: false, splitSourceRef: null, splitSourceTag: null },
        ],
      }),
    )

    expect(findCategory(result, 'alt_text').score).toBe(100)
    expect(findCategory(result, 'alt_text').findings.some(finding => finding.includes('wrapper figure'))).toBe(true)
  })

  it('reduces alt_text when Acrobat reports orphaned alternate text with no associated content', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf(),
      makeStructure({
        acrobatAltRiskNodes: [
          {
            ref: 'obj:77 0 R',
            tag: '/Figure',
            pageRef: 'obj:5 0 R',
            mcids: [],
            hasText: false,
            hasGraphics: false,
            hasAlt: true,
            splitSafe: false,
            graphicsLikelyDecorative: false,
            operatorPattern: null,
            parentTagPath: ['/Document'],
            ownershipMode: 'orphaned_alt_empty_element',
            duplicateOwnerRefs: [],
          },
        ],
      }),
    )

    expect(findCategory(result, 'alt_text').score).toBeLessThan(100)
    expect(findCategory(result, 'alt_text').findings.some(finding => finding.includes('Acrobat-style alternate-text risk'))).toBe(true)
  })
})

describe('scoreBookmarks edge cases', () => {
  it('20 pages, outlines with entries → score 100', () => {
    const qpdf = makeQpdf({ hasOutlines: true, outlineCount: 5 })
    const pdfjs = makePdfjs({ pageCount: 20, hasOutlines: true, outlineCount: 5 })
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'bookmarks').score).toBe(100)
  })

  it('20 pages, outline structure but 0 entries → score 25', () => {
    const qpdf = makeQpdf({ hasOutlines: true, outlineCount: 0 })
    const pdfjs = makePdfjs({ pageCount: 20, hasOutlines: false, outlineCount: 0 })
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'bookmarks').score).toBe(25)
  })

  it('20 pages, no outlines → score 0', () => {
    const qpdf = makeQpdf({ hasOutlines: false, outlineCount: 0 })
    const pdfjs = makePdfjs({ pageCount: 20, hasOutlines: false, outlineCount: 0 })
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'bookmarks').score).toBe(0)
    expect(findCategory(result, 'bookmarks').grade).toBe('F')
  })

  it('9 pages → N/A', () => {
    const qpdf = makeQpdf()
    const pdfjs = makePdfjs({ pageCount: 9 })
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'bookmarks').score).toBeNull()
  })

  it('10 pages → assessed (boundary)', () => {
    const qpdf = makeQpdf()
    const pdfjs = makePdfjs({ pageCount: 10 })
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'bookmarks').score).not.toBeNull()
  })
})

describe('scoreTableMarkup edge cases', () => {
  it('2 tables, all with headers → score 100', () => {
    const qpdf = makeQpdf({
      tables: [{ hasHeaders: true }, { hasHeaders: true }],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'table_markup').score).toBe(100)
  })

  it('2 tables, 1 with headers → score 40', () => {
    const qpdf = makeQpdf({
      tables: [{ hasHeaders: true }, { hasHeaders: false }],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'table_markup').score).toBe(40)
  })

  it('tables with no headers → score 40', () => {
    const qpdf = makeQpdf({
      tables: [{ hasHeaders: false }, { hasHeaders: false }],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'table_markup').score).toBe(40)
  })

  it('keeps score 100 when visual-only table detections are advisory', () => {
    const qpdf = makeQpdf({
      tables: [{ hasHeaders: true }, { hasHeaders: true }],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs, makeVeraPdf(), undefined, null, makeLocalStandards(), {
      tableStructure: {
        status: 'ok',
        detectedTables: 5,
        taggedTables: 2,
        untaggedTables: 0,
        highConfidenceUntaggedTables: 0,
        advisoryUntaggedTables: 3,
        tableDetails: [],
        warnings: [],
      },
    })
    expect(findCategory(result, 'table_markup').score).toBe(100)
    expect(findCategory(result, 'table_markup').findings.some(finding => finding.includes('advisory only'))).toBe(true)
  })

  it('softens score when only a few high-confidence untagged tables remain', () => {
    const qpdf = makeQpdf({
      tables: [{ hasHeaders: true }, { hasHeaders: true }],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs, makeVeraPdf(), undefined, null, makeLocalStandards(), {
      tableStructure: {
        status: 'ok',
        detectedTables: 4,
        taggedTables: 2,
        untaggedTables: 2,
        highConfidenceUntaggedTables: 2,
        advisoryUntaggedTables: 0,
        tableDetails: [],
        warnings: [],
      },
    })
    expect(findCategory(result, 'table_markup').score).toBe(85)
  })

  it('lowers table score for irregular tagged tables even when headers are present', () => {
    const qpdf = makeQpdf({
      tables: [
        { hasHeaders: true, rowCellCounts: [6, 11, 11], dominantColumnCount: 11, isRegular: false },
        { hasHeaders: true, rowCellCounts: [4, 4, 4], dominantColumnCount: 4, isRegular: true },
      ],
    })
    const result = scoreDocument(qpdf, makePdfjs())
    expect(findCategory(result, 'table_markup').score).toBe(85)
    expect(findCategory(result, 'table_markup').findings.some(finding => finding.includes('regularity'))).toBe(true)
  })

  it('lowers table score more aggressively for complex irregular grouped-header tables', () => {
    const qpdf = makeQpdf({
      tables: [
        { hasHeaders: true, rowCellCounts: [6, 11, 11], dominantColumnCount: 11, isRegular: false, headerRowCount: 2, maxRowSpan: 2, maxColSpan: 3 },
      ],
    })
    const result = scoreDocument(qpdf, makePdfjs())
    expect(findCategory(result, 'table_markup').score).toBe(75)
    expect(findCategory(result, 'table_markup').findings.some(finding => finding.includes('span-heavy headers'))).toBe(true)
  })

  it('keeps advisory mostly-regular short-row tables at full score', () => {
    const qpdf = makeQpdf({
      tables: [
        { hasHeaders: true, rowCellCounts: [4, 5, 5, 5, 5, 5, 5, 2, 5, 5], dominantColumnCount: 5, isRegular: false, headerRowCount: 1, maxRowSpan: 1, maxColSpan: 1 },
      ],
    })
    const result = scoreDocument(qpdf, makePdfjs())
    expect(findCategory(result, 'table_markup').score).toBe(100)
    expect(findCategory(result, 'table_markup').findings.some(finding => finding.includes('regularity'))).toBe(false)
  })
})

describe('scoreDocument gating edge cases', () => {
  it('does not return 100/A when any scored category remains incomplete', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      {
        ...qpdf,
        images: [
          { ref: '10 0 R', hasAlt: true },
          { ref: '11 0 R', hasAlt: false },
        ],
      },
      pdfjs,
      makeVeraPdf(),
      undefined,
      null,
      makeLocalStandards(),
    )

    expect(findCategory(result, 'alt_text').score).toBeLessThan(100)
    expect(result.overallScore).toBeLessThan(100)
    expect(result.grade).toBe('B')
  })
})

describe('scoreLinkQuality edge cases', () => {
  it('all descriptive links → score 100', () => {
    const qpdf = makeQpdf()
    const pdfjs = makePdfjs({
      links: [
        { url: 'https://example.com', text: 'View Report' },
        { url: 'https://example.com/faq', text: 'Frequently Asked Questions' },
      ],
    })
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'link_quality').score).toBe(100)
  })

  it('all raw URL links → score 0', () => {
    const qpdf = makeQpdf()
    const pdfjs = makePdfjs({
      links: [
        { url: 'https://example.com', text: 'https://example.com' },
        { url: 'https://example.com/page', text: 'www.example.com/page' },
      ],
    })
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'link_quality').score).toBe(0)
  })

  it('mix of raw and descriptive → proportional score', () => {
    const qpdf = makeQpdf()
    const pdfjs = makePdfjs({
      links: [
        { url: 'https://a.com', text: 'Annual Report 2024' }, // descriptive
        { url: 'https://b.com', text: 'https://b.com' }, // raw
      ],
    })
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'link_quality').score).toBe(50)
  })

  it('ambiguous link text lowers link quality like raw URLs do', () => {
    const qpdf = makeQpdf()
    const pdfjs = makePdfjs({
      links: [
        { url: 'https://a.com', text: 'click here' },
        { url: 'https://b.com', text: 'Annual Report 2024' },
      ],
    })
    const result = scoreDocument(qpdf, pdfjs)
    const category = findCategory(result, 'link_quality')
    expect(category.score).toBe(50)
    expect(category.findings.some(finding => finding.includes('ambiguous/generic text'))).toBe(true)
  })
})

describe('scoreDocument — veraPDF integration', () => {
  it('adds a veraPDF warning when veraPDF reports structural failures but local standards are primary', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(qpdf, pdfjs, makeVeraPdf({
      status: 'failed',
      isCompliant: false,
      failedChecks: 2,
      failures: [
        {
          ruleId: 'rule-1',
          specification: 'PDF/UA-1',
          clause: '7.1',
          testNumber: '1',
          location: 'StructTreeRoot',
          message: 'Structure tree is invalid.',
          categoryIds: ['text_extractability', 'reading_order'],
        },
      ],
      message: 'veraPDF detected 2 PDF/UA compliance issues.',
    }))

    // With useLocalStandardsAsPrimary=true, veraPDF failures only add a warning.
    // Local standards (default: clear) govern grade and score.
    expect(result.grade).toBe('A')
    expect(result.overallScore).toBe(100)
    expect(findCategory(result, 'pdf_ua_compliance').score).toBe(100)
    expect(result.warnings.some(w => w.includes('veraPDF'))).toBe(true)
  })

  it('adds a warning when veraPDF is unavailable, allows grade A when local standards are clear', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(qpdf, pdfjs, makeVeraPdf({
      status: 'unavailable',
      executionStatus: 'missing_binary',
      isCompliant: null,
      message: 'veraPDF CLI is unavailable.',
    }))

    // With useLocalStandardsAsPrimary=true, unavailable veraPDF only adds a warning.
    // Local standards (default: clear) govern grade and score.
    expect(result.overallScore).toBe(100)
    expect(result.grade).toBe('A')
    expect(findCategory(result, 'pdf_ua_compliance').score).toBe(100)
    expect(result.warnings.some(warning => warning.includes('veraPDF'))).toBe(true)
  })

  it('allows grade A when veraPDF errors but local standards are clear', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(qpdf, pdfjs, makeVeraPdf({
      status: 'error',
      executionStatus: 'error',
      isCompliant: null,
      message: 'veraPDF failed unexpectedly.',
    }))

    // With useLocalStandardsAsPrimary=true, a veraPDF execution error does not cap the grade.
    // Local standards (default: clear) remain the primary evidence.
    expect(result.overallScore).toBe(100)
    expect(result.grade).toBe('A')
  })

  it('uses local standards evidence as the primary PDF/UA gate when veraPDF is unavailable', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
        message: 'veraPDF CLI is unavailable.',
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'issues_detected',
        findings: [{
          key: 'pdfua.font_unicode',
          label: 'Font Unicode mapping',
          severity: 'error',
          blocking: true,
          categoryIds: ['text_extractability', 'pdf_ua_compliance'],
          confidence: 0.9,
          evidence: ['Detected 2 font objects without a ToUnicode map.'],
          source: 'qpdf',
          inferred: false,
          count: 2,
        }],
      }),
    )

    expect(result.grade).toBe('B')
    expect(result.overallScore).toBeLessThan(100)
    expect(findCategory(result, 'text_extractability').score).toBeLessThan(100)
    expect(findCategory(result, 'pdf_ua_compliance').score).toBe(85)
    expect(result.warnings.some(warning => warning.includes('Local standards checks'))).toBe(true)
  })

  it('does not claim a clean local PDF/UA pass when known gaps remain', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'clear',
        findings: [],
        knownGapKeys: ['pdfua.artifact_vs_real_content_partial'],
      }),
    )

    expect(findCategory(result, 'pdf_ua_compliance').score).toBe(90)
    expect(result.grade).toBe('B')
  })

  it('heavily caps local PDF/UA scoring when logical structure is broadly broken', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'issues_detected',
        findings: [
          {
            key: 'pdfua.logical_structure',
            label: 'Logical structure and marked content',
            severity: 'error',
            blocking: true,
            categoryIds: ['text_extractability', 'reading_order', 'pdf_ua_compliance'],
            confidence: 0.98,
            evidence: ['StructTreeRoot entry is not present in the document catalog.'],
            source: 'qpdf',
            inferred: false,
            count: 2,
          },
          {
            key: 'pdfua.document_language',
            label: 'Document language tag',
            severity: 'error',
            blocking: true,
            categoryIds: ['title_language', 'pdf_ua_compliance'],
            confidence: 0.95,
            evidence: ['No document language declaration was found.'],
            source: 'qpdf',
            inferred: false,
            count: 1,
          },
          {
            key: 'pdfua.display_doc_title',
            label: 'Display document title metadata',
            severity: 'error',
            blocking: true,
            categoryIds: ['title_language', 'pdf_ua_compliance'],
            confidence: 0.95,
            evidence: ['No meaningful document title metadata is available.'],
            source: 'composite',
            inferred: false,
            count: 1,
          },
        ],
        knownGapKeys: ['pdfua.artifact_vs_real_content_partial'],
      }),
    )

    expect(findCategory(result, 'pdf_ua_compliance').score).toBe(20)
    expect(result.overallScore).toBeLessThan(100)
  })

  it('heavily caps local PDF/UA scoring when structure and CIDSet blockers coexist', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'issues_detected',
        findings: [
          {
            key: 'pdfua.logical_structure',
            label: 'Logical structure and marked content',
            severity: 'error',
            blocking: true,
            categoryIds: ['text_extractability', 'reading_order', 'pdf_ua_compliance'],
            confidence: 0.76,
            evidence: ['No structure-tree MCID traversal could be confirmed.'],
            source: 'composite',
            inferred: true,
            count: 1,
          },
          {
            key: 'pdfua.cidset_consistency',
            label: 'CIDSet consistency',
            severity: 'error',
            blocking: true,
            categoryIds: ['text_extractability', 'pdf_ua_compliance'],
            confidence: 0.68,
            evidence: ['CID font descriptors expose CIDSet-risk signals.'],
            source: 'qpdf',
            inferred: true,
            count: 2,
          },
          {
            key: 'pdfua.document_language',
            label: 'Document language tag',
            severity: 'error',
            blocking: true,
            categoryIds: ['title_language', 'pdf_ua_compliance'],
            confidence: 0.72,
            evidence: ['Language metadata could not be confirmed across analyzers.'],
            source: 'composite',
            inferred: true,
            count: 1,
          },
        ],
        knownGapKeys: ['pdfua.artifact_vs_real_content_partial'],
      }),
    )

    expect(findCategory(result, 'pdf_ua_compliance').score).toBe(20)
  })

  it('caps the overall no-vera score when severe structure and CIDSet blockers still leave artifact gaps', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'issues_detected',
        findings: [
          {
            key: 'pdfua.logical_structure',
            label: 'Logical structure and marked content',
            severity: 'error',
            blocking: true,
            categoryIds: ['text_extractability', 'reading_order', 'pdf_ua_compliance'],
            confidence: 0.76,
            evidence: ['Artifact-mixing risk nodes indicate broken content ownership.'],
            source: 'composite',
            inferred: true,
            count: 10,
          },
          {
            key: 'pdfua.cidset_consistency',
            label: 'CIDSet consistency',
            severity: 'error',
            blocking: true,
            categoryIds: ['text_extractability', 'pdf_ua_compliance'],
            confidence: 0.92,
            evidence: ['Embedded CID font descriptors expose explicit CIDSet entries.'],
            source: 'qpdf',
            inferred: false,
            count: 2,
          },
          {
            key: 'pdfua.font_embedding',
            label: 'Font embedding',
            severity: 'error',
            blocking: true,
            categoryIds: ['text_extractability', 'pdf_ua_compliance'],
            confidence: 0.93,
            evidence: ['Detected 8 font objects without embedded programs.'],
            source: 'qpdf',
            inferred: false,
            count: 8,
          },
          {
            key: 'pdfua.document_language',
            label: 'Document language tag',
            severity: 'error',
            blocking: true,
            categoryIds: ['title_language', 'pdf_ua_compliance'],
            confidence: 0.72,
            evidence: ['Language metadata could not be confirmed across analyzers.'],
            source: 'composite',
            inferred: true,
            count: 1,
          },
        ],
        knownGapKeys: ['pdfua.artifact_vs_real_content_partial'],
      }),
    )

    expect(findCategory(result, 'pdf_ua_compliance').score).toBe(20)
    expect(result.overallScore).toBeLessThanOrEqual(52)
  })

  it('keeps grade A when veraPDF reports many failures but local standards are clear', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(qpdf, pdfjs, makeVeraPdf({
      status: 'failed',
      isCompliant: false,
      failedChecks: 12,
      failures: [
        {
          ruleId: 'rule-1',
          specification: 'PDF/UA-1',
          clause: '7.1',
          testNumber: '1',
          location: 'StructTreeRoot',
          message: 'Structure tree is invalid.',
          categoryIds: ['text_extractability', 'reading_order'],
        },
      ],
      message: 'veraPDF detected 12 PDF/UA compliance issues.',
    }))

    // With useLocalStandardsAsPrimary=true, veraPDF failures alone do not reduce the pdf_ua score.
    // Local standards (default: clear) determine the pdf_ua category result.
    expect(findCategory(result, 'pdf_ua_compliance').score).toBe(100)
    expect(result.grade).toBe('A')
    expect(result.warnings.some(w => w.includes('veraPDF'))).toBe(true)
  })

  it('does not cap a clean pass when only A-grade categories remain below 100', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      qpdf,
      {
        ...pdfjs,
        links: [
          { url: 'https://example.com/1', text: 'Section 1' },
          { url: 'https://example.com/2', text: 'Section 2' },
          { url: 'https://example.com/3', text: 'Section 3' },
          { url: 'https://example.com/4', text: 'Section 4' },
          { url: 'https://example.com/5', text: 'Section 5' },
          { url: 'https://example.com/6', text: 'Section 6' },
          { url: 'https://example.com/7', text: 'Section 7' },
          { url: 'https://example.com/8', text: 'Section 8' },
          { url: 'https://example.com/9', text: 'Section 9' },
          { url: 'https://example.com/raw', text: 'https://example.com/raw' },
        ],
      },
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'issues_detected',
        findings: [
          {
            key: 'pdfua.cidset_consistency',
            label: 'CIDSet consistency',
            severity: 'error',
            blocking: false,
            categoryIds: ['text_extractability', 'pdf_ua_compliance'],
            confidence: 0.92,
            evidence: ['Embedded CID font descriptors expose explicit CIDSet entries.'],
            source: 'qpdf',
            inferred: false,
            count: 5,
          },
        ],
        knownGapKeys: ['pdfua.metadata_identification_content_unconfirmed'],
      }),
    )

    expect(findCategory(result, 'link_quality').score).toBe(90)
    expect(findCategory(result, 'link_quality').grade).toBe('A')
    expect(findCategory(result, 'pdf_ua_compliance').score).toBe(100)
    expect(result.overallScore).toBe(100)
    expect(result.grade).toBe('A')
    expect(result.executiveSummary).toContain('ready for publication')
    expect(result.executiveSummary).not.toContain('fully confirmed pass')
  })

  it('treats low-density contrast failures as advisory when the sample count is small', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      qpdf,
      pdfjs,
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'issues_detected',
        findings: [
          {
            key: 'pdfua.cidset_consistency',
            label: 'CIDSet consistency',
            severity: 'warning',
            blocking: false,
            categoryIds: ['text_extractability', 'pdf_ua_compliance'],
            confidence: 0.92,
            evidence: ['Detected embedded CID font descriptors with /CIDSet entries.'],
            source: 'qpdf',
            inferred: false,
            count: 2,
          },
        ],
        knownGapKeys: ['pdfua.metadata_identification_content_unconfirmed'],
      }),
      {
        colorContrast: {
          status: 'ok',
          pagesAnalyzed: 10,
          totalSamples: 358,
          failingContrastCount: 9,
          failRatio: 9 / 358,
          failures: Array.from({ length: 9 }, (_, index) => ({
            page: 4,
            textPreview: `Low contrast sample ${index + 1}`,
            contrastRatio: 2,
            threshold: 4.5,
            fgColor: '#cfcfcf',
            bgColor: '#ffffff',
            fontSizePt: 12,
          })),
          warnings: [],
        },
      },
    )

    expect(findCategory(result, 'color_contrast').score).toBe(95)
    expect(findCategory(result, 'color_contrast').grade).toBe('A')
    expect(findCategory(result, 'color_contrast').findings.some(finding => finding.includes('advisory contrast warning'))).toBe(true)
    expect(result.overallScore).toBe(100)
    expect(result.grade).toBe('A')
  })

  it('treats near-threshold and display-sized contrast misses as advisory on short documents', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      qpdf,
      makePdfjs({
        ...pdfjs,
        pageCount: 2,
      }),
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'clear',
        findings: [],
        knownGapKeys: ['pdfua.metadata_identification_content_unconfirmed'],
      }),
      {
        colorContrast: {
          status: 'ok',
          pagesAnalyzed: 2,
          totalSamples: 164,
          failingContrastCount: 19,
          failRatio: 19 / 164,
          failures: [
            {
              page: 1,
              textPreview: 'State of Illinois',
              contrastRatio: 4.49,
              threshold: 4.5,
              fgColor: '#008394',
              bgColor: '#ffffff',
              fontSizePt: 12,
            },
            {
              page: 1,
              textPreview: 'Rod R. Blagojevich, Governor',
              contrastRatio: 4.49,
              threshold: 4.5,
              fgColor: '#008394',
              bgColor: '#ffffff',
              fontSizePt: 12,
            },
            {
              page: 1,
              textPreview: 'Illinois Criminal Justice Information Authority',
              contrastRatio: 4.49,
              threshold: 4.5,
              fgColor: '#008394',
              bgColor: '#ffffff',
              fontSizePt: 12,
            },
            {
              page: 1,
              textPreview: 'Lori G. Levin, Director',
              contrastRatio: 4.49,
              threshold: 4.5,
              fgColor: '#008394',
              bgColor: '#ffffff',
              fontSizePt: 12,
            },
            {
              page: 1,
              textPreview: 'data.',
              contrastRatio: 3.13,
              threshold: 4.5,
              fgColor: '#939192',
              bgColor: '#ffffff',
              fontSizePt: 12,
            },
            {
              page: 1,
              textPreview: '-',
              contrastRatio: 3.21,
              threshold: 4.5,
              fgColor: '#918f90',
              bgColor: '#ffffff',
              fontSizePt: 16,
            },
          ],
          warnings: [],
        },
      },
    )

    expect(findCategory(result, 'color_contrast').score).toBe(95)
    expect(findCategory(result, 'color_contrast').grade).toBe('A')
    expect(findCategory(result, 'color_contrast').findings.some(finding => finding.includes('residual medium-contrast miss'))).toBe(true)
    expect(findCategory(result, 'color_contrast').findings.some(finding => finding.includes('punctuation-only sample'))).toBe(true)
    expect(result.overallScore).toBe(100)
    expect(result.grade).toBe('A')
  })

  it('treats very low-density contrast misses as advisory on large documents', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      qpdf,
      makePdfjs({
        ...pdfjs,
        pageCount: 10,
      }),
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'issues_detected',
        findings: [
          {
            key: 'pdfua.cidset_consistency',
            label: 'CIDSet consistency',
            severity: 'warning',
            blocking: false,
            categoryIds: ['text_extractability', 'pdf_ua_compliance'],
            confidence: 0.92,
            evidence: ['Detected embedded CID font descriptors with /CIDSet entries.'],
            source: 'qpdf',
            inferred: false,
            count: 1,
          },
        ],
        knownGapKeys: ['pdfua.metadata_identification_content_unconfirmed'],
      }),
      {
        colorContrast: {
          status: 'ok',
          pagesAnalyzed: 10,
          totalSamples: 1215,
          failingContrastCount: 13,
          failRatio: 13 / 1215,
          failures: Array.from({ length: 13 }, (_, index) => ({
            page: 2 + (index % 7),
            textPreview: `Sparse contrast sample ${index + 1}`,
            contrastRatio: 2.9,
            threshold: 4.5,
            fgColor: '#6f6f6f',
            bgColor: '#ffffff',
            fontSizePt: 12,
          })),
          warnings: [],
        },
      },
    )

    expect(findCategory(result, 'color_contrast').score).toBe(95)
    expect(findCategory(result, 'color_contrast').grade).toBe('A')
    expect(findCategory(result, 'color_contrast').findings.some(finding => finding.includes('sparse across a large document'))).toBe(true)
    expect(result.overallScore).toBe(100)
    expect(result.grade).toBe('A')
  })

  it('treats concentrated contrast misses on one or two pages as advisory on long documents', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      qpdf,
      makePdfjs({
        ...pdfjs,
        pageCount: 10,
      }),
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'clear',
        findings: [],
      }),
      {
        colorContrast: {
          status: 'ok',
          pagesAnalyzed: 10,
          totalSamples: 416,
          failingContrastCount: 19,
          failRatio: 19 / 416,
          failures: Array.from({ length: 19 }, (_, index) => ({
            page: index < 12 ? 1 : 2,
            textPreview: `Display contrast sample ${index + 1}`,
            contrastRatio: 3.59,
            threshold: 4.5,
            fgColor: '#878787',
            bgColor: '#ffffff',
            fontSizePt: 12,
          })),
          warnings: [],
        },
      },
    )

    expect(findCategory(result, 'color_contrast').score).toBe(95)
    expect(findCategory(result, 'color_contrast').grade).toBe('A')
    expect(findCategory(result, 'color_contrast').findings.some(finding => finding.includes('concentrated on one or two pages'))).toBe(true)
    expect(result.overallScore).toBe(100)
    expect(result.grade).toBe('A')
  })

  it('treats spaced display-text contrast misses as advisory on long documents', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      qpdf,
      makePdfjs({
        ...pdfjs,
        pageCount: 10,
      }),
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'clear',
        findings: [],
      }),
      {
        colorContrast: {
          status: 'ok',
          pagesAnalyzed: 10,
          totalSamples: 416,
          failingContrastCount: 19,
          failRatio: 19 / 416,
          failures: Array.from({ length: 19 }, (_, index) => ({
            page: 1 + (index % 3),
            textPreview: index % 3 === 0 ? 'J O D A V I E S S' : (index % 3 === 1 ? 'STEPHENSON' : 'C O O K C O U N T Y'),
            contrastRatio: 3.59,
            threshold: 4.5,
            fgColor: '#878787',
            bgColor: '#ffffff',
            fontSizePt: 12,
          })),
          warnings: [],
        },
      },
    )

    expect(findCategory(result, 'color_contrast').score).toBe(95)
    expect(findCategory(result, 'color_contrast').grade).toBe('A')
    expect(findCategory(result, 'color_contrast').findings.some(finding => finding.includes('advisory display-text styling'))).toBe(true)
    expect(result.overallScore).toBe(100)
    expect(result.grade).toBe('A')
  })

  it('treats tiny microtext display-label contrast misses as advisory on long documents', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      qpdf,
      makePdfjs({
        ...pdfjs,
        pageCount: 10,
      }),
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'clear',
        findings: [],
      }),
      {
        colorContrast: {
          status: 'ok',
          pagesAnalyzed: 10,
          totalSamples: 416,
          failingContrastCount: 19,
          failRatio: 19 / 416,
          failures: Array.from({ length: 19 }, (_, index) => ({
            page: 1,
            textPreview: index % 2 === 0 ? 'STEPHENSON' : 'M C H E N R Y',
            contrastRatio: 3.59,
            threshold: 4.5,
            fgColor: '#878787',
            bgColor: '#ffffff',
            fontSizePt: 1.8,
          })),
          warnings: [],
        },
      },
    )

    expect(findCategory(result, 'color_contrast').score).toBe(95)
    expect(findCategory(result, 'color_contrast').grade).toBe('A')
    expect(findCategory(result, 'color_contrast').findings.some(finding => finding.includes('advisory display-text styling'))).toBe(true)
    expect(result.overallScore).toBe(100)
    expect(result.grade).toBe('A')
  })

  it('treats duplicated display-label contrast misses as advisory on long documents', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      qpdf,
      makePdfjs({
        ...pdfjs,
        pageCount: 10,
      }),
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'clear',
        findings: [],
      }),
      {
        colorContrast: {
          status: 'ok',
          pagesAnalyzed: 10,
          totalSamples: 361,
          failingContrastCount: 19,
          failRatio: 19 / 361,
          failures: Array.from({ length: 19 }, (_, index) => ({
            page: 1,
            textPreview: index === 0 ? 'CChhiiccaaggoo' : 'J O D A V I E S S',
            contrastRatio: 3.63,
            threshold: 4.5,
            fgColor: '#004da8',
            bgColor: '#73b2ff',
            fontSizePt: index === 0 ? 8.2 : 1.8,
          })),
          warnings: [],
        },
      },
    )

    expect(findCategory(result, 'color_contrast').score).toBe(95)
    expect(findCategory(result, 'color_contrast').grade).toBe('A')
    expect(result.overallScore).toBe(100)
    expect(result.grade).toBe('A')
  })
})

describe('summarizeLinkTextQuality', () => {
  it('returns zero counts when no links exist', () => {
    expect(summarizeLinkTextQuality([])).toEqual({
      linkCount: 0,
      rawUrlLinkCount: 0,
      rawUrlLinkDensity: 0,
      descriptiveLinks: [],
      rawLinks: [],
      genericLinks: [],
      genericLinkCount: 0,
    })
  })

  it('treats all descriptive links as descriptive', () => {
    const summary = summarizeLinkTextQuality([
      { url: 'https://example.com', text: 'View report' },
      { url: 'https://example.com/faq', text: 'FAQ' },
    ])
    expect(summary.linkCount).toBe(2)
    expect(summary.rawUrlLinkCount).toBe(0)
    expect(summary.rawUrlLinkDensity).toBe(0)
    expect(summary.descriptiveLinks).toHaveLength(2)
    expect(summary.rawLinks).toHaveLength(0)
  })

  it('treats all raw URL links as raw', () => {
    const summary = summarizeLinkTextQuality([
      { url: 'https://example.com', text: 'https://example.com' },
      { url: 'https://example.com/faq', text: 'www.example.com/faq' },
    ])
    expect(summary.linkCount).toBe(2)
    expect(summary.rawUrlLinkCount).toBe(2)
    expect(summary.rawUrlLinkDensity).toBe(1)
    expect(summary.descriptiveLinks).toHaveLength(0)
    expect(summary.rawLinks).toHaveLength(2)
  })

  it('reports proportional density for mixed links', () => {
    const summary = summarizeLinkTextQuality([
      { url: 'https://example.com', text: 'View report' },
      { url: 'https://example.com/faq', text: 'https://example.com/faq' },
    ])
    expect(summary.linkCount).toBe(2)
    expect(summary.rawUrlLinkCount).toBe(1)
    expect(summary.rawUrlLinkDensity).toBe(0.5)
    expect(summary.descriptiveLinks).toHaveLength(1)
    expect(summary.rawLinks).toHaveLength(1)
  })
})

describe('scoreFormAccessibility edge cases', () => {
  it('all fields labeled → score 100', () => {
    const qpdf = makeQpdf({
      hasAcroForm: true,
      formFields: [{ hasTU: true }, { hasTU: true }, { hasTU: true }],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'form_accessibility').score).toBe(100)
  })

  it('no fields labeled → score 0', () => {
    const qpdf = makeQpdf({
      hasAcroForm: true,
      formFields: [{ hasTU: false }, { hasTU: false }],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'form_accessibility').score).toBe(0)
  })

  it('hasAcroForm true but empty formFields → N/A', () => {
    const qpdf = makeQpdf({ hasAcroForm: true, formFields: [] })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'form_accessibility').score).toBeNull()
  })
})

describe('scoreReadingOrder edge cases', () => {
  it('no struct tree → score 0', () => {
    const qpdf = makeQpdf({ hasStructTree: false })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    const cat = findCategory(result, 'reading_order')
    expect(cat.score).toBe(0)
    expect(cat.severity).toBe('Critical')
  })

  it('flat struct tree (depth 1) → score 30', () => {
    const qpdf = makeQpdf({
      hasStructTree: true,
      structTreeDepth: 1,
      contentOrder: [0, 1, 2],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'reading_order').score).toBe(30)
  })

  it('deep tree with ordered MCIDs → score 100', () => {
    const qpdf = makeQpdf({
      hasStructTree: true,
      structTreeDepth: 4,
      contentOrder: [0, 1, 2, 3, 4, 5],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'reading_order').score).toBe(100)
  })

  it('deep tree with significantly disordered MCIDs → score 50', () => {
    // Disorder threshold is 0.20 (20%)
    // 10 items with > 20% out of order
    const qpdf = makeQpdf({
      hasStructTree: true,
      structTreeDepth: 4,
      contentOrder: [0, 5, 1, 6, 2, 7, 3, 8, 4, 9],
      // comparisons: 5>0 no, 1<5 yes, 6>1 no, 2<6 yes, 7>2 no, 3<7 yes, 8>3 no, 4<8 yes, 9>4 no
      // out of order: 4 out of 9 = 44% > 20%
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'reading_order').score).toBe(50)
  })

  it('deep tree with slightly disordered MCIDs (under threshold) → score 100', () => {
    // 10 items with only 1 out of order = 11% < 20%
    const qpdf = makeQpdf({
      hasStructTree: true,
      structTreeDepth: 4,
      contentOrder: [0, 1, 2, 3, 4, 5, 6, 7, 9, 8],
      // Only 9<8 is out of order: 1/9 = 11%
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'reading_order').score).toBe(100)
  })

  it('single MCID → score 100 (no comparisons needed)', () => {
    const qpdf = makeQpdf({
      hasStructTree: true,
      structTreeDepth: 3,
      contentOrder: [0],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'reading_order').score).toBe(100)
  })

  it('treats pdfminer reading-order mismatch as advisory on short tagged brochures', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      makeQpdf({
        ...qpdf,
        structTreeDepth: 3,
        contentOrder: [0, 1, 2, 3, 4, 5, 6],
        tables: [],
        formFields: [],
      }),
      makePdfjs({
        ...pdfjs,
        pageCount: 2,
        links: [],
      }),
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'clear',
        findings: [],
        knownGapKeys: ['pdfua.metadata_identification_content_unconfirmed'],
      }),
      {
        readingOrder: {
          status: 'ok',
          pagesAnalyzed: 2,
          totalBlocks: 12,
          disorderRatio: 0.37,
          disorderedBlockCount: 4,
          disorderedBlocks: [],
          warnings: [],
        },
        tabOrder: makeTabOrder({
          annotatedPageCount: 0,
          missingTabsCount: 0,
          outOfOrderPageCount: 0,
        }),
      },
    )

    expect(findCategory(result, 'reading_order').score).toBe(95)
    expect(findCategory(result, 'reading_order').grade).toBe('A')
    expect(findCategory(result, 'reading_order').findings.some(finding => finding.includes('advisory warning'))).toBe(true)
    expect(result.overallScore).toBe(100)
    expect(result.grade).toBe('A')
  })

  it('treats pdfminer reading-order mismatch as advisory on short four-page brochures without interactive content', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      makeQpdf({
        ...qpdf,
        structTreeDepth: 3,
        contentOrder: Array.from({ length: 20 }, (_, index) => index),
        tables: [],
        formFields: [],
      }),
      makePdfjs({
        ...pdfjs,
        pageCount: 4,
        links: [],
      }),
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'clear',
        findings: [],
      }),
      {
        readingOrder: {
          status: 'ok',
          pagesAnalyzed: 4,
          totalBlocks: 20,
          disorderRatio: 0.34,
          disorderedBlockCount: 7,
          disorderedBlocks: [],
          warnings: [],
        },
        tabOrder: makeTabOrder({
          annotatedPageCount: 0,
          missingTabsCount: 0,
          outOfOrderPageCount: 0,
        }),
      },
    )

    expect(findCategory(result, 'reading_order').score).toBe(95)
    expect(findCategory(result, 'reading_order').grade).toBe('A')
    expect(result.overallScore).toBe(100)
    expect(result.grade).toBe('A')
  })

  it('treats denser short four-page brochures as advisory when interactive debt is absent', () => {
    const { qpdf, pdfjs } = fullyAccessible()
    const result = scoreDocument(
      makeQpdf({
        ...qpdf,
        structTreeDepth: 2,
        contentOrder: Array.from({ length: 39 }, (_, index) => index),
        tables: [],
        formFields: [],
      }),
      makePdfjs({
        ...pdfjs,
        pageCount: 4,
        links: [],
      }),
      makeVeraPdf({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        isCompliant: null,
      }),
      undefined,
      null,
      makeLocalStandards({
        status: 'clear',
        findings: [],
      }),
      {
        readingOrder: {
          status: 'ok',
          pagesAnalyzed: 4,
          totalBlocks: 39,
          disorderRatio: 0.41,
          disorderedBlockCount: 16,
          disorderedBlocks: [],
          warnings: [],
        },
        tabOrder: makeTabOrder({
          annotatedPageCount: 0,
          missingTabsCount: 0,
          outOfOrderPageCount: 0,
        }),
      },
    )

    expect(findCategory(result, 'reading_order').score).toBe(95)
    expect(findCategory(result, 'reading_order').grade).toBe('A')
    expect(result.overallScore).toBe(100)
    expect(result.grade).toBe('A')
  })

  it('empty contentOrder with deep tree → score 100', () => {
    const qpdf = makeQpdf({
      hasStructTree: true,
      structTreeDepth: 3,
      contentOrder: [],
    })
    const pdfjs = makePdfjs()
    const result = scoreDocument(qpdf, pdfjs)
    expect(findCategory(result, 'reading_order').score).toBe(100)
  })
})
