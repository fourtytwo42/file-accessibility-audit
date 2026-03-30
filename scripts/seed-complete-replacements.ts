import fs from 'node:fs'
import path from 'node:path'

type ReplacementMapRow = {
  publicationId: string
  title: string
  slug: string | null
  fileUrl: string
  fileHost: string
  storageKind: 'legacy_archive' | 'agency_upload' | 'researchhub_upload' | 'other_pdf'
  replaceVia: 'sftp'
  serverHost: string | null
  sshTarget: string | null
  remotePath: string | null
  remoteDir: string | null
  localWorkingPath: string | null
  localBackupPath: string | null
  localServerMirrorPath: string | null
  expectedPresence: 'present' | 'missing' | 'unknown'
  notes: string
}

type CompleteFileRecord = {
  fileName: string
  absolutePath: string
  canonicalKey: string
  variantIndex: number
  sortKey: string
}

type TargetRecord = {
  canonicalKey: string
  remoteKey: string
  serverHost: string
  remotePath: string
  rows: ReplacementMapRow[]
  sortKey: string
}

type SeedEntry = {
  completeFileName: string
  completeFilePath: string
  canonicalKey: string
  variantIndex: number
  serverHost: string
  sshTarget: string
  remotePath: string
  stagedReplacementPath: string
  publicationIds: string[]
  publicationTitles: string[]
  fileUrls: string[]
  status: 'passing_from_complete'
  matchStrategy: 'direct' | 'variant-paired'
  recordedAt: string
}

type UnmatchedEntry = {
  completeFileName: string
  completeFilePath: string
  canonicalKey: string
  variantIndex: number
  reason: string
}

type Summary = {
  generatedAt: string
  completeDir: string
  replacementMapPath: string
  stagedCount: number
  unmatchedCount: number
  byServerHost: Record<string, number>
  outputs: {
    manifestJson: string
    publicationStatusJson: string
    summaryJson: string
    csv: string
  }
}

const repoRoot = '/home/hendo420/pdfaf'
const completeDir = path.join(repoRoot, 'Complete')
const icjiaRoot = path.join(repoRoot, 'ICJIA-PDFs')
const replacementMapPath = path.join(icjiaRoot, 'manifests', 'publication-pdf-replacement-map.json')
const manifestPath = path.join(icjiaRoot, 'manifests', 'complete-passing-replacements.json')
const publicationStatusPath = path.join(icjiaRoot, 'manifests', 'complete-passing-publication-status.json')
const summaryPath = path.join(icjiaRoot, 'manifests', 'complete-passing-replacements.summary.json')
const csvPath = path.join(icjiaRoot, 'reports', 'exports', 'csv', 'complete-passing-replacements.csv')
const stagingRoot = path.join(icjiaRoot, 'staging', 'to-replace')

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function normalizeBaseName(name: string): string {
  return path
    .basename(name)
    .replace(/\.pdf$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function canonicalizeFileName(name: string): { canonicalKey: string; variantIndex: number } {
  const base = path.basename(name).replace(/\.pdf$/i, '')
  const match = base.match(/^(.*?)-(\d+)$/)
  if (!match) {
    return {
      canonicalKey: normalizeBaseName(base),
      variantIndex: 1,
    }
  }

  return {
    canonicalKey: normalizeBaseName(match[1]),
    variantIndex: Number(match[2]),
  }
}

function stagePathFor(serverHost: string, remotePath: string): string {
  const relativeParts = remotePath.split('/').filter(Boolean)
  return path.join(stagingRoot, serverHost, ...relativeParts)
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function copyFile(from: string, to: string): void {
  ensureDir(path.dirname(to))
  fs.copyFileSync(from, to)
}

function buildTargetGroups(rows: ReplacementMapRow[]): Map<string, TargetRecord[]> {
  const groups = new Map<string, Map<string, TargetRecord>>()

  for (const row of rows) {
    if (!row.serverHost || !row.remotePath || row.expectedPresence === 'missing') continue
    const fileName = path.basename(row.remotePath)
    const { canonicalKey } = canonicalizeFileName(fileName)
    const remoteKey = `${row.serverHost}:${row.remotePath}`

    if (!groups.has(canonicalKey)) groups.set(canonicalKey, new Map())
    const group = groups.get(canonicalKey)!

    if (!group.has(remoteKey)) {
      group.set(remoteKey, {
        canonicalKey,
        remoteKey,
        serverHost: row.serverHost,
        remotePath: row.remotePath,
        rows: [],
        sortKey: `${normalizeBaseName(fileName)}::${row.remotePath}`,
      })
    }

    group.get(remoteKey)!.rows.push(row)
  }

  const result = new Map<string, TargetRecord[]>()
  for (const [canonicalKey, group] of groups.entries()) {
    result.set(
      canonicalKey,
      [...group.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.remotePath.localeCompare(b.remotePath)),
    )
  }
  return result
}

function buildCompleteGroups(): Map<string, CompleteFileRecord[]> {
  const files = fs
    .readdirSync(completeDir)
    .filter(fileName => /\.pdf$/i.test(fileName))
    .sort((a, b) => a.localeCompare(b))

  const groups = new Map<string, CompleteFileRecord[]>()

  for (const fileName of files) {
    const { canonicalKey, variantIndex } = canonicalizeFileName(fileName)
    const record: CompleteFileRecord = {
      fileName,
      absolutePath: path.join(completeDir, fileName),
      canonicalKey,
      variantIndex,
      sortKey: `${String(variantIndex).padStart(4, '0')}::${fileName.toLowerCase()}`,
    }
    if (!groups.has(canonicalKey)) groups.set(canonicalKey, [])
    groups.get(canonicalKey)!.push(record)
  }

  for (const group of groups.values()) {
    group.sort((a, b) => a.sortKey.localeCompare(b.sortKey))
  }

  return groups
}

function main(): void {
  ensureDir(path.dirname(manifestPath))
  ensureDir(path.dirname(csvPath))
  ensureDir(stagingRoot)

  const replacementRows = readJson<ReplacementMapRow[]>(replacementMapPath)
  const targetGroups = buildTargetGroups(replacementRows)
  const completeGroups = buildCompleteGroups()

  const stagedEntries: SeedEntry[] = []
  const unmatchedEntries: UnmatchedEntry[] = []
  const byServerHost: Record<string, number> = {}

  for (const [canonicalKey, completeFiles] of completeGroups.entries()) {
    const targets = targetGroups.get(canonicalKey) ?? []

    if (targets.length === 0) {
      for (const completeFile of completeFiles) {
        unmatchedEntries.push({
          completeFileName: completeFile.fileName,
          completeFilePath: completeFile.absolutePath,
          canonicalKey,
          variantIndex: completeFile.variantIndex,
          reason: 'No publication-backed remote target matched this Complete file.',
        })
      }
      continue
    }

    if (targets.length === 1) {
      const completeFile = completeFiles[0]
      const target = targets[0]
      const stagedPath = stagePathFor(target.serverHost, target.remotePath)
      copyFile(completeFile.absolutePath, stagedPath)

      stagedEntries.push({
        completeFileName: completeFile.fileName,
        completeFilePath: completeFile.absolutePath,
        canonicalKey,
        variantIndex: completeFile.variantIndex,
        serverHost: target.serverHost,
        sshTarget: target.rows[0].sshTarget ?? '',
        remotePath: target.remotePath,
        stagedReplacementPath: stagedPath,
        publicationIds: target.rows.map(row => row.publicationId),
        publicationTitles: target.rows.map(row => row.title),
        fileUrls: target.rows.map(row => row.fileUrl),
        status: 'passing_from_complete',
        matchStrategy: 'direct',
        recordedAt: new Date().toISOString(),
      })

      byServerHost[target.serverHost] = (byServerHost[target.serverHost] ?? 0) + 1

      for (const extraFile of completeFiles.slice(1)) {
        unmatchedEntries.push({
          completeFileName: extraFile.fileName,
          completeFilePath: extraFile.absolutePath,
          canonicalKey,
          variantIndex: extraFile.variantIndex,
          reason: 'Extra Complete variant found, but only one remote target exists.',
        })
      }
      continue
    }

    if (completeFiles.length >= targets.length) {
      for (let index = 0; index < targets.length; index += 1) {
        const completeFile = completeFiles[index]
        const target = targets[index]
        const stagedPath = stagePathFor(target.serverHost, target.remotePath)
        copyFile(completeFile.absolutePath, stagedPath)

        stagedEntries.push({
          completeFileName: completeFile.fileName,
          completeFilePath: completeFile.absolutePath,
          canonicalKey,
          variantIndex: completeFile.variantIndex,
          serverHost: target.serverHost,
          sshTarget: target.rows[0].sshTarget ?? '',
          remotePath: target.remotePath,
          stagedReplacementPath: stagedPath,
          publicationIds: target.rows.map(row => row.publicationId),
          publicationTitles: target.rows.map(row => row.title),
          fileUrls: target.rows.map(row => row.fileUrl),
          status: 'passing_from_complete',
          matchStrategy: 'variant-paired',
          recordedAt: new Date().toISOString(),
        })

        byServerHost[target.serverHost] = (byServerHost[target.serverHost] ?? 0) + 1
      }

      for (const extraFile of completeFiles.slice(targets.length)) {
        unmatchedEntries.push({
          completeFileName: extraFile.fileName,
          completeFilePath: extraFile.absolutePath,
          canonicalKey,
          variantIndex: extraFile.variantIndex,
          reason: 'More Complete variants exist than remote targets for this canonical filename.',
        })
      }
      continue
    }

    for (const completeFile of completeFiles) {
      unmatchedEntries.push({
        completeFileName: completeFile.fileName,
        completeFilePath: completeFile.absolutePath,
        canonicalKey,
        variantIndex: completeFile.variantIndex,
        reason: 'Multiple remote targets exist, but not enough Complete variants were available to assign confidently.',
      })
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify({ stagedEntries, unmatchedEntries }, null, 2) + '\n')

  const publicationStatus = stagedEntries.flatMap(entry =>
    entry.publicationIds.map((publicationId, index) => ({
      publicationId,
      publicationTitle: entry.publicationTitles[index] ?? entry.publicationTitles[0] ?? '',
      fileUrl: entry.fileUrls[index] ?? entry.fileUrls[0] ?? '',
      serverHost: entry.serverHost,
      sshTarget: entry.sshTarget,
      remotePath: entry.remotePath,
      stagedReplacementPath: entry.stagedReplacementPath,
      sourceCompleteFileName: entry.completeFileName,
      sourceCompleteFilePath: entry.completeFilePath,
      status: 'passing_from_complete' as const,
      matchStrategy: entry.matchStrategy,
      recordedAt: entry.recordedAt,
    })),
  )
  fs.writeFileSync(publicationStatusPath, JSON.stringify(publicationStatus, null, 2) + '\n')

  const csvHeaders = [
    'completeFileName',
    'serverHost',
    'remotePath',
    'stagedReplacementPath',
    'publicationIds',
    'status',
    'matchStrategy',
  ]
  const csvLines = [
    csvHeaders.join(','),
    ...stagedEntries.map(entry =>
      [
        csvEscape(entry.completeFileName),
        csvEscape(entry.serverHost),
        csvEscape(entry.remotePath),
        csvEscape(entry.stagedReplacementPath),
        csvEscape(entry.publicationIds.join('|')),
        csvEscape(entry.status),
        csvEscape(entry.matchStrategy),
      ].join(','),
    ),
  ]
  fs.writeFileSync(csvPath, csvLines.join('\n') + '\n')

  const summary: Summary = {
    generatedAt: new Date().toISOString(),
    completeDir,
    replacementMapPath,
    stagedCount: stagedEntries.length,
    unmatchedCount: unmatchedEntries.length,
    byServerHost,
    outputs: {
      manifestJson: manifestPath,
      publicationStatusJson: publicationStatusPath,
      summaryJson: summaryPath,
      csv: csvPath,
    },
  }

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify(summary, null, 2))
}

main()
