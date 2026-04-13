import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VERIFY_MIN_PASS_SCORE,
  evaluateVerificationGate,
  getVerificationScorePolicy,
} from '../../../../scripts/verify-ready-to-replace.ts'
import { classifyResult } from '../../../../scripts/classify-ready-verification.ts'

describe('verify-ready policy', () => {
  it('uses the 90-point forward verification threshold by default', () => {
    expect(getVerificationScorePolicy()).toEqual({
      minPassOverallScore: DEFAULT_VERIFY_MIN_PASS_SCORE,
    })
  })

  it('treats staged 90+ outputs as verified pass candidates under the new policy', () => {
    const gate = evaluateVerificationGate({
      analysisResult: {
        overallScore: 92,
        grade: 'B',
        isScanned: false,
        localStandards: {
          findings: [
            { key: 'pdfua.logical_structure', blocking: true },
          ],
        },
        categories: [
          { label: 'PDF/UA Compliance', score: 92 },
        ],
      },
      criticalManualReviewFlagCodes: [],
    })

    expect(gate.passed).toBe(true)
  })

  it('does not verify 80-89 staged outputs as pass', () => {
    const gate = evaluateVerificationGate({
      analysisResult: {
        overallScore: 85,
        grade: 'B',
        isScanned: false,
        localStandards: {
          findings: [],
        },
        categories: [],
      },
      criticalManualReviewFlagCodes: [],
    })

    expect(gate.passed).toBe(false)
    expect(gate.reasons[0]).toContain('below relaxed threshold 90')
  })

  it('holds visually flagged replacements out of verified pass classification', () => {
    const classification = classifyResult({
      key: 'local:/tmp/example.pdf',
      mode: 'local_staged',
      sourcePathOrUrl: '/tmp/example.pdf',
      filename: 'example.pdf',
      verifiedAt: '2026-04-10T00:00:00.000Z',
      durationMs: 10,
      passed: true,
      missing: false,
      error: null,
      summary: {
        overallScore: 100,
        grade: 'A',
        pageCount: 4,
        isScanned: false,
      },
      gate: {
        reasons: [],
        blockingLocalFindingKeys: [],
        unresolvedCategoryLabels: [],
      },
      visualApproval: {
        required: true,
        approved: false,
        reasonCodes: ['visual_parity_material_change'],
      },
      artifacts: {
        reportPath: '/tmp/report.json',
      },
    })

    expect(classification).toBe('held_visual_review')
  })
})
