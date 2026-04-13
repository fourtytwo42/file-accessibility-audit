import type { AnalysisResult } from '../../api/src/services/pdfAnalyzer.ts'
import type { PdfRemediationContext } from '../../api/src/services/pdfRemediationTools.ts'

const CAP = 120

function trimArray<T>(arr: T[] | undefined, max: number): { items: T[]; total: number } {
  if (!arr?.length) return { items: [], total: 0 }
  return { items: arr.slice(0, max), total: arr.length }
}

export function summarizeAnalysis(result: AnalysisResult, full: boolean): unknown {
  const blocking = result.localStandards?.findings
    ?.filter(f => f.blocking)
    .map(f => ({ key: f.key, label: f.label, evidence: f.evidence?.slice(0, 3) }))
    ?? []

  const base = {
    filename: result.filename,
    pageCount: result.pageCount,
    overallScore: result.overallScore,
    grade: result.grade,
    isScanned: result.isScanned,
    executiveSummary: result.executiveSummary,
    verapdf: {
      status: result.verapdf.status,
      failedChecks: result.verapdf.failedChecks,
      passedChecks: result.verapdf.passedChecks,
      topFailures: result.verapdf.failures?.slice(0, 12).map(f => f.message) ?? [],
    },
    categories: result.categories.map(c => ({
      id: c.id,
      label: c.label,
      score: c.score,
      findings: c.findings.slice(0, 8),
    })),
    blockingLocalFindings: blocking.slice(0, 40),
    warnings: result.warnings.slice(0, 20),
  }

  if (!full) return base

  return {
    ...result,
    verapdf: result.verapdf,
  }
}

export function serializeRemediationContext(ctx: PdfRemediationContext): unknown {
  const fig = trimArray(ctx.figureCandidates, CAP)
  const head = trimArray(ctx.headingCandidates, CAP)
  const tbl = trimArray(ctx.tableCandidates, CAP)
  const links = trimArray(ctx.linkCandidates, CAP)
  const ro = trimArray(ctx.readingOrderCandidates, CAP)
  const rop = trimArray(ctx.readingOrderParentCandidates, CAP)

  return {
    structure: {
      status: ctx.structure?.status,
      warnings: (ctx.structure?.warnings || []).slice(0, 12),
    },
    qpdf: {
      hasStructTree: ctx.qpdf?.hasStructTree,
      imageCount: ctx.qpdf?.images?.length,
      outlineCount: ctx.qpdf?.outlineCount,
    },
    figureCandidates: { total: fig.total, items: fig.items },
    headingCandidates: { total: head.total, items: head.items },
    tableCandidates: { total: tbl.total, items: tbl.items },
    linkCandidates: { total: links.total, items: links.items },
    readingOrderCandidates: { total: ro.total, items: ro.items },
    readingOrderParentCandidates: { total: rop.total, items: rop.items },
    pagesSummary: {
      count: ctx.pages?.length ?? 0,
      sample: (ctx.pages || []).slice(0, 5).map(p => ({
        pageNumber: p.pageNumber,
        imageCount: p.imageCount,
        textLineCount: p.textLines?.length ?? 0,
        linkCount: p.links?.length ?? 0,
      })),
    },
  }
}
