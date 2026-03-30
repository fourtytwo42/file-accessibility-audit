import fs from 'node:fs'
import path from 'node:path'

type ScanReport = {
  source: {
    publicationIds?: string[]
    publicationTitles?: string[]
    fileUrls?: string[]
    serverHost?: string
    remotePath?: string
    localCachePath?: string
    storageKind?: string
  }
  summary: {
    overallScore: number
    grade: string
    pageCount: number
    isScanned: boolean
    topBlockingResidualFamilyIds?: string[]
    blockingFindingKeys?: string[]
    autoRunnableOpportunityKeys?: string[]
    manualOnlyFailureModeKeys?: string[]
  }
}

type BatchCandidate = {
  nextBatchRank: number
  publicationId: string | null
  publicationTitle: string | null
  selectorScore: number
  waveTier: 'highest' | 'high'
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
  selectorReasons: string[]
  reportPath: string
}

type BatchManifest = {
  generatedAt: string
  selectionProfile: {
    description: string
    limit: number
    exclusionRules: string[]
    preferredSignals: string[]
    riskSignals: string[]
  }
  totals: {
    scannedReportsConsidered: number
    eligibleAfterFiltering: number
    shortlistedCandidates: number
    byTier: Record<string, number>
  }
  candidates: BatchCandidate[]
}

const repoRoot = '/home/hendo420/pdfaf'
const icjiaRoot = path.join(repoRoot, 'ICJIA-PDFs')
const reportRoot = path.join(icjiaRoot, 'reports', 'test-runs', 'source-scan')
const defaultBaseName = process.env.ICJIA_BATCH_OUTPUT_BASENAME || 'remediation-50-batch-2'
const batchLimit = Number(process.env.ICJIA_BATCH_LIMIT || '50')
const maxPages = Number(process.env.ICJIA_BATCH_MAX_PAGES || '30')
const maxBlockerFamilies = Number(process.env.ICJIA_BATCH_MAX_BLOCKER_FAMILIES || '5')
const maxBlockingFindings = Number(process.env.ICJIA_BATCH_MAX_BLOCKING_FINDINGS || '10')
const excludeCompiler = process.env.ICJIA_BATCH_EXCLUDE_COMPILER !== '0'
const manifestPath = path.join(icjiaRoot, 'manifests', `${defaultBaseName}-candidates.json`)
const summaryPath = path.join(icjiaRoot, 'manifests', `${defaultBaseName}-candidates.summary.json`)
const csvPath = path.join(icjiaRoot, 'reports', 'exports', 'csv', `${defaultBaseName}-candidates.csv`)

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
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

function loadCoveredPublicationIds(): Set<string> {
  const covered = new Set<string>()

  const completeStatusPath = path.join(icjiaRoot, 'manifests', 'complete-passing-publication-status.json')
  if (fs.existsSync(completeStatusPath)) {
    try {
      const entries = readJson<Array<{ publicationId?: string }>>(completeStatusPath)
      for (const entry of entries) {
        if (entry?.publicationId) covered.add(String(entry.publicationId))
      }
    } catch {
      // ignore malformed tracker and continue with outcomes
    }
  }

  const manifestsDir = path.join(icjiaRoot, 'manifests')
  const outcomePaths = fs.existsSync(manifestsDir)
    ? fs
        .readdirSync(manifestsDir)
        .filter(name => name.endsWith('-outcomes.json'))
        .map(name => path.join(manifestsDir, name))
    : []

  for (const outcomePath of outcomePaths) {
    if (!fs.existsSync(outcomePath)) continue
    try {
      const manifest = readJson<{ outcomes?: Array<{ publicationId?: string }> }>(outcomePath)
      for (const outcome of manifest.outcomes ?? []) {
        if (outcome?.publicationId) covered.add(String(outcome.publicationId))
      }
    } catch {
      // ignore malformed outcome file
    }
  }

  return covered
}

function csvEscape(value: string | number | boolean | null): string {
  const text = value == null ? '' : String(value)
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function computeSelector(report: ScanReport, reportPath: string): { score: number; reasons: string[]; tier: 'highest' | 'high' | null } {
  const summary = report.summary
  const familyIds = summary.topBlockingResidualFamilyIds ?? []
  const findingKeys = summary.blockingFindingKeys ?? []
  const autoKeys = summary.autoRunnableOpportunityKeys ?? []
  const manualKeys = summary.manualOnlyFailureModeKeys ?? []
  const text = `${report.source.publicationTitles?.[0] ?? ''} ${report.source.remotePath ?? ''} ${reportPath}`.toLowerCase()

  if (summary.isScanned) return { score: -Infinity, reasons: ['exclude_scanned'], tier: null }
  if (manualKeys.length > 0) return { score: -Infinity, reasons: ['exclude_manual_only'], tier: null }
  if (summary.pageCount > maxPages) return { score: -Infinity, reasons: [`exclude_over_${maxPages}_pages`], tier: null }
  if (familyIds.length > maxBlockerFamilies) return { score: -Infinity, reasons: [`exclude_over_${maxBlockerFamilies}_blocker_families`], tier: null }
  if (findingKeys.length > maxBlockingFindings) return { score: -Infinity, reasons: [`exclude_over_${maxBlockingFindings}_blocking_findings`], tier: null }
  if (excludeCompiler && /\bcompiler\b|\bnewsletter\b/.test(text)) return { score: -Infinity, reasons: ['exclude_compiler_newsletter_timeout_risk'], tier: null }

  let score = 100
  const reasons: string[] = []

  score += Math.max(0, 35 - summary.pageCount)
  reasons.push('prefer_short_documents')

  score += Math.max(0, 12 - familyIds.length * 2)
  reasons.push('prefer_fewer_blocker_families')

  score += Math.max(0, 14 - findingKeys.length)
  reasons.push('prefer_fewer_blocking_findings')

  score += Math.min(10, Math.floor(autoKeys.length / 2))
  reasons.push('prefer_many_autorunnable_opportunities')

  const preferredFamilies = new Set([
    'metadata_normalization',
    'font_embedding_and_unicode',
    'link_tabs_and_annotation_cleanup',
    'bookmark_language_outline_cleanup',
  ])
  const positiveFamilyHits = familyIds.filter(familyId => preferredFamilies.has(familyId)).length
  score += positiveFamilyHits * 4
  if (positiveFamilyHits > 0) reasons.push('preferred_fixable_family_mix')

  const riskyFamilies = new Set([
    'table_structure_recovery',
    'logical_structure_marked_content',
    'native_figure_convergence',
  ])
  const riskyHits = familyIds.filter(familyId => riskyFamilies.has(familyId)).length
  if (riskyHits > 0) {
    score -= riskyHits * 10
    reasons.push('penalize_complex_structure_families')
  }

  const riskyFindings = findingKeys.filter(key =>
    key.includes('table_') ||
    key.includes('logical_structure') ||
    key.includes('figure_') ||
    key.includes('annotation_alt_contents'),
  ).length
  if (riskyFindings > 0) {
    score -= riskyFindings * 4
    reasons.push('penalize_risky_blocking_findings')
  }

  if (summary.pageCount <= 10) {
    score += 8
    reasons.push('very_short_document')
  } else if (summary.pageCount <= 20) {
    score += 4
    reasons.push('short_document')
  }

  const tier: 'highest' | 'high' = score >= 120 ? 'highest' : 'high'
  return { score, reasons, tier }
}

function main(): void {
  ensureDir(path.dirname(manifestPath))
  ensureDir(path.dirname(csvPath))

  const coveredPublicationIds = loadCoveredPublicationIds()
  const reportPaths = walkJsonFiles(reportRoot).filter(filePath => !filePath.includes(`${path.sep}repair-trials${path.sep}`))
  const candidates: BatchCandidate[] = []

  for (const reportPath of reportPaths) {
    let report: ScanReport
    try {
      report = readJson<ScanReport>(reportPath)
    } catch {
      continue
    }

    const publicationId = report.source.publicationIds?.[0] ?? null
    if (!publicationId || coveredPublicationIds.has(publicationId)) continue
    if (!report.summary || typeof report.summary.overallScore !== 'number') continue

    const familyIds = report.summary.topBlockingResidualFamilyIds ?? []
    const findingKeys = report.summary.blockingFindingKeys ?? []
    const autoKeys = report.summary.autoRunnableOpportunityKeys ?? []
    const manualKeys = report.summary.manualOnlyFailureModeKeys ?? []
    const selection = computeSelector(report, reportPath)
    if (!selection.tier) continue

    candidates.push({
      nextBatchRank: 0,
      publicationId,
      publicationTitle: report.source.publicationTitles?.[0] ?? null,
      selectorScore: selection.score,
      waveTier: selection.tier,
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
      selectorReasons: selection.reasons,
      reportPath,
    })
  }

  candidates.sort((a, b) =>
    b.selectorScore - a.selectorScore ||
    a.pageCount - b.pageCount ||
    a.blockerFamilyCount - b.blockerFamilyCount ||
    a.blockingFindingCount - b.blockingFindingCount ||
    b.autoRunnableOpportunityCount - a.autoRunnableOpportunityCount ||
    (a.publicationTitle ?? '').localeCompare(b.publicationTitle ?? '') ||
    a.reportPath.localeCompare(b.reportPath),
  )

  const shortlisted = candidates.slice(0, batchLimit).map((candidate, index) => ({
    ...candidate,
    nextBatchRank: index + 1,
  }))

  const byTier = shortlisted.reduce<Record<string, number>>((acc, candidate) => {
    acc[candidate.waveTier] = (acc[candidate.waveTier] ?? 0) + 1
    return acc
  }, {})

  const manifest: BatchManifest = {
    generatedAt: new Date().toISOString(),
    selectionProfile: {
      description:
        'Strict next-batch selector for PDFs most likely to pass after automated remediation, favoring short non-scanned documents with low-complexity blocker profiles.',
      limit: batchLimit,
      exclusionRules: [
        'Exclude publications already covered by seeded passing replacements or prior remediation outcomes.',
        'Exclude scanned/image-only PDFs.',
        'Exclude any PDF with manual-only failure modes.',
        `Exclude PDFs over ${maxPages} pages.`,
        `Exclude PDFs with more than ${maxBlockerFamilies} blocker families or more than ${maxBlockingFindings} blocking findings.`,
        excludeCompiler
          ? 'Exclude compiler/newsletter-style PDFs due to observed timeout risk.'
          : 'Allow compiler/newsletter-style PDFs in this relaxed selector.',
      ],
      preferredSignals: [
        'short page count',
        'few blocker families',
        'few blocking findings',
        'many autorunnable opportunities',
        'metadata/font/link cleanup family mix',
      ],
      riskSignals: [
        'table structure recovery',
        'logical structure / marked content complexity',
        'native figure convergence',
        'compiler/newsletter file patterns',
      ],
    },
    totals: {
      scannedReportsConsidered: reportPaths.length,
      eligibleAfterFiltering: candidates.length,
      shortlistedCandidates: shortlisted.length,
      byTier,
    },
    candidates: shortlisted,
  }

  const summary = {
    generatedAt: manifest.generatedAt,
    totals: manifest.totals,
    top15: shortlisted.slice(0, 15).map(candidate => ({
      nextBatchRank: candidate.nextBatchRank,
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      selectorScore: candidate.selectorScore,
      waveTier: candidate.waveTier,
      pageCount: candidate.pageCount,
      blockerFamilyCount: candidate.blockerFamilyCount,
      blockingFindingCount: candidate.blockingFindingCount,
      storageKind: candidate.storageKind,
      serverHost: candidate.serverHost,
    })),
  }

  const csvLines = [
    [
      'nextBatchRank',
      'publicationId',
      'publicationTitle',
      'selectorScore',
      'waveTier',
      'overallScore',
      'grade',
      'pageCount',
      'serverHost',
      'remotePath',
      'storageKind',
      'blockerFamilyCount',
      'blockingFindingCount',
      'manualOnlyFailureModeCount',
      'autoRunnableOpportunityCount',
      'reportPath',
    ].join(','),
    ...shortlisted.map(candidate =>
      [
        candidate.nextBatchRank,
        candidate.publicationId,
        candidate.publicationTitle,
        candidate.selectorScore,
        candidate.waveTier,
        candidate.overallScore,
        candidate.grade,
        candidate.pageCount,
        candidate.serverHost,
        candidate.remotePath,
        candidate.storageKind,
        candidate.blockerFamilyCount,
        candidate.blockingFindingCount,
        candidate.manualOnlyFailureModeCount,
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
