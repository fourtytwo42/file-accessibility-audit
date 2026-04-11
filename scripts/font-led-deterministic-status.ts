import { pathToFileURL } from 'node:url'
import { main as status } from './sub79-recovery-wave-status.ts'

if (!process.argv.includes('font-led-deterministic')) {
  process.argv.splice(2, 0, 'font-led-deterministic')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  status().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
