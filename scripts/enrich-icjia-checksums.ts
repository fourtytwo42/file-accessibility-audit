import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

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
  checksumState?: {
    checksumRecordedAt: string
    localCurrentFilePath: string | null
    localCurrentFileMd5: string | null
    localBackupFileMd5: string | null
    localMirrorFileMd5: string | null
    replacementCandidatePath: string | null
    replacementCandidateMd5: string | null
  }
}

type CompletePassingPublicationStatus = {
  publicationId: string
  publicationTitle: string
  fileUrl: string
  serverHost: string
  sshTarget: string
  remotePath: string
  stagedReplacementPath: string
  sourceCompleteFileName: string
  sourceCompleteFilePath: string
  status: string
  matchStrategy: string
  recordedAt: string
  replacedAt?: string
  replacementVerification?: {
    beforeUrlMd5?: string
    replacementFileMd5?: string
    afterUrlMd5?: string
    httpStatus?: number
    remoteBackupPath?: string
  }
  checksumState?: {
    checksumRecordedAt: string
    localCurrentFilePath: string | null
    localCurrentFileMd5: string | null
    replacementCandidatePath: string | null
    replacementCandidateMd5: string | null
    currentRemoteMd5: string | null
  }
}

type CompletePassingReplacementManifest = {
  stagedEntries: Array<{
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
    status: string
    matchStrategy: string
    recordedAt: string
    replacedAt?: string
    replacementVerification?: {
      beforeUrlMd5?: string
      replacementFileMd5?: string
      afterUrlMd5?: string
      httpStatus?: number
      remoteBackupPath?: string
    }
    checksumState?: {
      checksumRecordedAt: string
      localCurrentFilePath: string | null
      localCurrentFileMd5: string | null
      replacementCandidatePath: string | null
      replacementCandidateMd5: string | null
      currentRemoteMd5: string | null
    }
  }>
  unmatchedEntries: Array<Record<string, unknown>>
}

type ChecksumSummary = {
  generatedAt: string
  replacementMapPath: string
  completeStatusPath: string
  completeReplacementsPath: string
  replacementMap: {
    totalRows: number
    rowsWithCurrentMd5: number
    rowsWithReplacementCandidateMd5: number
  }
  completePassingStatus: {
    totalRows: number
    rowsWithCurrentMd5: number
    rowsWithReplacementCandidateMd5: number
    rowsWithCurrentRemoteMd5: number
  }
  completePassingReplacements: {
    totalRows: number
    rowsWithCurrentMd5: number
    rowsWithReplacementCandidateMd5: number
    rowsWithCurrentRemoteMd5: number
  }
}

const repoRoot = '/home/hendo420/pdfaf'
const icjiaRoot = path.join(repoRoot, 'ICJIA-PDFs')
const manifestsDir = path.join(icjiaRoot, 'manifests')
const replacementMapPath = path.join(manifestsDir, 'publication-pdf-replacement-map.json')
const completeStatusPath = path.join(manifestsDir, 'complete-passing-publication-status.json')
const completeReplacementsPath = path.join(manifestsDir, 'complete-passing-replacements.json')
const summaryPath = path.join(manifestsDir, 'checksum-enrichment.summary.json')
const serverCacheRoot = path.join(icjiaRoot, 'backups', 'server-cache')

const serverRoots: Record<string, string> = {
  '143.244.146.43': '/home/forge/archive.icjia-api.cloud/root/files',
  '192.241.146.85': '/home/forge/agency.icjia-api.cloud/agency-api/public/uploads',
  '157.230.3.215': '/home/forge/researchhub.icjia-api.cloud/researchhub/public/uploads',
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

function md5File(filePath: string): string | null {
  if (!filePath || !fs.existsSync(filePath)) return null
  const hash = crypto.createHash('md5')
  const buffer = fs.readFileSync(filePath)
  hash.update(buffer)
  return hash.digest('hex')
}

function deriveLocalCurrentPath(serverHost: string | null, remotePath: string | null): string | null {
  if (!serverHost || !remotePath) return null
  const remoteRoot = serverRoots[serverHost]
  if (!remoteRoot) return null
  const relative = path.posix.relative(remoteRoot, remotePath)
  if (!relative || relative.startsWith('..')) return null
  const candidate = path.join(serverCacheRoot, serverHost, ...relative.split('/'))
  return fs.existsSync(candidate) ? candidate : null
}

function enrichReplacementMap(rows: ReplacementMapRow[], checksumRecordedAt: string): ReplacementMapRow[] {
  return rows.map(row => {
    const localCurrentFilePath = deriveLocalCurrentPath(row.serverHost, row.remotePath)
    const localCurrentFileMd5 = md5File(localCurrentFilePath)
    const localBackupFileMd5 = md5File(row.localBackupPath)
    const localMirrorFileMd5 = md5File(row.localServerMirrorPath)
    const replacementCandidatePath = row.localWorkingPath
    const replacementCandidateMd5 = md5File(replacementCandidatePath)

    return {
      ...row,
      checksumState: {
        checksumRecordedAt,
        localCurrentFilePath,
        localCurrentFileMd5,
        localBackupFileMd5,
        localMirrorFileMd5,
        replacementCandidatePath,
        replacementCandidateMd5,
      },
    }
  })
}

function enrichCompleteStatus(
  rows: CompletePassingPublicationStatus[],
  checksumRecordedAt: string,
): CompletePassingPublicationStatus[] {
  return rows.map(row => {
    const localCurrentFilePath = deriveLocalCurrentPath(row.serverHost, row.remotePath)
    const localCurrentFileMd5 = md5File(localCurrentFilePath)
    const replacementCandidatePath = row.stagedReplacementPath || row.sourceCompleteFilePath
    const replacementCandidateMd5 = md5File(replacementCandidatePath) ?? md5File(row.sourceCompleteFilePath)
    const currentRemoteMd5 = row.replacementVerification?.afterUrlMd5 ?? null

    return {
      ...row,
      checksumState: {
        checksumRecordedAt,
        localCurrentFilePath,
        localCurrentFileMd5,
        replacementCandidatePath,
        replacementCandidateMd5,
        currentRemoteMd5,
      },
    }
  })
}

function enrichCompleteReplacements(
  manifest: CompletePassingReplacementManifest,
  checksumRecordedAt: string,
): CompletePassingReplacementManifest {
  return {
    ...manifest,
    stagedEntries: manifest.stagedEntries.map(entry => {
      const localCurrentFilePath = deriveLocalCurrentPath(entry.serverHost, entry.remotePath)
      const localCurrentFileMd5 = md5File(localCurrentFilePath)
      const replacementCandidatePath = entry.stagedReplacementPath || entry.completeFilePath
      const replacementCandidateMd5 = md5File(replacementCandidatePath) ?? md5File(entry.completeFilePath)
      const currentRemoteMd5 = entry.replacementVerification?.afterUrlMd5 ?? null

      return {
        ...entry,
        checksumState: {
          checksumRecordedAt,
          localCurrentFilePath,
          localCurrentFileMd5,
          replacementCandidatePath,
          replacementCandidateMd5,
          currentRemoteMd5,
        },
      }
    }),
  }
}

function countTruthy<T>(rows: T[], selector: (row: T) => string | null | undefined): number {
  return rows.reduce((count, row) => count + (selector(row) ? 1 : 0), 0)
}

function main(): void {
  const checksumRecordedAt = new Date().toISOString()

  const replacementMap = enrichReplacementMap(readJson<ReplacementMapRow[]>(replacementMapPath), checksumRecordedAt)
  const completeStatus = enrichCompleteStatus(
    readJson<CompletePassingPublicationStatus[]>(completeStatusPath),
    checksumRecordedAt,
  )
  const completeReplacements = enrichCompleteReplacements(
    readJson<CompletePassingReplacementManifest>(completeReplacementsPath),
    checksumRecordedAt,
  )

  writeJson(replacementMapPath, replacementMap)
  writeJson(completeStatusPath, completeStatus)
  writeJson(completeReplacementsPath, completeReplacements)

  const summary: ChecksumSummary = {
    generatedAt: checksumRecordedAt,
    replacementMapPath,
    completeStatusPath,
    completeReplacementsPath,
    replacementMap: {
      totalRows: replacementMap.length,
      rowsWithCurrentMd5: countTruthy(replacementMap, row => row.checksumState?.localCurrentFileMd5),
      rowsWithReplacementCandidateMd5: countTruthy(replacementMap, row => row.checksumState?.replacementCandidateMd5),
    },
    completePassingStatus: {
      totalRows: completeStatus.length,
      rowsWithCurrentMd5: countTruthy(completeStatus, row => row.checksumState?.localCurrentFileMd5),
      rowsWithReplacementCandidateMd5: countTruthy(completeStatus, row => row.checksumState?.replacementCandidateMd5),
      rowsWithCurrentRemoteMd5: countTruthy(completeStatus, row => row.checksumState?.currentRemoteMd5),
    },
    completePassingReplacements: {
      totalRows: completeReplacements.stagedEntries.length,
      rowsWithCurrentMd5: countTruthy(completeReplacements.stagedEntries, row => row.checksumState?.localCurrentFileMd5),
      rowsWithReplacementCandidateMd5: countTruthy(
        completeReplacements.stagedEntries,
        row => row.checksumState?.replacementCandidateMd5,
      ),
      rowsWithCurrentRemoteMd5: countTruthy(
        completeReplacements.stagedEntries,
        row => row.checksumState?.currentRemoteMd5,
      ),
    },
  }

  writeJson(summaryPath, summary)
  console.log(JSON.stringify(summary, null, 2))
}

main()
