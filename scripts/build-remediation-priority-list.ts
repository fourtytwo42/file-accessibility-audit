import fs from 'node:fs'
import path from 'node:path'

type ScanReport = {
  generatedAt: string
  source: {
    key?: string
    serverHost?: string
    remotePath?: string
    localCachePath?: string
    storageKind?: string
    publicationIds?: string[]
    publicationTitles?: string[]
    fileUrls?: string[]
    inputPath?: string
    filename?: string
    repairSource?: string
  }
  summary: {
    overallScore: number
    grade: string
    pageCount: number
    isScanned: boolean
    executiveSummary: string
    topBlockingResidualFamilyIds?: string[]
    blockingFindingKeys?: string[]
    autoRunnableOpportunityKeys?: string[]
    manualOnlyFailureModeKeys?: string[]
  }
}

type PriorityCandidate = {
  priorityRank: number
  passLikelihoodScore: number
  priorityTier: 'highest' | 'high' | 'medium'
  recommendedAction: 'fix_first'
  publicationId: string | null
  publicationTitle: string | null
  serverHost: string | null
  remotePath: string | null
  localCachePath: string | null
  fileUrl: string | null
  storageKind: string | null
  overallScore: number
  grade: string
  pageCount: number
  isScanned: boolean
  blockerFamilyCount: number
  blockingFindingCount: number
  manualOnlyFailureModeCount: number
  autoRunnableOpportunityCount: number
  topBlockingResidualFamilyIds: string[]
  blockingFindingKeys: string[]
  autoRunnableOpportunityKeys: string[]
  manualOnlyFailureModeKeys: string[]
  heuristicReasons: string[]
  reportPath: string
}

type PriorityManifest = {
  generatedAt: string
  sourceReportRoot: string
  heuristic: {
    description: string
    selectionRules: string[]
    rankingSignals: string[]
  }
  totals: {
    scannedReportsConsidered: number
    selectedCandidates: number
    byTier: Record<string, number>
  }
  candidates: PriorityCandidate[]
}

const repoRoot = '/home/hendo420/pdfaf'
const icjiaRoot = path.join(repoRoot, 'ICJIA-PDFs')
const reportRoot = path.join(icjiaRoot, 'reports', 'test-runs', 'source-scan')
const manifestPath = path.join(icjiaRoot, 'manifests', 'remediation-priority-candidates.json')
const summaryPath = path.join(icjiaRoot, 'manifests', 'remediation-priority-candidates.summary.json')
const csvPath = path.join(icjiaRoot, 'reports', 'exports', 'csv', 'remediation-priority-candidates.csv')

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

function walkJsonFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()!
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(next)
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(next)
    }
  }
  return out.sort((a, b) => a.localeCompare(b))
}

function computePassLikelihood(report: ScanReport): { score: number; reasons: string[] } {
  const summary = report.summary
  const familyCount = summary.topBlockingResidualFamilyIds?.length ?? 0
  const findingCount = summary.blockingFindingKeys?.length ?? 0
  const manualCount = summary.manualOnlyFailureModeKeys?.length ?? 0
  const autoCount = summary.autoRunnableOpportunityKeys?.length ?? 0

  let score = summary.overallScore
  const reasons: string[] = []

  if (!summary.isScanned) {
    score += 12
    reasons.push('not_scanned_image_only')
  }
  if (manualCount === 0) {
    score += 10
    reasons.push('no_manual_only_failure_modes')
  } else {
    score -= manualCount * 12
    reasons.push('manual_only_failure_modes_present')
  }
  if (familyCount <= 4) {
    score += 8
    reasons.push('few_blocker_families')
  } else if (familyCount >= 6) {
    score -= 8
    reasons.push('many_blocker_families')
  }
  if (findingCount <= 8) {
    score += 6
    reasons.push('few_blocking_findings')
  } else if (findingCount >= 12) {
    score -= 6
    reasons.push('many_blocking_findings')
  }
  if (autoCount >= 5) {
    score += 4
    reasons.push('has_auto_runnable_opportunities')
  }
  if (summary.pageCount <= 25) {
    score += 4
    reasons.push('shorter_document')
  } else if (summary.pageCount >= 100) {
    score -= 4
    reasons.push('long_document')
  }

  return { score, reasons }
}

function tierFor(candidate: Omit<PriorityCandidate, 'priorityRank' | 'priorityTier' | 'recommendedAction'>): 'highest' | 'high' | 'medium' | null {
  if (
    candidate.overallScore >= 50 &&
    !candidate.isScanned &&
    candidate.manualOnlyFailureModeCount === 0
  ) {
    return 'highest'
  }
  if (
    candidate.overallScore >= 40 &&
    !candidate.isScanned &&
    candidate.manualOnlyFailureModeCount === 0
  ) {
    return 'high'
  }
  if (
    candidate.overallScore >= 30 &&
    !candidate.isScanned &&
    candidate.manualOnlyFailureModeCount <= 1
  ) {
    return 'medium'
  }
  return null
}

function csvEscape(value: string | number | boolean | null): string {
  const text = value == null ? '' : String(value)
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function main(): void {
  ensureDir(path.dirname(manifestPath))
  ensureDir(path.dirname(csvPath))

  const paths = walkJsonFiles(reportRoot).filter(filePath => !filePath.includes(`${path.sep}repair-trials${path.sep}`))
  const candidates: PriorityCandidate[] = []

  for (const reportPath of paths) {
    let report: ScanReport
    try {
      report = readJson<ScanReport>(reportPath)
    } catch {
      continue
    }
    if (!report.summary || typeof report.summary.overallScore !== 'number') continue

    const familyIds = report.summary.topBlockingResidualFamilyIds ?? []
    const findingKeys = report.summary.blockingFindingKeys ?? []
    const autoKeys = report.summary.autoRunnableOpportunityKeys ?? []
    const manualKeys = report.summary.manualOnlyFailureModeKeys ?? []
    const { score: passLikelihoodScore, reasons } = computePassLikelihood(report)

    const baseCandidate = {
      passLikelihoodScore,
      publicationId: report.source.publicationIds?.[0] ?? null,
      publicationTitle: report.source.publicationTitles?.[0] ?? null,
      serverHost: report.source.serverHost ?? null,
      remotePath: report.source.remotePath ?? null,
      localCachePath: report.source.localCachePath ?? null,
      fileUrl: report.source.fileUrls?.[0] ?? null,
      storageKind: report.source.storageKind ?? null,
      overallScore: report.summary.overallScore,
      grade: report.summary.grade,
      pageCount: report.summary.pageCount,
      isScanned: report.summary.isScanned,
      blockerFamilyCount: familyIds.length,
      blockingFindingCount: findingKeys.length,
      manualOnlyFailureModeCount: manualKeys.length,
      autoRunnableOpportunityCount: autoKeys.length,
      topBlockingResidualFamilyIds: familyIds,
      blockingFindingKeys: findingKeys,
      autoRunnableOpportunityKeys: autoKeys,
      manualOnlyFailureModeKeys: manualKeys,
      heuristicReasons: reasons,
      reportPath,
    }

    const tier = tierFor(baseCandidate)
    if (!tier) continue

    candidates.push({
      priorityRank: 0,
      priorityTier: tier,
      recommendedAction: 'fix_first',
      ...baseCandidate,
    })
  }

  candidates.sort((a, b) =>
    b.passLikelihoodScore - a.passLikelihoodScore ||
    b.overallScore - a.overallScore ||
    a.manualOnlyFailureModeCount - b.manualOnlyFailureModeCount ||
    a.blockerFamilyCount - b.blockerFamilyCount ||
    a.blockingFindingCount - b.blockingFindingCount ||
    a.pageCount - b.pageCount ||
    (a.reportPath.localeCompare(b.reportPath))
  )

  candidates.forEach((candidate, index) => {
    candidate.priorityRank = index + 1
  })

  const byTier = candidates.reduce<Record<string, number>>((acc, candidate) => {
    acc[candidate.priorityTier] = (acc[candidate.priorityTier] ?? 0) + 1
    return acc
  }, {})

  const manifest: PriorityManifest = {
    generatedAt: new Date().toISOString(),
    sourceReportRoot: reportRoot,
    heuristic: {
      description:
        'Priority list of not-yet-fixed PDFs most likely to clear WCAG 2.1 AA after automated remediation, based on current scan reports.',
      selectionRules: [
        'Exclude repaired fallback trial JSONs from the main queue.',
        'Prefer non-scanned PDFs over image-only/scanned PDFs.',
        'Prefer files with no manual-only failure modes.',
        'Prefer higher current score, fewer blocker families, and fewer blocking findings.',
        'Prefer files with autorunnable opportunities and smaller page counts.',
      ],
      rankingSignals: [
        'overallScore',
        'manualOnlyFailureModeCount',
        'isScanned',
        'blockerFamilyCount',
        'blockingFindingCount',
        'autoRunnableOpportunityCount',
        'pageCount',
      ],
    },
    totals: {
      scannedReportsConsidered: paths.length,
      selectedCandidates: candidates.length,
      byTier,
    },
    candidates,
  }

  const summary = {
    generatedAt: manifest.generatedAt,
    sourceReportRoot: manifest.sourceReportRoot,
    scannedReportsConsidered: manifest.totals.scannedReportsConsidered,
    selectedCandidates: manifest.totals.selectedCandidates,
    byTier,
    top10: candidates.slice(0, 10).map(candidate => ({
      priorityRank: candidate.priorityRank,
      passLikelihoodScore: candidate.passLikelihoodScore,
      priorityTier: candidate.priorityTier,
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      overallScore: candidate.overallScore,
      grade: candidate.grade,
      pageCount: candidate.pageCount,
      serverHost: candidate.serverHost,
      remotePath: candidate.remotePath,
    })),
  }

  const csvLines = [
    [
      'priorityRank',
      'passLikelihoodScore',
      'priorityTier',
      'publicationId',
      'publicationTitle',
      'overallScore',
      'grade',
      'pageCount',
      'serverHost',
      'remotePath',
      'storageKind',
      'manualOnlyFailureModeCount',
      'blockerFamilyCount',
      'blockingFindingCount',
      'autoRunnableOpportunityCount',
      'reportPath',
    ].join(','),
    ...candidates.map(candidate =>
      [
        candidate.priorityRank,
        candidate.passLikelihoodScore,
        candidate.priorityTier,
        candidate.publicationId,
        candidate.publicationTitle,
        candidate.overallScore,
        candidate.grade,
        candidate.pageCount,
        candidate.serverHost,
        candidate.remotePath,
        candidate.storageKind,
        candidate.manualOnlyFailureModeCount,
        candidate.blockerFamilyCount,
        candidate.blockingFindingCount,
        candidate.autoRunnableOpportunityCount,
        candidate.reportPath,
      ].map(csvEscape).join(','),
    ),
  ]

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n')
  fs.writeFileSync(csvPath, csvLines.join('\n') + '\n')

  console.log(JSON.stringify(summary, null, 2))
}

main()
