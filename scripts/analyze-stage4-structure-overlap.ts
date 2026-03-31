import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildCorpusControlPlaneArtifactsFromSources,
  loadCorpusControlPlaneSources,
} from '../apps/api/src/services/corpusControlPlane.ts'
import { applyStage2ShortCohortReclassification } from '../apps/api/src/services/shortCohortStage2.ts'
import { applyStage3FigureWaveReclassification } from '../apps/api/src/services/figureWaveStage3.ts'
import {
  applyStage4StructureWaveReclassification,
  buildStage4StructureOverlapAnalysis,
} from '../apps/api/src/services/structureWaveStage4.ts'

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

export async function main(): Promise<void> {
  const sources = loadCorpusControlPlaneSources()
  const includePublicationIds = (process.env.ICJIA_STAGE4_STRUCTURE_OVERLAP_INCLUDE_IDS || '3877,3903')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  const baseArtifacts = buildCorpusControlPlaneArtifactsFromSources(sources)
  const stage2Artifacts = applyStage2ShortCohortReclassification(baseArtifacts, sources)
  const stage3Artifacts = applyStage3FigureWaveReclassification(stage2Artifacts)
  const stage4Artifacts = applyStage4StructureWaveReclassification(
    stage3Artifacts,
    sources.stage4PendingAnalysisRows,
    sources.stage4ActiveAnalysisRows,
    sources.stage4StalledAnalysisRows,
    [],
    sources.stage4ActiveForensicsRows,
    sources.stage4HomogeneousAnalysisRows,
  )

  const analysisArtifacts = buildStage4StructureOverlapAnalysis({
    artifacts: stage4Artifacts,
    sourceControlPlanePath: path.join(sources.manifestsRoot, 'corpus-control-plane.json'),
    sourceControlPlaneGeneratedAt: stage4Artifacts.document.generatedAt,
    manifestsRoot: sources.manifestsRoot,
    includePublicationIds,
  })

  const analysisPath = path.join(sources.manifestsRoot, 'stage4-structure-overlap-analysis.json')
  const summaryPath = path.join(sources.manifestsRoot, 'stage4-structure-overlap-analysis.summary.json')

  writeJson(analysisPath, analysisArtifacts.analysis)
  writeJson(summaryPath, analysisArtifacts.summary)

  console.log(JSON.stringify({
    analysisPath,
    summaryPath,
    includePublicationIds,
    totals: analysisArtifacts.summary.totals,
    publicationIdsByDisposition: analysisArtifacts.summary.publicationIdsByDisposition,
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
