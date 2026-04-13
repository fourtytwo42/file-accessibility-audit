import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildCorpusControlPlaneArtifactsFromSources,
  loadCorpusControlPlaneSources,
  validateCorpusControlPlaneArtifacts,
} from '../apps/api/src/services/corpusControlPlane.ts'
import { applyStage2ShortCohortReclassification } from '../apps/api/src/services/shortCohortStage2.ts'
import { applyStage3FigureWaveReclassification } from '../apps/api/src/services/figureWaveStage3.ts'
import { applyStage4StructureWaveReclassification } from '../apps/api/src/services/structureWaveStage4.ts'
import { summarizeRuntimeSliceProofLoop } from '../apps/api/src/services/passRateProofLoops.ts'
import type { RuntimeRetrySliceDocument } from '../apps/api/src/services/passRateWaveSlices.ts'
import {
  planRuntimeTailChunk,
  recommendRuntimeTailOvernightAction,
  summarizeRuntimeTailChunkMetrics,
  type RuntimeTailOvernightRecommendation,
} from '../apps/api/src/services/runtimeTailOvernight.ts'

const repoRoot = '/home/hendo420/pdfaf'
const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')
const verificationSummaryPath = path.join(manifestsRoot, 'ready-to-replace-verification.summary.json')
const promotionLedgerSummaryPath = path.join(manifestsRoot, 'verified-promotion-ledger.summary.json')

type RuntimeSliceName =
  | 'runtime-tail-figure-retry'
  | 'runtime-tail-structure-retry'
  | 'runtime-tail-mixed-terminalization'

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

function fileWrittenAfter(filePath: string, thresholdMs: number): boolean {
  if (!fs.existsSync(filePath)) return false
  return fs.statSync(filePath).mtimeMs >= thresholdMs
}

function selectedOutcomesAreTerminal(manifestPath: string, outcomesPath: string): boolean {
  const manifest = readJsonIfExists<{ selectedPublicationIds?: string[] }>(manifestPath)
  const selectedPublicationIds = Array.isArray(manifest?.selectedPublicationIds)
    ? manifest.selectedPublicationIds.filter(Boolean)
    : []
  if (!selectedPublicationIds.length) return false
  const outcomes = readJsonIfExists<{ outcomes?: Array<{ publicationId?: string | null, status?: string | null }> }>(outcomesPath)
  if (!outcomes?.outcomes?.length) return false
  const latestByPublicationId = new Map<string, string>()
  for (const outcome of outcomes.outcomes) {
    const publicationId = String(outcome.publicationId || '').trim()
    if (!publicationId) continue
    latestByPublicationId.set(publicationId, String(outcome.status || ''))
  }
  return selectedPublicationIds.every(publicationId => {
    const status = latestByPublicationId.get(publicationId)
    return Boolean(status && status !== 'ready_to_replace')
  })
}

async function terminateChild(child: ReturnType<typeof spawn>, graceMs = 8000): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const deadline = Date.now() + graceMs
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function runVerifyReadyWithPersistedTruth(manifestPath: string, outcomesPath: string): Promise<void> {
  const startedAtMs = Date.now()
  const child = spawn('pnpm', ['agency:verify-ready'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })

  const exitPromise = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 0))
  })

  while (true) {
    const exitCode = await Promise.race([
      exitPromise,
      new Promise<symbol>(resolve => setTimeout(() => resolve(Symbol.for('poll')), 5000)),
    ])

    if (typeof exitCode === 'number') {
      if (exitCode !== 0) throw new Error(`Command failed: pnpm agency:verify-ready (exit ${exitCode})`)
      return
    }

    const persistedTruthReady =
      fileWrittenAfter(verificationSummaryPath, startedAtMs)
      && fileWrittenAfter(promotionLedgerSummaryPath, startedAtMs)
      && selectedOutcomesAreTerminal(manifestPath, outcomesPath)

    if (!persistedTruthReady) continue

    console.warn(`[runtime-tail-overnight] Verification artifacts are persisted and selected outcomes are terminal; continuing from manifests even though verify-ready is still running.`)
    await terminateChild(child)
    return
  }
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): { status: number | null, signal: NodeJS.Signals | null } {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
  })
  return {
    status: result.status,
    signal: result.signal,
  }
}

function assertCommandSucceeded(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = runCommand(command, args, env)
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}${result.signal ? ` (${result.signal})` : ''}`)
  }
}

function loadReclassifiedArtifacts() {
  const sources = loadCorpusControlPlaneSources()
  const baseArtifacts = buildCorpusControlPlaneArtifactsFromSources(sources)
  const stage2Artifacts = applyStage2ShortCohortReclassification(baseArtifacts, sources)
  const stage3Artifacts = applyStage3FigureWaveReclassification(stage2Artifacts)
  const artifacts = applyStage4StructureWaveReclassification(
    stage3Artifacts,
    sources.stage4PendingAnalysisRows,
    sources.stage4ActiveAnalysisRows,
    sources.stage4StalledAnalysisRows,
    sources.stage4OverlapAnalysisRows,
    sources.stage4ActiveForensicsRows,
    sources.stage4HomogeneousAnalysisRows,
  )
  const validation = validateCorpusControlPlaneArtifacts(artifacts, {
    replacementMap: sources.replacementMap,
    promotionLedgerRows: sources.promotionLedgerRows,
  })
  if (!validation.ok) throw new Error('Control plane became invalid while building overnight runtime summary.')
  return { artifacts }
}

function laneToReportRoot(sliceName: RuntimeSliceName): string {
  return sliceName
}

function clampChunkSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 8
  return Math.max(8, Math.min(12, Math.floor(value)))
}

function manifestPathFor(sliceName: RuntimeSliceName): string {
  return path.join(manifestsRoot, `${sliceName}.json`)
}

function buildChunkManifest(
  slice: RuntimeRetrySliceDocument,
  chunkId: number,
  selectedPublicationIds: string[],
): { manifestPath: string, manifest: RuntimeRetrySliceDocument } {
  const selectedIdSet = new Set(selectedPublicationIds)
  const candidates = slice.candidates
    .filter(candidate => selectedIdSet.has(candidate.publicationId))
    .map((candidate, index) => ({ ...candidate, priorityRank: index + 1 }))
  const manifest: RuntimeRetrySliceDocument = {
    ...slice,
    selectedPublicationIds,
    candidates,
    totals: {
      ...slice.totals,
      eligibleRows: candidates.length,
      selectedRows: candidates.length,
      skippedRows: 0,
    },
  }
  const manifestPath = path.join(manifestsRoot, `${slice.sliceName}.chunk-${String(chunkId).padStart(3, '0')}.json`)
  writeJson(manifestPath, manifest)
  return { manifestPath, manifest }
}

export async function main(): Promise<void> {
  const sliceName = (process.env.ICJIA_RUNTIME_TAIL_OVERNIGHT_SLICE || 'runtime-tail-mixed-terminalization') as RuntimeSliceName
  const allowDormantRuntimeSlice = process.env.ICJIA_ALLOW_DORMANT_RUNTIME_SLICE === '1'
  const chunkSize = clampChunkSize(Number(process.env.ICJIA_RUNTIME_TAIL_CHUNK_SIZE || 8))
  const processingErrorRateThreshold = Number(process.env.ICJIA_RUNTIME_TAIL_PROCESSING_ERROR_THRESHOLD || 0.35)
  const maxChunks = Number(process.env.ICJIA_RUNTIME_TAIL_MAX_CHUNKS || 0)
  const summaryPath = path.join(manifestsRoot, `${sliceName}.overnight.summary.json`)
  const reportRoot = laneToReportRoot(sliceName)

  const cumulative = {
    startedAt: new Date().toISOString(),
    sliceName,
    chunkSize,
    thresholds: {
      processingErrorRateThreshold,
      consecutiveLowYieldChunks: 2,
    },
    processedPublicationIds: [] as string[],
    chunkSummaries: [] as Array<Record<string, unknown>>,
    totals: {
      processedRows: 0,
      passCandidates: 0,
      failedAfterRemediation: 0,
      processingError: 0,
      processingErrorToStableHardFail: 0,
      remainingRetryWorthyRows: 0,
    },
    finalRecommendation: 'continue_same_lane' as RuntimeTailOvernightRecommendation,
  }

  let chunkId = 0
  let consecutiveLowYieldChunks = 0
  let finalRecommendation: RuntimeTailOvernightRecommendation = 'continue_same_lane'

  while (true) {
    if (maxChunks > 0 && chunkId >= maxChunks) break
    assertCommandSucceeded('pnpm', ['agency:build-pass-rate-slices'])
    const slice = readJson<RuntimeRetrySliceDocument>(manifestPathFor(sliceName))
    if (slice.executionPolicy === 'dormant' && !allowDormantRuntimeSlice) {
      finalRecommendation = 'stop_and_replan_engine'
      cumulative.chunkSummaries.push({
        chunkId: chunkId + 1,
        skipped: true,
        reason: `Runtime slice ${sliceName} is dormant by policy.`,
        executionPolicy: slice.executionPolicy,
        executionPolicyReason: slice.executionPolicyReason,
      })
      break
    }
    const processedIdSet = new Set(cumulative.processedPublicationIds)
    const remainingCandidates = slice.candidates.filter(candidate => !processedIdSet.has(candidate.publicationId))
    const remainingIds = remainingCandidates.map(candidate => candidate.publicationId)
    cumulative.totals.remainingRetryWorthyRows = remainingIds.length
    if (!remainingIds.length) {
      finalRecommendation = slice.sliceIntent === 'pass_rate_conversion'
        ? 'switch_to_terminalization'
        : 'stop_and_replan_engine'
      break
    }

    chunkId += 1
    const chunkPlan = planRuntimeTailChunk({
      candidates: remainingCandidates.map(candidate => ({
        publicationId: candidate.publicationId,
        runtimeWeightBucket: candidate.runtimeWeightBucket,
        runtimeProfileKey: candidate.runtimeProfileKey,
        passLikelihoodScore: candidate.passLikelihoodScore,
      })),
      nominalChunkSize: chunkSize,
      sliceIntent: slice.sliceIntent,
    })
    const chunkPublicationIds = chunkPlan.selectedPublicationIds
    const { manifestPath, manifest } = buildChunkManifest(slice, chunkId, chunkPublicationIds)
    const chunkStem = `${sliceName}.chunk-${String(chunkId).padStart(3, '0')}`
    const outcomesPath = path.join(manifestsRoot, `${chunkStem}.outcomes.json`)
    const outcomesSummaryPath = path.join(manifestsRoot, `${chunkStem}.outcomes.summary.json`)
    const proofSummaryPath = path.join(manifestsRoot, `${chunkStem}.proof-summary.json`)

    const remediation = runCommand('pnpm', ['agency:run-priority-remediation'], {
      ...process.env,
      ICJIA_PRIORITY_MANIFEST_PATH: manifestPath,
      ICJIA_REMEDIATION_OUTCOMES_PATH: outcomesPath,
      ICJIA_REMEDIATION_OUTCOMES_SUMMARY_PATH: outcomesSummaryPath,
      ICJIA_REMEDIATION_DETAILED_REPORT_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'test-runs', reportRoot, `chunk-${String(chunkId).padStart(3, '0')}`),
      ICJIA_REMEDIATION_FAILURE_REPORT_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'failures', reportRoot, `chunk-${String(chunkId).padStart(3, '0')}`),
      ICJIA_REMEDIATION_REMEDIATED_PDF_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'artifacts', 'remediated-pdfs', reportRoot, `chunk-${String(chunkId).padStart(3, '0')}`),
      ICJIA_REMEDIATION_ATTEMPTS_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'artifacts', 'remediation-attempts', reportRoot, `chunk-${String(chunkId).padStart(3, '0')}`),
      ICJIA_REMEDIATION_CONCURRENCY: String(chunkPlan.concurrency),
    })

    if (remediation.status !== 0) {
      finalRecommendation = remediation.status === 137
        ? 'stop_and_replan_engine'
        : manifest.sliceIntent === 'pass_rate_conversion'
          ? 'switch_to_terminalization'
          : 'stop_and_replan_engine'
      cumulative.chunkSummaries.push({
        chunkId,
        chunkManifestPath: manifestPath,
        selectedPublicationIds: chunkPublicationIds,
        runtimeWeightBucket: chunkPlan.runtimeWeightBucket,
        chunkSizeCap: chunkPlan.chunkSizeCap,
        remediationConcurrency: chunkPlan.concurrency,
        isolatedHeavyProfileKeys: chunkPlan.isolatedHeavyProfileKeys,
        exitCode: remediation.status,
        signal: remediation.signal,
        recommendation: finalRecommendation,
      })
      writeJson(summaryPath, { ...cumulative, finalRecommendation })
      break
    }

    await runVerifyReadyWithPersistedTruth(manifestPath, outcomesPath)
    assertCommandSucceeded('pnpm', ['exec', 'tsx', 'scripts/classify-ready-verification.ts'])
    assertCommandSucceeded('pnpm', ['agency:build-control-plane'])
    assertCommandSucceeded('pnpm', ['agency:validate-control-plane'])
    assertCommandSucceeded('pnpm', ['agency:build-pass-rate-slices'])

    const { artifacts } = loadReclassifiedArtifacts()
    const proofSummary = summarizeRuntimeSliceProofLoop({ slice: manifest, artifacts })
    writeJson(proofSummaryPath, proofSummary)
    const outcomesSummary = readJsonIfExists<{
      totals?: {
        processed?: number
        readyToReplace?: number
        remediatedPassCandidates?: number
        failedAfterRemediation?: number
        processingError?: number
      }
    }>(outcomesSummaryPath)

    const passCandidates = Number(outcomesSummary?.totals?.readyToReplace || 0)
      + Number(outcomesSummary?.totals?.remediatedPassCandidates || 0)
    const processingErrorCount = Number(outcomesSummary?.totals?.processingError || 0)
    const failedAfterRemediation = Number(outcomesSummary?.totals?.failedAfterRemediation || 0)
    const processingErrorToStableHardFail = proofSummary.runtimeTransitions?.processingErrorToStableHardFail.length || 0
    const unchangedProcessingError = proofSummary.runtimeTransitions?.unchangedProcessingError.length || 0
    const chunkMetrics = {
      sliceIntent: manifest.sliceIntent,
      selectedCount: chunkPublicationIds.length,
      passCandidates,
      processingErrorCount,
      processingErrorToStableHardFail,
      unchangedProcessingError,
      targetedFindingDeltas: proofSummary.deltas.targetedFindingCounts,
      targetedFamilyDeltas: proofSummary.deltas.targetedFamilyCounts,
      remainingRetryWorthyRows: Math.max(0, remainingIds.length - chunkPublicationIds.length),
      consecutiveLowYieldChunks,
      processingErrorRateThreshold,
    } as const
    const chunkSummary = summarizeRuntimeTailChunkMetrics(chunkMetrics)
    const blockerReductionObserved = chunkSummary.passRateSummary.blockerReductionObserved
    consecutiveLowYieldChunks = passCandidates === 0 && !blockerReductionObserved
      ? consecutiveLowYieldChunks + 1
      : 0
    finalRecommendation = recommendRuntimeTailOvernightAction({
      ...chunkMetrics,
      consecutiveLowYieldChunks,
    })

    cumulative.processedPublicationIds.push(...chunkPublicationIds)
    cumulative.totals.processedRows += chunkPublicationIds.length
    cumulative.totals.passCandidates += passCandidates
    cumulative.totals.failedAfterRemediation += failedAfterRemediation
    cumulative.totals.processingError += processingErrorCount
    cumulative.totals.processingErrorToStableHardFail += processingErrorToStableHardFail
    cumulative.totals.remainingRetryWorthyRows = Math.max(0, remainingIds.length - chunkPublicationIds.length)
    cumulative.chunkSummaries.push({
      chunkId,
      chunkManifestPath: manifestPath,
      outcomesSummaryPath,
      proofSummaryPath,
      selectedPublicationIds: chunkPublicationIds,
      runtimeWeightBucket: chunkPlan.runtimeWeightBucket,
      chunkSizeCap: chunkPlan.chunkSizeCap,
      remediationConcurrency: chunkPlan.concurrency,
      isolatedHeavyProfileKeys: chunkPlan.isolatedHeavyProfileKeys,
      outcomeTotals: outcomesSummary?.totals || {},
      delta: proofSummary.deltas,
      runtimeTransitions: proofSummary.runtimeTransitions || {},
      passRateSummary: chunkSummary.passRateSummary,
      truthHardeningSummary: chunkSummary.truthHardeningSummary,
      recommendation: finalRecommendation,
    })
    writeJson(summaryPath, { ...cumulative, finalRecommendation })

    if (finalRecommendation !== 'continue_same_lane') break
  }

  writeJson(summaryPath, { ...cumulative, finalRecommendation, finishedAt: new Date().toISOString() })
  console.log(JSON.stringify({
    summaryPath,
    finalRecommendation,
    totals: cumulative.totals,
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
