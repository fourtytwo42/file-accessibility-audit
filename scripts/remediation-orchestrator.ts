import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultOrchestratorConfig, runRemediationOrchestrator } from '../apps/api/src/services/remediationOrchestrator.ts'

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(scriptDir, '..')
  const config = defaultOrchestratorConfig(repoRoot)
  await runRemediationOrchestrator(config)
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
