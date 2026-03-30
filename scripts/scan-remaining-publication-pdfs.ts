import fs from 'node:fs'
import path from 'node:path'
import { analyzePDF } from '../apps/api/src/services/pdfAnalyzer.js'
import { inspectPdfForRemediation } from '../apps/api/src/services/pdfRemediationTools.js'
import { buildFailureProfileArtifacts } from '../apps/api/src/services/failureProfileService.js'
import { buildLiveResidualFamilyState } from '../apps/api/src/services/liveResidualFamilyDiagnosisService.js'

type ReplacementMapRow = {
  publicationId: string
  title: string
  slug: string | null
  fileUrl: string
  fileHost: string
  storageKind: 'legacy_archive' | 'agency_upload' | 'researchhub_upload' | 'other_pdf'
  serverHost: string | null
  sshTarget: string | null
  remotePath: string | null
  expectedPresence: 'present' | 'missing' | 'unknown'
}

type PassingPublicationStatus = {
  publicationId: string
}

type ScanTarget = {
  key: string
  serverHost: string
  remotePath: string
  localCachePath: string
  storageKind: ReplacementMapRow['storageKind']
  publicationIds: string[]
  publicationTitles: string[]
  fileUrls: string[]
}

type FileScanReport = {
  generatedAt: string
  source: {
    key: string
    serverHost: string
    remotePath: string
    localCachePath: string
    storageKind: ReplacementMapRow['storageKind']
    publicationIds: string[]
    publicationTitles: string[]
    fileUrls: string[]
  }
  summary: {
    overallScore: number
    grade: string
    pageCount: number
    isScanned: boolean
    executiveSummary: string
    topBlockingResidualFamilyIds: string[]
    blockingFindingKeys: string[]
    autoRunnableOpportunityKeys: string[]
    manualOnlyFailureModeKeys: string[]
  }
  categoryScores: Record<string, number | null>
  warnings: string[]
  categories: Array<{
    id: string
    label: string
    score: number | null
    grade: string | null
    severity: string | null
    findings: string[]
    explanation: string
  }>
  localStandards: unknown
  failureProfile: {
    failureModes: unknown
    residualFamilies: unknown
    toolOpportunities: unknown
  }
  plannerEvidence: unknown
  liveResidualState: unknown
}

type ScanGroupArtifact = {
  generatedAt: string
  totals: {
    scannedFiles: number
    byGrade: Record<string, number>
    byTopBlockingFamily: Record<string, number>
    byBlockingFindingKey: Record<string, number>
  }
  groups: {
    byTopBlockingFamily: Array<{
      familyId: string
      count: number
      files: Array<{
        key: string
        overallScore: number
        grade: string
        serverHost: string
        remotePath: string
      }>
    }>
    byBlockingFindingKey: Array<{
      findingKey: string
      count: number
      files: Array<{
        key: string
        overallScore: number
        grade: string
        serverHost: string
        remotePath: string
      }>
    }>
    bySignature: Array<{
      signature: string
      count: number
      topBlockingResidualFamilyIds: string[]
      blockingFindingKeys: string[]
      files: Array<{
        key: string
        overallScore: number
        grade: string
        serverHost: string
        remotePath: string
      }>
    }>
  }
}

const repoRoot = '/home/hendo420/pdfaf'
const icjiaRoot = path.join(repoRoot, 'ICJIA-PDFs')
const replacementMapPath = path.join(icjiaRoot, 'manifests', 'publication-pdf-replacement-map.json')
const passingStatusPath = path.join(icjiaRoot, 'manifests', 'complete-passing-publication-status.json')
const reportRoot = path.join(icjiaRoot, 'reports', 'test-runs', 'source-scan')
const manifestDir = path.join(icjiaRoot, 'manifests')
const csvDir = path.join(icjiaRoot, 'reports', 'exports', 'csv')
const summaryPath = path.join(manifestDir, 'remaining-source-scan.summary.json')
const groupPath = path.join(manifestDir, 'remaining-source-scan-groups.json')
const groupCsvPath = path.join(csvDir, 'remaining-source-scan-groups.csv')
const concurrency = Number(process.env.ICJIA_SCAN_CONCURRENCY || 2)
const limit = Number(process.env.ICJIA_SCAN_LIMIT || 0)

const remoteRootsByHost: Record<string, string> = {
  '143.244.146.43': '/home/forge/archive.icjia-api.cloud/root/files',
  '192.241.146.85': '/home/forge/agency.icjia-api.cloud/agency-api/public/uploads',
  '157.230.3.215': '/home/forge/researchhub.icjia-api.cloud/researchhub/public/uploads',
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
}

function categoryScores(result: Awaited<ReturnType<typeof analyzePDF>>): Record<string, number | null> {
  return Object.fromEntries(result.categories.map(category => [
    category.id,
    typeof category.score === 'number' ? category.score : null,
  ]))
}

function reportPathFor(target: ScanTarget): string {
  const relative = path.posix.relative(remoteRootsByHost[target.serverHost], target.remotePath)
  const relativeParts = relative.split('/').filter(Boolean).map(part => part.replace(/\.pdf$/i, '.json'))
  return path.join(reportRoot, target.serverHost, ...relativeParts)
}

function localCachePathFor(serverHost: string, remotePath: string): string {
  const remoteRoot = remoteRootsByHost[serverHost]
  if (!remoteRoot) throw new Error(`No remote root configured for ${serverHost}`)
  const relative = path.posix.relative(remoteRoot, remotePath)
  if (!relative || relative.startsWith('..')) {
    throw new Error(`Remote path ${remotePath} is not under configured root ${remoteRoot}`)
  }
  return path.join(icjiaRoot, 'backups', 'server-cache', serverHost, ...relative.split('/'))
}

function buildTargets(): ScanTarget[] {
  const replacementRows = readJson<ReplacementMapRow[]>(replacementMapPath)
  const passingRows = fs.existsSync(passingStatusPath) ? readJson<PassingPublicationStatus[]>(passingStatusPath) : []
  const passingIds = new Set(passingRows.map(row => String(row.publicationId)))
  const grouped = new Map<string, ScanTarget>()

  for (const row of replacementRows) {
    if (passingIds.has(String(row.publicationId))) continue
    if (!row.serverHost || !row.remotePath || row.expectedPresence === 'missing') continue

    const key = `${row.serverHost}:${row.remotePath}`
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        serverHost: row.serverHost,
        remotePath: row.remotePath,
        localCachePath: localCachePathFor(row.serverHost, row.remotePath),
        storageKind: row.storageKind,
        publicationIds: [],
        publicationTitles: [],
        fileUrls: [],
      })
    }

    const target = grouped.get(key)!
    target.publicationIds.push(String(row.publicationId))
    target.publicationTitles.push(row.title)
    target.fileUrls.push(row.fileUrl)
  }

  return [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key))
}

async function analyzeOne(target: ScanTarget): Promise<FileScanReport> {
  const buffer = await fs.promises.readFile(target.localCachePath)
  const filename = path.basename(target.remotePath)
  const analysis = await analyzePDF(buffer, filename, {
    skipAdobe: true,
    skipVeraPdf: true,
    analysisProfile: 'full_final',
  })
  const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
  const artifacts = buildFailureProfileArtifacts({
    analysis,
    context,
    actions: [],
    rejectedActions: [],
    iterations: [],
  })
  const liveResidualState = buildLiveResidualFamilyState({
    filePath: target.localCachePath,
    overallScore: analysis.overallScore,
    grade: analysis.grade,
    failureProfile: artifacts.failureProfile,
    plannerEvidence: artifacts.plannerEvidence,
    manualReviewFlags: [],
  })

  return {
    generatedAt: new Date().toISOString(),
    source: {
      key: target.key,
      serverHost: target.serverHost,
      remotePath: target.remotePath,
      localCachePath: target.localCachePath,
      storageKind: target.storageKind,
      publicationIds: target.publicationIds,
      publicationTitles: target.publicationTitles,
      fileUrls: target.fileUrls,
    },
    summary: {
      overallScore: analysis.overallScore,
      grade: analysis.grade,
      pageCount: analysis.pageCount,
      isScanned: analysis.isScanned,
      executiveSummary: analysis.executiveSummary,
      topBlockingResidualFamilyIds: liveResidualState.topBlockingResidualFamilyIds,
      blockingFindingKeys: liveResidualState.blockingFindingKeys,
      autoRunnableOpportunityKeys: liveResidualState.autoRunnableOpportunityKeys,
      manualOnlyFailureModeKeys: liveResidualState.manualOnlyFailureModeKeys,
    },
    categoryScores: categoryScores(analysis),
    warnings: analysis.warnings,
    categories: analysis.categories.map(category => ({
      id: category.id,
      label: category.label,
      score: typeof category.score === 'number' ? category.score : null,
      grade: category.grade,
      severity: category.severity,
      findings: category.findings,
      explanation: category.explanation,
    })),
    localStandards: analysis.localStandards ?? null,
    failureProfile: {
      failureModes: artifacts.failureProfile.failureModes,
      residualFamilies: artifacts.failureProfile.residualFamilies,
      toolOpportunities: artifacts.failureProfile.toolOpportunities,
    },
    plannerEvidence: artifacts.plannerEvidence,
    liveResidualState,
  }
}

function buildGroupArtifact(reports: FileScanReport[]): ScanGroupArtifact {
  const byGrade: Record<string, number> = {}
  const byTopBlockingFamily: Record<string, number> = {}
  const byBlockingFindingKey: Record<string, number> = {}
  const familyGroupMap = new Map<string, ScanGroupArtifact['groups']['byTopBlockingFamily'][number]>()
  const findingGroupMap = new Map<string, ScanGroupArtifact['groups']['byBlockingFindingKey'][number]>()
  const signatureGroupMap = new Map<string, ScanGroupArtifact['groups']['bySignature'][number]>()

  for (const report of reports) {
    byGrade[report.summary.grade] = (byGrade[report.summary.grade] ?? 0) + 1

    const fileSummary = {
      key: report.source.key,
      overallScore: report.summary.overallScore,
      grade: report.summary.grade,
      serverHost: report.source.serverHost,
      remotePath: report.source.remotePath,
    }

    for (const familyId of report.summary.topBlockingResidualFamilyIds) {
      byTopBlockingFamily[familyId] = (byTopBlockingFamily[familyId] ?? 0) + 1
      if (!familyGroupMap.has(familyId)) {
        familyGroupMap.set(familyId, {
          familyId,
          count: 0,
          files: [],
        })
      }
      const group = familyGroupMap.get(familyId)!
      group.count += 1
      if (group.files.length < 50) group.files.push(fileSummary)
    }

    for (const findingKey of report.summary.blockingFindingKeys) {
      byBlockingFindingKey[findingKey] = (byBlockingFindingKey[findingKey] ?? 0) + 1
      if (!findingGroupMap.has(findingKey)) {
        findingGroupMap.set(findingKey, {
          findingKey,
          count: 0,
          files: [],
        })
      }
      const group = findingGroupMap.get(findingKey)!
      group.count += 1
      if (group.files.length < 50) group.files.push(fileSummary)
    }

    const signatureFamilies = report.summary.topBlockingResidualFamilyIds.slice(0, 3)
    const signatureFindings = report.summary.blockingFindingKeys.slice(0, 5)
    const signature = `families:${signatureFamilies.join('|') || 'none'}__findings:${signatureFindings.join('|') || 'none'}`
    if (!signatureGroupMap.has(signature)) {
      signatureGroupMap.set(signature, {
        signature,
        count: 0,
        topBlockingResidualFamilyIds: signatureFamilies,
        blockingFindingKeys: signatureFindings,
        files: [],
      })
    }
    const signatureGroup = signatureGroupMap.get(signature)!
    signatureGroup.count += 1
    if (signatureGroup.files.length < 50) signatureGroup.files.push(fileSummary)
  }

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      scannedFiles: reports.length,
      byGrade,
      byTopBlockingFamily,
      byBlockingFindingKey,
    },
    groups: {
      byTopBlockingFamily: [...familyGroupMap.values()].sort((a, b) => b.count - a.count || a.familyId.localeCompare(b.familyId)),
      byBlockingFindingKey: [...findingGroupMap.values()].sort((a, b) => b.count - a.count || a.findingKey.localeCompare(b.findingKey)),
      bySignature: [...signatureGroupMap.values()].sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature)),
    },
  }
}

async function loadAllReports(): Promise<FileScanReport[]> {
  if (!fs.existsSync(reportRoot)) return []
  const results: FileScanReport[] = []
  const stack = [reportRoot]
  while (stack.length) {
    const current = stack.pop()!
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(next)
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          results.push(readJson<FileScanReport>(next))
        } catch {
          continue
        }
      }
    }
  }
  return results
}

function writeGroupCsv(artifact: ScanGroupArtifact): void {
  ensureDir(path.dirname(groupCsvPath))
  const lines = [
    'group_type,group_key,count,example_server,example_remote_path',
    ...artifact.groups.byTopBlockingFamily.map(group => {
      const example = group.files[0]
      return [
        'top_blocking_family',
        group.familyId,
        String(group.count),
        example?.serverHost || '',
        example?.remotePath || '',
      ].map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')
    }),
    ...artifact.groups.byBlockingFindingKey.map(group => {
      const example = group.files[0]
      return [
        'blocking_finding',
        group.findingKey,
        String(group.count),
        example?.serverHost || '',
        example?.remotePath || '',
      ].map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')
    }),
  ]
  fs.writeFileSync(groupCsvPath, `${lines.join('\n')}\n`)
}

async function main(): Promise<void> {
  ensureDir(reportRoot)
  ensureDir(manifestDir)
  ensureDir(csvDir)

  const targets = buildTargets().slice(0, limit > 0 ? limit : undefined)
  let index = 0
  let analyzed = 0
  let skipped = 0
  let failed = 0

  async function worker() {
    while (index < targets.length) {
      const target = targets[index++]
      const reportPath = reportPathFor(target)
      if (fs.existsSync(reportPath)) {
        skipped += 1
        continue
      }
      if (!fs.existsSync(target.localCachePath)) {
        failed += 1
        console.error(`[scan] missing local cache: ${target.localCachePath}`)
        continue
      }

      try {
        console.log(`[scan] starting ${target.remotePath}`)
        const report = await analyzeOne(target)
        ensureDir(path.dirname(reportPath))
        fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
        analyzed += 1
        console.log(`[scan] ${analyzed + skipped + failed}/${targets.length} analyzed ${target.remotePath}`)
      } catch (error) {
        failed += 1
        console.error(`[scan] failed ${target.remotePath}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))

  const reports = await loadAllReports()
  const groupArtifact = buildGroupArtifact(reports)
  fs.writeFileSync(groupPath, `${JSON.stringify(groupArtifact, null, 2)}\n`)
  writeGroupCsv(groupArtifact)

  const summary = {
    generatedAt: new Date().toISOString(),
    replacementMapPath,
    passingStatusPath,
    targetFileCount: targets.length,
    limit: limit > 0 ? limit : null,
    analyzed,
    skippedExisting: skipped,
    failed,
    reportRoot,
    groupPath,
    groupCsvPath,
  }
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
