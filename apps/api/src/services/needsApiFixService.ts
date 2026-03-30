import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendRemediationLedgerEvent, writeFixFamiliesReport } from './remediationLedgerService.js'

export interface NeedsApiFixRecord {
  filename: string
  queueItemId: string
  blockerType: string
  subsystem: string
  summary: string
  classification: {
    fixFamily: string | null
    blockerKind: string
    pipelineStage: string | null
    structuralClass: string | null
    residualFamilyIds: string[]
    topFailureModeKeys: string[]
    visualFidelity: 'passed' | 'failed' | 'not_run'
    bookmarkState: 'ai_clean' | 'raw_or_noisy' | 'not_run' | 'unknown'
    semanticSidecarState: 'unknown' | 'not_flagged' | 'semantic_sidecar_unavailable'
    likelyNextGenericFix: string
    generalizationConfidence: 'low' | 'medium' | 'high'
  }
  explanation: {
    queueState: string
    processingStage: string | null
    processingProgress: number | null
    overallScore: number | null
    grade: string | null
    promotionStatus: string | null
    likelyNextFixArea: string
    topFailureModes: Array<{
      key: string
      label: string
      blocking: boolean
      count: number
    }>
    criticalManualReviewFlags: Array<{
      code: string
      label: string
      details: string
    }>
  }
  reusable: boolean
  artifactPaths: string[]
  ownerId: string | null
  jobGroup: string | null
  runtimeGeneration: string | null
  codeVersion: string | null
  sourcePdfPath: string | null
  recordedAt: string
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDir, '..', '..', '..', '..')

function configuredNeedsApiFixRoot(): string {
  const override = process.env.NEEDS_API_FIX_ROOT?.trim()
  return override ? path.resolve(override) : path.join(repoRoot, 'NeedsApiFix')
}

function manifestPathForRoot(root: string): string {
  return path.join(root, 'manifest.json')
}

function safeStem(filename: string): string {
  return filename
    .replace(/\.pdf$/i, '')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160) || 'unnamed'
}

function recordPathForFilename(filename: string): string {
  return path.join(configuredNeedsApiFixRoot(), `${safeStem(filename)}.json`)
}

export function getNeedsApiFixRoot(): string {
  return configuredNeedsApiFixRoot()
}

export function getNeedsApiFixManifestPath(): string {
  return manifestPathForRoot(getNeedsApiFixRoot())
}

export async function ensureNeedsApiFixBacklog(): Promise<{
  rootPath: string
  manifestPath: string
}> {
  const rootPath = getNeedsApiFixRoot()
  const manifestPath = getNeedsApiFixManifestPath()
  await fs.promises.mkdir(rootPath, { recursive: true })
  if (!fs.existsSync(manifestPath)) {
    await fs.promises.writeFile(manifestPath, '[]\n', 'utf8')
  }
  return { rootPath, manifestPath }
}

export async function clearNeedsApiFixBacklog(): Promise<{
  rootPath: string
  manifestPath: string
}> {
  const { rootPath, manifestPath } = await ensureNeedsApiFixBacklog()
  const entries = await fs.promises.readdir(rootPath, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.json')) continue
    await fs.promises.rm(path.join(rootPath, entry.name), { force: true })
  }
  await fs.promises.writeFile(manifestPath, '[]\n', 'utf8')
  await writeFixFamiliesReport([])
  return { rootPath, manifestPath }
}

export async function writeNeedsApiFixRecord(record: NeedsApiFixRecord): Promise<{
  recordPath: string
  manifestPath: string
  fixFamiliesReportPath: string
}> {
  const { manifestPath } = await ensureNeedsApiFixBacklog()
  const recordPath = recordPathForFilename(record.filename)
  await fs.promises.writeFile(recordPath, JSON.stringify(record, null, 2), 'utf8')

  let manifest: NeedsApiFixRecord[] = []
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as NeedsApiFixRecord[]
  } catch {
    manifest = []
  }

  const nextManifest = [
    record,
    ...manifest.filter(entry =>
      entry.filename !== record.filename,
    ),
  ].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))

  await fs.promises.writeFile(manifestPath, JSON.stringify(nextManifest, null, 2), 'utf8')
  await appendRemediationLedgerEvent({
    recordedAt: record.recordedAt,
    outcome: 'needs_api_fix',
    filename: record.filename,
    queueItemId: record.queueItemId,
    ownerId: record.ownerId,
    jobGroup: record.jobGroup,
    runtimeGeneration: record.runtimeGeneration,
    codeVersion: record.codeVersion,
    sourcePdfPath: record.sourcePdfPath,
    summary: record.summary,
    subsystem: record.subsystem,
    completeDestinationPath: null,
    needsApiFixRecordPath: recordPath,
    artifactPaths: record.artifactPaths,
    classification: record.classification,
    validation: {
      promotionEligible: false,
      freshnessPassed: record.explanation.promotionStatus !== 'rejected',
      blockingFailureModesClear: record.explanation.topFailureModes.length === 0,
      blockingResidualFamiliesClear: false,
      criticalManualReviewClear: record.explanation.criticalManualReviewFlags.length === 0,
      visualFidelityPassed: record.classification.visualFidelity === 'passed',
    },
  })
  const fixFamiliesReportPath = await writeFixFamiliesReport(nextManifest)

  return {
    recordPath,
    manifestPath,
    fixFamiliesReportPath,
  }
}
