import { pathToFileURL } from 'node:url'
import { runPassRateProofLoop } from './run-pass-rate-proof-loop-common.ts'

export async function main(): Promise<void> {
  await runPassRateProofLoop({
    sliceName: 'runtime-tail-figure-retry',
    reportRootName: 'runtime-tail-figure-retry',
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
