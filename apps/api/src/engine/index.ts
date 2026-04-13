/**
 * Stage 7: General PDF Accessibility Engine — Public API
 *
 * Four document-centric functions with no ICJIA-specific assumptions.
 * The ICJIA batch runner is one consumer of this surface, not the surface itself.
 */

import { analyzePDF, type AnalysisResult, type AnalysisProfile } from '../services/pdfAnalyzer.js'
import { remediatePdfWithAgent } from '../services/agentRemediationService.js'
import { evaluatePromotionGate, type PromotionGateResult } from '../services/promotionGate.js'
import type { DocumentModel, ModelReviewFlag, AppliedChange, FailureProfile, PlannerEvidenceSummary } from '../services/documentModel.js'

// ─── Re-exports for callers who only import from this module ─────────────────

export type { AnalysisResult, AnalysisProfile } from '../services/pdfAnalyzer.js'
export type { PromotionGateResult } from '../services/promotionGate.js'

export interface RemediationPolicy {
  visualPreservation?: 'strict'
}

export interface EngineRequestPolicy {
  remediationPolicy?: RemediationPolicy
  artifactRetention?: 'none' | 'summary' | 'debug'
  benchmarkLabel?: string | null
  canaryLabel?: string | null
  maxRuntimeMs?: number | null
}

export interface EngineDiagnostics {
  blockingFindingKeys: string[]
  unresolvedCategories: string[]
  residualFamilySummaries: FailureProfile['residualFamilies'] | null
  safeToRetry: FailureProfile['summary']['safeToRetry'] | null
  dominantResidualFamily: FailureProfile['summary']['dominantResidualFamily'] | null
  lastStableNoEffectTool: FailureProfile['summary']['lastStableNoEffectTool'] | null
  retryDisposition: FailureProfile['summary']['retryDisposition'] | null
  stopReasons: {
    figureDescription: DocumentModel['remediationMetrics'] extends infer T
      ? T extends { phases: { figureDescriptionState: { finalStopReason?: infer R } } } ? R | null : null
      : null
    structure: DocumentModel['remediationMetrics'] extends infer T
      ? T extends { phases: { structureState: { finalStopReason?: infer R } } } ? R | null : null
      : null
    residualCleanup: DocumentModel['remediationMetrics'] extends infer T
      ? T extends { residualCleanup?: { finalStopReason?: infer R } } ? R | null : null
      : null
    figureFamily: FailureProfile['summary']['dominantResidualFamily'] | null
    structureFamily: FailureProfile['summary']['dominantResidualFamily'] | null
    fontFamily: FailureProfile['summary']['dominantResidualFamily'] | null
    runtimeRetryClassification: FailureProfile['summary']['retryDisposition'] | null
  }
  runtimeMetrics: DocumentModel['remediationMetrics'] | null
  artifactPaths: {
    retainedArtifacts: string[]
  }
}

function matchesFamilyGroup(
  familyId: FailureProfile['summary']['dominantResidualFamily'] | null | undefined,
  group: 'figure' | 'structure' | 'font',
): boolean {
  if (!familyId || familyId === 'manual' || familyId === 'unknown') return false
  if (group === 'figure') return /figure|alt|artifact/i.test(familyId)
  if (group === 'structure') return /structure|heading|reading|marked_content|metadata|bookmark|title|language/i.test(familyId)
  return /font|unicode|cid/i.test(familyId)
}

function normalizeRequestPolicy(policy?: EngineRequestPolicy | null): Required<Pick<EngineRequestPolicy, 'artifactRetention'>> & EngineRequestPolicy {
  return {
    remediationPolicy: {
      visualPreservation: policy?.remediationPolicy?.visualPreservation || 'strict',
    },
    artifactRetention: policy?.artifactRetention || 'summary',
    benchmarkLabel: policy?.benchmarkLabel || null,
    canaryLabel: policy?.canaryLabel || null,
    maxRuntimeMs: Number.isFinite(policy?.maxRuntimeMs) ? Number(policy?.maxRuntimeMs) : null,
  }
}

function buildDiagnostics(input: {
  analysis: AnalysisResult
  failureProfile?: FailureProfile | null
  remediationMetrics?: DocumentModel['remediationMetrics'] | null
  artifactPaths?: string[]
  manualReviewFlags?: ModelReviewFlag[] | null
}): EngineDiagnostics {
  const gate = evaluatePromotionGate({
    analysisResult: input.analysis,
    manualReviewFlags: input.manualReviewFlags ?? null,
  })
  return {
    blockingFindingKeys: gate.blockingLocalFindingKeys,
    unresolvedCategories: gate.unresolvedCategoryLabels,
    residualFamilySummaries: input.failureProfile?.residualFamilies ?? null,
    safeToRetry: input.failureProfile?.summary.safeToRetry ?? null,
    dominantResidualFamily: input.failureProfile?.summary.dominantResidualFamily ?? null,
    lastStableNoEffectTool: input.failureProfile?.summary.lastStableNoEffectTool ?? null,
    retryDisposition: input.failureProfile?.summary.retryDisposition ?? null,
    stopReasons: {
      figureDescription: input.remediationMetrics?.phases.figureDescriptionState.finalStopReason || null,
      structure: input.remediationMetrics?.phases.structureState.finalStopReason || null,
      residualCleanup: input.remediationMetrics?.residualCleanup?.finalStopReason || null,
      figureFamily: matchesFamilyGroup(input.failureProfile?.summary.dominantResidualFamily, 'figure')
        ? input.failureProfile?.summary.dominantResidualFamily ?? null
        : null,
      structureFamily: matchesFamilyGroup(input.failureProfile?.summary.dominantResidualFamily, 'structure')
        ? input.failureProfile?.summary.dominantResidualFamily ?? null
        : null,
      fontFamily: matchesFamilyGroup(input.failureProfile?.summary.dominantResidualFamily, 'font')
        ? input.failureProfile?.summary.dominantResidualFamily ?? null
        : null,
      runtimeRetryClassification: input.failureProfile?.summary.retryDisposition ?? null,
    },
    runtimeMetrics: input.remediationMetrics ?? null,
    artifactPaths: {
      retainedArtifacts: input.artifactPaths || [],
    },
  }
}

// ─── analyzePdf ──────────────────────────────────────────────────────────────

/**
 * Grade a PDF for accessibility. Returns scores, categories, local-standards
 * findings, and routing signals. No remediation is attempted.
 */
export async function analyzePdf(
  buffer: Buffer,
  filename: string,
  options?: {
    signal?: AbortSignal
    analysisProfile?: AnalysisProfile
    skipAdobe?: boolean
    skipVeraPdf?: boolean
  } & EngineRequestPolicy,
): Promise<AnalysisResult & { requestPolicy: ReturnType<typeof normalizeRequestPolicy>; diagnostics: EngineDiagnostics }> {
  const result = await analyzePDF(buffer, filename, options)
  const requestPolicy = normalizeRequestPolicy(options)
  return {
    ...result,
    requestPolicy,
    diagnostics: buildDiagnostics({
      analysis: result,
      artifactPaths: [],
    }),
  }
}

// ─── remediatePdf ────────────────────────────────────────────────────────────

export interface RemediationResult {
  /** Remediated PDF bytes. */
  buffer: Buffer
  /** Re-analysis result on the final remediated bytes. */
  finalAnalysis: AnalysisResult
  /** Every mutation the agent applied during the session. */
  appliedActions: AppliedChange[]
  /** Flags that require human review (warnings + critical). */
  manualReviewFlags: ModelReviewFlag[]
  /** Phase-level inspection and convergence counters. */
  remediationMetrics: DocumentModel['remediationMetrics']
  /** Failure profile built from the final analysis (null if agent short-circuited). */
  failureProfile: FailureProfile | null
  /** Planner evidence from the remediation session. */
  plannerEvidence: PlannerEvidenceSummary | null
  /** Post-remediation final audit summary set by the agent on the last round. */
  finalAudit: DocumentModel['finalAudit']
  /** Promotion gate evaluated against the final analysis. */
  promotionGate: PromotionGateResult
  /** Normalized caller policy for this remediation run. */
  requestPolicy: ReturnType<typeof normalizeRequestPolicy>
  /** Standardized diagnostics intended for non-ICJIA callers. */
  diagnostics: EngineDiagnostics
}

/**
 * Attempt to remediate a PDF for accessibility using the AI agent engine.
 * Runs multiple rounds of inspection → repair → re-analysis until the document
 * passes or the agent exhausts its budget.
 *
 * NOTE: This is a long-running synchronous call (seconds to minutes).
 * For production batch use, prefer the queue-based runner in the ICJIA adapter.
 */
export async function remediatePdf(
  buffer: Buffer,
  filename: string,
  analysis: AnalysisResult,
  options?: {
    signal?: AbortSignal
    artifactsDir?: string
    onProgress?: (progress: { stage: string; percent: number }) => void
  } & EngineRequestPolicy,
): Promise<RemediationResult> {
  const result = await remediatePdfWithAgent(buffer, filename, analysis, options)
  const requestPolicy = normalizeRequestPolicy(options)
  const artifactPaths = uniqueArtifactPaths([
    options?.artifactsDir || null,
  ])
  return {
    buffer: result.buffer,
    finalAnalysis: result.finalResult,
    appliedActions: result.model.aiAppliedChanges ?? [],
    manualReviewFlags: result.model.manualReviewFlags ?? [],
    remediationMetrics: result.model.remediationMetrics ?? null,
    failureProfile: result.model.failureProfile ?? null,
    plannerEvidence: result.model.plannerEvidence ?? null,
    finalAudit: result.model.finalAudit ?? null,
    promotionGate: evaluatePromotionGate({
      analysisResult: result.finalResult,
      manualReviewFlags: result.model.manualReviewFlags,
    }),
    requestPolicy,
    diagnostics: buildDiagnostics({
      analysis: result.finalResult,
      failureProfile: result.model.failureProfile ?? null,
      remediationMetrics: result.model.remediationMetrics ?? null,
      artifactPaths,
      manualReviewFlags: result.model.manualReviewFlags ?? null,
    }),
  }
}

// ─── verifyPdf ───────────────────────────────────────────────────────────────

/**
 * Evaluate whether an analysis result clears the promotion gate.
 * Requires grade A + score 100 + no blocking findings (color contrast excepted).
 * Synchronous — pass the result of `analyzePdf` or `remediatePdf.finalAnalysis`.
 */
export function verifyPdf(
  analysis: AnalysisResult,
  options?: { manualReviewFlags?: ModelReviewFlag[] | null } & EngineRequestPolicy,
): PromotionGateResult & { requestPolicy: ReturnType<typeof normalizeRequestPolicy>; diagnostics: EngineDiagnostics } {
  const gate = evaluatePromotionGate({
    analysisResult: analysis,
    manualReviewFlags: options?.manualReviewFlags ?? null,
  })
  return {
    ...gate,
    requestPolicy: normalizeRequestPolicy(options),
    diagnostics: buildDiagnostics({
      analysis,
      manualReviewFlags: options?.manualReviewFlags ?? null,
      artifactPaths: [],
    }),
  }
}

// ─── explainFailure ──────────────────────────────────────────────────────────

export interface ExplainResult {
  grade: string
  score: number
  passed: boolean
  /** Category labels that are below 100 (excluding non-blocking color contrast). */
  unresolvedCategories: string[]
  /** Local-standards finding keys that are blocking promotion. */
  blockingFindings: string[]
  /** Structured failure modes from the remediation session, if available. */
  failureModes: FailureProfile['failureModes'] | null
  /** Planner evidence from the remediation session, if available. */
  plannerEvidence: PlannerEvidenceSummary | null
  /** Human-readable one-line summary. */
  summary: string
  /** Normalized caller policy. */
  requestPolicy: ReturnType<typeof normalizeRequestPolicy>
  /** Standardized diagnostics. */
  diagnostics: EngineDiagnostics
}

function uniqueArtifactPaths(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))))
}

/**
 * Explain why a PDF failed (or confirm it passed).
 *
 * Two paths:
 * - With `model`: extracts `failureProfile` and `plannerEvidence` already set
 *   by `remediatePdf`, giving full per-round planner context.
 * - Without `model`: derives explanation from the analysis result alone —
 *   suitable for a fresh analysis with no prior remediation.
 */
export function explainFailure(
  analysis: AnalysisResult,
  model?: Pick<DocumentModel, 'failureProfile' | 'plannerEvidence' | 'manualReviewFlags'> | null,
  requestPolicy?: EngineRequestPolicy | null,
): ExplainResult {
  const gate = evaluatePromotionGate({
    analysisResult: analysis,
    manualReviewFlags: model?.manualReviewFlags ?? null,
  })

  const blocking = [
    ...gate.unresolvedCategoryLabels,
    ...gate.blockingLocalFindingKeys,
  ]

  return {
    grade: analysis.grade,
    score: analysis.overallScore,
    passed: gate.passed,
    unresolvedCategories: gate.unresolvedCategoryLabels,
    blockingFindings: gate.blockingLocalFindingKeys,
    failureModes: model?.failureProfile?.failureModes ?? null,
    plannerEvidence: model?.plannerEvidence ?? null,
    summary: gate.passed
      ? `Grade ${analysis.grade} — passed all gates.`
      : `Grade ${analysis.grade} (${analysis.overallScore}/100). Blocking: ${blocking.join(', ') || 'none listed'}.`,
    requestPolicy: normalizeRequestPolicy(requestPolicy),
    diagnostics: buildDiagnostics({
      analysis,
      failureProfile: model?.failureProfile ?? null,
      manualReviewFlags: model?.manualReviewFlags ?? null,
      artifactPaths: [],
    }),
  }
}
