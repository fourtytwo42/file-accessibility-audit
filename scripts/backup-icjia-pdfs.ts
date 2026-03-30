import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

type Publication = {
  id: string
  title: string
  fileURL: string | null
}

type BackupRecord = {
  publicationId: string
  title: string
  sourceUrl: string
  category: 'legacy_archive' | 'strapi_upload' | 'other_pdf'
  localPath: string
  sizeBytes: number | null
  status: 'downloaded' | 'skipped-existing' | 'failed'
  httpStatus: number | null
  error: string | null
  recordedAt: string
}

const repoRoot = '/home/hendo420/pdfaf'
const dumpRoot = path.join(repoRoot, 'ICJIA-PDFs', 'backups', 'api-dumps', '2026-03-25T21-19-49-164Z')
const publicationsPath = path.join(dumpRoot, 'publications.json')
const backupRoot = path.join(repoRoot, 'ICJIA-PDFs', 'backups', 'original-pdfs')
const manifestDir = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')
const logDir = path.join(repoRoot, 'ICJIA-PDFs', 'logs')
const statePath = path.join(manifestDir, 'pdf-backup-state.json')
const jsonlPath = path.join(logDir, 'pdf-backup-events.jsonl')
const summaryPath = path.join(manifestDir, 'pdf-backup-summary.json')
const concurrency = Number(process.env.ICJIA_BACKUP_CONCURRENCY || 4)

function classify(url: string): 'legacy_archive' | 'strapi_upload' | 'other_pdf' {
  if (/\/uploads\//i.test(url)) return 'strapi_upload'
  if (/\/files\//i.test(url)) return 'legacy_archive'
  return 'other_pdf'
}

function safeSegment(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed'
}

function localPathFor(urlString: string, category: 'legacy_archive' | 'strapi_upload' | 'other_pdf'): string {
  const url = new URL(urlString)
  const parts = url.pathname.split('/').filter(Boolean)
  const relativeParts =
    category === 'legacy_archive'
      ? parts.slice(3)
      : category === 'strapi_upload'
        ? parts.slice(1)
        : parts
  const cleaned = relativeParts.map(safeSegment)
  return path.join(backupRoot, category, ...cleaned)
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

async function downloadOne(pub: Publication): Promise<BackupRecord> {
  const sourceUrl = pub.fileURL!
  const category = classify(sourceUrl)
  const localPath = localPathFor(sourceUrl, category)
  fs.mkdirSync(path.dirname(localPath), { recursive: true })

  if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) {
    return {
      publicationId: pub.id,
      title: pub.title,
      sourceUrl,
      category,
      localPath,
      sizeBytes: fs.statSync(localPath).size,
      status: 'skipped-existing',
      httpStatus: 200,
      error: null,
      recordedAt: new Date().toISOString(),
    }
  }

  const response = await fetch(sourceUrl)
  if (!response.ok || !response.body) {
    return {
      publicationId: pub.id,
      title: pub.title,
      sourceUrl,
      category,
      localPath,
      sizeBytes: null,
      status: 'failed',
      httpStatus: response.status,
      error: `HTTP ${response.status}`,
      recordedAt: new Date().toISOString(),
    }
  }

  const tempPath = `${localPath}.part`
  const writeStream = fs.createWriteStream(tempPath)
  await pipeline(response.body as any, writeStream)
  fs.renameSync(tempPath, localPath)
  const sizeBytes = fs.statSync(localPath).size

  return {
    publicationId: pub.id,
    title: pub.title,
    sourceUrl,
    category,
    localPath,
    sizeBytes,
    status: 'downloaded',
    httpStatus: response.status,
    error: null,
    recordedAt: new Date().toISOString(),
  }
}

async function main() {
  fs.mkdirSync(backupRoot, { recursive: true })
  fs.mkdirSync(manifestDir, { recursive: true })
  fs.mkdirSync(logDir, { recursive: true })

  const publications = readJson<Publication[]>(publicationsPath, [])
  const pdfs = publications.filter(pub => typeof pub.fileURL === 'string' && /\.pdf(\?|#|$)/i.test(pub.fileURL))
  const completed = new Set(readJson<string[]>(statePath, []))

  let downloaded = 0
  let skippedExisting = 0
  let failed = 0
  let index = 0

  async function worker() {
    while (index < pdfs.length) {
      const current = pdfs[index++]
      if (completed.has(current.id)) continue
      let record: BackupRecord
      try {
        record = await downloadOne(current)
      } catch (error) {
        record = {
          publicationId: current.id,
          title: current.title,
          sourceUrl: current.fileURL!,
          category: classify(current.fileURL!),
          localPath: localPathFor(current.fileURL!, classify(current.fileURL!)),
          sizeBytes: null,
          status: 'failed',
          httpStatus: null,
          error: error instanceof Error ? error.message : String(error),
          recordedAt: new Date().toISOString(),
        }
      }

      fs.appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`)
      completed.add(current.id)
      writeJson(statePath, [...completed])

      if (record.status === 'downloaded') downloaded += 1
      else if (record.status === 'skipped-existing') skippedExisting += 1
      else failed += 1

      const done = downloaded + skippedExisting + failed
      console.log(`[backup] ${done}/${pdfs.length} ${record.status} ${path.basename(record.localPath)}`)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  const summary = {
    recordedAt: new Date().toISOString(),
    sourceDump: publicationsPath,
    totalPdfRows: pdfs.length,
    completedPublicationIds: completed.size,
    downloaded,
    skippedExisting,
    failed,
    backupRoot,
    eventsPath: jsonlPath,
    statePath,
  }
  writeJson(summaryPath, summary)
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
