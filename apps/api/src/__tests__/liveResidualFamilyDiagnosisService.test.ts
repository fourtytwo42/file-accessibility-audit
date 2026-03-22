import { describe, expect, it } from 'vitest'
import {
  buildLiveResidualFamilyDiagnosisArtifact,
  buildLiveResidualFamilyState,
} from '../services/liveResidualFamilyDiagnosisService.js'

function makeFailureProfile(overrides: any = {}): any {
  return {
    failureModes: [
      {
        key: 'context.post_bootstrap_structural_residue',
        classification: 'deterministic',
        blocking: true,
      },
    ],
    residualFamilies: [
      {
        id: 'post_bootstrap_heading_convergence',
        label: 'Post-bootstrap heading convergence',
        priority: 70,
        blocking: true,
        blockingReason: 'blocking_failure_mode:context.post_bootstrap_structural_residue',
        semanticPolicy: 'optional_after_deterministic',
        failureModeKeys: ['context.post_bootstrap_structural_residue'],
        categoryIds: ['heading_structure', 'reading_order'],
        preferredTools: ['artifact_nonsemantic_page_elements', 'normalize_heading_hierarchy'],
        deprioritizedTools: ['repair_native_marked_content_refs'],
        expectedPostconditions: ['heading_blocking_keys_shrink'],
        activeOpportunityKeys: ['normalize_heading_hierarchy:document:document'],
        currentStep: 2,
        evidenceSignals: [
          'blocking_failure_mode:context.post_bootstrap_structural_residue',
          'opportunity:normalize_heading_hierarchy:auto_runnable',
        ],
        evidenceStrength: 14,
        regressionCanaries: ['annual_report_heading_convergence'],
      },
    ],
    toolOpportunities: [
      {
        key: 'normalize_heading_hierarchy:document:document',
        status: 'auto_runnable',
      },
    ],
    ...overrides,
  }
}

function makePlannerEvidence(overrides: any = {}): any {
  return {
    topBlockingResidualFamilyIds: ['post_bootstrap_heading_convergence'],
    topResidualFamilyIds: ['post_bootstrap_heading_convergence'],
    ...overrides,
  }
}

describe('liveResidualFamilyDiagnosisService', () => {
  it('builds a live state from failure-profile family evidence', () => {
    const state = buildLiveResidualFamilyState({
      filePath: '/repo/Downloads/2008 Annual Report.pdf',
      overallScore: 90,
      grade: 'B',
      failureProfile: makeFailureProfile(),
      plannerEvidence: makePlannerEvidence(),
      manualReviewFlags: [],
    })

    expect(state.topBlockingResidualFamilyIds).toEqual(['post_bootstrap_heading_convergence'])
    expect(state.topResidualFamilies[0]).toEqual(expect.objectContaining({
      id: 'post_bootstrap_heading_convergence',
      currentStep: 2,
      evidenceSignals: expect.arrayContaining(['blocking_failure_mode:context.post_bootstrap_structural_residue']),
    }))
    expect(state.semanticSidecarState).toBe('not_flagged')
  })

  it('builds family diffs that isolate unresolved fallback on the attempt side', () => {
    const source = buildLiveResidualFamilyState({
      filePath: '/repo/Downloads/2007 Annual Report Final.pdf',
      overallScore: 39,
      grade: 'F',
      failureProfile: makeFailureProfile(),
      plannerEvidence: makePlannerEvidence(),
    })
    const attempt = buildLiveResidualFamilyState({
      filePath: '/repo/MitigationAttempts/2007 Annual Report Final/attempt-006-runtime-integration-retry.pdf',
      overallScore: 57,
      grade: 'F',
      failureProfile: makeFailureProfile({
        failureModes: [
          {
            key: 'manual.semantic_follow_up',
            classification: 'manual_only',
            blocking: true,
          },
        ],
        residualFamilies: [
          {
            id: 'unresolved_manual_family',
            label: 'Unresolved manual family',
            priority: 999,
            blocking: true,
            blockingReason: 'manual_only_failure_mode',
            semanticPolicy: 'manual_only',
            failureModeKeys: ['manual.semantic_follow_up'],
            categoryIds: ['alt_text', 'reading_order'],
            preferredTools: [],
            deprioritizedTools: [],
            expectedPostconditions: ['manual_review_required'],
            activeOpportunityKeys: [],
            currentStep: null,
            evidenceSignals: ['manual_only_failure_mode:manual.semantic_follow_up'],
            evidenceStrength: 5,
            regressionCanaries: ['manual_review_queue'],
          },
        ],
        toolOpportunities: [],
      }),
      plannerEvidence: makePlannerEvidence({
        topBlockingResidualFamilyIds: ['unresolved_manual_family'],
        topResidualFamilyIds: ['unresolved_manual_family'],
      }),
      manualReviewFlags: [{
        code: 'semantic_sidecar_unavailable',
        label: 'Semantic sidecar unavailable',
        severity: 'warning',
        details: 'provider 502',
      }],
    })

    const artifact = buildLiveResidualFamilyDiagnosisArtifact({
      pairs: [{ source, attempt }],
    })

    expect(artifact.pairs[0]?.familyDiff.sourceTopBlocker).toBe('post_bootstrap_heading_convergence')
    expect(artifact.pairs[0]?.familyDiff.attemptTopBlocker).toBe('unresolved_manual_family')
    expect(artifact.pairs[0]?.familyDiff.addedBlockingFamilies).toEqual(['unresolved_manual_family'])
    expect(artifact.pairs[0]?.attempt.semanticSidecarState).toBe('semantic_sidecar_unavailable')
  })
})
