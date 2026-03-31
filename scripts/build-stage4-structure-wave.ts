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
  type Stage4StructureWaveDocument,
} from '../apps/api/src/services/structureWaveStage4.ts'

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

function readJsonIfExists(filePath: string) {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function terminalPublicationIdsFromOutcomes(outcomesDoc: { outcomes?: Array<{ publicationId?: string | null; status?: string | null }> } | null): Set<string> {
  return new Set(
    (outcomesDoc?.outcomes || [])
      .filter(outcome => ['failed_after_remediation', 'processing_error', 'ready_to_replace', 'remediated_pass_candidate', 'source_missing'].includes(outcome.status || ''))
      .map(outcome => outcome.publicationId)
      .filter((value): value is string => Boolean(value)),
  )
}

function latestProcessedAtMillis(outcome: { processedAt?: string | null }): number | null {
  if (!outcome.processedAt) return null
  const parsed = Date.parse(outcome.processedAt)
  return Number.isFinite(parsed) ? parsed : null
}

function deriveLatestCompletedWavePublicationIds(input: {
  existingOutcomes: { outcomes?: Array<{ publicationId?: string | null; status?: string | null; processedAt?: string | null }> } | null
  excludedPublicationIds: string[]
  minRows: number
  maxGapMs?: number
}): string[] {
  const { existingOutcomes, excludedPublicationIds, minRows, maxGapMs = 15 * 60 * 1000 } = input
  const terminalStatuses = new Set(['failed_after_remediation', 'processing_error', 'ready_to_replace', 'remediated_pass_candidate', 'source_missing'])
  const excluded = new Set(excludedPublicationIds)
  const outcomes = (existingOutcomes?.outcomes || []).filter(outcome => {
    return Boolean(outcome.publicationId) && terminalStatuses.has(outcome.status || '') && !excluded.has(String(outcome.publicationId))
  })
  if (!outcomes.length) return []

  const selected: Array<{ publicationId: string; processedAtMs: number | null }> = []
  const seen = new Set<string>()
  let anchorProcessedAt: number | null = null
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    const outcome = outcomes[index]
    const publicationId = String(outcome.publicationId)
    const processedAtMs = latestProcessedAtMillis(outcome)
    if (seen.has(publicationId)) continue
    if (anchorProcessedAt !== null && processedAtMs !== null && anchorProcessedAt - processedAtMs > maxGapMs) {
      break
    }
    if (anchorProcessedAt === null && processedAtMs !== null) anchorProcessedAt = processedAtMs
    seen.add(publicationId)
    selected.push({ publicationId, processedAtMs })
  }

  if (selected.length < minRows) return []
  return selected
    .sort((left, right) => {
      const leftTs = left.processedAtMs ?? 0
      const rightTs = right.processedAtMs ?? 0
      if (leftTs !== rightTs) return leftTs - rightTs
      return left.publicationId.localeCompare(right.publicationId)
    })
    .map(row => row.publicationId)
}

function chooseReportingWave(input: {
  existingWave: Stage4StructureWaveDocument | null
  existingOutcomes: { outcomes?: Array<{ publicationId?: string | null; status?: string | null; processedAt?: string | null }> } | null
  existingOutcomesSummary: { totals?: { targetCandidates?: number | null } | null } | null
  nextWave: Stage4StructureWaveDocument
  sourceControlPlanePath: string
  sourceControlPlaneGeneratedAt: string
  fallbackPublicationIds?: string[]
}): Stage4StructureWaveDocument {
  const { existingWave, existingOutcomes, existingOutcomesSummary, nextWave, sourceControlPlanePath, sourceControlPlaneGeneratedAt, fallbackPublicationIds = [] } = input
  const terminalIds = terminalPublicationIdsFromOutcomes(existingOutcomes)
  if (existingWave) {
    const selectedIds = existingWave.selectedPublicationIds || []
    if (selectedIds.length > 0 && selectedIds.every(publicationId => terminalIds.has(publicationId))) {
      return existingWave
    }
  }

  const minRows = Number(existingOutcomesSummary?.totals?.targetCandidates || 0)
  const latestCompletedWavePublicationIds = deriveLatestCompletedWavePublicationIds({
    existingOutcomes,
    excludedPublicationIds: nextWave.selectedPublicationIds || [],
    minRows: minRows > 0 ? minRows : 1,
  })
  if (latestCompletedWavePublicationIds.length > 0) {
    return {
      generatedAt: new Date().toISOString(),
      sourceControlPlanePath,
      sourceControlPlaneGeneratedAt,
      waveName: 'stage4-structure-wave',
      cohortLabel: 'structure_heavy',
      maxCandidates: latestCompletedWavePublicationIds.length,
      totals: {
        eligibleRows: latestCompletedWavePublicationIds.length,
        selectedRows: latestCompletedWavePublicationIds.length,
        skippedRows: 0,
        pendingRows: 0,
      },
      selectedPublicationIds: latestCompletedWavePublicationIds,
      pendingPublicationIds: [],
      candidates: [],
      skippedRows: [],
    }
  }

  const fallbackIds = Array.from(new Set(fallbackPublicationIds.filter(Boolean))).sort()
  if (fallbackIds.length > 0 && fallbackIds.every(publicationId => terminalIds.has(publicationId))) {
    return {
      generatedAt: new Date().toISOString(),
      sourceControlPlanePath,
      sourceControlPlaneGeneratedAt,
      waveName: 'stage4-structure-wave',
      cohortLabel: 'structure_heavy',
      maxCandidates: fallbackIds.length,
      totals: {
        eligibleRows: fallbackIds.length,
        selectedRows: fallbackIds.length,
        skippedRows: 0,
        pendingRows: 0,
      },
      selectedPublicationIds: fallbackIds,
      pendingPublicationIds: [],
      candidates: [],
      skippedRows: [],
    }
  }

  return nextWave
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

  if (!validation.ok) {
    throw new Error('Cannot build Stage 4 structure wave from an invalid control plane.')
  }

  const wavePath = path.join(sources.manifestsRoot, 'stage4-structure-wave.json')
  const waveSummaryPath = path.join(sources.manifestsRoot, 'stage4-structure-wave.summary.json')
  const throughputSummaryPath = path.join(sources.manifestsRoot, 'stage4-structure-throughput.summary.json')
  const canariesPath = path.join(sources.manifestsRoot, 'stage4-structure-canaries.json')
  const outcomesPath = path.join(sources.manifestsRoot, 'stage4-structure-wave.outcomes.json')
  const outcomesSummaryPath = path.join(sources.manifestsRoot, 'stage4-structure-wave.outcomes.summary.json')

  const existingWave = readJsonIfExists(wavePath) as Stage4StructureWaveDocument | null
  const existingOutcomes = readJsonIfExists(outcomesPath) as { outcomes?: Array<{ publicationId?: string | null; status?: string | null; processedAt?: string | null }> } | null
  const existingOutcomesSummary = readJsonIfExists(outcomesSummaryPath) as { totals?: { targetCandidates?: number | null } | null } | null

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
    stalledAnalysisRows: sources.stage4StalledAnalysisRows,
    overlapAnalysisRows: sources.stage4OverlapAnalysisRows,
    activeForensicsRows: sources.stage4ActiveForensicsRows,
    homogeneousAnalysisRows: sources.stage4HomogeneousAnalysisRows,
  })

  const reportingWave = chooseReportingWave({
    existingWave,
    existingOutcomes,
    existingOutcomesSummary,
    nextWave: waveArtifacts.wave,
    sourceControlPlanePath: path.join(sources.manifestsRoot, 'corpus-control-plane.json'),
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    fallbackPublicationIds: (sources.stage4ActiveAnalysisRows || []).map(row => row.publicationId),
  })

  const throughputSummary = buildStage4StructureThroughputSummary({
    artifacts,
    sourceControlPlanePath: path.join(sources.manifestsRoot, 'corpus-control-plane.json'),
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    waveManifestPath: wavePath,
    wave: reportingWave,
    activeWave: waveArtifacts.wave,
    outcomesPath: fs.existsSync(outcomesPath) ? outcomesPath : null,
    outcomes: existingOutcomes,
    pendingAnalysisRows: sources.stage4PendingAnalysisRows,
    activeAnalysisRows: sources.stage4ActiveAnalysisRows,
    stalledAnalysisRows: sources.stage4StalledAnalysisRows,
    overlapAnalysisRows: sources.stage4OverlapAnalysisRows,
    activeForensicsRows: sources.stage4ActiveForensicsRows,
    homogeneousAnalysisRows: sources.stage4HomogeneousAnalysisRows,
  })

  const refreshedOutcomesSummary = buildStage4StructureWaveOutcomesSummary({
    wave: reportingWave,
    outcomesPath,
    outcomes: existingOutcomes,
  })
  const canaries = buildStage4StructureCanaries({ artifacts, sources, reportingWavePublicationIds: reportingWave.selectedPublicationIds })

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
    reportingWaveSelectedPublicationIds: reportingWave.selectedPublicationIds,
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
