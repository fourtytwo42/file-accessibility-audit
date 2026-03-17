import type { AnalysisResult } from './pdfAnalyzer.js'
import type {
  FailureClassification,
  FailureMode,
  FailureProfile,
  PlannerEvidenceSummary,
  RemediationActionRecord,
  RemediationIteration,
  RemediationToolName,
  ToolOpportunity,
  ToolOpportunityScope,
  ToolOpportunityStatus,
} from './documentModel.js'
import type { PdfRemediationContext } from './pdfRemediationTools.js'
import { ALT_REMOVAL_MODES } from './altTextScoring.js'
import { needsLanguageTagNormalization, normalizeLanguageTag } from './languageTags.js'

interface BuildFailureProfileInput {
  analysis: AnalysisResult
  context: PdfRemediationContext
  actions: RemediationActionRecord[]
  rejectedActions: RemediationActionRecord[]
  iterations?: RemediationIteration[]
}

interface VeraPdfFailureFamily {
  key: string
  label: string
  pattern: RegExp
  nativeToolFamilies: RemediationToolName[]
  categoryIds: string[]
  classification: FailureClassification
}

const SEMANTIC_CATEGORY_IDS = new Set(['heading_structure', 'alt_text', 'table_markup', 'link_quality'])
const MANUAL_ONLY_CATEGORY_IDS = new Set(['text_extractability'])

const VERA_PDF_FAILURE_FAMILIES: VeraPdfFailureFamily[] = [
  {
    key: 'pdfua.metadata_identification',
    label: 'PDF/UA metadata and identification',
    pattern: /pdf\/ua identification|identification extension schema|conformance level|metadata stream doesn't contain pdf\/ua/i,
    nativeToolFamilies: ['set_pdfua_identification', 'normalize_document_metadata'],
    categoryIds: ['title_language', 'pdf_ua_compliance'],
    classification: 'deterministic',
  },
  {
    key: 'pdfua.document_language',
    label: 'Document language tag',
    pattern: /lang entry.*language identifier|value .* of the lang entry is not a language-tag|language-tag as defined in rfc 3066/i,
    nativeToolFamilies: ['set_document_language', 'normalize_document_metadata', 'set_pdfua_identification'],
    categoryIds: ['title_language', 'pdf_ua_compliance'],
    classification: 'deterministic',
  },
  {
    key: 'pdfua.display_doc_title',
    label: 'Display document title metadata',
    pattern: /viewerpreferences|displaydoctitle|document catalog dictionary shall include a viewerpreferences dictionary/i,
    nativeToolFamilies: ['set_document_title', 'normalize_document_metadata', 'set_pdfua_identification'],
    categoryIds: ['title_language', 'pdf_ua_compliance'],
    classification: 'deterministic',
  },
  {
    key: 'pdfua.page_tabs',
    label: 'Page tab order metadata',
    pattern: /\/tabs\b|value shall be s\b|page dictionary.*key tabs|key tabs with value s|\btab order\b|annotation.*tab order|tabs shall/i,
    nativeToolFamilies: ['set_page_tabs', 'normalize_annotation_tab_order', 'set_tabs_all_annotated_pages'],
    categoryIds: ['reading_order', 'pdf_ua_compliance'],
    classification: 'deterministic',
  },
  {
    key: 'pdfua.annotation_alt_contents',
    label: 'Link annotation alternate descriptions',
    pattern: /alternate description via their contents key|links shall contain an alternate description|\/contents\b/i,
    nativeToolFamilies: ['set_link_annotation_contents'],
    categoryIds: ['link_quality', 'pdf_ua_compliance'],
    classification: 'deterministic',
  },
  {
    key: 'pdfua.logical_structure',
    label: 'Logical structure and marked content',
    pattern: /content shall be marked as artifact|content is neither marked as artifact nor tagged as real content|logical structure|parenttree|marked content|structtree/i,
    nativeToolFamilies: ['repair_native_marked_content_refs', 'repair_structure_conformance', 'repair_bootstrapped_chart_content_refs', 'artifact_nonsemantic_page_elements'],
    categoryIds: ['text_extractability', 'reading_order', 'pdf_ua_compliance'],
    classification: 'deterministic',
  },
  {
    key: 'pdfua.link_tagging',
    label: 'Link structure tagging',
    pattern: /links shall be tagged|link annotation.*not.*tagged|link annotation.*shall.*enclosed|annotation.*shall.*enclosed.*link|link.*artifact|link.*null tag|link.*reference tag/i,
    nativeToolFamilies: ['repair_native_link_structure'],
    categoryIds: ['link_quality', 'reading_order', 'pdf_ua_compliance'],
    classification: 'deterministic',
  },
  {
    key: 'pdfua.note_tag_id',
    label: 'Note tag identifiers',
    pattern: /note tag shall have id entry|\/note.*id entry/i,
    nativeToolFamilies: ['repair_note_tag_ids'],
    categoryIds: ['reading_order', 'pdf_ua_compliance'],
    classification: 'deterministic',
  },
  {
    key: 'pdfua.font_embedding',
    label: 'Font embedding',
    pattern: /font programs.*embedded|font program is not embedded/i,
    nativeToolFamilies: ['embed_missing_fonts_in_place', 'substitute_legacy_fonts_in_place', 'finalize_substituted_font_conformance'],
    categoryIds: ['text_extractability', 'pdf_ua_compliance'],
    classification: 'deterministic',
  },
  {
    key: 'pdfua.font_unicode',
    label: 'Font Unicode mapping',
    pattern: /map of all used character codes to unicode|glyph can not be mapped to unicode|\/tounicode\b|tounicode/i,
    nativeToolFamilies: ['repair_font_unicode_maps'],
    categoryIds: ['text_extractability', 'pdf_ua_compliance'],
    classification: 'deterministic',
  },
  {
    key: 'pdfua.type1_unicode',
    label: 'Legacy Type1 or Type3 Unicode mapping',
    pattern: /could not derive a tounicode map for .*type1|type1|type3|encoding differences|custom encoding/i,
    nativeToolFamilies: ['repair_type1_font_unicode_maps'],
    categoryIds: ['text_extractability', 'pdf_ua_compliance'],
    classification: 'deterministic',
  },
  {
    key: 'pdfua.truetype_encoding_differences',
    label: 'TrueType encoding Differences array compliance',
    pattern: /non-symbolic truetype.*differences|differences array.*adobe glyph list|glyph names.*differences array|encoding.*winansicoding.*differences|differences.*unicode compliant.*false/i,
    nativeToolFamilies: ['repair_truetype_encoding_differences'],
    categoryIds: ['text_extractability', 'pdf_ua_compliance'],
    classification: 'deterministic',
  },
  {
    key: 'pdfua.font_widths',
    label: 'Font width consistency',
    pattern: /glyph width .*not consistent with the widths entry|width information in the font dictionary/i,
    nativeToolFamilies: ['substitute_legacy_fonts_in_place', 'finalize_substituted_font_conformance'],
    categoryIds: ['text_extractability', 'pdf_ua_compliance'],
    classification: 'deterministic',
  },
  {
    key: 'pdfua.cid_symbol_fonts',
    label: 'CID symbol font mappings',
    pattern: /cidtogidmap|type 2 cidfont|wingdings|symbolmt/i,
    nativeToolFamilies: ['repair_cid_symbol_font_maps'],
    categoryIds: ['text_extractability', 'pdf_ua_compliance'],
    classification: 'deterministic',
  },
  {
    key: 'pdfua.cidset_consistency',
    label: 'CIDSet consistency',
    pattern: /cidset stream|cidset entry in the font descriptor|fontdescriptor dictionary of an embedded cid font contains a cidset/i,
    nativeToolFamilies: ['repair_cidset_consistency', 'substitute_legacy_fonts_in_place', 'finalize_substituted_font_conformance'],
    categoryIds: ['text_extractability', 'pdf_ua_compliance'],
    classification: 'deterministic',
  },
  {
    key: 'pdfua.figure_alt_or_artifact',
    label: 'Figure alternate text or artifacts',
    pattern: /other elements alternate text|alternate text.*failed|artifact image|decorative image/i,
    nativeToolFamilies: ['set_figure_alt_text', 'retag_as_figure_and_set_alt', 'mark_figure_decorative', 'artifact_nonsemantic_page_elements'],
    categoryIds: ['alt_text', 'pdf_ua_compliance'],
    classification: 'semantic',
  },
]

function classificationForCategory(categoryId: string, analysis: AnalysisResult): FailureClassification {
  if (SEMANTIC_CATEGORY_IDS.has(categoryId)) return 'semantic'
  if (MANUAL_ONLY_CATEGORY_IDS.has(categoryId) && analysis.isScanned) return 'manual_only'
  return 'deterministic'
}

function nowIso(): string {
  return new Date().toISOString()
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function sortedNumeric(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

function actionTargetForOpportunity(input: {
  scope: ToolOpportunityScope
  candidateIds?: string[]
  candidateGroupIds?: string[]
  pageNumbers?: number[]
}): string {
  if (input.scope === 'candidate') return input.candidateIds?.[0] || 'document'
  if (input.scope === 'candidate_group') return input.candidateGroupIds?.[0] || 'document'
  if (input.scope === 'page') return input.pageNumbers?.length === 1 ? `page ${input.pageNumbers[0]}` : 'document'
  return 'document'
}

function actionKey(tool: RemediationToolName, target: string): string {
  return `${tool}:${target}`
}

function opportunityKey(toolName: RemediationToolName, scope: ToolOpportunityScope, target: string): string {
  return `${toolName}:${scope}:${target}`
}

function mergeMode(existing: Map<string, FailureMode>, next: FailureMode) {
  const current = existing.get(next.key)
  if (!current) {
    existing.set(next.key, {
      ...next,
      categoryIds: unique(next.categoryIds),
      nativeToolFamilies: unique(next.nativeToolFamilies),
      evidence: unique(next.evidence).slice(0, 5),
    })
    return
  }

  existing.set(next.key, {
    ...current,
    count: current.count + next.count,
    blocking: current.blocking || next.blocking,
    unmatched: current.unmatched || next.unmatched,
    categoryIds: unique([...current.categoryIds, ...next.categoryIds]),
    nativeToolFamilies: unique([...current.nativeToolFamilies, ...next.nativeToolFamilies]),
    evidence: unique([...current.evidence, ...next.evidence]).slice(0, 5),
  })
}

function mapVeraPdfFailure(failure: AnalysisResult['verapdf']['failures'][number]): VeraPdfFailureFamily | null {
  const message = failure.message || ''
  return VERA_PDF_FAILURE_FAMILIES.find(family => family.pattern.test(message)) || null
}

function buildFailureModes(input: BuildFailureProfileInput): FailureMode[] {
  const modes = new Map<string, FailureMode>()

  for (const category of input.analysis.categories) {
    if (typeof category.score !== 'number' || category.score >= 100) continue
    mergeMode(modes, {
      key: `category.${category.id}`,
      label: category.label,
      source: 'category',
      count: 1,
      categoryIds: [category.id],
      blocking: category.severity === 'Critical',
      unmatched: false,
      classification: classificationForCategory(category.id, input.analysis),
      nativeToolFamilies: [],
      evidence: category.findings.slice(0, 2),
    })
  }

  if (input.analysis.verapdf.status === 'failed') {
    let unmatchedCount = 0
    const unmatchedEvidence: string[] = []
    for (const failure of input.analysis.verapdf.failures) {
      const family = mapVeraPdfFailure(failure)
      if (!family) {
        unmatchedCount += 1
        unmatchedEvidence.push(failure.message)
        continue
      }
      mergeMode(modes, {
        key: family.key,
        label: family.label,
        source: 'verapdf',
        count: 1,
        categoryIds: unique([...family.categoryIds, ...failure.categoryIds]),
        blocking: true,
        unmatched: false,
        classification: family.classification,
        nativeToolFamilies: family.nativeToolFamilies,
        evidence: [failure.message],
      })
    }
    if (unmatchedCount > 0) {
      mergeMode(modes, {
        key: 'pdfua.unmatched',
        label: 'Unmatched PDF/UA failures',
        source: 'verapdf',
        count: unmatchedCount,
        categoryIds: ['pdf_ua_compliance'],
        blocking: true,
        unmatched: true,
        classification: 'manual_only',
        nativeToolFamilies: [],
        evidence: unmatchedEvidence,
      })
    }
  }

  if (input.analysis.adobe?.status === 'failed' && input.analysis.adobe.findings.length) {
    const grouped = new Map<string, { label: string; count: number; evidence: string[]; categoryIds: string[] }>()
    for (const finding of input.analysis.adobe.findings) {
      if (finding.severity === 'info') continue
      const key = `adobe.${finding.categoryId || 'general'}`
      const current = grouped.get(key) || {
        label: finding.categoryId ? `Adobe ${finding.categoryId.replace(/_/g, ' ')}` : 'Adobe accessibility findings',
        count: 0,
        evidence: [],
        categoryIds: finding.categoryId ? [finding.categoryId] : ['pdf_ua_compliance'],
      }
      current.count += 1
      current.evidence.push(finding.message)
      grouped.set(key, current)
    }
    for (const [key, value] of grouped.entries()) {
      const includesAlt = value.categoryIds.includes('alt_text')
      mergeMode(modes, {
        key,
        label: value.label,
        source: 'composite',
        count: value.count,
        categoryIds: value.categoryIds,
        blocking: true,
        unmatched: false,
        classification: includesAlt ? 'semantic' : 'deterministic',
        nativeToolFamilies: includesAlt
          ? ['repair_other_elements_alt_text', 'repair_native_figure_semantics', 'adobe_auto_tag']
          : ['adobe_auto_tag'],
        evidence: value.evidence.slice(0, 3),
      })
    }
  }

  const blockedHeadings = input.context.headingCandidates.filter(candidate => candidate.repairMode !== 'safe')
  if (blockedHeadings.length) {
    mergeMode(modes, {
      key: 'context.heading_candidates_blocked',
      label: 'Heading candidates need semantic or manual review',
      source: 'context',
      count: blockedHeadings.length,
      categoryIds: ['heading_structure'],
      blocking: false,
      unmatched: false,
      classification: 'semantic',
      nativeToolFamilies: ['create_heading_from_candidate'],
      evidence: blockedHeadings.map(candidate => candidate.unsafeReason || candidate.text).slice(0, 3),
    })
  }

  const blockedFigures = input.context.figureCandidates.filter(candidate => candidate.repairMode === 'defer')
  if (blockedFigures.length) {
    mergeMode(modes, {
      key: 'context.figure_candidates_blocked',
      label: 'Figure candidates need semantic or manual review',
      source: 'context',
      count: blockedFigures.length,
      categoryIds: ['alt_text'],
      blocking: false,
      unmatched: false,
      classification: blockedFigures.some(candidate => /^unsafe_|^no_image_evidence/i.test(candidate.unsafeReason || '')) ? 'manual_only' : 'semantic',
      nativeToolFamilies: ['set_figure_alt_text', 'retag_as_figure_and_set_alt', 'mark_figure_decorative'],
      evidence: blockedFigures.map(candidate => candidate.unsafeReason || candidate.id).slice(0, 3),
    })
  }

  const acrobatAltRiskNodes = input.context.structure.acrobatAltRiskNodes || []
  // Determine unresolved alt risk nodes. The resolution semantics differ by mode:
  // - orphaned_alt_empty_element / nonfigure_with_alt: unresolved when /Alt IS present (needs removal)
  // - all other modes: unresolved when /Alt is NOT present (needs addition)
  const unresolvedAltRiskNodes = acrobatAltRiskNodes.filter(node =>
    ALT_REMOVAL_MODES.has(node.ownershipMode ?? '') ? node.hasAlt : !node.hasAlt
  )
  if (unresolvedAltRiskNodes.length) {
    const hasDeterministicRepair = unresolvedAltRiskNodes.some(node =>
      node.ownershipMode === 'duplicate_mcid_ownership'
      || node.ownershipMode === 'container_with_graphics_descendants'
      // split-safe: can rewrite content stream to separate text and graphics MCIDs
      || (node.ownershipMode === 'mixed_text_graphics_same_mcid' && node.splitSafe)
      // orphaned_alt_empty_element: remove /Alt from empty element with no content
      || node.ownershipMode === 'orphaned_alt_empty_element'
      // nonfigure_with_alt: remove /Alt from non-Figure element that has actual content
      || node.ownershipMode === 'nonfigure_with_alt'
      // untagged images: wraps Do operator in BDC/EMC and creates /Figure struct element
      || node.ownershipMode === 'untagged_image_mcid'
      || node.ownershipMode === 'untagged_image_direct');
    mergeMode(modes, {
      key: 'acrobat.other_elements_alt_text',
      label: 'Acrobat-style other-elements alternate text',
      source: 'context',
      count: unresolvedAltRiskNodes.length,
      categoryIds: ['alt_text'],
      blocking: true,
      unmatched: false,
      classification: hasDeterministicRepair ? 'deterministic' : 'manual_only',
      nativeToolFamilies: hasDeterministicRepair ? ['repair_other_elements_alt_text'] : [],
      evidence: unresolvedAltRiskNodes.slice(0, 3).map(node =>
        node.ownershipMode === 'nonfigure_with_alt'
          ? `${node.tag} has /Alt but is not a /Figure or /Formula — triggers "Other elements alternate text" in Adobe Acrobat.`
          : node.ownershipMode === 'orphaned_alt_empty_element'
            ? `${node.tag} has /Alt but no MCID content (empty element) — triggers "Associated with content" in Adobe Acrobat.`
            : node.ownershipMode === 'mixed_text_graphics_same_mcid'
              ? `${node.tag} mixes text and graphics in MCID ${node.mcids?.join(', ') || 'unknown'} (${node.operatorPattern || 'mixed'}, splitSafe=${node.splitSafe}).`
              : node.ownershipMode === 'duplicate_mcid_ownership'
                ? `${node.tag} shares MCID ownership with ${node.duplicateOwnerRefs?.join(', ') || 'another structure element'}.`
                : node.ownershipMode === 'container_with_graphics_descendants'
                  ? `${node.tag} still directly owns graphics content while a child bridge exists.`
                  : `${node.tag} owns graphics content but is not tagged as /Figure.`),
    })
  }

  const blockedTables = input.context.tableCandidates.filter(candidate => candidate.repairMode !== 'safe')
  if (blockedTables.length) {
    mergeMode(modes, {
      key: 'context.table_candidates_blocked',
      label: 'Table candidates need semantic or manual review',
      source: 'context',
      count: blockedTables.length,
      categoryIds: ['table_markup'],
      blocking: false,
      unmatched: false,
      classification: 'semantic',
      nativeToolFamilies: ['set_table_header_cells'],
      evidence: blockedTables.map(candidate => candidate.unsafeReason || candidate.ref).slice(0, 3),
    })
  }

  const blockedReadingOrder = input.context.readingOrderParentCandidates.filter(candidate => !candidate.mutableKids)
  if (blockedReadingOrder.length) {
    mergeMode(modes, {
      key: 'context.reading_order_groups_blocked',
      label: 'Reading-order groups require manual review',
      source: 'context',
      count: blockedReadingOrder.length,
      categoryIds: ['reading_order'],
      blocking: false,
      unmatched: false,
      classification: 'manual_only',
      nativeToolFamilies: ['reorder_structure_children'],
      evidence: blockedReadingOrder.map(candidate => `Parent ${candidate.parentRef} is not mutable`).slice(0, 3),
    })
  }

  return [...modes.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

function addOpportunity(
  opportunities: Map<string, Omit<ToolOpportunity, 'status'>>,
  input: Omit<ToolOpportunity, 'status' | 'key'>,
) {
  const target = actionTargetForOpportunity(input)
  const key = opportunityKey(input.toolName, input.scope, target)
  if (opportunities.has(key)) return
  opportunities.set(key, {
    ...input,
    key,
  })
}

function deriveOpportunityStatus(
  opportunity: Omit<ToolOpportunity, 'status'>,
  actions: RemediationActionRecord[],
  rejectedActions: RemediationActionRecord[],
): ToolOpportunityStatus {
  const target = actionTargetForOpportunity(opportunity)
  const candidateId = opportunity.candidateIds[0]
  const candidateGroupId = opportunity.candidateGroupIds[0]

  const rejected = rejectedActions.find(action =>
    action.tool === opportunity.toolName &&
    (candidateId ? action.candidateId === candidateId
      : candidateGroupId ? action.candidateGroupId === candidateGroupId
      : action.target === target),
  )
  if (rejected) return 'rejected'

  const prior = actions.find(action =>
    action.tool === opportunity.toolName &&
    (candidateId ? action.candidateId === candidateId
      : candidateGroupId ? action.candidateGroupId === candidateGroupId
      : action.target === target),
  )
  if (
    prior?.outcome === 'no_effect'
    && opportunity.toolName === 'repair_other_elements_alt_text'
    && opportunity.derivedFromFailureModeKeys.includes('acrobat.other_elements_alt_text')
  ) {
    return 'auto_runnable'
  }
  if (
    prior?.outcome === 'no_effect'
    && opportunity.toolName === 'finalize_substituted_font_conformance'
    && opportunity.derivedFromFailureModeKeys.some(key => key === 'pdfua.font_widths' || key === 'pdfua.font_embedding')
  ) {
    return 'auto_runnable'
  }
  if (prior?.outcome === 'no_effect') return 'no_effect'
  if (prior) return 'already_attempted'
  if (opportunity.blockedReason) return opportunity.scope === 'candidate' || opportunity.scope === 'candidate_group' ? 'blocked' : 'deferred'
  return 'auto_runnable'
}

function buildToolOpportunities(input: BuildFailureProfileInput, failureModes: FailureMode[]): ToolOpportunity[] {
  const opportunities = new Map<string, Omit<ToolOpportunity, 'status'>>()
  const failureModeByKey = new Map(failureModes.map(mode => [mode.key, mode]))
  const issueIds = new Set(
    input.analysis.categories
      .filter(category => typeof category.score === 'number' && category.score < 100)
      .map(category => category.id),
  )

  const derivedFailureKeys = (keys: string[]) => keys.filter(key => failureModeByKey.has(key))

  if (issueIds.has('title_language')) {
    addOpportunity(opportunities, {
      toolName: 'normalize_document_metadata',
      reason: 'Metadata normalization can reconcile title, language, viewer preferences, and PDF/UA metadata.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['title_language'],
      confidence: 0.84,
      blockedReason: undefined,
      derivedFromFailureModeKeys: derivedFailureKeys(['category.title_language', 'pdfua.metadata_identification']),
    })
    if (!(input.context.pdfjs.title || '').trim()) {
      addOpportunity(opportunities, {
        toolName: 'set_document_title',
        reason: 'The document title is missing from metadata.',
        scope: 'document',
        candidateIds: [],
        candidateGroupIds: [],
        pageNumbers: [],
        categoryTargets: ['title_language'],
        confidence: 0.82,
        blockedReason: undefined,
        derivedFromFailureModeKeys: derivedFailureKeys(['category.title_language']),
      })
    }
    const currentLanguage = input.context.qpdf.lang || input.context.pdfjs.lang || ''
    if (!currentLanguage || needsLanguageTagNormalization(currentLanguage)) {
      addOpportunity(opportunities, {
        toolName: 'set_document_language',
        reason: currentLanguage
          ? `The document language "${currentLanguage}" should be normalized to "${normalizeLanguageTag(currentLanguage)}".`
          : 'The document language is missing from metadata.',
        scope: 'document',
        candidateIds: [],
        candidateGroupIds: [],
        pageNumbers: [],
        categoryTargets: ['title_language'],
        confidence: 0.6,
        blockedReason: undefined,
        derivedFromFailureModeKeys: derivedFailureKeys(['category.title_language']),
      })
    }
  }

  const hasNativeStructure = input.context.qpdf.hasStructTree
    && input.context.qpdf.structTreeDepth > 0
    && (input.context.structure.structuralNodes?.length || 0) > 0

  if (hasNativeStructure && issueIds.has('alt_text')) {
    addOpportunity(opportunities, {
      toolName: 'repair_native_figure_semantics',
      reason: 'The document already has a tag tree, so figure semantics can be repaired in place.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['alt_text'],
      confidence: 0.74,
      blockedReason: undefined,
      derivedFromFailureModeKeys: derivedFailureKeys(['category.alt_text', 'pdfua.figure_alt_or_artifact']),
    })
  }

  // Only schedule repair for nodes that are still unresolved:
  // - orphaned_alt_empty_element / nonfigure_with_alt: unresolved when /Alt IS present (needs removal)
  // - all other modes: unresolved when /Alt is NOT present (needs addition)
  const acrobatRiskNodes = (input.context.structure.acrobatAltRiskNodes || []).filter(node =>
    ALT_REMOVAL_MODES.has(node.ownershipMode ?? '') ? node.hasAlt : !node.hasAlt
  )
  // Nodes that can be deterministically repaired
  const deterministicAcrobatRiskNodes = acrobatRiskNodes.filter(node =>
    node.ownershipMode === 'duplicate_mcid_ownership'
    || node.ownershipMode === 'container_with_graphics_descendants'
    || (node.ownershipMode === 'mixed_text_graphics_same_mcid' && node.splitSafe)
    // orphaned_alt_empty_element: remove /Alt from empty element (no content kids)
    || node.ownershipMode === 'orphaned_alt_empty_element'
    // nonfigure_with_alt: remove /Alt from non-Figure element with real content kids
    || node.ownershipMode === 'nonfigure_with_alt'
    // untagged images: wraps Do operator in BDC/EMC and creates /Figure struct element
    || node.ownershipMode === 'untagged_image_mcid'
    || node.ownershipMode === 'untagged_image_direct')
  if (acrobatRiskNodes.length) {
    addOpportunity(opportunities, {
      toolName: 'repair_other_elements_alt_text',
      reason: deterministicAcrobatRiskNodes.length
        ? 'Normalize non-figure graphics ownership so Acrobat no longer flags other-elements alternate text.'
        : 'Remaining Acrobat-style alternate-text risk requires manual review.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['alt_text'],
      confidence: deterministicAcrobatRiskNodes.length ? 0.9 : 0.35,
      blockedReason: deterministicAcrobatRiskNodes.length
        ? undefined
        : 'Mixed text and graphics share the same marked-content block with no safe deterministic repair.',
      derivedFromFailureModeKeys: derivedFailureKeys(['acrobat.other_elements_alt_text']),
    })
  }

  if (hasNativeStructure && issueIds.has('table_markup')) {
    addOpportunity(opportunities, {
      toolName: 'repair_native_table_headers',
      reason: 'The document already has tagged tables, so table headers can be repaired in place.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['table_markup'],
      confidence: 0.58,
      blockedReason: undefined,
      derivedFromFailureModeKeys: derivedFailureKeys(['category.table_markup']),
    })
  }

  if (hasNativeStructure && issueIds.has('reading_order')) {
    addOpportunity(opportunities, {
      toolName: 'repair_native_reading_order',
      reason: 'The document already has a structure tree, so reading order can be repaired within existing parents.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['reading_order'],
      confidence: 0.74,
      blockedReason: undefined,
      derivedFromFailureModeKeys: derivedFailureKeys(['category.reading_order']),
    })
  }

  // Proactively add /Contents alt text to non-link annotations and set /Tabs /S on all
  // annotated / tagged pages.  Adobe Acrobat's checker fires 'Tab order - Failed',
  // 'Associated with content - Failed', and 'Other elements alternate text - Failed'
  // for annotations that lack these properties even when veraPDF passes.
  // Only schedule these when the document actually has annotations or is a tagged PDF —
  // skipping them on plain image/text PDFs avoids an unnecessary structure-backend call.
  const hasAnnotationsOrTagged = (input.context.qpdf.annotationCount ?? 0) > 0
    || input.context.qpdf.isTagged
    || input.context.qpdf.hasStructTree
  if (hasAnnotationsOrTagged) {
    addOpportunity(opportunities, {
      toolName: 'repair_annotation_alt_text',
      reason: 'Ensure all non-link annotations have /Contents alt text and all annotated/tagged pages have /Tabs /S to satisfy Adobe Accessibility Checker requirements.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['alt_text', 'reading_order'],
      confidence: 0.88,
      blockedReason: undefined,
      derivedFromFailureModeKeys: [],
    })

    // Final-pass tab-order fix: set /Tabs /S on every annotated page.
    // Runs after all other tools so it catches any pages whose annotation arrays were
    // created or modified during remediation and might still be missing /Tabs /S.
    addOpportunity(opportunities, {
      toolName: 'set_tabs_all_annotated_pages',
      reason: 'Set /Tabs /S on all annotated/tagged pages as a final pass to satisfy Adobe Accessibility Checker tab-order requirement.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['reading_order'],
      confidence: 0.95,
      blockedReason: undefined,
      derivedFromFailureModeKeys: [],
    })
  }

  for (const mode of failureModes) {
    const relevantToOpenIssue = mode.categoryIds.some(categoryId => issueIds.has(categoryId))
      || (mode.key.startsWith('pdfua.') && input.analysis.verapdf.status === 'failed')
    if (!relevantToOpenIssue) continue
    for (const toolName of mode.nativeToolFamilies) {
      if (toolName === 'set_document_title' || toolName === 'set_document_language' || toolName === 'normalize_document_metadata') continue
      addOpportunity(opportunities, {
        toolName,
        reason: mode.label,
        scope: 'document',
        candidateIds: [],
        candidateGroupIds: [],
        pageNumbers: [],
        categoryTargets: mode.categoryIds,
        confidence: 0.85,
        blockedReason: mode.classification === 'manual_only' ? 'No safe deterministic target is available for this failure mode.' : undefined,
        derivedFromFailureModeKeys: [mode.key],
      })
    }
  }

  if (
    input.analysis.pageCount >= 10
    && failureModeByKey.has('pdfua.font_unicode')
    && !failureModeByKey.has('pdfua.type1_unicode')
  ) {
    addOpportunity(opportunities, {
      toolName: 'repair_type1_font_unicode_maps',
      reason: 'Large legacy PDFs with persistent font Unicode failures often need a Type1/Type3-specific Unicode recovery pass.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['text_extractability', 'pdf_ua_compliance'],
      confidence: 0.72,
      blockedReason: undefined,
      derivedFromFailureModeKeys: derivedFailureKeys(['pdfua.font_unicode']),
    })
  }

  if (
    failureModeByKey.has('pdfua.font_unicode')
    && input.actions.some(action => action.tool === 'repair_font_unicode_maps' && action.outcome === 'no_effect')
    && (
      input.analysis.pageCount <= 2
      || input.actions.some(action => action.tool === 'repair_type1_font_unicode_maps')
      || input.actions.some(action => action.tool === 'ocr_scanned_pdf')
    )
  ) {
    const reason = input.analysis.pageCount <= 2
      ? 'Small chart PDFs with persistent unmapped glyphs after generic Unicode repair often need a CID symbol-font recovery pass.'
      : input.actions.some(action => action.tool === 'ocr_scanned_pdf')
        ? 'OCR-searchable PDFs with persistent unmapped CID glyphs often need a CID font ToUnicode recovery pass.'
        : 'Large legacy PDFs with persistent unmapped glyphs after generic and Type1 Unicode repair often need a CID symbol-font recovery pass.'
    addOpportunity(opportunities, {
      toolName: 'repair_cid_symbol_font_maps',
      reason,
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['text_extractability', 'pdf_ua_compliance'],
      confidence: 0.74,
      blockedReason: undefined,
      derivedFromFailureModeKeys: derivedFailureKeys(['pdfua.font_unicode']),
    })
  }

  for (const candidate of input.context.headingCandidates) {
    if (!issueIds.has('heading_structure')) continue
    addOpportunity(opportunities, {
      toolName: 'create_heading_from_candidate',
      reason: candidate.repairMode === 'safe'
        ? `Promote heading candidate "${candidate.text}" to semantic heading markup.`
        : candidate.unsafeReason || `Heading candidate "${candidate.text}" is not safely auto-runnable.`,
      scope: 'candidate',
      candidateIds: [candidate.id],
      candidateGroupIds: [],
      pageNumbers: [candidate.pageNumber],
      categoryTargets: ['heading_structure'],
      confidence: 0.7,
      blockedReason: candidate.repairMode === 'safe' ? undefined : (candidate.unsafeReason || 'Heading candidate requires semantic review.'),
      derivedFromFailureModeKeys: derivedFailureKeys(['category.heading_structure', 'context.heading_candidates_blocked']),
    })
  }

  for (const candidate of input.context.figureCandidates) {
    if (!issueIds.has('alt_text')) continue
    const toolName = candidate.informativeHint === 'decorative'
      ? 'mark_figure_decorative'
      : candidate.repairMode === 'retag_then_set_alt'
        ? 'retag_as_figure_and_set_alt'
        : 'set_figure_alt_text'
    addOpportunity(opportunities, {
      toolName,
      reason: candidate.repairMode === 'defer'
        ? candidate.unsafeReason || `Figure candidate ${candidate.id} is not safely auto-runnable.`
        : `Repair figure semantics for candidate ${candidate.id}.`,
      scope: 'candidate',
      candidateIds: [candidate.id],
      candidateGroupIds: [],
      pageNumbers: [candidate.pageNumber],
      categoryTargets: ['alt_text'],
      confidence: candidate.informativeHint === 'decorative' ? 0.7 : 0.62,
      blockedReason: candidate.repairMode === 'defer' ? (candidate.unsafeReason || 'Figure candidate requires semantic or manual review.') : undefined,
      derivedFromFailureModeKeys: derivedFailureKeys(['category.alt_text', 'context.figure_candidates_blocked', 'pdfua.figure_alt_or_artifact']),
    })
  }

  for (const candidate of input.context.tableCandidates) {
    if (!issueIds.has('table_markup')) continue
    addOpportunity(opportunities, {
      toolName: 'set_table_header_cells',
      reason: candidate.repairMode === 'safe'
        ? `Promote first-row cells to headers for table ${candidate.ref}.`
        : candidate.unsafeReason || `Table candidate ${candidate.ref} requires semantic review.`,
      scope: 'candidate',
      candidateIds: [candidate.id],
      candidateGroupIds: [],
      pageNumbers: candidate.pageNumberHints,
      categoryTargets: ['table_markup'],
      confidence: 0.45,
      blockedReason: candidate.repairMode === 'safe' ? undefined : (candidate.unsafeReason || 'Table candidate requires semantic review.'),
      derivedFromFailureModeKeys: derivedFailureKeys(['category.table_markup', 'context.table_candidates_blocked']),
    })
  }

  for (const candidate of input.context.linkCandidates) {
    if (!issueIds.has('link_quality') && !failureModeByKey.has('pdfua.annotation_alt_contents')) continue
    addOpportunity(opportunities, {
      toolName: 'set_link_annotation_contents',
      reason: `Set annotation alternate text for link candidate ${candidate.id}.`,
      scope: 'candidate',
      candidateIds: [candidate.id],
      candidateGroupIds: [],
      pageNumbers: [candidate.pageNumber],
      categoryTargets: ['link_quality'],
      confidence: 0.84,
      blockedReason: undefined,
      derivedFromFailureModeKeys: derivedFailureKeys(['pdfua.annotation_alt_contents', 'category.link_quality']),
    })
    if (candidate.rawUrl) {
      addOpportunity(opportunities, {
        toolName: 'rewrite_link_visible_text',
        reason: `Replace raw URL visible text for link candidate ${candidate.id}.`,
        scope: 'candidate',
        candidateIds: [candidate.id],
        candidateGroupIds: [],
        pageNumbers: [candidate.pageNumber],
        categoryTargets: ['link_quality'],
        confidence: 0.66,
        blockedReason: candidate.suggestedText ? undefined : 'Link wording needs semantic review before rewriting visible text.',
        derivedFromFailureModeKeys: derivedFailureKeys(['category.link_quality']),
      })
    }
  }

  for (const candidate of input.context.readingOrderParentCandidates) {
    if (!issueIds.has('reading_order')) continue
    if (candidate.suggestedChildCandidateIds.length <= 1) continue
    addOpportunity(opportunities, {
      toolName: 'reorder_structure_children',
      reason: candidate.mutableKids
        ? `Normalize reading-order group for parent ${candidate.parentRef}.`
        : `Reading-order parent ${candidate.parentRef} is not mutable.`,
      scope: 'candidate_group',
      candidateIds: [],
      candidateGroupIds: [candidate.id],
      pageNumbers: candidate.pageNumberHints,
      categoryTargets: ['reading_order'],
      confidence: 0.4,
      blockedReason: candidate.mutableKids ? undefined : `Parent ${candidate.parentRef} does not expose mutable children.`,
      derivedFromFailureModeKeys: derivedFailureKeys(['category.reading_order', 'context.reading_order_groups_blocked']),
    })
  }

  if (
    !input.context.qpdf.hasStructTree
    && !input.analysis.isScanned
    && (issueIds.has('text_extractability') || issueIds.has('heading_structure') || issueIds.has('alt_text') || issueIds.has('reading_order'))
  ) {
    addOpportunity(opportunities, {
      toolName: 'bootstrap_struct_tree',
      reason: 'The document lacks a usable structure tree, so a bootstrap pass is the first deterministic repair opportunity.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['text_extractability', 'heading_structure', 'alt_text', 'reading_order'],
      confidence: 0.72,
      blockedReason: undefined,
      derivedFromFailureModeKeys: derivedFailureKeys(['category.text_extractability', 'category.heading_structure', 'category.alt_text', 'category.reading_order']),
    })
  }

  if (issueIds.has('bookmarks')) {
    addOpportunity(opportunities, {
      toolName: 'replace_bookmarks_from_headings',
      reason: 'The document lacks bookmarks and can try generating them from headings.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['bookmarks'],
      confidence: 0.55,
      blockedReason: input.context.headingCandidates.length ? undefined : 'Bookmark generation needs heading candidates or manual review.',
      derivedFromFailureModeKeys: derivedFailureKeys(['category.bookmarks']),
    })
  }

  return [...opportunities.values()]
    .map(opportunity => ({
      ...opportunity,
      status: deriveOpportunityStatus(opportunity, input.actions, input.rejectedActions),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

export function buildPlannerEvidenceSummary(input: {
  failureModes: FailureMode[]
  toolOpportunities: ToolOpportunity[]
  actions: RemediationActionRecord[]
  rejectedActions: RemediationActionRecord[]
  iterations?: RemediationIteration[]
}): PlannerEvidenceSummary {
  const skippedReasonCounts = new Map<string, number>()
  for (const opportunity of input.toolOpportunities) {
    if (opportunity.status === 'auto_runnable') continue
    const reason = opportunity.blockedReason || opportunity.status
    skippedReasonCounts.set(reason, (skippedReasonCounts.get(reason) || 0) + 1)
  }

  const attemptedKeys = unique(input.actions.map(action => actionKey(action.tool, action.candidateGroupId || action.candidateId || action.target)))
  const rejectedKeys = unique(input.rejectedActions.map(action => actionKey(action.tool, action.candidateGroupId || action.candidateId || action.target)))
  const noEffectKeys = unique(input.actions
    .filter(action => action.outcome === 'no_effect')
    .map(action => actionKey(action.tool, action.candidateGroupId || action.candidateId || action.target)))

  return {
    topFailureModeKeys: input.failureModes.slice(0, 5).map(mode => mode.key),
    topAutoRunnableOpportunityKeys: input.toolOpportunities
      .filter(opportunity => opportunity.status === 'auto_runnable')
      .slice(0, 5)
      .map(opportunity => opportunity.key),
    skippedReasonCounts: [...skippedReasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    attemptedKeys,
    rejectedKeys,
    noEffectKeys,
  }
}

export function buildFailureProfile(input: BuildFailureProfileInput): FailureProfile {
  const failureModes = buildFailureModes(input)
  const toolOpportunities = buildToolOpportunities(input, failureModes)

  return {
    version: '1',
    generatedAt: nowIso(),
    analysisGrade: input.analysis.grade,
    analysisScore: input.analysis.overallScore,
    veraPdfStatus: input.analysis.verapdf.status,
    veraPdfFailedChecks: input.analysis.verapdf.failedChecks,
    failureModes,
    toolOpportunities,
    summary: {
      deterministicIssueCount: failureModes.filter(mode => mode.classification === 'deterministic').length,
      semanticIssueCount: failureModes.filter(mode => mode.classification === 'semantic').length,
      manualOnlyIssueCount: failureModes.filter(mode => mode.classification === 'manual_only').length,
      blockedOpportunityCount: toolOpportunities.filter(opportunity => opportunity.status === 'blocked' || opportunity.status === 'deferred').length,
      autoRunnableOpportunityCount: toolOpportunities.filter(opportunity => opportunity.status === 'auto_runnable').length,
    },
  }
}

export function buildFailureProfileArtifacts(input: BuildFailureProfileInput): {
  failureProfile: FailureProfile
  plannerEvidence: PlannerEvidenceSummary
} {
  const failureProfile = buildFailureProfile(input)
  const plannerEvidence = buildPlannerEvidenceSummary({
    failureModes: failureProfile.failureModes,
    toolOpportunities: failureProfile.toolOpportunities,
    actions: input.actions,
    rejectedActions: input.rejectedActions,
    iterations: input.iterations,
  })

  return {
    failureProfile,
    plannerEvidence,
  }
}
