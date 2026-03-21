import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PHASE0_VERIFICATION_MANIFEST } from './phase0VerificationManifest.js'

type CompareMode = 'phase0-baseline' | 'phase0-canary' | 'all'

type ArtifactFile = {
  filename: string
  overallScore: number
  grade: string
  false100: boolean
  veraPdf: {
    status: string
    failedChecks: number
  }
  adobe: {
    issueCount: number
    normalizedFailedFamilyCounts: Record<string, number>
  }
  classification: {
    structuralClass: string
  }
  failureProfileKeys: string[]
  plannerOpportunityKeys: string[]
  plannerAutoRunnableKeys: string[]
}

type CanaryEntry = {
  filename: string
  why: string
  expectedSignals: string[]
  structuralClass: string
  verificationLocks?: {
    disallowedAutoRunnableKeys?: string[]
    requiredFailureProfileKeys?: string[]
    requiredPlannerOpportunityKeys?: string[]
    requiredAutoRunnableKeys?: string[]
  }
}

export interface Phase0Artifact {
  generatedAt: string
  corpusName: 'phase0-baseline' | 'phase0-canary'
  summary: {
    fileCount: number
    adobeFailFileCount: number
    false100Count: number
    score100AdobeFailCount: number
    structuralClassCounts: Record<string, number>
    adobeFailedFamilyTotals: Record<string, number>
  }
  canary: {
    entries: CanaryEntry[]
    coverage: {
      structuralClasses: string[]
      missingStructuralClasses: string[]
    }
  }
  files: ArtifactFile[]
}

interface ComparisonIssue {
  key: string
  kind: 'summary' | 'file' | 'canary'
  message: string
  suppressed: boolean
}

interface CompareOptions {
  mode: Exclude<CompareMode, 'all'>
  beforePath: string
  afterPath: string
  allowKnownGaps: string[]
  requiredCanaryStructuralClasses?: string[]
}

function repoRoot(): string {
  return path.resolve(process.cwd(), '../..')
}

function gradeWeight(grade: string): number {
  return ['F', 'D', 'C', 'B', 'A'].indexOf(grade)
}

function adobeFamilyTotal(file: ArtifactFile): number {
  return Object.values(file.adobe.normalizedFailedFamilyCounts || {}).reduce((sum, count) => sum + count, 0)
}

function fileImproved(beforeFile: ArtifactFile, afterFile: ArtifactFile): boolean {
  return afterFile.overallScore > beforeFile.overallScore
    || gradeWeight(afterFile.grade) > gradeWeight(beforeFile.grade)
    || afterFile.adobe.issueCount < beforeFile.adobe.issueCount
    || adobeFamilyTotal(afterFile) < adobeFamilyTotal(beforeFile)
}

function suffixForMode(mode: Exclude<CompareMode, 'all'>): string {
  return mode === 'phase0-baseline' ? '.phase0-baseline.json' : '.phase0-canary.json'
}

async function resolveLatestArtifact(mode: Exclude<CompareMode, 'all'>): Promise<string> {
  const outputDir = path.join(repoRoot(), 'MitigationAttempts', 'phase0-baselines')
  const suffix = suffixForMode(mode)
  const entries = (await fs.readdir(outputDir))
    .filter(name => name.endsWith(suffix))
    .sort()
  const latest = entries.at(-1)
  if (!latest) {
    throw new Error(`No Phase 0 artifact found for ${mode} in ${outputDir}`)
  }
  return path.join(outputDir, latest)
}

async function readArtifact(filePath: string): Promise<Phase0Artifact> {
  const raw = await fs.readFile(filePath, 'utf8')
  return JSON.parse(raw) as Phase0Artifact
}

function compareSetDelta(beforeValues: string[], afterValues: string[]) {
  return {
    removed: beforeValues.filter(value => !afterValues.includes(value)).sort(),
    added: afterValues.filter(value => !beforeValues.includes(value)).sort(),
  }
}

function maybeIssue(input: {
  issues: ComparisonIssue[]
  allowKnownGaps: Set<string>
  key: string
  kind: ComparisonIssue['kind']
  message: string
}) {
  input.issues.push({
    key: input.key,
    kind: input.kind,
    message: input.message,
    suppressed: input.allowKnownGaps.has(input.key),
  })
}

function canarySignalSatisfied(signal: string, file: ArtifactFile): boolean {
  if (signal.startsWith('structural_class.')) {
    return file.classification.structuralClass === signal.replace('structural_class.', '')
  }
  if (signal.startsWith('adobe.')) {
    return (file.adobe.normalizedFailedFamilyCounts?.[signal] || 0) > 0
  }
  if (signal.startsWith('failure_mode.')) {
    return file.failureProfileKeys.includes(signal.replace('failure_mode.', ''))
  }
  if (signal.startsWith('opportunity.')) {
    return file.plannerOpportunityKeys.includes(signal.replace('opportunity.', ''))
  }
  if (signal.startsWith('autoreunnable.')) {
    return file.plannerAutoRunnableKeys.includes(signal.replace('autoreunnable.', ''))
  }
  if (signal.startsWith('regression.')) {
    return true
  }
  return false
}

export function comparePhase0Artifacts(before: Phase0Artifact, after: Phase0Artifact, options: CompareOptions) {
  const allowKnownGaps = new Set(options.allowKnownGaps)
  const issues: ComparisonIssue[] = []
  const beforeByName = new Map(before.files.map(file => [file.filename, file]))
  const afterByName = new Map(after.files.map(file => [file.filename, file]))

  if (after.summary.false100Count > before.summary.false100Count) {
    maybeIssue({
      issues,
      allowKnownGaps,
      key: 'summary.false100Count',
      kind: 'summary',
      message: `False 100 count increased from ${before.summary.false100Count} to ${after.summary.false100Count}.`,
    })
  }

  if (after.summary.adobeFailFileCount > before.summary.adobeFailFileCount) {
    maybeIssue({
      issues,
      allowKnownGaps,
      key: 'summary.adobeFailFileCount',
      kind: 'summary',
      message: `Adobe-fail file count increased from ${before.summary.adobeFailFileCount} to ${after.summary.adobeFailFileCount}.`,
    })
  }

  const groupedDeltas = {
    scoreGrade: [] as Array<{
      filename: string
      beforeScore: number
      afterScore: number
      beforeGrade: string
      afterGrade: string
    }>,
    veraPdf: [] as Array<{
      filename: string
      beforeStatus: string
      afterStatus: string
      beforeFailedChecks: number
      afterFailedChecks: number
    }>,
    adobeFamilies: [] as Array<{
      filename: string
      removed: string[]
      added: string[]
    }>,
    failureProfileKeys: [] as Array<{
      filename: string
      removed: string[]
      added: string[]
    }>,
    plannerAutoRunnableKeys: [] as Array<{
      filename: string
      removed: string[]
      added: string[]
    }>,
    structuralClass: [] as Array<{
      filename: string
      beforeStructuralClass: string
      afterStructuralClass: string
    }>,
    canaryExpectations: [] as Array<{
      filename: string
      expectation: string
      status: 'present' | 'improved_away' | 'missing'
    }>,
  }

  for (const [filename, beforeFile] of beforeByName.entries()) {
    const afterFile = afterByName.get(filename)
    if (!afterFile) {
      maybeIssue({
        issues,
        allowKnownGaps,
        key: `file:${filename}:missing_after`,
        kind: 'file',
        message: `${filename} is missing from the after artifact.`,
      })
      continue
    }

    if (beforeFile.overallScore !== afterFile.overallScore || beforeFile.grade !== afterFile.grade) {
      groupedDeltas.scoreGrade.push({
        filename,
        beforeScore: beforeFile.overallScore,
        afterScore: afterFile.overallScore,
        beforeGrade: beforeFile.grade,
        afterGrade: afterFile.grade,
      })
    }

    if (beforeFile.veraPdf.status !== afterFile.veraPdf.status || beforeFile.veraPdf.failedChecks !== afterFile.veraPdf.failedChecks) {
      groupedDeltas.veraPdf.push({
        filename,
        beforeStatus: beforeFile.veraPdf.status,
        afterStatus: afterFile.veraPdf.status,
        beforeFailedChecks: beforeFile.veraPdf.failedChecks,
        afterFailedChecks: afterFile.veraPdf.failedChecks,
      })
    }

    const adobeDelta = compareSetDelta(
      Object.entries(beforeFile.adobe.normalizedFailedFamilyCounts).filter(([, count]) => count > 0).map(([key]) => key),
      Object.entries(afterFile.adobe.normalizedFailedFamilyCounts).filter(([, count]) => count > 0).map(([key]) => key),
    )
    if (adobeDelta.removed.length || adobeDelta.added.length) {
      groupedDeltas.adobeFamilies.push({ filename, removed: adobeDelta.removed, added: adobeDelta.added })
    }

    const failureDelta = compareSetDelta(beforeFile.failureProfileKeys, afterFile.failureProfileKeys)
    if (failureDelta.removed.length || failureDelta.added.length) {
      groupedDeltas.failureProfileKeys.push({ filename, removed: failureDelta.removed, added: failureDelta.added })
    }

    const plannerDelta = compareSetDelta(beforeFile.plannerAutoRunnableKeys, afterFile.plannerAutoRunnableKeys)
    if (plannerDelta.removed.length || plannerDelta.added.length) {
      groupedDeltas.plannerAutoRunnableKeys.push({ filename, removed: plannerDelta.removed, added: plannerDelta.added })
    }

    if (beforeFile.classification.structuralClass !== afterFile.classification.structuralClass) {
      groupedDeltas.structuralClass.push({
        filename,
        beforeStructuralClass: beforeFile.classification.structuralClass,
        afterStructuralClass: afterFile.classification.structuralClass,
      })
    }

    if (beforeFile.overallScore === 100 && beforeFile.grade === 'A' && (afterFile.overallScore < 100 || afterFile.grade !== 'A')) {
      maybeIssue({
        issues,
        allowKnownGaps,
        key: `file:${filename}:perfect_score_regressed`,
        kind: 'file',
        message: `${filename} regressed from 100/A to ${afterFile.overallScore}/${afterFile.grade}.`,
      })
    }

    for (const removedKey of failureDelta.removed) {
      if (!fileImproved(beforeFile, afterFile)) {
        maybeIssue({
          issues,
          allowKnownGaps,
          key: `file:${filename}:failure_profile_key_removed:${removedKey}`,
          kind: 'file',
          message: `${filename} lost failure-profile key ${removedKey} without an accompanying score or Adobe improvement.`,
        })
      }
    }

    for (const removedKey of plannerDelta.removed) {
      if (!fileImproved(beforeFile, afterFile)) {
        maybeIssue({
          issues,
          allowKnownGaps,
          key: `file:${filename}:planner_auto_runnable_removed:${removedKey}`,
          kind: 'file',
          message: `${filename} lost auto-runnable planner key ${removedKey} without an accompanying score or Adobe improvement.`,
        })
      }
    }
  }

  if (options.mode === 'phase0-canary') {
    const requiredClasses = new Set(options.requiredCanaryStructuralClasses || [])
    const beforeCoverage = new Set(before.canary.coverage.structuralClasses)
    const afterCoverage = new Set(after.canary.coverage.structuralClasses)

    for (const structuralClass of requiredClasses) {
      if (!afterCoverage.has(structuralClass)) {
        maybeIssue({
          issues,
          allowKnownGaps,
          key: `canary.coverage:${structuralClass}`,
          kind: 'canary',
          message: `Canary coverage is missing required structural class ${structuralClass}.`,
        })
      }
    }

    for (const structuralClass of beforeCoverage) {
      if (!afterCoverage.has(structuralClass)) {
        maybeIssue({
          issues,
          allowKnownGaps,
          key: `canary.coverage_shrunk:${structuralClass}`,
          kind: 'canary',
          message: `Canary structural coverage lost ${structuralClass}.`,
        })
      }
    }

    for (const entry of after.canary.entries) {
      const afterFile = afterByName.get(entry.filename)
      if (!afterFile) continue
      const beforeFile = beforeByName.get(entry.filename)

      for (const signal of entry.expectedSignals || []) {
        if (canarySignalSatisfied(signal, afterFile)) {
          groupedDeltas.canaryExpectations.push({
            filename: entry.filename,
            expectation: signal,
            status: 'present',
          })
          continue
        }
        if (beforeFile && canarySignalSatisfied(signal, beforeFile) && fileImproved(beforeFile, afterFile)) {
          groupedDeltas.canaryExpectations.push({
            filename: entry.filename,
            expectation: signal,
            status: 'improved_away',
          })
          continue
        }
        groupedDeltas.canaryExpectations.push({
          filename: entry.filename,
          expectation: signal,
          status: 'missing',
        })
        maybeIssue({
          issues,
          allowKnownGaps,
          key: `canary.signal:${entry.filename}:${signal}`,
          kind: 'canary',
          message: `${entry.filename} no longer satisfies canary expectation ${signal}.`,
        })
      }

      for (const disallowedKey of entry.verificationLocks?.disallowedAutoRunnableKeys || []) {
        if (afterFile.plannerAutoRunnableKeys.includes(disallowedKey)) {
          maybeIssue({
            issues,
            allowKnownGaps,
            key: `canary.disallowed_auto_runnable:${entry.filename}:${disallowedKey}`,
            kind: 'canary',
            message: `${entry.filename} surfaced disallowed auto-runnable key ${disallowedKey}.`,
          })
        }
      }
      for (const requiredKey of entry.verificationLocks?.requiredFailureProfileKeys || []) {
        if (!afterFile.failureProfileKeys.includes(requiredKey)) {
          maybeIssue({
            issues,
            allowKnownGaps,
            key: `canary.required_failure_mode:${entry.filename}:${requiredKey}`,
            kind: 'canary',
            message: `${entry.filename} is missing required failure-profile key ${requiredKey}.`,
          })
        }
      }
      for (const requiredKey of entry.verificationLocks?.requiredPlannerOpportunityKeys || []) {
        if (!afterFile.plannerOpportunityKeys.includes(requiredKey)) {
          maybeIssue({
            issues,
            allowKnownGaps,
            key: `canary.required_planner_key:${entry.filename}:${requiredKey}`,
            kind: 'canary',
            message: `${entry.filename} is missing required planner opportunity key ${requiredKey}.`,
          })
        }
      }
      for (const requiredKey of entry.verificationLocks?.requiredAutoRunnableKeys || []) {
        if (!afterFile.plannerAutoRunnableKeys.includes(requiredKey)) {
          maybeIssue({
            issues,
            allowKnownGaps,
            key: `canary.required_auto_runnable:${entry.filename}:${requiredKey}`,
            kind: 'canary',
            message: `${entry.filename} is missing required auto-runnable key ${requiredKey}.`,
          })
        }
      }
    }
  }

  const regressions = issues.filter(issue => !issue.suppressed)
  return {
    ok: regressions.length === 0,
    mode: options.mode,
    beforePath: options.beforePath,
    afterPath: options.afterPath,
    allowKnownGaps: [...allowKnownGaps].sort(),
    summary: {
      regressionCount: regressions.length,
      suppressedRegressionCount: issues.length - regressions.length,
      comparedFileCount: after.files.length,
    },
    regressions,
    suppressedRegressions: issues.filter(issue => issue.suppressed),
    groupedDeltas,
  }
}

async function compareOneMode(input: {
  mode: Exclude<CompareMode, 'all'>
  beforePath?: string
  afterPath?: string
  allowKnownGaps: string[]
}) {
  const repo = repoRoot()
  const resolveInputPath = (value: string) => (path.isAbsolute(value) ? value : path.resolve(repo, value))
  const beforePath = input.beforePath
    ? resolveInputPath(input.beforePath)
    : path.resolve(repo, input.mode === 'phase0-baseline'
      ? PHASE0_VERIFICATION_MANIFEST.blessedArtifacts.baseline
      : PHASE0_VERIFICATION_MANIFEST.blessedArtifacts.canary)
  const afterPath = input.afterPath ? resolveInputPath(input.afterPath) : await resolveLatestArtifact(input.mode)
  const before = await readArtifact(beforePath)
  const after = await readArtifact(afterPath)
  return comparePhase0Artifacts(before, after, {
    mode: input.mode,
    beforePath,
    afterPath,
    allowKnownGaps: [...PHASE0_VERIFICATION_MANIFEST.allowKnownGaps, ...input.allowKnownGaps],
    requiredCanaryStructuralClasses: input.mode === 'phase0-canary'
      ? PHASE0_VERIFICATION_MANIFEST.requiredCanaryStructuralClasses
      : undefined,
  })
}

function parseArgs(argv: string[]) {
  let mode: CompareMode = 'all'
  let beforePath: string | undefined
  let afterPath: string | undefined
  const allowKnownGaps: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--mode') {
      const value = argv[index + 1]
      if (value === 'phase0-baseline' || value === 'phase0-canary' || value === 'all') {
        mode = value
      }
      index += 1
      continue
    }
    if (arg === '--before') {
      beforePath = argv[index + 1]
      index += 1
      continue
    }
    if (arg === '--after') {
      afterPath = argv[index + 1]
      index += 1
      continue
    }
    if (arg === '--allow-known-gap') {
      const value = argv[index + 1]
      if (value) allowKnownGaps.push(value)
      index += 1
    }
  }

  return { mode, beforePath, afterPath, allowKnownGaps }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const modes: Array<Exclude<CompareMode, 'all'>> = args.mode === 'all'
    ? ['phase0-baseline', 'phase0-canary']
    : [args.mode]
  const results = []
  for (const mode of modes) {
    results.push(await compareOneMode({
      mode,
      beforePath: args.beforePath,
      afterPath: args.afterPath,
      allowKnownGaps: args.allowKnownGaps,
    }))
  }

  const ok = results.every(result => result.ok)
  console.log(JSON.stringify({
    ok,
    manifest: PHASE0_VERIFICATION_MANIFEST,
    results,
  }, null, 2))
  if (!ok) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}
