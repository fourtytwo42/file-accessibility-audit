import { describe, expect, it } from 'vitest'
import {
  buildProcessedIntakeParityArtifact,
  buildProcessedIntakeParityPairReport,
  buildProcessedIntakeParityState,
} from '../services/processedIntakeParityService.js'

function makeLiveState(overrides: any = {}): any {
  return {
    path: '/repo/example.pdf',
    filename: 'example.pdf',
    overallScore: 92,
    grade: 'B',
    blockingFindingKeys: ['pdfua.link_tagging'],
    topBlockingResidualFamilyIds: ['link_tabs_and_annotation_cleanup'],
    topResidualFamilies: [
      {
        id: 'link_tabs_and_annotation_cleanup',
        label: 'Link, tabs, and annotation cleanup',
        blocking: true,
        blockingReason: 'blocking_failure_mode:pdfua.link_tagging',
        convergenceStatus: 'preferred_tools_available',
        currentStep: 1,
        preferredAutoRunnableOpportunityKeys: [
          'repair_native_link_structure:document:document',
        ],
        evidenceSignals: ['blocking_failure_mode:pdfua.link_tagging'],
        evidenceStrength: 24,
        activeOpportunityKeys: ['repair_native_link_structure:document:document'],
      },
    ],
    autoRunnableOpportunityKeys: ['repair_native_link_structure:document:document'],
    manualOnlyFailureModeKeys: [],
    semanticSidecarState: 'unknown',
    ...overrides,
  }
}

describe('processedIntakeParityService', () => {
  it('marks a runtime state as a family-completion gap when one blocking family still has preferred tools available', () => {
    const before = buildProcessedIntakeParityState({
      path: '/repo/Processed/Before/15adult probation_1999-2008.pdf',
      filename: '15adult probation_1999-2008.pdf',
      planningProfile: makeLiveState({
        overallScore: 29,
        grade: 'F',
        blockingFindingKeys: ['pdfua.document_language'],
        topBlockingResidualFamilyIds: ['metadata_normalization'],
        topResidualFamilies: [{
          id: 'metadata_normalization',
          label: 'Metadata normalization',
          blocking: true,
          blockingReason: 'blocking_failure_mode:pdfua.document_language',
          convergenceStatus: 'preferred_tools_available',
          currentStep: 1,
          preferredAutoRunnableOpportunityKeys: ['normalize_document_metadata:document:document'],
          evidenceSignals: ['blocking_failure_mode:pdfua.document_language'],
          evidenceStrength: 20,
          activeOpportunityKeys: ['normalize_document_metadata:document:document'],
        }],
        autoRunnableOpportunityKeys: ['normalize_document_metadata:document:document'],
      }),
      fullAudit: makeLiveState({
        overallScore: 29,
        grade: 'F',
        blockingFindingKeys: ['pdfua.document_language'],
        topBlockingResidualFamilyIds: ['metadata_normalization'],
        topResidualFamilies: [{
          id: 'metadata_normalization',
          label: 'Metadata normalization',
          blocking: true,
          blockingReason: 'blocking_failure_mode:pdfua.document_language',
          convergenceStatus: 'preferred_tools_available',
          currentStep: 1,
          preferredAutoRunnableOpportunityKeys: ['normalize_document_metadata:document:document'],
          evidenceSignals: ['blocking_failure_mode:pdfua.document_language'],
          evidenceStrength: 20,
          activeOpportunityKeys: ['normalize_document_metadata:document:document'],
        }],
        autoRunnableOpportunityKeys: ['normalize_document_metadata:document:document'],
      }),
    })
    const runtime = buildProcessedIntakeParityState({
      path: '/repo/MitigationAttempts/15adult.runtime.pdf',
      filename: '15adult.runtime.pdf',
      planningProfile: makeLiveState(),
      fullAudit: makeLiveState({
        overallScore: 58,
        grade: 'F',
        topBlockingResidualFamilyIds: ['link_tabs_and_annotation_cleanup'],
      }),
    })
    const storedAfter = buildProcessedIntakeParityState({
      path: '/repo/Processed/After/15adult_probation_1999-2008.pdf',
      filename: '15adult_probation_1999-2008.pdf',
      planningProfile: makeLiveState({
        overallScore: 83,
        grade: 'B',
        blockingFindingKeys: [],
        topBlockingResidualFamilyIds: [],
        topResidualFamilies: [],
        autoRunnableOpportunityKeys: [],
      }),
      fullAudit: makeLiveState({
        overallScore: 83,
        grade: 'B',
        blockingFindingKeys: [],
        topBlockingResidualFamilyIds: [],
        topResidualFamilies: [],
        autoRunnableOpportunityKeys: [],
      }),
    })

    const pair = buildProcessedIntakeParityPairReport({
      beforeFilename: '15adult probation_1999-2008.pdf',
      afterFilename: '15adult_probation_1999-2008.pdf',
      before,
      runtime,
      storedAfter,
    })

    expect(pair.familyCompletionGap).toBe(true)
    expect(pair.nextBlockingFamily).toBe('link_tabs_and_annotation_cleanup')
    expect(pair.runtime.planningProfileVsFullAuditDelta.fullAuditTail).toBe(true)
  })

  it('surfaces a full-audit tail when planning blockers are gone but the authoritative audit is still materially lower', () => {
    const cleanPlanning = makeLiveState({
      overallScore: 100,
      grade: 'A',
      blockingFindingKeys: [],
      topBlockingResidualFamilyIds: [],
      topResidualFamilies: [],
      autoRunnableOpportunityKeys: [],
    })

    const pair = buildProcessedIntakeParityPairReport({
      beforeFilename: 'before.pdf',
      afterFilename: 'after.pdf',
      before: buildProcessedIntakeParityState({
        path: '/repo/before.pdf',
        filename: 'before.pdf',
        planningProfile: cleanPlanning,
        fullAudit: cleanPlanning,
      }),
      runtime: buildProcessedIntakeParityState({
        path: '/repo/runtime.pdf',
        filename: 'runtime.pdf',
        planningProfile: cleanPlanning,
        fullAudit: makeLiveState({
          overallScore: 88,
          grade: 'B',
          blockingFindingKeys: ['pdfua.logical_structure'],
          topBlockingResidualFamilyIds: [],
          topResidualFamilies: [],
          autoRunnableOpportunityKeys: [],
        }),
      }),
      storedAfter: buildProcessedIntakeParityState({
        path: '/repo/after.pdf',
        filename: 'after.pdf',
        planningProfile: cleanPlanning,
        fullAudit: cleanPlanning,
      }),
    })

    expect(pair.familyCompletionGap).toBe(false)
    expect(pair.nextBlockingFamily).toBe('full_audit_tail')
  })

  it('summarizes parity artifacts with family-completion and full-audit-tail counts', () => {
    const runtime = buildProcessedIntakeParityState({
      path: '/repo/runtime.pdf',
      filename: 'runtime.pdf',
      planningProfile: makeLiveState(),
      fullAudit: makeLiveState({
        overallScore: 58,
        grade: 'F',
      }),
    })
    const storedAfter = buildProcessedIntakeParityState({
      path: '/repo/after.pdf',
      filename: 'after.pdf',
      planningProfile: makeLiveState({
        overallScore: 83,
        grade: 'B',
        blockingFindingKeys: [],
        topBlockingResidualFamilyIds: [],
        topResidualFamilies: [],
        autoRunnableOpportunityKeys: [],
      }),
      fullAudit: makeLiveState({
        overallScore: 83,
        grade: 'B',
        blockingFindingKeys: [],
        topBlockingResidualFamilyIds: [],
        topResidualFamilies: [],
        autoRunnableOpportunityKeys: [],
      }),
    })
    const pair = buildProcessedIntakeParityPairReport({
      beforeFilename: 'before.pdf',
      afterFilename: 'after.pdf',
      before: buildProcessedIntakeParityState({
        path: '/repo/before.pdf',
        filename: 'before.pdf',
        planningProfile: makeLiveState({
          overallScore: 29,
          grade: 'F',
        }),
        fullAudit: makeLiveState({
          overallScore: 29,
          grade: 'F',
        }),
      }),
      runtime,
      storedAfter,
    })

    const artifact = buildProcessedIntakeParityArtifact({
      pairs: [pair],
    })

    expect(artifact.summary.pairCount).toBe(1)
    expect(artifact.summary.familyCompletionGapCount).toBe(1)
    expect(artifact.summary.fullAuditTailCount).toBe(1)
    expect(artifact.summary.nextBlockingFamilies).toEqual(['link_tabs_and_annotation_cleanup'])
  })
})
