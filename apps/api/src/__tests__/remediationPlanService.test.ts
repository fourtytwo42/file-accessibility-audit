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
})
