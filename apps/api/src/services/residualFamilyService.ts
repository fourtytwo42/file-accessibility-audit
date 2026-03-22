import type { AnalysisResult } from './pdfAnalyzer.js'
import type {
  FailureMode,
  FailureProfile,
  FamilyPostconditionStatus,
  RemediationActionRecord,
  RemediationToolName,
  ResidualFamilyDecision,
  ResidualFamilyId,
  ResidualSemanticPolicy,
  ToolOpportunity,
} from './documentModel.js'
import type { PdfRemediationContext } from './pdfRemediationTools.js'

type ResidualFamilyDefinition = {
  id: ResidualFamilyId
  label: string
  priority: number
  semanticPolicy: ResidualSemanticPolicy
  failureModeKeys: string[]
  categoryIds: string[]
  preferredTools: RemediationToolName[]
  deprioritizedTools: RemediationToolName[]
  expectedPostconditions: string[]
  regressionCanaries: string[]
}

type BuildResidualFamilyInput = {
  analysis: AnalysisResult
  context: PdfRemediationContext
  failureModes: FailureMode[]
  toolOpportunities: ToolOpportunity[]
  actions: RemediationActionRecord[]
}

type EvaluateActionPostconditionsInput = {
  action: RemediationActionRecord
  previous: AnalysisResult
  next: AnalysisResult
  previousContext?: Pick<PdfRemediationContext, 'qpdf' | 'figureCandidates'> | null
  nextContext?: Pick<PdfRemediationContext, 'qpdf' | 'figureCandidates'> | null
  residualFamilies?: ResidualFamilyDecision[]
}

type EvaluateActionPostconditionsResult = {
  familyId?: ResidualFamilyId
  status: FamilyPostconditionStatus
  signals: string[]
}

const RESIDUAL_FAMILY_DEFINITIONS: ResidualFamilyDefinition[] = [
  {
    id: 'metadata_normalization',
    label: 'Metadata normalization',
    priority: 10,
    semanticPolicy: 'forbidden',
    failureModeKeys: [
      'category.title_language',
      'pdfua.metadata_identification',
      'pdfua.document_language',
      'pdfua.display_doc_title',
    ],
    categoryIds: ['title_language', 'pdf_ua_compliance'],
    preferredTools: ['set_pdfua_identification', 'normalize_document_metadata', 'set_document_language', 'set_document_title'],
    deprioritizedTools: [],
    expectedPostconditions: ['metadata_blocking_keys_shrink', 'title_language_improves'],
    regressionCanaries: ['processed_runtime_metadata', 'annual_reports_metadata_stage'],
  },
  {
    id: 'bookmark_language_outline_cleanup',
    label: 'Bookmark and outline cleanup',
    priority: 20,
    semanticPolicy: 'optional_after_deterministic',
    failureModeKeys: ['category.bookmarks', 'pdfua.bookmark_language'],
    categoryIds: ['bookmarks', 'pdf_ua_compliance'],
    preferredTools: ['replace_bookmarks_from_headings'],
    deprioritizedTools: ['normalize_document_metadata'],
    expectedPostconditions: ['bookmark_blocking_keys_shrink', 'bookmark_score_improves'],
    regressionCanaries: ['97anreport_bookmark_cleanup'],
  },
  {
    id: 'font_embedding_and_unicode',
    label: 'Font embedding and Unicode',
    priority: 30,
    semanticPolicy: 'forbidden',
    failureModeKeys: [
      'pdfua.font_embedding',
      'pdfua.font_unicode',
      'pdfua.type1_unicode',
      'pdfua.truetype_encoding_differences',
      'pdfua.font_widths',
      'pdfua.cid_symbol_fonts',
      'pdfua.cidset_consistency',
    ],
    categoryIds: ['text_extractability', 'pdf_ua_compliance'],
    preferredTools: [
      'embed_missing_fonts_in_place',
      'repair_font_unicode_maps',
      'repair_type1_font_unicode_maps',
      'repair_cid_symbol_font_maps',
      'repair_cidset_consistency',
      'substitute_legacy_fonts_in_place',
      'finalize_substituted_font_conformance',
    ],
    deprioritizedTools: [],
    expectedPostconditions: ['font_blocking_keys_shrink', 'font_counters_shrink'],
    regressionCanaries: ['processed_font_cluster', 'annual_report_font_tail'],
  },
  {
    id: 'table_structure_recovery',
    label: 'Table structure recovery',
    priority: 40,
    semanticPolicy: 'forbidden',
    failureModeKeys: ['category.table_markup', 'pdfua.table_regularity', 'context.table_candidates_blocked'],
    categoryIds: ['table_markup', 'pdf_ua_compliance'],
    preferredTools: ['repair_native_table_headers', 'set_table_header_cells'],
    deprioritizedTools: [],
    expectedPostconditions: ['table_blocking_keys_shrink', 'table_markup_improves'],
    regressionCanaries: ['annual_report_table_recovery'],
  },
  {
    id: 'link_tabs_and_annotation_cleanup',
    label: 'Link, tabs, and annotation cleanup',
    priority: 50,
    semanticPolicy: 'optional_after_deterministic',
    failureModeKeys: [
      'category.link_quality',
      'pdfua.page_tabs',
      'pdfua.annotation_alt_contents',
      'pdfua.link_tagging',
    ],
    categoryIds: ['link_quality', 'reading_order', 'pdf_ua_compliance'],
    preferredTools: [
      'repair_native_link_structure',
      'set_page_tabs',
      'normalize_annotation_tab_order',
      'set_tabs_all_annotated_pages',
      'repair_annotation_alt_text',
      'set_link_annotation_contents',
      'rewrite_link_visible_text',
      'update_link_visible_text',
    ],
    deprioritizedTools: [],
    expectedPostconditions: ['link_blocking_keys_shrink', 'page_tabs_clear', 'annotation_alt_clear'],
    regressionCanaries: ['annual_report_link_tabs_cleanup'],
  },
  {
    id: 'native_figure_convergence',
    label: 'Native figure convergence',
    priority: 60,
    semanticPolicy: 'optional_after_deterministic',
    failureModeKeys: [
      'category.alt_text',
      'pdfua.figure_alt_or_artifact',
      'pdfua.figure_alt_quality',
      'context.figure_candidates_blocked',
      'context.long_report_figure_residue',
    ],
    categoryIds: ['alt_text', 'pdf_ua_compliance'],
    preferredTools: [
      'repair_native_figure_semantics',
      'repair_other_elements_alt_text',
      'set_figure_alt_text',
      'retag_as_figure_and_set_alt',
      'mark_figure_decorative',
    ],
    deprioritizedTools: ['artifact_nonsemantic_page_elements'],
    expectedPostconditions: ['figure_blocking_keys_shrink', 'alt_text_improves', 'figure_candidate_surface_shrinks'],
    regressionCanaries: ['long_report_figure_cleanup'],
  },
  {
    id: 'post_bootstrap_heading_convergence',
    label: 'Post-bootstrap heading convergence',
    priority: 70,
    semanticPolicy: 'optional_after_deterministic',
    failureModeKeys: [
      'category.heading_structure',
      'context.post_bootstrap_native_structure_debt',
      'context.post_bootstrap_structural_residue',
      'context.post_heading_creation_native_structure_debt',
    ],
    categoryIds: ['heading_structure', 'reading_order', 'pdf_ua_compliance'],
    preferredTools: [
      'artifact_nonsemantic_page_elements',
      'normalize_heading_hierarchy',
      'create_heading_from_candidate',
      'repair_structure_conformance',
      'repair_native_marked_content_refs',
    ],
    deprioritizedTools: ['bootstrap_struct_tree', 'repair_native_marked_content_refs'],
    expectedPostconditions: ['heading_blocking_keys_shrink', 'heading_structure_improves'],
    regressionCanaries: ['annual_report_heading_convergence'],
  },
  {
    id: 'logical_structure_marked_content',
    label: 'Logical structure and marked content',
    priority: 80,
    semanticPolicy: 'forbidden',
    failureModeKeys: ['pdfua.logical_structure', 'pdfua.structure'],
    categoryIds: ['reading_order', 'text_extractability', 'pdf_ua_compliance'],
    preferredTools: [
      'repair_native_marked_content_refs',
      'artifact_nonsemantic_page_elements',
      'repair_bootstrapped_chart_content_refs',
      'repair_structure_conformance',
    ],
    deprioritizedTools: ['bootstrap_struct_tree'],
    expectedPostconditions: ['logical_structure_blocking_keys_shrink', 'logical_structure_scores_improve'],
    regressionCanaries: ['annual_report_structure_tail'],
  },
  {
    id: 'unresolved_manual_family',
    label: 'Unresolved manual family',
    priority: 999,
    semanticPolicy: 'manual_only',
    failureModeKeys: [],
    categoryIds: [],
    preferredTools: [],
    deprioritizedTools: [],
    expectedPostconditions: ['manual_review_required'],
    regressionCanaries: ['manual_review_queue'],
  },
]

const FAMILY_BY_ID = new Map(RESIDUAL_FAMILY_DEFINITIONS.map(definition => [definition.id, definition]))

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}

function blockingKeys(result: AnalysisResult): string[] {
  return (result.localStandards?.findings ?? [])
    .filter(finding => finding.blocking)
    .map(finding => finding.key)
}

function categoryScore(result: AnalysisResult, categoryId: string): number | null {
  const category = result.categories.find(entry => entry.id === categoryId)
  return typeof category?.score === 'number' ? category.score : null
}

function blockingKeyRemoved(previous: AnalysisResult, next: AnalysisResult, keys: string[]): string[] {
  const previousBlocking = new Set(blockingKeys(previous))
  const nextBlocking = new Set(blockingKeys(next))
  return keys.filter(key => previousBlocking.has(key) && !nextBlocking.has(key))
}

function categoryImprovement(previous: AnalysisResult, next: AnalysisResult, categories: string[]): string[] {
  return categories.filter(categoryId => {
    const before = categoryScore(previous, categoryId)
    const after = categoryScore(next, categoryId)
    return typeof before === 'number' && typeof after === 'number' && after > before
  })
}

function shrinkSignal(label: string, previousValue: number | null | undefined, nextValue: number | null | undefined): string[] {
  if (typeof previousValue !== 'number' || typeof nextValue !== 'number') return []
  return nextValue < previousValue ? [`${label}:${previousValue}->${nextValue}`] : []
}

function familyMatches(definition: ResidualFamilyDefinition, input: BuildResidualFamilyInput): boolean {
  const failureModeKeys = new Set(input.failureModes.map(mode => mode.key))
  if (definition.failureModeKeys.some(key => failureModeKeys.has(key))) return true
  if (definition.categoryIds.some(categoryId => categoryScore(input.analysis, categoryId) !== null && (categoryScore(input.analysis, categoryId) ?? 100) < 100)) {
    return true
  }
  return input.toolOpportunities.some(opportunity =>
    definition.preferredTools.includes(opportunity.toolName)
    || definition.deprioritizedTools.includes(opportunity.toolName),
  )
}

function opportunityFamilyScore(opportunity: ToolOpportunity, definition: ResidualFamilyDefinition): number {
  let score = 0
  if (definition.preferredTools.includes(opportunity.toolName)) score += 4
  if (definition.deprioritizedTools.includes(opportunity.toolName)) score += 1
  const matchedFailureKeys = opportunity.derivedFromFailureModeKeys.filter(key => definition.failureModeKeys.includes(key))
  score += matchedFailureKeys.length * 5
  const matchedCategories = opportunity.categoryTargets.filter(categoryId => definition.categoryIds.includes(categoryId))
  score += matchedCategories.length * 3
  return score
}

function currentFamilyStep(definition: ResidualFamilyDefinition, opportunities: ToolOpportunity[]): number | null {
  for (let index = 0; index < definition.preferredTools.length; index += 1) {
    const toolName = definition.preferredTools[index]!
    if (opportunities.some(opportunity => opportunity.toolName === toolName && opportunity.status === 'auto_runnable')) {
      return index + 1
    }
  }
  for (let index = 0; index < definition.preferredTools.length; index += 1) {
    const toolName = definition.preferredTools[index]!
    if (opportunities.some(opportunity => opportunity.toolName === toolName)) {
      return index + 1
    }
  }
  return null
}

export function buildResidualFamilyDecisions(input: BuildResidualFamilyInput): ResidualFamilyDecision[] {
  const decisions = RESIDUAL_FAMILY_DEFINITIONS
    .filter(definition => definition.id !== 'unresolved_manual_family')
    .filter(definition => familyMatches(definition, input))
    .map(definition => {
      const familyFailureModes = input.failureModes.filter(mode =>
        definition.failureModeKeys.includes(mode.key)
        || mode.categoryIds.some(categoryId => definition.categoryIds.includes(categoryId)),
      )
      const familyOpportunities = input.toolOpportunities.filter(opportunity => opportunityFamilyScore(opportunity, definition) > 0)
      return {
        id: definition.id,
        label: definition.label,
        priority: definition.priority,
        blocking: familyFailureModes.some(mode => mode.blocking),
        semanticPolicy: definition.semanticPolicy,
        failureModeKeys: sortedUnique(familyFailureModes.map(mode => mode.key)),
        categoryIds: sortedUnique(familyFailureModes.flatMap(mode => mode.categoryIds.filter(categoryId => definition.categoryIds.includes(categoryId)))),
        preferredTools: [...definition.preferredTools],
        deprioritizedTools: [...definition.deprioritizedTools],
        expectedPostconditions: [...definition.expectedPostconditions],
        activeOpportunityKeys: sortedUnique(familyOpportunities.map(opportunity => opportunity.key)),
        currentStep: currentFamilyStep(definition, familyOpportunities),
        regressionCanaries: [...definition.regressionCanaries],
      } satisfies ResidualFamilyDecision
    })
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))

  const hasBlockingManualIssue = input.failureModes.some(mode => mode.blocking && mode.classification === 'manual_only')
  if (!decisions.length || hasBlockingManualIssue) {
    const unresolved = FAMILY_BY_ID.get('unresolved_manual_family')!
    decisions.push({
      id: unresolved.id,
      label: unresolved.label,
      priority: unresolved.priority,
      blocking: hasBlockingManualIssue || !decisions.some(decision => decision.blocking),
      semanticPolicy: unresolved.semanticPolicy,
      failureModeKeys: sortedUnique(input.failureModes.filter(mode => mode.classification === 'manual_only').map(mode => mode.key)),
      categoryIds: sortedUnique(input.failureModes.filter(mode => mode.classification === 'manual_only').flatMap(mode => mode.categoryIds)),
      preferredTools: [...unresolved.preferredTools],
      deprioritizedTools: [...unresolved.deprioritizedTools],
      expectedPostconditions: [...unresolved.expectedPostconditions],
      activeOpportunityKeys: [],
      currentStep: null,
      regressionCanaries: [...unresolved.regressionCanaries],
    })
  }

  return decisions
}

export function annotateToolOpportunitiesWithResidualFamilies(input: {
  toolOpportunities: ToolOpportunity[]
  residualFamilies: ResidualFamilyDecision[]
}): ToolOpportunity[] {
  const familyDefinitions = input.residualFamilies
    .map(family => ({
      family,
      definition: FAMILY_BY_ID.get(family.id),
    }))
    .filter(entry => !!entry.definition) as Array<{ family: ResidualFamilyDecision; definition: ResidualFamilyDefinition }>

  return input.toolOpportunities.map(opportunity => {
    const match = familyDefinitions
      .map(entry => ({
        family: entry.family,
        score: opportunityFamilyScore(opportunity, entry.definition),
      }))
      .filter(entry => entry.score > 0)
      .sort((left, right) =>
        right.score - left.score
        || left.family.priority - right.family.priority
        || left.family.id.localeCompare(right.family.id),
      )[0]

    if (!match) return opportunity
    const familyStep = match.family.preferredTools.findIndex(toolName => toolName === opportunity.toolName)
    return {
      ...opportunity,
      familyId: match.family.id,
      familyStep: familyStep >= 0 ? familyStep + 1 : undefined,
      expectedPostconditions: match.family.expectedPostconditions,
    }
  })
}

export function inferResidualFamilyFromAction(
  action: Pick<RemediationActionRecord, 'tool' | 'familyId'>,
  residualFamilies: ResidualFamilyDecision[] = [],
): ResidualFamilyId | undefined {
  if (action.familyId) return action.familyId
  const directMatch = residualFamilies.find(family => family.preferredTools.includes(action.tool) || family.deprioritizedTools.includes(action.tool))
  if (directMatch) return directMatch.id
  return RESIDUAL_FAMILY_DEFINITIONS
    .filter(definition => definition.id !== 'unresolved_manual_family')
    .find(definition => definition.preferredTools.includes(action.tool) || definition.deprioritizedTools.includes(action.tool))
    ?.id
}

function evaluateMetadataSignals(previous: AnalysisResult, next: AnalysisResult): string[] {
  return [
    ...blockingKeyRemoved(previous, next, ['pdfua.metadata_identification', 'pdfua.document_language', 'pdfua.display_doc_title']),
    ...categoryImprovement(previous, next, ['title_language']).map(categoryId => `category_improved:${categoryId}`),
  ]
}

function evaluateBookmarkSignals(previous: AnalysisResult, next: AnalysisResult): string[] {
  return [
    ...blockingKeyRemoved(previous, next, ['pdfua.bookmark_language']).map(key => `blocking_removed:${key}`),
    ...categoryImprovement(previous, next, ['bookmarks']).map(categoryId => `category_improved:${categoryId}`),
  ]
}

function evaluateFontSignals(
  previous: AnalysisResult,
  next: AnalysisResult,
  previousContext?: Pick<PdfRemediationContext, 'qpdf'> | null,
  nextContext?: Pick<PdfRemediationContext, 'qpdf'> | null,
): string[] {
  return [
    ...blockingKeyRemoved(previous, next, [
      'pdfua.font_embedding',
      'pdfua.font_unicode',
      'pdfua.type1_unicode',
      'pdfua.truetype_encoding_differences',
      'pdfua.cid_symbol_fonts',
      'pdfua.cidset_consistency',
    ]).map(key => `blocking_removed:${key}`),
    ...categoryImprovement(previous, next, ['text_extractability', 'pdf_ua_compliance']).map(categoryId => `category_improved:${categoryId}`),
    ...shrinkSignal('fontsMissingToUnicodeBlocking', previousContext?.qpdf?.fontsMissingToUnicodeBlocking, nextContext?.qpdf?.fontsMissingToUnicodeBlocking),
    ...shrinkSignal('unembeddedFontCount', previousContext?.qpdf?.unembeddedFontCount, nextContext?.qpdf?.unembeddedFontCount),
  ]
}

function evaluateTableSignals(previous: AnalysisResult, next: AnalysisResult): string[] {
  return [
    ...blockingKeyRemoved(previous, next, ['pdfua.table_regularity']).map(key => `blocking_removed:${key}`),
    ...categoryImprovement(previous, next, ['table_markup']).map(categoryId => `category_improved:${categoryId}`),
  ]
}

function evaluateLinkSignals(previous: AnalysisResult, next: AnalysisResult): string[] {
  return [
    ...blockingKeyRemoved(previous, next, ['pdfua.page_tabs', 'pdfua.annotation_alt_contents', 'pdfua.link_tagging']).map(key => `blocking_removed:${key}`),
    ...categoryImprovement(previous, next, ['link_quality', 'reading_order', 'pdf_ua_compliance']).map(categoryId => `category_improved:${categoryId}`),
  ]
}

function evaluateFigureSignals(
  previous: AnalysisResult,
  next: AnalysisResult,
  previousContext?: Pick<PdfRemediationContext, 'figureCandidates'> | null,
  nextContext?: Pick<PdfRemediationContext, 'figureCandidates'> | null,
): string[] {
  return [
    ...blockingKeyRemoved(previous, next, ['pdfua.figure_alt_or_artifact', 'pdfua.figure_alt_quality']).map(key => `blocking_removed:${key}`),
    ...categoryImprovement(previous, next, ['alt_text']).map(categoryId => `category_improved:${categoryId}`),
    ...shrinkSignal('figureCandidates', previousContext?.figureCandidates?.length ?? null, nextContext?.figureCandidates?.length ?? null),
  ]
}

function evaluateHeadingSignals(previous: AnalysisResult, next: AnalysisResult): string[] {
  return [
    ...blockingKeyRemoved(previous, next, [
      'context.post_bootstrap_native_structure_debt',
      'context.post_bootstrap_structural_residue',
      'context.post_heading_creation_native_structure_debt',
    ]).map(key => `blocking_removed:${key}`),
    ...categoryImprovement(previous, next, ['heading_structure', 'reading_order', 'pdf_ua_compliance']).map(categoryId => `category_improved:${categoryId}`),
  ]
}

function evaluateLogicalStructureSignals(previous: AnalysisResult, next: AnalysisResult): string[] {
  return [
    ...blockingKeyRemoved(previous, next, ['pdfua.logical_structure', 'pdfua.structure']).map(key => `blocking_removed:${key}`),
    ...categoryImprovement(previous, next, ['reading_order', 'text_extractability', 'pdf_ua_compliance']).map(categoryId => `category_improved:${categoryId}`),
  ]
}

export function evaluateActionPostconditions(input: EvaluateActionPostconditionsInput): EvaluateActionPostconditionsResult {
  const familyId = inferResidualFamilyFromAction(input.action, input.residualFamilies)
  if (!familyId || input.action.outcome !== 'applied') {
    return {
      familyId,
      status: 'unknown',
      signals: [],
    }
  }

  const signals = (() => {
    switch (familyId) {
      case 'metadata_normalization':
        return evaluateMetadataSignals(input.previous, input.next)
      case 'bookmark_language_outline_cleanup':
        return evaluateBookmarkSignals(input.previous, input.next)
      case 'font_embedding_and_unicode':
        return evaluateFontSignals(input.previous, input.next, input.previousContext, input.nextContext)
      case 'table_structure_recovery':
        return evaluateTableSignals(input.previous, input.next)
      case 'link_tabs_and_annotation_cleanup':
        return evaluateLinkSignals(input.previous, input.next)
      case 'native_figure_convergence':
        return evaluateFigureSignals(input.previous, input.next, input.previousContext, input.nextContext)
      case 'post_bootstrap_heading_convergence':
        return evaluateHeadingSignals(input.previous, input.next)
      case 'logical_structure_marked_content':
        return evaluateLogicalStructureSignals(input.previous, input.next)
      default:
        return []
    }
  })()

  if (signals.length) {
    return {
      familyId,
      status: 'satisfied',
      signals: sortedUnique(signals),
    }
  }

  return {
    familyId,
    status: input.action.changedDocumentBytes ? 'not_satisfied' : 'unknown',
    signals: [],
  }
}

export function semanticSidecarEligibleFamilies(failureProfile: FailureProfile): ResidualFamilyDecision[] {
  return failureProfile.residualFamilies.filter(family =>
    family.semanticPolicy === 'optional_after_deterministic'
    && family.blocking
    && !failureProfile.toolOpportunities.some(opportunity =>
      opportunity.familyId === family.id
      && opportunity.status === 'auto_runnable'
      && opportunity.scope !== 'candidate'
      && opportunity.scope !== 'candidate_group',
    ),
  )
}
