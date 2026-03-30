import fs from 'node:fs'
import path from 'node:path'

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

type PublicationVerificationRow = {
  publicationId: string
  publicationTitle: string | null
  fileUrl: string | null
  serverHost: string | null
  remotePath: string | null
  stagedReplacementPath: string | null
  sourceKind: 'complete_seed' | 'batch_ready' | 'already_replaced_remote'
  sourceManifest: string
  sourceStatus: string
  verificationKey: string
  verificationPassed: boolean
  verificationMissing: boolean
  verificationError: string | null
}

type Classification = 'verified_pass' | 'soft_fail_advisory' | 'hard_fail'

const repoRoot = '/home/hendo420/pdfaf'
const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')
const sourcePath = path.join(manifestsRoot, 'ready-to-replace-verification.json')
const outputPath = path.join(manifestsRoot, 'ready-to-replace-verification.classified.json')
const summaryPath = path.join(manifestsRoot, 'ready-to-replace-verification.classified.summary.json')

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

function classifyResult(result: VerificationResult): Classification {
  if (result.passed) return 'verified_pass'

  const hardFail = (
    result.summary.grade !== 'A' ||
    result.summary.overallScore !== 100 ||
    (result.gate.blockingLocalFindingKeys || []).length > 0 ||
    Boolean(result.error) ||
    result.missing
  )

  return hardFail ? 'hard_fail' : 'soft_fail_advisory'
}

function main(): void {
  const doc = readJson<{
    generatedAt: string
    summary: Record<string, number>
    verificationResults: VerificationResult[]
    publicationRows: PublicationVerificationRow[]
  }>(sourcePath)

  const resultMap = new Map(doc.verificationResults.map(result => [result.key, result]))

  const classifiedResults = doc.verificationResults.map(result => ({
    ...result,
    classification: classifyResult(result),
  }))

  const classifiedRows = doc.publicationRows.map(row => {
    const result = resultMap.get(row.verificationKey)
    const classification = result ? classifyResult(result) : 'hard_fail'
    return {
      ...row,
      classification,
    }
  })

  const summary = {
    generatedAt: new Date().toISOString(),
    basedOn: sourcePath,
    totals: {
      publicationRows: classifiedRows.length,
      uniqueTargets: classifiedResults.length,
      verifiedPassTargets: classifiedResults.filter(result => result.classification === 'verified_pass').length,
      softFailAdvisoryTargets: classifiedResults.filter(result => result.classification === 'soft_fail_advisory').length,
      hardFailTargets: classifiedResults.filter(result => result.classification === 'hard_fail').length,
      verifiedPassPublicationRows: classifiedRows.filter(row => row.classification === 'verified_pass').length,
      softFailAdvisoryPublicationRows: classifiedRows.filter(row => row.classification === 'soft_fail_advisory').length,
      hardFailPublicationRows: classifiedRows.filter(row => row.classification === 'hard_fail').length,
    },
    breakdownBySourceKind: Object.fromEntries(
      Array.from(new Set(classifiedRows.map(row => row.sourceKind))).sort().map(sourceKind => {
        const rows = classifiedRows.filter(row => row.sourceKind === sourceKind)
        return [sourceKind, {
          total: rows.length,
          verifiedPass: rows.filter(row => row.classification === 'verified_pass').length,
          softFailAdvisory: rows.filter(row => row.classification === 'soft_fail_advisory').length,
          hardFail: rows.filter(row => row.classification === 'hard_fail').length,
        }]
      }),
    ),
    advisoryReasons: Object.fromEntries(
      Array.from(
        classifiedResults
          .filter(result => result.classification === 'soft_fail_advisory')
          .reduce((map, result) => {
            for (const reason of result.gate.reasons || []) {
              map.set(reason, (map.get(reason) || 0) + 1)
            }
            return map
          }, new Map<string, number>())
          .entries(),
      ).sort((a, b) => b[1] - a[1]),
    ),
  }

  writeJson(outputPath, {
    generatedAt: summary.generatedAt,
    basedOn: sourcePath,
    summary: summary.totals,
    breakdownBySourceKind: summary.breakdownBySourceKind,
    verificationResults: classifiedResults,
    publicationRows: classifiedRows,
  })
  writeJson(summaryPath, summary)

  console.log(JSON.stringify(summary, null, 2))
}

main()
