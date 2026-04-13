import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildBatchStatusSnapshot,
  formatDurationCompact,
  readJsonIfExists,
  type ProgressCompatibleOutcome,
  type RemediationBatchProgressDocument,
} from './remediation-batch-progress.ts'

const repoRoot = '/home/hendo420/pdfaf'
const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')
const laneName = 'all-remaining-60-69-material-wave'
const manifestPath = path.join(manifestsRoot, `${laneName}.json`)
const outcomesPath = path.join(manifestsRoot, `${laneName}.outcomes.json`)
const progressPath = outcomesPath.replace(/\.json$/i, '.progress.json')

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function buildSnapshot() {
  const manifest = fs.existsSync(manifestPath)
    ? readJson<{ candidates?: unknown[]; scorePolicy?: { minPassOverallScore?: number | null; minKeepOverallScore?: number | null } }>(manifestPath)
    : { candidates: [] }
  const outcomes = readJsonIfExists<{ outcomes?: ProgressCompatibleOutcome[] }>(outcomesPath)
  const progress = readJsonIfExists<RemediationBatchProgressDocument>(progressPath)

  return buildBatchStatusSnapshot({
    manifestPath,
    outcomesPath,
    progressPath,
    totalCandidates: Array.isArray(manifest.candidates) ? manifest.candidates.length : 0,
    outcomes: outcomes?.outcomes || [],
    progress,
    defaultScorePolicy: manifest.scorePolicy
      ? {
          minPassOverallScore: manifest.scorePolicy.minPassOverallScore ?? 90,
          minKeepOverallScore: manifest.scorePolicy.minKeepOverallScore ?? null,
        }
      : undefined,
  })
}

function printHuman(snapshot: ReturnType<typeof buildSnapshot>): void {
  const rate = snapshot.pdfsPerHour == null ? 'unknown' : `${snapshot.pdfsPerHour.toFixed(2)} PDFs/hr`
  const eta = snapshot.etaMs == null ? 'unknown' : formatDurationCompact(snapshot.etaMs)
  const started = snapshot.firstStartedAt || 'n/a'
  const heartbeat = snapshot.lastHeartbeatAt || 'n/a'
  const lastCompleted = snapshot.lastCompleted
    ? `${snapshot.lastCompleted.publicationId || 'unknown'} | ${snapshot.lastCompleted.resultBand} | score ${snapshot.lastCompleted.finalOverallScore ?? 'n/a'}`
    : 'none'

  console.log(`State: ${snapshot.runState}`)
  console.log(`Progress: ${snapshot.processed}/${snapshot.total} (${snapshot.percentComplete.toFixed(1)}%)`)
  console.log(`Remaining: ${snapshot.remaining}`)
  console.log(
    `Results: pass>=90 ${snapshot.countsByResultBand.pass_ge_90} | keep 80-89 ${snapshot.countsByResultBand.keep_fail_80_to_89} | drop <80 ${snapshot.countsByResultBand.drop_fail_lt_80} | processing_error ${snapshot.countsByResultBand.processing_error} | source_missing ${snapshot.countsByResultBand.source_missing}`,
  )
  console.log(`Rate: ${rate}`)
  console.log(`ETA: ${eta}`)
  console.log(`Run: ${snapshot.runId || 'none'}${snapshot.pid ? ` | pid ${snapshot.pid}` : ''}`)
  console.log(`Started: ${started}`)
  console.log(`Last heartbeat: ${heartbeat}`)
  console.log(`Last completed: ${lastCompleted}`)
}

export async function main(): Promise<void> {
  const snapshot = buildSnapshot()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(snapshot, null, 2))
    return
  }
  printHuman(snapshot)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
