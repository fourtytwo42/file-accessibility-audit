import fs from 'node:fs'
import path from 'node:path'
import { analyzePDF } from '../apps/api/src/services/pdfAnalyzer.ts'
import { evaluatePromotionGate } from '../apps/api/src/services/promotionGate.ts'
import type { ManualWorklistOutcomeDocument } from '../apps/api/src/services/manualWorklist.ts'

const MAX_CANDIDATES = 20
const MAX_LIGHT_PAGES = 15
const PREFLIGHT_CAP = 100

const EXCLUDED_STATUSES = new Set([
  'manual_ready_to_replace',
  'manual_terminalized',
  'manual_in_progress',
  'manual_deferred',
])

interface ControlRow {
  publicationId?: string
  title?: string | null
  currentCorpusStatus?: string
  cohortLabel?: string
  serverHost?: string | null
  classificationEvidence?: {
    pageCount?: number
    overallScore?: number
    grade?: string | null
    topBlockingResidualFamilyIds?: string[]
  }
}

interface ReplacementMapRow {
  publicationId?: string
  title?: string | null
  checksumState?: { localCurrentFilePath?: string | null } | null
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function findPdfByPublicationId(root: string, publicationId: string): string | null {
  const stack = [root]
  const matches: string[] = []
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || !fs.existsSync(current)) continue
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.pdf')) continue
      if (entry.name.startsWith(`${publicationId}-`)) matches.push(fullPath)
    }
  }
  const preferredRoots = [
    `${path.sep}medium-figure-conversion${path.sep}`,
    `${path.sep}small-fast-pass${path.sep}`,
    `${path.sep}stage4-structure-wave${path.sep}`,
    `${path.sep}stage3-figure-wave${path.sep}`,
    `${path.sep}manual-mcp-batch${path.sep}`,
  ]
  for (const preferred of preferredRoots) {
    const hit = matches.find(file => file.includes(preferred))
    if (hit) return hit
  }
  return matches[0] || null
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile()
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const root = process.cwd()
  const manifestsRoot = path.join(root, 'ICJIA-PDFs', 'manifests')
  const controlPath = path.join(manifestsRoot, 'corpus-control-plane.json')
  const outcomesPath = path.join(manifestsRoot, 'manual-worklist.outcomes.json')
  const replacePath = path.join(manifestsRoot, 'publication-pdf-replacement-map.json')
  const currentNextPath = path.join(manifestsRoot, 'manual-mcp-next-batch.json')
  const outManifest = path.join(manifestsRoot, 'manual-mcp-next-batch-v2.json')
  const outSummary = path.join(manifestsRoot, 'manual-mcp-next-batch-v2.summary.json')

  const control = readJson<{ rows: ControlRow[] }>(controlPath)
  const outcomesDoc: ManualWorklistOutcomeDocument = fs.existsSync(outcomesPath)
    ? readJson(outcomesPath)
    : { generatedAt: new Date().toISOString(), queueName: 'manual-worklist', outcomes: [] }

  const replaceRows = readJson<ReplacementMapRow[]>(replacePath)
  const replaceById = new Map(
    replaceRows.map(r => [String(r.publicationId || '').trim(), r]).filter(([id]) => id),
  )

  const currentNext = readJson<{ selectedPublicationIds?: string[] }>(currentNextPath)
  const waveIds = new Set((currentNext.selectedPublicationIds || []).map(String))

  const excludedByManual = new Set<string>()
  for (const o of outcomesDoc.outcomes || []) {
    if (EXCLUDED_STATUSES.has(o.status)) excludedByManual.add(o.publicationId)
  }

  type PoolRow = {
    publicationId: string
    publicationTitle: string | null
    overallScore: number
    grade: string | null
    pageCount: number
    serverHost: string
    topFamilies: string[]
  }

  const pool: PoolRow[] = []
  for (const row of control.rows) {
    const id = String(row.publicationId || '').trim()
    if (!id) continue
    if (row.currentCorpusStatus !== 'remediated_fail') continue
    if (row.cohortLabel !== 'figure_heavy') continue
    if (excludedByManual.has(id)) continue
    if (waveIds.has(id)) continue

    const ce = row.classificationEvidence
    if (!ce) continue
    const pageCount = Number(ce.pageCount || 0)
    if (pageCount > MAX_LIGHT_PAGES || pageCount < 1) continue

    const families = ce.topBlockingResidualFamilyIds || []
    const figureish = families.some(
      f => f === 'native_figure_convergence' || f === 'unresolved_manual_family',
    )
    if (!figureish) continue

    pool.push({
      publicationId: id,
      publicationTitle: row.title ? String(row.title) : null,
      overallScore: Number(ce.overallScore ?? 0),
      grade: ce.grade ? String(ce.grade) : null,
      pageCount,
      serverHost: String(row.serverHost || 'unknown-host'),
      topFamilies: families,
    })
  }

  pool.sort((a, b) => b.overallScore - a.overallScore)

  const remediatedRoot = path.join(root, 'ICJIA-PDFs', 'artifacts', 'remediated-pdfs')

  const skippedAlreadyPassingIds: string[] = []
  const candidates: Array<{
    priorityRank: number
    publicationId: string
    publicationTitle: string | null
    currentCorpusStatus: string
    overallScore: number
    grade: string | null
    pageCount: number
    runtimeWeightBucket: 'light'
    dominantResidualFamily: string
    manualRationale: string
  }> = []

  let preflightCount = 0
  for (const pr of pool) {
    if (candidates.length >= MAX_CANDIDATES) break
    if (preflightCount >= PREFLIGHT_CAP) break
    preflightCount += 1

    const r = replaceById.get(pr.publicationId)
    const localCachePath = r?.checksumState?.localCurrentFilePath || null
    const remediatedPath = findPdfByPublicationId(remediatedRoot, pr.publicationId)
    const inputPath =
      remediatedPath && fileExists(remediatedPath)
        ? remediatedPath
        : localCachePath && fileExists(localCachePath)
          ? localCachePath
          : null

    if (!inputPath) continue

    const buffer = fs.readFileSync(inputPath)
    const analysis = await analyzePDF(buffer, path.basename(inputPath), {
      skipAdobe: true,
      analysisProfile: 'full_final',
    })
    const gate = evaluatePromotionGate({
      analysisResult: analysis,
      criticalManualReviewFlagCodes: [],
    })
    if (gate.passed) {
      skippedAlreadyPassingIds.push(pr.publicationId)
      continue
    }

    const rank = candidates.length + 1
    const dominant = pr.topFamilies[0] || 'unknown'
    candidates.push({
      priorityRank: rank,
      publicationId: pr.publicationId,
      publicationTitle: pr.publicationTitle || (r?.title ? String(r.title) : null),
      currentCorpusStatus: 'remediated_fail',
      overallScore: pr.overallScore,
      grade: pr.grade,
      pageCount: pr.pageCount,
      runtimeWeightBucket: 'light',
      dominantResidualFamily: dominant,
      manualRationale: `v2_figure_heavy_light_pool_rank_${rank}_score_${pr.overallScore}`,
    })
  }

  const generatedAt = new Date().toISOString()
  const selectedPublicationIds = candidates.map(c => c.publicationId)

  const manifest = {
    generatedAt,
    queueName: 'manual-mcp-next-batch-v2',
    selectionRule:
      'failing_only_no_already_passing_locals_figure_heavy_light_runtime_prefiltered_full_final_excludes_prior_next_batch',
    notes: [
      'Built from corpus-control-plane.json (remediated_fail, cohort figure_heavy, pageCount<=15, figure-related residual families).',
      'Excludes manual-worklist.outcomes rows with terminal/in-progress manual statuses.',
      'Excludes publication ids still listed on manual-mcp-next-batch.json (prior wave queue).',
      'skippedAlreadyPassingIds are locals that already pass the promotion gate under full_final at build time.',
      `preflightRowsExamined: ${preflightCount}, poolSizeBeforePreflight: ${pool.length}.`,
    ],
    sourcePaths: {
      corpusControlPlane: controlPath,
      manualOutcomes: outcomesPath,
      publicationPdfReplacementMap: replacePath,
      excludedPriorNextBatchManifest: currentNextPath,
    },
    skippedAlreadyPassingIds,
    selectedPublicationIds,
    candidates,
  }

  writeJson(outManifest, manifest)
  writeJson(outSummary, {
    generatedAt,
    queueName: manifest.queueName,
    totalCandidates: candidates.length,
    selectionRule: manifest.selectionRule,
    selectedPublicationIds,
    skippedAlreadyPassingIds,
    preflightRowsExamined: preflightCount,
    poolSizeBeforePreflight: pool.length,
    manifestPath: outManifest,
  })

  console.log(
    JSON.stringify(
      {
        wrote: outManifest,
        summary: outSummary,
        selectedCount: candidates.length,
        skippedAlreadyPassingCount: skippedAlreadyPassingIds.length,
        preflightRowsExamined: preflightCount,
      },
      null,
      2,
    ),
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
