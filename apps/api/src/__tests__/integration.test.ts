import { beforeAll, describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import type { AnalysisResult } from '../services/pdfAnalyzer.js'

// ---------------------------------------------------------------------------
// Full pipeline integration tests using real PDF files
// ---------------------------------------------------------------------------
// These tests run the complete analysis pipeline: QPDF → pdfjs → scorer.
// They catch regressions in PDF parsing that unit tests with mock data miss
// (e.g., the QPDF v2 JSON format issue where objects wrap in { value: {...} }).
//
// Prerequisites: QPDF must be installed (`brew install qpdf` / `apt install qpdf`)
// ---------------------------------------------------------------------------

const fixturesDir = path.join(import.meta.dirname, 'fixtures')
let accessibleResult: AnalysisResult
let inaccessibleResult: AnalysisResult

function loadFixture(filename: string): Buffer {
  return fs.readFileSync(path.join(fixturesDir, filename))
}

function findCategory(result: AnalysisResult, id: string) {
  const cat = result.categories.find(c => c.id === id)
  if (!cat) throw new Error(`Category "${id}" not found`)
  return cat
}

beforeAll(async () => {
  ;[accessibleResult, inaccessibleResult] = await Promise.all([
    analyzePDF(loadFixture('accessible.pdf'), 'accessible.pdf'),
    analyzePDF(loadFixture('inaccessible.pdf'), 'inaccessible.pdf'),
  ])
}, 120_000)

// ---------------------------------------------------------------------------
// Accessible-ish PDF — syllabus_accessible.pdf
// ---------------------------------------------------------------------------
// This fixture is still a useful mixed-quality regression sample: it is not
// scanned and it preserves some strong semantic signals such as headings,
// figures, and links, but current local/PDF-UA checks still surface
// substantial blocking debt.
// ---------------------------------------------------------------------------

describe('integration: accessible PDF', () => {
  let result: AnalysisResult

  it('analyzes without errors', async () => {
    result = accessibleResult
    expect(result).toBeDefined()
    expect(Array.isArray(result.warnings)).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
  }, 30_000)

  it('is not detected as scanned', () => {
    expect(result.isScanned).toBe(false)
  })

  it('retains mixed accessibility signals instead of a false-clean pass', () => {
    expect(result.overallScore).toBeGreaterThanOrEqual(60)
    expect(result.overallScore).toBeLessThan(90)
    expect(result.grade).toBe('D')
  })

  it('still exposes extractability debt', () => {
    const cat = findCategory(result, 'text_extractability')
    expect(cat.score).toBeLessThan(100)
  })

  it('still exposes title/language debt', () => {
    const cat = findCategory(result, 'title_language')
    expect(cat.score).toBeLessThan(100)
  })

  it('has proper heading structure (score 100)', () => {
    const cat = findCategory(result, 'heading_structure')
    expect(cat.score).toBe(100)
  })

  it('has alt text on all images (score ≥70)', () => {
    const cat = findCategory(result, 'alt_text')
    expect(cat.score).toBeGreaterThanOrEqual(70)
  })

  it('has partially marked-up tables', () => {
    const cat = findCategory(result, 'table_markup')
    expect(cat.score).toBeGreaterThanOrEqual(50)
  })

  it('has descriptive links (score 100)', () => {
    const cat = findCategory(result, 'link_quality')
    expect(cat.score).toBe(100)
  })

  it('all categories have explanations and help links', () => {
    for (const cat of result.categories) {
      expect(cat.explanation).toBeTruthy()
      expect(cat.helpLinks).toBeDefined()
      expect(cat.helpLinks.length).toBeGreaterThan(0)
    }
  })

  it('returns correct metadata', () => {
    expect(result.filename).toBe('accessible.pdf')
    expect(result.fileType).toBe('pdf')
    expect(result.pageCount).toBeGreaterThan(0)
  })

  it('executive summary foregrounds remaining PDF/UA debt', () => {
    expect(result.executiveSummary).toContain('Local standards checks found')
    expect(result.executiveSummary).toContain('PDF/UA')
  })
})

// ---------------------------------------------------------------------------
// Inaccessible PDF — file-example_PDF_1MB_not_accessible.pdf
// ---------------------------------------------------------------------------
// This PDF has text but NO structure tree (untagged), no headings, and
// incomplete metadata. It should score F or D (well below 60).
// ---------------------------------------------------------------------------

describe('integration: inaccessible PDF', () => {
  let result: AnalysisResult

  it('analyzes without errors', async () => {
    result = inaccessibleResult
    expect(result).toBeDefined()
  }, 30_000)

  it('is not detected as scanned (it has text, just no tags)', () => {
    expect(result.isScanned).toBe(false)
  })

  it('scores below 60 overall (grade F)', () => {
    expect(result.overallScore).toBeLessThan(60)
    expect(result.grade).toBe('F')
  })

  it('text is present but not tagged and veraPDF evidence can reduce that category further', () => {
    const cat = findCategory(result, 'text_extractability')
    expect(cat.score).toBe(40)
    expect(cat.findings.some(f => f.includes('NOT tagged'))).toBe(true)
  })

  it('has no heading structure (score 0, Critical)', () => {
    const cat = findCategory(result, 'heading_structure')
    expect(cat.score).toBe(0)
    expect(cat.severity).toBe('Critical')
  })

  it('has no structure tree → reading order fails (score 0, Critical)', () => {
    const cat = findCategory(result, 'reading_order')
    expect(cat.score).toBe(0)
    expect(cat.severity).toBe('Critical')
  })

  it('has at least one critical issue', () => {
    const criticals = result.categories.filter(c => c.severity === 'Critical')
    expect(criticals.length).toBeGreaterThanOrEqual(1)
  })

  it('executive summary foregrounds local PDF/UA non-compliance', () => {
    expect(result.executiveSummary).toContain('Local standards checks found')
    expect(result.executiveSummary).toContain('PDF/UA')
  })

  it('all categories have explanations and help links', () => {
    for (const cat of result.categories) {
      expect(cat.explanation).toBeTruthy()
      expect(cat.helpLinks).toBeDefined()
      expect(cat.helpLinks.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Cross-check: accessible PDF should outscore inaccessible PDF
// ---------------------------------------------------------------------------

describe('integration: comparative scoring', () => {
  let accessible: AnalysisResult
  let inaccessible: AnalysisResult

  it('loads both PDFs', async () => {
    accessible = accessibleResult
    inaccessible = inaccessibleResult
  }, 30_000)

  it('accessible PDF scores higher', () => {
    expect(accessible.overallScore).toBeGreaterThan(inaccessible.overallScore)
  })

  it('accessible PDF has a better grade', () => {
    const gradeOrder = ['F', 'D', 'C', 'B', 'A']
    expect(gradeOrder.indexOf(accessible.grade)).toBeGreaterThan(
      gradeOrder.indexOf(inaccessible.grade)
    )
  })

  it('accessible PDF has fewer critical issues', () => {
    const accessibleCriticals = accessible.categories.filter(c => c.severity === 'Critical').length
    const inaccessibleCriticals = inaccessible.categories.filter(c => c.severity === 'Critical').length
    expect(accessibleCriticals).toBeLessThan(inaccessibleCriticals)
  })

  it('no false positive: inaccessible PDF does NOT score A', () => {
    expect(inaccessible.grade).not.toBe('A')
    expect(inaccessible.grade).not.toBe('B')
  })

  it('no false negative: accessible PDF does NOT collapse to the failing floor', () => {
    expect(accessible.grade).not.toBe('F')
  })
})
