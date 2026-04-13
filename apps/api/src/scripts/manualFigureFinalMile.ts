import fs from 'node:fs/promises'
import syncFs from 'node:fs'
import path from 'node:path'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import {
  executeRemediationTool,
  inspectPdfForRemediation,
} from '../services/pdfRemediationTools.js'
import { heuristicFigureAltText } from '../services/remediationCallDerivationService.js'
import type { RemediationActionRecord } from '../services/documentModel.js'
import { evaluatePromotionGate } from '../services/promotionGate.js'
import {
  summarizeManualWorklistOutcomes,
  type ManualWorklistDocument,
  type ManualWorklistOutcomeDocument,
  type ManualWorklistOutcomeRecord,
  type ManualWorklistResolutionReason,
  type ManualWorklistStatus,
} from '../services/manualWorklist.js'

interface StepSummary {
  step: string
  score: number
  grade: string
  blockingFindingKeys: string[]
  figureCandidates: number
  altRiskNodes: number
  nestedAltNodes: number
  missingAltNodes: number
}

function repoRoot() {
  return path.resolve(process.cwd(), '../..')
}

function sanitizeFilename(input: string) {
  return input.replace(/[^A-Za-z0-9._-]+/g, '_')
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

async function writeJson(filePath: string, value: unknown) {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function findPdfByPublicationId(root: string, publicationId: string): Promise<string | null> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = await findPdfByPublicationId(fullPath, publicationId)
      if (nested) return nested
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.pdf')) continue
    if (entry.name.startsWith(`${publicationId}-`)) files.push(fullPath)
  }
  const preferredRoots = [
    `${path.sep}medium-figure-conversion${path.sep}`,
    `${path.sep}small-fast-pass${path.sep}`,
    `${path.sep}stage4-structure-wave${path.sep}`,
    `${path.sep}stage3-figure-wave${path.sep}`,
  ]
  for (const preferred of preferredRoots) {
    const hit = files.find(file => file.includes(preferred))
    if (hit) return hit
  }
  return files[0] || null
}

function summarizeStep(step: string, analysis: any, context: any): StepSummary {
  const findings = analysis.localStandards?.findings ?? []
  const riskNodes = context.structure?.acrobatAltRiskNodes || context.acrobatAltRiskNodes || []
  return {
    step,
    score: analysis.overallScore,
    grade: analysis.grade,
    blockingFindingKeys: findings.filter((finding: any) => finding.blocking).map((finding: any) => finding.key),
    figureCandidates: context.figureCandidates?.length || 0,
    altRiskNodes: riskNodes.length,
    nestedAltNodes: riskNodes.filter((node: any) => node.ownershipMode === 'nested_alt_text_hides_content').length,
    missingAltNodes: riskNodes.filter((node: any) => String(node.ownershipMode || '').includes('untagged') || !node.hasAlt).length,
  }
}

async function applyDocumentTool(
  buffer: Buffer,
  context: any,
  toolName: 'repair_native_figure_semantics' | 'repair_other_elements_alt_text',
): Promise<{ buffer: Buffer; action: RemediationActionRecord }> {
  const result = await executeRemediationTool({
    buffer,
    context,
    call: {
      tool_name: toolName,
      arguments: { target: 'document' },
      rationale: 'Manual figure-final-mile local repair.',
      confidence: 0.95,
    },
  })
  return { buffer: result.buffer, action: result.action }
}

async function applyCandidateTool(
  buffer: Buffer,
  context: any,
  candidate: any,
): Promise<{ buffer: Buffer; action: RemediationActionRecord } | null> {
  const toolName = candidate.informativeHint === 'decorative'
    ? 'mark_figure_decorative'
    : (candidate.repairMode === 'retag_then_set_alt' ? 'retag_as_figure_and_set_alt' : 'set_figure_alt_text')
  const result = await executeRemediationTool({
    buffer,
    context,
    call: {
      tool_name: toolName,
      arguments: {
        candidateId: candidate.id,
        altText: toolName === 'mark_figure_decorative' ? 'Decorative image' : heuristicFigureAltText(candidate.id, context),
        generationSource: 'heuristic_fallback',
      },
      rationale: 'Manual figure-final-mile local candidate repair.',
      confidence: 0.9,
    },
  })
  return { buffer: result.buffer, action: result.action }
}

async function main() {
  const publicationId = process.argv[2]
  if (!publicationId) {
    throw new Error('Usage: pnpm --filter api exec tsx src/scripts/manualFigureFinalMile.ts <publicationId>')
  }

  const root = repoRoot()
  const manifestPath = path.join(root, 'ICJIA-PDFs', 'manifests', 'manual-worklist.json')
  const outcomesPath = path.join(root, 'ICJIA-PDFs', 'manifests', 'manual-worklist.outcomes.json')
  const outcomesSummaryPath = path.join(root, 'ICJIA-PDFs', 'manifests', 'manual-worklist.outcomes.summary.json')
  const manifest = await readJson<ManualWorklistDocument>(manifestPath)
  const candidate = manifest.candidates.find(entry => entry.publicationId === publicationId)
  if (!candidate) {
    throw new Error(`Publication ${publicationId} is not in manual-worklist.json`)
  }

  const remediatedRoot = path.join(root, 'ICJIA-PDFs', 'artifacts', 'remediated-pdfs')
  const preferredInput = candidate.bestManualInputPath || await findPdfByPublicationId(remediatedRoot, publicationId)
  const inputPath = preferredInput || candidate.localCachePath
  if (!inputPath) throw new Error(`No local input path found for ${publicationId}`)
  const filename = path.basename(inputPath)
  const publicationTitle = candidate.publicationTitle || `publication-${publicationId}`
  const outputDir = path.join(root, 'ICJIA-PDFs', 'artifacts', 'remediated-pdfs', 'manual-figure-final-mile', candidate.serverHost)
  const reportDir = path.join(root, 'ICJIA-PDFs', 'reports', 'manual-figure-final-mile', candidate.serverHost)
  const stagingDir = path.join(root, 'ICJIA-PDFs', 'staging', 'to-replace', 'manual-worklist', candidate.serverHost)
  await ensureDir(outputDir)
  await ensureDir(reportDir)
  await ensureDir(stagingDir)
  const safeTitle = sanitizeFilename(publicationTitle)
  const outputPath = path.join(outputDir, `${publicationId}-${safeTitle}.pdf`)
  const reportPath = path.join(reportDir, `${publicationId}-${safeTitle}.manual.json`)
  const stagedReplacementPath = path.join(stagingDir, `${publicationId}-${safeTitle}.pdf`)

  const existingOutcomeDoc = syncFs.existsSync(outcomesPath)
    ? await readJson<ManualWorklistOutcomeDocument>(outcomesPath)
    : { generatedAt: new Date().toISOString(), queueName: 'manual-worklist' as const, outcomes: [] }
  const provisionalRecord: ManualWorklistOutcomeRecord = {
    publicationId,
    publicationTitle: candidate.publicationTitle,
    status: 'manual_in_progress',
    processedAt: new Date().toISOString(),
    inputPath,
    outputPath: null,
    reportPath,
    stagedReplacementPath: null,
    beforeScore: null,
    afterScore: null,
    beforeGrade: null,
    afterGrade: null,
    beforeBlockingFindingKeys: [],
    afterBlockingFindingKeys: [],
    manualResolutionReason: 'manual_object_level_repair_exhausted',
    manualResolutionNotes: 'Manual repair run started.',
    lastValidatedAt: null,
    gate: null,
    original: null,
    final: null,
    artifacts: {
      remediatedPdfPath: null,
      stagedReplacementPath: null,
      detailedReportPath: reportPath,
    },
  }
  const provisionalOutcomes = existingOutcomeDoc.outcomes.filter(outcome => outcome.publicationId !== publicationId)
  provisionalOutcomes.push(provisionalRecord)
  await writeJson(outcomesPath, {
    generatedAt: new Date().toISOString(),
    queueName: 'manual-worklist',
    outcomes: provisionalOutcomes,
  })

  let buffer = Buffer.from(await fs.readFile(inputPath))
  const actions: RemediationActionRecord[] = []
  const steps: StepSummary[] = []

  let analysis = await analyzePDF(buffer, filename, {
    analysisProfile: 'remediation_fast',
    skipAdobe: true,
    skipVeraPdf: true,
  })
  let context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'alt_text_deep' })
  steps.push(summarizeStep('baseline', analysis, context))

  for (const toolName of ['repair_native_figure_semantics', 'repair_other_elements_alt_text'] as const) {
    const result = await applyDocumentTool(buffer, context, toolName)
    buffer = Buffer.from(result.buffer)
    actions.push(result.action)
    analysis = await analyzePDF(buffer, filename, {
      analysisProfile: 'remediation_fast',
      skipAdobe: true,
      skipVeraPdf: true,
    })
    context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'alt_text_deep' })
    steps.push(summarizeStep(toolName, analysis, context))
  }

  const candidateTargets = (context.figureCandidates || []).filter((entry: any) =>
    entry.repairMode === 'set_alt'
    || entry.repairMode === 'retag_then_set_alt'
    || entry.informativeHint === 'decorative',
  )

  for (const figureCandidate of candidateTargets) {
    const refreshedContext = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'alt_text_deep' })
    const refreshedCandidate = (refreshedContext.figureCandidates || []).find((entry: any) => entry.id === figureCandidate.id)
    if (!refreshedCandidate) continue
    const result = await applyCandidateTool(buffer, refreshedContext, refreshedCandidate)
    if (!result) continue
    buffer = Buffer.from(result.buffer)
    actions.push(result.action)
    analysis = await analyzePDF(buffer, filename, {
      analysisProfile: 'remediation_fast',
      skipAdobe: true,
      skipVeraPdf: true,
    })
    context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'alt_text_deep' })
    steps.push(summarizeStep(`candidate:${refreshedCandidate.id}`, analysis, context))
  }

  const finalAnalysis = await analyzePDF(buffer, filename)
  const finalContext = await inspectPdfForRemediation(buffer, finalAnalysis, { inspectMode: 'alt_text_deep' })
  steps.push(summarizeStep('final', finalAnalysis, finalContext))

  const gate = evaluatePromotionGate({
    analysisResult: finalAnalysis,
    criticalManualReviewFlagCodes: [],
  })
  const readyToReplace = gate.passed
  const appliedActionCount = actions.filter(action => action.outcome === 'applied').length
  const manualResolutionReason: ManualWorklistResolutionReason = readyToReplace
    ? 'cleared_final_blockers'
    : finalAnalysis.isScanned
      ? 'manual_scanned_or_source_limited'
      : appliedActionCount > 0
        ? 'manual_object_level_repair_exhausted'
        : finalAnalysis.pageCount >= 100
          ? 'manual_runtime_cost_not_worth_continuing'
          : 'manual_rebuild_required_not_patchable'
  const finalStatus: ManualWorklistStatus = readyToReplace ? 'manual_ready_to_replace' : 'manual_terminalized'

  await fs.writeFile(outputPath, buffer)
  if (readyToReplace) {
    await fs.writeFile(stagedReplacementPath, buffer)
  }
  await fs.writeFile(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    publicationId,
    publicationTitle: candidate.publicationTitle,
    inputPath,
    outputPath,
    steps,
    actions,
    gate,
    finalBlockingFindings: finalAnalysis.localStandards?.findings?.filter((finding: any) => finding.blocking) || [],
  }, null, 2))

  const finalRecord: ManualWorklistOutcomeRecord = {
    publicationId,
    publicationTitle: candidate.publicationTitle,
    status: finalStatus,
    processedAt: new Date().toISOString(),
    inputPath,
    outputPath,
    reportPath,
    stagedReplacementPath: readyToReplace ? stagedReplacementPath : null,
    beforeScore: steps[0]?.score ?? null,
    afterScore: finalAnalysis.overallScore,
    beforeGrade: steps[0]?.grade ?? null,
    afterGrade: finalAnalysis.grade,
    beforeBlockingFindingKeys: steps[0]?.blockingFindingKeys ?? [],
    afterBlockingFindingKeys: gate.blockingLocalFindingKeys,
    manualResolutionReason,
    manualResolutionNotes: readyToReplace
      ? 'Manual figure-final-mile repair cleared the replacement gate.'
      : `Manual figure-final-mile repair stopped with ${gate.blockingLocalFindingKeys.length} blocking finding(s) remaining.`,
    lastValidatedAt: new Date().toISOString(),
    gate: {
      passed: gate.passed,
      blockingLocalFindingKeys: gate.blockingLocalFindingKeys,
      unresolvedCategoryLabels: gate.unresolvedCategoryLabels,
      criticalManualReviewFlagCodes: gate.criticalManualReviewFlagCodes,
      reasons: gate.reasons,
    },
    original: {
      overallScore: steps[0]?.score ?? null,
      grade: steps[0]?.grade ?? null,
    },
    final: {
      overallScore: finalAnalysis.overallScore,
      grade: finalAnalysis.grade,
    },
    artifacts: {
      remediatedPdfPath: outputPath,
      stagedReplacementPath: readyToReplace ? stagedReplacementPath : null,
      detailedReportPath: reportPath,
    },
  }
  const completedOutcomes = provisionalOutcomes.filter(outcome => outcome.publicationId !== publicationId)
  completedOutcomes.push(finalRecord)
  const finalOutcomeDoc: ManualWorklistOutcomeDocument = {
    generatedAt: new Date().toISOString(),
    queueName: 'manual-worklist',
    outcomes: completedOutcomes.sort((left, right) => left.publicationId.localeCompare(right.publicationId)),
  }
  await writeJson(outcomesPath, finalOutcomeDoc)
  await writeJson(outcomesSummaryPath, summarizeManualWorklistOutcomes(finalOutcomeDoc))

  console.log(JSON.stringify({
    publicationId,
    publicationTitle: candidate.publicationTitle,
    inputPath,
    outputPath,
    reportPath,
    status: finalStatus,
    manualResolutionReason,
    stagedReplacementPath: readyToReplace ? stagedReplacementPath : null,
    steps,
    finalBlockingFindingKeys: gate.blockingLocalFindingKeys,
    finalScore: finalAnalysis.overallScore,
    finalGrade: finalAnalysis.grade,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
