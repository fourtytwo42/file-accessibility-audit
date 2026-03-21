import type { QpdfResult } from './qpdfService.js'
import type { PdfjsResult } from './pdfjsService.js'
import type { TabOrderResult } from './tabOrderService.js'
import type { StructureBackendMutationResult } from './pdfStructureBackend.js'
import { hasCanonicalLanguageTag } from './languageTags.js'

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

const GENERIC_ALT_TEXT_PATTERNS = new Set(['image', 'photo', 'picture', 'graphic', 'icon', 'logo'])
const GENERIC_HEADING_TEXT_PATTERNS = new Set(['heading', 'title', 'header', 'subtitle'])
const AMBIGUOUS_LINK_TEXT_PATTERNS = new Set(['click here', 'read more', 'more', 'learn more', 'here'])
const EXPLICIT_HEADING_TAG_RE = /^\/H(?:[1-6])?$/i
const LEGACY_HEADING_TAG_RE = /^\/heading\s+\d+$/i

function normalizeSemanticText(text: string | null | undefined): string {
  return String(text || '').replace(/^u:/, '').trim().toLowerCase()
}

function isGenericAltText(text: string | null | undefined): boolean {
  const normalized = normalizeSemanticText(text)
  if (!normalized) return false
  return GENERIC_ALT_TEXT_PATTERNS.has(normalized) || /^image\s+\d+$/i.test(normalized)
}

function isBoilerplateAltText(text: string | null | undefined): boolean {
  return /^(image|picture|photo|graphic)\s+of\b/i.test(normalizeSemanticText(text))
}

function isOverlongAltText(text: string | null | undefined): boolean {
  const normalized = normalizeSemanticText(text)
  return normalized.length > 220 || normalized.split(/\s+/).filter(Boolean).length > 32
}

function isGenericHeadingText(text: string | null | undefined): boolean {
  const normalized = normalizeSemanticText(text)
  return !!normalized && GENERIC_HEADING_TEXT_PATTERNS.has(normalized)
}

function isAmbiguousLinkText(text: string | null | undefined): boolean {
  const normalized = normalizeSemanticText(text).replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
  return !!normalized && AMBIGUOUS_LINK_TEXT_PATTERNS.has(normalized)
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

function missingLogicalStructureFinding(
  qpdf: QpdfResult,
  pdfjs: PdfjsResult,
  structure?: Pick<StructureBackendMutationResult, 'structuralNodes' | 'figures' | 'imageStructNodes' | 'acrobatAltRiskNodes' | 'untaggedTopLevelContentGroups' | 'readingOrderNodes'> | null,
): LocalStandardsFinding | null {
  const evidence: string[] = []
  let count = 0
  let inferred = false

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

  const structureNodeCount = structure?.structuralNodes?.length ?? 0
  const semanticCoveragePresent = qpdf.headings.length > 0
    || qpdf.tables.length > 0
    || qpdf.images.length > 0
    || (qpdf.linkStructCount ?? 0) > 0
    || structureNodeCount > 1
  const weakContentEvidence = pdfjs.textLength > 0 && qpdf.contentOrder.length === 0 && !semanticCoveragePresent
  const shallowStructureTree = qpdf.hasStructTree && qpdf.structTreeDepth > 0 && qpdf.structTreeDepth <= 1
  const sparseStructureSnapshot = qpdf.hasStructTree && structureNodeCount > 0 && structureNodeCount <= 1 && pdfjs.textLength > 0
  const figureCount = structure?.figures?.length ?? 0
  const imageStructNodeCount = structure?.imageStructNodes?.length ?? 0
  const acrobatAltRiskNodes = structure?.acrobatAltRiskNodes ?? []
  const acrobatAltRiskCount = acrobatAltRiskNodes.length
  const countsAsSubstantiveAltRisk = (node: NonNullable<typeof acrobatAltRiskNodes>[number]): boolean =>
    !node.graphicsLikelyDecorative
    || node.ownershipMode === 'untagged_image_direct'
    || node.ownershipMode === 'untagged_image_mcid'
  // Exclude purely decorative graphics (path/stroke only ops — borders, lines, underlines) from
  // the proxy count. These elements mix text and decorative shapes in the same MCID, but the
  // text is still fully accessible. They do not indicate a true tagged-content ownership conflict.
  const substantiveAltRiskCount = acrobatAltRiskNodes.filter(countsAsSubstantiveAltRisk).length
  const readingOrderNodeCount = structure?.readingOrderNodes?.length ?? 0
  const untaggedTopLevelContentGroups = structure?.untaggedTopLevelContentGroups ?? []
  const untaggedTopLevelContentCount = untaggedTopLevelContentGroups.length
  const semanticNodeCoverageAbsent = qpdf.hasStructTree
    && pdfjs.textLength > 1000
    && qpdf.outlineCount === 0
    && qpdf.headings.length === 0
    && qpdf.tables.length === 0
    && qpdf.images.length === 0
  const semanticFigureCoverageAbsent = qpdf.hasStructTree
    && qpdf.images.length > 0
    && figureCount === 0
    && imageStructNodeCount === 0
  const artifactMixingProxy = qpdf.hasStructTree
    && substantiveAltRiskCount >= 5
    && (qpdf.images.length > 0 || figureCount > 0)
    && (readingOrderNodeCount === 0 || substantiveAltRiskCount >= Math.max(6, imageStructNodeCount + 3))
  const untaggedTopLevelContentProxy = qpdf.hasStructTree
    && untaggedTopLevelContentCount > 0

  if (!count && (weakContentEvidence || shallowStructureTree || sparseStructureSnapshot || semanticNodeCoverageAbsent || semanticFigureCoverageAbsent || artifactMixingProxy || untaggedTopLevelContentProxy)) {
    inferred = true
    if (weakContentEvidence) {
      count += 1
      evidence.push('The document exposes text content, but no structure-tree MCID traversal could confirm that page content is represented in tagged reading order.')
    }
    if (shallowStructureTree) {
      count += 1
      evidence.push(`Structure tree depth is only ${qpdf.structTreeDepth}, which is too shallow to justify a reliable logical structure pass for this document.`)
    }
    if (sparseStructureSnapshot) {
      count += 1
      evidence.push(`Only ${structureNodeCount} structural node was recovered from the backend structure snapshot despite extractable page text.`)
    }
    if (semanticNodeCoverageAbsent) {
      count += 1
      evidence.push('The document is tagged at the catalog level, but no headings, tables, figures, or outline structure were recoverable from local analysis despite substantial text content.')
    }
    if (semanticFigureCoverageAbsent) {
      count += Math.max(1, qpdf.images.length)
      evidence.push(`Detected ${figureCount} figure candidate(s) and ${qpdf.images.length} PDF image(s), but no image structure nodes were recovered from the structure snapshot.`)
    }
    if (artifactMixingProxy) {
      count += Math.max(1, Math.min(substantiveAltRiskCount, 10))
      evidence.push(`Recovered ${substantiveAltRiskCount} artifact-mixing risk node(s) from the structure snapshot, which is a strong local proxy that tagged content and artifact ownership still conflict.`)
    }
    if (untaggedTopLevelContentProxy) {
      count += Math.max(1, Math.min(untaggedTopLevelContentCount, 10))
      evidence.push(`Recovered ${untaggedTopLevelContentCount} untagged top-level page content group(s) from the structure snapshot, which strongly suggests some visible page content is still outside the tag tree.`)
    }
  }

  if (!count) return null
  return {
    key: 'pdfua.logical_structure',
    label: 'Logical structure and marked content',
    severity: 'error',
    blocking: true,
    categoryIds: ['text_extractability', 'reading_order', 'pdf_ua_compliance'],
    confidence: inferred ? 0.76 : 0.98,
    evidence,
    source: inferred ? 'composite' : 'qpdf',
    inferred,
    count,
  }
}

function noteTagIdFinding(qpdf: QpdfResult): LocalStandardsFinding | null {
  const missingCount = qpdf.noteTagsMissingId ?? 0
  if (missingCount <= 0) return null
  const noteCount = qpdf.noteTagCount ?? missingCount
  return {
    key: 'pdfua.note_tag_id',
    label: 'Note tag identifiers',
    severity: 'error',
    blocking: true,
    categoryIds: ['reading_order', 'pdf_ua_compliance'],
    confidence: 0.96,
    evidence: [`Detected ${missingCount} /Note or role-mapped note structure element(s) without an /ID entry out of ${noteCount} inspected note tag(s).`],
    source: 'qpdf',
    inferred: false,
    count: missingCount,
  }
}

function documentLanguageFinding(qpdf: QpdfResult, pdfjs: PdfjsResult): LocalStandardsFinding | null {
  const qpdfLangValid = !!(qpdf.hasLang && qpdf.lang && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(qpdf.lang))
  const pdfjsLangValid = !!(pdfjs.lang && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(pdfjs.lang))
  const qpdfCanonical = qpdfLangValid && hasCanonicalLanguageTag(qpdf.lang)
  const pdfjsCanonical = pdfjsLangValid && hasCanonicalLanguageTag(pdfjs.lang)
  if (qpdfCanonical && (!pdfjs.lang || pdfjsCanonical)) return null

  const evidence: string[] = []
  let inferred = false

  if (!qpdf.hasLang) {
    evidence.push('No document language declaration was found in the catalog metadata.')
  } else if (!qpdfLangValid) {
    evidence.push(`Language tag "${qpdf.lang || 'unknown'}" does not appear normalized.`)
  } else if (!qpdfCanonical) {
    inferred = true
    evidence.push(`Language tag "${qpdf.lang}" is present but not canonicalized to BCP 47 casing.`)
  }

  if (qpdfLangValid && pdfjs.lang && !pdfjsLangValid) {
    inferred = true
    evidence.push(`PDF.js exposed an inconsistent language tag "${pdfjs.lang}", so local analyzers could not confirm a stable document language value.`)
  } else if (qpdfLangValid && !pdfjs.lang) {
    inferred = true
    evidence.push('Language metadata is present in qpdf output, but it was not recoverable through PDF.js metadata, so local confirmation remains incomplete.')
  } else if (pdfjsLangValid && !pdfjsCanonical) {
    inferred = true
    evidence.push(`PDF.js exposed language tag "${pdfjs.lang}" in non-canonical form.`)
  }

  return {
    key: 'pdfua.document_language',
    label: 'Document language tag',
    severity: 'error',
    blocking: true,
    categoryIds: ['title_language', 'pdf_ua_compliance'],
    confidence: inferred ? 0.72 : qpdf.hasLang ? 0.8 : 0.95,
    evidence,
    source: inferred ? 'composite' : 'qpdf',
    inferred,
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
  const unembeddedType3 = qpdf.unembeddedType3FontCount ?? 0
  const onlyResidualType3FontsRemain = unembeddedType3 > 0
    && unembeddedType3 === (qpdf.unembeddedFontCount ?? 0)
    && (qpdf.fontsMissingToUnicode ?? 0) === 0
  if (onlyResidualType3FontsRemain) {
    return null
  }
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

function cidSetConsistencyFinding(qpdf: QpdfResult): LocalStandardsFinding | null {
  const riskCount = qpdf.cidSetRiskFontCount ?? 0
  if (riskCount <= 0) return null
  const explicitCount = qpdf.cidSetExplicitFontCount ?? 0
  const inferredCount = Math.max(0, riskCount - explicitCount)
  const evidence: string[] = []

  if (explicitCount > 0) {
    evidence.push(`Detected ${explicitCount} embedded CID font descriptor(s) with a /CIDSet entry, which matches a known PDF/UA CIDSet consistency failure pattern.`)
  }
  if (inferredCount > 0) {
    evidence.push(`Detected ${inferredCount} embedded subsetted CID font object(s) with legacy Symbol/Dingbat characteristics or missing Unicode coverage, which is a conservative proxy for CIDSet conformance drift.`)
  }

  // This finding is always a structural proxy: QPDF can detect the presence/absence of CIDSet
  // streams but cannot verify whether the bitset content is correct. After repair_cidset_consistency
  // runs (which rebuilds CIDSet bitsets from actual used-CID data), the font is compliant, but the
  // finding would still fire because /CIDSet still exists in the FontDescriptor. Since we cannot
  // distinguish "correct CIDSet" from "possibly-wrong CIDSet" purely from QPDF output, and the
  // accessibility impact of CIDSet conformance drift is minimal (text remains readable), we treat
  // this finding as advisory (non-blocking) to avoid permanently suppressing otherwise-passing scores.
  return {
    key: 'pdfua.cidset_consistency',
    label: 'CIDSet consistency',
    severity: 'warning',
    blocking: false,
    categoryIds: ['text_extractability', 'pdf_ua_compliance'],
    confidence: explicitCount > 0 && inferredCount === 0 ? 0.92 : explicitCount > 0 ? 0.82 : 0.68,
    evidence,
    source: 'qpdf',
    inferred: inferredCount > 0,
    count: riskCount,
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
  const missingCount = (qpdf.linkAnnotationCount ?? 0) > 0
    ? (qpdf.linkAnnotationsMissingContents ?? 0)
    : missingFromLinks
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
  const snapshotLinkNodeCount = structure?.structuralNodes?.filter(node => node.tag === '/Link').length ?? 0
  const qpdfLinkNodeCount = qpdf.linkStructCount ?? 0
  const linkNodeCount = Math.max(snapshotLinkNodeCount, qpdfLinkNodeCount)
  if (qpdf.hasStructTree && linkNodeCount >= linkCount) return null

  const evidence: string[] = []
  if (!qpdf.hasStructTree) {
    evidence.push('Link annotations are present but the document has no structure tree, so links cannot be enclosed in /Link structure elements.')
  } else if (!linkNodeCount) {
    evidence.push('Link annotations are present but no /Link structure elements were found in the inspected structure snapshot.')
  } else {
    evidence.push(`Detected ${linkCount} link annotation(s) but only ${linkNodeCount} /Link structure element(s) across qpdf and the inspected structure snapshot.`)
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

function tableRegularityFinding(qpdf: QpdfResult): LocalStandardsFinding | null {
  const irregularTables = qpdf.tables.filter(table =>
    table.isRegular === false
    && (table.rowCellCounts?.length ?? 0) > 1,
  )
  if (!irregularTables.length) return null

  const evidence = irregularTables.slice(0, 3).map((table, index) => {
    const counts = table.rowCellCounts?.join(', ') || 'unknown'
    const dominant = table.dominantColumnCount ?? 'unknown'
    return `Table ${index + 1} exposes irregular row column counts (${counts}); dominant column count is ${dominant}.`
  })

  return {
    key: 'pdfua.table_regularity',
    label: 'Table regularity',
    severity: 'error',
    blocking: true,
    categoryIds: ['table_markup', 'pdf_ua_compliance'],
    confidence: 0.92,
    evidence,
    source: 'qpdf',
    inferred: false,
    count: irregularTables.length,
  }
}

function complexTableStructureFinding(qpdf: QpdfResult): LocalStandardsFinding | null {
  const complexTables = qpdf.tables.filter(table => {
    const spanHeavy = (table.maxRowSpan ?? 1) > 1 || (table.maxColSpan ?? 1) > 1
    const multiHeaderRows = (table.headerRowCount ?? 0) > 1
    const irregular = table.isRegular === false && (table.rowCellCounts?.length ?? 0) > 1
    return table.hasHeaders && irregular && (spanHeavy || multiHeaderRows)
  })
  if (!complexTables.length) return null

  return {
    key: 'pdfua.table_complexity',
    label: 'Complex table header relationships',
    severity: 'error',
    blocking: true,
    categoryIds: ['table_markup', 'pdf_ua_compliance'],
    confidence: 0.82,
    evidence: complexTables.slice(0, 3).map((table, index) => `Table ${index + 1} has grouped or span-heavy headers (header rows ${table.headerRowCount ?? 0}, max RowSpan ${table.maxRowSpan ?? 1}, max ColSpan ${table.maxColSpan ?? 1}) while row structure remains irregular.`),
    source: 'qpdf',
    inferred: true,
    count: complexTables.length,
  }
}

function altTextQualityFinding(
  qpdf: QpdfResult,
  structure?: Pick<StructureBackendMutationResult, 'figures'> | null,
): LocalStandardsFinding | null {
  const lowQualityRefs = new Set<string>()
  for (const image of qpdf.images) {
    if (image.hasAlt && (isGenericAltText(image.altText) || isBoilerplateAltText(image.altText) || isOverlongAltText(image.altText))) {
      lowQualityRefs.add(image.canonicalRef || image.ref)
    }
  }
  for (const figure of structure?.figures || []) {
    if (figure.graphicsLikelyDecorative && !figure.hasText) continue
    if (figure.hasAlt && (isGenericAltText(figure.altText) || isBoilerplateAltText(figure.altText) || isOverlongAltText(figure.altText))) {
      lowQualityRefs.add(figure.splitSourceRef || figure.ref)
    }
  }
  if (!lowQualityRefs.size) return null
  return {
    key: 'pdfua.figure_alt_quality',
    label: 'Figure alternate text quality',
    severity: 'error',
    blocking: true,
    categoryIds: ['alt_text', 'pdf_ua_compliance'],
    confidence: 0.82,
    evidence: [...lowQualityRefs].slice(0, 5).map(ref => `Figure ${ref} uses low-quality alternate text that is generic, boilerplate, or overly long.`),
    source: 'composite',
    inferred: true,
    count: lowQualityRefs.size,
  }
}

function linkTextQualityFinding(pdfjs: PdfjsResult): LocalStandardsFinding | null {
  const ambiguousLinks = pdfjs.links.filter(link => isAmbiguousLinkText(link.text))
  if (!ambiguousLinks.length) return null
  return {
    key: 'pdfua.link_text_quality',
    label: 'Link text quality',
    severity: 'error',
    blocking: true,
    categoryIds: ['link_quality', 'pdf_ua_compliance'],
    confidence: 0.84,
    evidence: ambiguousLinks.slice(0, 5).map(link => `Link text "${link.text.trim()}" is ambiguous when read out of context.`),
    source: 'pdfjs',
    inferred: false,
    count: ambiguousLinks.length,
  }
}

function headingContentFinding(
  qpdf: QpdfResult,
  structure?: Pick<StructureBackendMutationResult, 'headings'> | null,
): LocalStandardsFinding | null {
  const evidence: string[] = []
  let count = 0

  const numberedLevels = qpdf.headings
    .map(heading => heading.level)
    .filter(level => /^H[1-6]$/i.test(level))
  if (numberedLevels.length > 0 && !numberedLevels.some(level => /^H1$/i.test(level))) {
    count += 1
    evidence.push('The document contains headings but no main H1 heading was detected.')
  }

  const snapshotHeadings = (structure?.headings || []).filter(heading =>
    EXPLICIT_HEADING_TAG_RE.test(String(heading.tag || ''))
    || LEGACY_HEADING_TAG_RE.test(String(heading.tag || '')),
  )
  const readableHeadings = snapshotHeadings.filter(heading => normalizeSemanticText(heading.text).length > 0)
  const hasReliableHeadingTextCoverage = readableHeadings.length >= 2
    || (snapshotHeadings.length > 0 && (readableHeadings.length / snapshotHeadings.length) >= 0.5)
  // Older tagged PDFs can expose valid heading structure while our MCID-to-text snapshot
  // still fails to recover enough readable heading text to distinguish a true empty heading
  // from a text-recovery blind spot. Only trust empty-heading detection once the same
  // document produced a reliable baseline of readable heading text.
  const emptyHeadings = hasReliableHeadingTextCoverage
    ? snapshotHeadings.filter(heading => normalizeSemanticText(heading.text).length === 0)
    : []
  const genericHeadings = snapshotHeadings.filter(heading => isGenericHeadingText(heading.text))
  if (emptyHeadings.length > 0) {
    count += emptyHeadings.length
    evidence.push(...emptyHeadings.slice(0, 3).map(heading => `Heading ${heading.ref} is tagged as ${heading.tag} but has no readable heading text.`))
  }
  if (genericHeadings.length > 0) {
    count += genericHeadings.length
    evidence.push(...genericHeadings.slice(0, 3).map(heading => `Heading ${heading.ref} uses generic text "${String(heading.text || '').trim()}".`))
  }
  if (!count) return null

  return {
    key: 'pdfua.heading_content_quality',
    label: 'Heading content quality',
    severity: 'error',
    blocking: true,
    categoryIds: ['heading_structure', 'pdf_ua_compliance'],
    confidence: snapshotHeadings.length > 0 ? 0.86 : 0.74,
    evidence,
    source: snapshotHeadings.length > 0 ? 'structure_backend' : 'composite',
    inferred: snapshotHeadings.length === 0,
    count,
  }
}

function partialArtifactFinding(qpdf: QpdfResult, pdfjs: PdfjsResult): LocalStandardsFinding | null {
  const semanticCoveragePresent = qpdf.headings.length > 0
    || qpdf.tables.length > 0
    || qpdf.images.length > 0
    || (qpdf.linkStructCount ?? 0) > 0
  if (!qpdf.hasStructTree || pdfjs.textLength === 0 || qpdf.contentOrder.length > 0 || semanticCoveragePresent) return null
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
    structure?: Pick<StructureBackendMutationResult, 'structuralNodes' | 'figures' | 'headings' | 'imageStructNodes' | 'acrobatAltRiskNodes' | 'readingOrderNodes'> | null
  },
): LocalStandardsReport {
  const findings: LocalStandardsFinding[] = []
  pushFinding(findings, missingLogicalStructureFinding(qpdf, pdfjs, options?.structure))
  pushFinding(findings, documentLanguageFinding(qpdf, pdfjs))
  pushFinding(findings, displayDocTitleFinding(qpdf, pdfjs))
  pushFinding(findings, metadataIdentificationFinding(qpdf))
  pushFinding(findings, bookmarkLanguageFinding(qpdf, pdfjs))
  pushFinding(findings, fontEmbeddingFinding(qpdf))
  pushFinding(findings, fontUnicodeFinding(qpdf))
  pushFinding(findings, cidSymbolFontFinding(qpdf))
  pushFinding(findings, cidSetConsistencyFinding(qpdf))
  pushFinding(findings, pageTabsFinding(options?.tabOrder))
  pushFinding(findings, annotationAltContentsFinding(qpdf, pdfjs))
  pushFinding(findings, linkTaggingFinding(qpdf, pdfjs, options?.structure))
  pushFinding(findings, noteTagIdFinding(qpdf))
  pushFinding(findings, fontWidthsFinding(qpdf))
  pushFinding(findings, tableRegularityFinding(qpdf))
  pushFinding(findings, complexTableStructureFinding(qpdf))
  pushFinding(findings, altTextQualityFinding(qpdf, options?.structure))
  pushFinding(findings, linkTextQualityFinding(pdfjs))
  pushFinding(findings, headingContentFinding(qpdf, options?.structure))
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
