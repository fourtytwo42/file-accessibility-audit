import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const execFileAsync = promisify(execFile)
const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const apiRoot = path.resolve(moduleDir, '../..')
dotenv.config({ path: path.resolve(apiRoot, '.env'), override: false })
dotenv.config({ path: path.resolve(apiRoot, '../../.env'), override: false })
const PYTHON_BIN = process.env.PYTHON_PATH || 'python'
const HELPER_PATH = path.resolve(
  moduleDir,
  '../../scripts/pdf_structure_helper.py',
)

function structureBackendTimeoutMs(mutation: StructureBackendMutationRequest): number {
  if (mutation.operation === 'repair_other_elements_alt_text') return 900_000
  if (mutation.operation === 'tag_unowned_annotations') return 120_000
  if (mutation.operation === 'inspect' && mutation.inspectMode === 'alt_text_deep') return 45_000
  if (mutation.operation === 'inspect') return 120_000
  return 60_000
}

export interface StructureBackendMutationRequest {
  operation:
    | 'inspect'
    | 'batch_mutate'
    | 'bootstrap_struct_tree'
    | 'set_pdfua_identification'
    | 'normalize_annotation_tab_order'
    | 'embed_missing_fonts_in_place'
    | 'repair_cid_symbol_font_maps'
    | 'repair_cidset_consistency'
    | 'repair_structure_conformance'
    | 'repair_note_tag_ids'
    | 'repair_native_marked_content_refs'
    | 'repair_native_link_structure'
    | 'tag_unowned_annotations'
    | 'set_link_annotation_contents'
    | 'repair_bootstrapped_chart_content_refs'
    | 'repair_native_figure_semantics'
    | 'repair_other_elements_alt_text'
    | 'repair_native_table_headers'
    | 'repair_native_reading_order'
    | 'repair_font_unicode_maps'
    | 'repair_type1_font_unicode_maps'
    | 'repair_truetype_encoding_differences'
    | 'repair_annotation_alt_text'
    | 'set_tabs_all_annotated_pages'
    | 'substitute_legacy_fonts_in_place'
    | 'finalize_substituted_font_conformance'
    | 'repair_malformed_bdc_operators'
    | 'artifact_nonsemantic_page_elements'
    | 'replace_bookmarks_from_headings'
    | 'create_heading_tag'
    | 'create_heading_from_candidate'
    | 'normalize_heading_hierarchy'
    | 'normalize_nested_figure_containers'
    | 'retag_node'
    | 'set_table_header_cells'
    | 'set_figure_alt_text'
    | 'retag_as_figure_and_set_alt'
    | 'mark_figure_decorative'
    | 'reorder_structure_children'
  inspectMode?: 'light' | 'alt_text_deep'
  targets?: string[]
  headingLevels?: string[]
  targetTag?: string
  targetRef?: string
  level?: string
  text?: string
  contents?: string
  altText?: string
  pageNumber?: number
  annotationIndex?: number
  pageImageCount?: number
  textDensityHint?: 'low' | 'medium' | 'high'
  imageEvidence?: 'strong' | 'vector' | 'weak'
  parentRef?: string
  orderedTargets?: string[]
  expectedDisorderBefore?: number
  title?: string
  language?: string
  part?: number
  conformance?: string
  maxWidthDrift?: number
  reportedWidthFixes?: Array<{ fontName: string; code: number; width: number }>
  headings?: Array<{ text: string; level: string; pageNumber?: number; targetRef?: string | null }>
  figures?: Array<{ altText: string }>
  includeSnapshot?: boolean
  maxRepairsPerRun?: number
  maxElapsedMs?: number
}

export interface StructureBackendMutationResult {
  status: 'applied' | 'no_effect' | 'unsupported' | 'failed'
  changedDocumentBytes: boolean
  fontOperationSummary?: {
    operation: string
    embeddedFontProgramsAdded: number
    toUnicodeMapsAdded: number
    cidSetStreamsRebuilt: number
    substituteFontsApplied: number
    widthFixesApplied: number
    unresolvedWarningCount: number
  }
  figureOperationSummary?: {
    operation: string
    figureNodesRetagged: number
    figureAltPreserved: number
    figureAltPlaceholdersCreated: number
    graphicsOnlyOwnersPromoted: number
    mixedOwnersSkipped: number
    unsafeCandidateCount: number
    unresolvedWarningCount: number
  }
  appliedMutations: Array<{
    ref: string
    before?: string | null
    after?: string | null
    details: string
  }>
  warnings: string[]
  headings: Array<{ ref: string; tag: string; parentRef?: string | null; text?: string | null }>
  structuralNodes: Array<{ ref: string; tag: string; parentRef?: string | null; orderIndex: number; parentTagPath?: string[] }>
  tables: Array<{
    ref: string
    firstRowCellRefs: string[]
    headerCellRefs: string[]
    pageNumberHints?: number[]
  }>
  figures: Array<{
    ref: string
    tag: string
    hasAlt: boolean
    altText?: string | null
    childFigureCount?: number
    parentTagPath?: string[]
    pageRef?: string | null
    mcids?: number[]
    hasText?: boolean
    graphicsLikelyDecorative?: boolean
    splitGenerated?: boolean
    splitSourceRef?: string | null
    splitSourceTag?: string | null
  }>
  imageStructNodes?: Array<{ ref: string; tag: string; hasAlt: boolean; altText?: string | null; parentTagPath?: string[]; mcids?: number[]; hasText?: boolean; graphicsDominant?: boolean }>
  untaggedTopLevelContentGroups?: Array<{
    ref: string
    pageRef?: string | null
    pageNumber?: number
    groupIndex?: number
    hasText?: boolean
    hasGraphics?: boolean
    kind?: 'text' | 'graphics' | 'text+graphics'
  }>
  acrobatAltRiskNodes?: Array<{
    ref: string
    tag: string
    pageRef?: string | null
    mcids?: number[]
    hasText?: boolean
    hasGraphics?: boolean
    hasAlt?: boolean
    splitSafe?: boolean
    containmentSafe?: boolean
    graphicsLikelyDecorative?: boolean
    graphicsDominant?: boolean
    textOpCount?: number
    graphicsOpCount?: number
    operatorPattern?: 'text_then_graphics' | 'graphics_then_text' | 'interleaved' | null
    visibleSegmentCount?: number
    sawTextOutsideBt?: boolean
    sawGraphicsInsideText?: boolean
    parentTagPath?: string[]
    ownershipMode?: 'mixed_text_graphics_same_mcid' | 'graphics_only_nonfigure' | 'duplicate_mcid_ownership' | 'container_with_graphics_descendants' | 'orphaned_alt_empty_element' | 'nonfigure_with_alt' | 'untagged_image_mcid' | 'untagged_image_direct' | 'nested_alt_text_hides_content'
    duplicateOwnerRefs?: string[]
  }>
  readingOrderNodes: Array<{ ref: string; tag: string; parentRef?: string | null; orderIndex: number }>
  readingOrderParents: Array<{
    parentRef: string
    childRefs: string[]
    childTags: string[]
    mutableKids: boolean
    mcidDisorderBefore: number
    pageNumberHints: number[]
    suggestedChildRefs: string[]
  }>
  outputBuffer?: Buffer
}

export interface StructureBackendOperationResult {
  operation: string
  status: 'applied' | 'no_effect' | 'unsupported'
  changedDocumentBytes: boolean
  fontOperationSummary?: StructureBackendMutationResult['fontOperationSummary']
  figureOperationSummary?: StructureBackendMutationResult['figureOperationSummary']
  appliedMutations: StructureBackendMutationResult['appliedMutations']
  warnings: string[]
}

export interface StructureBackendBatchResult extends StructureBackendMutationResult {
  operationResults: StructureBackendOperationResult[]
}

function ensureHelperExists(): void {
  if (!fs.existsSync(HELPER_PATH)) {
    throw new Error(`PDF structure helper not found at ${HELPER_PATH}`)
  }
}

export async function runPdfStructureBackend(input: {
  buffer: Buffer
  mutation: StructureBackendMutationRequest
}): Promise<StructureBackendMutationResult> {
  ensureHelperExists()
  const timeoutMs = structureBackendTimeoutMs(input.mutation)

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-struct-'))
  const inputPath = path.join(tmpRoot, `${randomUUID()}.pdf`)
  const requestPath = path.join(tmpRoot, `${randomUUID()}.json`)
  const outputPath = path.join(tmpRoot, `${randomUUID()}.pdf`)

  try {
    await fs.promises.writeFile(inputPath, input.buffer)
    const requestPayload: StructureBackendMutationRequest = {
      includeSnapshot: input.mutation.operation === 'inspect',
      ...input.mutation,
    }
    await fs.promises.writeFile(requestPath, JSON.stringify(requestPayload, null, 2))

    const { stdout, stderr } = await execFileAsync(PYTHON_BIN, [
      HELPER_PATH,
      '--input',
      inputPath,
      '--request',
      requestPath,
      '--output',
      outputPath,
    ], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
      windowsHide: true,
    })

    const parsed = JSON.parse(stdout) as StructureBackendMutationResult
    if ((parsed.status === 'applied' || parsed.changedDocumentBytes) && fs.existsSync(outputPath)) {
      parsed.outputBuffer = await fs.promises.readFile(outputPath)
    }
    if (stderr?.trim()) {
      parsed.warnings = [...parsed.warnings, stderr.trim()]
    }
    return parsed
  } catch (error: any) {
    return {
      status: 'failed',
      changedDocumentBytes: false,
      fontOperationSummary: undefined,
      figureOperationSummary: undefined,
      appliedMutations: [],
      warnings: [error?.message || 'Structure backend failed.'],
      headings: [],
      structuralNodes: [],
      tables: [],
      figures: [],
      imageStructNodes: [],
      acrobatAltRiskNodes: [],
      readingOrderNodes: [],
      readingOrderParents: [],
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}

export const __test_structureBackendTimeoutMs = structureBackendTimeoutMs

/**
 * Run multiple mutations in a single Python subprocess invocation.
 * Each mutation is applied sequentially on the same pikepdf.Pdf object — one
 * file open, one file save, one snapshot — dramatically reducing spawn overhead
 * when a stage has many deterministic tools to apply.
 *
 * Per-operation outcomes are returned in `result.operationResults` so callers
 * can map back to individual tool records in the DocumentModel.
 */
export async function runPdfStructureBackendBatch(input: {
  buffer: Buffer
  mutations: StructureBackendMutationRequest[]
  /** Whether to include a final structure snapshot after all mutations. Default: true */
  includeSnapshot?: boolean
  /** Snapshot mode for the final snapshot after all mutations. Default: 'light' */
  inspectMode?: 'light' | 'alt_text_deep'
}): Promise<StructureBackendBatchResult> {
  ensureHelperExists()
  if (input.mutations.length === 0) {
    throw new Error('runPdfStructureBackendBatch: mutations array must be non-empty')
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-struct-batch-'))
  const inputPath = path.join(tmpRoot, `${randomUUID()}.pdf`)
  const requestPath = path.join(tmpRoot, `${randomUUID()}.json`)
  const outputPath = path.join(tmpRoot, `${randomUUID()}.pdf`)

  try {
    await fs.promises.writeFile(inputPath, input.buffer)
    const requestPayload = {
      operation: 'batch_mutate' as const,
      inspectMode: input.inspectMode ?? 'light',
      includeSnapshot: input.includeSnapshot ?? true,
      operations: input.mutations.map(m => ({ includeSnapshot: false, ...m })),
    }
    await fs.promises.writeFile(requestPath, JSON.stringify(requestPayload, null, 2))

    const { stdout, stderr } = await execFileAsync(PYTHON_BIN, [
      HELPER_PATH,
      '--input', inputPath,
      '--request', requestPath,
      '--output', outputPath,
    ], {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
      windowsHide: true,
    })

    const parsed = JSON.parse(stdout) as StructureBackendBatchResult
    if ((parsed.status === 'applied' || parsed.changedDocumentBytes) && fs.existsSync(outputPath)) {
      parsed.outputBuffer = await fs.promises.readFile(outputPath)
    }
    if (stderr?.trim()) {
      parsed.warnings = [...(parsed.warnings ?? []), stderr.trim()]
    }
    parsed.operationResults = parsed.operationResults ?? []
    return parsed
  } catch (error: any) {
    return {
      status: 'failed',
      changedDocumentBytes: false,
      fontOperationSummary: undefined,
      figureOperationSummary: undefined,
      appliedMutations: [],
      warnings: [error?.message || 'Structure backend batch failed.'],
      headings: [],
      structuralNodes: [],
      tables: [],
      figures: [],
      imageStructNodes: [],
      acrobatAltRiskNodes: [],
      readingOrderNodes: [],
      readingOrderParents: [],
      operationResults: [],
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}
