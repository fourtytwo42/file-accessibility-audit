import fs from 'node:fs/promises'
import path from 'node:path'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { inspectPdfForRemediation, executeRemediationTool } from '../services/pdfRemediationTools.js'

const DEFAULT_FILES = [
  '1993-1994_Biennial_Report.pdf',
  '1996CHRIAudit.pdf',
  '1998_Madison.pdf',
  '1988-1989_Biennial_Report.pdf',
] as const

const DEFAULT_TOOL_CHAIN = [
  'set_pdfua_identification',
  'normalize_document_metadata',
  'set_document_language',
  'bootstrap_struct_tree',
  'artifact_nonsemantic_page_elements',
  'repair_bootstrapped_chart_content_refs',
  'normalize_heading_hierarchy',
  'repair_native_marked_content_refs',
  'repair_structure_conformance',
  'replace_bookmarks_from_headings',
] as const

interface TraceStep {
  step: string
  outcome?: string
  changedDocumentBytes?: boolean
  score: number
  grade: string
  headingStructure: number | null
  bookmarks: number | null
  pdfUaCompliance: number | null
  titleLanguage: number | null
  readingOrder: number | null
  blockingFindingKeys: string[]
  warningFindingKeys: string[]
  structureSignals?: {
    hasStructTree: boolean
    hasMarkInfo: boolean
    headingCount: number
    structTreeDepth: number
  }
}

interface LongReportTraceFile {
  filename: string
  steps: TraceStep[]
}

interface LongReportTraceArtifact {
  generatedAt: string
  files: LongReportTraceFile[]
}

function repoRoot(): string {
  return path.resolve(process.cwd(), '../..')
}

function timestampForFilename(input: Date): string {
  return input.toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z')
}

function categoryScore(analysis: any, id: string): number | null {
  return analysis.categories?.find((category: any) => category.id === id)?.score ?? null
}

function summarizeStep(step: string, analysis: any, extra?: Partial<TraceStep>): TraceStep {
  const findings = analysis.localStandards?.findings ?? []
  return {
    step,
    score: analysis.overallScore,
    grade: analysis.grade,
    headingStructure: categoryScore(analysis, 'heading_structure'),
    bookmarks: categoryScore(analysis, 'bookmarks'),
    pdfUaCompliance: categoryScore(analysis, 'pdf_ua_compliance'),
    titleLanguage: categoryScore(analysis, 'title_language'),
    readingOrder: categoryScore(analysis, 'reading_order'),
    blockingFindingKeys: findings.filter((finding: any) => finding.blocking).map((finding: any) => finding.key),
    warningFindingKeys: findings.filter((finding: any) => !finding.blocking).map((finding: any) => finding.key),
    ...extra,
  }
}

async function traceFile(filename: string): Promise<LongReportTraceFile> {
  const pdfPath = path.join(repoRoot(), 'Processed', 'After', filename)
  let buffer = await fs.readFile(pdfPath) as Buffer
  let analysis = await analyzePDF(buffer, filename, {
    analysisProfile: 'remediation_fast',
    skipAdobe: true,
    skipVeraPdf: true,
  })

  const steps: TraceStep[] = [summarizeStep('baseline', analysis)]

  for (const toolName of DEFAULT_TOOL_CHAIN) {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const outcome = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: toolName,
        arguments: { target: 'document' },
        rationale: 'Long-report cleanup trace',
        confidence: 0.95,
      } as any,
    })
    buffer = outcome.buffer
    analysis = await analyzePDF(buffer, filename, {
      analysisProfile: 'remediation_fast',
      skipAdobe: true,
      skipVeraPdf: true,
    })
    steps.push(summarizeStep(toolName, analysis, {
      outcome: outcome.action.outcome,
      changedDocumentBytes: outcome.action.changedDocumentBytes,
      structureSignals: {
        hasStructTree: !!context.qpdf.hasStructTree,
        hasMarkInfo: !!context.qpdf.hasMarkInfo,
        headingCount: context.qpdf.headings?.length ?? 0,
        structTreeDepth: context.qpdf.structTreeDepth ?? 0,
      },
    }))
  }

  return { filename, steps }
}

async function main() {
  const filenames = process.argv.slice(2)
  const targetFiles = filenames.length ? filenames : [...DEFAULT_FILES]
  const files: LongReportTraceFile[] = []
  for (const filename of targetFiles) {
    files.push(await traceFile(filename))
  }

  const artifact: LongReportTraceArtifact = {
    generatedAt: new Date().toISOString(),
    files,
  }

  const outputDir = path.join(repoRoot(), 'MitigationAttempts', 'long-report-traces')
  await fs.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${timestampForFilename(new Date())}.long-report-trace.json`)
  await fs.writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')

  console.log(JSON.stringify({
    outputPath: path.relative(repoRoot(), outputPath),
    ...artifact,
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
