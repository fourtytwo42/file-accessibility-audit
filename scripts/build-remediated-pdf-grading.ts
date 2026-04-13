import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

type HistoricalArtifactRecord = {
  artifactPath: string
  publicationId: string | null
  publicationTitle: string | null
  status: string | null
  sourceManifest: string
  processedAt: string | null
  overallScore: number | null
  grade: string | null
  pageCount: number | null
  isScanned: boolean | null
  resultBand: string | null
}

type GradingCandidate = {
  artifactPath: string
  relativeArtifactPath: string
  waveName: string
  publicationId: string | null
  publicationTitle: string | null
  filename: string
  historical: HistoricalArtifactRecord | null
}

type GradingManifest = {
  generatedAt: string
  artifactRoot: string
  sourceManifestPaths: string[]
  totals: {
    rawArtifactFiles: number
    totalCandidates: number
    withHistoricalRecord: number
    withHistoricalScore: number
    withoutHistoricalRecord: number
  }
  byWave: Record<string, number>
  candidates: GradingCandidate[]
}

const repoRoot = '/home/hendo420/pdfaf'
const icjiaRoot = path.join(repoRoot, 'ICJIA-PDFs')
const manifestsRoot = path.join(icjiaRoot, 'manifests')
const remediatedRoot = path.join(icjiaRoot, 'artifacts', 'remediated-pdfs')
const manifestPath = path.join(manifestsRoot, 'remediated-pdf-grading.json')
const summaryPath = path.join(manifestsRoot, 'remediated-pdf-grading.summary.json')

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

function normalizePath(value: string): string {
  return path.resolve(value)
}

function dateMs(value: string | null | undefined): number {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function inferPublicationIdFromFilename(filename: string): string | null {
  const match = path.basename(filename).match(/^(\d+)-/)
  return match ? match[1] : null
}

function inferPublicationTitleFromFilename(filename: string): string | null {
  const base = path.basename(filename, path.extname(filename))
  const parts = base.split('-')
  if (parts.length < 2) return null
  return parts.slice(1).join('-').replace(/_/g, ' ').trim() || null
}

function walkPdfFiles(root: string): string[] {
  const found: string[] = []

  function visit(dirPath: string): void {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        visit(fullPath)
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
        found.push(normalizePath(fullPath))
      }
    }
  }

  if (fs.existsSync(root)) visit(root)
  return found.sort((a, b) => a.localeCompare(b))
}

function isUnderRemediatedRoot(candidatePath: string | null | undefined): candidatePath is string {
  if (!candidatePath) return false
  const normalized = normalizePath(candidatePath)
  const root = normalizePath(remediatedRoot)
  return normalized.startsWith(`${root}${path.sep}`) || normalized === root
}

function chooseBetterHistoricalRecord(
  current: HistoricalArtifactRecord | undefined,
  next: HistoricalArtifactRecord,
): HistoricalArtifactRecord {
  if (!current) return next
  const nextScore = Number.isFinite(next.overallScore) ? Number(next.overallScore) : Number.NEGATIVE_INFINITY
  const currentScore = Number.isFinite(current.overallScore) ? Number(current.overallScore) : Number.NEGATIVE_INFINITY
  if (nextScore !== currentScore) return nextScore > currentScore ? next : current
  const nextMs = dateMs(next.processedAt)
  const currentMs = dateMs(current.processedAt)
  if (nextMs !== currentMs) return nextMs > currentMs ? next : current
  return next.sourceManifest.localeCompare(current.sourceManifest) >= 0 ? next : current
}

function extractHistoricalArtifactRows(): {
  artifactIndex: Map<string, HistoricalArtifactRecord>
  bestArtifactByPublication: Map<string, HistoricalArtifactRecord>
  sourceManifestPaths: string[]
} {
  const artifactIndex = new Map<string, HistoricalArtifactRecord>()
  const bestArtifactByPublication = new Map<string, HistoricalArtifactRecord>()
  const sourceManifestPaths: string[] = []
  const manifestFiles = fs.readdirSync(manifestsRoot)
    .filter(name => name === 'complete-passing-publication-status.json' || name.endsWith('-outcomes.json') || name.endsWith('.outcomes.json'))
    .sort()

  for (const name of manifestFiles) {
    const sourceManifest = path.join(manifestsRoot, name)
    sourceManifestPaths.push(sourceManifest)

    if (name === 'complete-passing-publication-status.json') {
      const rows = readJson<any[]>(sourceManifest)
      for (const row of rows) {
        const artifactPath = row?.sourceCompleteFilePath ? String(row.sourceCompleteFilePath) : null
        if (!isUnderRemediatedRoot(artifactPath)) continue
        const record: HistoricalArtifactRecord = {
          artifactPath: normalizePath(artifactPath),
          publicationId: row?.publicationId != null ? String(row.publicationId) : null,
          publicationTitle: row?.publicationTitle ? String(row.publicationTitle) : null,
          status: row?.status ? String(row.status) : null,
          sourceManifest,
          processedAt: row?.verifiedAt ? String(row.verifiedAt) : null,
          overallScore: Number.isFinite(row?.overallScore) ? Number(row.overallScore) : null,
          grade: row?.grade ? String(row.grade) : null,
          pageCount: Number.isFinite(row?.pageCount) ? Number(row.pageCount) : null,
          isScanned: typeof row?.isScanned === 'boolean' ? row.isScanned : null,
          resultBand: row?.resultBand ? String(row.resultBand) : null,
        }
        artifactIndex.set(record.artifactPath, chooseBetterHistoricalRecord(artifactIndex.get(record.artifactPath), record))
        if (record.publicationId) {
          bestArtifactByPublication.set(
            record.publicationId,
            chooseBetterHistoricalRecord(bestArtifactByPublication.get(record.publicationId), record),
          )
        }
      }
      continue
    }

    const doc = readJson<{ outcomes?: any[] }>(sourceManifest)
    for (const outcome of doc?.outcomes || []) {
      const candidatePaths = [
        outcome?.artifacts?.remediatedPdfPath,
        outcome?.outputPath,
        outcome?.localFinalArtifactPath,
      ]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .filter(isUnderRemediatedRoot)

      if (!candidatePaths.length) continue

      const record: HistoricalArtifactRecord = {
        artifactPath: '',
        publicationId: outcome?.publicationId != null ? String(outcome.publicationId) : null,
        publicationTitle: outcome?.publicationTitle ? String(outcome.publicationTitle) : null,
        status: outcome?.status ? String(outcome.status) : null,
        sourceManifest,
        processedAt: outcome?.processedAt ? String(outcome.processedAt) : null,
        overallScore: Number.isFinite(outcome?.final?.overallScore)
          ? Number(outcome.final.overallScore)
          : Number.isFinite(outcome?.overallScore)
            ? Number(outcome.overallScore)
            : null,
        grade: outcome?.final?.grade
          ? String(outcome.final.grade)
          : outcome?.grade
            ? String(outcome.grade)
            : null,
        pageCount: Number.isFinite(outcome?.final?.pageCount)
          ? Number(outcome.final.pageCount)
          : Number.isFinite(outcome?.pageCount)
            ? Number(outcome.pageCount)
            : null,
        isScanned: typeof outcome?.final?.isScanned === 'boolean'
          ? outcome.final.isScanned
          : typeof outcome?.isScanned === 'boolean'
            ? outcome.isScanned
            : null,
        resultBand: outcome?.resultBand ? String(outcome.resultBand) : null,
      }

      for (const artifactPath of candidatePaths) {
        const normalized = normalizePath(artifactPath)
        const recordForPath: HistoricalArtifactRecord = {
          ...record,
          artifactPath: normalized,
        }
        artifactIndex.set(normalized, chooseBetterHistoricalRecord(artifactIndex.get(normalized), recordForPath))
        if (recordForPath.publicationId) {
          bestArtifactByPublication.set(
            recordForPath.publicationId,
            chooseBetterHistoricalRecord(bestArtifactByPublication.get(recordForPath.publicationId), recordForPath),
          )
        }
      }
    }
  }

  return { artifactIndex, bestArtifactByPublication, sourceManifestPaths }
}

function buildManifest(): GradingManifest {
  const pdfPaths = walkPdfFiles(remediatedRoot)
  const { artifactIndex, bestArtifactByPublication, sourceManifestPaths } = extractHistoricalArtifactRows()
  const pdfSet = new Set(pdfPaths)
  const candidatesByPublication = new Map<string, GradingCandidate>()
  const candidatesWithoutPublication: GradingCandidate[] = []

  for (const [publicationId, bestRecord] of bestArtifactByPublication) {
    if (!pdfSet.has(bestRecord.artifactPath) || !fs.existsSync(bestRecord.artifactPath)) continue
    const relativeArtifactPath = path.relative(remediatedRoot, bestRecord.artifactPath).split(path.sep).join('/')
    const waveName = relativeArtifactPath.split('/')[0] || 'unknown'
    candidatesByPublication.set(publicationId, {
      artifactPath: bestRecord.artifactPath,
      relativeArtifactPath,
      waveName,
      publicationId,
      publicationTitle: bestRecord.publicationTitle || inferPublicationTitleFromFilename(bestRecord.artifactPath),
      filename: path.basename(bestRecord.artifactPath),
      historical: bestRecord,
    })
  }

  for (const filePath of pdfPaths) {
    const historical = artifactIndex.get(filePath) || null
    const publicationId = historical?.publicationId || inferPublicationIdFromFilename(filePath)
    if (!publicationId) {
      const relativeArtifactPath = path.relative(remediatedRoot, filePath).split(path.sep).join('/')
      const waveName = relativeArtifactPath.split('/')[0] || 'unknown'
      candidatesWithoutPublication.push({
        artifactPath: filePath,
        relativeArtifactPath,
        waveName,
        publicationId: null,
        publicationTitle: historical?.publicationTitle || inferPublicationTitleFromFilename(filePath),
        filename: path.basename(filePath),
        historical,
      })
    }
  }

  const candidates = [...candidatesByPublication.values(), ...candidatesWithoutPublication]
    .sort((a, b) => {
      const aId = a.publicationId || ''
      const bId = b.publicationId || ''
      if (aId !== bId) return aId.localeCompare(bId)
      return a.artifactPath.localeCompare(b.artifactPath)
    })

  const byWave = new Map<string, number>()
  for (const candidate of candidates) {
    byWave.set(candidate.waveName, (byWave.get(candidate.waveName) || 0) + 1)
  }

  const withHistoricalRecord = candidates.filter(candidate => candidate.historical != null).length
  const withHistoricalScore = candidates.filter(candidate => candidate.historical?.overallScore != null).length

  return {
    generatedAt: new Date().toISOString(),
    artifactRoot: remediatedRoot,
    sourceManifestPaths,
    totals: {
      rawArtifactFiles: pdfPaths.length,
      totalCandidates: candidates.length,
      withHistoricalRecord,
      withHistoricalScore,
      withoutHistoricalRecord: candidates.length - withHistoricalRecord,
    },
    byWave: Object.fromEntries([...byWave.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    candidates,
  }
}

export async function main(): Promise<void> {
  const manifest = buildManifest()
  writeJson(manifestPath, manifest)
  writeJson(summaryPath, {
    generatedAt: manifest.generatedAt,
    artifactRoot: manifest.artifactRoot,
    sourceManifestCount: manifest.sourceManifestPaths.length,
    totals: manifest.totals,
    byWave: manifest.byWave,
  })
  console.log(JSON.stringify({
    manifestPath,
    summaryPath,
    rawArtifactFiles: manifest.totals.rawArtifactFiles,
    totalCandidates: manifest.totals.totalCandidates,
    withHistoricalRecord: manifest.totals.withHistoricalRecord,
    withHistoricalScore: manifest.totals.withHistoricalScore,
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
