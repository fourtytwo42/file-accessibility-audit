/**
 * Full agent loop (same as API queue) — stronger than fixed MCP batches.
 * Run: pnpm --filter pdf-mcp exec tsx scripts/run-agent-to-pass.ts <input.pdf> [out.pdf]
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { analyzePDF } from '../../api/src/services/pdfAnalyzer.ts'
import { remediatePdfWithAgent } from '../../api/src/services/agentRemediationService.ts'
import { evaluatePromotionGate } from '../../api/src/services/promotionGate.ts'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDir, '..', '..', '..')
dotenv.config({ path: path.join(repoRoot, '.env'), override: false })
dotenv.config({ path: path.join(repoRoot, 'apps', 'api', '.env'), override: false })

async function main() {
  const input = process.argv[2]
  const output = process.argv[3] || input.replace(/\.pdf$/i, '.agent-pass.pdf')
  if (!input) {
    console.error('Usage: tsx scripts/run-agent-to-pass.ts <input.pdf> [output.pdf]')
    process.exit(1)
  }
  const filename = path.basename(input)
  const buffer = await fs.readFile(input)
  const before = await analyzePDF(buffer, filename, { skipAdobe: true, analysisProfile: 'full_final' })
  console.log(JSON.stringify({ before: { grade: before.grade, score: before.overallScore, gate: evaluatePromotionGate({ analysisResult: before }) } }, null, 2))

  const out = await remediatePdfWithAgent(buffer, filename, before, {
    onProgress(p) {
      if (p.percent % 25 === 0 || p.stage.includes('Complete')) {
        console.log(JSON.stringify({ progress: p }))
      }
    },
  })

  await fs.writeFile(output, out.buffer)
  const gate = evaluatePromotionGate({ analysisResult: out.finalResult })
  console.log(JSON.stringify({
    wrote: output,
    after: { grade: out.finalResult.grade, score: out.finalResult.overallScore, gate },
    actions: out.model.actions?.length ?? 0,
  }, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
