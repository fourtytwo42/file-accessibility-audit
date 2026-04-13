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
import { applyStage4StructureWaveReclassification } from '../apps/api/src/services/structureWaveStage4.ts'
import {
  buildStage5FontForensicsArtifacts,
  buildStage5FontThroughputSummary,
  buildStage5FontWaveArtifacts,
} from '../apps/api/src/services/fontWaveStage5.ts'

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
  const stage3Artifacts = applyStage3FigureWaveReclassification(stage2Artifacts)
  const artifacts = applyStage4StructureWaveReclassification(
    stage3Artifacts,
    sources.stage4PendingAnalysisRows,
    sources.stage4ActiveAnalysisRows,
    sources.stage4StalledAnalysisRows,
    sources.stage4OverlapAnalysisRows,
    sources.stage4ActiveForensicsRows,
    sources.stage4HomogeneousAnalysisRows,
  )
  const validation = validateCorpusControlPlaneArtifacts(artifacts, {
    replacementMap: sources.replacementMap,
    promotionLedgerRows: sources.promotionLedgerRows,
  })
  if (!validation.ok) {
    throw new Error('Cannot build Stage 5 font wave from an invalid control plane.')
  }

  const sourceControlPlanePath = path.join(sources.manifestsRoot, 'corpus-control-plane.json')
  const includePublicationIds = (process.env.ICJIA_STAGE5_FONT_WAVE_INCLUDE_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)

  const forensics = buildStage5FontForensicsArtifacts({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    manifestsRoot: sources.manifestsRoot,
    includePublicationIds,
  })

  const maxCandidates = Number(process.env.ICJIA_STAGE5_FONT_WAVE_LIMIT || 8)
  const waveArtifacts = buildStage5FontWaveArtifacts({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    manifestsRoot: sources.manifestsRoot,
    maxCandidates,
    forensicsRows: forensics.document.rows,
    includePublicationIds,
  })

  const forensicsPath = path.join(sources.manifestsRoot, 'stage5-font-forensics.json')
  const forensicsSummaryPath = path.join(sources.manifestsRoot, 'stage5-font-forensics.summary.json')
  const wavePath = path.join(sources.manifestsRoot, 'stage5-font-wave.json')
  const waveSummaryPath = path.join(sources.manifestsRoot, 'stage5-font-wave.summary.json')
  const throughputSummaryPath = path.join(sources.manifestsRoot, 'stage5-font-throughput.summary.json')
  const outcomesPath = path.join(sources.manifestsRoot, 'stage5-font-wave.outcomes.json')

  const throughputSummary = buildStage5FontThroughputSummary({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    waveManifestPath: wavePath,
    wave: waveArtifacts.wave,
    waveOutcomesPath: fs.existsSync(outcomesPath) ? outcomesPath : null,
    outcomes: readJsonIfExists<{ outcomes?: Array<{ publicationId?: string | null; status?: string | null }> }>(outcomesPath),
    forensicsManifestPath: forensicsPath,
    forensicsRows: forensics.document.rows,
  })

  writeJson(forensicsPath, forensics.document)
  writeJson(forensicsSummaryPath, forensics.summary)
  writeJson(wavePath, waveArtifacts.wave)
  writeJson(waveSummaryPath, waveArtifacts.summary)
  writeJson(throughputSummaryPath, throughputSummary)

  console.log(JSON.stringify({
    forensicsPath,
    forensicsSummaryPath,
    wavePath,
    waveSummaryPath,
    throughputSummaryPath,
    totals: waveArtifacts.wave.totals,
    selectedPublicationIds: waveArtifacts.wave.selectedPublicationIds,
    throughput: throughputSummary.totals,
    publicationIdsByDisposition: forensics.summary.publicationIdsByDisposition,
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
