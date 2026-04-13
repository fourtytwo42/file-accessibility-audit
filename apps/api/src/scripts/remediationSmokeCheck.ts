import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import { analyzePdf, remediatePdf } from '../engine/index.js'
import { consumeOpenAiCompatAttemptRecords } from '../services/openAiCompatService.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const apiRoot = path.resolve(here, '..', '..')
const repoRoot = path.resolve(apiRoot, '..', '..')
dotenv.config({ path: path.join(apiRoot, '.env') })
dotenv.config({ path: path.join(repoRoot, '.env') })

interface SmokeSummary {
  file: string
  before: { score: number; grade: string }
  after: { score: number; grade: string }
  promotionPassed: boolean
  appliedActions: number
  manualFlags: number
  providerAttempts: Array<{ serviceName: string; label: string; outcome: string }>
}

async function runSmokeFor(filePath: string): Promise<SmokeSummary> {
  const absolutePath = path.resolve(filePath)
  const filename = path.basename(absolutePath)
  const buffer = fs.readFileSync(absolutePath)

  consumeOpenAiCompatAttemptRecords()
  const analysis = await analyzePdf(buffer, filename, {
    skipAdobe: true,
    skipVeraPdf: true,
  })
  const result = await remediatePdf(buffer, filename, analysis, {
    artifactRetention: 'none',
    maxRuntimeMs: 180_000,
  })
  const providerAttempts = consumeOpenAiCompatAttemptRecords()

  if (providerAttempts.some(entry => entry.label !== 'primary' || entry.outcome !== 'success')) {
    throw new Error(`Unexpected provider routing for ${filename}: ${JSON.stringify(providerAttempts)}`)
  }

  return {
    file: absolutePath,
    before: {
      score: analysis.overallScore,
      grade: analysis.grade,
    },
    after: {
      score: result.finalAnalysis.overallScore,
      grade: result.finalAnalysis.grade,
    },
    promotionPassed: result.promotionGate.passed,
    appliedActions: result.appliedActions.length,
    manualFlags: result.manualReviewFlags.length,
    providerAttempts: providerAttempts.map(entry => ({
      serviceName: entry.serviceName,
      label: entry.label,
      outcome: entry.outcome,
    })),
  }
}

async function main(): Promise<void> {
  const files = process.argv.slice(2)
  if (!files.length) {
    throw new Error('Usage: tsx src/scripts/remediationSmokeCheck.ts <pdf-path> [pdf-path...]')
  }

  const summaries: SmokeSummary[] = []
  for (const filePath of files) {
    if (!fs.existsSync(filePath)) {
      console.warn(JSON.stringify({
        scope: 'remediation_smoke',
        skipped: true,
        reason: 'missing_file',
        file: path.resolve(filePath),
      }))
      continue
    }
    summaries.push(await runSmokeFor(filePath))
  }

  if (!summaries.length) {
    throw new Error('No remediation smoke PDFs were processed.')
  }

  if (!summaries.some(summary => summary.providerAttempts.length > 0 || summary.appliedActions > 0)) {
    throw new Error('Remediation smoke completed without any provider routing or applied actions.')
  }

  console.log(JSON.stringify({
    scope: 'remediation_smoke',
    processed: summaries.length,
    summaries,
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
