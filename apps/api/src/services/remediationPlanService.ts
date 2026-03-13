import type { AnalysisResult } from './pdfAnalyzer.js'
import type { RemediationToolCall } from './documentModel.js'
import type { PdfRemediationContext } from './pdfRemediationTools.js'

const OPENAI_COMPAT_BASE_URL = process.env.OPENAI_COMPAT_BASE_URL || process.env.OPENROUTER_BASE_URL || 'http://192.168.50.239:51824/v1'
const OPENAI_COMPAT_API_KEY = process.env.OPENAI_COMPAT_API_KEY || process.env.OPENROUTER_API_KEY || 'hs_a9a29d90a35c4b1c8a709e17c8c76dcf'
const OPENAI_COMPAT_MODEL = process.env.OPENAI_COMPAT_MODEL || process.env.OPENROUTER_MODEL || 'gpt-5.1-codex-mini'
const PLAN_REMEDIATION_TOOL = 'plan_pdf_remediation'
const MAX_ACTIONS = 32

export interface RemediationPlanResult {
  done: boolean
  actions: RemediationToolCall[]
  unresolvedIssues: string[]
}

function clampConfidence(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0.5
  return Math.max(0, Math.min(1, numeric))
}

function normalizeToolCall(entry: any): RemediationToolCall | null {
  const toolName = typeof entry?.tool_name === 'string' ? entry.tool_name.trim() : ''
  if (!toolName) return null
  return {
    tool_name: toolName as RemediationToolCall['tool_name'],
    arguments: entry?.arguments && typeof entry.arguments === 'object' ? entry.arguments : {},
    rationale: typeof entry?.rationale === 'string' ? entry.rationale.trim() : '',
    confidence: clampConfidence(entry?.confidence),
  }
}

function issueCategoryIds(result: AnalysisResult): string[] {
  return result.categories
    .filter(category => typeof category.score === 'number' && category.score < 100)
    .sort((a, b) => {
      const severityWeight = (severity: string | null | undefined) => severity === 'Critical' ? 0 : severity === 'Moderate' ? 1 : 2
      return severityWeight(a.severity) - severityWeight(b.severity)
    })
    .map(category => category.id)
}

function humanizeFilenameTitle(filename: string): string {
  const base = filename.replace(/\.pdf$/i, '')
  const stripped = base
    .replace(/[-_](\d{6,}|\d{6,}T\d{6,}|\d+)$/i, '')
    .replace(/\bfinal\b/ig, '')
    .replace(/\s+/g, ' ')
    .replace(/[_-]+/g, ' ')
    .trim()
  const normalized = stripped
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return base
  return normalized
    .split(' ')
    .map(token => (/^[A-Z0-9]{2,}$/.test(token) ? token : token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()))
    .join(' ')
}

function suggestDocumentTitle(input: {
  filename: string
  context: PdfRemediationContext
}): string {
  const pageOneHeadings = input.context.headingCandidates
    .filter(candidate => candidate.pageNumber === 1 && candidate.text.trim())
    .map(candidate => candidate.text.trim())
  const unique = [...new Set(pageOneHeadings)]
  if (unique.length >= 2) {
    return `${unique[0]} ${unique[1]}`.slice(0, 160)
  }
  if (unique.length === 1) {
    return unique[0].slice(0, 160)
  }
  return humanizeFilenameTitle(input.filename).slice(0, 160)
}

function hasMeaningfulMetadataTitle(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function veraPdfFailureText(result: AnalysisResult): string[] {
  if (result.verapdf?.status !== 'failed') return []
  return result.verapdf.failures
    .map(failure => failure.message.trim())
    .filter(Boolean)
}

function hasVeraPdfFailure(result: AnalysisResult, pattern: RegExp): boolean {
  return veraPdfFailureText(result).some(message => pattern.test(message))
}

function dedupeActions(actions: RemediationToolCall[]): RemediationToolCall[] {
  const seen = new Set<string>()
  const next: RemediationToolCall[] = []
  for (const action of actions) {
    const key = JSON.stringify([action.tool_name, action.arguments])
    if (seen.has(key)) continue
    seen.add(key)
    next.push(action)
    if (next.length >= MAX_ACTIONS) break
  }
  return next
}

function heuristicActions(input: {
  analysis: AnalysisResult
  filename: string
  context: PdfRemediationContext
  previousActions: string[]
}): RemediationToolCall[] {
  const actions: RemediationToolCall[] = []
  const issueIds = new Set(issueCategoryIds(input.analysis))
  const attempted = new Set(input.previousActions)
  const alreadyTried = (key: string) => attempted.has(key)
  const titleSuggestion = suggestDocumentTitle(input)
  const hasTabsFailure = hasVeraPdfFailure(input.analysis, /\/tabs\b|value shall be s\b|page dictionary the key tabs/i)
  const hasTabOrderFailure = hasVeraPdfFailure(input.analysis, /\btab order\b|annotation.*tab order|tabs shall/i)
  const hasLinkContentsFailure = hasVeraPdfFailure(input.analysis, /alternate description via their contents key|links shall contain an alternate description|\/contents\b/i)
  const hasPdfUaIdentificationFailure = hasVeraPdfFailure(input.analysis, /pdf\/ua identification|identification extension schema|conformance level|metadata stream doesn't contain pdf\/ua/i)
  const hasStructureConformanceFailure = hasVeraPdfFailure(input.analysis, /content shall be marked as artifact|content is neither marked as artifact nor tagged as real content|links shall be tagged according to|logical structure|parenttree|marked content/i)
  const hasLinkTaggingFailure = hasVeraPdfFailure(input.analysis, /links shall be tagged|link annotation.*not.*tagged|link annotation.*shall.*enclosed|annotation.*shall.*enclosed.*link|link.*artifact|link.*null tag|link.*reference tag/i)
  const hasNoteTagIdFailure = hasVeraPdfFailure(input.analysis, /note tag shall have id entry|\/note.*id entry/i)
  const hasFontEmbeddingFailure = hasVeraPdfFailure(input.analysis, /font programs.*embedded|font program is not embedded/i)
  const hasFontUnicodeFailure = hasVeraPdfFailure(input.analysis, /map of all used character codes to unicode|glyph can not be mapped to unicode|\/tounicode\b|tounicode/i)
  const hasType1UnicodeFailure = hasVeraPdfFailure(input.analysis, /could not derive a tounicode map for .*type1|type1|type3|encoding differences|custom encoding/i)
  const hasFontWidthFailure = hasVeraPdfFailure(input.analysis, /glyph width .*not consistent with the widths entry|width information in the font dictionary/i)
  const hasCidSymbolFailure = hasVeraPdfFailure(input.analysis, /cidtogidmap|type 2 cidfont|glyph can not be mapped to unicode|wingdings|symbolmt/i)
  const hasCidSetFailure = hasVeraPdfFailure(input.analysis, /cidset stream|cidset entry in the font descriptor|fontdescriptor dictionary of an embedded cid font contains a cidset/i)
  const hasOtherElementsAltFailure = hasVeraPdfFailure(input.analysis, /other elements alternate text|alternate text.*failed|artifact image|decorative image/i)
  const shouldRunConformanceRepairs = !input.analysis.isScanned
  const bootstrapWasAttempted = alreadyTried('bootstrap_struct_tree:document')
  const hasUsableNativeStructure = input.context.qpdf.hasStructTree
    && input.context.qpdf.structTreeDepth > 0
    && input.context.structure.structuralNodes.length > 0
  const nativeTaggedSafeMode = shouldRunConformanceRepairs && hasUsableNativeStructure && !bootstrapWasAttempted
  const shouldRunBootstrappedChartConformance = shouldRunConformanceRepairs
    && bootstrapWasAttempted
    && input.analysis.pageCount === 1
    && hasStructureConformanceFailure

  if (hasTabsFailure) {
    const pageNumbers = [...new Set(input.context.pages.filter(page => page.links.length > 0).map(page => page.pageNumber))]
    if (pageNumbers.length && !alreadyTried('set_page_tabs:document') && !pageNumbers.every(pageNumber => alreadyTried(`set_page_tabs:page ${pageNumber}`))) {
      actions.push({
        tool_name: 'set_page_tabs',
        arguments: { pageNumbers },
        rationale: 'veraPDF reported missing /Tabs /S on annotated pages, so normalize those page dictionaries directly.',
        confidence: 0.88,
      })
    }
  }

  if (shouldRunConformanceRepairs && hasTabOrderFailure && !alreadyTried('normalize_annotation_tab_order:document')) {
    actions.push({
      tool_name: 'normalize_annotation_tab_order',
      arguments: { target: 'document' },
      rationale: 'Acrobat-style tab-order failures remain, so normalize annotation order on annotated pages without changing content layout.',
      confidence: 0.86,
    })
  }

  if (hasLinkContentsFailure) {
    input.context.linkCandidates
      .filter(candidate =>
        !alreadyTried(`set_link_annotation_contents:${candidate.id}`)
        && (nativeTaggedSafeMode ? !candidate.annotationContents : true),
      )
      .slice(0, nativeTaggedSafeMode ? MAX_ACTIONS - 4 : 8)
      .forEach(candidate => {
        const contents = candidate.suggestedText || candidate.text || (candidate.url && !candidate.url.startsWith('#') ? candidate.url : null) || 'Link'
        actions.push({
          tool_name: 'set_link_annotation_contents',
          arguments: {
            candidateId: candidate.id,
            contents,
          },
          rationale: `veraPDF reported missing link annotation alternate descriptions, so set /Contents for link on page ${candidate.pageNumber}.`,
          confidence: 0.84,
        })
      })
  }

  if (shouldRunConformanceRepairs && hasPdfUaIdentificationFailure && !alreadyTried('set_pdfua_identification:document')) {
    actions.push({
      tool_name: 'set_pdfua_identification',
      arguments: {
        title: input.context.pdfjs.title || titleSuggestion,
        language: input.context.qpdf.lang || input.context.pdfjs.lang || 'en',
        part: 1,
        conformance: 'B',
      },
      rationale: 'veraPDF reported missing PDF/UA identification metadata, so write the required identification schema and catalog metadata directly.',
      confidence: 0.88,
    })
  }

  if (shouldRunConformanceRepairs && issueIds.has('title_language') && !alreadyTried('normalize_document_metadata:document')) {
    actions.push({
      tool_name: 'normalize_document_metadata',
      arguments: {
        title: input.context.pdfjs.title || titleSuggestion,
        language: input.context.qpdf.lang || input.context.pdfjs.lang || 'en',
      },
      rationale: 'Normalize title, language, viewer preferences, and metadata so Acrobat and veraPDF see the same document metadata.',
      confidence: 0.84,
    })
  }

  if (issueIds.has('title_language') && !hasMeaningfulMetadataTitle(input.context.pdfjs.title) && !alreadyTried('set_document_title:document')) {
    actions.push({
      tool_name: 'set_document_title',
      arguments: { title: titleSuggestion },
      rationale: 'The document is missing a usable title, so set the title from the filename as a fallback.',
      confidence: 0.82,
    })
  }

  if (issueIds.has('title_language') && !(input.context.qpdf.lang || input.context.pdfjs.lang) && !alreadyTried('set_document_language:document')) {
    actions.push({
      tool_name: 'set_document_language',
      arguments: { language: 'en' },
      rationale: 'The document is missing a declared language, so set the default language to English.',
      confidence: 0.6,
    })
  }

  if (!input.context.qpdf.hasStructTree && (
    issueIds.has('text_extractability') ||
    issueIds.has('heading_structure') ||
    issueIds.has('alt_text') ||
    issueIds.has('reading_order')
  ) && !attempted.has('bootstrap_struct_tree:document')) {
    actions.push({
      tool_name: 'bootstrap_struct_tree',
      arguments: { target: 'document' },
      rationale: 'The PDF lacks a usable structure tree, so bootstrap a minimal tag tree from heading and figure candidates before deeper semantic repairs.',
      confidence: 0.72,
    })
  }

  if (nativeTaggedSafeMode && hasNoteTagIdFailure && !alreadyTried('repair_note_tag_ids:document')) {
    actions.push({
      tool_name: 'repair_note_tag_ids',
      arguments: { target: 'document' },
      rationale: 'The document already has a tag tree, so repair missing /Note IDs in place instead of rewriting page structure.',
      confidence: 0.88,
    })
  }

  if (nativeTaggedSafeMode && hasStructureConformanceFailure && !alreadyTried('repair_native_marked_content_refs:document')) {
    actions.push({
      tool_name: 'repair_native_marked_content_refs',
      arguments: { target: 'document' },
      rationale: 'The document already has a structure tree, so connect orphaned existing MCIDs into the parent tree before attempting broader reading-order changes.',
      confidence: 0.86,
    })
  }

  if (nativeTaggedSafeMode && (hasLinkTaggingFailure || hasStructureConformanceFailure) && !alreadyTried('repair_native_link_structure:document')) {
    actions.push({
      tool_name: 'repair_native_link_structure',
      arguments: { target: 'document' },
      rationale: 'The document has an existing structure tree but link annotations are not properly enclosed in /Link structure elements, so create Link struct elements for untagged annotations without modifying existing page content structure.',
      confidence: 0.88,
    })
  }

  if (shouldRunBootstrappedChartConformance && !alreadyTried('repair_bootstrapped_chart_content_refs:document')) {
    actions.push({
      tool_name: 'repair_bootstrapped_chart_content_refs',
      arguments: { target: 'document' },
      rationale: 'The chart page was bootstrapped into a new structure tree, so attach remaining top-level real content and link annotations to that tree in place.',
      confidence: 0.9,
    })
  }

  if (
    shouldRunConformanceRepairs &&
    hasStructureConformanceFailure &&
    input.context.qpdf.hasStructTree &&
    !shouldRunBootstrappedChartConformance &&
    !nativeTaggedSafeMode &&
    !alreadyTried('repair_structure_conformance:document')
  ) {
    actions.push({
      tool_name: 'repair_structure_conformance',
      arguments: { target: 'document' },
      rationale: 'veraPDF reported remaining logical-structure and untagged-content failures, so repair page marked content, parent-tree entries, and link structure in place.',
      confidence: 0.9,
    })
  }

  if (nativeTaggedSafeMode && issueIds.has('alt_text') && !alreadyTried('repair_native_figure_semantics:document')) {
    actions.push({
      tool_name: 'repair_native_figure_semantics',
      arguments: { target: 'document' },
      rationale: 'The document is already tagged, so repair figure/decorative semantics inside the existing structure tree instead of rebuilding wrappers.',
      confidence: 0.74,
    })
  }

  if (nativeTaggedSafeMode && issueIds.has('table_markup') && !alreadyTried('repair_native_table_headers:document')) {
    actions.push({
      tool_name: 'repair_native_table_headers',
      arguments: { target: 'document' },
      rationale: 'Repair table headers within existing tagged tables instead of inferring new wrappers.',
      confidence: 0.58,
    })
  }

  if (nativeTaggedSafeMode && issueIds.has('reading_order') && !alreadyTried('repair_native_reading_order:document')) {
    actions.push({
      tool_name: 'repair_native_reading_order',
      arguments: { target: 'document' },
      rationale: 'Repair reading order locally within existing tagged parents instead of wrapping whole pages in new structure elements.',
      confidence: 0.74,
    })
  }

  if (shouldRunConformanceRepairs && hasFontEmbeddingFailure && !alreadyTried('embed_missing_fonts_in_place:document')) {
    actions.push({
      tool_name: 'embed_missing_fonts_in_place',
      arguments: { target: 'document' },
      rationale: 'veraPDF reported unembedded fonts, so embed the original page fonts in place where available without changing layout.',
      confidence: 0.9,
    })
  }

  if (shouldRunConformanceRepairs && hasFontUnicodeFailure && !alreadyTried('repair_font_unicode_maps:document')) {
    actions.push({
      tool_name: 'repair_font_unicode_maps',
      arguments: { target: 'document' },
      rationale: 'veraPDF reported missing or incomplete Unicode mappings, so add ToUnicode maps for derivable document fonts in place.',
      confidence: 0.88,
    })
  }

  if (
    shouldRunConformanceRepairs
    && hasFontUnicodeFailure
    && (hasType1UnicodeFailure || alreadyTried('repair_font_unicode_maps:document'))
    && !alreadyTried('repair_type1_font_unicode_maps:document')
  ) {
    actions.push({
      tool_name: 'repair_type1_font_unicode_maps',
      arguments: { target: 'document' },
      rationale: 'Remaining font Unicode failures appear to involve legacy Type1 or Type3 fonts with custom encodings, so derive ToUnicode maps from their encoding differences and used glyph codes in place.',
      confidence: 0.9,
    })
  }

  if (
    shouldRunConformanceRepairs
    && input.analysis.pageCount >= 10
    && (hasFontEmbeddingFailure || hasFontWidthFailure)
    && (alreadyTried('embed_missing_fonts_in_place:document') || alreadyTried('repair_type1_font_unicode_maps:document'))
    && !alreadyTried('substitute_legacy_fonts_in_place:document')
  ) {
    actions.push({
      tool_name: 'substitute_legacy_fonts_in_place',
      arguments: { target: 'document' },
      rationale: 'Remaining annual-report font failures require substituting unavailable legacy Type1 fonts with approved metric-aware embedded fallbacks and rewriting width data in place.',
      confidence: 0.92,
    })
  }

  if (
    shouldRunConformanceRepairs
    && input.analysis.pageCount >= 10
    && (hasFontEmbeddingFailure || hasFontUnicodeFailure || hasFontWidthFailure)
    && (
      alreadyTried('substitute_legacy_fonts_in_place:document')
      || alreadyTried('repair_type1_font_unicode_maps:document')
      || alreadyTried('repair_cidset_consistency:document')
      // Also plan finalize in the same iteration as substitute so it runs immediately after
      || actions.some(a => a.tool_name === 'substitute_legacy_fonts_in_place')
    )
    && !alreadyTried('finalize_substituted_font_conformance:document')
  ) {
    actions.push({
      tool_name: 'finalize_substituted_font_conformance',
      arguments: { target: 'document' },
      rationale: 'Remaining annual-report font failures require a final per-font audit to finish embedding, width normalization, and Unicode mapping on the actual substituted font objects.',
      confidence: 0.94,
    })
  }

  if (shouldRunConformanceRepairs && hasCidSymbolFailure && !alreadyTried('repair_cid_symbol_font_maps:document')) {
    actions.push({
      tool_name: 'repair_cid_symbol_font_maps',
      arguments: { target: 'document' },
      rationale: 'Remaining CID symbol-font failures require explicit CIDToGIDMap and Unicode repairs for embedded Symbol/Wingdings fonts.',
      confidence: 0.9,
    })
  }

  if (shouldRunConformanceRepairs && hasCidSetFailure && !alreadyTried('repair_cidset_consistency:document')) {
    actions.push({
      tool_name: 'repair_cidset_consistency',
      arguments: { target: 'document' },
      rationale: 'Remaining embedded CID font CIDSet failures require regenerating CIDSet streams so they match the embedded subset glyphs.',
      confidence: 0.9,
    })
  }

  if (shouldRunConformanceRepairs && hasOtherElementsAltFailure && !alreadyTried('artifact_nonsemantic_page_elements:document')) {
    actions.push({
      tool_name: 'artifact_nonsemantic_page_elements',
      arguments: { target: 'document' },
      rationale: 'Remaining alternate-text failures appear to be on nonsemantic elements, so mark decorative leftovers conservatively in place.',
      confidence: 0.72,
    })
  }

  if (issueIds.has('bookmarks') && !alreadyTried('replace_bookmarks_from_headings:document')) {
    actions.push({
      tool_name: 'replace_bookmarks_from_headings',
      arguments: {},
      rationale: 'The document lacks bookmarks and should try generating them from heading structure.',
      confidence: 0.55,
    })
  }

  if (issueIds.has('heading_structure')) {
    const seenHeadingTargets = new Set<string>()
    input.context.headingCandidates
      .filter(candidate => {
        if (!candidate.targetRef || candidate.repairMode !== 'safe') return false
        if (alreadyTried(`create_heading_from_candidate:${candidate.id}`)) return false
        if (seenHeadingTargets.has(candidate.targetRef)) return false
        seenHeadingTargets.add(candidate.targetRef)
        return true
      })
      .slice(0, 4)
      .forEach((candidate, index) => {
        actions.push({
          tool_name: 'create_heading_from_candidate',
          arguments: {
            candidateId: candidate.id,
            level: candidate.pageNumber === 1 && index === 0 ? 'H1' : 'H2',
          },
          rationale: `Promote the structural candidate for "${candidate.text}" to a heading.`,
          confidence: 0.7,
        })
      })
  }

  if (issueIds.has('alt_text')) {
    const altActionLimit = issueIds.size <= 2 ? 12 : 6
    input.context.figureCandidates
      .filter(candidate =>
        !candidate.hasAlt &&
        candidate.targetRef &&
        candidate.repairMode !== 'defer' &&
        !alreadyTried(`set_figure_alt_text:${candidate.id}`) &&
        !alreadyTried(`retag_as_figure_and_set_alt:${candidate.id}`),
      )
      .slice(0, altActionLimit)
      .forEach(candidate => {
        const altText = candidate.surroundingText[0]
          ? `Image related to ${candidate.surroundingText[0].replace(/[.]+$/, '').slice(0, 80)}`
          : `Image on page ${candidate.pageNumber}`
        actions.push({
          tool_name: candidate.informativeHint === 'decorative'
            ? 'mark_figure_decorative'
            : candidate.repairMode === 'retag_then_set_alt'
              ? 'retag_as_figure_and_set_alt'
              : 'set_figure_alt_text',
          arguments: candidate.informativeHint === 'decorative'
            ? { candidateId: candidate.id, decorative: true }
            : { candidateId: candidate.id, altText },
          rationale: `Repair missing figure description for figure candidate ${candidate.id}.`,
          confidence: candidate.informativeHint === 'decorative' ? 0.7 : 0.62,
        })
      })
  }

  if (issueIds.has('table_markup')) {
    actions.push({
      tool_name: 'set_table_header_cells',
      arguments: { target: 'detected tables' },
      rationale: 'Detected tables should have header cells tagged where missing.',
      confidence: 0.45,
    })
  }

  if (issueIds.has('reading_order')) {
    const selectedGroup = input.context.readingOrderParentCandidates
      .filter(candidate =>
        candidate.mutableKids &&
        candidate.mcidDisorderBefore > 0 &&
        candidate.suggestedChildCandidateIds.length > 1 &&
        !alreadyTried(`reorder_structure_children:${candidate.id}`),
      )
      .sort((a, b) => {
        if (a.pageNumberHints.length !== b.pageNumberHints.length) {
          return a.pageNumberHints.length - b.pageNumberHints.length
        }
        if (a.childCandidateIds.length !== b.childCandidateIds.length) {
          return a.childCandidateIds.length - b.childCandidateIds.length
        }
        return b.mcidDisorderBefore - a.mcidDisorderBefore
      })[0]
    if (selectedGroup) {
      actions.push({
        tool_name: 'reorder_structure_children',
        arguments: { candidateGroupId: selectedGroup.id, parentRef: selectedGroup.parentRef },
        rationale: 'Normalize a parent-scoped reading-order group with detectable MCID disorder.',
        confidence: 0.4,
      })
    }
  }

  if (issueIds.has('link_quality')) {
    input.context.linkCandidates
      .filter(candidate => candidate.rawUrl && candidate.suggestedText && !alreadyTried(`rewrite_link_visible_text:${candidate.id}`))
      .slice(0, 4)
      .forEach(candidate => {
        actions.push({
          tool_name: 'rewrite_link_visible_text',
          arguments: {
            candidateId: candidate.id,
            replacementText: candidate.suggestedText,
          },
          rationale: `Replace the raw URL label for ${candidate.url} with descriptive text.`,
          confidence: 0.66,
        })
      })
  }

  if (issueIds.has('form_accessibility')) {
    actions.push({
      tool_name: 'set_form_field_tooltip',
      arguments: { target: 'unlabeled form fields' },
      rationale: 'Unlabeled form fields should receive tooltips or accessible labels.',
      confidence: 0.5,
    })
  }

  return dedupeActions(actions)
}

function buildPrompt(input: {
  filename: string
  analysis: AnalysisResult
  context: PdfRemediationContext
  iteration: number
  previousActions: string[]
}): string {
  const issues = input.analysis.categories
    .filter(category => typeof category.score === 'number' && category.score < 100)
    .map(category => ({
      id: category.id,
      label: category.label,
      score: category.score,
      severity: category.severity,
      findings: category.findings.slice(0, 5),
    }))

  const compactContext = {
    metadata: {
      title: input.context.pdfjs.title,
      language: input.context.qpdf.lang || input.context.pdfjs.lang,
      pageCount: input.analysis.pageCount,
      veraPdfStatus: input.analysis.verapdf?.status,
    },
    qpdf: {
      hasStructTree: input.context.qpdf.hasStructTree,
      headingCount: input.context.qpdf.headings.length,
      tableCount: input.context.qpdf.tables.length,
      figureCount: input.context.qpdf.images.length,
      bookmarkCount: input.context.qpdf.outlineCount,
      formFieldCount: input.context.qpdf.formFields.length,
      readingOrderDepth: input.context.qpdf.structTreeDepth,
    },
    pages: input.context.pages.slice(0, 4).map(page => ({
      pageNumber: page.pageNumber,
      imageCount: page.imageCount,
      textLines: page.textLines.slice(0, 12),
      links: page.links.slice(0, 10),
    })),
    headingCandidates: input.context.headingCandidates.slice(0, 10),
    figureCandidates: input.context.figureCandidates.slice(0, 10).map(candidate => ({
      ...candidate,
      surroundingText: candidate.surroundingText.slice(0, 3),
    })),
    readingOrderCandidates: input.context.readingOrderCandidates.slice(0, 12),
    readingOrderParentCandidates: input.context.readingOrderParentCandidates.slice(0, 8),
    linkCandidates: input.context.linkCandidates.slice(0, 10),
    veraPdfFailures: input.analysis.verapdf?.failures.slice(0, 12).map(failure => ({
      message: failure.message,
      categoryIds: failure.categoryIds,
    })) || [],
  }

  return [
    'You are planning in-place PDF accessibility remediation.',
    'Return tool calls only via the provided function schema.',
    'Prefer non-visual edits over visible content changes.',
    'Visible text rewrites are allowed only for raw URL link labels.',
    'Do not propose HTML generation, page rebuilding, screenshots, or page replacement.',
    'Use concrete candidateId payloads when candidate lists are available.',
    'Use candidateGroupId for reading-order parent groups when provided.',
    'Use set_page_tabs when veraPDF reports missing /Tabs /S on annotated pages.',
    'Use set_link_annotation_contents when veraPDF reports missing alternate descriptions on link annotations.',
    'If the PDF has no usable structure tree, prefer bootstrap_struct_tree before individual heading or reading-order repairs.',
    'Do not retry any candidate already listed in previous actions.',
    'Only emit alt text when the figure candidate repairMode is set_alt or retag_then_set_alt; otherwise defer.',
    'Do not retry figure candidates or reading-order parent groups that previously returned no_effect or validation warnings.',
    'If a document issue cannot be safely fixed, leave it unresolved instead of inventing a workaround.',
    `Filename: ${input.filename}`,
    `Iteration: ${input.iteration}`,
    `Previous actions: ${JSON.stringify(input.previousActions)}`,
    `Open issues: ${JSON.stringify(issues)}`,
    `Document context: ${JSON.stringify(compactContext)}`,
  ].join('\n')
}

async function openAiPlan(messages: any[]): Promise<RemediationPlanResult> {
  const response = await fetch(`${OPENAI_COMPAT_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_COMPAT_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_COMPAT_MODEL,
      temperature: 0.1,
      tools: [{
        type: 'function',
        function: {
          name: PLAN_REMEDIATION_TOOL,
          description: 'Plan the next remediation actions for an in-place PDF accessibility patch loop.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['done', 'actions', 'unresolvedIssues'],
            properties: {
              done: { type: 'boolean' },
              unresolvedIssues: { type: 'array', items: { type: 'string' } },
              actions: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['tool_name', 'arguments', 'rationale', 'confidence'],
                  properties: {
                    tool_name: { type: 'string' },
                    arguments: { type: 'object' },
                    rationale: { type: 'string' },
                    confidence: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      }],
      tool_choice: {
        type: 'function',
        function: { name: PLAN_REMEDIATION_TOOL },
      },
      messages,
    }),
  })

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '')
    throw new Error(`OpenAI-compatible remediation planner failed: ${response.status}${bodyText ? ` ${bodyText}` : ''}`)
  }

  const payload = await response.json() as any
  const toolCall = payload?.choices?.[0]?.message?.tool_calls?.find((entry: any) => entry?.function?.name === PLAN_REMEDIATION_TOOL)
  const rawArguments = toolCall?.function?.arguments
  if (!rawArguments || typeof rawArguments !== 'string') {
    throw new Error('OpenAI-compatible remediation planner did not return function call arguments.')
  }

  const parsed = JSON.parse(rawArguments)
  return {
    done: !!parsed?.done,
    unresolvedIssues: Array.isArray(parsed?.unresolvedIssues) ? parsed.unresolvedIssues.map((entry: unknown) => String(entry)) : [],
    actions: Array.isArray(parsed?.actions)
      ? parsed.actions.map(normalizeToolCall).filter(Boolean).slice(0, MAX_ACTIONS) as RemediationToolCall[]
      : [],
  }
}

export async function planRemediationActions(input: {
  filename: string
  analysis: AnalysisResult
  context: PdfRemediationContext
  iteration: number
  previousActions: string[]
}): Promise<RemediationPlanResult> {
  const fallback = {
    done: issueCategoryIds(input.analysis).length === 0,
    actions: heuristicActions(input),
    unresolvedIssues: issueCategoryIds(input.analysis),
  }

  if (!OPENAI_COMPAT_API_KEY) {
    return fallback
  }

  try {
    const planned = await openAiPlan([{
      role: 'user',
      content: [{ type: 'text', text: buildPrompt(input) }],
    }])
    if (!planned.actions.length && !planned.done) {
      return fallback
    }
    return {
      done: planned.done,
      actions: dedupeActions([...heuristicActions(input), ...planned.actions]),
      unresolvedIssues: planned.unresolvedIssues,
    }
  } catch {
    return fallback
  }
}
