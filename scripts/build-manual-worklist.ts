import fs from 'node:fs'
import path from 'node:path'
import {
  buildManualWorklist,
  summarizeManualWorklistOutcomes,
  type ManualWorklistOutcomeDocument,
} from '../apps/api/src/services/manualWorklist.ts'

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  return readJson<T>(filePath)
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function findPdfByPublicationId(root: string, publicationId: string): string | null {
  const stack = [root]
  const matches: string[] = []
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || !fs.existsSync(current)) continue
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.pdf')) continue
      if (entry.name.startsWith(`${publicationId}-`)) matches.push(fullPath)
    }
  }
  const preferredRoots = [
    `${path.sep}medium-figure-conversion${path.sep}`,
    `${path.sep}small-fast-pass${path.sep}`,
    `${path.sep}stage4-structure-wave${path.sep}`,
    `${path.sep}stage3-figure-wave${path.sep}`,
  ]
  for (const preferred of preferredRoots) {
    const hit = matches.find(file => file.includes(preferred))
    if (hit) return hit
  }
  return matches[0] || null
}

export async function main(): Promise<void> {
  const repoRoot = process.cwd()
  const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')
  const figureFinalMilePath = path.join(manifestsRoot, 'figure-final-mile-closure.json')
  const worklistPath = path.join(manifestsRoot, 'manual-worklist.json')
  const worklistSummaryPath = path.join(manifestsRoot, 'manual-worklist.summary.json')
  const outcomesPath = path.join(manifestsRoot, 'manual-worklist.outcomes.json')
  const outcomesSummaryPath = path.join(manifestsRoot, 'manual-worklist.outcomes.summary.json')
  const figureFinalMile = readJson<{ sourceControlPlanePath: string; sourceControlPlaneGeneratedAt: string; candidates: Array<any> }>(figureFinalMilePath)
  const remediatedRoot = path.join(repoRoot, 'ICJIA-PDFs', 'artifacts', 'remediated-pdfs')

  const worklist = buildManualWorklist({
    sourceControlPlanePath: figureFinalMile.sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: figureFinalMile.sourceControlPlaneGeneratedAt,
    sourceFigureFinalMileClosurePath: figureFinalMilePath,
    candidates: figureFinalMile.candidates.map(candidate => ({
      publicationId: String(candidate.publicationId),
      publicationTitle: candidate.publicationTitle ? String(candidate.publicationTitle) : null,
      serverHost: String(candidate.serverHost || 'unknown-host'),
      localCachePath: candidate.localCachePath ? String(candidate.localCachePath) : null,
      bestManualInputPath: findPdfByPublicationId(remediatedRoot, String(candidate.publicationId)),
      dominantResidualFamily: 'figure' as const,
      blockingFindingKeys: Array.isArray(candidate.blockingFindingKeys) ? candidate.blockingFindingKeys.map(String) : [],
      pageCount: Number(candidate.pageCount || 0),
      runtimeWeightBucket: candidate.runtimeWeightBucket === 'heavy' || candidate.runtimeWeightBucket === 'medium' ? candidate.runtimeWeightBucket : 'light',
    })),
  })

  writeJson(worklistPath, worklist)
  writeJson(worklistSummaryPath, {
    generatedAt: worklist.generatedAt,
    queueName: worklist.queueName,
    queueIntent: worklist.queueIntent,
    totalCandidates: worklist.candidates.length,
    selectedPublicationIds: worklist.selectedPublicationIds,
    sourceFigureFinalMileClosurePath: worklist.sourceFigureFinalMileClosurePath,
  })

  const existingOutcomes = readJsonIfExists<ManualWorklistOutcomeDocument>(outcomesPath)
    || { generatedAt: new Date().toISOString(), queueName: 'manual-worklist' as const, outcomes: [] }
  writeJson(outcomesPath, existingOutcomes)
  writeJson(outcomesSummaryPath, summarizeManualWorklistOutcomes(existingOutcomes))

  console.log(JSON.stringify({
    worklistPath,
    worklistSummaryPath,
    outcomesPath,
    outcomesSummaryPath,
    selectedPublicationIds: worklist.selectedPublicationIds,
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
