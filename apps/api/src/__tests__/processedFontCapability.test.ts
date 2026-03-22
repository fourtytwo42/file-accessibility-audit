import { describe, expect, it } from 'vitest'
import {
  classifyProcessedStaticMisses,
  evaluateProcessedFontCapabilityArtifact,
  type ProcessedFontCapabilityFileReport,
  type ProcessedStaticAfterAnalysis,
} from '../scripts/verifyProcessedFontCapability.js'

function makeFile(overrides?: Partial<ProcessedFontCapabilityFileReport>): ProcessedFontCapabilityFileReport {
  return {
    filename: '11drug_seizures_1997-2007.pdf',
    directRepairTool: 'repair_font_unicode_maps',
    repairOutcome: 'applied',
    baseline: {
      filename: '11drug_seizures_1997-2007.pdf',
      overallScore: 75,
      grade: 'C',
      blockingFindingKeys: ['pdfua.font_unicode'],
      plannerAutoRunnableKeys: ['repair_font_unicode_maps:document:document'],
      qpdf: {
        fontsMissingToUnicode: 5,
        fontsMissingToUnicodeBlocking: 5,
        fontsMissingToUnicodeProxy: 0,
        fontsMissingToUnicodeAdvisory: 0,
        cidSetRiskFontCount: 1,
        legacyWidthRiskFontCount: 0,
      },
    },
    postRepair: {
      filename: '11drug_seizures_1997-2007.pdf',
      overallScore: 100,
      grade: 'A',
      blockingFindingKeys: [],
      plannerAutoRunnableKeys: [],
      qpdf: {
        fontsMissingToUnicode: 0,
        fontsMissingToUnicodeBlocking: 0,
        fontsMissingToUnicodeProxy: 0,
        fontsMissingToUnicodeAdvisory: 0,
        cidSetRiskFontCount: 1,
        legacyWidthRiskFontCount: 0,
      },
    },
    ...overrides,
  }
}

function makeState(overrides?: Partial<ProcessedFontCapabilityFileReport['baseline']>): ProcessedFontCapabilityFileReport['baseline'] {
  return {
    filename: '11drug_seizures_1997-2007.pdf',
    overallScore: 75,
    grade: 'C',
    blockingFindingKeys: ['pdfua.font_unicode'],
    plannerAutoRunnableKeys: ['repair_font_unicode_maps:document:document'],
    qpdf: {
      fontsMissingToUnicode: 5,
      fontsMissingToUnicodeBlocking: 5,
      fontsMissingToUnicodeProxy: 0,
      fontsMissingToUnicodeAdvisory: 0,
      cidSetRiskFontCount: 1,
      legacyWidthRiskFontCount: 0,
    },
    ...overrides,
  }
}

function makePerfectState(overrides?: Partial<ProcessedFontCapabilityFileReport['postRepair']>): NonNullable<ProcessedFontCapabilityFileReport['postRepair']> {
  return {
    filename: '11drug_seizures_1997-2007.pdf',
    overallScore: 100,
    grade: 'A',
    blockingFindingKeys: [],
    plannerAutoRunnableKeys: [],
    qpdf: {
      fontsMissingToUnicode: 0,
      fontsMissingToUnicodeBlocking: 0,
      fontsMissingToUnicodeProxy: 0,
      fontsMissingToUnicodeAdvisory: 0,
      cidSetRiskFontCount: 1,
      legacyWidthRiskFontCount: 0,
    },
    ...overrides,
  }
}

function makeStaticAfter(overrides?: Partial<ProcessedStaticAfterAnalysis>): ProcessedStaticAfterAnalysis {
  return {
    filename: '11drug_seizures_1997-2007.pdf',
    overallScore: 75,
    grade: 'C',
    plannerAutoRunnableKeys: ['repair_font_unicode_maps:document:document'],
    ...overrides,
  }
}

describe('evaluateProcessedFontCapabilityArtifact', () => {
  it('marks imperfect baseline files as directly repairable when post-repair state is clean', () => {
    const result = evaluateProcessedFontCapabilityArtifact([makeFile()])
    expect(result.summary.fileCount).toBe(1)
    expect(result.summary.baselineImperfectCount).toBe(1)
    expect(result.summary.directRepairableCount).toBe(1)
    expect(result.summary.unresolvedAfterDirectRepairCount).toBe(0)
    expect(result.summary.regressionCount).toBe(0)
  })

  it('fails when direct repair no longer reaches 100/A', () => {
    const result = evaluateProcessedFontCapabilityArtifact([
      makeFile({
        postRepair: makePerfectState({
          overallScore: 81,
          grade: 'B',
        }),
      }),
    ])
    expect(result.regressions.map(entry => entry.key)).toContain('post_repair_not_perfect:11drug_seizures_1997-2007.pdf')
  })

  it('fails when repair_font_unicode_maps stays auto-runnable after repair', () => {
    const result = evaluateProcessedFontCapabilityArtifact([
      makeFile({
        postRepair: makePerfectState({
          plannerAutoRunnableKeys: ['repair_font_unicode_maps:document:document'],
        }),
      }),
    ])
    expect(result.regressions.map(entry => entry.key)).toContain('post_repair_font_auto_runnable:11drug_seizures_1997-2007.pdf')
  })

  it('classifies font-only static misses separately from non-font misses', () => {
    const result = classifyProcessedStaticMisses([
      makeStaticAfter(),
      makeStaticAfter({
        filename: '97anreport.pdf',
        overallScore: 81,
        grade: 'B',
        plannerAutoRunnableKeys: ['normalize_document_metadata:document:document'],
      }),
      makeStaticAfter({
        filename: '98anreport.pdf',
        overallScore: 100,
        grade: 'A',
        plannerAutoRunnableKeys: [],
      }),
    ])

    expect(result.fontOnlyStaticMisses).toEqual(['11drug_seizures_1997-2007.pdf'])
    expect(result.nonFontStaticMisses).toEqual(['97anreport.pdf'])
  })

  it('surfaces next true blockers after excluding directly repairable font files', () => {
    const result = evaluateProcessedFontCapabilityArtifact(
      [makeFile()],
      {
        fontOnlyStaticMisses: ['11drug_seizures_1997-2007.pdf'],
        nonFontStaticMisses: ['97anreport.pdf'],
      },
    )

    expect(result.buckets.fontOnlyDirectlyRepairable).toEqual(['11drug_seizures_1997-2007.pdf'])
    expect(result.nextTrueBlockers).toEqual([])
  })

  it('classifies bookmark cleanup residuals as non-font directly repairable', () => {
    const result = evaluateProcessedFontCapabilityArtifact(
      [makeFile({
        filename: '97anreport.pdf',
        directRepairTool: 'replace_bookmarks_from_headings',
        baseline: makeState({
          filename: '97anreport.pdf',
          overallScore: 81,
          grade: 'B',
          blockingFindingKeys: ['pdfua.bookmark_language'],
          plannerAutoRunnableKeys: ['replace_bookmarks_from_headings:document:document'],
        }),
        postRepair: makePerfectState({
          filename: '97anreport.pdf',
          blockingFindingKeys: [],
          plannerAutoRunnableKeys: [],
        }),
      })],
      {
        fontOnlyStaticMisses: [],
        nonFontStaticMisses: ['97anreport.pdf'],
      },
    )

    expect(result.summary.directRepairableCount).toBe(1)
    expect(result.buckets.nonFontDirectlyRepairable).toEqual(['97anreport.pdf'])
    expect(result.buckets.stillUnresolvedAfterDirectRepair).toEqual([])
    expect(result.nextTrueBlockers).toEqual([])
  })

  it('keeps unsupported residuals in the unresolved bucket', () => {
    const result = evaluateProcessedFontCapabilityArtifact(
      [makeFile({
        filename: 'mystery.pdf',
        directRepairTool: null,
        repairOutcome: null,
        baseline: makeState({
          filename: 'mystery.pdf',
          overallScore: 83,
          grade: 'B',
          blockingFindingKeys: ['pdfua.logical_structure'],
          plannerAutoRunnableKeys: ['repair_native_marked_content_refs:document:document'],
        }),
        postRepair: null,
      })],
      {
        fontOnlyStaticMisses: [],
        nonFontStaticMisses: ['mystery.pdf'],
      },
    )

    expect(result.summary.unresolvedAfterDirectRepairCount).toBe(1)
    expect(result.buckets.stillUnresolvedAfterDirectRepair).toEqual(['mystery.pdf'])
    expect(result.nextTrueBlockers).toEqual(['mystery.pdf'])
    expect(result.regressions.map(entry => entry.key)).toContain('unsupported_direct_repair:mystery.pdf')
  })
})
