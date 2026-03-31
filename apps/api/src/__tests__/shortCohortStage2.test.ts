import { describe, expect, it } from 'vitest'
import {
  applyStage2ShortCohortReclassification,
  buildStage2ShortCohortThroughputSummary,
  buildStage2ShortCohortWaveArtifacts,
  type Stage2ShortCohortWaveDocument,
} from '../services/shortCohortStage2.js'
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
  return {
    document: {
      generatedAt: '2026-03-30T00:00:00.000Z',
      summary: {
        totalRows: rows.length,
        byCurrentCorpusStatus: emptyStatusCounts(),
        byCohortLabel: { short_high_likelihood: 0, figure_heavy: 0, structure_heavy: 0, font_heavy: 0, long_report: 0, manual_tail: 0 },
        byStorageKind: { legacy_archive: rows.length },
        statusByCohort: { short_high_likelihood: emptyStatusCounts(), figure_heavy: emptyStatusCounts(), structure_heavy: emptyStatusCounts(), font_heavy: emptyStatusCounts(), long_report: emptyStatusCounts(), manual_tail: emptyStatusCounts() },
        verifiedPassRowsFromLedger: 0,
        remainingRowsExcludingVerifiedPass: rows.length,
      },
      rows,
    },
    byCohort: {
      generatedAt: '2026-03-30T00:00:00.000Z',
      cohorts: {
        short_high_likelihood: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] },
        figure_heavy: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] },
        structure_heavy: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] },
        font_heavy: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] },
        long_report: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] },
        manual_tail: { totalRows: 0, byCurrentCorpusStatus: emptyStatusCounts(), samplePublicationIds: [] },
      },
    },
    canaries: { generatedAt: '2026-03-30T00:00:00.000Z', summary: { totalCanaries: 0, matchedPublicationIds: 0, unmatchedCanaries: 0, byCohortLabel: { short_high_likelihood: 0, figure_heavy: 0, structure_heavy: 0, font_heavy: 0, long_report: 0, manual_tail: 0 } }, rows: [] },
  }
}

function makeSources(): CorpusControlPlaneSources {
  return {
    repoRoot: '/tmp/repo', manifestsRoot: '/tmp/repo/ICJIA-PDFs/manifests', replacementMapPath: '/tmp/repo/ICJIA-PDFs/manifests/publication-pdf-replacement-map.json', verificationPath: null, verificationClassifiedPath: null, promotionLedgerPath: null, regressionBenchmarkPath: null, replacementMap: [
      { publicationId: 'processing', title: 'Court System', slug: 'court-system', fileUrl: null, fileHost: null, storageKind: 'legacy_archive', replaceVia: null, serverHost: '143.244.146.43', sshTarget: null, remotePath: '/remote/processing.pdf', remoteDir: '/remote', localWorkingPath: null, localBackupPath: null, localServerMirrorPath: null, expectedPresence: 'present', notes: null, checksumState: { localCurrentFilePath: '/cache/processing.pdf' } },
      { publicationId: 'annual', title: 'ICJIA 1998 Annual Report', slug: 'annual', fileUrl: null, fileHost: null, storageKind: 'legacy_archive', replaceVia: null, serverHost: '143.244.146.43', sshTarget: null, remotePath: '/remote/annual.pdf', remoteDir: '/remote', localWorkingPath: null, localBackupPath: null, localServerMirrorPath: null, expectedPresence: 'present', notes: null, checksumState: { localCurrentFilePath: '/cache/annual.pdf' } },
    ], verificationResults: [], verificationRows: [], classifiedRows: [], promotionLedgerRows: [], outcomeManifests: [], candidateManifests: [], regressionBenchmarkOutcomes: [ { name: 'Court System', filePath: '/cache/processing.pdf', category: 'structure', terminalState: 'processing_error' } ],
  } as unknown as CorpusControlPlaneSources
}

describe('short cohort Stage 2 reclassification', () => {
  it('reclassifies operational retry rows when the document is clearly not a short-profile fit', () => {
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'operational-long',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'short_high_likelihood',
        reasonCodes: ['stage2:operational_retry_after_tempdir_failure'],
        classificationEvidence: {
          pageCount: 143,
          isScanned: true,
          overallScore: 9,
          grade: 'F',
          blockerFamilyCount: 0,
          blockingFindingCount: 0,
          manualOnlyFailureModeCount: 0,
          autoRunnableOpportunityCount: 0,
          topBlockingResidualFamilyIds: [],
          blockingFindingKeys: [],
          autoRunnableOpportunityKeys: [],
          manualOnlyFailureModeKeys: [],
        },
      }),
    ])
    const nextArtifacts = applyStage2ShortCohortReclassification(artifacts, makeSources())
    expect(nextArtifacts.document.rows.find(row => row.publicationId === 'operational-long')?.cohortLabel).toBe('long_report')
  })

  it('reclassifies benchmarked processing errors and annual reports out of the short cohort', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'processing', currentCorpusStatus: 'processing_error', cohortLabel: 'short_high_likelihood' }),
      makeRow({ publicationId: 'annual', currentCorpusStatus: 'remediated_fail', cohortLabel: 'short_high_likelihood', title: 'ICJIA 1998 Annual Report', classificationEvidence: { pageCount: 36, isScanned: false, overallScore: 80, grade: 'C', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: [], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
    ])
    const nextArtifacts = applyStage2ShortCohortReclassification(artifacts, makeSources())
    expect(nextArtifacts.document.rows.find(row => row.publicationId === 'processing')?.cohortLabel).toBe('structure_heavy')
    expect(nextArtifacts.document.rows.find(row => row.publicationId === 'annual')?.cohortLabel).toBe('long_report')
  })
})

describe('short cohort Stage 2 wave selection', () => {
  it('drops stale pending wave rows that are no longer in the short cohort', () => {
    const fsLocal = require('fs')
    const os = require('os')
    const pathLocal = require('path')
    const manifestsRoot = fsLocal.mkdtempSync(pathLocal.join(os.tmpdir(), 'stage2-wave-'))
    fsLocal.writeFileSync(pathLocal.join(manifestsRoot, 'stage2-short-cohort-wave.json'), JSON.stringify({
      generatedAt: '2026-03-30T00:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-30T00:00:00.000Z',
      waveName: 'stage2-short-cohort-wave',
      cohortLabel: 'short_high_likelihood',
      maxCandidates: 8,
      totals: { eligibleRows: 1, selectedRows: 1, skippedRows: 0, pendingRows: 1 },
      selectedPublicationIds: ['stale'],
      pendingPublicationIds: ['stale'],
      candidates: [],
      skippedRows: [],
    }))
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'verified', currentCorpusStatus: 'verified_pass', cohortLabel: 'short_high_likelihood', promotionTruth: { promotionStatus: 'verified_pass', ledgerRowPresent: true, stagedReplacementPath: '/staged/verified.pdf', replacementChecksumSha256: 'x', verificationPassed: true } }),
    ])
    const { wave } = buildStage2ShortCohortWaveArtifacts({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-30T00:00:00.000Z',
      manifestsRoot,
      maxCandidates: 8,
    })
    expect(wave.selectedPublicationIds).toEqual([])
    expect(wave.pendingPublicationIds).toEqual([])
  })

  it('selects only non-verified short-cohort rows in the expected priority order', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'verified', currentCorpusStatus: 'verified_pass', cohortLabel: 'short_high_likelihood', promotionTruth: { promotionStatus: 'verified_pass', ledgerRowPresent: true, stagedReplacementPath: '/staged/verified.pdf', replacementChecksumSha256: 'x', verificationPassed: true } }),
      makeRow({ publicationId: 'analyzed', currentCorpusStatus: 'analyzed', cohortLabel: 'short_high_likelihood' }),
      makeRow({ publicationId: 'processing', currentCorpusStatus: 'processing_error', cohortLabel: 'short_high_likelihood', classificationEvidence: { pageCount: 2, isScanned: false, overallScore: 70, grade: 'C', blockerFamilyCount: 0, blockingFindingCount: 0, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: [], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
      makeRow({ publicationId: 'remfail', currentCorpusStatus: 'remediated_fail', cohortLabel: 'short_high_likelihood', classificationEvidence: { pageCount: 6, isScanned: false, overallScore: 88, grade: 'B', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 2, topBlockingResidualFamilyIds: [], blockingFindingKeys: [], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
    ])
    const { wave } = buildStage2ShortCohortWaveArtifacts({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-30T00:00:00.000Z',
      manifestsRoot: '/tmp/repo/ICJIA-PDFs/manifests',
      maxCandidates: 8,
    })
    expect(wave.selectedPublicationIds).toEqual(['analyzed', 'processing', 'remfail'])
    expect(wave.candidates.map(candidate => candidate.priorityTier)).toEqual(['highest', 'high', 'medium'])
  })

  it('reports verified passes and reclassifications in throughput summaries', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'verified', currentCorpusStatus: 'verified_pass', cohortLabel: 'short_high_likelihood', promotionTruth: { promotionStatus: 'verified_pass', ledgerRowPresent: true, stagedReplacementPath: '/staged/verified.pdf', replacementChecksumSha256: 'x', verificationPassed: true } }),
      makeRow({ publicationId: 'moved', currentCorpusStatus: 'remediated_fail', cohortLabel: 'structure_heavy' }),
      makeRow({ publicationId: 'remaining', currentCorpusStatus: 'remediated_fail', cohortLabel: 'short_high_likelihood' }),
    ])
    const wave: Stage2ShortCohortWaveDocument = {
      generatedAt: '2026-03-30T00:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-30T00:00:00.000Z',
      waveName: 'stage2-short-cohort-wave',
      cohortLabel: 'short_high_likelihood',
      maxCandidates: 8,
      totals: { eligibleRows: 2, selectedRows: 2, skippedRows: 0, pendingRows: 0 },
      selectedPublicationIds: ['verified', 'moved'],
      pendingPublicationIds: [],
      candidates: [],
      skippedRows: [],
    }
    const summary = buildStage2ShortCohortThroughputSummary({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-03-30T00:00:00.000Z',
      waveManifestPath: '/tmp/repo/ICJIA-PDFs/manifests/stage2-short-cohort-wave.json',
      wave,
      outcomesPath: '/tmp/repo/ICJIA-PDFs/manifests/stage2-short-cohort-wave.outcomes.json',
      outcomes: { outcomes: [ { publicationId: 'moved', status: 'failed_after_remediation' } ] },
    })
    expect(summary.totals.newlyVerifiedPassRowsFromWave).toBe(1)
    expect(summary.totals.reclassifiedOutOfCohort).toBe(1)
    expect(summary.rows.remainingPublicationIds).toEqual(['remaining'])
  })
})
