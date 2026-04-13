import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ThroughputLaneDocument, ThroughputLaneName } from '../apps/api/src/services/passRateWaveSlices.ts'

const repoRoot = '/home/hendo420/pdfaf'
const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')

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

function resolveLaneName(): ThroughputLaneName {
  const envLane = String(process.env.ICJIA_THROUGHPUT_LANE_NAME || '').trim()
  if (
    envLane === 'small-fast-pass'
    || envLane === 'medium-figure-conversion'
    || envLane === 'serial-heavy-mixed-terminalization'
    || envLane === 'manual-scanned-deferred'
    || envLane === 'all-remaining-automated'
    || envLane === 'replacement-likelihood'
  ) {
    return envLane
  }
  throw new Error('Set ICJIA_THROUGHPUT_LANE_NAME to a valid throughput lane.')
}

export async function main(): Promise<void> {
  run('pnpm', ['agency:build-pass-rate-slices'])

  const laneName = resolveLaneName()
  const manifestPath = path.join(manifestsRoot, `${laneName}.json`)
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing throughput lane manifest: ${manifestPath}`)
  }

  const manifest = readJson<ThroughputLaneDocument>(manifestPath)
  if (
    (manifest.executionPolicy === 'deferred' && process.env.ICJIA_ALLOW_DEFERRED_LANE !== '1')
    || (manifest.executionPolicy === 'dormant' && process.env.ICJIA_ALLOW_DORMANT_LANE !== '1')
  ) {
    console.log(JSON.stringify({
      skipped: true,
      laneName,
      reason: `Throughput lane ${laneName} is ${manifest.executionPolicy} by policy.`,
      executionPolicyReason: manifest.executionPolicyReason,
    }, null, 2))
    return
  }

  const outcomesPath = path.join(manifestsRoot, `${laneName}.outcomes.json`)
  const outcomesSummaryPath = path.join(manifestsRoot, `${laneName}.outcomes.summary.json`)

  run('pnpm', ['agency:run-priority-remediation'], {
    ...process.env,
    ICJIA_PRIORITY_MANIFEST_PATH: manifestPath,
    ICJIA_REMEDIATION_OUTCOMES_PATH: outcomesPath,
    ICJIA_REMEDIATION_OUTCOMES_SUMMARY_PATH: outcomesSummaryPath,
    ICJIA_REMEDIATION_CONCURRENCY: String(manifest.recommendedConcurrency),
    ICJIA_REMEDIATION_INITIAL_ANALYSIS_PROFILE: manifest.initialAnalysisProfile,
    ICJIA_REMEDIATION_DETAILED_REPORT_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'test-runs', laneName),
    ICJIA_REMEDIATION_FAILURE_REPORT_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'failures', laneName),
    ICJIA_REMEDIATION_REMEDIATED_PDF_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'artifacts', 'remediated-pdfs', laneName),
    ICJIA_REMEDIATION_ATTEMPTS_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'artifacts', 'remediation-attempts', laneName),
  })

  console.log(JSON.stringify({
    laneName,
    laneIntent: manifest.laneIntent,
    manifestPath,
    outcomesPath,
    outcomesSummaryPath,
    recommendedConcurrency: manifest.recommendedConcurrency,
    initialAnalysisProfile: manifest.initialAnalysisProfile,
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
