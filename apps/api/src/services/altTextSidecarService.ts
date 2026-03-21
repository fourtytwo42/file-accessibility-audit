import fs from 'node:fs/promises'
import path from 'node:path'
import type { PdfRemediationContext } from './pdfRemediationTools.js'

export type AltTextSidecarStatus = 'needs_review' | 'approved' | 'decorative'

export interface AltTextSidecarEntry {
  imageId: string
  canonicalRef?: string | null
  contentFingerprint?: string | null
  pageNumber: number
  placementPageNumbers: number[]
  placementCount: number
  status: AltTextSidecarStatus
  altText: string | null
  aiDraft?: string | null
  caption?: string | null
  contextBefore?: string | null
  contextAfter?: string | null
  updatedAt: string
}

export interface AltTextSidecar {
  version: 1
  filename: string
  updatedAt: string
  entries: Record<string, AltTextSidecarEntry>
}

export interface AltTextSidecarDirective {
  imageId: string
  status: AltTextSidecarStatus
  candidateId: string
  toolName: 'set_figure_alt_text' | 'retag_as_figure_and_set_alt' | 'mark_figure_decorative'
  altText?: string
}

const ALT_TEXT_SIDECAR_FILENAME = 'alt-text-sidecar.json'

function nowIso(): string {
  return new Date().toISOString()
}

export function altTextSidecarPath(artifactsDir: string): string {
  return path.join(artifactsDir, ALT_TEXT_SIDECAR_FILENAME)
}

function normalizeText(text: string | null | undefined): string {
  return String(text || '').replace(/^u:/, '').trim()
}

function buildFigureAIDraft(
  candidate: PdfRemediationContext['figureCandidates'][number],
): string | null {
  if (candidate.informativeHint === 'decorative' || candidate.splitGenerated) return null
  const firstLine = normalizeText(candidate.surroundingText?.[0])
  if (firstLine) return `Image related to ${firstLine.replace(/[.]+$/, '').slice(0, 120)}`
  return `Image on page ${candidate.pageNumber}`
}

function candidatePriority(candidate: PdfRemediationContext['figureCandidates'][number]): number {
  if (candidate.repairMode === 'set_alt') return 0
  if (candidate.repairMode === 'retag_then_set_alt') return 1
  return 2
}

function candidateHasMeaningfulAlt(candidate: PdfRemediationContext['figureCandidates'][number]): boolean {
  const text = normalizeText(candidate.altText)
  if (!candidate.hasAlt) return false
  if (!text) return false
  return !/^(image|photo|picture|graphic|icon|logo|image\s+\d+)$/i.test(text)
}

async function readSidecar(filePath: string): Promise<AltTextSidecar | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as AltTextSidecar
    if (!parsed || parsed.version !== 1 || typeof parsed.entries !== 'object' || !parsed.entries) return null
    return parsed
  } catch {
    return null
  }
}

async function writeSidecar(filePath: string, sidecar: AltTextSidecar): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(sidecar, null, 2))
}

export async function loadAltTextSidecar(artifactsDir?: string | null): Promise<AltTextSidecar | null> {
  if (!artifactsDir) return null
  return readSidecar(altTextSidecarPath(artifactsDir))
}

export async function syncAltTextSidecar(input: {
  artifactsDir: string
  filename: string
  context: PdfRemediationContext
}): Promise<AltTextSidecar> {
  const filePath = altTextSidecarPath(input.artifactsDir)
  const existing = await readSidecar(filePath)
  const entries: Record<string, AltTextSidecarEntry> = { ...(existing?.entries || {}) }
  const timestamp = nowIso()

  const qpdfImagesById = new Map(
    input.context.qpdf.images.map(image => [
      image.contentFingerprint || image.canonicalRef || image.ref,
      image,
    ]),
  )

  for (const candidate of input.context.figureCandidates) {
    const imageId = candidate.imageKey || candidate.imageContentFingerprint || candidate.imageCanonicalRef || candidate.targetRef || candidate.id
    if (!imageId) continue
    const existingEntry = entries[imageId]
    const qpdfImage = qpdfImagesById.get(imageId)
      || (candidate.imageContentFingerprint ? qpdfImagesById.get(candidate.imageContentFingerprint) : undefined)
      || (candidate.imageCanonicalRef ? qpdfImagesById.get(candidate.imageCanonicalRef) : undefined)

    const caption = normalizeText(candidate.surroundingText?.[0]) || null
    const contextAfter = normalizeText((candidate.surroundingText || []).slice(1).join(' ')) || null
    const aiDraft = normalizeText(existingEntry?.aiDraft) || buildFigureAIDraft(candidate)
    const existingAlt = normalizeText(existingEntry?.altText)
    const candidateAlt = normalizeText(candidate.altText)

    entries[imageId] = {
      imageId,
      canonicalRef: candidate.imageCanonicalRef || qpdfImage?.canonicalRef || existingEntry?.canonicalRef || candidate.targetRef || null,
      contentFingerprint: candidate.imageContentFingerprint || qpdfImage?.contentFingerprint || existingEntry?.contentFingerprint || null,
      pageNumber: candidate.pageNumber || qpdfImage?.pageNumber || existingEntry?.pageNumber || 1,
      placementPageNumbers: [...new Set(
        [
          ...(qpdfImage?.placementPageNumbers || []),
          ...(candidate.placementPageNumbers || []),
          existingEntry?.pageNumber,
          candidate.pageNumber,
        ].filter((value): value is number => Number.isFinite(value)),
      )].sort((a, b) => a - b),
      placementCount: Math.max(
        qpdfImage?.placementCount || 0,
        candidate.placementCount || 0,
        existingEntry?.placementCount || 0,
        1,
      ),
      status: existingEntry?.status || 'needs_review',
      altText: existingEntry?.status === 'approved' || existingEntry?.status === 'decorative'
        ? existingEntry.altText
        : (candidateHasMeaningfulAlt(candidate) ? candidateAlt : existingAlt || null),
      aiDraft: aiDraft || null,
      caption,
      contextBefore: caption,
      contextAfter,
      updatedAt: timestamp,
    }
  }

  const sidecar: AltTextSidecar = {
    version: 1,
    filename: input.filename,
    updatedAt: timestamp,
    entries,
  }
  await writeSidecar(filePath, sidecar)
  return sidecar
}

export function planAltTextSidecarDirectives(input: {
  context: PdfRemediationContext
  sidecar: AltTextSidecar | null
}): AltTextSidecarDirective[] {
  if (!input.sidecar) return []

  const candidatesByImageId = new Map<string, PdfRemediationContext['figureCandidates']>()
  for (const candidate of input.context.figureCandidates) {
    const imageId = candidate.imageKey || candidate.imageContentFingerprint || candidate.imageCanonicalRef || candidate.targetRef || candidate.id
    if (!imageId) continue
    const bucket = candidatesByImageId.get(imageId) || []
    bucket.push(candidate)
    candidatesByImageId.set(imageId, bucket)
  }

  const directives: AltTextSidecarDirective[] = []
  for (const entry of Object.values(input.sidecar.entries)) {
    if (entry.status !== 'approved' && entry.status !== 'decorative') continue
    const candidates = [...(candidatesByImageId.get(entry.imageId) || [])]
      .filter(candidate => candidate.repairMode === 'set_alt' || candidate.repairMode === 'retag_then_set_alt')
      .sort((a, b) => candidatePriority(a) - candidatePriority(b))
    if (!candidates.length) continue

    const preferred = candidates.find(candidate => candidate.repairMode === 'set_alt' && !candidateHasMeaningfulAlt(candidate))
      || candidates.find(candidate => !candidateHasMeaningfulAlt(candidate))
      || candidates[0]
    if (!preferred) continue

    if (entry.status === 'decorative') {
      if (preferred.repairMode !== 'set_alt') continue
      directives.push({
        imageId: entry.imageId,
        status: entry.status,
        candidateId: preferred.id,
        toolName: 'mark_figure_decorative',
      })
      continue
    }

    const approvedAlt = normalizeText(entry.altText || entry.aiDraft)
    if (!approvedAlt) continue
    if (candidateHasMeaningfulAlt(preferred) && normalizeText(preferred.altText) === approvedAlt) continue

    directives.push({
      imageId: entry.imageId,
      status: entry.status,
      candidateId: preferred.id,
      toolName: preferred.repairMode === 'set_alt' ? 'set_figure_alt_text' : 'retag_as_figure_and_set_alt',
      altText: approvedAlt,
    })
  }

  return directives
}
