import { createHash, randomUUID } from 'node:crypto'
import db from '../db/sqlite.js'
import type {
  DocumentModel,
  FailureProfile,
  FailureSignature,
  PlaybookEntry,
  PlaybookPageCountRange,
  PlaybookPdfClass,
  PlaybookRun,
  PlaybookRunOutcome,
  PlaybookStatus,
  PlaybookStep,
  RemediationActionRecord,
  ToolOpportunityScope,
} from './documentModel.js'
import type { AnalysisResult } from './pdfAnalyzer.js'
import type { PdfRemediationContext } from './pdfRemediationTools.js'
import type { QpdfResult } from './qpdfService.js'

type PlaybookEntryRow = {
  id: string
  failure_signature_hash: string
  failure_mode_keys: string
  pdf_class: PlaybookPdfClass
  tool_sequence: string
  has_images: number
  has_forms: number
  has_tables: number
  page_count_range: PlaybookPageCountRange
  initial_score: number
  final_score: number
  success_count: number
  failure_count: number
  total_attempts: number
  avg_rounds: number
  status: PlaybookStatus
  created_at: string
  updated_at: string
  last_used_at: string | null
}

type PlaybookRunRow = {
  id: string
  playbook_id: string
  failure_signature_hash: string
  pdf_class: PlaybookPdfClass
  matched_exact: number
  outcome: PlaybookRunOutcome
  initial_score: number
  final_score: number | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T
}

function mapPlaybookEntry(row: PlaybookEntryRow): PlaybookEntry {
  return {
    id: row.id,
    failureSignatureHash: row.failure_signature_hash,
    failureModeKeys: parseJson<string[]>(row.failure_mode_keys),
    pdfClass: row.pdf_class,
    toolSequence: parseJson<PlaybookStep[]>(row.tool_sequence),
    hasImages: row.has_images === 1,
    hasForms: row.has_forms === 1,
    hasTables: row.has_tables === 1,
    pageCountRange: row.page_count_range,
    initialScore: row.initial_score,
    finalScore: row.final_score,
    successCount: row.success_count,
    failureCount: row.failure_count,
    totalAttempts: row.total_attempts,
    avgRounds: row.avg_rounds,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  }
}

function mapPlaybookRun(row: PlaybookRunRow): PlaybookRun {
  return {
    id: row.id,
    playbookId: row.playbook_id,
    failureSignatureHash: row.failure_signature_hash,
    pdfClass: row.pdf_class,
    matchedExact: row.matched_exact === 1,
    outcome: row.outcome,
    initialScore: row.initial_score,
    finalScore: row.final_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function updatePlaybookStatus(entry: Pick<PlaybookEntry, 'successCount' | 'totalAttempts'>): PlaybookStatus {
  const rate = entry.totalAttempts > 0 ? entry.successCount / entry.totalAttempts : 0
  if (entry.totalAttempts >= 10 && rate < 0.5) return 'deprecated'
  if (entry.successCount >= 5 && rate >= 0.8) return 'hardened'
  if (entry.successCount >= 2) return 'validated'
  return 'candidate'
}

export function classifyPlaybookPdf(input: {
  analysis: AnalysisResult
  context: Pick<PdfRemediationContext, 'qpdf'> | null
}): PlaybookPdfClass {
  if (input.analysis.isScanned) return 'scanned'
  if (!input.context?.qpdf?.hasStructTree) return 'untagged'
  if ((input.context.qpdf.structTreeDepth || 0) <= 1 || !input.context.qpdf.hasMarkInfo) return 'partially_tagged'
  return 'tagged'
}

export function pageCountRange(pageCount: number): PlaybookPageCountRange {
  if (pageCount <= 5) return 'small'
  if (pageCount <= 50) return 'medium'
  return 'large'
}

export function hashFailureSignature(failureModeKeys: string[], pdfClass: PlaybookPdfClass): string {
  return createHash('sha256')
    .update(JSON.stringify({ keys: [...failureModeKeys].sort(), pdfClass }))
    .digest('hex')
}

export function buildFailureSignature(input: {
  failureProfile: FailureProfile
  analysis: AnalysisResult
  context: Pick<PdfRemediationContext, 'qpdf'> | null
}): FailureSignature {
  const failureModeKeys = input.failureProfile.failureModes.map(mode => mode.key).sort()
  const pdfClass = classifyPlaybookPdf({
    analysis: input.analysis,
    context: input.context,
  })
  return {
    failureModeKeys,
    pdfClass,
    hash: hashFailureSignature(failureModeKeys, pdfClass),
  }
}

function actionScope(action: RemediationActionRecord): ToolOpportunityScope {
  if (action.candidateGroupId) return 'candidate_group'
  if (action.candidateId) return 'candidate'
  if (/^page\s+\d+$/i.test(action.target)) return 'page'
  return 'document'
}

export function buildPlaybookSequence(actions: RemediationActionRecord[]): PlaybookStep[] {
  const seen = new Set<string>()
  const next: PlaybookStep[] = []
  for (const action of actions) {
    if (action.outcome !== 'applied' || !action.changedDocumentBytes) continue
    const scope = actionScope(action)
    const key = `${action.tool}:${scope}`
    if (seen.has(key)) continue
    seen.add(key)
    next.push({
      tool: action.tool,
      scope,
      stage: stageForTool(action.tool),
    })
  }
  return next
}

function stageForTool(tool: RemediationActionRecord['tool']): number {
  switch (tool) {
    case 'set_pdfua_identification':
    case 'normalize_document_metadata':
    case 'set_document_title':
    case 'set_document_language':
      return 1
    case 'bootstrap_struct_tree':
    case 'repair_malformed_bdc_operators':
    case 'repair_note_tag_ids':
    case 'repair_native_marked_content_refs':
    case 'repair_bootstrapped_chart_content_refs':
    case 'repair_structure_conformance':
      return 2
    case 'repair_native_link_structure':
    case 'set_page_tabs':
    case 'normalize_annotation_tab_order':
    case 'set_tabs_all_annotated_pages':
    case 'repair_annotation_alt_text':
    case 'set_link_annotation_contents':
      return 3
    case 'embed_missing_fonts_in_place':
    case 'repair_font_unicode_maps':
    case 'repair_type1_font_unicode_maps':
    case 'repair_truetype_encoding_differences':
    case 'repair_cid_symbol_font_maps':
    case 'repair_cidset_consistency':
    case 'substitute_legacy_fonts_in_place':
    case 'finalize_substituted_font_conformance':
      return 4
    case 'repair_other_elements_alt_text':
    case 'adobe_auto_tag':
    case 'repair_native_figure_semantics':
    case 'repair_native_table_headers':
    case 'repair_native_reading_order':
    case 'artifact_nonsemantic_page_elements':
      return 5
    default:
      return 6
  }
}

const selectPlaybookBySignatureStatement = db.prepare(`
  SELECT *
  FROM playbook_entries
  WHERE failure_signature_hash = ?
  ORDER BY
    CASE status
      WHEN 'hardened' THEN 0
      WHEN 'validated' THEN 1
      WHEN 'candidate' THEN 2
      ELSE 3
    END,
    success_count DESC,
    updated_at DESC
  LIMIT 1
`)

const selectAllPlaybooksStatement = db.prepare(`
  SELECT *
  FROM playbook_entries
  ORDER BY
    CASE status
      WHEN 'hardened' THEN 0
      WHEN 'validated' THEN 1
      WHEN 'candidate' THEN 2
      ELSE 3
    END,
    updated_at DESC
`)

const selectPlaybookByIdStatement = db.prepare('SELECT * FROM playbook_entries WHERE id = ?')
const selectPlaybookRunsByPlaybookIdStatement = db.prepare('SELECT * FROM playbook_runs WHERE playbook_id = ? ORDER BY created_at DESC LIMIT 20')
const selectToolOutcomesByPlaybookIdStatement = db.prepare(`
  SELECT *
  FROM tool_outcomes
  WHERE playbook_id = ?
  ORDER BY created_at DESC
  LIMIT 50
`)

const insertPlaybookEntryStatement = db.prepare(`
  INSERT INTO playbook_entries (
    id,
    failure_signature_hash,
    failure_mode_keys,
    pdf_class,
    tool_sequence,
    has_images,
    has_forms,
    has_tables,
    page_count_range,
    initial_score,
    final_score,
    success_count,
    failure_count,
    total_attempts,
    avg_rounds,
    status,
    created_at,
    updated_at,
    last_used_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

const updatePlaybookEntryStatement = db.prepare(`
  UPDATE playbook_entries
  SET
    tool_sequence = ?,
    has_images = ?,
    has_forms = ?,
    has_tables = ?,
    page_count_range = ?,
    initial_score = ?,
    final_score = ?,
    success_count = ?,
    failure_count = ?,
    total_attempts = ?,
    avg_rounds = ?,
    status = ?,
    updated_at = ?,
    last_used_at = ?
  WHERE id = ?
`)

const insertPlaybookRunStatement = db.prepare(`
  INSERT INTO playbook_runs (
    id,
    playbook_id,
    failure_signature_hash,
    pdf_class,
    matched_exact,
    outcome,
    initial_score,
    final_score,
    created_at,
    updated_at,
    completed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

const updatePlaybookRunStatement = db.prepare(`
  UPDATE playbook_runs
  SET outcome = ?, final_score = ?, updated_at = ?, completed_at = ?
  WHERE id = ?
`)

export function findUsablePlaybookBySignatureHash(hash: string): PlaybookEntry | null {
  const row = selectPlaybookBySignatureStatement.get(hash) as PlaybookEntryRow | undefined
  if (!row) return null
  const entry = mapPlaybookEntry(row)
  return entry.status === 'validated' || entry.status === 'hardened' ? entry : null
}

export function listPlaybooks(): PlaybookEntry[] {
  return (selectAllPlaybooksStatement.all() as PlaybookEntryRow[]).map(mapPlaybookEntry)
}

export function getPlaybookById(id: string): PlaybookEntry | null {
  const row = selectPlaybookByIdStatement.get(id) as PlaybookEntryRow | undefined
  return row ? mapPlaybookEntry(row) : null
}

export function getPlaybookDetail(id: string): {
  playbook: PlaybookEntry | null
  runs: PlaybookRun[]
  toolOutcomes: any[]
} {
  return {
    playbook: getPlaybookById(id),
    runs: (selectPlaybookRunsByPlaybookIdStatement.all(id) as PlaybookRunRow[]).map(mapPlaybookRun),
    toolOutcomes: selectToolOutcomesByPlaybookIdStatement.all(id) as any[],
  }
}

export function createPlaybookRun(input: {
  playbook: PlaybookEntry
  failureSignature: FailureSignature
  initialScore: number
}): PlaybookRun {
  const timestamp = nowIso()
  const run: PlaybookRun = {
    id: randomUUID(),
    playbookId: input.playbook.id,
    failureSignatureHash: input.failureSignature.hash,
    pdfClass: input.failureSignature.pdfClass,
    matchedExact: true,
    outcome: 'pending',
    initialScore: input.initialScore,
    finalScore: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  }
  insertPlaybookRunStatement.run(
    run.id,
    run.playbookId,
    run.failureSignatureHash,
    run.pdfClass,
    1,
    run.outcome,
    run.initialScore,
    null,
    run.createdAt,
    run.updatedAt,
    null,
  )
  return run
}

export function finalizePlaybookRun(input: {
  playbook: PlaybookEntry
  run: PlaybookRun
  outcome: Extract<PlaybookRunOutcome, 'succeeded' | 'failed'>
  finalScore: number
}): PlaybookRun {
  const completedAt = nowIso()
  updatePlaybookRunStatement.run(input.outcome, input.finalScore, completedAt, completedAt, input.run.id)

  const nextEntry: PlaybookEntry = {
    ...input.playbook,
    successCount: input.playbook.successCount + (input.outcome === 'succeeded' ? 1 : 0),
    failureCount: input.playbook.failureCount + (input.outcome === 'failed' ? 1 : 0),
    totalAttempts: input.playbook.totalAttempts + 1,
    status: input.playbook.status,
    updatedAt: completedAt,
    lastUsedAt: completedAt,
  }
  nextEntry.status = updatePlaybookStatus(nextEntry)
  updatePlaybookEntryStatement.run(
    JSON.stringify(nextEntry.toolSequence),
    nextEntry.hasImages ? 1 : 0,
    nextEntry.hasForms ? 1 : 0,
    nextEntry.hasTables ? 1 : 0,
    nextEntry.pageCountRange,
    nextEntry.initialScore,
    nextEntry.finalScore,
    nextEntry.successCount,
    nextEntry.failureCount,
    nextEntry.totalAttempts,
    nextEntry.avgRounds,
    nextEntry.status,
    nextEntry.updatedAt,
    nextEntry.lastUsedAt,
    nextEntry.id,
  )

  return {
    ...input.run,
    outcome: input.outcome,
    finalScore: input.finalScore,
    updatedAt: completedAt,
    completedAt,
  }
}

export function learnFromSuccessfulRemediation(input: {
  failureSignature: FailureSignature
  initialAnalysis: AnalysisResult
  initialContext: Pick<PdfRemediationContext, 'qpdf'>
  finalAnalysis: AnalysisResult
  model: DocumentModel
  matchedPlaybookId?: string | null
  incrementStats?: boolean
}): PlaybookEntry | null {
  const toolSequence = buildPlaybookSequence(input.model.actions || [])
  if (!toolSequence.length) return null

  const existing = getPlaybookBySignatureHash(input.failureSignature.hash)
  const timestamp = nowIso()
  if (!existing) {
    const entry: PlaybookEntry = {
      id: randomUUID(),
      failureSignatureHash: input.failureSignature.hash,
      failureModeKeys: input.failureSignature.failureModeKeys,
      pdfClass: input.failureSignature.pdfClass,
      toolSequence,
      hasImages: input.initialContext.qpdf.images.length > 0,
      hasForms: input.initialContext.qpdf.hasAcroForm || input.initialContext.qpdf.formFields.length > 0,
      hasTables: input.initialContext.qpdf.tables.length > 0,
      pageCountRange: pageCountRange(input.initialAnalysis.pageCount),
      initialScore: input.initialAnalysis.overallScore,
      finalScore: input.finalAnalysis.overallScore,
      successCount: 1,
      failureCount: 0,
      totalAttempts: 1,
      avgRounds: input.model.iterations?.length || 1,
      status: 'candidate',
      createdAt: timestamp,
      updatedAt: timestamp,
      lastUsedAt: input.matchedPlaybookId ? timestamp : null,
    }
    insertPlaybookEntryStatement.run(
      entry.id,
      entry.failureSignatureHash,
      JSON.stringify(entry.failureModeKeys),
      entry.pdfClass,
      JSON.stringify(entry.toolSequence),
      entry.hasImages ? 1 : 0,
      entry.hasForms ? 1 : 0,
      entry.hasTables ? 1 : 0,
      entry.pageCountRange,
      entry.initialScore,
      entry.finalScore,
      entry.successCount,
      entry.failureCount,
      entry.totalAttempts,
      entry.avgRounds,
      entry.status,
      entry.createdAt,
      entry.updatedAt,
      entry.lastUsedAt,
    )
    return entry
  }

  const incrementStats = input.incrementStats ?? !input.matchedPlaybookId
  const totalAttempts = incrementStats ? existing.totalAttempts + 1 : existing.totalAttempts
  const successCount = incrementStats ? existing.successCount + 1 : existing.successCount
  const avgRounds = incrementStats
    ? (((existing.avgRounds * existing.totalAttempts) + (input.model.iterations?.length || 1)) / totalAttempts)
    : existing.avgRounds

  const nextEntry: PlaybookEntry = {
    ...existing,
    failureModeKeys: input.failureSignature.failureModeKeys,
    pdfClass: input.failureSignature.pdfClass,
    toolSequence: toolSequence.length >= existing.toolSequence.length ? toolSequence : existing.toolSequence,
    hasImages: input.initialContext.qpdf.images.length > 0,
    hasForms: input.initialContext.qpdf.hasAcroForm || input.initialContext.qpdf.formFields.length > 0,
    hasTables: input.initialContext.qpdf.tables.length > 0,
    pageCountRange: pageCountRange(input.initialAnalysis.pageCount),
    initialScore: input.initialAnalysis.overallScore,
    finalScore: input.finalAnalysis.overallScore,
    successCount,
    totalAttempts,
    avgRounds,
    updatedAt: timestamp,
    lastUsedAt: input.matchedPlaybookId ? timestamp : existing.lastUsedAt,
    status: existing.status,
  }
  nextEntry.status = updatePlaybookStatus(nextEntry)
  updatePlaybookEntryStatement.run(
    JSON.stringify(nextEntry.toolSequence),
    nextEntry.hasImages ? 1 : 0,
    nextEntry.hasForms ? 1 : 0,
    nextEntry.hasTables ? 1 : 0,
    nextEntry.pageCountRange,
    nextEntry.initialScore,
    nextEntry.finalScore,
    nextEntry.successCount,
    nextEntry.failureCount,
    nextEntry.totalAttempts,
    nextEntry.avgRounds,
    nextEntry.status,
    nextEntry.updatedAt,
    nextEntry.lastUsedAt,
    nextEntry.id,
  )
  return nextEntry
}

export function getPlaybookBySignatureHash(hash: string): PlaybookEntry | null {
  const row = selectPlaybookBySignatureStatement.get(hash) as PlaybookEntryRow | undefined
  return row ? mapPlaybookEntry(row) : null
}

export function __test_resetPlaybooks(): void {
  db.prepare('DELETE FROM playbook_runs').run()
  db.prepare('DELETE FROM playbook_entries').run()
}
