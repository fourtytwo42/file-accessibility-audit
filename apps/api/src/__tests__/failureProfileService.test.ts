import { describe, expect, it } from 'vitest'
import { buildFailureProfileArtifacts } from '../services/failureProfileService.js'
import type { AnalysisResult } from '../services/pdfAnalyzer.js'
import type { PdfRemediationContext } from '../services/pdfRemediationTools.js'
import type { RemediationActionRecord } from '../services/documentModel.js'

function makeAnalysisResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    filename: 'example.pdf',
    pageCount: 12,
    fileType: 'pdf',
    pdfMetadata: {
      creator: null,
      producer: null,
      creationDate: null,
      modDate: null,
      pdfVersion: '1.7',
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 12,
    },
    routingSignals: { headingCount: 1, linkCount: 1, rawUrlLinkCount: 1, rawUrlLinkDensity: 1 },
    overallScore: 72,
    grade: 'C',
    isScanned: false,
    executiveSummary: '',
    verapdf: {
      status: 'failed',
      executionStatus: 'ok',
      profile: 'PDF/UA-1',
      flavour: 'ua1',
      isCompliant: false,
      passedChecks: 10,
      failedChecks: 3,
      failures: [
        {
          ruleId: 'tabs',
          specification: 'PDF/UA-1',
          clause: null,
          testNumber: null,
          location: null,
          message: 'The page dictionary shall contain the key Tabs with value S.',
          categoryIds: ['reading_order'],
        },
        {
          ruleId: 'link-contents',
          specification: 'PDF/UA-1',
          clause: null,
          testNumber: null,
          location: null,
          message: 'Link annotations shall contain an alternate description via their Contents key.',
          categoryIds: ['link_quality'],
        },
        {
          ruleId: 'unknown',
          specification: 'PDF/UA-1',
          clause: null,
          testNumber: null,
          location: null,
          message: 'Some unmatched PDF/UA failure',
          categoryIds: [],
        },
      ],
      message: 'veraPDF detected 3 PDF/UA compliance issues.',
    },
    categories: [
      { id: 'title_language', label: 'Document Title & Language', weight: 0.135, score: 50, grade: 'F', severity: 'Moderate', findings: ['No document title found in metadata'], explanation: '', helpLinks: [] },
      { id: 'heading_structure', label: 'Heading Structure', weight: 0.135, score: 60, grade: 'D', severity: 'Moderate', findings: ['Heading hierarchy skip'], explanation: '', helpLinks: [] },
      { id: 'alt_text', label: 'Alt Text on Images', weight: 0.135, score: 0, grade: 'F', severity: 'Critical', findings: ['Image missing alt text'], explanation: '', helpLinks: [] },
      { id: 'table_markup', label: 'Table Markup', weight: 0.09, score: null, grade: null, severity: null, findings: [], explanation: '', helpLinks: [] },
      { id: 'link_quality', label: 'Link Quality', weight: 0.045, score: 0, grade: 'F', severity: 'Critical', findings: ['Raw URL link'], explanation: '', helpLinks: [] },
      { id: 'reading_order', label: 'Reading Order', weight: 0.045, score: 40, grade: 'F', severity: 'Critical', findings: ['Bad reading order'], explanation: '', helpLinks: [] },
      { id: 'pdf_ua_compliance', label: 'PDF/UA Compliance', weight: 0.10, score: 70, grade: 'C', severity: 'Minor', findings: ['veraPDF detected issues'], explanation: '', helpLinks: [] },
    ] as any,
    warnings: [],
    localStandards: {
      status: 'clear',
      findings: [],
      knownGapKeys: [],
    },
    ...overrides,
  }
}

function makeContext(overrides: Partial<PdfRemediationContext> = {}): PdfRemediationContext {
  return {
    analysis: makeAnalysisResult(),
    qpdf: {
      hasStructTree: true,
      isTagged: true,
      hasMarkInfo: true,
      marked: true,
      hasLang: true,
      lang: 'en',
      hasOutlines: false,
      outlineCount: 0,
      outlineTitles: [],
      displayDocTitle: true,
      metadataRef: 'obj:1 0 R',
      metadataTypeValid: true,
      metadataSubtypeXml: true,
      hasAcroForm: false,
      formFields: [],
      fontCount: 1,
      unembeddedFontCount: 0,
      fontsMissingToUnicode: 0,
      cidFontsMissingCidToGidMap: 0,
      images: [],
      headings: [],
      tables: [],
      structTreeDepth: 3,
      contentOrder: [0, 1],
      error: null,
    },
    pdfjs: {
      pageCount: 12,
      hasText: true,
      textLength: 1000,
      title: null,
      author: null,
      subject: null,
      lang: 'en',
      hasOutlines: false,
      outlineCount: 0,
      links: [],
      imageCount: 1,
      metadata: {
        creator: null,
        producer: null,
        creationDate: null,
        modDate: null,
        pdfVersion: '1.7',
        isEncrypted: false,
        keywords: null,
        author: null,
        subject: null,
        pageCount: 12,
      },
      error: null,
    },
    structure: { structuralNodes: [] } as any,
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        imageCount: 1,
        textLines: [],
        links: [{ url: 'https://example.com', text: 'https://example.com', bbox: { x: 0, y: 0, width: 0.2, height: 0.03 }, annotationIndex: 0 }],
      },
    ],
    headingCandidates: [
      {
        id: 'heading:1',
        pageNumber: 1,
        text: 'Executive Summary',
        bbox: { x: 0, y: 0, width: 0.3, height: 0.05 },
        fontSize: 18,
        fontWeight: 'bold',
        nearbyContext: [],
        targetRef: 'obj:10 0 R',
        existingTag: '/P',
        repairMode: 'safe',
      },
      {
        id: 'heading:2',
        pageNumber: 1,
        text: 'Unsafe Heading',
        bbox: { x: 0, y: 0, width: 0.3, height: 0.05 },
        fontSize: 18,
        fontWeight: 'bold',
        nearbyContext: [],
        targetRef: null,
        existingTag: '/Sect',
        repairMode: 'defer',
        unsafeReason: 'unsafe_ancestry: Heading candidate resolved to /Sect.',
      },
    ],
    figureCandidates: [
      {
        id: 'figure:1',
        pageNumber: 1,
        targetRef: 'obj:20 0 R',
        bbox: { x: 0, y: 0, width: 0.3, height: 0.3 },
        hasAlt: false,
        altText: null,
        informativeHint: 'informative',
        surroundingText: ['Chart summary'],
        repairMode: 'retag_then_set_alt',
        targetTag: '/P',
        parentTagPath: [],
        pageImageCount: 1,
        textDensityHint: 'low',
        imageEvidence: 'strong',
      },
      {
        id: 'figure:2',
        pageNumber: 1,
        targetRef: 'obj:21 0 R',
        bbox: { x: 0, y: 0, width: 0.3, height: 0.3 },
        hasAlt: false,
        altText: null,
        informativeHint: 'unknown',
        surroundingText: ['Dense table'],
        repairMode: 'defer',
        targetTag: '/TD',
        unsafeReason: 'unsafe_ancestry: Target obj:21 0 R is associated with /TD.',
        parentTagPath: ['/Table'],
        pageImageCount: 1,
        textDensityHint: 'high',
        imageEvidence: 'strong',
      },
    ],
    tableCandidates: [
      {
        id: 'table:1',
        ref: 'obj:30 0 R',
        pageNumberHints: [1],
        firstRowCellRefs: ['obj:31 0 R'],
        headerCellRefs: [],
        hasHeaders: false,
        repairMode: 'safe',
        nearbyContext: ['Table 1'],
      },
      {
        id: 'table:2',
        ref: 'obj:32 0 R',
        pageNumberHints: [1],
        firstRowCellRefs: [],
        headerCellRefs: [],
        hasHeaders: false,
        repairMode: 'defer',
        nearbyContext: ['Complex table'],
        unsafeReason: 'Complex merged cells require review.',
      },
    ],
    readingOrderCandidates: [],
    readingOrderParentCandidates: [
      {
        id: 'group:1',
        parentRef: 'obj:40 0 R',
        childCandidateIds: ['order:1', 'order:2'],
        mutableKids: true,
        mcidDisorderBefore: 2,
        pageNumberHints: [1],
        tagMix: ['/P'],
        suggestedChildCandidateIds: ['order:1', 'order:2'],
      },
      {
        id: 'group:2',
        parentRef: 'obj:41 0 R',
        childCandidateIds: ['order:3', 'order:4'],
        mutableKids: false,
        mcidDisorderBefore: 3,
        pageNumberHints: [1],
        tagMix: ['/P'],
        suggestedChildCandidateIds: ['order:3', 'order:4'],
      },
    ],
    linkCandidates: [
      {
        id: 'link:1',
        pageNumber: 1,
        url: 'https://example.com',
        text: 'https://example.com',
        bbox: { x: 0, y: 0, width: 0.2, height: 0.03 },
        annotationIndex: 0,
        annotationContents: null,
        rawUrl: true,
        suggestedText: 'Example resource',
      },
    ],
    ...overrides,
  } as PdfRemediationContext
}

function makeAction(overrides: Partial<RemediationActionRecord> = {}): RemediationActionRecord {
  return {
    tool: 'set_document_title',
    target: 'document',
    details: 'did a thing',
    confidence: 0.8,
    autoApplied: true,
    changedVisibleContent: false,
    outcome: 'applied',
    ...overrides,
  }
}

describe('failureProfileService', () => {
  it('groups veraPDF failures into stable family keys and unmatched bucket', () => {
    const result = buildFailureProfileArtifacts({
      analysis: makeAnalysisResult(),
      context: makeContext(),
      actions: [],
      rejectedActions: [],
    })

    expect(result.failureProfile.failureModes.some(mode => mode.key === 'pdfua.page_tabs')).toBe(true)
    expect(result.failureProfile.failureModes.some(mode => mode.key === 'pdfua.annotation_alt_contents')).toBe(true)
    const unmatched = result.failureProfile.failureModes.find(mode => mode.key === 'pdfua.unmatched')
    expect(unmatched?.blocking).toBe(true)
    expect(unmatched?.classification).toBe('manual_only')
  })

  it('promotes local standards findings into canonical failure families and planner opportunities', () => {
    const baseAnalysis = makeAnalysisResult()
    const analysis = makeAnalysisResult({
      verapdf: {
        ...baseAnalysis.verapdf,
        status: 'unavailable',
        executionStatus: 'missing_binary',
        failedChecks: 0,
        failures: [],
      },
      localStandards: {
        status: 'issues_detected',
        findings: [
          {
            key: 'pdfua.font_unicode',
            label: 'Font Unicode mapping',
            severity: 'error',
            blocking: true,
            categoryIds: ['text_extractability', 'pdf_ua_compliance'],
            confidence: 0.9,
            evidence: ['Detected 2 font objects without a ToUnicode map.'],
            source: 'qpdf',
            inferred: false,
            count: 2,
          },
          {
            key: 'pdfua.bookmark_language',
            label: 'Bookmark and outline language quality',
            severity: 'error',
            blocking: true,
            categoryIds: ['bookmarks', 'title_language', 'pdf_ua_compliance'],
            confidence: 0.82,
            evidence: ['Bookmark title appears raw or OCR-noisy.'],
            source: 'composite',
            inferred: false,
            count: 1,
          },
        ],
        knownGapKeys: [],
      },
      categories: [
        ...baseAnalysis.categories,
        { id: 'bookmarks', label: 'Bookmarks / Navigation', weight: 0.09, score: 40, grade: 'F', severity: 'Critical', findings: ['Bookmark titles are noisy'], explanation: '', helpLinks: [] },
        { id: 'text_extractability', label: 'Text Extractability', weight: 0.18, score: 60, grade: 'D', severity: 'Moderate', findings: ['Fonts are missing Unicode maps'], explanation: '', helpLinks: [] },
      ] as any,
    })

    const context = makeContext({ analysis })
    context.qpdf.hasLang = false
    context.qpdf.lang = null

    const result = buildFailureProfileArtifacts({
      analysis,
      context,
      actions: [],
      rejectedActions: [],
    })

    expect(result.failureProfile.failureModes.some(mode => mode.key === 'pdfua.font_unicode' && mode.source === 'local_standards')).toBe(true)
    expect(result.failureProfile.failureModes.some(mode => mode.key === 'pdfua.bookmark_language' && mode.source === 'local_standards')).toBe(true)
    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'repair_font_unicode_maps')).toBe(true)
    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'replace_bookmarks_from_headings')).toBe(true)
  })

  it('maps local page-tabs, link-tagging, and annotation-contents findings into planner opportunities', () => {
    const baseAnalysis = makeAnalysisResult()
    const analysis = makeAnalysisResult({
      verapdf: {
        ...baseAnalysis.verapdf,
        status: 'unavailable',
        executionStatus: 'missing_binary',
        failedChecks: 0,
        failures: [],
      },
      localStandards: {
        status: 'issues_detected',
        findings: [
          {
            key: 'pdfua.page_tabs',
            label: 'Page tab order metadata',
            severity: 'error',
            blocking: true,
            categoryIds: ['reading_order', 'pdf_ua_compliance'],
            confidence: 0.95,
            evidence: ['1 page is missing /Tabs /S.'],
            source: 'composite',
            inferred: false,
            count: 1,
          },
          {
            key: 'pdfua.annotation_alt_contents',
            label: 'Link annotation alternate descriptions',
            severity: 'error',
            blocking: true,
            categoryIds: ['link_quality', 'pdf_ua_compliance'],
            confidence: 0.95,
            evidence: ['2 links are missing /Contents.'],
            source: 'composite',
            inferred: false,
            count: 2,
          },
          {
            key: 'pdfua.link_tagging',
            label: 'Link structure tagging',
            severity: 'error',
            blocking: true,
            categoryIds: ['link_quality', 'reading_order', 'pdf_ua_compliance'],
            confidence: 0.8,
            evidence: ['Links are present but no /Link nodes were found.'],
            source: 'composite',
            inferred: true,
            count: 1,
          },
        ],
        knownGapKeys: [],
      },
    })

    const result = buildFailureProfileArtifacts({
      analysis,
      context: makeContext({ analysis }),
      actions: [],
      rejectedActions: [],
    })

    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'set_page_tabs')).toBe(true)
    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'normalize_annotation_tab_order')).toBe(true)
    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'set_link_annotation_contents')).toBe(true)
    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'repair_native_link_structure')).toBe(true)
  })

  it('maps local CIDSet, language, and logical-structure findings into planner opportunities', () => {
    const baseAnalysis = makeAnalysisResult()
    const analysis = makeAnalysisResult({
      verapdf: {
        ...baseAnalysis.verapdf,
        status: 'unavailable',
        executionStatus: 'missing_binary',
        failedChecks: 0,
        failures: [],
      },
      localStandards: {
        status: 'issues_detected',
        findings: [
          {
            key: 'pdfua.cidset_consistency',
            label: 'CIDSet consistency',
            severity: 'error',
            blocking: true,
            categoryIds: ['text_extractability', 'pdf_ua_compliance'],
            confidence: 0.7,
            evidence: ['CID font descriptors expose CIDSet-risk signals.'],
            source: 'qpdf',
            inferred: true,
            count: 2,
          },
          {
            key: 'pdfua.logical_structure',
            label: 'Logical structure and marked content',
            severity: 'error',
            blocking: true,
            categoryIds: ['text_extractability', 'reading_order', 'pdf_ua_compliance'],
            confidence: 0.76,
            evidence: ['No structure-tree MCID traversal could be confirmed.'],
            source: 'composite',
            inferred: true,
            count: 1,
          },
          {
            key: 'pdfua.document_language',
            label: 'Document language tag',
            severity: 'error',
            blocking: true,
            categoryIds: ['title_language', 'pdf_ua_compliance'],
            confidence: 0.72,
            evidence: ['Language metadata could not be confirmed across analyzers.'],
            source: 'composite',
            inferred: true,
            count: 1,
          },
        ],
        knownGapKeys: ['pdfua.artifact_vs_real_content_partial'],
      },
    })

    const result = buildFailureProfileArtifacts({
      analysis,
      context: makeContext({ analysis }),
      actions: [],
      rejectedActions: [],
    })

    expect(result.failureProfile.failureModes.some(mode => mode.key === 'pdfua.cidset_consistency')).toBe(true)
    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'repair_cidset_consistency')).toBe(true)
    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'repair_structure_conformance')).toBe(true)
    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'repair_native_marked_content_refs')).toBe(true)
    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'artifact_nonsemantic_page_elements')).toBe(true)
    expect(result.failureProfile.toolOpportunities.some(opportunity => ['set_document_language', 'normalize_document_metadata', 'set_pdfua_identification'].includes(opportunity.toolName))).toBe(true)
  })

  it('builds candidate opportunities with auto-runnable and blocked statuses', () => {
    const result = buildFailureProfileArtifacts({
      analysis: makeAnalysisResult(),
      context: makeContext(),
      actions: [],
      rejectedActions: [],
    })

    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'create_heading_from_candidate' && opportunity.status === 'auto_runnable')).toBe(true)
    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'set_table_header_cells' && opportunity.status === 'auto_runnable')).toBe(false)
    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'retag_as_figure_and_set_alt' && opportunity.status === 'auto_runnable')).toBe(true)
    expect(result.failureProfile.toolOpportunities.some(opportunity => ['set_figure_alt_text', 'retag_as_figure_and_set_alt', 'mark_figure_decorative'].includes(opportunity.toolName) && opportunity.status === 'blocked')).toBe(true)
  })

  it('treats graphics-only non-figure Acrobat risks as deterministically repairable', () => {
    const result = buildFailureProfileArtifacts({
      analysis: makeAnalysisResult(),
      context: makeContext({
        structure: {
          structuralNodes: [],
          acrobatAltRiskNodes: [{
            ref: '90 0 R',
            tag: '/Shape',
            pageRef: '5 0 R',
            mcids: [12],
            hasText: false,
            hasGraphics: true,
            hasAlt: false,
            splitSafe: false,
            graphicsLikelyDecorative: false,
            operatorPattern: 'graphics_then_text',
            parentTagPath: [],
            ownershipMode: 'graphics_only_nonfigure',
          }],
        } as any,
      }),
      actions: [],
      rejectedActions: [],
    })

    const opportunity = result.failureProfile.toolOpportunities.find(entry => entry.toolName === 'repair_other_elements_alt_text')
    expect(opportunity?.status).toBe('auto_runnable')
    expect(opportunity?.blockedReason).toBeUndefined()
  })

  it('marks prior attempts, rejections, and no-effect actions on matching opportunities', () => {
    const result = buildFailureProfileArtifacts({
      analysis: makeAnalysisResult(),
      context: makeContext(),
      actions: [
        makeAction({ tool: 'create_heading_from_candidate', target: 'page 1', candidateId: 'heading:1' }),
        makeAction({ tool: 'set_link_annotation_contents', target: 'page 1', candidateId: 'link:1', outcome: 'no_effect' }),
      ],
      rejectedActions: [
        makeAction({ tool: 'reorder_structure_children', target: 'document', candidateGroupId: 'group:1', outcome: 'rejected', autoApplied: false }),
      ],
    })

    expect(result.failureProfile.toolOpportunities.find(opportunity => opportunity.toolName === 'create_heading_from_candidate' && opportunity.candidateIds[0] === 'heading:1')?.status).toBe('already_attempted')
    expect(result.failureProfile.toolOpportunities.find(opportunity => opportunity.toolName === 'set_link_annotation_contents' && opportunity.candidateIds[0] === 'link:1')?.status).toBe('no_effect')
    expect(result.failureProfile.toolOpportunities.find(opportunity => opportunity.toolName === 'reorder_structure_children' && opportunity.candidateGroupIds[0] === 'group:1')?.status).toBe('rejected')
    expect(result.plannerEvidence.rejectedKeys.some(key => key.includes('reorder_structure_children:group:1'))).toBe(true)
  })

  it('does not emit heading or figure candidate opportunities once those categories are already complete', () => {
    const analysis = makeAnalysisResult({
      overallScore: 100,
      grade: 'A',
      verapdf: {
        ...makeAnalysisResult().verapdf,
        status: 'passed',
        isCompliant: true,
        failedChecks: 0,
        failures: [],
      },
      categories: makeAnalysisResult().categories.map(category =>
        category.id === 'heading_structure' || category.id === 'alt_text'
          ? { ...category, score: 100, grade: 'A', severity: 'Pass', findings: [] }
          : category),
    })

    const result = buildFailureProfileArtifacts({
      analysis,
      context: makeContext({ analysis: analysis as AnalysisResult }),
      actions: [],
      rejectedActions: [],
    })

    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'create_heading_from_candidate')).toBe(false)
    expect(result.failureProfile.toolOpportunities.some(opportunity => ['set_figure_alt_text', 'retag_as_figure_and_set_alt', 'mark_figure_decorative'].includes(opportunity.toolName))).toBe(false)
  })

  it('emits Acrobat-risk alt-text failure modes and a deterministic repair opportunity', () => {
    const analysis = makeAnalysisResult({
      overallScore: 88,
      grade: 'B',
      verapdf: {
        ...makeAnalysisResult().verapdf,
        status: 'passed',
        isCompliant: true,
        failedChecks: 0,
        failures: [],
      },
      categories: makeAnalysisResult().categories.map(category =>
        category.id === 'alt_text'
          ? {
              ...category,
              score: 60,
              grade: 'D',
              severity: 'Moderate',
              findings: ['Acrobat-risk non-figure graphics ownership remains.'],
            }
          : category),
    })

    const result = buildFailureProfileArtifacts({
      analysis,
      context: makeContext({
        analysis,
        structure: {
          structuralNodes: [],
          acrobatAltRiskNodes: [
            {
              ref: 'obj:20 0 R',
              tag: '/H1',
              pageRef: 'obj:1 0 R',
              mcids: [0],
              hasText: true,
              hasGraphics: true,
              parentTagPath: ['/Document'],
              ownershipMode: 'mixed_text_graphics_same_mcid',
              splitSafe: true,
              operatorPattern: 'graphics_then_text',
              duplicateOwnerRefs: [],
            },
          ],
        } as any,
      }),
      actions: [],
      rejectedActions: [],
    })

    expect(result.failureProfile.failureModes.some(mode => mode.key === 'acrobat.other_elements_alt_text' && mode.classification === 'deterministic')).toBe(true)
    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'repair_other_elements_alt_text' && opportunity.status === 'auto_runnable')).toBe(true)
  })

  it('keeps unsplittable mixed Acrobat-risk nodes manual-only', () => {
    const analysis = makeAnalysisResult({
      overallScore: 88,
      grade: 'B',
      verapdf: {
        ...makeAnalysisResult().verapdf,
        status: 'passed',
        isCompliant: true,
        failedChecks: 0,
        failures: [],
      },
      categories: makeAnalysisResult().categories.map(category =>
        category.id === 'alt_text'
          ? {
              ...category,
              score: 60,
              grade: 'D',
              severity: 'Moderate',
              findings: ['Acrobat-risk mixed text and graphics ownership remains.'],
            }
          : category),
    })

    const result = buildFailureProfileArtifacts({
      analysis,
      context: makeContext({
        analysis,
        structure: {
          structuralNodes: [],
          acrobatAltRiskNodes: [
            {
              ref: 'obj:20 0 R',
              tag: '/H1',
              pageRef: 'obj:1 0 R',
              mcids: [0],
              hasText: true,
              hasGraphics: true,
              parentTagPath: ['/Document'],
              ownershipMode: 'mixed_text_graphics_same_mcid',
              splitSafe: false,
              operatorPattern: 'interleaved',
              duplicateOwnerRefs: [],
            },
          ],
        } as any,
      }),
      actions: [],
      rejectedActions: [],
    })

    expect(result.failureProfile.failureModes.some(mode => mode.key === 'acrobat.other_elements_alt_text' && mode.classification === 'manual_only')).toBe(true)
    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'repair_other_elements_alt_text' && opportunity.status === 'deferred')).toBe(true)
  })

  it('keeps Acrobat-risk repair opportunity available even when alt-text already scores 100', () => {
    const analysis = makeAnalysisResult({
      overallScore: 100,
      grade: 'A',
      verapdf: {
        ...makeAnalysisResult().verapdf,
        status: 'passed',
        isCompliant: true,
        failedChecks: 0,
        failures: [],
      },
      categories: makeAnalysisResult().categories.map(category =>
        category.id === 'alt_text'
          ? {
              ...category,
              score: 100,
              grade: 'A',
              severity: 'Low',
              findings: ['Detected 1 Acrobat-risk non-figure element with graphics content.'],
            }
          : category),
    })

    const result = buildFailureProfileArtifacts({
      analysis,
      context: makeContext({
        analysis,
        structure: {
          structuralNodes: [],
          acrobatAltRiskNodes: [
            {
              ref: 'obj:20 0 R',
              tag: '/H1',
              pageRef: 'obj:1 0 R',
              mcids: [0],
              hasText: true,
              hasGraphics: true,
              parentTagPath: ['/Document'],
              ownershipMode: 'mixed_text_graphics_same_mcid',
              splitSafe: true,
              operatorPattern: 'graphics_then_text',
              duplicateOwnerRefs: [],
            },
          ],
        } as any,
      }),
      actions: [],
      rejectedActions: [],
    })

    expect(result.failureProfile.toolOpportunities.some(opportunity => opportunity.toolName === 'repair_other_elements_alt_text' && opportunity.status === 'auto_runnable')).toBe(true)
  })

  it('does not emit blocked semantic failure modes once those categories are already complete', () => {
    const analysis = makeAnalysisResult({
      overallScore: 100,
      grade: 'A',
      verapdf: {
        ...makeAnalysisResult().verapdf,
        status: 'passed',
        isCompliant: true,
        failedChecks: 0,
        failures: [],
      },
      categories: makeAnalysisResult().categories.map(category =>
        ['heading_structure', 'alt_text', 'table_markup'].includes(category.id)
          ? { ...category, score: 100, grade: 'A', severity: 'Pass', findings: [] }
          : category),
    })

    const result = buildFailureProfileArtifacts({
      analysis,
      context: makeContext({ analysis: analysis as AnalysisResult }),
      actions: [],
      rejectedActions: [],
    })

    expect(result.failureProfile.failureModes.some(mode => mode.key === 'context.heading_candidates_blocked')).toBe(false)
    expect(result.failureProfile.failureModes.some(mode => mode.key === 'context.figure_candidates_blocked')).toBe(false)
    expect(result.failureProfile.failureModes.some(mode => mode.key === 'context.table_candidates_blocked')).toBe(false)
  })
})
