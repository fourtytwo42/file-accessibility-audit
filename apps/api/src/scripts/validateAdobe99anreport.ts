/**
 * Run analysis (local + veraPDF + Adobe Checker) on a PDF and print a comparison.
 * Usage (from repo root): pnpm exec tsx apps/api/src/scripts/validateAdobe99anreport.ts [path/to/file.pdf]
 * Default: 99anreport.pdf in repo root.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { adobeServicesAvailable } from '../services/adobePdfServices.js'

const repoRoot = path.resolve(process.cwd(), process.cwd().endsWith('apps/api') ? '../..' : '.')
const defaultInput = path.join(repoRoot, '99anreport.pdf')

async function main() {
  const inputPath = path.resolve(process.argv[2] || defaultInput)
  const filename = path.basename(inputPath)

  console.log('Validate Adobe + local + veraPDF on:', inputPath)
  console.log('')

  const adobeStatus = adobeServicesAvailable()
  console.log('Adobe PDF Services:', adobeStatus.available ? 'available' : 'unavailable')
  if (!adobeStatus.available) console.log('  ', adobeStatus.message)
  console.log('')

  const buffer = await fs.readFile(inputPath)
  console.log('Running full analysis (qpdf, veraPDF, Adobe Checker)...')
  const result = await analyzePDF(buffer, filename, {
    onProgress(p) {
      if (p.percent === 100 || p.percent % 25 < 5) process.stdout.write(`  ${p.percent}%\n`)
    },
  })

  console.log('')
  console.log('--- Comparison ---')
  console.log('Local (heuristic + structure):')
  console.log('  Score:', result.overallScore, '| Grade:', result.grade)
  console.log('veraPDF:')
  console.log('  Status:', result.verapdf?.status ?? 'n/a', '| Failed checks:', result.verapdf?.failedChecks ?? 'n/a')
  if (result.verapdf?.failures?.length) {
    console.log('  Sample failures:', result.verapdf.failures.slice(0, 2).map((f: { message?: string }) => f.message))
  }
  console.log('Adobe Accessibility Checker:')
  if (result.adobe) {
    console.log('  Status:', result.adobe.status, '| Issue count:', result.adobe.issueCount)
    console.log('  Summary:', result.adobe.summary)
    if (result.adobe.findings?.length) {
      console.log('  Sample findings:', result.adobe.findings.slice(0, 3).map((f: { message: string }) => f.message))
    }
  } else {
    console.log('  No Adobe result (unavailable or not run).')
  }
  console.log('')
  process.exitCode = 0
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
