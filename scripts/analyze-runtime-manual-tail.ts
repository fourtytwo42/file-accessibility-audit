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
  buildRuntimeTailAnalysisSummary,
  classifyRuntimeTailRow,
} from '../apps/api/src/services/runtimeTailClassifier.ts'

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

export async function main(): Promise<void> {
  const sources = loadCorpusControlPlaneSources()
  const baseArtifacts = buildCorpusControlPlaneArtifactsFromSources(sources)
  const stage2Artifacts = applyStage2ShortCohortReclassification(baseArtifacts, sources)
  const stage3Artifacts = applyStage3FigureWaveReclassification(stage2Artifacts)
  const artifacts = applyStage4StructureWaveReclassification(stage3Artifacts, sources.stage4PendingAnalysisRows, sources.stage4ActiveAnalysisRows, sources.stage4StalledAnalysisRows, sources.stage4OverlapAnalysisRows, sources.stage4ActiveForensicsRows, sources.stage4HomogeneousAnalysisRows)
  const validation = validateCorpusControlPlaneArtifacts(artifacts, {
    replacementMap: sources.replacementMap,
    promotionLedgerRows: sources.promotionLedgerRows,
  })

  const rows = artifacts.document.rows
    .map(classifyRuntimeTailRow)
    .filter(row => row.disposition !== 'not_runtime_tail')
    .sort((left, right) => left.publicationId.localeCompare(right.publicationId))
  const summary = buildRuntimeTailAnalysisSummary(artifacts)

  const analysisPath = path.join(sources.manifestsRoot, 'runtime-manual-tail-analysis.json')
  const summaryPath = path.join(sources.manifestsRoot, 'runtime-manual-tail-analysis.summary.json')
  writeJson(analysisPath, {
    generatedAt: summary.generatedAt,
    sourceControlPlanePath: path.join(sources.manifestsRoot, 'corpus-control-plane.json'),
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    rows,
  })
  writeJson(summaryPath, {
    ...summary,
    analysisPath,
    validation,
  })

  console.log(JSON.stringify({
    analysisPath,
    summaryPath,
    totals: summary.totals,
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
