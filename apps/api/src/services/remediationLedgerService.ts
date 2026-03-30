import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RemediationClassificationSnapshot {
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

export interface RemediationValidationSnapshot {
  promotionEligible: boolean | null
  freshnessPassed: boolean | null
  blockingFailureModesClear: boolean | null
  blockingResidualFamiliesClear: boolean | null
  criticalManualReviewClear: boolean | null
  visualFidelityPassed: boolean | null
}

export interface RemediationLedgerEvent {
  recordedAt: string
  outcome: 'complete' | 'needs_api_fix'
  filename: string
  queueItemId: string
  ownerId: string | null
  jobGroup: string | null
  runtimeGeneration: string | null
  codeVersion: string | null
  sourcePdfPath: string | null
  summary: string
  subsystem: string | null
  completeDestinationPath: string | null
  needsApiFixRecordPath: string | null
  artifactPaths: string[]
  classification: RemediationClassificationSnapshot | null
  validation: RemediationValidationSnapshot | null
}

export interface NeedsApiFixAnalyticsRecordLike {
  filename: string
  queueItemId: string
  subsystem: string
  summary: string
  reusable: boolean
  recordedAt: string
  classification: RemediationClassificationSnapshot
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDir, '..', '..', '..', '..')

function configuredRoot(envName: string, fallbackSegments: string[]): string {
  const override = process.env[envName]?.trim()
  return override ? path.resolve(override) : path.join(repoRoot, ...fallbackSegments)
}

export function getRemediationDataRoot(): string {
  return configuredRoot('REMEDIATION_DATA_ROOT', ['data', 'remediation'])
}

export function getRemediationLedgerPath(): string {
  return path.join(getRemediationDataRoot(), 'pdf-ledger.jsonl')
}

export function getFixFamiliesReportPath(): string {
  return path.join(getRemediationDataRoot(), 'fix-families.json')
}

async function ensureRemediationDataLayout(): Promise<void> {
  await fs.promises.mkdir(getRemediationDataRoot(), { recursive: true })
}

export async function appendRemediationLedgerEvent(event: RemediationLedgerEvent): Promise<string> {
  await ensureRemediationDataLayout()
  const ledgerPath = getRemediationLedgerPath()
  await fs.promises.appendFile(ledgerPath, `${JSON.stringify(event)}\n`, 'utf8')
  return ledgerPath
}

export async function writeFixFamiliesReport(records: NeedsApiFixAnalyticsRecordLike[]): Promise<string> {
  await ensureRemediationDataLayout()
  const reportPath = getFixFamiliesReportPath()
  const families = new Map<string, {
    fixFamily: string
    blockedPdfCount: number
    latestSeenAt: string
    representativePdf: string
    filenames: Set<string>
    subsystems: Set<string>
    blockerKinds: Set<string>
    pipelineStages: Set<string>
    structuralClasses: Set<string>
    topFailureModeKeys: Set<string>
    likelyNextGenericFixes: Set<string>
    generalizationConfidence: Set<string>
    reusableCount: number
    recordQueueItemIds: Set<string>
  }>()

  for (const record of records) {
    const fixFamily = record.classification.fixFamily
      || record.classification.topFailureModeKeys[0]
      || 'uncategorized'
    const existing = families.get(fixFamily) || {
      fixFamily,
      blockedPdfCount: 0,
      latestSeenAt: record.recordedAt,
      representativePdf: record.filename,
      filenames: new Set<string>(),
      subsystems: new Set<string>(),
      blockerKinds: new Set<string>(),
      pipelineStages: new Set<string>(),
      structuralClasses: new Set<string>(),
      topFailureModeKeys: new Set<string>(),
      likelyNextGenericFixes: new Set<string>(),
      generalizationConfidence: new Set<string>(),
      reusableCount: 0,
      recordQueueItemIds: new Set<string>(),
    }

    if (!existing.filenames.has(record.filename)) {
      existing.blockedPdfCount += 1
      existing.filenames.add(record.filename)
    }
    existing.recordQueueItemIds.add(record.queueItemId)
    if (record.recordedAt > existing.latestSeenAt) {
      existing.latestSeenAt = record.recordedAt
      existing.representativePdf = record.filename
    }
    existing.subsystems.add(record.subsystem)
    existing.blockerKinds.add(record.classification.blockerKind)
    if (record.classification.pipelineStage) existing.pipelineStages.add(record.classification.pipelineStage)
    if (record.classification.structuralClass) existing.structuralClasses.add(record.classification.structuralClass)
    for (const key of record.classification.topFailureModeKeys) existing.topFailureModeKeys.add(key)
    if (record.classification.likelyNextGenericFix) existing.likelyNextGenericFixes.add(record.classification.likelyNextGenericFix)
    existing.generalizationConfidence.add(record.classification.generalizationConfidence)
    if (record.reusable) existing.reusableCount += 1
    families.set(fixFamily, existing)
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    totalBlockedPdfs: records.length,
    totalFamilies: families.size,
    families: [...families.values()]
      .map(entry => ({
        fixFamily: entry.fixFamily,
        blockedPdfCount: entry.blockedPdfCount,
        latestSeenAt: entry.latestSeenAt,
        representativePdf: entry.representativePdf,
        filenames: [...entry.filenames].sort(),
        subsystems: [...entry.subsystems].sort(),
        blockerKinds: [...entry.blockerKinds].sort(),
        pipelineStages: [...entry.pipelineStages].sort(),
        structuralClasses: [...entry.structuralClasses].sort(),
        topFailureModeKeys: [...entry.topFailureModeKeys].sort(),
        likelyNextGenericFixes: [...entry.likelyNextGenericFixes].sort(),
        generalizationConfidence: [...entry.generalizationConfidence].sort(),
        reusableCount: entry.reusableCount,
        recordQueueItemIds: [...entry.recordQueueItemIds].sort(),
      }))
      .sort((a, b) => b.blockedPdfCount - a.blockedPdfCount || b.latestSeenAt.localeCompare(a.latestSeenAt) || a.fixFamily.localeCompare(b.fixFamily)),
  }

  await fs.promises.writeFile(reportPath, JSON.stringify(payload, null, 2), 'utf8')
  return reportPath
}
