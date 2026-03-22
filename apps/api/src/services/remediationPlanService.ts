import { REMEDIATION } from '#config'
import type { AnalysisResult } from './pdfAnalyzer.js'
import type {
  FailureMode,
  PlannerEvidenceSummary,
  PipelineConfig,
  PdfClassification,
  PdfStructuralClass,
  RemediationActionRecord,
  RemediationToolCall,
  RemediationToolName,
  ToolOpportunity,
  ToolOpportunityScope,
} from './documentModel.js'
import { buildFailureProfileArtifacts } from './failureProfileService.js'
import type { PdfRemediationContext } from './pdfRemediationTools.js'
import { buildPipelineConfig, classifyPdfFull } from './pdfClassificationService.js'
import { classifyPdf, getToolReliabilityMap } from './toolReliabilityService.js'
import { deriveDeterministicCall, hasMeaningfulMetadataTitle, heuristicFigureAltText } from './remediationCallDerivationService.js'
import { needsLanguageTagNormalization } from './languageTags.js'

const OPENAI_COMPAT_BASE_URL = process.env.OPENAI_COMPAT_BASE_URL || process.env.OPENROUTER_BASE_URL || 'http://192.168.50.239:51824/v1'
const OPENAI_COMPAT_API_KEY = process.env.OPENAI_COMPAT_API_KEY || process.env.OPENROUTER_API_KEY || 'hs_a9a29d90a35c4b1c8a709e17c8c76dcf'
const OPENAI_COMPAT_MODEL = process.env.OPENAI_COMPAT_MODEL || process.env.OPENROUTER_MODEL || 'gpt-5.1-codex-mini'
const PLAN_REMEDIATION_TOOL = 'plan_pdf_remediation'
const MAX_ACTIONS = 32
const RESERVED_HEADING_ACTIONS = 8
const LONG_REPORT_RESERVED_HEADING_ACTIONS = 3

const STRUCTURE_BOOTSTRAP_STAGE = new Set<RemediationToolName>([
  'bootstrap_struct_tree',
  'repair_malformed_bdc_operators',
  'repair_native_marked_content_refs',
  'repair_bootstrapped_chart_content_refs',
  'repair_structure_conformance',
])

const STRUCTURE_LINK_STAGE = new Set<RemediationToolName>([
  'repair_native_link_structure',
  'tag_unowned_annotations',
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
  'repair_note_tag_ids',
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
  ['repair_malformed_bdc_operators', 2],
  ['repair_native_marked_content_refs', 2],
  ['repair_bootstrapped_chart_content_refs', 2],
  ['repair_structure_conformance', 2],
  ['repair_native_link_structure', 3],
  ['tag_unowned_annotations', 3],
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
  ['repair_note_tag_ids', 5],
  ['repair_other_elements_alt_text', 5],
  ['adobe_auto_tag', 5],
  ['repair_native_figure_semantics', 5],
  ['repair_native_table_headers', 5],
  ['repair_native_reading_order', 5],
  ['artifact_nonsemantic_page_elements', 5],
  ['replace_bookmarks_from_headings', 6],
  ['normalize_heading_hierarchy', 6],
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
  ['repair_malformed_bdc_operators', 1],
  ['repair_native_marked_content_refs', 2],
  ['repair_bootstrapped_chart_content_refs', 3],
  ['repair_structure_conformance', 4],
  ['repair_native_link_structure', 0],
  ['tag_unowned_annotations', 1],
  ['set_page_tabs', 2],
  ['normalize_annotation_tab_order', 3],
  ['set_tabs_all_annotated_pages', 3],
  ['repair_annotation_alt_text', 4],
  ['set_link_annotation_contents', 5],
  ['embed_missing_fonts_in_place', 0],
  ['repair_cid_symbol_font_maps', 1],
  ['repair_font_unicode_maps', 2],
  ['repair_type1_font_unicode_maps', 3],
  ['repair_truetype_encoding_differences', 4],
  ['repair_cidset_consistency', 5],
  ['substitute_legacy_fonts_in_place', 6],
  ['finalize_substituted_font_conformance', 7],
  ['repair_note_tag_ids', 0],
  ['repair_other_elements_alt_text', 0],
  ['adobe_auto_tag', 0],
  ['repair_native_figure_semantics', 0],
  ['repair_native_table_headers', 1],
  ['repair_native_reading_order', 2],
  ['artifact_nonsemantic_page_elements', 3],
  ['replace_bookmarks_from_headings', 0],
  ['normalize_heading_hierarchy', 0],
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

function isCandidateFloodOpportunity(opportunity: ToolOpportunity): boolean {
  return opportunity.scope === 'candidate' || opportunity.scope === 'candidate_group'
}

function isNativeTaggedSafeContext(context: PdfRemediationContext): boolean {
  return context.qpdf.hasStructTree
    && context.qpdf.structTreeDepth > 0
    && (context.structure.structuralNodes?.length || 0) > 0
}

const NATIVE_SAFE_REPAIR_TOOLS = new Set<RemediationToolName>([
  'repair_native_marked_content_refs',
  'repair_native_link_structure',
  'tag_unowned_annotations',
  'repair_native_figure_semantics',
  'repair_native_table_headers',
  'repair_native_reading_order',
])

const BROAD_STRUCTURE_FAILURE_KEYS = new Set([
  'pdfua.logical_structure',
  'pdfua.structure',
])

function classAllowsNativeSafeRepair(structuralClass: PdfStructuralClass): boolean {
  return structuralClass === 'partially_tagged'
    || structuralClass === 'native_tagged'
    || structuralClass === 'well_tagged'
}

function hasDirectStructureFailure(opportunity: ToolOpportunity): boolean {
  return opportunity.derivedFromFailureModeKeys.some(key => BROAD_STRUCTURE_FAILURE_KEYS.has(key))
}

function hasNarrowerStructureAlternative(input: {
  opportunity: ToolOpportunity
  autoRunnableOpportunities: ToolOpportunity[]
  pipelineConfig: PipelineConfig | null
  reliabilityByTool: Map<RemediationToolName, { reliability: number, source?: string }>
  failureModeByKey: Map<string, FailureMode>
}): boolean {
  const { opportunity, autoRunnableOpportunities, pipelineConfig, reliabilityByTool, failureModeByKey } = input
  const excluded = new Set(pipelineConfig?.excludedTools || [])
  return autoRunnableOpportunities.some(candidate =>
    candidate.toolName !== opportunity.toolName
    && !excluded.has(candidate.toolName)
    && NATIVE_SAFE_REPAIR_TOOLS.has(candidate.toolName)
    && candidate.derivedFromFailureModeKeys.some(key => opportunity.derivedFromFailureModeKeys.includes(key))
    && !shouldSkipForLowReliability({
      opportunity: candidate,
      reliability: reliabilityByTool.get(candidate.toolName)?.reliability ?? REMEDIATION.TOOL_RELIABILITY_DEFAULT,
      reliabilitySource: reliabilityByTool.get(candidate.toolName)?.source,
      autoRunnableOpportunities,
      failureModeByKey,
      pipelineConfig,
    })
  )
}

function shouldSkipForLowReliability(input: {
  opportunity: ToolOpportunity
  reliability: number
  reliabilitySource: string | undefined
  autoRunnableOpportunities: ToolOpportunity[]
  failureModeByKey: Map<string, FailureMode>
  pipelineConfig: PipelineConfig | null
}): boolean {
  const { opportunity, reliability, reliabilitySource, autoRunnableOpportunities, failureModeByKey, pipelineConfig } = input
  if (reliabilitySource === 'default') return false
  if (reliability >= REMEDIATION.TOOL_CLASS_RELIABILITY_SKIP_THRESHOLD) return false

  const blockingDerivedKeys = opportunity.derivedFromFailureModeKeys.filter(key => failureModeByKey.get(key)?.blocking)
  if (!blockingDerivedKeys.length) return true

  const excluded = new Set(pipelineConfig?.excludedTools || [])
  const hasAlternative = autoRunnableOpportunities.some(candidate =>
    candidate.toolName !== opportunity.toolName
    && !excluded.has(candidate.toolName)
    && candidate.status === 'auto_runnable'
    && candidate.derivedFromFailureModeKeys.some(key => blockingDerivedKeys.includes(key))
  )

  return hasAlternative
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

function hasBlockingFailure(opportunity: ToolOpportunity, failureModeByKey: Map<string, FailureMode>): boolean {
  return opportunity.derivedFromFailureModeKeys.some(key => failureModeByKey.get(key)?.blocking)
}

function activeIssueCategoryIds(input: {
  analysis: AnalysisResult
  failureModeByKey: Map<string, FailureMode>
}): Set<string> {
  const active = new Set<string>(issueCategoryIds(input.analysis))
  for (const mode of input.failureModeByKey.values()) {
    for (const categoryId of mode.categoryIds) {
      active.add(categoryId)
    }
  }
  return active
}

function opportunityTargetsActiveIssue(input: {
  opportunity: ToolOpportunity
  activeIssueIds: Set<string>
  failureModeByKey: Map<string, FailureMode>
}): boolean {
  if (input.opportunity.categoryTargets.some(categoryId => input.activeIssueIds.has(categoryId))) {
    return true
  }
  return input.opportunity.derivedFromFailureModeKeys.some(key =>
    (input.failureModeByKey.get(key)?.categoryIds || []).some(categoryId => input.activeIssueIds.has(categoryId)),
  )
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
  return (input.analysis.pageCount === 1 || (input.analysis.pageCount >= 20 && !input.analysis.isScanned))
    && input.context.qpdf.hasStructTree
    && (hasActionTool(input.actions, 'bootstrap_struct_tree')
      || hasPlannedTool(input.selectedActions ?? [], 'bootstrap_struct_tree'))
}

function hasSemanticOrManualOnlyIssues(failureModes: FailureMode[]): boolean {
  return failureModes.some(mode => mode.classification !== 'deterministic')
}

function actionAttemptOutcome(
  tool: RemediationToolName,
  actions: RemediationActionRecord[],
): RemediationActionRecord['outcome'] | null {
  const prior = [...actions].reverse().find(action => action.tool === tool)
  return prior?.outcome ?? null
}

function buildDeterministicCall(input: {
  filename: string
  analysis: AnalysisResult
  context: PdfRemediationContext
  opportunity: ToolOpportunity
  selectedActions: RemediationToolCall[]
}): RemediationToolCall | null {
  return deriveDeterministicCall(input)
}

function opportunitySelectionDecision(input: {
  opportunity: ToolOpportunity
  analysis: AnalysisResult
  context: PdfRemediationContext
  classification: PdfClassification
  pipelineConfig: PipelineConfig | null
  actions: RemediationActionRecord[]
  selectedActions: RemediationToolCall[]
  autoRunnableOpportunities: ToolOpportunity[]
  reliabilityByTool: Map<RemediationToolName, { reliability: number, source?: string }>
  failureModeByKey: Map<string, FailureMode>
}): { selectable: boolean, reason?: string } {
  const {
    opportunity,
    analysis,
    context,
    classification,
    pipelineConfig,
    actions,
    selectedActions,
    autoRunnableOpportunities,
    reliabilityByTool,
    failureModeByKey,
  } = input
  if (opportunity.status !== 'auto_runnable') return { selectable: false, reason: `opportunity_status:${opportunity.status}` }
  if (!TOOL_STAGE_ORDER.has(opportunity.toolName)) return { selectable: false, reason: 'tool_not_ranked' }
  if ((pipelineConfig?.excludedTools || []).includes(opportunity.toolName)) return { selectable: false, reason: `pipeline_excluded:${opportunity.toolName}` }
  if (CANDIDATE_ONLY_TOOLS.has(opportunity.toolName) && opportunity.scope === 'document') return { selectable: false, reason: `candidate_only_scope:${opportunity.toolName}` }

  const structuralClass = classification.structuralClass
  const allowsPostBootstrapNativeConvergence = opportunity.derivedFromFailureModeKeys.includes('context.post_bootstrap_native_structure_debt')
    || opportunity.derivedFromFailureModeKeys.includes('context.post_bootstrap_structural_residue')
    || opportunity.derivedFromFailureModeKeys.includes('context.post_heading_creation_native_structure_debt')
  const nativeSafeContext = !analysis.isScanned
    && isNativeTaggedSafeContext(context)
    && (
      allowsPostBootstrapNativeConvergence
      || (!hasActionTool(actions, 'bootstrap_struct_tree')
        && !hasPlannedTool(selectedActions, 'bootstrap_struct_tree'))
    )
  const useBootstrappedChartConformance = shouldUseBootstrappedChartConformance({ analysis, context, actions, selectedActions })
  const postBootstrapStructuralResidue = failureModeByKey.has('context.post_bootstrap_structural_residue')
  const hasAutoNativeMarkedContent = !!firstAutoRunnableOpportunity(autoRunnableOpportunities, 'repair_native_marked_content_refs')
  const hasAutoNativeLinkRepair = !!firstAutoRunnableOpportunity(autoRunnableOpportunities, 'repair_native_link_structure')
  const repairFontUnicodeOutcome = actionAttemptOutcome('repair_font_unicode_maps', actions)
  const repairCidSetOutcome = actionAttemptOutcome('repair_cidset_consistency', actions)
  const persistentLegacyFontFailures = opportunity.derivedFromFailureModeKeys.some(key =>
    key === 'pdfua.font_embedding'
    || key === 'pdfua.font_unicode'
    || key === 'pdfua.type1_unicode'
    || key === 'pdfua.cid_symbol_fonts'
    || key === 'pdfua.cidset_consistency'
    || key === 'pdfua.font_widths',
  )

  const reliabilitySummary = reliabilityByTool.get(opportunity.toolName)
  if (shouldSkipForLowReliability({
    opportunity,
    reliability: reliabilitySummary?.reliability ?? REMEDIATION.TOOL_RELIABILITY_DEFAULT,
    reliabilitySource: reliabilitySummary?.source,
    autoRunnableOpportunities,
    failureModeByKey,
    pipelineConfig,
  })) {
    return { selectable: false, reason: `low_class_reliability:${opportunity.toolName}` }
  }

  switch (opportunity.toolName) {
    case 'bootstrap_struct_tree':
      if (
        analysis.pageCount >= 20
        && !analysis.isScanned
        && hasActionTool(actions, 'bootstrap_struct_tree')
        && (
          postBootstrapStructuralResidue
          || (context.qpdf.headings?.length || 0) > 0
        )
      ) {
        return { selectable: false, reason: 'post_bootstrap_cleanup_supersedes_repeat_bootstrap' }
      }
      return { selectable: true }
    case 'repair_bootstrapped_chart_content_refs':
      return {
        selectable: useBootstrappedChartConformance,
        reason: useBootstrappedChartConformance ? undefined : 'bootstrapped_chart_not_applicable',
      }
    case 'repair_native_marked_content_refs':
    case 'repair_native_link_structure':
    case 'tag_unowned_annotations':
    case 'repair_native_figure_semantics':
    case 'repair_native_table_headers':
    case 'repair_native_reading_order':
      return {
        selectable: nativeSafeContext && classAllowsNativeSafeRepair(structuralClass),
        reason: nativeSafeContext && classAllowsNativeSafeRepair(structuralClass)
          ? undefined
          : `structural_class_blocks_native_safe:${structuralClass}`,
      }
    case 'repair_structure_conformance':
      if (!context.qpdf.hasStructTree) return { selectable: false, reason: 'no_struct_tree' }
      if (structuralClass === 'well_tagged') return { selectable: false, reason: `structural_class_blocks_broad_structure:${structuralClass}` }
      if (!hasDirectStructureFailure(opportunity)) return { selectable: false, reason: 'no_direct_structure_failure_family' }
      if (useBootstrappedChartConformance && !!firstAutoRunnableOpportunity(autoRunnableOpportunities, 'repair_bootstrapped_chart_content_refs')) {
        return { selectable: false, reason: 'superseded_by_bootstrapped_chart_conformance' }
      }
      if (hasNarrowerStructureAlternative({
        opportunity,
        autoRunnableOpportunities,
        pipelineConfig,
        reliabilityByTool,
        failureModeByKey,
      })) {
        return { selectable: false, reason: 'superseded_by_narrow_native_structure_repair' }
      }
      if (structuralClass === 'untagged_digital' || structuralClass === 'scanned') {
        return { selectable: false, reason: `structural_class_blocks_broad_structure:${structuralClass}` }
      }
      if (structuralClass === 'native_tagged' && (hasAutoNativeMarkedContent || hasAutoNativeLinkRepair)) {
        return { selectable: false, reason: 'native_tagged_prefers_narrow_repairs' }
      }
      return { selectable: true }
    case 'create_heading_from_candidate':
      if (
        analysis.pageCount >= 20
        && !analysis.isScanned
        && postBootstrapStructuralResidue
        && (context.qpdf.headings?.length || 0) > 0
      ) {
        return { selectable: false, reason: 'post_bootstrap_structural_residue_blocks_heading_creation' }
      }
      return { selectable: true }
    case 'repair_type1_font_unicode_maps':
      return {
        selectable: attemptedOrPlanned('repair_font_unicode_maps', actions, selectedActions)
          || !firstAutoRunnableOpportunity(autoRunnableOpportunities, 'repair_font_unicode_maps'),
        reason: 'font_unicode_prereq_missing',
      }
    case 'repair_cidset_consistency':
      return {
        selectable: attemptedOrPlanned('embed_missing_fonts_in_place', actions, selectedActions)
        && (
          !firstAutoRunnableOpportunity(autoRunnableOpportunities, 'repair_font_unicode_maps')
          || attemptedOrPlanned('repair_font_unicode_maps', actions, selectedActions)
        )
        && (
          !firstAutoRunnableOpportunity(autoRunnableOpportunities, 'repair_cid_symbol_font_maps')
          || attemptedOrPlanned('repair_cid_symbol_font_maps', actions, selectedActions)
        ),
        reason: 'cidset_prereqs_missing',
      }
    case 'substitute_legacy_fonts_in_place':
      return {
        selectable: persistentLegacyFontFailures
        && (
          (
            !firstAutoRunnableOpportunity(autoRunnableOpportunities, 'repair_type1_font_unicode_maps')
            || attemptedOrPlanned('repair_type1_font_unicode_maps', actions, selectedActions)
          )
          && (
            !firstAutoRunnableOpportunity(autoRunnableOpportunities, 'repair_cidset_consistency')
            || attemptedOrPlanned('repair_cidset_consistency', actions, selectedActions)
            || repairCidSetOutcome === 'no_effect'
            || repairCidSetOutcome === 'applied'
          )
          && (
            repairFontUnicodeOutcome === 'no_effect'
            || repairFontUnicodeOutcome === 'applied'
            || attemptedOrPlanned('repair_font_unicode_maps', actions, selectedActions)
          )
        )
        && attemptedOrPlanned('embed_missing_fonts_in_place', actions, selectedActions)
        && (
          attemptedOrPlanned('repair_font_unicode_maps', actions, selectedActions)
          || attemptedOrPlanned('repair_type1_font_unicode_maps', actions, selectedActions)
        ),
        reason: 'legacy_font_substitution_prereqs_missing',
      }
    case 'finalize_substituted_font_conformance':
      return {
        selectable: persistentLegacyFontFailures
        && attemptedOrPlanned('substitute_legacy_fonts_in_place', actions, selectedActions),
        reason: 'finalize_substituted_fonts_prereqs_missing',
      }
    case 'adobe_auto_tag':
      return {
        selectable: !attemptedOrPlanned('adobe_auto_tag', actions, selectedActions),
        reason: 'already_attempted:adobe_auto_tag',
      }
    case 'set_document_title':
      return {
        selectable: !hasMeaningfulMetadataTitle(context.pdfjs.title),
        reason: 'metadata_title_already_present',
      }
    case 'set_document_language':
      const currentLanguage = context.qpdf.lang || context.pdfjs.lang || ''
      return {
        selectable: !currentLanguage || needsLanguageTagNormalization(currentLanguage),
        reason: 'document_language_already_present',
      }
    case 'set_pdfua_identification':
    case 'normalize_document_metadata':
      return { selectable: true }
    default:
      return { selectable: true }
  }
}

function mergePlannerEvidenceSummary(base: PlannerEvidenceSummary, selectionSkipCounts: Map<string, number>): PlannerEvidenceSummary {
  if (!selectionSkipCounts.size) return base
  const merged = new Map<string, number>()
  for (const entry of base.skippedReasonCounts) merged.set(entry.reason, entry.count)
  for (const [reason, count] of selectionSkipCounts.entries()) {
    merged.set(reason, (merged.get(reason) || 0) + count)
  }
  return {
    ...base,
    skippedReasonCounts: [...merged.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  }
}

async function deterministicActions(input: {
  filename: string
  analysis: AnalysisResult
  context: PdfRemediationContext
  iteration: number
  actions: RemediationActionRecord[]
  rejectedActions: RemediationActionRecord[]
  pipelineConfig?: PipelineConfig | null
}): Promise<{ actions: RemediationToolCall[]; artifacts: ReturnType<typeof buildFailureProfileArtifacts> }> {
  const classification = classifyPdfFull({
    analysis: input.analysis,
    context: {
      qpdf: input.context.qpdf,
      pdfjs: input.context.pdfjs,
    },
  })
  const effectivePipelineConfig = input.pipelineConfig ?? buildPipelineConfig(classification)
  const baseArtifacts = buildFailureProfileArtifacts({
    analysis: input.analysis,
    context: input.context,
    actions: input.actions,
    rejectedActions: input.rejectedActions,
  })
  const { failureProfile } = baseArtifacts
  const failureModeByKey = new Map(failureProfile.failureModes.map(mode => [mode.key, mode]))
  const activeIssues = activeIssueCategoryIds({
    analysis: input.analysis,
    failureModeByKey,
  })
  const selectionSkipCounts = new Map<string, number>()
  const autoRunnableOpportunities = failureProfile.toolOpportunities.filter(opportunity =>
    opportunity.status === 'auto_runnable'
    && !((effectivePipelineConfig?.excludedTools || []).includes(opportunity.toolName))
    && (
      input.iteration <= 1
      || opportunityTargetsActiveIssue({
        opportunity,
        activeIssueIds: activeIssues,
        failureModeByKey,
      })
    ),
  )
  for (const opportunity of failureProfile.toolOpportunities) {
    if (opportunity.status !== 'auto_runnable') continue
    if ((effectivePipelineConfig?.excludedTools || []).includes(opportunity.toolName)) {
      const reason = `pipeline_excluded:${opportunity.toolName}`
      selectionSkipCounts.set(reason, (selectionSkipCounts.get(reason) || 0) + 1)
    }
  }

  const pdfClass = classifyPdf({
    analysis: input.analysis,
    context: input.context,
  })
  const reliabilityByTool = getToolReliabilityMap(
    [...new Set(autoRunnableOpportunities.map(opportunity => opportunity.toolName))],
    pdfClass,
  )

  const selected: RemediationToolCall[] = []
  const selectedOpportunityKeys = new Set<string>()
  const orderedOpportunities = [...autoRunnableOpportunities].sort((a, b) => {
    const stageDiff = toolStage(a.toolName) - toolStage(b.toolName)
    if (stageDiff !== 0) return stageDiff
    const blockingDiff = Number(hasBlockingFailure(b, failureModeByKey)) - Number(hasBlockingFailure(a, failureModeByKey))
    if (blockingDiff !== 0) return blockingDiff
    const weightedConfidenceA = a.confidence * (reliabilityByTool.get(a.toolName)?.reliability ?? REMEDIATION.TOOL_RELIABILITY_DEFAULT)
    const weightedConfidenceB = b.confidence * (reliabilityByTool.get(b.toolName)?.reliability ?? REMEDIATION.TOOL_RELIABILITY_DEFAULT)
    const confidenceDiff = weightedConfidenceB - weightedConfidenceA
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

  const headingStructureUnresolved = issueCategoryIds(input.analysis).includes('heading_structure')
  const postBootstrapStructureDebt = failureModeByKey.has('context.post_bootstrap_native_structure_debt')
  const postBootstrapStructuralResidue = failureModeByKey.has('context.post_bootstrap_structural_residue')
  const postHeadingCreationStructureDebt = failureModeByKey.has('context.post_heading_creation_native_structure_debt')
  const longReportConvergence = input.analysis.pageCount >= 20 && !input.analysis.isScanned
  const longReportMetadataDebt = longReportConvergence && (
    failureModeByKey.has('category.title_language')
    || failureModeByKey.has('pdfua.metadata_identification')
    || failureModeByKey.has('pdfua.document_language')
    || failureModeByKey.has('pdfua.display_doc_title')
  )
  const headingSelectionLimit = longReportConvergence ? LONG_REPORT_RESERVED_HEADING_ACTIONS : RESERVED_HEADING_ACTIONS
  const selectionPasses: Array<{
    includeOpportunity: (opportunity: ToolOpportunity) => boolean
    maxSelections?: number
  }> = [
    {
      includeOpportunity: (opportunity: ToolOpportunity) =>
        longReportMetadataDebt
        && opportunity.scope === 'document'
        && ['set_pdfua_identification', 'normalize_document_metadata', 'set_document_language', 'set_document_title'].includes(opportunity.toolName),
      maxSelections: 4,
    },
    {
      includeOpportunity: (opportunity: ToolOpportunity) =>
        postBootstrapStructuralResidue
        && opportunity.scope === 'document'
        && ['artifact_nonsemantic_page_elements', 'repair_bootstrapped_chart_content_refs'].includes(opportunity.toolName),
      maxSelections: 2,
    },
    {
      includeOpportunity: (opportunity: ToolOpportunity) =>
        postBootstrapStructuralResidue
        && opportunity.scope === 'document'
        && ['repair_native_marked_content_refs', 'repair_structure_conformance'].includes(opportunity.toolName),
      maxSelections: 2,
    },
    {
      includeOpportunity: (opportunity: ToolOpportunity) =>
        postHeadingCreationStructureDebt
        && opportunity.scope === 'document'
        && ['normalize_heading_hierarchy', 'repair_native_marked_content_refs', 'repair_structure_conformance'].includes(opportunity.toolName),
      maxSelections: 3,
    },
    {
      includeOpportunity: (opportunity: ToolOpportunity) =>
        postBootstrapStructureDebt
        && opportunity.scope === 'document'
        && ['normalize_heading_hierarchy', 'repair_native_marked_content_refs', 'repair_structure_conformance'].includes(opportunity.toolName),
      maxSelections: 3,
    },
    {
      includeOpportunity: (opportunity: ToolOpportunity) =>
        headingStructureUnresolved
        && opportunity.toolName === 'normalize_heading_hierarchy'
        && opportunity.scope === 'document',
      maxSelections: 1,
    },
    {
      includeOpportunity: (opportunity: ToolOpportunity) =>
        headingStructureUnresolved
        && opportunity.toolName === 'create_heading_from_candidate'
        && opportunity.scope === 'candidate',
      maxSelections: headingSelectionLimit,
    },
    {
      includeOpportunity: (opportunity: ToolOpportunity) => !isCandidateFloodOpportunity(opportunity),
    },
    {
      includeOpportunity: (_opportunity: ToolOpportunity) => true,
    },
  ]
  for (const selectionPass of selectionPasses) {
    let changed = true
    let passSelections = 0
    while (changed && selected.length < MAX_ACTIONS) {
      changed = false
      for (const opportunity of orderedOpportunities) {
        if (selected.length >= MAX_ACTIONS) break
        if (selectionPass.maxSelections !== undefined && passSelections >= selectionPass.maxSelections) break
        if (!selectionPass.includeOpportunity(opportunity)) continue
        if (selectedOpportunityKeys.has(opportunity.key)) continue
        const decision = opportunitySelectionDecision({
          opportunity,
          analysis: input.analysis,
          context: input.context,
          classification,
          pipelineConfig: effectivePipelineConfig,
          actions: input.actions,
          selectedActions: selected,
          autoRunnableOpportunities,
          reliabilityByTool: reliabilityByTool as any,
          failureModeByKey,
        })
        if (!decision.selectable) {
          if (decision.reason) {
            selectionSkipCounts.set(decision.reason, (selectionSkipCounts.get(decision.reason) || 0) + 1)
          }
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
        passSelections += 1
        changed = true
      }
    }
  }

  return {
    actions: dedupeActions(selected),
    artifacts: {
      ...baseArtifacts,
      plannerEvidence: mergePlannerEvidenceSummary(baseArtifacts.plannerEvidence, selectionSkipCounts),
    },
  }
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
  pipelineConfig?: PipelineConfig | null
}): Promise<RemediationPlanResult> {
  const unresolvedIssues = issueCategoryIds(input.analysis)
  const { actions: deterministic, artifacts } = await deterministicActions(input)
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
