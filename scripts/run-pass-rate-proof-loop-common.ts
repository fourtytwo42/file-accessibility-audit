import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildCorpusControlPlaneArtifactsFromSources,
  loadCorpusControlPlaneSources,
  validateCorpusControlPlaneArtifacts,
} from '../apps/api/src/services/corpusControlPlane.ts'
import { applyStage2ShortCohortReclassification } from '../apps/api/src/services/shortCohortStage2.ts'
import { applyStage3FigureWaveReclassification } from '../apps/api/src/services/figureWaveStage3.ts'
import { applyStage4StructureWaveReclassification } from '../apps/api/src/services/structureWaveStage4.ts'
import {
  summarizeFigureCanaryProofLoop,
  summarizeFontCanaryProofLoop,
  summarizeRuntimeRetryProofLoop,
  summarizeRuntimeSliceProofLoop,
  type PassRateProofSummary,
} from '../apps/api/src/services/passRateProofLoops.ts'
import type {
  PassRateFigureCanaryDocument,
  PassRateFontCanaryDocument,
  RuntimeRetryWaveDocument,
  RuntimeRetrySliceDocument,
} from '../apps/api/src/services/passRateWaveSlices.ts'

const repoRoot = '/home/hendo420/pdfaf'
const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')
const verificationSummaryPath = path.join(manifestsRoot, 'ready-to-replace-verification.summary.json')
const promotionLedgerSummaryPath = path.join(manifestsRoot, 'verified-promotion-ledger.summary.json')
const controlPlaneSummaryPath = path.join(manifestsRoot, 'corpus-control-plane.summary.json')

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
  })
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`)
  }
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
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

    console.warn(`[${path.basename(manifestPath, '.json')}] Verification artifacts are persisted and selected outcomes are terminal; continuing from manifests even though verify-ready is still running.`)
    await terminateChild(child)
    return
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
  if (!validation.ok) {
    throw new Error('Control plane became invalid while building proof-loop summary.')
  }
  return { sources, artifacts }
}

export async function runPassRateProofLoop(input: {
  sliceName:
    | 'pass-rate-figure-canary'
    | 'pass-rate-font-canary'
    | 'runtime-tail-retry-wave'
    | 'runtime-tail-figure-retry'
    | 'runtime-tail-structure-retry'
    | 'runtime-tail-mixed-terminalization'
  reportRootName: string
}): Promise<void> {
  const buildOnly = process.argv.includes('--build-only') || process.argv.includes('--skip-remediation')
  const allowDormantRuntimeSlice = process.env.ICJIA_ALLOW_DORMANT_RUNTIME_SLICE === '1'
  run('pnpm', ['agency:build-pass-rate-slices'])

  const manifestPath = path.join(manifestsRoot, `${input.sliceName}.json`)
  const outcomesPath = path.join(manifestsRoot, `${input.sliceName}.outcomes.json`)
  const outcomesSummaryPath = path.join(manifestsRoot, `${input.sliceName}.outcomes.summary.json`)
  const proofSummaryPath = path.join(manifestsRoot, `${input.sliceName}.proof-summary.json`)

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing pass-rate slice manifest: ${manifestPath}`)
  }

  const manifest = readJson<PassRateFigureCanaryDocument | PassRateFontCanaryDocument | RuntimeRetryWaveDocument | RuntimeRetrySliceDocument>(manifestPath)
  const selectedCount = Array.isArray(manifest.selectedPublicationIds) ? manifest.selectedPublicationIds.length : 0
  const runtimeSliceManifest = (
    input.sliceName === 'runtime-tail-figure-retry'
    || input.sliceName === 'runtime-tail-structure-retry'
    || input.sliceName === 'runtime-tail-mixed-terminalization'
  ) ? manifest as RuntimeRetrySliceDocument : null
  if (!selectedCount) {
    console.log(JSON.stringify({ skipped: true, reason: `No ${input.sliceName} candidates selected.` }, null, 2))
    return
  }
  if (
    !buildOnly
    && runtimeSliceManifest
    && runtimeSliceManifest.executionPolicy === 'dormant'
    && !allowDormantRuntimeSlice
  ) {
    console.log(JSON.stringify({
      skipped: true,
      reason: `Runtime slice ${input.sliceName} is dormant by policy.`,
      executionPolicy: runtimeSliceManifest.executionPolicy,
      executionPolicyReason: runtimeSliceManifest.executionPolicyReason,
    }, null, 2))
    return
  }

  if (!buildOnly) {
    run('pnpm', ['agency:run-priority-remediation'], {
      ...process.env,
      ICJIA_PRIORITY_MANIFEST_PATH: manifestPath,
      ICJIA_REMEDIATION_OUTCOMES_PATH: outcomesPath,
      ICJIA_REMEDIATION_OUTCOMES_SUMMARY_PATH: outcomesSummaryPath,
      ICJIA_REMEDIATION_DETAILED_REPORT_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'test-runs', input.reportRootName),
      ICJIA_REMEDIATION_FAILURE_REPORT_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'failures', input.reportRootName),
      ICJIA_REMEDIATION_REMEDIATED_PDF_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'artifacts', 'remediated-pdfs', input.reportRootName),
      ICJIA_REMEDIATION_ATTEMPTS_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'artifacts', 'remediation-attempts', input.reportRootName),
    })

    await runVerifyReadyWithPersistedTruth(manifestPath, outcomesPath)
    run('pnpm', ['exec', 'tsx', 'scripts/classify-ready-verification.ts'])
    run('pnpm', ['agency:build-control-plane'])
    run('pnpm', ['agency:validate-control-plane'])
    run('pnpm', ['agency:build-pass-rate-slices'])
  }

  const { artifacts } = loadReclassifiedArtifacts()
  let proofSummary: PassRateProofSummary
  if (input.sliceName === 'pass-rate-figure-canary') {
    proofSummary = summarizeFigureCanaryProofLoop({
      slice: manifest as PassRateFigureCanaryDocument,
      artifacts,
    })
  } else if (input.sliceName === 'pass-rate-font-canary') {
    proofSummary = summarizeFontCanaryProofLoop({
      slice: manifest as PassRateFontCanaryDocument,
      artifacts,
    })
  } else if (input.sliceName === 'runtime-tail-retry-wave') {
    proofSummary = summarizeRuntimeRetryProofLoop({
      slice: manifest as RuntimeRetryWaveDocument,
      artifacts,
    })
  } else {
    proofSummary = summarizeRuntimeSliceProofLoop({
      slice: manifest as RuntimeRetrySliceDocument,
      artifacts,
    })
  }

  writeJson(proofSummaryPath, proofSummary)
  console.log(JSON.stringify({
    sliceName: input.sliceName,
    manifestPath,
    outcomesPath,
    outcomesSummaryPath,
    proofSummaryPath,
    selectedCount,
    delta: proofSummary.deltas,
  }, null, 2))
}
