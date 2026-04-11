import type { AnalysisResult } from './pdfAnalyzer.js'
import type {
  FailureClassification,
  FailureProfileDominantResidualFamily,
  FailureMode,
  FailureReportingCategory,
  FailureSourceDetail,
  FailureProfile,
  PlannerEvidenceSummary,
  RemediationActionRecord,
  RemediationIteration,
  RemediationToolName,
  RetryDisposition,
  ToolOpportunity,
  ToolOpportunityScope,
  ToolOpportunityStatus,
  ToolOpportunityStatusReasonCode,
} from './documentModel.js'
import { selectHighConfidenceLongReportFigureCandidates, selectHighConfidenceLongReportHeadingCandidates } from './pdfRemediationTools.js'
import type { PdfRemediationContext } from './pdfRemediationTools.js'
import { ALT_REMOVAL_MODES } from './altTextScoring.js'
import { needsLanguageTagNormalization, normalizeLanguageTag } from './languageTags.js'
import { hasMeaningfulMetadataTitle } from './remediationCallDerivationService.js'
import { annotateToolOpportunitiesWithResidualFamilies, buildResidualFamilyDecisions } from './residualFamilyService.js'
import type { LocalStandardsFinding } from './localStandardsService.js'

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

type FailureFamilyDefinition = Omit<VeraPdfFailureFamily, 'pattern'>

const SEMANTIC_CATEGORY_IDS = new Set(['heading_structure', 'alt_text', 'table_markup', 'link_quality'])
const MANUAL_ONLY_CATEGORY_IDS = new Set(['text_extractability'])
const FONT_REMEDIATION_TOOLS = new Set<RemediationToolName>([
  'embed_missing_fonts_in_place',
  'repair_font_unicode_maps',
  'repair_type1_font_unicode_maps',
  'repair_cid_symbol_font_maps',
  'repair_cidset_consistency',
  'substitute_legacy_fonts_in_place',
  'finalize_substituted_font_conformance',
])
const FIGURE_REMEDIATION_TOOLS = new Set<RemediationToolName>([
  'normalize_nested_figure_containers',
  'set_figure_alt_text',
  'retag_as_figure_and_set_alt',
  'mark_figure_decorative',
  'repair_native_figure_semantics',
  'repair_other_elements_alt_text',
])
const FONT_FAILURE_MODE_KEYS = new Set([
  'pdfua.font_embedding',
  'pdfua.font_unicode',
  'pdfua.type1_unicode',
  'pdfua.truetype_encoding_differences',
  'pdfua.font_widths',
  'pdfua.cid_symbol_fonts',
  'pdfua.cidset_consistency',
])
const FIGURE_ADVISORY_FAILURE_MODE_KEYS = new Set([
  'pdfua.figure_alt_quality',
])
const LONG_REPORT_HEADING_LIMIT = 3
const LONG_REPORT_FIGURE_LIMIT = 5
const FIGURE_DOMINANT_FAMILY_IDS = new Set([
  'native_figure_convergence',
  'pdfua.figure_alt_or_artifact',
  'context.long_report_figure_residue',
])
const STRUCTURE_ONLY_TERMINAL_FINDING_KEYS = new Set([
  'pdfua.logical_structure',
  'pdfua.heading_content_quality',
  'category.heading_structure',
  'category.reading_order',
])

function isLongReportConvergenceContext(input: BuildFailureProfileInput): boolean {
  return input.analysis.pageCount >= 20
    && !input.analysis.isScanned
}

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

function classificationRank(classification: FailureClassification): number {
  switch (classification) {
    case 'deterministic':
      return 0
    case 'semantic':
      return 1
    case 'manual_only':
      return 2
  }
}

function reportingCategoryForMode(input: Pick<FailureMode, 'key' | 'categoryIds'>): FailureReportingCategory {
  if (input.key.includes('bookmark') || input.categoryIds.includes('bookmarks')) return 'bookmarks'
  if (input.key.includes('font') || input.key.includes('cid') || input.categoryIds.includes('text_extractability')) return 'fonts'
  if (input.key.includes('table') || input.categoryIds.includes('table_markup')) return 'tables'
  if (input.key.includes('annotation') || input.key.includes('link') || input.key.includes('note_tag') || input.categoryIds.includes('link_quality')) return 'annotations'
  if (input.key.includes('reading_order') || input.key.includes('page_tabs') || input.categoryIds.includes('reading_order')) return 'reading_order'
  if (input.key.includes('alt') || input.key.includes('figure') || input.categoryIds.includes('alt_text')) return 'alt_text'
  if (input.key.includes('language') || input.categoryIds.includes('title_language')) return 'language'
  if (input.key.includes('metadata') || input.key.includes('display_doc_title')) return 'metadata'
  if (input.key.includes('logical_structure') || input.key.includes('struct') || input.key.includes('marked_content') || input.categoryIds.includes('pdf_ua_compliance')) return 'logical_structure'
  return 'general'
}

function sourceDetailForMode(source: FailureMode['source'], key: string): FailureSourceDetail {
  if (source === 'verapdf') return 'verapdf_family'
  if (source === 'local_standards') return 'local_standards_key'
  if (source === 'category') return 'category_score'
  if (source === 'context') return 'context_blocker'
  if (source === 'composite' && key.startsWith('adobe.')) return 'acrobat_group'
  return 'composite_summary'
}

function sortFailureModes(modes: FailureMode[]): FailureMode[] {
  return [...modes].sort((a, b) => {
    const blockingDiff = Number(b.blocking) - Number(a.blocking)
    if (blockingDiff !== 0) return blockingDiff
    const countDiff = b.count - a.count
    if (countDiff !== 0) return countDiff
    const classificationDiff = classificationRank(a.classification) - classificationRank(b.classification)
    if (classificationDiff !== 0) return classificationDiff
    return a.key.localeCompare(b.key)
  })
}

function withModeReportingFields(mode: FailureMode): FailureMode {
  return {
    ...mode,
    reportingCategory: reportingCategoryForMode(mode),
    sourceDetail: sourceDetailForMode(mode.source, mode.key),
    derivedFrom: mode.derivedFrom || [mode.source === 'local_standards'
      ? `local_standards:${mode.key}`
      : mode.source === 'verapdf'
        ? `verapdf:${mode.key}`
        : mode.source === 'category'
          ? `category:${mode.key.replace(/^category\./, '')}`
          : mode.source === 'context'
            ? `context:${mode.key}`
            : `composite:${mode.key}`],
  }
}

function sortedNumeric(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

function categoryScore(input: BuildFailureProfileInput, categoryId: string): number | null {
  const category = input.analysis.categories.find(entry => entry.id === categoryId)
  return typeof category?.score === 'number' ? category.score : null
}

function weakNativeBootstrapNeeded(input: BuildFailureProfileInput): boolean {
  if (input.analysis.isScanned || !input.context.qpdf.hasStructTree) return false
  const headingScore = categoryScore(input, 'heading_structure') ?? 100
  const altScore = categoryScore(input, 'alt_text') ?? 100
  const tableScore = categoryScore(input, 'table_markup')
  const hasNativeHeadings = (input.context.qpdf.headings?.length || 0) > 0
  const hasSafeHeadingTargets = input.context.headingCandidates.some(candidate => candidate.repairMode === 'safe')
  const hasRetaggableFigures = input.context.figureCandidates.some(candidate => candidate.repairMode !== 'defer')
  const hasAccessibleImages = (input.context.qpdf.images ?? []).some(image => image.hasAlt)
  const hasPdfImages = (input.context.qpdf.images?.length || 0) > 0
  const hasNativeFigureNodes = (input.context.structure.figures?.length || 0) > 0 || (input.context.structure.imageStructNodes?.length || 0) > 0
  const hasNativeTables = (input.context.structure.tables?.length || 0) > 0
  const hasPdfTables = (input.context.qpdf.tables?.length || 0) > 0
  return (
    headingScore < 100
    && !hasNativeHeadings
    && input.context.headingCandidates.length > 0
    && !hasSafeHeadingTargets
  ) || (
    altScore < 100
    && (
      hasRetaggableFigures
      || (hasPdfImages && !hasNativeFigureNodes)
    )
    && !hasAccessibleImages
  ) || (
    typeof tableScore === 'number'
    && tableScore < 100
    && hasPdfTables
    && !hasNativeTables
  )
}

function likelyBootstrappedStructuralResidue(input: BuildFailureProfileInput): {
  hasResidualNonsemanticDebt: boolean
  hasResidualBootstrappedChartDebt: boolean
} {
  const longReportConvergence = isLongReportConvergenceContext(input)
  if (!longReportConvergence) {
    return {
      hasResidualNonsemanticDebt: false,
      hasResidualBootstrappedChartDebt: false,
    }
  }

  const headingsExist = (input.context.qpdf.headings?.length || 0) > 0
    || (input.context.structure.structuralNodes?.length || 0) > 0
  const pagesWithImageContent = input.context.pages.filter(page =>
    page.imageCount > 0,
  ).length
  const likelyChartPages = input.context.pages.filter(page =>
    page.imageCount > 0 && page.textLines.length >= 2,
  ).length

  return {
    hasResidualNonsemanticDebt: headingsExist && pagesWithImageContent > 0,
    hasResidualBootstrappedChartDebt: headingsExist && likelyChartPages > 0,
  }
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

function familyDefinitionByKey(key: string): FailureFamilyDefinition | null {
  const family = VERA_PDF_FAILURE_FAMILIES.find(entry => entry.key === key)
  if (!family) return null
  return {
    key: family.key,
    label: family.label,
    nativeToolFamilies: family.nativeToolFamilies,
    categoryIds: family.categoryIds,
    classification: family.classification,
  }
}

function mapLocalStandardsFinding(finding: LocalStandardsFinding): FailureFamilyDefinition {
  const knownFamily = familyDefinitionByKey(finding.key)
  if (knownFamily) return knownFamily

  if (finding.key === 'pdfua.bookmark_language') {
    return {
      key: finding.key,
      label: finding.label,
      nativeToolFamilies: ['replace_bookmarks_from_headings'],
      categoryIds: ['bookmarks', 'title_language', 'pdf_ua_compliance'],
      classification: 'deterministic',
    }
  }

  if (finding.key === 'pdfua.table_regularity') {
    return {
      key: finding.key,
      label: finding.label,
      nativeToolFamilies: ['repair_native_table_headers', 'set_table_header_cells'],
      categoryIds: ['table_markup', 'pdf_ua_compliance'],
      classification: 'deterministic',
    }
  }

  if (finding.key === 'pdfua.table_complexity') {
    return {
      key: finding.key,
      label: finding.label,
      nativeToolFamilies: ['repair_native_table_headers', 'set_table_header_cells'],
      categoryIds: ['table_markup', 'pdf_ua_compliance'],
      classification: 'deterministic',
    }
  }

  if (finding.key === 'pdfua.figure_alt_quality') {
    return {
      key: finding.key,
      label: finding.label,
      nativeToolFamilies: ['set_figure_alt_text', 'retag_as_figure_and_set_alt'],
      categoryIds: ['alt_text', 'pdf_ua_compliance'],
      classification: 'semantic',
    }
  }

  if (finding.key === 'pdfua.heading_content_quality') {
    return {
      key: finding.key,
      label: finding.label,
      nativeToolFamilies: ['normalize_heading_hierarchy', 'create_heading_from_candidate'],
      categoryIds: ['heading_structure', 'pdf_ua_compliance'],
      classification: 'semantic',
    }
  }

  if (finding.key === 'pdfua.link_text_quality') {
    return {
      key: finding.key,
      label: finding.label,
      nativeToolFamilies: ['rewrite_link_visible_text', 'set_link_annotation_contents'],
      categoryIds: ['link_quality', 'pdf_ua_compliance'],
      classification: 'semantic',
    }
  }

  if (finding.key === 'pdfua.tagged_annotations') {
    return {
      key: finding.key,
      label: finding.label,
      nativeToolFamilies: ['tag_unowned_annotations'],
      categoryIds: ['reading_order', 'pdf_ua_compliance'],
      classification: 'deterministic',
    }
  }

  if (
    finding.key === 'pdfua.untagged_rendered_images'
    || finding.key === 'pdfua.nonfigure_with_alt'
    || finding.key === 'pdfua.nested_alt_text'
  ) {
    return {
      key: finding.key,
      label: finding.label,
      nativeToolFamilies: ['normalize_nested_figure_containers', 'repair_other_elements_alt_text'],
      categoryIds: ['alt_text', 'pdf_ua_compliance'],
      classification: 'deterministic',
    }
  }

  return {
    key: finding.key,
    label: finding.label,
    nativeToolFamilies: [],
    categoryIds: finding.categoryIds,
    classification: finding.blocking ? 'deterministic' : 'manual_only',
  }
}

function buildFailureModes(input: BuildFailureProfileInput): FailureMode[] {
  const modes = new Map<string, FailureMode>()

  for (const category of input.analysis.categories) {
    if (typeof category.score !== 'number' || category.score >= 100) continue
    mergeMode(modes, {
      key: `category.${category.id}`,
      label: category.label,
      source: 'category',
      derivedFrom: [`category:${category.id}`],
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
        derivedFrom: unique([`verapdf:${family.key}`, failure.ruleId ? `verapdf_rule:${failure.ruleId}` : '']),
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
        derivedFrom: unique(['verapdf:unmatched', ...input.analysis.verapdf.failures.map(failure => failure.ruleId ? `verapdf_rule:${failure.ruleId}` : '')]),
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

  if (input.analysis.localStandards?.status === 'issues_detected') {
    for (const finding of input.analysis.localStandards.findings) {
      const family = mapLocalStandardsFinding(finding)
      mergeMode(modes, {
        key: family.key,
        label: family.label,
        source: 'local_standards',
        derivedFrom: [`local_standards:${finding.key}`],
        count: Math.max(1, finding.count || 1),
        categoryIds: unique([...family.categoryIds, ...finding.categoryIds]),
        blocking: finding.blocking,
        unmatched: false,
        classification: family.classification,
        nativeToolFamilies: family.nativeToolFamilies,
        evidence: finding.evidence,
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
        derivedFrom: [`adobe:${key.replace(/^adobe\./, '')}`],
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

  const headingNeedsReview = (categoryScore(input, 'heading_structure') ?? 100) < 100
  const logicalStructureBlocking = input.analysis.localStandards?.findings?.some(finding =>
    finding.blocking && finding.key === 'pdfua.logical_structure',
  ) ?? false
  const bootstrapAugmentedExistingTree = input.actions.some(action =>
    action.tool === 'bootstrap_struct_tree'
    && action.outcome === 'applied'
    && /Augmented existing structure tree/i.test(action.details || ''),
  )
  const acceptedHeadingCreation = input.actions.some(action =>
    action.tool === 'create_heading_from_candidate'
    && action.outcome === 'applied',
  )
  const blockedHeadings = headingNeedsReview
    ? input.context.headingCandidates.filter(candidate => candidate.repairMode !== 'safe')
    : []
  if (blockedHeadings.length) {
    mergeMode(modes, {
      key: 'context.heading_candidates_blocked',
      label: 'Heading candidates need semantic or manual review',
      source: 'context',
      derivedFrom: blockedHeadings.map(candidate => `heading_candidate:${candidate.id}`),
      count: blockedHeadings.length,
      categoryIds: ['heading_structure'],
      blocking: false,
      unmatched: false,
      classification: 'semantic',
      nativeToolFamilies: ['create_heading_from_candidate'],
      evidence: blockedHeadings.map(candidate => candidate.unsafeReason || candidate.text).slice(0, 3),
    })
  }

  const postBootstrapStructureRefsAvailable = input.context.headingCandidates.length > 0
    || (input.context.qpdf.headings?.length || 0) > 0
  const structuralResidueSignals = likelyBootstrappedStructuralResidue(input)
  if (
    bootstrapAugmentedExistingTree
    && postBootstrapStructureRefsAvailable
    && (headingNeedsReview || logicalStructureBlocking)
  ) {
    mergeMode(modes, {
      key: 'context.post_bootstrap_native_structure_debt',
      label: 'Post-bootstrap native structure debt remains',
      source: 'context',
      derivedFrom: [
        'action:bootstrap_struct_tree',
        ...(headingNeedsReview ? ['category:heading_structure'] : []),
        ...(logicalStructureBlocking ? ['local_standard:pdfua.logical_structure'] : []),
      ],
      count: 1,
      categoryIds: ['heading_structure', 'reading_order', 'pdf_ua_compliance'],
      blocking: logicalStructureBlocking || headingNeedsReview,
      unmatched: false,
      classification: 'deterministic',
      nativeToolFamilies: ['normalize_heading_hierarchy', 'repair_native_marked_content_refs', 'repair_structure_conformance'],
      evidence: [
        headingNeedsReview && logicalStructureBlocking
          ? 'Bootstrap added headings to an existing structure tree, but heading hierarchy and native structure debt still block convergence.'
          : headingNeedsReview
            ? 'Bootstrap added headings to an existing structure tree, but heading hierarchy still needs native cleanup.'
            : 'Bootstrap added headings to an existing structure tree, but logical-structure debt still blocks native convergence.',
      ],
    })
  }

  if (
    bootstrapAugmentedExistingTree
    && isLongReportConvergenceContext(input)
    && (headingNeedsReview || logicalStructureBlocking)
    && (structuralResidueSignals.hasResidualNonsemanticDebt || structuralResidueSignals.hasResidualBootstrappedChartDebt)
  ) {
    mergeMode(modes, {
      key: 'context.post_bootstrap_structural_residue',
      label: 'Post-bootstrap structural residue remains',
      source: 'context',
      derivedFrom: [
        'action:bootstrap_struct_tree',
        ...(headingNeedsReview ? ['category:heading_structure'] : []),
        ...(logicalStructureBlocking ? ['local_standard:pdfua.logical_structure'] : []),
        ...(structuralResidueSignals.hasResidualNonsemanticDebt ? ['context:nonsemantic_page_elements_likely'] : []),
        ...(structuralResidueSignals.hasResidualBootstrappedChartDebt ? ['context:bootstrapped_chart_content_refs_likely'] : []),
      ],
      count: Number(structuralResidueSignals.hasResidualNonsemanticDebt) + Number(structuralResidueSignals.hasResidualBootstrappedChartDebt),
      categoryIds: ['heading_structure', 'reading_order', 'pdf_ua_compliance'],
      blocking: true,
      unmatched: false,
      classification: 'deterministic',
      nativeToolFamilies: [
        'artifact_nonsemantic_page_elements',
        'repair_bootstrapped_chart_content_refs',
        'repair_native_marked_content_refs',
        'repair_structure_conformance',
      ],
      evidence: [
        structuralResidueSignals.hasResidualNonsemanticDebt && structuralResidueSignals.hasResidualBootstrappedChartDebt
          ? 'Bootstrap created usable structure cues, but long-report page artifacts and bootstrapped chart references still need cleanup before native structure credit can land.'
          : structuralResidueSignals.hasResidualNonsemanticDebt
            ? 'Bootstrap created usable structure cues, but long-report nonsemantic page elements still need cleanup before native structure credit can land.'
            : 'Bootstrap created usable structure cues, but bootstrapped chart references still need cleanup before native structure credit can land.',
      ],
    })
  }

  if (
    acceptedHeadingCreation
    && postBootstrapStructureRefsAvailable
    && (headingNeedsReview || logicalStructureBlocking)
  ) {
    mergeMode(modes, {
      key: 'context.post_heading_creation_native_structure_debt',
      label: 'Post-heading native structure debt remains',
      source: 'context',
      derivedFrom: [
        'action:create_heading_from_candidate',
        ...(headingNeedsReview ? ['category:heading_structure'] : []),
        ...(logicalStructureBlocking ? ['local_standard:pdfua.logical_structure'] : []),
      ],
      count: 1,
      categoryIds: ['heading_structure', 'reading_order', 'pdf_ua_compliance'],
      blocking: logicalStructureBlocking || headingNeedsReview,
      unmatched: false,
      classification: 'deterministic',
      nativeToolFamilies: ['normalize_heading_hierarchy', 'repair_native_marked_content_refs', 'repair_structure_conformance'],
      evidence: [
        headingNeedsReview && logicalStructureBlocking
          ? 'New headings were created, but native marked-content and logical-structure debt still prevent convergence.'
          : headingNeedsReview
            ? 'New headings were created, but the heading hierarchy still needs native structure cleanup.'
            : 'New headings were created, but logical-structure debt still blocks native convergence.',
      ],
    })
  }

  const altTextNeedsReview = (categoryScore(input, 'alt_text') ?? 100) < 100
  const blockedFigures = altTextNeedsReview
    ? input.context.figureCandidates.filter(candidate => candidate.repairMode === 'defer')
    : []
  if (blockedFigures.length) {
    mergeMode(modes, {
      key: 'context.figure_candidates_blocked',
      label: 'Figure candidates need semantic or manual review',
      source: 'context',
      derivedFrom: blockedFigures.map(candidate => `figure_candidate:${candidate.id}`),
      count: blockedFigures.length,
      categoryIds: ['alt_text'],
      blocking: false,
      unmatched: false,
      classification: blockedFigures.some(candidate => /^unsafe_|^no_(image|figure)_evidence/i.test(candidate.unsafeReason || '')) ? 'manual_only' : 'semantic',
      nativeToolFamilies: ['set_figure_alt_text', 'retag_as_figure_and_set_alt', 'mark_figure_decorative'],
      evidence: blockedFigures.map(candidate => candidate.unsafeReason || candidate.id).slice(0, 3),
    })
  }

  const acrobatAltRiskNodes = input.context.structure.acrobatAltRiskNodes || []
  const countsAsSubstantiveAltRisk = (node: typeof acrobatAltRiskNodes[number]): boolean =>
    !node.graphicsLikelyDecorative
    || node.ownershipMode === 'untagged_image_direct'
    || node.ownershipMode === 'untagged_image_mcid'
  // Determine unresolved alt risk nodes. The resolution semantics differ by mode:
  // - orphaned_alt_empty_element / nonfigure_with_alt: unresolved when /Alt IS present (needs removal)
  // - all other modes: unresolved when /Alt is NOT present (needs addition)
  // Exclude purely decorative nodes (path/stroke-only graphics — borders, underlines, lines):
  // they share MCIDs with text but carry no semantic information, so they do not require alt text
  // and are not real accessibility failures.
  const unresolvedAltRiskNodes = acrobatAltRiskNodes.filter(node =>
    countsAsSubstantiveAltRisk(node)
    && (ALT_REMOVAL_MODES.has(node.ownershipMode ?? '') ? node.hasAlt : !node.hasAlt)
  )
  if (unresolvedAltRiskNodes.length) {
    const hasDeterministicRepair = unresolvedAltRiskNodes.some(node =>
      node.ownershipMode === 'duplicate_mcid_ownership'
      || node.ownershipMode === 'container_with_graphics_descendants'
      || node.ownershipMode === 'graphics_only_nonfigure'
      // split-safe: can rewrite content stream to separate text and graphics MCIDs
      || (node.ownershipMode === 'mixed_text_graphics_same_mcid' && node.splitSafe)
      || (node.ownershipMode === 'mixed_text_graphics_same_mcid' && node.containmentSafe)
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
      derivedFrom: unresolvedAltRiskNodes.map(node => `acrobat_alt_risk:${node.ref || node.pageRef || node.tag}`),
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
              ? `${node.tag} mixes text and graphics in MCID ${node.mcids?.join(', ') || 'unknown'} (${node.operatorPattern || 'mixed'}, splitSafe=${node.splitSafe}, containmentSafe=${node.containmentSafe}).`
              : node.ownershipMode === 'duplicate_mcid_ownership'
                ? `${node.tag} shares MCID ownership with ${node.duplicateOwnerRefs?.join(', ') || 'another structure element'}.`
                : node.ownershipMode === 'container_with_graphics_descendants'
                  ? `${node.tag} still directly owns graphics content while a child bridge exists.`
                  : `${node.tag} owns graphics content but is not tagged as /Figure.`),
    })
  }

  const hasNativeStructure = input.context.qpdf.hasStructTree
    && input.context.qpdf.structTreeDepth > 0
    && (input.context.structure.structuralNodes?.length || 0) > 0
  const longReportFigureCandidates = altTextNeedsReview
    ? input.context.figureCandidates.filter(candidate =>
        candidate.repairMode !== 'defer'
        && (!candidate.hasAlt || !!candidate.hasLowQualityAlt),
      )
    : []
  const longReportFigureFlood = longReportFigureCandidates.length > LONG_REPORT_FIGURE_LIMIT
  const hasCredibleDecorativeLongReportFigure = longReportFigureCandidates.some(candidate =>
    candidate.informativeHint === 'decorative',
  )
  if (
    isLongReportConvergenceContext(input)
    && altTextNeedsReview
    && hasNativeStructure
    && (longReportFigureFlood || unresolvedAltRiskNodes.length > 0)
  ) {
    mergeMode(modes, {
      key: 'context.long_report_figure_residue',
      label: 'Long-report figure cleanup residue remains',
      source: 'context',
      derivedFrom: [
        'category:alt_text',
        ...(longReportFigureFlood ? ['context:long_report_figure_candidate_flood'] : []),
        ...(unresolvedAltRiskNodes.length > 0 ? ['acrobat:other_elements_alt_text'] : []),
      ],
      count: longReportFigureCandidates.length + unresolvedAltRiskNodes.length,
      categoryIds: ['alt_text', 'pdf_ua_compliance'],
      blocking: true,
      unmatched: false,
      classification: 'deterministic',
      nativeToolFamilies: [
        'repair_native_figure_semantics',
        ...(unresolvedAltRiskNodes.length > 0 ? ['repair_other_elements_alt_text'] as const : []),
        'set_figure_alt_text',
        'retag_as_figure_and_set_alt',
        ...(hasCredibleDecorativeLongReportFigure ? ['mark_figure_decorative'] as const : []),
      ],
      evidence: [
        unresolvedAltRiskNodes.length > 0 && longReportFigureFlood
          ? 'Long-report figure cleanup still has Acrobat-style ownership residue and too many candidate-level figure repairs to schedule safely at once.'
          : unresolvedAltRiskNodes.length > 0
            ? 'Long-report figure cleanup still has Acrobat-style ownership residue that should be repaired before broader candidate-level alt work.'
            : 'Long-report figure cleanup still exposes too many candidate-level figure repairs to schedule safely at once.',
      ],
    })
  }

  const tableNeedsReview = (categoryScore(input, 'table_markup') ?? 100) < 100
  const blockedTables = tableNeedsReview
    ? input.context.tableCandidates.filter(candidate => candidate.repairMode !== 'safe')
    : []
  const qpdfTableCount = input.context.qpdf.tables?.length ?? 0
  const tableCandidateSurfaceMissing = tableNeedsReview && blockedTables.length === 0 && qpdfTableCount > 0
  if (blockedTables.length || tableCandidateSurfaceMissing) {
    mergeMode(modes, {
      key: 'context.table_candidates_blocked',
      label: 'Table candidates need semantic or manual review',
      source: 'context',
      derivedFrom: tableCandidateSurfaceMissing
        ? ['context:qpdf_table_surface_missing']
        : blockedTables.map(candidate => `table_candidate:${candidate.id}`),
      count: tableCandidateSurfaceMissing ? qpdfTableCount : blockedTables.length,
      categoryIds: ['table_markup'],
      blocking: tableCandidateSurfaceMissing,
      unmatched: false,
      classification: tableCandidateSurfaceMissing ? 'deterministic' : 'semantic',
      nativeToolFamilies: ['set_table_header_cells'],
      evidence: tableCandidateSurfaceMissing
        ? ['qpdf still reports tagged tables, but the structure snapshot did not surface table candidates for targeted repair.']
        : blockedTables.map(candidate => candidate.unsafeReason || candidate.ref).slice(0, 3),
    })
  }

  const blockedReadingOrder = input.context.readingOrderParentCandidates.filter(candidate => !candidate.mutableKids)
  if (blockedReadingOrder.length) {
    mergeMode(modes, {
      key: 'context.reading_order_groups_blocked',
      label: 'Reading-order groups require manual review',
      source: 'context',
      derivedFrom: blockedReadingOrder.map(candidate => `reading_order_group:${candidate.id}`),
      count: blockedReadingOrder.length,
      categoryIds: ['reading_order'],
      blocking: false,
      unmatched: false,
      classification: 'manual_only',
      nativeToolFamilies: ['reorder_structure_children'],
      evidence: blockedReadingOrder.map(candidate => `Parent ${candidate.parentRef} is not mutable`).slice(0, 3),
    })
  }

  return sortFailureModes([...modes.values()].map(withModeReportingFields))
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

function hasAttemptedFontStep(actions: RemediationActionRecord[], tool: RemediationToolName): boolean {
  return actions.some(action =>
    action.tool === tool
      && (action.outcome === 'applied' || action.outcome === 'no_effect' || action.outcome === 'unsupported'),
  )
}

function opportunitiesHasTool(
  opportunities: Map<string, Omit<ToolOpportunity, 'status'>>,
  toolName: RemediationToolName,
): boolean {
  for (const opportunity of opportunities.values()) {
    if (opportunity.toolName === toolName) return true
  }
  return false
}

function applyFontOpportunityPolicy(
  opportunities: Map<string, Omit<ToolOpportunity, 'status'>>,
  input: BuildFailureProfileInput,
  failureModeByKey: Map<string, FailureMode>,
): void {
  const blockingFontFailures = new Set(
    [...failureModeByKey.values()]
      .filter(mode => mode.blocking && FONT_FAILURE_MODE_KEYS.has(mode.key))
      .map(mode => mode.key),
  )
  const hasBlockingFontFailures = blockingFontFailures.size > 0
  const qpdf = input.context.qpdf
  const attemptedEmbed = hasAttemptedFontStep(input.actions, 'embed_missing_fonts_in_place')
  const attemptedUnicode = hasAttemptedFontStep(input.actions, 'repair_font_unicode_maps')
  const attemptedType1 = hasAttemptedFontStep(input.actions, 'repair_type1_font_unicode_maps')
  const attemptedTrueType = hasAttemptedFontStep(input.actions, 'repair_truetype_encoding_differences')
  const attemptedCidSymbol = hasAttemptedFontStep(input.actions, 'repair_cid_symbol_font_maps')
  const attemptedCidSet = hasAttemptedFontStep(input.actions, 'repair_cidset_consistency')
  const attemptedSubstitute = hasAttemptedFontStep(input.actions, 'substitute_legacy_fonts_in_place')
  const genericUnicodeNoEffect = input.actions.some(action => action.tool === 'repair_font_unicode_maps' && action.outcome === 'no_effect')
  const type1UnicodeNoEffect = input.actions.some(action => action.tool === 'repair_type1_font_unicode_maps' && action.outcome === 'no_effect')
  const cidSymbolNoEffect = input.actions.some(action => action.tool === 'repair_cid_symbol_font_maps' && action.outcome === 'no_effect')

  for (const opportunity of opportunities.values()) {
    if (!FONT_REMEDIATION_TOOLS.has(opportunity.toolName)) continue
    const derivedFailureModes = opportunity.derivedFromFailureModeKeys
      .map(key => failureModeByKey.get(key))
      .filter((mode): mode is FailureMode => !!mode)
    const onlyAdvisoryFontResidue = derivedFailureModes.length > 0
      && derivedFailureModes.every(mode => FONT_FAILURE_MODE_KEYS.has(mode.key) && !mode.blocking)

    if (!hasBlockingFontFailures && onlyAdvisoryFontResidue) {
      opportunity.blockedReason = 'Only advisory font or CIDSet residue remains; do not keep font remediation auto-runnable.'
      continue
    }

    switch (opportunity.toolName) {
      case 'repair_font_unicode_maps':
        if ((qpdf.fontsMissingToUnicodeBlocking ?? qpdf.fontsMissingToUnicode ?? 0) <= 0) {
          opportunity.blockedReason = 'No blocking text-font Unicode debt remains.'
        } else if ((qpdf.unembeddedFontCount ?? 0) > 0 && !attemptedEmbed) {
          opportunity.blockedReason = 'Run embedding before Unicode repair when fonts still lack embedded programs.'
        } else if (
          genericUnicodeNoEffect
          && (
            opportunitiesHasTool(opportunities, 'repair_type1_font_unicode_maps')
            || opportunitiesHasTool(opportunities, 'repair_truetype_encoding_differences')
            || opportunitiesHasTool(opportunities, 'repair_cid_symbol_font_maps')
          )
        ) {
          opportunity.blockedReason = 'Generic Unicode repair already hit a no-effect ceiling; prefer the smallest remaining font-specific lane.'
        }
        break
      case 'repair_type1_font_unicode_maps':
        if (
          !attemptedUnicode
          && opportunitiesHasTool(opportunities, 'repair_font_unicode_maps')
          && (qpdf.fontsMissingToUnicodeBlocking ?? qpdf.fontsMissingToUnicode ?? 0) > 0
        ) {
          opportunity.blockedReason = 'Run generic Unicode repair before the Type1/Type3-specific recovery pass.'
        } else if (type1UnicodeNoEffect && opportunitiesHasTool(opportunities, 'repair_cid_symbol_font_maps')) {
          opportunity.blockedReason = 'Type1/Type3 Unicode recovery already hit a no-effect ceiling; escalate to CID symbol-font recovery instead.'
        }
        break
      case 'repair_truetype_encoding_differences':
        if ((qpdf.unembeddedFontCount ?? 0) > 0 && !attemptedEmbed) {
          opportunity.blockedReason = 'Run embedding before TrueType encoding-difference repair.'
        } else if ((qpdf.fontsMissingToUnicodeBlocking ?? qpdf.fontsMissingToUnicode ?? 0) > 0 && !attemptedUnicode) {
          opportunity.blockedReason = 'Run generic Unicode repair before TrueType encoding-difference recovery.'
        } else if (attemptedTrueType || genericUnicodeNoEffect) {
          opportunity.blockedReason = genericUnicodeNoEffect
            ? 'Prefer the next remaining font lane after a generic Unicode no-effect pass.'
            : opportunity.blockedReason
        }
        break
      case 'repair_cidset_consistency':
        if (!hasBlockingFontFailures && onlyAdvisoryFontResidue) {
          opportunity.blockedReason = 'CIDSet residue is advisory-only in the current snapshot.'
        } else if ((qpdf.unembeddedFontCount ?? 0) > 0 && !attemptedEmbed) {
          opportunity.blockedReason = 'Run embedding before CIDSet consistency repair.'
        } else if ((qpdf.fontsMissingToUnicodeBlocking ?? qpdf.fontsMissingToUnicode ?? 0) > 0 && !attemptedUnicode) {
          opportunity.blockedReason = 'Run Unicode repair before CIDSet consistency repair.'
        } else if (opportunitiesHasTool(opportunities, 'repair_truetype_encoding_differences') && !hasAttemptedFontStep(input.actions, 'repair_truetype_encoding_differences')) {
          opportunity.blockedReason = 'Run TrueType encoding-difference repair before CIDSet consistency repair.'
        } else if (opportunitiesHasTool(opportunities, 'repair_cid_symbol_font_maps') && !attemptedCidSymbol) {
          opportunity.blockedReason = 'Run CID symbol-font recovery before CIDSet consistency repair.'
        }
        break
      case 'substitute_legacy_fonts_in_place':
        if ((qpdf.unembeddedFontCount ?? 0) > 0 && !attemptedEmbed) {
          opportunity.blockedReason = 'Run embedding before legacy font substitution.'
        } else if ((qpdf.fontsMissingToUnicodeBlocking ?? qpdf.fontsMissingToUnicode ?? 0) > 0 && !attemptedUnicode) {
          opportunity.blockedReason = 'Run Unicode repair before legacy font substitution.'
        } else if ((qpdf.type1FontsMissingToUnicode ?? 0) > 0 && !attemptedType1) {
          opportunity.blockedReason = 'Run Type1/Type3 Unicode repair before legacy font substitution.'
        } else if (
          opportunity.derivedFromFailureModeKeys.includes('pdfua.cidset_consistency')
          && opportunitiesHasTool(opportunities, 'repair_cidset_consistency')
          && !attemptedCidSet
        ) {
          opportunity.blockedReason = 'Run CIDSet consistency repair before escalating to font substitution.'
        } else if (cidSymbolNoEffect && opportunitiesHasTool(opportunities, 'finalize_substituted_font_conformance')) {
          opportunity.blockedReason = 'Preserve substitution as the final bounded lane after deterministic Unicode and CID recovery are exhausted.'
        }
        break
      case 'finalize_substituted_font_conformance':
        if (!attemptedSubstitute) {
          opportunity.blockedReason = 'Finalize substituted fonts only after substitution has run.'
        }
        break
      default:
        break
    }
  }
}

function applyStructureOpportunityPolicy(
  opportunities: Map<string, Omit<ToolOpportunity, 'status'>>,
  input: BuildFailureProfileInput,
  failureModeByKey: Map<string, FailureMode>,
): void {
  const headingDebt = failureModeByKey.has('category.heading_structure') || failureModeByKey.has('pdfua.heading_content_quality')
  const readingDebt = failureModeByKey.has('category.reading_order')
  const markedContentDebt = failureModeByKey.has('pdfua.logical_structure')
  const figureDebtDominant = input.actions.length > 0 && input.actions.some(action =>
    (action.tool === 'repair_native_figure_semantics' || action.tool === 'repair_other_elements_alt_text')
    && (action.outcome === 'applied' || action.outcome === 'no_effect'),
  )
    ? false
    : input.actions.length === 0
      && input.context.structure.acrobatAltRiskNodes?.some(node => !node.graphicsLikelyDecorative)
      && input.context.figureCandidates.some(candidate => candidate.repairMode !== 'defer')
  const attemptedHeadingNormalization = input.actions.some(action =>
    action.tool === 'normalize_heading_hierarchy'
    && (action.outcome === 'applied' || action.outcome === 'no_effect')
  )
  const attemptedReadingOrderRepair = input.actions.some(action =>
    (action.tool === 'repair_native_reading_order' || action.tool === 'reorder_structure_children')
    && (action.outcome === 'applied' || action.outcome === 'no_effect')
  )
  const attemptedMarkedContentRepair = input.actions.some(action =>
    action.tool === 'repair_native_marked_content_refs'
    && (action.outcome === 'applied' || action.outcome === 'no_effect')
  )
  const mixedStructureFigureConvergence =
    (headingDebt || readingDebt || markedContentDebt)
    && (
      failureModeByKey.has('pdfua.figure_alt_or_artifact')
      || failureModeByKey.has('pdfua.nested_alt_text')
      || failureModeByKey.has('pdfua.untagged_rendered_images')
      || failureModeByKey.has('category.alt_text')
      || failureModeByKey.has('context.long_report_figure_residue')
    )
  const onlyStructureSpecificDebt = [...failureModeByKey.values()].every(mode =>
    mode.key.startsWith('context.post_')
    || STRUCTURE_ONLY_TERMINAL_FINDING_KEYS.has(mode.key)
    || mode.categoryIds.every(categoryId => ['heading_structure', 'reading_order', 'pdf_ua_compliance'].includes(categoryId)),
  )

  for (const opportunity of opportunities.values()) {
    if (!['normalize_heading_hierarchy', 'repair_native_reading_order', 'reorder_structure_children', 'repair_native_marked_content_refs', 'repair_structure_conformance'].includes(opportunity.toolName)) {
      continue
    }

    if (
      figureDebtDominant
      && !mixedStructureFigureConvergence
      && ['normalize_heading_hierarchy', 'repair_native_reading_order', 'reorder_structure_children', 'repair_native_marked_content_refs', 'repair_structure_conformance'].includes(opportunity.toolName)
    ) {
      opportunity.blockedReason = 'Figure-family convergence still dominates the residual debt; keep structure cleanup behind figure closure.'
      continue
    }

    if (opportunity.toolName === 'repair_native_reading_order' || opportunity.toolName === 'reorder_structure_children') {
      if (headingDebt && opportunitiesHasTool(opportunities, 'normalize_heading_hierarchy') && !attemptedHeadingNormalization) {
        opportunity.blockedReason = 'Normalize heading hierarchy before reading-order parent repair on post-bootstrap structure residue.'
      }
      continue
    }

    if (opportunity.toolName === 'repair_native_marked_content_refs') {
      if (
        !mixedStructureFigureConvergence
        && headingDebt
        && opportunitiesHasTool(opportunities, 'normalize_heading_hierarchy')
        && !attemptedHeadingNormalization
      ) {
        opportunity.blockedReason = 'Normalize heading hierarchy before marked-content reference cleanup.'
      } else if (
        !mixedStructureFigureConvergence
        && readingDebt
        && (opportunitiesHasTool(opportunities, 'repair_native_reading_order') || opportunitiesHasTool(opportunities, 'reorder_structure_children'))
        && !attemptedReadingOrderRepair
      ) {
        opportunity.blockedReason = 'Repair reading-order parents before marked-content reference cleanup.'
      }
      continue
    }

    if (opportunity.toolName === 'repair_structure_conformance') {
      if (
        !mixedStructureFigureConvergence
        && headingDebt
        && opportunitiesHasTool(opportunities, 'normalize_heading_hierarchy')
        && !attemptedHeadingNormalization
      ) {
        opportunity.blockedReason = 'Run heading-content verification and hierarchy normalization before broad structure conformance.'
      } else if (
        !mixedStructureFigureConvergence
        && readingDebt
        && (opportunitiesHasTool(opportunities, 'repair_native_reading_order') || opportunitiesHasTool(opportunities, 'reorder_structure_children'))
        && !attemptedReadingOrderRepair
      ) {
        opportunity.blockedReason = 'Run reading-order parent repair before broad structure conformance.'
      } else if (
        !mixedStructureFigureConvergence
        && markedContentDebt
        && opportunitiesHasTool(opportunities, 'repair_native_marked_content_refs')
        && !attemptedMarkedContentRepair
      ) {
        opportunity.blockedReason = 'Run marked-content reference cleanup before broad structure conformance.'
      } else if (!mixedStructureFigureConvergence && onlyStructureSpecificDebt) {
        opportunity.blockedReason = 'Broad structure conformance is not indicated while only heading, reading-order, or marked-content residue remains.'
      }
    }
  }
}

function applyFigureOpportunityPolicy(
  opportunities: Map<string, Omit<ToolOpportunity, 'status'>>,
  input: BuildFailureProfileInput,
  failureModeByKey: Map<string, FailureMode>,
): void {
  const longReportConvergence = isLongReportConvergenceContext(input)
  const blockingAltFailures = new Set(
    [...failureModeByKey.values()]
      .filter(mode => mode.blocking && mode.categoryIds.includes('alt_text'))
      .map(mode => mode.key),
  )
  const acrobatAltRiskNodes = input.context.structure.acrobatAltRiskNodes || []
  const substantiveUnresolvedAltRiskCount = acrobatAltRiskNodes.filter(node =>
    (!node.graphicsLikelyDecorative
      || node.ownershipMode === 'untagged_image_direct'
      || node.ownershipMode === 'untagged_image_mcid')
    && (ALT_REMOVAL_MODES.has(node.ownershipMode ?? '') ? node.hasAlt : !node.hasAlt)
  ).length
  const hasHighConfidenceInformativeLongReportFigure = longReportConvergence
    && input.context.figureCandidates.some(candidate =>
      candidate.repairMode !== 'defer'
      && candidate.informativeHint !== 'decorative'
      && (candidate.imageEvidence === 'strong' || candidate.imageEvidence === 'vector'),
    )
  const attemptedNestedFigureNormalization = input.actions.some(action =>
    action.tool === 'normalize_nested_figure_containers'
    && (action.outcome === 'applied' || action.outcome === 'no_effect')
  )
  const attemptedNativeFigureRepair = input.actions.some(action =>
    action.tool === 'repair_native_figure_semantics'
    && (action.outcome === 'applied' || action.outcome === 'no_effect')
  )

  for (const opportunity of opportunities.values()) {
    if (!FIGURE_REMEDIATION_TOOLS.has(opportunity.toolName)) continue
    const derivedFailureModes = opportunity.derivedFromFailureModeKeys
      .map(key => failureModeByKey.get(key))
      .filter((mode): mode is FailureMode => !!mode)
    const onlyAdvisoryFigureResidue = derivedFailureModes.length > 0
      && derivedFailureModes.every(mode => FIGURE_ADVISORY_FAILURE_MODE_KEYS.has(mode.key) && !mode.blocking)

    if (blockingAltFailures.size === 0 && substantiveUnresolvedAltRiskCount === 0 && onlyAdvisoryFigureResidue) {
      opportunity.blockedReason = 'Only advisory figure alternate-text quality residue remains; do not keep figure remediation auto-runnable.'
      continue
    }

    if (
      opportunity.toolName === 'repair_native_figure_semantics'
      && !attemptedNestedFigureNormalization
      && opportunitiesHasTool(opportunities, 'normalize_nested_figure_containers')
    ) {
      opportunity.blockedReason = 'Normalize nested figure containers before native figure repair.'
      continue
    }

    if (
      opportunity.toolName === 'repair_other_elements_alt_text'
      && !attemptedNativeFigureRepair
      && opportunitiesHasTool(opportunities, 'repair_native_figure_semantics')
    ) {
      opportunity.blockedReason = 'Run native figure repair before Acrobat-style non-figure alternate-text repair.'
      continue
    }

    if (
      longReportConvergence
      && opportunity.scope === 'document'
      && ['set_figure_alt_text', 'retag_as_figure_and_set_alt'].includes(opportunity.toolName)
    ) {
      opportunity.blockedReason = 'Use bounded candidate-level figure repairs for long-report figure convergence.'
      continue
    }

    if (
      longReportConvergence
      && opportunity.toolName === 'mark_figure_decorative'
      && opportunity.scope === 'document'
      && hasHighConfidenceInformativeLongReportFigure
    ) {
      opportunity.blockedReason = 'Prefer informative figure cleanup before broad decorative classification on long reports.'
    }
  }
}

function deriveOpportunityStatus(
  opportunity: Omit<ToolOpportunity, 'status'>,
  actions: RemediationActionRecord[],
  rejectedActions: RemediationActionRecord[],
): {
  status: ToolOpportunityStatus
  statusReasonCode: ToolOpportunityStatusReasonCode
  statusReasonDetail: string
  blockedReason?: string
} {
  const target = actionTargetForOpportunity(opportunity)
  const candidateId = opportunity.candidateIds[0]
  const candidateGroupId = opportunity.candidateGroupIds[0]

  const rejected = rejectedActions.find(action =>
    action.tool === opportunity.toolName &&
    (candidateId ? action.candidateId === candidateId
      : candidateGroupId ? action.candidateGroupId === candidateGroupId
      : action.target === target),
  )
  if (rejected) {
    return {
      status: 'rejected',
      statusReasonCode: 'rejected_before',
      statusReasonDetail: `A prior ${opportunity.toolName} attempt for this target was rejected.`,
    }
  }

  const prior = actions.find(action =>
    action.tool === opportunity.toolName &&
    (candidateId ? action.candidateId === candidateId
      : candidateGroupId ? action.candidateGroupId === candidateGroupId
      : action.target === target),
  )
  if (
    prior
    && opportunity.toolName === 'repair_other_elements_alt_text'
    && opportunity.derivedFromFailureModeKeys.includes('acrobat.other_elements_alt_text')
  ) {
    return {
      status: 'auto_runnable',
      statusReasonCode: 'retry_exception',
      statusReasonDetail: 'Acrobat-risk ownership repairs stay runnable while Acrobat debt remains.',
    }
  }
  if (
    prior?.outcome === 'no_effect'
    && opportunity.toolName === 'finalize_substituted_font_conformance'
    && opportunity.derivedFromFailureModeKeys.some(key => key === 'pdfua.font_widths' || key === 'pdfua.font_embedding')
  ) {
    return {
      status: 'auto_runnable',
      statusReasonCode: 'retry_exception',
      statusReasonDetail: 'Font finalization stays runnable after no-effect retries when width or embedding debt remains.',
    }
  }
  if (prior?.outcome === 'no_effect') {
    return {
      status: 'no_effect',
      statusReasonCode: 'no_effect_before',
      statusReasonDetail: `A prior ${opportunity.toolName} attempt completed with no measurable effect.`,
    }
  }
  if (prior) {
    return {
      status: 'already_attempted',
      statusReasonCode: 'already_attempted',
      statusReasonDetail: `A prior ${opportunity.toolName} attempt already targeted this scope.`,
    }
  }
  const isProactiveCleanupWithoutActiveFailure = opportunity.derivedFromFailureModeKeys.length === 0
    && [
      'repair_malformed_bdc_operators',
      'repair_annotation_alt_text',
      'set_tabs_all_annotated_pages',
    ].includes(opportunity.toolName)
  if (isProactiveCleanupWithoutActiveFailure) {
    return {
      status: 'deferred',
      statusReasonCode: 'no_active_failure_mode',
      statusReasonDetail: 'This cleanup remains available, but no active blocking failure currently derives it.',
    }
  }
  if (opportunity.blockedReason) {
    const blockedByManualOnlyFailureMode = opportunity.derivedFromFailureModeKeys.some(key =>
      key.startsWith('context.') || key === 'pdfua.unmatched',
    )
    const status = opportunity.scope === 'candidate' || opportunity.scope === 'candidate_group' ? 'blocked' : 'deferred'
    const statusReasonCode: ToolOpportunityStatusReasonCode = blockedByManualOnlyFailureMode
      ? 'manual_only_failure_mode'
      : status === 'blocked'
        ? 'candidate_blocked'
        : 'deferred_document_scope'
    return {
      status,
      statusReasonCode,
      statusReasonDetail: opportunity.blockedReason,
      blockedReason: opportunity.blockedReason,
    }
  }
  return {
    status: 'auto_runnable',
    statusReasonCode: 'safe_to_run',
    statusReasonDetail: 'The current snapshot supports a safe deterministic run.',
  }
}

function buildToolOpportunities(input: BuildFailureProfileInput, failureModes: FailureMode[]): ToolOpportunity[] {
  const opportunities = new Map<string, Omit<ToolOpportunity, 'status'>>()
  const failureModeByKey = new Map(failureModes.map(mode => [mode.key, mode]))
  const issueIds = new Set(
    input.analysis.categories
      .filter(category => typeof category.score === 'number' && category.score < 100)
      .map(category => category.id),
  )
  const isLongReportConvergence = isLongReportConvergenceContext(input)
  const bootstrapAugmentedExistingTree = input.actions.some(action =>
    action.tool === 'bootstrap_struct_tree'
    && action.outcome === 'applied'
    && /Augmented existing structure tree/i.test(action.details || ''),
  )
  const postBootstrapStructureRefsAvailable = input.context.headingCandidates.length > 0
    || (input.context.qpdf.headings?.length || 0) > 0
  const postBootstrapStructuralResidue = failureModeByKey.has('context.post_bootstrap_structural_residue')
  const prioritizedLongReportHeadingIds = isLongReportConvergence && issueIds.has('heading_structure')
    ? new Set(
        selectHighConfidenceLongReportHeadingCandidates(input.context.headingCandidates, {
          maxCandidates: LONG_REPORT_HEADING_LIMIT,
        }).map(candidate => candidate.id),
      )
    : null
  const prioritizedLongReportFigureIds = isLongReportConvergence && issueIds.has('alt_text')
    ? new Set(
        selectHighConfidenceLongReportFigureCandidates(input.context.figureCandidates, {
          maxCandidates: LONG_REPORT_FIGURE_LIMIT,
        }).map(candidate => candidate.id),
      )
    : null
  const hasNativeStructure = input.context.qpdf.hasStructTree
    && input.context.qpdf.structTreeDepth > 0
    && (input.context.structure.structuralNodes?.length || 0) > 0
  const qpdfTableCount = input.context.qpdf.tables?.length ?? 0
  const currentLanguage = input.context.qpdf.lang || input.context.pdfjs.lang || ''
  const metadataDebtActive = failureModeByKey.has('pdfua.metadata_identification')
    || failureModeByKey.has('pdfua.document_language')
    || failureModeByKey.has('pdfua.display_doc_title')
    || !hasMeaningfulMetadataTitle(input.context.pdfjs.title)
    || !currentLanguage
    || needsLanguageTagNormalization(currentLanguage)

  const derivedFailureKeys = (keys: string[]) => keys.filter(key => failureModeByKey.has(key))

  if (issueIds.has('title_language') && metadataDebtActive) {
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
    if (!hasMeaningfulMetadataTitle(input.context.pdfjs.title)) {
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

  if (
    failureModeByKey.has('pdfua.metadata_identification')
    && !opportunities.has('set_pdfua_identification:document:document')
  ) {
    addOpportunity(opportunities, {
      toolName: 'set_pdfua_identification',
      reason: 'The document metadata is missing or incomplete for PDF/UA identification, so the identification dictionary should be normalized early.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['title_language', 'pdf_ua_compliance'],
      confidence: 0.9,
      blockedReason: undefined,
      derivedFromFailureModeKeys: derivedFailureKeys(['pdfua.metadata_identification', 'category.title_language']),
    })
  }

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
      derivedFromFailureModeKeys: derivedFailureKeys(['category.alt_text', 'pdfua.figure_alt_or_artifact', 'context.long_report_figure_residue']),
    })
  }

  if (
    issueIds.has('alt_text')
    && (
      failureModeByKey.has('pdfua.nested_alt_text')
      || failureModeByKey.has('pdfua.untagged_rendered_images')
      || failureModeByKey.has('pdfua.figure_alt_or_artifact')
    )
  ) {
    addOpportunity(opportunities, {
      toolName: 'normalize_nested_figure_containers',
      reason: 'Normalize nested figure containers before native figure repair so figure ownership and alternate-text cleanup can converge deterministically.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['alt_text', 'pdf_ua_compliance'],
      confidence: 0.84,
      blockedReason: undefined,
      derivedFromFailureModeKeys: derivedFailureKeys([
        'pdfua.nested_alt_text',
        'pdfua.untagged_rendered_images',
        'pdfua.figure_alt_or_artifact',
        'context.long_report_figure_residue',
      ]),
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
    || (node.ownershipMode === 'mixed_text_graphics_same_mcid' && node.containmentSafe)
    || node.ownershipMode === 'graphics_only_nonfigure'
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
      derivedFromFailureModeKeys: derivedFailureKeys(['acrobat.other_elements_alt_text', 'context.long_report_figure_residue']),
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

  if (issueIds.has('table_markup') && qpdfTableCount > 0) {
    addOpportunity(opportunities, {
      toolName: 'repair_native_table_headers',
      reason: input.context.tableCandidates.length > 0
        ? 'The document exposes table debt and qpdf still sees tables, so native table header repair remains available.'
        : 'The document exposes table debt, but the backend structure snapshot did not surface table candidates; try native table header repair directly.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['table_markup'],
      confidence: input.context.tableCandidates.length > 0 ? 0.58 : 0.5,
      blockedReason: undefined,
      derivedFromFailureModeKeys: derivedFailureKeys(['category.table_markup', 'context.table_candidates_blocked', 'pdfua.table_regularity']),
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

  // Proactively fix malformed BDC operators (missing tag-name operand) on tagged PDFs.
  // Some generators emit `<dict> BDC` instead of `/Tag <dict> BDC`; this causes pdftoppm
  // to fail rendering pages (white-page output), which in turn causes false-positive
  // color-contrast failures. Schedule this repair whenever the document has a struct tree.
  if (input.context.qpdf.hasStructTree || input.context.qpdf.isTagged) {
    addOpportunity(opportunities, {
      toolName: 'repair_malformed_bdc_operators',
      reason: 'Repair BDC operators missing their tag-name operand to fix page rendering and eliminate false-positive color-contrast failures.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['text_extractability', 'pdf_ua_compliance'],
      confidence: 0.9,
      blockedReason: undefined,
      derivedFromFailureModeKeys: [],
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
      || (mode.key.startsWith('pdfua.') && (input.analysis.verapdf.status === 'failed' || input.analysis.localStandards?.status === 'issues_detected'))
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
    failureModeByKey.has('pdfua.font_unicode')
    && ((input.context.qpdf.type1FontsMissingToUnicode ?? 0) > 0 || input.analysis.pageCount >= 10)
    && !failureModeByKey.has('pdfua.type1_unicode')
  ) {
    addOpportunity(opportunities, {
      toolName: 'repair_type1_font_unicode_maps',
      reason: (input.context.qpdf.type1FontsMissingToUnicode ?? 0) > 0
        ? `Detected ${(input.context.qpdf.type1FontsMissingToUnicode ?? 0)} Type1/Type3 font object(s) still missing ToUnicode maps, so a Type1/Type3-specific Unicode recovery pass is warranted.`
        : 'Large legacy PDFs with persistent font Unicode failures often need a Type1/Type3-specific Unicode recovery pass.',
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

  if (
    issueIds.has('heading_structure')
    && (input.context.qpdf.headings ?? []).some(heading => /^H\d+$/i.test(heading.level))
  ) {
    addOpportunity(opportunities, {
      toolName: 'normalize_heading_hierarchy',
      reason: 'Existing heading tags already form a detectable hierarchy, but their levels need normalization to remove Acrobat-style nesting failures.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['heading_structure'],
      confidence: 0.92,
      blockedReason: undefined,
      derivedFromFailureModeKeys: derivedFailureKeys([
        'category.heading_structure',
        'context.post_bootstrap_native_structure_debt',
        'context.post_bootstrap_structural_residue',
        'context.post_heading_creation_native_structure_debt',
      ]),
    })
  }

  const nativeHeadingsExist = (input.context.qpdf.headings?.length || 0) > 0
  for (const candidate of input.context.headingCandidates) {
    if (!issueIds.has('heading_structure')) continue
    if (
      isLongReportConvergence
      && nativeHeadingsExist
      && postBootstrapStructuralResidue
      && candidate.repairMode === 'safe'
    ) {
      continue
    }
    if (
      prioritizedLongReportHeadingIds
      && candidate.repairMode === 'safe'
      && !prioritizedLongReportHeadingIds.has(candidate.id)
    ) {
      continue
    }
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
      confidence: candidate.pageNumber === 1 ? 0.82 : candidate.fontWeight === 'bold' ? 0.76 : 0.7,
      blockedReason: candidate.repairMode === 'safe' ? undefined : (candidate.unsafeReason || 'Heading candidate requires semantic review.'),
      derivedFromFailureModeKeys: derivedFailureKeys(['category.heading_structure', 'context.heading_candidates_blocked']),
    })
  }

  for (const candidate of input.context.figureCandidates) {
    if (!issueIds.has('alt_text')) continue
    if (
      prioritizedLongReportFigureIds
      && candidate.repairMode !== 'defer'
      && !prioritizedLongReportFigureIds.has(candidate.id)
    ) {
      continue
    }
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
      derivedFromFailureModeKeys: derivedFailureKeys(['category.alt_text', 'context.figure_candidates_blocked', 'pdfua.figure_alt_or_artifact', 'context.long_report_figure_residue']),
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
    !input.analysis.isScanned
    && (issueIds.has('text_extractability') || issueIds.has('heading_structure') || issueIds.has('alt_text') || issueIds.has('reading_order'))
    && (!input.context.qpdf.hasStructTree || weakNativeBootstrapNeeded(input))
    && !(
      isLongReportConvergence
      && bootstrapAugmentedExistingTree
      && (postBootstrapStructureRefsAvailable || postBootstrapStructuralResidue)
    )
  ) {
    addOpportunity(opportunities, {
      toolName: 'bootstrap_struct_tree',
      reason: !input.context.qpdf.hasStructTree
        ? 'The document lacks a usable structure tree, so a bootstrap pass is the first deterministic repair opportunity.'
        : 'The native structure tree is present but too weak to support headings or figures reliably, so a bootstrap augmentation pass is warranted.',
      scope: 'document',
      candidateIds: [],
      candidateGroupIds: [],
      pageNumbers: [],
      categoryTargets: ['text_extractability', 'heading_structure', 'alt_text', 'reading_order', 'table_markup'],
      confidence: 0.72,
      blockedReason: undefined,
      derivedFromFailureModeKeys: derivedFailureKeys(['category.text_extractability', 'category.heading_structure', 'category.alt_text', 'category.reading_order', 'category.table_markup']),
    })
  }

  if (issueIds.has('bookmarks')) {
    const prioritizedHeadingWorkPending = !!prioritizedLongReportHeadingIds?.size
    const headingConvergenceStarted = input.actions.some(action =>
      (action.tool === 'create_heading_from_candidate' || action.tool === 'normalize_heading_hierarchy')
      && action.outcome === 'applied',
    )
    const bookmarkBlockedReason = !input.context.headingCandidates.length
      ? 'Bookmark generation needs heading candidates or manual review.'
      : isLongReportConvergence && metadataDebtActive
        ? 'Bookmark generation should wait until metadata and language normalization complete on long reports.'
        : isLongReportConvergence && prioritizedHeadingWorkPending && !headingConvergenceStarted
          ? 'Bookmark generation should wait until the highest-confidence heading candidates have been repaired.'
          : undefined
    const existingBookmarkOpportunity = [...opportunities.values()].find(opportunity => opportunity.toolName === 'replace_bookmarks_from_headings')
    if (existingBookmarkOpportunity) {
      existingBookmarkOpportunity.blockedReason = bookmarkBlockedReason
      existingBookmarkOpportunity.categoryTargets = ['bookmarks']
      existingBookmarkOpportunity.derivedFromFailureModeKeys = derivedFailureKeys([
        ...existingBookmarkOpportunity.derivedFromFailureModeKeys,
        'category.bookmarks',
      ])
    } else {
      addOpportunity(opportunities, {
        toolName: 'replace_bookmarks_from_headings',
        reason: 'The document lacks bookmarks and can try generating them from headings.',
        scope: 'document',
        candidateIds: [],
        candidateGroupIds: [],
        pageNumbers: [],
        categoryTargets: ['bookmarks'],
        confidence: 0.55,
        blockedReason: bookmarkBlockedReason,
        derivedFromFailureModeKeys: derivedFailureKeys(['category.bookmarks']),
      })
    }
  }

  applyFigureOpportunityPolicy(opportunities, input, failureModeByKey)
  applyFontOpportunityPolicy(opportunities, input, failureModeByKey)
  applyStructureOpportunityPolicy(opportunities, input, failureModeByKey)

  return [...opportunities.values()]
    .map(opportunity => {
      const status = deriveOpportunityStatus(opportunity, input.actions, input.rejectedActions)
      return {
        ...opportunity,
        status: status.status,
        statusReasonCode: status.statusReasonCode,
        statusReasonDetail: status.statusReasonDetail,
        blockedReason: status.blockedReason,
      }
    })
    .sort((a, b) => a.key.localeCompare(b.key))
}

export function buildPlannerEvidenceSummary(input: {
  failureModes: FailureMode[]
  residualFamilies?: FailureProfile['residualFamilies']
  toolOpportunities: ToolOpportunity[]
  actions: RemediationActionRecord[]
  rejectedActions: RemediationActionRecord[]
  iterations?: RemediationIteration[]
}): PlannerEvidenceSummary {
  const skippedReasonCounts = new Map<string, number>()
  const statusCounts = new Map<ToolOpportunityStatus, number>()
  const reasonCodeCounts = new Map<ToolOpportunityStatusReasonCode, number>()
  for (const opportunity of input.toolOpportunities) {
    statusCounts.set(opportunity.status, (statusCounts.get(opportunity.status) || 0) + 1)
    if (opportunity.statusReasonCode) {
      reasonCodeCounts.set(opportunity.statusReasonCode, (reasonCodeCounts.get(opportunity.statusReasonCode) || 0) + 1)
    }
    if (opportunity.status === 'auto_runnable') continue
    const reason = opportunity.statusReasonDetail || opportunity.blockedReason || opportunity.status
    skippedReasonCounts.set(reason, (skippedReasonCounts.get(reason) || 0) + 1)
  }

  const attemptedKeys = unique(input.actions.map(action => actionKey(action.tool, action.candidateGroupId || action.candidateId || action.target)))
  const rejectedKeys = unique(input.rejectedActions.map(action => actionKey(action.tool, action.candidateGroupId || action.candidateId || action.target)))
  const noEffectKeys = unique(input.actions
    .filter(action => action.outcome === 'no_effect')
    .map(action => actionKey(action.tool, action.candidateGroupId || action.candidateId || action.target)))
  const attemptedOpportunityKeys = input.toolOpportunities
    .filter(opportunity => opportunity.status === 'already_attempted')
    .map(opportunity => opportunity.key)
  const rejectedOpportunityKeys = input.toolOpportunities
    .filter(opportunity => opportunity.status === 'rejected')
    .map(opportunity => opportunity.key)
  const noEffectOpportunityKeys = input.toolOpportunities
    .filter(opportunity => opportunity.status === 'no_effect')
    .map(opportunity => opportunity.key)
  const dominantResidualFamily = dominantResidualFamilyForProfile(input.failureModes, input.residualFamilies || [])
  const retryDisposition = retryDispositionForProfile({
    failureModes: input.failureModes,
    residualFamilies: input.residualFamilies || [],
    toolOpportunities: input.toolOpportunities,
  })
  const mixedFamilyConvergencePath = hasMixedStructureFigureConvergencePath(input.failureModes, input.residualFamilies || [])

  return {
    topFailureModeKeys: input.failureModes.slice(0, 5).map(mode => mode.key),
    topResidualFamilyIds: (input.residualFamilies || []).slice(0, 5).map(family => family.id),
    topBlockingResidualFamilyIds: (input.residualFamilies || [])
      .filter(family => family.blocking)
      .slice(0, 5)
      .map(family => family.id),
    topResidualFamilySummaries: (input.residualFamilies || [])
      .slice(0, 5)
      .map(family => ({
        id: family.id,
        label: family.label,
        blocking: family.blocking,
        blockingReason: family.blockingReason,
        convergenceStatus: family.convergenceStatus,
        currentStep: family.currentStep,
        preferredAutoRunnableOpportunityKeys: family.preferredAutoRunnableOpportunityKeys.slice(0, 5),
        evidenceSignals: family.evidenceSignals.slice(0, 5),
        evidenceStrength: family.evidenceStrength,
      })),
    topBlockingFailureModeKeys: input.failureModes.filter(mode => mode.blocking).slice(0, 5).map(mode => mode.key),
    topManualOnlyFailureModeKeys: input.failureModes.filter(mode => mode.classification === 'manual_only').slice(0, 5).map(mode => mode.key),
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
    attemptedOpportunityKeys,
    rejectedOpportunityKeys,
    noEffectOpportunityKeys,
    statusCounts: [...statusCounts.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)),
    reasonCodeCounts: [...reasonCodeCounts.entries()]
      .map(([reasonCode, count]) => ({ reasonCode, count }))
      .sort((a, b) => b.count - a.count || a.reasonCode.localeCompare(b.reasonCode)),
    safeToRetry: retryDisposition === 'retryable_deterministic',
    dominantResidualFamily,
    lastStableNoEffectTool: lastStableNoEffectTool(input.actions),
    retryDisposition,
    mixedFamilyConvergencePath,
  }
}

function hasMixedStructureFigureConvergencePath(
  failureModes: FailureMode[],
  residualFamilies: FailureProfile['residualFamilies'],
): boolean {
  const blockingFailureKeys = new Set(
    failureModes
      .filter(mode => mode.blocking)
      .map(mode => mode.key),
  )
  const hasStructureDebt =
    blockingFailureKeys.has('pdfua.logical_structure')
    || blockingFailureKeys.has('pdfua.heading_content_quality')
    || blockingFailureKeys.has('category.heading_structure')
    || residualFamilies.some(family =>
      family.blocking
      && (family.id === 'logical_structure_marked_content' || family.id === 'post_bootstrap_heading_convergence'),
    )
  const hasFigureDebt =
    blockingFailureKeys.has('pdfua.figure_alt_or_artifact')
    || blockingFailureKeys.has('pdfua.nested_alt_text')
    || blockingFailureKeys.has('pdfua.untagged_rendered_images')
    || blockingFailureKeys.has('category.alt_text')
    || residualFamilies.some(family => family.blocking && family.id === 'native_figure_convergence')
  return hasStructureDebt && hasFigureDebt
}

function dominantResidualFamilyForProfile(
  failureModes: FailureMode[],
  residualFamilies: FailureProfile['residualFamilies'],
): FailureProfileDominantResidualFamily {
  const rankedFamilies = [...residualFamilies].sort((left, right) => {
    const blockingDelta = Number(right.blocking) - Number(left.blocking)
    if (blockingDelta !== 0) return blockingDelta
    const preferredDelta = (right.preferredAutoRunnableOpportunityKeys.length || 0) - (left.preferredAutoRunnableOpportunityKeys.length || 0)
    if (preferredDelta !== 0) return preferredDelta
    const activeDelta = (right.activeOpportunityKeys.length || 0) - (left.activeOpportunityKeys.length || 0)
    if (activeDelta !== 0) return activeDelta
    const evidenceDelta = (right.evidenceStrength || 0) - (left.evidenceStrength || 0)
    if (evidenceDelta !== 0) return evidenceDelta
    const priorityDelta = (right.priority || 0) - (left.priority || 0)
    if (priorityDelta !== 0) return priorityDelta
    return left.id.localeCompare(right.id)
  })

  if (rankedFamilies[0]?.id) return rankedFamilies[0].id

  const hasManualOnly = failureModes.some(mode => mode.classification === 'manual_only')
  const hasActionableFailure = failureModes.some(mode => mode.classification !== 'manual_only')
  if (hasManualOnly && !hasActionableFailure) return 'manual'
  return 'unknown'
}

function lastStableNoEffectTool(actions: RemediationActionRecord[]): RemediationToolName | null {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    if (actions[index]?.outcome === 'no_effect') return actions[index].tool
  }
  return null
}

function retryDispositionForProfile(input: {
  failureModes: FailureMode[]
  residualFamilies: FailureProfile['residualFamilies']
  toolOpportunities: ToolOpportunity[]
}): RetryDisposition {
  const dominantResidualFamily = dominantResidualFamilyForProfile(input.failureModes, input.residualFamilies)
  const autoRunnableOpportunityCount = input.toolOpportunities
    .filter(opportunity => opportunity.status === 'auto_runnable')
    .length
  const hasManualOnly = input.failureModes.some(mode => mode.classification === 'manual_only')
  const hasActionableFailure = input.failureModes.some(mode => mode.classification !== 'manual_only')

  if (autoRunnableOpportunityCount > 0) return 'retryable_deterministic'
  if (dominantResidualFamily === 'manual') return 'manual_residual'
  if (hasManualOnly && !hasActionableFailure) return 'manual_residual'
  return 'stable_hard_fail'
}

export function buildFailureProfile(input: BuildFailureProfileInput): FailureProfile {
  const failureModes = buildFailureModes(input)
  const rawToolOpportunities = buildToolOpportunities(input, failureModes)
  const residualFamilies = buildResidualFamilyDecisions({
    analysis: input.analysis,
    context: input.context,
    failureModes,
    toolOpportunities: rawToolOpportunities,
    actions: input.actions,
  })
  const toolOpportunities = annotateToolOpportunitiesWithResidualFamilies({
    toolOpportunities: rawToolOpportunities,
    residualFamilies,
  })
  const deterministicIssueCount = failureModes.filter(mode => mode.classification === 'deterministic').length
  const semanticIssueCount = failureModes.filter(mode => mode.classification === 'semantic').length
  const manualOnlyIssueCount = failureModes.filter(mode => mode.classification === 'manual_only').length
  const blockedOpportunityCount = toolOpportunities.filter(opportunity => opportunity.status === 'blocked' || opportunity.status === 'deferred').length
  const autoRunnableOpportunityCount = toolOpportunities.filter(opportunity => opportunity.status === 'auto_runnable').length
  const dominantResidualFamily = dominantResidualFamilyForProfile(failureModes, residualFamilies)
  const retryDisposition = retryDispositionForProfile({
    failureModes,
    residualFamilies,
    toolOpportunities,
  })
  const mixedFamilyConvergencePath = hasMixedStructureFigureConvergencePath(failureModes, residualFamilies)

  return {
    version: '2',
    generatedAt: nowIso(),
    analysisGrade: input.analysis.grade,
    analysisScore: input.analysis.overallScore,
    veraPdfStatus: input.analysis.verapdf.status,
    veraPdfFailedChecks: input.analysis.verapdf.failedChecks,
    adobeStatus: input.analysis.adobe?.status,
    adobeIssueCount: input.analysis.adobe?.issueCount,
    failureModes,
    residualFamilies,
    toolOpportunities,
    summary: {
      deterministicIssueCount,
      semanticIssueCount,
      manualOnlyIssueCount,
      blockedOpportunityCount,
      autoRunnableOpportunityCount,
      safeToRetry: retryDisposition === 'retryable_deterministic',
      dominantResidualFamily,
      lastStableNoEffectTool: lastStableNoEffectTool(input.actions),
      retryDisposition,
      mixedFamilyConvergencePath,
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
    residualFamilies: failureProfile.residualFamilies,
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
