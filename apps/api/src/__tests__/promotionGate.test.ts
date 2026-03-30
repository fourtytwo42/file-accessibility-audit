import { describe, expect, it } from 'vitest'
import { evaluatePromotionGate } from '../services/promotionGate.js'
import { createVerifiedPromotionLedgerRow } from '../services/promotionLedger.js'

describe('evaluatePromotionGate', () => {
  it('ignores Color Contrast but rejects other scored deficits and blockers', () => {
    const gate = evaluatePromotionGate({
      analysisResult: {
        grade: 'A',
        overallScore: 100,
        isScanned: false,
        localStandards: {
          findings: [
            { key: 'category.color_contrast', blocking: true },
            { key: 'pdfua.figure_alt_or_artifact', blocking: true },
          ],
        },
        categories: [
          { label: 'Color Contrast', score: 71 },
          { label: 'Alt Text on Images', score: 92 },
        ],
      },
      manualReviewFlags: [],
    })

    expect(gate.passed).toBe(false)
    expect(gate.blockingLocalFindingKeys).toEqual(['pdfua.figure_alt_or_artifact'])
    expect(gate.unresolvedCategoryLabels).toEqual(['Alt Text on Images'])
    expect(gate.reasons).toContain('Blocking local standards findings remain: pdfua.figure_alt_or_artifact')
    expect(gate.reasons).toContain('Categories still below 100: Alt Text on Images')
  })

  it('fails when critical manual review flags remain', () => {
    const gate = evaluatePromotionGate({
      analysisResult: {
        grade: 'A',
        overallScore: 100,
        isScanned: false,
        localStandards: { findings: [] },
        categories: [{ label: 'Color Contrast', score: 99 }],
      },
      manualReviewFlags: [
        { code: 'reading_order_manual_review', severity: 'critical' },
      ],
    })

    expect(gate.passed).toBe(false)
    expect(gate.criticalManualReviewFlagCodes).toEqual(['reading_order_manual_review'])
    expect(gate.reasons).toContain('Critical manual review flags remain: reading_order_manual_review')
  })
})

describe('createVerifiedPromotionLedgerRow', () => {
  it('creates ledger rows only for verified-pass items', () => {
    const failed = createVerifiedPromotionLedgerRow({
      publicationId: '123',
      publicationTitle: 'Failed Example',
      sourceKind: 'batch_ready',
      sourcePathOrUrl: '/tmp/original.pdf',
      sourceFileUrl: 'https://example.test/original.pdf',
      localFinalArtifactPath: '/tmp/final.pdf',
      stagedReplacementPath: '/tmp/staged.pdf',
      currentSourceChecksumSha256: 'aaa',
      replacementChecksumSha256: 'bbb',
      verificationReportPath: '/tmp/report.json',
      verificationTimestamp: '2026-03-30T00:00:00.000Z',
      verificationSummary: {
        passed: false,
        overallScore: 87,
        grade: 'B',
        pageCount: 12,
        isScanned: false,
        reasons: ['Final grade is B, not A.'],
        blockingLocalFindingKeys: [],
        unresolvedCategoryLabels: ['Alt Text on Images'],
        criticalManualReviewFlagCodes: [],
      },
    })

    const passed = createVerifiedPromotionLedgerRow({
      publicationId: '456',
      publicationTitle: 'Passing Example',
      sourceKind: 'batch_ready',
      sourcePathOrUrl: '/tmp/original.pdf',
      sourceFileUrl: 'https://example.test/original.pdf',
      localFinalArtifactPath: '/tmp/final.pdf',
      stagedReplacementPath: '/tmp/staged.pdf',
      currentSourceChecksumSha256: 'aaa',
      replacementChecksumSha256: 'bbb',
      verificationReportPath: '/tmp/report.json',
      verificationTimestamp: '2026-03-30T00:00:00.000Z',
      verificationSummary: {
        passed: true,
        overallScore: 100,
        grade: 'A',
        pageCount: 12,
        isScanned: false,
        reasons: [],
        blockingLocalFindingKeys: [],
        unresolvedCategoryLabels: [],
        criticalManualReviewFlagCodes: [],
      },
    })

    expect(failed).toBeNull()
    expect(passed).toMatchObject({
      publicationId: '456',
      promotionStatus: 'verified_pass',
      stagedReplacementPath: '/tmp/staged.pdf',
      replacementChecksumSha256: 'bbb',
    })
  })
})
