import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildCorpusControlPlaneArtifactsFromSources,
  loadCorpusControlPlaneSources,
  validateCorpusControlPlaneArtifacts,
} from '../apps/api/src/services/corpusControlPlane.ts'
import { applyStage2ShortCohortReclassification } from '../apps/api/src/services/shortCohortStage2.ts'
import {
  applyStage3FigureWaveReclassification,
  buildStage3FigureCanaries,
  buildStage3FigureThroughputSummary,
  buildStage3FigureWaveArtifacts,
} from '../apps/api/src/services/figureWaveStage3.ts'

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

export async function main(): Promise<void> {
  const sources = loadCorpusControlPlaneSources()
  const baseArtifacts = buildCorpusControlPlaneArtifactsFromSources(sources)
  const stage2Artifacts = applyStage2ShortCohortReclassification(baseArtifacts, sources)
  const artifacts = applyStage3FigureWaveReclassification(stage2Artifacts)
  const validation = validateCorpusControlPlaneArtifacts(artifacts, {
    replacementMap: sources.replacementMap,
    promotionLedgerRows: sources.promotionLedgerRows,
  })

  if (!validation.ok) {
    throw new Error('Cannot build Stage 3 figure wave from an invalid control plane.')
  }

  const wavePath = path.join(sources.manifestsRoot, 'stage3-figure-wave.json')
  const waveSummaryPath = path.join(sources.manifestsRoot, 'stage3-figure-wave.summary.json')
  const throughputSummaryPath = path.join(sources.manifestsRoot, 'stage3-figure-throughput.summary.json')
  const canariesPath = path.join(sources.manifestsRoot, 'stage3-figure-canaries.json')
  const outcomesPath = path.join(sources.manifestsRoot, 'stage3-figure-wave.outcomes.json')

  const maxCandidates = Number(process.env.ICJIA_STAGE3_FIGURE_WAVE_LIMIT || 8)
  const waveArtifacts = buildStage3FigureWaveArtifacts({
    artifacts,
    sourceControlPlanePath: path.join(sources.manifestsRoot, 'corpus-control-plane.json'),
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    manifestsRoot: sources.manifestsRoot,
    maxCandidates,
  })

  const throughputSummary = buildStage3FigureThroughputSummary({
    artifacts,
    sourceControlPlanePath: path.join(sources.manifestsRoot, 'corpus-control-plane.json'),
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    waveManifestPath: wavePath,
    wave: waveArtifacts.wave,
    outcomesPath: fs.existsSync(outcomesPath) ? outcomesPath : null,
    outcomes: readJsonIfExists<{ outcomes?: Array<{ publicationId: string | null; status: string | null }> }>(outcomesPath),
  })

  const canaries = buildStage3FigureCanaries({ artifacts, sources })

  writeJson(wavePath, waveArtifacts.wave)
  writeJson(waveSummaryPath, waveArtifacts.summary)
  writeJson(throughputSummaryPath, throughputSummary)
  writeJson(canariesPath, canaries)

  console.log(JSON.stringify({
    wavePath,
    waveSummaryPath,
    throughputSummaryPath,
    canariesPath,
    totals: waveArtifacts.wave.totals,
    selectedPublicationIds: waveArtifacts.wave.selectedPublicationIds,
    throughput: throughputSummary.totals,
    canaries: canaries.summary,
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
