import fs from 'node:fs/promises'
import path from 'node:path'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { buildFailureProfileArtifacts } from '../services/failureProfileService.js'
import {
  executeRemediationTool,
  inspectPdfForRemediation,
} from '../services/pdfRemediationTools.js'
import type { RemediationActionRecord } from '../services/documentModel.js'

const DEFAULT_FILES = [
  '2007 Annual Report Final.pdf',
  '2008 Annual Report.pdf',
] as const

interface AnnualReportTraceStep {
  step: string
  outcome?: string
  changedDocumentBytes?: boolean
  score: number
  grade: string
  veraPdf: {
    status: string
    failedChecks: number
  }
  categories: {
    altText: number | null
    tableMarkup: number | null
    pdfUaCompliance: number | null
    titleLanguage: number | null
  }
  blockingFindingKeys: string[]
  advisoryFindingKeys: string[]
  mixedOwnership: {
    total: number
    splitSafe: number
    containmentSafe: number
    unsplittable: number
  }
  tableCandidates: {
    total: number
    safe: number
    deferred: number
    withHeaders: number
  }
  fontSignals: {
    unembeddedFontCount: number
    fontsMissingToUnicode: number
    fontsMissingToUnicodeBlocking: number
    cidSetRiskFontCount: number
    legacyWidthRiskFontCount: number
  }
  pageTabsFindingCount: number
  annotationAltContentsCount: number
  acrobatAltRiskCount: number
  highConfidenceUntaggedTables: number
  advisoryUntaggedTables: number
  structureSignals: {
    structuralNodeCount: number
    readingOrderNodeCount: number
    readingOrderParentCount: number
    figureCount: number
    headingCount: number
    imageStructNodeCount: number
  }
  autoRunnableKeys: string[]
}

interface AnnualReportTraceFile {
  filename: string
  steps: AnnualReportTraceStep[]
}

interface AnnualReportTraceArtifact {
  generatedAt: string
  files: AnnualReportTraceFile[]
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
  extra?: Partial<AnnualReportTraceStep>,
): Promise<AnnualReportTraceStep> {
  const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
  const artifacts = buildFailureProfileArtifacts({
    analysis,
    context,
    actions,
    rejectedActions: [],
  })
  const acrobatAltRiskNodes = context.structure.acrobatAltRiskNodes || []
  const mixedOwnershipNodes = acrobatAltRiskNodes.filter((node: any) => node.ownershipMode === 'mixed_text_graphics_same_mcid')
  const tableStructure = analysis.tableStructure || {}

  return {
    step,
    score: analysis.overallScore,
    grade: analysis.grade,
    veraPdf: {
      status: analysis.verapdf?.status || 'unavailable',
      failedChecks: analysis.verapdf?.failedChecks || 0,
    },
    categories: {
      altText: categoryScore(analysis, 'alt_text'),
      tableMarkup: categoryScore(analysis, 'table_markup'),
      pdfUaCompliance: categoryScore(analysis, 'pdf_ua_compliance'),
      titleLanguage: categoryScore(analysis, 'title_language'),
    },
    blockingFindingKeys: (analysis.localStandards?.findings || [])
      .filter((finding: any) => finding.blocking)
      .map((finding: any) => finding.key),
    advisoryFindingKeys: (analysis.localStandards?.findings || [])
      .filter((finding: any) => !finding.blocking)
      .map((finding: any) => finding.key),
    mixedOwnership: {
      total: mixedOwnershipNodes.length,
      splitSafe: mixedOwnershipNodes.filter((node: any) => node.splitSafe).length,
      containmentSafe: mixedOwnershipNodes.filter((node: any) => node.containmentSafe).length,
      unsplittable: mixedOwnershipNodes.filter((node: any) => !node.splitSafe && !node.containmentSafe).length,
    },
    tableCandidates: {
      total: context.tableCandidates.length,
      safe: context.tableCandidates.filter(candidate => candidate.repairMode === 'safe').length,
      deferred: context.tableCandidates.filter(candidate => candidate.repairMode === 'defer').length,
      withHeaders: context.tableCandidates.filter(candidate => candidate.hasHeaders).length,
    },
    fontSignals: {
      unembeddedFontCount: context.qpdf.unembeddedFontCount ?? 0,
      fontsMissingToUnicode: context.qpdf.fontsMissingToUnicode ?? 0,
      fontsMissingToUnicodeBlocking: context.qpdf.fontsMissingToUnicodeBlocking ?? 0,
      cidSetRiskFontCount: context.qpdf.cidSetRiskFontCount ?? 0,
      legacyWidthRiskFontCount: context.qpdf.legacyWidthRiskFontCount ?? 0,
    },
    pageTabsFindingCount: (analysis.localStandards?.findings || [])
      .filter((finding: any) => finding.key === 'pdfua.page_tabs')
      .reduce((sum: number, finding: any) => sum + (Number(finding.count) || 1), 0),
    annotationAltContentsCount: (analysis.localStandards?.findings || [])
      .filter((finding: any) => finding.key === 'pdfua.annotation_alt_contents')
      .reduce((sum: number, finding: any) => sum + (Number(finding.count) || 1), 0),
    acrobatAltRiskCount: acrobatAltRiskNodes.length,
    highConfidenceUntaggedTables: tableStructure.highConfidenceUntaggedTables ?? tableStructure.untaggedTables ?? 0,
    advisoryUntaggedTables: tableStructure.advisoryUntaggedTables ?? 0,
    structureSignals: {
      structuralNodeCount: context.structure.structuralNodes?.length ?? 0,
      readingOrderNodeCount: context.structure.readingOrderNodes?.length ?? 0,
      readingOrderParentCount: context.structure.readingOrderParents?.length ?? 0,
      figureCount: context.structure.figures?.length ?? 0,
      headingCount: context.structure.headings?.length ?? 0,
      imageStructNodeCount: context.structure.imageStructNodes?.length ?? 0,
    },
    autoRunnableKeys: artifacts.failureProfile.toolOpportunities
      .filter((opportunity: any) => opportunity.status === 'auto_runnable')
      .map((opportunity: any) => opportunity.key),
    ...extra,
  }
}

async function analyzeForTrace(buffer: Buffer, filename: string) {
  return analyzePDF(buffer, filename, {
    analysisProfile: 'remediation_fast',
    skipAdobe: true,
    skipVeraPdf: false,
  })
}

async function traceFile(filename: string): Promise<AnnualReportTraceFile> {
  const pdfPath = path.join(repoRoot(), 'Downloads', filename)
  let buffer = await fs.readFile(pdfPath) as Buffer
  let analysis = await analyzeForTrace(buffer, filename)
  const actions: RemediationActionRecord[] = []
  const steps: AnnualReportTraceStep[] = [
    await summarizeStep('baseline', filename, buffer, analysis, actions),
  ]

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const outcome = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'normalize_document_metadata',
        arguments: { target: 'document' },
        rationale: 'Annual-report metadata-first closure trace.',
        confidence: 0.95,
      },
    })
    buffer = outcome.buffer
    actions.push(outcome.action)
    analysis = await analyzeForTrace(buffer, filename)
    steps.push(await summarizeStep('normalize_document_metadata', filename, buffer, analysis, actions, {
      outcome: outcome.action.outcome,
      changedDocumentBytes: outcome.action.changedDocumentBytes,
    }))
  }

  {
    let context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const nativeOpportunity = buildFailureProfileArtifacts({
      analysis,
      context,
      actions,
      rejectedActions: [],
    }).failureProfile.toolOpportunities.find((opportunity: any) =>
      opportunity.status === 'auto_runnable' && opportunity.toolName === 'repair_native_table_headers',
    )
    if (nativeOpportunity) {
      const outcome = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name: 'repair_native_table_headers',
          arguments: { target: 'document' },
          rationale: 'Annual-report native table-regularity trace.',
          confidence: 0.92,
        },
      })
      buffer = outcome.buffer
      actions.push(outcome.action)
      analysis = await analyzeForTrace(buffer, filename)
      steps.push(await summarizeStep('repair_native_table_headers', filename, buffer, analysis, actions, {
        outcome: outcome.action.outcome,
        changedDocumentBytes: outcome.action.changedDocumentBytes,
      }))
    }
  }

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const tabsOpportunity = buildFailureProfileArtifacts({
      analysis,
      context,
      actions,
      rejectedActions: [],
    }).failureProfile.toolOpportunities.find((opportunity: any) =>
      opportunity.status === 'auto_runnable' && opportunity.toolName === 'set_page_tabs',
    )
    if (tabsOpportunity) {
      const outcome = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name: 'set_page_tabs',
          arguments: { target: 'document' },
          rationale: 'Annual-report page-tab cleanup trace.',
          confidence: 0.9,
        },
      })
      buffer = outcome.buffer
      actions.push(outcome.action)
      analysis = await analyzeForTrace(buffer, filename)
      steps.push(await summarizeStep('set_page_tabs', filename, buffer, analysis, actions, {
        outcome: outcome.action.outcome,
        changedDocumentBytes: outcome.action.changedDocumentBytes,
      }))
    }
  }

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const tabOrderOpportunity = buildFailureProfileArtifacts({
      analysis,
      context,
      actions,
      rejectedActions: [],
    }).failureProfile.toolOpportunities.find((opportunity: any) =>
      opportunity.status === 'auto_runnable' && opportunity.toolName === 'normalize_annotation_tab_order',
    )
    if (tabOrderOpportunity) {
      const outcome = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name: 'normalize_annotation_tab_order',
          arguments: { target: 'document' },
          rationale: 'Annual-report annotation tab-order cleanup trace.',
          confidence: 0.9,
        },
      })
      buffer = outcome.buffer
      actions.push(outcome.action)
      analysis = await analyzeForTrace(buffer, filename)
      steps.push(await summarizeStep('normalize_annotation_tab_order', filename, buffer, analysis, actions, {
        outcome: outcome.action.outcome,
        changedDocumentBytes: outcome.action.changedDocumentBytes,
      }))
    }
  }

  {
    let batchChanged = false
    let batchOutcome = 'no_effect'
    let context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const linkOpportunities = buildFailureProfileArtifacts({
      analysis,
      context,
      actions,
      rejectedActions: [],
    }).failureProfile.toolOpportunities.filter((opportunity: any) =>
      opportunity.status === 'auto_runnable' && opportunity.toolName === 'set_link_annotation_contents',
    )
    const candidateIds = new Set(linkOpportunities.flatMap((opportunity: any) => opportunity.candidateIds || []))
    const candidates = context.linkCandidates.filter(candidate => candidateIds.has(candidate.id))
    for (const candidate of candidates.slice(0, 24)) {
      const outcome = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name: 'set_link_annotation_contents',
          arguments: { candidateId: candidate.id, pageNumber: candidate.pageNumber, annotationIndex: candidate.annotationIndex, contents: candidate.text },
          rationale: 'Annual-report annotation alternate-description trace batch.',
          confidence: 0.9,
        },
      })
      buffer = outcome.buffer
      actions.push(outcome.action)
      if (outcome.action.outcome === 'applied') batchOutcome = 'applied'
      batchChanged = batchChanged || !!outcome.action.changedDocumentBytes
      analysis = await analyzeForTrace(buffer, filename)
      context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    }
    if (candidates.length) {
      steps.push(await summarizeStep('set_link_annotation_contents_batch', filename, buffer, analysis, actions, {
        outcome: batchOutcome,
        changedDocumentBytes: batchChanged,
      }))
    }
  }

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const embedOpportunity = buildFailureProfileArtifacts({
      analysis,
      context,
      actions,
      rejectedActions: [],
    }).failureProfile.toolOpportunities.find((opportunity: any) =>
      opportunity.status === 'auto_runnable' && opportunity.toolName === 'embed_missing_fonts_in_place',
    )
    if (embedOpportunity) {
      const outcome = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name: 'embed_missing_fonts_in_place',
          arguments: { target: 'document' },
          rationale: 'Annual-report font embedding trace.',
          confidence: 0.9,
        },
      })
      buffer = outcome.buffer
      actions.push(outcome.action)
      analysis = await analyzeForTrace(buffer, filename)
      steps.push(await summarizeStep('embed_missing_fonts_in_place', filename, buffer, analysis, actions, {
        outcome: outcome.action.outcome,
        changedDocumentBytes: outcome.action.changedDocumentBytes,
      }))
    }
  }

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const fontOpportunity = buildFailureProfileArtifacts({
      analysis,
      context,
      actions,
      rejectedActions: [],
    }).failureProfile.toolOpportunities.find((opportunity: any) =>
      opportunity.status === 'auto_runnable' && opportunity.toolName === 'repair_font_unicode_maps',
    )
    if (fontOpportunity) {
      const outcome = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name: 'repair_font_unicode_maps',
          arguments: { target: 'document' },
          rationale: 'Annual-report font Unicode closure trace.',
          confidence: 0.9,
        },
      })
      buffer = outcome.buffer
      actions.push(outcome.action)
      analysis = await analyzeForTrace(buffer, filename)
      steps.push(await summarizeStep('repair_font_unicode_maps', filename, buffer, analysis, actions, {
        outcome: outcome.action.outcome,
        changedDocumentBytes: outcome.action.changedDocumentBytes,
      }))
    }
  }

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const type1Opportunity = buildFailureProfileArtifacts({
      analysis,
      context,
      actions,
      rejectedActions: [],
    }).failureProfile.toolOpportunities.find((opportunity: any) =>
      opportunity.status === 'auto_runnable' && opportunity.toolName === 'repair_type1_font_unicode_maps',
    )
    if (type1Opportunity) {
      const outcome = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name: 'repair_type1_font_unicode_maps',
          arguments: { target: 'document' },
          rationale: 'Annual-report Type1 font Unicode trace.',
          confidence: 0.9,
        },
      })
      buffer = outcome.buffer
      actions.push(outcome.action)
      analysis = await analyzeForTrace(buffer, filename)
      steps.push(await summarizeStep('repair_type1_font_unicode_maps', filename, buffer, analysis, actions, {
        outcome: outcome.action.outcome,
        changedDocumentBytes: outcome.action.changedDocumentBytes,
      }))
    }
  }

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const nativeMarkedContentOpportunity = buildFailureProfileArtifacts({
      analysis,
      context,
      actions,
      rejectedActions: [],
    }).failureProfile.toolOpportunities.find((opportunity: any) =>
      opportunity.status === 'auto_runnable' && opportunity.toolName === 'repair_native_marked_content_refs',
    )
    if (nativeMarkedContentOpportunity) {
      const outcome = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name: 'repair_native_marked_content_refs',
          arguments: { target: 'document' },
          rationale: 'Annual-report native marked-content bridge trace.',
          confidence: 0.9,
        },
      })
      buffer = outcome.buffer
      actions.push(outcome.action)
      analysis = await analyzeForTrace(buffer, filename)
      steps.push(await summarizeStep('repair_native_marked_content_refs', filename, buffer, analysis, actions, {
        outcome: outcome.action.outcome,
        changedDocumentBytes: outcome.action.changedDocumentBytes,
      }))
    }
  }

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const artifactOpportunity = buildFailureProfileArtifacts({
      analysis,
      context,
      actions,
      rejectedActions: [],
    }).failureProfile.toolOpportunities.find((opportunity: any) =>
      opportunity.status === 'auto_runnable' && opportunity.toolName === 'artifact_nonsemantic_page_elements',
    )
    if (artifactOpportunity) {
      const outcome = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name: 'artifact_nonsemantic_page_elements',
          arguments: { target: 'document' },
          rationale: 'Annual-report nonsemantic artifact cleanup trace.',
          confidence: 0.88,
        },
      })
      buffer = outcome.buffer
      actions.push(outcome.action)
      analysis = await analyzeForTrace(buffer, filename)
      steps.push(await summarizeStep('artifact_nonsemantic_page_elements', filename, buffer, analysis, actions, {
        outcome: outcome.action.outcome,
        changedDocumentBytes: outcome.action.changedDocumentBytes,
      }))
    }
  }

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const bootstrappedChartOpportunity = buildFailureProfileArtifacts({
      analysis,
      context,
      actions,
      rejectedActions: [],
    }).failureProfile.toolOpportunities.find((opportunity: any) =>
      opportunity.status === 'auto_runnable' && opportunity.toolName === 'repair_bootstrapped_chart_content_refs',
    )
    if (bootstrappedChartOpportunity) {
      const outcome = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name: 'repair_bootstrapped_chart_content_refs',
          arguments: { target: 'document' },
          rationale: 'Annual-report bootstrapped chart content-ref trace.',
          confidence: 0.82,
        },
      })
      buffer = outcome.buffer
      actions.push(outcome.action)
      analysis = await analyzeForTrace(buffer, filename)
      steps.push(await summarizeStep('repair_bootstrapped_chart_content_refs', filename, buffer, analysis, actions, {
        outcome: outcome.action.outcome,
        changedDocumentBytes: outcome.action.changedDocumentBytes,
      }))
    }
  }

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const headingOpportunity = buildFailureProfileArtifacts({
      analysis,
      context,
      actions,
      rejectedActions: [],
    }).failureProfile.toolOpportunities.find((opportunity: any) =>
      opportunity.status === 'auto_runnable' && opportunity.toolName === 'normalize_heading_hierarchy',
    )
    if (headingOpportunity) {
      const outcome = await executeRemediationTool({
        buffer,
        context,
        call: {
          tool_name: 'normalize_heading_hierarchy',
          arguments: { target: 'document' },
          rationale: 'Annual-report heading and role-map normalization trace.',
          confidence: 0.88,
        },
      })
      buffer = outcome.buffer
      actions.push(outcome.action)
      analysis = await analyzeForTrace(buffer, filename)
      steps.push(await summarizeStep('normalize_heading_hierarchy', filename, buffer, analysis, actions, {
        outcome: outcome.action.outcome,
        changedDocumentBytes: outcome.action.changedDocumentBytes,
      }))
    }
  }

  {
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const outcome = await executeRemediationTool({
      buffer,
      context,
      call: {
        tool_name: 'repair_structure_conformance',
        arguments: { target: 'document' },
        rationale: 'Annual-report final logical-structure convergence trace.',
        confidence: 0.9,
      },
    })
    buffer = outcome.buffer
    actions.push(outcome.action)
    analysis = await analyzeForTrace(buffer, filename)
    steps.push(await summarizeStep('repair_structure_conformance_logical', filename, buffer, analysis, actions, {
      outcome: outcome.action.outcome,
      changedDocumentBytes: outcome.action.changedDocumentBytes,
    }))
  }

  return { filename, steps }
}

async function main() {
  const filenames = process.argv.slice(2)
  const targetFiles = filenames.length ? filenames : [...DEFAULT_FILES]
  const files: AnnualReportTraceFile[] = []
  for (const filename of targetFiles) {
    files.push(await traceFile(filename))
  }

  const artifact: AnnualReportTraceArtifact = {
    generatedAt: new Date().toISOString(),
    files,
  }

  const outputDir = path.join(repoRoot(), 'MitigationAttempts', 'annual-report-traces')
  await fs.mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${timestampForFilename(new Date())}.annual-report-trace.json`)
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
