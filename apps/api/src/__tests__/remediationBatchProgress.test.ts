import { describe, expect, it } from 'vitest'
import {
  buildBatchStatusSnapshot,
  classifyOutcomeResultBand,
  createOrResumeProgressDocument,
  emptyResultBandCounts,
} from '../../../../scripts/remediation-batch-progress.ts'

describe('remediationBatchProgress', () => {
  it('classifies score bands for pass, keep, drop, and terminal errors', () => {
    expect(classifyOutcomeResultBand({ status: 'remediated_pass_candidate', finalOverallScore: 92, gatePassed: true })).toBe('pass_ge_90')
    expect(classifyOutcomeResultBand({ status: 'failed_after_remediation', finalOverallScore: 85, gatePassed: false })).toBe('keep_fail_80_to_89')
    expect(classifyOutcomeResultBand({ status: 'failed_after_remediation', finalOverallScore: 75, gatePassed: false })).toBe('drop_fail_lt_80')
    expect(classifyOutcomeResultBand({ status: 'processing_error' })).toBe('processing_error')
    expect(classifyOutcomeResultBand({ status: 'source_missing' })).toBe('source_missing')
  })

  it('rejects a second live owner when single-owner enforcement is enabled', () => {
    expect(() => createOrResumeProgressDocument({
      existingProgress: {
        runId: 'run-1',
        state: 'running',
        pid: 333,
        manifestPath: '/tmp/manifest.json',
        outcomesPath: '/tmp/outcomes.json',
        firstStartedAt: '2026-04-08T00:00:00.000Z',
        currentSessionStartedAt: '2026-04-08T00:00:00.000Z',
        accumulatedActiveRuntimeMs: 0,
        lastHeartbeatAt: '2026-04-08T00:05:00.000Z',
        totalCandidates: 10,
        processed: 2,
        remaining: 8,
        activeWorkers: 2,
        scorePolicy: { minPassOverallScore: 90, minKeepOverallScore: 80 },
        countsByResultBand: emptyResultBandCounts(),
        lastCompleted: null,
      },
      manifestPath: '/tmp/manifest.json',
      outcomesPath: '/tmp/outcomes.json',
      totalCandidates: 10,
      processed: 2,
      remaining: 8,
      countsByResultBand: emptyResultBandCounts(),
      scorePolicy: { minPassOverallScore: 90, minKeepOverallScore: 80 },
      pid: 444,
      enforceSingleOwner: true,
      isAlive: () => true,
    })).toThrow(/already active/)
  })

  it('carries forward active runtime when resuming a stale run', () => {
    const progress = createOrResumeProgressDocument({
      existingProgress: {
        runId: 'run-1',
        state: 'running',
        pid: 333,
        manifestPath: '/tmp/manifest.json',
        outcomesPath: '/tmp/outcomes.json',
        firstStartedAt: '2026-04-08T00:00:00.000Z',
        currentSessionStartedAt: '2026-04-08T00:00:00.000Z',
        accumulatedActiveRuntimeMs: 1000,
        lastHeartbeatAt: '2026-04-08T00:30:00.000Z',
        totalCandidates: 10,
        processed: 3,
        remaining: 7,
        activeWorkers: 0,
        scorePolicy: { minPassOverallScore: 90, minKeepOverallScore: 80 },
        countsByResultBand: emptyResultBandCounts(),
        lastCompleted: null,
      },
      manifestPath: '/tmp/manifest.json',
      outcomesPath: '/tmp/outcomes.json',
      totalCandidates: 10,
      processed: 3,
      remaining: 7,
      countsByResultBand: emptyResultBandCounts(),
      scorePolicy: { minPassOverallScore: 90, minKeepOverallScore: 80 },
      pid: 555,
      now: new Date('2026-04-08T01:00:00.000Z'),
      enforceSingleOwner: true,
      isAlive: () => false,
    })

    expect(progress.runId).toBe('run-1')
    expect(progress.accumulatedActiveRuntimeMs).toBe(1801000)
    expect(progress.currentSessionStartedAt).toBe('2026-04-08T01:00:00.000Z')
  })

  it('builds status snapshots with ETA from active wall-clock runtime', () => {
    const snapshot = buildBatchStatusSnapshot({
      manifestPath: '/tmp/manifest.json',
      outcomesPath: '/tmp/outcomes.json',
      progressPath: '/tmp/outcomes.progress.json',
      totalCandidates: 30,
      outcomes: Array.from({ length: 15 }, (_, index) => ({
        publicationId: `${index + 1}`,
        status: index < 5 ? 'remediated_pass_candidate' : 'failed_after_remediation',
        resultBand: index < 5 ? 'pass_ge_90' : 'keep_fail_80_to_89',
        processedAt: `2026-04-08T00:${String(index).padStart(2, '0')}:00.000Z`,
        final: {
          overallScore: index < 5 ? 92 : 85,
        },
      })),
      progress: {
        runId: 'run-eta',
        state: 'running',
        pid: 999,
        manifestPath: '/tmp/manifest.json',
        outcomesPath: '/tmp/outcomes.json',
        firstStartedAt: '2026-04-08T00:00:00.000Z',
        currentSessionStartedAt: '2026-04-08T01:00:00.000Z',
        accumulatedActiveRuntimeMs: 60 * 60 * 1000,
        lastHeartbeatAt: '2026-04-08T01:25:00.000Z',
        totalCandidates: 30,
        processed: 15,
        remaining: 15,
        activeWorkers: 4,
        scorePolicy: { minPassOverallScore: 90, minKeepOverallScore: 80 },
        countsByResultBand: {
          pass_ge_90: 5,
          keep_fail_80_to_89: 10,
          drop_fail_lt_80: 0,
          processing_error: 0,
          source_missing: 0,
        },
        lastCompleted: null,
      },
      now: new Date('2026-04-08T01:30:00.000Z'),
      isAlive: () => true,
    })

    expect(snapshot.runState).toBe('running')
    expect(snapshot.effectiveActiveRuntimeMs).toBe(90 * 60 * 1000)
    expect(snapshot.pdfsPerHour).toBe(10)
    expect(snapshot.etaMs).toBe(90 * 60 * 1000)
  })

  it('treats orphaned partial outcomes as stale and full outcomes as completed', () => {
    const staleSnapshot = buildBatchStatusSnapshot({
      manifestPath: '/tmp/manifest.json',
      outcomesPath: '/tmp/outcomes.json',
      progressPath: '/tmp/outcomes.progress.json',
      totalCandidates: 5,
      outcomes: [{ publicationId: '1', status: 'failed_after_remediation', resultBand: 'drop_fail_lt_80' }],
      progress: null,
    })
    const completedSnapshot = buildBatchStatusSnapshot({
      manifestPath: '/tmp/manifest.json',
      outcomesPath: '/tmp/outcomes.json',
      progressPath: '/tmp/outcomes.progress.json',
      totalCandidates: 1,
      outcomes: [{ publicationId: '1', status: 'remediated_pass_candidate', resultBand: 'pass_ge_90' }],
      progress: null,
    })

    expect(staleSnapshot.runState).toBe('stale')
    expect(completedSnapshot.runState).toBe('completed')
  })
})
