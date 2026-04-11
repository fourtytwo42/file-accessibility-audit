import { pathToFileURL } from 'node:url'
import { buildSub79RecoveryWave } from './build-sub79-recovery-wave.ts'

export async function main(): Promise<void> {
  const manifest = buildSub79RecoveryWave('mixed-structure-figure-plus')
  console.log(JSON.stringify({
    laneName: manifest.laneName,
    selectedCandidates: manifest.totals.selectedCandidates,
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
