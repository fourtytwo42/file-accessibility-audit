import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = '/home/hendo420/pdfaf'
const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')
const waveManifestPath = path.join(manifestsRoot, 'stage4-structure-wave.json')
const waveOutcomesPath = path.join(manifestsRoot, 'stage4-structure-wave.outcomes.json')
const waveOutcomesSummaryPath = path.join(manifestsRoot, 'stage4-structure-wave.outcomes.summary.json')
const verificationClassifiedPath = path.join(manifestsRoot, 'ready-to-replace-verification.classified.json')
const verificationSummaryPath = path.join(manifestsRoot, 'ready-to-replace-verification.summary.json')
const promotionLedgerSummaryPath = path.join(manifestsRoot, 'verified-promotion-ledger.summary.json')
const controlPlaneSummaryPath = path.join(manifestsRoot, 'corpus-control-plane.summary.json')

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', env })
  if (result.status !== 0) throw new Error(`Command failed: ${command} ${args.join(' ')}`)
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function readWaveSelectedCount(): number {
  if (!fs.existsSync(waveManifestPath)) return 0
  const doc = JSON.parse(fs.readFileSync(waveManifestPath, 'utf8')) as { totals?: { selectedRows?: number } }
  return Number(doc?.totals?.selectedRows || 0)
}

function readPendingPublicationIds(): string[] {
  if (!fs.existsSync(waveManifestPath)) return []
  const doc = JSON.parse(fs.readFileSync(waveManifestPath, 'utf8')) as { pendingPublicationIds?: string[] }
  return Array.isArray(doc?.pendingPublicationIds) ? doc.pendingPublicationIds.filter(Boolean) : []
}

function readSelectedPublicationIds(): string[] {
  const doc = readJsonIfExists<{ selectedPublicationIds?: string[] }>(waveManifestPath)
  return Array.isArray(doc?.selectedPublicationIds) ? doc.selectedPublicationIds.filter(Boolean) : []
}

function controlPlaneIsValidated(): boolean {
  const doc = readJsonIfExists<{ validation?: { ok?: boolean } }>(controlPlaneSummaryPath)
  return Boolean(doc?.validation?.ok)
}

function assertPersistedTruthReady(): void {
  if (!fs.existsSync(verificationClassifiedPath)) {
    throw new Error('Cannot start a new Stage 4 wave: classified verification manifest is missing.')
  }
  if (!fs.existsSync(controlPlaneSummaryPath)) {
    throw new Error('Cannot start a new Stage 4 wave: corpus control-plane summary is missing.')
  }
  if (!controlPlaneIsValidated()) {
    throw new Error('Cannot start a new Stage 4 wave: corpus control-plane summary is not validated.')
  }
}

function waveOutcomesAreTerminalForSelected(): boolean {
  const selectedPublicationIds = readSelectedPublicationIds()
  if (!selectedPublicationIds.length) return false
  const doc = readJsonIfExists<{ outcomes?: Array<{ publicationId?: string; status?: string | null }> }>(waveOutcomesPath)
  if (!doc?.outcomes?.length) return false
  const latestByPublicationId = new Map<string, string>()
  for (const outcome of doc.outcomes) {
    const publicationId = String(outcome.publicationId || '').trim()
    if (!publicationId) continue
    latestByPublicationId.set(publicationId, String(outcome.status || ''))
  }
  return selectedPublicationIds.every(publicationId => {
    const status = latestByPublicationId.get(publicationId)
    return Boolean(status && status !== 'ready_to_replace')
  })
}

function fileWrittenAfter(filePath: string, thresholdMs: number): boolean {
  if (!fs.existsSync(filePath)) return false
  return fs.statSync(filePath).mtimeMs >= thresholdMs
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

async function runVerifyReadyWithPersistedTruth(): Promise<void> {
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
      && waveOutcomesAreTerminalForSelected()

    if (!persistedTruthReady) continue

    console.warn('[stage4-structure-wave] Verification artifacts are persisted and the selected wave is terminal; continuing from manifests even though verify-ready is still running.')
    await terminateChild(child)
    return
  }
}

export async function main(): Promise<void> {
  const buildOnly = process.argv.includes('--build-only') || process.argv.includes('--skip-remediation')
  const pendingOnly = process.argv.includes('--pending-only')

  const buildEnv = pendingOnly
    ? {
        ...process.env,
        ICJIA_STAGE4_STRUCTURE_WAVE_INCLUDE_IDS: readPendingPublicationIds().join(','),
      }
    : process.env

  run('pnpm', ['agency:build-stage4-structure-wave'], buildEnv)
  assertPersistedTruthReady()
  const selectedRows = readWaveSelectedCount()
  if (pendingOnly && !readPendingPublicationIds().length) {
    console.log(JSON.stringify({ skipped: true, reason: 'No pending Stage 4 rows remain.' }, null, 2))
    return
  }
  if (!selectedRows) {
    console.log(JSON.stringify({ skipped: true, reason: 'No Stage 4 structure-wave candidates selected.' }, null, 2))
    return
  }

  if (!buildOnly) {
    run('pnpm', ['agency:run-priority-remediation'], {
      ...buildEnv,
      ICJIA_PRIORITY_MANIFEST_PATH: waveManifestPath,
      ICJIA_REMEDIATION_OUTCOMES_PATH: waveOutcomesPath,
      ICJIA_REMEDIATION_OUTCOMES_SUMMARY_PATH: waveOutcomesSummaryPath,
      ICJIA_REMEDIATION_DETAILED_REPORT_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'test-runs', 'stage4-structure-wave'),
      ICJIA_REMEDIATION_FAILURE_REPORT_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'failures', 'stage4-structure-wave'),
      ICJIA_REMEDIATION_REMEDIATED_PDF_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'artifacts', 'remediated-pdfs', 'stage4-structure-wave'),
      ICJIA_REMEDIATION_ATTEMPTS_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'artifacts', 'remediation-attempts', 'stage4-structure-wave'),
    })
    console.log(JSON.stringify({
      stage: 'stage4_remediation_complete',
      waveManifestPath,
      waveOutcomesPath,
      waveOutcomesSummaryPath,
      outcomesTerminalForSelected: waveOutcomesAreTerminalForSelected(),
    }, null, 2))

    await runVerifyReadyWithPersistedTruth()
    run('pnpm', ['exec', 'tsx', 'scripts/classify-ready-verification.ts'])
    run('pnpm', ['agency:build-control-plane'])
    run('pnpm', ['agency:validate-control-plane'])
    console.log(JSON.stringify({
      stage: 'stage4_post_wave_truth_reconciled',
      verificationClassifiedPath,
      controlPlaneSummaryPath,
      controlPlaneValidated: controlPlaneIsValidated(),
    }, null, 2))
  }

  run('pnpm', ['agency:build-stage4-structure-wave'])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
