import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildRecoveryWaveHistory,
  buildRecoveryWaveManifest,
  latestOutcomePerPublication,
  type RecoveryLaneName,
  type RecoveryWaveManifest,
  type RecoveryWaveOutcome,
} from '../apps/api/src/services/sub79RecoveryWave.ts'

type OutcomesDocument = {
  generatedAt?: string | null
  outcomes?: RecoveryWaveOutcome[]
}

const repoRoot = '/home/hendo420/pdfaf'
const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')

const sourceOutcomeFilenames = [
  'all-sub79-recovery.outcomes.json',
  'all-remaining-automated.outcomes.json',
  'all-remaining-dropped-rerun.outcomes.json',
  'all-remaining-79-down-rerun.outcomes.json',
  'all-remaining-79-down-rerun-v2.outcomes.json',
  'all-remaining-60-69-positive-delta-wave.outcomes.json',
  'remediation-batch-outcomes.json',
]

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

export function buildSub79RecoveryWave(laneName: RecoveryLaneName): RecoveryWaveManifest {
  const sourcePaths = sourceOutcomeFilenames
    .map(filename => path.join(manifestsRoot, filename))
    .filter(filePath => fs.existsSync(filePath))

  const sourceDocuments = sourcePaths.map(filePath => readJson<OutcomesDocument>(filePath))
  const allOutcomes = sourceDocuments.flatMap(document => Array.isArray(document.outcomes) ? document.outcomes : [])
  const manifest = buildRecoveryWaveManifest({
    laneName,
    sourceOutcomesPaths: sourcePaths,
    sourceOutcomesGeneratedAt: sourceDocuments
      .map(document => document.generatedAt || null)
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) || null,
    latestOutcomes: latestOutcomePerPublication(allOutcomes),
    historyByPublicationId: buildRecoveryWaveHistory(allOutcomes),
  })

  const manifestPath = path.join(manifestsRoot, `${laneName}.json`)
  const summaryPath = path.join(manifestsRoot, `${laneName}.summary.json`)
  writeJson(manifestPath, manifest)
  writeJson(summaryPath, {
    generatedAt: manifest.generatedAt,
    laneName: manifest.laneName,
    executionPolicy: manifest.executionPolicy,
    executionPolicyReason: manifest.executionPolicyReason,
    sourceOutcomesPaths: manifest.sourceOutcomesPaths,
    totals: manifest.totals,
    blockerSignatureCounts: manifest.blockerSignatureCounts,
    plateauCounts: manifest.plateauCounts,
    topCandidates: manifest.candidates.slice(0, 10).map(candidate => ({
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      overallScore: candidate.overallScore,
      blockerSignature: candidate.blockerSignature,
      blockerFamilies: candidate.blockerFamilies,
      scoreDeltaFromPrior: candidate.scoreDeltaFromPrior,
      plateaued: candidate.plateaued,
      runtimeWeightBucket: candidate.runtimeWeightBucket,
      priorityRank: candidate.priorityRank,
      priorityTier: candidate.priorityTier,
    })),
  })
  return manifest
}

export async function main(): Promise<void> {
  const laneName = process.argv[2] as RecoveryLaneName | undefined
  if (!laneName) {
    throw new Error('Usage: tsx scripts/build-sub79-recovery-wave.ts <laneName>')
  }
  const manifest = buildSub79RecoveryWave(laneName)
  console.log(JSON.stringify({
    laneName: manifest.laneName,
    selectedCandidates: manifest.totals.selectedCandidates,
    plateauedCandidates: manifest.totals.plateauedCandidates,
    outputManifestPath: path.join(manifestsRoot, `${laneName}.json`),
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
