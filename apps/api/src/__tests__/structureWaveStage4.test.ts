import { describe, expect, it } from 'vitest'
import {
  applyStage4StructureWaveReclassification,
  buildStage4StructureCanaries,
  buildStage4StructureThroughputSummary,
  buildStage4StructureWaveArtifacts,
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
    stage4StructureDiagnostics: { structureWaveBucket: null, dominantStructurePhase: null, hasLogicalStructureDebt: null, hasHeadingDebt: null, hasReadingOrderDebt: null, hasMetadataNavigationDebt: null, hasMixedFigureResiduals: null, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' },
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
      makeRow({ publicationId: 'retry', currentCorpusStatus: 'processing_error', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: null, dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: null, hasReadingOrderDebt: null, hasMetadataNavigationDebt: null, hasMixedFigureResiduals: null, hasBoundedRuntimeWording: true, originLane: 'native_structure_heavy' }, reasonCodes: ['outcome:processing_error'] }),
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
      makeRow({ publicationId: 'meta', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' } }),
      makeRow({ publicationId: 'structure', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'structure_only_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' } }),
      makeRow({ publicationId: 'mixed', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'mixed_structure_figure_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: true, hasBoundedRuntimeWording: false, originLane: 'reclassified_from_figure_heavy' } }),
      makeRow({ publicationId: 'retry', currentCorpusStatus: 'processing_error', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'structure_processing_error_retry', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: true, originLane: 'native_structure_heavy' }, reasonCodes: ['outcome:processing_error'] }),
      makeRow({ publicationId: 'verified', currentCorpusStatus: 'verified_pass', cohortLabel: 'structure_heavy', promotionTruth: { promotionStatus: 'verified_pass', ledgerRowPresent: true, stagedReplacementPath: '/staged/verified.pdf', replacementChecksumSha256: 'x', verificationPassed: true } }),
    ])
    const { wave } = buildStage4StructureWaveArtifacts({ artifacts, sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json', sourceControlPlaneGeneratedAt: '2026-03-31T00:00:00.000Z', manifestsRoot, maxCandidates: 8 })
    expect(wave.selectedPublicationIds).toEqual(['meta', 'structure', 'mixed', 'retry'])
  })

  it('reports throughput routing buckets and builds structure canaries', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'verified', currentCorpusStatus: 'verified_pass', cohortLabel: 'structure_heavy', title: 'Verified Structure', promotionTruth: { promotionStatus: 'verified_pass', ledgerRowPresent: true, stagedReplacementPath: '/staged/verified.pdf', replacementChecksumSha256: 'x', verificationPassed: true }, stage4StructureDiagnostics: { structureWaveBucket: 'structure_only_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' } }),
      makeRow({ publicationId: 'meta', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'metadata_navigation_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: false, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: true, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' } }),
      makeRow({ publicationId: 'structure', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'structure_only_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'native_structure_heavy' } }),
      makeRow({ publicationId: 'mixed', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', reasonCodes: ['stage4:mixed_structure_figure_after_wave'], stage4StructureDiagnostics: { structureWaveBucket: 'mixed_structure_figure_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: true, hasBoundedRuntimeWording: false, originLane: 'reclassified_from_figure_heavy' } }),
      makeRow({ publicationId: 'retry', currentCorpusStatus: 'processing_error', cohortLabel: 'structure_heavy', stage4StructureDiagnostics: { structureWaveBucket: 'structure_processing_error_retry', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: true, originLane: 'native_structure_heavy' } }),
      makeRow({ publicationId: '4436', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', title: 'Spillover Structure', reasonCodes: ['stage3:reclassified_from_figure_heavy'], stage4StructureDiagnostics: { structureWaveBucket: 'structure_only_residuals', dominantStructurePhase: null, hasLogicalStructureDebt: true, hasHeadingDebt: false, hasReadingOrderDebt: false, hasMetadataNavigationDebt: false, hasMixedFigureResiduals: false, hasBoundedRuntimeWording: false, originLane: 'reclassified_from_figure_heavy' } }),
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
    expect(summary.rows.mixedFollowupPublicationIds).toEqual(['mixed'])
    expect(summary.rows.boundedRuntimeRetryPublicationIds).toEqual(['retry'])
    expect(summary.totals.genericTimeoutRows).toBe(0)

    const canaries = buildStage4StructureCanaries({ artifacts, sources: makeSources() })
    expect(canaries.rows.some(row => row.publicationId === '4436' && row.stage4RepresentativeKind === 'spillover_from_stage3')).toBe(true)
    expect(canaries.rows.some(row => row.publicationId === 'verified' && row.stage4RepresentativeKind === 'verified_pass')).toBe(true)
  })
})
