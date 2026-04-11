import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { analyzePDF } from '../apps/api/src/services/pdfAnalyzer.ts'
import { remediatePdfWithAgent } from '../apps/api/src/services/agentRemediationService.ts'
import type { DocumentModel } from '../apps/api/src/services/documentModel.ts'

type BenchmarkCase = {
  name: string
  filePath: string
  category: 'ownership' | 'figure_description' | 'structure' | 'long_report'
}

type BenchmarkOutcome = {
  name: string
  filePath: string
  category: BenchmarkCase['category']
  ok: boolean
  durationMs: number
  terminalState: 'pass' | 'hard_fail' | 'processing_error'
  initial: {
    overallScore: number
    grade: string
    blockingLocalFindingKeys: string[]
  }
  final: {
    overallScore: number
    grade: string
    blockingLocalFindingKeys: string[]
    remediationMetrics: DocumentModel['remediationMetrics']
    inspectionProfile: {
      pattern: 'deep_only' | 'light_only' | 'mixed' | 'unknown'
      dominantPhase: 'ownership' | 'figure_description' | 'structure' | 'mixed' | 'unknown'
      deepDowngradedToLight: boolean
    }
  } | null
  figurePhaseDiagnostic: {
    focusedRescueRan: boolean
    skippedBecauseLateConverged: boolean
    finalStopReason: 'no_mutation' | 'no_debt_reduction' | 'same_blocking_keys' | 'budget_exhausted' | 'completed' | 'figure_tail_plateau' | null
  } | null
  residualCleanupDiagnostic: {
    dominantFamily: 'structure' | 'figure' | 'mixed' | 'unknown'
    finalStopReason:
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
      | null
  } | null
  error?: {
    code: string | null
    message: string
  }
}

type BenchmarkSummary = {
  startedAt: string
  generatedAt: string
  status: 'running' | 'completed' | 'crashed'
  fatalError: {
    message: string
  } | null
  totals: {
    cases: number
    completed: number
    remaining: number
    pass: number
    hardFail: number
    processingError: number
  }
  byInspectionPattern: {
    deep_only: number
    light_only: number
    mixed: number
    unknown: number
    generic_timeout_wording: number
  }
  byDominantPhase: {
    ownership: number
    figure_description: number
    structure: number
    mixed: number
    unknown: number
  }
  stopReasonSignals: {
    budgetExhausted: number
    sameFamilyNoProgress: number
    lateFigureDeferral: number
    boundedRuntimeRetry: number
  }
  latestCompletedCase: {
    name: string
    category: BenchmarkCase['category']
    terminalState: BenchmarkOutcome['terminalState']
    durationMs: number
  } | null
  outcomes: BenchmarkOutcome[]
}

function inspectionPatternFromMetrics(metrics: DocumentModel['remediationMetrics'] | null | undefined): 'deep_only' | 'light_only' | 'mixed' | 'unknown' {
  if (!metrics) return 'unknown'
  const deep = (metrics.inspections.deepFresh || 0) + (metrics.inspections.deepReused || 0)
  const light = (metrics.inspections.lightFresh || 0) + (metrics.inspections.lightReused || 0)
  if (deep > 0 && light === 0) return 'deep_only'
  if (light > 0 && deep === 0) return 'light_only'
  if (light > 0 && deep > 0) return 'mixed'
  return 'unknown'
}

function dominantPhaseFromMetrics(metrics: DocumentModel['remediationMetrics'] | null | undefined): 'ownership' | 'figure_description' | 'structure' | 'mixed' | 'unknown' {
  if (!metrics) return 'unknown'
  const ownership = (metrics.phases.ownershipState.freshDeepInspections || 0) + (metrics.phases.ownershipState.reusedInspections || 0)
  const figure = (metrics.phases.figureDescriptionState.freshDeepInspections || 0) + (metrics.phases.figureDescriptionState.reusedInspections || 0)
  const structure = (metrics.phases.structureState.freshDeepAnalyses || 0)
  const ranked = [
    ['ownership', ownership],
    ['figure_description', figure],
    ['structure', structure],
  ] as const
  const max = Math.max(...ranked.map(([, value]) => value))
  if (max <= 0) return 'unknown'
  const leaders = ranked.filter(([, value]) => value === max)
  if (leaders.length > 1) return 'mixed'
  return leaders[0][0]
}

export function deriveFigurePhaseDiagnostic(input: {
  remediationMetrics: DocumentModel['remediationMetrics'] | null | undefined
  errorMessage?: string | null
}): BenchmarkOutcome['figurePhaseDiagnostic'] {
  const figureState = input.remediationMetrics?.phases.figureDescriptionState
  if (figureState) {
    return {
      focusedRescueRan: !!figureState.focusedRescueRan,
      skippedBecauseLateConverged: !!figureState.focusedRescueSkippedBecauseLateConverged,
      finalStopReason: figureState.finalStopReason || null,
    }
  }
  if (input.errorMessage && /inspection budget exceeded/i.test(input.errorMessage)) {
    return {
      focusedRescueRan: false,
      skippedBecauseLateConverged: false,
      finalStopReason: 'budget_exhausted',
    }
  }
  return null
}

export function deriveResidualCleanupDiagnostic(input: {
  remediationMetrics: DocumentModel['remediationMetrics'] | null | undefined
  errorMessage?: string | null
}): BenchmarkOutcome['residualCleanupDiagnostic'] {
  const structureState = input.remediationMetrics?.phases.structureState
  const residualCleanup = input.remediationMetrics?.residualCleanup
  if (residualCleanup || structureState?.finalStopReason) {
    return {
      dominantFamily: residualCleanup?.dominantFamily || (structureState?.finalBlockingKeys?.length ? 'structure' : 'unknown'),
      finalStopReason: residualCleanup?.finalStopReason || structureState?.finalStopReason || null,
    }
  }
  if (input.errorMessage && /inspection budget exceeded/i.test(input.errorMessage)) {
    return {
      dominantFamily: 'unknown',
      finalStopReason: 'budget_exhausted',
    }
  }
  return null
}

function stopReasonSignals(outcomes: BenchmarkOutcome[]): BenchmarkSummary['stopReasonSignals'] {
  return {
    budgetExhausted: outcomes.filter(entry =>
      entry.figurePhaseDiagnostic?.finalStopReason === 'budget_exhausted'
      || entry.residualCleanupDiagnostic?.finalStopReason === 'budget_exhausted',
    ).length,
    sameFamilyNoProgress: outcomes.filter(entry =>
      entry.residualCleanupDiagnostic?.finalStopReason === 'same_family_no_progress',
    ).length,
    lateFigureDeferral: outcomes.filter(entry =>
      !!entry.figurePhaseDiagnostic?.skippedBecauseLateConverged,
    ).length,
    boundedRuntimeRetry: outcomes.filter(entry =>
      entry.terminalState === 'processing_error'
      && entry.figurePhaseDiagnostic?.finalStopReason !== 'budget_exhausted'
      && entry.residualCleanupDiagnostic?.finalStopReason !== 'budget_exhausted',
    ).length,
  }
}

const repoRoot = '/home/hendo420/pdfaf'
const icjiaRoot = path.join(repoRoot, 'ICJIA-PDFs')
const outputPath = process.env.ICJIA_REMEDIATION_BENCHMARK_SUMMARY_PATH
  || path.join(icjiaRoot, 'manifests', 'remediation-regression-benchmark.summary.json')
const artifactsRoot = process.env.ICJIA_REMEDIATION_BENCHMARK_ARTIFACTS_ROOT
  || path.join(icjiaRoot, 'artifacts', 'remediation-regression-benchmark')

const benchmarkCases: BenchmarkCase[] = [
  {
    name: 'Kendall County Profile',
    filePath: path.join(icjiaRoot, 'backups', 'server-cache', '143.244.146.43', 'icjia', 'pdf', 'CountyProfiles', 'Kendall.pdf'),
    category: 'ownership',
  },
  {
    name: 'CSEC 2008 Research Bulletin',
    filePath: path.join(icjiaRoot, 'backups', 'server-cache', '143.244.146.43', 'icjia', 'pdf', 'Bulletins', 'CSEC 2008 Research Bulletin.pdf'),
    category: 'figure_description',
  },
  {
    name: 'Court System Get The Facts',
    filePath: path.join(icjiaRoot, 'backups', 'server-cache', '143.244.146.43', 'icjia', 'pdf', 'GetTheFacts', 'GTF_CourtSystem.pdf'),
    category: 'structure',
  },
  {
    name: 'SFY24 ICJIA Annual Report',
    filePath: path.join(icjiaRoot, 'backups', 'server-cache', '192.241.146.85', 'SFY_24_ICJIA_Annual_Report_FINAL_2538a182e5_1731f93851.pdf'),
    category: 'long_report',
  },
  {
    name: 'Criminal Sentencing Layout',
    filePath: path.join(icjiaRoot, 'backups', 'server-cache', '143.244.146.43', 'icjia', 'pdf', 'GetTheFacts', 'CrimSentencLayout.pdf'),
    category: 'structure',
  },
]

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readExistingSummary(filePath: string): BenchmarkSummary | null {
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as BenchmarkSummary
  } catch {
    return null
  }
}

function buildSummary(input: {
  startedAt: string
  status: BenchmarkSummary['status']
  outcomes: BenchmarkOutcome[]
  fatalError?: string | null
}): BenchmarkSummary {
  const outcomes = input.outcomes
  return {
    startedAt: input.startedAt,
    generatedAt: new Date().toISOString(),
    status: input.status,
    fatalError: input.fatalError ? { message: input.fatalError } : null,
    totals: {
      cases: benchmarkCases.length,
      completed: outcomes.length,
      remaining: Math.max(0, benchmarkCases.length - outcomes.length),
      pass: outcomes.filter(entry => entry.terminalState === 'pass').length,
      hardFail: outcomes.filter(entry => entry.terminalState === 'hard_fail').length,
      processingError: outcomes.filter(entry => entry.terminalState === 'processing_error').length,
    },
    byInspectionPattern: {
      deep_only: outcomes.filter(entry => entry.final?.inspectionProfile.pattern === 'deep_only').length,
      light_only: outcomes.filter(entry => entry.final?.inspectionProfile.pattern === 'light_only').length,
      mixed: outcomes.filter(entry => entry.final?.inspectionProfile.pattern === 'mixed').length,
      unknown: outcomes.filter(entry => entry.final?.inspectionProfile.pattern === 'unknown').length,
      generic_timeout_wording: outcomes.filter(entry =>
        entry.error?.message
        && /runtime limit/i.test(entry.error.message)
        && !/inspection budget exceeded/i.test(entry.error.message),
      ).length,
    },
    byDominantPhase: {
      ownership: outcomes.filter(entry => entry.final?.inspectionProfile.dominantPhase === 'ownership').length,
      figure_description: outcomes.filter(entry => entry.final?.inspectionProfile.dominantPhase === 'figure_description').length,
      structure: outcomes.filter(entry => entry.final?.inspectionProfile.dominantPhase === 'structure').length,
      mixed: outcomes.filter(entry => entry.final?.inspectionProfile.dominantPhase === 'mixed').length,
      unknown: outcomes.filter(entry => entry.final?.inspectionProfile.dominantPhase === 'unknown').length,
    },
    stopReasonSignals: stopReasonSignals(outcomes),
    latestCompletedCase: outcomes.length > 0
      ? {
          name: outcomes[outcomes.length - 1].name,
          category: outcomes[outcomes.length - 1].category,
          terminalState: outcomes[outcomes.length - 1].terminalState,
          durationMs: outcomes[outcomes.length - 1].durationMs,
        }
      : null,
    outcomes,
  }
}

function writeSummary(filePath: string, summary: BenchmarkSummary): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(summary, null, 2) + '\n')
}

function blockingKeys(result: Awaited<ReturnType<typeof analyzePDF>>): string[] {
  return (result.localStandards?.findings ?? [])
    .filter(finding => finding.blocking)
    .map(finding => finding.key)
    .sort((a, b) => a.localeCompare(b))
}

async function runCase(entry: BenchmarkCase): Promise<BenchmarkOutcome> {
  const buffer = await fs.promises.readFile(entry.filePath)
  const initial = await analyzePDF(buffer, path.basename(entry.filePath), {
    analysisProfile: 'full_final',
    skipAdobe: true,
    skipVeraPdf: true,
  })
  const startedAt = Date.now()
  try {
    const caseArtifactsDir = path.join(artifactsRoot, entry.category, entry.name.replace(/[^A-Za-z0-9._-]+/g, '_'))
    ensureDir(caseArtifactsDir)
    const remediation = await remediatePdfWithAgent(buffer, path.basename(entry.filePath), initial, {
      artifactsDir: caseArtifactsDir,
    })
    const passed = remediation.finalResult.grade === 'A'
      && remediation.finalResult.overallScore === 100
      && blockingKeys(remediation.finalResult).length === 0
    return {
      name: entry.name,
      filePath: entry.filePath,
      category: entry.category,
      ok: true,
      durationMs: Date.now() - startedAt,
      terminalState: passed ? 'pass' : 'hard_fail',
      initial: {
        overallScore: initial.overallScore,
        grade: initial.grade,
        blockingLocalFindingKeys: blockingKeys(initial),
      },
      final: {
        overallScore: remediation.finalResult.overallScore,
        grade: remediation.finalResult.grade,
        blockingLocalFindingKeys: blockingKeys(remediation.finalResult),
        remediationMetrics: remediation.model.remediationMetrics || null,
        inspectionProfile: {
          pattern: inspectionPatternFromMetrics(remediation.model.remediationMetrics || null),
          dominantPhase: dominantPhaseFromMetrics(remediation.model.remediationMetrics || null),
          deepDowngradedToLight: !!remediation.model.remediationMetrics?.inspections.deepDowngradedToLight,
        },
      },
      figurePhaseDiagnostic: deriveFigurePhaseDiagnostic({
        remediationMetrics: remediation.model.remediationMetrics || null,
      }),
      residualCleanupDiagnostic: deriveResidualCleanupDiagnostic({
        remediationMetrics: remediation.model.remediationMetrics || null,
      }),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      name: entry.name,
      filePath: entry.filePath,
      category: entry.category,
      ok: false,
      durationMs: Date.now() - startedAt,
      terminalState: 'processing_error',
      initial: {
        overallScore: initial.overallScore,
        grade: initial.grade,
        blockingLocalFindingKeys: blockingKeys(initial),
      },
      final: null,
      figurePhaseDiagnostic: deriveFigurePhaseDiagnostic({
        remediationMetrics: null,
        errorMessage: message,
      }),
      residualCleanupDiagnostic: deriveResidualCleanupDiagnostic({
        remediationMetrics: null,
        errorMessage: message,
      }),
      error: {
        code: error && typeof error === 'object' && 'code' in error ? String((error as any).code || '') || null : null,
        message,
      },
    }
  }
}

async function main(): Promise<void> {
  ensureDir(path.dirname(outputPath))
  ensureDir(artifactsRoot)
  const existingSummary = readExistingSummary(outputPath)
  const startedAt = existingSummary?.startedAt || new Date().toISOString()
  const outcomes: BenchmarkOutcome[] = existingSummary?.outcomes || []
  const completedKeys = new Set(outcomes.map(entry => `${entry.category}:${entry.name}:${entry.filePath}`))

  writeSummary(outputPath, buildSummary({
    startedAt,
    status: 'running',
    outcomes,
  }))

  for (const entry of benchmarkCases) {
    const caseKey = `${entry.category}:${entry.name}:${entry.filePath}`
    if (completedKeys.has(caseKey)) continue
    const outcome = await runCase(entry)
    outcomes.push(outcome)
    completedKeys.add(caseKey)
    writeSummary(outputPath, buildSummary({
      startedAt,
      status: 'running',
      outcomes,
    }))
  }
  const summary = buildSummary({
    startedAt,
    status: 'completed',
    outcomes,
  })
  writeSummary(outputPath, summary)
  console.log(JSON.stringify(summary, null, 2))
}

const directEntryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null
if (directEntryHref && import.meta.url === directEntryHref) {
  main().catch(error => {
    const existingSummary = readExistingSummary(outputPath)
    const startedAt = existingSummary?.startedAt || new Date().toISOString()
    const outcomes = existingSummary?.outcomes || []
    writeSummary(outputPath, buildSummary({
      startedAt,
      status: 'crashed',
      outcomes,
      fatalError: error instanceof Error ? error.stack || error.message : String(error),
    }))
    console.error(error)
    process.exitCode = 1
  })
}
