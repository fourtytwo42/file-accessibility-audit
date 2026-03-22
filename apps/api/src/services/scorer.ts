import {
  SCORING_WEIGHTS,
  GRADE_THRESHOLDS,
  SEVERITY_THRESHOLDS,
  ANALYSIS,
} from '#config'
import type { QpdfResult } from './qpdfService.js'
import type { PdfjsResult } from './pdfjsService.js'
import type { StructureBackendMutationResult } from './pdfStructureBackend.js'
import { emptyVeraPdfResult, type VeraPdfFailure, type VeraPdfResult } from './veraPdfService.js'
import { ALT_REMOVAL_MODES } from './altTextScoring.js'
import type { AdobeSummary } from './documentModel.js'
import type { ReadingOrderResult } from './readingOrderService.js'
import type { ColorContrastResult } from './colorContrastService.js'
import type { TableStructureResult } from './tableStructureService.js'
import type { TabOrderResult } from './tabOrderService.js'
import type { LocalStandardsFinding, LocalStandardsReport } from './localStandardsService.js'
import { isAdvisoryTableRegularity } from './tableRegularityHeuristics.js'

export interface HelpLink {
  label: string
  url: string
}

export interface CategoryResult {
  id: string
  label: string
  weight: number
  score: number | null // null = N/A
  grade: string | null
  severity: string | null
  findings: string[]
  explanation: string
  helpLinks: HelpLink[]
}

export interface ScoringResult {
  overallScore: number
  grade: string
  isScanned: boolean
  executiveSummary: string
  verapdf: VeraPdfResult
  localStandards?: LocalStandardsReport
  adobe?: AdobeSummary | null
  categories: CategoryResult[]
  warnings: string[]
}

const EXPLICIT_HEADING_TAG_RE = /^\/H(?:[1-6])?$/i
const LEGACY_HEADING_TAG_RE = /^\/heading\s+\d+$/i

type ProvisionalCategoryId = 'reading_order' | 'color_contrast'

export function isRawUrlLinkText(text: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(text.trim())
}

export function isGenericLinkText(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
  return (ANALYSIS.GENERIC_LINK_TEXT_PATTERNS as string[]).includes(normalized)
}

export function summarizeLinkTextQuality(links: Array<{ url: string; text: string }>) {
  const rawLinks = links.filter(link => isRawUrlLinkText(link.text))
  const genericLinks = links.filter(link => !isRawUrlLinkText(link.text) && isGenericLinkText(link.text))
  return {
    linkCount: links.length,
    rawUrlLinkCount: rawLinks.length,
    rawUrlLinkDensity: links.length > 0 ? rawLinks.length / links.length : 0,
    descriptiveLinks: links.filter(link => !isRawUrlLinkText(link.text) && !isGenericLinkText(link.text)),
    rawLinks,
    genericLinks,
    genericLinkCount: genericLinks.length,
  }
}

function getGrade(score: number): string {
  for (const t of GRADE_THRESHOLDS) {
    if (score >= t.min) return t.grade
  }
  return 'F'
}

function getSeverity(score: number | null): string | null {
  if (score === null) return null
  for (const t of SEVERITY_THRESHOLDS) {
    if (score >= t.min) return t.severity
  }
  return 'Critical'
}

function veraPdfWarning(result: VeraPdfResult): string | null {
  if (result.status === 'failed') {
    return `veraPDF detected ${result.failedChecks} PDF/UA compliance issue${result.failedChecks === 1 ? '' : 's'}.`
  }
  if (result.status === 'unavailable') return 'veraPDF standards validation could not run because the CLI is unavailable.'
  if (result.status === 'timeout') return 'veraPDF standards validation timed out before completion.'
  if (result.status === 'parse_error') return 'veraPDF standards validation returned output that could not be parsed.'
  if (result.status === 'error') return result.message || 'veraPDF standards validation failed.'
  return null
}

function appendVeraPdfFinding(category: CategoryResult, failureCount: number): CategoryResult {
  const finding = `veraPDF detected ${failureCount} related PDF/UA compliance issue${failureCount === 1 ? '' : 's'}.`
  if (category.findings.includes(finding)) return category
  return {
    ...category,
    findings: [...category.findings, finding],
  }
}

function applyAdobeEvidence(categories: CategoryResult[], adobe?: AdobeSummary | null): CategoryResult[] {
  if (!adobe || adobe.status !== 'failed' || !adobe.findings.length) return categories

  const counts = new Map<string, number>()
  for (const finding of adobe.findings) {
    if (!finding.categoryId || finding.severity !== 'error') continue
    counts.set(finding.categoryId, (counts.get(finding.categoryId) || 0) + 1)
  }

  return categories.map(category => {
    const count = counts.get(category.id) || 0
    if (!count || category.score === null) return category
    const score = Math.min(category.score, category.id === 'alt_text' ? 60 : 75)
    const note = `Adobe Accessibility Checker reported ${count} related issue${count === 1 ? '' : 's'}.`
    return {
      ...category,
      score,
      grade: getGrade(score),
      severity: getSeverity(score),
      findings: category.findings.includes(note) ? category.findings : [...category.findings, note],
    }
  })
}

function applyVeraPdfEvidence(categories: CategoryResult[], verapdf: VeraPdfResult): {
  categories: CategoryResult[]
  unmatchedFailures: VeraPdfFailure[]
} {
  if (verapdf.status !== 'failed' || !verapdf.failures.length) {
    return { categories, unmatchedFailures: [] }
  }

  const counts = new Map<string, number>()
  const unmatchedFailures: VeraPdfFailure[] = []
  for (const failure of verapdf.failures) {
    if (!failure.categoryIds.length) {
      unmatchedFailures.push(failure)
      continue
    }
    for (const categoryId of failure.categoryIds) {
      counts.set(categoryId, (counts.get(categoryId) || 0) + 1)
    }
  }

  const nextCategories = categories.map((category) => {
    const failureCount = counts.get(category.id) || 0
    if (!failureCount || category.score === null) return category

    const cappedScore = (() => {
      if (category.id === 'title_language') return failureCount > 1 ? 50 : 75
      if (category.id === 'bookmarks') return failureCount > 1 ? 40 : 60
      return failureCount > 1 ? 40 : 60
    })()

    const score = Math.min(category.score, cappedScore)
    return appendVeraPdfFinding({
      ...category,
      score,
      grade: getGrade(score),
      severity: getSeverity(score),
    }, failureCount)
  })

  return {
    categories: nextCategories,
    unmatchedFailures,
  }
}

function scorePdfUaCompliance(verapdf: VeraPdfResult): CategoryResult {
  const explanation = 'PDF/UA Compliance reflects veraPDF validation of the final document against PDF/UA requirements. It complements heuristic category scoring by measuring whether the document as a whole satisfies machine-checkable accessibility conformance rules.'
  const helpLinks: HelpLink[] = [
    { label: 'veraPDF Project', url: 'https://verapdf.org/home/' },
    { label: 'W3C: PDF Techniques', url: 'https://www.w3.org/WAI/WCAG21/Techniques/pdf/' },
    { label: 'Adobe: Create and Verify PDF Accessibility', url: 'https://helpx.adobe.com/acrobat/using/create-verify-pdf-accessibility.html' },
  ]

  if (verapdf.status === 'passed') {
    return {
      id: 'pdf_ua_compliance',
      label: 'PDF/UA Compliance',
      weight: SCORING_WEIGHTS.pdf_ua_compliance,
      score: 100,
      grade: 'A',
      severity: 'Pass',
      findings: ['veraPDF passed PDF/UA validation.', 'The document meets the current machine-checkable PDF/UA compliance checks.'],
      explanation,
      helpLinks,
    }
  }

  const failureCount = verapdf.failedChecks || verapdf.failures.length
  if (verapdf.status === 'failed') {
    const score = failureCount <= 2 ? 85 : failureCount <= 10 ? 70 : failureCount <= 25 ? 40 : 20
    const findings = [
      `veraPDF reported ${failureCount} PDF/UA compliance issue${failureCount === 1 ? '' : 's'}.`,
      verapdf.message || 'The document still has standards-level PDF/UA validation failures.',
    ]
    if (failureCount <= 2) {
      findings.push('The document appears close to compliant, but the remaining standards failures still block a full pass.')
    } else {
      findings.push('The remaining standards failures are material enough that the document should not be treated as PDF/UA compliant yet.')
    }
    return {
      id: 'pdf_ua_compliance',
      label: 'PDF/UA Compliance',
      weight: SCORING_WEIGHTS.pdf_ua_compliance,
      score,
      grade: getGrade(score),
      severity: getSeverity(score),
      findings,
      explanation,
      helpLinks,
    }
  }

  return {
    id: 'pdf_ua_compliance',
    label: 'PDF/UA Compliance',
    weight: SCORING_WEIGHTS.pdf_ua_compliance,
    score: 60,
    grade: getGrade(60),
    severity: getSeverity(60),
    findings: [
      veraPdfWarning(verapdf) || 'Legacy veraPDF validation is disabled.',
      'PDF/UA compliance scoring is being derived from local standards evidence instead of veraPDF.',
    ],
    explanation,
    helpLinks,
  }
}

function localStandardsWarning(report: LocalStandardsReport): string | null {
  if (report.status !== 'issues_detected') return null
  const blockingCount = report.findings.filter(finding => finding.blocking).reduce((sum, finding) => sum + Math.max(1, finding.count || 1), 0)
  if (blockingCount > 0) return `Local standards checks detected ${blockingCount} PDF/UA-related issue${blockingCount === 1 ? '' : 's'}.`
  return 'Local standards checks found potential PDF/UA-related issues that need review.'
}

function applyLocalStandardsEvidence(categories: CategoryResult[], report: LocalStandardsReport): CategoryResult[] {
  if (report.status !== 'issues_detected' || !report.findings.length) return categories
  const counts = new Map<string, number>()
  // Only apply score caps for blocking findings. Non-blocking (advisory/inferred) findings are
  // surfaced as informational without penalizing category scores.
  for (const finding of report.findings.filter(f => f.blocking)) {
    const increment = Math.max(1, finding.count || 1)
    for (const categoryId of finding.categoryIds) {
      counts.set(categoryId, (counts.get(categoryId) || 0) + increment)
    }
  }

  return categories.map(category => {
    const failureCount = counts.get(category.id) || 0
    if (!failureCount || category.score === null) return category
    const cappedScore = category.id === 'title_language'
      ? failureCount > 1 ? 50 : 75
      : category.id === 'bookmarks'
        ? failureCount > 1 ? 40 : 60
        : failureCount > 1 ? 40 : 60
    const score = Math.min(category.score, cappedScore)
    const note = `Local standards checks detected ${failureCount} related PDF/UA issue${failureCount === 1 ? '' : 's'}.`
    return {
      ...category,
      score,
      grade: getGrade(score),
      severity: getSeverity(score),
      findings: category.findings.includes(note) ? category.findings : [...category.findings, note],
    }
  })
}

function scorePdfUaComplianceFromLocal(report: LocalStandardsReport): CategoryResult {
  const blockingFindings = report.findings.filter(finding => finding.blocking)
  const blockingCount = blockingFindings.reduce((sum, finding) => sum + Math.max(1, finding.count || 1), 0)
  // Treat as clean when either there are no findings, or only non-blocking advisory findings remain.
  // Advisory (non-blocking) findings like inferred CIDSet proxies do not represent confirmed failures.
  // Administrative gap keys like 'pdfua.local_coverage_unconfirmed' do not block a clean pass —
  // only semantic gap keys that represent confirmed partial coverage gaps do.
  const SEMANTIC_GAP_KEYS = new Set(['pdfua.artifact_vs_real_content_partial'])
  const hasSemanticGapKey = report.knownGapKeys.some(k => SEMANTIC_GAP_KEYS.has(k))
  const canJustifyCleanPass = !hasSemanticGapKey
    && (report.status === 'clear' || report.findings.every(f => !f.blocking))
  const logicalStructureBlocking = blockingFindings.find(finding => finding.key === 'pdfua.logical_structure')
  const cidsetBlocking = blockingFindings.find(finding => finding.key === 'pdfua.cidset_consistency')
  const languageBlocking = blockingFindings.find(finding => finding.key === 'pdfua.document_language')
  const affectedCategoryCount = new Set(blockingFindings.flatMap(finding => finding.categoryIds)).size
  const explanation = 'PDF/UA Compliance reflects standards-level evidence gathered from local PDF analyzers when veraPDF is skipped or unavailable.'
  const helpLinks: HelpLink[] = [
    { label: 'W3C: PDF Techniques', url: 'https://www.w3.org/WAI/WCAG21/Techniques/pdf/' },
    { label: 'Adobe: Create and Verify PDF Accessibility', url: 'https://helpx.adobe.com/acrobat/using/create-verify-pdf-accessibility.html' },
  ]

  if (canJustifyCleanPass) {
    return {
      id: 'pdf_ua_compliance',
      label: 'PDF/UA Compliance',
      weight: SCORING_WEIGHTS.pdf_ua_compliance,
      score: 100,
      grade: 'A',
      severity: 'Pass',
      findings: ['Local standards checks did not find any PDF/UA blockers.', 'A clean pass was inferred without requiring veraPDF.'],
      explanation,
      helpLinks,
    }
  }

  if (logicalStructureBlocking && (report.knownGapKeys.length > 0 || affectedCategoryCount >= 3) && blockingCount >= 4) {
    return {
      id: 'pdf_ua_compliance',
      label: 'PDF/UA Compliance',
      weight: SCORING_WEIGHTS.pdf_ua_compliance,
      score: 20,
      grade: getGrade(20),
      severity: getSeverity(20),
      findings: [
        `Local standards checks reported ${blockingCount} PDF/UA-related issue${blockingCount === 1 ? '' : 's'}.`,
        'The document is missing fundamental logical-structure evidence, so provisional no-vera scoring remains heavily capped.',
      ],
      explanation,
      helpLinks,
    }
  }

  if (logicalStructureBlocking && cidsetBlocking && (languageBlocking || report.knownGapKeys.length > 0 || affectedCategoryCount >= 3)) {
    return {
      id: 'pdf_ua_compliance',
      label: 'PDF/UA Compliance',
      weight: SCORING_WEIGHTS.pdf_ua_compliance,
      score: 20,
      grade: getGrade(20),
      severity: getSeverity(20),
      findings: [
        `Local standards checks reported ${blockingCount} PDF/UA-related issue${blockingCount === 1 ? '' : 's'}.`,
        'The document still shows combined logical-structure and CID-font conformance blockers, so provisional no-vera scoring remains heavily capped.',
      ],
      explanation,
      helpLinks,
    }
  }

  if (blockingCount === 0) {
    return {
      id: 'pdf_ua_compliance',
      label: 'PDF/UA Compliance',
      weight: SCORING_WEIGHTS.pdf_ua_compliance,
      score: 90,
      grade: getGrade(90),
      severity: getSeverity(90),
      findings: [
        'Local standards checks did not find blockers, but full standards coverage is not yet complete without veraPDF.',
        'The document cannot be treated as a fully confirmed PDF/UA pass yet.',
      ],
      explanation,
      helpLinks,
    }
  }

  const score = blockingCount <= 2 ? 85 : blockingCount <= 10 ? 70 : blockingCount <= 25 ? 40 : 20
  return {
    id: 'pdf_ua_compliance',
    label: 'PDF/UA Compliance',
    weight: SCORING_WEIGHTS.pdf_ua_compliance,
    score,
    grade: getGrade(score),
    severity: getSeverity(score),
    findings: [
      `Local standards checks reported ${blockingCount} PDF/UA-related issue${blockingCount === 1 ? '' : 's'}.`,
      ...blockingFindings.slice(0, 2).flatMap(finding => finding.evidence.slice(0, 1)),
    ],
    explanation,
    helpLinks,
  }
}

interface SummaryContext {
  pdfUaScore: number
  failedChecks: number
  standardsReducedScore: boolean
  scoreGateApplied: boolean
  gradeGateApplied: boolean
}

type AcrobatAltRiskNode = NonNullable<StructureBackendMutationResult['acrobatAltRiskNodes']>[number]
type StructureFigureNode = NonNullable<StructureBackendMutationResult['figures']>[number]
type StructureHeadingNode = NonNullable<StructureBackendMutationResult['headings']>[number]

type AltQuality = 'missing' | 'empty' | 'generic' | 'boilerplate' | 'garbled' | 'citation' | 'overlong' | 'descriptive'

const GENERIC_ALT_TEXT_PATTERNS = new Set(['image', 'photo', 'picture', 'graphic', 'icon', 'logo'])
const GENERIC_HEADING_TEXT_PATTERNS = new Set(['heading', 'title', 'header', 'subtitle'])

function normalizeSemanticText(text: string | null | undefined): string {
  return String(text || '').replace(/^u:/, '').trim().toLowerCase()
}

function isUnreadableAltText(text: string | null | undefined): boolean {
  const raw = String(text || '').replace(/^u:/, '').trim()
  if (!raw) return false
  const tokens = raw.split(/\s+/).filter(Boolean)
  const isolatedGlyphTokens = tokens.filter(token => {
    const normalized = token.replace(/[.,;:!?'"()\-_/\\]/g, '')
    return normalized.length <= 1
  })
  return tokens.length >= 6 && (isolatedGlyphTokens.length / tokens.length) >= 0.65
}

function isFragmentaryAltText(text: string | null | undefined): boolean {
  const raw = String(text || '').replace(/^u:/, '').trim()
  if (!raw) return false
  const words = raw.split(/\s+/).filter(Boolean)
  if (words.length < 6) return false
  const startsLowercase = /^[a-z]/.test(raw)
  const endsWithContinuation = /\b(and|or|but|with|than|to|of|for|in|on|at|by)$/i.test(raw)
  const hasCitationLikeNumber = /\b\d{1,3}\b/.test(raw)
  return startsLowercase || endsWithContinuation || hasCitationLikeNumber
}

function isCitationLikeAltText(text: string | null | undefined): boolean {
  const raw = String(text || '').replace(/^u:/, '').trim()
  if (!raw) return false
  const words = raw.split(/\s+/).filter(Boolean)
  if (words.length < 4) return false
  if (/\b[A-Z][a-z]+,\s*\d{1,3}\s*\(\d+\)/.test(raw)) return true
  if (/\b\d{1,3}\s*\(\d+\),\s*\d+[\u2013\u2014-]\d+\b/.test(raw)) return true
  if (/\b\d{4}\)\s*$/.test(raw) && /[;,]/.test(raw)) return true
  if (/\b\d{1,3}\s*\([1-9]\)\b/.test(raw)) return true
  return /\b(vol\.?|no\.?|issue|journal|pp\.?|doi)\b/i.test(raw)
}

function classifyAltQuality(hasAlt: boolean, altText?: string | null): AltQuality {
  if (!hasAlt) return 'missing'
  if (altText === null || typeof altText === 'undefined') return 'descriptive'
  if (String(altText).trim().length === 0) return 'empty'
  const normalized = normalizeSemanticText(altText)
  if (GENERIC_ALT_TEXT_PATTERNS.has(normalized) || /^image\s+\d+$/i.test(normalized)) return 'generic'
  if (/^(image|picture|photo|graphic)\s+of\b/i.test(normalized)) return 'boilerplate'
  if (isUnreadableAltText(altText)) return 'garbled'
  if (isFragmentaryAltText(altText)) return 'boilerplate'
  if (isCitationLikeAltText(altText)) return 'citation'
  if (normalized.length > 220 || normalized.split(/\s+/).filter(Boolean).length > 32) return 'overlong'
  return 'descriptive'
}

function isGenericHeadingText(text: string | null | undefined): boolean {
  const normalized = normalizeSemanticText(text)
  return !!normalized && GENERIC_HEADING_TEXT_PATTERNS.has(normalized)
}

function effectiveAltFigureStats(
  qpdf: QpdfResult,
  pdfjs: PdfjsResult,
  structure?: Pick<StructureBackendMutationResult, 'figures' | 'imageStructNodes'> | null,
): {
  figures: Array<{ ref: string; hasAlt: boolean; altText?: string; altQuality: AltQuality }>
  withAlt: number
  withDescriptiveAlt: number
  lowQualityAltCount: number
  wrapperExclusionCount: number
  structureCreditApplied: boolean
} {
  const structureFigures = structure?.figures || []
  const structureImageNodes = structure?.imageStructNodes || []
  const pageSummaryByNumber = new Map((pdfjs.pages || []).map(page => [page.pageNumber, page]))
  const qpdfCanonicalByRef = new Map<string, string>()
  for (const image of qpdf.images) {
    const canonicalRef = image.canonicalRef || image.ref
    if (!canonicalRef) continue
    if (image.ref) qpdfCanonicalByRef.set(image.ref, canonicalRef)
    qpdfCanonicalByRef.set(canonicalRef, canonicalRef)
  }
  const collapseFigureVariants = <T extends { ref: string; hasAlt: boolean; altText?: string | null; splitSourceRef?: string | null }>(
    figures: T[],
  ): Array<{ ref: string; hasAlt: boolean; altText?: string; altQuality: AltQuality }> => {
    const byCanonicalRef = new Map<string, { ref: string; hasAlt: boolean; altText?: string; altQuality: AltQuality }>()
    for (const figure of figures) {
      const rawCanonicalRef = figure.splitSourceRef || figure.ref
      const canonicalRef = qpdfCanonicalByRef.get(rawCanonicalRef) || rawCanonicalRef
      const existing = byCanonicalRef.get(canonicalRef)
      const nextQuality = classifyAltQuality(!!figure.hasAlt, figure.altText)
      if (!existing) {
        byCanonicalRef.set(canonicalRef, {
          ref: canonicalRef,
          hasAlt: !!figure.hasAlt,
          altText: figure.altText || undefined,
          altQuality: nextQuality,
        })
        continue
      }
      existing.hasAlt = existing.hasAlt || !!figure.hasAlt
      if (!existing.altText && figure.altText) existing.altText = figure.altText
      if (existing.altQuality !== 'descriptive') {
        if (nextQuality === 'descriptive') existing.altQuality = 'descriptive'
        else if (existing.altQuality === 'missing') existing.altQuality = nextQuality
      }
    }
    return [...byCanonicalRef.values()]
  }
  const excludedWrapperRefs = new Set(
    structureFigures
      .filter(figure =>
        !figure.hasAlt
        && !figure.hasText
        && (figure.splitGenerated || figure.graphicsLikelyDecorative)
      )
      .map(figure => figure.ref),
  )
  const protectedStructureRefs = new Set<string>()
  for (const figure of structureFigures) {
    if (figure.ref) protectedStructureRefs.add(figure.ref)
    if (figure.splitSourceRef) protectedStructureRefs.add(figure.splitSourceRef)
  }
  for (const node of structureImageNodes) {
    if (node.ref) protectedStructureRefs.add(node.ref)
  }
  const excludedOcrBackdropRefs = new Set(
    qpdf.images
      .filter(image => {
        const ref = image.canonicalRef || image.ref
        if (!ref || protectedStructureRefs.has(ref)) return false
        if ((image.placementCount || 0) !== 1) return false
        if (!image.pageNumber) return false
        const pageSummary = pageSummaryByNumber.get(image.pageNumber)
        if (!pageSummary) return false
        return pageSummary.imageCount === 1 && pageSummary.hasMeaningfulText
      })
      .map(image => image.canonicalRef || image.ref),
  )
  const filteredQpdfFigures = collapseFigureVariants(
    qpdf.images
      .filter((img): img is typeof img & { ref: string } =>
        !!img.ref
        && !excludedWrapperRefs.has(img.ref)
        && !excludedOcrBackdropRefs.has(img.canonicalRef || img.ref),
      )
      .map(img => ({
        ref: img.canonicalRef || img.ref,
        hasAlt: img.hasAlt,
        altText: img.altText,
        splitSourceRef: null,
      })),
  )
  const informativeStructureFigures = collapseFigureVariants(
    structureFigures
      .filter(figure => !excludedWrapperRefs.has(figure.ref))
      .map(figure => ({
        ref: figure.ref,
        hasAlt: figure.hasAlt,
        altText: figure.altText,
        splitSourceRef: figure.splitSourceRef || null,
      })),
  )
  const structureTotal = informativeStructureFigures.length
  const structureWithAlt = informativeStructureFigures.filter(figure => figure.hasAlt).length
  const structureWithDescriptiveAlt = informativeStructureFigures.filter(figure => figure.altQuality === 'descriptive').length
  const qpdfWithAlt = filteredQpdfFigures.filter(figure => figure.hasAlt).length
  const qpdfWithDescriptiveAlt = filteredQpdfFigures.filter(figure => figure.altQuality === 'descriptive').length
  const effectiveTotal = Math.max(filteredQpdfFigures.length, structureTotal)
  const effectiveWithAlt = Math.min(effectiveTotal, Math.max(qpdfWithAlt, structureWithAlt))
  const effectiveWithDescriptiveAlt = Math.min(effectiveTotal, Math.max(qpdfWithDescriptiveAlt, structureWithDescriptiveAlt))

  const figures: Array<{ ref: string; hasAlt: boolean; altText?: string; altQuality: AltQuality }> = Array.from({ length: effectiveTotal }, (_, index) => {
    const qpdfFigure = filteredQpdfFigures[index]
    const structureFigure = informativeStructureFigures[index]
    const hasAlt = index < effectiveWithAlt
    return {
      ref: qpdfFigure?.ref || structureFigure?.ref || `structure:${index}`,
      hasAlt,
      altText: qpdfFigure?.altText || structureFigure?.altText || undefined,
      altQuality: hasAlt
        ? (
            qpdfFigure?.altQuality === 'descriptive' || structureFigure?.altQuality === 'descriptive'
              ? 'descriptive'
              : (qpdfFigure?.altQuality || structureFigure?.altQuality || 'empty')
          )
        : 'missing',
    }
  })

  return {
    figures,
    withAlt: effectiveWithAlt,
    withDescriptiveAlt: effectiveWithDescriptiveAlt,
    lowQualityAltCount: figures.filter(figure => !['descriptive', 'missing'].includes(figure.altQuality)).length,
    wrapperExclusionCount: excludedWrapperRefs.size,
    structureCreditApplied: structureWithAlt > qpdfWithAlt || structureTotal > filteredQpdfFigures.length,
  }
}

export function scoreDocument(
  qpdf: QpdfResult,
  pdfjs: PdfjsResult,
  verapdf: VeraPdfResult = emptyVeraPdfResult({
    status: 'passed',
    executionStatus: 'ok',
    isCompliant: true,
    message: 'veraPDF passed PDF/UA validation.',
  }),
  structure?: Pick<StructureBackendMutationResult, 'acrobatAltRiskNodes' | 'figures' | 'imageStructNodes' | 'headings' | 'structuralNodes'> | null,
  adobe?: AdobeSummary | null,
  localStandards: LocalStandardsReport = { status: 'clear', findings: [], knownGapKeys: ['pdfua.local_coverage_unconfirmed'] },
  extras?: {
    readingOrder?: ReadingOrderResult | null
    colorContrast?: ColorContrastResult | null
    tableStructure?: TableStructureResult | null
    tabOrder?: TabOrderResult | null
  },
  options?: {
    provisionalCategoryIds?: ProvisionalCategoryId[]
  },
): ScoringResult {
  let categories: CategoryResult[] = []
  const warnings: string[] = []
  const provisionalCategoryIds = new Set(options?.provisionalCategoryIds || [])

  if (qpdf.error) {
    warnings.push('Some accessibility checks could not be completed. The results below reflect only the checks that succeeded.')
  }
  const veraPdfMessage = veraPdfWarning(verapdf)
  const localStandardsMessage = localStandardsWarning(localStandards)
  if (veraPdfMessage && verapdf.status !== 'failed') {
    warnings.push(veraPdfMessage)
  }
  if (localStandardsMessage && verapdf.status !== 'failed') {
    warnings.push(localStandardsMessage)
  }
  if (adobe?.status === 'failed') {
    warnings.push(adobe.summary)
  } else if (adobe?.status && adobe.status !== 'passed') {
    warnings.push(adobe.summary)
  }

  // 1. Text Extractability (20%)
  const textScore = scoreTextExtractability(qpdf, pdfjs)
  categories.push(textScore)

  const isScanned = !pdfjs.hasText && !qpdf.hasStructTree

  // 2. Document Title & Language (15%)
  categories.push(scoreTitleLanguage(qpdf, pdfjs))

  // 3. Heading Structure (15%)
  categories.push(scoreHeadingStructureWithContent(qpdf, pdfjs, structure))

  // 4. Alt Text on Images (15%)
  categories.push(scoreAltTextWithAcrobatRisk(qpdf, pdfjs, verapdf, structure))

  // 5. Bookmarks / Navigation (10%)
  categories.push(scoreBookmarks(qpdf, pdfjs))

  // 6. Table Markup (10%)
  categories.push(scoreTableMarkup(qpdf, extras?.tableStructure))

  // 7. Link & URL Quality (5%)
  categories.push(scoreLinkQuality(pdfjs))

  // 8. Form Accessibility (5%)
  categories.push(scoreFormAccessibility(qpdf))

  // 9. Reading Order (5%)
  categories.push(provisionalCategoryIds.has('reading_order')
    ? provisionalCategoryResult('reading_order', 'Reading Order', SCORING_WEIGHTS.reading_order, 'Reading-order scoring is provisional during fast remediation analysis.')
    : scoreReadingOrder(qpdf, pdfjs, extras?.readingOrder, extras?.tabOrder, verapdf))

  // 10. Color Contrast (4.5%)
  categories.push(provisionalCategoryIds.has('color_contrast')
    ? provisionalCategoryResult('color_contrast', 'Color Contrast', SCORING_WEIGHTS.color_contrast, 'Color-contrast scoring is provisional during fast remediation analysis.')
    : scoreColorContrast(extras?.colorContrast))

  const useLocalStandardsAsPrimary = true
  const veraPdfAdjusted = applyVeraPdfEvidence(categories, verapdf)
  categories = useLocalStandardsAsPrimary ? applyLocalStandardsEvidence(categories, localStandards) : veraPdfAdjusted.categories
  categories = applyAdobeEvidence(categories, adobe)
  const pdfUaCategory = useLocalStandardsAsPrimary
    ? scorePdfUaComplianceFromLocal(localStandards)
    : scorePdfUaCompliance(verapdf)
  categories.push(pdfUaCategory)
  if (verapdf.status === 'failed') {
    warnings.push(veraPdfMessage || 'veraPDF detected PDF/UA compliance issues.')
    if (veraPdfAdjusted.unmatchedFailures.length) {
      warnings.push('Some veraPDF failures could not be mapped cleanly to an existing category and require manual review.')
    }
  } else if (useLocalStandardsAsPrimary && localStandardsMessage) {
    warnings.push(localStandardsMessage)
  }

  // Calculate weighted average (N/A categories excluded, weights renormalized)
  const applicable = categories.filter(c => c.score !== null)
  const totalWeight = applicable.reduce((sum, c) => sum + c.weight, 0)
  let computedScore = totalWeight > 0
    ? Math.round(applicable.reduce((sum, c) => sum + (c.score! * (c.weight / totalWeight)), 0))
    : 0

  // If local standards are clean (no findings, or only non-blocking advisory findings remain),
  // allow near-perfect heuristic scores to reach 100/100.
  // Administrative gap keys like 'pdfua.local_coverage_unconfirmed' do not block a clean pass —
  // only semantic gap keys that represent confirmed partial coverage gaps do.
  const SEMANTIC_GAP_KEYS_DOC = new Set(['pdfua.artifact_vs_real_content_partial'])
  const hasSemanticGapKeyDoc = localStandards.knownGapKeys.some(k => SEMANTIC_GAP_KEYS_DOC.has(k))
  const localStandardsClean = !hasSemanticGapKeyDoc
    && (localStandards.status === 'clear' || localStandards.findings.every(f => !f.blocking))
  const standardsClean = localStandardsClean
  if (standardsClean && computedScore >= 98) {
    computedScore = 100
  }

  const blockingLocalCount = localStandards.findings
    .filter(finding => finding.blocking)
    .reduce((sum, finding) => sum + Math.max(1, finding.count || 1), 0)
  const severeLocalStructureCap = useLocalStandardsAsPrimary
    && (pdfUaCategory.score ?? 100) <= 20
    && blockingLocalCount >= 20
    && localStandards.knownGapKeys.includes('pdfua.artifact_vs_real_content_partial')
    && localStandards.findings.some(finding => finding.key === 'pdfua.logical_structure')
    && localStandards.findings.some(finding => finding.key === 'pdfua.cidset_consistency')
  if (severeLocalStructureCap) {
    computedScore = Math.min(computedScore, 52)
  }

  const hasIncompleteScoredCategory = applicable.some(category => (
    (category.score ?? 100) < 100
      && category.grade !== 'A'
  ))
  const scoreGateApplied = (!standardsClean && computedScore === 100)
    || (computedScore === 100 && hasIncompleteScoredCategory)
  const overallScore = scoreGateApplied ? 99 : computedScore
  let grade = getGrade(overallScore)
  const gradeGateApplied = ((!standardsClean && grade === 'A') || (hasIncompleteScoredCategory && grade === 'A'))
  if (gradeGateApplied) {
    grade = 'B'
  }
  const effectiveFailedChecks = localStandards.findings.reduce((sum, finding) => sum + Math.max(1, finding.count || 1), 0)
  const executiveSummary = generateSummary(overallScore, grade, isScanned, categories, verapdf, localStandards, {
    pdfUaScore: pdfUaCategory?.score ?? 0,
    failedChecks: effectiveFailedChecks,
    standardsReducedScore: computedScore !== 100 && !standardsClean,
    scoreGateApplied,
    gradeGateApplied,
  })

  return {
    overallScore,
    grade,
    isScanned,
    executiveSummary,
    verapdf,
    localStandards,
    adobe,
    categories,
    warnings,
  }
}

function provisionalCategoryResult(
  id: ProvisionalCategoryId,
  label: string,
  weight: number,
  finding: string,
): CategoryResult {
  return {
    id,
    label,
    weight,
    score: null,
    grade: null,
    severity: null,
    findings: [finding],
    explanation: 'This category was intentionally skipped during the fast remediation loop and will be recomputed during final validation.',
    helpLinks: [],
  }
}

function scoreTextExtractability(qpdf: QpdfResult, pdfjs: PdfjsResult): CategoryResult {
  let score: number
  const findings: string[] = []

  if (pdfjs.hasText && qpdf.hasStructTree) {
    score = 100
    findings.push('PDF contains extractable text')
    findings.push('Document is tagged (StructTreeRoot present)')
    if (pdfjs.textLength) findings.push(`Extracted ${pdfjs.textLength.toLocaleString()} characters of text content`)
  } else if (pdfjs.hasText && !qpdf.hasStructTree) {
    score = 50
    findings.push('PDF contains extractable text')
    findings.push('Document is NOT tagged — no StructTreeRoot found')
    findings.push('How to fix: In Adobe Acrobat, go to Accessibility → Add Tags to Document. Tags create a hidden structure that tells screen readers the reading order, headings, and other elements.')
  } else if (!pdfjs.hasText && qpdf.hasStructTree) {
    score = 25
    findings.push('No extractable text found, but document has tag structure')
    findings.push('This may be a partially tagged scanned document. The images need OCR (Optical Character Recognition) to convert them to real text.')
    findings.push('How to fix: In Adobe Acrobat, go to Scan & OCR → Recognize Text → In This File.')
  } else {
    score = 0
    findings.push('No extractable text found')
    findings.push('No tag structure found')
    findings.push('This PDF appears to be a scanned image — it is essentially a photograph of text. Screen readers cannot read it at all.')
    findings.push('How to fix: (1) Run OCR in Adobe Acrobat: Scan & OCR → Recognize Text. (2) Then add tags: Accessibility → Add Tags to Document.')
  }

  const blockingMissingToUnicode = qpdf.fontsMissingToUnicodeBlocking ?? qpdf.fontsMissingToUnicode ?? 0
  const proxyMissingToUnicode = qpdf.fontsMissingToUnicodeProxy ?? 0
  const advisoryMissingToUnicode = qpdf.fontsMissingToUnicodeAdvisory ?? 0
  if (score === 100 && blockingMissingToUnicode > 0) {
    score = blockingMissingToUnicode <= 2
      ? ANALYSIS.CHARACTER_ENCODING_SCORE_CAP_FEW
      : ANALYSIS.CHARACTER_ENCODING_SCORE_CAP_MANY
    findings.push(`${blockingMissingToUnicode} font object(s) are missing /ToUnicode maps on readable text fonts, so character extraction is not fully reliable.`)
    findings.push('How to fix: repair or regenerate the affected fonts so each embedded font maps used character codes to Unicode.')
  } else if (score === 100 && (proxyMissingToUnicode > 0 || advisoryMissingToUnicode > 0)) {
    const proxyTotal = proxyMissingToUnicode + advisoryMissingToUnicode
    findings.push(`${proxyTotal} legacy or symbol-font object(s) are still missing /ToUnicode maps, but the remaining signal looks advisory rather than active text-loss debt.`)
  }

  return {
    id: 'text_extractability',
    label: 'Text Extractability',
    weight: SCORING_WEIGHTS.text_extractability,
    score,
    grade: getGrade(score),
    severity: getSeverity(score),
    findings,
    explanation: 'Text extractability checks whether the PDF contains real, selectable text (not just images of text) and whether it has a tag structure. Tags are a hidden layer that tells assistive technology — like screen readers — what each piece of content is and in what order to read it. Without extractable text, a screen reader has nothing to work with.',
    helpLinks: [
      { label: 'Adobe: Add Tags to a PDF', url: 'https://helpx.adobe.com/acrobat/using/creating-accessible-pdfs.html' },
      { label: 'Adobe: OCR a Scanned Document', url: 'https://helpx.adobe.com/acrobat/using/edit-scanned-pdfs.html' },
      { label: 'WebAIM: PDF Accessibility', url: 'https://webaim.org/techniques/acrobat/' },
    ],
  }
}

function scoreTitleLanguage(qpdf: QpdfResult, pdfjs: PdfjsResult): CategoryResult {
  let score = 0
  const findings: string[] = []

  // Title check (50 points)
  if (pdfjs.title && pdfjs.title.trim().length > 0) {
    score += 50
    findings.push(`Document title: "${pdfjs.title}"`)
  } else {
    findings.push('No document title found in metadata')
    findings.push('How to fix: In Adobe Acrobat, go to File → Properties → Description tab → enter a descriptive Title.')
    findings.push('The title is what screen readers announce when a user first opens the document. Without it, they hear the filename instead (e.g., "report_v3_final.pdf").')
  }

  // Language check (50 points)
  const hasLang = qpdf.hasLang || !!pdfjs.lang
  if (hasLang) {
    score += 50
    findings.push(`Language declared: ${qpdf.lang || pdfjs.lang}`)
  } else {
    findings.push('No language declaration found')
    findings.push('How to fix: In Adobe Acrobat, go to File → Properties → Advanced tab → set the Language dropdown.')
    findings.push('The language tag tells screen readers which pronunciation rules to use. Without it, a French document might be read with English pronunciation.')
  }

  if (pdfjs.author) findings.push(`Author: ${pdfjs.author}`)

  return {
    id: 'title_language',
    label: 'Document Title & Language',
    weight: SCORING_WEIGHTS.title_language,
    score,
    grade: getGrade(score),
    severity: getSeverity(score),
    findings,
    explanation: 'This category checks two metadata fields: the document title and the language declaration. The title appears in the browser tab and is the first thing a screen reader announces. The language tag tells assistive technology how to pronounce the text correctly.',
    helpLinks: [
      { label: 'Adobe: Set Document Title', url: 'https://helpx.adobe.com/acrobat/using/creating-accessible-pdfs.html' },
      { label: 'WCAG 3.1.1: Language of Page', url: 'https://www.w3.org/WAI/WCAG21/Understanding/language-of-page.html' },
      { label: 'WebAIM: Document Properties', url: 'https://webaim.org/techniques/acrobat/acrobat#document' },
    ],
  }
}

function scoreHeadingStructure(qpdf: QpdfResult, pdfjs?: PdfjsResult): CategoryResult {
  const findings: string[] = []
  const headingExplanation = 'Headings (H1–H6) create a navigable outline of the document. Screen reader users rely on headings to skim and jump between sections — similar to how sighted users scan bold section titles. Headings must follow a logical hierarchy: H1 for the main title, H2 for major sections, H3 for subsections, and so on. Skipping levels (e.g., H1 → H3) confuses assistive technology.'
  const headingLinks: CategoryResult['helpLinks'] = [
    { label: 'Adobe: Add Headings to a PDF', url: 'https://helpx.adobe.com/acrobat/using/editing-document-structure-content-tags.html' },
    { label: 'WCAG 1.3.1: Info and Relationships', url: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html' },
    { label: 'WebAIM: Headings in PDFs', url: 'https://webaim.org/techniques/acrobat/acrobat#702' },
  ]

  if (qpdf.headings.length === 0) {
    return {
      id: 'heading_structure',
      label: 'Heading Structure',
      weight: SCORING_WEIGHTS.heading_structure,
      score: 0,
      grade: 'F',
      severity: 'Critical',
      findings: [
        'No heading tags found in the document structure',
        'How to fix: In Adobe Acrobat, open the Tags panel (View → Show/Hide → Navigation Panes → Tags). Select text that serves as a heading, right-click the corresponding tag, and change its type to H1, H2, etc.',
      ],
      explanation: headingExplanation,
      helpLinks: headingLinks,
    }
  }

  // Show the heading outline
  const headingSummary = qpdf.headings.map(h => h.level).join(', ')
  findings.push(`Heading outline: ${headingSummary}`)

  const hasLegacyOutOfRangeHeading = qpdf.headings.some(h => /^H\d+$/i.test(h.level) && !/^H[1-6]$/i.test(h.level))
  if (hasLegacyOutOfRangeHeading) {
    findings.push('Found legacy heading tags outside H1-H6, which Acrobat treats as invalid heading nesting.')
  }

  const hasNumberedHeadings = qpdf.headings.some(h => /^H[1-6]$/.test(h.level))

  if (!hasNumberedHeadings) {
    findings.push('Only generic /H tags found (not H1–H6). Generic heading tags don\'t convey hierarchy.')
    findings.push('How to fix: In the Tags panel, change each /H tag to a specific level (H1, H2, etc.) that matches the document outline.')
    return {
      id: 'heading_structure',
      label: 'Heading Structure',
      weight: SCORING_WEIGHTS.heading_structure,
      score: 40,
      grade: getGrade(40),
      severity: getSeverity(40),
      findings,
      explanation: headingExplanation,
      helpLinks: headingLinks,
    }
  }

  // Check hierarchy
  const levels = qpdf.headings
    .filter(h => /^H[1-6]$/.test(h.level))
    .map(h => parseInt(h.level.replace('H', '')))

  let hierarchyBroken = hasLegacyOutOfRangeHeading
  let hierarchySkipCount = 0
  let hierarchyResetCount = 0
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1] + 1) {
      hierarchyBroken = true
      hierarchySkipCount += 1
      findings.push(`Heading hierarchy skip: H${levels[i - 1]} → H${levels[i]} (skipped H${levels[i - 1] + 1})`)
    } else if (levels[i] < levels[i - 1]) {
      hierarchyBroken = true
      hierarchyResetCount += 1
      findings.push(`Heading hierarchy reset: H${levels[i - 1]} → H${levels[i]} (descending levels should not restart)`)
    }
  }

  if (hierarchyBroken) {
    const advisoryResetOnlyHierarchy =
      !hasLegacyOutOfRangeHeading
      && hierarchySkipCount === 0
      && hierarchyResetCount > 0
      && hierarchyResetCount <= 2
      && levels.length <= 10
      && (pdfjs?.pageCount ?? 0) > 0
      && (pdfjs?.pageCount ?? 0) <= 4
      && qpdf.formFields.length === 0
      && (qpdf.linkAnnotationCount ?? 0) === 0
    if (advisoryResetOnlyHierarchy) {
      findings.unshift(`Found ${levels.length} heading tags with limited section-level resets`)
      findings.push('The remaining heading resets were treated as an advisory warning because this short document otherwise maintains a stable heading structure without skipped levels or interactive-content debt.')
      return {
        id: 'heading_structure',
        label: 'Heading Structure',
        weight: SCORING_WEIGHTS.heading_structure,
        score: 95,
        grade: getGrade(95),
        severity: getSeverity(95),
        findings,
        explanation: headingExplanation,
        helpLinks: headingLinks,
      }
    }
    findings.unshift(`Found ${levels.length} heading tags, but hierarchy has gaps`)
    findings.push('Heading levels should not skip or restart — e.g., don\'t jump from H1 to H3 or fall back from H2 to H1 in the same outline.')
    return {
      id: 'heading_structure',
      label: 'Heading Structure',
      weight: SCORING_WEIGHTS.heading_structure,
      score: 60,
      grade: getGrade(60),
      severity: getSeverity(60),
      findings,
      explanation: headingExplanation,
      helpLinks: headingLinks,
    }
  }

  findings.push(`Found ${levels.length} heading tags with logical hierarchy`)
  return {
    id: 'heading_structure',
    label: 'Heading Structure',
    weight: SCORING_WEIGHTS.heading_structure,
    score: 100,
    grade: 'A',
    severity: 'Pass',
    findings,
    explanation: headingExplanation,
    helpLinks: headingLinks,
  }
}

function scoreHeadingStructureWithContent(
  qpdf: QpdfResult,
  pdfjs: PdfjsResult,
  structure?: Pick<StructureBackendMutationResult, 'headings' | 'structuralNodes'> | null,
): CategoryResult {
  const category = scoreHeadingStructure(qpdf, pdfjs)
  const findings = [...category.findings]
  let score = category.score ?? 100

  const numberedLevels = qpdf.headings
    .map(heading => heading.level)
    .filter(level => /^H[1-6]$/i.test(level))
  if (numberedLevels.length > 0 && !numberedLevels.some(level => /^H1$/i.test(level))) {
    findings.push('The document contains headings but no main H1 heading was detected.')
    score = Math.min(score, 60)
  }

  const snapshotHeadings = ((structure?.headings || []) as StructureHeadingNode[]).filter(heading =>
    EXPLICIT_HEADING_TAG_RE.test(String(heading.tag || ''))
    || LEGACY_HEADING_TAG_RE.test(String(heading.tag || '')),
  )
  const snapshotHeadingRefs = new Set(snapshotHeadings.map(heading => heading.ref))
  const structuralNodeTagByRef = new Map(
    (structure?.structuralNodes || []).map(node => [node.ref, String(node.tag || '')]),
  )
  const headingContainerRefs = new Set(
    (structure?.structuralNodes || [])
      .map(node => node.parentRef || null)
      .filter((ref): ref is string => !!ref),
  )
  const readableHeadings = snapshotHeadings.filter(heading => normalizeSemanticText(heading.text).length > 0)
  const hasReliableHeadingTextCoverage = readableHeadings.length >= 2
    || (snapshotHeadings.length > 0 && (readableHeadings.length / snapshotHeadings.length) >= 0.5)
  const emptyHeadings = hasReliableHeadingTextCoverage
    ? snapshotHeadings.filter(heading =>
      normalizeSemanticText(heading.text).length === 0
      && !headingContainerRefs.has(heading.ref)
      && !snapshotHeadingRefs.has(String(heading.parentRef || ''))
      && !['/Story', '/Sect', '/Div'].includes(structuralNodeTagByRef.get(String(heading.parentRef || '')) || '')
    )
    : []
  const genericHeadings = snapshotHeadings.filter(heading => isGenericHeadingText(heading.text))
  if (emptyHeadings.length > 0) {
    findings.push(`${emptyHeadings.length} heading tag(s) have no readable heading text.`)
    score = Math.min(score, 60)
  }
  if (genericHeadings.length > 0) {
    findings.push(`${genericHeadings.length} heading tag(s) use generic heading text such as "${String(genericHeadings[0]?.text || '').trim()}".`)
    score = Math.min(score, 60)
  }

  return {
    ...category,
    score,
    grade: getGrade(score),
    severity: getSeverity(score),
    findings,
  }
}

function scoreAltText(
  qpdf: QpdfResult,
  pdfjs: PdfjsResult,
  structure?: Pick<StructureBackendMutationResult, 'figures' | 'imageStructNodes'> | null,
): CategoryResult {
  const altLinks: CategoryResult['helpLinks'] = [
    { label: 'Adobe: Add Alt Text to Images', url: 'https://helpx.adobe.com/acrobat/using/editing-document-structure-content-tags.html#add_alternate_text_to_links_and_figures' },
    { label: 'WCAG 1.1.1: Non-text Content', url: 'https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html' },
    { label: 'WebAIM: Alt Text in PDFs', url: 'https://webaim.org/techniques/acrobat/acrobat#702' },
  ]
  const altExplanation = 'Alternative text (alt text) is a short text description attached to each image in the document. Screen readers read this description aloud so that blind and low-vision users can understand visual content. Every informative image needs alt text. Decorative images (borders, spacers) should be marked as artifacts instead.'

  const {
    figures,
    withAlt,
    withDescriptiveAlt,
    lowQualityAltCount,
    wrapperExclusionCount,
    structureCreditApplied,
  } = effectiveAltFigureStats(qpdf, pdfjs, structure)

  // QPDF found no tagged images, but pdfjs detected image rendering operations.
  // Since QPDF comprehensively parses every indirect object, if it finds zero
  // Image XObjects (/Subtype /Image), the paint operations PDF.js detected are
  // from inline images, Form XObjects, or patterns — elements that are typically
  // decorative and do not need individual alt text. Treat as N/A.
  if (figures.length === 0 && pdfjs.imageCount > 0) {
    return {
      id: 'alt_text',
      label: 'Alt Text on Images',
      weight: SCORING_WEIGHTS.alt_text,
      score: null,
      grade: null,
      severity: null,
      findings: [
        `${pdfjs.imageCount} image rendering operation(s) detected, but no taggable Image XObjects were found in the document structure.`,
        'The detected images are likely inline images, form XObjects, or decorative patterns that do not require individual alt text — this category does not affect the score.',
        'If this document contains informative photos or diagrams, verify manually in Adobe Acrobat\'s Tags panel that they are tagged as <Figure> elements with alt text.',
      ],
      explanation: altExplanation,
      helpLinks: altLinks,
    }
  }

  if (figures.length === 0) {
    return {
      id: 'alt_text',
      label: 'Alt Text on Images',
      weight: SCORING_WEIGHTS.alt_text,
      score: null,
      grade: null,
      severity: null,
      findings: [
        'No images detected in this document — this category does not affect the score',
        'If this document does contain images, they may not be properly tagged as <Figure> elements. Verify manually in Adobe Acrobat\'s Tags panel.',
      ],
      explanation: altExplanation,
      helpLinks: altLinks,
    }
  }

  const score = withAlt === figures.length
    ? 100
    : withDescriptiveAlt === 0
      ? 0
      : Math.round((withDescriptiveAlt / figures.length) * 100)
  const findings: string[] = []

  if (withDescriptiveAlt === figures.length) {
    findings.push(`All ${figures.length} image(s) have alternative text`)
    for (const fig of figures) {
      if (fig.altText) findings.push(`Image alt text: "${fig.altText}"`)
    }
  } else if (withAlt === figures.length) {
    findings.push(`All ${figures.length} image(s) have alternative text`)
    findings.push(`${lowQualityAltCount} image(s) use low-quality alternate text that should be improved, but no detected image is missing alternate text.`)
  } else {
    findings.push(`${withAlt} of ${figures.length} image(s) have alternative text`)
    const missing = figures.filter(f => !f.hasAlt).length
    const lowQuality = figures.filter(f => f.altQuality !== 'descriptive' && f.altQuality !== 'missing').length
    if (missing > 0) findings.push(`${missing} image(s) are missing alt text`)
    if (lowQuality > 0) findings.push(`${lowQuality} image(s) have empty, generic, boilerplate, or overlong alt text that should be rewritten more descriptively.`)
    findings.push('How to fix: In Adobe Acrobat, open the Tags panel → find the <Figure> tag for each image → right-click → Properties → enter a description in the "Alternate Text" field.')
    findings.push('Tip: Good alt text is concise and describes the purpose of the image, not just its appearance. For example, "Bar chart showing 2024 crime rates by county" rather than "chart".')
  }
  if (lowQualityAltCount > 0) {
    findings.push(`${lowQualityAltCount} image(s) use low-quality alternate text such as generic placeholders, boilerplate openings, or overlong descriptions.`)
  }
  if (wrapperExclusionCount > 0) {
    findings.push(`${wrapperExclusionCount} split-generated decorative wrapper figure(s) were excluded from alt-text scoring.`)
  }
  if (structureCreditApplied) {
    findings.push('Tagged figure descriptions recovered from the structure snapshot were used to reconcile image alt-text coverage.')
  }

  return {
    id: 'alt_text',
    label: 'Alt Text on Images',
    weight: SCORING_WEIGHTS.alt_text,
    score,
    grade: getGrade(score),
    severity: getSeverity(score),
    findings,
    explanation: altExplanation,
    helpLinks: altLinks,
  }
}

function describeAcrobatAltRisk(node: AcrobatAltRiskNode): string {
  if (node.ownershipMode === 'mixed_text_graphics_same_mcid') {
    return `${node.tag} mixes text and graphics in the same marked-content block on MCID${node.mcids?.length === 1 ? '' : 's'} ${node.mcids?.join(', ') || 'unknown'}.`
  }
  if (node.ownershipMode === 'duplicate_mcid_ownership') {
    return `${node.tag} shares MCID ownership with ${node.duplicateOwnerRefs?.join(', ') || 'another structure element'}.`
  }
  if (node.ownershipMode === 'container_with_graphics_descendants') {
    return `${node.tag} still directly owns graphics content even though a child bridge already exists.`
  }
  return `${node.tag} owns graphics content but is not tagged as /Figure.`
}

function scoreAltTextWithAcrobatRisk(
  qpdf: QpdfResult,
  pdfjs: PdfjsResult,
  verapdf: VeraPdfResult,
  structure?: Pick<StructureBackendMutationResult, 'acrobatAltRiskNodes' | 'figures' | 'imageStructNodes'> | null,
): CategoryResult {
  const acrobatAltRiskNodes = structure?.acrobatAltRiskNodes || []
  const countsAsSubstantiveAltRisk = (node: AcrobatAltRiskNode): boolean =>
    !node.graphicsLikelyDecorative
    || node.ownershipMode === 'untagged_image_direct'
    || node.ownershipMode === 'untagged_image_mcid'
    || node.ownershipMode === 'nested_alt_text_hides_content'
  const category = scoreAltText(qpdf, pdfjs, structure)
  if (!acrobatAltRiskNodes.length) return category

  const findings = [
    ...(category.findings || []),
    `Detected ${acrobatAltRiskNodes.length} Acrobat-risk non-figure element${acrobatAltRiskNodes.length === 1 ? '' : 's'} with graphics content.`,
    'Acrobat-style alternate-text risk remains because graphics content is still owned by non-/Figure structure elements.',
    ...acrobatAltRiskNodes.slice(0, 3).map(describeAcrobatAltRisk),
  ]

  // Determine which nodes are still unresolved:
  // - orphaned_alt_empty_element / nonfigure_with_alt / nested_alt_text_hides_content:
  //   unresolved if /Alt IS present (needs removal)
  // - all other modes: unresolved if /Alt is NOT present (needs addition)
  const unresolvedRiskNodes = acrobatAltRiskNodes.filter(n =>
    ALT_REMOVAL_MODES.has(n.ownershipMode ?? '') ? n.hasAlt : !n.hasAlt
  )
  const substantiveUnresolvedRiskNodes = unresolvedRiskNodes.filter(countsAsSubstantiveAltRisk)

  if (verapdf.status === 'passed' && category.score === 100) {
    if (!substantiveUnresolvedRiskNodes.length) {
      return {
        ...category,
        findings: [
          ...category.findings,
          'Decorative-looking non-figure graphics were detected, but all informative figures already have compliant alternate text.',
        ],
      }
    }
    if (!unresolvedRiskNodes.length) {
      return {
        ...category,
        findings,
      }
    }
    const hasMixedContentRisk = substantiveUnresolvedRiskNodes.some(n => n.ownershipMode === 'mixed_text_graphics_same_mcid')
    const hasNestedAltRisk = substantiveUnresolvedRiskNodes.some(n => n.ownershipMode === 'nested_alt_text_hides_content')
    const hasUntaggedImageRisk = substantiveUnresolvedRiskNodes.some(n =>
      n.ownershipMode === 'untagged_image_direct' || n.ownershipMode === 'untagged_image_mcid',
    )
    const hasNonFigureAltRisk = substantiveUnresolvedRiskNodes.some(n => n.ownershipMode === 'nonfigure_with_alt')
    const scoreCap = hasUntaggedImageRisk
      ? ANALYSIS.UNTAGGED_IMAGE_ALT_SCORE_CAP
      : hasNestedAltRisk
        ? ANALYSIS.NESTED_ALT_TEXT_SCORE_CAP
        : hasNonFigureAltRisk
          ? ANALYSIS.NONFIGURE_ALT_SCORE_CAP
          : hasMixedContentRisk
            ? 75
            : 85
    return {
      ...category,
      score: scoreCap,
      grade: getGrade(scoreCap),
      severity: getSeverity(scoreCap),
      findings,
    }
  }

  // Nodes that are purely decorative (path/stroke-only — borders, underlines, lines) do not
  // represent real accessibility failures: the text in the MCID is still accessible and the
  // graphics carry no semantic information. Do not cap the score for these.
  const substantiveRiskNodes = acrobatAltRiskNodes.filter(countsAsSubstantiveAltRisk)
  const residualDecorativeMixedCount = acrobatAltRiskNodes.filter(node =>
    node.ownershipMode === 'mixed_text_graphics_same_mcid'
    && node.graphicsLikelyDecorative
    && node.splitSafe,
  ).length
  const residualUntaggedImageCount = acrobatAltRiskNodes.filter(node => node.ownershipMode === 'untagged_image_mcid').length
  if (!substantiveRiskNodes.length) {
    const { figures, withAlt } = effectiveAltFigureStats(qpdf, pdfjs, structure)
    const missingWithoutAlt = Math.max(0, figures.length - withAlt)
    const decorativeAllowance = Math.min(acrobatAltRiskNodes.length, missingWithoutAlt)
    const informativeFigureCount = figures.length - decorativeAllowance
    if (informativeFigureCount > 0) {
      const informativeWithAlt = Math.min(withAlt, informativeFigureCount)
      const adjustedScore = informativeWithAlt === 0
        ? 0
        : Math.round((informativeWithAlt / informativeFigureCount) * 100)
      const adjustedFindings = informativeWithAlt === informativeFigureCount
        ? [
            `All ${informativeFigureCount} informative image(s) have alternative text`,
            `${acrobatAltRiskNodes.length} non-figure element(s) with decorative-only graphics were excluded from alt-text scoring because the graphics are purely decorative (path/stroke operations only).`,
          ]
        : [
            `${informativeWithAlt} of ${informativeFigureCount} informative image(s) have alternative text`,
            `${informativeFigureCount - informativeWithAlt} informative image(s) are missing alt text`,
            `${acrobatAltRiskNodes.length} non-figure element(s) with decorative-only graphics were excluded from alt-text scoring because the graphics are purely decorative (path/stroke operations only).`,
          ]
      return {
        ...category,
        score: adjustedScore,
        grade: getGrade(adjustedScore),
        severity: getSeverity(adjustedScore),
        findings: adjustedFindings,
      }
    }
    return {
      ...category,
      findings: [
        ...category.findings,
        `${acrobatAltRiskNodes.length} non-figure element(s) with decorative-only graphics were detected but do not require alternate text — the graphics are purely decorative (path/stroke operations only).`,
      ],
    }
  }
  const { figures, withAlt: figuresWithAlt } = effectiveAltFigureStats(qpdf, pdfjs, structure)
  const missingFigureCount = Math.max(0, figures.length - figuresWithAlt)
  const allDetectedFiguresHaveAlt = figures.length > 0 && figures.every(fig => fig.hasAlt)
  const guidanceOnlyResidualRisk = substantiveRiskNodes.every(node =>
    node.ownershipMode === 'mixed_text_graphics_same_mcid'
    || node.ownershipMode === 'duplicate_mcid_ownership'
    || node.ownershipMode === 'container_with_graphics_descendants'
  )
  // If any mixed text/graphics node contains content-bearing (non-decorative) graphics, apply the strict cap.
  const hasNonDecorativeMixedContent = substantiveRiskNodes.some(
    n => n.ownershipMode === 'mixed_text_graphics_same_mcid'
  )
  const hasNestedAltRisk = substantiveUnresolvedRiskNodes.some(node => node.ownershipMode === 'nested_alt_text_hides_content')
  const hasUntaggedImageRisk = substantiveUnresolvedRiskNodes.some(node =>
    node.ownershipMode === 'untagged_image_mcid' || node.ownershipMode === 'untagged_image_direct',
  )
  const hasNonFigureAltRisk = substantiveUnresolvedRiskNodes.some(node => node.ownershipMode === 'nonfigure_with_alt')
  const baseScore = category.score === null
    ? (hasUntaggedImageRisk ? ANALYSIS.UNTAGGED_IMAGE_ALT_SCORE_CAP : 100)
    : category.score
  const mostlyDecorativeResidualRisk =
    missingFigureCount === 0
    && residualDecorativeMixedCount >= Math.max(1, acrobatAltRiskNodes.length - residualUntaggedImageCount)
    && residualUntaggedImageCount <= 1
  if (baseScore === 100 && allDetectedFiguresHaveAlt && (guidanceOnlyResidualRisk || mostlyDecorativeResidualRisk)) {
    return {
      ...category,
      findings: [
        ...findings,
        'All detected /Figure elements already have alternate text, so residual Acrobat-risk ownership debt is being reported as structural cleanup guidance rather than unresolved figure-description debt.',
      ],
    }
  }
  if (
    hasNonDecorativeMixedContent
    && figures.length >= 4
    && missingFigureCount === 1
    && baseScore >= 80
  ) {
    const score = Math.min(baseScore, 75)
    return {
      ...category,
      score,
      grade: getGrade(score),
      severity: getSeverity(score),
      findings: [
        ...findings,
        'Most detected figures already have alternate text, so the remaining Acrobat-style ownership debt is being scored with a softer residual cap while one image description is still unresolved.',
      ],
    }
  }
  const scoreCap = hasUntaggedImageRisk
    ? ANALYSIS.UNTAGGED_IMAGE_ALT_SCORE_CAP
    : hasNestedAltRisk
      ? ANALYSIS.NESTED_ALT_TEXT_SCORE_CAP
      : hasNonFigureAltRisk
        ? ANALYSIS.NONFIGURE_ALT_SCORE_CAP
        : hasNonDecorativeMixedContent
    ? (
        substantiveRiskNodes.length === 1
        && substantiveRiskNodes[0]?.splitSafe
        && baseScore >= 60
          ? 60
          : 40
      )
    : 60
  const score = Math.min(baseScore, scoreCap)

  return {
    ...category,
    score,
    grade: getGrade(score),
    severity: getSeverity(score),
    findings,
  }
}

function scoreBookmarks(qpdf: QpdfResult, pdfjs: PdfjsResult): CategoryResult {
  const bookmarkLinks: CategoryResult['helpLinks'] = [
    { label: 'Adobe: Create Bookmarks', url: 'https://helpx.adobe.com/acrobat/using/page-thumbnails-bookmarks-pdfs.html#create_a_bookmark' },
    { label: 'Adobe: Auto-generate Bookmarks from Headings', url: 'https://helpx.adobe.com/acrobat/using/page-thumbnails-bookmarks-pdfs.html' },
    { label: 'WebAIM: PDF Navigation', url: 'https://webaim.org/techniques/acrobat/acrobat#702' },
  ]
  const bookmarkExplanation = 'Bookmarks (also called outlines) create a clickable table of contents in the PDF sidebar. They let all users — including those using screen readers — jump directly to any section. For documents longer than a few pages, bookmarks are essential for navigation. In Adobe Acrobat, bookmarks can be generated automatically from heading tags.'

  if (pdfjs.pageCount < ANALYSIS.BOOKMARKS_PAGE_THRESHOLD) {
    return {
      id: 'bookmarks',
      label: 'Bookmarks / Navigation',
      weight: SCORING_WEIGHTS.bookmarks,
      score: null,
      grade: null,
      severity: null,
      findings: [
        `Document has ${pdfjs.pageCount} page(s) — bookmarks are not required for documents under ${ANALYSIS.BOOKMARKS_PAGE_THRESHOLD} pages`,
        'This category does not affect the score',
      ],
      explanation: bookmarkExplanation,
      helpLinks: bookmarkLinks,
    }
  }

  const hasOutlines = qpdf.hasOutlines || pdfjs.hasOutlines
  const outlineCount = Math.max(qpdf.outlineCount, pdfjs.outlineCount)

  if (hasOutlines && outlineCount > 0) {
    const findings = [`${outlineCount} bookmark(s) found`]
    if (qpdf.outlineTitles?.length > 0) {
      findings.push('Bookmark outline:')
      for (const title of qpdf.outlineTitles) {
        findings.push(`  ${title}`)
      }
    }
    return {
      id: 'bookmarks',
      label: 'Bookmarks / Navigation',
      weight: SCORING_WEIGHTS.bookmarks,
      score: 100,
      grade: 'A',
      severity: 'Pass',
      findings,
      explanation: bookmarkExplanation,
      helpLinks: bookmarkLinks,
    }
  }

  if (hasOutlines && outlineCount === 0) {
    return {
      id: 'bookmarks',
      label: 'Bookmarks / Navigation',
      weight: SCORING_WEIGHTS.bookmarks,
      score: 25,
      grade: getGrade(25),
      severity: getSeverity(25),
      findings: [
        'Outline structure present but contains no entries',
        'How to fix: In Adobe Acrobat, go to the Bookmarks panel (View → Show/Hide → Navigation Panes → Bookmarks). You can create bookmarks manually or auto-generate them from headings (Options menu → New Bookmarks from Structure).',
      ],
      explanation: bookmarkExplanation,
      helpLinks: bookmarkLinks,
    }
  }

  return {
    id: 'bookmarks',
    label: 'Bookmarks / Navigation',
    weight: SCORING_WEIGHTS.bookmarks,
    score: 0,
    grade: 'F',
    severity: 'Critical',
    findings: [
      `Document has ${pdfjs.pageCount} pages but no bookmarks`,
      'How to fix: In Adobe Acrobat, go to the Bookmarks panel. Create bookmarks for each major section, or auto-generate them from heading tags (Options → New Bookmarks from Structure).',
    ],
    explanation: bookmarkExplanation,
    helpLinks: bookmarkLinks,
  }
}

function scoreColorContrast(contrast?: ColorContrastResult | null): CategoryResult {
  const contrastLinks: CategoryResult['helpLinks'] = [
    { label: 'WCAG 1.4.3: Contrast (Minimum)', url: 'https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html' },
    { label: 'WebAIM: Contrast Checker', url: 'https://webaim.org/resources/contrastchecker/' },
    { label: 'Adobe: Check Color Accessibility', url: 'https://helpx.adobe.com/acrobat/using/accessibility-features-pdfs.html' },
  ]
  const contrastExplanation = 'Color contrast measures how readable text is against its background. WCAG requires a contrast ratio of at least 4.5:1 for normal-sized text and 3:1 for large text (18pt or 14pt bold). Low contrast text is difficult or impossible to read for people with low vision or color blindness.'

  if (!contrast || contrast.status === 'unavailable') {
    return {
      id: 'color_contrast',
      label: 'Color Contrast',
      weight: SCORING_WEIGHTS.color_contrast,
      score: null,
      grade: null,
      severity: null,
      findings: [
        'Color contrast analysis is unavailable — required tools (pdftoppm / Pillow / pdfminer) are not installed.',
        'Install poppler-utils, Pillow, and pdfminer.six to enable this check.',
        contrast?.warnings?.[0] ?? '',
      ].filter(Boolean),
      explanation: contrastExplanation,
      helpLinks: contrastLinks,
    }
  }

  if (contrast.status === 'error' || contrast.status === 'timeout') {
    return {
      id: 'color_contrast',
      label: 'Color Contrast',
      weight: SCORING_WEIGHTS.color_contrast,
      score: 50,
      grade: getGrade(50),
      severity: getSeverity(50),
      findings: [
        contrast.status === 'timeout'
          ? 'Color contrast analysis timed out before completing.'
          : `Color contrast analysis encountered an error: ${contrast.warnings?.[0] ?? 'unknown error'}.`,
      ],
      explanation: contrastExplanation,
      helpLinks: contrastLinks,
    }
  }

  // status === 'ok'
  const findings: string[] = []
  const ignorableInvisibleFailures = contrast.failures.filter(failure =>
    failure.contrastRatio <= 1.05 && failure.fgColor.toLowerCase() === failure.bgColor.toLowerCase()
  )
  const ignorablePunctuationFailures = contrast.failures.filter(failure =>
    /^[^a-z0-9]{1,3}$/i.test(failure.textPreview.trim()) && failure.contrastRatio >= 3.0
  )
  const isAdvisoryDisplayText = (text: string): boolean => {
    const normalized = text.trim()
    if (normalized.length < 5) return false
    const tokens = normalized.split(/\s+/).filter(Boolean)
    const singleCharTokens = tokens.filter(token => /^[A-Za-z]$/.test(token))
    if (tokens.length >= 4 && (singleCharTokens.length / tokens.length) >= 0.7) return true
    const compact = normalized.replace(/\s+/g, '')
    if (!/^[A-Z]{6,}$/.test(compact)) return false
    return compact.length <= 18
  }
  const effectiveFailures = contrast.failures.filter(failure =>
    !(failure.contrastRatio <= 1.05 && failure.fgColor.toLowerCase() === failure.bgColor.toLowerCase())
    && !(/^[^a-z0-9]{1,3}$/i.test(failure.textPreview.trim()) && failure.contrastRatio >= 3.0)
  )
  const effectiveFailingCount = effectiveFailures.length
  const effectiveFailRatio = contrast.totalSamples > 0 ? effectiveFailingCount / contrast.totalSamples : 0
  const advisoryDisplayFailures = effectiveFailures.filter(failure => {
    const ratioDelta = failure.threshold - failure.contrastRatio
    const nearThreshold = ratioDelta <= 0.3
    const displaySized = failure.fontSizePt >= 14 && failure.contrastRatio >= 3.0
    const shortFragment = failure.textPreview.trim().length <= 5 && failure.contrastRatio >= 3.0
    const spacedDisplayText = isAdvisoryDisplayText(failure.textPreview) && failure.contrastRatio >= 3.0
    const microDisplayLabel = failure.fontSizePt > 0 && failure.fontSizePt <= 2.5
    const duplicatedDisplayArtifact = /(.)\1/i.test(failure.textPreview.replace(/\s+/g, '')) && failure.contrastRatio >= 3.0
    const tocDotLeader = /[.·•]{4,}/.test(failure.textPreview)
    return nearThreshold || displaySized || shortFragment || spacedDisplayText || microDisplayLabel || duplicatedDisplayArtifact || tocDotLeader
  })
  const materialFailures = effectiveFailures.filter(failure => !advisoryDisplayFailures.includes(failure))
  const residualMediumFailures = materialFailures.filter(failure => failure.contrastRatio >= 3.0)
  const uniqueAdvisoryDisplayElements = new Set(
    advisoryDisplayFailures.map(failure =>
      `${failure.page}|${failure.textPreview.trim().toLowerCase()}|${failure.fgColor.toLowerCase()}|${failure.bgColor.toLowerCase()}|${failure.threshold}`,
    ),
  )
  const concentratedFailurePages = new Set(effectiveFailures.map(failure => failure.page))
  const largeDocumentLowDensityContrastRisk =
    contrast.totalSamples >= 750
    && contrast.pagesAnalyzed >= 8
    && effectiveFailRatio < 0.02
    && effectiveFailingCount <= 20
  const concentratedLongDocumentContrastRisk =
    contrast.pagesAnalyzed >= 10
    && contrast.totalSamples >= 250
    && effectiveFailRatio <= 0.05
    && effectiveFailingCount <= 24
    && concentratedFailurePages.size <= 2
  const mostlyAdvisoryLongDocumentContrastRisk =
    contrast.pagesAnalyzed >= 10
    && contrast.totalSamples >= 250
    && effectiveFailRatio <= 0.05
    && effectiveFailingCount <= 12
    && concentratedFailurePages.size <= 2
    && materialFailures.length > 0
    && residualMediumFailures.length <= 1
  const sparseMostlyAdvisoryLongReportContrastRisk =
    contrast.pagesAnalyzed >= 10
    && contrast.totalSamples >= 250
    && effectiveFailRatio <= 0.05
    && effectiveFailingCount <= 12
    && materialFailures.length > 0
    && materialFailures.length <= 3
    && advisoryDisplayFailures.length >= effectiveFailingCount - materialFailures.length
    && materialFailures.every(failure => failure.contrastRatio >= 2.75)
  findings.push(`Analyzed ${contrast.totalSamples} text samples across ${contrast.pagesAnalyzed} page(s).`)

  let score: number
  if (effectiveFailRatio === 0 || effectiveFailingCount === 0) {
    score = 100
    findings.push('All sampled text meets WCAG contrast requirements.')
  } else if (
    effectiveFailRatio < 0.20
    && materialFailures.length <= 1
    && residualMediumFailures.length === materialFailures.length
    && contrast.pagesAnalyzed <= 2
    && uniqueAdvisoryDisplayElements.size <= 20
  ) {
    score = 95
    findings.push(`${effectiveFailingCount} text sample(s) fail contrast requirements (${Math.round(effectiveFailRatio * 100)}% of samples).`)
    findings.push('The failing samples were limited to near-threshold or display-sized text, with at most one residual medium-contrast miss, and were treated as an advisory contrast warning rather than a major document-wide contrast problem.')
  } else if (effectiveFailRatio < 0.01) {
    score = 95
    findings.push(`${effectiveFailingCount} text sample(s) fail contrast requirements (${Math.round(effectiveFailRatio * 100)}% of samples).`)
  } else if (largeDocumentLowDensityContrastRisk) {
    score = 95
    findings.push(`${effectiveFailingCount} text sample(s) fail contrast requirements (${Math.round(effectiveFailRatio * 100)}% of samples).`)
    findings.push('The failing samples were sparse across a large document and were treated as an advisory contrast warning rather than a material document-wide contrast problem.')
  } else if (concentratedLongDocumentContrastRisk) {
    score = 95
    findings.push(`${effectiveFailingCount} text sample(s) fail contrast requirements (${Math.round(effectiveFailRatio * 100)}% of samples).`)
    findings.push('The failing samples were concentrated on one or two pages of a long document and were treated as an advisory contrast warning rather than a material document-wide contrast problem.')
  } else if (mostlyAdvisoryLongDocumentContrastRisk) {
    score = 95
    findings.push(`${effectiveFailingCount} text sample(s) fail contrast requirements (${Math.round(effectiveFailRatio * 100)}% of samples).`)
    findings.push('The failing samples were concentrated on one or two pages of a long document, with at most one residual medium-contrast miss beyond advisory display text, and were treated as an advisory contrast warning.')
  } else if (sparseMostlyAdvisoryLongReportContrastRisk) {
    score = 95
    findings.push(`${effectiveFailingCount} text sample(s) fail contrast requirements (${Math.round(effectiveFailRatio * 100)}% of samples).`)
    findings.push('The remaining failures were sparse on a long report and were limited to mostly advisory display-text styling with only a few near-threshold caption or chart-label misses, so they were treated as an advisory contrast warning.')
  } else if (
    effectiveFailRatio <= 0.06
    && materialFailures.length === 0
    && contrast.pagesAnalyzed >= 8
  ) {
    score = 95
    findings.push(`${effectiveFailingCount} text sample(s) fail contrast requirements (${Math.round(effectiveFailRatio * 100)}% of samples).`)
    findings.push('The remaining failures were limited to advisory display-text styling on an otherwise readable long document and were treated as an advisory contrast warning.')
  } else if (effectiveFailRatio < 0.05) {
    score = effectiveFailingCount <= 10 ? 95 : 80
    findings.push(`${effectiveFailingCount} text sample(s) fail contrast requirements (${Math.round(effectiveFailRatio * 100)}% of samples).`)
    if (effectiveFailingCount <= 10) {
      findings.push('The failing samples are low-density and were treated as an advisory contrast warning rather than a major document-wide contrast problem.')
    }
  } else if (effectiveFailRatio < 0.20) {
    score = 60
    findings.push(`${effectiveFailingCount} text sample(s) fail contrast requirements (${Math.round(effectiveFailRatio * 100)}% of samples).`)
  } else {
    score = 30
    findings.push(`${effectiveFailingCount} text sample(s) fail contrast requirements (${Math.round(effectiveFailRatio * 100)}% of samples — significant contrast problem).`)
  }

  // Show up to 5 failure examples
  for (const failure of effectiveFailures.slice(0, 5)) {
    findings.push(`Page ${failure.page}: "${failure.textPreview}" — contrast ratio ${failure.contrastRatio}:1 (minimum ${failure.threshold}:1, colors ${failure.fgColor} on ${failure.bgColor})`)
  }

  if (ignorableInvisibleFailures.length > 0) {
    findings.push(`Ignored ${ignorableInvisibleFailures.length} white-on-white sample(s) that appear to be invisible or hidden text rather than visible page content.`)
  }
  if (ignorablePunctuationFailures.length > 0) {
    findings.push(`Ignored ${ignorablePunctuationFailures.length} punctuation-only sample(s) that appear to be decorative glyphs or separator marks rather than readable text.`)
  }

  if (effectiveFailingCount > 0) {
    findings.push('How to fix: Increase the contrast between text and background colors. Use a contrast checker (e.g. WebAIM Contrast Checker) to verify your color choices meet WCAG 1.4.3. In the source document, adjust text or background colors before re-exporting to PDF.')
  }

  if (contrast.warnings?.length) {
    for (const w of contrast.warnings) {
      findings.push(`Note: ${w}`)
    }
  }

  return {
    id: 'color_contrast',
    label: 'Color Contrast',
    weight: SCORING_WEIGHTS.color_contrast,
    score,
    grade: getGrade(score),
    severity: getSeverity(score),
    findings,
    explanation: contrastExplanation,
    helpLinks: contrastLinks,
  }
}

function scoreTableMarkup(qpdf: QpdfResult, tableStructure?: TableStructureResult | null): CategoryResult {
  const tableLinks: CategoryResult['helpLinks'] = [
    { label: 'Adobe: Make Tables Accessible', url: 'https://helpx.adobe.com/acrobat/using/editing-document-structure-content-tags.html' },
    { label: 'WCAG 1.3.1: Info and Relationships', url: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html' },
    { label: 'WebAIM: Table Accessibility in PDFs', url: 'https://webaim.org/techniques/acrobat/acrobat#702' },
  ]
  const tableExplanation = 'Table markup tells screen readers which cells are headers and which are data. Without proper header tags (TH), a screen reader reads table cells in a flat stream — the user has no way to know which column or row a value belongs to. Each table should have header cells tagged as <TH> and data cells tagged as <TD>.'

  if (qpdf.tables.length === 0) {
    return {
      id: 'table_markup',
      label: 'Table Markup',
      weight: SCORING_WEIGHTS.table_markup,
      score: null,
      grade: null,
      severity: null,
      findings: [
        'No tables detected in this document — this category does not affect the score',
      ],
      explanation: tableExplanation,
      helpLinks: tableLinks,
    }
  }

  const withHeaders = qpdf.tables.filter(t => t.hasHeaders).length
  const findings: string[] = []

  if (withHeaders === qpdf.tables.length) {
    findings.push(`All ${qpdf.tables.length} table(s) have proper header tags (TH)`)

    let score = 100
    const irregularTables = qpdf.tables.filter(table =>
      table.isRegular === false && !isAdvisoryTableRegularity(table),
    )
    const complexTables = qpdf.tables.filter(table =>
      table.hasHeaders
      && (((table.headerRowCount ?? 0) > 1) || ((table.maxRowSpan ?? 1) > 1) || ((table.maxColSpan ?? 1) > 1))
      && table.isRegular === false
      && !isAdvisoryTableRegularity(table),
    )
    if (irregularTables.length > 0) {
      findings.push(`${irregularTables.length} tagged table(s) still have irregular row/column structure and may fail Acrobat's table regularity check.`)
      score = irregularTables.length <= 1 ? 85 : 70
    }
    if (complexTables.length > 0) {
      findings.push(`${complexTables.length} table(s) use grouped or span-heavy headers but still have ambiguous header relationships.`)
      score = Math.min(score, complexTables.length <= 1 ? 75 : 60)
    }
    const highConfidenceUntagged = tableStructure?.highConfidenceUntaggedTables ?? tableStructure?.untaggedTables ?? 0
    const advisoryUntagged = tableStructure?.advisoryUntaggedTables ?? 0
    if (tableStructure?.status === 'ok' && highConfidenceUntagged > 0) {
      findings.push(`${highConfidenceUntagged} high-confidence table(s) were detected visually without matching PDF tags. Screen readers may miss these data tables.`)
      score = highConfidenceUntagged <= 2 ? 85 : 70
    }
    if (tableStructure?.status === 'ok' && advisoryUntagged > 0) {
      findings.push(`${advisoryUntagged} low-confidence visual table detection(s) were treated as advisory only.`)
    }

    return {
      id: 'table_markup',
      label: 'Table Markup',
      weight: SCORING_WEIGHTS.table_markup,
      score,
      grade: getGrade(score),
      severity: getSeverity(score),
      findings,
      explanation: tableExplanation,
      helpLinks: tableLinks,
    }
  }

  if (withHeaders > 0) {
    findings.push(`${withHeaders} of ${qpdf.tables.length} table(s) have header tags`)
    findings.push(`${qpdf.tables.length - withHeaders} table(s) are missing header cell tags`)
  } else {
    findings.push(`${qpdf.tables.length} table(s) found but none have header tags (TH)`)
  }
  findings.push('How to fix: In Adobe Acrobat, open the Tags panel → expand each <Table> tag → find the header row → change the cell tags from <TD> to <TH>. This tells screen readers "this cell is a column/row header" so they can announce it with each data cell.')

  // Apply secondary signal from visual table detection
  if (tableStructure?.status === 'ok' && (tableStructure.untaggedTables ?? 0) > 0) {
    const highConfidenceUntagged = tableStructure.highConfidenceUntaggedTables ?? tableStructure.untaggedTables ?? 0
    const advisoryUntagged = tableStructure.advisoryUntaggedTables ?? 0
    if (highConfidenceUntagged > 0) {
      findings.push(`${highConfidenceUntagged} high-confidence table(s) were detected visually without matching PDF tags. Screen readers may miss these data tables.`)
    }
    if (advisoryUntagged > 0) {
      findings.push(`${advisoryUntagged} low-confidence visual table detection(s) were treated as advisory only.`)
    }
  }

  return {
    id: 'table_markup',
    label: 'Table Markup',
    weight: SCORING_WEIGHTS.table_markup,
    score: withHeaders > 0 ? 40 : 40,
    grade: getGrade(40),
    severity: getSeverity(40),
    findings,
    explanation: tableExplanation,
    helpLinks: tableLinks,
  }
}

function scoreLinkQuality(pdfjs: PdfjsResult): CategoryResult {
  const linkLinks: CategoryResult['helpLinks'] = [
    { label: 'Adobe: Create and Edit Links', url: 'https://helpx.adobe.com/acrobat/using/accessibility-features-pdfs.html' },
    { label: 'WCAG 2.4.4: Link Purpose', url: 'https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context.html' },
    { label: 'WebAIM: Links and Hypertext', url: 'https://webaim.org/techniques/hypertext/' },
  ]
  const linkExplanation = 'Screen reader users often navigate by tabbing through links or pulling up a list of all links on the page. If a link says "https://www.example.com/reports/2024/q3/data.pdf", that\'s not useful. A descriptive label like "Q3 2024 Data Report" tells the user where the link goes without needing to see the URL.'

  if (pdfjs.links.length === 0) {
    return {
      id: 'link_quality',
      label: 'Link & URL Quality',
      weight: SCORING_WEIGHTS.link_quality,
      score: null,
      grade: null,
      severity: null,
      findings: ['No links found in this document — link quality scoring not applicable'],
      explanation: linkExplanation,
      helpLinks: linkLinks,
    }
  }

  const { descriptiveLinks: descriptive, rawLinks, rawUrlLinkCount, genericLinks, genericLinkCount } = summarizeLinkTextQuality(pdfjs.links)
  const goodLinks = descriptive // descriptive already excludes both raw URLs and generic
  const score = Math.round((goodLinks.length / pdfjs.links.length) * 100)
  const findings: string[] = []

  if (goodLinks.length === pdfjs.links.length) {
    findings.push(`All ${pdfjs.links.length} link(s) use descriptive text`)
    for (const link of pdfjs.links) {
      findings.push(`Link: "${link.text.trim()}"`)
    }
  } else {
    if (rawUrlLinkCount > 0) {
      findings.push(`${rawUrlLinkCount} of ${pdfjs.links.length} link(s) display raw URLs instead of descriptive text`)
      for (const link of rawLinks) {
        findings.push(`Raw URL link: "${link.text.trim()}"`)
      }
      findings.push('How to fix: In the original document (Word, InDesign, etc.), change the visible link text to something descriptive before re-exporting to PDF. In Adobe Acrobat, you can edit link properties via the Edit PDF tool.')
    }
    if (genericLinkCount > 0) {
      findings.push(`${genericLinkCount} link(s) use ambiguous/generic text (e.g. 'click here', 'read more'). Screen readers present these out of context.`)
      for (const link of genericLinks) {
        findings.push(`Generic link: "${link.text.trim()}"`)
      }
      findings.push("How to fix: Replace generic link text with descriptive text that makes sense when read in isolation, e.g. 'Download the 2024 Annual Report (PDF)' instead of 'click here'.")
    }
  }

  return {
    id: 'link_quality',
    label: 'Link & URL Quality',
    weight: SCORING_WEIGHTS.link_quality,
    score,
    grade: getGrade(score),
    severity: getSeverity(score),
    findings,
    explanation: linkExplanation,
    helpLinks: linkLinks,
  }
}

function scoreFormAccessibility(qpdf: QpdfResult): CategoryResult {
  const formLinks: CategoryResult['helpLinks'] = [
    { label: 'Adobe: Create Accessible Forms', url: 'https://helpx.adobe.com/acrobat/using/creating-accessible-pdfs.html' },
    { label: 'WCAG 1.3.1: Labels for Form Fields', url: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html' },
    { label: 'WebAIM: Accessible PDF Forms', url: 'https://webaim.org/techniques/acrobat/forms' },
  ]
  const formExplanation = 'Form fields (text boxes, checkboxes, dropdowns) need a "tooltip" label (called TU in the PDF spec) so screen readers can announce what each field is for. Without a tooltip, a screen reader user encounters a text box with no indication of what to type — they hear "text field" instead of "First Name".'

  if (!qpdf.hasAcroForm || qpdf.formFields.length === 0) {
    return {
      id: 'form_accessibility',
      label: 'Form Accessibility',
      weight: SCORING_WEIGHTS.form_accessibility,
      score: null,
      grade: null,
      severity: null,
      findings: ['No form fields found in this document — this category does not affect the score'],
      explanation: formExplanation,
      helpLinks: formLinks,
    }
  }

  const withLabels = qpdf.formFields.filter(f => f.hasTU).length
  const score = Math.round((withLabels / qpdf.formFields.length) * 100)
  const findings: string[] = []

  findings.push(`${qpdf.formFields.length} form field(s) detected`)

  if (withLabels === qpdf.formFields.length) {
    findings.push(`All fields have accessible tooltip labels (TU)`)
  } else {
    findings.push(`${withLabels} of ${qpdf.formFields.length} field(s) have accessible labels`)
    const unlabeled = qpdf.formFields.filter(f => !f.hasTU)
    for (const field of unlabeled) {
      findings.push(`Unlabeled field${field.name ? `: "${field.name}"` : ''}`)
    }
    findings.push('How to fix: In Adobe Acrobat, right-click each form field → Properties → General tab → enter a descriptive Tooltip. The tooltip becomes the accessible label that screen readers announce.')
  }

  return {
    id: 'form_accessibility',
    label: 'Form Accessibility',
    weight: SCORING_WEIGHTS.form_accessibility,
    score,
    grade: getGrade(score),
    severity: getSeverity(score),
    findings,
    explanation: formExplanation,
    helpLinks: formLinks,
  }
}

function scoreReadingOrder(qpdf: QpdfResult, pdfjs: PdfjsResult, pdfminer?: ReadingOrderResult | null, tabOrder?: TabOrderResult | null, verapdf?: VeraPdfResult | null): CategoryResult {
  const readingLinks: CategoryResult['helpLinks'] = [
    { label: 'Adobe: Fix Reading Order', url: 'https://helpx.adobe.com/acrobat/using/create-verify-pdf-accessibility.html' },
    { label: 'WCAG 1.3.2: Meaningful Sequence', url: 'https://www.w3.org/WAI/WCAG21/Understanding/meaningful-sequence.html' },
    { label: 'WebAIM: Reading Order', url: 'https://webaim.org/techniques/acrobat/acrobat#702' },
  ]
  const readingExplanation = 'Reading order determines the sequence in which a screen reader announces content. In a visual layout, humans naturally read left-to-right, top-to-bottom. But PDFs store content in drawing order, which may not match the visual order — for example, a sidebar might be read before the main content. The tag structure tree overrides the drawing order, ensuring assistive technology reads content in the correct logical sequence.'

  if (!qpdf.hasStructTree) {
    return {
      id: 'reading_order',
      label: 'Reading Order',
      weight: SCORING_WEIGHTS.reading_order,
      score: 0,
      grade: 'F',
      severity: 'Critical',
      findings: [
        'No structure tree present — reading order cannot be determined',
        'Without a tag structure, screen readers fall back to the raw drawing order, which may not match the visual layout at all.',
        'How to fix: First add tags (Accessibility → Add Tags to Document), then use the Reading Order tool (Accessibility → Reading Order) to verify and correct the sequence.',
      ],
      explanation: readingExplanation,
      helpLinks: readingLinks,
    }
  }

  const findings: string[] = []
  findings.push(`Structure tree depth: ${qpdf.structTreeDepth} level(s)`)
  findings.push(`Content items tracked: ${qpdf.contentOrder.length}`)

  // Check tree depth (flat = bad)
  if (qpdf.structTreeDepth <= 1) {
    findings.push('Structure tree is flat (no meaningful nesting) — the document has tags but they don\'t define a nested hierarchy.')
    findings.push('How to fix: Use the Reading Order tool in Adobe Acrobat (Accessibility → Reading Order) to reorganize the tag structure into proper sections, headings, and content blocks.')
    return {
      id: 'reading_order',
      label: 'Reading Order',
      weight: SCORING_WEIGHTS.reading_order,
      score: 30,
      grade: getGrade(30),
      severity: getSeverity(30),
      findings,
      explanation: readingExplanation,
      helpLinks: readingLinks,
    }
  }

  // Check MCID ordering per page.
  // contentOrder entries are encoded as pageIndex * 100_000 + mcid so that
  // cross-page MCID resets don't cause false positives. We split by page and
  // measure disorder within each page independently.
  if (qpdf.contentOrder.length > 1) {
    const PAGE_STRIDE = 100_000
    // Group consecutive entries by page index
    let outOfOrder = 0
    let comparisons = 0
    let prevPage = Math.floor(qpdf.contentOrder[0] / PAGE_STRIDE)
    let prevMcid = qpdf.contentOrder[0] % PAGE_STRIDE
    for (let i = 1; i < qpdf.contentOrder.length; i++) {
      const encoded = qpdf.contentOrder[i]
      const page = Math.floor(encoded / PAGE_STRIDE)
      const mcid = encoded % PAGE_STRIDE
      if (page === prevPage) {
        // Same page — compare MCIDs
        comparisons++
        if (mcid < prevMcid) outOfOrder++
      }
      // Cross-page transitions are not compared (page MCID counters reset to 0)
      prevPage = page
      prevMcid = mcid
    }

    if (comparisons > 0) {
      const disorderRatio = outOfOrder / comparisons
      if (disorderRatio > ANALYSIS.READING_ORDER_DISORDER_THRESHOLD) {
        findings.push(`Content order has significant deviations (${Math.round(disorderRatio * 100)}% of items out of sequence)`)
        findings.push('This means the tag order doesn\'t match the page content order — a screen reader may announce content in a confusing sequence.')
        findings.push('How to fix: Use the Reading Order tool in Adobe Acrobat (Accessibility → Reading Order) to reorder elements.')
        if (
          pdfminer?.status === 'ok' &&
          pdfminer.disorderRatio !== null &&
          pdfminer.disorderRatio > ANALYSIS.PDFMINER_READING_ORDER_THRESHOLD
        ) {
          const pct = Math.round(pdfminer.disorderRatio * 100)
          findings.push(`PDFMiner detected content-stream vs visual order mismatch (${pct}% of block pairs disordered across ${pdfminer.pagesAnalyzed} pages).`)
        }
        return {
          id: 'reading_order',
          label: 'Reading Order',
          weight: SCORING_WEIGHTS.reading_order,
          score: 50,
          grade: getGrade(50),
          severity: getSeverity(50),
          findings,
          explanation: readingExplanation,
          helpLinks: readingLinks,
        }
      }
    }
  }

  findings.push('Structure tree defines a logical reading order')

  let finalScore = 100
  if (
    pdfminer?.status === 'ok' &&
    pdfminer.disorderRatio !== null &&
    pdfminer.disorderRatio > ANALYSIS.PDFMINER_READING_ORDER_THRESHOLD
  ) {
    const pct = Math.round(pdfminer.disorderRatio * 100)
    const shouldIgnorePdfMinerMismatch = qpdf.contentOrder.length === 0 && verapdf?.status === 'passed'
    const shortTaggedBrochureMismatch =
      qpdf.structTreeDepth >= 2
      && qpdf.contentOrder.length > 0
      && qpdf.contentOrder.length <= 48
      && pdfminer.pagesAnalyzed <= 4
      && pdfjs.pageCount <= 4
      && qpdf.tables.length === 0
      && pdfjs.links.length === 0
      && qpdf.formFields.length === 0
      && (tabOrder?.status !== 'ok' || (tabOrder.missingTabsCount === 0 && tabOrder.outOfOrderPageCount === 0))
    if (shouldIgnorePdfMinerMismatch) {
      findings.push(`PDFMiner detected a ${pct}% content-stream mismatch, but this was ignored because the document passes PDF/UA and no MCID content-order trace was available for a stronger comparison.`)
    } else if (shortTaggedBrochureMismatch) {
      finalScore = 95
      findings.push(`PDFMiner detected content-stream vs visual order mismatch (${pct}% of block pairs disordered across ${pdfminer.pagesAnalyzed} pages), but this was treated as an advisory warning because the short tagged document already has a stable structure tree and no annotation/tab-order debt.`)
    } else if (finalScore < 100) {
      findings.push(`PDFMiner detected content-stream vs visual order mismatch (${pct}% of block pairs disordered across ${pdfminer.pagesAnalyzed} pages).`)
    } else {
      finalScore = 70
      findings.push(`PDFMiner detected content-stream vs visual order mismatch (${pct}% of block pairs disordered across ${pdfminer.pagesAnalyzed} pages). Although the tag structure appears correct, the underlying content stream order differs significantly from the visual layout.`)
    }
  }

  if (tabOrder?.status === 'ok') {
    if (tabOrder.missingTabsCount > 0) {
      finalScore = Math.min(finalScore, 60)
      findings.push(`${tabOrder.missingTabsCount} page(s) are missing /Tabs /S.`)
    }
    if ((tabOrder.unownedAnnotationCount ?? 0) > 0) {
      finalScore = Math.min(finalScore, ANALYSIS.UNOWNED_ANNOTATION_SCORE_CAP)
      findings.push(`${tabOrder.unownedAnnotationCount} visible annotation(s) are missing /StructParent ownership and are not fully tagged.`)
    }
    if (tabOrder.outOfOrderPageCount > 0) {
      finalScore = Math.min(finalScore, 75)
      findings.push(`${tabOrder.outOfOrderPageCount} page(s) have annotations that are not ordered top-to-bottom, left-to-right.`)
    }
    if (tabOrder.annotatedPageCount > 0 && tabOrder.missingTabsCount === 0 && tabOrder.outOfOrderPageCount === 0) {
      findings.push('Annotated pages use /Tabs /S and annotation arrays already follow reading order.')
    }
  } else if (tabOrder?.status === 'error' && tabOrder.warnings.length > 0) {
    findings.push(`Tab order analysis warning: ${tabOrder.warnings[0]}`)
  }

  if (finalScore < 100) {
    findings.push('How to fix: Set /Tabs /S on every tagged or annotated page and reorder each page’s annotations from top-to-bottom, then left-to-right.')
  }

  return {
    id: 'reading_order',
    label: 'Reading Order',
    weight: SCORING_WEIGHTS.reading_order,
    score: finalScore,
    grade: getGrade(finalScore),
    severity: getSeverity(finalScore),
    findings,
    explanation: readingExplanation,
    helpLinks: readingLinks,
  }
}

function generateSummary(
  score: number,
  grade: string,
  isScanned: boolean,
  categories: CategoryResult[],
  verapdf: VeraPdfResult,
  localStandards: LocalStandardsReport,
  context: SummaryContext,
): string {
  if (isScanned) {
    return 'This PDF appears to be a scanned image. Screen readers cannot access its content. OCR and full remediation are required before this document can be made accessible.'
  }

  const critical = categories.filter(c => c.severity === 'Critical')
  const passing = categories.filter(c => c.severity === 'Pass')
  const applicable = categories.filter(c => c.score !== null)

  const hasBlockingLocalFindings = localStandards.findings.some(finding => finding.blocking)
  if (localStandards.status === 'issues_detected' && (hasBlockingLocalFindings || context.gradeGateApplied || context.scoreGateApplied)) {
    const gateText = context.gradeGateApplied || context.scoreGateApplied
      ? ' Local standards findings keep the document below a fully confirmed pass.'
      : ''
    return `Local standards checks found ${context.failedChecks} PDF/UA-related issue${context.failedChecks === 1 ? '' : 's'}. The PDF/UA compliance score is ${context.pdfUaScore}/100.${gateText}`
  }

  if (grade === 'A') {
    return `This PDF meets accessibility standards across all ${applicable.length} assessed categories based on the current local validation stack. It is ready for publication.`
  }

  if (grade === 'B') {
    return `This PDF is in good shape overall, but heuristic checks still found minor issues. ${passing.length} of ${applicable.length} categories pass.`
  }

  if (grade === 'B') {
    return `This PDF is in good shape with minor issues. ${passing.length} of ${applicable.length} categories pass. Review the findings below for remaining improvements.`
  }

  const moderate = categories.filter(c => c.severity === 'Moderate')

  if (critical.length > 0 && moderate.length > 0) {
    const criticalNames = critical.map(c => c.label).join(', ')
    const moderateNames = moderate.map(c => c.label).join(', ')
    return `This PDF has ${critical.length} critical issue${critical.length > 1 ? 's' : ''} (${criticalNames}) and ${moderate.length} moderate issue${moderate.length > 1 ? 's' : ''} (${moderateNames}). Critical issues must be fixed before publishing, and moderate issues should also be addressed.`
  }

  if (critical.length > 0) {
    const criticalNames = critical.map(c => c.label).join(', ')
    return `This PDF has ${critical.length} critical accessibility issue${critical.length > 1 ? 's' : ''}: ${criticalNames}. These must be addressed before publishing.`
  }

  if (moderate.length > 0) {
    const moderateNames = moderate.map(c => c.label).join(', ')
    return `This PDF has ${moderate.length} moderate accessibility issue${moderate.length > 1 ? 's' : ''}: ${moderateNames}. These should be addressed to improve accessibility.`
  }

  const standardsText = context.standardsReducedScore
    ? ' Standards findings also reduced the score.'
    : ''
  return `This PDF has accessibility issues in ${applicable.length - passing.length} of ${applicable.length} categories. Review the findings below and remediate in Adobe Acrobat.${standardsText}`
}
