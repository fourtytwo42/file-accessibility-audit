import fs from 'node:fs'
import path from 'node:path'
import { analyzePDF } from '../apps/api/src/services/pdfAnalyzer.ts'

type ReadyRow = {
  publicationId: string
  publicationTitle: string | null
  fileUrl: string | null
  serverHost: string | null
  remotePath: string | null
  stagedReplacementPath: string | null
  sourceKind: 'complete_seed' | 'batch_ready' | 'already_replaced_remote'
  sourceManifest: string
  sourceStatus: string
}

type VerificationTarget = {
  key: string
  mode: 'local_staged' | 'remote_live'
  sourcePathOrUrl: string
  filename: string
}

type VerificationResult = {
  key: string
  mode: 'local_staged' | 'remote_live'
  sourcePathOrUrl: string
  filename: string
  verifiedAt: string
  durationMs: number
  passed: boolean
  missing: boolean
  error: string | null
  summary: {
    overallScore: number | null
    grade: string | null
    pageCount: number | null
    isScanned: boolean | null
  }
  gate: {
    reasons: string[]
    blockingLocalFindingKeys: string[]
    unresolvedCategoryLabels: string[]
  }
  artifacts: {
    reportPath: string
  }
}

type PublicationVerificationRow = ReadyRow & {
  verificationKey: string
  verificationPassed: boolean
  verificationMissing: boolean
  verificationError: string | null
}

const repoRoot = '/home/hendo420/pdfaf'
const icjiaRoot = path.join(repoRoot, 'ICJIA-PDFs')
const manifestsRoot = path.join(icjiaRoot, 'manifests')
const reportsRoot = path.join(icjiaRoot, 'reports', 'test-runs', 'ready-verification')
const verificationManifestPath = path.join(manifestsRoot, 'ready-to-replace-verification.json')
const verificationSummaryPath = path.join(manifestsRoot, 'ready-to-replace-verification.summary.json')

const concurrency = Number(process.env.ICJIA_VERIFY_CONCURRENCY || 8)

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

function safeStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'item'
}

function ignoredCategoryLabels(): Set<string> {
  return new Set(['Color Contrast'])
}

function ignoredBlockingKeys(): Set<string> {
  return new Set(['category.color_contrast'])
}

function buildGate(result: any): VerificationResult['gate'] & { passed: boolean } {
  const blockingLocalFindingKeys = (result.localStandards?.findings || [])
    .filter((finding: any) => finding.blocking)
    .map((finding: any) => String(finding.key))
    .filter(key => !ignoredBlockingKeys().has(key))

  const unresolvedCategoryLabels = (result.categories || [])
    .filter((category: any) => typeof category.score === 'number' && category.score < 100)
    .map((category: any) => String(category.label))
    .filter(label => !ignoredCategoryLabels().has(label))

  const reasons: string[] = []
  if (result.isScanned) reasons.push('Document still appears scanned/image-only.')
  if (result.grade !== 'A') reasons.push(`Final grade is ${result.grade}, not A.`)
  if (result.overallScore !== 100) reasons.push(`Final overall score is ${result.overallScore}, not 100.`)
  if (blockingLocalFindingKeys.length) reasons.push(`Blocking local standards findings remain: ${blockingLocalFindingKeys.join(', ')}`)
  if (unresolvedCategoryLabels.length) reasons.push(`Categories still below 100: ${unresolvedCategoryLabels.join(', ')}`)

  return {
    passed: reasons.length === 0,
    reasons,
    blockingLocalFindingKeys,
    unresolvedCategoryLabels,
  }
}

function loadReadyRows(): ReadyRow[] {
  const rows: ReadyRow[] = []

  const completeStatusPath = path.join(manifestsRoot, 'complete-passing-publication-status.json')
  const completeRows = readJson<Array<any>>(completeStatusPath)
  for (const row of completeRows) {
    if (!row?.publicationId) continue
    rows.push({
      publicationId: String(row.publicationId),
      publicationTitle: row.publicationTitle ? String(row.publicationTitle) : null,
      fileUrl: row.fileUrl ? String(row.fileUrl) : null,
      serverHost: row.serverHost ? String(row.serverHost) : null,
      remotePath: row.remotePath ? String(row.remotePath) : null,
      stagedReplacementPath: row.stagedReplacementPath ? String(row.stagedReplacementPath) : null,
      sourceKind: row.status === 'replaced_on_remote' ? 'already_replaced_remote' : 'complete_seed',
      sourceManifest: completeStatusPath,
      sourceStatus: String(row.status || 'passing_from_complete'),
    })
  }

  for (const name of fs.readdirSync(manifestsRoot)) {
    if (!name.endsWith('-outcomes.json')) continue
    const manifestPath = path.join(manifestsRoot, name)
    const doc = readJson<{ outcomes?: Array<any> }>(manifestPath)
    for (const outcome of doc.outcomes || []) {
      if (outcome?.status !== 'ready_to_replace' || !outcome.publicationId) continue
      rows.push({
        publicationId: String(outcome.publicationId),
        publicationTitle: outcome.publicationTitle ? String(outcome.publicationTitle) : null,
        fileUrl: outcome.fileUrl ? String(outcome.fileUrl) : null,
        serverHost: outcome.serverHost ? String(outcome.serverHost) : null,
        remotePath: outcome.remotePath ? String(outcome.remotePath) : null,
        stagedReplacementPath: outcome.artifacts?.stagedReplacementPath ? String(outcome.artifacts.stagedReplacementPath) : null,
        sourceKind: 'batch_ready',
        sourceManifest: manifestPath,
        sourceStatus: 'ready_to_replace',
      })
    }
  }

  rows.sort((a, b) => a.publicationId.localeCompare(b.publicationId))
  return rows
}

function buildTargets(rows: ReadyRow[]): Map<string, VerificationTarget> {
  const targets = new Map<string, VerificationTarget>()

  for (const row of rows) {
    if (row.sourceKind === 'already_replaced_remote' && row.fileUrl) {
      const key = `remote:${row.fileUrl}`
      if (!targets.has(key)) {
        targets.set(key, {
          key,
          mode: 'remote_live',
          sourcePathOrUrl: row.fileUrl,
          filename: path.basename(row.fileUrl),
        })
      }
      continue
    }

    if (!row.stagedReplacementPath) continue
    const key = `local:${row.stagedReplacementPath}`
    if (!targets.has(key)) {
      targets.set(key, {
        key,
        mode: 'local_staged',
        sourcePathOrUrl: row.stagedReplacementPath,
        filename: path.basename(row.stagedReplacementPath),
      })
    }
  }

  return targets
}

async function readTargetBuffer(target: VerificationTarget): Promise<Buffer> {
  if (target.mode === 'local_staged') {
    return fs.promises.readFile(target.sourcePathOrUrl)
  }

  const response = await fetch(target.sourcePathOrUrl)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${target.sourcePathOrUrl}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

function reportPathForTarget(target: VerificationTarget): string {
  const modeDir = target.mode === 'local_staged' ? 'local-staged' : 'remote-live'
  return path.join(reportsRoot, modeDir, `${safeStem(target.filename)}.json`)
}

async function verifyTarget(target: VerificationTarget): Promise<VerificationResult> {
  const startedAt = Date.now()
  const reportPath = reportPathForTarget(target)

  try {
    const buffer = await readTargetBuffer(target)
    const result = await analyzePDF(buffer, target.filename, {
      analysisProfile: 'full_final',
      skipAdobe: true,
      skipVeraPdf: true,
    })

    const gate = buildGate(result)
    const record: VerificationResult = {
      key: target.key,
      mode: target.mode,
      sourcePathOrUrl: target.sourcePathOrUrl,
      filename: target.filename,
      verifiedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      passed: gate.passed,
      missing: false,
      error: null,
      summary: {
        overallScore: result.overallScore,
        grade: result.grade,
        pageCount: result.pageCount,
        isScanned: result.isScanned,
      },
      gate: {
        reasons: gate.reasons,
        blockingLocalFindingKeys: gate.blockingLocalFindingKeys,
        unresolvedCategoryLabels: gate.unresolvedCategoryLabels,
      },
      artifacts: {
        reportPath,
      },
    }

    writeJson(reportPath, {
      target,
      result: {
        overallScore: result.overallScore,
        grade: result.grade,
        pageCount: result.pageCount,
        isScanned: result.isScanned,
        executiveSummary: result.executiveSummary,
        localStandards: result.localStandards,
        categories: result.categories,
      },
      gate,
      verifiedAt: record.verifiedAt,
      durationMs: record.durationMs,
    })

    return record
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    const missing = /ENOENT|HTTP 404/.test(message)
    const record: VerificationResult = {
      key: target.key,
      mode: target.mode,
      sourcePathOrUrl: target.sourcePathOrUrl,
      filename: target.filename,
      verifiedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      passed: false,
      missing,
      error: message,
      summary: {
        overallScore: null,
        grade: null,
        pageCount: null,
        isScanned: null,
      },
      gate: {
        reasons: [message],
        blockingLocalFindingKeys: [],
        unresolvedCategoryLabels: [],
      },
      artifacts: {
        reportPath,
      },
    }
    writeJson(reportPath, { target, error: message, verifiedAt: record.verifiedAt, durationMs: record.durationMs })
    return record
  }
}

async function main(): Promise<void> {
  ensureDir(reportsRoot)

  const rows = loadReadyRows()
  const targets = Array.from(buildTargets(rows).values())
  const targetResults = new Map<string, VerificationResult>()
  let index = 0

  async function worker(): Promise<void> {
    while (index < targets.length) {
      const target = targets[index++]
      console.log(`[ready-verification] starting ${index}/${targets.length} ${target.sourcePathOrUrl}`)
      const result = await verifyTarget(target)
      targetResults.set(target.key, result)
      console.log(`[ready-verification] finished passed=${result.passed} missing=${result.missing} ${target.sourcePathOrUrl}`)
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))

  const publicationRows: PublicationVerificationRow[] = rows.map(row => {
    const verificationKey = row.sourceKind === 'already_replaced_remote' && row.fileUrl
      ? `remote:${row.fileUrl}`
      : `local:${row.stagedReplacementPath}`
    const result = targetResults.get(verificationKey)
    return {
      ...row,
      verificationKey,
      verificationPassed: Boolean(result?.passed),
      verificationMissing: Boolean(result?.missing),
      verificationError: result?.error ?? null,
    }
  })

  const verificationResults = Array.from(targetResults.values())
  const summary = {
    generatedAt: new Date().toISOString(),
    totals: {
      publicationRows: publicationRows.length,
      uniqueTargets: verificationResults.length,
      passedTargets: verificationResults.filter(result => result.passed).length,
      failedTargets: verificationResults.filter(result => !result.passed && !result.missing && !result.error).length,
      erroredTargets: verificationResults.filter(result => Boolean(result.error) && !result.missing).length,
      missingTargets: verificationResults.filter(result => result.missing).length,
      passedPublicationRows: publicationRows.filter(row => row.verificationPassed).length,
      failedPublicationRows: publicationRows.filter(row => !row.verificationPassed && !row.verificationMissing && !row.verificationError).length,
      erroredPublicationRows: publicationRows.filter(row => Boolean(row.verificationError) && !row.verificationMissing).length,
      missingPublicationRows: publicationRows.filter(row => row.verificationMissing).length,
    },
    latestVerifiedTarget: verificationResults.at(-1) || null,
  }

  writeJson(verificationManifestPath, {
    generatedAt: summary.generatedAt,
    summary: summary.totals,
    verificationResults,
    publicationRows,
  })
  writeJson(verificationSummaryPath, summary)

  console.log(JSON.stringify(summary, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
