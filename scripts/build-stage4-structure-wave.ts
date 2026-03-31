import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildCorpusControlPlaneArtifactsFromSources,
  loadCorpusControlPlaneSources,
  validateCorpusControlPlaneArtifacts,
} from '../apps/api/src/services/corpusControlPlane.ts'
import { applyStage2ShortCohortReclassification } from '../apps/api/src/services/shortCohortStage2.ts'
import { applyStage3FigureWaveReclassification } from '../apps/api/src/services/figureWaveStage3.ts'
import {
  applyStage4StructureWaveReclassification,
  buildStage4StructureCanaries,
  buildStage4StructureThroughputSummary,
  buildStage4StructureWaveArtifacts,
  buildStage4StructureWaveOutcomesSummary,
} from '../apps/api/src/services/structureWaveStage4.ts'

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

function readJsonIfExists(filePath: string) {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

export async function main(): Promise<void> {
  const sources = loadCorpusControlPlaneSources()
  const baseArtifacts = buildCorpusControlPlaneArtifactsFromSources(sources)
  const stage2Artifacts = applyStage2ShortCohortReclassification(baseArtifacts, sources)
  const stage3Artifacts = applyStage3FigureWaveReclassification(stage2Artifacts)
  const artifacts = applyStage4StructureWaveReclassification(stage3Artifacts, sources.stage4PendingAnalysisRows, sources.stage4ActiveAnalysisRows)
  const validation = validateCorpusControlPlaneArtifacts(artifacts, {
    replacementMap: sources.replacementMap,
    promotionLedgerRows: sources.promotionLedgerRows,
  })

  if (!validation.ok) {
    throw new Error('Cannot build Stage 4 structure wave from an invalid control plane.')
  }

  const wavePath = path.join(sources.manifestsRoot, 'stage4-structure-wave.json')
  const waveSummaryPath = path.join(sources.manifestsRoot, 'stage4-structure-wave.summary.json')
  const throughputSummaryPath = path.join(sources.manifestsRoot, 'stage4-structure-throughput.summary.json')
  const canariesPath = path.join(sources.manifestsRoot, 'stage4-structure-canaries.json')
  const outcomesPath = path.join(sources.manifestsRoot, 'stage4-structure-wave.outcomes.json')
  const outcomesSummaryPath = path.join(sources.manifestsRoot, 'stage4-structure-wave.outcomes.summary.json')

  const maxCandidates = Number(process.env.ICJIA_STAGE4_STRUCTURE_WAVE_LIMIT || 8)
  const includePublicationIds = (process.env.ICJIA_STAGE4_STRUCTURE_WAVE_INCLUDE_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  const waveArtifacts = buildStage4StructureWaveArtifacts({
    artifacts,
    sourceControlPlanePath: path.join(sources.manifestsRoot, 'corpus-control-plane.json'),
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    manifestsRoot: sources.manifestsRoot,
    maxCandidates,
    includePublicationIds,
    pendingAnalysisRows: sources.stage4PendingAnalysisRows,
    activeAnalysisRows: sources.stage4ActiveAnalysisRows,
  })

  const throughputSummary = buildStage4StructureThroughputSummary({
    artifacts,
    sourceControlPlanePath: path.join(sources.manifestsRoot, 'corpus-control-plane.json'),
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    waveManifestPath: wavePath,
    wave: waveArtifacts.wave,
    outcomesPath: fs.existsSync(outcomesPath) ? outcomesPath : null,
    outcomes: readJsonIfExists(outcomesPath),
    pendingAnalysisRows: sources.stage4PendingAnalysisRows,
    activeAnalysisRows: sources.stage4ActiveAnalysisRows,
  })

  const refreshedOutcomesSummary = buildStage4StructureWaveOutcomesSummary({
    wave: waveArtifacts.wave,
    outcomesPath,
    outcomes: readJsonIfExists(outcomesPath),
  })
  const canaries = buildStage4StructureCanaries({ artifacts, sources })

  writeJson(wavePath, waveArtifacts.wave)
  writeJson(waveSummaryPath, waveArtifacts.summary)
  writeJson(throughputSummaryPath, throughputSummary)
  if (refreshedOutcomesSummary) writeJson(outcomesSummaryPath, refreshedOutcomesSummary)
  writeJson(canariesPath, canaries)

  console.log(JSON.stringify({
    wavePath,
    waveSummaryPath,
    throughputSummaryPath,
    canariesPath,
    outcomesSummaryPath: refreshedOutcomesSummary ? outcomesSummaryPath : null,
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
