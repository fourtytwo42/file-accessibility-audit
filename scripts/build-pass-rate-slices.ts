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
  buildAllRemainingAutomatedLane,
  buildManualScannedDeferredLane,
  buildMediumFigureConversionLane,
  buildFigureFinalMileClosureCohort,
  buildPassRateFigureCanary,
  buildPassRateFontCanary,
  buildReplacementLikelihoodLane,
  buildSerialHeavyMixedTerminalizationLane,
  buildSmallFastPassLane,
  buildRuntimeFigureRetrySlice,
  buildRuntimeMixedTerminalizationSlice,
  buildRuntimeRetryWave,
  buildRuntimeStructureRetrySlice,
  type RuntimeRetryPriorOutcome,
} from '../apps/api/src/services/passRateWaveSlices.ts'
import {
  buildResidualFamilyClosureReport,
  type HistoricalClosureOutcome,
} from '../apps/api/src/services/residualFamilyClosureReport.ts'
import {
  buildManualWorklist,
  summarizeManualWorklistOutcomes,
  type ManualWorklistOutcomeDocument,
} from '../apps/api/src/services/manualWorklist.ts'

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function collectLatestHistoricalOutcomes(manifestsRoot: string): Map<string, HistoricalClosureOutcome> {
  const latestByPublicationId = new Map<string, HistoricalClosureOutcome>()
  for (const fileName of fs.readdirSync(manifestsRoot)) {
    if (!fileName.endsWith('.outcomes.json')) continue
    const fullPath = path.join(manifestsRoot, fileName)
    const doc = readJsonIfExists<{ outcomes?: Array<{
      publicationId?: string | null
      status?: string | null
      processedAt?: string | null
      beforeBlockingFindingKeys?: string[] | null
      afterBlockingFindingKeys?: string[] | null
      blockingFindingKeys?: string[] | null
      gate?: { blockingLocalFindingKeys?: string[] | null } | null
    }> }>(fullPath)
    for (const outcome of doc?.outcomes || []) {
      const publicationId = String(outcome.publicationId || '').trim()
      const status = String(outcome.status || '').trim()
      if (!publicationId || !status) continue
      const processedAt = outcome.processedAt ? String(outcome.processedAt) : null
      const gateBlockingKeys = outcome.afterBlockingFindingKeys || outcome.gate?.blockingLocalFindingKeys || []
      const initialBlockingKeys = outcome.beforeBlockingFindingKeys || outcome.blockingFindingKeys || []
      const blockingFindingShrink = gateBlockingKeys.length < initialBlockingKeys.length
      const current = latestByPublicationId.get(publicationId)
      if (!current || String(current.processedAt || '') < String(processedAt || '')) {
        latestByPublicationId.set(publicationId, {
          publicationId,
          status,
          processedAt,
          blockingFindingShrink,
          blockingLocalFindingKeys: gateBlockingKeys,
        })
      }
    }
  }
  return latestByPublicationId
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
    throw new Error('Cannot build pass-rate slices from an invalid control plane.')
  }

  const sourceControlPlanePath = path.join(sources.manifestsRoot, 'corpus-control-plane.json')
  const manualOutcomesPath = path.join(sources.manifestsRoot, 'manual-worklist.outcomes.json')
  const manualOutcomesSummaryPath = path.join(sources.manifestsRoot, 'manual-worklist.outcomes.summary.json')
  const maxFigureCandidates = Number(process.env.ICJIA_PASS_RATE_FIGURE_CANARY_LIMIT || 8)
  const maxFontCandidates = Number(process.env.ICJIA_PASS_RATE_FONT_CANARY_LIMIT || 8)
  const priorRuntimeOutcomes = readJsonIfExists<{ outcomes?: Array<{
    publicationId?: string | null
    status?: RuntimeRetryPriorOutcome['status'] | null
    final?: { overallScore?: number | null } | null
    gate?: { blockingLocalFindingKeys?: string[] | null } | null
  }> }>(path.join(sources.manifestsRoot, 'runtime-tail-retry-wave.outcomes.json'))
  const priorOutcomeMap = new Map<string, RuntimeRetryPriorOutcome>()
  for (const outcome of priorRuntimeOutcomes?.outcomes || []) {
    const publicationId = String(outcome.publicationId || '').trim()
    const status = outcome.status || null
    if (!publicationId || !status) continue
    priorOutcomeMap.set(publicationId, {
      publicationId,
      status,
      finalOverallScore: outcome.final?.overallScore ?? null,
      blockingLocalFindingKeys: outcome.gate?.blockingLocalFindingKeys || [],
    })
  }
  const manualOutcomes = readJsonIfExists<ManualWorklistOutcomeDocument>(manualOutcomesPath)
    || { generatedAt: new Date().toISOString(), queueName: 'manual-worklist', outcomes: [] }
  const manualOutcomeByPublicationId = new Map(
    manualOutcomes.outcomes.map(outcome => [
      outcome.publicationId,
      {
        status: outcome.status,
        manualResolutionReason: outcome.manualResolutionReason,
      },
    ]),
  )

  const figureCanary = buildPassRateFigureCanary({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    maxCandidates: maxFigureCandidates,
    manualOutcomeByPublicationId,
  })
  const fontCanary = buildPassRateFontCanary({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    maxCandidates: maxFontCandidates,
    manualOutcomeByPublicationId,
  })
  const runtimeRetryWave = buildRuntimeRetryWave({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    manualOutcomeByPublicationId,
  })
  const runtimeFigureRetry = buildRuntimeFigureRetrySlice({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    priorOutcomes: priorOutcomeMap,
    manualOutcomeByPublicationId,
  })
  const runtimeStructureRetry = buildRuntimeStructureRetrySlice({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    priorOutcomes: priorOutcomeMap,
    manualOutcomeByPublicationId,
  })
  const runtimeMixedTerminalization = buildRuntimeMixedTerminalizationSlice({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    priorOutcomes: priorOutcomeMap,
    manualOutcomeByPublicationId,
  })
  const smallFastPass = buildSmallFastPassLane({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    manualOutcomeByPublicationId,
  })
  const mediumFigureConversion = buildMediumFigureConversionLane({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    manualOutcomeByPublicationId,
  })
  const serialHeavyMixedTerminalization = buildSerialHeavyMixedTerminalizationLane({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    manualOutcomeByPublicationId,
  })
  const manualScannedDeferred = buildManualScannedDeferredLane({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    manualOutcomeByPublicationId,
  })
  const allRemainingAutomated = buildAllRemainingAutomatedLane({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    manualOutcomeByPublicationId,
  })
  const replacementLikelihood = buildReplacementLikelihoodLane({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    manualOutcomeByPublicationId,
  })
  const latestHistoricalOutcomes = collectLatestHistoricalOutcomes(sources.manifestsRoot)
  const residualFamilyClosureReport = buildResidualFamilyClosureReport({
    artifacts,
    latestOutcomeByPublicationId: latestHistoricalOutcomes,
    manualOutcomeByPublicationId,
  })
  const figureFinalMileClosure = buildFigureFinalMileClosureCohort({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    latestOutcomeByPublicationId: new Map(
      [...latestHistoricalOutcomes.entries()].map(([publicationId, value]) => [
        publicationId,
        {
          status: value.status,
          processedAt: value.processedAt,
          blockingFindingShrink: value.blockingFindingShrink,
        },
      ]),
    ),
    manualOutcomeByPublicationId,
  })
  const manualFigureFinalMileSource = buildFigureFinalMileClosureCohort({
    artifacts,
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    latestOutcomeByPublicationId: new Map(
      [...latestHistoricalOutcomes.entries()].map(([publicationId, value]) => [
        publicationId,
        {
          status: value.status,
          processedAt: value.processedAt,
          blockingFindingShrink: value.blockingFindingShrink,
        },
      ]),
    ),
  })
  const manualWorklist = buildManualWorklist({
    sourceControlPlanePath,
    sourceControlPlaneGeneratedAt: artifacts.document.generatedAt,
    sourceFigureFinalMileClosurePath: path.join(sources.manifestsRoot, 'figure-final-mile-closure.json'),
    candidates: manualFigureFinalMileSource.candidates.map(candidate => ({
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      serverHost: candidate.serverHost,
      localCachePath: candidate.localCachePath,
      bestManualInputPath: candidate.localCachePath,
      dominantResidualFamily: candidate.dominantFamily,
      blockingFindingKeys: candidate.blockingFindingKeys,
      pageCount: candidate.pageCount,
      runtimeWeightBucket: candidate.runtimeWeightBucket,
    })),
  })
  const manualOutcomesSummary = summarizeManualWorklistOutcomes(manualOutcomes)

  const figurePath = path.join(sources.manifestsRoot, 'pass-rate-figure-canary.json')
  const figureSummaryPath = path.join(sources.manifestsRoot, 'pass-rate-figure-canary.summary.json')
  const fontPath = path.join(sources.manifestsRoot, 'pass-rate-font-canary.json')
  const fontSummaryPath = path.join(sources.manifestsRoot, 'pass-rate-font-canary.summary.json')
  const runtimePath = path.join(sources.manifestsRoot, 'runtime-tail-retry-wave.json')
  const runtimeSummaryPath = path.join(sources.manifestsRoot, 'runtime-tail-retry-wave.summary.json')
  const runtimeFigurePath = path.join(sources.manifestsRoot, 'runtime-tail-figure-retry.json')
  const runtimeFigureSummaryPath = path.join(sources.manifestsRoot, 'runtime-tail-figure-retry.summary.json')
  const runtimeStructurePath = path.join(sources.manifestsRoot, 'runtime-tail-structure-retry.json')
  const runtimeStructureSummaryPath = path.join(sources.manifestsRoot, 'runtime-tail-structure-retry.summary.json')
  const runtimeMixedPath = path.join(sources.manifestsRoot, 'runtime-tail-mixed-terminalization.json')
  const runtimeMixedSummaryPath = path.join(sources.manifestsRoot, 'runtime-tail-mixed-terminalization.summary.json')
  const smallFastPassPath = path.join(sources.manifestsRoot, 'small-fast-pass.json')
  const smallFastPassSummaryPath = path.join(sources.manifestsRoot, 'small-fast-pass.summary.json')
  const mediumFigureConversionPath = path.join(sources.manifestsRoot, 'medium-figure-conversion.json')
  const mediumFigureConversionSummaryPath = path.join(sources.manifestsRoot, 'medium-figure-conversion.summary.json')
  const serialHeavyMixedPath = path.join(sources.manifestsRoot, 'serial-heavy-mixed-terminalization.json')
  const serialHeavyMixedSummaryPath = path.join(sources.manifestsRoot, 'serial-heavy-mixed-terminalization.summary.json')
  const manualScannedDeferredPath = path.join(sources.manifestsRoot, 'manual-scanned-deferred.json')
  const manualScannedDeferredSummaryPath = path.join(sources.manifestsRoot, 'manual-scanned-deferred.summary.json')
  const allRemainingAutomatedPath = path.join(sources.manifestsRoot, 'all-remaining-automated.json')
  const allRemainingAutomatedSummaryPath = path.join(sources.manifestsRoot, 'all-remaining-automated.summary.json')
  const replacementLikelihoodPath = path.join(sources.manifestsRoot, 'replacement-likelihood.json')
  const replacementLikelihoodSummaryPath = path.join(sources.manifestsRoot, 'replacement-likelihood.summary.json')
  const manualWorklistPath = path.join(sources.manifestsRoot, 'manual-worklist.json')
  const manualWorklistSummaryPath = path.join(sources.manifestsRoot, 'manual-worklist.summary.json')
  const residualFamilyClosureReportPath = path.join(sources.manifestsRoot, 'residual-family-closure-report.json')
  const residualFamilyClosureReportSummaryPath = path.join(sources.manifestsRoot, 'residual-family-closure-report.summary.json')
  const figureFinalMileClosurePath = path.join(sources.manifestsRoot, 'figure-final-mile-closure.json')
  const figureFinalMileClosureSummaryPath = path.join(sources.manifestsRoot, 'figure-final-mile-closure.summary.json')

  writeJson(figurePath, figureCanary)
  writeJson(figureSummaryPath, {
    generatedAt: figureCanary.generatedAt,
    figurePath,
    totals: figureCanary.totals,
    totalCandidates: figureCanary.candidates.length,
    selectedPublicationIds: figureCanary.selectedPublicationIds,
    selectionSanity: figureCanary.selectionSanity,
  })
  writeJson(fontPath, fontCanary)
  writeJson(fontSummaryPath, {
    generatedAt: fontCanary.generatedAt,
    fontPath,
    totals: fontCanary.totals,
    totalCandidates: fontCanary.candidates.length,
    selectedPublicationIds: fontCanary.selectedPublicationIds,
    selectionSanity: fontCanary.selectionSanity,
  })
  writeJson(runtimePath, runtimeRetryWave)
  writeJson(runtimeSummaryPath, {
    generatedAt: runtimeRetryWave.generatedAt,
    runtimePath,
    totals: runtimeRetryWave.totals,
    totalCandidates: runtimeRetryWave.candidates.length,
    selectedPublicationIds: runtimeRetryWave.selectedPublicationIds,
    groupedPublicationIds: runtimeRetryWave.groupedPublicationIds,
    groupedCounts: runtimeRetryWave.groupedCounts,
  })
  writeJson(runtimeFigurePath, runtimeFigureRetry)
  writeJson(runtimeFigureSummaryPath, {
    generatedAt: runtimeFigureRetry.generatedAt,
    runtimeFigurePath,
    totals: runtimeFigureRetry.totals,
    totalCandidates: runtimeFigureRetry.candidates.length,
    selectedPublicationIds: runtimeFigureRetry.selectedPublicationIds,
    groupedPublicationIds: runtimeFigureRetry.groupedPublicationIds,
    groupedCounts: runtimeFigureRetry.groupedCounts,
    selectionSanity: runtimeFigureRetry.selectionSanity,
    targetedFindingKeys: runtimeFigureRetry.targetedFindingKeys,
    targetedFamilyIds: runtimeFigureRetry.targetedFamilyIds,
  })
  writeJson(runtimeStructurePath, runtimeStructureRetry)
  writeJson(runtimeStructureSummaryPath, {
    generatedAt: runtimeStructureRetry.generatedAt,
    runtimeStructurePath,
    totals: runtimeStructureRetry.totals,
    totalCandidates: runtimeStructureRetry.candidates.length,
    selectedPublicationIds: runtimeStructureRetry.selectedPublicationIds,
    groupedPublicationIds: runtimeStructureRetry.groupedPublicationIds,
    groupedCounts: runtimeStructureRetry.groupedCounts,
    selectionSanity: runtimeStructureRetry.selectionSanity,
    targetedFindingKeys: runtimeStructureRetry.targetedFindingKeys,
    targetedFamilyIds: runtimeStructureRetry.targetedFamilyIds,
  })
  writeJson(runtimeMixedPath, runtimeMixedTerminalization)
  writeJson(runtimeMixedSummaryPath, {
    generatedAt: runtimeMixedTerminalization.generatedAt,
    runtimeMixedPath,
    totals: runtimeMixedTerminalization.totals,
    totalCandidates: runtimeMixedTerminalization.candidates.length,
    selectedPublicationIds: runtimeMixedTerminalization.selectedPublicationIds,
    groupedPublicationIds: runtimeMixedTerminalization.groupedPublicationIds,
    groupedCounts: runtimeMixedTerminalization.groupedCounts,
    selectionSanity: runtimeMixedTerminalization.selectionSanity,
    targetedFindingKeys: runtimeMixedTerminalization.targetedFindingKeys,
    targetedFamilyIds: runtimeMixedTerminalization.targetedFamilyIds,
  })
  writeJson(smallFastPassPath, smallFastPass)
  writeJson(smallFastPassSummaryPath, {
    generatedAt: smallFastPass.generatedAt,
    smallFastPassPath,
    laneIntent: smallFastPass.laneIntent,
    executionPolicy: smallFastPass.executionPolicy,
    recommendedConcurrency: smallFastPass.recommendedConcurrency,
    initialAnalysisProfile: smallFastPass.initialAnalysisProfile,
    totals: smallFastPass.totals,
    totalCandidates: smallFastPass.candidates.length,
    selectedPublicationIds: smallFastPass.selectedPublicationIds,
    selectionSanity: smallFastPass.selectionSanity,
  })
  writeJson(mediumFigureConversionPath, mediumFigureConversion)
  writeJson(mediumFigureConversionSummaryPath, {
    generatedAt: mediumFigureConversion.generatedAt,
    mediumFigureConversionPath,
    laneIntent: mediumFigureConversion.laneIntent,
    executionPolicy: mediumFigureConversion.executionPolicy,
    recommendedConcurrency: mediumFigureConversion.recommendedConcurrency,
    initialAnalysisProfile: mediumFigureConversion.initialAnalysisProfile,
    totals: mediumFigureConversion.totals,
    totalCandidates: mediumFigureConversion.candidates.length,
    selectedPublicationIds: mediumFigureConversion.selectedPublicationIds,
    selectionSanity: mediumFigureConversion.selectionSanity,
  })
  writeJson(serialHeavyMixedPath, serialHeavyMixedTerminalization)
  writeJson(serialHeavyMixedSummaryPath, {
    generatedAt: serialHeavyMixedTerminalization.generatedAt,
    serialHeavyMixedPath,
    laneIntent: serialHeavyMixedTerminalization.laneIntent,
    executionPolicy: serialHeavyMixedTerminalization.executionPolicy,
    recommendedConcurrency: serialHeavyMixedTerminalization.recommendedConcurrency,
    initialAnalysisProfile: serialHeavyMixedTerminalization.initialAnalysisProfile,
    totals: serialHeavyMixedTerminalization.totals,
    totalCandidates: serialHeavyMixedTerminalization.candidates.length,
    selectedPublicationIds: serialHeavyMixedTerminalization.selectedPublicationIds,
    selectionSanity: serialHeavyMixedTerminalization.selectionSanity,
  })
  writeJson(manualScannedDeferredPath, manualScannedDeferred)
  writeJson(manualScannedDeferredSummaryPath, {
    generatedAt: manualScannedDeferred.generatedAt,
    manualScannedDeferredPath,
    laneIntent: manualScannedDeferred.laneIntent,
    executionPolicy: manualScannedDeferred.executionPolicy,
    recommendedConcurrency: manualScannedDeferred.recommendedConcurrency,
    initialAnalysisProfile: manualScannedDeferred.initialAnalysisProfile,
    totals: manualScannedDeferred.totals,
    totalCandidates: manualScannedDeferred.candidates.length,
    selectedPublicationIds: manualScannedDeferred.selectedPublicationIds,
    selectionSanity: manualScannedDeferred.selectionSanity,
  })
  writeJson(allRemainingAutomatedPath, allRemainingAutomated)
  writeJson(allRemainingAutomatedSummaryPath, {
    generatedAt: allRemainingAutomated.generatedAt,
    allRemainingAutomatedPath,
    laneIntent: allRemainingAutomated.laneIntent,
    executionPolicy: allRemainingAutomated.executionPolicy,
    recommendedConcurrency: allRemainingAutomated.recommendedConcurrency,
    initialAnalysisProfile: allRemainingAutomated.initialAnalysisProfile,
    totals: allRemainingAutomated.totals,
    totalCandidates: allRemainingAutomated.candidates.length,
    selectedPublicationIds: allRemainingAutomated.selectedPublicationIds,
    selectionSanity: allRemainingAutomated.selectionSanity,
  })
  writeJson(replacementLikelihoodPath, replacementLikelihood)
  writeJson(replacementLikelihoodSummaryPath, {
    generatedAt: replacementLikelihood.generatedAt,
    replacementLikelihoodPath,
    laneIntent: replacementLikelihood.laneIntent,
    executionPolicy: replacementLikelihood.executionPolicy,
    recommendedConcurrency: replacementLikelihood.recommendedConcurrency,
    initialAnalysisProfile: replacementLikelihood.initialAnalysisProfile,
    totals: replacementLikelihood.totals,
    totalCandidates: replacementLikelihood.candidates.length,
    selectedPublicationIds: replacementLikelihood.selectedPublicationIds,
    selectionSanity: replacementLikelihood.selectionSanity,
  })
  writeJson(manualWorklistPath, manualWorklist)
  writeJson(manualWorklistSummaryPath, {
    generatedAt: manualWorklist.generatedAt,
    manualWorklistPath,
    totals: manualWorklist.totals,
    selectedPublicationIds: manualWorklist.selectedPublicationIds,
    queueIntent: manualWorklist.queueIntent,
    sourceFigureFinalMileClosurePath: manualWorklist.sourceFigureFinalMileClosurePath,
  })
  writeJson(manualOutcomesSummaryPath, manualOutcomesSummary)
  writeJson(residualFamilyClosureReportPath, residualFamilyClosureReport)
  writeJson(residualFamilyClosureReportSummaryPath, {
    generatedAt: residualFamilyClosureReport.generatedAt,
    residualFamilyClosureReportPath,
    totals: residualFamilyClosureReport.totals,
    manualMitigation: residualFamilyClosureReport.manualMitigation,
    recommendedNextEngineSlice: residualFamilyClosureReport.recommendedNextEngineSlice,
    rankedCohorts: residualFamilyClosureReport.rankedCohorts,
    figureFinalMileRows: residualFamilyClosureReport.figureFinalMileRows,
  })
  writeJson(figureFinalMileClosurePath, figureFinalMileClosure)
  writeJson(figureFinalMileClosureSummaryPath, {
    generatedAt: figureFinalMileClosure.generatedAt,
    figureFinalMileClosurePath,
    totals: figureFinalMileClosure.totals,
    totalCandidates: figureFinalMileClosure.candidates.length,
    selectedPublicationIds: figureFinalMileClosure.selectedPublicationIds,
  })

  console.log(JSON.stringify({
    figurePath,
    fontPath,
    runtimePath,
    runtimeFigurePath,
    runtimeStructurePath,
    runtimeMixedPath,
    figureCandidates: figureCanary.selectedPublicationIds,
    fontCandidates: fontCanary.selectedPublicationIds,
    runtimeRetryCount: runtimeRetryWave.candidates.length,
    runtimeFigureRetryCount: runtimeFigureRetry.candidates.length,
    runtimeStructureRetryCount: runtimeStructureRetry.candidates.length,
    runtimeMixedTerminalizationCount: runtimeMixedTerminalization.candidates.length,
    smallFastPassCount: smallFastPass.candidates.length,
    mediumFigureConversionCount: mediumFigureConversion.candidates.length,
    serialHeavyMixedTerminalizationCount: serialHeavyMixedTerminalization.candidates.length,
    manualScannedDeferredCount: manualScannedDeferred.candidates.length,
    allRemainingAutomatedCount: allRemainingAutomated.candidates.length,
    replacementLikelihoodCount: replacementLikelihood.candidates.length,
    manualWorklistCount: manualWorklist.candidates.length,
    manualMitigation: residualFamilyClosureReport.manualMitigation,
    recommendedNextEngineSlice: residualFamilyClosureReport.recommendedNextEngineSlice,
    figureFinalMileClosureCount: figureFinalMileClosure.candidates.length,
    runtimeByFamily: runtimeRetryWave.groupedPublicationIds,
  }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
