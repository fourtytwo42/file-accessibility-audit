import { describe, expect, it } from 'vitest'
import type { FailureMode, ToolOpportunity } from '../services/documentModel.js'
import {
  annotateToolOpportunitiesWithResidualFamilies,
  buildResidualFamilyDecisions,
  evaluateActionPostconditions,
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
})
