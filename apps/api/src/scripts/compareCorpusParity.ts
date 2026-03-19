import fs from 'node:fs/promises'
import path from 'node:path'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { buildFailureProfileArtifacts } from '../services/failureProfileService.js'
import { inspectPdfForRemediation } from '../services/pdfRemediationTools.js'

type ComparedFile = {
  filename: string
  withVera: {
    overallScore: number
    grade: string
    veraStatus: string
    failedChecks: number
  }
  withoutVera: {
    overallScore: number
    grade: string
    veraStatus: string
    failedChecks: number
  }
  failureFamilyDelta: {
    withVeraOnly: string[]
    withoutVeraOnly: string[]
  }
  plannerOpportunityDelta: {
    withVeraOnly: string[]
    withoutVeraOnly: string[]
  }
  parity: {
    passes: boolean
    reasons: string[]
  }
}

function diffKeys(withA: string[], withB: string[]) {
  return {
    withAOnly: withA.filter(key => !withB.includes(key)).sort(),
    withBOnly: withB.filter(key => !withA.includes(key)).sort(),
  }
}

function gradeWeight(grade: string): number {
  return ['F', 'D', 'C', 'B', 'A'].indexOf(grade)
}

async function buildProfileArtifacts(result: Awaited<ReturnType<typeof analyzePDF>>, buffer: Buffer) {
  const context = await inspectPdfForRemediation(buffer, result)
  return buildFailureProfileArtifacts({
    analysis: result,
    context,
    actions: [],
    rejectedActions: [],
    iterations: [],
  })
}

function evaluateParity(input: {
  withVera: Awaited<ReturnType<typeof analyzePDF>>
  withoutVera: Awaited<ReturnType<typeof analyzePDF>>
  withFailureKeys: string[]
  withoutFailureKeys: string[]
  withPlannerKeys: string[]
  withoutPlannerKeys: string[]
}): { passes: boolean; reasons: string[] } {
  const reasons: string[] = []

  if (gradeWeight(input.withoutVera.grade) > gradeWeight(input.withVera.grade)) {
    reasons.push(`No-vera grade improved from ${input.withVera.grade} to ${input.withoutVera.grade}.`)
  }
  if (input.withoutVera.overallScore > input.withVera.overallScore + 2) {
    reasons.push(`No-vera score improved materially from ${input.withVera.overallScore} to ${input.withoutVera.overallScore}.`)
  }

  const withPdfUaFamilies = input.withFailureKeys.filter(key => key.startsWith('pdfua.') && key !== 'pdfua.unmatched')
  const missingFamilies = withPdfUaFamilies.filter(key => !input.withoutFailureKeys.includes(key))
  if (missingFamilies.length) {
    reasons.push(`No-vera run missed PDF/UA family keys: ${missingFamilies.join(', ')}`)
  }

  const missingPlannerKeys = input.withPlannerKeys.filter(key => !input.withoutPlannerKeys.includes(key))
  if (missingPlannerKeys.length) {
    reasons.push(`No-vera run missed planner opportunities: ${missingPlannerKeys.join(', ')}`)
  }

  return {
    passes: reasons.length === 0,
    reasons,
  }
}

async function main() {
  const args = process.argv.slice(2)
  let corpusDir = path.resolve(process.cwd(), '../../Processed/Before')
  const names: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--dir') {
      const dir = args[index + 1]
      if (!dir) throw new Error('Missing value for --dir')
      corpusDir = path.resolve(process.cwd(), dir)
      index += 1
      continue
    }
    names.push(arg)
  }

  if (!names.length) {
    throw new Error('Provide at least one PDF filename or use the existing compareVeraPdfCoverage.ts baseline script.')
  }

  const results: ComparedFile[] = []

  for (const name of names) {
    const filePath = path.join(corpusDir, name)
    const buffer = await fs.readFile(filePath)
    const withVera = await analyzePDF(buffer, name)
    const withoutVera = await analyzePDF(buffer, name, { skipVeraPdf: true })
    const withArtifacts = await buildProfileArtifacts(withVera, buffer)
    const withoutArtifacts = await buildProfileArtifacts(withoutVera, buffer)
    const withFailureKeys = withArtifacts.failureProfile.failureModes.map(mode => mode.key)
    const withoutFailureKeys = withoutArtifacts.failureProfile.failureModes.map(mode => mode.key)
    const coveredFailureKeys = withFailureKeys.filter(key => key.startsWith('pdfua.') && key !== 'pdfua.unmatched')
    const withPlannerKeys = withArtifacts.failureProfile.toolOpportunities
      .filter(entry => entry.derivedFromFailureModeKeys.some(key => coveredFailureKeys.includes(key)))
      .map(entry => entry.key)
    const withoutPlannerKeys = withoutArtifacts.failureProfile.toolOpportunities
      .filter(entry => entry.derivedFromFailureModeKeys.some(key => coveredFailureKeys.includes(key)))
      .map(entry => entry.key)
    const failureDiff = diffKeys(withFailureKeys, withoutFailureKeys)
    const plannerDiff = diffKeys(withPlannerKeys, withoutPlannerKeys)

    results.push({
      filename: name,
      withVera: {
        overallScore: withVera.overallScore,
        grade: withVera.grade,
        veraStatus: withVera.verapdf.status,
        failedChecks: withVera.verapdf.failedChecks,
      },
      withoutVera: {
        overallScore: withoutVera.overallScore,
        grade: withoutVera.grade,
        veraStatus: withoutVera.verapdf.status,
        failedChecks: withoutVera.verapdf.failedChecks,
      },
      failureFamilyDelta: {
        withVeraOnly: failureDiff.withAOnly,
        withoutVeraOnly: failureDiff.withBOnly,
      },
      plannerOpportunityDelta: {
        withVeraOnly: plannerDiff.withAOnly,
        withoutVeraOnly: plannerDiff.withBOnly,
      },
      parity: evaluateParity({
        withVera,
        withoutVera,
        withFailureKeys,
        withoutFailureKeys,
        withPlannerKeys,
        withoutPlannerKeys,
      }),
    })
  }

  const failingFiles = results
    .filter(result => !result.parity.passes)
    .map(result => ({ filename: result.filename, reasons: result.parity.reasons }))

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    corpusDir,
    sampleCorpus: names,
    summary: {
      fileCount: results.length,
      parityPassCount: results.length - failingFiles.length,
      parityFailCount: failingFiles.length,
      failingFiles,
    },
    files: results,
  }, null, 2))

  if (failingFiles.length) {
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
