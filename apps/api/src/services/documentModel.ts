import type { PromotionGateResult } from './promotionGate.js'

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

export interface AdobeFindingSummary {
  id: string
  rule: string
  categoryId: string | null
  severity: 'info' | 'warning' | 'error'
  message: string
}

export interface AdobeSummary {
  status: 'passed' | 'failed' | 'unavailable' | 'error'
  summary: string
  passed: boolean | null
  issueCount: number
  findings: AdobeFindingSummary[]
  warnings: string[]
  artifacts?: {
    checkerJsonPath?: string | null
    checkerReportPath?: string | null
    autoTagPdfPath?: string | null
    autoTagReportPath?: string | null
  } | null
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
  generationSource?: 'semantic_ai' | 'heuristic_fallback' | 'manual_deferred'
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
  | 'adobe_accessibility_check'
  | 'adobe_auto_tag'
  | 'get_document_metadata'
  | 'set_document_title'
  | 'set_document_language'
  | 'set_pdfua_identification'
  | 'normalize_document_metadata'
  | 'repair_structure_conformance'
  | 'repair_malformed_bdc_operators'
  | 'repair_note_tag_ids'
  | 'repair_native_marked_content_refs'
  | 'repair_native_link_structure'
  | 'tag_unowned_annotations'
  | 'repair_bootstrapped_chart_content_refs'
  | 'repair_native_figure_semantics'
  | 'repair_other_elements_alt_text'
  | 'repair_native_table_headers'
  | 'repair_native_reading_order'
  | 'repair_font_unicode_maps'
  | 'repair_type1_font_unicode_maps'
  | 'repair_truetype_encoding_differences'
  | 'repair_annotation_alt_text'
  | 'set_tabs_all_annotated_pages'
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
  | 'normalize_heading_hierarchy'
  | 'normalize_nested_figure_containers'
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

export type ResidualFamilyId =
  | 'metadata_normalization'
  | 'bookmark_language_outline_cleanup'
  | 'font_embedding_and_unicode'
  | 'table_structure_recovery'
  | 'link_tabs_and_annotation_cleanup'
  | 'native_figure_convergence'
  | 'post_bootstrap_heading_convergence'
  | 'logical_structure_marked_content'
  | 'unresolved_manual_family'

export type ResidualSemanticPolicy = 'forbidden' | 'optional_after_deterministic' | 'manual_only'
export type FamilyPostconditionStatus = 'satisfied' | 'not_satisfied' | 'unknown'
export type ResidualFamilyConvergenceStatus =
  | 'preferred_tools_available'
  | 'preferred_tools_exhausted'
  | 'postconditions_satisfied'
  | 'manual_only'

export interface RemediationToolCall {
  tool_name: RemediationToolName
  arguments: Record<string, any>
  rationale: string
  confidence: number
  familyId?: ResidualFamilyId
  familyStep?: number
  expectedPostconditions?: string[]
}

export interface RemediationActionRecord {
  tool: RemediationToolName
  target: string
  candidateId?: string
  candidateGroupId?: string
  targetRef?: string
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
  generationSource?: 'semantic_ai' | 'heuristic_fallback' | 'manual_deferred'
  familyId?: ResidualFamilyId
  familyStep?: number
  expectedPostconditions?: string[]
  postconditionStatus?: FamilyPostconditionStatus
  postconditionSignals?: string[]
  linkOperationSummary?: {
    operation: string
    taggedLinkCount: number
    taggedAnnotationCount: number
    orphanAnnotationCountReduced: number
    repairedLinkStructureCount: number
    annotationContentsSetCount: number
    annotationTabOrderNormalizedCount: number
    tabsSetCount: number
    unresolvedWarningCount: number
  }
}

export interface RemediationIteration {
  iteration: number
  plannedActions: RemediationToolCall[]
  executedActions: RemediationActionRecord[]
  changedDocument: boolean
}

export type FailureClassification = 'deterministic' | 'semantic' | 'manual_only'
export type FailureModeSource = 'verapdf' | 'local_standards' | 'category' | 'context' | 'composite'
export type FailureReportingCategory = 'metadata' | 'language' | 'logical_structure' | 'annotations' | 'alt_text' | 'tables' | 'fonts' | 'bookmarks' | 'reading_order' | 'general'
export type FailureSourceDetail = 'verapdf_family' | 'local_standards_key' | 'acrobat_group' | 'category_score' | 'context_blocker' | 'composite_summary'
export type ToolOpportunityScope = 'document' | 'page' | 'candidate' | 'candidate_group'
export type ToolOpportunityStatus = 'auto_runnable' | 'blocked' | 'deferred' | 'already_attempted' | 'rejected' | 'no_effect'
export type ResidualFamilyEvidenceStrength = number
export type ToolOpportunityStatusReasonCode =
  | 'pipeline_excluded'
  | 'candidate_blocked'
  | 'manual_only_failure_mode'
  | 'already_attempted'
  | 'rejected_before'
  | 'no_effect_before'
  | 'no_active_failure_mode'
  | 'safe_to_run'
  | 'retry_exception'
  | 'deferred_document_scope'

export type RetryDisposition =
  | 'retryable_deterministic'
  | 'stable_hard_fail'
  | 'manual_residual'

export type FailureProfileDominantResidualFamily =
  | ResidualFamilyId
  | 'manual'
  | 'unknown'

export interface ResidualFamilyDecision {
  id: ResidualFamilyId
  label: string
  priority: number
  blocking: boolean
  blockingReason?: string
  convergenceStatus: ResidualFamilyConvergenceStatus
  semanticPolicy: ResidualSemanticPolicy
  failureModeKeys: string[]
  categoryIds: string[]
  preferredTools: RemediationToolName[]
  deprioritizedTools: RemediationToolName[]
  expectedPostconditions: string[]
  activeOpportunityKeys: string[]
  preferredAutoRunnableOpportunityKeys: string[]
  currentStep: number | null
  evidenceSignals: string[]
  evidenceStrength: ResidualFamilyEvidenceStrength
  regressionCanaries: string[]
}

export interface PlannerResidualFamilySummary {
  id: ResidualFamilyId
  label: string
  blocking: boolean
  blockingReason?: string
  convergenceStatus: ResidualFamilyConvergenceStatus
  currentStep: number | null
  preferredAutoRunnableOpportunityKeys?: string[]
  evidenceSignals: string[]
  evidenceStrength: ResidualFamilyEvidenceStrength
}

export interface FailureMode {
  key: string
  label: string
  source: FailureModeSource
  reportingCategory?: FailureReportingCategory
  sourceDetail?: FailureSourceDetail
  derivedFrom?: string[]
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
  statusReasonCode?: ToolOpportunityStatusReasonCode
  statusReasonDetail?: string
  blockedReason?: string
  derivedFromFailureModeKeys: string[]
  familyId?: ResidualFamilyId
  familyStep?: number
  expectedPostconditions?: string[]
}

export type ToolReliabilitySource = 'tool_and_class' | 'tool_global' | 'default'

export interface ToolReliabilitySummary {
  toolName: RemediationToolName
  pdfClass: 'scanned' | 'native_tagged' | 'partially_tagged' | 'untagged_digital' | 'form_heavy'
  attempts: number
  successes: number
  reliability: number
  source: ToolReliabilitySource
}

export type PlaybookPdfClass = 'tagged' | 'partially_tagged' | 'untagged' | 'scanned'
export type PlaybookStatus = 'candidate' | 'validated' | 'hardened' | 'deprecated'
export type PlaybookPageCountRange = 'small' | 'medium' | 'large'
export type PlaybookRunOutcome = 'pending' | 'succeeded' | 'failed'
export type PdfStructuralClass = 'scanned' | 'untagged_digital' | 'partially_tagged' | 'native_tagged' | 'well_tagged'
export type PdfTextDensity = 'none' | 'sparse' | 'normal' | 'dense'
export type PdfAuthoringTool =
  | 'microsoft_word'
  | 'adobe_indesign'
  | 'adobe_acrobat'
  | 'libreoffice'
  | 'latex'
  | 'chrome_print'
  | 'scanner'
  | 'crystal_reports'
  | 'government_cms'
  | 'unknown'
export type PdfFontProfile = 'clean' | 'needs_embedding' | 'legacy_encoding' | 'needs_substitution' | 'no_fonts'
export type PdfScale = 'tiny' | 'small' | 'medium' | 'large' | 'massive'
export type PdfRemediationDepth = 'polish' | 'moderate' | 'major' | 'rebuild'
export type SemanticStrategy = 'full_ai' | 'heuristic_only' | 'skip'

export interface PdfClassification {
  structuralClass: PdfStructuralClass
  contentProfile: {
    textDensity: PdfTextDensity
    hasImages: boolean
    hasComplexTables: boolean
    hasSimpleTables: boolean
    hasForms: boolean
    hasLinks: boolean
    hasFootnotes: boolean
  }
  authoringTool: PdfAuthoringTool
  fontProfile: PdfFontProfile
  scale: PdfScale
  remediationDepth: PdfRemediationDepth
}

export interface PipelineConfig {
  stages: {
    metadata: boolean
    structureBootstrap: boolean
    linkStructure: boolean
    fonts: boolean
    nativeStructure: boolean
    safeCandidates: boolean
  }
  excludedTools: RemediationToolName[]
  maxRounds: number
  earlyExitScore: number
  semanticStrategy: SemanticStrategy
}

export interface FailureSignature {
  failureModeKeys: string[]
  pdfClass: PlaybookPdfClass
  hash: string
  residualFamilyIds?: ResidualFamilyId[]
}

export interface PlaybookStep {
  tool: RemediationToolName
  scope: ToolOpportunityScope
  stage: number
  familyId?: ResidualFamilyId
  familyStep?: number
  postconditionStatus?: FamilyPostconditionStatus
}

export interface PlaybookEntry {
  id: string
  failureSignatureHash: string
  failureModeKeys: string[]
  pdfClass: PlaybookPdfClass
  toolSequence: PlaybookStep[]
  hasImages: boolean
  hasForms: boolean
  hasTables: boolean
  pageCountRange: PlaybookPageCountRange
  initialScore: number
  finalScore: number
  successCount: number
  failureCount: number
  totalAttempts: number
  avgRounds: number
  status: PlaybookStatus
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

export interface PlaybookRun {
  id: string
  playbookId: string
  failureSignatureHash: string
  pdfClass: PlaybookPdfClass
  matchedExact: boolean
  outcome: PlaybookRunOutcome
  initialScore: number
  finalScore: number | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface PlannerEvidenceSummary {
  topFailureModeKeys: string[]
  topResidualFamilyIds?: ResidualFamilyId[]
  topBlockingResidualFamilyIds?: ResidualFamilyId[]
  topResidualFamilySummaries?: PlannerResidualFamilySummary[]
  topAutoRunnableOpportunityKeys: string[]
  skippedReasonCounts: Array<{ reason: string; count: number }>
  attemptedKeys: string[]
  rejectedKeys: string[]
  noEffectKeys: string[]
  attemptedOpportunityKeys?: string[]
  rejectedOpportunityKeys?: string[]
  noEffectOpportunityKeys?: string[]
  statusCounts?: Array<{ status: ToolOpportunityStatus; count: number }>
  reasonCodeCounts?: Array<{ reasonCode: ToolOpportunityStatusReasonCode; count: number }>
  topBlockingFailureModeKeys?: string[]
  topManualOnlyFailureModeKeys?: string[]
  safeToRetry?: boolean
  dominantResidualFamily?: FailureProfileDominantResidualFamily
  lastStableNoEffectTool?: RemediationToolName | null
  retryDisposition?: RetryDisposition
  mixedFamilyConvergencePath?: boolean
  tailSignature?: string
  tailFamilies?: string[]
  nearPassTailEligible?: boolean
  specializedTailMode?: 'figure_tail' | 'font_tail' | 'annotation_table_tail' | 'figure_structure_tail' | 'none'
  specializedTailAttempted?: boolean
  specializedTailImproved?: boolean
}

export interface FailureProfile {
  version: '1' | '2'
  generatedAt: string
  analysisGrade: string
  analysisScore: number
  veraPdfStatus: VeraPdfSummary['status']
  veraPdfFailedChecks: number
  adobeStatus?: AdobeSummary['status']
  adobeIssueCount?: number
  failureModes: FailureMode[]
  residualFamilies: ResidualFamilyDecision[]
  toolOpportunities: ToolOpportunity[]
  summary: {
    deterministicIssueCount: number
    semanticIssueCount: number
    manualOnlyIssueCount: number
    blockedOpportunityCount: number
    autoRunnableOpportunityCount: number
    safeToRetry: boolean
    dominantResidualFamily: FailureProfileDominantResidualFamily
    lastStableNoEffectTool: RemediationToolName | null
    retryDisposition: RetryDisposition
    mixedFamilyConvergencePath: boolean
    tailSignature: string
    tailFamilies: string[]
    nearPassTailEligible: boolean
    specializedTailMode: 'figure_tail' | 'font_tail' | 'annotation_table_tail' | 'figure_structure_tail' | 'none'
    specializedTailAttempted?: boolean
    specializedTailImproved?: boolean
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
    adobe?: AdobeSummary | null
  } | null
  originalVeraPdf?: VeraPdfSummary | null
  remediatedVeraPdf?: VeraPdfSummary | null
  originalAdobe?: AdobeSummary | null
  remediatedAdobe?: AdobeSummary | null
  failureProfile?: FailureProfile | null
  plannerEvidence?: PlannerEvidenceSummary | null
  classification?: PdfClassification | null
  pipelineConfig?: {
    stagesRun: number[]
    excludedToolCount: number
    maxRounds: number
    earlyExitScore: number
    semanticStrategy: SemanticStrategy
    structuralClass: PdfStructuralClass
    authoringTool: PdfAuthoringTool
    fontProfile: PdfFontProfile
  } | null
  remediationMetrics?: {
    inspections: {
      lightFresh: number
      lightReused: number
      deepFresh: number
      deepReused: number
      deepDowngradedToLight: number
    }
    phases: {
      ownershipState: {
        initialRiskCount: number
        finalRiskCount: number
        freshDeepInspections: number
        reusedInspections: number
        downgradedToLight: boolean
        lateConverged?: boolean
      }
      figureDescriptionState: {
        initialMissingAltCount: number
        finalMissingAltCount: number
        initialDecorativeFigureCount: number
        finalDecorativeFigureCount: number
        freshDeepInspections: number
        reusedInspections: number
        downgradedToLight: boolean
        lateConverged?: boolean
        focusedRescueRan?: boolean
        focusedRescueSkippedBecauseLateConverged?: boolean
        finalStopReason?:
          | 'no_mutation'
          | 'no_debt_reduction'
          | 'same_blocking_keys'
          | 'budget_exhausted'
          | 'completed'
          | 'figure_tail_plateau'
      }
      structureState: {
        freshDeepAnalyses: number
        downgradedDeepAnalyses: number
        finalBlockingKeys: string[]
        lateConverged?: boolean
        finalStopReason?:
          | 'same_family_no_progress'
          | 'no_mutation'
          | 'family_shifted'
          | 'budget_exhausted'
          | 'completed'
          | 'structure_debt_cleared_figure_debt_remaining'
          | 'figure_debt_cleared_structure_debt_remaining'
          | 'mixed_figure_structure_separation_required'
          | 'mixed_runtime_churn_without_family_shrink'
          | 'mixed_large_runtime_profile_requires_serial_terminalization'
          | 'tail_signature_plateau_after_specialized_rescue'
          | 'figure_tail_plateau'
          | 'annotation_table_tail_plateau'
      }
    }
    residualCleanup?: {
      dominantFamily?: 'structure' | 'figure' | 'mixed' | 'unknown'
      finalStopReason?:
        | 'same_family_no_progress'
        | 'no_mutation'
        | 'family_shifted'
        | 'budget_exhausted'
        | 'completed'
        | 'structure_debt_cleared_figure_debt_remaining'
        | 'figure_debt_cleared_structure_debt_remaining'
        | 'mixed_figure_structure_separation_required'
        | 'mixed_runtime_churn_without_family_shrink'
        | 'mixed_large_runtime_profile_requires_serial_terminalization'
        | 'tail_signature_plateau_after_specialized_rescue'
        | 'font_tail_plateau'
        | 'figure_tail_plateau'
        | 'annotation_table_tail_plateau'
    }
    providerRouting?: {
      byEndpointLabel: Record<string, number>
      byService: Record<string, number>
      livenessBypassCount: number
    }
    runtimeSummary?: {
      lightInspectionCount?: number
      deepInspectionCount?: number
      semanticCallCount?: number
      providerCallCount?: number
      focusedRescuePassCount?: number
      mixedRuntimeGovernorFired?: boolean
      compactFinalRescueFallback?: boolean
      authoritativeFinalScoringReached?: boolean
      safeToRetry?: boolean
      dominantResidualFamily?: FailureProfileDominantResidualFamily
      lastStableNoEffectTool?: RemediationToolName | null
      retryDisposition?: RetryDisposition
      specializedTailMode?: 'figure_tail' | 'font_tail' | 'annotation_table_tail' | 'figure_structure_tail' | 'none'
      specializedTailAttempted?: boolean
      specializedTailImproved?: boolean
    }
  } | null
  promotionGate?: PromotionGateResult | null
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
