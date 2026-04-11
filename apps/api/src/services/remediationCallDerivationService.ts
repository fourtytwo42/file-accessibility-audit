import type { AnalysisResult } from './pdfAnalyzer.js'
import type { RemediationActionRecord, RemediationToolCall, ToolOpportunity } from './documentModel.js'
import { normalizeLanguageTag } from './languageTags.js'
import { hasSemanticRepairConfig } from './semanticEnrichmentService.js'
import { bookmarkTargets } from './semanticEnrichmentService.js'
import { normalizedExistingHeadingLevel, type PdfRemediationContext } from './pdfRemediationTools.js'
import { draftFigureAltText } from './altTextDraftingService.js'

function humanizeFilenameTitle(filename: string): string {
  const base = filename.replace(/\.pdf$/i, '')
  const stripped = base
    .replace(/[-_](\d{6,}|\d{6,}T\d{6,}|\d+)$/i, '')
    .replace(/\bfinal\b/ig, '')
    .replace(/\s+/g, ' ')
    .replace(/[_-]+/g, ' ')
    .trim()
  const normalized = stripped.replace(/\s+/g, ' ').trim()
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
  if (unique.length >= 2) return `${unique[0]} ${unique[1]}`.slice(0, 160)
  if (unique.length === 1) return unique[0].slice(0, 160)
  return humanizeFilenameTitle(input.filename).slice(0, 160)
}

export function hasMeaningfulMetadataTitle(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function reportedWidthFixes(analysis: AnalysisResult): Array<{ fontName: string; code: number; width: number }> {
  const fixes = new Map<string, { fontName: string; code: number; width: number }>()
  for (const failure of analysis.verapdf.failures) {
    const messageMatch = failure.message.match(/Glyph width\s+(\d+)\s+in the embedded font program is not consistent with the Widths entry of the font dictionary \(value\s+(\d+)\)/i)
    const locationMatch = failure.location?.match(/\(([^()\s]+)\s+\1\s+(\d+)\s+/)
    if (!messageMatch || !locationMatch) continue
    const fontName = `/${locationMatch[1].replace(/^\/+/, '')}`
    const code = Number(locationMatch[2])
    const width = Number(messageMatch[1])
    if (!fontName || !Number.isFinite(code) || !Number.isFinite(width)) continue
    fixes.set(`${fontName}:${code}`, { fontName, code, width })
  }
  return [...fixes.values()]
}

function headingLevelForCandidate(candidateId: string, context: PdfRemediationContext, selectedActions: RemediationToolCall[]): string {
  const candidate = context.headingCandidates.find(entry => entry.id === candidateId)
  if (!candidate) return 'H2'
  const existingLevel = normalizedExistingHeadingLevel(candidate.existingTag)
  if (existingLevel) return existingLevel
  const normalizedText = candidate.text.replace(/\s+/g, ' ').trim().toLowerCase()
  const topLevel = candidate.pageNumber === 1
    || /^(executive summary|table of contents(?:\s*\(continued\))?|contents|introduction|overview|conclusion|appendix\b|appendices\b|chapter\s+\d+\b|part\s+\d+\b|section\s+\d+\b|foreword|preface|acknowledg(?:e)?ments?)\b/.test(normalizedText)
  if (topLevel) return 'H1'
  const hasH1 = selectedActions.some(action => action.tool_name === 'create_heading_from_candidate' && action.arguments.level === 'H1')
  return hasH1 ? 'H2' : 'H1'
}

export function heuristicFigureAltText(candidateId: string, context: PdfRemediationContext): string {
  const candidate = context.figureCandidates.find(entry => entry.id === candidateId)
  if (!candidate) return 'Image'
  return draftFigureAltText({
    pageNumber: candidate.pageNumber,
    surroundingText: candidate.surroundingText,
    decorative: candidate.informativeHint === 'decorative',
  })
}

function shouldPreferSemanticFigureAltText(candidateId: string, context: PdfRemediationContext): boolean {
  if (!hasSemanticRepairConfig()) return false
  const candidate = context.figureCandidates.find(entry => entry.id === candidateId)
  if (!candidate) return false
  return candidate.repairMode !== 'defer' && candidate.informativeHint !== 'decorative'
}

export function deriveDeterministicCall(input: {
  filename: string
  analysis: AnalysisResult
  context: PdfRemediationContext
  opportunity: Pick<ToolOpportunity, 'toolName' | 'reason' | 'confidence' | 'candidateIds' | 'candidateGroupIds' | 'familyId' | 'familyStep' | 'expectedPostconditions'>
  selectedActions: RemediationToolCall[]
}): RemediationToolCall | null {
  const { opportunity, context } = input
  const title = hasMeaningfulMetadataTitle(context.pdfjs.title)
    ? context.pdfjs.title!.trim()
    : suggestDocumentTitle({ filename: input.filename, context })
  const language = normalizeLanguageTag(context.qpdf.lang || context.pdfjs.lang || 'en') || 'en'
  const withFamilyMetadata = (call: RemediationToolCall | null): RemediationToolCall | null => {
    if (!call) return null
    return {
      ...call,
      familyId: opportunity.familyId,
      familyStep: opportunity.familyStep,
      expectedPostconditions: opportunity.expectedPostconditions,
    }
  }

  switch (opportunity.toolName) {
    case 'set_pdfua_identification':
      return withFamilyMetadata({ tool_name: 'set_pdfua_identification', arguments: { title, language, part: 1, conformance: 'B' }, rationale: opportunity.reason, confidence: opportunity.confidence })
    case 'normalize_document_metadata':
      return withFamilyMetadata({ tool_name: 'normalize_document_metadata', arguments: { title, language }, rationale: opportunity.reason, confidence: opportunity.confidence })
    case 'set_document_title':
      return withFamilyMetadata({ tool_name: 'set_document_title', arguments: { title }, rationale: opportunity.reason, confidence: opportunity.confidence })
    case 'set_document_language':
      return withFamilyMetadata({ tool_name: 'set_document_language', arguments: { language }, rationale: opportunity.reason, confidence: opportunity.confidence })
    case 'bootstrap_struct_tree':
    case 'repair_note_tag_ids':
    case 'repair_native_marked_content_refs':
    case 'repair_native_link_structure':
    case 'tag_unowned_annotations':
    case 'repair_bootstrapped_chart_content_refs':
    case 'repair_structure_conformance':
    case 'normalize_nested_figure_containers':
    case 'embed_missing_fonts_in_place':
    case 'repair_font_unicode_maps':
    case 'repair_type1_font_unicode_maps':
    case 'repair_cid_symbol_font_maps':
    case 'repair_cidset_consistency':
    case 'substitute_legacy_fonts_in_place':
    case 'repair_malformed_bdc_operators':
    case 'repair_other_elements_alt_text':
    case 'repair_native_figure_semantics':
    case 'repair_native_table_headers':
    case 'repair_native_reading_order':
    case 'artifact_nonsemantic_page_elements':
    case 'normalize_annotation_tab_order':
    case 'set_tabs_all_annotated_pages':
    case 'repair_annotation_alt_text':
    case 'adobe_auto_tag':
      return withFamilyMetadata({ tool_name: opportunity.toolName, arguments: { target: 'document' }, rationale: opportunity.reason, confidence: opportunity.confidence })
    case 'finalize_substituted_font_conformance':
      return withFamilyMetadata({ tool_name: opportunity.toolName, arguments: { target: 'document', reportedWidthFixes: reportedWidthFixes(input.analysis) }, rationale: opportunity.reason, confidence: opportunity.confidence })
    case 'set_page_tabs': {
      const pageNumbers = [...new Set(context.pages.filter(page => page.links.length > 0).map(page => page.pageNumber))]
      return withFamilyMetadata(pageNumbers.length ? { tool_name: 'set_page_tabs', arguments: { pageNumbers }, rationale: opportunity.reason, confidence: opportunity.confidence } : null)
    }
    case 'set_link_annotation_contents': {
      const candidateId = opportunity.candidateIds[0]
      const candidate = context.linkCandidates.find(entry => entry.id === candidateId)
      const contents = candidate?.suggestedText || candidate?.text || candidate?.url || ''
      if (!candidateId || !contents.trim()) return null
      return withFamilyMetadata({
        tool_name: 'set_link_annotation_contents',
        arguments: { candidateId, pageNumber: candidate?.pageNumber, annotationIndex: candidate?.annotationIndex, contents: contents.trim() },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      })
    }
    case 'replace_bookmarks_from_headings':
      const headings = bookmarkTargets(context)
        .map(candidate => ({
          text: candidate.text,
          level: candidate.pageNumber === 1 ? 'H1' : 'H2',
          targetRef: candidate.targetRef || undefined,
          pageNumber: candidate.pageNumber,
        }))
        .filter(entry => entry.text && (entry.targetRef || Number.isFinite(entry.pageNumber)))
      if (!headings.length) return null
      return withFamilyMetadata({
        tool_name: 'replace_bookmarks_from_headings',
        arguments: { headings },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      })
    case 'normalize_heading_hierarchy':
      return withFamilyMetadata({
        tool_name: 'normalize_heading_hierarchy',
        arguments: { target: 'document' },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      })
    case 'create_heading_from_candidate': {
      const candidateId = opportunity.candidateIds[0]
      if (!candidateId) return null
      return withFamilyMetadata({
        tool_name: 'create_heading_from_candidate',
        arguments: { candidateId, level: headingLevelForCandidate(candidateId, context, input.selectedActions) },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      })
    }
    case 'set_table_header_cells': {
      const candidateId = opportunity.candidateIds[0]
      const candidate = context.tableCandidates.find(entry => entry.id === candidateId)
      if (!candidate?.ref) return null
      return withFamilyMetadata({ tool_name: 'set_table_header_cells', arguments: { targets: [candidate.ref] }, rationale: opportunity.reason, confidence: opportunity.confidence })
    }
    case 'set_figure_alt_text':
    case 'retag_as_figure_and_set_alt': {
      const candidateId = opportunity.candidateIds[0]
      if (!candidateId || shouldPreferSemanticFigureAltText(candidateId, context)) return null
      return withFamilyMetadata({
        tool_name: opportunity.toolName,
        arguments: { candidateId, altText: heuristicFigureAltText(candidateId, context), generationSource: 'heuristic_fallback' },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      })
    }
    case 'mark_figure_decorative': {
      const candidateId = opportunity.candidateIds[0]
      if (!candidateId) return null
      return withFamilyMetadata({ tool_name: 'mark_figure_decorative', arguments: { candidateId, decorative: true }, rationale: opportunity.reason, confidence: opportunity.confidence })
    }
    case 'reorder_structure_children': {
      const candidateGroupId = opportunity.candidateGroupIds[0]
      const parentGroup = context.readingOrderParentCandidates.find(entry => entry.id === candidateGroupId)
      if (!candidateGroupId || !parentGroup) return null
      return withFamilyMetadata({ tool_name: 'reorder_structure_children', arguments: { candidateGroupId, parentRef: parentGroup.parentRef }, rationale: opportunity.reason, confidence: opportunity.confidence })
    }
    default:
      return null
  }
}
