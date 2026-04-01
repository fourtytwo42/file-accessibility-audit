import { describe, expect, it } from 'vitest'

describe('run-remediation-regression-benchmark', () => {
  it('derives figure-phase diagnostics from remediation metrics when present', async () => {
    const { deriveFigurePhaseDiagnostic } = await import('../../../../scripts/run-remediation-regression-benchmark.ts')

    expect(deriveFigurePhaseDiagnostic({
      remediationMetrics: {
        inspections: {
          lightFresh: 1,
          lightReused: 0,
          deepFresh: 2,
          deepReused: 0,
          deepDowngradedToLight: 1,
        },
        phases: {
          ownershipState: {
            initialRiskCount: 1,
            finalRiskCount: 0,
            freshDeepInspections: 1,
            reusedInspections: 0,
            downgradedToLight: false,
          },
          figureDescriptionState: {
            initialMissingAltCount: 8,
            finalMissingAltCount: 8,
            initialDecorativeFigureCount: 0,
            finalDecorativeFigureCount: 0,
            freshDeepInspections: 2,
            reusedInspections: 0,
            downgradedToLight: true,
            lateConverged: true,
            focusedRescueRan: true,
            focusedRescueSkippedBecauseLateConverged: false,
            finalStopReason: 'same_blocking_keys',
          },
          structureState: {
            freshDeepAnalyses: 0,
            downgradedDeepAnalyses: 0,
            finalBlockingKeys: [],
          },
        },
      } as any,
    })).toEqual({
      focusedRescueRan: true,
      skippedBecauseLateConverged: false,
      finalStopReason: 'same_blocking_keys',
    })
  })

  it('classifies inspection-budget processing errors as budget-exhausted figure stops', async () => {
    const { deriveFigurePhaseDiagnostic } = await import('../../../../scripts/run-remediation-regression-benchmark.ts')

    expect(deriveFigurePhaseDiagnostic({
      remediationMetrics: null,
      errorMessage: 'Inspection budget exceeded (light=4, deep=9, total=13).',
    })).toEqual({
      focusedRescueRan: false,
      skippedBecauseLateConverged: false,
      finalStopReason: 'budget_exhausted',
    })
  })

  it('derives residual cleanup diagnostics from remediation metrics when present', async () => {
    const { deriveResidualCleanupDiagnostic } = await import('../../../../scripts/run-remediation-regression-benchmark.ts')

    expect(deriveResidualCleanupDiagnostic({
      remediationMetrics: {
        inspections: {
          lightFresh: 1,
          lightReused: 0,
          deepFresh: 2,
          deepReused: 0,
          deepDowngradedToLight: 1,
        },
        phases: {
          ownershipState: {
            initialRiskCount: 1,
            finalRiskCount: 0,
            freshDeepInspections: 1,
            reusedInspections: 0,
            downgradedToLight: false,
          },
          figureDescriptionState: {
            initialMissingAltCount: 8,
            finalMissingAltCount: 8,
            initialDecorativeFigureCount: 0,
            finalDecorativeFigureCount: 0,
            freshDeepInspections: 2,
            reusedInspections: 0,
            downgradedToLight: true,
          },
          structureState: {
            freshDeepAnalyses: 1,
            downgradedDeepAnalyses: 0,
            finalBlockingKeys: ['pdfua.logical_structure'],
            finalStopReason: 'same_family_no_progress',
          },
        },
        residualCleanup: {
          dominantFamily: 'structure',
          finalStopReason: 'same_family_no_progress',
        },
      } as any,
    })).toEqual({
      dominantFamily: 'structure',
      finalStopReason: 'same_family_no_progress',
    })
  })

  it('falls back to structure-state stop reasons when residual cleanup metrics are sparse', async () => {
    const { deriveResidualCleanupDiagnostic } = await import('../../../../scripts/run-remediation-regression-benchmark.ts')

    expect(deriveResidualCleanupDiagnostic({
      remediationMetrics: {
        phases: {
          structureState: {
            freshDeepAnalyses: 1,
            downgradedDeepAnalyses: 0,
            lateConverged: true,
            finalStopReason: 'same_family_no_progress',
            finalBlockingKeys: ['pdfua.logical_structure'],
          },
        },
      } as any,
    })).toEqual({
      dominantFamily: 'structure',
      finalStopReason: 'same_family_no_progress',
    })
  })
})
