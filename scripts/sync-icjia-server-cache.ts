import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

type ReplacementMapRow = {
  publicationId: string
  title: string
  fileUrl: string
  storageKind: 'legacy_archive' | 'agency_upload' | 'researchhub_upload' | 'other_pdf'
  serverHost: string | null
  sshTarget: string | null
  remotePath: string | null
  expectedPresence: 'present' | 'missing' | 'unknown'
}

type ServerConfig = {
  host: string
  sshTarget: string
  remoteRoot: string
  localRoot: string
  manifestPath: string
}

type SyncSummary = {
  generatedAt: string
  replacementMapPath: string
  sshKeyPath: string
  servers: Array<{
    host: string
    sshTarget: string
    remoteRoot: string
    localRoot: string
    fileCount: number
    skippedMissing: number
  }>
  summaryByHost: Record<string, { syncedTargets: number; skippedMissing: number }>
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const envPath = path.join(repoRoot, '.env')

if (fs.existsSync(envPath)) {
  const envText = fs.readFileSync(envPath, 'utf8')
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1)
    if (!(key in process.env)) process.env[key] = value
  }
}

const icjiaRoot = path.join(repoRoot, 'ICJIA-PDFs')
const replacementMapPath = path.join(icjiaRoot, 'manifests', 'publication-pdf-replacement-map.json')
const cacheRoot = path.join(icjiaRoot, 'backups', 'server-cache')
const manifestRoot = path.join(icjiaRoot, 'manifests', 'server-cache')
const summaryPath = path.join(manifestRoot, 'server-cache-sync.summary.json')

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

function normalizePosixRelative(fullPath: string, remoteRoot: string): string {
  const relative = path.posix.relative(remoteRoot, fullPath)
  if (!relative || relative.startsWith('..')) {
    throw new Error(`Remote path ${fullPath} is not under expected root ${remoteRoot}`)
  }
  return relative
}

function runRsync(server: ServerConfig, sshKeyPath: string): void {
  ensureDir(server.localRoot)
  const sshCommand = `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=accept-new`
  const source = `${server.sshTarget}:${server.remoteRoot}/`

  const result = spawnSync(
    'rsync',
    [
      '-av',
      '--partial',
      '--files-from',
      server.manifestPath,
      '-e',
      sshCommand,
      source,
      server.localRoot,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'inherit',
    },
  )

  if (result.status !== 0) {
    throw new Error(`rsync failed for ${server.host} with exit code ${result.status ?? 'unknown'}`)
  }
}

function main(): void {
  const sshKeyPath = requireEnv('ICJIA_ARCHIVE_SSH_KEY_PATH')
  const rows = JSON.parse(fs.readFileSync(replacementMapPath, 'utf8')) as ReplacementMapRow[]

  ensureDir(cacheRoot)
  ensureDir(manifestRoot)

  const serverConfigs: Record<string, ServerConfig> = {
    '143.244.146.43': {
      host: '143.244.146.43',
      sshTarget: 'forge@143.244.146.43',
      remoteRoot: '/home/forge/archive.icjia-api.cloud/root/files',
      localRoot: path.join(cacheRoot, '143.244.146.43'),
      manifestPath: path.join(manifestRoot, '143.244.146.43.files-from.txt'),
    },
    '192.241.146.85': {
      host: '192.241.146.85',
      sshTarget: 'forge@192.241.146.85',
      remoteRoot: '/home/forge/agency.icjia-api.cloud/agency-api/public/uploads',
      localRoot: path.join(cacheRoot, '192.241.146.85'),
      manifestPath: path.join(manifestRoot, '192.241.146.85.files-from.txt'),
    },
    '157.230.3.215': {
      host: '157.230.3.215',
      sshTarget: 'forge@157.230.3.215',
      remoteRoot: '/home/forge/researchhub.icjia-api.cloud/researchhub/public/uploads',
      localRoot: path.join(cacheRoot, '157.230.3.215'),
      manifestPath: path.join(manifestRoot, '157.230.3.215.files-from.txt'),
    },
  }

  const pathsByHost = new Map<string, Set<string>>()
  const skippedMissingByHost = new Map<string, number>()

  for (const row of rows) {
    if (!row.serverHost || !row.remotePath) continue
    if (row.expectedPresence === 'missing') {
      skippedMissingByHost.set(row.serverHost, (skippedMissingByHost.get(row.serverHost) ?? 0) + 1)
      continue
    }

    const config = serverConfigs[row.serverHost]
    if (!config) continue

    const relativePath = normalizePosixRelative(row.remotePath, config.remoteRoot)
    if (!pathsByHost.has(row.serverHost)) pathsByHost.set(row.serverHost, new Set<string>())
    pathsByHost.get(row.serverHost)!.add(relativePath)
  }

  const summaryByHost: Record<string, { syncedTargets: number; skippedMissing: number }> = {}
  const servers: SyncSummary['servers'] = []

  for (const [host, config] of Object.entries(serverConfigs)) {
    const entries = [...(pathsByHost.get(host) ?? new Set<string>())].sort()
    fs.writeFileSync(config.manifestPath, entries.join('\n') + (entries.length ? '\n' : ''))

    summaryByHost[host] = {
      syncedTargets: entries.length,
      skippedMissing: skippedMissingByHost.get(host) ?? 0,
    }

    servers.push({
      host,
      sshTarget: config.sshTarget,
      remoteRoot: config.remoteRoot,
      localRoot: config.localRoot,
      fileCount: entries.length,
      skippedMissing: skippedMissingByHost.get(host) ?? 0,
    })
  }

  for (const server of servers) {
    if (!server.fileCount) continue
    runRsync(serverConfigs[server.host], sshKeyPath)
  }

  const summary: SyncSummary = {
    generatedAt: new Date().toISOString(),
    replacementMapPath,
    sshKeyPath,
    servers,
    summaryByHost,
  }

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify(summary, null, 2))
}

main()
