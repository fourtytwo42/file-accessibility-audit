import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = '/home/hendo420/pdfaf'
const logsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'logs')
const pidPath = path.join(logsRoot, 'runtime-tail-retry-wave-overnight.pid')
const metaPath = path.join(logsRoot, 'runtime-tail-retry-wave-overnight.json')

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

export async function main(): Promise<void> {
  const pidRaw = fs.existsSync(pidPath) ? fs.readFileSync(pidPath, 'utf8').trim() : ''
  const pid = Number(pidRaw)
  const meta = readJsonIfExists<Record<string, unknown>>(metaPath)
  const overnightSummaryPath = typeof meta?.overnightSummaryPath === 'string'
    ? meta.overnightSummaryPath
    : null
  const overnightSummary = overnightSummaryPath
    ? readJsonIfExists<Record<string, unknown>>(overnightSummaryPath)
    : null

  console.log(JSON.stringify({
    pid: Number.isFinite(pid) && pid > 0 ? pid : null,
    running: Number.isFinite(pid) && pid > 0 ? processIsAlive(pid) : false,
    metadata: meta,
    overnightSummary,
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
