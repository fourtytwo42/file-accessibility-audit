import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  CorpusControlPlaneArtifacts,
  CorpusControlPlaneByCohortDocument,
  CorpusControlPlaneCanariesDocument,
  CorpusControlPlaneDocument,
} from '../apps/api/src/services/corpusControlPlane.ts'
import {
  loadCorpusControlPlaneSources,
  validateCorpusControlPlaneArtifacts,
} from '../apps/api/src/services/corpusControlPlane.ts'

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

export async function main(): Promise<void> {
  const sources = loadCorpusControlPlaneSources()
  const corpusPath = path.join(sources.manifestsRoot, 'corpus-control-plane.json')
  const byCohortPath = path.join(sources.manifestsRoot, 'corpus-control-plane.by-cohort.json')
  const canariesPath = path.join(sources.manifestsRoot, 'corpus-control-plane-canaries.json')

  const artifacts: CorpusControlPlaneArtifacts = {
    document: readJson<CorpusControlPlaneDocument>(corpusPath),
    byCohort: readJson<CorpusControlPlaneByCohortDocument>(byCohortPath),
    canaries: readJson<CorpusControlPlaneCanariesDocument>(canariesPath),
  }

  const validation = validateCorpusControlPlaneArtifacts(artifacts, {
    replacementMap: sources.replacementMap,
    promotionLedgerRows: sources.promotionLedgerRows,
  })

  console.log(JSON.stringify(validation, null, 2))
  if (!validation.ok) {
    throw new Error(validation.errors.join(' | '))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
