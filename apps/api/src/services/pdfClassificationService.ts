import { REMEDIATION } from '#config'
import type {
  PdfAuthoringTool,
  PdfClassification,
  PdfFontProfile,
  PipelineConfig,
  PlaybookPdfClass,
  PdfScale,
  PdfStructuralClass,
  PdfTextDensity,
  PdfRemediationDepth,
  RemediationToolName,
} from './documentModel.js'
import type { AnalysisResult } from './pdfAnalyzer.js'
import type { PdfjsResult } from './pdfjsService.js'
import type { PdfRemediationContext } from './pdfRemediationTools.js'
import type { QpdfResult } from './qpdfService.js'
import type { PdfClass } from './toolReliabilityService.js'

export const RECLASSIFICATION_TRIGGER_TOOLS = new Set<RemediationToolName>([
  'ocr_scanned_pdf',
  'bootstrap_struct_tree',
  'substitute_legacy_fonts_in_place',
])

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] || 0
}

export function classifyStructure(input: {
  qpdf: Pick<QpdfResult, 'hasStructTree' | 'structTreeDepth' | 'hasMarkInfo' | 'headings'>
  pdfjs: Pick<PdfjsResult, 'hasText'>
  analysis: Pick<AnalysisResult, 'isScanned' | 'categories'>
}): PdfStructuralClass {
  if (input.analysis.isScanned || (!input.pdfjs.hasText && !input.qpdf.hasStructTree)) return 'scanned'
  if (!input.qpdf.hasStructTree) return 'untagged_digital'
  if ((input.qpdf.structTreeDepth || 0) <= 1 || !input.qpdf.hasMarkInfo) return 'partially_tagged'

  const categoryScores = input.analysis.categories
    .map(category => category.score)
    .filter((score): score is number => typeof score === 'number')
  const categoryScoreById = new Map(
    input.analysis.categories.map(category => [category.id, category.score]),
  )
  const semanticCategoriesHealthy = ['alt_text', 'heading_structure', 'table_markup', 'link_quality']
    .every(categoryId => {
      const score = categoryScoreById.get(categoryId)
      return score == null || score >= 80
    })
  if (
    (input.qpdf.structTreeDepth || 0) >= 3
    && (input.qpdf.headings?.length || 0) > 0
    && median(categoryScores) >= 80
    && semanticCategoriesHealthy
  ) {
    return 'well_tagged'
  }
  return 'native_tagged'
}

export function classifyContent(input: {
  qpdf: Pick<QpdfResult, 'images' | 'tables' | 'hasAcroForm' | 'formFields' | 'noteTagCount'>
  pdfjs: Pick<PdfjsResult, 'hasText' | 'textLength' | 'imageCount' | 'links'>
}): PdfClassification['contentProfile'] {
  let textDensity: PdfTextDensity = 'normal'
  if (!input.pdfjs.hasText) textDensity = 'none'
  else if (input.pdfjs.textLength < 200) textDensity = 'sparse'
  else if (input.pdfjs.textLength > 5000) textDensity = 'dense'

  const tableCount = input.qpdf.tables?.length || 0
  return {
    textDensity,
    hasImages: (input.qpdf.images?.length || 0) > 0 || (input.pdfjs.imageCount || 0) > 0,
    hasComplexTables: tableCount > 0 && input.qpdf.tables.some(table => !table.hasHeaders),
    hasSimpleTables: tableCount > 0 && input.qpdf.tables.every(table => table.hasHeaders),
    hasForms: !!input.qpdf.hasAcroForm && (input.qpdf.formFields?.length || 0) > 0,
    hasLinks: (input.pdfjs.links?.length || 0) > 0,
    hasFootnotes: (input.qpdf.noteTagCount || 0) > 0,
  }
}

export function fingerprintAuthoringTool(metadata: PdfjsResult['metadata']): PdfAuthoringTool {
  const producer = String(metadata?.producer || '').toLowerCase()
  const creator = String(metadata?.creator || '').toLowerCase()
  const combined = `${producer} ${creator}`.trim()
  if (/crystal\s*reports/.test(combined)) return 'crystal_reports'
  if (/microsoft.*word|docx/.test(combined)) return 'microsoft_word'
  if (/indesign/.test(combined)) return 'adobe_indesign'
  if (/acrobat|adobe.*pdf/.test(combined)) return 'adobe_acrobat'
  if (/libreoffice|openoffice/.test(combined)) return 'libreoffice'
  if (/pdftex|xetex|luatex|latex/.test(combined)) return 'latex'
  if (/chrome|chromium|headless/.test(combined)) return 'chrome_print'
  if (/scan|fujitsu|epson|canon|kofax|abbyy/.test(combined)) return 'scanner'

  const pdfVersion = Number.parseFloat(metadata?.pdfVersion || '1.7')
  if ((!metadata?.producer || !String(metadata.producer).trim()) && Number.isFinite(pdfVersion) && pdfVersion <= 1.4) {
    return 'government_cms'
  }
  return 'unknown'
}

export function classifyFonts(qpdf: Pick<QpdfResult,
  'fontCount' | 'unembeddedFontCount' | 'unembeddedType3FontCount' | 'fontsMissingToUnicode' | 'type1FontsMissingToUnicode' | 'legacyWidthRiskFontCount' | 'cidFontsMissingCidToGidMap'
>): PdfFontProfile {
  if ((qpdf.fontCount || 0) === 0) return 'no_fonts'
  const unembedded = qpdf.unembeddedFontCount || 0
  const unembeddedType3 = qpdf.unembeddedType3FontCount || 0
  const missingUnicode = qpdf.fontsMissingToUnicode || 0
  const missingType1Unicode = qpdf.type1FontsMissingToUnicode || 0
  const legacyWidth = qpdf.legacyWidthRiskFontCount || 0
  const cidMissing = qpdf.cidFontsMissingCidToGidMap || 0

  if (unembeddedType3 > 0 || (legacyWidth >= 3 && cidMissing >= 2)) return 'needs_substitution'
  if (missingType1Unicode > 0 || missingUnicode >= 3 || legacyWidth >= 2) return 'legacy_encoding'
  if (unembedded > 0) return 'needs_embedding'
  if (missingUnicode === 0) return 'clean'
  return 'legacy_encoding'
}

export function classifyScale(pageCount: number): PdfScale {
  if (pageCount <= 1) return 'tiny'
  if (pageCount <= 5) return 'small'
  if (pageCount <= 50) return 'medium'
  if (pageCount <= 200) return 'large'
  return 'massive'
}

export function classifyDepth(score: number): PdfRemediationDepth {
  if (score >= 85) return 'polish'
  if (score >= 50) return 'moderate'
  if (score >= 20) return 'major'
  return 'rebuild'
}

export function classifyPdfFull(input: {
  analysis: AnalysisResult
  context: (Pick<PdfRemediationContext, 'qpdf'> & { pdfjs?: PdfRemediationContext['pdfjs'] | null }) | null
}): PdfClassification {
  const qpdf = input.context?.qpdf
  const pdfjs = input.context?.pdfjs
  return {
    structuralClass: classifyStructure({
      analysis: input.analysis,
      qpdf: {
        hasStructTree: !!qpdf?.hasStructTree,
        structTreeDepth: qpdf?.structTreeDepth || 0,
        hasMarkInfo: !!qpdf?.hasMarkInfo,
        headings: qpdf?.headings || [],
      },
      pdfjs: {
        hasText: pdfjs?.hasText ?? input.analysis.isScanned === false,
      },
    }),
    contentProfile: classifyContent({
      qpdf: {
        images: qpdf?.images || [],
        tables: qpdf?.tables || [],
        hasAcroForm: !!qpdf?.hasAcroForm,
        formFields: qpdf?.formFields || [],
        noteTagCount: qpdf?.noteTagCount || 0,
      },
      pdfjs: {
        hasText: pdfjs?.hasText ?? !input.analysis.isScanned,
        textLength: pdfjs?.textLength || 0,
        imageCount: pdfjs?.imageCount || 0,
        links: pdfjs?.links || [],
      },
    }),
    authoringTool: fingerprintAuthoringTool(pdfjs?.metadata || input.analysis.pdfMetadata),
    fontProfile: classifyFonts({
      fontCount: qpdf?.fontCount || 0,
      unembeddedFontCount: qpdf?.unembeddedFontCount || 0,
      unembeddedType3FontCount: qpdf?.unembeddedType3FontCount || 0,
      fontsMissingToUnicode: qpdf?.fontsMissingToUnicode || 0,
      type1FontsMissingToUnicode: qpdf?.type1FontsMissingToUnicode || 0,
      legacyWidthRiskFontCount: qpdf?.legacyWidthRiskFontCount || 0,
      cidFontsMissingCidToGidMap: qpdf?.cidFontsMissingCidToGidMap || 0,
    }),
    scale: classifyScale(input.analysis.pageCount),
    remediationDepth: classifyDepth(input.analysis.overallScore),
  }
}

function stageDefaults() {
  return {
    metadata: true,
    structureBootstrap: true,
    linkStructure: true,
    fonts: true,
    nativeStructure: true,
    safeCandidates: true,
  }
}

export function buildPipelineConfig(classification: PdfClassification): PipelineConfig {
  const excludedTools = new Set<RemediationToolName>()
  const config: PipelineConfig = {
    stages: stageDefaults(),
    excludedTools: [],
    maxRounds: REMEDIATION.MAX_REMEDIATION_ROUNDS,
    earlyExitScore: REMEDIATION.EARLY_EXIT_SCORE_THRESHOLD,
    semanticStrategy: 'full_ai',
  }

  switch (classification.structuralClass) {
    case 'well_tagged':
      config.stages.structureBootstrap = false
      excludedTools.add('bootstrap_struct_tree')
      excludedTools.add('ocr_scanned_pdf')
      config.maxRounds = Math.min(config.maxRounds, 2)
      config.earlyExitScore = 95
      config.semanticStrategy = 'heuristic_only'
      break
    case 'native_tagged':
      config.stages.structureBootstrap = false
      excludedTools.add('bootstrap_struct_tree')
      excludedTools.add('ocr_scanned_pdf')
      config.maxRounds = Math.min(config.maxRounds, 3)
      break
    case 'partially_tagged':
      excludedTools.add('ocr_scanned_pdf')
      config.maxRounds = Math.min(config.maxRounds, 3)
      break
    case 'untagged_digital':
      excludedTools.add('ocr_scanned_pdf')
      excludedTools.add('repair_native_marked_content_refs')
      excludedTools.add('repair_native_link_structure')
      excludedTools.add('repair_native_figure_semantics')
      excludedTools.add('repair_native_table_headers')
      excludedTools.add('repair_native_reading_order')
      break
    case 'scanned':
      config.maxRounds = Math.max(config.maxRounds, 4)
      config.semanticStrategy = 'full_ai'
      break
  }

  switch (classification.fontProfile) {
    case 'clean':
    case 'no_fonts':
      config.stages.fonts = false
      break
    case 'needs_embedding':
      excludedTools.add('substitute_legacy_fonts_in_place')
      excludedTools.add('repair_type1_font_unicode_maps')
      excludedTools.add('repair_truetype_encoding_differences')
      excludedTools.add('finalize_substituted_font_conformance')
      break
    case 'legacy_encoding':
      excludedTools.add('substitute_legacy_fonts_in_place')
      break
    case 'needs_substitution':
      break
  }

  if (!classification.contentProfile.hasLinks) {
    excludedTools.add('repair_native_link_structure')
    excludedTools.add('set_link_annotation_contents')
    excludedTools.add('repair_annotation_alt_text')
    excludedTools.add('rewrite_link_visible_text')
  }
  if (!classification.contentProfile.hasImages) {
    excludedTools.add('set_figure_alt_text')
    excludedTools.add('retag_as_figure_and_set_alt')
    excludedTools.add('mark_figure_decorative')
    excludedTools.add('repair_native_figure_semantics')
    excludedTools.add('repair_other_elements_alt_text')
    excludedTools.add('normalize_nested_figure_containers')
  }
  if (!classification.contentProfile.hasComplexTables && !classification.contentProfile.hasSimpleTables) {
    excludedTools.add('set_table_header_cells')
    excludedTools.add('repair_native_table_headers')
  }
  if (!classification.contentProfile.hasFootnotes) {
    excludedTools.add('repair_note_tag_ids')
  }

  switch (classification.remediationDepth) {
    case 'polish':
      config.maxRounds = Math.min(config.maxRounds, 2)
      config.earlyExitScore = Math.min(config.earlyExitScore, 95)
      break
    case 'moderate':
      config.maxRounds = Math.min(config.maxRounds, 3)
      break
    case 'major':
      break
    case 'rebuild':
      config.maxRounds = Math.max(config.maxRounds, 4)
      config.semanticStrategy = 'full_ai'
      break
  }

  if (classification.scale === 'massive') {
    config.semanticStrategy = 'heuristic_only'
    config.maxRounds = Math.min(config.maxRounds, 2)
  }

  config.excludedTools = [...excludedTools]
  return config
}

export function toReliabilityPdfClass(classification: PdfClassification): PdfClass {
  if (classification.contentProfile.hasForms) return 'form_heavy'
  switch (classification.structuralClass) {
    case 'scanned':
      return 'scanned'
    case 'well_tagged':
    case 'native_tagged':
      return 'native_tagged'
    case 'partially_tagged':
      return 'partially_tagged'
    case 'untagged_digital':
      return 'untagged_digital'
  }
}

export function toPlaybookPdfClass(classification: PdfClassification): PlaybookPdfClass {
  switch (classification.structuralClass) {
    case 'scanned':
      return 'scanned'
    case 'partially_tagged':
      return 'partially_tagged'
    case 'untagged_digital':
      return 'untagged'
    case 'native_tagged':
    case 'well_tagged':
      return 'tagged'
  }
}
