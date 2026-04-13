import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzePdf, remediatePdf, verifyPdf, explainFailure } from '../engine/index.js'

// Mock the long-running AI agent so remediatePdf tests stay fast
vi.mock('../services/agentRemediationService.js', () => ({
  remediatePdfWithAgent: vi.fn(),
}))

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const accessiblePdf = fs.readFileSync(path.join(fixturesDir, 'accessible.pdf'))
const inaccessiblePdf = fs.readFileSync(path.join(fixturesDir, 'inaccessible.pdf'))

const ANALYSIS_TIMEOUT = 30_000

// ─── analyzePdf ──────────────────────────────────────────────────────────────

describe('analyzePdf', () => {
  it('returns a valid AnalysisResult shape', async () => {
    const result = await analyzePdf(accessiblePdf, 'accessible.pdf')
    expect(result).toMatchObject({
      grade: expect.any(String),
      overallScore: expect.any(Number),
      categories: expect.any(Array),
      filename: 'accessible.pdf',
      requestPolicy: {
        remediationPolicy: { visualPreservation: 'strict' },
        artifactRetention: 'summary',
      },
      diagnostics: {
        blockingFindingKeys: expect.any(Array),
        unresolvedCategories: expect.any(Array),
      },
    })
  }, ANALYSIS_TIMEOUT)

  it('returns a valid grade letter', async () => {
    const result = await analyzePdf(accessiblePdf, 'accessible.pdf')
    expect(['A', 'B', 'C', 'D', 'F']).toContain(result.grade)
    expect(result.overallScore).toBeGreaterThanOrEqual(0)
    expect(result.overallScore).toBeLessThanOrEqual(100)
  }, ANALYSIS_TIMEOUT)

  it('inaccessible PDF scores below accessible PDF', async () => {
    const [accessible, inaccessible] = await Promise.all([
      analyzePdf(accessiblePdf, 'accessible.pdf'),
      analyzePdf(inaccessiblePdf, 'inaccessible.pdf'),
    ])
    expect(accessible.overallScore).toBeGreaterThanOrEqual(inaccessible.overallScore)
  }, ANALYSIS_TIMEOUT)
})

// ─── verifyPdf ───────────────────────────────────────────────────────────────

describe('verifyPdf', () => {
  it('returns a valid gate result shape', async () => {
    const analysis = await analyzePdf(accessiblePdf, 'accessible.pdf')
    const result = verifyPdf(analysis)
    expect(typeof result.passed).toBe('boolean')
    expect(Array.isArray(result.reasons)).toBe(true)
  }, ANALYSIS_TIMEOUT)

  it('fails inaccessible PDF through promotion gate', async () => {
    const analysis = await analyzePdf(inaccessiblePdf, 'inaccessible.pdf')
    const result = verifyPdf(analysis)
    expect(result.passed).toBe(false)
    expect(result.reasons.length).toBeGreaterThan(0)
  }, ANALYSIS_TIMEOUT)
})

// ─── explainFailure ──────────────────────────────────────────────────────────

describe('explainFailure', () => {
  it('returns a valid ExplainResult shape (analysis-only path)', async () => {
    const analysis = await analyzePdf(accessiblePdf, 'accessible.pdf')
    const result = explainFailure(analysis)
    expect(typeof result.passed).toBe('boolean')
    expect(['A', 'B', 'C', 'D', 'F']).toContain(result.grade)
    expect(typeof result.summary).toBe('string')
    expect(result.failureModes).toBeNull()
    expect(result.plannerEvidence).toBeNull()
    expect(result.requestPolicy.remediationPolicy?.visualPreservation).toBe('strict')
    expect(result.diagnostics.blockingFindingKeys).toEqual(expect.any(Array))
  }, ANALYSIS_TIMEOUT)

  it('returns failure summary with blocking items for inaccessible PDF', async () => {
    const analysis = await analyzePdf(inaccessiblePdf, 'inaccessible.pdf')
    const result = explainFailure(analysis)
    expect(result.passed).toBe(false)
    expect(result.summary).toMatch(/Grade/)
    expect(result.unresolvedCategories.length + result.blockingFindings.length).toBeGreaterThan(0)
  }, ANALYSIS_TIMEOUT)
})

// ─── remediatePdf ────────────────────────────────────────────────────────────

describe('remediatePdf', () => {
  beforeEach(() => vi.resetAllMocks())

  it('reshapes remediatePdfWithAgent output into RemediationResult', async () => {
    // analyzePdf runs inside to produce fakeAnalysis — needs extended timeout
    const { remediatePdfWithAgent } = await import('../services/agentRemediationService.js')
    const fakeAnalysis = await analyzePdf(accessiblePdf, 'accessible.pdf')

    vi.mocked(remediatePdfWithAgent).mockResolvedValueOnce({
      buffer: accessiblePdf,
      finalResult: fakeAnalysis,
      model: {
        aiAppliedChanges: [],
        manualReviewFlags: [],
        remediationMetrics: null,
        failureProfile: {
          version: '2',
          generatedAt: new Date().toISOString(),
          analysisGrade: fakeAnalysis.grade,
          analysisScore: fakeAnalysis.overallScore,
          veraPdfStatus: fakeAnalysis.verapdf.status,
          veraPdfFailedChecks: fakeAnalysis.verapdf.failedChecks,
          adobeStatus: fakeAnalysis.adobe?.status,
          adobeIssueCount: fakeAnalysis.adobe?.issueCount,
          failureModes: [],
          residualFamilies: [],
          toolOpportunities: [],
          summary: {
            deterministicIssueCount: 0,
            semanticIssueCount: 0,
            manualOnlyIssueCount: 0,
            blockedOpportunityCount: 0,
            autoRunnableOpportunityCount: 0,
            safeToRetry: false,
            dominantResidualFamily: 'unknown',
            lastStableNoEffectTool: 'repair_native_figure_semantics',
            retryDisposition: 'stable_hard_fail',
          },
        },
        plannerEvidence: {
          topFailureModeKeys: [],
          topResidualFamilyIds: [],
          topBlockingResidualFamilyIds: [],
          topResidualFamilySummaries: [],
          topBlockingFailureModeKeys: [],
          topManualOnlyFailureModeKeys: [],
          topAutoRunnableOpportunityKeys: [],
          skippedReasonCounts: [],
          attemptedKeys: [],
          rejectedKeys: [],
          noEffectKeys: [],
          attemptedOpportunityKeys: [],
          rejectedOpportunityKeys: [],
          noEffectOpportunityKeys: [],
          statusCounts: [],
          reasonCodeCounts: [],
          safeToRetry: false,
          dominantResidualFamily: 'unknown',
          lastStableNoEffectTool: 'repair_native_figure_semantics',
          retryDisposition: 'stable_hard_fail',
        },
        finalAudit: null,
      } as any,
      artifacts: { pageImages: [] },
    })

    const result = await remediatePdf(accessiblePdf, 'accessible.pdf', fakeAnalysis)

    expect(result.buffer).toBeInstanceOf(Buffer)
    expect(result.finalAnalysis).toBe(fakeAnalysis)
    expect(result.appliedActions).toEqual([])
    expect(result.manualReviewFlags).toEqual([])
    expect(result.finalAudit).toBeNull()
    expect(result.failureProfile).not.toBeNull()
    expect(result.plannerEvidence).not.toBeNull()
    expect(result.promotionGate).toMatchObject({
      passed: expect.any(Boolean),
      reasons: expect.any(Array),
    })
    expect(result.requestPolicy.remediationPolicy?.visualPreservation).toBe('strict')
    expect(result.diagnostics.runtimeMetrics).toBeNull()
    expect(result.diagnostics.safeToRetry).toBe(false)
    expect(result.diagnostics.dominantResidualFamily).toBe('unknown')
    expect(result.diagnostics.lastStableNoEffectTool).toBe('repair_native_figure_semantics')
    expect(result.diagnostics.retryDisposition).toBe('stable_hard_fail')
    expect(result.diagnostics.stopReasons.runtimeRetryClassification).toBe('stable_hard_fail')
  }, ANALYSIS_TIMEOUT)
})
