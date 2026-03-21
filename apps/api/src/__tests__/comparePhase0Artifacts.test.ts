import { describe, expect, it } from 'vitest'
import type { Phase0Artifact } from '../scripts/comparePhase0Artifacts.js'
import { comparePhase0Artifacts } from '../scripts/comparePhase0Artifacts.js'

function makeArtifact(overrides: Partial<Phase0Artifact> = {}): Phase0Artifact {
  return {
    generatedAt: '2026-03-21T20:29:06.000Z',
    corpusName: 'phase0-baseline',
    summary: {
      fileCount: 1,
      adobeFailFileCount: 1,
      false100Count: 0,
      score100AdobeFailCount: 0,
      structuralClassCounts: { native_tagged: 1 },
      adobeFailedFamilyTotals: { 'adobe.other_elements_alt_text': 1 },
    },
    canary: {
      entries: [],
      coverage: {
        structuralClasses: ['native_tagged'],
        missingStructuralClasses: [],
      },
    },
    files: [{
      filename: 'example.pdf',
      overallScore: 80,
      grade: 'B',
      false100: false,
      veraPdf: {
        status: 'failed',
        failedChecks: 2,
      },
      adobe: {
        issueCount: 1,
        normalizedFailedFamilyCounts: {
          'adobe.other_elements_alt_text': 1,
        },
      },
      classification: {
        structuralClass: 'native_tagged',
      },
      failureProfileKeys: ['pdfua.tagged_annotations'],
      plannerOpportunityKeys: ['tag_unowned_annotations:document'],
      plannerAutoRunnableKeys: ['tag_unowned_annotations:document'],
    }],
    ...overrides,
  }
}

describe('comparePhase0Artifacts', () => {
  it('fails when false 100 count increases', () => {
    const before = makeArtifact()
    const after = makeArtifact({
      summary: {
        ...before.summary,
        false100Count: 1,
      },
    })

    const result = comparePhase0Artifacts(before, after, {
      mode: 'phase0-baseline',
      beforePath: '/tmp/before.json',
      afterPath: '/tmp/after.json',
      allowKnownGaps: [],
    })

    expect(result.ok).toBe(false)
    expect(result.regressions.map(entry => entry.key)).toContain('summary.false100Count')
  })

  it('allows explicit known-gap suppressions', () => {
    const before = makeArtifact()
    const after = makeArtifact({
      summary: {
        ...before.summary,
        false100Count: 1,
      },
    })

    const result = comparePhase0Artifacts(before, after, {
      mode: 'phase0-baseline',
      beforePath: '/tmp/before.json',
      afterPath: '/tmp/after.json',
      allowKnownGaps: ['summary.false100Count'],
    })

    expect(result.ok).toBe(true)
    expect(result.suppressedRegressions.map(entry => entry.key)).toContain('summary.false100Count')
  })

  it('fails when canary structural coverage shrinks', () => {
    const before = makeArtifact({
      corpusName: 'phase0-canary',
      canary: {
        entries: [],
        coverage: {
          structuralClasses: ['native_tagged', 'well_tagged'],
          missingStructuralClasses: [],
        },
      },
    })
    const after = makeArtifact({
      corpusName: 'phase0-canary',
      canary: {
        entries: [],
        coverage: {
          structuralClasses: ['native_tagged'],
          missingStructuralClasses: ['well_tagged'],
        },
      },
    })

    const result = comparePhase0Artifacts(before, after, {
      mode: 'phase0-canary',
      beforePath: '/tmp/before.json',
      afterPath: '/tmp/after.json',
      allowKnownGaps: [],
      requiredCanaryStructuralClasses: ['native_tagged', 'well_tagged'],
    })

    expect(result.ok).toBe(false)
    expect(result.regressions.map(entry => entry.key)).toContain('canary.coverage:well_tagged')
    expect(result.regressions.map(entry => entry.key)).toContain('canary.coverage_shrunk:well_tagged')
  })

  it('treats disappearing adobe expectations as satisfied when the file improved', () => {
    const before = makeArtifact({
      corpusName: 'phase0-canary',
      canary: {
        entries: [{
          filename: 'example.pdf',
          why: 'alt-text canary',
          expectedSignals: ['adobe.other_elements_alt_text'],
          structuralClass: 'native_tagged',
        }],
        coverage: {
          structuralClasses: ['native_tagged'],
          missingStructuralClasses: [],
        },
      },
    })
    const after = makeArtifact({
      corpusName: 'phase0-canary',
      files: [{
        ...before.files[0]!,
        overallScore: 90,
        grade: 'A',
        adobe: {
          issueCount: 0,
          normalizedFailedFamilyCounts: {},
        },
      }],
      canary: before.canary,
      summary: {
        ...before.summary,
        adobeFailFileCount: 0,
      },
    })

    const result = comparePhase0Artifacts(before, after, {
      mode: 'phase0-canary',
      beforePath: '/tmp/before.json',
      afterPath: '/tmp/after.json',
      allowKnownGaps: [],
      requiredCanaryStructuralClasses: ['native_tagged'],
    })

    expect(result.ok).toBe(true)
    expect(result.groupedDeltas.canaryExpectations).toContainEqual({
      filename: 'example.pdf',
      expectation: 'adobe.other_elements_alt_text',
      status: 'improved_away',
    })
  })

  it('fails when a canary surfaces a disallowed auto-runnable key', () => {
    const before = makeArtifact({
      corpusName: 'phase0-canary',
      canary: {
        entries: [{
          filename: 'example.pdf',
          why: 'planner canary',
          expectedSignals: ['structural_class.native_tagged'],
          structuralClass: 'native_tagged',
          verificationLocks: {
            disallowedAutoRunnableKeys: ['repair_structure_conformance:document'],
          },
        }],
        coverage: {
          structuralClasses: ['native_tagged'],
          missingStructuralClasses: [],
        },
      },
    })
    const after = makeArtifact({
      corpusName: 'phase0-canary',
      files: [{
        ...before.files[0]!,
        plannerAutoRunnableKeys: ['repair_structure_conformance:document'],
      }],
      canary: before.canary,
    })

    const result = comparePhase0Artifacts(before, after, {
      mode: 'phase0-canary',
      beforePath: '/tmp/before.json',
      afterPath: '/tmp/after.json',
      allowKnownGaps: [],
      requiredCanaryStructuralClasses: ['native_tagged'],
    })

    expect(result.ok).toBe(false)
    expect(result.regressions.map(entry => entry.key)).toContain(
      'canary.disallowed_auto_runnable:example.pdf:repair_structure_conformance:document',
    )
  })
})
