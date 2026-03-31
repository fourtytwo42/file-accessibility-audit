import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = '/home/hendo420/pdfaf'
const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')
const waveManifestPath = path.join(manifestsRoot, 'stage3-figure-wave.json')
const waveOutcomesPath = path.join(manifestsRoot, 'stage3-figure-wave.outcomes.json')
const waveOutcomesSummaryPath = path.join(manifestsRoot, 'stage3-figure-wave.outcomes.summary.json')

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

function readWaveSelectedCount(): number {
  if (!fs.existsSync(waveManifestPath)) return 0
  const doc = JSON.parse(fs.readFileSync(waveManifestPath, 'utf8')) as { totals?: { selectedRows?: number } }
  return Number(doc?.totals?.selectedRows || 0)
}

export async function main(): Promise<void> {
  const buildOnly = process.argv.includes('--build-only') || process.argv.includes('--skip-remediation')

  run('pnpm', ['agency:build-stage3-figure-wave'])
  const selectedRows = readWaveSelectedCount()
  if (!selectedRows) {
    console.log(JSON.stringify({ skipped: true, reason: 'No Stage 3 figure-wave candidates selected.' }, null, 2))
    return
  }

  if (!buildOnly) {
    run('pnpm', ['agency:run-priority-remediation'], {
      ...process.env,
      ICJIA_PRIORITY_MANIFEST_PATH: waveManifestPath,
      ICJIA_REMEDIATION_OUTCOMES_PATH: waveOutcomesPath,
      ICJIA_REMEDIATION_OUTCOMES_SUMMARY_PATH: waveOutcomesSummaryPath,
      ICJIA_REMEDIATION_DETAILED_REPORT_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'test-runs', 'stage3-figure-wave'),
      ICJIA_REMEDIATION_FAILURE_REPORT_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'failures', 'stage3-figure-wave'),
      ICJIA_REMEDIATION_REMEDIATED_PDF_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'artifacts', 'remediated-pdfs', 'stage3-figure-wave'),
      ICJIA_REMEDIATION_ATTEMPTS_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'artifacts', 'remediation-attempts', 'stage3-figure-wave'),
    })

    run('pnpm', ['agency:verify-ready'])
    run('pnpm', ['exec', 'tsx', 'scripts/classify-ready-verification.ts'])
    run('pnpm', ['agency:build-control-plane'])
    run('pnpm', ['agency:validate-control-plane'])
  }

  run('pnpm', ['agency:build-stage3-figure-wave'])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
