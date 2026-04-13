import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

type HoldManifestRow = {
  publicationId?: string | number | null
  status?: string | null
  reasonCodes?: string[] | null
  notes?: string[] | null
}

type HoldManifest = {
  generatedAt?: string
  rows?: HoldManifestRow[]
}

type ClassifiedRow = {
  publicationId?: string | number | null
  publicationTitle?: string | null
  sourceStatus?: string | null
  stagedReplacementPath?: string | null
  classification?: string | null
  visualApproval?: {
    required?: boolean
    status?: string | null
    reasonCodes?: string[] | null
    sourceManifest?: string | null
    notes?: string[] | null
  } | null
}

type ClassifiedDocument = {
  generatedAt?: string
  publicationRows?: ClassifiedRow[]
}

const repoRoot = '/home/hendo420/pdfaf'
const manifestsRoot = path.join(repoRoot, 'ICJIA-PDFs', 'manifests')
const holdManifestPath = path.join(manifestsRoot, 'visual-approval-holds.json')
const classifiedPath = path.join(manifestsRoot, 'ready-to-replace-verification.classified.json')

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function buildSnapshot() {
  const holdDoc = readJsonIfExists<HoldManifest>(holdManifestPath)
  const classifiedDoc = readJsonIfExists<ClassifiedDocument>(classifiedPath)
  const holdRows = (holdDoc?.rows || [])
    .filter(row => row?.publicationId != null)
    .map(row => ({
      publicationId: String(row.publicationId),
      status: row.status === 'approved' ? 'approved' : 'required',
      reasonCodes: Array.isArray(row.reasonCodes) ? row.reasonCodes.map(String) : [],
      notes: Array.isArray(row.notes) ? row.notes.map(String) : [],
    }))
    .sort((a, b) => a.publicationId.localeCompare(b.publicationId))

  const classifiedRows = (classifiedDoc?.publicationRows || [])
    .filter(row => row?.publicationId != null)
    .map(row => ({
      publicationId: String(row.publicationId),
      publicationTitle: row.publicationTitle ? String(row.publicationTitle) : null,
      sourceStatus: row.sourceStatus ? String(row.sourceStatus) : null,
      stagedReplacementPath: row.stagedReplacementPath ? String(row.stagedReplacementPath) : null,
      classification: row.classification ? String(row.classification) : null,
      visualApproval: {
        required: Boolean(row.visualApproval?.required),
        status: row.visualApproval?.status ? String(row.visualApproval.status) : null,
        reasonCodes: Array.isArray(row.visualApproval?.reasonCodes) ? row.visualApproval!.reasonCodes!.map(String) : [],
        notes: Array.isArray(row.visualApproval?.notes) ? row.visualApproval!.notes!.map(String) : [],
      },
    }))

  const activeHeldRows = classifiedRows
    .filter(row => row.classification === 'held_visual_review')
    .sort((a, b) => a.publicationId.localeCompare(b.publicationId))

  const activeHeldIdSet = new Set(activeHeldRows.map(row => row.publicationId))
  const holdManifestOnlyRows = holdRows
    .filter(row => row.status === 'required' && !activeHeldIdSet.has(row.publicationId))
    .sort((a, b) => a.publicationId.localeCompare(b.publicationId))

  return {
    generatedAt: new Date().toISOString(),
    sources: {
      holdManifestPath,
      classifiedPath,
      holdManifestGeneratedAt: holdDoc?.generatedAt || null,
      classifiedGeneratedAt: classifiedDoc?.generatedAt || null,
    },
    totals: {
      holdManifestRows: holdRows.length,
      activeHeldVisualReviewRows: activeHeldRows.length,
      holdManifestOnlyRows: holdManifestOnlyRows.length,
    },
    activeHeldRows,
    holdManifestOnlyRows,
  }
}

function printHuman(snapshot: ReturnType<typeof buildSnapshot>): void {
  console.log(`Hold manifest rows: ${snapshot.totals.holdManifestRows}`)
  console.log(`Active held_visual_review rows: ${snapshot.totals.activeHeldVisualReviewRows}`)
  console.log(`Hold manifest only rows: ${snapshot.totals.holdManifestOnlyRows}`)
  console.log(`Classified generated: ${snapshot.sources.classifiedGeneratedAt || 'missing'}`)
  console.log(`Hold manifest generated: ${snapshot.sources.holdManifestGeneratedAt || 'missing'}`)

  if (snapshot.activeHeldRows.length) {
    console.log('')
    console.log('Active held_visual_review:')
    for (const row of snapshot.activeHeldRows) {
      const reasons = row.visualApproval.reasonCodes.length ? row.visualApproval.reasonCodes.join(', ') : 'none'
      console.log(
        `- ${row.publicationId} | ${row.publicationTitle || 'untitled'} | source ${row.sourceStatus || 'unknown'} | reasons ${reasons}`,
      )
    }
  }

  if (snapshot.holdManifestOnlyRows.length) {
    console.log('')
    console.log('Hold manifest only:')
    for (const row of snapshot.holdManifestOnlyRows) {
      const reasons = row.reasonCodes.length ? row.reasonCodes.join(', ') : 'none'
      console.log(`- ${row.publicationId} | status ${row.status} | reasons ${reasons}`)
    }
  }
}

export async function main(): Promise<void> {
  const snapshot = buildSnapshot()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(snapshot, null, 2))
    return
  }
  printHuman(snapshot)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}
