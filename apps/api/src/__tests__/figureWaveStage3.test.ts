import { describe, expect, it } from 'vitest'
import {
  applyStage3FigureWaveReclassification,
  buildStage3FigureCanaries,
  buildStage3FigureThroughputSummary,
  buildStage3FigureWaveArtifacts,
  type Stage3FigureWaveDocument,
} from '../services/figureWaveStage3.js'
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
    classificationEvidence: { pageCount: 4, isScanned: false, overallScore: 90, grade: 'B', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 2, topBlockingResidualFamilyIds: ['native_figure_convergence'], blockingFindingKeys: ['pdfua.figure_alt_or_artifact'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] },
    promotionTruth: { promotionStatus: null, ledgerRowPresent: false, stagedReplacementPath: null, replacementChecksumSha256: null, verificationPassed: false },
    stage3FigureDiagnostics: { figureWaveBucket: 'mass_unresolved_figure_debt', ownershipRiskKnown: false, ownershipRiskCountInitial: null, ownershipRiskCountFinal: null, missingAltCountInitial: null, missingAltCountFinal: null, decorativeFigureCountInitial: null, decorativeFigureCountFinal: null, dominantFigurePhase: null, inspectionPattern: null, hasGenericTimeoutWording: false },
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
      generatedAt: '2026-03-30T00:00:00.000Z',
      summary: {
        totalRows: rows.length,
        byCurrentCorpusStatus,
        byCohortLabel,
        byStorageKind: { legacy_archive: rows.length },
        statusByCohort,
        verifiedPassRowsFromLedger: 0,
        remainingRowsExcludingVerifiedPass: rows.filter(row => row.currentCorpusStatus !== 'verified_pass').length,
      },
      rows,
    },
    byCohort: {
      generatedAt: '2026-03-30T00:00:00.000Z',
      cohorts: {
        short_high_likelihood: { totalRows: byCohortLabel.short_high_likelihood, byCurrentCorpusStatus: statusByCohort.short_high_likelihood, samplePublicationIds: [] },
        figure_heavy: { totalRows: byCohortLabel.figure_heavy, byCurrentCorpusStatus: statusByCohort.figure_heavy, samplePublicationIds: [] },
        structure_heavy: { totalRows: byCohortLabel.structure_heavy, byCurrentCorpusStatus: statusByCohort.structure_heavy, samplePublicationIds: [] },
        font_heavy: { totalRows: byCohortLabel.font_heavy, byCurrentCorpusStatus: statusByCohort.font_heavy, samplePublicationIds: [] },
        long_report: { totalRows: byCohortLabel.long_report, byCurrentCorpusStatus: statusByCohort.long_report, samplePublicationIds: [] },
        manual_tail: { totalRows: byCohortLabel.manual_tail, byCurrentCorpusStatus: statusByCohort.manual_tail, samplePublicationIds: [] },
      },
    },
    canaries: { generatedAt: '2026-03-30T00:00:00.000Z', summary: { totalCanaries: 0, matchedPublicationIds: 0, unmatchedCanaries: 0, byCohortLabel }, rows: [] },
  }
}

function makeSources(): CorpusControlPlaneSources {
  return {
    repoRoot: '/tmp/repo', manifestsRoot: '/tmp/repo/ICJIA-PDFs/manifests', replacementMapPath: '/tmp/repo/ICJIA-PDFs/manifests/publication-pdf-replacement-map.json', verificationPath: null, verificationClassifiedPath: null, promotionLedgerPath: null, regressionBenchmarkPath: null, replacementMap: [
      { publicationId: 'ownership', title: 'Kendall County Profile', slug: 'kendall', fileUrl: null, fileHost: null, storageKind: 'legacy_archive', replaceVia: null, serverHost: '143.244.146.43', sshTarget: null, remotePath: '/remote/ownership.pdf', remoteDir: '/remote', localWorkingPath: null, localBackupPath: null, localServerMirrorPath: null, expectedPresence: 'present', notes: null, checksumState: { localCurrentFilePath: '/cache/ownership.pdf' } },
      { publicationId: 'mixed', title: 'CSEC 2008 Research Bulletin', slug: 'csec', fileUrl: null, fileHost: null, storageKind: 'legacy_archive', replaceVia: null, serverHost: '143.244.146.43', sshTarget: null, remotePath: '/remote/mixed.pdf', remoteDir: '/remote', localWorkingPath: null, localBackupPath: null, localServerMirrorPath: null, expectedPresence: 'present', notes: null, checksumState: { localCurrentFilePath: '/cache/mixed.pdf' } },
      { publicationId: 'runtime', title: 'Criminal Sentencing Layout', slug: 'runtime', fileUrl: null, fileHost: null, storageKind: 'legacy_archive', replaceVia: null, serverHost: '143.244.146.43', sshTarget: null, remotePath: '/remote/runtime.pdf', remoteDir: '/remote', localWorkingPath: null, localBackupPath: null, localServerMirrorPath: null, expectedPresence: 'present', notes: null, checksumState: { localCurrentFilePath: '/cache/runtime.pdf' } },
    ], verificationResults: [], verificationRows: [], classifiedRows: [], promotionLedgerRows: [], outcomeManifests: [], candidateManifests: [], regressionBenchmarkOutcomes: [
      { name: 'Kendall County Profile', filePath: '/cache/ownership.pdf', category: 'ownership', terminalState: 'pass' },
      { name: 'CSEC 2008 Research Bulletin', filePath: '/cache/mixed.pdf', category: 'figure_description', terminalState: 'hard_fail' },
      { name: 'Criminal Sentencing Layout', filePath: '/cache/runtime.pdf', category: 'structure', terminalState: 'hard_fail' },
    ],
  } as unknown as CorpusControlPlaneSources
}

describe('figure wave Stage 3 selection', () => {
  it('reclassifies structure-only rows and preserves truthful runtime retries', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: '3614', currentCorpusStatus: 'remediated_fail', cohortLabel: 'figure_heavy', statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: '/tmp/outcomes.json', outcomeStatus: 'failed_after_remediation', latestReportPath: '/tmp/3614.json', candidateManifestPath: null }, stage3FigureDiagnostics: { figureWaveBucket: 'ownership_cleared_figure_debt_remains', ownershipRiskKnown: true, ownershipRiskCountInitial: 5, ownershipRiskCountFinal: 0, missingAltCountInitial: 2, missingAltCountFinal: 4, decorativeFigureCountInitial: 0, decorativeFigureCountFinal: 0, dominantFigurePhase: 'figure_description', inspectionPattern: 'mixed', hasGenericTimeoutWording: false }, classificationEvidence: { pageCount: 32, isScanned: false, overallScore: 87, grade: 'B', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: ['pdfua.untagged_rendered_images'], blockingFindingKeys: ['pdfua.figure_alt_or_artifact'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
      makeRow({ publicationId: '3682', currentCorpusStatus: 'remediated_fail', cohortLabel: 'figure_heavy', statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: '/tmp/outcomes.json', outcomeStatus: 'failed_after_remediation', latestReportPath: '/tmp/3682.json', candidateManifestPath: null }, stage3FigureDiagnostics: { figureWaveBucket: 'mass_unresolved_figure_debt', ownershipRiskKnown: true, ownershipRiskCountInitial: 115, ownershipRiskCountFinal: 0, missingAltCountInitial: 110, missingAltCountFinal: 110, decorativeFigureCountInitial: 0, decorativeFigureCountFinal: 0, dominantFigurePhase: 'figure_description', inspectionPattern: 'mixed', hasGenericTimeoutWording: false }, classificationEvidence: { pageCount: 2, isScanned: false, overallScore: 76, grade: 'C', blockerFamilyCount: 5, blockingFindingCount: 10, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 13, topBlockingResidualFamilyIds: ['native_figure_convergence'], blockingFindingKeys: ['pdfua.figure_alt_or_artifact'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
      makeRow({ publicationId: '4184', currentCorpusStatus: 'remediated_fail', cohortLabel: 'figure_heavy', statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: '/tmp/outcomes.json', outcomeStatus: 'failed_after_remediation', latestReportPath: '/tmp/4184.json', candidateManifestPath: null }, stage3FigureDiagnostics: { figureWaveBucket: 'mixed_figure_structure_debt', ownershipRiskKnown: true, ownershipRiskCountInitial: 1, ownershipRiskCountFinal: 0, missingAltCountInitial: 4, missingAltCountFinal: 0, decorativeFigureCountInitial: 1, decorativeFigureCountFinal: 1, dominantFigurePhase: 'figure_description', inspectionPattern: 'mixed', hasGenericTimeoutWording: false }, classificationEvidence: { pageCount: 4, isScanned: false, overallScore: 69, grade: 'D', blockerFamilyCount: 2, blockingFindingCount: 2, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: ['pdfua.logical_structure'], blockingFindingKeys: ['pdfua.figure_alt_or_artifact', 'pdfua.logical_structure'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
      makeRow({ publicationId: '4436', currentCorpusStatus: 'remediated_fail', cohortLabel: 'figure_heavy', statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: '/tmp/outcomes.json', outcomeStatus: 'failed_after_remediation', latestReportPath: '/tmp/4436.json', candidateManifestPath: null }, stage3FigureDiagnostics: { figureWaveBucket: null, ownershipRiskKnown: false, ownershipRiskCountInitial: null, ownershipRiskCountFinal: null, missingAltCountInitial: null, missingAltCountFinal: null, decorativeFigureCountInitial: null, decorativeFigureCountFinal: null, dominantFigurePhase: null, inspectionPattern: null, hasGenericTimeoutWording: false }, classificationEvidence: { pageCount: 8, isScanned: false, overallScore: 72, grade: 'C', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: ['pdfua.logical_structure'], blockingFindingKeys: ['pdfua.logical_structure'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
      makeRow({ publicationId: '4487', currentCorpusStatus: 'remediated_fail', cohortLabel: 'figure_heavy', statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: '/tmp/outcomes.json', outcomeStatus: 'processing_error', latestReportPath: '/tmp/4487.json', candidateManifestPath: null }, stage3FigureDiagnostics: { figureWaveBucket: 'figure_processing_error_retry', ownershipRiskKnown: false, ownershipRiskCountInitial: null, ownershipRiskCountFinal: null, missingAltCountInitial: null, missingAltCountFinal: null, decorativeFigureCountInitial: null, decorativeFigureCountFinal: null, dominantFigurePhase: null, inspectionPattern: null, hasGenericTimeoutWording: false }, classificationEvidence: { pageCount: 9, isScanned: false, overallScore: 64, grade: 'D', blockerFamilyCount: 2, blockingFindingCount: 2, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: ['pdfua.heading_content_quality', 'pdfua.untagged_rendered_images'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
    ])
    const reclassified = applyStage3FigureWaveReclassification(artifacts)
    const row3614 = reclassified.document.rows.find(row => row.publicationId === '3614')!
    const row3682 = reclassified.document.rows.find(row => row.publicationId === '3682')!
    const row4184 = reclassified.document.rows.find(row => row.publicationId === '4184')!
    const row4436 = reclassified.document.rows.find(row => row.publicationId === '4436')!
    const row4487 = reclassified.document.rows.find(row => row.publicationId === '4487')!

    expect(row3614.stage3FigureDiagnostics.figureWaveBucket).toBe('ownership_cleared_figure_debt_remains')
    expect(row3682.stage3FigureDiagnostics.figureWaveBucket).toBe('mass_unresolved_figure_debt')
    expect(row4184.stage3FigureDiagnostics.figureWaveBucket).toBe('mixed_figure_structure_debt')
    expect(row4436.cohortLabel).toBe('structure_heavy')
    expect(row4436.reasonCodes).toContain('stage3:reclassified_from_figure_heavy')
    expect(row4487.currentCorpusStatus).toBe('processing_error')
    expect(row4487.reasonCodes).toContain('stage3:bounded_runtime_figure_retry')
  })

  it('drops stale pending rows and prioritizes figure-only survivors before mixed cases', () => {
    const fsLocal = require('fs')
    const os = require('os')
    const pathLocal = require('path')
    const manifestsRoot = fsLocal.mkdtempSync(pathLocal.join(os.tmpdir(), 'stage3-wave-'))
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, 'stage3-figure-wave.json'), JSON.stringify({
      generatedAt: '2026-03-30T00:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-30T00:00:00.000Z',
      waveName: 'stage3-figure-wave',
      cohortLabel: 'figure_heavy',
      maxCandidates: 8,
      totals: { eligibleRows: 1, selectedRows: 1, skippedRows: 0, pendingRows: 1 },
      selectedPublicationIds: ['stale'],
      pendingPublicationIds: ['stale'],
      candidates: [],
      skippedRows: [],
    }))
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'ownership', currentCorpusStatus: 'remediated_fail', cohortLabel: 'figure_heavy', stage3FigureDiagnostics: { figureWaveBucket: 'ownership_cleared_figure_debt_remains', ownershipRiskKnown: true, ownershipRiskCountInitial: 5, ownershipRiskCountFinal: 0, missingAltCountInitial: 3, missingAltCountFinal: 2, decorativeFigureCountInitial: 0, decorativeFigureCountFinal: 0, dominantFigurePhase: 'figure_description', inspectionPattern: 'mixed', hasGenericTimeoutWording: false } }),
      makeRow({ publicationId: 'mass', currentCorpusStatus: 'remediated_fail', cohortLabel: 'figure_heavy', stage3FigureDiagnostics: { figureWaveBucket: 'mass_unresolved_figure_debt', ownershipRiskKnown: true, ownershipRiskCountInitial: 115, ownershipRiskCountFinal: 0, missingAltCountInitial: 110, missingAltCountFinal: 110, decorativeFigureCountInitial: 0, decorativeFigureCountFinal: 0, dominantFigurePhase: 'figure_description', inspectionPattern: 'mixed', hasGenericTimeoutWording: false } }),
      makeRow({ publicationId: 'retry', currentCorpusStatus: 'processing_error', cohortLabel: 'figure_heavy', stage3FigureDiagnostics: { figureWaveBucket: 'figure_processing_error_retry', ownershipRiskKnown: false, ownershipRiskCountInitial: null, ownershipRiskCountFinal: null, missingAltCountInitial: 1, missingAltCountFinal: 1, decorativeFigureCountInitial: 0, decorativeFigureCountFinal: 0, dominantFigurePhase: 'figure_description', inspectionPattern: 'mixed', hasGenericTimeoutWording: false }, statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: '/tmp/outcomes.json', outcomeStatus: 'processing_error', latestReportPath: '/tmp/retry.json', candidateManifestPath: null } }),
      makeRow({ publicationId: 'mixed', currentCorpusStatus: 'remediated_fail', cohortLabel: 'figure_heavy', stage3FigureDiagnostics: { figureWaveBucket: 'mixed_figure_structure_debt', ownershipRiskKnown: false, ownershipRiskCountInitial: null, ownershipRiskCountFinal: null, missingAltCountInitial: 2, missingAltCountFinal: 1, decorativeFigureCountInitial: 0, decorativeFigureCountFinal: 0, dominantFigurePhase: 'figure_description', inspectionPattern: 'mixed', hasGenericTimeoutWording: false } }),
      makeRow({ publicationId: 'reclassified', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', reasonCodes: ['stage3:reclassified_from_figure_heavy'], stage3FigureDiagnostics: { figureWaveBucket: null, ownershipRiskKnown: false, ownershipRiskCountInitial: null, ownershipRiskCountFinal: null, missingAltCountInitial: null, missingAltCountFinal: null, decorativeFigureCountInitial: null, decorativeFigureCountFinal: null, dominantFigurePhase: null, inspectionPattern: null, hasGenericTimeoutWording: false } }),
      makeRow({ publicationId: 'verified', currentCorpusStatus: 'verified_pass', cohortLabel: 'figure_heavy', promotionTruth: { promotionStatus: 'verified_pass', ledgerRowPresent: true, stagedReplacementPath: '/staged/verified.pdf', replacementChecksumSha256: 'x', verificationPassed: true } }),
    ])
    const { wave } = buildStage3FigureWaveArtifacts({ artifacts, sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json', sourceControlPlaneGeneratedAt: '2026-03-30T00:00:00.000Z', manifestsRoot, maxCandidates: 8 })
    expect(wave.selectedPublicationIds).toEqual(['ownership', 'mass', 'retry', 'mixed'])
    expect(wave.pendingPublicationIds).toEqual([])
    expect(wave.candidates.map(candidate => candidate.figureWaveBucket)).toEqual(['ownership_cleared_figure_debt_remains', 'mass_unresolved_figure_debt', 'figure_processing_error_retry', 'mixed_figure_structure_debt'])
  })

  it('reports Stage 3 routing buckets in the throughput summary', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: '3614', currentCorpusStatus: 'remediated_fail', cohortLabel: 'figure_heavy', stage3FigureDiagnostics: { figureWaveBucket: 'ownership_cleared_figure_debt_remains', ownershipRiskKnown: true, ownershipRiskCountInitial: 5, ownershipRiskCountFinal: 0, missingAltCountInitial: 2, missingAltCountFinal: 4, decorativeFigureCountInitial: 0, decorativeFigureCountFinal: 0, dominantFigurePhase: 'figure_description', inspectionPattern: 'mixed', hasGenericTimeoutWording: false } }),
      makeRow({ publicationId: '3682', currentCorpusStatus: 'remediated_fail', cohortLabel: 'figure_heavy', reasonCodes: ['stage3:mass_figure_debt_after_wave'], stage3FigureDiagnostics: { figureWaveBucket: 'mass_unresolved_figure_debt', ownershipRiskKnown: true, ownershipRiskCountInitial: 115, ownershipRiskCountFinal: 0, missingAltCountInitial: 110, missingAltCountFinal: 110, decorativeFigureCountInitial: 0, decorativeFigureCountFinal: 0, dominantFigurePhase: 'figure_description', inspectionPattern: 'mixed', hasGenericTimeoutWording: false } }),
      makeRow({ publicationId: '4074', currentCorpusStatus: 'remediated_fail', cohortLabel: 'figure_heavy', reasonCodes: ['stage3:mixed_figure_structure_after_wave'], stage3FigureDiagnostics: { figureWaveBucket: 'mixed_figure_structure_debt', ownershipRiskKnown: false, ownershipRiskCountInitial: null, ownershipRiskCountFinal: null, missingAltCountInitial: null, missingAltCountFinal: null, decorativeFigureCountInitial: null, decorativeFigureCountFinal: null, dominantFigurePhase: null, inspectionPattern: null, hasGenericTimeoutWording: false } }),
      makeRow({ publicationId: '4487', currentCorpusStatus: 'processing_error', cohortLabel: 'figure_heavy', reasonCodes: ['stage3:bounded_runtime_figure_retry'], stage3FigureDiagnostics: { figureWaveBucket: 'figure_processing_error_retry', ownershipRiskKnown: false, ownershipRiskCountInitial: null, ownershipRiskCountFinal: null, missingAltCountInitial: null, missingAltCountFinal: null, decorativeFigureCountInitial: null, decorativeFigureCountFinal: null, dominantFigurePhase: null, inspectionPattern: null, hasGenericTimeoutWording: false } }),
      makeRow({ publicationId: '4436', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy', reasonCodes: ['stage3:reclassified_from_figure_heavy'], stage3FigureDiagnostics: { figureWaveBucket: null, ownershipRiskKnown: false, ownershipRiskCountInitial: null, ownershipRiskCountFinal: null, missingAltCountInitial: null, missingAltCountFinal: null, decorativeFigureCountInitial: null, decorativeFigureCountFinal: null, dominantFigurePhase: null, inspectionPattern: null, hasGenericTimeoutWording: false } }),
      makeRow({ publicationId: 'verified', currentCorpusStatus: 'verified_pass', cohortLabel: 'figure_heavy', promotionTruth: { promotionStatus: 'verified_pass', ledgerRowPresent: true, stagedReplacementPath: '/staged/verified.pdf', replacementChecksumSha256: 'x', verificationPassed: true }, stage3FigureDiagnostics: { figureWaveBucket: 'ownership_cleared_figure_debt_remains', ownershipRiskKnown: true, ownershipRiskCountInitial: 4, ownershipRiskCountFinal: 0, missingAltCountInitial: 2, missingAltCountFinal: 0, decorativeFigureCountInitial: 0, decorativeFigureCountFinal: 0, dominantFigurePhase: 'figure_description', inspectionPattern: 'mixed', hasGenericTimeoutWording: false } }),
    ])
    const wave: Stage3FigureWaveDocument = {
      generatedAt: '2026-03-30T00:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-30T00:00:00.000Z',
      waveName: 'stage3-figure-wave',
      cohortLabel: 'figure_heavy',
      maxCandidates: 8,
      totals: { eligibleRows: 4, selectedRows: 4, skippedRows: 0, pendingRows: 0 },
      selectedPublicationIds: ['3614', '3682', '4074', '4487'],
      pendingPublicationIds: [],
      candidates: [],
      skippedRows: [],
    }
    const summary = buildStage3FigureThroughputSummary({ artifacts, sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json', sourceControlPlaneGeneratedAt: '2026-03-30T00:00:00.000Z', waveManifestPath: '/tmp/repo/ICJIA-PDFs/manifests/stage3-figure-wave.json', wave, outcomesPath: '/tmp/repo/ICJIA-PDFs/manifests/stage3-figure-wave.outcomes.json', outcomes: { outcomes: [{ publicationId: '4074', status: 'failed_after_remediation' }, { publicationId: '4487', status: 'processing_error' }] } })
    expect(summary.rows.nextWaveFigureOnlyPublicationIds).toEqual(['3614', '3682'])
    expect(summary.rows.mixedFollowupPublicationIds).toEqual(['4074'])
    expect(summary.rows.boundedRuntimeRetryPublicationIds).toEqual(['4487'])
    expect(summary.rows.reclassifiedOutOfFigureHeavyPublicationIds).toEqual(['4436'])
    expect(summary.totals.genericTimeoutRows).toBe(0)
  })

  it('builds stable benchmark and representative canaries with corrected post-wave routing', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'ownership', currentCorpusStatus: 'remediated_fail', cohortLabel: 'figure_heavy', title: 'Kendall County Profile', classificationEvidence: { pageCount: 12, isScanned: false, overallScore: 90, grade: 'B', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 2, topBlockingResidualFamilyIds: ['native_figure_convergence'], blockingFindingKeys: ['pdfua.figure_alt_or_artifact'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] }, stage3FigureDiagnostics: { figureWaveBucket: 'ownership_cleared_figure_debt_remains', ownershipRiskKnown: true, ownershipRiskCountInitial: 5, ownershipRiskCountFinal: 0, missingAltCountInitial: 3, missingAltCountFinal: 2, decorativeFigureCountInitial: 0, decorativeFigureCountFinal: 0, dominantFigurePhase: 'figure_description', inspectionPattern: 'mixed', hasGenericTimeoutWording: false } }),
      makeRow({ publicationId: 'mass', currentCorpusStatus: 'remediated_fail', cohortLabel: 'figure_heavy', title: 'Criminal Sentencing Layout', classificationEvidence: { pageCount: 2, isScanned: false, overallScore: 76, grade: 'C', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: ['native_figure_convergence'], blockingFindingKeys: ['pdfua.figure_alt_or_artifact'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] }, stage3FigureDiagnostics: { figureWaveBucket: 'mass_unresolved_figure_debt', ownershipRiskKnown: true, ownershipRiskCountInitial: 115, ownershipRiskCountFinal: 0, missingAltCountInitial: 110, missingAltCountFinal: 110, decorativeFigureCountInitial: 0, decorativeFigureCountFinal: 0, dominantFigurePhase: 'figure_description', inspectionPattern: 'mixed', hasGenericTimeoutWording: false } }),
      makeRow({ publicationId: 'runtime', currentCorpusStatus: 'processing_error', cohortLabel: 'figure_heavy', title: 'Bounded Runtime Retry', stage3FigureDiagnostics: { figureWaveBucket: 'figure_processing_error_retry', ownershipRiskKnown: false, ownershipRiskCountInitial: null, ownershipRiskCountFinal: null, missingAltCountInitial: 110, missingAltCountFinal: 110, decorativeFigureCountInitial: 0, decorativeFigureCountFinal: 0, dominantFigurePhase: 'figure_description', inspectionPattern: 'mixed', hasGenericTimeoutWording: false }, classificationEvidence: { pageCount: 2, isScanned: false, overallScore: 76, grade: 'C', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: ['native_figure_convergence'], blockingFindingKeys: ['pdfua.figure_alt_or_artifact'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
    ])
    const canaries = buildStage3FigureCanaries({ artifacts, sources: makeSources() })
    expect(canaries.rows.some(row => row.benchmarkName === 'Kendall County Profile')).toBe(true)
    expect(canaries.rows.some(row => row.benchmarkName === 'CSEC 2008 Research Bulletin')).toBe(true)
    expect(canaries.rows.some(row => row.benchmarkName === 'Criminal Sentencing Layout')).toBe(true)
    expect(canaries.rows.some(row => row.stage3RepresentativeKind === 'mass_unresolved_figure_debt')).toBe(true)
    expect(canaries.summary.withGenericTimeoutWording).toBe(0)
  })
})
