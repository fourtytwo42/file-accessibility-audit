import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCorpusControlPlaneArtifactsFromSources,
  classifyCohort,
  loadCorpusControlPlaneSources,
  validateCorpusControlPlaneArtifacts,
  type CorpusControlPlaneSources,
} from '../services/corpusControlPlane.js'

function makeSources(overrides: Partial<CorpusControlPlaneSources> = {}): CorpusControlPlaneSources {
  return {
    repoRoot: '/tmp/repo',
    manifestsRoot: '/tmp/repo/ICJIA-PDFs/manifests',
    replacementMapPath: '/tmp/repo/ICJIA-PDFs/manifests/publication-pdf-replacement-map.json',
    verificationPath: '/tmp/repo/ICJIA-PDFs/manifests/ready-to-replace-verification.json',
    verificationClassifiedPath: '/tmp/repo/ICJIA-PDFs/manifests/ready-to-replace-verification.classified.json',
    promotionLedgerPath: '/tmp/repo/ICJIA-PDFs/manifests/verified-promotion-ledger.json',
    regressionBenchmarkPath: '/tmp/repo/ICJIA-PDFs/manifests/remediation-regression-benchmark.summary.json',
    stage4PendingAnalysisPath: null,
    stage4ActiveAnalysisPath: null,
    stage4StalledAnalysisPath: null,
    stage4OverlapAnalysisPath: null,
    stage4ActiveForensicsPath: null,
    stage4HomogeneousAnalysisPath: null,
    replacementMap: [],
    verificationResults: [],
    verificationRows: [],
    classifiedRows: [],
    promotionLedgerRows: [],
    outcomeManifests: [],
    candidateManifests: [],
    regressionBenchmarkOutcomes: [],
    stage4PendingAnalysisRows: [],
    stage4ActiveAnalysisRows: [],
    stage4StalledAnalysisRows: [],
    stage4OverlapAnalysisRows: [],
    stage4ActiveForensicsRows: [],
    stage4HomogeneousAnalysisRows: [],
    ...overrides,
  }
}

describe('buildCorpusControlPlaneArtifactsFromSources', () => {
  it('lets verified ledger truth outrank verification failures and candidates', () => {
    const sources = makeSources({
      replacementMap: [{
        publicationId: '100',
        title: 'Ledger Wins',
        slug: 'ledger-wins',
        fileUrl: 'https://example.test/ledger.pdf',
        fileHost: 'example.test',
        storageKind: 'legacy_archive',
        replaceVia: 'sftp',
        serverHost: 'host-1',
        sshTarget: 'forge@host-1',
        remotePath: '/remote/ledger.pdf',
        remoteDir: '/remote',
        localWorkingPath: null,
        localBackupPath: null,
        localServerMirrorPath: null,
        expectedPresence: 'present',
        notes: null,
        checksumState: {
          checksumRecordedAt: '2026-03-30T00:00:00.000Z',
          localCurrentFilePath: '/cache/ledger.pdf',
          localCurrentFileMd5: 'abc',
        },
      }],
      verificationResults: [{
        key: 'local:/staged/ledger.pdf',
        mode: 'local_staged',
        sourcePathOrUrl: '/staged/ledger.pdf',
        filename: 'ledger.pdf',
        verifiedAt: '2026-03-30T01:00:00.000Z',
        durationMs: 1,
        passed: false,
        missing: false,
        error: null,
        summary: {
          overallScore: 72,
          grade: 'C',
          pageCount: 5,
          isScanned: false,
        },
        gate: {
          reasons: ['Final grade is C, not A.'],
          blockingLocalFindingKeys: ['pdfua.figure_alt_or_artifact'],
          unresolvedCategoryLabels: ['Alt Text on Images'],
          criticalManualReviewFlagCodes: [],
        },
        artifacts: {
          reportPath: '/reports/ledger.json',
        },
      }],
      classifiedRows: [{
        publicationId: '100',
        publicationTitle: 'Ledger Wins',
        fileUrl: 'https://example.test/ledger.pdf',
        serverHost: 'host-1',
        remotePath: '/remote/ledger.pdf',
        stagedReplacementPath: '/staged/ledger.pdf',
        sourceKind: 'batch_ready',
        sourceManifest: '/tmp/outcomes.json',
        sourceStatus: 'ready_to_replace',
        verificationKey: 'local:/staged/ledger.pdf',
        verificationPassed: false,
        verificationMissing: false,
        verificationError: null,
        classification: 'hard_fail',
      }],
      promotionLedgerRows: [{
        publicationId: '100',
        publicationTitle: 'Ledger Wins',
        sourceKind: 'batch_ready',
        sourcePathOrUrl: '/remote/ledger.pdf',
        sourceFileUrl: 'https://example.test/ledger.pdf',
        localFinalArtifactPath: '/artifacts/ledger.pdf',
        stagedReplacementPath: '/staged/ledger.pdf',
        currentSourceChecksumSha256: 'old',
        replacementChecksumSha256: 'new',
        verificationReportPath: '/reports/ledger.json',
        verificationTimestamp: '2026-03-30T01:00:00.000Z',
        verificationSummary: {
          passed: true,
          overallScore: 100,
          grade: 'A',
          pageCount: 5,
          isScanned: false,
          reasons: [],
          blockingLocalFindingKeys: [],
          unresolvedCategoryLabels: [],
          criticalManualReviewFlagCodes: [],
        },
        promotionStatus: 'verified_pass',
      }],
      outcomeManifests: [{
        path: '/tmp/outcomes.json',
        outcomes: [{
          publicationId: '100',
          status: 'processing_error',
          processedAt: '2026-03-30T00:30:00.000Z',
        }],
      }],
      candidateManifests: [{
        path: '/tmp/candidates.json',
        candidates: [{
          publicationId: '100',
          passLikelihoodScore: 99,
          priorityRank: 1,
          pageCount: 5,
          isScanned: false,
          blockerFamilyCount: 1,
          blockingFindingCount: 1,
          autoRunnableOpportunityCount: 3,
          topBlockingResidualFamilyIds: ['native_figure_convergence'],
          blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
          autoRunnableOpportunityKeys: ['set_figure_alt_text:candidate:figure:1'],
          manualOnlyFailureModeCount: 0,
        }],
      }],
    })

    const artifacts = buildCorpusControlPlaneArtifactsFromSources(sources)
    expect(artifacts.document.rows).toHaveLength(1)
    expect(artifacts.document.rows[0]).toMatchObject({
      publicationId: '100',
      currentCorpusStatus: 'verified_pass',
      promotionTruth: {
        ledgerRowPresent: true,
        promotionStatus: 'verified_pass',
      },
    })
  })

  it('classifies representative cohort families deterministically', () => {
    expect(classifyCohort({
      pageCount: 8,
      isScanned: false,
      manualOnlyFailureModeCount: 0,
      blockerFamilyIds: ['native_figure_convergence'],
      blockingFindingKeys: ['pdfua.figure_alt_or_artifact'],
      autoRunnableOpportunityCount: 10,
      expectedPresence: 'present',
    })).toBe('figure_heavy')

    expect(classifyCohort({
      pageCount: 12,
      isScanned: false,
      manualOnlyFailureModeCount: 0,
      blockerFamilyIds: ['logical_structure_marked_content'],
      blockingFindingKeys: ['category.reading_order'],
      autoRunnableOpportunityCount: 10,
      expectedPresence: 'present',
    })).toBe('structure_heavy')

    expect(classifyCohort({
      pageCount: 18,
      isScanned: false,
      manualOnlyFailureModeCount: 0,
      blockerFamilyIds: ['font_embedding_and_unicode'],
      blockingFindingKeys: ['pdfua.font_unicode'],
      autoRunnableOpportunityCount: 10,
      expectedPresence: 'present',
    })).toBe('font_heavy')

    expect(classifyCohort({
      pageCount: 80,
      isScanned: false,
      manualOnlyFailureModeCount: 0,
      blockerFamilyIds: ['metadata_normalization'],
      blockingFindingKeys: ['pdfua.display_doc_title'],
      autoRunnableOpportunityCount: 4,
      expectedPresence: 'present',
    })).toBe('long_report')

    expect(classifyCohort({
      pageCount: 6,
      isScanned: false,
      manualOnlyFailureModeCount: 0,
      blockerFamilyIds: ['metadata_normalization'],
      blockingFindingKeys: ['pdfua.display_doc_title'],
      autoRunnableOpportunityCount: 4,
      expectedPresence: 'present',
    })).toBe('short_high_likelihood')
  })

  it('marks missing-source rows as discovered and manual tail', () => {
    const sources = makeSources({
      replacementMap: [{
        publicationId: '200',
        title: 'Missing Source',
        slug: 'missing-source',
        fileUrl: 'https://example.test/missing.pdf',
        fileHost: 'example.test',
        storageKind: 'researchhub_upload',
        replaceVia: 'sftp',
        serverHost: 'host-2',
        sshTarget: 'forge@host-2',
        remotePath: '/remote/missing.pdf',
        remoteDir: '/remote',
        localWorkingPath: null,
        localBackupPath: null,
        localServerMirrorPath: null,
        expectedPresence: 'missing',
        notes: 'Known broken upload URL.',
        checksumState: {
          checksumRecordedAt: null,
          localCurrentFilePath: null,
          localCurrentFileMd5: null,
        },
      }],
    })

    const artifacts = buildCorpusControlPlaneArtifactsFromSources(sources)
    expect(artifacts.document.rows[0].currentCorpusStatus).toBe('discovered')
    expect(artifacts.document.rows[0].cohortLabel).toBe('manual_tail')
  })
})

describe('corpus control plane regression', () => {
  it('classifies title-only Stage 4 hard fails as metadata title survivors', () => {
    const sources = makeSources({
      replacementMap: [{
        publicationId: '3665',
        title: 'Title Survivor',
        slug: 'title-survivor',
        fileUrl: 'https://example.test/title.pdf',
        fileHost: 'example.test',
        storageKind: 'legacy_archive',
        replaceVia: 'sftp',
        serverHost: 'host-1',
        sshTarget: 'forge@host-1',
        remotePath: '/remote/title.pdf',
        remoteDir: '/remote',
        localWorkingPath: null,
        localBackupPath: null,
        localServerMirrorPath: null,
        expectedPresence: 'present',
        notes: null,
        checksumState: {
          checksumRecordedAt: '2026-03-31T00:00:00.000Z',
          localCurrentFilePath: '/cache/title.pdf',
          localCurrentFileMd5: 'abc',
        },
      }],
      outcomeManifests: [{
        path: '/tmp/stage4-structure-wave.outcomes.json',
        outcomes: [{
          publicationId: '3665',
          status: 'failed_after_remediation',
          processedAt: '2026-03-31T15:06:18.720Z',
          gate: {
            passed: false,
            reasons: [
              'Final grade is B, not A.',
              'Final overall score is 89, not 100.',
              'Blocking local standards findings remain: pdfua.display_doc_title',
              'Categories still below 100: Document Title & Language, PDF/UA Compliance',
            ],
            blockingLocalFindingKeys: ['pdfua.display_doc_title'],
            unresolvedCategoryLabels: ['Document Title & Language', 'PDF/UA Compliance'],
            criticalManualReviewFlagCodes: [],
          },
          final: { overallScore: 89, grade: 'B', pageCount: 4, isScanned: false },
          original: { overallScore: 21, grade: 'F', pageCount: 4, isScanned: false },
          artifacts: {
            detailedReportPath: '/reports/3665.remediation.json',
            failureReportPath: '/reports/3665.failure.json',
            stagedReplacementPath: null,
            remediatedPdfPath: '/artifacts/3665.pdf',
          },
        }],
      }],
    })

    const artifacts = buildCorpusControlPlaneArtifactsFromSources(sources)
    const row = artifacts.document.rows[0]
    expect(row.currentCorpusStatus).toBe('remediated_fail')
    expect(row.stage4StructureDiagnostics.terminalSurvivorClass).toBe('metadata_title_survivor')
    expect(row.stage4StructureDiagnostics.structureWaveBucket).toBe('metadata_navigation_residuals')
  })

  it('matches the refreshed Stage 0 baseline and validates current artifacts', () => {
    const sources = loadCorpusControlPlaneSources(path.resolve(process.cwd(), '..', '..'))
    const artifacts = buildCorpusControlPlaneArtifactsFromSources(sources)
    const validation = validateCorpusControlPlaneArtifacts(artifacts, {
      replacementMap: sources.replacementMap,
      promotionLedgerRows: sources.promotionLedgerRows,
    })

    expect(validation.ok).toBe(true)
    expect(artifacts.document.rows).toHaveLength(sources.replacementMap.length)
    expect(artifacts.document.summary.totalRows).toBe(1056)
    expect(artifacts.document.summary.verifiedPassRowsFromLedger).toBe(90)
    expect(sources.promotionLedgerRows).toHaveLength(90)
    expect(sources.classifiedRows.filter(row => row.classification === 'verified_pass')).toHaveLength(90)
    expect(sources.classifiedRows.filter(row => row.classification === 'soft_fail_advisory')).toHaveLength(2)
    expect(sources.classifiedRows.filter(row => row.classification === 'hard_fail')).toHaveLength(300)
    expect(artifacts.document.rows.every(row => !!row.currentCorpusStatus && !!row.cohortLabel)).toBe(true)
    expect(artifacts.document.rows.filter(row => row.currentCorpusStatus === 'verified_pass').every(row => row.promotionTruth.ledgerRowPresent)).toBe(true)
  })
})
