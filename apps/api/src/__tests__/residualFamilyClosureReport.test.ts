import { describe, expect, it } from 'vitest'
import { buildResidualFamilyClosureReport } from '../services/residualFamilyClosureReport.js'

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
      overallScore: 82,
      grade: 'B',
      pageCount: 12,
      isScanned: false,
      blockerFamilyCount: 1,
      blockingFindingCount: 1,
      topBlockingResidualFamilyIds: ['native_figure_convergence'],
      blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
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

describe('residualFamilyClosureReport', () => {
  it('ranks figure-final-mile ahead by default and preserves observed shrink evidence', () => {
    const artifacts: any = {
      document: {
        generatedAt: '2026-04-07T00:00:00.000Z',
        rows: [
          makeRow({
            publicationId: 'figure-1',
            classificationEvidence: {
              ...makeRow().classificationEvidence,
              blockingFindingKeys: ['pdfua.figure_alt_or_artifact', 'pdfua.nested_alt_text'],
            },
          }),
          makeRow({
            publicationId: 'mixed-1',
            cohortLabel: 'structure_heavy',
            classificationEvidence: {
              ...makeRow().classificationEvidence,
              blockerFamilyCount: 2,
              topBlockingResidualFamilyIds: ['native_figure_convergence', 'post_bootstrap_heading_convergence'],
              blockingFindingKeys: ['pdfua.figure_alt_or_artifact', 'pdfua.logical_structure'],
            },
          }),
          makeRow({
            publicationId: 'manual-1',
            cohortLabel: 'manual_tail',
            classificationEvidence: {
              ...makeRow().classificationEvidence,
              isScanned: true,
              blockingFindingKeys: ['pdfua.logical_structure'],
            },
          }),
        ],
      },
    }

    const report = buildResidualFamilyClosureReport({
      artifacts,
      latestOutcomeByPublicationId: new Map([
        ['figure-1', {
          publicationId: 'figure-1',
          status: 'failed_after_remediation',
          processedAt: '2026-04-07T01:00:00.000Z',
          blockingFindingShrink: true,
          blockingLocalFindingKeys: ['pdfua.figure_alt_or_artifact'],
        }],
      ]),
    })

    expect(report.recommendedNextEngineSlice).toBe('figure_final_mile_closure')
    expect(report.figureFinalMileRows).toContain('figure-1')
    expect(report.candidates.find(candidate => candidate.publicationId === 'figure-1')?.observedBlockingFindingShrink).toBe(true)
    expect(report.rankedCohorts[0]?.candidateEngineSliceTag).toBe('figure_final_mile_closure')
  })

  it('excludes manually mitigated rows and reports manual counts and reasons', () => {
    const artifacts: any = {
      document: {
        generatedAt: '2026-04-07T00:00:00.000Z',
        rows: [
          makeRow({
            publicationId: 'manual-ready',
            classificationEvidence: {
              ...makeRow().classificationEvidence,
              blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
            },
          }),
          makeRow({
            publicationId: 'manual-terminal',
            classificationEvidence: {
              ...makeRow().classificationEvidence,
              blockingFindingKeys: ['pdfua.logical_structure'],
            },
          }),
          makeRow({
            publicationId: 'active-backlog',
            classificationEvidence: {
              ...makeRow().classificationEvidence,
              blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
            },
          }),
        ],
      },
    }

    const report = buildResidualFamilyClosureReport({
      artifacts,
      latestOutcomeByPublicationId: new Map(),
      manualOutcomeByPublicationId: new Map([
        ['manual-ready', {
          status: 'manual_ready_to_replace' as const,
          manualResolutionReason: 'cleared_final_blockers',
        }],
        ['manual-terminal', {
          status: 'manual_terminalized' as const,
          manualResolutionReason: 'manual_object_level_repair_exhausted',
        }],
      ]),
    })

    expect(report.candidates.map(candidate => candidate.publicationId)).toEqual(['active-backlog'])
    expect(report.manualMitigation.manualReadyCount).toBe(1)
    expect(report.manualMitigation.manualTerminalizedCount).toBe(1)
    expect(report.manualMitigation.reasonsByFrequency.cleared_final_blockers).toBe(1)
    expect(report.manualMitigation.reasonsByFrequency.manual_object_level_repair_exhausted).toBe(1)
    expect(report.manualMitigation.excludedPublicationIds).toEqual(['manual-ready', 'manual-terminal'])
  })
})
