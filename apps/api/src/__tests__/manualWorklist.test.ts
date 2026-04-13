import { describe, expect, it } from 'vitest'
import {
  INITIAL_MANUAL_WORKLIST_PUBLICATION_IDS,
  buildManualWorklist,
  summarizeManualWorklistOutcomes,
  type ManualWorklistOutcomeDocument,
} from '../services/manualWorklist.js'

describe('manualWorklist', () => {
  it('emits the first-wave manual queue in the exact configured order', () => {
    const worklist = buildManualWorklist({
      sourceControlPlanePath: '/tmp/control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-07T00:00:00.000Z',
      sourceFigureFinalMileClosurePath: '/tmp/figure-final-mile-closure.json',
      candidates: INITIAL_MANUAL_WORKLIST_PUBLICATION_IDS.map((publicationId, index) => ({
        publicationId,
        publicationTitle: `Title ${publicationId}`,
        serverHost: '143.244.146.43',
        localCachePath: `/tmp/${publicationId}.pdf`,
        bestManualInputPath: `/tmp/${publicationId}.manual.pdf`,
        dominantResidualFamily: 'figure' as const,
        blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
        pageCount: index + 1,
        runtimeWeightBucket: 'medium' as const,
      })),
    })

    expect(worklist.selectedPublicationIds).toEqual([...INITIAL_MANUAL_WORKLIST_PUBLICATION_IDS])
    expect(worklist.candidates).toHaveLength(12)
    expect(worklist.candidates[0]?.manualPriorityRank).toBe(1)
    expect(worklist.candidates[0]?.manualRationale).toBe('phase_a_calibration_object_level_figure_surgery')
    expect(worklist.candidates[3]?.manualRationale).toBe('phase_b_automation_relief_heavy_figure_final_mile')
  })

  it('summarizes manual outcomes by status and reason', () => {
    const outcomes: ManualWorklistOutcomeDocument = {
      generatedAt: '2026-04-07T00:00:00.000Z',
      queueName: 'manual-worklist',
      outcomes: [
        {
          publicationId: '4481',
          publicationTitle: 'One',
          status: 'manual_ready_to_replace',
          processedAt: '2026-04-07T01:00:00.000Z',
          inputPath: '/tmp/in1.pdf',
          outputPath: '/tmp/out1.pdf',
          reportPath: '/tmp/report1.json',
          stagedReplacementPath: '/tmp/staged1.pdf',
          beforeScore: 89,
          afterScore: 100,
          beforeGrade: 'B',
          afterGrade: 'A',
          beforeBlockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
          afterBlockingFindingKeys: [],
          manualResolutionReason: 'cleared_final_blockers',
          manualResolutionNotes: 'done',
          lastValidatedAt: '2026-04-07T01:00:00.000Z',
        },
        {
          publicationId: '4186',
          publicationTitle: 'Two',
          status: 'manual_terminalized',
          processedAt: '2026-04-07T02:00:00.000Z',
          inputPath: '/tmp/in2.pdf',
          outputPath: null,
          reportPath: '/tmp/report2.json',
          stagedReplacementPath: null,
          beforeScore: 91,
          afterScore: 91,
          beforeGrade: 'B',
          afterGrade: 'B',
          beforeBlockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
          afterBlockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
          manualResolutionReason: 'manual_object_level_repair_exhausted',
          manualResolutionNotes: 'stuck',
          lastValidatedAt: '2026-04-07T02:00:00.000Z',
        },
      ],
    }

    const summary = summarizeManualWorklistOutcomes(outcomes)

    expect(summary.totals.manualReadyToReplace).toBe(1)
    expect(summary.totals.manualTerminalized).toBe(1)
    expect(summary.reasonsByFrequency.cleared_final_blockers).toBe(1)
    expect(summary.reasonsByFrequency.manual_object_level_repair_exhausted).toBe(1)
    expect(summary.statusByPublicationId['4481']).toBe('manual_ready_to_replace')
  })
})
