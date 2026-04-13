import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const repoRoot = '/home/hendo420/pdfaf'
const logsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'logs')
const pidPath = path.join(logsRoot, 'runtime-tail-retry-wave-overnight.pid')
const metaPath = path.join(logsRoot, 'runtime-tail-retry-wave-overnight.json')

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

function timestampLabel(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readExistingPid(): number | null {
  if (!fs.existsSync(pidPath)) return null
  const raw = fs.readFileSync(pidPath, 'utf8').trim()
  const pid = Number(raw)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

export async function main(): Promise<void> {
  ensureDir(logsRoot)

  const existingPid = readExistingPid()
  if (existingPid && processIsAlive(existingPid)) {
    const existingMeta = fs.existsSync(metaPath)
      ? JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      : null
    console.log(JSON.stringify({
      started: false,
      reason: 'runtime_tail_overnight_already_running',
      pid: existingPid,
      metadata: existingMeta,
    }, null, 2))
    return
  }

  const startedAt = new Date()
  const sliceName = process.env.ICJIA_RUNTIME_TAIL_OVERNIGHT_SLICE || 'runtime-tail-mixed-terminalization'
  const logPath = path.join(logsRoot, `runtime-tail-overnight-${safeStem(sliceName)}-${timestampLabel(startedAt)}.log`)
  const out = fs.openSync(logPath, 'a')

  const child = spawn('pnpm', ['exec', 'tsx', 'scripts/run-runtime-tail-overnight-pipeline.ts'], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      ICJIA_RUNTIME_TAIL_OVERNIGHT_SLICE: sliceName,
    },
  })

  child.unref()

  fs.writeFileSync(pidPath, `${child.pid}\n`)
  const metadata = {
    startedAt: startedAt.toISOString(),
    pid: child.pid,
    sliceName,
    logPath,
    command: 'pnpm exec tsx scripts/run-runtime-tail-overnight-pipeline.ts',
    manifestPath: path.join(repoRoot, 'ICJIA-PDFs', 'manifests', `${sliceName}.json`),
    overnightSummaryPath: path.join(repoRoot, 'ICJIA-PDFs', 'manifests', `${sliceName}.overnight.summary.json`),
  }
  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n')

  console.log(JSON.stringify({
    started: true,
    ...metadata,
  }, null, 2))
}

function safeStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'runtime-tail'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
