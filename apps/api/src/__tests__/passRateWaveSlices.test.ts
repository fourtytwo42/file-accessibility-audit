import { describe, expect, it } from 'vitest'
import {
  buildAllRemainingAutomatedLane,
  buildFigureFinalMileClosureCohort,
  buildManualScannedDeferredLane,
  buildMediumFigureConversionLane,
  buildPassRateFigureCanary,
  buildPassRateFontCanary,
  buildReplacementLikelihoodLane,
  buildSerialHeavyMixedTerminalizationLane,
  buildSmallFastPassLane,
  buildRuntimeFigureRetrySlice,
  buildRuntimeMixedTerminalizationSlice,
  buildRuntimeRetryWave,
  buildRuntimeStructureRetrySlice,
} from '../services/passRateWaveSlices.js'

function makeRow(overrides: Record<string, any> = {}) {
  return {
    publicationId: '1001',
    title: 'Example',
    fileUrl: 'https://example.test/example.pdf',
    storageKind: 'legacy_archive',
    sourceKind: 'legacy_archive',
    serverHost: '143.244.146.43',
    remotePath: '/home/forge/archive.icjia-api.cloud/root/files/example.pdf',
    currentCorpusStatus: 'remediated_fail',
    cohortLabel: 'figure_heavy',
    sourceMetadata: {
      currentSourcePath: '/tmp/example.pdf',
    },
    statusEvidence: {
      latestReportPath: '/tmp/example.remediation.json',
      verificationReportPath: '/tmp/example.verification.json',
    },
    classificationEvidence: {
      overallScore: 72,
      grade: 'C',
      pageCount: 12,
      isScanned: false,
      blockerFamilyCount: 2,
      blockingFindingCount: 2,
      topBlockingResidualFamilyIds: [],
      blockingFindingKeys: [],
      autoRunnableOpportunityCount: 1,
      autoRunnableOpportunityKeys: ['repair_native_figure_semantics:document:document'],
      manualOnlyFailureModeCount: 0,
      manualOnlyFailureModeKeys: [],
    },
    stage3FigureDiagnostics: {
      figureWaveBucket: 'ownership_cleared_figure_debt_remains',
      hasGenericTimeoutWording: false,
    },
    stage4StructureDiagnostics: {
      hasBoundedRuntimeWording: false,
    },
    reasonCodes: [],
    notes: [],
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

describe('passRateWaveSlices', () => {
  it('selects figure canary rows only when figure debt is dominant and runner-ready', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'fig-1',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact', 'category.alt_text'],
        },
      }),
      makeRow({
        publicationId: 'mixed-secondary',
        cohortLabel: 'structure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          topBlockingResidualFamilyIds: ['post_bootstrap_heading_convergence', 'native_figure_convergence'],
          blockingFindingKeys: ['pdfua.logical_structure', 'pdfua.figure_alt_or_artifact'],
        },
      }),
    ])

    const slice = buildPassRateFigureCanary({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
      maxCandidates: 8,
    })

    expect(slice.selectedPublicationIds).toEqual(['fig-1'])
    expect(slice.candidates[0]?.localCachePath).toBe('/tmp/example.pdf')
    expect(slice.candidates[0]?.selectionReasons).toContain('native_figure_convergence')
    expect(slice.selectionSanity.excludedBecauseSecondary).toBe(1)
  })

  it('excludes 100/A non-verified anomalies unless the target family is truly dominant', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'near-pass-structure',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'structure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 100,
          grade: 'A',
          topBlockingResidualFamilyIds: ['post_bootstrap_heading_convergence', 'native_figure_convergence'],
          blockingFindingKeys: ['pdfua.logical_structure', 'pdfua.figure_alt_or_artifact'],
        },
      }),
      makeRow({
        publicationId: 'real-figure',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
        },
      }),
    ])

    const slice = buildPassRateFigureCanary({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
      maxCandidates: 8,
    })

    expect(slice.selectedPublicationIds).toEqual(['real-figure'])
    expect(slice.selectionSanity.excludedNearPassAnomalies).toBe(1)
  })

  it('selects font canary rows while excluding figure-dominant mixed survivors', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'font-1',
        cohortLabel: 'font_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          topBlockingResidualFamilyIds: ['font_embedding_and_unicode'],
          blockingFindingKeys: ['pdfua.font_unicode', 'pdfua.cid_symbol_fonts'],
        },
      }),
      makeRow({
        publicationId: 'fig-font-mixed',
        cohortLabel: 'figure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          topBlockingResidualFamilyIds: ['native_figure_convergence', 'font_embedding_and_unicode'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact', 'pdfua.font_unicode'],
        },
      }),
    ])

    const slice = buildPassRateFontCanary({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
      maxCandidates: 8,
    })

    expect(slice.selectedPublicationIds).toEqual(['font-1'])
    expect(slice.candidates[0]?.selectionReasons).toContain('pdfua.font_unicode')
    expect(slice.selectionSanity.excludedBecauseSecondary).toBe(1)
  })

  it('groups retryable runtime-tail rows by dominant family and keeps runner-ready fields', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'rt-figure',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'figure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
        },
        stage3FigureDiagnostics: {
          ...makeRow().stage3FigureDiagnostics,
          hasGenericTimeoutWording: true,
        },
      }),
      makeRow({
        publicationId: 'rt-font',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'font_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          topBlockingResidualFamilyIds: ['font_embedding_and_unicode'],
          blockingFindingKeys: ['pdfua.font_unicode'],
        },
      }),
      makeRow({
        publicationId: 'manual-tail',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'manual_tail',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          autoRunnableOpportunityCount: 0,
          topBlockingResidualFamilyIds: [],
          blockingFindingKeys: [],
        },
      }),
    ])

    const wave = buildRuntimeRetryWave({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    })

    expect(wave.selectedPublicationIds).toEqual(['rt-figure', 'rt-font'])
    expect(wave.groupedPublicationIds.figure).toEqual(['rt-figure'])
    expect(wave.groupedPublicationIds.font).toEqual(['rt-font'])
    expect(wave.groupedCounts.figure).toBe(1)
    expect(wave.candidates[0]?.localCachePath).toBe('/tmp/example.pdf')
  })

  it('builds a figure retry slice that excludes secondary mixed rows and prior processed failures', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'figure-worth-it',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'figure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 34,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
        },
        stage3FigureDiagnostics: {
          ...makeRow().stage3FigureDiagnostics,
          hasGenericTimeoutWording: true,
        },
      }),
      makeRow({
        publicationId: 'mixed-secondary',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'structure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 22,
          topBlockingResidualFamilyIds: ['native_figure_convergence', 'post_bootstrap_heading_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact', 'pdfua.logical_structure'],
        },
        stage3FigureDiagnostics: {
          ...makeRow().stage3FigureDiagnostics,
          hasGenericTimeoutWording: true,
        },
        stage4StructureDiagnostics: {
          ...makeRow().stage4StructureDiagnostics,
          hasBoundedRuntimeWording: true,
        },
      }),
      makeRow({
        publicationId: 'already-processed',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'figure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
        },
        stage3FigureDiagnostics: {
          ...makeRow().stage3FigureDiagnostics,
          hasGenericTimeoutWording: true,
        },
      }),
    ])

    const slice = buildRuntimeFigureRetrySlice({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
      priorOutcomes: {
        'already-processed': {
          publicationId: 'already-processed',
          status: 'failed_after_remediation',
        },
      },
    })

    expect(slice.selectedPublicationIds).toEqual(['figure-worth-it'])
    expect(slice.executionPolicy).toBe('dormant')
    expect(slice.executionPolicyReason).toBe('runtime_conversion_dormant_until_engine_change')
    expect(slice.selectionSanity.excludedSecondary).toBe(1)
    expect(slice.selectionSanity.excludedPriorProcessed).toBe(1)
  })

  it('builds a structure retry slice that excludes figure-dominant retryables and figure-only residuals', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'structure-worth-it',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'structure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 42,
          topBlockingResidualFamilyIds: ['post_bootstrap_heading_convergence'],
          blockingFindingKeys: ['pdfua.logical_structure'],
        },
        stage4StructureDiagnostics: {
          ...makeRow().stage4StructureDiagnostics,
          hasBoundedRuntimeWording: true,
        },
      }),
      makeRow({
        publicationId: 'figure-dominant',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'figure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 41,
          topBlockingResidualFamilyIds: ['post_bootstrap_heading_convergence', 'native_figure_convergence'],
          blockingFindingKeys: ['pdfua.logical_structure', 'pdfua.figure_alt_or_artifact'],
        },
        stage3FigureDiagnostics: {
          ...makeRow().stage3FigureDiagnostics,
          hasGenericTimeoutWording: true,
        },
        stage4StructureDiagnostics: {
          ...makeRow().stage4StructureDiagnostics,
          hasBoundedRuntimeWording: true,
        },
      }),
      makeRow({
        publicationId: 'structure-cleared-figure-remains',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'structure_heavy',
        reasonCodes: ['structure_debt_cleared_figure_debt_remaining'],
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 48,
          topBlockingResidualFamilyIds: ['post_bootstrap_heading_convergence'],
          blockingFindingKeys: ['pdfua.logical_structure'],
        },
        stage4StructureDiagnostics: {
          ...makeRow().stage4StructureDiagnostics,
          hasBoundedRuntimeWording: true,
        },
      }),
    ])

    const slice = buildRuntimeStructureRetrySlice({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    })

    expect(slice.selectedPublicationIds).toEqual(['structure-worth-it'])
    expect(slice.executionPolicy).toBe('dormant')
    expect(slice.executionPolicyReason).toBe('runtime_conversion_dormant_until_engine_change')
    expect(slice.selectionSanity.excludedSecondary).toBe(2)
  })

  it('builds a mixed terminalization slice only for mixed-dominant retryables', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'mixed-terminal',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'figure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 26,
          topBlockingResidualFamilyIds: ['native_figure_convergence', 'post_bootstrap_heading_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact', 'pdfua.logical_structure'],
        },
        stage3FigureDiagnostics: {
          ...makeRow().stage3FigureDiagnostics,
          hasGenericTimeoutWording: true,
        },
        stage4StructureDiagnostics: {
          ...makeRow().stage4StructureDiagnostics,
          hasBoundedRuntimeWording: true,
        },
      }),
      makeRow({
        publicationId: 'structure-only',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'structure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 30,
          topBlockingResidualFamilyIds: ['post_bootstrap_heading_convergence'],
          blockingFindingKeys: ['pdfua.logical_structure'],
        },
        stage4StructureDiagnostics: {
          ...makeRow().stage4StructureDiagnostics,
          hasBoundedRuntimeWording: true,
        },
      }),
    ])

    const slice = buildRuntimeMixedTerminalizationSlice({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    })

    expect(slice.selectedPublicationIds).toEqual(['mixed-terminal'])
    expect(slice.executionPolicy).toBe('active')
    expect(slice.executionPolicyReason).toBe('truth_hardening_active_lane')
    expect(slice.sliceIntent).toBe('truth_hardening_terminalization')
  })

  it('builds a small fast pass lane that excludes heavy mixed and runtime-tail rows', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'fast-pass',
        currentCorpusStatus: 'remediated_fail',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 89,
          pageCount: 14,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
        },
      }),
      makeRow({
        publicationId: 'mixed-heavy',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'figure_heavy',
        title: 'Annual Report 2020',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          pageCount: 140,
          topBlockingResidualFamilyIds: ['native_figure_convergence', 'post_bootstrap_heading_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact', 'pdfua.logical_structure'],
        },
      }),
      makeRow({
        publicationId: 'runtime-tail',
        currentCorpusStatus: 'processing_error',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          pageCount: 18,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
        },
        stage3FigureDiagnostics: {
          ...makeRow().stage3FigureDiagnostics,
          hasGenericTimeoutWording: true,
        },
      }),
      makeRow({
        publicationId: 'font-small',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'font_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 88,
          pageCount: 8,
          topBlockingResidualFamilyIds: ['font_embedding_and_unicode'],
          blockingFindingKeys: ['pdfua.font_embedding'],
        },
      }),
      makeRow({
        publicationId: 'slow-small-profile',
        currentCorpusStatus: 'remediated_fail',
        title: 'Focused Deterrence Policy Brief',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 90,
          pageCount: 12,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
        },
      }),
    ])

    const lane = buildSmallFastPassLane({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
      maxCandidates: 8,
    })

    expect(lane.selectedPublicationIds).toEqual(['fast-pass'])
    expect(lane.recommendedConcurrency).toBe(10)
    expect(lane.initialAnalysisProfile).toBe('remediation_fast')
    expect(lane.executionPolicy).toBe('dormant')
    expect(lane.selectionSanity.excludedRuntimeTail).toBe(1)
    expect(lane.totals.skippedRows).toBeGreaterThanOrEqual(3)
  })

  it('builds a medium figure conversion lane without heavy runtime profiles', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'figure-medium',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'figure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          pageCount: 44,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact', 'category.alt_text'],
        },
      }),
      makeRow({
        publicationId: 'caps-heavy',
        currentCorpusStatus: 'remediated_fail',
        title: 'CAPS Annual Report',
        remotePath: '/tmp/CAPS3.pdf',
        cohortLabel: 'figure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          pageCount: 160,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
        },
      }),
    ])

    const lane = buildMediumFigureConversionLane({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
      maxCandidates: 8,
    })

    expect(lane.selectedPublicationIds).toEqual(['figure-medium'])
    expect(lane.recommendedConcurrency).toBe(5)
    expect(lane.executionPolicy).toBe('dormant')
  })

  it('builds an all-remaining automated lane from active automatable backlog only', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'discovered-light',
        currentCorpusStatus: 'discovered',
        cohortLabel: 'structure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 45,
          pageCount: 9,
          topBlockingResidualFamilyIds: ['post_bootstrap_heading_convergence'],
          blockingFindingKeys: ['pdfua.logical_structure'],
        },
      }),
      makeRow({
        publicationId: 'retry-medium',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'figure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 62,
          pageCount: 44,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
        },
      }),
      makeRow({
        publicationId: 'verified-pass',
        currentCorpusStatus: 'verified_pass',
      }),
      makeRow({
        publicationId: 'manual-only',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          manualOnlyFailureModeCount: 2,
          manualOnlyFailureModeKeys: ['manual_patch_required'],
        },
      }),
      makeRow({
        publicationId: 'scanned',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          isScanned: true,
        },
      }),
      makeRow({
        publicationId: 'missing-source',
        sourceMetadata: {
          currentSourcePath: null,
        },
      }),
    ])

    const lane = buildAllRemainingAutomatedLane({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    })

    expect(lane.selectedPublicationIds).toEqual(['retry-medium', 'discovered-light'])
    expect(lane.recommendedConcurrency).toBe(4)
    expect(lane.initialAnalysisProfile).toBe('full_final')
    expect(lane.executionPolicy).toBe('active')
  })

  it('builds a serial heavy mixed terminalization lane with heavy runtime metadata', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'heavy-mixed',
        currentCorpusStatus: 'processing_error',
        title: 'CAPS 3 Annual Report',
        remotePath: '/reports/CAPS3.pdf',
        cohortLabel: 'figure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          pageCount: 180,
          topBlockingResidualFamilyIds: ['native_figure_convergence', 'post_bootstrap_heading_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact', 'pdfua.logical_structure'],
        },
        stage3FigureDiagnostics: {
          ...makeRow().stage3FigureDiagnostics,
          hasGenericTimeoutWording: true,
        },
        stage4StructureDiagnostics: {
          ...makeRow().stage4StructureDiagnostics,
          hasBoundedRuntimeWording: true,
        },
      }),
    ])

    const lane = buildSerialHeavyMixedTerminalizationLane({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    })

    expect(lane.selectedPublicationIds).toEqual(['heavy-mixed'])
    expect(lane.laneIntent).toBe('truth_hardening_terminalization')
    expect(lane.recommendedConcurrency).toBe(1)
    expect(lane.candidates[0]?.runtimeWeightBucket).toBe('heavy')
  })

  it('builds a manual scanned deferred lane and keeps it deferred by policy', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'scanned-manual',
        cohortLabel: 'manual_tail',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          isScanned: true,
          manualOnlyFailureModeCount: 2,
          manualOnlyFailureModeKeys: ['ocr_required'],
        },
      }),
    ])

    const lane = buildManualScannedDeferredLane({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    })

    expect(lane.selectedPublicationIds).toEqual(['scanned-manual'])
    expect(lane.executionPolicy).toBe('deferred')
    expect(lane.laneIntent).toBe('deferred_manual_review')
  })

  it('builds a replacement-likelihood lane only for near-pass light single-family survivors', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'replacement-worthy',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'figure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 99,
          grade: 'B',
          pageCount: 6,
          blockerFamilyCount: 1,
          blockingFindingCount: 1,
          autoRunnableOpportunityCount: 3,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
        },
      }),
      makeRow({
        publicationId: 'font-near-pass',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'font_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 99,
          grade: 'B',
          pageCount: 4,
          blockerFamilyCount: 1,
          blockingFindingCount: 1,
          autoRunnableOpportunityCount: 2,
          topBlockingResidualFamilyIds: ['font_embedding_and_unicode'],
          blockingFindingKeys: ['pdfua.font_unicode'],
        },
      }),
      makeRow({
        publicationId: 'logical-structure-near-pass',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'structure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 99,
          grade: 'B',
          pageCount: 6,
          blockerFamilyCount: 1,
          blockingFindingCount: 1,
          autoRunnableOpportunityCount: 2,
          topBlockingResidualFamilyIds: ['post_bootstrap_heading_convergence'],
          blockingFindingKeys: ['pdfua.logical_structure'],
        },
      }),
    ])

    const lane = buildReplacementLikelihoodLane({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
      maxCandidates: 8,
    })

    expect(lane.selectedPublicationIds).toEqual(['replacement-worthy'])
    expect(lane.recommendedConcurrency).toBe(3)
    expect(lane.executionPolicy).toBe('dormant')
    expect(lane.laneIntent).toBe('pass_rate_conversion')
  })

  it('excludes manually mitigated rows from automatic throughput and runtime lanes', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'manual-terminalized',
        currentCorpusStatus: 'remediated_fail',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 99,
          grade: 'B',
          blockerFamilyCount: 1,
          blockingFindingCount: 1,
          autoRunnableOpportunityCount: 3,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
        },
      }),
      makeRow({
        publicationId: 'automatic-candidate',
        currentCorpusStatus: 'processing_error',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
        },
      }),
    ])
    const manualOutcomeByPublicationId = new Map([
      ['manual-terminalized', {
        status: 'manual_terminalized' as const,
        manualResolutionReason: 'manual_object_level_repair_exhausted',
      }],
    ])

    const lane = buildReplacementLikelihoodLane({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
      maxCandidates: 8,
      manualOutcomeByPublicationId,
    })
    const runtimeWave = buildRuntimeRetryWave({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
      manualOutcomeByPublicationId,
    })

    expect(lane.selectedPublicationIds).not.toContain('manual-terminalized')
    expect(runtimeWave.selectedPublicationIds).not.toContain('manual-terminalized')
    expect(runtimeWave.selectedPublicationIds).toContain('automatic-candidate')
  })

  it('builds a figure-final-mile closure cohort from narrow figure-only survivors', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'figure-final-mile',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'figure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 88,
          grade: 'B',
          pageCount: 12,
          blockerFamilyCount: 1,
          blockingFindingCount: 2,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact', 'pdfua.nested_alt_text'],
        },
      }),
      makeRow({
        publicationId: 'mixed-survivor',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'structure_heavy',
        classificationEvidence: {
          ...makeRow().classificationEvidence,
          overallScore: 84,
          grade: 'B',
          pageCount: 18,
          blockerFamilyCount: 2,
          blockingFindingCount: 2,
          topBlockingResidualFamilyIds: ['native_figure_convergence', 'post_bootstrap_heading_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact', 'pdfua.logical_structure'],
        },
      }),
    ])

    const cohort = buildFigureFinalMileClosureCohort({
      artifacts,
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
      latestOutcomeByPublicationId: new Map([
        ['figure-final-mile', {
          status: 'failed_after_remediation',
          processedAt: '2026-04-07T00:00:00.000Z',
          blockingFindingShrink: true,
        }],
      ]),
      maxCandidates: 8,
    })

    expect(cohort.selectedPublicationIds).toEqual(['figure-final-mile'])
    expect(cohort.candidates[0]?.observedBlockingFindingShrink).toBe(true)
    expect(cohort.candidates[0]?.candidateEngineSliceTag).toBe('figure_final_mile_closure')
  })
})
