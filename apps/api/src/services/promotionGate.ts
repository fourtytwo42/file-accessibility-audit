import type { ModelReviewFlag } from './documentModel.js'

export interface PromotionGateResult {
  passed: boolean
  reasons: string[]
  blockingLocalFindingKeys: string[]
  unresolvedCategoryLabels: string[]
  criticalManualReviewFlagCodes: string[]
}

export const NON_BLOCKING_PROMOTION_CATEGORY_LABELS = new Set(['Color Contrast'])
export const NON_BLOCKING_PROMOTION_LOCAL_FINDING_KEYS = new Set(['category.color_contrast'])

type ManualReviewFlagLike = Pick<ModelReviewFlag, 'code' | 'severity'>

export type EvaluatePromotionGateOptions = {
  /**
   * Relaxed pass for manual / experimental lanes: pass when not scanned, overall score >= this
   * value, and no critical manual-review flags. Grade A, blocking locals, and category deficits
   * are ignored for `passed` (still returned on the result for reporting).
   * Replacement verification and the engine default to strict mode (omit this option).
   */
  minOverallScore?: number
}

function collectPromotionDiagnostics(input: {
  analysisResult: any
  manualReviewFlags?: ManualReviewFlagLike[] | null
  criticalManualReviewFlagCodes?: string[] | null
}): Pick<
  PromotionGateResult,
  'blockingLocalFindingKeys' | 'unresolvedCategoryLabels' | 'criticalManualReviewFlagCodes'
> {
  const analysisResult = input.analysisResult || {}
  const blockingLocalFindingKeys: string[] = Array.from(new Set<string>(
    (analysisResult.localStandards?.findings || [])
      .filter((finding: any) => Boolean(finding?.blocking))
      .map((finding: any) => String(finding.key))
      .filter((key: string) => !NON_BLOCKING_PROMOTION_LOCAL_FINDING_KEYS.has(key)),
  ))

  const unresolvedCategoryLabels: string[] = Array.from(new Set<string>(
    (analysisResult.categories || [])
      .filter((category: any) => typeof category?.score === 'number' && category.score < 100)
      .map((category: any) => String(category.label))
      .filter((label: string) => !NON_BLOCKING_PROMOTION_CATEGORY_LABELS.has(label)),
  ))

  const criticalManualReviewFlagCodes: string[] = Array.from(new Set<string>([
    ...((input.manualReviewFlags || [])
      .filter(flag => flag?.severity === 'critical')
      .map(flag => String(flag.code))),
    ...((input.criticalManualReviewFlagCodes || []).map(code => String(code))),
  ]))

  return { blockingLocalFindingKeys, unresolvedCategoryLabels, criticalManualReviewFlagCodes }
}

export function evaluatePromotionGate(
  input: {
    analysisResult: any
    manualReviewFlags?: ManualReviewFlagLike[] | null
    criticalManualReviewFlagCodes?: string[] | null
  },
  options?: EvaluatePromotionGateOptions,
): PromotionGateResult {
  const analysisResult = input.analysisResult || {}
  const { blockingLocalFindingKeys, unresolvedCategoryLabels, criticalManualReviewFlagCodes }
    = collectPromotionDiagnostics(input)

  if (options?.minOverallScore != null && Number.isFinite(options.minOverallScore)) {
    const min = Number(options.minOverallScore)
    const reasons: string[] = []
    if (analysisResult.isScanned) reasons.push('Document still appears scanned/image-only.')
    const score = typeof analysisResult.overallScore === 'number' ? analysisResult.overallScore : NaN
    if (!Number.isFinite(score) || score < min) {
      reasons.push(
        `Final overall score is ${analysisResult.overallScore ?? 'unknown'}, below relaxed threshold ${min}.`,
      )
    }
    if (criticalManualReviewFlagCodes.length) {
      reasons.push(`Critical manual review flags remain: ${criticalManualReviewFlagCodes.join(', ')}`)
    }
    return {
      passed: reasons.length === 0,
      reasons,
      blockingLocalFindingKeys,
      unresolvedCategoryLabels,
      criticalManualReviewFlagCodes,
    }
  }

  // Grade A shortcut: a PDF that has achieved grade A, score 100, zero blocking local
  // findings, and no critical manual review flags passes the gate even if a sub-category
  // heuristic (e.g. Reading Order) reports < 100.  Category sub-scores are secondary
  // signals and should not override a confirmed Grade A.
  const gradeAShortcut =
    !analysisResult.isScanned &&
    analysisResult.grade === 'A' &&
    analysisResult.overallScore === 100 &&
    blockingLocalFindingKeys.length === 0 &&
    criticalManualReviewFlagCodes.length === 0

  const reasons: string[] = []
  if (analysisResult.isScanned) reasons.push('Document still appears scanned/image-only.')
  if (analysisResult.grade !== 'A') reasons.push(`Final grade is ${analysisResult.grade ?? 'unknown'}, not A.`)
  if (analysisResult.overallScore !== 100) reasons.push(`Final overall score is ${analysisResult.overallScore ?? 'unknown'}, not 100.`)
  if (blockingLocalFindingKeys.length) reasons.push(`Blocking local standards findings remain: ${blockingLocalFindingKeys.join(', ')}`)
  if (criticalManualReviewFlagCodes.length) reasons.push(`Critical manual review flags remain: ${criticalManualReviewFlagCodes.join(', ')}`)
  if (!gradeAShortcut && unresolvedCategoryLabels.length) reasons.push(`Categories still below 100: ${unresolvedCategoryLabels.join(', ')}`)

  return {
    passed: reasons.length === 0,
    reasons,
    blockingLocalFindingKeys,
    unresolvedCategoryLabels,
    criticalManualReviewFlagCodes,
  }
}
