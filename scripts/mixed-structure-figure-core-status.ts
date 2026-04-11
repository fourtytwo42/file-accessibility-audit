import { pathToFileURL } from 'node:url'
import { main as status } from './sub79-recovery-wave-status.ts'

if (!process.argv.includes('mixed-structure-figure-core')) {
  process.argv.splice(2, 0, 'mixed-structure-figure-core')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  status().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
