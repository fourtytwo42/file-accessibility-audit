import { describe, expect, it } from 'vitest'
import {
  buildStage6LongReportForensicsArtifacts,
  buildStage6LongReportThroughputSummary,
  buildStage6LongReportWaveArtifacts,
} from '../services/longReportStage6.js'
import type { CorpusControlPlaneArtifacts, CorpusControlPlaneRow } from '../services/corpusControlPlane.js'

function emptyStatusCounts() {
  return { verified_pass: 0, discovered: 0, analyzed: 0, queued_for_remediation: 0, remediated_fail: 0, processing_error: 0, deferred_manual: 0, staged_for_replacement: 0, replaced_remote: 0 }
}

function makeRow(input: Partial<CorpusControlPlaneRow> & Pick<CorpusControlPlaneRow, 'publicationId' | 'currentCorpusStatus' | 'cohortLabel'>): CorpusControlPlaneRow {
  const { publicationId, currentCorpusStatus, cohortLabel, ...overrides } = input
  return {
    publicationId,
    title: publicationId,
    slug: null,
    fileUrl: `https://example.test/${publicationId}.pdf`,
    storageKind: 'legacy_archive',
    sourceKind: 'legacy_archive',
    serverHost: '143.244.146.43',
    remotePath: `/remote/${publicationId}.pdf`,
    remoteDir: '/remote',
    replaceVia: 'sftp',
    currentCorpusStatus,
    cohortLabel,
    sourceMetadata: { fileHost: 'archive.icjia-api.cloud', sshTarget: 'forge@test', expectedPresence: 'present', localWorkingPath: null, localBackupPath: null, localServerMirrorPath: null, checksumRecordedAt: null, currentSourcePath: `/cache/${publicationId}.pdf`, currentSourceMd5: null },
    statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.classified.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: null, outcomeStatus: null, latestReportPath: null, candidateManifestPath: null },
    classificationEvidence: { pageCount: 80, isScanned: false, overallScore: 88, grade: 'B', blockerFamilyCount: null, blockingFindingCount: null, manualOnlyFailureModeCount: null, autoRunnableOpportunityCount: null, topBlockingResidualFamilyIds: [], blockingFindingKeys: [], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] },
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
      generatedAt: '2026-04-01T00:00:00.000Z',
      summary: {
        totalRows: rows.length,
        byCurrentCorpusStatus,
        byCohortLabel,
        byStorageKind: { legacy_archive: rows.length, researchhub_upload: 0, agency_upload: 0 },
        statusByCohort,
        verifiedPassRowsFromLedger: 0,
        remainingRowsExcludingVerifiedPass: rows.filter(row => row.currentCorpusStatus !== 'verified_pass').length,
      },
      rows,
    },
    byCohort: {
      generatedAt: '2026-04-01T00:00:00.000Z',
      cohorts: {
        short_high_likelihood: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] },
        figure_heavy: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] },
        structure_heavy: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] },
        font_heavy: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] },
        long_report: { totalRows: byCohortLabel.long_report, byCurrentCorpusStatus: statusByCohort.long_report, samplePublicationIds: [] },
        manual_tail: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] },
      },
    },
    canaries: { generatedAt: '2026-04-01T00:00:00.000Z', summary: { totalCanaries: 0, matchedPublicationIds: 0, unmatchedCanaries: 0, byCohortLabel }, rows: [] },
  }
}

describe('long report Stage 6', () => {
  it('classifies long-report rows into verified, stable hard fail, retry, and mixed residual buckets', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'verified', currentCorpusStatus: 'verified_pass', cohortLabel: 'long_report', promotionTruth: { promotionStatus: 'verified_pass', ledgerRowPresent: true, stagedReplacementPath: '/tmp/verified.pdf', replacementChecksumSha256: 'abc', verificationPassed: true } }),
      makeRow({ publicationId: 'retry', currentCorpusStatus: 'processing_error', cohortLabel: 'long_report', statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.classified.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: '/tmp/stage2.outcomes.json', outcomeStatus: 'processing_error', latestReportPath: null, candidateManifestPath: null } }),
      makeRow({ publicationId: 'mixed', currentCorpusStatus: 'remediated_fail', cohortLabel: 'long_report', statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.classified.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: null, outcomeStatus: null, latestReportPath: null, candidateManifestPath: null }, classificationEvidence: { pageCount: 110, isScanned: false, overallScore: 83, grade: 'B', blockerFamilyCount: null, blockingFindingCount: null, manualOnlyFailureModeCount: null, autoRunnableOpportunityCount: null, topBlockingResidualFamilyIds: [], blockingFindingKeys: ['pdfua.figure_alt_or_artifact', 'pdfua.logical_structure'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
      makeRow({ publicationId: 'stable', currentCorpusStatus: 'remediated_fail', cohortLabel: 'long_report', statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.classified.json', verificationClassification: 'hard_fail', verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: null, outcomeStatus: null, latestReportPath: null, candidateManifestPath: null } }),
    ])

    const forensics = buildStage6LongReportForensicsArtifacts({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      manifestsRoot: '/tmp/repo/ICJIA-PDFs/manifests',
    })

    expect(forensics.summary.publicationIdsByDisposition.long_report_verified_pass).toEqual(['verified'])
    expect(forensics.summary.publicationIdsByDisposition.long_report_processing_retry).toEqual(['retry'])
    expect(forensics.summary.publicationIdsByDisposition.long_report_mixed_residual).toEqual(['mixed'])
    expect(forensics.summary.publicationIdsByDisposition.long_report_stable_hard_fail).toEqual(['stable'])
  })

  it('selects only unresolved long-report rows into the active wave', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'verified', currentCorpusStatus: 'verified_pass', cohortLabel: 'long_report', promotionTruth: { promotionStatus: 'verified_pass', ledgerRowPresent: true, stagedReplacementPath: '/tmp/verified.pdf', replacementChecksumSha256: 'abc', verificationPassed: true } }),
      makeRow({ publicationId: 'stable', currentCorpusStatus: 'remediated_fail', cohortLabel: 'long_report' }),
      makeRow({ publicationId: 'retry', currentCorpusStatus: 'processing_error', cohortLabel: 'long_report' }),
      makeRow({ publicationId: 'mixed', currentCorpusStatus: 'remediated_fail', cohortLabel: 'long_report' }),
    ])
    const forensicsRows = [
      { publicationId: 'verified', publicationTitle: 'verified', currentCorpusStatus: 'verified_pass', currentCohortLabel: 'long_report', forensicsDisposition: 'long_report_verified_pass', blockingFindingKeys: [], reportFindingKeys: [], reasonCodes: [], latestReportPath: null, notes: [] },
      { publicationId: 'stable', publicationTitle: 'stable', currentCorpusStatus: 'remediated_fail', currentCohortLabel: 'long_report', forensicsDisposition: 'long_report_stable_hard_fail', blockingFindingKeys: [], reportFindingKeys: [], reasonCodes: [], latestReportPath: null, notes: [] },
      { publicationId: 'retry', publicationTitle: 'retry', currentCorpusStatus: 'processing_error', currentCohortLabel: 'long_report', forensicsDisposition: 'long_report_processing_retry', blockingFindingKeys: [], reportFindingKeys: [], reasonCodes: [], latestReportPath: null, notes: [] },
      { publicationId: 'mixed', publicationTitle: 'mixed', currentCorpusStatus: 'remediated_fail', currentCohortLabel: 'long_report', forensicsDisposition: 'long_report_mixed_residual', blockingFindingKeys: [], reportFindingKeys: [], reasonCodes: [], latestReportPath: null, notes: [] },
    ] as const

    const { wave } = buildStage6LongReportWaveArtifacts({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      manifestsRoot: '/tmp/repo/ICJIA-PDFs/manifests',
      maxCandidates: 4,
      forensicsRows: [...forensicsRows],
    })

    expect(wave.selectedPublicationIds).toEqual(['retry', 'mixed'])
    expect(wave.skippedRows.find(row => row.publicationId === 'stable')?.skipReasons).toContain('stage6:stable_hard_fail_not_selected')
    expect(wave.skippedRows.find(row => row.publicationId === 'verified')?.skipReasons).toContain('already_verified_pass')
  })

  it('classifies never-remediated hard-fail rows with report findings as remediation candidates', () => {
    const baseEvidence = { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present' as const, verificationManifestPath: '/tmp/verification.classified.json', verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: null, candidateManifestPath: null }
    const realReportPath = '/home/hendo420/pdfaf/ICJIA-PDFs/reports/test-runs/ready-verification/local-staged/1988-1989_Biennial_Report.pdf.json'
    const artifacts = makeArtifacts([
      // hard_fail + outcomeStatus: null + report has findings → remediation_candidate
      makeRow({ publicationId: 'candidate', currentCorpusStatus: 'remediated_fail', cohortLabel: 'long_report', statusEvidence: { ...baseEvidence, verificationClassification: 'hard_fail', outcomeStatus: null, latestReportPath: realReportPath } }),
      // hard_fail + outcomeStatus set → stable_hard_fail (has a real outcome, not a candidate)
      makeRow({ publicationId: 'post-outcome', currentCorpusStatus: 'remediated_fail', cohortLabel: 'long_report', statusEvidence: { ...baseEvidence, verificationClassification: 'hard_fail', outcomeStatus: 'failed_after_remediation', latestReportPath: realReportPath } }),
    ])

    const forensics = buildStage6LongReportForensicsArtifacts({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      manifestsRoot: '/tmp/repo/ICJIA-PDFs/manifests',
    })

    expect(forensics.summary.publicationIdsByDisposition.long_report_remediation_candidate).toEqual(['candidate'])
    expect(forensics.summary.publicationIdsByDisposition.long_report_stable_hard_fail).toEqual(['post-outcome'])
  })

  it('selects long_report_remediation_candidate rows into the active wave', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'candidate', currentCorpusStatus: 'remediated_fail', cohortLabel: 'long_report' }),
      makeRow({ publicationId: 'stable', currentCorpusStatus: 'remediated_fail', cohortLabel: 'long_report' }),
    ])
    const forensicsRows = [
      { publicationId: 'candidate', publicationTitle: 'candidate', currentCorpusStatus: 'remediated_fail', currentCohortLabel: 'long_report', forensicsDisposition: 'long_report_remediation_candidate', blockingFindingKeys: [], reportFindingKeys: ['pdfua.figure_alt_quality'], reasonCodes: [], latestReportPath: null, notes: [] },
      { publicationId: 'stable', publicationTitle: 'stable', currentCorpusStatus: 'remediated_fail', currentCohortLabel: 'long_report', forensicsDisposition: 'long_report_stable_hard_fail', blockingFindingKeys: [], reportFindingKeys: [], reasonCodes: [], latestReportPath: null, notes: [] },
    ] as const

    const { wave } = buildStage6LongReportWaveArtifacts({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      manifestsRoot: '/tmp/repo/ICJIA-PDFs/manifests',
      maxCandidates: 4,
      forensicsRows: [...forensicsRows],
    })

    expect(wave.selectedPublicationIds).toContain('candidate')
    expect(wave.selectedPublicationIds).not.toContain('stable')
    expect(wave.skippedRows.find(row => row.publicationId === 'stable')?.skipReasons).toContain('stage6:stable_hard_fail_not_selected')
  })

  it('reports the long-report benchmark lead case in throughput', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'verified', currentCorpusStatus: 'verified_pass', cohortLabel: 'long_report', promotionTruth: { promotionStatus: 'verified_pass', ledgerRowPresent: true, stagedReplacementPath: '/tmp/verified.pdf', replacementChecksumSha256: 'abc', verificationPassed: true } }),
      makeRow({ publicationId: 'retry', currentCorpusStatus: 'processing_error', cohortLabel: 'long_report' }),
    ])
    const wave = {
      generatedAt: '2026-04-01T00:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      waveName: 'stage6-long-report-wave',
      cohortLabel: 'long_report',
      maxCandidates: 4,
      totals: { eligibleRows: 1, selectedRows: 1, skippedRows: 1, pendingRows: 0 },
      selectedPublicationIds: ['retry'],
      pendingPublicationIds: [],
      candidates: [],
      skippedRows: [],
    } as any
    const forensicsRows = [
      { publicationId: 'verified', publicationTitle: 'verified', currentCorpusStatus: 'verified_pass', currentCohortLabel: 'long_report', forensicsDisposition: 'long_report_verified_pass', blockingFindingKeys: [], reportFindingKeys: [], reasonCodes: [], latestReportPath: null, notes: [] },
      { publicationId: 'retry', publicationTitle: 'retry', currentCorpusStatus: 'processing_error', currentCohortLabel: 'long_report', forensicsDisposition: 'long_report_processing_retry', blockingFindingKeys: [], reportFindingKeys: [], reasonCodes: [], latestReportPath: null, notes: [] },
    ] as any

    const summary = buildStage6LongReportThroughputSummary({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      manifestsRoot: '/home/hendo420/pdfaf/ICJIA-PDFs/manifests',
      waveManifestPath: '/tmp/repo/ICJIA-PDFs/manifests/stage6-long-report-wave.json',
      wave,
      waveOutcomesPath: '/tmp/repo/ICJIA-PDFs/manifests/stage6-long-report-wave.outcomes.json',
      outcomes: { outcomes: [{ publicationId: 'retry', status: 'processing_error' }] },
      forensicsManifestPath: '/tmp/repo/ICJIA-PDFs/manifests/stage6-long-report-forensics.json',
      forensicsRows,
    })

    expect(summary.totals.totalLongReportRows).toBe(2)
    expect(summary.rows.processingRetryPublicationIds).toEqual(['retry'])
    expect(summary.benchmarkLeadCase?.category).toBe('long_report')
  })
})
