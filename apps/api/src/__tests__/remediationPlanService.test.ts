import { beforeEach, describe, expect, it, vi } from 'vitest'

const buildFailureProfileArtifacts = vi.fn()
const getToolReliabilityMap = vi.fn()
const classifyPdfFull = vi.fn()
const buildPipelineConfig = vi.fn()

vi.mock('../services/failureProfileService.js', () => ({
  buildFailureProfileArtifacts,
}))

vi.mock('../services/pdfClassificationService.js', () => ({
  classifyPdfFull,
  buildPipelineConfig,
}))

vi.mock('../services/toolReliabilityService.js', () => ({
  classifyPdf: () => 'untagged_digital',
  getToolReliabilityMap,
}))

vi.mock('../services/semanticEnrichmentService.js', () => ({
  hasSemanticRepairConfig: () => false,
  bookmarkTargets: () => [],
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
    classifyPdfFull.mockReturnValue({
      structuralClass: 'untagged_digital',
      contentProfile: {
        textDensity: 'normal',
        hasImages: true,
        hasComplexTables: false,
        hasSimpleTables: false,
        hasForms: false,
        hasLinks: false,
        hasFootnotes: false,
      },
      authoringTool: 'unknown',
      fontProfile: 'clean',
      scale: 'small',
      remediationDepth: 'moderate',
    })
    buildPipelineConfig.mockReturnValue({
      stages: {
        metadata: true,
        structureBootstrap: true,
        linkStructure: true,
        fonts: true,
        nativeStructure: true,
        safeCandidates: true,
      },
      excludedTools: [],
      maxRounds: 3,
      earlyExitScore: 98,
      semanticStrategy: 'full_ai',
    })
  })

  it('prioritizes the full font-convergence lane in deterministic order', async () => {
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '1',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'C',
        analysisScore: 70,
        veraPdfStatus: 'failed',
        veraPdfFailedChecks: 4,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [{
          key: 'pdfua.font_unicode',
          label: 'Font Unicode mapping',
          source: 'local_standards',
          count: 1,
          categoryIds: ['text_extractability', 'pdf_ua_compliance'],
          blocking: true,
          unmatched: false,
          classification: 'deterministic',
          nativeToolFamilies: [],
          evidence: [],
        }],
        residualFamilies: [{
          id: 'font_embedding_and_unicode',
          label: 'Font embedding and Unicode',
          priority: 30,
          blocking: true,
          blockingReason: 'blocking_failure_mode:pdfua.font_unicode',
          convergenceStatus: 'preferred_tools_available',
          semanticPolicy: 'forbidden',
          failureModeKeys: ['pdfua.font_unicode'],
          categoryIds: ['text_extractability', 'pdf_ua_compliance'],
          preferredTools: [
            'embed_missing_fonts_in_place',
            'repair_font_unicode_maps',
            'repair_type1_font_unicode_maps',
            'repair_truetype_encoding_differences',
            'repair_cid_symbol_font_maps',
            'repair_cidset_consistency',
            'substitute_legacy_fonts_in_place',
            'finalize_substituted_font_conformance',
          ],
          deprioritizedTools: [],
          expectedPostconditions: ['font_blocking_keys_shrink', 'font_counters_shrink'],
          activeOpportunityKeys: [],
          preferredAutoRunnableOpportunityKeys: [],
          currentStep: 1,
          evidenceSignals: ['blocking_failure_mode:pdfua.font_unicode'],
          evidenceStrength: 18,
          regressionCanaries: ['processed_font_cluster'],
        }],
        toolOpportunities: [
          'embed_missing_fonts_in_place',
          'repair_font_unicode_maps',
          'repair_type1_font_unicode_maps',
          'repair_truetype_encoding_differences',
          'repair_cid_symbol_font_maps',
          'repair_cidset_consistency',
          'substitute_legacy_fonts_in_place',
          'finalize_substituted_font_conformance',
        ].map((toolName, index) => ({
          key: `${toolName}:document:document`,
          toolName,
          reason: toolName,
          scope: 'document',
          candidateIds: [],
          candidateGroupIds: [],
          pageNumbers: [],
          categoryTargets: ['text_extractability'],
          confidence: 0.9 - index * 0.01,
          status: 'auto_runnable',
          derivedFromFailureModeKeys: ['pdfua.font_unicode'],
          familyId: 'font_embedding_and_unicode',
          familyStep: index + 1,
          expectedPostconditions: ['font_counters_shrink'],
        })),
        summary: {
          deterministicIssueCount: 1,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 8,
        },
      },
      plannerEvidence: {
        topFailureModeKeys: ['pdfua.font_unicode'],
        topAutoRunnableOpportunityKeys: [],
        topResidualFamilyIds: ['font_embedding_and_unicode'],
        topBlockingResidualFamilyIds: ['font_embedding_and_unicode'],
        topResidualFamilySummaries: [],
        skippedReasonCounts: [],
        attemptedKeys: [],
        rejectedKeys: [],
        noEffectKeys: [],
      },
    })

    const { planRemediationActions } = await import('../services/remediationPlanService.js')
    const plan = await planRemediationActions({
      filename: 'fonts.pdf',
      analysis: {
        overallScore: 70,
        grade: 'C',
        isScanned: false,
        categories: [{ id: 'text_extractability', label: 'Text Extractability', score: 40, severity: 'Critical' }],
      } as any,
      context: {
        pdfjs: { title: '', lang: '' },
        qpdf: { lang: '', hasStructTree: true, structTreeDepth: 1, formFields: [] },
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

    expect(plan.actions.map(action => action.tool_name)).toEqual([
      'embed_missing_fonts_in_place',
      'repair_font_unicode_maps',
      'repair_cid_symbol_font_maps',
      'repair_cidset_consistency',
    ])
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

  it('serializes the mixed structure and figure convergence path in the intended order', async () => {
    classifyPdfFull.mockReturnValue({
      structuralClass: 'partially_tagged',
      contentProfile: {
        textDensity: 'normal',
        hasImages: true,
        hasComplexTables: false,
        hasSimpleTables: false,
        hasForms: false,
        hasLinks: false,
        hasFootnotes: false,
      },
      authoringTool: 'unknown',
      fontProfile: 'clean',
      scale: 'small',
      remediationDepth: 'moderate',
    })
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '2',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'D',
        analysisScore: 65,
        veraPdfStatus: 'failed',
        veraPdfFailedChecks: 3,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [
          {
            key: 'pdfua.logical_structure',
            label: 'Logical structure',
            source: 'local_standards',
            count: 1,
            categoryIds: ['reading_order', 'pdf_ua_compliance'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: [],
            evidence: [],
          },
          {
            key: 'pdfua.figure_alt_or_artifact',
            label: 'Figure alt',
            source: 'local_standards',
            count: 1,
            categoryIds: ['alt_text', 'pdf_ua_compliance'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: [],
            evidence: [],
          },
        ],
        residualFamilies: [
          {
            id: 'logical_structure_marked_content',
            label: 'Logical structure',
            priority: 80,
            blocking: true,
            convergenceStatus: 'preferred_tools_available',
            semanticPolicy: 'forbidden',
            failureModeKeys: ['pdfua.logical_structure'],
            categoryIds: ['reading_order', 'pdf_ua_compliance'],
            preferredTools: ['normalize_heading_hierarchy', 'repair_native_marked_content_refs', 'repair_structure_conformance'],
            deprioritizedTools: [],
            expectedPostconditions: [],
            activeOpportunityKeys: [],
            preferredAutoRunnableOpportunityKeys: [],
            currentStep: 1,
            evidenceSignals: [],
            evidenceStrength: 10,
            regressionCanaries: [],
          },
          {
            id: 'native_figure_convergence',
            label: 'Figure convergence',
            priority: 60,
            blocking: true,
            convergenceStatus: 'preferred_tools_available',
            semanticPolicy: 'optional_after_deterministic',
            failureModeKeys: ['pdfua.figure_alt_or_artifact'],
            categoryIds: ['alt_text', 'pdf_ua_compliance'],
            preferredTools: ['normalize_nested_figure_containers', 'repair_native_figure_semantics', 'repair_other_elements_alt_text', 'set_figure_alt_text'],
            deprioritizedTools: [],
            expectedPostconditions: [],
            activeOpportunityKeys: [],
            preferredAutoRunnableOpportunityKeys: [],
            currentStep: 1,
            evidenceSignals: [],
            evidenceStrength: 9,
            regressionCanaries: [],
          },
        ],
        toolOpportunities: [
          'normalize_heading_hierarchy',
          'repair_native_marked_content_refs',
          'repair_structure_conformance',
          'normalize_nested_figure_containers',
          'repair_native_figure_semantics',
          'repair_other_elements_alt_text',
          'set_figure_alt_text',
        ].map((toolName, index) => ({
          key: `${toolName}:${index}`,
          toolName,
          reason: toolName,
          scope: toolName === 'set_figure_alt_text' ? 'candidate' : 'document',
          candidateIds: toolName === 'set_figure_alt_text' ? ['figure:1'] : [],
          candidateGroupIds: [],
          pageNumbers: [1],
          categoryTargets: toolName.includes('figure') || toolName.includes('alt') ? ['alt_text'] : ['reading_order'],
          confidence: 0.95 - (index * 0.01),
          status: 'auto_runnable',
          derivedFromFailureModeKeys: toolName.includes('figure') || toolName.includes('alt')
            ? ['pdfua.figure_alt_or_artifact']
            : ['pdfua.logical_structure'],
          familyId: toolName.includes('figure') || toolName.includes('alt')
            ? 'native_figure_convergence'
            : 'logical_structure_marked_content',
          familyStep: index + 1,
        })),
        summary: {
          deterministicIssueCount: 2,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 7,
          safeToRetry: true,
          dominantResidualFamily: 'logical_structure_marked_content',
          lastStableNoEffectTool: null,
          retryDisposition: 'retryable_deterministic',
          mixedFamilyConvergencePath: true,
        },
      },
      plannerEvidence: {
        topFailureModeKeys: ['pdfua.logical_structure', 'pdfua.figure_alt_or_artifact'],
        topResidualFamilyIds: ['logical_structure_marked_content', 'native_figure_convergence'],
        topBlockingResidualFamilyIds: ['logical_structure_marked_content', 'native_figure_convergence'],
        topAutoRunnableOpportunityKeys: [],
        skippedReasonCounts: [],
        attemptedKeys: [],
        rejectedKeys: [],
        noEffectKeys: [],
        mixedFamilyConvergencePath: true,
      },
    })

    const { planRemediationActions } = await import('../services/remediationPlanService.js')
    const plan = await planRemediationActions({
      filename: 'mixed.pdf',
      analysis: {
        overallScore: 65,
        grade: 'D',
        isScanned: false,
        pageCount: 12,
        categories: [
          { id: 'heading_structure', label: 'Heading', score: 65, severity: 'Moderate' },
          { id: 'reading_order', label: 'Reading', score: 60, severity: 'Moderate' },
          { id: 'alt_text', label: 'Alt', score: 50, severity: 'Critical' },
        ],
      } as any,
      context: {
        pdfjs: { title: '', lang: '' },
        qpdf: { lang: 'en', hasStructTree: true, structTreeDepth: 4, formFields: [] },
        headingCandidates: [],
        figureCandidates: [{ id: 'figure:1', pageNumber: 1, surroundingText: [], informativeHint: 'informative', repairMode: 'safe' }],
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
    })

    expect(plan.actions.map(action => action.tool_name)).toEqual([
      'normalize_heading_hierarchy',
      'repair_native_marked_content_refs',
      'repair_structure_conformance',
      'normalize_nested_figure_containers',
      'repair_native_figure_semantics',
      'repair_other_elements_alt_text',
      'set_figure_alt_text',
    ])
  })

  it('skips solved categories in round 2+ but preserves standards-only tools for unresolved compliance', async () => {
    classifyPdfFull.mockReturnValue({
      structuralClass: 'partially_tagged',
      contentProfile: {
        textDensity: 'normal',
        hasImages: false,
        hasComplexTables: false,
        hasSimpleTables: false,
        hasForms: false,
        hasLinks: false,
        hasFootnotes: false,
      },
      authoringTool: 'unknown',
      fontProfile: 'clean',
      scale: 'small',
      remediationDepth: 'polish',
    })
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

  it('suppresses broad structure tools on well-tagged documents', async () => {
    classifyPdfFull.mockReturnValue({
      structuralClass: 'well_tagged',
      contentProfile: {
        textDensity: 'dense',
        hasImages: true,
        hasComplexTables: false,
        hasSimpleTables: false,
        hasForms: false,
        hasLinks: false,
        hasFootnotes: false,
      },
      authoringTool: 'adobe_indesign',
      fontProfile: 'clean',
      scale: 'medium',
      remediationDepth: 'polish',
    })
    buildPipelineConfig.mockReturnValue({
      stages: {
        metadata: true,
        structureBootstrap: false,
        linkStructure: true,
        fonts: false,
        nativeStructure: true,
        safeCandidates: true,
      },
      excludedTools: ['bootstrap_struct_tree', 'repair_structure_conformance'],
      maxRounds: 2,
      earlyExitScore: 95,
      semanticStrategy: 'heuristic_only',
    })
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
            key: 'bootstrap',
            toolName: 'bootstrap_struct_tree',
            reason: 'Rebuild structure',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['heading_structure', 'alt_text'],
            confidence: 0.8,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.structure'],
          },
          {
            key: 'conformance',
            toolName: 'repair_structure_conformance',
            reason: 'Fix broad structure',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['pdf_ua_compliance'],
            confidence: 0.8,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.structure'],
          },
          {
            key: 'native-reading',
            toolName: 'repair_native_reading_order',
            reason: 'Fix reading order in place',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['reading_order'],
            confidence: 0.75,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.reading_order'],
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
      filename: 'well-tagged.pdf',
      analysis: {
        overallScore: 88,
        grade: 'B',
        isScanned: false,
        categories: [
          { id: 'reading_order', label: 'Reading Order', score: 70, severity: 'Moderate' },
          { id: 'pdf_ua_compliance', label: 'PDF/UA', score: 70, severity: 'Moderate' },
        ],
      } as any,
      context: {
        pdfjs: { title: '', lang: '' },
        qpdf: { lang: '', hasStructTree: true, structTreeDepth: 4, formFields: [] },
        headingCandidates: [],
        figureCandidates: [],
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
    })

    expect(plan.actions.map(action => action.tool_name)).toEqual(['repair_native_reading_order'])
    expect(plan.plannerEvidence.skippedReasonCounts.some(entry => entry.reason.includes('pipeline_excluded:repair_structure_conformance'))).toBe(true)
  })

  it('prefers narrow native repairs over broad conformance repair on native-tagged documents', async () => {
    classifyPdfFull.mockReturnValue({
      structuralClass: 'native_tagged',
      contentProfile: {
        textDensity: 'dense',
        hasImages: true,
        hasComplexTables: false,
        hasSimpleTables: false,
        hasForms: false,
        hasLinks: true,
        hasFootnotes: false,
      },
      authoringTool: 'adobe_indesign',
      fontProfile: 'clean',
      scale: 'medium',
      remediationDepth: 'moderate',
    })
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '1',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'C',
        analysisScore: 72,
        veraPdfStatus: 'failed',
        veraPdfFailedChecks: 2,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [{
          key: 'pdfua.logical_structure',
          label: 'Logical structure and marked content',
          source: 'verapdf',
          count: 1,
          categoryIds: ['reading_order', 'pdf_ua_compliance'],
          blocking: true,
          unmatched: false,
          classification: 'deterministic',
          nativeToolFamilies: [],
          evidence: [],
        }],
        toolOpportunities: [
          {
            key: 'conformance',
            toolName: 'repair_structure_conformance',
            reason: 'Fix broad structure',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['pdf_ua_compliance'],
            confidence: 0.8,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.logical_structure'],
          },
          {
            key: 'native-marked',
            toolName: 'repair_native_marked_content_refs',
            reason: 'Repair native marked content',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['reading_order', 'pdf_ua_compliance'],
            confidence: 0.82,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.logical_structure'],
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
      filename: 'native-tagged.pdf',
      analysis: {
        overallScore: 72,
        grade: 'C',
        isScanned: false,
        categories: [
          { id: 'reading_order', label: 'Reading Order', score: 60, severity: 'Moderate' },
          { id: 'pdf_ua_compliance', label: 'PDF/UA', score: 60, severity: 'Moderate' },
        ],
      } as any,
      context: {
        pdfjs: { title: '', lang: '' },
        qpdf: { lang: '', hasStructTree: true, structTreeDepth: 4, formFields: [] },
        headingCandidates: [],
        figureCandidates: [],
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
    })

    expect(plan.actions.map(action => action.tool_name)).toEqual(['repair_native_marked_content_refs'])
    expect(plan.actions.some(action => action.tool_name === 'repair_structure_conformance')).toBe(false)
  })

  it('prioritizes reading-order and group repairs before broad structure repair for Stage 4 survivors', async () => {
    classifyPdfFull.mockReturnValue({
      structuralClass: 'native_tagged',
      contentProfile: {
        textDensity: 'normal',
        hasImages: false,
        hasComplexTables: false,
        hasSimpleTables: false,
        hasForms: false,
        hasLinks: false,
        hasFootnotes: false,
      },
      authoringTool: 'adobe_acrobat',
      fontProfile: 'clean',
      scale: 'small',
      remediationDepth: 'moderate',
    })
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '1',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'B',
        analysisScore: 84,
        veraPdfStatus: 'failed',
        veraPdfFailedChecks: 2,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [
          {
            key: 'pdfua.logical_structure',
            label: 'Logical structure',
            source: 'verapdf',
            count: 1,
            categoryIds: ['reading_order', 'pdf_ua_compliance'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: ['repair_native_reading_order', 'repair_native_marked_content_refs', 'repair_structure_conformance'],
            evidence: [],
          },
          {
            key: 'category.reading_order',
            label: 'Reading order',
            source: 'category',
            count: 1,
            categoryIds: ['reading_order'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: ['repair_native_reading_order', 'reorder_structure_children'],
            evidence: [],
          },
        ],
        toolOpportunities: [
          {
            key: 'repair-conformance',
            toolName: 'repair_structure_conformance',
            reason: 'Fix broad structure',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['reading_order', 'pdf_ua_compliance'],
            confidence: 0.9,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.logical_structure'],
          },
          {
            key: 'repair-native-marked',
            toolName: 'repair_native_marked_content_refs',
            reason: 'Repair marked content',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['reading_order'],
            confidence: 0.88,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.logical_structure'],
          },
          {
            key: 'repair-native-reading',
            toolName: 'repair_native_reading_order',
            reason: 'Repair reading order',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['reading_order'],
            confidence: 0.87,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.reading_order', 'pdfua.logical_structure'],
          },
          {
            key: 'reorder-group',
            toolName: 'reorder_structure_children',
            reason: 'Normalize reading-order group',
            scope: 'candidate_group',
            candidateIds: [],
            candidateGroupIds: ['group-1'],
            pageNumbers: [1],
            categoryTargets: ['reading_order'],
            confidence: 0.8,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.reading_order'],
          },
        ],
        summary: {
          deterministicIssueCount: 2,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 4,
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
      filename: 'stage4-survivor.pdf',
      analysis: {
        overallScore: 84,
        grade: 'B',
        isScanned: false,
        categories: [
          { id: 'reading_order', label: 'Reading Order', score: 60, severity: 'Moderate' },
          { id: 'pdf_ua_compliance', label: 'PDF/UA', score: 70, severity: 'Moderate' },
        ],
      } as any,
      context: {
        pdfjs: { title: '', lang: '' },
        qpdf: { lang: '', hasStructTree: true, structTreeDepth: 4, formFields: [] },
        headingCandidates: [],
        figureCandidates: [],
        tableCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [{ id: 'group-1', parentRef: '12 0 R', suggestedChildCandidateIds: ['a', 'b'], mutableKids: true, pageNumberHints: [1] }],
        structure: { structuralNodes: [{ ref: '12 0 R' }] },
      } as any,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.map(action => action.tool_name)).toEqual([
      'repair_native_reading_order',
      'reorder_structure_children',
      'repair_native_marked_content_refs',
    ])
  })

  it('skips low-reliability tools when a blocking alternative exists for the same failure family', async () => {
    classifyPdfFull.mockReturnValue({
      structuralClass: 'native_tagged',
      contentProfile: {
        textDensity: 'normal',
        hasImages: false,
        hasComplexTables: false,
        hasSimpleTables: false,
        hasForms: false,
        hasLinks: false,
        hasFootnotes: false,
      },
      authoringTool: 'adobe_acrobat',
      fontProfile: 'clean',
      scale: 'small',
      remediationDepth: 'moderate',
    })
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '1',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'B',
        analysisScore: 84,
        veraPdfStatus: 'failed',
        veraPdfFailedChecks: 2,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [
          {
            key: 'pdfua.logical_structure',
            label: 'Logical structure',
            source: 'verapdf',
            count: 1,
            categoryIds: ['reading_order', 'pdf_ua_compliance'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: ['repair_native_reading_order', 'repair_native_marked_content_refs', 'repair_structure_conformance'],
            evidence: [],
          },
          {
            key: 'category.reading_order',
            label: 'Reading order',
            source: 'category',
            count: 1,
            categoryIds: ['reading_order'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: ['repair_native_reading_order', 'reorder_structure_children'],
            evidence: [],
          },
        ],
        toolOpportunities: [
          {
            key: 'repair-conformance',
            toolName: 'repair_structure_conformance',
            reason: 'Fix broad structure',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['reading_order', 'pdf_ua_compliance'],
            confidence: 0.9,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.logical_structure'],
          },
          {
            key: 'repair-native-marked',
            toolName: 'repair_native_marked_content_refs',
            reason: 'Repair marked content',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['reading_order'],
            confidence: 0.88,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.logical_structure'],
          },
          {
            key: 'repair-native-reading',
            toolName: 'repair_native_reading_order',
            reason: 'Repair reading order',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['reading_order'],
            confidence: 0.87,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.reading_order', 'pdfua.logical_structure'],
          },
          {
            key: 'reorder-group',
            toolName: 'reorder_structure_children',
            reason: 'Normalize reading-order group',
            scope: 'candidate_group',
            candidateIds: [],
            candidateGroupIds: ['group-1'],
            pageNumbers: [1],
            categoryTargets: ['reading_order'],
            confidence: 0.8,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.reading_order'],
          },
        ],
        summary: {
          deterministicIssueCount: 2,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 4,
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
      filename: 'stage4-survivor.pdf',
      analysis: {
        overallScore: 84,
        grade: 'B',
        isScanned: false,
        categories: [
          { id: 'reading_order', label: 'Reading Order', score: 60, severity: 'Moderate' },
          { id: 'pdf_ua_compliance', label: 'PDF/UA', score: 70, severity: 'Moderate' },
        ],
      } as any,
      context: {
        pdfjs: { title: '', lang: '' },
        qpdf: { lang: '', hasStructTree: true, structTreeDepth: 4, formFields: [] },
        headingCandidates: [],
        figureCandidates: [],
        tableCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [{ id: 'group-1', parentRef: '12 0 R', suggestedChildCandidateIds: ['a', 'b'], mutableKids: true, pageNumberHints: [1] }],
        structure: { structuralNodes: [{ ref: '12 0 R' }] },
      } as any,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.map(action => action.tool_name).slice(0, 2)).toEqual([
      'repair_native_reading_order',
      'reorder_structure_children',
    ])
    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool_name: 'repair_native_marked_content_refs' }),
    ]))
  })

  it('skips low-reliability tools when a blocking alternative exists for the same failure family', async () => {
    getToolReliabilityMap.mockReturnValue(new Map([
      ['repair_native_marked_content_refs', { reliability: 0.2, source: 'tool_and_class' }],
      ['repair_structure_conformance', { reliability: 0.9, source: 'tool_and_class' }],
    ]))
    classifyPdfFull.mockReturnValue({
      structuralClass: 'partially_tagged',
      contentProfile: {
        textDensity: 'normal',
        hasImages: false,
        hasComplexTables: false,
        hasSimpleTables: false,
        hasForms: false,
        hasLinks: false,
        hasFootnotes: false,
      },
      authoringTool: 'unknown',
      fontProfile: 'clean',
      scale: 'small',
      remediationDepth: 'moderate',
    })
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '1',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'C',
        analysisScore: 70,
        veraPdfStatus: 'failed',
        veraPdfFailedChecks: 1,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [{
          key: 'pdfua.logical_structure',
          label: 'Logical structure and marked content',
          source: 'verapdf',
          count: 1,
          categoryIds: ['reading_order', 'pdf_ua_compliance'],
          blocking: true,
          unmatched: false,
          classification: 'deterministic',
          nativeToolFamilies: [],
          evidence: [],
        }],
        toolOpportunities: [
          {
            key: 'native-marked',
            toolName: 'repair_native_marked_content_refs',
            reason: 'Repair native marked content',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['reading_order', 'pdf_ua_compliance'],
            confidence: 0.9,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.logical_structure'],
          },
          {
            key: 'conformance',
            toolName: 'repair_structure_conformance',
            reason: 'Repair broad structure',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['pdf_ua_compliance'],
            confidence: 0.85,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.logical_structure'],
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
      filename: 'reliability.pdf',
      analysis: {
        overallScore: 70,
        grade: 'C',
        isScanned: false,
        categories: [
          { id: 'reading_order', label: 'Reading Order', score: 60, severity: 'Moderate' },
          { id: 'pdf_ua_compliance', label: 'PDF/UA', score: 60, severity: 'Moderate' },
        ],
      } as any,
      context: {
        pdfjs: { title: '', lang: '' },
        qpdf: { lang: '', hasStructTree: true, structTreeDepth: 2, formFields: [] },
        headingCandidates: [],
        figureCandidates: [],
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
    })

    expect(plan.actions.map(action => action.tool_name)).toEqual(['repair_structure_conformance'])
    expect(plan.plannerEvidence.skippedReasonCounts.some(entry => entry.reason === 'low_class_reliability:repair_native_marked_content_refs')).toBe(true)
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

  it('selects document-level heading normalization before per-candidate heading creation when an existing heading tree needs repair', async () => {
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '1',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'A',
        analysisScore: 94,
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
            blocking: false,
            unmatched: false,
            classification: 'semantic',
            nativeToolFamilies: [],
            evidence: ['Found 5 heading tags, but hierarchy has gaps'],
          },
        ],
        toolOpportunities: [
          {
            key: 'normalize-heading-hierarchy',
            toolName: 'normalize_heading_hierarchy',
            reason: 'Normalize existing heading levels.',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['heading_structure'],
            confidence: 0.92,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.heading_structure'],
          },
          {
            key: 'heading-1',
            toolName: 'create_heading_from_candidate',
            reason: 'Create heading 1',
            scope: 'candidate',
            candidateIds: ['heading:1:1'],
            candidateGroupIds: [],
            pageNumbers: [1],
            categoryTargets: ['heading_structure'],
            confidence: 0.7,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.heading_structure'],
          },
        ],
        summary: {
          deterministicIssueCount: 0,
          semanticIssueCount: 1,
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
      filename: 'legacy-headings.pdf',
      analysis: {
        overallScore: 94,
        grade: 'A',
        isScanned: false,
        pageCount: 25,
        categories: [
          { id: 'heading_structure', label: 'Heading', score: 60, severity: 'Moderate' },
        ],
      } as any,
      context: {
        pdfjs: { title: '', lang: '', links: [] },
        qpdf: {
          lang: 'en',
          hasStructTree: true,
          structTreeDepth: 6,
          formFields: [],
          headings: [
            { level: 'H1', tag: '/H1' },
            { level: 'H4', tag: '/heading 4' },
            { level: 'H9', tag: '/heading 9' },
          ],
        },
        headingCandidates: [
          {
            id: 'heading:1:1',
            pageNumber: 1,
            text: 'Heading 1',
            nearbyContext: [],
            targetRef: 'obj:500 0 R',
            existingTag: '/P',
            repairMode: 'safe',
          },
        ],
        figureCandidates: [],
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
    })

    expect(plan.actions[0]?.tool_name).toBe('normalize_heading_hierarchy')
  })

  it('prioritizes long-report metadata normalization ahead of heading candidate floods', async () => {
    const headingOpportunities = Array.from({ length: 6 }, (_, index) => ({
      key: `heading-${index}`,
      toolName: 'create_heading_from_candidate',
      reason: `Create heading ${index}`,
      scope: 'candidate',
      candidateIds: [`heading:${index}`],
      candidateGroupIds: [],
      pageNumbers: [index + 1],
      categoryTargets: ['heading_structure'],
      confidence: 0.72,
      status: 'auto_runnable',
      derivedFromFailureModeKeys: ['category.heading_structure'],
    }))

    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '2',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'F',
        analysisScore: 33,
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
            key: 'category.title_language',
            label: 'Title and Language',
            source: 'category',
            count: 1,
            categoryIds: ['title_language'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: [],
            evidence: [],
          },
          {
            key: 'pdfua.metadata_identification',
            label: 'Metadata identification',
            source: 'local_standards',
            count: 1,
            categoryIds: ['title_language', 'pdf_ua_compliance'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: ['set_pdfua_identification', 'normalize_document_metadata'],
            evidence: [],
          },
        ],
        toolOpportunities: [
          {
            key: 'set_pdfua_identification:document',
            toolName: 'set_pdfua_identification',
            reason: 'Set identification',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['title_language', 'pdf_ua_compliance'],
            confidence: 0.9,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.metadata_identification'],
          },
          {
            key: 'normalize_document_metadata:document',
            toolName: 'normalize_document_metadata',
            reason: 'Normalize metadata',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['title_language'],
            confidence: 0.88,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.title_language', 'pdfua.metadata_identification'],
          },
          ...headingOpportunities,
        ],
        summary: {
          deterministicIssueCount: 2,
          semanticIssueCount: 1,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 8,
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
      filename: '1988-1989_Biennial_Report.pdf',
      analysis: {
        overallScore: 33,
        grade: 'F',
        isScanned: false,
        pageCount: 28,
        categories: [
          { id: 'title_language', label: 'Title', score: 35, severity: 'Critical' },
          { id: 'heading_structure', label: 'Headings', score: 40, severity: 'Critical' },
          { id: 'pdf_ua_compliance', label: 'PDF/UA', score: 35, severity: 'Critical' },
        ],
      } as any,
      context: {
        pdfjs: { title: '', lang: '', links: [] },
        qpdf: { lang: '', hasStructTree: true, structTreeDepth: 4, formFields: [] },
        headingCandidates: headingOpportunities.map((_, index) => ({
          id: `heading:${index}`,
          pageNumber: index + 1,
          text: `Heading ${index}`,
          nearbyContext: [],
          targetRef: `obj:${100 + index} 0 R`,
          existingTag: '/P',
          repairMode: 'safe',
        })),
        figureCandidates: [],
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
    })

    expect(plan.actions[0]?.tool_name).toBe('set_pdfua_identification')
    expect(plan.actions[1]?.tool_name).toBe('normalize_document_metadata')
  })

  it('prioritizes long-report figure cleanup ahead of bounded candidate-level figure work', async () => {
    classifyPdfFull.mockReturnValue({
      structuralClass: 'native_tagged',
      contentProfile: {
        textDensity: 'normal',
        hasImages: true,
        hasComplexTables: false,
        hasSimpleTables: false,
        hasForms: false,
        hasLinks: false,
        hasFootnotes: false,
      },
      authoringTool: 'unknown',
      fontProfile: 'clean',
      scale: 'large',
      remediationDepth: 'moderate',
    })

    const figureOpportunities = Array.from({ length: 6 }, (_, index) => ({
      key: `set_figure_alt_text:candidate:${index + 1}`,
      toolName: 'set_figure_alt_text',
      reason: `Repair figure ${index + 1}`,
      scope: 'candidate',
      candidateIds: [`figure:${index + 1}`],
      candidateGroupIds: [],
      pageNumbers: [index + 1],
      categoryTargets: ['alt_text'],
      confidence: 0.7,
      status: 'auto_runnable',
      derivedFromFailureModeKeys: ['context.long_report_figure_residue'],
    }))

    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '2',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'B',
        analysisScore: 89,
        veraPdfStatus: 'unavailable',
        veraPdfFailedChecks: 0,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [
          {
            key: 'context.long_report_figure_residue',
            label: 'Long-report figure cleanup residue remains',
            source: 'context',
            count: 1,
            categoryIds: ['alt_text', 'pdf_ua_compliance'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: ['repair_native_figure_semantics', 'repair_other_elements_alt_text', 'set_figure_alt_text'],
            evidence: [],
          },
        ],
        toolOpportunities: [
          {
            key: 'repair_native_figure_semantics:document',
            toolName: 'repair_native_figure_semantics',
            reason: 'Repair native figure semantics',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['alt_text'],
            confidence: 0.9,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['context.long_report_figure_residue'],
          },
          {
            key: 'repair_other_elements_alt_text:document',
            toolName: 'repair_other_elements_alt_text',
            reason: 'Repair Acrobat ownership residue',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['alt_text'],
            confidence: 0.88,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['context.long_report_figure_residue'],
          },
          ...figureOpportunities,
        ],
        summary: {
          deterministicIssueCount: 1,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 8,
        },
      },
      plannerEvidence: {
        topFailureModeKeys: ['context.long_report_figure_residue'],
        topBlockingFailureModeKeys: ['context.long_report_figure_residue'],
        topManualOnlyFailureModeKeys: [],
        topAutoRunnableOpportunityKeys: ['repair_native_figure_semantics:document'],
        skippedReasonCounts: [],
        attemptedKeys: [],
        rejectedKeys: [],
        noEffectKeys: [],
        attemptedOpportunityKeys: [],
        rejectedOpportunityKeys: [],
        noEffectOpportunityKeys: [],
        statusCounts: [{ status: 'auto_runnable', count: 8 }],
        reasonCodeCounts: [{ reasonCode: 'safe_to_run', count: 8 }],
      },
    })

    const { planRemediationActions } = await import('../services/remediationPlanService.js')
    const plan = await planRemediationActions({
      filename: '1998_Madison.pdf',
      analysis: {
        overallScore: 89,
        grade: 'B',
        isScanned: false,
        pageCount: 40,
        categories: [
          { id: 'alt_text', label: 'Alt text', score: 50, severity: 'Critical' },
          { id: 'pdf_ua_compliance', label: 'PDF/UA', score: 89, severity: 'Moderate' },
        ],
      } as any,
      context: {
        pdfjs: { title: 'Report', lang: 'en', links: [] },
        qpdf: { lang: 'en', hasStructTree: true, structTreeDepth: 6, formFields: [] },
        headingCandidates: [],
        figureCandidates: figureOpportunities.map((_, index) => ({
          id: `figure:${index + 1}`,
          pageNumber: index + 1,
          targetRef: `obj:${200 + index} 0 R`,
          surroundingText: ['Chart summary'],
          informativeHint: 'informative',
          repairMode: 'set_alt',
          targetTag: '/Figure',
          parentTagPath: [],
          pageImageCount: 1,
          textDensityHint: 'low',
          imageEvidence: 'strong',
        })),
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
    })

    expect(plan.actions.slice(0, 2).map(action => action.tool_name)).toEqual([
      'repair_native_figure_semantics',
      'repair_other_elements_alt_text',
    ])
    expect(plan.actions.filter(action => action.tool_name === 'set_figure_alt_text')).toHaveLength(5)
  })

  it('prioritizes native structure convergence ahead of bookmark replacement after heading creation', async () => {
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '2',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'D',
        analysisScore: 55,
        veraPdfStatus: 'unavailable',
        veraPdfFailedChecks: 0,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [
          {
            key: 'context.post_heading_creation_native_structure_debt',
            label: 'Post heading creation debt',
            source: 'context',
            count: 1,
            categoryIds: ['heading_structure', 'pdf_ua_compliance'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: ['repair_native_marked_content_refs', 'repair_structure_conformance'],
            evidence: [],
          },
        ],
        toolOpportunities: [
          {
            key: 'normalize_heading_hierarchy:document',
            toolName: 'normalize_heading_hierarchy',
            reason: 'Normalize heading hierarchy',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['heading_structure'],
            confidence: 0.9,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['context.post_heading_creation_native_structure_debt'],
          },
          {
            key: 'repair_native_marked_content_refs:document',
            toolName: 'repair_native_marked_content_refs',
            reason: 'Repair marked content refs',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['heading_structure', 'pdf_ua_compliance'],
            confidence: 0.85,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['context.post_heading_creation_native_structure_debt'],
          },
          {
            key: 'replace_bookmarks_from_headings:document',
            toolName: 'replace_bookmarks_from_headings',
            reason: 'Replace bookmarks',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['bookmarks'],
            confidence: 0.6,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.bookmarks'],
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
      filename: '1993-1994_Biennial_Report.pdf',
      analysis: {
        overallScore: 55,
        grade: 'D',
        isScanned: false,
        pageCount: 30,
        categories: [
          { id: 'heading_structure', label: 'Headings', score: 50, severity: 'Critical' },
          { id: 'pdf_ua_compliance', label: 'PDF/UA', score: 55, severity: 'Critical' },
          { id: 'bookmarks', label: 'Bookmarks', score: 0, severity: 'Critical' },
        ],
      } as any,
      context: {
        pdfjs: { title: 'Biennial', lang: 'en', hasText: true, textLength: 40000, imageCount: 2, links: [] },
        qpdf: { lang: 'en', hasStructTree: true, hasMarkInfo: true, structTreeDepth: 4, headings: [{ level: 'H1', tag: '/H1' }], images: [], formFields: [] },
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
      actions: [{ tool: 'create_heading_from_candidate', target: 'page 1', outcome: 'applied' }] as any,
      rejectedActions: [],
    })

    expect(['normalize_heading_hierarchy', 'repair_native_marked_content_refs']).toContain(plan.actions[0]?.tool_name)
    expect(plan.actions.some(action => action.tool_name === 'replace_bookmarks_from_headings')).toBe(false)
  })

  it('prioritizes post-bootstrap native structure convergence ahead of bookmark cleanup', async () => {
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '2',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'C',
        analysisScore: 72,
        veraPdfStatus: 'unavailable',
        veraPdfFailedChecks: 0,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [
          {
            key: 'context.post_bootstrap_native_structure_debt',
            label: 'Post-bootstrap native structure debt remains',
            source: 'context',
            count: 1,
            categoryIds: ['heading_structure', 'reading_order', 'pdf_ua_compliance'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: ['normalize_heading_hierarchy', 'repair_native_marked_content_refs', 'repair_structure_conformance'],
            evidence: ['Bootstrap added headings, but native structure debt remains.'],
          },
          {
            key: 'category.bookmarks',
            label: 'Bookmarks',
            source: 'category',
            count: 1,
            categoryIds: ['bookmarks'],
            blocking: false,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: ['replace_bookmarks_from_headings'],
            evidence: ['Missing bookmarks'],
          },
        ],
        toolOpportunities: [
          {
            key: 'normalize-headings',
            toolName: 'normalize_heading_hierarchy',
            reason: 'Normalize headings',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['heading_structure'],
            confidence: 0.92,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['context.post_bootstrap_native_structure_debt'],
          },
          {
            key: 'replace-bookmarks',
            toolName: 'replace_bookmarks_from_headings',
            reason: 'Build bookmarks',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['bookmarks'],
            confidence: 0.55,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.bookmarks'],
          },
        ],
        summary: {
          deterministicIssueCount: 2,
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
      filename: 'biennial.pdf',
      analysis: {
        overallScore: 72,
        grade: 'C',
        isScanned: false,
        pageCount: 24,
        categories: [
          { id: 'heading_structure', label: 'Heading', score: 60, severity: 'Moderate' },
          { id: 'pdf_ua_compliance', label: 'PDF/UA', score: 40, severity: 'Moderate' },
          { id: 'bookmarks', label: 'Bookmarks', score: 0, severity: 'Moderate' },
        ],
      } as any,
      context: {
        pdfjs: { title: '', lang: '', links: [] },
        qpdf: {
          lang: 'en',
          hasStructTree: true,
          structTreeDepth: 5,
          formFields: [],
          headings: [{ level: 'H1', tag: '/H1' }],
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
      actions: [{
        tool: 'bootstrap_struct_tree',
        target: 'document',
        details: 'Augmented existing structure tree under obj:360 0 R.',
        confidence: 0.9,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        outcome: 'applied',
      }] as any,
      rejectedActions: [],
    })

    expect(plan.actions[0]?.tool_name).toBe('normalize_heading_hierarchy')
    expect(plan.actions.some(action => action.tool_name === 'replace_bookmarks_from_headings')).toBe(false)
  })

  it('prioritizes post-bootstrap structural residue cleanup ahead of repeated bootstrap', async () => {
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '2',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'F',
        analysisScore: 33,
        veraPdfStatus: 'unavailable',
        veraPdfFailedChecks: 0,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [
          {
            key: 'context.post_bootstrap_structural_residue',
            label: 'Post-bootstrap structural residue remains',
            source: 'context',
            count: 2,
            categoryIds: ['heading_structure', 'reading_order', 'pdf_ua_compliance'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: ['artifact_nonsemantic_page_elements', 'repair_bootstrapped_chart_content_refs', 'repair_native_marked_content_refs', 'repair_structure_conformance'],
            evidence: ['Bootstrap residue remains.'],
          },
        ],
        toolOpportunities: [
          {
            key: 'bootstrap',
            toolName: 'bootstrap_struct_tree',
            reason: 'Repeat bootstrap',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['heading_structure'],
            confidence: 0.9,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.heading_structure'],
          },
          {
            key: 'artifact',
            toolName: 'artifact_nonsemantic_page_elements',
            reason: 'Artifact nonsemantic elements',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['heading_structure', 'pdf_ua_compliance'],
            confidence: 0.93,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['context.post_bootstrap_structural_residue'],
          },
          {
            key: 'chart-refs',
            toolName: 'repair_bootstrapped_chart_content_refs',
            reason: 'Repair chart refs',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['heading_structure', 'pdf_ua_compliance'],
            confidence: 0.91,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['context.post_bootstrap_structural_residue'],
          },
          {
            key: 'native-marked',
            toolName: 'repair_native_marked_content_refs',
            reason: 'Repair marked-content refs',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['heading_structure', 'reading_order'],
            confidence: 0.88,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['context.post_bootstrap_structural_residue'],
          },
          {
            key: 'heading-normalization',
            toolName: 'normalize_heading_hierarchy',
            reason: 'Normalize heading hierarchy after artifact cleanup',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['heading_structure', 'pdf_ua_compliance'],
            confidence: 0.89,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['context.post_bootstrap_structural_residue', 'category.heading_structure'],
          },
          {
            key: 'conformance',
            toolName: 'repair_structure_conformance',
            reason: 'Repair structure conformance',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['heading_structure', 'reading_order'],
            confidence: 0.8,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['context.post_bootstrap_structural_residue', 'pdfua.logical_structure'],
          },
        ],
        summary: {
          deterministicIssueCount: 1,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 5,
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
      filename: 'biennial-residue.pdf',
      analysis: {
        overallScore: 33,
        grade: 'F',
        isScanned: false,
        pageCount: 28,
        categories: [
          { id: 'heading_structure', label: 'Heading', score: 40, severity: 'Critical' },
          { id: 'reading_order', label: 'Reading', score: 40, severity: 'Critical' },
          { id: 'pdf_ua_compliance', label: 'PDF/UA', score: 20, severity: 'Critical' },
        ],
      } as any,
      context: {
        pdfjs: { title: '', lang: '', links: [] },
        qpdf: {
          lang: 'en',
          hasStructTree: true,
          structTreeDepth: 5,
          formFields: [],
          headings: [{ level: 'H1', tag: '/H1' }],
        },
        headingCandidates: [],
        figureCandidates: [],
        tableCandidates: [],
        pages: [{ imageCount: 1, graphics: [{}, {}], textLines: [{ text: 'A' }, { text: 'B' }] }],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: { structuralNodes: [{ ref: '1 0 R' }] },
      } as any,
      iteration: 2,
      actions: [{
        tool: 'bootstrap_struct_tree',
        target: 'document',
        details: 'Augmented existing structure tree.',
        confidence: 0.9,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: true,
        outcome: 'applied',
      }] as any,
      rejectedActions: [],
    })

    expect(new Set(plan.actions.slice(0, 2).map(action => action.tool_name))).toEqual(new Set([
      'artifact_nonsemantic_page_elements',
      'repair_bootstrapped_chart_content_refs',
    ]))
    expect(plan.actions[2]?.tool_name).toBe('normalize_heading_hierarchy')
    const nativeMarkedIndex = plan.actions.findIndex(action => action.tool_name === 'repair_native_marked_content_refs')
    const headingNormalizationIndex = plan.actions.findIndex(action => action.tool_name === 'normalize_heading_hierarchy')
    expect(nativeMarkedIndex === -1 || nativeMarkedIndex > headingNormalizationIndex).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'bootstrap_struct_tree')).toBe(false)
  })

  it('does not plan finalize_substituted_font_conformance before legacy substitution has run', async () => {
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

    expect(plan.actions.some(action => action.tool_name === 'finalize_substituted_font_conformance')).toBe(false)
  })

  it('does not repeat generic font unicode repair after a no-effect attempt', async () => {
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '2',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'B',
        analysisScore: 84,
        veraPdfStatus: 'failed',
        veraPdfFailedChecks: 1,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [
          {
            key: 'pdfua.font_unicode',
            label: 'Font Unicode mapping',
            source: 'local_standards',
            count: 4,
            categoryIds: ['text_extractability', 'pdf_ua_compliance'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: ['repair_font_unicode_maps'],
            evidence: [],
          },
        ],
        toolOpportunities: [
          {
            key: 'font-unicode',
            toolName: 'repair_font_unicode_maps',
            reason: 'Repair font Unicode maps',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['text_extractability'],
            confidence: 0.9,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.font_unicode'],
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
      filename: 'font-repeat.pdf',
      analysis: {
        overallScore: 84,
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
          unembeddedFontCount: 0,
          fontsMissingToUnicode: 4,
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
        { tool: 'repair_font_unicode_maps', outcome: 'no_effect' },
      ] as any,
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'repair_font_unicode_maps')).toBe(false)
  })

  it('prioritizes residual family order ahead of raw tool stage ordering', async () => {
    classifyPdfFull.mockReturnValue({
      structuralClass: 'partially_tagged',
      contentProfile: {
        textDensity: 'normal',
        hasImages: false,
        hasComplexTables: false,
        hasSimpleTables: false,
        hasForms: false,
        hasLinks: false,
        hasFootnotes: false,
      },
      authoringTool: 'unknown',
      fontProfile: 'clean',
      scale: 'small',
      remediationDepth: 'moderate',
    })
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '2',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'C',
        analysisScore: 70,
        veraPdfStatus: 'failed',
        veraPdfFailedChecks: 4,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [
          {
            key: 'category.heading_structure',
            label: 'Heading structure',
            source: 'category',
            count: 1,
            categoryIds: ['heading_structure'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: ['normalize_heading_hierarchy'],
            evidence: [],
          },
          {
            key: 'pdfua.logical_structure',
            label: 'Logical structure',
            source: 'verapdf',
            count: 1,
            categoryIds: ['reading_order', 'pdf_ua_compliance'],
            blocking: true,
            unmatched: false,
            classification: 'deterministic',
            nativeToolFamilies: ['repair_native_marked_content_refs'],
            evidence: [],
          },
        ],
        residualFamilies: [
          {
            id: 'post_bootstrap_heading_convergence',
            label: 'Post-bootstrap heading convergence',
            priority: 70,
            blocking: true,
            semanticPolicy: 'optional_after_deterministic',
            failureModeKeys: ['category.heading_structure'],
            categoryIds: ['heading_structure'],
            preferredTools: ['normalize_heading_hierarchy'],
            deprioritizedTools: ['repair_native_marked_content_refs'],
            expectedPostconditions: ['heading_structure_improves'],
            activeOpportunityKeys: ['heading'],
            currentStep: 1,
            regressionCanaries: [],
          },
          {
            id: 'logical_structure_marked_content',
            label: 'Logical structure and marked content',
            priority: 80,
            blocking: true,
            semanticPolicy: 'forbidden',
            failureModeKeys: ['pdfua.logical_structure'],
            categoryIds: ['reading_order'],
            preferredTools: ['repair_native_marked_content_refs'],
            deprioritizedTools: [],
            expectedPostconditions: ['logical_structure_blocking_keys_shrink'],
            activeOpportunityKeys: ['marked-content'],
            currentStep: 1,
            regressionCanaries: [],
          },
        ],
        toolOpportunities: [
          {
            key: 'marked-content',
            toolName: 'repair_native_marked_content_refs',
            reason: 'Repair native marked content',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['reading_order'],
            confidence: 0.95,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.logical_structure'],
            familyId: 'logical_structure_marked_content',
            familyStep: 1,
            expectedPostconditions: ['logical_structure_blocking_keys_shrink'],
          },
          {
            key: 'heading',
            toolName: 'normalize_heading_hierarchy',
            reason: 'Normalize heading hierarchy',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['heading_structure'],
            confidence: 0.8,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['category.heading_structure'],
            familyId: 'post_bootstrap_heading_convergence',
            familyStep: 1,
            expectedPostconditions: ['heading_structure_improves'],
          },
        ],
        summary: {
          deterministicIssueCount: 2,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 2,
        },
      },
      plannerEvidence: {
        topFailureModeKeys: [],
        topResidualFamilyIds: ['post_bootstrap_heading_convergence', 'logical_structure_marked_content'],
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
        overallScore: 70,
        grade: 'C',
        isScanned: false,
        categories: [
          { id: 'heading_structure', label: 'Heading Structure', score: 55, severity: 'Moderate' },
          { id: 'reading_order', label: 'Reading Order', score: 80, severity: 'Moderate' },
          { id: 'pdf_ua_compliance', label: 'PDF/UA', score: 80, severity: 'Moderate' },
        ],
      } as any,
      context: {
        pdfjs: { title: '', lang: 'en' },
        qpdf: { lang: 'en', hasStructTree: true, structTreeDepth: 2, formFields: [], headings: [] },
        headingCandidates: [],
        figureCandidates: [],
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
    })

    expect(plan.actions[0]?.tool_name).toBe('normalize_heading_hierarchy')
  })

  it('prefers candidate-scoped table header repair over document-level native repair for table regularity', async () => {
    classifyPdfFull.mockReturnValue({
      structuralClass: 'native_tagged',
      contentProfile: {
        textDensity: 'normal',
        hasImages: false,
        hasComplexTables: true,
        hasSimpleTables: true,
        hasForms: false,
        hasLinks: false,
        hasFootnotes: false,
      },
      authoringTool: 'unknown',
      fontProfile: 'clean',
      scale: 'small',
      remediationDepth: 'moderate',
    })
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '1',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'C',
        analysisScore: 83,
        veraPdfStatus: 'failed',
        veraPdfFailedChecks: 3,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [{
          key: 'pdfua.table_regularity',
          label: 'Table regularity',
          source: 'local_standards',
          count: 1,
          categoryIds: ['table_markup', 'pdf_ua_compliance'],
          blocking: true,
          unmatched: false,
          classification: 'deterministic',
          nativeToolFamilies: ['repair_native_table_headers', 'set_table_header_cells'],
          evidence: [],
        }],
        toolOpportunities: [
          {
            key: 'table-doc',
            toolName: 'repair_native_table_headers',
            reason: 'Repair native headers at document scope',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['table_markup'],
            confidence: 0.9,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.table_regularity'],
          },
          {
            key: 'table-candidate-1',
            toolName: 'set_table_header_cells',
            reason: 'Repair table 1 header cells',
            scope: 'candidate',
            candidateIds: ['table:1'],
            candidateGroupIds: [],
            pageNumbers: [1],
            categoryTargets: ['table_markup'],
            confidence: 0.92,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.table_regularity'],
          },
        ],
        summary: {
          deterministicIssueCount: 1,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 2,
        },
        residualFamilies: [],
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
      filename: 'tables.pdf',
      analysis: {
        overallScore: 83,
        grade: 'B',
        isScanned: false,
        pageCount: 10,
        categories: [{ id: 'table_markup', label: 'Table Markup', score: 40, severity: 'Moderate' }],
      } as any,
      context: {
        pdfjs: { title: '', lang: '' },
        qpdf: { lang: '', hasStructTree: true, structTreeDepth: 2, formFields: [] },
        headingCandidates: [],
        figureCandidates: [],
        tableCandidates: [{ id: 'table:1', ref: 'obj:465 0 R' }],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: { structuralNodes: [{ ref: 'obj:1 0 R' }] },
      } as any,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'set_table_header_cells')).toBe(true)
    expect(plan.actions.some(action => action.tool_name === 'repair_native_table_headers')).toBe(false)
  })

  it('keeps document-level native table repair as fallback when candidate table routes are rejected', async () => {
    classifyPdfFull.mockReturnValue({
      structuralClass: 'native_tagged',
      contentProfile: {
        textDensity: 'normal',
        hasImages: false,
        hasComplexTables: true,
        hasSimpleTables: true,
        hasForms: false,
        hasLinks: false,
        hasFootnotes: false,
      },
      authoringTool: 'unknown',
      fontProfile: 'clean',
      scale: 'small',
      remediationDepth: 'moderate',
    })
    buildFailureProfileArtifacts.mockReturnValue({
      failureProfile: {
        version: '1',
        generatedAt: new Date().toISOString(),
        analysisGrade: 'C',
        analysisScore: 83,
        veraPdfStatus: 'failed',
        veraPdfFailedChecks: 3,
        adobeStatus: 'unavailable',
        adobeIssueCount: 0,
        failureModes: [{
          key: 'pdfua.table_regularity',
          label: 'Table regularity',
          source: 'local_standards',
          count: 1,
          categoryIds: ['table_markup', 'pdf_ua_compliance'],
          blocking: true,
          unmatched: false,
          classification: 'deterministic',
          nativeToolFamilies: ['repair_native_table_headers', 'set_table_header_cells'],
          evidence: [],
        }],
        toolOpportunities: [
          {
            key: 'table-doc',
            toolName: 'repair_native_table_headers',
            reason: 'Repair native headers at document scope',
            scope: 'document',
            candidateIds: [],
            candidateGroupIds: [],
            pageNumbers: [],
            categoryTargets: ['table_markup'],
            confidence: 0.9,
            status: 'auto_runnable',
            derivedFromFailureModeKeys: ['pdfua.table_regularity'],
          },
          {
            key: 'table-candidate-1',
            toolName: 'set_table_header_cells',
            reason: 'Repair table 1 header cells',
            scope: 'candidate',
            candidateIds: ['table:1'],
            candidateGroupIds: [],
            pageNumbers: [1],
            categoryTargets: ['table_markup'],
            confidence: 0.92,
            status: 'rejected',
            derivedFromFailureModeKeys: ['pdfua.table_regularity'],
          },
        ],
        summary: {
          deterministicIssueCount: 1,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 1,
        },
        residualFamilies: [],
      },
      plannerEvidence: {
        topFailureModeKeys: [],
        topAutoRunnableOpportunityKeys: [],
        skippedReasonCounts: [],
        attemptedKeys: [],
        rejectedKeys: ['table-candidate-1'],
        noEffectKeys: [],
      },
    })

    const { planRemediationActions } = await import('../services/remediationPlanService.js')
    const plan = await planRemediationActions({
      filename: 'tables.pdf',
      analysis: {
        overallScore: 83,
        grade: 'B',
        isScanned: false,
        pageCount: 10,
        categories: [{ id: 'table_markup', label: 'Table Markup', score: 40, severity: 'Moderate' }],
      } as any,
      context: {
        pdfjs: { title: '', lang: '' },
        qpdf: { lang: '', hasStructTree: true, structTreeDepth: 2, formFields: [] },
        headingCandidates: [],
        figureCandidates: [],
        tableCandidates: [{ id: 'table:1', ref: 'obj:465 0 R' }],
        pages: [],
        linkCandidates: [],
        readingOrderCandidates: [],
        readingOrderParentCandidates: [],
        structure: { structuralNodes: [{ ref: 'obj:1 0 R' }] },
      } as any,
      iteration: 1,
      actions: [],
      rejectedActions: [],
    })

    expect(plan.actions.some(action => action.tool_name === 'repair_native_table_headers')).toBe(true)
  })
})
