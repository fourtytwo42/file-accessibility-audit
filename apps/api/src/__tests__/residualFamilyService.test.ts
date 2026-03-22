import { describe, expect, it } from 'vitest'
import type { FailureMode, ToolOpportunity } from '../services/documentModel.js'
import {
  annotateToolOpportunitiesWithResidualFamilies,
  buildResidualFamilyDecisions,
  evaluateActionPostconditions,
  findSingleBlockingResidualFamilyConvergenceTarget,
  semanticSidecarEligibleFamilies,
} from '../services/residualFamilyService.js'

function makeAnalysis(overrides: any = {}): any {
  return {
    overallScore: 72,
    grade: 'C',
    isScanned: false,
    categories: [
      { id: 'title_language', score: 50 },
      { id: 'text_extractability', score: 65 },
      { id: 'table_markup', score: 100 },
      { id: 'heading_structure', score: 100 },
      { id: 'alt_text', score: 100 },
      { id: 'link_quality', score: 100 },
      { id: 'reading_order', score: 100 },
      { id: 'pdf_ua_compliance', score: 100 },
      { id: 'bookmarks', score: 100 },
    ],
    localStandards: {
      findings: [
        { key: 'pdfua.font_unicode', blocking: true, count: 3 },
        { key: 'pdfua.document_language', blocking: true, count: 1 },
      ],
    },
    ...overrides,
  }
}

function makeContext(overrides: any = {}): any {
  return {
    qpdf: {
      fontsMissingToUnicodeBlocking: 3,
      unembeddedFontCount: 1,
    },
    figureCandidates: [{ id: 'figure:1' }, { id: 'figure:2' }],
    ...overrides,
  }
}

function makeFailureMode(overrides: Partial<FailureMode> = {}): FailureMode {
  return {
    key: 'pdfua.font_unicode',
    label: 'Font Unicode mapping',
    source: 'verapdf',
    count: 1,
    categoryIds: ['text_extractability', 'pdf_ua_compliance'],
    blocking: true,
    unmatched: false,
    classification: 'deterministic',
    nativeToolFamilies: ['repair_font_unicode_maps'],
    evidence: [],
    ...overrides,
  }
}

function makeOpportunity(overrides: Partial<ToolOpportunity> = {}): ToolOpportunity {
  return {
    key: 'repair_font_unicode_maps:document:document',
    toolName: 'repair_font_unicode_maps',
    reason: 'Fix font unicode',
    scope: 'document',
    candidateIds: [],
    candidateGroupIds: [],
    pageNumbers: [],
    categoryTargets: ['text_extractability', 'pdf_ua_compliance'],
    confidence: 0.9,
    status: 'auto_runnable',
    derivedFromFailureModeKeys: ['pdfua.font_unicode'],
    ...overrides,
  }
}

describe('residualFamilyService', () => {
  it('classifies seeded residual families from failure modes and opportunities', () => {
    const decisions = buildResidualFamilyDecisions({
      analysis: makeAnalysis(),
      context: makeContext(),
      failureModes: [
        makeFailureMode(),
        makeFailureMode({
          key: 'pdfua.document_language',
          categoryIds: ['title_language', 'pdf_ua_compliance'],
          nativeToolFamilies: ['normalize_document_metadata'],
        }),
      ],
      toolOpportunities: [
        makeOpportunity(),
        makeOpportunity({
          key: 'normalize_document_metadata:document:document',
          toolName: 'normalize_document_metadata',
          derivedFromFailureModeKeys: ['pdfua.document_language'],
          categoryTargets: ['title_language', 'pdf_ua_compliance'],
        }),
      ],
      actions: [],
    })

    expect(decisions.map(entry => entry.id)).toEqual(expect.arrayContaining([
      'metadata_normalization',
      'font_embedding_and_unicode',
    ]))
    expect(decisions.find(entry => entry.id === 'font_embedding_and_unicode')?.evidenceSignals).toEqual(
      expect.arrayContaining([
        'blocking_failure_mode:pdfua.font_unicode',
        'opportunity:repair_font_unicode_maps:auto_runnable',
      ]),
    )
  })

  it('annotates tool opportunities with family ids, steps, and postconditions', () => {
    const residualFamilies = buildResidualFamilyDecisions({
      analysis: makeAnalysis(),
      context: makeContext(),
      failureModes: [makeFailureMode()],
      toolOpportunities: [makeOpportunity()],
      actions: [],
    })

    const [annotated] = annotateToolOpportunitiesWithResidualFamilies({
      toolOpportunities: [makeOpportunity()],
      residualFamilies,
    })

    expect(annotated?.familyId).toBe('font_embedding_and_unicode')
    expect(annotated?.familyStep).toBe(2)
    expect(annotated?.expectedPostconditions).toContain('font_blocking_keys_shrink')
  })

  it('does not activate unrelated residual families from low category scores alone', () => {
    const decisions = buildResidualFamilyDecisions({
      analysis: makeAnalysis({
        categories: [
          { id: 'title_language', score: 100 },
          { id: 'text_extractability', score: 60 },
          { id: 'table_markup', score: 100 },
          { id: 'heading_structure', score: 70 },
          { id: 'alt_text', score: 65 },
          { id: 'link_quality', score: 100 },
          { id: 'reading_order', score: 55 },
          { id: 'pdf_ua_compliance', score: 50 },
          { id: 'bookmarks', score: 100 },
        ],
        localStandards: {
          findings: [],
        },
      }),
      context: makeContext({
        qpdf: {
          fontsMissingToUnicodeBlocking: 0,
          unembeddedFontCount: 0,
        },
        figureCandidates: [],
      }),
      failureModes: [],
      toolOpportunities: [],
      actions: [],
    })

    expect(decisions.map(entry => entry.id)).toEqual(['unresolved_manual_family'])
    expect(decisions[0]?.evidenceSignals).toEqual(['no_direct_family_evidence'])
  })

  it('does not activate unrelated families from shared category-target opportunities alone', () => {
    const decisions = buildResidualFamilyDecisions({
      analysis: makeAnalysis({
        categories: [
          { id: 'title_language', score: 100 },
          { id: 'text_extractability', score: 100 },
          { id: 'table_markup', score: 100 },
          { id: 'heading_structure', score: 80 },
          { id: 'alt_text', score: 100 },
          { id: 'link_quality', score: 100 },
          { id: 'reading_order', score: 70 },
          { id: 'pdf_ua_compliance', score: 85 },
          { id: 'bookmarks', score: 100 },
        ],
        localStandards: {
          findings: [],
        },
      }),
      context: makeContext(),
      failureModes: [],
      toolOpportunities: [
        makeOpportunity({
          key: 'artifact_nonsemantic_page_elements:document:document',
          toolName: 'artifact_nonsemantic_page_elements',
          categoryTargets: ['reading_order', 'pdf_ua_compliance'],
          derivedFromFailureModeKeys: [],
          status: 'auto_runnable',
        }),
      ],
      actions: [],
    })

    expect(decisions.map(entry => entry.id)).toEqual(expect.arrayContaining([
      'post_bootstrap_heading_convergence',
      'logical_structure_marked_content',
    ]))
    expect(decisions.map(entry => entry.id)).not.toEqual(expect.arrayContaining([
      'metadata_normalization',
      'bookmark_language_outline_cleanup',
      'font_embedding_and_unicode',
      'table_structure_recovery',
      'link_tabs_and_annotation_cleanup',
    ]))
  })

  it('classifies tagged annotations inside the link/tabs family and exposes tag_unowned_annotations as a preferred step', () => {
    const decisions = buildResidualFamilyDecisions({
      analysis: makeAnalysis({
        categories: [
          { id: 'title_language', score: 100 },
          { id: 'text_extractability', score: 100 },
          { id: 'table_markup', score: 100 },
          { id: 'heading_structure', score: 100 },
          { id: 'alt_text', score: 100 },
          { id: 'link_quality', score: 65 },
          { id: 'reading_order', score: 80 },
          { id: 'pdf_ua_compliance', score: 75 },
          { id: 'bookmarks', score: 100 },
        ],
        localStandards: {
          findings: [
            { key: 'pdfua.tagged_annotations', blocking: true, count: 2 },
          ],
        },
      }),
      context: makeContext({
        qpdf: {
          fontsMissingToUnicodeBlocking: 0,
          unembeddedFontCount: 0,
        },
      }),
      failureModes: [
        makeFailureMode({
          key: 'pdfua.tagged_annotations',
          categoryIds: ['link_quality', 'reading_order', 'pdf_ua_compliance'],
          nativeToolFamilies: ['tag_unowned_annotations'],
        }),
      ],
      toolOpportunities: [
        makeOpportunity({
          key: 'tag_unowned_annotations:document:document',
          toolName: 'tag_unowned_annotations',
          categoryTargets: ['link_quality', 'reading_order'],
          derivedFromFailureModeKeys: ['pdfua.tagged_annotations'],
        }),
      ],
      actions: [],
    })

    const family = decisions.find(entry => entry.id === 'link_tabs_and_annotation_cleanup')
    expect(family?.preferredTools.slice(0, 4)).toEqual([
      'repair_native_link_structure',
      'tag_unowned_annotations',
      'set_page_tabs',
      'set_link_annotation_contents',
    ])
    expect(family?.preferredAutoRunnableOpportunityKeys).toEqual(['tag_unowned_annotations:document:document'])
    expect(family?.convergenceStatus).toBe('preferred_tools_available')
  })

  it('identifies a single blocking family that still has preferred deterministic work left', () => {
    const target = findSingleBlockingResidualFamilyConvergenceTarget([
      {
        id: 'link_tabs_and_annotation_cleanup',
        label: 'Link, tabs, and annotation cleanup',
        priority: 50,
        blocking: true,
        blockingReason: 'blocking_failure_mode:pdfua.link_tagging',
        convergenceStatus: 'preferred_tools_available',
        semanticPolicy: 'optional_after_deterministic',
        failureModeKeys: ['pdfua.link_tagging'],
        categoryIds: ['link_quality'],
        preferredTools: ['repair_native_link_structure'],
        deprioritizedTools: ['rewrite_link_visible_text'],
        expectedPostconditions: ['link_blocking_keys_shrink'],
        activeOpportunityKeys: ['repair_native_link_structure:document:document'],
        preferredAutoRunnableOpportunityKeys: ['repair_native_link_structure:document:document'],
        currentStep: 1,
        evidenceSignals: ['blocking_failure_mode:pdfua.link_tagging'],
        evidenceStrength: 20,
        regressionCanaries: ['annual_report_link_tabs_cleanup'],
      },
    ])

    expect(target?.id).toBe('link_tabs_and_annotation_cleanup')
  })

  it('marks a blocking family as exhausted when its remaining preferred opportunity was already attempted', () => {
    const decisions = buildResidualFamilyDecisions({
      analysis: makeAnalysis({
        categories: [
          { id: 'title_language', score: 100 },
          { id: 'text_extractability', score: 100 },
          { id: 'table_markup', score: 100 },
          { id: 'heading_structure', score: 100 },
          { id: 'alt_text', score: 100 },
          { id: 'link_quality', score: 65 },
          { id: 'reading_order', score: 80 },
          { id: 'pdf_ua_compliance', score: 75 },
          { id: 'bookmarks', score: 100 },
        ],
        localStandards: {
          findings: [
            { key: 'pdfua.link_tagging', blocking: true, count: 1 },
          ],
        },
      }),
      context: makeContext({
        qpdf: {
          fontsMissingToUnicodeBlocking: 0,
          unembeddedFontCount: 0,
        },
      }),
      failureModes: [
        makeFailureMode({
          key: 'pdfua.link_tagging',
          categoryIds: ['link_quality', 'pdf_ua_compliance'],
          nativeToolFamilies: ['repair_native_link_structure'],
        }),
      ],
      toolOpportunities: [
        makeOpportunity({
          key: 'repair_native_link_structure:document:document',
          toolName: 'repair_native_link_structure',
          categoryTargets: ['link_quality', 'reading_order'],
          derivedFromFailureModeKeys: ['pdfua.link_tagging'],
        }),
      ],
      actions: [
        {
          tool: 'repair_native_link_structure',
          target: 'document',
          details: 'link structure normalized',
          confidence: 0.9,
          autoApplied: true,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['link_quality', 'reading_order'],
          outcome: 'applied',
          familyId: 'link_tabs_and_annotation_cleanup',
          postconditionStatus: 'not_satisfied',
        },
      ],
    })

    const family = decisions.find(entry => entry.id === 'link_tabs_and_annotation_cleanup')
    expect(family?.convergenceStatus).toBe('preferred_tools_exhausted')
    expect(findSingleBlockingResidualFamilyConvergenceTarget(decisions)).toBeNull()
  })

  it('marks postconditions satisfied when blocking keys or counters shrink', () => {
    const result = evaluateActionPostconditions({
      action: {
        tool: 'repair_font_unicode_maps',
        target: 'document',
        details: 'Fix font unicode',
        confidence: 0.9,
        autoApplied: true,
        changedVisibleContent: false,
        categoryTargets: ['text_extractability'],
        changedDocumentBytes: true,
        outcome: 'applied',
        familyId: 'font_embedding_and_unicode',
      },
      previous: makeAnalysis(),
      next: makeAnalysis({
        categories: [
          { id: 'title_language', score: 50 },
          { id: 'text_extractability', score: 90 },
          { id: 'table_markup', score: 40 },
          { id: 'heading_structure', score: 55 },
          { id: 'alt_text', score: 60 },
          { id: 'link_quality', score: 70 },
          { id: 'reading_order', score: 70 },
          { id: 'pdf_ua_compliance', score: 90 },
          { id: 'bookmarks', score: 60 },
        ],
        localStandards: {
          findings: [],
        },
      }),
      previousContext: makeContext(),
      nextContext: makeContext({
        qpdf: {
          fontsMissingToUnicodeBlocking: 0,
          unembeddedFontCount: 0,
        },
        figureCandidates: [],
      }),
    })

    expect(result.familyId).toBe('font_embedding_and_unicode')
    expect(result.status).toBe('satisfied')
    expect(result.signals.some(signal => signal.includes('fontsMissingToUnicodeBlocking'))).toBe(true)
  })

  it('only exposes semantic sidecar families after deterministic opportunities are exhausted', () => {
    const blockingFigureFamily = {
      id: 'native_figure_convergence',
      label: 'Native figure convergence',
      priority: 60,
      blocking: true,
      semanticPolicy: 'optional_after_deterministic',
      failureModeKeys: ['category.alt_text'],
      categoryIds: ['alt_text'],
      preferredTools: ['repair_native_figure_semantics', 'set_figure_alt_text'],
      deprioritizedTools: [],
      expectedPostconditions: ['figure_blocking_keys_shrink'],
      activeOpportunityKeys: [],
      currentStep: 2,
      regressionCanaries: [],
    } as const

    const blocked = semanticSidecarEligibleFamilies({
      residualFamilies: [blockingFigureFamily],
      toolOpportunities: [
        makeOpportunity({
          key: 'repair_native_figure_semantics:document:document',
          toolName: 'repair_native_figure_semantics',
          status: 'auto_runnable',
          familyId: 'native_figure_convergence',
          derivedFromFailureModeKeys: ['category.alt_text'],
          categoryTargets: ['alt_text'],
          scope: 'document',
        }),
      ],
    } as any)
    expect(blocked).toEqual([])

    const eligible = semanticSidecarEligibleFamilies({
      residualFamilies: [blockingFigureFamily],
      toolOpportunities: [
        makeOpportunity({
          key: 'set_figure_alt_text:candidate:figure:1',
          toolName: 'set_figure_alt_text',
          status: 'already_attempted',
          familyId: 'native_figure_convergence',
          derivedFromFailureModeKeys: ['category.alt_text'],
          categoryTargets: ['alt_text'],
        }),
      ],
    } as any)
    expect(eligible.map(entry => entry.id)).toEqual(['native_figure_convergence'])
  })

  it('treats backend-backed link ownership counters as satisfied link-family postconditions', () => {
    const result = evaluateActionPostconditions({
      action: {
        tool: 'tag_unowned_annotations',
        target: 'document',
        details: 'Tagged visible annotations with native structure ownership.',
        confidence: 0.95,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        categoryTargets: ['link_quality', 'reading_order', 'pdf_ua_compliance'],
        outcome: 'applied',
        familyId: 'link_tabs_and_annotation_cleanup',
        linkOperationSummary: {
          operation: 'tag_unowned_annotations',
          taggedLinkCount: 1,
          taggedAnnotationCount: 2,
          orphanAnnotationCountReduced: 2,
          repairedLinkStructureCount: 1,
          annotationContentsSetCount: 0,
          annotationTabOrderNormalizedCount: 0,
          tabsSetCount: 0,
          unresolvedWarningCount: 0,
        },
      },
      previous: makeAnalysis({
        localStandards: {
          findings: [
            { key: 'pdfua.tagged_annotations', blocking: true, count: 2 },
          ],
        },
      }),
      next: makeAnalysis({
        localStandards: {
          findings: [
            { key: 'pdfua.tagged_annotations', blocking: true, count: 2 },
          ],
        },
      }),
      previousContext: makeContext(),
      nextContext: makeContext(),
    })

    expect(result.familyId).toBe('link_tabs_and_annotation_cleanup')
    expect(result.status).toBe('satisfied')
    expect(result.signals).toEqual(expect.arrayContaining([
      'link_summary:taggedLinkCount:1',
      'link_summary:taggedAnnotationCount:2',
      'link_summary:orphanAnnotationCountReduced:2',
    ]))
  })
})
