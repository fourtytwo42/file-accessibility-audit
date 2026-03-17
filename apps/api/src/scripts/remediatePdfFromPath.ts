/**
 * Run full agent remediation on a PDF file and optionally verify 100/100 and no Adobe alt-text issues.
 * Usage (from apps/api): pnpm exec tsx src/scripts/remediatePdfFromPath.ts [input.pdf] [output.pdf]
 * Default: ../../99anreport.pdf -> ../../99anreport-remediated.pdf
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { remediatePdfWithAgent } from '../services/agentRemediationService.js'
import { runPdfStructureBackend } from '../services/pdfStructureBackend.js'

const repoRoot = path.resolve(process.cwd(), '../..')
const defaultInput = path.join(repoRoot, '99anreport.pdf')
const defaultOutput = path.join(repoRoot, '99anreport-remediated.pdf')

async function main() {
  const inputPath = path.resolve(process.argv[2] || defaultInput)
  const outputPath = path.resolve(process.argv[3] || defaultOutput)
  const filename = path.basename(inputPath)

  console.log('Input:', inputPath)
  console.log('Output:', outputPath)
  console.log('')

  const buffer = await fs.readFile(inputPath)
  console.log('Analyzing original...')
  const before = await analyzePDF(buffer, filename)
  console.log('Before — Score:', before.overallScore, 'Grade:', before.grade, 'veraPDF:', before.verapdf?.status ?? 'n/a')
  console.log('')

  console.log('Running agent remediation (this may take a few minutes)...')
  const remediated = await remediatePdfWithAgent(buffer, filename, before, {
    onProgress(p) {
      if (p.percent % 20 < 5 || p.percent >= 95) process.stdout.write(`  ${p.percent}% ${p.stage}\n`)
    },
  })
  const after = remediated.finalResult
  console.log('After — Score:', after.overallScore, 'Grade:', after.grade, 'veraPDF:', after.verapdf?.status ?? 'n/a')
  console.log('')

  await fs.writeFile(outputPath, remediated.buffer)
  console.log('Wrote remediated PDF to', outputPath)
  console.log('')

  console.log('Checking for Adobe "Other elements alternate text" risks (non-figure /Alt)...')
  const inspect = await runPdfStructureBackend({
    buffer: remediated.buffer,
    mutation: { operation: 'inspect', inspectMode: 'alt_text_deep' },
  })
  const riskNodes = inspect.acrobatAltRiskNodes || []
  const nonfigureRisks = riskNodes.filter((n: { ownershipMode?: string }) => n.ownershipMode === 'nonfigure_with_alt')
  console.log('  Acrobat alt risk nodes (total):', riskNodes.length)
  console.log('  nonfigure_with_alt (Other elements alternate text):', nonfigureRisks.length)
  if (nonfigureRisks.length > 0) {
    console.log('  Sample:', nonfigureRisks.slice(0, 3).map((n: { tag?: string; ref?: string }) => `${n.tag} ${n.ref}`))
  }
  console.log('')

  const ok = after.overallScore === 100 && nonfigureRisks.length === 0
  if (ok) {
    console.log('SUCCESS: 100/100 with no Adobe "Other elements alternate text" issues.')
  } else {
    if (after.overallScore !== 100) console.log('Score is not 100 (current:', after.overallScore, ')')
    if (nonfigureRisks.length > 0) console.log('Still has', nonfigureRisks.length, 'non-figure /Alt risk(s) for Adobe.')
  }
  process.exitCode = ok ? 0 : 1
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
