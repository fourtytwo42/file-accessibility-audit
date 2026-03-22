import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  ModelReviewFlag,
  RemediationActionRecord,
  RemediationToolCall,
  RemediationToolName,
  RemediationIteration,
  ResidualFamilyDecision,
} from '../services/documentModel.js'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { buildFailureProfileArtifacts } from '../services/failureProfileService.js'
import { runFamilyConvergenceTrace } from '../services/familyConvergenceService.js'
import type { LiveResidualFamilyState } from '../services/liveResidualFamilyDiagnosisService.js'
import { buildLiveResidualFamilyState } from '../services/liveResidualFamilyDiagnosisService.js'
import { inspectPdfForRemediation, executeRemediationTool } from '../services/pdfRemediationTools.js'

type ParsedArgs = {
  pdfs: string[]
}

type FullAuditTailTraceState = LiveResidualFamilyState & {
  topFigureFamily: ResidualFamilyDecision | null
  topHeadingFamily: ResidualFamilyDecision | null
  topStructureFamily: ResidualFamilyDecision | null
}

type FullAuditTailTraceStepRecord = {
  tool: RemediationToolName
  outcome: RemediationActionRecord['outcome']
  details: string
  selectedFamilyId: ResidualFamilyDecision['id'] | null
  selectedFamilyCurrentStep: number | null
  selectedFamilyActiveOpportunityKeys: string[]
  blockingFindingKeys: string[]
  topBlockingResidualFamilyIds: string[]
  postconditionStatus?: RemediationActionRecord['postconditionStatus']
  postconditionSignals?: string[]
  figureOperationSummary?: {
    operation: string
    figureNodesRetagged: number
    figureAltPreserved: number
    figureAltPlaceholdersCreated: number
    graphicsOnlyOwnersPromoted: number
    mixedOwnersSkipped: number
    unsafeCandidateCount: number
    unresolvedWarningCount: number
  }
}

type FullAuditTailTraceReport = {
  path: string
  baseline: FullAuditTailTraceState
  steps: Array<{
    key: string
    action: FullAuditTailTraceStepRecord | null
    state: FullAuditTailTraceState
  }>
}

type FullAuditTailConvergenceArtifact = {
  generatedAt: string
  reports: FullAuditTailTraceReport[]
}

const FULL_AUDIT_TAIL_TOOLS: RemediationToolName[] = [
  'repair_native_figure_semantics',
  'repair_other_elements_alt_text',
  'artifact_nonsemantic_page_elements',
  'repair_native_marked_content_refs',
  'repair_bootstrapped_chart_content_refs',
  'repair_structure_conformance',
]

function repoRoot(): string {
  return path.resolve(process.cwd(), '../..')
}

function resolveInputPath(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(repoRoot(), inputPath)
}

function relativeToRepoRoot(inputPath: string): string {
  return path.relative(repoRoot(), inputPath) || path.basename(inputPath)
}

function timestampForFilename(input: Date): string {
  return input.toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z')
}

function parseArgs(argv: string[]): ParsedArgs {
  const pdfs: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--pdf') {
      const next = argv[index + 1]
      if (!next) throw new Error('Expected --pdf <path>.')
      pdfs.push(next)
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  if (!pdfs.length) throw new Error('At least one --pdf <path> is required.')
  return { pdfs }
}

async function readManualReviewFlagsIfPresent(pdfPath: string): Promise<ModelReviewFlag[] | undefined> {
  const basename = pdfPath.replace(/\.pdf$/i, '')
  const candidates = [`${basename}.manual-review.json`, `${basename}.model.json`, `${basename}.json`]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidate, 'utf8')) as unknown
      if (Array.isArray(parsed)) return parsed as ModelReviewFlag[]
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { manualReviewFlags?: unknown }).manualReviewFlags)) {
        return (parsed as { manualReviewFlags: ModelReviewFlag[] }).manualReviewFlags
      }
    } catch {
      continue
    }
  }
  return undefined
}

async function buildState(input: {
  buffer: Buffer
  filePath: string
  filename: string
  actions: RemediationActionRecord[]
  manualReviewFlags: ModelReviewFlag[]
  iterations?: RemediationIteration[]
}): Promise<FullAuditTailTraceState> {
  const analysis = await analyzePDF(input.buffer, input.filename, {
    analysisProfile: 'full_final',
    skipAdobe: true,
    skipVeraPdf: true,
  })
  const context = await inspectPdfForRemediation(input.buffer, analysis, { inspectMode: 'alt_text_deep' })
  const artifacts = buildFailureProfileArtifacts({
    analysis,
    context,
    actions: input.actions,
    rejectedActions: [],
    iterations: input.iterations,
  })
  const live = buildLiveResidualFamilyState({
    filePath: input.filePath,
    overallScore: analysis.overallScore,
    grade: analysis.grade,
    failureProfile: artifacts.failureProfile,
    plannerEvidence: artifacts.plannerEvidence,
    manualReviewFlags: input.manualReviewFlags,
  })
  return {
    ...live,
    topFigureFamily: artifacts.failureProfile.residualFamilies.find(family => family.id === 'native_figure_convergence') || null,
    topHeadingFamily: artifacts.failureProfile.residualFamilies.find(family => family.id === 'post_bootstrap_heading_convergence') || null,
    topStructureFamily: artifacts.failureProfile.residualFamilies.find(family => family.id === 'logical_structure_marked_content') || null,
  }
}

function familyForTool(state: FullAuditTailTraceState, tool: RemediationToolName): ResidualFamilyDecision | null {
  if (tool === 'repair_native_figure_semantics' || tool === 'repair_other_elements_alt_text') {
    return state.topFigureFamily
  }
  if (tool === 'artifact_nonsemantic_page_elements') {
    return state.topHeadingFamily || state.topStructureFamily
  }
  return state.topStructureFamily || state.topHeadingFamily
}

function summarizeAction(action: RemediationActionRecord, state: FullAuditTailTraceState): FullAuditTailTraceStepRecord {
  const selectedFamily = familyForTool(state, action.tool)
  return {
    tool: action.tool,
    outcome: action.outcome,
    details: action.details,
    selectedFamilyId: selectedFamily?.id || null,
    selectedFamilyCurrentStep: selectedFamily?.currentStep ?? null,
    selectedFamilyActiveOpportunityKeys: [...(selectedFamily?.activeOpportunityKeys || [])],
    blockingFindingKeys: state.blockingFindingKeys,
    topBlockingResidualFamilyIds: state.topBlockingResidualFamilyIds,
    postconditionStatus: action.postconditionStatus,
    postconditionSignals: action.postconditionSignals,
    figureOperationSummary: (action as RemediationActionRecord & { figureOperationSummary?: FullAuditTailTraceStepRecord['figureOperationSummary'] }).figureOperationSummary,
  }
}

function buildToolCall(tool: RemediationToolName, family: ResidualFamilyDecision | null): RemediationToolCall {
  return {
    tool_name: tool,
    arguments: { target: 'document' },
    rationale: `Trace deterministic ${tool} for full-audit tail convergence.`,
    confidence: 0.95,
    familyId: family?.id,
    familyStep: family ? Math.max(1, family.preferredTools.indexOf(tool) + 1) : undefined,
    expectedPostconditions: family?.expectedPostconditions,
  }
}

async function tracePdf(pdfPath: string): Promise<FullAuditTailTraceReport> {
  const absolutePath = resolveInputPath(pdfPath)
  const filename = path.basename(absolutePath)
  const initialBuffer = await fs.readFile(absolutePath)
  const manualReviewFlags = (await readManualReviewFlagsIfPresent(absolutePath)) || []

  const trace = await runFamilyConvergenceTrace<FullAuditTailTraceState, FullAuditTailTraceStepRecord>({
    initialBuffer,
    summarize: async (buffer, actions) => buildState({
      buffer,
      filePath: absolutePath,
      filename,
      actions: actions.map(action => ({
        tool: action.tool,
        target: 'document',
        details: action.details,
        confidence: 0.95,
        autoApplied: true,
        changedVisibleContent: false,
        changedDocumentBytes: action.outcome === 'applied',
        outcome: action.outcome,
        familyId: action.tool === 'repair_native_figure_semantics' || action.tool === 'repair_other_elements_alt_text'
          ? 'native_figure_convergence'
          : action.tool === 'artifact_nonsemantic_page_elements'
            ? 'post_bootstrap_heading_convergence'
            : 'logical_structure_marked_content',
        expectedPostconditions: [],
        postconditionStatus: action.postconditionStatus,
        postconditionSignals: action.postconditionSignals,
      })),
      manualReviewFlags,
    }),
    steps: FULL_AUDIT_TAIL_TOOLS.map(tool => ({
      key: tool,
      shouldRun: state => {
        const family = familyForTool(state, tool)
        if (!family || !family.blocking) return false
        const matchesTool = (key: string) => key.startsWith(`${tool}:`)
        return family.activeOpportunityKeys.some(matchesTool)
          || family.preferredAutoRunnableOpportunityKeys.some(matchesTool)
      },
      execute: async ({ buffer, state }) => {
        const analysis = await analyzePDF(buffer, filename, {
          analysisProfile: 'full_final',
          skipAdobe: true,
          skipVeraPdf: true,
        })
        const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'alt_text_deep' })
        const result = await executeRemediationTool({
          buffer,
          context,
          call: buildToolCall(tool, familyForTool(state, tool)),
        })
        return {
          buffer: result.buffer,
          action: summarizeAction(result.action, state),
        }
      },
    })),
  })

  return {
    path: absolutePath,
    baseline: trace.baseline,
    steps: trace.steps,
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  const reports: FullAuditTailTraceReport[] = []
  for (const pdf of parsed.pdfs) {
    reports.push(await tracePdf(pdf))
  }

  const artifact: FullAuditTailConvergenceArtifact = {
    generatedAt: new Date().toISOString(),
    reports,
  }
  const outputDir = path.join(repoRoot(), 'MitigationAttempts', 'full-audit-tail-traces')
  await fs.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${timestampForFilename(new Date())}.full-audit-tail-trace.json`)
  await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2), 'utf8')
  console.log(JSON.stringify({
    outputPath: relativeToRepoRoot(outputPath),
    reports: reports.map(report => ({
      pdf: relativeToRepoRoot(report.path),
      baselineBlockers: report.baseline.topBlockingResidualFamilyIds,
      finalBlockers: report.steps.at(-1)?.state.topBlockingResidualFamilyIds || report.baseline.topBlockingResidualFamilyIds,
    })),
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
