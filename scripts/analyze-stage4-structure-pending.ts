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
  buildStage4StructurePendingAnalysis,
} from '../apps/api/src/services/structureWaveStage4.ts'

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

export async function main(): Promise<void> {
  const sources = loadCorpusControlPlaneSources()
  const baseArtifacts = buildCorpusControlPlaneArtifactsFromSources(sources)
  const stage2Artifacts = applyStage2ShortCohortReclassification(baseArtifacts, sources)
  const stage3Artifacts = applyStage3FigureWaveReclassification(stage2Artifacts)
  const stage4Artifacts = applyStage4StructureWaveReclassification(stage3Artifacts, [], [], sources.stage4StalledAnalysisRows, sources.stage4OverlapAnalysisRows)

  const analysisArtifacts = buildStage4StructurePendingAnalysis({
    artifacts: stage4Artifacts,
    sourceControlPlanePath: path.join(sources.manifestsRoot, 'corpus-control-plane.json'),
    sourceControlPlaneGeneratedAt: stage4Artifacts.document.generatedAt,
    manifestsRoot: sources.manifestsRoot,
  })

  const analysisPath = path.join(sources.manifestsRoot, 'stage4-structure-pending-analysis.json')
  const summaryPath = path.join(sources.manifestsRoot, 'stage4-structure-pending-analysis.summary.json')

  writeJson(analysisPath, analysisArtifacts.analysis)
  writeJson(summaryPath, analysisArtifacts.summary)

  console.log(JSON.stringify({
    analysisPath,
    summaryPath,
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
