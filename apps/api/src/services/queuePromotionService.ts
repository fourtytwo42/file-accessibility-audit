import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeWithQpdf } from './qpdfService.js'
import {
  compareRenderedPageImages,
  copyPassingOutputToComplete,
  defaultOrchestratorConfig,
  renderPdfPage1ToPng,
  type BookmarkValidationResult,
  type FailurePacket,
  type QueueFailureModeSummary,
  type ValidationResult,
  validateBookmarkTitles,
} from './remediationOrchestrator.js'
import type { PlannerResidualFamilySummary } from './documentModel.js'
import {
  getQueueItemById,
  nowIso,
  queueItemReviewAssetsDir,
  serializeQueueItemDetail,
  type QueueItemRecord,
  type QueueResultFreshness,
  updateQueueItem,
} from './queueStore.js'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(moduleDir, '..', '..')

export interface QueuePromotionValidationResult extends ValidationResult {
  freshnessPassed: boolean
  queueStateEligible: boolean
  promotionEligible: boolean
  resultFreshness: QueueResultFreshness
  queueState: QueueItemRecord['state']
  reasons: string[]
}

export interface QueuePromotionArtifacts {
  reviewAssetsDir: string
  rebuiltPdfPath: string
  originalPdfPath: string
  originalPage1PngPath: string
  remediatedPage1PngPath: string
  visualComparisonJsonPath: string
  failurePacketJsonPath: string
}

function currentVeraPdfStatus(detail: ReturnType<typeof serializeQueueItemDetail>): { status: string | null; failedChecks: number | null } {
  return {
    status: detail.standardsDetail?.veraPdf?.current?.status ?? detail.result?.verapdf?.status ?? null,
    failedChecks: detail.standardsDetail?.veraPdf?.current?.failedChecks ?? detail.result?.verapdf?.failedChecks ?? null,
  }
}

function currentBlockingFailureModes(detail: ReturnType<typeof serializeQueueItemDetail>): QueueFailureModeSummary[] {
  return (detail.standardsDetail?.failureModes || []).filter(mode => mode.blocking)
}

function currentBlockingResidualFamilies(detail: ReturnType<typeof serializeQueueItemDetail>): PlannerResidualFamilySummary[] {
  return (detail.standardsDetail?.plannerEvidence?.topResidualFamilySummaries || []).filter(family => family.blocking)
}

function hasCriticalManualReviewFlags(detail: ReturnType<typeof serializeQueueItemDetail>): boolean {
  return (detail.manualReviewFlags || []).some(flag => flag.severity === 'critical')
}

function buildValidationArtifactPaths(row: QueueItemRecord): QueuePromotionArtifacts {
  const reviewAssetsDir = row.review_assets_dir || queueItemReviewAssetsDir(row.id)
  return {
    reviewAssetsDir,
    rebuiltPdfPath: row.rebuilt_storage_path || row.remediated_storage_path || '',
    originalPdfPath: row.original_storage_path || row.storage_path || '',
    originalPage1PngPath: path.join(reviewAssetsDir, 'validation-original-page-1.png'),
    remediatedPage1PngPath: path.join(reviewAssetsDir, 'validation-remediated-page-1.png'),
    visualComparisonJsonPath: path.join(reviewAssetsDir, 'validation-visual-compare.json'),
    failurePacketJsonPath: path.join(reviewAssetsDir, 'validation-failure-packet.json'),
  }
}

export async function validateQueueItemForComplete(rowOrId: QueueItemRecord | string): Promise<{
  validation: QueuePromotionValidationResult
  artifacts: QueuePromotionArtifacts
  failurePacket: FailurePacket | null
}> {
  const row = typeof rowOrId === 'string' ? getQueueItemById(rowOrId) : rowOrId
  if (!row) throw new Error('Queue item not found')

  const config = defaultOrchestratorConfig(projectRoot)
  const artifacts = buildValidationArtifactPaths(row)
  await fs.promises.mkdir(artifacts.reviewAssetsDir, { recursive: true })

  const detail = serializeQueueItemDetail(row)
  const reasons: string[] = []
  const queueStateEligible = row.state === 'complete'
  const freshnessPassed = (row.result_freshness || 'fresh') === 'fresh'

  if (!artifacts.originalPdfPath || !fs.existsSync(artifacts.originalPdfPath)) {
    reasons.push('Original PDF artifact is missing.')
  }
  if (!artifacts.rebuiltPdfPath || !fs.existsSync(artifacts.rebuiltPdfPath)) {
    reasons.push('Remediated PDF artifact is missing.')
  }
  if (!queueStateEligible) reasons.push(`Queue item state ${row.state} is not eligible for promotion.`)
  if (!freshnessPassed) reasons.push(`Queue item result freshness is ${row.result_freshness || 'fresh'}.`)

  let visualComparison = {
    passed: false,
    reason: reasons[0] || 'Validation prerequisites not met.',
    originalWidth: 0,
    originalHeight: 0,
    remediatedWidth: 0,
    remediatedHeight: 0,
    sameDimensions: false,
    changedPixelRatio: 1,
    meanChannelDelta: 255,
    originalNonWhiteRatio: 0,
    remediatedNonWhiteRatio: 0,
    originalBlank: false,
    remediatedBlank: false,
  }
  let bookmarkValidation: BookmarkValidationResult = {
    passed: false,
    usedAiCleanup: false,
    reason: 'Validation prerequisites not met.',
    titles: [],
    flaggedTitles: [],
  }
  let failurePacket: FailurePacket | null = null

  const veraPdf = currentVeraPdfStatus(detail)
  const blockingFailureModes = currentBlockingFailureModes(detail)
  const blockingResidualFamilies = currentBlockingResidualFamilies(detail)
  const criticalManualReviewClear = !hasCriticalManualReviewFlags(detail)
  const scorePassed = (detail.overallScore || 0) >= config.targetScore
  const gradePassed = detail.grade === 'A'
  const veraPdfPassed = veraPdf.status !== 'failed'
  const blockingFailureModesClear = blockingFailureModes.length === 0
  const blockingResidualFamiliesClear = blockingResidualFamilies.length === 0

  if (reasons.length === 0) {
    const originalBuffer = await fs.promises.readFile(artifacts.originalPdfPath)
    const rebuiltBuffer = await fs.promises.readFile(artifacts.rebuiltPdfPath)
    const originalPage1 = await renderPdfPage1ToPng(originalBuffer, config.page1RenderScale)
    const rebuiltPage1 = await renderPdfPage1ToPng(rebuiltBuffer, config.page1RenderScale)
    await fs.promises.writeFile(artifacts.originalPage1PngPath, originalPage1)
    await fs.promises.writeFile(artifacts.remediatedPage1PngPath, rebuiltPage1)
    visualComparison = await compareRenderedPageImages(originalPage1, rebuiltPage1, config.page1DiffThreshold)
    await fs.promises.writeFile(artifacts.visualComparisonJsonPath, JSON.stringify(visualComparison, null, 2), 'utf8')

    const qpdf = await analyzeWithQpdf(rebuiltBuffer)
    bookmarkValidation = validateBookmarkTitles(qpdf.outlineTitles || [], detail)
  }

  const promotionEligible = queueStateEligible
    && freshnessPassed
    && scorePassed
    && gradePassed
    && veraPdfPassed
    && blockingFailureModesClear
    && blockingResidualFamiliesClear
    && criticalManualReviewClear
    && visualComparison.passed

  const validation: QueuePromotionValidationResult = {
    passed: promotionEligible,
    scorePassed,
    gradePassed,
    veraPdfPassed,
    blockingFailureModesClear,
    blockingResidualFamiliesClear,
    criticalManualReviewClear,
    visualComparison,
    bookmarkValidation,
    freshnessPassed,
    queueStateEligible,
    promotionEligible,
    resultFreshness: (row.result_freshness || 'fresh') as QueueResultFreshness,
    queueState: row.state,
    reasons,
  }

  if (!promotionEligible) {
    failurePacket = {
      filename: row.filename,
      queueItemId: row.id,
      latestAttemptPath: artifacts.rebuiltPdfPath || null,
      latestQueueSummary: {
        score: detail.overallScore,
        grade: detail.grade,
        verapdfStatus: veraPdf.status,
        failedChecks: veraPdf.failedChecks,
      },
      topFailureModes: (detail.standardsDetail?.failureModes || []).slice(0, 8),
      topBlockingResidualFamilyIds: detail.standardsDetail?.plannerEvidence?.topBlockingResidualFamilyIds || [],
      topResidualFamilies: detail.standardsDetail?.plannerEvidence?.topResidualFamilySummaries || [],
      semanticSidecarState: (detail.manualReviewFlags || []).some(flag => flag.code === 'semantic_sidecar_unavailable')
        ? 'semantic_sidecar_unavailable'
        : (detail.manualReviewFlags || []).length
          ? 'not_flagged'
          : 'unknown',
      visualComparison,
      bookmarkValidation,
      freshPostRestartRemediation: freshnessPassed,
      generatedAt: nowIso(),
    }
    await fs.promises.writeFile(artifacts.failurePacketJsonPath, JSON.stringify(failurePacket, null, 2), 'utf8')
  }

  updateQueueItem(row.id, {
    promotion_status: promotionEligible ? 'eligible' : 'rejected',
    promotion_rejection_reason: promotionEligible
      ? null
      : reasons[0]
        || failurePacket?.topFailureModes[0]?.label
        || failurePacket?.topResidualFamilies?.[0]?.label
        || 'Queue item did not meet complete promotion gates.',
  })

  return {
    validation,
    artifacts,
    failurePacket,
  }
}

export async function promoteQueueItemToComplete(rowOrId: QueueItemRecord | string): Promise<{
  destinationPath: string
  validation: QueuePromotionValidationResult
  artifacts: QueuePromotionArtifacts
}> {
  const row = typeof rowOrId === 'string' ? getQueueItemById(rowOrId) : rowOrId
  if (!row) throw new Error('Queue item not found')

  const config = defaultOrchestratorConfig(projectRoot)
  const { validation, artifacts } = await validateQueueItemForComplete(row)
  if (!validation.promotionEligible) {
    throw new Error(validation.reasons[0] || 'Queue item is not eligible for promotion.')
  }

  const destinationPath = await copyPassingOutputToComplete(artifacts.rebuiltPdfPath, config.completeDir, row.filename)
  updateQueueItem(row.id, {
    promotion_status: 'promoted',
    promotion_rejection_reason: null,
  })

  return {
    destinationPath,
    validation,
    artifacts,
  }
}
