import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { analyzePDF } from '../apps/api/src/services/pdfAnalyzer.ts'
import { remediatePdfWithAgent } from '../apps/api/src/services/agentRemediationService.ts'
import { evaluatePromotionGate } from '../apps/api/src/services/promotionGate.ts'
import type { PromotionLifecycleStatus } from '../apps/api/src/services/promotionLedger.ts'

type PriorityCandidate = {
  priorityRank: number
  passLikelihoodScore: number
  priorityTier: 'highest' | 'high' | 'medium'
  recommendedAction: 'fix_first'
  publicationId: string | null
  publicationTitle: string | null
  serverHost: string | null
  remotePath: string | null
  localCachePath: string | null
  fileUrl: string | null
  storageKind: string | null
  overallScore: number
  grade: string
  pageCount: number
  isScanned: boolean
  blockerFamilyCount: number
  blockingFindingCount: number
  manualOnlyFailureModeCount: number
  autoRunnableOpportunityCount: number
  topBlockingResidualFamilyIds: string[]
  blockingFindingKeys: string[]
  autoRunnableOpportunityKeys: string[]
  manualOnlyFailureModeKeys: string[]
  heuristicReasons: string[]
  reportPath: string
}

type PriorityManifest = {
  generatedAt: string
  sourceReportRoot: string
  totals: {
    scannedReportsConsidered: number
    selectedCandidates: number
    byTier: Record<string, number>
  }
  candidates: PriorityCandidate[]
}

type OutcomeRecord = {
  publicationId: string | null
  publicationTitle: string | null
  priorityRank: number
  priorityTier: 'highest' | 'high' | 'medium'
  passLikelihoodScore: number
  serverHost: string | null
  remotePath: string | null
  localCachePath: string | null
  fileUrl: string | null
  storageKind: string | null
  originalReportPath: string
  status: 'remediated_pass_candidate' | 'ready_to_replace' | 'failed_after_remediation' | 'source_missing' | 'processing_error'
  promotionStatus: PromotionLifecycleStatus | null
  processedAt: string
  durationMs: number
  original: {
    overallScore: number
    grade: string
    pageCount: number
    isScanned: boolean
  } | null
  final: {
    overallScore: number
    grade: string
    pageCount: number
    isScanned: boolean
  } | null
  gate: {
    passed: boolean
    reasons: string[]
    blockingLocalFindingKeys: string[]
    criticalManualReviewFlagCodes: string[]
    unresolvedCategoryLabels: string[]
  }
  artifacts: {
    remediatedPdfPath: string | null
    stagedReplacementPath: string | null
    detailedReportPath: string | null
    failureReportPath: string | null
  }
  checksums?: {
    gateEvaluatedBufferSha256: string | null
    remediatedPdfSha256: string | null
    stagedReplacementSha256: string | null
  }
  deferred?: {
    reasonCode: string
    skipNextBatch: boolean
    notes: string
  }
}

type OutcomesManifest = {
  generatedAt: string
  sourcePriorityManifestPath: string
  concurrency: number
  totals: {
    targetCandidates: number
    processed: number
    readyToReplace: number
    remediatedPassCandidates?: number
    failedAfterRemediation: number
    sourceMissing: number
    processingError: number
    remaining: number
  }
  outcomes: OutcomeRecord[]
}

const repoRoot = '/home/hendo420/pdfaf'
const icjiaRoot = path.join(repoRoot, 'ICJIA-PDFs')
const priorityManifestPath = process.env.ICJIA_PRIORITY_MANIFEST_PATH || path.join(icjiaRoot, 'manifests', 'remediation-priority-candidates.json')
const outcomesManifestPath = process.env.ICJIA_REMEDIATION_OUTCOMES_PATH || path.join(icjiaRoot, 'manifests', 'remediation-batch-outcomes.json')
const outcomesSummaryPath = process.env.ICJIA_REMEDIATION_OUTCOMES_SUMMARY_PATH || outcomesManifestPath.replace(/\.json$/i, '.summary.json')
const detailedReportRoot = process.env.ICJIA_REMEDIATION_DETAILED_REPORT_ROOT || path.join(icjiaRoot, 'reports', 'test-runs', 'remediation-batch')
const failureReportRoot = process.env.ICJIA_REMEDIATION_FAILURE_REPORT_ROOT || path.join(icjiaRoot, 'reports', 'failures', 'remediation-batch')
const remediatedPdfRoot = process.env.ICJIA_REMEDIATION_REMEDIATED_PDF_ROOT || path.join(icjiaRoot, 'artifacts', 'remediated-pdfs', 'priority-batch')
const attemptsRoot = process.env.ICJIA_REMEDIATION_ATTEMPTS_ROOT || path.join(icjiaRoot, 'artifacts', 'remediation-attempts', 'priority-batch')
const stagingRoot = process.env.ICJIA_REMEDIATION_STAGING_ROOT || path.join(icjiaRoot, 'staging', 'to-replace')

const concurrency = Number(process.env.ICJIA_REMEDIATION_CONCURRENCY || 8)
const limit = Number(process.env.ICJIA_REMEDIATION_LIMIT || 0)
const timeoutMs = Number(process.env.ICJIA_REMEDIATION_TIMEOUT_MS || 60 * 60 * 1000)

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

function safeStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'item'
}

function relativeRemoteParts(serverHost: string | null, remotePath: string | null): string[] {
  if (!serverHost || !remotePath) return ['unknown']
  const roots: Record<string, string> = {
    '143.244.146.43': '/home/forge/archive.icjia-api.cloud/root/files',
    '192.241.146.85': '/home/forge/agency.icjia-api.cloud/agency-api/public/uploads',
    '157.230.3.215': '/home/forge/researchhub.icjia-api.cloud/researchhub/public/uploads',
  }
  const root = roots[serverHost]
  if (!root) return [safeStem(path.basename(remotePath))]
  const relative = path.posix.relative(root, remotePath)
  if (!relative || relative.startsWith('..')) return [safeStem(path.basename(remotePath))]
  return relative.split('/').filter(Boolean)
}

function stagePathFor(serverHost: string | null, remotePath: string | null): string {
  return path.join(stagingRoot, serverHost || 'unknown', ...relativeRemoteParts(serverHost, remotePath))
}

function reportPathFor(root: string, candidate: PriorityCandidate, suffix: string): string {
  const publicationPart = candidate.publicationId ? `${candidate.publicationId}-${safeStem(candidate.publicationTitle || '')}` : safeStem(path.basename(candidate.remotePath || candidate.reportPath))
  return path.join(root, candidate.serverHost || 'unknown', `${publicationPart}.${suffix}.json`)
}

function artifactPdfPathFor(candidate: PriorityCandidate): string {
  const publicationPart = candidate.publicationId ? `${candidate.publicationId}-${safeStem(candidate.publicationTitle || '')}` : safeStem(path.basename(candidate.remotePath || candidate.reportPath))
  return path.join(remediatedPdfRoot, candidate.serverHost || 'unknown', `${publicationPart}.pdf`)
}

function timeoutFailureRecord(
  candidate: PriorityCandidate,
  startedAt: number,
  originalResult: any,
  failureReportPath: string,
  options?: {
    reasonMessage?: string
    notes?: string
  },
): OutcomeRecord {
  const reasonMessage = options?.reasonMessage || `Processing exceeded the ${Math.round(timeoutMs / (60 * 1000))}-minute runtime limit.`
  const notes = options?.notes || `Processing exceeded ${timeoutMs}ms without producing a terminal outcome.`
  return {
    publicationId: candidate.publicationId,
    publicationTitle: candidate.publicationTitle,
    priorityRank: candidate.priorityRank,
    priorityTier: candidate.priorityTier,
    passLikelihoodScore: candidate.passLikelihoodScore,
    serverHost: candidate.serverHost,
    remotePath: candidate.remotePath,
    localCachePath: candidate.localCachePath,
    fileUrl: candidate.fileUrl,
    storageKind: candidate.storageKind,
    originalReportPath: candidate.reportPath,
    status: 'processing_error',
    processedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    original: {
      overallScore: originalResult.overallScore,
      grade: originalResult.grade,
      pageCount: originalResult.pageCount,
      isScanned: originalResult.isScanned,
    },
    final: null,
    gate: {
      passed: false,
      reasons: [
        reasonMessage,
        'Marked as excessive runtime and deferred so the batch can continue.',
      ],
      blockingLocalFindingKeys: [],
      criticalManualReviewFlagCodes: [],
      unresolvedCategoryLabels: [],
    },
    promotionStatus: null,
    artifacts: {
      remediatedPdfPath: null,
      stagedReplacementPath: null,
      detailedReportPath: null,
      failureReportPath,
    },
    checksums: {
      gateEvaluatedBufferSha256: null,
      remediatedPdfSha256: null,
      stagedReplacementSha256: null,
    },
    deferred: {
      reasonCode: 'excessive_runtime_loop',
      skipNextBatch: true,
      notes,
    },
  }
}

function excessiveRuntimeReasonFromMessage(message: string): {
  reasonMessage: string
  notes: string
} {
  const normalizedMessage = String(message || '').trim()
  const notes = normalizedMessage || `Processing exceeded ${timeoutMs}ms without producing a terminal outcome.`
  const budgetTupleMatch = /light=(\d+),\s*deep=(\d+),\s*total=(\d+)/i.exec(normalizedMessage)
  if (budgetTupleMatch) {
    const light = Number(budgetTupleMatch[1] || 0)
    const deep = Number(budgetTupleMatch[2] || 0)
    if (deep > 0 && light === 0) {
      return {
        reasonMessage: 'Processing hit the remediation inspection budget during deep ownership or figure analysis before reaching a stable passing result.',
        notes,
      }
    }
    if (light > 0 && deep > 0) {
      return {
        reasonMessage: 'Processing hit the remediation inspection budget after repeated ownership/structure verification without reaching a stable passing result.',
        notes,
      }
    }
    return {
      reasonMessage: 'Processing hit the remediation inspection budget before reaching a stable passing result.',
      notes,
    }
  }
  if (/inspection budget exceeded/i.test(normalizedMessage)) {
    if (/deep=\d+/i.test(normalizedMessage) && !/light=\d+/i.test(normalizedMessage)) {
      return {
        reasonMessage: 'Processing hit the remediation inspection budget during deep ownership or figure analysis before reaching a stable passing result.',
        notes,
      }
    }
    if (/light=\d+/i.test(normalizedMessage) && /deep=\d+/i.test(normalizedMessage)) {
      return {
        reasonMessage: 'Processing hit the remediation inspection budget after repeated ownership/structure verification without reaching a stable passing result.',
        notes,
      }
    }
    return {
      reasonMessage: 'Processing hit the remediation inspection budget before reaching a stable passing result.',
      notes,
    }
  }
  if (/inspect/i.test(normalizedMessage) || /structure/i.test(normalizedMessage)) {
    return {
      reasonMessage: 'Processing stopped after repeated structure inspection churn without reaching a stable passing result.',
      notes,
    }
  }
  return {
    reasonMessage: `Processing exceeded the ${Math.round(timeoutMs / (60 * 1000))}-minute runtime limit.`,
    notes,
  }
}

function attemptDirFor(candidate: PriorityCandidate): string {
  const publicationPart = candidate.publicationId ? `${candidate.publicationId}-${safeStem(candidate.publicationTitle || '')}` : safeStem(path.basename(candidate.remotePath || candidate.reportPath))
  return path.join(attemptsRoot, candidate.serverHost || 'unknown', publicationPart)
}

function loadOutcomes(): OutcomesManifest {
  if (!fs.existsSync(outcomesManifestPath)) {
    return {
      generatedAt: new Date().toISOString(),
      sourcePriorityManifestPath: priorityManifestPath,
      concurrency,
      totals: {
        targetCandidates: 0,
        processed: 0,
        readyToReplace: 0,
        failedAfterRemediation: 0,
        sourceMissing: 0,
        processingError: 0,
        remaining: 0,
      },
      outcomes: [],
    }
  }
  return readJson<OutcomesManifest>(outcomesManifestPath)
}

function normalizePriorityManifest(value: unknown): PriorityManifest {
  const doc = value as Record<string, unknown>
  const sourceCandidates = Array.isArray((doc as any).candidates)
    ? ((doc as any).candidates as Array<Record<string, unknown>>)
    : []

  const candidates: PriorityCandidate[] = sourceCandidates.map((candidate, index) => ({
    priorityRank: Number(candidate.priorityRank ?? candidate.nextWaveRank ?? index + 1),
    passLikelihoodScore: Number(candidate.passLikelihoodScore ?? 0),
    priorityTier: String(candidate.priorityTier ?? candidate.waveTier ?? 'medium') as 'highest' | 'high' | 'medium',
    recommendedAction: 'fix_first',
    publicationId: candidate.publicationId == null ? null : String(candidate.publicationId),
    publicationTitle: candidate.publicationTitle == null ? null : String(candidate.publicationTitle),
    serverHost: candidate.serverHost == null ? null : String(candidate.serverHost),
    remotePath: candidate.remotePath == null ? null : String(candidate.remotePath),
    localCachePath: candidate.localCachePath == null ? null : String(candidate.localCachePath),
    fileUrl: candidate.fileUrl == null ? null : String(candidate.fileUrl),
    storageKind: candidate.storageKind == null ? null : String(candidate.storageKind),
    overallScore: Number(candidate.overallScore ?? 0),
    grade: String(candidate.grade ?? ''),
    pageCount: Number(candidate.pageCount ?? 0),
    isScanned: Boolean(candidate.isScanned),
    blockerFamilyCount: Number(candidate.blockerFamilyCount ?? 0),
    blockingFindingCount: Number(candidate.blockingFindingCount ?? 0),
    manualOnlyFailureModeCount: Number(candidate.manualOnlyFailureModeCount ?? 0),
    autoRunnableOpportunityCount: Number(candidate.autoRunnableOpportunityCount ?? 0),
    topBlockingResidualFamilyIds: Array.isArray(candidate.topBlockingResidualFamilyIds) ? candidate.topBlockingResidualFamilyIds.map(String) : [],
    blockingFindingKeys: Array.isArray(candidate.blockingFindingKeys) ? candidate.blockingFindingKeys.map(String) : [],
    autoRunnableOpportunityKeys: Array.isArray(candidate.autoRunnableOpportunityKeys) ? candidate.autoRunnableOpportunityKeys.map(String) : [],
    manualOnlyFailureModeKeys: Array.isArray(candidate.manualOnlyFailureModeKeys) ? candidate.manualOnlyFailureModeKeys.map(String) : [],
    heuristicReasons: Array.isArray(candidate.heuristicReasons) ? candidate.heuristicReasons.map(String) : [],
    reportPath: String(candidate.reportPath ?? ''),
  }))

  return {
    generatedAt: String(doc.generatedAt ?? new Date().toISOString()),
    sourceReportRoot: String(doc.sourceReportRoot ?? (doc.basedOn as any)?.sourceReportRoot ?? ''),
    totals: {
      scannedReportsConsidered: Number((doc.totals as any)?.scannedReportsConsidered ?? (doc.totals as any)?.remainingPublicationRowsConsidered ?? candidates.length),
      selectedCandidates: Number((doc.totals as any)?.selectedCandidates ?? (doc.totals as any)?.shortlistedCandidates ?? candidates.length),
      byTier: (((doc.totals as any)?.byTier ?? {}) as Record<string, number>),
    },
    candidates,
  }
}

function saveOutcomes(manifest: OutcomesManifest, targetCandidates: number): void {
  const remediatedPassCandidates = manifest.outcomes.filter(entry => entry.status === 'remediated_pass_candidate' || entry.status === 'ready_to_replace').length
  const totals = {
    targetCandidates,
    processed: manifest.outcomes.length,
    readyToReplace: remediatedPassCandidates,
    remediatedPassCandidates,
    failedAfterRemediation: manifest.outcomes.filter(entry => entry.status === 'failed_after_remediation').length,
    sourceMissing: manifest.outcomes.filter(entry => entry.status === 'source_missing').length,
    processingError: manifest.outcomes.filter(entry => entry.status === 'processing_error').length,
    remaining: Math.max(0, targetCandidates - manifest.outcomes.length),
  }

  manifest.generatedAt = new Date().toISOString()
  manifest.concurrency = concurrency
  manifest.sourcePriorityManifestPath = priorityManifestPath
  manifest.totals = totals

  writeJson(outcomesManifestPath, manifest)
  writeJson(outcomesSummaryPath, {
    generatedAt: manifest.generatedAt,
    sourcePriorityManifestPath: manifest.sourcePriorityManifestPath,
    concurrency: manifest.concurrency,
    totals,
    latestProcessed: manifest.outcomes.at(-1) || null,
  })
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function sha256OfFile(filePath: string): Promise<string> {
  return sha256Hex(await fs.promises.readFile(filePath))
}

async function processCandidate(candidate: PriorityCandidate): Promise<OutcomeRecord> {
  const startedAt = Date.now()
  const detailedReportPath = reportPathFor(detailedReportRoot, candidate, 'remediation')
  const failureReportPath = reportPathFor(failureReportRoot, candidate, 'failure')
  const remediatedPdfPath = artifactPdfPathFor(candidate)
  const stagedReplacementPath = stagePathFor(candidate.serverHost, candidate.remotePath)

  if (!candidate.localCachePath || !fs.existsSync(candidate.localCachePath)) {
    const record: OutcomeRecord = {
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      priorityRank: candidate.priorityRank,
      priorityTier: candidate.priorityTier,
      passLikelihoodScore: candidate.passLikelihoodScore,
      serverHost: candidate.serverHost,
      remotePath: candidate.remotePath,
      localCachePath: candidate.localCachePath,
      fileUrl: candidate.fileUrl,
      storageKind: candidate.storageKind,
      originalReportPath: candidate.reportPath,
      status: 'source_missing',
      processedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      original: null,
      final: null,
      gate: {
        passed: false,
        reasons: ['Local cache source PDF is missing.'],
        blockingLocalFindingKeys: [],
        criticalManualReviewFlagCodes: [],
        unresolvedCategoryLabels: [],
      },
      promotionStatus: null,
      artifacts: {
        remediatedPdfPath: null,
        stagedReplacementPath: null,
        detailedReportPath: null,
        failureReportPath,
      },
      checksums: {
        gateEvaluatedBufferSha256: null,
        remediatedPdfSha256: null,
        stagedReplacementSha256: null,
      },
    }
    writeJson(failureReportPath, record)
    return record
  }

  const originalBuffer = await fs.promises.readFile(candidate.localCachePath)
  const filename = path.basename(candidate.localCachePath)
  const originalResult = await analyzePDF(originalBuffer, filename, {
    skipAdobe: true,
    skipVeraPdf: true,
    analysisProfile: 'full_final',
  })

  try {
    const remediation = await Promise.race([
      remediatePdfWithAgent(originalBuffer, filename, originalResult, {
        artifactsDir: attemptDirFor(candidate),
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          const error = new Error(`Processing exceeded runtime limit of ${timeoutMs}ms`)
          ;(error as Error & { code?: string }).code = 'EXCESSIVE_RUNTIME'
          reject(error)
        }, timeoutMs)
      }),
    ])

    ensureDir(path.dirname(remediatedPdfPath))
    await fs.promises.writeFile(remediatedPdfPath, remediation.buffer)

    const gate = evaluatePromotionGate({
      analysisResult: remediation.finalResult,
      manualReviewFlags: remediation.model.manualReviewFlags || [],
    })
    const gateEvaluatedBufferSha256 = sha256Hex(remediation.buffer)

    const detailed = {
      generatedAt: new Date().toISOString(),
      candidate,
      original: {
        overallScore: originalResult.overallScore,
        grade: originalResult.grade,
        pageCount: originalResult.pageCount,
        isScanned: originalResult.isScanned,
        executiveSummary: originalResult.executiveSummary,
        warnings: originalResult.warnings,
        localStandards: originalResult.localStandards,
      },
      final: {
        overallScore: remediation.finalResult.overallScore,
        grade: remediation.finalResult.grade,
        pageCount: remediation.finalResult.pageCount,
        isScanned: remediation.finalResult.isScanned,
        executiveSummary: remediation.finalResult.executiveSummary,
        warnings: remediation.finalResult.warnings,
        localStandards: remediation.finalResult.localStandards,
        categories: remediation.finalResult.categories,
      },
      model: {
        manualReviewFlags: remediation.model.manualReviewFlags,
        finalAudit: remediation.model.finalAudit,
        plannerEvidence: remediation.model.plannerEvidence,
        failureProfile: remediation.model.failureProfile,
      },
      gate,
      promotionStatus: null,
      checksums: {
        gateEvaluatedBufferSha256,
        remediatedPdfSha256: null,
        stagedReplacementSha256: null,
      },
      remediatedPdfPath,
      stagedReplacementPath: gate.passed ? stagedReplacementPath : null,
    }

    if (gate.passed) {
      ensureDir(path.dirname(stagedReplacementPath))
      await fs.promises.copyFile(remediatedPdfPath, stagedReplacementPath)
    } else {
      // Failure details are written after checksum collection so the report records
      // the exact bytes used for the final gate evaluation.
    }

    const remediatedPdfSha256 = await sha256OfFile(remediatedPdfPath)
    const stagedReplacementSha256 = gate.passed ? await sha256OfFile(stagedReplacementPath) : null
    if (remediatedPdfSha256 !== gateEvaluatedBufferSha256) {
      throw new Error('Saved remediated PDF bytes do not match the final gate-evaluated buffer.')
    }
    if (gate.passed && stagedReplacementSha256 !== gateEvaluatedBufferSha256) {
      throw new Error('Staged replacement bytes do not match the final gate-evaluated buffer.')
    }

    detailed.checksums.remediatedPdfSha256 = remediatedPdfSha256
    detailed.checksums.stagedReplacementSha256 = stagedReplacementSha256
    writeJson(detailedReportPath, detailed)
    if (!gate.passed) {
      writeJson(failureReportPath, detailed)
    }

    return {
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      priorityRank: candidate.priorityRank,
      priorityTier: candidate.priorityTier,
      passLikelihoodScore: candidate.passLikelihoodScore,
      serverHost: candidate.serverHost,
      remotePath: candidate.remotePath,
      localCachePath: candidate.localCachePath,
      fileUrl: candidate.fileUrl,
      storageKind: candidate.storageKind,
      originalReportPath: candidate.reportPath,
      status: gate.passed ? 'remediated_pass_candidate' : 'failed_after_remediation',
      promotionStatus: null,
      processedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      original: {
        overallScore: originalResult.overallScore,
        grade: originalResult.grade,
        pageCount: originalResult.pageCount,
        isScanned: originalResult.isScanned,
      },
      final: {
        overallScore: remediation.finalResult.overallScore,
        grade: remediation.finalResult.grade,
        pageCount: remediation.finalResult.pageCount,
        isScanned: remediation.finalResult.isScanned,
      },
      gate,
      artifacts: {
        remediatedPdfPath,
        stagedReplacementPath: gate.passed ? stagedReplacementPath : null,
        detailedReportPath,
        failureReportPath: gate.passed ? null : failureReportPath,
      },
      checksums: {
        gateEvaluatedBufferSha256,
        remediatedPdfSha256,
        stagedReplacementSha256,
      },
    }
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === 'EXCESSIVE_RUNTIME') {
      const message = error.message || ''
      const record = timeoutFailureRecord(
        candidate,
        startedAt,
        originalResult,
        failureReportPath,
        excessiveRuntimeReasonFromMessage(message),
      )
      writeJson(failureReportPath, record)
      return record
    }

    const message = error instanceof Error ? error.stack || error.message : String(error)
    const record: OutcomeRecord = {
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      priorityRank: candidate.priorityRank,
      priorityTier: candidate.priorityTier,
      passLikelihoodScore: candidate.passLikelihoodScore,
      serverHost: candidate.serverHost,
      remotePath: candidate.remotePath,
      localCachePath: candidate.localCachePath,
      fileUrl: candidate.fileUrl,
      storageKind: candidate.storageKind,
      originalReportPath: candidate.reportPath,
      status: 'processing_error',
      processedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      original: {
        overallScore: originalResult.overallScore,
        grade: originalResult.grade,
        pageCount: originalResult.pageCount,
        isScanned: originalResult.isScanned,
      },
      final: null,
      gate: {
        passed: false,
        reasons: [message],
        blockingLocalFindingKeys: [],
        criticalManualReviewFlagCodes: [],
        unresolvedCategoryLabels: [],
      },
      promotionStatus: null,
      artifacts: {
        remediatedPdfPath: null,
        stagedReplacementPath: null,
        detailedReportPath: null,
        failureReportPath,
      },
      checksums: {
        gateEvaluatedBufferSha256: null,
        remediatedPdfSha256: null,
        stagedReplacementSha256: null,
      },
    }
    writeJson(failureReportPath, record)
    return record
  }
}

async function main(): Promise<void> {
  ensureDir(path.dirname(outcomesManifestPath))
  ensureDir(detailedReportRoot)
  ensureDir(failureReportRoot)
  ensureDir(remediatedPdfRoot)

  const priorityManifest = normalizePriorityManifest(readJson<unknown>(priorityManifestPath))
  const targets = priorityManifest.candidates.filter(candidate =>
    candidate.priorityTier === 'highest'
    || candidate.priorityTier === 'high'
    || candidate.priorityTier === 'medium',
  )
  const limitedTargets = limit > 0 ? targets.slice(0, limit) : targets

  const outcomes = loadOutcomes()
  const doneKeys = new Set(outcomes.outcomes.map(entry => `${entry.serverHost}:${entry.remotePath}`))
  const pending = limitedTargets.filter(candidate => !doneKeys.has(`${candidate.serverHost}:${candidate.remotePath}`))
  let index = 0

  async function worker(): Promise<void> {
    while (index < pending.length) {
      const candidate = pending[index++]
      console.log(`[priority-remediation] starting rank=${candidate.priorityRank} tier=${candidate.priorityTier} ${candidate.remotePath}`)
      const outcome = await processCandidate(candidate)
      outcomes.outcomes.push(outcome)
      saveOutcomes(outcomes, limitedTargets.length)
      console.log(`[priority-remediation] finished status=${outcome.status} rank=${candidate.priorityRank} ${candidate.remotePath}`)
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))
  saveOutcomes(outcomes, limitedTargets.length)
  console.log(JSON.stringify({ completed: outcomes.totals.processed, totals: outcomes.totals }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
