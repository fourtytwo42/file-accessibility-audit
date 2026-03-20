import { beforeEach, describe, expect, it, vi } from 'vitest'

const buildFailureProfileArtifacts = vi.fn()
const getToolReliabilityMap = vi.fn()

vi.mock('../services/failureProfileService.js', () => ({
  buildFailureProfileArtifacts,
}))

vi.mock('../services/toolReliabilityService.js', () => ({
  classifyPdf: () => 'untagged_digital',
  getToolReliabilityMap,
}))

vi.mock('../services/semanticEnrichmentService.js', () => ({
  hasSemanticRepairConfig: () => false,
}))

vi.mock('../services/languageTags.js', () => ({
  normalizeLanguageTag: (value: string) => value,
}))

vi.mock('../services/pdfRemediationTools.js', () => ({
  normalizedExistingHeadingLevel: () => null,
}))

describe('remediationPlanService', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getToolReliabilityMap.mockReturnValue(new Map())
  })

  it('reorders deterministic opportunities using historical reliability', async () => {
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '1',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'F',
        analysisScore: 50,
        veraPdfStatus: 'failed',
        veraPdfFailedChecks: 1,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [{
          key: 'category.title_language',
          label: 'Title and language',
          source: 'category',
          count: 1,
          categoryIds: ['title_language'],
          blocking: false,
          unmatched: false,
          classification: 'deterministic',
          nativeToolFamilies: [],
          evidence: [],
        }],
        toolOpportunities: [
          {
            key: 'title',
            toolName: 'set_document_title',
            reason: 'Set title',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['title_language'],
            confidence: 0.9,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.title_language'],
          },
          {
            key: 'language',
            toolName: 'set_document_language',
            reason: 'Set language',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['title_language'],
            confidence: 0.9,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.title_language'],
          },
        ],
        summary: {
          deterministicIssueCount: 1,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 2,
        },
      },
      plannerEvidence: {
        topFailureModeKeys: [],
        topAutoRunnableOpportunityKeys: [],
        skippedReasonCounts: [],
        attemptedKeys: [],
        rejectedKeys: [],
        noEffectKeys: [],
      },
    })
    getToolReliabilityMap.mockReturnValue(new Map([
      ['set_document_title', { reliability: 0.2 }],
      ['set_document_language', { reliability: 1.0 }],
    ]))

    const { planRemediationActions } = await import('../services/remediationPlanService.js')
    const plan = await planRemediationActions({
      filename: 'example.pdf',
      analysis: {
        overallScore: 50,
        grade: 'F',
        isScanned: false,
        categories: [{ id: 'title_language', label: 'Title', score: 50, severity: 'Moderate' }],
      } as any,
      context: {
        pdfjs: { title: '', lang: '' },
        qpdf: { lang: '', hasStructTree: false, structTreeDepth: 0, formFields: [] },
        headingCandidates: [],
        figureCandidates: [],
        tableCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: { structuralNodes: [] },
      } as any,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions[0]?.tool_name).toBe('set_document_language')
  })

  it('skips solved categories in round 2+ but preserves standards-only tools for unresolved compliance', async () => {
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '1',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'B',
        analysisScore: 98,
        veraPdfStatus: 'failed',
        veraPdfFailedChecks: 1,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [{
          key: 'pdfua.structure',
          label: 'PDF/UA structure',
          source: 'verapdf',
          count: 1,
          categoryIds: ['pdf_ua_compliance'],
          blocking: true,
          unmatched: false,
          classification: 'deterministic',
          nativeToolFamilies: [],
          evidence: [],
        }],
        toolOpportunities: [
          {
            key: 'title',
            toolName: 'set_document_title',
            reason: 'Set title',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['title_language'],
            confidence: 0.9,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.title_language'],
          },
          {
            key: 'tabs',
            toolName: 'normalize_annotation_tab_order',
            reason: 'Fix reading order',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['reading_order'],
            confidence: 0.9,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.reading_order'],
          },
          {
            key: 'structure',
            toolName: 'repair_structure_conformance',
            reason: 'Fix PDF/UA structure',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['pdf_ua_compliance'],
            confidence: 0.8,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.structure'],
          },
        ],
        summary: {
          deterministicIssueCount: 1,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 3,
        },
      },
      plannerEvidence: {
        topFailureModeKeys: [],
        topAutoRunnableOpportunityKeys: [],
        skippedReasonCounts: [],
        attemptedKeys: [],
        rejectedKeys: [],
        noEffectKeys: [],
      },
    })

    const { planRemediationActions } = await import('../services/remediationPlanService.js')
    const plan = await planRemediationActions({
      filename: 'example.pdf',
      analysis: {
        overallScore: 98,
        grade: 'A',
        isScanned: false,
        categories: [
          { id: 'title_language', label: 'Title', score: 100, severity: 'Pass' },
          { id: 'reading_order', label: 'Reading Order', score: 100, severity: 'Pass' },
          { id: 'pdf_ua_compliance', label: 'PDF/UA', score: 98, severity: 'Moderate' },
        ],
      } as any,
      context: {
        pdfjs: { title: 'Example', lang: 'en' },
        qpdf: { lang: 'en', hasStructTree: true, structTreeDepth: 1, formFields: [] },
        headingCandidates: [],
        figureCandidates: [],
        tableCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: { structuralNodes: [{ ref: '1 0 R' }] },
      } as any,
      iteration: 2,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.map(action => action.tool_name)).toEqual(['repair_structure_conformance'])
  })

  it('filters excluded tools from deterministic planning when pipeline classification disallows them', async () => {
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '1',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'B',
        analysisScore: 88,
        veraPdfStatus: 'failed',
        veraPdfFailedChecks: 1,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [{
          key: 'category.alt_text',
          label: 'Alt text',
          source: 'category',
          count: 1,
          categoryIds: ['alt_text'],
          blocking: false,
          unmatched: false,
          classification: 'deterministic',
          nativeToolFamilies: [],
          evidence: [],
        }],
        toolOpportunities: [
          {
            key: 'figure',
            toolName: 'set_figure_alt_text',
            reason: 'Add alt text',
            scope: 'candidate',
            candidateIds: ['figure:1'],
            candidateGroupIds: [],
            pageNumbers: [1],
            categoryTargets: ['alt_text'],
            confidence: 0.9,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.alt_text'],
          },
          {
            key: 'title',
            toolName: 'set_document_title',
            reason: 'Set title',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['title_language'],
            confidence: 0.8,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.title_language'],
          },
        ],
        summary: {
          deterministicIssueCount: 1,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 2,
        },
      },
      plannerEvidence: {
        topFailureModeKeys: [],
        topAutoRunnableOpportunityKeys: [],
        skippedReasonCounts: [],
        attemptedKeys: [],
        rejectedKeys: [],
        noEffectKeys: [],
      },
    })

    const { planRemediationActions } = await import('../services/remediationPlanService.js')
    const plan = await planRemediationActions({
      filename: 'example.pdf',
      analysis: {
        overallScore: 88,
        grade: 'B',
        isScanned: false,
        categories: [{ id: 'alt_text', label: 'Alt text', score: 70, severity: 'Moderate' }],
      } as any,
      context: {
        pdfjs: { title: '', lang: '' },
        qpdf: { lang: '', hasStructTree: true, structTreeDepth: 3, formFields: [] },
        headingCandidates: [],
        figureCandidates: [{ id: 'figure:1', pageNumber: 1, surroundingText: [], splitGenerated: false, informativeHint: 'informative', repairMode: 'safe' }],
        tableCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: { structuralNodes: [{ ref: '1 0 R' }] },
      } as any,
      iteration: 1,
      actions: [],
      rejectedActions: [],
      pipelineConfig: {
        stages: {
          metadata: true,
          structureBootstrap: false,
          linkStructure: true,
          fonts: false,
          nativeStructure: true,
          safeCandidates: true,
        },
        excludedTools: ['set_figure_alt_text'],
        maxRounds: 2,
        earlyExitScore: 95,
        semanticStrategy: 'heuristic_only',
      },
    })

    expect(plan.actions.map(action => action.tool_name)).toEqual(['set_document_title'])
  })

  it('reserves room for document-scoped fixes before candidate floods consume the action budget', async () => {
    const candidateOpportunities = Array.from({ length: 40 }, (_, index) => ({
      key: `link-${index}`,
      toolName: 'set_link_annotation_contents',
      reason: `Set link contents ${index}`,
      scope: 'candidate',
      candidateIds: [`link:1:${index}`],
      candidateGroupIds: [],
      pageNumbers: [1],
      categoryTargets: ['link_quality'],
      confidence: 0.9,
      status: 'auto_runnable',
      derivedFromFailureModeKeys: ['pdfua.annotation_alt_contents'],
    }))

    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '1',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'D',
        analysisScore: 65,
        veraPdfStatus: 'failed',
        veraPdfFailedChecks: 1,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [
          {
            key: 'pdfua.annotation_alt_contents',
            label: 'Link annotation alternate descriptions',
            source: 'local_standards',
            count: 40,
            categoryIds: ['link_quality', 'pdf_ua_compliance'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: [],
            evidence: [],
          },
          {
            key: 'pdfua.font_embedding',
            label: 'Font embedding',
            source: 'local_standards',
            count: 3,
            categoryIds: ['text_extractability', 'pdf_ua_compliance'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: [],
            evidence: [],
          },
        ],
        toolOpportunities: [
          ...candidateOpportunities,
          {
            key: 'embed-fonts',
            toolName: 'embed_missing_fonts_in_place',
            reason: 'Embed missing fonts',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['text_extractability', 'pdf_ua_compliance'],
            confidence: 0.85,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.font_embedding'],
          },
        ],
        summary: {
          deterministicIssueCount: 2,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 41,
        },
      },
      plannerEvidence: {
        topFailureModeKeys: [],
        topAutoRunnableOpportunityKeys: [],
        skippedReasonCounts: [],
        attemptedKeys: [],
        rejectedKeys: [],
        noEffectKeys: [],
      },
    })

    const { planRemediationActions } = await import('../services/remediationPlanService.js')
    const plan = await planRemediationActions({
      filename: 'crowded.pdf',
      analysis: {
        overallScore: 65,
        grade: 'D',
        isScanned: false,
        pageCount: 4,
        categories: [
          { id: 'link_quality', label: 'Links', score: 40, severity: 'Critical' },
          { id: 'text_extractability', label: 'Text', score: 40, severity: 'Critical' },
          { id: 'pdf_ua_compliance', label: 'PDF/UA', score: 60, severity: 'Moderate' },
        ],
      } as any,
      context: {
        pdfjs: { title: '', lang: '', links: [] },
        qpdf: { lang: '', hasStructTree: true, structTreeDepth: 3, formFields: [], unembeddedFontCount: 3 },
        headingCandidates: [],
        figureCandidates: [],
        tableCandidates: [],
        pages: [],
        linkCandidates: candidateOpportunities.map((_, index) => ({
          id: `link:1:${index}`,
          pageNumber: 1,
          annotationIndex: index,
          rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.02 },
          url: `https://example.com/${index}`,
          text: `Link ${index}`,
          contents: null,
          visibleText: `Link ${index}`,
          nearbyText: [],
        })),
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: { structuralNodes: [{ ref: '1 0 R' }] },
      } as any,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions).toHaveLength(32)
    expect(plan.actions.some(action => action.tool_name === 'embed_missing_fonts_in_place')).toBe(true)
  })

  it('reserves room for safe heading candidates before link candidate floods consume the action budget', async () => {
    const linkCandidateOpportunities = Array.from({ length: 40 }, (_, index) => ({
      key: `link-${index}`,
      toolName: 'set_link_annotation_contents',
      reason: `Set link contents ${index}`,
      scope: 'candidate',
      candidateIds: [`link:1:${index}`],
      candidateGroupIds: [],
      pageNumbers: [1],
      categoryTargets: ['link_quality'],
      confidence: 0.9,
      status: 'auto_runnable',
      derivedFromFailureModeKeys: ['pdfua.annotation_alt_contents'],
    }))
    const headingOpportunities = Array.from({ length: 12 }, (_, index) => ({
      key: `heading-${index}`,
      toolName: 'create_heading_from_candidate',
      reason: `Create heading ${index}`,
      scope: 'candidate',
      candidateIds: [`heading:1:${index}`],
      candidateGroupIds: [],
      pageNumbers: [1],
      categoryTargets: ['heading_structure'],
      confidence: 0.7,
      status: 'auto_runnable',
      derivedFromFailureModeKeys: ['category.heading_structure'],
    }))

    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '1',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'D',
        analysisScore: 63,
        veraPdfStatus: 'unavailable',
        veraPdfFailedChecks: 0,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [
          {
            key: 'category.heading_structure',
            label: 'Heading Structure',
            source: 'category',
            count: 1,
            categoryIds: ['heading_structure'],
            blocking: true,
            unmatched: false,
            classification: 'semantic',
            nativeToolFamilies: [],
            evidence: [],
          },
          {
            key: 'pdfua.annotation_alt_contents',
            label: 'Link annotation alternate descriptions',
            source: 'local_standards',
            count: 40,
            categoryIds: ['link_quality', 'pdf_ua_compliance'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: [],
            evidence: [],
          },
        ],
        toolOpportunities: [
          ...linkCandidateOpportunities,
          ...headingOpportunities,
        ],
        summary: {
          deterministicIssueCount: 1,
          semanticIssueCount: 1,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 52,
        },
      },
      plannerEvidence: {
        topFailureModeKeys: [],
        topAutoRunnableOpportunityKeys: [],
        skippedReasonCounts: [],
        attemptedKeys: [],
        rejectedKeys: [],
        noEffectKeys: [],
      },
    })

    const { planRemediationActions } = await import('../services/remediationPlanService.js')
    const plan = await planRemediationActions({
      filename: 'heading-crowded.pdf',
      analysis: {
        overallScore: 63,
        grade: 'D',
        isScanned: false,
        pageCount: 16,
        categories: [
          { id: 'heading_structure', label: 'Heading', score: 0, severity: 'Critical' },
          { id: 'link_quality', label: 'Links', score: 40, severity: 'Critical' },
          { id: 'pdf_ua_compliance', label: 'PDF/UA', score: 20, severity: 'Critical' },
        ],
      } as any,
      context: {
        pdfjs: { title: '', lang: '', links: [] },
        qpdf: { lang: '', hasStructTree: true, structTreeDepth: 4, formFields: [] },
        headingCandidates: headingOpportunities.map((_, index) => ({
          id: `heading:1:${index}`,
          pageNumber: 1,
          text: `Heading ${index}`,
          nearbyContext: [],
          targetRef: `obj:${500 + index} 0 R`,
          existingTag: '/P',
          repairMode: 'safe',
        })),
        figureCandidates: [],
        tableCandidates: [],
        pages: [],
        linkCandidates: linkCandidateOpportunities.map((_, index) => ({
          id: `link:1:${index}`,
          pageNumber: 1,
          annotationIndex: index,
          url: `https://example.com/${index}`,
          text: `Link ${index}`,
          suggestedText: `Link ${index}`,
        })),
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: { structuralNodes: [{ ref: '1 0 R' }] },
      } as any,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions).toHaveLength(32)
    expect(plan.actions.filter(action => action.tool_name === 'create_heading_from_candidate').length).toBeGreaterThan(0)
  })
  it('plans finalize_substituted_font_conformance after embed and unicode repair for persistent legacy font failures', async () => {
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '1',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'B',
        analysisScore: 80,
        veraPdfStatus: 'unavailable',
        veraPdfFailedChecks: 0,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [
          {
            key: 'pdfua.font_embedding',
            label: 'Font embedding',
            source: 'local_standards',
            count: 5,
            categoryIds: ['text_extractability', 'pdf_ua_compliance'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: [],
            evidence: [],
          },
        ],
        toolOpportunities: [
          {
            key: 'finalize-fonts',
            toolName: 'finalize_substituted_font_conformance',
            reason: 'Finalize residual legacy font conformance after embedding.',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['text_extractability', 'pdf_ua_compliance'],
            confidence: 0.85,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.font_embedding'],
          },
        ],
        summary: {
          deterministicIssueCount: 1,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 1,
        },
      },
      plannerEvidence: {
        topFailureModeKeys: [],
        topAutoRunnableOpportunityKeys: [],
        skippedReasonCounts: [],
        attemptedKeys: [],
        rejectedKeys: [],
        noEffectKeys: [],
      },
    })

    const { planRemediationActions } = await import('../services/remediationPlanService.js')
    const plan = await planRemediationActions({
      filename: 'cmvoga.pdf',
      analysis: {
        overallScore: 80,
        grade: 'B',
        isScanned: false,
        pageCount: 4,
        verapdf: { failures: [] },
        categories: [
          { id: 'text_extractability', label: 'Text', score: 40, severity: 'Critical' },
          { id: 'pdf_ua_compliance', label: 'PDF/UA', score: 70, severity: 'Moderate' },
        ],
      } as any,
      context: {
        pdfjs: { title: '', lang: '', links: [] },
        qpdf: {
          lang: '',
          hasStructTree: true,
          structTreeDepth: 2,
          formFields: [],
          unembeddedFontCount: 5,
          fontsMissingToUnicode: 0,
          type1FontsMissingToUnicode: 0,
          legacyWidthRiskFontCount: 0,
        },
        headingCandidates: [],
        figureCandidates: [],
        tableCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: { structuralNodes: [{ ref: '1 0 R' }] },
      } as any,
      iteration: 2,
      actions: [
        { tool: 'embed_missing_fonts_in_place', outcome: 'no_effect' },
        { tool: 'repair_font_unicode_maps', outcome: 'no_effect' },
      ] as any,
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'finalize_substituted_font_conformance')).toBe(true)
  })
})
