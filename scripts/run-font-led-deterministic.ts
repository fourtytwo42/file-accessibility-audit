import { pathToFileURL } from 'node:url'
import { main as run } from './run-sub79-recovery-wave.ts'

if (!process.argv.includes('font-led-deterministic')) {
  process.argv.splice(2, 0, 'font-led-deterministic')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
