export type DocumentModelStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface AssetRef {
  path: string
  mimeType: 'image/png'
}

export interface ConfidenceSummary {
  overall: number
  textRecovery: number
  structureRecovery: number
  tableRecovery: number
  visualFidelity: number
}

export interface VeraPdfSummary {
  status: 'passed' | 'failed' | 'unavailable' | 'timeout' | 'parse_error' | 'error'
  profile: string | null
  flavour: string | null
  failedChecks: number
  passedChecks: number
  topFailures: string[]
}

export interface ModelReviewFlag {
  code: string
  label: string
  severity: 'warning' | 'critical'
  details: string
  pageNumber?: number
  region?: BoundingBox | null
  asset?: AssetRef | null
}

export interface AppliedChange {
  type: 'title' | 'language' | 'alt_text' | 'bookmark' | 'table' | 'reading_order' | 'artifact' | 'text_recovery' | 'structure'
  label: string
  details: string
  pageNumber?: number
  confidence: number
  autoApplied: boolean
}

export interface SuggestedChange extends AppliedChange {
  reason: string
}

export interface PageLink {
  url: string
  text: string
}

export interface PageHeadingCandidate {
  text: string
  level: 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6'
  confidence: number
}

export interface PageTableCandidate {
  summary: string
  hasHeaderRow: boolean
  confidence: number
}

export interface PageImageCandidate {
  altText: string
  decorative: boolean
  confidence: number
}

export interface PageModel {
  pageNumber: number
  width: number
  height: number
  html: string
  css?: string | null
  links?: PageLink[]
  pageRole?: 'cover' | 'toc' | 'section' | 'appendix' | 'content' | 'unknown'
  headingCandidates?: PageHeadingCandidate[]
  tableCandidates?: PageTableCandidate[]
  imageCandidates?: PageImageCandidate[]
}

export type RemediationToolName =
  | 'ocr_scanned_pdf'
  | 'get_document_metadata'
  | 'set_document_title'
  | 'set_document_language'
  | 'set_pdfua_identification'
  | 'normalize_document_metadata'
  | 'repair_structure_conformance'
  | 'repair_note_tag_ids'
  | 'repair_native_marked_content_refs'
  | 'repair_native_link_structure'
  | 'repair_bootstrapped_chart_content_refs'
  | 'repair_native_figure_semantics'
  | 'repair_other_elements_alt_text'
  | 'repair_native_table_headers'
  | 'repair_native_reading_order'
  | 'repair_font_unicode_maps'
  | 'repair_type1_font_unicode_maps'
  | 'substitute_legacy_fonts_in_place'
  | 'finalize_substituted_font_conformance'
  | 'repair_cidset_consistency'
  | 'set_page_tabs'
  | 'normalize_annotation_tab_order'
  | 'list_bookmarks'
  | 'create_bookmark'
  | 'replace_bookmarks_from_headings'
  | 'list_links'
  | 'set_link_annotation_contents'
  | 'repair_cid_symbol_font_maps'
  | 'embed_missing_fonts_in_place'
  | 'embed_missing_fonts_for_page_content'
  | 'update_link_destination'
  | 'update_link_visible_text'
  | 'list_figures'
  | 'set_figure_alt_text'
  | 'retag_as_figure_and_set_alt'
  | 'mark_figure_decorative'
  | 'list_form_fields'
  | 'set_form_field_label'
  | 'set_form_field_tooltip'
  | 'inspect_tag_tree'
  | 'list_heading_candidates'
  | 'list_table_candidates'
  | 'inspect_reading_order'
  | 'bootstrap_struct_tree'
  | 'create_heading_from_candidate'
  | 'retag_node'
  | 'create_heading_tag'
  | 'set_table_header_cells'
  | 'move_tag_in_reading_order'
  | 'reorder_structure_children'
  | 'rewrite_link_visible_text'
  | 'mark_content_artifact'
  | 'artifact_nonsemantic_page_elements'
  | 'save_working_pdf'

export type VisibleContentChangePolicy = 'no_visible_changes' | 'limited_text_rewrites' | 'page_rebuilt'

export interface RemediationToolCall {
  tool_name: RemediationToolName
  arguments: Record<string, any>
  rationale: string
  confidence: number
}

export interface RemediationActionRecord {
  tool: RemediationToolName
  target: string
  candidateId?: string
  candidateGroupId?: string
  before?: string | null
  after?: string | null
  details: string
  confidence: number
  autoApplied: boolean
  changedVisibleContent: boolean
  outcome: 'applied' | 'skipped' | 'unsupported' | 'failed' | 'inspection' | 'no_effect' | 'deferred' | 'rejected'
  categoryTargets?: string[]
  changedDocumentBytes?: boolean
  scoreDelta?: Array<{ categoryId: string; before: number | null; after: number | null }>
  validationWarnings?: string[]
}

export interface RemediationIteration {
  iteration: number
  plannedActions: RemediationToolCall[]
  executedActions: RemediationActionRecord[]
  changedDocument: boolean
}

export type FailureClassification = 'deterministic' | 'semantic' | 'manual_only'
export type FailureModeSource = 'verapdf' | 'category' | 'context' | 'composite'
export type ToolOpportunityScope = 'document' | 'page' | 'candidate' | 'candidate_group'
export type ToolOpportunityStatus = 'auto_runnable' | 'blocked' | 'deferred' | 'already_attempted' | 'rejected' | 'no_effect'

export interface FailureMode {
  key: string
  label: string
  source: FailureModeSource
  count: number
  categoryIds: string[]
  blocking: boolean
  unmatched: boolean
  classification: FailureClassification
  nativeToolFamilies: RemediationToolName[]
  evidence: string[]
}

export interface ToolOpportunity {
  key: string
  toolName: RemediationToolName
  reason: string
  scope: ToolOpportunityScope
  candidateIds: string[]
  candidateGroupIds: string[]
  pageNumbers: number[]
  categoryTargets: string[]
  confidence: number
  status: ToolOpportunityStatus
  blockedReason?: string
  derivedFromFailureModeKeys: string[]
}

export interface PlannerEvidenceSummary {
  topFailureModeKeys: string[]
  topAutoRunnableOpportunityKeys: string[]
  skippedReasonCounts: Array<{ reason: string; count: number }>
  attemptedKeys: string[]
  rejectedKeys: string[]
  noEffectKeys: string[]
}

export interface FailureProfile {
  version: '1'
  generatedAt: string
  analysisGrade: string
  analysisScore: number
  veraPdfStatus: VeraPdfSummary['status']
  veraPdfFailedChecks: number
  failureModes: FailureMode[]
  toolOpportunities: ToolOpportunity[]
  summary: {
    deterministicIssueCount: number
    semanticIssueCount: number
    manualOnlyIssueCount: number
    blockedOpportunityCount: number
    autoRunnableOpportunityCount: number
  }
}

export interface DocumentModel {
  version: '4' | '6'
  processingPath?: 'ai_html' | 'agent_patch'
  pathFallbacks?: string[]
  nativeTaggedSafeMode?: boolean
  title: string | null
  language: string | null
  sourceType: 'native-text' | 'flattened' | 'mixed'
  confidenceSummary: ConfidenceSummary
  pages?: PageModel[]
  iterations?: RemediationIteration[]
  actions?: RemediationActionRecord[]
  rejectedActions?: RemediationActionRecord[]
  visibleContentChangePolicy?: VisibleContentChangePolicy
  finalAudit?: {
    overallScore: number
    grade: string
    unresolvedIssues: string[]
    veraPdf?: VeraPdfSummary | null
  } | null
  originalVeraPdf?: VeraPdfSummary | null
  remediatedVeraPdf?: VeraPdfSummary | null
  failureProfile?: FailureProfile | null
  plannerEvidence?: PlannerEvidenceSummary | null
  manualReviewFlags: ModelReviewFlag[]
  aiAppliedChanges: AppliedChange[]
  aiSuggestedChanges: SuggestedChange[]
}

export interface ReconstructionArtifacts {
  pageImages: Array<{
    pageNumber: number
    dataUrl: string
    buffer: Buffer
  }>
}

export interface ReconstructionOutput {
  model: DocumentModel
  artifacts: ReconstructionArtifacts
}

export function average(values: number[]): number {
  if (!values.length) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}
