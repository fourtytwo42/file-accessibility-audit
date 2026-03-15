import fs from 'node:fs/promises'
import path from 'node:path'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { remediatePdfWithAgent } from '../services/agentRemediationService.js'

async function main() {
  const names = process.argv.slice(2)
  if (!names.length) {
    throw new Error('Usage: tsx src/scripts/diagnoseRemediation.ts <pdf-name> [pdf-name...]')
  }

  const downloadsDir = path.resolve(process.cwd(), '../../downloads/icjia-publications')

  for (const name of names) {
    const filePath = path.join(downloadsDir, name)
    const buffer = await fs.readFile(filePath)
    const before = await analyzePDF(buffer, name)
    const remediated = await remediatePdfWithAgent(buffer, name, before)
    const after = remediated.finalResult

    const payload = {
      name,
      before: {
        grade: before.grade,
        score: before.overallScore,
        verapdfStatus: before.verapdf.status,
        failedChecks: before.verapdf.failedChecks,
      },
      after: {
        grade: after.grade,
        score: after.overallScore,
        verapdfStatus: after.verapdf.status,
        failedChecks: after.verapdf.failedChecks,
      },
      actions: (remediated.model.actions || []).map(action => ({
        tool: action.tool,
        outcome: action.outcome,
        target: action.candidateGroupId || action.candidateId || action.target,
        details: action.details,
      })),
      topFailures: after.verapdf.failures.slice(0, 12).map(failure => failure.message),
      failureModes: remediated.model.failureProfile?.failureModes.slice(0, 12).map(mode => ({
        key: mode.key,
        count: mode.count,
        classification: mode.classification,
      })),
    }

    console.log(JSON.stringify(payload, null, 2))
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
