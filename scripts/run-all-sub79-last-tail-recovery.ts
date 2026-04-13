import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = '/home/hendo420/pdfaf'
const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')
const laneName = 'all-sub79-last-tail-recovery'

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
  })
  if (result.status !== 0) throw new Error(`Command failed: ${command} ${args.join(' ')}`)
}

export async function main(): Promise<void> {
  const manifestPath = path.join(manifestsRoot, `${laneName}.json`)
  const outcomesPath = path.join(manifestsRoot, `${laneName}.outcomes.json`)
  const outcomesSummaryPath = path.join(manifestsRoot, `${laneName}.outcomes.summary.json`)
  const progressPath = outcomesPath.replace(/\.json$/i, '.progress.json')
  run('pnpm', ['exec', 'tsx', 'scripts/build-all-sub79-last-tail-recovery.ts'])
  for (const targetPath of [outcomesPath, outcomesSummaryPath, progressPath]) {
    fs.rmSync(targetPath, { force: true })
  }
  run('pnpm', ['agency:run-priority-remediation'], {
    ...process.env,
    ICJIA_PRIORITY_MANIFEST_PATH: manifestPath,
    ICJIA_REMEDIATION_OUTCOMES_PATH: outcomesPath,
    ICJIA_REMEDIATION_OUTCOMES_SUMMARY_PATH: outcomesSummaryPath,
    ICJIA_REMEDIATION_PROGRESS_PATH: progressPath,
    ICJIA_REMEDIATION_CONCURRENCY: '4',
    ICJIA_REMEDIATION_TIMEOUT_MS: '1800000',
    ICJIA_REMEDIATION_INITIAL_ANALYSIS_PROFILE: 'full_final',
    ICJIA_REMEDIATION_MIN_PASS_SCORE: '90',
    ICJIA_REMEDIATION_MIN_KEEP_SCORE: '',
    ICJIA_REMEDIATION_ENFORCE_SINGLE_OWNER: '1',
    ICJIA_REMEDIATION_DETAILED_REPORT_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'test-runs', laneName),
    ICJIA_REMEDIATION_FAILURE_REPORT_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'reports', 'failures', laneName),
    ICJIA_REMEDIATION_REMEDIATED_PDF_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'artifacts', 'remediated-pdfs', laneName),
    ICJIA_REMEDIATION_ATTEMPTS_ROOT: path.join(repoRoot, 'ICJIA-PDFs', 'artifacts', 'remediation-attempts', laneName),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
