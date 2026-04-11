import { pathToFileURL } from 'node:url'
import { main as runRecoveryWave } from './run-sub79-recovery-wave.ts'

export async function main(): Promise<void> {
  process.argv[2] = 'all-sub79-recovery'
  await runRecoveryWave()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
