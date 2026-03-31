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

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
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

  const corpusPath = path.join(sources.manifestsRoot, 'corpus-control-plane.json')
  const summaryPath = path.join(sources.manifestsRoot, 'corpus-control-plane.summary.json')
  const byCohortPath = path.join(sources.manifestsRoot, 'corpus-control-plane.by-cohort.json')
  const canariesPath = path.join(sources.manifestsRoot, 'corpus-control-plane-canaries.json')

  writeJson(corpusPath, artifacts.document)
  writeJson(summaryPath, {
    generatedAt: artifacts.document.generatedAt,
    summary: artifacts.document.summary,
    validation,
    sources: {
      replacementMapPath: sources.replacementMapPath,
      verificationPath: sources.verificationPath,
      verificationClassifiedPath: sources.verificationClassifiedPath,
      promotionLedgerPath: sources.promotionLedgerPath,
      regressionBenchmarkPath: sources.regressionBenchmarkPath,
      outcomeManifestCount: sources.outcomeManifests.length,
      candidateManifestCount: sources.candidateManifests.length,
    },
  })
  writeJson(byCohortPath, artifacts.byCohort)
  writeJson(canariesPath, artifacts.canaries)

  console.log(JSON.stringify({
    corpusPath,
    summaryPath,
    byCohortPath,
    canariesPath,
    summary: artifacts.document.summary,
    validation,
  }, null, 2))

  if (!validation.ok) {
    throw new Error(`Corpus control plane validation failed: ${validation.errors.join(' | ')}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
