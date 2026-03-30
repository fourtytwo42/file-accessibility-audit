export type PromotionLifecycleStatus =
  | 'remediated_pass_candidate'
  | 'verified_pass'
  | 'staged_for_replacement'
  | 'replaced_remote'

export interface PromotionLedgerVerificationSummary {
  passed: boolean
  overallScore: number | null
  grade: string | null
  pageCount: number | null
  isScanned: boolean | null
  reasons: string[]
  blockingLocalFindingKeys: string[]
  unresolvedCategoryLabels: string[]
  criticalManualReviewFlagCodes: string[]
}

export interface PromotionLedgerRow {
  publicationId: string
  publicationTitle: string | null
  sourceKind: string
  sourcePathOrUrl: string | null
  sourceFileUrl: string | null
  localFinalArtifactPath: string | null
  stagedReplacementPath: string
  currentSourceChecksumSha256: string | null
  replacementChecksumSha256: string
  verificationReportPath: string
  verificationTimestamp: string
  verificationSummary: PromotionLedgerVerificationSummary
  promotionStatus: PromotionLifecycleStatus
}

export function createVerifiedPromotionLedgerRow(input: {
  publicationId: string | null
  publicationTitle: string | null
  sourceKind: string
  sourcePathOrUrl: string | null
  sourceFileUrl: string | null
  localFinalArtifactPath: string | null
  stagedReplacementPath: string | null
  currentSourceChecksumSha256: string | null
  replacementChecksumSha256: string | null
  verificationReportPath: string | null
  verificationTimestamp: string | null
  verificationSummary: PromotionLedgerVerificationSummary
}): PromotionLedgerRow | null {
  if (!input.publicationId) return null
  if (!input.stagedReplacementPath) return null
  if (!input.replacementChecksumSha256) return null
  if (!input.verificationReportPath || !input.verificationTimestamp) return null
  if (!input.verificationSummary.passed) return null

  return {
    publicationId: input.publicationId,
    publicationTitle: input.publicationTitle,
    sourceKind: input.sourceKind,
    sourcePathOrUrl: input.sourcePathOrUrl,
    sourceFileUrl: input.sourceFileUrl,
    localFinalArtifactPath: input.localFinalArtifactPath,
    stagedReplacementPath: input.stagedReplacementPath,
    currentSourceChecksumSha256: input.currentSourceChecksumSha256,
    replacementChecksumSha256: input.replacementChecksumSha256,
    verificationReportPath: input.verificationReportPath,
    verificationTimestamp: input.verificationTimestamp,
    verificationSummary: input.verificationSummary,
    promotionStatus: 'verified_pass',
  }
}
