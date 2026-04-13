import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { analyzePDF } from '../apps/api/src/services/pdfAnalyzer.ts'
import { createVerifiedPromotionLedgerRow } from '../apps/api/src/services/promotionLedger.ts'
import { evaluatePromotionGate } from '../apps/api/src/services/promotionGate.ts'

type ReadyRow = {
  publicationId: string
  publicationTitle: string | null
  fileUrl: string | null
  serverHost: string | null
  remotePath: string | null
  stagedReplacementPath: string | null
  localFinalArtifactPath: string | null
  criticalManualReviewFlagCodes: string[]
  sourceKind: 'complete_seed' | 'batch_ready' | 'already_replaced_remote'
  sourceManifest: string
  sourceStatus: string
  visualApproval: {
    required: boolean
    status: 'required' | 'approved'
    reasonCodes: string[]
    sourceManifest: string | null
    notes: string[]
  }
}

type VerificationTarget = {
  key: string
  mode: 'local_staged' | 'remote_live'
  sourcePathOrUrl: string
  filename: string
  criticalManualReviewFlagCodes: string[]
  visualApprovalRequired: boolean
  visualApprovalReasonCodes: string[]
}

type VerificationResult = {
  key: string
  mode: 'local_staged' | 'remote_live'
  sourcePathOrUrl: string
  filename: string
  verifiedAt: string
  durationMs: number
  passed: boolean
  missing: boolean
  error: string | null
  summary: {
    overallScore: number | null
    grade: string | null
    pageCount: number | null
    isScanned: boolean | null
  }
  gate: {
    reasons: string[]
    blockingLocalFindingKeys: string[]
    unresolvedCategoryLabels: string[]
    criticalManualReviewFlagCodes: string[]
  }
  visualApproval: {
    required: boolean
    approved: boolean
    reasonCodes: string[]
  }
  artifacts: {
    reportPath: string
  }
}

type PublicationVerificationRow = ReadyRow & {
  verificationKey: string
  verificationPassed: boolean
  verificationMissing: boolean
  verificationError: string | null
}

type VisualApprovalHoldManifest = {
  generatedAt?: string
  rows?: Array<{
    publicationId?: string | number | null
    status?: string | null
    reasonCodes?: string[] | null
    notes?: string[] | null
  }>
}

type PromotionLedgerManifest = {
  generatedAt: string
  summary: {
    verifiedPassRows: number
    byPromotionStatus: Record<string, number>
  }
  rows: Array<ReturnType<typeof createVerifiedPromotionLedgerRow> extends infer T ? Exclude<T, null> : never>
}

const repoRoot = '/home/hendo420/pdfaf'
const icjiaRoot = path.join(repoRoot, 'ICJIA-PDFs')
const manifestsRoot = path.join(icjiaRoot, 'manifests')
const reportsRoot = path.join(icjiaRoot, 'reports', 'test-runs', 'ready-verification')
const verificationManifestPath = path.join(manifestsRoot, 'ready-to-replace-verification.json')
const verificationSummaryPath = path.join(manifestsRoot, 'ready-to-replace-verification.summary.json')
const promotionLedgerPath = path.join(manifestsRoot, 'verified-promotion-ledger.json')
const promotionLedgerSummaryPath = path.join(manifestsRoot, 'verified-promotion-ledger.summary.json')
const visualApprovalHoldPath = path.join(manifestsRoot, 'visual-approval-holds.json')

const concurrency = Number(process.env.ICJIA_VERIFY_CONCURRENCY || 8)
export const DEFAULT_VERIFY_MIN_PASS_SCORE = 90
const includePublicationIds = new Set(
  String(process.env.ICJIA_VERIFY_INCLUDE_PUBLICATION_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
)

function parseOptionalThreshold(envKey: string, fallback: number | null = null): number | null {
  const raw = process.env[envKey]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

const verificationMinPassOverallScore = parseOptionalThreshold('ICJIA_VERIFY_MIN_PASS_SCORE', DEFAULT_VERIFY_MIN_PASS_SCORE)

export function getVerificationScorePolicy(): { minPassOverallScore: number | null } {
  return {
    minPassOverallScore: verificationMinPassOverallScore,
  }
}

export function evaluateVerificationGate(input: {
  analysisResult: any
  criticalManualReviewFlagCodes?: string[] | null
}) {
  return verificationMinPassOverallScore != null
    ? evaluatePromotionGate(input, { minOverallScore: verificationMinPassOverallScore })
    : evaluatePromotionGate(input)
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  return readJson<T>(filePath)
}

function safeStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'item'
}

function defaultVisualApproval(): ReadyRow['visualApproval'] {
  return {
    required: false,
    status: 'approved',
    reasonCodes: [],
    sourceManifest: null,
    notes: [],
  }
}

function loadVisualApprovalHoldMap(): Map<string, ReadyRow['visualApproval']> {
  const doc = readJsonIfExists<VisualApprovalHoldManifest>(visualApprovalHoldPath)
  const holds = new Map<string, ReadyRow['visualApproval']>()
  for (const row of doc?.rows || []) {
    if (row?.publicationId == null) continue
    const publicationId = String(row.publicationId)
    const status = row.status === 'approved' ? 'approved' : 'required'
    holds.set(publicationId, {
      required: status !== 'approved',
      status,
      reasonCodes: Array.isArray(row.reasonCodes) ? row.reasonCodes.map(String) : [],
      sourceManifest: visualApprovalHoldPath,
      notes: Array.isArray(row.notes) ? row.notes.map(String) : [],
    })
  }
  return holds
}

function loadReadyRows(): ReadyRow[] {
  const rows: ReadyRow[] = []
  const visualApprovalHolds = loadVisualApprovalHoldMap()

  const completeStatusPath = path.join(manifestsRoot, 'complete-passing-publication-status.json')
  const completeRows = readJson<Array<any>>(completeStatusPath)
  for (const row of completeRows) {
    if (!row?.publicationId) continue
    const publicationId = String(row.publicationId)
    const visualApproval = visualApprovalHolds.get(publicationId) || defaultVisualApproval()
    rows.push({
      publicationId,
      publicationTitle: row.publicationTitle ? String(row.publicationTitle) : null,
      fileUrl: row.fileUrl ? String(row.fileUrl) : null,
      serverHost: row.serverHost ? String(row.serverHost) : null,
      remotePath: row.remotePath ? String(row.remotePath) : null,
      stagedReplacementPath: row.stagedReplacementPath ? String(row.stagedReplacementPath) : null,
      localFinalArtifactPath: row.sourceCompleteFilePath ? String(row.sourceCompleteFilePath) : null,
      criticalManualReviewFlagCodes: Array.isArray(row.criticalManualReviewFlagCodes) ? row.criticalManualReviewFlagCodes.map(String) : [],
      sourceKind: row.status === 'replaced_on_remote' ? 'already_replaced_remote' : 'complete_seed',
      sourceManifest: completeStatusPath,
      sourceStatus: String(row.status || 'passing_from_complete'),
      visualApproval,
    })
  }

  for (const name of fs.readdirSync(manifestsRoot)) {
    if (!name.endsWith('-outcomes.json') && !name.endsWith('.outcomes.json')) continue
    const manifestPath = path.join(manifestsRoot, name)
    const doc = readJson<{ outcomes?: Array<any> }>(manifestPath)
    for (const outcome of doc.outcomes || []) {
      const outcomeStatus = String(outcome?.status || '')
      if (!(outcomeStatus === 'ready_to_replace' || outcomeStatus === 'remediated_pass_candidate' || outcomeStatus === 'manual_ready_to_replace') || !outcome.publicationId) continue
      const publicationId = String(outcome.publicationId)
      const visualApproval = visualApprovalHolds.get(publicationId) || defaultVisualApproval()
      rows.push({
        publicationId,
        publicationTitle: outcome.publicationTitle ? String(outcome.publicationTitle) : null,
        fileUrl: outcome.fileUrl ? String(outcome.fileUrl) : null,
        serverHost: outcome.serverHost ? String(outcome.serverHost) : null,
        remotePath: outcome.remotePath ? String(outcome.remotePath) : null,
        stagedReplacementPath: outcome.artifacts?.stagedReplacementPath ? String(outcome.artifacts.stagedReplacementPath) : (outcome.stagedReplacementPath ? String(outcome.stagedReplacementPath) : null),
        localFinalArtifactPath: outcome.artifacts?.remediatedPdfPath ? String(outcome.artifacts.remediatedPdfPath) : (outcome.outputPath ? String(outcome.outputPath) : null),
        criticalManualReviewFlagCodes: Array.isArray(outcome.gate?.criticalManualReviewFlagCodes) ? outcome.gate.criticalManualReviewFlagCodes.map(String) : [],
        sourceKind: 'batch_ready',
        sourceManifest: manifestPath,
        sourceStatus: outcomeStatus,
        visualApproval,
      })
    }
  }

  rows.sort((a, b) => a.publicationId.localeCompare(b.publicationId))
  if (!includePublicationIds.size) return rows
  return rows.filter(row => includePublicationIds.has(row.publicationId))
}

function buildTargets(rows: ReadyRow[]): Map<string, VerificationTarget> {
  const targets = new Map<string, VerificationTarget>()

  for (const row of rows) {
    if (row.sourceKind === 'already_replaced_remote' && row.fileUrl) {
      const key = `remote:${row.fileUrl}`
      if (!targets.has(key)) {
        targets.set(key, {
          key,
          mode: 'remote_live',
          sourcePathOrUrl: row.fileUrl,
          filename: path.basename(row.fileUrl),
          criticalManualReviewFlagCodes: [...row.criticalManualReviewFlagCodes],
          visualApprovalRequired: row.visualApproval.required,
          visualApprovalReasonCodes: [...row.visualApproval.reasonCodes],
        })
      } else {
        const existing = targets.get(key)!
        existing.criticalManualReviewFlagCodes = Array.from(new Set([
          ...existing.criticalManualReviewFlagCodes,
          ...row.criticalManualReviewFlagCodes,
        ]))
        existing.visualApprovalRequired = existing.visualApprovalRequired || row.visualApproval.required
        existing.visualApprovalReasonCodes = Array.from(new Set([
          ...existing.visualApprovalReasonCodes,
          ...row.visualApproval.reasonCodes,
        ]))
      }
      continue
    }

    if (!row.stagedReplacementPath) continue
    const key = `local:${row.stagedReplacementPath}`
    if (!targets.has(key)) {
      targets.set(key, {
        key,
        mode: 'local_staged',
        sourcePathOrUrl: row.stagedReplacementPath,
        filename: path.basename(row.stagedReplacementPath),
        criticalManualReviewFlagCodes: [...row.criticalManualReviewFlagCodes],
        visualApprovalRequired: row.visualApproval.required,
        visualApprovalReasonCodes: [...row.visualApproval.reasonCodes],
      })
    } else {
      const existing = targets.get(key)!
      existing.criticalManualReviewFlagCodes = Array.from(new Set([
        ...existing.criticalManualReviewFlagCodes,
        ...row.criticalManualReviewFlagCodes,
      ]))
      existing.visualApprovalRequired = existing.visualApprovalRequired || row.visualApproval.required
      existing.visualApprovalReasonCodes = Array.from(new Set([
        ...existing.visualApprovalReasonCodes,
        ...row.visualApproval.reasonCodes,
      ]))
    }
  }

  return targets
}

async function readTargetBuffer(target: VerificationTarget): Promise<Buffer> {
  if (target.mode === 'local_staged') {
    return fs.promises.readFile(target.sourcePathOrUrl)
  }

  const response = await fetch(target.sourcePathOrUrl)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${target.sourcePathOrUrl}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function checksumForSourcePathOrUrl(sourcePathOrUrl: string | null): Promise<string | null> {
  if (!sourcePathOrUrl) return null
  if (/^https?:\/\//i.test(sourcePathOrUrl)) {
    const response = await fetch(sourcePathOrUrl)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${sourcePathOrUrl}`)
    }
    return sha256Hex(Buffer.from(await response.arrayBuffer()))
  }
  return sha256Hex(await fs.promises.readFile(sourcePathOrUrl))
}

function reportPathForTarget(target: VerificationTarget): string {
  const modeDir = target.mode === 'local_staged' ? 'local-staged' : 'remote-live'
  return path.join(reportsRoot, modeDir, `${safeStem(target.filename)}.json`)
}

async function verifyTarget(target: VerificationTarget): Promise<VerificationResult> {
  const startedAt = Date.now()
  const reportPath = reportPathForTarget(target)

  try {
    const buffer = await readTargetBuffer(target)
    const result = await analyzePDF(buffer, target.filename, {
      analysisProfile: 'full_final',
      skipAdobe: true,
      skipVeraPdf: true,
    })

    const gate = evaluateVerificationGate({
      analysisResult: result,
      criticalManualReviewFlagCodes: target.criticalManualReviewFlagCodes,
    })
    const record: VerificationResult = {
      key: target.key,
      mode: target.mode,
      sourcePathOrUrl: target.sourcePathOrUrl,
      filename: target.filename,
      verifiedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      passed: gate.passed,
      missing: false,
      error: null,
      summary: {
        overallScore: result.overallScore,
        grade: result.grade,
        pageCount: result.pageCount,
        isScanned: result.isScanned,
      },
      gate: {
        reasons: gate.reasons,
        blockingLocalFindingKeys: gate.blockingLocalFindingKeys,
        unresolvedCategoryLabels: gate.unresolvedCategoryLabels,
        criticalManualReviewFlagCodes: gate.criticalManualReviewFlagCodes,
      },
      visualApproval: {
        required: target.visualApprovalRequired,
        approved: !target.visualApprovalRequired,
        reasonCodes: [...target.visualApprovalReasonCodes],
      },
      artifacts: {
        reportPath,
      },
    }

    writeJson(reportPath, {
      target,
      result: {
        overallScore: result.overallScore,
        grade: result.grade,
        pageCount: result.pageCount,
        isScanned: result.isScanned,
        executiveSummary: result.executiveSummary,
        localStandards: result.localStandards,
        categories: result.categories,
      },
      gate,
      visualApproval: record.visualApproval,
      verifiedAt: record.verifiedAt,
      durationMs: record.durationMs,
    })

    return record
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    const missing = /ENOENT|HTTP 404/.test(message)
    const record: VerificationResult = {
      key: target.key,
      mode: target.mode,
      sourcePathOrUrl: target.sourcePathOrUrl,
      filename: target.filename,
      verifiedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      passed: false,
      missing,
      error: message,
      summary: {
        overallScore: null,
        grade: null,
        pageCount: null,
        isScanned: null,
      },
      gate: {
        reasons: [message],
        blockingLocalFindingKeys: [],
        unresolvedCategoryLabels: [],
        criticalManualReviewFlagCodes: [],
      },
      visualApproval: {
        required: target.visualApprovalRequired,
        approved: !target.visualApprovalRequired,
        reasonCodes: [...target.visualApprovalReasonCodes],
      },
      artifacts: {
        reportPath,
      },
    }
    writeJson(reportPath, { target, error: message, verifiedAt: record.verifiedAt, durationMs: record.durationMs })
    return record
  }
}

async function main(): Promise<void> {
  ensureDir(reportsRoot)

  const rows = loadReadyRows()
  const targets = Array.from(buildTargets(rows).values())
  const targetResults = new Map<string, VerificationResult>()
  let index = 0

  async function worker(): Promise<void> {
    while (index < targets.length) {
      const target = targets[index++]
      console.log(`[ready-verification] starting ${index}/${targets.length} ${target.sourcePathOrUrl}`)
      const result = await verifyTarget(target)
      targetResults.set(target.key, result)
      console.log(`[ready-verification] finished passed=${result.passed} missing=${result.missing} ${target.sourcePathOrUrl}`)
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))

  const publicationRows: PublicationVerificationRow[] = rows.map(row => {
    const verificationKey = row.sourceKind === 'already_replaced_remote' && row.fileUrl
      ? `remote:${row.fileUrl}`
      : `local:${row.stagedReplacementPath}`
    const result = targetResults.get(verificationKey)
    return {
      ...row,
      verificationKey,
      verificationPassed: Boolean(result?.passed) && !row.visualApproval.required,
      verificationMissing: Boolean(result?.missing),
      verificationError: result?.error ?? null,
    }
  })

  const verificationResults = Array.from(targetResults.values())
  const sourceChecksumCache = new Map<string, string | null>()
  const replacementChecksumCache = new Map<string, string | null>()

  const promotionLedgerRows = []
  for (const row of publicationRows) {
    if (!row.verificationPassed || !row.stagedReplacementPath) continue
    const verification = targetResults.get(row.verificationKey)
    if (!verification) continue

    const sourceChecksumKey = row.fileUrl || ''
    let currentSourceChecksumSha256: string | null = null
    if (sourceChecksumKey) {
      if (!sourceChecksumCache.has(sourceChecksumKey)) {
        sourceChecksumCache.set(sourceChecksumKey, await checksumForSourcePathOrUrl(row.fileUrl))
      }
      currentSourceChecksumSha256 = sourceChecksumCache.get(sourceChecksumKey) ?? null
    }

    const replacementChecksumKey = row.stagedReplacementPath
    if (!replacementChecksumCache.has(replacementChecksumKey)) {
      replacementChecksumCache.set(replacementChecksumKey, await checksumForSourcePathOrUrl(replacementChecksumKey))
    }
    const replacementChecksumSha256 = replacementChecksumCache.get(replacementChecksumKey) ?? null

    const ledgerRow = createVerifiedPromotionLedgerRow({
      publicationId: row.publicationId,
      publicationTitle: row.publicationTitle,
      sourceKind: row.sourceKind,
      sourcePathOrUrl: row.remotePath || row.fileUrl,
      sourceFileUrl: row.fileUrl,
      localFinalArtifactPath: row.localFinalArtifactPath,
      stagedReplacementPath: row.stagedReplacementPath,
      currentSourceChecksumSha256,
      replacementChecksumSha256,
      verificationReportPath: verification.artifacts.reportPath,
      verificationTimestamp: verification.verifiedAt,
      verificationSummary: {
        passed: verification.passed,
        overallScore: verification.summary.overallScore,
        grade: verification.summary.grade,
        pageCount: verification.summary.pageCount,
        isScanned: verification.summary.isScanned,
        reasons: verification.gate.reasons,
        blockingLocalFindingKeys: verification.gate.blockingLocalFindingKeys,
        unresolvedCategoryLabels: verification.gate.unresolvedCategoryLabels,
        criticalManualReviewFlagCodes: verification.gate.criticalManualReviewFlagCodes,
      },
    })
    if (ledgerRow) promotionLedgerRows.push(ledgerRow)
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    scorePolicy: getVerificationScorePolicy(),
    totals: {
      publicationRows: publicationRows.length,
      uniqueTargets: verificationResults.length,
      passedTargets: verificationResults.filter(result => result.passed).length,
      failedTargets: verificationResults.filter(result => !result.passed && !result.missing && !result.error).length,
      erroredTargets: verificationResults.filter(result => Boolean(result.error) && !result.missing).length,
      missingTargets: verificationResults.filter(result => result.missing).length,
      passedPublicationRows: publicationRows.filter(row => row.verificationPassed).length,
      failedPublicationRows: publicationRows.filter(row => !row.verificationPassed && !row.verificationMissing && !row.verificationError).length,
      erroredPublicationRows: publicationRows.filter(row => Boolean(row.verificationError) && !row.verificationMissing).length,
      missingPublicationRows: publicationRows.filter(row => row.verificationMissing).length,
      verifiedPromotionLedgerRows: promotionLedgerRows.length,
      visualApprovalHeldPublicationRows: publicationRows.filter(row => row.visualApproval.required).length,
    },
    latestVerifiedTarget: verificationResults.at(-1) || null,
    promotionLedgerPath,
  }

  const mergedVerificationResults = (() => {
    if (!includePublicationIds.size) return verificationResults
    const existing = readJsonIfExists<{
      verificationResults?: VerificationResult[]
    }>(verificationManifestPath)
    const merged = new Map<string, VerificationResult>()
    for (const result of existing?.verificationResults || []) merged.set(result.key, result)
    for (const result of verificationResults) merged.set(result.key, result)
    return Array.from(merged.values()).sort((a, b) => a.key.localeCompare(b.key))
  })()

  const mergedPublicationRows = (() => {
    if (!includePublicationIds.size) return publicationRows
    const existing = readJsonIfExists<{
      publicationRows?: PublicationVerificationRow[]
    }>(verificationManifestPath)
    const merged = new Map<string, PublicationVerificationRow>()
    for (const row of existing?.publicationRows || []) merged.set(row.publicationId, row)
    for (const row of publicationRows) merged.set(row.publicationId, row)
    return Array.from(merged.values())
      .map(row => ({
        ...row,
        visualApproval: row.visualApproval || defaultVisualApproval(),
      }))
      .sort((a, b) => a.publicationId.localeCompare(b.publicationId))
  })()

  const mergedPromotionLedgerRows = (() => {
    if (!includePublicationIds.size) return promotionLedgerRows
    const existing = readJsonIfExists<PromotionLedgerManifest>(promotionLedgerPath)
    const merged = new Map<string, PromotionLedgerManifest['rows'][number]>()
    for (const row of existing?.rows || []) merged.set(row.publicationId, row)
    for (const row of promotionLedgerRows) merged.set(row.publicationId, row)
    return Array.from(merged.values()).sort((a, b) => a.publicationId.localeCompare(b.publicationId))
  })()

  const mergedSummary = {
    ...summary,
    totals: {
      publicationRows: mergedPublicationRows.length,
      uniqueTargets: mergedVerificationResults.length,
      passedTargets: mergedVerificationResults.filter(result => result.passed).length,
      failedTargets: mergedVerificationResults.filter(result => !result.passed && !result.missing && !result.error).length,
      erroredTargets: mergedVerificationResults.filter(result => Boolean(result.error) && !result.missing).length,
      missingTargets: mergedVerificationResults.filter(result => result.missing).length,
      passedPublicationRows: mergedPublicationRows.filter(row => row.verificationPassed).length,
      failedPublicationRows: mergedPublicationRows.filter(row => !row.verificationPassed && !row.verificationMissing && !row.verificationError).length,
      erroredPublicationRows: mergedPublicationRows.filter(row => Boolean(row.verificationError) && !row.verificationMissing).length,
      missingPublicationRows: mergedPublicationRows.filter(row => row.verificationMissing).length,
      verifiedPromotionLedgerRows: mergedPromotionLedgerRows.length,
      visualApprovalHeldPublicationRows: mergedPublicationRows.filter(row => row.visualApproval?.required).length,
    },
    latestVerifiedTarget: verificationResults.at(-1) || summary.latestVerifiedTarget,
  }

  writeJson(verificationManifestPath, {
    generatedAt: mergedSummary.generatedAt,
    scorePolicy: mergedSummary.scorePolicy,
    summary: mergedSummary.totals,
    verificationResults: mergedVerificationResults,
    publicationRows: mergedPublicationRows,
  })
  writeJson(verificationSummaryPath, mergedSummary)
  const promotionLedgerManifest: PromotionLedgerManifest = {
    generatedAt: mergedSummary.generatedAt,
    summary: {
      verifiedPassRows: mergedPromotionLedgerRows.length,
      byPromotionStatus: mergedPromotionLedgerRows.reduce<Record<string, number>>((acc, row) => {
        acc[row.promotionStatus] = (acc[row.promotionStatus] || 0) + 1
        return acc
      }, {}),
    },
    rows: mergedPromotionLedgerRows,
  }
  writeJson(promotionLedgerPath, promotionLedgerManifest)
  writeJson(promotionLedgerSummaryPath, {
    generatedAt: promotionLedgerManifest.generatedAt,
    scorePolicy: mergedSummary.scorePolicy,
    summary: promotionLedgerManifest.summary,
    latestVerifiedPromotion: mergedPromotionLedgerRows.at(-1) || null,
  })

  console.log(JSON.stringify(mergedSummary, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
