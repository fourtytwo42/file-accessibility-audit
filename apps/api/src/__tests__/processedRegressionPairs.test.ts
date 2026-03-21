import { describe, expect, it } from 'vitest'
import { evaluateProcessedRegressionArtifact } from '../scripts/verifyProcessedRegressionPairs.js'
import { PROCESSED_REGRESSION_MANIFEST } from '../scripts/processedRegressionManifest.js'

function makePair(overrides?: {
  beforeScore?: number
  beforeGrade?: string
  afterScore?: number
  afterGrade?: string
  afterAutoRunnableKeys?: string[]
}) {
  return {
    beforeFilename: 'before.pdf',
    afterFilename: 'after.pdf',
    before: {
      filename: 'before.pdf',
      overallScore: overrides?.beforeScore ?? 70,
      grade: overrides?.beforeGrade ?? 'C',
      failureProfileKeys: ['pdfua.tagged_annotations'],
      plannerOpportunityKeys: ['tag_unowned_annotations:document'],
      plannerAutoRunnableKeys: ['tag_unowned_annotations:document'],
    },
    after: {
      filename: 'after.pdf',
      overallScore: overrides?.afterScore ?? 100,
      grade: overrides?.afterGrade ?? 'A',
      failureProfileKeys: [],
      plannerOpportunityKeys: [],
      plannerAutoRunnableKeys: overrides?.afterAutoRunnableKeys ?? [],
    },
  }
}

describe('evaluateProcessedRegressionArtifact', () => {
  it('passes when after files are perfect and have no auto-runnable debt', () => {
    const result = evaluateProcessedRegressionArtifact(PROCESSED_REGRESSION_MANIFEST, [makePair()])
    expect(result.summary.regressionCount).toBe(0)
    expect(result.summary.perfectAfterCount).toBe(1)
  })

  it('fails when an after file is not 100/A', () => {
    const result = evaluateProcessedRegressionArtifact(PROCESSED_REGRESSION_MANIFEST, [
      makePair({ afterScore: 95, afterGrade: 'A' }),
    ])
    expect(result.regressions.map(entry => entry.key)).toContain('after_not_perfect:before.pdf')
  })

  it('fails when an after file still has auto-runnable opportunities', () => {
    const result = evaluateProcessedRegressionArtifact(PROCESSED_REGRESSION_MANIFEST, [
      makePair({ afterAutoRunnableKeys: ['repair_structure_conformance:document'] }),
    ])
    expect(result.regressions.map(entry => entry.key)).toContain('after_has_auto_runnable:before.pdf')
  })

  it('fails when the after file regresses versus before', () => {
    const result = evaluateProcessedRegressionArtifact(PROCESSED_REGRESSION_MANIFEST, [
      makePair({ beforeScore: 80, beforeGrade: 'B', afterScore: 75, afterGrade: 'C' }),
    ])
    expect(result.regressions.map(entry => entry.key)).toContain('score_regressed:before.pdf')
    expect(result.regressions.map(entry => entry.key)).toContain('grade_regressed:before.pdf')
  })
})
