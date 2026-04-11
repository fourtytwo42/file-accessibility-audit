import { pathToFileURL } from 'node:url'
import { main as run } from './run-sub79-recovery-wave.ts'

if (!process.argv.includes('mixed-structure-figure-core')) {
  process.argv.splice(2, 0, 'mixed-structure-figure-core')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
