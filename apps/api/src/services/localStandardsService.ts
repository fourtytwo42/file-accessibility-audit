import type { QpdfResult } from './qpdfService.js'
import type { PdfjsResult } from './pdfjsService.js'
import type { TabOrderResult } from './tabOrderService.js'
import type { StructureBackendMutationResult } from './pdfStructureBackend.js'

export type LocalStandardsSource = 'qpdf' | 'pdfjs' | 'structure_backend' | 'composite'
export type LocalStandardsSeverity = 'warning' | 'error'

export interface LocalStandardsFinding {
  key: string
  label: string
  severity: LocalStandardsSeverity
  blocking: boolean
  categoryIds: string[]
  confidence: number
  evidence: string[]
  source: LocalStandardsSource
  inferred: boolean
  count: number
}

export interface LocalStandardsReport {
  status: 'clear' | 'issues_detected'
  findings: LocalStandardsFinding[]
  knownGapKeys: string[]
}

function pushFinding(target: LocalStandardsFinding[], finding: LocalStandardsFinding | null): void {
  if (!finding) return
  target.push(finding)
}

function looksLikeBrokenBookmarkTitle(title: string): boolean {
  const normalized = title.trim()
  if (!normalized) return false
  return /^b:[0-9a-f]{10,}/i.test(normalized)
    || /[.·•]{4,}\s*\d+\s*$/i.test(normalized)
    || /[\u0080-\u009f]/.test(normalized)
}

function missingLogicalStructureFinding(qpdf: QpdfResult): LocalStandardsFinding | null {
  const evidence: string[] = []
  let count = 0

  if (!qpdf.hasStructTree) {
    count += 1
    evidence.push('StructTreeRoot entry is not present in the document catalog.')
  }
  if (!qpdf.hasMarkInfo) {
    count += 1
    evidence.push('MarkInfo dictionary is missing from the document catalog.')
  } else if (qpdf.marked !== true) {
    count += 1
    evidence.push('MarkInfo dictionary is present but /Marked is not true.')
  }

  if (!count) return null
  return {
    key: 'pdfua.logical_structure',
    label: 'Logical structure and marked content',
    severity: 'error',
    blocking: true,
    categoryIds: ['text_extractability', 'reading_order', 'pdf_ua_compliance'],
    confidence: 0.98,
    evidence,
    source: 'qpdf',
    inferred: false,
    count,
  }
}

function documentLanguageFinding(qpdf: QpdfResult): LocalStandardsFinding | null {
  if (qpdf.hasLang && qpdf.lang && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(qpdf.lang)) return null
  return {
    key: 'pdfua.document_language',
    label: 'Document language tag',
    severity: 'error',
    blocking: true,
    categoryIds: ['title_language', 'pdf_ua_compliance'],
    confidence: qpdf.hasLang ? 0.8 : 0.95,
    evidence: qpdf.hasLang
      ? [`Language tag "${qpdf.lang || 'unknown'}" does not appear normalized.`]
      : ['No document language declaration was found in the catalog metadata.'],
    source: 'qpdf',
    inferred: false,
    count: 1,
  }
}

function displayDocTitleFinding(qpdf: QpdfResult, pdfjs: PdfjsResult): LocalStandardsFinding | null {
  const missingTitle = !pdfjs.title?.trim()
  const missingDisplayDocTitle = qpdf.displayDocTitle !== true
  if (!missingTitle && !missingDisplayDocTitle) return null

  const evidence: string[] = []
  let count = 0
  if (missingTitle) {
    count += 1
    evidence.push('No meaningful document title metadata is available.')
  }
  if (missingDisplayDocTitle) {
    count += 1
    evidence.push('ViewerPreferences /DisplayDocTitle is missing or not set to true.')
  }

  return {
    key: 'pdfua.display_doc_title',
    label: 'Display document title metadata',
    severity: 'error',
    blocking: true,
    categoryIds: ['title_language', 'pdf_ua_compliance'],
    confidence: 0.95,
    evidence,
    source: 'composite',
    inferred: false,
    count,
  }
}

function metadataIdentificationFinding(qpdf: QpdfResult): LocalStandardsFinding | null {
  if (qpdf.metadataRef && qpdf.metadataTypeValid && qpdf.metadataSubtypeXml) return null

  const evidence: string[] = []
  let count = 0
  let inferred = false
  if (!qpdf.metadataRef) {
    evidence.push('Catalog metadata stream is missing, so PDF/UA identification cannot be present.')
    count += 1
  } else {
    inferred = true
    if (!qpdf.metadataTypeValid) {
      evidence.push('Metadata stream dictionary is missing /Type /Metadata.')
      count += 1
    }
    if (!qpdf.metadataSubtypeXml) {
      evidence.push('Metadata stream dictionary is missing /Subtype /XML.')
      count += 1
    }
  }

  if (!count) return null
  return {
    key: 'pdfua.metadata_identification',
    label: 'PDF/UA metadata and identification',
    severity: 'error',
    blocking: true,
    categoryIds: ['title_language', 'pdf_ua_compliance'],
    confidence: inferred ? 0.75 : 0.95,
    evidence,
    source: 'qpdf',
    inferred,
    count,
  }
}

function bookmarkLanguageFinding(qpdf: QpdfResult, pdfjs: PdfjsResult): LocalStandardsFinding | null {
  if (!(qpdf.hasOutlines || pdfjs.hasOutlines)) return null
  const brokenTitles = qpdf.outlineTitles.filter(looksLikeBrokenBookmarkTitle)
  if (!brokenTitles.length && qpdf.hasLang) return null

  const evidence: string[] = []
  let count = 0
  if (brokenTitles.length) {
    count += brokenTitles.length
    evidence.push(...brokenTitles.slice(0, 5).map(title => `Bookmark title appears raw or OCR-noisy: "${title}"`))
  }
  if (!qpdf.hasLang) {
    count += 1
    evidence.push('Outlines are present but no document language is declared, so bookmark language inheritance cannot be confirmed.')
  }
  return {
    key: 'pdfua.bookmark_language',
    label: 'Bookmark and outline language quality',
    severity: 'error',
    blocking: true,
    categoryIds: ['bookmarks', 'title_language', 'pdf_ua_compliance'],
    confidence: brokenTitles.length ? 0.92 : 0.74,
    evidence,
    source: 'composite',
    inferred: !brokenTitles.length,
    count,
  }
}

function fontEmbeddingFinding(qpdf: QpdfResult): LocalStandardsFinding | null {
  if ((qpdf.unembeddedFontCount ?? 0) <= 0) return null
  return {
    key: 'pdfua.font_embedding',
    label: 'Font embedding',
    severity: 'error',
    blocking: true,
    categoryIds: ['text_extractability', 'pdf_ua_compliance'],
    confidence: 0.93,
    evidence: [`Detected ${qpdf.unembeddedFontCount ?? 0} font object(s) without an embedded font program.`],
    source: 'qpdf',
    inferred: false,
    count: qpdf.unembeddedFontCount ?? 0,
  }
}

function fontUnicodeFinding(qpdf: QpdfResult): LocalStandardsFinding | null {
  if ((qpdf.fontsMissingToUnicode ?? 0) <= 0) return null
  return {
    key: 'pdfua.font_unicode',
    label: 'Font Unicode mapping',
    severity: 'error',
    blocking: true,
    categoryIds: ['text_extractability', 'pdf_ua_compliance'],
    confidence: 0.9,
    evidence: [`Detected ${qpdf.fontsMissingToUnicode ?? 0} font object(s) without a ToUnicode map.`],
    source: 'qpdf',
    inferred: false,
    count: qpdf.fontsMissingToUnicode ?? 0,
  }
}

function cidSymbolFontFinding(qpdf: QpdfResult): LocalStandardsFinding | null {
  if ((qpdf.cidFontsMissingCidToGidMap ?? 0) <= 0) return null
  return {
    key: 'pdfua.cid_symbol_fonts',
    label: 'CID symbol font mappings',
    severity: 'error',
    blocking: true,
    categoryIds: ['text_extractability', 'pdf_ua_compliance'],
    confidence: 0.9,
    evidence: [`Detected ${qpdf.cidFontsMissingCidToGidMap ?? 0} CID font object(s) missing CIDToGIDMap.`],
    source: 'qpdf',
    inferred: false,
    count: qpdf.cidFontsMissingCidToGidMap ?? 0,
  }
}

function pageTabsFinding(tabOrder: TabOrderResult | null | undefined): LocalStandardsFinding | null {
  if (!tabOrder || tabOrder.status !== 'ok') return null
  const issueCount = tabOrder.missingTabsCount + tabOrder.outOfOrderPageCount
  if (issueCount <= 0) return null

  const evidence: string[] = []
  if (tabOrder.missingTabsCount > 0) {
    evidence.push(`${tabOrder.missingTabsCount} page(s) are missing /Tabs /S.`)
  }
  if (tabOrder.outOfOrderPageCount > 0) {
    evidence.push(`${tabOrder.outOfOrderPageCount} page(s) have annotations that are not ordered top-to-bottom, left-to-right.`)
  }

  return {
    key: 'pdfua.page_tabs',
    label: 'Page tab order metadata',
    severity: 'error',
    blocking: true,
    categoryIds: ['reading_order', 'pdf_ua_compliance'],
    confidence: 0.95,
    evidence,
    source: 'composite',
    inferred: false,
    count: issueCount,
  }
}

function annotationAltContentsFinding(qpdf: QpdfResult, pdfjs: PdfjsResult): LocalStandardsFinding | null {
  const missingFromLinks = pdfjs.links.filter(link => !(link.contents || '').trim()).length
  const missingCount = Math.max(missingFromLinks, qpdf.linkAnnotationsMissingContents ?? 0)
  if (missingCount <= 0) return null
  return {
    key: 'pdfua.annotation_alt_contents',
    label: 'Link annotation alternate descriptions',
    severity: 'error',
    blocking: true,
    categoryIds: ['link_quality', 'pdf_ua_compliance'],
    confidence: 0.96,
    evidence: [`Detected ${missingCount} link annotation(s) without a /Contents alternate description.`],
    source: 'composite',
    inferred: false,
    count: missingCount,
  }
}

function linkTaggingFinding(
  qpdf: QpdfResult,
  pdfjs: PdfjsResult,
  structure?: Pick<StructureBackendMutationResult, 'structuralNodes'> | null,
): LocalStandardsFinding | null {
  const linkCount = Math.max(pdfjs.links.length, qpdf.linkAnnotationCount ?? 0)
  if (linkCount <= 0) return null
  const linkNodeCount = structure?.structuralNodes?.filter(node => node.tag === '/Link').length ?? 0
  if (qpdf.hasStructTree && linkNodeCount >= linkCount) return null

  const evidence: string[] = []
  if (!qpdf.hasStructTree) {
    evidence.push('Link annotations are present but the document has no structure tree, so links cannot be enclosed in /Link structure elements.')
  } else if (!linkNodeCount) {
    evidence.push('Link annotations are present but no /Link structure elements were found in the inspected structure snapshot.')
  } else {
    evidence.push(`Detected ${linkCount} link annotation(s) but only ${linkNodeCount} /Link structure element(s) in the inspected structure snapshot.`)
  }

  return {
    key: 'pdfua.link_tagging',
    label: 'Link structure tagging',
    severity: 'error',
    blocking: true,
    categoryIds: ['link_quality', 'reading_order', 'pdf_ua_compliance'],
    confidence: qpdf.hasStructTree ? 0.82 : 0.95,
    evidence,
    source: 'composite',
    inferred: !!qpdf.hasStructTree,
    count: Math.max(1, linkCount - linkNodeCount),
  }
}

function fontWidthsFinding(qpdf: QpdfResult): LocalStandardsFinding | null {
  if ((qpdf.legacyWidthRiskFontCount ?? 0) <= 0) return null
  return {
    key: 'pdfua.font_widths',
    label: 'Font width consistency',
    severity: 'error',
    blocking: true,
    categoryIds: ['text_extractability', 'pdf_ua_compliance'],
    confidence: 0.7,
    evidence: [`Detected ${qpdf.legacyWidthRiskFontCount ?? 0} embedded legacy font object(s) with explicit Widths arrays and no Unicode map, which is a strong proxy for width-conformance drift.`],
    source: 'qpdf',
    inferred: true,
    count: qpdf.legacyWidthRiskFontCount ?? 0,
  }
}

function partialArtifactFinding(qpdf: QpdfResult, pdfjs: PdfjsResult): LocalStandardsFinding | null {
  if (!qpdf.hasStructTree || pdfjs.textLength === 0 || qpdf.contentOrder.length > 0) return null
  return {
    key: 'pdfua.logical_structure',
    label: 'Logical structure and marked content',
    severity: 'warning',
    blocking: false,
    categoryIds: ['reading_order', 'pdf_ua_compliance'],
    confidence: 0.62,
    evidence: ['The document has a structure tree, but no content-order MCID trace was available to prove page content is fully represented in structure.'],
    source: 'composite',
    inferred: true,
    count: 1,
  }
}

export function buildLocalStandardsReport(
  qpdf: QpdfResult,
  pdfjs: PdfjsResult,
  options?: {
    tabOrder?: TabOrderResult | null
    structure?: Pick<StructureBackendMutationResult, 'structuralNodes'> | null
  },
): LocalStandardsReport {
  const findings: LocalStandardsFinding[] = []
  pushFinding(findings, missingLogicalStructureFinding(qpdf))
  pushFinding(findings, documentLanguageFinding(qpdf))
  pushFinding(findings, displayDocTitleFinding(qpdf, pdfjs))
  pushFinding(findings, metadataIdentificationFinding(qpdf))
  pushFinding(findings, bookmarkLanguageFinding(qpdf, pdfjs))
  pushFinding(findings, fontEmbeddingFinding(qpdf))
  pushFinding(findings, fontUnicodeFinding(qpdf))
  pushFinding(findings, cidSymbolFontFinding(qpdf))
  pushFinding(findings, pageTabsFinding(options?.tabOrder))
  pushFinding(findings, annotationAltContentsFinding(qpdf, pdfjs))
  pushFinding(findings, linkTaggingFinding(qpdf, pdfjs, options?.structure))
  pushFinding(findings, fontWidthsFinding(qpdf))
  pushFinding(findings, partialArtifactFinding(qpdf, pdfjs))

  const knownGapKeys: string[] = []
  if (qpdf.metadataRef && qpdf.metadataTypeValid && qpdf.metadataSubtypeXml) {
    knownGapKeys.push('pdfua.metadata_identification_content_unconfirmed')
  }
  if (findings.some(finding => finding.key === 'pdfua.logical_structure' && finding.inferred)) {
    knownGapKeys.push('pdfua.artifact_vs_real_content_partial')
  }

  return {
    status: findings.length ? 'issues_detected' : 'clear',
    findings,
    knownGapKeys,
  }
}
