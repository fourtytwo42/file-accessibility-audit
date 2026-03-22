import { describe, expect, it } from 'vitest'
import {
  evaluateProcessedFontCapabilityArtifact,
  type ProcessedFontCapabilityFileReport,
} from '../scripts/verifyProcessedFontCapability.js'

function makeFile(overrides?: Partial<ProcessedFontCapabilityFileReport>): ProcessedFontCapabilityFileReport {
  return {
    filename: '11drug_seizures_1997-2007.pdf',
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

describe('evaluateProcessedFontCapabilityArtifact', () => {
  it('marks imperfect baseline files as directly repairable when post-repair state is clean', () => {
    const result = evaluateProcessedFontCapabilityArtifact([makeFile()])
    expect(result.summary.fileCount).toBe(1)
    expect(result.summary.baselineImperfectCount).toBe(1)
    expect(result.summary.directRepairableCount).toBe(1)
    expect(result.summary.regressionCount).toBe(0)
  })

  it('fails when direct repair no longer reaches 100/A', () => {
    const result = evaluateProcessedFontCapabilityArtifact([
      makeFile({
        postRepair: {
          ...makeFile().postRepair,
          overallScore: 81,
          grade: 'B',
        },
      }),
    ])
    expect(result.regressions.map(entry => entry.key)).toContain('post_repair_not_perfect:11drug_seizures_1997-2007.pdf')
  })

  it('fails when repair_font_unicode_maps stays auto-runnable after repair', () => {
    const result = evaluateProcessedFontCapabilityArtifact([
      makeFile({
        postRepair: {
          ...makeFile().postRepair,
          plannerAutoRunnableKeys: ['repair_font_unicode_maps:document:document'],
        },
      }),
    ])
    expect(result.regressions.map(entry => entry.key)).toContain('post_repair_font_auto_runnable:11drug_seizures_1997-2007.pdf')
  })
})
