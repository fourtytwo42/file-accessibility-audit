import fs from 'node:fs/promises'
import path from 'node:path'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { buildFailureProfileArtifacts } from '../services/failureProfileService.js'
import { inspectPdfForRemediation } from '../services/pdfRemediationTools.js'
import { PROCESSED_REGRESSION_MANIFEST, type ProcessedRegressionManifest, type ProcessedRegressionPair } from './processedRegressionManifest.js'

interface ProcessedPairAnalysis {
  filename: string
  overallScore: number
  grade: string
  failureProfileKeys: string[]
  plannerOpportunityKeys: string[]
  plannerAutoRunnableKeys: string[]
}

interface ProcessedPairReport {
  beforeFilename: string
  afterFilename: string
  before: ProcessedPairAnalysis
  after: ProcessedPairAnalysis
}

interface ProcessedRegressionIssue {
  key: string
  filename: string
  message: string
}

export interface ProcessedRegressionArtifact {
  generatedAt: string
  manifest: {
    beforeDir: string
    afterDir: string
    pairCount: number
    knownMissingAfter: string[]
  }
  summary: {
    pairCount: number
    perfectAfterCount: number
    nonPerfectAfterCount: number
    improvedPairCount: number
    regressionCount: number
  }
  regressions: ProcessedRegressionIssue[]
  files: ProcessedPairReport[]
}

function repoRoot(): string {
  return path.resolve(process.cwd(), '../..')
}

function gradeWeight(grade: string): number {
  return ['F', 'D', 'C', 'B', 'A'].indexOf(grade)
}

function timestampForFilename(input: Date): string {
  return input.toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z')
}

async function analyzeFile(pdfPath: string, filename: string): Promise<ProcessedPairAnalysis> {
  const buffer = await fs.readFile(pdfPath)
  const analysis = await analyzePDF(buffer, filename, {
    skipAdobe: true,
    skipVeraPdf: true,
    analysisProfile: 'remediation_fast',
  })
  const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
  const artifacts = buildFailureProfileArtifacts({
    analysis,
    context,
    actions: [],
    rejectedActions: [],
    iterations: [],
  })

  return {
    filename,
    overallScore: analysis.overallScore,
    grade: analysis.grade,
    failureProfileKeys: artifacts.failureProfile.failureModes.map(mode => mode.key).sort(),
    plannerOpportunityKeys: artifacts.failureProfile.toolOpportunities.map(entry => entry.key).sort(),
    plannerAutoRunnableKeys: artifacts.failureProfile.toolOpportunities
      .filter(entry => entry.status === 'auto_runnable')
      .map(entry => entry.key)
      .sort(),
  }
}

export function evaluateProcessedRegressionArtifact(
  manifest: ProcessedRegressionManifest,
  files: ProcessedPairReport[],
): ProcessedRegressionArtifact {
  const regressions: ProcessedRegressionIssue[] = []

  for (const file of files) {
    if (file.after.overallScore < file.before.overallScore) {
      regressions.push({
        key: `score_regressed:${file.beforeFilename}`,
        filename: file.beforeFilename,
        message: `${file.beforeFilename} regressed from ${file.before.overallScore} to ${file.after.overallScore}.`,
      })
    }

    if (gradeWeight(file.after.grade) < gradeWeight(file.before.grade)) {
      regressions.push({
        key: `grade_regressed:${file.beforeFilename}`,
        filename: file.beforeFilename,
        message: `${file.beforeFilename} regressed from grade ${file.before.grade} to ${file.after.grade}.`,
      })
    }

    if (file.after.overallScore !== manifest.expectedAfterScore || file.after.grade !== manifest.expectedAfterGrade) {
      regressions.push({
        key: `after_not_perfect:${file.beforeFilename}`,
        filename: file.beforeFilename,
        message: `${file.afterFilename} is ${file.after.overallScore}/${file.after.grade} instead of ${manifest.expectedAfterScore}/${manifest.expectedAfterGrade}.`,
      })
    }

    if (file.after.plannerAutoRunnableKeys.length > 0) {
      regressions.push({
        key: `after_has_auto_runnable:${file.beforeFilename}`,
        filename: file.beforeFilename,
        message: `${file.afterFilename} still exposes auto-runnable opportunities: ${file.after.plannerAutoRunnableKeys.join(', ')}`,
      })
    }
  }

  const perfectAfterCount = files.filter(file =>
    file.after.overallScore === manifest.expectedAfterScore && file.after.grade === manifest.expectedAfterGrade,
  ).length
  const improvedPairCount = files.filter(file =>
    file.after.overallScore > file.before.overallScore
      || gradeWeight(file.after.grade) > gradeWeight(file.before.grade),
  ).length

  return {
    generatedAt: new Date().toISOString(),
    manifest: {
      beforeDir: manifest.beforeDir,
      afterDir: manifest.afterDir,
      pairCount: manifest.pairs.length,
      knownMissingAfter: manifest.knownMissingAfter,
    },
    summary: {
      pairCount: files.length,
      perfectAfterCount,
      nonPerfectAfterCount: files.length - perfectAfterCount,
      improvedPairCount,
      regressionCount: regressions.length,
    },
    regressions,
    files,
  }
}

async function buildPairReport(root: string, pair: ProcessedRegressionPair): Promise<ProcessedPairReport> {
  const beforePath = path.join(root, pair.beforeFilename)
  const afterPath = path.join(root, '..', 'After', pair.afterFilename)
  const [before, after] = await Promise.all([
    analyzeFile(beforePath, pair.beforeFilename),
    analyzeFile(afterPath, pair.afterFilename),
  ])
  return {
    beforeFilename: pair.beforeFilename,
    afterFilename: pair.afterFilename,
    before,
    after,
  }
}

async function main() {
  const root = repoRoot()
  const beforeRoot = path.join(root, PROCESSED_REGRESSION_MANIFEST.beforeDir)
  const outputDir = path.join(root, 'MitigationAttempts', 'processed-regression')
  await fs.mkdir(outputDir, { recursive: true })

  const files: ProcessedPairReport[] = []
  for (const pair of PROCESSED_REGRESSION_MANIFEST.pairs) {
    files.push(await buildPairReport(beforeRoot, pair))
  }

  const artifact = evaluateProcessedRegressionArtifact(PROCESSED_REGRESSION_MANIFEST, files)
  const outputPath = path.join(
    outputDir,
    `${timestampForFilename(new Date())}.processed-regression.json`,
  )
  await fs.writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')

  console.log(JSON.stringify({
    outputPath: path.relative(root, outputPath),
    ...artifact,
  }, null, 2))

  if (artifact.regressions.length > 0) {
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
