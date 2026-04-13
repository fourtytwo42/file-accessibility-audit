import { describe, expect, it } from 'vitest'
import {
  planRuntimeTailChunk,
  recommendRuntimeTailOvernightAction,
  summarizeRuntimeTailChunkMetrics,
} from '../services/runtimeTailOvernight.js'

describe('runtimeTailOvernight', () => {
  it('stops and replans on exit 137', () => {
    expect(recommendRuntimeTailOvernightAction({
      sliceIntent: 'pass_rate_conversion',
      selectedCount: 8,
      passCandidates: 1,
      processingErrorCount: 0,
      processingErrorToStableHardFail: 2,
      unchangedProcessingError: 0,
      targetedFindingDeltas: { 'pdfua.figure_alt_or_artifact': -1 },
      targetedFamilyDeltas: { native_figure_convergence: -1 },
      remainingRetryWorthyRows: 10,
      consecutiveLowYieldChunks: 0,
      exitCode: 137,
    })).toBe('stop_and_replan_engine')
  })

  it('switches pass-rate lanes to terminalization after repeated low-yield chunks', () => {
    expect(recommendRuntimeTailOvernightAction({
      sliceIntent: 'pass_rate_conversion',
      selectedCount: 8,
      passCandidates: 0,
      processingErrorCount: 0,
      processingErrorToStableHardFail: 1,
      unchangedProcessingError: 0,
      targetedFindingDeltas: { 'pdfua.figure_alt_or_artifact': 0 },
      targetedFamilyDeltas: { native_figure_convergence: 0 },
      remainingRetryWorthyRows: 12,
      consecutiveLowYieldChunks: 2,
    })).toBe('switch_to_terminalization')
  })

  it('keeps truth-hardening and pass-rate summaries separate', () => {
    const summary = summarizeRuntimeTailChunkMetrics({
      sliceIntent: 'truth_hardening_terminalization',
      selectedCount: 8,
      passCandidates: 0,
      processingErrorCount: 1,
      processingErrorToStableHardFail: 3,
      unchangedProcessingError: 1,
      targetedFindingDeltas: { 'pdfua.figure_alt_or_artifact': -2, 'pdfua.logical_structure': 0 },
      targetedFamilyDeltas: { native_figure_convergence: -1, post_bootstrap_heading_convergence: 0 },
      remainingRetryWorthyRows: 22,
      consecutiveLowYieldChunks: 0,
    })

    expect(summary.passRateSummary.passCandidates).toBe(0)
    expect(summary.passRateSummary.blockerReductionObserved).toBe(true)
    expect(summary.truthHardeningSummary.processingErrorToFailedAfterRemediation).toBe(3)
    expect(summary.truthHardeningSummary.rowsRemovedFromRetryBudget).toBe(3)
  })

  it('stops a truth-hardening lane after repeated low-yield chunks', () => {
    expect(recommendRuntimeTailOvernightAction({
      sliceIntent: 'truth_hardening_terminalization',
      selectedCount: 8,
      passCandidates: 0,
      processingErrorCount: 0,
      processingErrorToStableHardFail: 0,
      unchangedProcessingError: 2,
      targetedFindingDeltas: { 'pdfua.figure_alt_or_artifact': 0 },
      targetedFamilyDeltas: { native_figure_convergence: 0 },
      remainingRetryWorthyRows: 18,
      consecutiveLowYieldChunks: 2,
    })).toBe('stop_and_replan_engine')
  })

  it('isolates heavyweight mixed rows into smaller serial chunks', () => {
    const plan = planRuntimeTailChunk({
      sliceIntent: 'truth_hardening_terminalization',
      nominalChunkSize: 8,
      candidates: [
        { publicationId: 'caps3-a', runtimeWeightBucket: 'heavy', runtimeProfileKey: 'caps#', passLikelihoodScore: 60 },
        { publicationId: 'caps3-b', runtimeWeightBucket: 'heavy', runtimeProfileKey: 'caps#', passLikelihoodScore: 59 },
        { publicationId: 'lighter-1', runtimeWeightBucket: 'light', runtimeProfileKey: 'light_1', passLikelihoodScore: 55 },
        { publicationId: 'lighter-2', runtimeWeightBucket: 'light', runtimeProfileKey: 'light_2', passLikelihoodScore: 54 },
      ],
    })

    expect(plan.selectedPublicationIds).toEqual(['lighter-1', 'lighter-2', 'caps3-a'])
    expect(plan.runtimeWeightBucket).toBe('heavy')
    expect(plan.selectedPublicationIds).toHaveLength(3)
    expect(plan.concurrency).toBe(1)
    expect(plan.isolatedHeavyProfileKeys).toEqual(['caps#'])
  })

  it('uses serial concurrency when the next mixed chunk must carry a heavyweight row', () => {
    const plan = planRuntimeTailChunk({
      sliceIntent: 'truth_hardening_terminalization',
      nominalChunkSize: 8,
      candidates: [
        { publicationId: 'caps3-a', runtimeWeightBucket: 'heavy', runtimeProfileKey: 'caps#', passLikelihoodScore: 60 },
      ],
    })

    expect(plan.selectedPublicationIds).toEqual(['caps3-a'])
    expect(plan.runtimeWeightBucket).toBe('heavy')
    expect(plan.chunkSizeCap).toBe(1)
    expect(plan.concurrency).toBe(1)
    expect(plan.isolatedHeavyProfileKeys).toEqual(['caps#'])
  })
})
