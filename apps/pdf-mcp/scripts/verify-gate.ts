import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { analyzePDF } from '../../api/src/services/pdfAnalyzer.ts'
import { evaluatePromotionGate } from '../../api/src/services/promotionGate.ts'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDir, '..', '..', '..')
dotenv.config({ path: path.join(repoRoot, '.env'), override: false })
dotenv.config({ path: path.join(repoRoot, 'apps', 'api', '.env'), override: false })

async function main() {
  const p = process.argv[2]
  if (!p) {
    console.error('Usage: tsx scripts/verify-gate.ts <file.pdf>')
    process.exit(1)
  }
  const buf = fs.readFileSync(p)
  const name = path.basename(p)
  const r = await analyzePDF(buf, name, { skipAdobe: true, analysisProfile: 'full_final' })
  const g = evaluatePromotionGate({ analysisResult: r })
  console.log(JSON.stringify({ grade: r.grade, score: r.overallScore, isScanned: r.isScanned, gatePassed: g.passed, gate: g }, null, 2))
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
