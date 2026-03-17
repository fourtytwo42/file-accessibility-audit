import { REMEDIATION } from '#config'
import type { AnalysisResult } from './pdfAnalyzer.js'
import type {
  FailureMode,
  RemediationActionRecord,
  RemediationToolCall,
  RemediationToolName,
  ToolOpportunity,
  ToolOpportunityScope,
} from './documentModel.js'
import { buildFailureProfileArtifacts } from './failureProfileService.js'
import { normalizeLanguageTag } from './languageTags.js'
import type { PdfRemediationContext } from './pdfRemediationTools.js'

const OPENAI_COMPAT_BASE_URL = process.env.OPENAI_COMPAT_BASE_URL || process.env.OPENROUTER_BASE_URL || 'http://192.168.50.239:51824/v1'
const OPENAI_COMPAT_API_KEY = process.env.OPENAI_COMPAT_API_KEY || process.env.OPENROUTER_API_KEY || 'hs_a9a29d90a35c4b1c8a709e17c8c76dcf'
const OPENAI_COMPAT_MODEL = process.env.OPENAI_COMPAT_MODEL || process.env.OPENROUTER_MODEL || 'gpt-5.1-codex-mini'
const PLAN_REMEDIATION_TOOL = 'plan_pdf_remediation'
const MAX_ACTIONS = 32

const STRUCTURE_BOOTSTRAP_STAGE = new Set<RemediationToolName>([
  'bootstrap_struct_tree',
  'repair_note_tag_ids',
  'repair_native_marked_content_refs',
  'repair_bootstrapped_chart_content_refs',
  'repair_structure_conformance',
])

const STRUCTURE_LINK_STAGE = new Set<RemediationToolName>([
  'repair_native_link_structure',
  'set_page_tabs',
  'normalize_annotation_tab_order',
  'set_tabs_all_annotated_pages',
  'repair_annotation_alt_text',
  'set_link_annotation_contents',
])

const FONT_STAGE = new Set<RemediationToolName>([
  'embed_missing_fonts_in_place',
  'repair_font_unicode_maps',
  'repair_type1_font_unicode_maps',
  'repair_truetype_encoding_differences',
  'repair_cid_symbol_font_maps',
  'repair_cidset_consistency',
  'substitute_legacy_fonts_in_place',
  'finalize_substituted_font_conformance',
])

const NATIVE_STRUCTURE_STAGE = new Set<RemediationToolName>([
  'adobe_auto_tag',
  'repair_other_elements_alt_text',
  'repair_native_figure_semantics',
  'repair_native_table_headers',
  'repair_native_reading_order',
  'artifact_nonsemantic_page_elements',
])

const SAFE_CANDIDATE_STAGE = new Set<RemediationToolName>([
  'replace_bookmarks_from_headings',
  'create_heading_from_candidate',
  'create_heading_tag',
  'set_table_header_cells',
  'set_figure_alt_text',
  'retag_as_figure_and_set_alt',
  'mark_figure_decorative',
  'reorder_structure_children',
])

const METADATA_STAGE = new Set<RemediationToolName>([
  'set_pdfua_identification',
  'normalize_document_metadata',
  'set_document_title',
  'set_document_language',
])

export const TOOL_STAGE_ORDER = new Map<RemediationToolName, number>([
  ['set_pdfua_identification', 1],
  ['normalize_document_metadata', 1],
  ['set_document_title', 1],
  ['set_document_language', 1],
  ['bootstrap_struct_tree', 2],
  ['repair_note_tag_ids', 2],
  ['repair_native_marked_content_refs', 2],
  ['repair_bootstrapped_chart_content_refs', 2],
  ['repair_structure_conformance', 2],
  ['repair_native_link_structure', 3],
  ['set_page_tabs', 3],
  ['normalize_annotation_tab_order', 3],
  ['set_tabs_all_annotated_pages', 3],
  ['repair_annotation_alt_text', 3],
  ['set_link_annotation_contents', 3],
  ['embed_missing_fonts_in_place', 4],
  ['repair_font_unicode_maps', 4],
  ['repair_type1_font_unicode_maps', 4],
  ['repair_truetype_encoding_differences', 4],
  ['repair_cid_symbol_font_maps', 4],
  ['repair_cidset_consistency', 4],
  ['substitute_legacy_fonts_in_place', 4],
  ['finalize_substituted_font_conformance', 4],
  ['repair_other_elements_alt_text', 5],
  ['adobe_auto_tag', 5],
  ['repair_native_figure_semantics', 5],
  ['repair_native_table_headers', 5],
  ['repair_native_reading_order', 5],
  ['artifact_nonsemantic_page_elements', 5],
  ['replace_bookmarks_from_headings', 6],
  ['create_heading_from_candidate', 6],
  ['create_heading_tag', 6],
  ['set_table_header_cells', 6],
  ['set_figure_alt_text', 6],
  ['retag_as_figure_and_set_alt', 6],
  ['mark_figure_decorative', 6],
  ['reorder_structure_children', 6],
])

const TOOL_PRIORITY = new Map<RemediationToolName, number>([
  ['set_pdfua_identification', 0],
  ['normalize_document_metadata', 1],
  ['set_document_title', 2],
  ['set_document_language', 3],
  ['bootstrap_struct_tree', 0],
  ['repair_note_tag_ids', 1],
  ['repair_native_marked_content_refs', 2],
  ['repair_bootstrapped_chart_content_refs', 3],
  ['repair_structure_conformance', 4],
  ['repair_native_link_structure', 0],
  ['set_page_tabs', 1],
  ['normalize_annotation_tab_order', 2],
  ['set_tabs_all_annotated_pages', 2],
  ['repair_annotation_alt_text', 3],
  ['set_link_annotation_contents', 4],
  ['embed_missing_fonts_in_place', 0],
  ['repair_font_unicode_maps', 1],
  ['repair_type1_font_unicode_maps', 2],
  ['repair_truetype_encoding_differences', 3],
  ['repair_cid_symbol_font_maps', 4],
  ['repair_cidset_consistency', 5],
  ['substitute_legacy_fonts_in_place', 6],
  ['finalize_substituted_font_conformance', 7],
  ['repair_other_elements_alt_text', 0],
  ['adobe_auto_tag', 0],
  ['repair_native_figure_semantics', 0],
  ['repair_native_table_headers', 1],
  ['repair_native_reading_order', 2],
  ['artifact_nonsemantic_page_elements', 3],
  ['replace_bookmarks_from_headings', 0],
  ['create_heading_from_candidate', 1],
  ['create_heading_tag', 2],
  ['set_table_header_cells', 3],
  ['set_figure_alt_text', 4],
  ['retag_as_figure_and_set_alt', 5],
  ['mark_figure_decorative', 6],
  ['reorder_structure_children', 7],
])

const CANDIDATE_ONLY_TOOLS = new Set<RemediationToolName>([
  'create_heading_from_candidate',
  'set_table_header_cells',
  'set_figure_alt_text',
  'retag_as_figure_and_set_alt',
  'mark_figure_decorative',
  'set_link_annotation_contents',
  'reorder_structure_children',
])

export interface RemediationPlanResult {
  done: boolean
  actions: RemediationToolCall[]
  unresolvedIssues: string[]
  failureProfile: import('./documentModel.js').FailureProfile
  plannerEvidence: import('./documentModel.js').PlannerEvidenceSummary
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

function hasMeaningfulMetadataTitle(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
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

function isNativeTaggedSafeContext(context: PdfRemediationContext): boolean {
  return context.qpdf.hasStructTree
    && context.qpdf.structTreeDepth > 0
    && (context.structure.structuralNodes?.length || 0) > 0
}

function scopeRank(scope: ToolOpportunityScope): number {
  switch (scope) {
    case 'document': return 0
    case 'page': return 1
    case 'candidate_group': return 2
    case 'candidate': return 3
    default: return 4
  }
}

function readingOrderGroupPriority(opportunity: ToolOpportunity, context: PdfRemediationContext): {
  disorder: number
  childCount: number
} {
  const candidateGroupId = opportunity.candidateGroupIds[0]
  const group = candidateGroupId
    ? context.readingOrderParentCandidates.find(entry => entry.id === candidateGroupId)
    : null
  return {
    disorder: group?.mcidDisorderBefore || 0,
    childCount: group?.childCandidateIds.length || Number.MAX_SAFE_INTEGER,
  }
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

function hasBlockingFailure(opportunity: ToolOpportunity, failureModeByKey: Map<string, FailureMode>): boolean {
  return opportunity.derivedFromFailureModeKeys.some(key => failureModeByKey.get(key)?.blocking)
}

function hasActionTool(actions: RemediationActionRecord[], tool: RemediationToolName): boolean {
  return actions.some(action => action.tool === tool)
}

function hasPlannedTool(actions: RemediationToolCall[], tool: RemediationToolName): boolean {
  return actions.some(action => action.tool_name === tool)
}

function attemptedOrPlanned(tool: RemediationToolName, actions: RemediationActionRecord[], planned: RemediationToolCall[]): boolean {
  return hasActionTool(actions, tool) || hasPlannedTool(planned, tool)
}

function firstAutoRunnableOpportunity(
  opportunities: ToolOpportunity[],
  toolName: RemediationToolName,
): ToolOpportunity | undefined {
  return opportunities.find(opportunity => opportunity.toolName === toolName && opportunity.status === 'auto_runnable')
}

function toolStage(tool: RemediationToolName): number {
  return TOOL_STAGE_ORDER.get(tool) || 99
}

function toolPriority(tool: RemediationToolName): number {
  return TOOL_PRIORITY.get(tool) || 99
}

function shouldUseBootstrappedChartConformance(input: {
  analysis: AnalysisResult
  context: PdfRemediationContext
  actions: RemediationActionRecord[]
  selectedActions?: RemediationToolCall[]
}): boolean {
  return input.analysis.pageCount === 1
    && input.context.qpdf.hasStructTree
    && (hasActionTool(input.actions, 'bootstrap_struct_tree')
      || hasPlannedTool(input.selectedActions ?? [], 'bootstrap_struct_tree'))
}

function hasSemanticOrManualOnlyIssues(failureModes: FailureMode[]): boolean {
  return failureModes.some(mode => mode.classification !== 'deterministic')
}

function headingLevelForCandidate(candidateId: string, context: PdfRemediationContext, selectedActions: RemediationToolCall[]): string {
  const candidate = context.headingCandidates.find(entry => entry.id === candidateId)
  if (!candidate) return 'H2'
  if (/^\/?H[1-6]$/i.test(candidate.existingTag || '')) {
    return String(candidate.existingTag).replace(/^\//, '').toUpperCase()
  }
  const h1AlreadyPlanned = selectedActions.some(action => action.tool_name === 'create_heading_from_candidate' && action.arguments.level === 'H1')
  return candidate.pageNumber === 1 && !h1AlreadyPlanned ? 'H1' : 'H2'
}

function figureAltText(candidateId: string, context: PdfRemediationContext): string {
  const candidate = context.figureCandidates.find(entry => entry.id === candidateId)
  if (!candidate) return 'Image'
  if (candidate.splitGenerated || candidate.informativeHint !== 'informative') {
    return `Decorative image on page ${candidate.pageNumber}`
  }
  if (candidate.surroundingText[0]) {
    return `Image related to ${candidate.surroundingText[0].replace(/[.]+$/, '').slice(0, 80)}`
  }
  return `Image on page ${candidate.pageNumber}`
}

function buildDeterministicCall(input: {
  filename: string
  analysis: AnalysisResult
  context: PdfRemediationContext
  opportunity: ToolOpportunity
  selectedActions: RemediationToolCall[]
}): RemediationToolCall | null {
  const { opportunity, context } = input
  const title = hasMeaningfulMetadataTitle(context.pdfjs.title)
    ? context.pdfjs.title!.trim()
    : suggestDocumentTitle({ filename: input.filename, context })
  const language = normalizeLanguageTag(context.qpdf.lang || context.pdfjs.lang || 'en') || 'en'

  switch (opportunity.toolName) {
    case 'set_pdfua_identification':
      return {
        tool_name: 'set_pdfua_identification',
        arguments: { title, language, part: 1, conformance: 'B' },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      }
    case 'normalize_document_metadata':
      return {
        tool_name: 'normalize_document_metadata',
        arguments: { title, language },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      }
    case 'set_document_title':
      return {
        tool_name: 'set_document_title',
        arguments: { title },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      }
    case 'set_document_language':
      return {
        tool_name: 'set_document_language',
        arguments: { language },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      }
    case 'bootstrap_struct_tree':
      return {
        tool_name: 'bootstrap_struct_tree',
        arguments: { target: 'document' },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      }
    case 'repair_note_tag_ids':
    case 'repair_native_marked_content_refs':
    case 'repair_native_link_structure':
    case 'repair_bootstrapped_chart_content_refs':
    case 'repair_structure_conformance':
    case 'embed_missing_fonts_in_place':
    case 'repair_font_unicode_maps':
    case 'repair_type1_font_unicode_maps':
    case 'repair_cid_symbol_font_maps':
    case 'repair_cidset_consistency':
    case 'substitute_legacy_fonts_in_place':
      return {
        tool_name: opportunity.toolName,
        arguments: { target: 'document' },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      }
    case 'finalize_substituted_font_conformance':
      return {
        tool_name: opportunity.toolName,
        arguments: { target: 'document', reportedWidthFixes: reportedWidthFixes(input.analysis) },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      }
    case 'repair_other_elements_alt_text':
    case 'repair_native_figure_semantics':
    case 'repair_native_table_headers':
    case 'repair_native_reading_order':
    case 'artifact_nonsemantic_page_elements':
    case 'normalize_annotation_tab_order':
    case 'set_tabs_all_annotated_pages':
    case 'repair_annotation_alt_text':
    case 'adobe_auto_tag':
      return {
        tool_name: opportunity.toolName,
        arguments: { target: 'document' },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      }
    case 'set_page_tabs': {
      const pageNumbers = [...new Set(context.pages.filter(page => page.links.length > 0).map(page => page.pageNumber))]
      if (!pageNumbers.length) return null
      return {
        tool_name: 'set_page_tabs',
        arguments: { pageNumbers },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      }
    }
    case 'set_link_annotation_contents': {
      const candidateId = opportunity.candidateIds[0]
      const candidate = context.linkCandidates.find(entry => entry.id === candidateId)
      const contents = candidate?.suggestedText || candidate?.text || candidate?.url || ''
      if (!candidateId || !contents.trim()) return null
      return {
        tool_name: 'set_link_annotation_contents',
        arguments: { candidateId, contents: contents.trim() },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      }
    }
    case 'replace_bookmarks_from_headings':
      return context.headingCandidates.some(candidate => candidate.text.trim())
        ? {
            tool_name: 'replace_bookmarks_from_headings',
            arguments: {},
            rationale: opportunity.reason,
            confidence: opportunity.confidence,
          }
        : null
    case 'create_heading_from_candidate': {
      const candidateId = opportunity.candidateIds[0]
      if (!candidateId) return null
      return {
        tool_name: 'create_heading_from_candidate',
        arguments: { candidateId, level: headingLevelForCandidate(candidateId, context, input.selectedActions) },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      }
    }
    case 'set_table_header_cells': {
      const candidateId = opportunity.candidateIds[0]
      const candidate = context.tableCandidates.find(entry => entry.id === candidateId)
      if (!candidate?.firstRowCellRefs?.length) return null
      return {
        tool_name: 'set_table_header_cells',
        arguments: { targets: candidate.firstRowCellRefs },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      }
    }
    case 'set_figure_alt_text':
    case 'retag_as_figure_and_set_alt': {
      const candidateId = opportunity.candidateIds[0]
      if (!candidateId) return null
      return {
        tool_name: opportunity.toolName,
        arguments: { candidateId, altText: figureAltText(candidateId, context) },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      }
    }
    case 'mark_figure_decorative': {
      const candidateId = opportunity.candidateIds[0]
      if (!candidateId) return null
      return {
        tool_name: 'mark_figure_decorative',
        arguments: { candidateId, decorative: true },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      }
    }
    case 'reorder_structure_children': {
      const candidateGroupId = opportunity.candidateGroupIds[0]
      const parentGroup = context.readingOrderParentCandidates.find(entry => entry.id === candidateGroupId)
      if (!candidateGroupId || !parentGroup) return null
      return {
        tool_name: 'reorder_structure_children',
        arguments: { candidateGroupId, parentRef: parentGroup.parentRef },
        rationale: opportunity.reason,
        confidence: opportunity.confidence,
      }
    }
    default:
      return null
  }
}

function isOpportunitySelectable(input: {
  opportunity: ToolOpportunity
  analysis: AnalysisResult
  context: PdfRemediationContext
  actions: RemediationActionRecord[]
  selectedActions: RemediationToolCall[]
  autoRunnableOpportunities: ToolOpportunity[]
}): boolean {
  const { opportunity, analysis, context, actions, selectedActions, autoRunnableOpportunities } = input
  if (opportunity.status !== 'auto_runnable') return false
  if (!TOOL_STAGE_ORDER.has(opportunity.toolName)) return false
  if (CANDIDATE_ONLY_TOOLS.has(opportunity.toolName) && opportunity.scope === 'document') return false

  const alreadyTaggedNative = !analysis.isScanned && isNativeTaggedSafeContext(context) && !hasActionTool(actions, 'bootstrap_struct_tree')
  const useBootstrappedChartConformance = shouldUseBootstrappedChartConformance({ analysis, context, actions, selectedActions })
  const hasAutoNativeMarkedContent = !!firstAutoRunnableOpportunity(autoRunnableOpportunities, 'repair_native_marked_content_refs')
  const hasAutoNativeLinkRepair = !!firstAutoRunnableOpportunity(autoRunnableOpportunities, 'repair_native_link_structure')

  switch (opportunity.toolName) {
    case 'repair_bootstrapped_chart_content_refs':
      return useBootstrappedChartConformance
    case 'repair_native_marked_content_refs':
    case 'repair_native_link_structure':
    case 'repair_native_figure_semantics':
    case 'repair_native_table_headers':
    case 'repair_native_reading_order':
      return alreadyTaggedNative
    case 'repair_structure_conformance':
      if (!context.qpdf.hasStructTree) return false
      if (useBootstrappedChartConformance && !!firstAutoRunnableOpportunity(autoRunnableOpportunities, 'repair_bootstrapped_chart_content_refs')) return false
      if (alreadyTaggedNative && (hasAutoNativeMarkedContent || hasAutoNativeLinkRepair)) return false
      return true
    case 'repair_type1_font_unicode_maps':
      return attemptedOrPlanned('repair_font_unicode_maps', actions, selectedActions)
        || opportunity.derivedFromFailureModeKeys.includes('pdfua.type1_unicode')
    case 'repair_cidset_consistency':
      return attemptedOrPlanned('embed_missing_fonts_in_place', actions, selectedActions)
        && (
          !firstAutoRunnableOpportunity(autoRunnableOpportunities, 'repair_font_unicode_maps')
          || attemptedOrPlanned('repair_font_unicode_maps', actions, selectedActions)
        )
        && (
          !firstAutoRunnableOpportunity(autoRunnableOpportunities, 'repair_cid_symbol_font_maps')
          || attemptedOrPlanned('repair_cid_symbol_font_maps', actions, selectedActions)
        )
    case 'substitute_legacy_fonts_in_place':
      return (
        (
          analysis.pageCount >= 10
          && attemptedOrPlanned('repair_type1_font_unicode_maps', actions, selectedActions)
        )
        || (
          opportunity.derivedFromFailureModeKeys.includes('pdfua.cidset_consistency')
          && attemptedOrPlanned('repair_cidset_consistency', actions, selectedActions)
        )
      )
        && attemptedOrPlanned('embed_missing_fonts_in_place', actions, selectedActions)
        && (
          attemptedOrPlanned('repair_font_unicode_maps', actions, selectedActions)
          || attemptedOrPlanned('repair_type1_font_unicode_maps', actions, selectedActions)
        )
    case 'finalize_substituted_font_conformance':
      return attemptedOrPlanned('substitute_legacy_fonts_in_place', actions, selectedActions)
    case 'adobe_auto_tag':
      return !attemptedOrPlanned('adobe_auto_tag', actions, selectedActions)
    case 'set_document_title':
      return !hasMeaningfulMetadataTitle(context.pdfjs.title)
    case 'set_document_language':
      return !(context.qpdf.lang || context.pdfjs.lang)
    case 'set_pdfua_identification':
    case 'normalize_document_metadata':
      return true
    default:
      return true
  }
}

function deterministicActions(input: {
  filename: string
  analysis: AnalysisResult
  context: PdfRemediationContext
  actions: RemediationActionRecord[]
  rejectedActions: RemediationActionRecord[]
}): { actions: RemediationToolCall[]; artifacts: ReturnType<typeof buildFailureProfileArtifacts> } {
  const artifacts = buildFailureProfileArtifacts({
    analysis: input.analysis,
    context: input.context,
    actions: input.actions,
    rejectedActions: input.rejectedActions,
  })
  const { failureProfile } = artifacts
  const failureModeByKey = new Map(failureProfile.failureModes.map(mode => [mode.key, mode]))
  const autoRunnableOpportunities = failureProfile.toolOpportunities.filter(opportunity => opportunity.status === 'auto_runnable')

  const selected: RemediationToolCall[] = []
  const selectedOpportunityKeys = new Set<string>()
  const orderedOpportunities = [...autoRunnableOpportunities].sort((a, b) => {
    const stageDiff = toolStage(a.toolName) - toolStage(b.toolName)
    if (stageDiff !== 0) return stageDiff
    const blockingDiff = Number(hasBlockingFailure(b, failureModeByKey)) - Number(hasBlockingFailure(a, failureModeByKey))
    if (blockingDiff !== 0) return blockingDiff
    const confidenceDiff = b.confidence - a.confidence
    if (confidenceDiff !== 0) return confidenceDiff
    const scopeDiff = scopeRank(a.scope) - scopeRank(b.scope)
    if (scopeDiff !== 0) return scopeDiff
    if (a.toolName === 'reorder_structure_children' && b.toolName === 'reorder_structure_children') {
      const aPriority = readingOrderGroupPriority(a, input.context)
      const bPriority = readingOrderGroupPriority(b, input.context)
      if (aPriority.disorder !== bPriority.disorder) return bPriority.disorder - aPriority.disorder
      if (aPriority.childCount !== bPriority.childCount) return aPriority.childCount - bPriority.childCount
    }
    const priorityDiff = toolPriority(a.toolName) - toolPriority(b.toolName)
    if (priorityDiff !== 0) return priorityDiff
    return a.key.localeCompare(b.key)
  })

  let changed = true
  while (changed && selected.length < MAX_ACTIONS) {
    changed = false
    for (const opportunity of orderedOpportunities) {
      if (selected.length >= MAX_ACTIONS) break
      if (selectedOpportunityKeys.has(opportunity.key)) continue
      if (!isOpportunitySelectable({
        opportunity,
        analysis: input.analysis,
        context: input.context,
        actions: input.actions,
        selectedActions: selected,
        autoRunnableOpportunities,
      })) {
        continue
      }
      const call = buildDeterministicCall({
        filename: input.filename,
        analysis: input.analysis,
        context: input.context,
        opportunity,
        selectedActions: selected,
      })
      if (!call) continue
      selected.push(call)
      selectedOpportunityKeys.add(opportunity.key)
      changed = true
    }
  }

  return { actions: dedupeActions(selected), artifacts }
}

function buildPrompt(input: {
  filename: string
  analysis: AnalysisResult
  context: PdfRemediationContext
  iteration: number
  actions: RemediationActionRecord[]
  rejectedActions: RemediationActionRecord[]
  precomputedArtifacts?: ReturnType<typeof buildFailureProfileArtifacts>
}): string {
  const { failureProfile, plannerEvidence } = input.precomputedArtifacts ?? buildFailureProfileArtifacts({
    analysis: input.analysis,
    context: input.context,
    actions: input.actions,
    rejectedActions: input.rejectedActions,
  })

  return [
    'You are planning in-place PDF accessibility remediation.',
    'Return tool calls only via the provided function schema.',
    'Prefer deterministic native PDF repairs and avoid visible changes unless necessary.',
    'Do not propose HTML rebuilds or page reconstruction.',
    `Filename: ${input.filename}`,
    `Iteration: ${input.iteration}`,
    `Open issues: ${JSON.stringify(issueCategoryIds(input.analysis))}`,
    `Failure modes: ${JSON.stringify(failureProfile.failureModes.slice(0, 12))}`,
    `Tool opportunities: ${JSON.stringify(failureProfile.toolOpportunities.slice(0, 20))}`,
    `Prior actions: ${JSON.stringify(input.actions.map(action => `${action.tool}:${action.candidateGroupId || action.candidateId || action.target}:${action.outcome}`))}`,
    `Rejected actions: ${JSON.stringify(input.rejectedActions.map(action => `${action.tool}:${action.candidateGroupId || action.candidateId || action.target}`))}`,
    `Planner evidence: ${JSON.stringify(plannerEvidence)}`,
  ].join('\n')
}

async function openAiPlan(messages: any[]): Promise<Pick<RemediationPlanResult, 'done' | 'actions' | 'unresolvedIssues'>> {
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
  actions: RemediationActionRecord[]
  rejectedActions: RemediationActionRecord[]
}): Promise<RemediationPlanResult> {
  const unresolvedIssues = issueCategoryIds(input.analysis)
  const { actions: deterministic, artifacts } = deterministicActions(input)
  if (deterministic.length > 0 || unresolvedIssues.length === 0) {
    return {
      done: unresolvedIssues.length === 0,
      actions: deterministic,
      unresolvedIssues,
      failureProfile: artifacts.failureProfile,
      plannerEvidence: artifacts.plannerEvidence,
    }
  }

  if (!REMEDIATION.ENABLE_PLANNER_AI_FALLBACK || !OPENAI_COMPAT_API_KEY) {
    return {
      done: false,
      actions: [],
      unresolvedIssues,
      failureProfile: artifacts.failureProfile,
      plannerEvidence: artifacts.plannerEvidence,
    }
  }

  try {
    const planned = await openAiPlan([{
      role: 'user',
      content: [{ type: 'text', text: buildPrompt({ ...input, precomputedArtifacts: artifacts }) }],
    }])
    return {
      done: planned.done,
      actions: dedupeActions(planned.actions),
      unresolvedIssues: planned.unresolvedIssues.length ? planned.unresolvedIssues : unresolvedIssues,
      failureProfile: artifacts.failureProfile,
      plannerEvidence: artifacts.plannerEvidence,
    }
  } catch {
    return {
      done: false,
      actions: [],
      unresolvedIssues,
      failureProfile: artifacts.failureProfile,
      plannerEvidence: artifacts.plannerEvidence,
    }
  }
}
