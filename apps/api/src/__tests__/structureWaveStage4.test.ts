import { describe, expect, it } from 'vitest'
import {
  applyStage4StructureWaveReclassification,
  buildStage4StructureCanaries,
  buildStage4StructureHomogeneousAnalysis,
  buildStage4StructureOverlapAnalysis,
  buildStage4StructureStalledAnalysis,
  buildStage4StructureThroughputSummary,
  buildStage4StructureWaveArtifacts,
  buildStage4StructureWaveOutcomesSummary,
  type Stage4StructureActiveAnalysisRow,
  type Stage4StructurePendingAnalysisRow,
  type Stage4StructureStalledAnalysisRow,
  type Stage4StructureWaveDocument,
} from '../services/structureWaveStage4.js'
import type { CorpusControlPlaneArtifacts, CorpusControlPlaneRow, CorpusControlPlaneSources } from '../services/corpusControlPlane.js'

function emptyStatusCounts() {
  return { verified_pass: 0, discovered: 0, analyzed: 0, queued_for_remediation: 0, remediated_fail: 0, processing_error: 0, deferred_manual: 0, staged_for_replacement: 0, replaced_remote: 0 }
}

function makeRow(input: Partial<CorpusControlPlaneRow> & Pick<CorpusControlPlaneRow, 'publicationId' | 'currentCorpusStatus' | 'cohortLabel'>): CorpusControlPlaneRow {
  const { publicationId, currentCorpusStatus, cohortLabel, ...overrides } = input
  return {
    publicationId,
    title: publicationId,
    slug: null,
    fileUrl: 'https://example.test/' + publicationId + '.pdf',
    storageKind: 'legacy_archive',
    sourceKind: 'legacy_archive',
    serverHost: '143.244.146.43',
    remotePath: '/remote/' + publicationId + '.pdf',
    remoteDir: '/remote',
    replaceVia: 'sftp',
    currentCorpusStatus,
    cohortLabel,
    sourceMetadata: { fileHost: 'archive.icjia-api.cloud', sshTarget: 'forge@test', expectedPresence: 'present', localWorkingPath: null, localBackupPath: null, localServerMirrorPath: null, checksumRecordedAt: null, currentSourcePath: '/cache/' + publicationId + '.pdf', currentSourceMd5: null },
    statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: null, outcomeStatus: null, latestReportPath: '/tmp/' + publicationId + '.json', candidateManifestPath: null },
    classificationEvidence: { pageCount: 4, isScanned: false, overallScore: 90, grade: 'B', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 2, topBlockingResidualFamilyIds: [], blockingFindingKeys: [], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] },
    promotionTruth: { promotionStatus: null, ledgerRowPresent: false, stagedReplacementPath: null, replacementChecksumSha256: null, verificationPassed: false },
    stage3FigureDiagnostics: { figureWaveBucket: null, ownershipRiskKnown: false, ownershipRiskCountInitial: null, ownershipRiskCountFinal: null, missingAltCountInitial: null, missingAltCountFinal: null, decorativeFigureCountInitial: null, decorativeFigureCountFinal: null, dominantFigurePhase: null, inspectionPattern: null, hasGenericTimeoutWording: false },
    stage4StructureDiagnostics: { structureWaveBucket: null, terminalSurvivorClass: null, dominantStructurePhase: null, hasLogicalStructureDebt: null, hasHeadingDebt: null, hasReadingOrderDebt: null, hasMetadataNavigationDebt: null, hasMixedFigureResiduals: null, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' },
    reasonCodes: [],
    notes: [],
    ...overrides,
  }
}

function makeArtifacts(rows: CorpusControlPlaneRow[]): CorpusControlPlaneArtifacts {
  const byCurrentCorpusStatus = emptyStatusCounts()
  const byCohortLabel = { short_high_likelihood: 0, figure_heavy: 0, structure_heavy: 0, font_heavy: 0, long_report: 0, manual_tail: 0 }
  const statusByCohort = { short_high_likelihood: emptyStatusCounts(), figure_heavy: emptyStatusCounts(), structure_heavy: emptyStatusCounts(), font_heavy: emptyStatusCounts(), long_report: emptyStatusCounts(), manual_tail: emptyStatusCounts() }
  for (const row of rows) {
    byCurrentCorpusStatus[row.currentCorpusStatus] += 1
    byCohortLabel[row.cohortLabel] += 1
    statusByCohort[row.cohortLabel][row.currentCorpusStatus] += 1
  }
  return {
    document: {
      generatedAt: '2026-03-31T00:00:00.000Z',
      summary: {
        totalRows: rows.length,
        byCurrentCorpusStatus,
        byCohortLabel,
        byStorageKind: { legacy_archive: rows.length },
        statusByCohort,
        verifiedPassRowsFromLedger: rows.filter(row => row.promotionTruth.ledgerRowPresent).length,
        remainingRowsExcludingVerifiedPass: rows.filter(row => row.currentCorpusStatus !== 'verified_pass').length,
      },
      rows,
    },
    byCohort: {
      generatedAt: '2026-03-31T00:00:00.000Z',
      cohorts: {
        short_high_likelihood: { totalRows: byCohortLabel.short_high_likelihood, byCurrentCorpusStatus: statusByCohort.short_high_likelihood, samplePublicationIds: [] },
        figure_heavy: { totalRows: byCohortLabel.figure_heavy, byCurrentCorpusStatus: statusByCohort.figure_heavy, samplePublicationIds: [] },
        structure_heavy: { totalRows: byCohortLabel.structure_heavy, byCurrentCorpusStatus: statusByCohort.structure_heavy, samplePublicationIds: [] },
        font_heavy: { totalRows: byCohortLabel.font_heavy, byCurrentCorpusStatus: statusByCohort.font_heavy, samplePublicationIds: [] },
        long_report: { totalRows: byCohortLabel.long_report, byCurrentCorpusStatus: statusByCohort.long_report, samplePublicationIds: [] },
        manual_tail: { totalRows: byCohortLabel.manual_tail, byCurrentCorpusStatus: statusByCohort.manual_tail, samplePublicationIds: [] },
      },
    },
    canaries: { generatedAt: '2026-03-31T00:00:00.000Z', summary: { totalCanaries: 0, matchedPublicationIds: 0, unmatchedCanaries: 0, byCohortLabel }, rows: [] },
  }
}

function makeSources(): CorpusControlPlaneSources {
  return {
    repoRoot: '/tmp/repo', manifestsRoot: '/tmp/repo/ICJIA-PDFs/manifests', replacementMapPath: '/tmp/repo/ICJIA-PDFs/manifests/publication-pdf-replacement-map.json', verificationPath: null, verificationClassifiedPath: null, promotionLedgerPath: null, regressionBenchmarkPath: null, replacementMap: [
      { publicationId: 'verified', title: 'Verified Structure', slug: 'verified', fileUrl: null, fileHost: null, storageKind: 'legacy_archive', replaceVia: null, serverHost: '143.244.146.43', sshTarget: null, remotePath: '/remote/verified.pdf', remoteDir: '/remote', localWorkingPath: null, localBackupPath: null, localServerMirrorPath: null, expectedPresence: 'present', notes: null, checksumState: { localCurrentFilePath: '/cache/verified.pdf' } },
      { publicationId: 'spillover', title: 'Spillover Structure', slug: 'spillover', fileUrl: null, fileHost: null, storageKind: 'legacy_archive', replaceVia: null, serverHost: '143.244.146.43', sshTarget: null, remotePath: '/remote/spillover.pdf', remoteDir: '/remote', localWorkingPath: null, localBackupPath: null, localServerMirrorPath: null, expectedPresence: 'present', notes: null, checksumState: { localCurrentFilePath: '/cache/spillover.pdf' } },
    ], verificationResults: [], verificationRows: [], classifiedRows: [], promotionLedgerRows: [], outcomeManifests: [], candidateManifests: [], regressionBenchmarkOutcomes: [
      { name: 'Structure Benchmark', filePath: '/cache/verified.pdf', category: 'structure', terminalState: 'pass' },
    ],
  } as unknown as CorpusControlPlaneSources
}

describe('structure wave Stage 4', () => {
  it('classifies structure buckets and preserves Stage 3 spillover origin', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'meta', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', classificationEvidence: { pageCount: 4, isScanned: false, overallScore: 80, grade: 'B', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: ['pdfua.document_language'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
      makeRow({ publicationId: 'structure', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', classificationEvidence: { pageCount: 12, isScanned: false, overallScore: 70, grade: 'C', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: ['pdfua.logical_structure'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
      makeRow({ publicationId: 'mixed', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', classificationEvidence: { pageCount: 8, isScanned: false, overallScore: 60, grade: 'D', blockerFamilyCount: 2, blockingFindingCount: 2, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: ['pdfua.logical_structure', 'pdfua.figure_alt_or_artifact'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
      makeRow({ publicationId: 'retry', currentCorpusStatus: 'processing_error', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: null, dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: null, hasReadingOrderDebt: null, hasMetadataNavigationDebt: null, hasMixedFigureResiduals: null, hasBoundedRuntimeWording: true, originLane: 'native_structure_heavy', terminalSurvivorClass: null }, reasonCodes: ['outcome:processing_error'] }),
      makeRow({ publicationId: 'spillover', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', reasonCodes: ['stage3:reclassified_from_figure_heavy'], classificationEvidence: { pageCount: 6, isScanned: false, overallScore: 72, grade: 'C', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: ['pdfua.logical_structure'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
    ])
    const next = applyStage4StructureWaveReclassification(artifacts)
    expect(next.document.rows.find(row => row.publicationId === 'meta')?.stage4StructureDiagnostics.structureWaveBucket).toBe('metadata_navigation_residuals')
    expect(next.document.rows.find(row => row.publicationId === 'structure')?.stage4StructureDiagnostics.structureWaveBucket).toBe('structure_only_residuals')
    expect(next.document.rows.find(row => row.publicationId === 'mixed')?.stage4StructureDiagnostics.structureWaveBucket).toBe('mixed_structure_figure_residuals')
    expect(next.document.rows.find(row => row.publicationId === 'retry')?.stage4StructureDiagnostics.structureWaveBucket).toBe('structure_processing_error_retry')
    expect(next.document.rows.find(row => row.publicationId === 'spillover')?.stage4StructureDiagnostics.originLane).toBe('reclassified_from_figure_heavy')
  })

  it('selects metadata and structure-only rows ahead of mixed and runtime retries', () => {
    const fsLocal = require('fs')
    const os = require('os')
    const pathLocal = require('path')
    const manifestsRoot = fsLocal.mkdtempSync(pathLocal.join(os.tmpdir(), 'stage4-wave-'))
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'meta', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: null } }),
      makeRow({ publicationId: 'structure', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'structure_only_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: null } }),
      makeRow({ publicationId: 'mixed', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'mixed_structure_figure_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: true, hasBoundedRuntimeWording: false, originLane: 'reclassified_from_figure_heavy', terminalSurvivorClass: null } }),
      makeRow({ publicationId: 'retry', currentCorpusStatus: 'processing_error', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'structure_processing_error_retry', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: true, originLane: 'native_structure_heavy', terminalSurvivorClass: null }, reasonCodes: ['outcome:processing_error'] }),
      makeRow({ publicationId: 'verified', currentCorpusStatus: 'verified_pass', cohortLabel: 'structure_heavy', promotionTruth: { promotionStatus: 'verified_pass', ledgerRowPresent: true, stagedReplacementPath: '/staged/verified.pdf', replacementChecksumSha256: 'x', verificationPassed: true } }),
    ])
    const { wave } = buildStage4StructureWaveArtifacts({ artifacts, sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json', sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z', manifestsRoot, maxCandidates: 8 })
    expect(wave.selectedPublicationIds).toEqual(['meta', 'structure', 'mixed', 'retry'])
  })

  it('keeps reading-order-only outcomes in structure_only_residuals and exposes them in reporting', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'reading-order',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'structure_heavy',
        stage4StructureDiagnostics: { structureWaveBucket: 'structure_only_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: true, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: 'reading_order_only_survivor' },
      }),
    ])
    const next = applyStage4StructureWaveReclassification(artifacts)
    expect(next.document.rows.find(row => row.publicationId === 'reading-order')?.stage4StructureDiagnostics.structureWaveBucket).toBe('structure_only_residuals')

    const wave: Stage4StructureWaveDocument = {
      generatedAt: '2026-03-31T00:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z',
      waveName: 'stage4-structure-wave',
      cohortLabel: 'structure_heavy',
      maxCandidates: 8,
      totals: { eligibleRows: 1, selectedRows: 1, skippedRows: 0, pendingRows: 0 },
      selectedPublicationIds: ['reading-order'],
      pendingPublicationIds: [],
      candidates: [],
      skippedRows: [],
    }

    const summary = buildStage4StructureThroughputSummary({
      artifacts: next,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z',
      waveManifestPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.json',
      wave,
      outcomesPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.outcomes.json',
      outcomes: { outcomes: [{ publicationId: 'reading-order', status: 'failed_after_remediation' }] },
    })
    expect(summary.rows.readingOrderOnlyResidualPublicationIds).toEqual(['reading-order'])
  })

  it('can rebuild a follow-up slice for only unresolved Stage 4 rows', () => {
    const fsLocal = require('fs')
    const os = require('os')
    const pathLocal = require('path')
    const manifestsRoot = fsLocal.mkdtempSync(pathLocal.join(os.tmpdir(), 'stage4-wave-follow-up-'))

    const priorWave: Stage4StructureWaveDocument = {
      generatedAt: '2026-03-31T00:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z',
      waveName: 'stage4-structure-wave',
      cohortLabel: 'structure_heavy',
      maxCandidates: 8,
      totals: { eligibleRows: 3, selectedRows: 3, skippedRows: 0, pendingRows: 2 },
      selectedPublicationIds: ['done-a', 'done-b', 'pending-a'],
      pendingPublicationIds: ['pending-a', 'pending-b'],
      candidates: [],
      skippedRows: [],
    }
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, 'stage4-structure-wave.json'), JSON.stringify(priorWave, null, 2))
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, 'stage4-structure-wave.outcomes.json'), JSON.stringify({ outcomes: [
      { publicationId: 'done-a', status: 'failed_after_remediation' },
      { publicationId: 'done-b', status: 'failed_after_remediation' },
    ] }, null, 2))

    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'pending-a', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: null } }),
      makeRow({ publicationId: 'pending-b', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'structure_only_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: true, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: null } }),
      makeRow({ publicationId: 'other', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'mixed_structure_figure_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: true, hasBoundedRuntimeWording: false, originLane: 'reclassified_from_figure_heavy', terminalSurvivorClass: null } }),
    ])

    const { wave } = buildStage4StructureWaveArtifacts({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z',
      manifestsRoot,
      maxCandidates: 8,
      includePublicationIds: ['pending-a', 'pending-b'],
    })

    expect(wave.selectedPublicationIds).toEqual(['pending-a', 'pending-b'])
  })

  it('uses Stage 4.2 pending analysis to clear stale pending rows and preserve forensic routing', () => {
    const fsLocal = require('fs')
    const os = require('os')
    const pathLocal = require('path')
    const manifestsRoot = fsLocal.mkdtempSync(pathLocal.join(os.tmpdir(), 'stage4-wave-analysis-'))

    const priorWave: Stage4StructureWaveDocument = {
      generatedAt: '2026-03-31T00:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z',
      waveName: 'stage4-structure-wave',
      cohortLabel: 'structure_heavy',
      maxCandidates: 8,
      totals: { eligibleRows: 2, selectedRows: 2, skippedRows: 0, pendingRows: 1 },
      selectedPublicationIds: ['pending-meta', 'other'],
      pendingPublicationIds: ['pending-meta'],
      candidates: [],
      skippedRows: [],
    }
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, 'stage4-structure-wave.json'), JSON.stringify(priorWave, null, 2))
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, 'stage4-structure-wave.outcomes.json'), JSON.stringify({ outcomes: [] }, null, 2))

    const pendingAnalysisRows: Stage4StructurePendingAnalysisRow[] = [{
      publicationId: 'pending-meta',
      publicationTitle: 'pending-meta',
      priorStructureWaveBucket: 'metadata_navigation_residuals',
      analysisDisposition: 'metadata_navigation_residuals',
      evidenceStrength: 'attempt_artifact_only',
      evidencePaths: {
        terminalReportPath: null,
        failureReportPath: null,
        attemptArtifactPath: '/tmp/repo/attempt.json',
        controlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      },
      reasonCodes: ['stage4.2:metadata_navigation_residuals'],
      notes: ['forensic resolution'],
    }]

    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'pending-meta', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: null } }),
      makeRow({ publicationId: 'other', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'structure_only_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: true, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: null } }),
    ])

    const next = applyStage4StructureWaveReclassification(artifacts, pendingAnalysisRows)
    const { wave } = buildStage4StructureWaveArtifacts({
      artifacts: next,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z',
      manifestsRoot,
      maxCandidates: 8,
      pendingAnalysisRows,
    })
    const summary = buildStage4StructureThroughputSummary({
      artifacts: next,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z',
      waveManifestPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.json',
      wave,
      outcomesPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.outcomes.json',
      outcomes: { outcomes: [] },
      pendingAnalysisRows,
    })

    expect(next.document.rows.find(row => row.publicationId === 'pending-meta')?.reasonCodes).toContain('stage4.2:metadata_navigation_residuals')
    expect(wave.pendingPublicationIds).toEqual(['other'])
    expect(summary.rows.forensicallyResolvedPendingPublicationIds).toEqual(['pending-meta'])
    expect(summary.rows.stillUnclassifiedPendingPublicationIds).toEqual(['other'])
  })

  it('uses Stage 4.2 pending analysis to mark bounded runtime retries as processing_error', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'retry', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: null } }),
    ])
    const pendingAnalysisRows: Stage4StructurePendingAnalysisRow[] = [{
      publicationId: 'retry',
      publicationTitle: 'retry',
      priorStructureWaveBucket: 'metadata_navigation_residuals',
      analysisDisposition: 'structure_processing_error_retry',
      evidenceStrength: 'attempt_artifact_only',
      evidencePaths: {
        terminalReportPath: null,
        failureReportPath: null,
        attemptArtifactPath: '/tmp/repo/attempt.json',
        controlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      },
      reasonCodes: ['stage4.2:structure_processing_error_retry'],
      notes: ['bounded runtime'],
    }]

    const next = applyStage4StructureWaveReclassification(artifacts, pendingAnalysisRows)
    const retryRow = next.document.rows.find(row => row.publicationId === 'retry')
    expect(retryRow?.currentCorpusStatus).toBe('processing_error')
    expect(retryRow?.stage4StructureDiagnostics.structureWaveBucket).toBe('structure_processing_error_retry')
  })

  it('keeps active unresolved rows pending when Stage 4.3 active analysis exists, while terminal rows drop out', () => {
    const fsLocal = require('fs')
    const os = require('os')
    const pathLocal = require('path')
    const manifestsRoot = fsLocal.mkdtempSync(pathLocal.join(os.tmpdir(), 'stage4-wave-active-analysis-'))

    const priorWave: Stage4StructureWaveDocument = {
      generatedAt: '2026-03-31T00:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z',
      waveName: 'stage4-structure-wave',
      cohortLabel: 'structure_heavy',
      maxCandidates: 8,
      totals: { eligibleRows: 6, selectedRows: 6, skippedRows: 0, pendingRows: 1 },
      selectedPublicationIds: ['3651', '4054', '4023', '4067', '3671', '3465'],
      pendingPublicationIds: ['3651'],
      candidates: [],
      skippedRows: [],
    }
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, 'stage4-structure-wave.json'), JSON.stringify(priorWave, null, 2))
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, 'stage4-structure-wave.outcomes.json'), JSON.stringify({ outcomes: [
      { publicationId: '3651', status: 'failed_after_remediation' },
    ] }, null, 2))

    const activeAnalysisRows: Stage4StructureActiveAnalysisRow[] = ['4054', '4023', '4067', '3671', '3465'].map(publicationId => ({
      publicationId,
      publicationTitle: publicationId,
      priorStructureWaveBucket: 'metadata_navigation_residuals',
      activeDisposition: 'metadata_navigation_residuals',
      evidenceStrength: 'attempt_artifact_only',
      evidencePaths: {
        latestStage4AttemptPath: '/tmp/repo/attempt.json',
        latestStage4OutcomePath: null,
        controlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      },
      reasonCodes: ['stage4.3:metadata_navigation_residuals'],
      notes: ['active unresolved'],
    }))

    const artifacts = makeArtifacts([
      makeRow({ publicationId: '3651', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', classificationEvidence: { pageCount: 2, isScanned: false, overallScore: 84, grade: 'B', blockerFamilyCount: 2, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: ['pdfua.font_embedding'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] }, stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: true, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: null } }),
      ...['4054', '4023', '4067', '3671', '3465'].map(publicationId => makeRow({ publicationId, currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: null } })),
    ])

    const next = applyStage4StructureWaveReclassification(artifacts, [], activeAnalysisRows)
    const { wave } = buildStage4StructureWaveArtifacts({
      artifacts: next,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z',
      manifestsRoot,
      maxCandidates: 8,
      activeAnalysisRows,
    })
    const summary = buildStage4StructureThroughputSummary({
      artifacts: next,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z',
      waveManifestPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.json',
      wave,
      outcomesPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.outcomes.json',
      outcomes: { outcomes: [{ publicationId: '3651', status: 'failed_after_remediation' }] },
      activeAnalysisRows,
    })

    expect(wave.selectedPublicationIds).toEqual(['3465', '3671', '4023', '4054', '4067'])
    expect(wave.pendingPublicationIds).toEqual(['3465', '3671', '4023', '4054', '4067'])
    expect(summary.rows.activeUnresolvedPublicationIds).toEqual(['3465', '3671', '4023', '4054', '4067'])
    expect(summary.rows.pendingPublicationIds).toEqual(['3465', '3671', '4023', '4054', '4067'])
    expect(summary.rows.readingOrderOnlyResidualPublicationIds).not.toContain('3651')
  })

  it('reports current-wave totals separately from cumulative Stage 4 history', () => {
    const wave: Stage4StructureWaveDocument = {
      generatedAt: '2026-03-31T00:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z',
      waveName: 'stage4-structure-wave',
      cohortLabel: 'structure_heavy',
      maxCandidates: 8,
      totals: { eligibleRows: 5, selectedRows: 5, skippedRows: 0, pendingRows: 0 },
      selectedPublicationIds: ['3465', '3671', '4023', '4054', '4067'],
      pendingPublicationIds: [],
      candidates: [],
      skippedRows: [],
    }

    const summary = buildStage4StructureWaveOutcomesSummary({
      wave,
      outcomesPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.outcomes.json',
      outcomes: {
        outcomes: [
          { publicationId: '3685', status: 'failed_after_remediation' },
          { publicationId: '3550', status: 'failed_after_remediation' },
          { publicationId: '3606', status: 'failed_after_remediation' },
          { publicationId: '3651', status: 'failed_after_remediation' },
          { publicationId: '3465', status: 'failed_after_remediation' },
          { publicationId: '4054', status: 'failed_after_remediation' },
          { publicationId: '4023', status: 'failed_after_remediation' },
          { publicationId: '4067', status: 'failed_after_remediation' },
          { publicationId: '3671', status: 'failed_after_remediation' },
        ] as any[],
      },
    })

    expect(summary?.totals).toMatchObject({
      targetCandidates: 5,
      processed: 5,
      failedAfterRemediation: 5,
      processingError: 0,
      remaining: 0,
    })
    expect(summary?.cumulativeTotals).toMatchObject({
      processed: 9,
      failedAfterRemediation: 9,
    })
    expect(summary?.currentWave).toMatchObject({
      processedPublicationIds: ['3465', '3671', '4023', '4054', '4067'],
      remainingPublicationIds: [],
    })
  })

  it('routes Stage 4.4 terminal survivors into explicit reporting buckets', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: '4023', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: 'near_pass_grade_only', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' } }),
      makeRow({ publicationId: '4054', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: 'near_pass_grade_only', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' } }),
      makeRow({ publicationId: '4067', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: 'near_pass_grade_only', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' } }),
      makeRow({ publicationId: '3465', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: 'font_text_extractability_survivor', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: true, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' } }),
      makeRow({ publicationId: '3665', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: 'metadata_title_survivor', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' } }),
      makeRow({ publicationId: '3671', currentCorpusStatus: 'remediated_fail', cohortLabel: 'figure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: 'figure_spillover_survivor', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: true, hasBoundedRuntimeWording: false, originLane: 'reclassified_from_short_high_likelihood' } }),
      makeRow({ publicationId: '3550', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'structure_only_residuals', terminalSurvivorClass: 'reading_order_only_survivor', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: true, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' } }),
      makeRow({ publicationId: '3606', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'structure_only_residuals', terminalSurvivorClass: 'reading_order_only_survivor', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: true, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' } }),
      makeRow({ publicationId: '3685', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'structure_only_residuals', terminalSurvivorClass: 'reading_order_only_survivor', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: true, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' } }),
    ])

    const wave: Stage4StructureWaveDocument = {
      generatedAt: '2026-03-31T00:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z',
      waveName: 'stage4-structure-wave',
      cohortLabel: 'structure_heavy',
      maxCandidates: 8,
      totals: { eligibleRows: 5, selectedRows: 5, skippedRows: 0, pendingRows: 0 },
      selectedPublicationIds: ['3465', '3671', '4023', '4054', '4067'],
      pendingPublicationIds: [],
      candidates: [],
      skippedRows: [],
    }

    const summary = buildStage4StructureThroughputSummary({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z',
      waveManifestPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.json',
      wave,
      outcomesPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.outcomes.json',
      outcomes: { outcomes: [
        { publicationId: '3465', status: 'failed_after_remediation' },
        { publicationId: '3671', status: 'failed_after_remediation' },
        { publicationId: '4023', status: 'failed_after_remediation' },
        { publicationId: '4054', status: 'failed_after_remediation' },
        { publicationId: '4067', status: 'failed_after_remediation' },
      ] },
    })

    expect(summary.rows.nearPassGradeOnlyPublicationIds).toEqual(['4023', '4054', '4067'])
    expect(summary.rows.metadataTitleSurvivorPublicationIds).toEqual(['3665'])
    expect(summary.rows.fontTextExtractabilitySurvivorPublicationIds).toEqual(['3465'])
    expect(summary.rows.figureSpilloverSurvivorPublicationIds).toEqual(['3671'])
    expect(summary.rows.readingOrderOnlyResidualPublicationIds).toEqual(['3550', '3606', '3685'])
    expect(summary.rows.currentWaveProcessedPublicationIds).toEqual(['3465', '3671', '4023', '4054', '4067'])
    expect(summary.rows.currentWaveRemainingPublicationIds).toEqual([])
    expect(summary.rows.activeUnresolvedPublicationIds).toEqual([])
    expect(summary.totals.pendingWaveRows).toBe(0)
  })

  it('reclassifies figure spillover terminal survivors out of the Stage 4 active lane', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: '3671',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'structure_heavy',
        statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: '/tmp/stage4-structure-wave.outcomes.json', outcomeStatus: 'failed_after_remediation', latestReportPath: '/tmp/3671.json', candidateManifestPath: null },
        stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: 'figure_spillover_survivor', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: true, hasBoundedRuntimeWording: false, originLane: 'reclassified_from_short_high_likelihood' },
      }),
    ])

    const next = applyStage4StructureWaveReclassification(artifacts)
    const row = next.document.rows.find(candidate => candidate.publicationId === '3671')
    expect(row?.cohortLabel).toBe('figure_heavy')
    expect(row?.reasonCodes).toContain('stage4.4:figure_spillover_survivor')
    expect(row?.reasonCodes).toContain('stage4:reclassified_from_structure_heavy')
  })


  it('reports the latest completed eight-row wave separately from cumulative append history', () => {
    const wave: Stage4StructureWaveDocument = {
      generatedAt: '2026-03-31T06:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T06:00:00.000Z',
      waveName: 'stage4-structure-wave',
      cohortLabel: 'structure_heavy',
      maxCandidates: 8,
      totals: { eligibleRows: 8, selectedRows: 8, skippedRows: 0, pendingRows: 0 },
      selectedPublicationIds: ['3767', '3771', '3964', '3981', '4046', '4047', '4050', '4135'],
      pendingPublicationIds: [],
      candidates: [],
      skippedRows: [],
    }

    const summary = buildStage4StructureWaveOutcomesSummary({
      wave,
      outcomesPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.outcomes.json',
      outcomes: {
        outcomes: [
          { publicationId: '3465', status: 'failed_after_remediation', processedAt: '2026-03-31T04:07:48.539Z' },
          { publicationId: '4054', status: 'failed_after_remediation', processedAt: '2026-03-31T04:07:55.513Z' },
          { publicationId: '4023', status: 'failed_after_remediation', processedAt: '2026-03-31T04:08:00.270Z' },
          { publicationId: '4067', status: 'failed_after_remediation', processedAt: '2026-03-31T04:08:12.611Z' },
          { publicationId: '3671', status: 'failed_after_remediation', processedAt: '2026-03-31T04:08:40.491Z' },
          { publicationId: '3767', status: 'failed_after_remediation', processedAt: '2026-03-31T05:04:46.651Z' },
          { publicationId: '3981', status: 'failed_after_remediation', processedAt: '2026-03-31T05:05:05.569Z' },
          { publicationId: '3771', status: 'failed_after_remediation', processedAt: '2026-03-31T05:05:10.924Z' },
          { publicationId: '3964', status: 'failed_after_remediation', processedAt: '2026-03-31T05:05:16.271Z' },
          { publicationId: '4046', status: 'failed_after_remediation', processedAt: '2026-03-31T05:05:20.464Z' },
          { publicationId: '4047', status: 'remediated_pass_candidate', processedAt: '2026-03-31T05:05:20.619Z' },
          { publicationId: '4135', status: 'failed_after_remediation', processedAt: '2026-03-31T05:05:25.311Z' },
          { publicationId: '4050', status: 'failed_after_remediation', processedAt: '2026-03-31T05:05:26.226Z' },
        ],
      },
    })

    expect(summary?.totals).toMatchObject({
      targetCandidates: 8,
      processed: 8,
      remediatedPassCandidates: 1,
      failedAfterRemediation: 7,
      processingError: 0,
      remaining: 0,
    })
    expect((summary as any)?.currentWave.processedPublicationIds).toEqual(['3767', '3771', '3964', '3981', '4046', '4047', '4050', '4135'])
    expect(summary?.cumulativeTotals).toMatchObject({
      processed: 13,
      remediatedPassCandidates: 1,
      failedAfterRemediation: 12,
    })
  })


  it('keeps staged pass-candidate survivors in staged_for_replacement status after Stage 4 routing', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'staged',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'structure_heavy',
        statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: '/tmp/stage4-structure-wave.outcomes.json', outcomeStatus: 'remediated_pass_candidate', latestReportPath: '/tmp/staged.json', candidateManifestPath: null },
        stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: 'staged_pass_candidate_survivor', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' },
      }),
    ])

    const next = applyStage4StructureWaveReclassification(artifacts)
    const row = next.document.rows.find(candidate => candidate.publicationId === 'staged')
    expect(row?.currentCorpusStatus).toBe('staged_for_replacement')
    expect(row?.reasonCodes).toContain('stage4.5:staged_pass_candidate_survivor')
  })

  it('builds overlap analysis for 3877 and 3903 and terminalizes them as reading-order survivors', () => {
    const fsLocal = require('fs')
    const os = require('os')
    const pathLocal = require('path')
    const manifestsRoot = fsLocal.mkdtempSync(pathLocal.join(os.tmpdir(), 'stage4-wave-overlap-analysis-'))
    const artifacts = makeArtifacts([
      makeRow({ publicationId: '3877', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: null, outcomeStatus: null, latestReportPath: pathLocal.join(manifestsRoot, '../reports/test-runs/remediation-batch/143.244.146.43/3877-Family_Group_Conferences_Offer_Promise_for_Juvenile_Cases.remediation.json'), candidateManifestPath: null }, stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: null, dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: true, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' }, classificationEvidence: { pageCount: 4, isScanned: false, overallScore: 99, grade: 'B', blockerFamilyCount: 1, blockingFindingCount: 0, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: ['metadata_normalization','font_embedding_and_unicode','logical_structure_marked_content'], blockingFindingKeys: ['category.reading_order','category.title_language','pdfua.display_doc_title','pdfua.document_language','pdfua.font_embedding','pdfua.font_unicode','pdfua.logical_structure','pdfua.metadata_identification'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
      makeRow({ publicationId: '3903', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: null, outcomeStatus: null, latestReportPath: pathLocal.join(manifestsRoot, '../reports/test-runs/remediation-batch/143.244.146.43/3903-The_Impact_of_Domestic_Violence_Probation_Programs.remediation.json'), candidateManifestPath: null }, stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: null, dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: true, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' }, classificationEvidence: { pageCount: 4, isScanned: false, overallScore: 100, grade: 'A', blockerFamilyCount: 1, blockingFindingCount: 0, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: ['metadata_normalization','font_embedding_and_unicode','logical_structure_marked_content'], blockingFindingKeys: ['category.reading_order','pdfua.display_doc_title','pdfua.document_language','pdfua.font_embedding','pdfua.font_unicode','pdfua.logical_structure','pdfua.metadata_identification'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
    ])
    const mk = (_id: string, _name: string) => ({
      gate: { unresolvedCategoryLabels: ['Reading Order'], reasons: ['Categories still below 100: Reading Order'] },
      finalGate: { unresolvedCategoryLabels: ['Reading Order'], reasons: ['Categories still below 100: Reading Order'] },
    })
    fsLocal.mkdirSync(pathLocal.join(manifestsRoot, '../reports/test-runs/remediation-batch/143.244.146.43'), { recursive: true })
    fsLocal.mkdirSync(pathLocal.join(manifestsRoot, '../reports/failures/remediation-batch/143.244.146.43'), { recursive: true })
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, '../reports/test-runs/remediation-batch/143.244.146.43/3877-Family_Group_Conferences_Offer_Promise_for_Juvenile_Cases.remediation.json'), JSON.stringify(mk('3877','x')))
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, '../reports/failures/remediation-batch/143.244.146.43/3877-Family_Group_Conferences_Offer_Promise_for_Juvenile_Cases.failure.json'), JSON.stringify(mk('3877','x')))
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, '../reports/test-runs/remediation-batch/143.244.146.43/3903-The_Impact_of_Domestic_Violence_Probation_Programs.remediation.json'), JSON.stringify(mk('3903','x')))
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, '../reports/failures/remediation-batch/143.244.146.43/3903-The_Impact_of_Domestic_Violence_Probation_Programs.failure.json'), JSON.stringify(mk('3903','x')))

    const overlap = buildStage4StructureOverlapAnalysis({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T07:30:00.000Z',
      manifestsRoot,
      includePublicationIds: ['3877','3903'],
    })
    expect(overlap.summary.publicationIdsByDisposition.reading_order_only_survivor).toEqual(['3877','3903'])

    const next = applyStage4StructureWaveReclassification(artifacts, [], [], [], overlap.analysis.rows)
    expect(next.document.rows.find(row => row.publicationId === '3877')?.stage4StructureDiagnostics.terminalSurvivorClass).toBe('reading_order_only_survivor')
    expect(next.document.rows.find(row => row.publicationId === '3903')?.stage4StructureDiagnostics.terminalSurvivorClass).toBe('reading_order_only_survivor')
  })

  it('builds stalled-wave forensics and separates active-wave truth from completed-wave truth', () => {
    const fsLocal = require('fs')
    const os = require('os')
    const pathLocal = require('path')
    const manifestsRoot = fsLocal.mkdtempSync(pathLocal.join(os.tmpdir(), 'stage4-wave-stalled-analysis-'))

    const existingWave: Stage4StructureWaveDocument = {
      generatedAt: '2026-03-31T07:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T07:00:00.000Z',
      waveName: 'stage4-structure-wave',
      cohortLabel: 'structure_heavy',
      maxCandidates: 8,
      totals: { eligibleRows: 4, selectedRows: 4, skippedRows: 0, pendingRows: 4 },
      selectedPublicationIds: ['3866', '3871', '3898', '4039'],
      pendingPublicationIds: ['3866', '3871', '3898', '4039'],
      candidates: [],
      skippedRows: [],
    }
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, 'stage4-structure-wave.json'), JSON.stringify(existingWave, null, 2))
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, 'stage4-structure-wave.outcomes.json'), JSON.stringify({ outcomes: [] }, null, 2))

    const artifacts = makeArtifacts([
      makeRow({ publicationId: '3866', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: 'metadata_title_survivor', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' } }),
      makeRow({ publicationId: '3871', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: null, dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' }, classificationEvidence: { pageCount: 4, isScanned: false, overallScore: 88, grade: 'B', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: ['pdfua.display_doc_title'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
      makeRow({ publicationId: '3898', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: 'font_text_extractability_survivor', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: true, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' } }),
      makeRow({ publicationId: '4039', currentCorpusStatus: 'processing_error', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', terminalSurvivorClass: null, dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: true, originLane: 'native_structure_heavy' }, classificationEvidence: { pageCount: 4, isScanned: false, overallScore: 77, grade: 'C', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: [], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
    ])

    const stalledArtifacts = buildStage4StructureStalledAnalysis({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T07:00:00.000Z',
      manifestsRoot,
    })

    expect(stalledArtifacts.summary.publicationIdsByDisposition.metadata_title_survivor).toEqual(['3866'])
    expect(stalledArtifacts.summary.publicationIdsByDisposition.metadata_navigation_residuals).toEqual(['3871'])
    expect(stalledArtifacts.summary.publicationIdsByDisposition.font_text_extractability_survivor).toEqual(['3898'])
    expect(stalledArtifacts.summary.publicationIdsByDisposition.structure_processing_error_retry).toEqual(['4039'])

    const next = applyStage4StructureWaveReclassification(artifacts, [], [], stalledArtifacts.analysis.rows)
    expect(next.document.rows.find(row => row.publicationId === '3866')?.stage4StructureDiagnostics.terminalSurvivorClass).toBe('metadata_title_survivor')
    expect(next.document.rows.find(row => row.publicationId === '3898')?.stage4StructureDiagnostics.terminalSurvivorClass).toBe('font_text_extractability_survivor')
    expect(next.document.rows.find(row => row.publicationId === '4039')?.currentCorpusStatus).toBe('processing_error')

    const nextWave: Stage4StructureWaveDocument = {
      generatedAt: '2026-03-31T07:30:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T07:30:00.000Z',
      waveName: 'stage4-structure-wave',
      cohortLabel: 'structure_heavy',
      maxCandidates: 8,
      totals: { eligibleRows: 1, selectedRows: 1, skippedRows: 0, pendingRows: 1 },
      selectedPublicationIds: ['4039'],
      pendingPublicationIds: ['4039'],
      candidates: [],
      skippedRows: [],
    }

    const summary = buildStage4StructureThroughputSummary({
      artifacts: next,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T07:30:00.000Z',
      waveManifestPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.json',
      wave: existingWave,
      activeWave: nextWave,
      outcomesPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.outcomes.json',
      outcomes: { outcomes: [] },
      stalledAnalysisRows: stalledArtifacts.analysis.rows,
    })

    expect(summary.rows.currentWaveProcessedPublicationIds).toEqual([])
    expect(summary.rows.activeWaveSelectedPublicationIds).toEqual(['4039'])
    expect(summary.rows.activeWavePendingPublicationIds).toEqual(['4039'])
    expect(summary.rows.activeWaveAttemptedButUnterminalizedPublicationIds).toEqual(['4039'])
    expect(summary.rows.stalledForensicPublicationIds).toEqual(['3866', '3871', '3898', '4039'])
    expect(summary.rows.stalledForensicByDisposition.metadata_title_survivor).toEqual(['3866'])
    expect(summary.rows.stalledForensicByDisposition.font_text_extractability_survivor).toEqual(['3898'])
    expect(summary.totals.pendingWaveRows).toBe(1)
  })

  it('builds Stage 4.11 homogeneous analysis and removes homogeneous survivors from the live wave', () => {
    const fsLocal = require('fs')
    const os = require('os')
    const pathLocal = require('path')
    const manifestsRoot = fsLocal.mkdtempSync(pathLocal.join(os.tmpdir(), 'stage4-wave-homogeneous-analysis-'))

    const existingWave: Stage4StructureWaveDocument = {
      generatedAt: '2026-03-31T08:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T08:00:00.000Z',
      waveName: 'stage4-structure-wave',
      cohortLabel: 'structure_heavy',
      maxCandidates: 8,
      totals: { eligibleRows: 3, selectedRows: 3, skippedRows: 0, pendingRows: 3 },
      selectedPublicationIds: ['homogeneous', 'figurey', 'runtime'],
      pendingPublicationIds: ['homogeneous', 'figurey', 'runtime'],
      candidates: [],
      skippedRows: [],
    }
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, 'stage4-structure-wave.json'), JSON.stringify(existingWave, null, 2))
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, 'stage4-structure-wave.outcomes.json'), JSON.stringify({ outcomes: [] }, null, 2))

    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'homogeneous',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'structure_heavy',
        classificationEvidence: { pageCount: 12, isScanned: false, overallScore: 61, grade: 'D', blockerFamilyCount: 5, blockingFindingCount: 10, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: ['bookmark_language_outline_cleanup', 'font_embedding_and_unicode', 'logical_structure_marked_content', 'metadata_normalization', 'post_bootstrap_heading_convergence'], blockingFindingKeys: ['pdfua.display_doc_title', 'pdfua.document_language', 'pdfua.font_embedding', 'pdfua.font_unicode', 'pdfua.logical_structure', 'category.bookmarks', 'category.heading_structure', 'category.reading_order'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] },
        stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: true, hasReadingOrderDebt: true, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: null },
      }),
      makeRow({
        publicationId: 'figurey',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'structure_heavy',
        classificationEvidence: { pageCount: 12, isScanned: false, overallScore: 40, grade: 'F', blockerFamilyCount: 6, blockingFindingCount: 12, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: ['bookmark_language_outline_cleanup', 'font_embedding_and_unicode', 'logical_structure_marked_content', 'metadata_normalization'], blockingFindingKeys: ['pdfua.display_doc_title', 'pdfua.document_language', 'pdfua.font_embedding', 'pdfua.font_unicode', 'pdfua.logical_structure', 'pdfua.figure_alt_or_artifact'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] },
        stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: true, hasReadingOrderDebt: true, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: true, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: null },
      }),
      makeRow({
        publicationId: 'runtime',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'structure_heavy',
        classificationEvidence: { pageCount: 12, isScanned: false, overallScore: 0, grade: 'F', blockerFamilyCount: 0, blockingFindingCount: 0, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: [], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] },
        stage4StructureDiagnostics: { structureWaveBucket: 'structure_processing_error_retry', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: true, originLane: 'native_structure_heavy', terminalSurvivorClass: null },
      }),
      makeRow({
        publicationId: 'fresh-meta',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'structure_heavy',
        stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: null },
      }),
    ])

    const homogeneous = buildStage4StructureHomogeneousAnalysis({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T08:00:00.000Z',
      manifestsRoot,
    })

    expect(homogeneous.summary.publicationIdsByDisposition.metadata_font_structure_survivor).toEqual(['homogeneous'])
    expect(homogeneous.summary.publicationIdsByDisposition.mixed_structure_figure_residuals).toEqual(['figurey'])
    expect(homogeneous.summary.publicationIdsByDisposition.structure_processing_error_retry).toEqual(['runtime'])

    const next = applyStage4StructureWaveReclassification(artifacts, [], [], [], [], [], homogeneous.analysis.rows)
    expect(next.document.rows.find(row => row.publicationId === 'homogeneous')?.stage4StructureDiagnostics.terminalSurvivorClass).toBe('metadata_font_structure_survivor')
    expect(next.document.rows.find(row => row.publicationId === 'runtime')?.currentCorpusStatus).toBe('processing_error')

    const { wave } = buildStage4StructureWaveArtifacts({
      artifacts: next,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T08:00:00.000Z',
      manifestsRoot,
      homogeneousAnalysisRows: homogeneous.analysis.rows,
    })

    expect(wave.selectedPublicationIds).toEqual(['fresh-meta'])

    const summary = buildStage4StructureThroughputSummary({
      artifacts: next,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T08:00:00.000Z',
      waveManifestPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.json',
      wave,
      activeWave: wave,
      outcomesPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.outcomes.json',
      outcomes: { outcomes: [] },
      homogeneousAnalysisRows: homogeneous.analysis.rows,
    })

    expect(summary.rows.metadataFontStructureSurvivorPublicationIds).toEqual(['homogeneous'])
    expect(summary.rows.homogeneousAnalysisPublicationIds).toEqual(['figurey', 'homogeneous', 'runtime'])
    expect(summary.rows.homogeneousAnalysisByDisposition.metadata_font_structure_survivor).toEqual(['homogeneous'])
  })

  it('reports throughput routing buckets and builds structure canaries', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'staged', currentCorpusStatus: 'staged_for_replacement', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: 'staged_pass_candidate_survivor' } }),
      makeRow({ publicationId: 'verified', currentCorpusStatus: 'verified_pass', cohortLabel: 'structure_heavy', title: 'Verified Structure', promotionTruth: { promotionStatus: 'verified_pass', ledgerRowPresent: true, stagedReplacementPath: '/staged/verified.pdf', replacementChecksumSha256: 'x', verificationPassed: true }, stage4StructureDiagnostics: { structureWaveBucket: 'structure_only_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: null } }),
      makeRow({ publicationId: 'meta', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: null } }),
      makeRow({ publicationId: 'structure', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'structure_only_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: null } }),
      makeRow({ publicationId: 'mixed', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', reasonCodes: ['stage4:mixed_structure_figure_after_wave'], stage4StructureDiagnostics: { structureWaveBucket: 'mixed_structure_figure_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: true, hasBoundedRuntimeWording: false, originLane: 'reclassified_from_figure_heavy', terminalSurvivorClass: null } }),
      makeRow({ publicationId: 'retry', currentCorpusStatus: 'processing_error', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'structure_processing_error_retry', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: true, originLane: 'native_structure_heavy', terminalSurvivorClass: null } }),
      makeRow({ publicationId: '4436', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', title: 'Spillover Structure', reasonCodes: ['stage3:reclassified_from_figure_heavy'], stage4StructureDiagnostics: { structureWaveBucket: 'structure_only_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'reclassified_from_figure_heavy', terminalSurvivorClass: null } }),
      makeRow({ publicationId: '4023', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: 'near_pass_grade_only' } }),
      makeRow({ publicationId: '3665', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: 'metadata_title_survivor' } }),
      makeRow({ publicationId: '3465', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: true, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy', terminalSurvivorClass: 'font_text_extractability_survivor' } }),
      makeRow({ publicationId: '3671', currentCorpusStatus: 'remediated_fail', cohortLabel: 'figure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: true, hasBoundedRuntimeWording: false, originLane: 'reclassified_from_short_high_likelihood', terminalSurvivorClass: 'figure_spillover_survivor' } }),
    ])
    const wave: Stage4StructureWaveDocument = {
      generatedAt: '2026-03-31T00:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z',
      waveName: 'stage4-structure-wave',
      cohortLabel: 'structure_heavy',
      maxCandidates: 8,
      totals: { eligibleRows: 4, selectedRows: 4, skippedRows: 0, pendingRows: 0 },
      selectedPublicationIds: ['meta', 'structure', 'mixed', 'retry'],
      pendingPublicationIds: [],
      candidates: [],
      skippedRows: [],
    }
    const summary = buildStage4StructureThroughputSummary({ artifacts, sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json', sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z', waveManifestPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.json', wave, outcomesPath: '/tmp/repo/ICJIA-PDFs/manifests/stage4-structure-wave.outcomes.json', outcomes: { outcomes: [{ publicationId: 'mixed', status: 'failed_after_remediation' }, { publicationId: 'retry', status: 'processing_error' }] } })
    expect(summary.rows.nextWaveStructureOnlyPublicationIds).toEqual(['4436', 'meta', 'structure'])
    expect(summary.rows.stagedPassCandidatePublicationIds).toEqual(['staged'])
    expect(summary.rows.metadataTitleSurvivorPublicationIds).toEqual(['3665'])
    expect(summary.rows.readingOrderOnlyResidualPublicationIds).toEqual([])
    expect(summary.rows.mixedFollowupPublicationIds).toEqual(['mixed'])
    expect(summary.rows.boundedRuntimeRetryPublicationIds).toEqual(['retry'])
    expect(summary.totals.genericTimeoutRows).toBe(0)

    const canaries = buildStage4StructureCanaries({ artifacts, sources: makeSources() })
    expect(canaries.rows.some(row => row.publicationId === 'staged' && row.stage4RepresentativeKind === 'staged_pass_candidate_survivor')).toBe(true)
    expect(canaries.rows.some(row => row.publicationId === 'verified' && row.stage4RepresentativeKind === 'verified_pass')).toBe(true)
    expect(canaries.rows.some(row => row.publicationId === '4023' && row.stage4RepresentativeKind === 'near_pass_grade_only')).toBe(true)
    expect(canaries.rows.some(row => row.publicationId === '3665' && row.stage4RepresentativeKind === 'metadata_title_survivor')).toBe(true)
    expect(canaries.rows.some(row => row.publicationId === '3465' && row.stage4RepresentativeKind === 'font_text_extractability_survivor')).toBe(true)
    expect(canaries.rows.some(row => row.publicationId === '3671' && row.stage4RepresentativeKind === 'figure_spillover_survivor')).toBe(true)
  })
})
