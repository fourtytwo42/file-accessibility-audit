import fs from 'node:fs/promises'
import path from 'node:path'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { buildFailureProfileArtifacts } from '../services/failureProfileService.js'
import {
  executeRemediationTool,
  inspectPdfForRemediation,
} from '../services/pdfRemediationTools.js'
import { deriveDeterministicCall } from '../services/remediationCallDerivationService.js'
import type { RemediationActionRecord } from '../services/documentModel.js'

const DEFAULT_FILENAME = '97anreport.pdf'

interface MetadataBookmarkTraceStep {
  step: string
  outcome?: string
  changedDocumentBytes?: boolean
  score: number
  grade: string
  categories: {
    bookmarks: number | null
    titleLanguage: number | null
    pdfUaCompliance: number | null
    altText: number | null
  }
  findingKeys: string[]
  trackedFindings: Array<{
    key: string
    evidence: string[]
  }>
  title: string | null
  language: string | null
  outlineTitles: string[]
  autoRunnableKeys: string[]
}

interface MetadataBookmarkTraceArtifact {
  generatedAt: string
  filename: string
  steps: MetadataBookmarkTraceStep[]
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

async function summarizeStep(
  step: string,
  filename: string,
  buffer: Buffer,
  analysis: any,
  actions: RemediationActionRecord[],
  extra?: Partial<MetadataBookmarkTraceStep>,
): Promise<MetadataBookmarkTraceStep> {
  const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
  const artifacts = buildFailureProfileArtifacts({
    analysis,
    context,
    actions,
    rejectedActions: [],
  })
  const trackedFindingKeys = new Set([
    'pdfua.bookmark_language',
    'pdfua.display_doc_title',
    'pdfua.document_language',
    'pdfua.metadata_identification',
    'pdfua.figure_alt_quality',
  ])
  return {
    step,
    score: analysis.overallScore,
    grade: analysis.grade,
    categories: {
      bookmarks: categoryScore(analysis, 'bookmarks'),
      titleLanguage: categoryScore(analysis, 'title_language'),
      pdfUaCompliance: categoryScore(analysis, 'pdf_ua_compliance'),
      altText: categoryScore(analysis, 'alt_text'),
    },
    findingKeys: (analysis.localStandards?.findings || [])
      .filter((finding: any) => finding.blocking)
      .map((finding: any) => finding.key),
    trackedFindings: (analysis.localStandards?.findings || [])
      .filter((finding: any) => trackedFindingKeys.has(finding.key))
      .map((finding: any) => ({
        key: finding.key,
        evidence: finding.evidence,
      })),
    title: context.pdfjs.title || null,
    language: context.qpdf.lang || context.pdfjs.lang || null,
    outlineTitles: (context.qpdf.outlineTitles || []).slice(0, 12),
    autoRunnableKeys: artifacts.failureProfile.toolOpportunities
      .filter((opportunity: any) => opportunity.status === 'auto_runnable')
      .map((opportunity: any) => opportunity.key),
    ...extra,
  }
}

async function main() {
  const filename = process.argv[2] || DEFAULT_FILENAME
  const pdfPath = path.join(repoRoot(), 'Processed', 'After', filename)
  let buffer = await fs.readFile(pdfPath) as Buffer
  let analysis = await analyzePDF(buffer, filename, {
    analysisProfile: 'remediation_fast',
    skipAdobe: true,
    skipVeraPdf: true,
  })
  const actions: RemediationActionRecord[] = []
  const steps: MetadataBookmarkTraceStep[] = [
    await summarizeStep('baseline', filename, buffer, analysis, actions),
  ]

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const artifacts = buildFailureProfileArtifacts({
      analysis,
      context,
      actions,
      rejectedActions: [],
    })
    const opportunity = artifacts.failureProfile.toolOpportunities.find(entry => entry.toolName === 'normalize_document_metadata')
    if (opportunity) {
      const call = deriveDeterministicCall({
        filename,
        analysis,
        context,
        opportunity,
        selectedActions: [],
      })
      if (call) {
        const outcome = await executeRemediationTool({ buffer, context, call })
        buffer = outcome.buffer
        actions.push(outcome.action)
        analysis = await analyzePDF(buffer, filename, {
          analysisProfile: 'remediation_fast',
          skipAdobe: true,
          skipVeraPdf: true,
        })
        steps.push(await summarizeStep('normalize_document_metadata', filename, buffer, analysis, actions, {
          outcome: outcome.action.outcome,
          changedDocumentBytes: outcome.action.changedDocumentBytes,
        }))
      }
    }
  }

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const outcome = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'replace_bookmarks_from_headings',
        arguments: { target: 'document' },
        rationale: 'Trace post-metadata bookmark cleanup for 97anreport.',
        confidence: 0.95,
      },
    })
    buffer = outcome.buffer
    actions.push(outcome.action)
    analysis = await analyzePDF(buffer, filename, {
      analysisProfile: 'remediation_fast',
      skipAdobe: true,
      skipVeraPdf: true,
    })
    steps.push(await summarizeStep('replace_bookmarks_from_headings', filename, buffer, analysis, actions, {
      outcome: outcome.action.outcome,
      changedDocumentBytes: outcome.action.changedDocumentBytes,
    }))
  }

  const artifact: MetadataBookmarkTraceArtifact = {
    generatedAt: new Date().toISOString(),
    filename,
    steps,
  }

  const outputDir = path.join(repoRoot(), 'MitigationAttempts', 'metadata-bookmark-traces')
  await fs.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${timestampForFilename(new Date())}.metadata-bookmark-trace.json`)
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
