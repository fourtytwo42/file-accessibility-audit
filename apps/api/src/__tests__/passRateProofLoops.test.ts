import { describe, expect, it } from 'vitest'
import {
  summarizeFigureCanaryProofLoop,
  summarizeFontCanaryProofLoop,
  summarizeRuntimeRetryProofLoop,
  summarizeRuntimeSliceProofLoop,
} from '../services/passRateProofLoops.js'

function makeRow(overrides: Record<string, any> = {}) {
  return {
    publicationId: '1001',
    title: 'Example',
    currentCorpusStatus: 'remediated_fail',
    classificationEvidence: {
      overallScore: 72,
      blockingFindingKeys: [],
      topBlockingResidualFamilyIds: [],
    },
    reasonCodes: [],
    notes: [],
    stage3FigureDiagnostics: {
      hasGenericTimeoutWording: false,
    },
    stage4StructureDiagnostics: {
      hasBoundedRuntimeWording: false,
    },
    cohortLabel: 'figure_heavy',
    ...overrides,
  }
}

function makeArtifacts(rows: any[]) {
  return {
    document: {
      generatedAt: '2026-04-06T00:00:00.000Z',
      rows,
    },
  } as any
}

describe('passRateProofLoops', () => {
  it('summarizes figure canary before/after deltas and unchanged rows', () => {
    const slice = {
      sliceName: 'pass-rate-figure-canary',
      selectedPublicationIds: ['fig-1', 'fig-2'],
      candidates: [
        {
          publicationId: 'fig-1',
          currentCorpusStatus: 'remediated_fail',
          overallScore: 70,
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact', 'category.alt_text'],
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
        },
        {
          publicationId: 'fig-2',
          currentCorpusStatus: 'processing_error',
          overallScore: 65,
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
        },
      ],
    } as any
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'fig-1',
        currentCorpusStatus: 'verified_pass',
        classificationEvidence: {
          overallScore: 100,
          blockingFindingKeys: [],
          topBlockingResidualFamilyIds: [],
        },
      }),
      makeRow({
        publicationId: 'fig-2',
        currentCorpusStatus: 'processing_error',
        classificationEvidence: {
          overallScore: 65,
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
        },
      }),
    ])

    const summary = summarizeFigureCanaryProofLoop({ slice, artifacts })
    expect(summary.deltas.verifiedPass).toBe(1)
    expect(summary.deltas.targetedFindingCounts['pdfua.figure_alt_or_artifact']).toBe(-1)
    expect(summary.unchangedRows).toEqual(['fig-2'])
  })

  it('summarizes font canary targeted blocker deltas', () => {
    const slice = {
      sliceName: 'pass-rate-font-canary',
      selectedPublicationIds: ['font-1'],
      candidates: [
        {
          publicationId: 'font-1',
          currentCorpusStatus: 'remediated_fail',
          overallScore: 82,
          blockingFindingKeys: ['pdfua.font_unicode', 'pdfua.cid_symbol_fonts'],
          topBlockingResidualFamilyIds: ['font_embedding_and_unicode'],
        },
      ],
    } as any
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'font-1',
        cohortLabel: 'font_heavy',
        currentCorpusStatus: 'remediated_fail',
        classificationEvidence: {
          overallScore: 90,
          blockingFindingKeys: ['pdfua.cid_symbol_fonts'],
          topBlockingResidualFamilyIds: ['font_embedding_and_unicode'],
        },
      }),
    ])

    const summary = summarizeFontCanaryProofLoop({ slice, artifacts })
    expect(summary.deltas.targetedFindingCounts['pdfua.font_unicode']).toBe(-1)
    expect(summary.deltas.targetedFamilyCounts.font_embedding_and_unicode).toBe(0)
  })

  it('summarizes runtime retry transitions and dominant-family shifts', () => {
    const slice = {
      sliceName: 'runtime-tail-retry-wave',
      selectedPublicationIds: ['rt-1', 'rt-2'],
      candidates: [
        {
          publicationId: 'rt-1',
          currentCorpusStatus: 'processing_error',
          overallScore: 50,
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          dominantFamily: 'figure',
        },
        {
          publicationId: 'rt-2',
          currentCorpusStatus: 'processing_error',
          overallScore: 48,
          blockingFindingKeys: ['pdfua.font_unicode'],
          topBlockingResidualFamilyIds: ['font_embedding_and_unicode'],
          dominantFamily: 'font',
        },
      ],
    } as any
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'rt-1',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'structure_heavy',
        classificationEvidence: {
          overallScore: 78,
          autoRunnableOpportunityCount: 1,
          blockingFindingKeys: ['pdfua.logical_structure'],
          topBlockingResidualFamilyIds: ['post_bootstrap_heading_convergence'],
        },
        stage4StructureDiagnostics: {
          hasBoundedRuntimeWording: true,
        },
      }),
      makeRow({
        publicationId: 'rt-2',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'font_heavy',
        classificationEvidence: {
          overallScore: 48,
          autoRunnableOpportunityCount: 1,
          blockingFindingKeys: ['pdfua.font_unicode'],
          topBlockingResidualFamilyIds: ['font_embedding_and_unicode'],
        },
      }),
    ])

    const summary = summarizeRuntimeRetryProofLoop({ slice, artifacts })
    expect(summary.runtimeTransitions?.processingErrorToStableHardFail).toEqual(['rt-1'])
    expect(summary.runtimeTransitions?.unchangedProcessingError).toEqual(['rt-2'])
    expect(summary.runtimeTransitions?.dominantFamilyShifts).toEqual([
      { publicationId: 'rt-1', before: 'figure', after: 'structure' },
    ])
  })

  it('summarizes targeted deltas for figure retry and carries slice intent', () => {
    const slice = {
      sliceName: 'runtime-tail-figure-retry',
      sliceIntent: 'pass_rate_conversion',
      targetedFindingKeys: ['pdfua.figure_alt_or_artifact', 'category.alt_text'],
      targetedFamilyIds: ['native_figure_convergence'],
      selectedPublicationIds: ['rt-fig'],
      candidates: [
        {
          publicationId: 'rt-fig',
          currentCorpusStatus: 'processing_error',
          overallScore: 35,
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact', 'category.alt_text'],
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          dominantFamily: 'figure',
        },
      ],
    } as any

    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'rt-fig',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'figure_heavy',
        classificationEvidence: {
          overallScore: 88,
          autoRunnableOpportunityCount: 1,
          blockingFindingKeys: ['category.alt_text'],
          topBlockingResidualFamilyIds: [],
        },
        stage3FigureDiagnostics: {
          hasGenericTimeoutWording: true,
        },
      }),
    ])

    const summary = summarizeRuntimeSliceProofLoop({ slice, artifacts })
    expect(summary.sliceIntent).toBe('pass_rate_conversion')
    expect(summary.deltas.targetedFindingCounts['pdfua.figure_alt_or_artifact']).toBe(-1)
    expect(summary.deltas.targetedFamilyCounts.native_figure_convergence).toBe(-1)
    expect(summary.runtimeTransitions?.processingErrorToStableHardFail).toEqual(['rt-fig'])
  })
})
