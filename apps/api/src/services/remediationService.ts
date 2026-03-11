import { PDFDocument } from 'pdf-lib'
import type { AnalysisResult } from './pdfAnalyzer.js'
import { analyzeWithPdfjs } from './pdfjsService.js'
import { analyzeWithQpdf } from './qpdfService.js'
import type { ManualReviewFlag, RemediationStatus } from './queueStore.js'

export interface RemediationOutput {
  buffer: Buffer
  remediationStatus: RemediationStatus
  appliedFixes: string[]
  skippedFixes: string[]
  manualReviewFlags: ManualReviewFlag[]
}

function pushFlag(flags: ManualReviewFlag[], next: ManualReviewFlag): void {
  if (flags.some(flag => flag.code === next.code)) return
  flags.push(next)
}

function addCategoryFlag(
  result: AnalysisResult,
  categoryId: string,
  flag: ManualReviewFlag,
  flags: ManualReviewFlag[],
): void {
  const category = result.categories.find(entry => entry.id === categoryId)
  if (!category || category.score === null || category.score >= 100) return
  pushFlag(flags, flag)
}

export async function remediatePdf(
  originalBuffer: Buffer,
  originalResult: AnalysisResult,
  options?: { signal?: AbortSignal },
): Promise<RemediationOutput> {
  if (options?.signal?.aborted) {
    const error = new Error('Remediation cancelled') as Error & { aborted?: boolean }
    error.aborted = true
    throw error
  }

  const appliedFixes: string[] = []
  const skippedFixes: string[] = []
  const manualReviewFlags: ManualReviewFlag[] = []

  const [pdfjsResult, qpdfResult] = await Promise.all([
    analyzeWithPdfjs(originalBuffer, { signal: options?.signal }),
    analyzeWithQpdf(originalBuffer, { signal: options?.signal }),
  ])

  if (options?.signal?.aborted) {
    const error = new Error('Remediation cancelled') as Error & { aborted?: boolean }
    error.aborted = true
    throw error
  }

  const pdfDoc = await PDFDocument.load(originalBuffer, {
    updateMetadata: false,
    ignoreEncryption: false,
  })

  const existingTitle = pdfjsResult.title || pdfDoc.getTitle()
  if (existingTitle?.trim()) {
    pdfDoc.setTitle(existingTitle.trim(), { showInWindowTitleBar: true })
    appliedFixes.push('Normalized the existing document title metadata and enabled title display in the viewer.')
  }

  const explicitLanguage = qpdfResult.lang || pdfjsResult.lang
  if (explicitLanguage?.trim()) {
    pdfDoc.setLanguage(explicitLanguage.trim())
    appliedFixes.push('Preserved the explicit document language metadata in the remediated PDF.')
  }

  if (qpdfResult.hasOutlines && qpdfResult.outlineCount > 0) {
    skippedFixes.push('Existing bookmarks were preserved, but automatic bookmark regeneration is not available in this version.')
  } else if (originalResult.pageCount >= 10) {
    skippedFixes.push('Bookmark generation from headings is not available in this version and requires manual review.')
    pushFlag(manualReviewFlags, {
      code: 'bookmarks_manual_review',
      label: 'Bookmarks require manual review',
      severity: 'warning',
      details: 'This document is long enough to benefit from bookmarks, but safe automatic bookmark generation is not available in this version.',
    })
  }

  if (originalResult.isScanned) {
    skippedFixes.push('OCR-dependent remediation was skipped because OCR is out of scope for this version.')
    pushFlag(manualReviewFlags, {
      code: 'ocr_required',
      label: 'OCR required',
      severity: 'critical',
      details: 'This PDF appears to be scanned or image-only. OCR is required before accessibility structure can be repaired.',
    })
  }

  addCategoryFlag(originalResult, 'alt_text', {
    code: 'alt_text_manual_review',
    label: 'Image descriptions require human review',
    severity: 'warning',
    details: 'Missing or incomplete alt text was detected. This version does not generate alt text automatically.',
  }, manualReviewFlags)

  addCategoryFlag(originalResult, 'heading_structure', {
    code: 'heading_semantics_manual_review',
    label: 'Heading structure requires manual review',
    severity: 'warning',
    details: 'Heading hierarchy or semantics need human review to avoid changing document meaning.',
  }, manualReviewFlags)

  addCategoryFlag(originalResult, 'table_markup', {
    code: 'table_semantics_manual_review',
    label: 'Table semantics require manual review',
    severity: 'warning',
    details: 'Table header and structure issues were detected. Safe automatic table remediation is not available in this version.',
  }, manualReviewFlags)

  addCategoryFlag(originalResult, 'link_quality', {
    code: 'link_text_manual_review',
    label: 'Link text requires manual review',
    severity: 'warning',
    details: 'Link wording or link semantics need human judgment and are not rewritten automatically.',
  }, manualReviewFlags)

  addCategoryFlag(originalResult, 'reading_order', {
    code: 'reading_order_manual_review',
    label: 'Reading order requires manual review',
    severity: 'warning',
    details: 'Reading order issues were detected, but this version avoids reordering content automatically when meaning could change.',
  }, manualReviewFlags)

  addCategoryFlag(originalResult, 'form_accessibility', {
    code: 'form_labels_manual_review',
    label: 'Form labels require manual review',
    severity: 'warning',
    details: 'Form field labels or tooltips need manual remediation in this version.',
  }, manualReviewFlags)

  addCategoryFlag(originalResult, 'title_language', {
    code: 'metadata_manual_review',
    label: 'Metadata requires manual review',
    severity: 'warning',
    details: 'Missing title or language values cannot be invented automatically in this version.',
  }, manualReviewFlags)

  if (manualReviewFlags.length > 0) {
    skippedFixes.push('Semantic or OCR-dependent fixes were intentionally skipped and flagged for manual review.')
  }

  const buffer = Buffer.from(await pdfDoc.save())
  const remediationStatus: RemediationStatus = manualReviewFlags.length > 0 ? 'manual_review_required' : 'completed'

  return {
    buffer,
    remediationStatus,
    appliedFixes,
    skippedFixes,
    manualReviewFlags,
  }
}
