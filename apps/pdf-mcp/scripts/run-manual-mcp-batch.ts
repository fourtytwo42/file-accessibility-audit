import fs from 'node:fs/promises'
import syncFs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { analyzePDF } from '../../api/src/services/pdfAnalyzer.ts'
import {
  evaluatePromotionGate,
  type EvaluatePromotionGateOptions,
} from '../../api/src/services/promotionGate.ts'
import {
  summarizeManualWorklistOutcomes,
  type ManualWorklistOutcomeDocument,
  type ManualWorklistOutcomeRecord,
  type ManualWorklistResolutionReason,
  type ManualWorklistStatus,
} from '../../api/src/services/manualWorklist.ts'

const MANUAL_MCP_BATCH_PUBLICATION_IDS = ['4150', '3671', '4169', '4590'] as const

interface BatchCandidate {
  publicationId: string
  publicationTitle: string | null
  serverHost: string
  localCachePath: string | null
  inputPath: string | null
  rationale: string
  alreadyPassing: boolean
  /** When set, passing PDFs are copied here (canonical staging path from ready-to-replace verification). */
  canonicalStagedReplacementPath?: string | null
  criticalManualReviewFlagCodes?: string[]
}

interface McpToolResult {
  [key: string]: unknown
}

interface McpAnalysisSummary {
  pageCount?: number
  overallScore?: number
  grade?: string
  blockingLocalFindings?: Array<{ key?: string }>
}

interface McpFigureCandidate {
  id: string
  pageNumber?: number
  objectRef?: string | null
  repairMode?: string | null
  informativeHint?: string | null
  altText?: string | null
  currentAltText?: string | null
  existingAltText?: string | null
  alt?: string | null
  unsafe?: boolean
}

interface McpInspectSummary {
  figureCandidates?: {
    total?: number
    items?: McpFigureCandidate[]
  }
}

interface BatchManifestEntry {
  publicationId: string
  publicationTitle: string | null
  serverHost: string
  inputPath: string | null
  rationale: string
  alreadyPassing: boolean
}

interface BatchManifest {
  generatedAt: string
  queueName: string
  sourceManifestPath: string
  selectedPublicationIds: string[]
  skippedAlreadyPassingIds: string[]
  candidates: BatchManifestEntry[]
}

/** e.g. manual-mcp-next-batch.json */
interface ManualMcpBatchSourceManifest {
  generatedAt?: string
  queueName?: string
  selectedPublicationIds?: string[]
  candidates?: Array<{
    priorityRank?: number
    publicationId?: string
    publicationTitle?: string | null
    manualRationale?: string | null
  }>
}

interface ReplacementMapRow {
  publicationId?: string
  title?: string | null
  serverHost?: string | null
  checksumState?: {
    localCurrentFilePath?: string | null
  } | null
}

interface VerificationPublicationRow {
  publicationId?: string
  publicationTitle?: string | null
  serverHost?: string | null
  verificationPassed?: boolean
  verificationMissing?: boolean
  stagedReplacementPath?: string | null
  localFinalArtifactPath?: string | null
  criticalManualReviewFlagCodes?: string[]
}

type BatchLoadMode =
  | { type: 'legacy_figure_canary'; ids: string[] }
  | { type: 'manifest_and_map'; manifestPath: string; filterPublicationIds?: string[] }
  | { type: 'argv_map_only'; ids: string[] }
  | {
      type: 'verification_failures'
      verificationPath: string
      limit?: number
      offset?: number
      filterPublicationIds?: string[]
    }

interface LoadBatchResult {
  selected: BatchCandidate[]
  skippedAlreadyPassing: BatchCandidate[]
  /** Remediated input already passes gate; copy to canonical staged path + ledger (no MCP). */
  verificationPreflightPassed: BatchCandidate[]
  /** Failed verification rows we could not resolve to a local input PDF. */
  verificationNoInput: Array<{ publicationId: string; reason: string }>
}

function repoRoot() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(moduleDir, '..', '..', '..')
}

function sanitizeFilename(input: string) {
  return input.replace(/[^A-Za-z0-9._-]+/g, '_')
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

async function writeJson(filePath: string, value: unknown) {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T
}

async function collectPdfsByPublicationId(root: string, publicationId: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await collectPdfsByPublicationId(fullPath, publicationId, out)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.pdf')) continue
    if (entry.name.startsWith(`${publicationId}-`)) out.push(fullPath)
  }
}

/** Prefer real remediated waves; avoid manual-mcp-batch until last (often partial/0-byte after ENOSPC). */
async function findPdfByPublicationId(root: string, publicationId: string): Promise<string | null> {
  const files: string[] = []
  await collectPdfsByPublicationId(root, publicationId, files)
  if (files.length === 0) return null

  const sized = await Promise.all(
    files.map(async p => {
      try {
        const st = await fs.stat(p)
        return { p, size: st.size }
      } catch {
        return { p, size: 0 }
      }
    }),
  )
  const nonEmpty = sized.filter(x => x.size > 0).map(x => x.p)
  if (nonEmpty.length === 0) return null

  const preferredRoots = [
    `${path.sep}medium-figure-conversion${path.sep}`,
    `${path.sep}small-fast-pass${path.sep}`,
    `${path.sep}stage4-structure-wave${path.sep}`,
    `${path.sep}stage3-figure-wave${path.sep}`,
    `${path.sep}priority-batch${path.sep}`,
  ]
  for (const preferred of preferredRoots) {
    const hit = nonEmpty.find(file => file.includes(preferred))
    if (hit) return hit
  }

  const notManualMcp = nonEmpty.filter(f => !f.includes(`${path.sep}manual-mcp-batch${path.sep}`))
  const pool = notManualMcp.length > 0 ? notManualMcp : nonEmpty
  return pool[0] || null
}

function parseToolJson(result: any): McpToolResult {
  const text = result?.content?.find((entry: any) => entry?.type === 'text')?.text
  if (!text) {
    throw new Error('MCP tool returned no text payload.')
  }
  if (result?.isError) {
    throw new Error(text)
  }
  return JSON.parse(text) as McpToolResult
}

async function callTool<T extends McpToolResult>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({
    name,
    arguments: args,
  })
  return parseToolJson(result) as T
}

function blockingKeysFromMcpAnalysis(analysis: McpAnalysisSummary): string[] {
  return (analysis.blockingLocalFindings || [])
    .map(finding => String(finding?.key || '').trim())
    .filter(Boolean)
}

function chooseAltText(candidate: McpFigureCandidate, publicationTitle: string | null): string {
  const existing = [
    candidate.altText,
    candidate.currentAltText,
    candidate.existingAltText,
    candidate.alt,
  ]
    .map(value => String(value || '').trim())
    .find(value => value && value.toLowerCase() !== 'decorative image')
  if (existing) return existing
  const title = String(publicationTitle || '').trim()
  return title ? `${title} figure` : 'Informative figure'
}

function candidateNeedsAction(candidate: McpFigureCandidate): boolean {
  if (!candidate.id) return false
  if (candidate.unsafe) return false
  if (candidate.informativeHint === 'decorative') return true
  return candidate.repairMode === 'set_alt' || candidate.repairMode === 'retag_then_set_alt'
}

function candidateToolName(candidate: McpFigureCandidate): 'set_figure_alt_text' | 'retag_as_figure_and_set_alt' | 'mark_figure_decorative' {
  if (candidate.informativeHint === 'decorative') return 'mark_figure_decorative'
  if (candidate.repairMode === 'retag_then_set_alt') return 'retag_as_figure_and_set_alt'
  return 'set_figure_alt_text'
}

async function loadReplacementMapById(root: string): Promise<Map<string, ReplacementMapRow>> {
  const mapPath = path.join(root, 'ICJIA-PDFs', 'manifests', 'publication-pdf-replacement-map.json')
  const rows = await readJson<ReplacementMapRow[]>(mapPath)
  const byId = new Map<string, ReplacementMapRow>()
  for (const row of rows) {
    const id = String(row.publicationId || '').trim()
    if (id) byId.set(id, row)
  }
  return byId
}

function fileExistsSync(p: string): boolean {
  try {
    return syncFs.existsSync(p) && syncFs.statSync(p).isFile()
  } catch {
    return false
  }
}

async function resolveOneCandidate(
  root: string,
  publicationId: string,
  replaceById: Map<string, ReplacementMapRow>,
  remediatedRoot: string,
  meta: { publicationTitle: string | null; rationale: string },
): Promise<BatchCandidate> {
  const row = replaceById.get(publicationId)
  if (!row) {
    throw new Error(`Publication ${publicationId} not found in publication-pdf-replacement-map.json`)
  }
  const localCachePath = row.checksumState?.localCurrentFilePath || null
  const remediatedPath = await findPdfByPublicationId(remediatedRoot, publicationId)
  const inputPath =
    remediatedPath && fileExistsSync(remediatedPath)
      ? remediatedPath
      : localCachePath && fileExistsSync(localCachePath)
        ? localCachePath
        : null
  return {
    publicationId,
    publicationTitle: meta.publicationTitle || row.title || null,
    serverHost: String(row.serverHost || 'unknown-host'),
    localCachePath,
    inputPath,
    rationale: meta.rationale,
    alreadyPassing: false,
  }
}

function gateFlagsForCandidate(candidate: BatchCandidate): string[] {
  return candidate.criticalManualReviewFlagCodes?.length
    ? candidate.criticalManualReviewFlagCodes
    : []
}

/** Max pages for bootstrap + native structure repairs (default 240). Larger PDFs skip to avoid OOM/timeouts. */
function manualMcpStructureMaxPages(): number {
  const raw = Number(process.env.MANUAL_MCP_STRUCTURE_MAX_PAGES || '240')
  return Number.isFinite(raw) && raw > 0 ? raw : 240
}

/** Max figure-level pdf_apply_tool calls per publication (default 48). */
function manualMcpMaxFigureOps(): number {
  const raw = Number(process.env.MANUAL_MCP_MAX_FIGURE_OPS || '48')
  return Number.isFinite(raw) && raw > 0 ? raw : 48
}

/**
 * Default: min overall score 90 (relaxed). Set MANUAL_MCP_STRICT_PROMOTION_GATE=1 for grade A / 100 / full gate.
 * Override floor with MANUAL_MCP_MIN_OVERALL_SCORE (1–100).
 */
function manualMcpPromotionGateOptions(): EvaluatePromotionGateOptions | undefined {
  const strict = process.env.MANUAL_MCP_STRICT_PROMOTION_GATE
  if (strict === '1' || strict === 'true' || strict === 'yes') return undefined
  const raw = process.env.MANUAL_MCP_MIN_OVERALL_SCORE ?? '90'
  const min = Number(raw)
  if (!Number.isFinite(min) || min < 1 || min > 100) return { minOverallScore: 90 }
  return { minOverallScore: min }
}

function evaluateManualMcpPromotionGate(
  analysisResult: unknown,
  candidate: BatchCandidate,
  relaxedOpts: EvaluatePromotionGateOptions | undefined,
) {
  const input = {
    analysisResult,
    criticalManualReviewFlagCodes: gateFlagsForCandidate(candidate),
  }
  const strictGate = evaluatePromotionGate(input)
  const gate = relaxedOpts ? evaluatePromotionGate(input, relaxedOpts) : strictGate
  return { gate, strictGate }
}

async function prefilterPassing(candidate: BatchCandidate): Promise<BatchCandidate> {
  if (!candidate.inputPath) return candidate
  const buffer = await fs.readFile(candidate.inputPath)
  const analysis = await analyzePDF(buffer, path.basename(candidate.inputPath), {
    skipAdobe: true,
    analysisProfile: 'full_final',
  })
  const { gate } = evaluateManualMcpPromotionGate(analysis, candidate, manualMcpPromotionGateOptions())
  return { ...candidate, alreadyPassing: gate.passed }
}

async function loadVerificationFailureCandidates(
  root: string,
  mode: Extract<BatchLoadMode, { type: 'verification_failures' }>,
): Promise<LoadBatchResult> {
  const remediatedRoot = path.join(root, 'ICJIA-PDFs', 'artifacts', 'remediated-pdfs')
  const replaceById = await loadReplacementMapById(root)
  const doc = await readJson<{ publicationRows?: VerificationPublicationRow[] }>(mode.verificationPath)
  const rows = doc.publicationRows || []
  let failed = rows.filter(
    r =>
      r.publicationId
      && r.verificationPassed === false
      && !r.verificationMissing
      && r.stagedReplacementPath,
  )
  const seen = new Set<string>()
  failed = failed.filter(r => {
    const id = String(r.publicationId).trim()
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
  failed.sort((a, b) => String(a.publicationId).localeCompare(String(b.publicationId)))
  if (mode.filterPublicationIds?.length) {
    const allow = new Set(mode.filterPublicationIds)
    failed = failed.filter(r => allow.has(String(r.publicationId)))
  }
  const offset = Math.max(0, mode.offset ?? 0)
  const limit = mode.limit
  failed = typeof limit === 'number' && limit > 0 ? failed.slice(offset, offset + limit) : failed.slice(offset)

  const selected: BatchCandidate[] = []
  const skippedAlreadyPassing: BatchCandidate[] = []
  const verificationPreflightPassed: BatchCandidate[] = []
  const verificationNoInput: Array<{ publicationId: string; reason: string }> = []

  for (const row of failed) {
    const publicationId = String(row.publicationId).trim()
    const canonical = row.stagedReplacementPath ? String(row.stagedReplacementPath) : null
    const remediatedPath = await findPdfByPublicationId(remediatedRoot, publicationId)
    const remediated = remediatedPath && fileExistsSync(remediatedPath) ? remediatedPath : null
    const localFinal = row.localFinalArtifactPath && fileExistsSync(String(row.localFinalArtifactPath))
      ? String(row.localFinalArtifactPath)
      : null
    const mapRow = replaceById.get(publicationId)
    const cachePath = mapRow?.checksumState?.localCurrentFilePath
    const cache = cachePath && fileExistsSync(cachePath) ? cachePath : null
    /** Prefer remediated tree (publication-scoped) over complete-seed paths that can be wrong per row. */
    const inputPath = remediated || localFinal || cache
    const critical = Array.isArray(row.criticalManualReviewFlagCodes)
      ? row.criticalManualReviewFlagCodes.map(String)
      : []
    if (!inputPath || !canonical) {
      verificationNoInput.push({
        publicationId,
        reason: !canonical ? 'missing canonical stagedReplacementPath' : 'no local remediated/cache path',
      })
      continue
    }
    let c: BatchCandidate = {
      publicationId,
      publicationTitle: row.publicationTitle ? String(row.publicationTitle) : (mapRow?.title ? String(mapRow.title) : null),
      serverHost: String(row.serverHost || mapRow?.serverHost || 'unknown-host'),
      localCachePath: cachePath || null,
      inputPath,
      rationale: 'verify_failure_recovery_remediated_then_mcp',
      alreadyPassing: false,
      canonicalStagedReplacementPath: canonical,
      criticalManualReviewFlagCodes: critical,
    }
    c = await prefilterPassing(c)
    if (c.alreadyPassing) verificationPreflightPassed.push(c)
    else selected.push(c)
  }

  return { selected, skippedAlreadyPassing, verificationPreflightPassed, verificationNoInput }
}

async function loadBatchCandidates(root: string, mode: BatchLoadMode): Promise<LoadBatchResult> {
  const remediatedRoot = path.join(root, 'ICJIA-PDFs', 'artifacts', 'remediated-pdfs')
  const replaceById = await loadReplacementMapById(root)
  const selected: BatchCandidate[] = []
  const skippedAlreadyPassing: BatchCandidate[] = []

  if (mode.type === 'verification_failures') {
    return loadVerificationFailureCandidates(root, mode)
  }

  if (mode.type === 'legacy_figure_canary') {
    const sourceManifestPath = path.join(root, 'ICJIA-PDFs', 'manifests', 'pass-rate-figure-canary.json')
    const source = await readJson<{ candidates?: Array<{
      publicationId?: string
      publicationTitle?: string | null
      serverHost?: string | null
      localCachePath?: string | null
    }> }>(sourceManifestPath)
    const byCanary = new Map((source.candidates || []).map(candidate => [
      String(candidate.publicationId || '').trim(),
      candidate,
    ]))
    const rationaleById: Record<string, string> = {
      '4150': 'annual_report_near_pass_figure_only_mcp_manual',
      '3671': 'annual_report_near_pass_figure_only_mcp_manual',
      '4169': 'small_stubborn_figure_structure_candidate_mcp_manual',
      '4590': 'single_page_replacement_candidate_mcp_manual',
    }
    for (const publicationId of mode.ids) {
      const hit = byCanary.get(publicationId)
      if (!hit) {
        throw new Error(`Publication ${publicationId} not found in pass-rate-figure-canary.json`)
      }
      const inputPath = await findPdfByPublicationId(remediatedRoot, publicationId) || String(hit.localCachePath || '')
      let nextCandidate: BatchCandidate = {
        publicationId,
        publicationTitle: hit.publicationTitle || null,
        serverHost: String(hit.serverHost || 'unknown-host'),
        localCachePath: hit.localCachePath || null,
        inputPath: inputPath || null,
        rationale: rationaleById[publicationId] || 'manual_mcp_batch',
        alreadyPassing: false,
      }
      nextCandidate = await prefilterPassing(nextCandidate)
      if (nextCandidate.alreadyPassing) skippedAlreadyPassing.push(nextCandidate)
      else selected.push(nextCandidate)
    }
    return { selected, skippedAlreadyPassing, verificationPreflightPassed: [], verificationNoInput: [] }
  }

  const metaById = new Map<string, { publicationTitle: string | null; rationale: string }>()
  let orderedIds: string[] = []

  if (mode.type === 'manifest_and_map') {
    const doc = await readJson<ManualMcpBatchSourceManifest>(mode.manifestPath)
    const fromSelected = (doc.selectedPublicationIds || []).map(String)
    const fromCandidates = [...(doc.candidates || [])]
      .sort((a, b) => (Number(a.priorityRank) || 0) - (Number(b.priorityRank) || 0))
      .map(c => String(c.publicationId || '').trim())
      .filter(Boolean)
    orderedIds = fromSelected.length ? fromSelected : fromCandidates
    for (const c of doc.candidates || []) {
      const id = String(c.publicationId || '').trim()
      if (!id) continue
      metaById.set(id, {
        publicationTitle: c.publicationTitle ?? null,
        rationale: String(c.manualRationale || 'manual_mcp_next_batch'),
      })
    }
    if (mode.filterPublicationIds?.length) {
      const manifestSet = new Set(orderedIds)
      orderedIds = mode.filterPublicationIds.filter(id => manifestSet.has(id))
    }
  } else {
    orderedIds = mode.ids
  }

  for (const publicationId of orderedIds) {
    const meta = metaById.get(publicationId) || {
      publicationTitle: null,
      rationale: 'manual_mcp_batch',
    }
    let nextCandidate = await resolveOneCandidate(
      root,
      publicationId,
      replaceById,
      remediatedRoot,
      meta,
    )
    nextCandidate = await prefilterPassing(nextCandidate)
    if (nextCandidate.alreadyPassing) skippedAlreadyPassing.push(nextCandidate)
    else selected.push(nextCandidate)
  }

  return { selected, skippedAlreadyPassing, verificationPreflightPassed: [], verificationNoInput: [] }
}

async function writeBatchManifest(
  root: string,
  candidates: BatchCandidate[],
  skippedAlreadyPassing: BatchCandidate[],
  options: {
    sourceManifestPath: string
    queueName: string
    verificationPreflightPassedIds?: string[]
    verificationNoInput?: Array<{ publicationId: string; reason: string }>
  },
) {
  const manifestPath = path.join(root, 'ICJIA-PDFs', 'manifests', 'manual-mcp-batch.json')
  const summaryPath = path.join(root, 'ICJIA-PDFs', 'manifests', 'manual-mcp-batch.summary.json')
  const manifest: BatchManifest & {
    verificationPreflightPassedIds?: string[]
    verificationNoInput?: Array<{ publicationId: string; reason: string }>
  } = {
    generatedAt: new Date().toISOString(),
    queueName: options.queueName,
    sourceManifestPath: options.sourceManifestPath,
    selectedPublicationIds: candidates.map(candidate => candidate.publicationId),
    skippedAlreadyPassingIds: skippedAlreadyPassing.map(candidate => candidate.publicationId),
    candidates: candidates.map(candidate => ({
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      serverHost: candidate.serverHost,
      inputPath: candidate.inputPath,
      rationale: candidate.rationale,
      alreadyPassing: candidate.alreadyPassing,
    })),
    ...(options.verificationPreflightPassedIds?.length
      ? { verificationPreflightPassedIds: options.verificationPreflightPassedIds }
      : {}),
    ...(options.verificationNoInput?.length ? { verificationNoInput: options.verificationNoInput } : {}),
  }
  await writeJson(manifestPath, manifest)
  await writeJson(summaryPath, {
    generatedAt: manifest.generatedAt,
    queueName: manifest.queueName,
    totalCandidates: manifest.candidates.length,
    selectedPublicationIds: manifest.selectedPublicationIds,
    skippedAlreadyPassingIds: manifest.skippedAlreadyPassingIds,
    verificationPreflightPassedIds: options.verificationPreflightPassedIds,
    verificationNoInput: options.verificationNoInput,
    manifestPath,
  })
}

async function processVerificationPreflightPass(root: string, candidate: BatchCandidate) {
  if (!candidate.inputPath || !candidate.canonicalStagedReplacementPath) return null
  const buffer = await fs.readFile(candidate.inputPath)
  const filename = path.basename(candidate.inputPath)
  const analysis = await analyzePDF(buffer, filename, {
    skipAdobe: true,
    analysisProfile: 'full_final',
  })
  const { gate } = evaluateManualMcpPromotionGate(analysis, candidate, manualMcpPromotionGateOptions())
  if (!gate.passed) return null
  await ensureDir(path.dirname(candidate.canonicalStagedReplacementPath))
  await fs.copyFile(candidate.inputPath, candidate.canonicalStagedReplacementPath)
  const safeTitle = sanitizeFilename(candidate.publicationTitle || `publication-${candidate.publicationId}`)
  const reportDir = path.join(root, 'ICJIA-PDFs', 'reports', 'manual-mcp-verify-recovery', candidate.serverHost)
  await ensureDir(reportDir)
  const reportPath = path.join(reportDir, `${candidate.publicationId}-${safeTitle}.preflight-pass.json`)
  await writeJson(reportPath, {
    generatedAt: new Date().toISOString(),
    publicationId: candidate.publicationId,
    publicationTitle: candidate.publicationTitle,
    inputPath: candidate.inputPath,
    canonicalStagedReplacementPath: candidate.canonicalStagedReplacementPath,
    analysisProfile: 'full_final',
    gate,
    summary: {
      overallScore: analysis.overallScore,
      grade: analysis.grade,
      pageCount: analysis.pageCount,
    },
  })
  await upsertOutcome(root, {
    publicationId: candidate.publicationId,
    publicationTitle: candidate.publicationTitle,
    status: 'manual_ready_to_replace',
    processedAt: new Date().toISOString(),
    inputPath: candidate.inputPath,
    outputPath: candidate.inputPath,
    reportPath,
    stagedReplacementPath: candidate.canonicalStagedReplacementPath,
    beforeScore: analysis.overallScore,
    afterScore: analysis.overallScore,
    beforeGrade: analysis.grade,
    afterGrade: analysis.grade,
    beforeBlockingFindingKeys: gate.blockingLocalFindingKeys,
    afterBlockingFindingKeys: [],
    manualResolutionReason: 'cleared_final_blockers',
    manualResolutionNotes:
      'Remediated artifact already passed full_final; copied to canonical staged path for agency:verify-ready.',
    lastValidatedAt: new Date().toISOString(),
    gate: {
      passed: gate.passed,
      blockingLocalFindingKeys: gate.blockingLocalFindingKeys,
      unresolvedCategoryLabels: gate.unresolvedCategoryLabels,
      criticalManualReviewFlagCodes: gate.criticalManualReviewFlagCodes,
      reasons: gate.reasons,
    },
    original: { overallScore: analysis.overallScore, grade: analysis.grade },
    final: { overallScore: analysis.overallScore, grade: analysis.grade },
    artifacts: {
      remediatedPdfPath: candidate.inputPath,
      stagedReplacementPath: candidate.canonicalStagedReplacementPath,
      detailedReportPath: reportPath,
    },
  })
  return {
    publicationId: candidate.publicationId,
    publicationTitle: candidate.publicationTitle,
    status: 'manual_ready_to_replace' as const,
    manualResolutionReason: 'cleared_final_blockers' as const,
    stagedReplacementPath: candidate.canonicalStagedReplacementPath,
    finalScore: analysis.overallScore,
    finalGrade: analysis.grade,
  }
}

async function upsertOutcome(root: string, record: ManualWorklistOutcomeRecord) {
  const outcomesPath = path.join(root, 'ICJIA-PDFs', 'manifests', 'manual-worklist.outcomes.json')
  const outcomesSummaryPath = path.join(root, 'ICJIA-PDFs', 'manifests', 'manual-worklist.outcomes.summary.json')
  const existing = syncFs.existsSync(outcomesPath)
    ? await readJson<ManualWorklistOutcomeDocument>(outcomesPath)
    : { generatedAt: new Date().toISOString(), queueName: 'manual-worklist' as const, outcomes: [] }
  const outcomes = existing.outcomes.filter(outcome => outcome.publicationId !== record.publicationId)
  outcomes.push(record)
  const nextDoc: ManualWorklistOutcomeDocument = {
    generatedAt: new Date().toISOString(),
    queueName: 'manual-worklist',
    outcomes: outcomes.sort((left, right) => left.publicationId.localeCompare(right.publicationId)),
  }
  await writeJson(outcomesPath, nextDoc)
  await writeJson(outcomesSummaryPath, summarizeManualWorklistOutcomes(nextDoc))
}

async function runSingleCandidate(root: string, client: Client, candidate: BatchCandidate) {
  if (!candidate.inputPath) {
    throw new Error(`No input path for ${candidate.publicationId}`)
  }

  const safeTitle = sanitizeFilename(candidate.publicationTitle || `publication-${candidate.publicationId}`)
  const outputDir = path.join(root, 'ICJIA-PDFs', 'artifacts', 'remediated-pdfs', 'manual-mcp-batch', candidate.serverHost)
  const reportDir = path.join(root, 'ICJIA-PDFs', 'reports', 'manual-mcp-batch', candidate.serverHost)
  const stagingDir = path.join(root, 'ICJIA-PDFs', 'staging', 'to-replace', 'manual-mcp-batch', candidate.serverHost)
  await ensureDir(outputDir)
  await ensureDir(reportDir)
  await ensureDir(stagingDir)

  const outputPath = path.join(outputDir, `${candidate.publicationId}-${safeTitle}.pdf`)
  const reportPath = path.join(reportDir, `${candidate.publicationId}-${safeTitle}.manual-mcp.json`)
  const legacyStagedPath = path.join(stagingDir, `${candidate.publicationId}-${safeTitle}.pdf`)
  const destStagedPath = candidate.canonicalStagedReplacementPath || legacyStagedPath
  const filename = path.basename(candidate.inputPath)
  const inputBuffer = await fs.readFile(candidate.inputPath)

  await upsertOutcome(root, {
    publicationId: candidate.publicationId,
    publicationTitle: candidate.publicationTitle,
    status: 'manual_in_progress',
    processedAt: new Date().toISOString(),
    inputPath: candidate.inputPath,
    outputPath: null,
    reportPath,
    stagedReplacementPath: null,
    beforeScore: null,
    afterScore: null,
    beforeGrade: null,
    afterGrade: null,
    beforeBlockingFindingKeys: [],
    afterBlockingFindingKeys: [],
    manualResolutionReason: 'manual_object_level_repair_exhausted',
    manualResolutionNotes: 'MCP manual batch started.',
    lastValidatedAt: null,
    gate: null,
    original: null,
    final: null,
    artifacts: {
      remediatedPdfPath: null,
      stagedReplacementPath: null,
      detailedReportPath: reportPath,
    },
  })

  const openResult = await callTool<{ sessionId: string }>(client, 'pdf_open', {
    filename,
    path: candidate.inputPath,
  })
  const sessionId = String(openResult.sessionId)
  const actionLog: Array<{ tool: string; result: McpToolResult }> = []
  const manualPromotionOpts = manualMcpPromotionGateOptions()

  try {
    const baselineMcp = await callTool<McpAnalysisSummary>(client, 'pdf_analyze', {
      sessionId,
      analysisProfile: 'full_final',
      skipAdobe: true,
    })
    let inspect = await callTool<McpInspectSummary>(client, 'pdf_inspect', { sessionId })

    const baselineBlocking = blockingKeysFromMcpAnalysis(baselineMcp)
    const directBaseline = await analyzePDF(inputBuffer, filename, {
      skipAdobe: true,
      analysisProfile: 'full_final',
    })
    const pageCount = Number(baselineMcp.pageCount || directBaseline.pageCount || 0)
    const structurePageCap = manualMcpStructureMaxPages()
    const wantsHeavyStructurePass =
      pageCount > 0
      && pageCount <= structurePageCap
      && (baselineBlocking.includes('pdfua.logical_structure')
        || baselineBlocking.includes('pdfua.figure_alt_or_artifact')
        || baselineBlocking.includes('pdfua.untagged_rendered_images'))

    const docTools: Array<{ tool_name: string; arguments?: Record<string, unknown> }> = []
    if (baselineBlocking.includes('pdfua.display_doc_title') || baselineBlocking.includes('pdfua.document_language') || baselineBlocking.includes('pdfua.bookmark_language')) {
      docTools.push({
        tool_name: 'normalize_document_metadata',
        arguments: {
          title: candidate.publicationTitle || filename.replace(/\.pdf$/i, ''),
          language: 'en-US',
        },
      })
      docTools.push({
        tool_name: 'set_pdfua_identification',
        arguments: {
          title: candidate.publicationTitle || filename.replace(/\.pdf$/i, ''),
          language: 'en-US',
          part: 1,
          conformance: 'B',
        },
      })
    }
    if (baselineBlocking.includes('pdfua.page_tabs')) {
      docTools.push({
        tool_name: 'set_page_tabs',
        arguments: {},
      })
    }
    if (wantsHeavyStructurePass) {
      docTools.push({ tool_name: 'bootstrap_struct_tree', arguments: {} })
      docTools.push({ tool_name: 'repair_native_marked_content_refs', arguments: {} })
      docTools.push({ tool_name: 'repair_structure_conformance', arguments: {} })
    } else if (pageCount <= 8 && baselineBlocking.includes('pdfua.logical_structure')) {
      docTools.push({ tool_name: 'repair_native_marked_content_refs', arguments: {} })
      docTools.push({ tool_name: 'repair_structure_conformance', arguments: {} })
    }
    docTools.push({ tool_name: 'repair_native_figure_semantics', arguments: { target: 'document' } })
    docTools.push({ tool_name: 'repair_other_elements_alt_text', arguments: { target: 'document' } })
    docTools.push({ tool_name: 'normalize_nested_figure_containers', arguments: { target: 'document' } })

    for (const step of docTools) {
      const result = await callTool(client, 'pdf_apply_tool', {
        sessionId,
        tool_name: step.tool_name,
        arguments: step.arguments || {},
        rationale: `manual mcp batch ${candidate.publicationId}`,
        confidence: 0.95,
      })
      actionLog.push({ tool: step.tool_name, result })
      if (Boolean(result.changedDocumentBytes)) {
        await callTool(client, 'pdf_analyze', {
          sessionId,
          analysisProfile: 'remediation_fast',
          skipAdobe: true,
          skipVeraPdf: true,
        })
        inspect = await callTool<McpInspectSummary>(client, 'pdf_inspect', { sessionId })
      }
    }

    const maxFigureOps = manualMcpMaxFigureOps()
    const figureSkipNoChange = new Set<string>()
    for (let op = 0; op < maxFigureOps; op++) {
      const items = inspect.figureCandidates?.items || []
      const figureCandidate = items.find(
        entry => candidateNeedsAction(entry) && !figureSkipNoChange.has(String(entry.id || '')),
      )
      if (!figureCandidate) break
      const toolName = candidateToolName(figureCandidate)
      const result = await callTool(client, 'pdf_apply_tool', {
        sessionId,
        tool_name: toolName,
        arguments: {
          candidateId: figureCandidate.id,
          altText: toolName === 'mark_figure_decorative' ? 'Decorative image' : chooseAltText(figureCandidate, candidate.publicationTitle),
          generationSource: 'manual_mcp_batch',
        },
        rationale: `manual mcp figure candidate ${figureCandidate.id}`,
        confidence: 0.9,
      })
      actionLog.push({ tool: toolName, result })
      if (Boolean(result.changedDocumentBytes)) {
        await callTool(client, 'pdf_analyze', {
          sessionId,
          analysisProfile: 'remediation_fast',
          skipAdobe: true,
          skipVeraPdf: true,
        })
        inspect = await callTool<McpInspectSummary>(client, 'pdf_inspect', { sessionId })
      } else {
        figureSkipNoChange.add(String(figureCandidate.id || ''))
      }
    }

    if (baselineBlocking.includes('pdfua.untagged_rendered_images')) {
      const tailRepair: Array<{ tool_name: string; arguments?: Record<string, unknown> }> = [
        { tool_name: 'repair_native_figure_semantics', arguments: { target: 'document' } },
        { tool_name: 'repair_other_elements_alt_text', arguments: { target: 'document' } },
      ]
      for (const step of tailRepair) {
        const result = await callTool(client, 'pdf_apply_tool', {
          sessionId,
          tool_name: step.tool_name,
          arguments: step.arguments || {},
          rationale: `manual mcp batch ${candidate.publicationId} untagged tail`,
          confidence: 0.9,
        })
        actionLog.push({ tool: step.tool_name, result })
        if (Boolean(result.changedDocumentBytes)) {
          await callTool(client, 'pdf_analyze', {
            sessionId,
            analysisProfile: 'remediation_fast',
            skipAdobe: true,
            skipVeraPdf: true,
          })
          inspect = await callTool<McpInspectSummary>(client, 'pdf_inspect', { sessionId })
        }
      }
    }

    await callTool(client, 'pdf_write', {
      sessionId,
      path: outputPath,
    })

    const finalBuffer = await fs.readFile(outputPath)
    const finalAnalysis = await analyzePDF(finalBuffer, path.basename(outputPath), {
      skipAdobe: true,
      analysisProfile: 'full_final',
    })
    const { gate, strictGate } = evaluateManualMcpPromotionGate(
      finalAnalysis,
      candidate,
      manualPromotionOpts,
    )

    const status: ManualWorklistStatus = gate.passed ? 'manual_ready_to_replace' : 'manual_terminalized'
    const manualResolutionReason: ManualWorklistResolutionReason = gate.passed
      ? strictGate.passed
        ? 'cleared_final_blockers'
        : 'cleared_min_overall_score'
      : finalAnalysis.isScanned
        ? 'manual_scanned_or_source_limited'
        : actionLog.some(entry => entry.result.outcome === 'applied')
          ? 'manual_object_level_repair_exhausted'
          : finalAnalysis.pageCount >= 80
            ? 'manual_runtime_cost_not_worth_continuing'
            : 'manual_rebuild_required_not_patchable'

    if (gate.passed) {
      await ensureDir(path.dirname(destStagedPath))
      await fs.copyFile(outputPath, destStagedPath)
    }

    await writeJson(reportPath, {
      generatedAt: new Date().toISOString(),
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      inputPath: candidate.inputPath,
      outputPath,
      status,
      manualResolutionReason,
      rationale: candidate.rationale,
      baseline: {
        score: baselineMcp.overallScore ?? null,
        grade: baselineMcp.grade ?? null,
        blockingFindingKeys: baselineBlocking,
      },
      final: {
        score: finalAnalysis.overallScore,
        grade: finalAnalysis.grade,
        blockingFindingKeys: gate.blockingLocalFindingKeys,
      },
      gate,
      actionLog,
      finalFigureCandidates: inspect.figureCandidates?.items || [],
    })

    await upsertOutcome(root, {
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      status,
      processedAt: new Date().toISOString(),
      inputPath: candidate.inputPath,
      outputPath,
      reportPath,
      stagedReplacementPath: gate.passed ? destStagedPath : null,
      beforeScore: Number(baselineMcp.overallScore ?? null),
      afterScore: finalAnalysis.overallScore,
      beforeGrade: String(baselineMcp.grade ?? '') || null,
      afterGrade: finalAnalysis.grade,
      beforeBlockingFindingKeys: baselineBlocking,
      afterBlockingFindingKeys: gate.blockingLocalFindingKeys,
      manualResolutionReason,
      manualResolutionNotes: gate.passed
        ? strictGate.passed
          ? 'MCP-driven manual repair cleared the replacement gate.'
          : `MCP-driven manual repair met relaxed score floor (${manualPromotionOpts?.minOverallScore ?? 90}); blocking locals may remain — see gate.reasons / local standards.`
        : `MCP-driven manual repair stopped with ${gate.blockingLocalFindingKeys.length} blocking finding(s) remaining.`,
      lastValidatedAt: new Date().toISOString(),
      gate: {
        passed: gate.passed,
        blockingLocalFindingKeys: gate.blockingLocalFindingKeys,
        unresolvedCategoryLabels: gate.unresolvedCategoryLabels,
        criticalManualReviewFlagCodes: gate.criticalManualReviewFlagCodes,
        reasons: gate.reasons,
      },
      original: {
        overallScore: Number(baselineMcp.overallScore ?? null),
        grade: String(baselineMcp.grade ?? '') || null,
      },
      final: {
        overallScore: finalAnalysis.overallScore,
        grade: finalAnalysis.grade,
      },
      artifacts: {
        remediatedPdfPath: outputPath,
        stagedReplacementPath: gate.passed ? destStagedPath : null,
        detailedReportPath: reportPath,
      },
    })

    return {
      publicationId: candidate.publicationId,
      publicationTitle: candidate.publicationTitle,
      status,
      manualResolutionReason,
      outputPath,
      reportPath,
      stagedReplacementPath: gate.passed ? destStagedPath : null,
      finalScore: finalAnalysis.overallScore,
      finalGrade: finalAnalysis.grade,
      finalBlockingFindingKeys: gate.blockingLocalFindingKeys,
    }
  } finally {
    await client.callTool({
      name: 'pdf_close',
      arguments: { sessionId },
    }).catch(() => undefined)
  }
}

const DEFAULT_NEXT_BATCH_MANIFEST = 'ICJIA-PDFs/manifests/manual-mcp-next-batch.json'
const DEFAULT_VERIFICATION_MANIFEST = 'ICJIA-PDFs/manifests/ready-to-replace-verification.json'

function parseCli(argv: string[]): {
  manifestPath: string | null
  useDefaultNextBatchManifest: boolean
  filterPublicationIds: string[]
  dryRun: boolean
  verificationFailures: boolean
  verificationFailuresPath: string | null
  batchLimit?: number
  batchOffset?: number
} {
  const filterPublicationIds: string[] = []
  let manifestPath: string | null = null
  let useDefaultNextBatchManifest = false
  let dryRun = false
  let verificationFailures = false
  let verificationFailuresPath: string | null = null
  let batchLimit: number | undefined
  let batchOffset: number | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    if (a === '--dry-run') {
      dryRun = true
      continue
    }
    if (a === '--verification-failures') {
      verificationFailures = true
      const next = argv[i + 1]
      const nextIsPath = Boolean(
        next
          && !next.startsWith('-')
          && !/^\d+$/.test(next)
          && next !== '--limit'
          && next !== '--offset',
      )
      if (nextIsPath) {
        verificationFailuresPath = next
        i++
      }
      continue
    }
    if (a === '--limit') {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n < 1) throw new Error('--limit must be a positive number')
      batchLimit = n
      continue
    }
    if (a === '--offset') {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n < 0) throw new Error('--offset must be a non-negative number')
      batchOffset = n
      continue
    }
    if (a === '--manifest') {
      const next = argv[i + 1]
      const nextIsExplicitPath = Boolean(
        next && !next.startsWith('-') && !/^\d+$/.test(next),
      )
      if (nextIsExplicitPath) {
        manifestPath = next
        i++
      } else {
        useDefaultNextBatchManifest = true
      }
      continue
    }
    if (/^\d+$/.test(a)) filterPublicationIds.push(a)
    else throw new Error(`Unknown argument: ${a}`)
  }
  return {
    manifestPath,
    useDefaultNextBatchManifest,
    filterPublicationIds,
    dryRun,
    verificationFailures,
    verificationFailuresPath,
    batchLimit,
    batchOffset,
  }
}

async function main() {
  const root = repoRoot()
  dotenv.config({ path: path.join(root, '.env'), override: false })
  dotenv.config({ path: path.join(root, 'apps', 'api', '.env'), override: false })

  const argv = process.argv.slice(2)
  const parsed = parseCli(argv)

  const figureCanaryPath = path.join(root, 'ICJIA-PDFs', 'manifests', 'pass-rate-figure-canary.json')
  const replacementMapPath = path.join(root, 'ICJIA-PDFs', 'manifests', 'publication-pdf-replacement-map.json')

  let mode: BatchLoadMode
  let writeSourcePath: string
  let queueName: string

  if (parsed.verificationFailures) {
    if (parsed.useDefaultNextBatchManifest || parsed.manifestPath) {
      throw new Error('Do not combine --manifest with --verification-failures')
    }
    const raw = parsed.verificationFailuresPath || DEFAULT_VERIFICATION_MANIFEST
    const verificationPath = path.isAbsolute(raw) ? raw : path.join(root, raw)
    mode = {
      type: 'verification_failures',
      verificationPath,
      limit: parsed.batchLimit,
      offset: parsed.batchOffset,
      filterPublicationIds: parsed.filterPublicationIds.length ? parsed.filterPublicationIds : undefined,
    }
    writeSourcePath = verificationPath
    queueName = 'manual-mcp-verify-failure-recovery'
  } else if (parsed.useDefaultNextBatchManifest || parsed.manifestPath) {
    const resolvedManifest = path.isAbsolute(parsed.manifestPath || '')
      ? (parsed.manifestPath as string)
      : path.join(root, parsed.manifestPath || DEFAULT_NEXT_BATCH_MANIFEST)
    mode = {
      type: 'manifest_and_map',
      manifestPath: resolvedManifest,
      filterPublicationIds: parsed.filterPublicationIds.length ? parsed.filterPublicationIds : undefined,
    }
    const src = await readJson<ManualMcpBatchSourceManifest>(resolvedManifest)
    writeSourcePath = resolvedManifest
    queueName = String(src.queueName || 'manual-mcp-next-batch')
  } else if (parsed.filterPublicationIds.length) {
    mode = { type: 'argv_map_only', ids: parsed.filterPublicationIds }
    writeSourcePath = replacementMapPath
    queueName = 'manual-mcp-batch'
  } else {
    mode = { type: 'legacy_figure_canary', ids: [...MANUAL_MCP_BATCH_PUBLICATION_IDS] }
    writeSourcePath = figureCanaryPath
    queueName = 'manual-mcp-batch'
  }

  const {
    selected: candidates,
    skippedAlreadyPassing,
    verificationPreflightPassed,
    verificationNoInput,
  } = await loadBatchCandidates(root, mode)
  await writeBatchManifest(root, candidates, skippedAlreadyPassing, {
    sourceManifestPath: writeSourcePath,
    queueName,
    verificationPreflightPassedIds: verificationPreflightPassed.map(c => c.publicationId),
    verificationNoInput,
  })

  if (parsed.dryRun) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      dryRun: true,
      queueName,
      sourceManifestPath: writeSourcePath,
      skippedAlreadyPassingIds: skippedAlreadyPassing.map(c => c.publicationId),
      verificationPreflightPassed: verificationPreflightPassed.map(c => ({
        publicationId: c.publicationId,
        inputPath: c.inputPath,
        canonicalStagedReplacementPath: c.canonicalStagedReplacementPath,
      })),
      verificationNoInput,
      selected: candidates.map(c => ({
        publicationId: c.publicationId,
        publicationTitle: c.publicationTitle,
        serverHost: c.serverHost,
        inputPath: c.inputPath,
        rationale: c.rationale,
        canonicalStagedReplacementPath: c.canonicalStagedReplacementPath,
      })),
    }, null, 2))
    return
  }

  const preflightResults = []
  for (const c of verificationPreflightPassed) {
    const r = await processVerificationPreflightPass(root, c)
    if (r) preflightResults.push(r)
  }

  if (!candidates.length) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      queueName,
      sourceManifestPath: writeSourcePath,
      verificationPreflightResults: preflightResults,
      skippedAlreadyPassingIds: skippedAlreadyPassing.map(c => c.publicationId),
      verificationNoInput,
      results: [],
      note: preflightResults.length ? 'Preflight only; no MCP candidates in this slice.' : 'No work in this slice.',
    }, null, 2))
    return
  }

  const mcpMaxBytes = process.env.PDF_MCP_MAX_BYTES || String(256 * 1024 * 1024)
  const results: unknown[] = []
  for (const candidate of candidates) {
    const transport = new StdioClientTransport({
      command: 'pnpm',
      args: ['--filter', 'pdf-mcp', 'exec', 'tsx', 'src/index.ts'],
      cwd: root,
      stderr: 'pipe',
      env: { ...process.env, PDF_MCP_MAX_BYTES: mcpMaxBytes },
    })
    const client = new Client({
      name: 'manual-mcp-batch-runner',
      version: '0.0.1',
    })
    try {
      await client.connect(transport)
      results.push(await runSingleCandidate(root, client, candidate))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[manual-mcp-batch] candidate ${candidate.publicationId} failed: ${message}`)
      results.push({
        publicationId: candidate.publicationId,
        publicationTitle: candidate.publicationTitle,
        status: 'batch_error',
        error: message,
      })
    } finally {
      await transport.close().catch(() => undefined)
    }
  }

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    queueName,
    sourceManifestPath: writeSourcePath,
    skippedAlreadyPassingIds: skippedAlreadyPassing.map(candidate => candidate.publicationId),
    verificationPreflightResults: preflightResults,
    verificationNoInput,
    results,
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
