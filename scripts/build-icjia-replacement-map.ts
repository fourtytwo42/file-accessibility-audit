import fs from 'node:fs'
import path from 'node:path'

type Publication = {
  id: string
  title: string
  slug?: string | null
  fileURL: string | null
}

type StorageKind = 'legacy_archive' | 'agency_upload' | 'researchhub_upload' | 'other_pdf'
type PresenceStatus = 'present' | 'missing' | 'unknown'

type ReplacementMapRow = {
  publicationId: string
  title: string
  slug: string | null
  fileUrl: string
  fileHost: string
  storageKind: StorageKind
  replaceVia: 'sftp'
  serverHost: string | null
  sshTarget: string | null
  remotePath: string | null
  remoteDir: string | null
  localWorkingPath: string | null
  localBackupPath: string | null
  localServerMirrorPath: string | null
  expectedPresence: PresenceStatus
  notes: string
}

type Summary = {
  generatedAt: string
  sourceDump: string
  totalPdfRows: number
  uniqueFileUrls: number
  byStorageKind: Record<StorageKind, number>
  byServerHost: Record<string, number>
  missingCount: number
  outputJson: string
  outputCsv: string
}

const repoRoot = '/home/hendo420/pdfaf'
const icjiaRoot = path.join(repoRoot, 'ICJIA-PDFs')
const apiDumpRoot = path.join(icjiaRoot, 'backups', 'api-dumps')
const manifestsDir = path.join(icjiaRoot, 'manifests')
const csvDir = path.join(icjiaRoot, 'reports', 'exports', 'csv')
const originalBackupRoot = path.join(icjiaRoot, 'backups', 'original-pdfs')
const legacyMirrorRoot = path.join(icjiaRoot, 'backups', 'server-mirror', 'icjia', 'pdf')

const legacyServer = {
  host: '143.244.146.43',
  sshTarget: 'forge@143.244.146.43',
  remoteRoot: '/home/forge/archive.icjia-api.cloud/root/files/icjia/pdf',
  filesRoot: '/home/forge/archive.icjia-api.cloud/root/files',
}

const agencyServer = {
  host: '192.241.146.85',
  sshTarget: 'forge@192.241.146.85',
  remoteRoot: '/home/forge/agency.icjia-api.cloud/agency-api/public/uploads',
}

const researchhubServer = {
  host: '157.230.3.215',
  sshTarget: 'forge@157.230.3.215',
  remoteRoot: '/home/forge/researchhub.icjia-api.cloud/researchhub/public/uploads',
}

const knownMissingResearchhubFiles = new Set([
  'FINAL PDF for posting-230915T15353341.pdf',
  'Illegal gun carrying article PDF for posting-220913T20573010.pdf',
  'R3 Program Grantmaking and Implementation ReportV2-230209T22371426.pdf',
])

function findLatestDumpDir(root: string): string {
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()

  if (!entries.length) {
    throw new Error(`No API dump directories found in ${root}`)
  }

  return path.join(root, entries[entries.length - 1])
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function csvEscape(value: string | null): string {
  const text = value ?? ''
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function localPathIfExists(filePath: string): string | null {
  return fs.existsSync(filePath) ? filePath : null
}

function firstExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function classifyRow(fileUrl: string): {
  storageKind: StorageKind
  serverHost: string | null
  sshTarget: string | null
  remotePath: string | null
  remoteDir: string | null
  localBackupPath: string | null
  localServerMirrorPath: string | null
  expectedPresence: PresenceStatus
  notes: string
} {
  const url = new URL(fileUrl)
  const pathname = url.pathname

  if (
    (url.host === 'archive.icjia-api.cloud' || url.host === 'archive.icjia.cloud') &&
    pathname.startsWith('/files/')
  ) {
    const filesRelativePath = decodePathSegment(pathname.replace(/^\/files\//, ''))
    const remotePath = path.posix.join(legacyServer.filesRoot, filesRelativePath)
    const localMirrorPath = filesRelativePath.startsWith('icjia/pdf/')
      ? path.join(legacyMirrorRoot, ...filesRelativePath.replace(/^icjia\/pdf\//, '').split('/'))
      : null
    const archiveFilename = path.basename(filesRelativePath)
    const localBackupPath = firstExistingPath([
      path.join(originalBackupRoot, 'legacy_archive', ...filesRelativePath.split('/')),
      path.join(originalBackupRoot, 'legacy_archive', archiveFilename),
    ])

    return {
      storageKind: 'legacy_archive',
      serverHost: legacyServer.host,
      sshTarget: legacyServer.sshTarget,
      remotePath,
      remoteDir: path.posix.dirname(remotePath),
      localBackupPath,
      localServerMirrorPath: localMirrorPath ? localPathIfExists(localMirrorPath) : null,
      expectedPresence: 'present',
      notes: 'Legacy archive PDF backed by archive.icjia-api.cloud filesystem.',
    }
  }

  if (url.host === 'agency.icjia-api.cloud' && pathname.startsWith('/uploads/')) {
    const filename = decodePathSegment(pathname.replace(/^\/uploads\//, ''))
    const remotePath = path.posix.join(agencyServer.remoteRoot, filename)
    const localBackupPath = path.join(originalBackupRoot, 'strapi_upload', filename)

    return {
      storageKind: 'agency_upload',
      serverHost: agencyServer.host,
      sshTarget: agencyServer.sshTarget,
      remotePath,
      remoteDir: path.posix.dirname(remotePath),
      localBackupPath: localPathIfExists(localBackupPath),
      localServerMirrorPath: null,
      expectedPresence: 'present',
      notes: 'Strapi-managed upload served from the agency uploads store.',
    }
  }

  if (url.host === 'researchhub.icjia-api.cloud' && pathname.startsWith('/uploads/')) {
    const filename = decodePathSegment(pathname.replace(/^\/uploads\//, ''))
    const remotePath = path.posix.join(researchhubServer.remoteRoot, filename)
    const localBackupPath = path.join(originalBackupRoot, 'strapi_upload', filename)
    const expectedPresence: PresenceStatus = knownMissingResearchhubFiles.has(filename) ? 'missing' : 'present'
    const notes =
      expectedPresence === 'missing'
        ? 'Known broken researchhub upload URL; publication record points to a missing file.'
        : 'Strapi-managed upload served from the researchhub uploads store.'

    return {
      storageKind: 'researchhub_upload',
      serverHost: researchhubServer.host,
      sshTarget: researchhubServer.sshTarget,
      remotePath,
      remoteDir: path.posix.dirname(remotePath),
      localBackupPath: localPathIfExists(localBackupPath),
      localServerMirrorPath: null,
      expectedPresence,
      notes,
    }
  }

  if (url.host === 'icjia.illinois.gov' && pathname.startsWith('/researchhub/files/')) {
    const filename = decodePathSegment(path.basename(pathname))
    const remotePath = path.posix.join(researchhubServer.remoteRoot, filename)
    const localBackupPath = firstExistingPath([
      path.join(originalBackupRoot, 'other_pdf', 'researchhub', 'files', filename),
      path.join(originalBackupRoot, 'other_pdf', filename),
      path.join(originalBackupRoot, 'strapi_upload', filename),
    ])

    return {
      storageKind: 'researchhub_upload',
      serverHost: researchhubServer.host,
      sshTarget: researchhubServer.sshTarget,
      remotePath,
      remoteDir: path.posix.dirname(remotePath),
      localBackupPath,
      localServerMirrorPath: null,
      expectedPresence: knownMissingResearchhubFiles.has(filename) ? 'missing' : 'present',
      notes: 'Legacy site researchhub file URL; replacement path maps to the researchhub uploads store.',
    }
  }

  const fallbackFilename = decodePathSegment(path.basename(pathname))

  return {
    storageKind: 'other_pdf',
    serverHost: null,
    sshTarget: null,
    remotePath: null,
    remoteDir: null,
    localBackupPath: localPathIfExists(path.join(originalBackupRoot, 'other_pdf', fallbackFilename)),
    localServerMirrorPath: null,
    expectedPresence: 'unknown',
    notes: 'PDF URL does not match the verified archive/agency/researchhub hosting patterns.',
  }
}

function main(): void {
  ensureDir(manifestsDir)
  ensureDir(csvDir)

  const latestDumpDir = findLatestDumpDir(apiDumpRoot)
  const publicationsPath = path.join(latestDumpDir, 'publications.json')
  const publications = readJson<Publication[]>(publicationsPath)

  const pdfRows = publications.filter(pub => typeof pub.fileURL === 'string' && /\.pdf(\?|#|$)/i.test(pub.fileURL))
  const mappedRows: ReplacementMapRow[] = pdfRows.map(pub => {
    const fileUrl = pub.fileURL as string
    const classification = classifyRow(fileUrl)

    return {
      publicationId: pub.id,
      title: pub.title,
      slug: pub.slug ?? null,
      fileUrl,
      fileHost: new URL(fileUrl).host,
      storageKind: classification.storageKind,
      replaceVia: 'sftp',
      serverHost: classification.serverHost,
      sshTarget: classification.sshTarget,
      remotePath: classification.remotePath,
      remoteDir: classification.remoteDir,
      localWorkingPath: null,
      localBackupPath: classification.localBackupPath,
      localServerMirrorPath: classification.localServerMirrorPath,
      expectedPresence: classification.expectedPresence,
      notes: classification.notes,
    }
  })

  const uniqueFileUrls = new Set(mappedRows.map(row => row.fileUrl)).size
  const byStorageKind: Record<StorageKind, number> = {
    legacy_archive: 0,
    agency_upload: 0,
    researchhub_upload: 0,
    other_pdf: 0,
  }
  const byServerHost: Record<string, number> = {}
  let missingCount = 0

  for (const row of mappedRows) {
    byStorageKind[row.storageKind] += 1
    if (row.serverHost) {
      byServerHost[row.serverHost] = (byServerHost[row.serverHost] ?? 0) + 1
    }
    if (row.expectedPresence === 'missing') missingCount += 1
  }

  const jsonPath = path.join(manifestsDir, 'publication-pdf-replacement-map.json')
  const csvPath = path.join(csvDir, 'publication-pdf-replacement-map.csv')
  const summaryPath = path.join(manifestsDir, 'publication-pdf-replacement-map.summary.json')

  fs.writeFileSync(jsonPath, `${JSON.stringify(mappedRows, null, 2)}\n`)

  const headers: Array<keyof ReplacementMapRow> = [
    'publicationId',
    'title',
    'slug',
    'fileUrl',
    'fileHost',
    'storageKind',
    'replaceVia',
    'serverHost',
    'sshTarget',
    'remotePath',
    'remoteDir',
    'localWorkingPath',
    'localBackupPath',
    'localServerMirrorPath',
    'expectedPresence',
    'notes',
  ]
  const csvLines = [
    headers.join(','),
    ...mappedRows.map(row => headers.map(header => csvEscape(row[header] as string | null)).join(',')),
  ]
  fs.writeFileSync(csvPath, `${csvLines.join('\n')}\n`)

  const summary: Summary = {
    generatedAt: new Date().toISOString(),
    sourceDump: publicationsPath,
    totalPdfRows: mappedRows.length,
    uniqueFileUrls,
    byStorageKind,
    byServerHost,
    missingCount,
    outputJson: jsonPath,
    outputCsv: csvPath,
  }
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)

  console.log(JSON.stringify(summary, null, 2))
}

main()
