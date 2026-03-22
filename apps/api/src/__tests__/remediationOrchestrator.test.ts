import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  QueueApiClient,
  buildAttemptArtifactPaths,
  buildFailurePacketSummary,
  compareRenderedPageImages,
  createEmptyCampaignState,
  defaultOrchestratorConfig,
  deriveDashboardRow,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // imported for targeted classifier coverage
  isExpiredSessionError,
  loadCampaignState,
  progressBar,
  recoverInterruptedCampaignState,
  renderDashboard,
  renderProgressTrackerMarkdown,
  saveCampaignState,
  validateBookmarkTitles,
} from '../services/remediationOrchestrator.ts'

function makePng(fill: string, width = 4, height = 4): Buffer {
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = fill
  context.fillRect(0, 0, width, height)
  return canvas.toBuffer('image/png')
}

describe('remediationOrchestrator', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds deterministic attempt artifact paths', () => {
    const paths = buildAttemptArtifactPaths('/tmp/attempts', 'Example Report.pdf', 12)
    expect(paths.directory).toBe('/tmp/attempts/Example Report')
    expect(paths.pdfPath).toBe('/tmp/attempts/Example Report/attempt-012.pdf')
    expect(paths.originalPage1PngPath).toContain('attempt-012-original-page-1.png')
    expect(paths.remediatedPage1PngPath).toContain('attempt-012-remediated-page-1.png')
  })

  it('persists and reloads campaign state', () => {
    const statePath = path.join(os.tmpdir(), `orchestrator-state-${Date.now()}.json`)
    try {
      const state = createEmptyCampaignState('http://127.0.0.1:6103')
      state.files['sample.pdf'] = {
        filename: 'sample.pdf',
        sourcePath: '/tmp/sample.pdf',
        queueItemId: 'qid-1',
        attemptNumber: 2,
        loopCount: 2,
        lifecycleState: 'needs_fix',
        validationStage: 'idle',
        latestOutputPath: '/tmp/attempt-002.pdf',
        latestFailurePacketPath: null,
        latestScore: 82,
        latestGrade: 'C',
        latestVeraPdfStatus: 'failed',
        latestProcessingStage: 'Complete',
        latestProcessingProgress: 100,
        latestVisualComparison: null,
        latestBookmarkValidation: null,
        latestValidationPassed: false,
        resultProvenance: 'current_session',
        queuedAt: null,
        lastUpdatedAt: '2026-03-18T00:00:00.000Z',
      }
      saveCampaignState(statePath, state)
      const loaded = loadCampaignState(statePath, 'http://127.0.0.1:6103')
      expect(loaded.files['sample.pdf']?.queueItemId).toBe('qid-1')
      expect(loaded.files['sample.pdf']?.attemptNumber).toBe(2)
      expect(loaded.files['sample.pdf']?.lifecycleState).toBe('needs_fix')
    } finally {
      try { fs.unlinkSync(statePath) } catch {}
    }
  })

  it('recovers interrupted autofix entries on startup', () => {
    const state = createEmptyCampaignState('http://127.0.0.1:6103')
    state.files['stuck.pdf'] = {
      filename: 'stuck.pdf',
      sourcePath: '/tmp/stuck.pdf',
      queueItemId: null,
      attemptNumber: 3,
      loopCount: 3,
      lifecycleState: 'autofixing',
      validationStage: 'idle',
      latestOutputPath: '/tmp/stuck.pdf',
      latestFailurePacketPath: '/tmp/stuck-failure.json',
      latestScore: 44,
      latestGrade: 'F',
      latestVeraPdfStatus: 'failed',
      latestProcessingStage: 'Running Codex autofix',
      latestProcessingProgress: 100,
      latestVisualComparison: null,
      latestBookmarkValidation: null,
      latestValidationPassed: false,
      resultProvenance: 'current_session',
      queuedAt: null,
      lastUpdatedAt: '2026-03-18T00:00:00.000Z',
    }

    const recovered = recoverInterruptedCampaignState(state)
    expect(recovered.files['stuck.pdf']?.lifecycleState).toBe('needs_fix')
    expect(recovered.files['stuck.pdf']?.latestProcessingStage).toContain('Recovered')
    expect(recovered.recentEvents.at(-1)).toContain('Recovered interrupted autofix state')
  })

  it('recovers completed autofix entries into awaiting-restart state', () => {
    const state = createEmptyCampaignState('http://127.0.0.1:6103')
    state.recentEvents.push('2026-03-18T00:00:05.000Z Autofix batch completed: stuck.pdf')
    state.files['stuck.pdf'] = {
      filename: 'stuck.pdf',
      sourcePath: '/tmp/stuck.pdf',
      queueItemId: null,
      attemptNumber: 3,
      loopCount: 3,
      lifecycleState: 'autofixing',
      validationStage: 'idle',
      latestOutputPath: '/tmp/stuck.pdf',
      latestFailurePacketPath: '/tmp/stuck-failure.json',
      latestScore: 44,
      latestGrade: 'F',
      latestVeraPdfStatus: 'failed',
      latestProcessingStage: 'Running Codex autofix',
      latestProcessingProgress: 100,
      latestVisualComparison: null,
      latestBookmarkValidation: null,
      latestValidationPassed: false,
      resultProvenance: 'current_session',
      queuedAt: null,
      lastUpdatedAt: '2026-03-18T00:00:00.000Z',
    }

    const recovered = recoverInterruptedCampaignState(state)
    expect(recovered.files['stuck.pdf']?.lifecycleState).toBe('awaiting_restart')
    expect(recovered.files['stuck.pdf']?.latestProcessingStage).toContain('awaiting rerun')
    expect(recovered.files['stuck.pdf']?.resultProvenance).toBe('stale_after_restart')
  })

  it('detects expired client-session API errors', () => {
    expect(isExpiredSessionError(new Error('API request failed (401): {"error":"Client session expired"}'))).toBe(true)
    expect(isExpiredSessionError(new Error('API request failed (500): boom'))).toBe(false)
    expect(isExpiredSessionError(new Error('different message'))).toBe(false)
  })

  it('fails visual comparison when rendered pages differ too much', async () => {
    const original = makePng('#ffffff', 10, 10)
    const remediated = makePng('#000000', 10, 10)
    const result = await compareRenderedPageImages(original, remediated, 0.1)
    expect(result.passed).toBe(false)
    expect(result.changedPixelRatio).toBeGreaterThan(0.9)
  })

  it('passes visual comparison for identical rendered pages', async () => {
    const original = makePng('#336699', 10, 10)
    const result = await compareRenderedPageImages(original, original, 0.1)
    expect(result.passed).toBe(true)
    expect(result.changedPixelRatio).toBe(0)
  })

  it('validates bookmark quality using AI cleanup evidence and title heuristics', () => {
    const passing = validateBookmarkTitles(
      ['Executive Summary', 'Program Outcomes', 'Budget Overview'],
      {
        aiAppliedChanges: [{ type: 'bookmark', label: 'Bookmarks', details: 'AI cleaned', generationSource: 'semantic_ai' }],
        documentModel: null,
      },
    )
    expect(passing.passed).toBe(true)
    expect(passing.usedAiCleanup).toBe(true)

    const failing = validateBookmarkTitles(
      ['Council members ........................... 5', 'b:436f756e63696c'],
      {
        aiAppliedChanges: [],
        documentModel: null,
      },
    )
    expect(failing.passed).toBe(false)
    expect(failing.flaggedTitles).toHaveLength(2)
  })

  it('maps queue progress and validation states into dashboard rows', () => {
    const row = deriveDashboardRow({
      filename: 'report.pdf',
      sourcePath: '/tmp/report.pdf',
      queueItemId: 'qid-1',
      attemptNumber: 1,
      loopCount: 1,
      lifecycleState: 'remediating',
      validationStage: 'idle',
      latestOutputPath: null,
      latestFailurePacketPath: null,
      latestScore: null,
      latestGrade: null,
      latestVeraPdfStatus: null,
      latestProcessingStage: 'Applying PDF fixes (stage 5)',
      latestProcessingProgress: 60,
      latestVisualComparison: null,
      latestBookmarkValidation: null,
      latestValidationPassed: false,
      resultProvenance: 'current_session',
      queuedAt: null,
      lastUpdatedAt: '2026-03-18T00:00:00.000Z',
    })
    expect(row.progressPercent).toBe(48)
    expect(row.stageLabel).toContain('Applying PDF fixes')
  })

  it('renders a read-only dashboard with overall and per-file progress bars', () => {
    const state = createEmptyCampaignState('http://127.0.0.1:6103')
    state.recentEvents.push('2026-03-18T00:00:00.000Z Upload started: sample.pdf')
    state.files['done.pdf'] = {
      filename: 'done.pdf',
      sourcePath: '/tmp/done.pdf',
      queueItemId: 'qid-done',
      attemptNumber: 1,
      loopCount: 1,
      lifecycleState: 'done',
      validationStage: 'idle',
      latestOutputPath: '/tmp/done.pdf',
      latestFailurePacketPath: null,
      latestScore: 100,
      latestGrade: 'A',
      latestVeraPdfStatus: 'passed',
      latestProcessingStage: 'Complete',
      latestProcessingProgress: 100,
      latestVisualComparison: null,
      latestBookmarkValidation: null,
      latestValidationPassed: true,
      resultProvenance: 'current_session',
      queuedAt: null,
      lastUpdatedAt: '2026-03-18T00:00:00.000Z',
    }
    state.files['active.pdf'] = {
      filename: 'active.pdf',
      sourcePath: '/tmp/active.pdf',
      queueItemId: 'qid-active',
      attemptNumber: 2,
      loopCount: 2,
      lifecycleState: 'remediating',
      validationStage: 'idle',
      latestOutputPath: null,
      latestFailurePacketPath: null,
      latestScore: 88,
      latestGrade: 'B',
      latestVeraPdfStatus: 'failed',
      latestProcessingStage: 'Planning remediation',
      latestProcessingProgress: 40,
      latestVisualComparison: null,
      latestBookmarkValidation: null,
      latestValidationPassed: false,
      resultProvenance: 'current_session',
      queuedAt: null,
      lastUpdatedAt: '2026-03-18T00:00:00.000Z',
    }
    const rendered = renderDashboard(state, {
      apiStatus: 'ok',
      cpuCount: 8,
      loadAverage1m: 2,
      loadRatio: 0.25,
      totalMemoryBytes: 1024,
      freeMemoryBytes: 256,
      usedMemoryBytes: 768,
      memoryUsageRatio: 0.75,
      activeConcurrency: 1,
      concurrencyCap: 4,
    })
    expect(rendered).toContain('1/2 completed')
    expect(rendered).toContain('active.pdf')
    expect(rendered).toContain(progressBar(50, 40))
  })

  it('renders a progress tracker markdown snapshot from orchestrator state', () => {
    const state = createEmptyCampaignState('http://127.0.0.1:6103')
    const config = defaultOrchestratorConfig('/repo')
    state.lastApiRestartAt = '2026-03-18T00:00:00.000Z'
    state.recentEvents.push('2026-03-18T00:01:00.000Z Needs fix: report.pdf')
    const packetPath = path.join(os.tmpdir(), `orchestrator-failure-packet-${Date.now()}.json`)
    fs.writeFileSync(packetPath, JSON.stringify({
      filename: 'report.pdf',
      queueItemId: 'qid-report',
      latestAttemptPath: '/repo/MitigationAttempts/report/attempt-003.pdf',
      latestQueueSummary: {
        score: 92,
        grade: 'B',
        verapdfStatus: 'failed',
        failedChecks: 5,
      },
      topFailureModes: [],
      topBlockingResidualFamilyIds: ['post_bootstrap_heading_convergence'],
      topResidualFamilies: [{
        id: 'post_bootstrap_heading_convergence',
        label: 'Post-bootstrap heading convergence',
        blocking: true,
        blockingReason: 'blocking_failure_mode:context.post_bootstrap_structural_residue',
        convergenceStatus: 'preferred_tools_available',
        currentStep: 2,
        preferredAutoRunnableOpportunityKeys: ['normalize_heading_hierarchy:document:document'],
        evidenceSignals: ['blocking_failure_mode:context.post_bootstrap_structural_residue'],
        evidenceStrength: 14,
      }],
      semanticSidecarState: 'unknown',
      visualComparison: null,
      bookmarkValidation: null,
      freshPostRestartRemediation: true,
      generatedAt: '2026-03-18T00:01:00.000Z',
    }), 'utf8')
    state.files['report.pdf'] = {
      filename: 'report.pdf',
      sourcePath: '/repo/Downloads/report.pdf',
      queueItemId: 'qid-report',
      attemptNumber: 3,
      loopCount: 3,
      lifecycleState: 'needs_fix',
      validationStage: 'idle',
      latestOutputPath: '/repo/MitigationAttempts/report/attempt-003.pdf',
      latestFailurePacketPath: packetPath,
      latestScore: 92,
      latestGrade: 'B',
      latestVeraPdfStatus: 'failed',
      latestProcessingStage: 'Complete',
      latestProcessingProgress: 100,
      latestVisualComparison: null,
      latestBookmarkValidation: { passed: false, usedAiCleanup: false, reason: 'Bookmark cleanup did not appear to use the semantic AI path.', titles: [], flaggedTitles: [] },
      latestValidationPassed: false,
      resultProvenance: 'current_session',
      queuedAt: null,
      lastUpdatedAt: '2026-03-18T00:01:00.000Z',
    }
    const rendered = renderProgressTrackerMarkdown(state, config, {
      apiStatus: 'ok',
      cpuCount: 8,
      loadAverage1m: 2,
      loadRatio: 0.25,
      totalMemoryBytes: 1000,
      freeMemoryBytes: 500,
      usedMemoryBytes: 500,
      memoryUsageRatio: 0.5,
      activeConcurrency: 0,
      concurrencyCap: 4,
    })
    expect(rendered).toContain('# Remediation Progress')
    expect(rendered).toContain('Autofix the current blocker batch')
    expect(rendered).toContain('report.pdf')
    expect(rendered).toContain('post_bootstrap_heading_convergence')
    expect(rendered).toContain('API restart status')
    try { fs.unlinkSync(packetPath) } catch {}
  })

  it('summarizes failure packets with residual family evidence when available', () => {
    const summary = buildFailurePacketSummary({
      filename: 'report.pdf',
      queueItemId: 'qid-report',
      latestAttemptPath: '/repo/MitigationAttempts/report/attempt-003.pdf',
      latestQueueSummary: {
        score: 92,
        grade: 'B',
        verapdfStatus: 'failed',
        failedChecks: 5,
      },
      topFailureModes: [],
      topBlockingResidualFamilyIds: ['unresolved_manual_family'],
      topResidualFamilies: [{
        id: 'unresolved_manual_family',
        label: 'Unresolved manual family',
        blocking: true,
        blockingReason: 'manual_only_failure_mode',
        convergenceStatus: 'manual_only',
        currentStep: null,
        preferredAutoRunnableOpportunityKeys: [],
        evidenceSignals: ['manual_only_failure_mode:manual.semantic_follow_up'],
        evidenceStrength: 5,
      }],
      semanticSidecarState: 'semantic_sidecar_unavailable',
      visualComparison: null,
      bookmarkValidation: null,
      freshPostRestartRemediation: true,
      generatedAt: '2026-03-18T00:01:00.000Z',
    })

    expect(summary).toContain('unresolved_manual_family')
    expect(summary).toContain('manual_only_failure_mode')
  })

  it('calls the API queue endpoints with session auth', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        clientId: '12345678-1234-1234-1234-abcdefabcdef',
        expiresAt: '2026-03-19T00:00:00.000Z',
        restored: false,
      }), {
        status: 200,
        headers: { 'set-cookie': 'client_session=test-cookie; Path=/; HttpOnly' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [],
        counts: { active: 0, history: 0, processing: 0, failed: 0, complete: 0 },
        generatedAt: '2026-03-18T00:00:00.000Z',
      }), { status: 200 }))

    const client = new QueueApiClient({
      baseUrl: 'http://127.0.0.1:6103',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const session = await client.bootstrap('12345678-1234-1234-1234-abcdefabcdef')
    expect(session.cookie).toBe('client_session=test-cookie')

    await client.queueStatus()
    expect(fetchImpl).toHaveBeenNthCalledWith(2,
      'http://127.0.0.1:6103/api/queue/status',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-client-id': '12345678-1234-1234-1234-abcdefabcdef',
          cookie: 'client_session=test-cookie',
        }),
      }),
    )
  })
})
