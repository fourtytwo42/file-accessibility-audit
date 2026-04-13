import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildStage5FontForensicsArtifacts,
  buildStage5FontThroughputSummary,
  buildStage5FontWaveArtifacts,
} from '../services/fontWaveStage5.js'
import type { CorpusControlPlaneArtifacts, CorpusControlPlaneRow } from '../services/corpusControlPlane.js'

function emptyStatusCounts() {
  return { verified_pass: 0, discovered: 0, analyzed: 0, queued_for_remediation: 0, remediated_fail: 0, processing_error: 0, deferred_manual: 0, staged_for_replacement: 0, replaced_remote: 0 }
}

function writeReport(filePath: string, findings: Array<{ key: string; blocking?: boolean; count?: number; evidence?: string[] }>): void {
  fs.writeFileSync(filePath, JSON.stringify({
    result: { localStandards: { findings } },
    gate: {
      passed: false,
      blockingLocalFindingKeys: findings.filter(finding => finding.blocking).map(finding => finding.key),
      unresolvedCategoryLabels: ['Text Extractability'],
      criticalManualReviewFlagCodes: [],
      reasons: [],
    },
  }))
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
    classificationEvidence: { pageCount: 4, isScanned: false, overallScore: 84, grade: 'B', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: ['pdfua.font_unicode'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] },
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
        byStorageKind: { legacy_archive: rows.length },
        statusByCohort,
        verifiedPassRowsFromLedger: 0,
        remainingRowsExcludingVerifiedPass: rows.filter(row => row.currentCorpusStatus !== 'verified_pass').length,
      },
      rows,
    },
    byCohort: {
      generatedAt: '2026-04-01T00:00:00.000Z',
      cohorts: {
        short_high_likelihood: { totalRows: byCohortLabel.short_high_likelihood, byCurrentCorpusStatus: statusByCohort.short_high_likelihood, samplePublicationIds: [] },
        figure_heavy: { totalRows: byCohortLabel.figure_heavy, byCurrentCorpusStatus: statusByCohort.figure_heavy, samplePublicationIds: [] },
        structure_heavy: { totalRows: byCohortLabel.structure_heavy, byCurrentCorpusStatus: statusByCohort.structure_heavy, samplePublicationIds: [] },
        font_heavy: { totalRows: byCohortLabel.font_heavy, byCurrentCorpusStatus: statusByCohort.font_heavy, samplePublicationIds: [] },
        long_report: { totalRows: byCohortLabel.long_report, byCurrentCorpusStatus: statusByCohort.long_report, samplePublicationIds: [] },
        manual_tail: { totalRows: byCohortLabel.manual_tail, byCurrentCorpusStatus: statusByCohort.manual_tail, samplePublicationIds: [] },
      },
    },
    canaries: { generatedAt: '2026-04-01T00:00:00.000Z', summary: { totalCanaries: 0, matchedPublicationIds: 0, unmatchedCanaries: 0, byCohortLabel }, rows: [] },
  }
}

describe('font wave Stage 5', () => {
  it('classifies font-heavy rows into concrete Stage 5 dispositions from latest reports', () => {
    const manifestsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-font-'))
    const embeddedReport = path.join(manifestsRoot, 'embedded.json')
    const unicodeReport = path.join(manifestsRoot, 'unicode.json')
    const type1Report = path.join(manifestsRoot, 'type1.json')
    writeReport(embeddedReport, [
      { key: 'pdfua.font_embedding', blocking: true, count: 2, evidence: ['Missing embedded font programs.'] },
      { key: 'pdfua.font_unicode', blocking: true, count: 2, evidence: ['Missing ToUnicode maps.'] },
    ])
    writeReport(unicodeReport, [
      { key: 'pdfua.font_unicode', blocking: true, count: 4, evidence: ['Missing ToUnicode maps.'] },
    ])
    writeReport(type1Report, [
      { key: 'pdfua.type1_unicode', blocking: true, count: 1, evidence: ['Legacy Type1 custom encoding differences remain unresolved.'] },
      { key: 'pdfua.font_unicode', blocking: true, count: 1, evidence: ['Missing ToUnicode maps.'] },
    ])

    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'embedded', currentCorpusStatus: 'remediated_fail', cohortLabel: 'font_heavy', statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: null, outcomeStatus: null, latestReportPath: embeddedReport, candidateManifestPath: null }, classificationEvidence: { pageCount: 8, isScanned: false, overallScore: 75, grade: 'C', blockerFamilyCount: 1, blockingFindingCount: 2, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: ['pdfua.font_embedding', 'pdfua.font_unicode'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
      makeRow({ publicationId: 'unicode', currentCorpusStatus: 'remediated_fail', cohortLabel: 'font_heavy', statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: null, outcomeStatus: null, latestReportPath: unicodeReport, candidateManifestPath: null } }),
      makeRow({ publicationId: 'type1', currentCorpusStatus: 'remediated_fail', cohortLabel: 'font_heavy', statusEvidence: { sourceManifestPath: '/tmp/replacement-map.json', sourceStatus: 'replacement_map_present', verificationManifestPath: '/tmp/verification.json', verificationClassification: null, verificationTimestamp: null, verificationReportPath: null, outcomeManifestPath: null, outcomeStatus: null, latestReportPath: type1Report, candidateManifestPath: null }, classificationEvidence: { pageCount: 2, isScanned: false, overallScore: 71, grade: 'C', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: ['pdfua.type1_unicode', 'pdfua.font_unicode'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
    ])

    const forensics = buildStage5FontForensicsArtifacts({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      manifestsRoot,
    })

    expect(forensics.summary.publicationIdsByDisposition.embedded_font_repairable).toEqual(['embedded'])
    expect(forensics.summary.publicationIdsByDisposition.deterministic_unicode_map_repair_available).toEqual(['unicode'])
    expect(forensics.summary.publicationIdsByDisposition.type1_unicode_fallback_candidate).toEqual(['type1'])
    expect(forensics.summary.stillUnclassifiedPublicationIds).toEqual([])
  })

  it('selects only repairable font-heavy rows and prioritizes embed before unicode', () => {
    const manifestsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-font-wave-'))
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'manual', currentCorpusStatus: 'remediated_fail', cohortLabel: 'font_heavy' }),
      makeRow({ publicationId: 'retry', currentCorpusStatus: 'processing_error', cohortLabel: 'font_heavy' }),
      makeRow({ publicationId: 'unicode-a', currentCorpusStatus: 'remediated_fail', cohortLabel: 'font_heavy', classificationEvidence: { pageCount: 1, isScanned: false, overallScore: 84, grade: 'B', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: ['pdfua.font_unicode'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
      makeRow({ publicationId: 'embedded', currentCorpusStatus: 'remediated_fail', cohortLabel: 'font_heavy', classificationEvidence: { pageCount: 10, isScanned: false, overallScore: 70, grade: 'C', blockerFamilyCount: 1, blockingFindingCount: 2, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: ['pdfua.font_embedding', 'pdfua.font_unicode'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
      makeRow({ publicationId: 'unicode-b', currentCorpusStatus: 'remediated_fail', cohortLabel: 'font_heavy', classificationEvidence: { pageCount: 3, isScanned: false, overallScore: 82, grade: 'B', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: ['pdfua.font_unicode'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
    ])
    const forensicsRows = [
      { publicationId: 'manual', publicationTitle: 'manual', currentCorpusStatus: 'remediated_fail', currentCohortLabel: 'font_heavy', forensicsDisposition: 'font_unicode_manual_residual', blockingFindingKeys: [], reportFindingKeys: [], reasonCodes: [], latestReportPath: null, fontUnicodeCount: 0, fontEmbeddingCount: 0, type1UnicodeCount: 0, cidsetConsistencyCount: 0, recommendedRepairOrder: [], notes: [] },
      { publicationId: 'retry', publicationTitle: 'retry', currentCorpusStatus: 'processing_error', currentCohortLabel: 'font_heavy', forensicsDisposition: 'font_processing_error_retry', blockingFindingKeys: ['pdfua.font_unicode'], reportFindingKeys: ['pdfua.font_unicode'], reasonCodes: [], latestReportPath: null, fontUnicodeCount: 4, fontEmbeddingCount: 0, type1UnicodeCount: 0, cidsetConsistencyCount: 0, recommendedRepairOrder: ['repair_font_unicode_maps'], notes: [] },
      { publicationId: 'unicode-a', publicationTitle: 'unicode-a', currentCorpusStatus: 'remediated_fail', currentCohortLabel: 'font_heavy', forensicsDisposition: 'deterministic_unicode_map_repair_available', blockingFindingKeys: ['pdfua.font_unicode'], reportFindingKeys: ['pdfua.font_unicode'], reasonCodes: [], latestReportPath: null, fontUnicodeCount: 4, fontEmbeddingCount: 0, type1UnicodeCount: 0, cidsetConsistencyCount: 0, recommendedRepairOrder: ['repair_font_unicode_maps'], notes: [] },
      { publicationId: 'embedded', publicationTitle: 'embedded', currentCorpusStatus: 'remediated_fail', currentCohortLabel: 'font_heavy', forensicsDisposition: 'embedded_font_repairable', blockingFindingKeys: ['pdfua.font_embedding', 'pdfua.font_unicode'], reportFindingKeys: ['pdfua.font_embedding', 'pdfua.font_unicode'], reasonCodes: [], latestReportPath: null, fontUnicodeCount: 2, fontEmbeddingCount: 2, type1UnicodeCount: 0, cidsetConsistencyCount: 0, recommendedRepairOrder: ['embed_missing_fonts_in_place', 'repair_font_unicode_maps', 'repair_type1_font_unicode_maps'], notes: [] },
      { publicationId: 'unicode-b', publicationTitle: 'unicode-b', currentCorpusStatus: 'remediated_fail', currentCohortLabel: 'font_heavy', forensicsDisposition: 'deterministic_unicode_map_repair_available', blockingFindingKeys: ['pdfua.font_unicode'], reportFindingKeys: ['pdfua.font_unicode'], reasonCodes: [], latestReportPath: null, fontUnicodeCount: 2, fontEmbeddingCount: 0, type1UnicodeCount: 0, cidsetConsistencyCount: 0, recommendedRepairOrder: ['repair_font_unicode_maps'], notes: [] },
    ] as any

    const { wave } = buildStage5FontWaveArtifacts({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      manifestsRoot,
      maxCandidates: 3,
      forensicsRows,
    })

    expect(wave.selectedPublicationIds).toEqual(['embedded', 'unicode-b', 'unicode-a'])
    expect(wave.skippedRows.find(row => row.publicationId === 'manual')?.skipReasons).toContain('stage5:manual_residual_not_selected')
    expect(wave.skippedRows.find(row => row.publicationId === 'retry')?.skipReasons).toContain('stage5:processing_retry_not_selected')
  })

  it('reports Stage 5 cohort truth in the throughput summary', () => {
    const artifacts = makeArtifacts([
      makeRow({ publicationId: 'verified', currentCorpusStatus: 'verified_pass', cohortLabel: 'font_heavy', promotionTruth: { promotionStatus: 'verified_pass', ledgerRowPresent: true, stagedReplacementPath: '/tmp/verified.pdf', replacementChecksumSha256: 'abc', verificationPassed: true } }),
      makeRow({ publicationId: 'unicode', currentCorpusStatus: 'remediated_fail', cohortLabel: 'font_heavy' }),
      makeRow({ publicationId: 'type1', currentCorpusStatus: 'processing_error', cohortLabel: 'font_heavy', classificationEvidence: { pageCount: 2, isScanned: false, overallScore: 60, grade: 'D', blockerFamilyCount: 1, blockingFindingCount: 1, manualOnlyFailureModeCount: 0, autoRunnableOpportunityCount: 0, topBlockingResidualFamilyIds: [], blockingFindingKeys: ['pdfua.type1_unicode'], autoRunnableOpportunityKeys: [], manualOnlyFailureModeKeys: [] } }),
    ])
    const wave = {
      generatedAt: '2026-04-01T00:00:00.000Z',
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      waveName: 'stage5-font-wave',
      cohortLabel: 'font_heavy',
      maxCandidates: 8,
      totals: { eligibleRows: 2, selectedRows: 2, skippedRows: 1, pendingRows: 0 },
      selectedPublicationIds: ['unicode', 'type1'],
      pendingPublicationIds: [],
      candidates: [],
      skippedRows: [],
    } as any
    const forensicsRows = [
      { publicationId: 'unicode', publicationTitle: 'unicode', currentCorpusStatus: 'remediated_fail', currentCohortLabel: 'font_heavy', forensicsDisposition: 'deterministic_unicode_map_repair_available', blockingFindingKeys: ['pdfua.font_unicode'], reportFindingKeys: ['pdfua.font_unicode'], reasonCodes: [], latestReportPath: null, fontUnicodeCount: 4, fontEmbeddingCount: 0, type1UnicodeCount: 0, cidsetConsistencyCount: 0, recommendedRepairOrder: ['repair_font_unicode_maps'], notes: [] },
      { publicationId: 'type1', publicationTitle: 'type1', currentCorpusStatus: 'processing_error', currentCohortLabel: 'font_heavy', forensicsDisposition: 'type1_unicode_fallback_candidate', blockingFindingKeys: ['pdfua.type1_unicode'], reportFindingKeys: ['pdfua.type1_unicode'], reasonCodes: [], latestReportPath: null, fontUnicodeCount: 0, fontEmbeddingCount: 0, type1UnicodeCount: 1, cidsetConsistencyCount: 0, recommendedRepairOrder: ['repair_font_unicode_maps', 'repair_type1_font_unicode_maps'], notes: [] },
    ] as any

    const summary = buildStage5FontThroughputSummary({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      waveManifestPath: '/tmp/repo/ICJIA-PDFs/manifests/stage5-font-wave.json',
      wave,
      waveOutcomesPath: '/tmp/repo/ICJIA-PDFs/manifests/stage5-font-wave.outcomes.json',
      outcomes: { outcomes: [{ publicationId: 'type1', status: 'processing_error' }, { publicationId: 'unicode', status: 'failed_after_remediation' }] },
      forensicsManifestPath: '/tmp/repo/ICJIA-PDFs/manifests/stage5-font-forensics.json',
      forensicsRows,
    })

    expect(summary.totals.totalFontHeavyRows).toBe(3)
    expect(summary.rows.activeWaveSelectedPublicationIds).toEqual(['unicode', 'type1'])
    expect(summary.rows.deterministicUnicodeRepairPublicationIds).toEqual(['unicode'])
    expect(summary.rows.type1FallbackPublicationIds).toEqual(['type1'])
    expect(summary.rows.stillUnclassifiedPublicationIds).toEqual([])
  })

  it('routes exhausted unicode-only post-run rows to a terminal survivor bucket', () => {
    const manifestsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-font-terminal-'))
    const terminalReport = path.join(manifestsRoot, 'terminal.remediation.json')
    fs.writeFileSync(terminalReport, JSON.stringify({
      candidate: {
        plannerEvidence: {
          attemptedKeys: ['repair_font_unicode_maps:document'],
          noEffectKeys: ['repair_font_unicode_maps:document'],
        },
      },
      gate: {
        passed: false,
        blockingLocalFindingKeys: ['pdfua.font_unicode'],
        unresolvedCategoryLabels: ['Text Extractability'],
        criticalManualReviewFlagCodes: [],
        reasons: [],
      },
      result: {
        localStandards: {
          findings: [
            { key: 'pdfua.font_unicode', blocking: true, count: 4, evidence: ['Missing ToUnicode maps.'] },
          ],
        },
      },
    }))

    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'terminal',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'font_heavy',
        statusEvidence: {
          sourceManifestPath: '/tmp/replacement-map.json',
          sourceStatus: 'replacement_map_present',
          verificationManifestPath: '/tmp/verification.json',
          verificationClassification: null,
          verificationTimestamp: null,
          verificationReportPath: null,
          outcomeManifestPath: '/tmp/stage5-font-wave.outcomes.json',
          outcomeStatus: 'failed_after_remediation',
          latestReportPath: terminalReport,
          candidateManifestPath: null,
        },
      }),
    ])

    const forensics = buildStage5FontForensicsArtifacts({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      manifestsRoot,
    })

    expect(forensics.summary.publicationIdsByDisposition.font_unicode_terminal_survivor).toEqual(['terminal'])

    const { wave } = buildStage5FontWaveArtifacts({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      manifestsRoot,
      maxCandidates: 8,
      forensicsRows: forensics.document.rows,
    })

    expect(wave.selectedPublicationIds).toEqual([])
    expect(wave.skippedRows.find(row => row.publicationId === 'terminal')?.skipReasons).toContain('stage5:terminal_survivor_not_selected')
  })

  it('routes failed pass-candidates with unicode-only hard-fail verification to a terminal survivor bucket', () => {
    const manifestsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-font-verified-hardfail-'))
    const verificationHardFailReport = path.join(manifestsRoot, 'verified-hardfail.remediation.json')
    writeReport(verificationHardFailReport, [
      { key: 'pdfua.font_unicode', blocking: true, count: 1, evidence: ['Missing ToUnicode maps.'] },
    ])

    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'verified-hardfail',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'font_heavy',
        statusEvidence: {
          sourceManifestPath: '/tmp/replacement-map.json',
          sourceStatus: 'replacement_map_present',
          verificationManifestPath: '/tmp/verification.classified.json',
          verificationClassification: 'hard_fail',
          verificationTimestamp: null,
          verificationReportPath: '/tmp/ready-verification.json',
          outcomeManifestPath: '/tmp/stage5-font-wave.outcomes.json',
          outcomeStatus: 'remediated_pass_candidate',
          latestReportPath: verificationHardFailReport,
          candidateManifestPath: null,
        },
      }),
    ])

    const forensics = buildStage5FontForensicsArtifacts({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      manifestsRoot,
    })

    expect(forensics.summary.publicationIdsByDisposition.font_unicode_terminal_survivor).toEqual(['verified-hardfail'])
  })

  it('routes processing errors into a bounded Stage 5 retry bucket', () => {
    const manifestsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-font-retry-'))
    const retryReport = path.join(manifestsRoot, 'retry.remediation.json')
    writeReport(retryReport, [
      { key: 'pdfua.font_unicode', blocking: true, count: 4, evidence: ['Missing ToUnicode maps.'] },
    ])

    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'retry',
        currentCorpusStatus: 'processing_error',
        cohortLabel: 'font_heavy',
        statusEvidence: {
          sourceManifestPath: '/tmp/replacement-map.json',
          sourceStatus: 'replacement_map_present',
          verificationManifestPath: '/tmp/verification.json',
          verificationClassification: null,
          verificationTimestamp: null,
          verificationReportPath: null,
          outcomeManifestPath: '/tmp/stage5-font-wave.outcomes.json',
          outcomeStatus: 'processing_error',
          latestReportPath: retryReport,
          candidateManifestPath: null,
        },
      }),
    ])

    const forensics = buildStage5FontForensicsArtifacts({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      manifestsRoot,
    })

    expect(forensics.summary.publicationIdsByDisposition.font_processing_error_retry).toEqual(['retry'])
  })

  it('routes exhausted runtime-only unicode rows into a manual residual bucket', () => {
    const manifestsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-font-runtime-manual-'))
    const retryReport = path.join(manifestsRoot, 'retry.remediation.json')
    writeReport(retryReport, [
      { key: 'pdfua.font_unicode', blocking: true, count: 4, evidence: ['Missing ToUnicode maps.'] },
    ])
    const outcomePath = path.join(manifestsRoot, 'stage5-font-wave.outcomes.json')
    fs.writeFileSync(outcomePath, JSON.stringify({
      outcomes: [
        {
          publicationId: 'runtime-manual',
          status: 'processing_error',
          deferred: {
            reasonCode: 'excessive_runtime_loop',
            skipNextBatch: true,
            notes: 'Processing exceeded runtime limit of 120000ms',
          },
        },
      ],
    }))

    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'runtime-manual',
        currentCorpusStatus: 'remediated_fail',
        cohortLabel: 'font_heavy',
        statusEvidence: {
          sourceManifestPath: '/tmp/replacement-map.json',
          sourceStatus: 'replacement_map_present',
          verificationManifestPath: '/tmp/verification.json',
          verificationClassification: null,
          verificationTimestamp: null,
          verificationReportPath: null,
          outcomeManifestPath: outcomePath,
          outcomeStatus: 'processing_error',
          latestReportPath: retryReport,
          candidateManifestPath: null,
        },
      }),
    ])

    const forensics = buildStage5FontForensicsArtifacts({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      manifestsRoot,
    })

    expect(forensics.summary.publicationIdsByDisposition.font_unicode_manual_residual).toEqual(['runtime-manual'])
  })

  it('keeps verified-pass rows out of the active Stage 5 wave', () => {
    const manifestsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage5-font-verified-'))
    const artifacts = makeArtifacts([
      makeRow({
        publicationId: 'verified',
        currentCorpusStatus: 'verified_pass',
        cohortLabel: 'font_heavy',
        promotionTruth: {
          promotionStatus: 'verified_pass',
          ledgerRowPresent: true,
          stagedReplacementPath: '/tmp/verified.pdf',
          replacementChecksumSha256: 'abc',
          verificationPassed: true,
        },
      }),
      makeRow({ publicationId: 'unicode', currentCorpusStatus: 'remediated_fail', cohortLabel: 'font_heavy' }),
    ])

    const forensicsRows = [
      { publicationId: 'verified', publicationTitle: 'verified', currentCorpusStatus: 'verified_pass', currentCohortLabel: 'font_heavy', forensicsDisposition: 'deterministic_unicode_map_repair_available', blockingFindingKeys: ['pdfua.font_unicode'], reportFindingKeys: ['pdfua.font_unicode'], reasonCodes: [], latestReportPath: null, fontUnicodeCount: 1, fontEmbeddingCount: 0, type1UnicodeCount: 0, cidsetConsistencyCount: 0, recommendedRepairOrder: ['repair_font_unicode_maps'], notes: [] },
      { publicationId: 'unicode', publicationTitle: 'unicode', currentCorpusStatus: 'remediated_fail', currentCohortLabel: 'font_heavy', forensicsDisposition: 'deterministic_unicode_map_repair_available', blockingFindingKeys: ['pdfua.font_unicode'], reportFindingKeys: ['pdfua.font_unicode'], reasonCodes: [], latestReportPath: null, fontUnicodeCount: 1, fontEmbeddingCount: 0, type1UnicodeCount: 0, cidsetConsistencyCount: 0, recommendedRepairOrder: ['repair_font_unicode_maps'], notes: [] },
    ] as any

    const { wave } = buildStage5FontWaveArtifacts({
      artifacts,
      sourceControlPlanePath: '/tmp/repo/ICJIA-PDFs/manifests/corpus-control-plane.json',
      sourceControlPlaneGeneratedAt: '2026-04-01T00:00:00.000Z',
      manifestsRoot,
      maxCandidates: 8,
      forensicsRows,
    })

    expect(wave.selectedPublicationIds).toEqual(['unicode'])
    expect(wave.skippedRows.find(row => row.publicationId === 'verified')?.skipReasons).toContain('already_verified_pass')
  })
})
