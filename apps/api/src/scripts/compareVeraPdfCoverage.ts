import fs from 'node:fs/promises'
import path from 'node:path'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { buildFailureProfileArtifacts } from '../services/failureProfileService.js'
import { inspectPdfForRemediation } from '../services/pdfRemediationTools.js'
import { STAGE1_BASELINE_CORPUS } from './stage1BaselineCorpus.js'

type ComparedCategory = {
  id: string
  label: string
  withVera: number | null
  withoutVera: number | null
  delta: number | null
  findingsAddedByVera: string[]
}

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
  categoriesChanged: ComparedCategory[]
  topFindingsDelta: Array<{
    categoryId: string
    withVeraOnly: string[]
    withoutVeraOnly: string[]
  }>
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

function compareCategories(withVera: Awaited<ReturnType<typeof analyzePDF>>, withoutVera: Awaited<ReturnType<typeof analyzePDF>>): ComparedCategory[] {
  return withVera.categories
    .map(category => {
      const withoutCategory = withoutVera.categories.find(entry => entry.id === category.id)
      const withScore = category.score ?? null
      const withoutScore = withoutCategory?.score ?? null
      const delta = typeof withScore === 'number' && typeof withoutScore === 'number' ? withScore - withoutScore : null
      const findingsAddedByVera = category.findings.filter(finding => !(withoutCategory?.findings || []).includes(finding))
      return {
        id: category.id,
        label: category.label,
        withVera: withScore,
        withoutVera: withoutScore,
        delta,
        findingsAddedByVera,
      }
    })
    .filter(category => category.delta !== 0 || category.findingsAddedByVera.length > 0)
}

function topFindingsDelta(withVera: Awaited<ReturnType<typeof analyzePDF>>, withoutVera: Awaited<ReturnType<typeof analyzePDF>>) {
  return withVera.categories.flatMap(category => {
    const withoutCategory = withoutVera.categories.find(entry => entry.id === category.id)
    const withVeraOnly = category.findings.filter(finding => !(withoutCategory?.findings || []).includes(finding)).slice(0, 3)
    const withoutVeraOnly = (withoutCategory?.findings || []).filter(finding => !category.findings.includes(finding)).slice(0, 3)
    if (!withVeraOnly.length && !withoutVeraOnly.length) return []
    return [{
      categoryId: category.id,
      withVeraOnly,
      withoutVeraOnly,
    }]
  })
}

async function buildProfileArtifacts(result: Awaited<ReturnType<typeof analyzePDF>>, buffer: Buffer, filename: string) {
  const context = await inspectPdfForRemediation(buffer, result)
  return buildFailureProfileArtifacts({
    analysis: result,
    context,
    actions: [],
    rejectedActions: [],
    iterations: [],
  })
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
  const names = process.argv.slice(2)
  const corpus = names.length ? names : [...STAGE1_BASELINE_CORPUS]
  const beforeDir = path.resolve(process.cwd(), '../../Processed/Before')
  const results: ComparedFile[] = []

  for (const name of corpus) {
    const filePath = path.join(beforeDir, name)
    const buffer = await fs.readFile(filePath)
    const withVera = await analyzePDF(buffer, name)
    const withoutVera = await analyzePDF(buffer, name, { skipVeraPdf: true })
    const withArtifacts = await buildProfileArtifacts(withVera, buffer, name)
    const withoutArtifacts = await buildProfileArtifacts(withoutVera, buffer, name)
    const coveredFailureKeys = withArtifacts.failureProfile.failureModes
      .map(mode => mode.key)
      .filter(key => key.startsWith('pdfua.') && key !== 'pdfua.unmatched')
    const failureDiff = diffKeys(
      withArtifacts.failureProfile.failureModes.map(mode => mode.key),
      withoutArtifacts.failureProfile.failureModes.map(mode => mode.key),
    )
    const withCoveredPlannerKeys = withArtifacts.failureProfile.toolOpportunities
      .filter(entry => entry.derivedFromFailureModeKeys.some(key => coveredFailureKeys.includes(key)))
      .map(entry => entry.key)
    const withoutCoveredPlannerKeys = withoutArtifacts.failureProfile.toolOpportunities
      .filter(entry => entry.derivedFromFailureModeKeys.some(key => coveredFailureKeys.includes(key)))
      .map(entry => entry.key)
    const plannerDiff = diffKeys(
      withCoveredPlannerKeys,
      withoutCoveredPlannerKeys,
    )
    const parity = evaluateParity({
      withVera,
      withoutVera,
      withFailureKeys: withArtifacts.failureProfile.failureModes.map(mode => mode.key),
      withoutFailureKeys: withoutArtifacts.failureProfile.failureModes.map(mode => mode.key),
      withPlannerKeys: withCoveredPlannerKeys,
      withoutPlannerKeys: withoutCoveredPlannerKeys,
    })

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
      categoriesChanged: compareCategories(withVera, withoutVera),
      topFindingsDelta: topFindingsDelta(withVera, withoutVera),
      failureFamilyDelta: {
        withVeraOnly: failureDiff.withAOnly,
        withoutVeraOnly: failureDiff.withBOnly,
      },
      plannerOpportunityDelta: {
        withVeraOnly: plannerDiff.withAOnly,
        withoutVeraOnly: plannerDiff.withBOnly,
      },
      parity,
    })
  }

  const failingFiles = results
    .filter(result => !result.parity.passes)
    .map(result => ({ filename: result.filename, reasons: result.parity.reasons }))

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    baselineCorpus: corpus,
    summary: {
      fileCount: results.length,
      parityPassCount: results.length - failingFiles.length,
      parityFailCount: failingFiles.length,
      failingFiles,
      knownGaps: [
        'pdfua.artifact_vs_real_content_partial',
        'pdfua.metadata_identification_content_unconfirmed',
      ],
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
