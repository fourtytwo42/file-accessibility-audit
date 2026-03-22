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

type LinkFamilyTraceState = LiveResidualFamilyState & {
  topLinkFamily: ResidualFamilyDecision | null
}

type LinkFamilyTraceStepRecord = {
  tool: RemediationToolName
  outcome: RemediationActionRecord['outcome']
  details: string
  blockingFindingKeys: string[]
  convergenceStatus: ResidualFamilyDecision['convergenceStatus'] | 'absent'
  expectedPostconditions?: string[]
  postconditionStatus?: RemediationActionRecord['postconditionStatus']
  postconditionSignals?: string[]
  linkOperationSummary?: RemediationActionRecord['linkOperationSummary']
}

type LinkFamilyTraceReport = {
  path: string
  baseline: LinkFamilyTraceState
  steps: Array<{
    key: string
    action: LinkFamilyTraceStepRecord | null
    state: LinkFamilyTraceState
  }>
}

type LinkFamilyConvergenceArtifact = {
  generatedAt: string
  reports: LinkFamilyTraceReport[]
}

const LINK_TOOLS: RemediationToolName[] = [
  'repair_native_link_structure',
  'tag_unowned_annotations',
  'set_page_tabs',
  'set_link_annotation_contents',
  'normalize_annotation_tab_order',
  'set_tabs_all_annotated_pages',
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
  if (!pdfs.length) {
    throw new Error('At least one --pdf <path> is required.')
  }
  return { pdfs }
}

function summarizeLinkAction(action: RemediationActionRecord, state: LinkFamilyTraceState): LinkFamilyTraceStepRecord {
  return {
    tool: action.tool,
    outcome: action.outcome,
    details: action.details,
    blockingFindingKeys: state.blockingFindingKeys,
    convergenceStatus: state.topLinkFamily?.convergenceStatus || 'absent',
    expectedPostconditions: action.expectedPostconditions,
    postconditionStatus: action.postconditionStatus,
    postconditionSignals: action.postconditionSignals,
    linkOperationSummary: action.linkOperationSummary,
  }
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
}): Promise<LinkFamilyTraceState> {
  const analysis = await analyzePDF(input.buffer, input.filename, {
    analysisProfile: 'remediation_fast',
    skipAdobe: true,
    skipVeraPdf: true,
  })
  const context = await inspectPdfForRemediation(input.buffer, analysis, { inspectMode: 'light' })
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
    topLinkFamily: artifacts.failureProfile.residualFamilies.find(family => family.id === 'link_tabs_and_annotation_cleanup') || null,
  }
}

function buildToolCall(tool: RemediationToolName, family: ResidualFamilyDecision | null): RemediationToolCall {
  return {
    tool_name: tool,
    arguments: { target: 'document' },
    rationale: `Trace deterministic ${tool} for link-family convergence.`,
    confidence: 0.95,
    familyId: family?.id,
    familyStep: family ? Math.max(1, family.preferredTools.indexOf(tool) + 1) : undefined,
    expectedPostconditions: family?.expectedPostconditions,
  }
}

async function tracePdf(pdfPath: string): Promise<LinkFamilyTraceReport> {
  const absolutePath = resolveInputPath(pdfPath)
  const filename = path.basename(absolutePath)
  const initialBuffer = await fs.readFile(absolutePath)
  const manualReviewFlags = (await readManualReviewFlagsIfPresent(absolutePath)) || []

  const trace = await runFamilyConvergenceTrace<LinkFamilyTraceState, LinkFamilyTraceStepRecord>({
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
        familyId: 'link_tabs_and_annotation_cleanup',
        familyStep: LINK_TOOLS.indexOf(action.tool) + 1,
        expectedPostconditions: action.expectedPostconditions,
        postconditionStatus: action.postconditionStatus,
        postconditionSignals: action.postconditionSignals,
        linkOperationSummary: action.linkOperationSummary,
      })),
      manualReviewFlags,
    }),
    steps: LINK_TOOLS.map(tool => ({
      key: tool,
      execute: async ({ buffer, state }) => {
        const analysis = await analyzePDF(buffer, filename, {
          analysisProfile: 'remediation_fast',
          skipAdobe: true,
          skipVeraPdf: true,
        })
        const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
        const result = await executeRemediationTool({
          buffer,
          context,
          call: buildToolCall(tool, state.topLinkFamily),
        })
        return {
          buffer: result.buffer,
          action: summarizeLinkAction(result.action, state),
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
  const reports: LinkFamilyTraceReport[] = []
  for (const pdf of parsed.pdfs) {
    reports.push(await tracePdf(pdf))
  }
  const artifact: LinkFamilyConvergenceArtifact = {
    generatedAt: new Date().toISOString(),
    reports,
  }
  const outputDir = path.join(repoRoot(), 'MitigationAttempts', 'link-family-traces')
  await fs.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${timestampForFilename(new Date())}.link-family-trace.json`)
  await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2), 'utf8')
  console.log(JSON.stringify({
    outputPath: relativeToRepoRoot(outputPath),
    reports: reports.map(report => ({
      pdf: relativeToRepoRoot(report.path),
      baselineBlocker: report.baseline.topBlockingResidualFamilyIds[0] || null,
      finalBlocker: report.steps.at(-1)?.state.topBlockingResidualFamilyIds[0] || report.baseline.topBlockingResidualFamilyIds[0] || null,
    })),
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
