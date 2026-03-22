import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  rgb,
} from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { AnalysisResult } from './pdfAnalyzer.js'
import { analyzeWithPdfjs, getLinkDisplayText } from './pdfjsService.js'
import type { PdfjsResult } from './pdfjsService.js'
import { analyzeWithQpdf } from './qpdfService.js'
import type { QpdfResult } from './qpdfService.js'
import { runPdfStructureBackend } from './pdfStructureBackend.js'
import { runAdobeAutoTag } from './adobePdfServices.js'
import type { StructureBackendMutationResult } from './pdfStructureBackend.js'
import { normalizeLanguageTag } from './languageTags.js'
import { ANALYSIS, REMEDIATION } from '#config'
import { draftFigureAltText } from './altTextDraftingService.js'
import type {
  AppliedChange,
  BoundingBox,
  ModelReviewFlag,
  RemediationActionRecord,
  RemediationToolCall,
  SuggestedChange,
} from './documentModel.js'

export interface RemediationPageFact {
  pageNumber: number
  width: number
  height: number
  imageCount: number
  textLines: Array<{
    text: string
    bbox: BoundingBox
    fontSize: number
    fontWeight: 'normal' | 'bold'
    fontName?: string | null
  }>
  links: Array<{
    url: string
    text: string
    bbox: BoundingBox
    annotationIndex: number
    contents?: string | null
  }>
}

export interface HeadingCandidate {
  id: string
  pageNumber: number
  text: string
  bbox: BoundingBox
  fontSize: number
  fontWeight: 'normal' | 'bold'
  fontName?: string | null
  nearbyContext: string[]
  targetRef?: string | null
  existingTag?: string | null
  repairMode: 'safe' | 'defer'
  unsafeReason?: string
}

const SAFE_HEADING_TAGS = ['/P', '/Span', '/Div', '/NonStruct', '/TextBox', '/Sect', '/Story', '/Normal', '/H', '/H1', '/H2', '/H3', '/H4', '/H5', '/H6'] as const
const UNSAFE_HEADING_TAGS = ['/Link', '/L', '/LI', '/Lbl', '/TOC', '/TOCI', '/Table', '/TR', '/TH', '/TD'] as const
const SAFE_FIGURE_TAGS = ['/P', '/Span', '/Div', '/NonStruct', '/TextBox', '/Story', '/Shape', '/InlineShape', '/Normal'] as const
const UNSAFE_FIGURE_TAGS = ['/TD', '/TH', '/TR', '/Table', '/TOCI', '/TOC', '/Link', '/L', '/LI'] as const
const LEGACY_HEADING_TAG_RE = /^\/heading\s+(\d+)$/i
const WINDOWS_FONT_CANDIDATES = [
  'arial.ttf',
  'segoeui.ttf',
  'calibri.ttf',
] as const
let cachedEmbeddedRewriteFontBytes: Buffer | null = null

async function loadRewriteFontBytes(): Promise<Buffer | null> {
  if (cachedEmbeddedRewriteFontBytes) return cachedEmbeddedRewriteFontBytes
  const fontsDir = path.join(process.env.WINDIR || 'C:/Windows', 'Fonts')
  for (const filename of WINDOWS_FONT_CANDIDATES) {
    const candidate = path.join(fontsDir, filename)
    try {
      const bytes = await fs.readFile(candidate)
      cachedEmbeddedRewriteFontBytes = bytes
      return bytes
    } catch {
      continue
    }
  }
  return null
}

function isSafeHeadingTag(tag?: string | null): boolean {
  return !!tag
    && (
      SAFE_HEADING_TAGS.includes(tag as (typeof SAFE_HEADING_TAGS)[number])
      || LEGACY_HEADING_TAG_RE.test(tag)
    )
}

function isUnsafeHeadingTag(tag?: string | null): boolean {
  return !!tag && UNSAFE_HEADING_TAGS.includes(tag as (typeof UNSAFE_HEADING_TAGS)[number])
}

export function normalizedExistingHeadingLevel(tag?: string | null): string | null {
  if (!tag) return null
  if (/^\/?H[1-6]$/i.test(tag)) {
    return String(tag).replace(/^\//, '').toUpperCase()
  }
  const legacy = String(tag).match(LEGACY_HEADING_TAG_RE)
  if (!legacy) return null
  const numeric = Math.max(1, Math.min(6, Number(legacy[1]) || 1))
  return `H${numeric}`
}

function remapHeadingTarget(
  structuralNodes: StructureBackendMutationResult['structuralNodes'],
  startIndex: number,
): StructureBackendMutationResult['structuralNodes'][number] | null {
  const initial = structuralNodes[startIndex] || null
  if (!initial) return null
  const structuralByRef = new Map(
    structuralNodes
      .filter((node): node is NonNullable<typeof node> => !!node?.ref)
      .map(node => [node.ref as string, node]),
  )
  if (isSafeHeadingTag(initial.tag) && initial.tag !== '/Sect' && initial.tag !== '/Story') return initial
  if (initial.parentRef) {
    const parent = structuralByRef.get(initial.parentRef)
    if (parent && isSafeHeadingTag(parent.tag) && parent.tag !== '/Sect' && parent.tag !== '/Story') {
      return parent
    }
  }
  if ((initial.tag === '/Sect' || initial.tag === '/Story') && initial.ref) {
    for (let index = startIndex + 1; index < structuralNodes.length; index++) {
      const candidate = structuralNodes[index]
      if (!candidate) break
      const inSection = candidate.parentRef === initial.ref
        || candidate.parentTagPath?.includes('/Sect')
        || candidate.parentTagPath?.includes('/Story')
      if (!inSection) {
        if (candidate.orderIndex > initial.orderIndex + 12) break
        continue
      }
      if (isSafeHeadingTag(candidate.tag)) return candidate
      if (
        candidate.parentRef !== initial.ref
        && !candidate.parentTagPath?.includes('/Sect')
        && !candidate.parentTagPath?.includes('/Story')
      ) break
    }
  }
  const limit = Math.min(48, structuralNodes.length)
  for (let offset = 1; offset <= limit; offset++) {
    const next = structuralNodes[startIndex + offset]
    if (
      next
      && isSafeHeadingTag(next.tag)
      && (
        next.parentRef === initial.parentRef
        || next.parentRef === initial.ref
        || next.parentTagPath?.some(tag => initial.parentTagPath?.includes(tag))
      )
    ) return next
    const previous = structuralNodes[startIndex - offset]
    if (
      previous
      && isSafeHeadingTag(previous.tag)
      && (
        previous.parentRef === initial.parentRef
        || previous.parentRef === initial.ref
        || previous.parentTagPath?.some(tag => initial.parentTagPath?.includes(tag))
      )
    ) return previous
  }
  return initial.tag === '/Sect' || initial.tag === '/Story' ? initial : null
}

export const __test_remapHeadingTarget = remapHeadingTarget

export interface FigureCandidate {
  id: string
  pageNumber: number
  targetRef?: string | null
  bbox?: BoundingBox | null
  imageKey?: string | null
  imageCanonicalRef?: string | null
  imageContentFingerprint?: string | null
  placementPageNumbers?: number[]
  placementCount?: number
  hasAlt: boolean
  altText?: string | null
  hasLowQualityAlt?: boolean
  informativeHint: 'informative' | 'decorative' | 'unknown'
  surroundingText: string[]
  repairMode: 'set_alt' | 'retag_then_set_alt' | 'defer'
  targetTag?: string | null
  unsafeReason?: string
  parentTagPath?: string[]
  pageImageCount: number
  textDensityHint: 'low' | 'medium' | 'high'
  imageEvidence: 'strong' | 'vector' | 'weak'
  containsText?: boolean
  splitGenerated?: boolean
  splitSourceRef?: string | null
  splitSourceTag?: string | null
}

function normalizeFigureAltQualityText(text: string | null | undefined): string {
  return String(text || '').replace(/^u:/, '').trim().toLowerCase()
}

function isUnreadableFigureAltText(text: string | null | undefined): boolean {
  const raw = String(text || '').replace(/^u:/, '').trim()
  if (!raw) return false
  const tokens = raw.split(/\s+/).filter(Boolean)
  const isolatedGlyphTokens = tokens.filter(token => {
    const normalized = token.replace(/[.,;:!?'"()\-_/\\]/g, '')
    return normalized.length <= 1
  })
  return tokens.length >= 6 && (isolatedGlyphTokens.length / tokens.length) >= 0.65
}

function isFragmentaryFigureAltText(text: string | null | undefined): boolean {
  const raw = String(text || '').replace(/^u:/, '').trim()
  if (!raw) return false
  const words = raw.split(/\s+/).filter(Boolean)
  if (words.length < 6) return false
  const startsLowercase = /^[a-z]/.test(raw)
  const endsWithContinuation = /\b(and|or|but|with|than|to|of|for|in|on|at|by)$/i.test(raw)
  const hasCitationLikeNumber = /\b\d{1,3}\b/.test(raw)
  return startsLowercase || endsWithContinuation || hasCitationLikeNumber
}

function isCitationLikeFigureAltText(text: string | null | undefined): boolean {
  const raw = String(text || '').replace(/^u:/, '').trim()
  if (!raw) return false
  const words = raw.split(/\s+/).filter(Boolean)
  if (words.length < 4) return false
  if (/\b[A-Z][a-z]+,\s*\d{1,3}\s*\(\d+\)/.test(raw)) return true
  if (/\b\d{1,3}\s*\(\d+\),\s*\d+[\u2013\u2014-]\d+\b/.test(raw)) return true
  if (/\b\d{4}\)\s*$/.test(raw) && /[;,]/.test(raw)) return true
  if (/\b\d{1,3}\s*\([1-9]\)\b/.test(raw)) return true
  return /\b(vol\.?|no\.?|issue|journal|pp\.?|doi)\b/i.test(raw)
}

function hasLowQualityFigureAltText(text: string | null | undefined): boolean {
  const normalized = normalizeFigureAltQualityText(text)
  if (!normalized) return false
  if (/^(image|picture|photo|graphic)\s+of\b/i.test(normalized)) return true
  if (/^image related to\b/i.test(normalized)) return true
  if (isUnreadableFigureAltText(text)) return true
  if (isFragmentaryFigureAltText(text)) return true
  if (isCitationLikeFigureAltText(text)) return true
  if (normalized.length > 220 || normalized.split(/\s+/).filter(Boolean).length > 32) return true
  return new Set(['image', 'photo', 'picture', 'graphic', 'icon', 'logo', 'figure 1', 'figure 2']).has(normalized)
}

export interface ReadingOrderCandidate {
  id: string
  ref: string
  tag: string
  parentRef?: string | null
  orderIndex: number
}

export interface ReadingOrderParentCandidate {
  id: string
  parentRef: string
  childCandidateIds: string[]
  mutableKids: boolean
  mcidDisorderBefore: number
  pageNumberHints: number[]
  tagMix: string[]
  suggestedChildCandidateIds: string[]
}

export interface LinkCandidate {
  id: string
  pageNumber: number
  url: string
  text: string
  bbox: BoundingBox
  annotationIndex: number
  annotationContents?: string | null
  rawUrl: boolean
  suggestedText?: string | null
}

export interface TableCandidate {
  id: string
  ref: string
  pageNumberHints: number[]
  firstRowCellRefs: string[]
  headerCellRefs: string[]
  hasHeaders: boolean
  repairMode: 'safe' | 'defer'
  nearbyContext: string[]
  unsafeReason?: string
}

function bootstrapFigureAltText(candidate: FigureCandidate): string {
  return draftFigureAltText({
    pageNumber: candidate.pageNumber,
    surroundingText: candidate.surroundingText,
    decorative: candidate.splitGenerated || candidate.informativeHint === 'decorative',
  })
}

function isSemanticAiEligibleDeferredFigureCandidate(candidate: FigureCandidate | null | undefined): boolean {
  if (!candidate || candidate.repairMode !== 'defer') return false
  if (candidate.informativeHint === 'decorative') return false
  if (!(candidate.imageEvidence === 'strong' || candidate.imageEvidence === 'vector')) return false
  if (!candidate.unsafeReason?.startsWith('text_heavy_candidate:')) return false
  return !!candidate.targetTag && SAFE_FIGURE_TAGS.includes(candidate.targetTag as (typeof SAFE_FIGURE_TAGS)[number])
}

export const __test_isSemanticAiEligibleDeferredFigureCandidate = isSemanticAiEligibleDeferredFigureCandidate

export interface PdfRemediationContext {
  analysis: AnalysisResult
  qpdf: QpdfResult
  pdfjs: PdfjsResult
  structure: StructureBackendMutationResult
  pages: RemediationPageFact[]
  headingCandidates: HeadingCandidate[]
  figureCandidates: FigureCandidate[]
  tableCandidates: TableCandidate[]
  readingOrderCandidates: ReadingOrderCandidate[]
  readingOrderParentCandidates: ReadingOrderParentCandidate[]
  linkCandidates: LinkCandidate[]
}

export type RemediationInspectMode = 'light' | 'alt_text_deep'

type CachedPdfRemediationPayload = Omit<PdfRemediationContext, 'analysis'>

const INSPECTION_RESULT_CACHE_MAX_ENTRIES = 20
const inspectionResultCache = new Map<string, CachedPdfRemediationPayload>()

export interface RemediationInspectionCache {
  bufferSha256?: string
  contextsByMode?: Partial<Record<RemediationInspectMode, CachedPdfRemediationPayload>>
  pagesByHash?: Record<string, RemediationPageFact[]>
  qpdf?: QpdfResult
  pdfjs?: PdfjsResult
  pages?: RemediationPageFact[]
}

export interface RemediationInspectOptions {
  inspectMode?: RemediationInspectMode
  cache?: RemediationInspectionCache
}

function inspectionCacheKey(bufferSha256: string, inspectMode: RemediationInspectMode): string {
  return `${bufferSha256}:${inspectMode}`
}

function getBufferSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function getCachedPagesForHash(
  cache: RemediationInspectionCache | undefined,
  bufferSha256: string,
): RemediationPageFact[] | undefined {
  return cache?.pagesByHash?.[bufferSha256]
}

function setCachedPagesForHash(
  cache: RemediationInspectionCache | undefined,
  bufferSha256: string,
  pages: RemediationPageFact[],
): void {
  if (!cache) return
  cache.pagesByHash = {
    ...(cache.pagesByHash || {}),
    [bufferSha256]: pages,
  }
  // Preserve the legacy field as a mirror for the current buffer.
  cache.pages = pages
}

function toInspectionContext(
  analysis: AnalysisResult,
  payload: CachedPdfRemediationPayload,
): PdfRemediationContext {
  return {
    analysis,
    ...payload,
  }
}

function toInspectionPayload(input: {
  qpdf: QpdfResult
  pdfjs: PdfjsResult
  pages: RemediationPageFact[]
  structure: StructureBackendMutationResult
}): CachedPdfRemediationPayload {
  const readingOrderCandidates = buildReadingOrderCandidates(input.structure)
  return {
    qpdf: input.qpdf,
    pdfjs: input.pdfjs,
    pages: input.pages,
    structure: input.structure,
    headingCandidates: buildHeadingCandidatesFromPageFacts(input.pages, input.structure),
    figureCandidates: buildFigureCandidates(input.pages, input.structure, input.qpdf),
    tableCandidates: buildTableCandidates(input.pages, input.structure),
    readingOrderCandidates,
    readingOrderParentCandidates: buildReadingOrderParentCandidates(input.structure, readingOrderCandidates),
    linkCandidates: buildLinkCandidates(input.pages),
  }
}

function setCachedInspectionPayload(
  cacheKey: string,
  payload: CachedPdfRemediationPayload,
): void {
  if (inspectionResultCache.has(cacheKey)) inspectionResultCache.delete(cacheKey)
  else if (inspectionResultCache.size >= INSPECTION_RESULT_CACHE_MAX_ENTRIES) {
    inspectionResultCache.delete(inspectionResultCache.keys().next().value!)
  }
  inspectionResultCache.set(cacheKey, payload)
}

export function __test_resetInspectionResultCache(): void {
  inspectionResultCache.clear()
}

export function __test_getInspectionResultCacheSize(): number {
  return inspectionResultCache.size
}

let buildRemediationPageFactsCallCount = 0

export function __test_resetBuildRemediationPageFactsCallCount(): void {
  buildRemediationPageFactsCallCount = 0
}

export function __test_getBuildRemediationPageFactsCallCount(): number {
  return buildRemediationPageFactsCallCount
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

function isRawUrl(text: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(text.trim())
}

function normalizeHeadingText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function looksLikeProseHeadingText(text: string): boolean {
  const normalized = normalizeHeadingText(text)
  if (!normalized) return true
  if (normalized.length < 3 || normalized.length > 120) return true
  if (normalized.endsWith('.')) return true
  const words = normalized.match(/\b[\p{L}\p{N}&/-]+\b/gu) || []
  if (words.length > 12) return true
  const sentencePunctuationCount = (normalized.match(/[.;!?]/g) || []).length
  if (sentencePunctuationCount > 0 && words.length > 6) return true
  if (/,/.test(normalized) && words.length > 7) return true
  if (/[()]/.test(normalized) && words.length > 9) return true
  if (/\b(and|or|but|because|while|although|since|were|was|are|have|has)\b/i.test(normalized) && words.length > 8) return true

  const significantWords = words.filter(word => /[A-Za-z]/.test(word))
  const lowercaseWords = significantWords.filter(word => /^[a-z]/.test(word))
  const uppercaseWords = significantWords.filter(word => /^[A-Z0-9]/.test(word) || word === word.toUpperCase())
  if (significantWords.length >= 6 && lowercaseWords.length > uppercaseWords.length) return true

  return false
}

function headingWordCount(text: string): number {
  return (normalizeHeadingText(text).match(/\b[\p{L}\p{N}&/-]+\b/gu) || []).length
}

function longReportHeadingCandidateScore(
  candidate: HeadingCandidate,
  duplicateCounts: Map<string, number>,
): number {
  const normalized = normalizeHeadingText(candidate.text)
  const normalizedKey = normalized.toLowerCase()
  const words = headingWordCount(normalized)
  let score = 0
  if (candidate.pageNumber === 1) score += 3
  if (candidate.fontWeight === 'bold') score += 2
  if (candidate.fontSize >= 18) score += 2
  else if (candidate.fontSize >= 15) score += 1
  if (words >= 1 && words <= 4) score += 2
  else if (words <= 6) score += 1
  if ((candidate.existingTag || '').startsWith('/H')) score += 2
  if ((duplicateCounts.get(normalizedKey) || 0) > 1) score -= 3
  if (normalized === normalized.toUpperCase() && words <= 4) score += 1
  if (candidate.bbox.y < 0.25) score += 1
  return score
}

function shouldRejectLongReportHeadingCandidate(
  candidate: HeadingCandidate,
  duplicateCounts: Map<string, number>,
): boolean {
  const normalized = normalizeHeadingText(candidate.text)
  if (!normalized) return true
  if (candidate.repairMode !== 'safe') return true
  if (normalized.length < 4 || normalized.length > 90) return true
  if (isRawUrl(normalized)) return true
  if (/(\.{2,}|_{2,}|-{3,})/.test(normalized)) return true
  if (/^\d+$/.test(normalized)) return true
  if (/^[a-z]/.test(normalized)) return true
  if (looksLikeProseHeadingText(normalized)) return true
  if (headingWordCount(normalized) > 8) return true
  if ((duplicateCounts.get(normalized.toLowerCase()) || 0) > 1 && candidate.pageNumber > 1) return true
  if (candidate.nearbyContext.some(line => looksLikeProseHeadingText(line) && line.length > 40)) return true
  return false
}

export function selectHighConfidenceLongReportHeadingCandidates(
  candidates: HeadingCandidate[],
  options?: { maxCandidates?: number },
): HeadingCandidate[] {
  const safeCandidates = candidates.filter(candidate => candidate.repairMode === 'safe')
  const duplicateCounts = new Map<string, number>()
  for (const candidate of safeCandidates) {
    const key = normalizeHeadingText(candidate.text).toLowerCase()
    duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1)
  }
  const filtered = safeCandidates.filter(candidate => !shouldRejectLongReportHeadingCandidate(candidate, duplicateCounts))
  return [...filtered]
    .sort((a, b) => {
      const scoreDiff = longReportHeadingCandidateScore(b, duplicateCounts) - longReportHeadingCandidateScore(a, duplicateCounts)
      if (scoreDiff !== 0) return scoreDiff
      const pageDiff = a.pageNumber - b.pageNumber
      if (pageDiff !== 0) return pageDiff
      return normalizeHeadingText(a.text).localeCompare(normalizeHeadingText(b.text))
    })
    .slice(0, options?.maxCandidates ?? 3)
}

function longReportFigureCandidateScore(candidate: FigureCandidate): number {
  let score = 0
  score += candidate.repairMode === 'set_alt' ? 50 : candidate.repairMode === 'retag_then_set_alt' ? 35 : -40
  score += candidate.informativeHint === 'informative' ? 40 : candidate.informativeHint === 'unknown' ? 10 : -20
  score += candidate.imageEvidence === 'strong' ? 25 : candidate.imageEvidence === 'vector' ? 10 : 0
  score += candidate.textDensityHint === 'low' ? 20 : candidate.textDensityHint === 'medium' ? 8 : -12
  score += candidate.pageNumber === 1 ? 12 : Math.max(0, 8 - candidate.pageNumber)
  if (candidate.targetTag === '/Figure') score += 8
  if (candidate.hasLowQualityAlt) score += 10
  if (candidate.splitGenerated) score -= 30
  if ((candidate.surroundingText || []).some(line => looksLikeProseHeadingText(line) && line.length > 80)) score -= 10
  return score
}

export function selectHighConfidenceLongReportFigureCandidates(
  candidates: FigureCandidate[],
  options?: { maxCandidates?: number },
): FigureCandidate[] {
  return [...candidates]
    .filter(candidate => candidate.repairMode !== 'defer')
    .sort((a, b) => {
      const scoreDiff = longReportFigureCandidateScore(b) - longReportFigureCandidateScore(a)
      if (scoreDiff !== 0) return scoreDiff
      const pageDiff = a.pageNumber - b.pageNumber
      if (pageDiff !== 0) return pageDiff
      return a.id.localeCompare(b.id)
    })
    .slice(0, options?.maxCandidates ?? 5)
}

function normalizeBookmarkText(text: string): string {
  const stopWords = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'via'])
  const normalized = text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
  if (!normalized) return normalized
  return normalized
    .split(' ')
    .map((word, index) => {
      if (!/[A-Za-z]/.test(word)) return word
      const lower = word.toLowerCase()
      const hasWeirdMixedCase = /[A-Z]/.test(word)
        && /[a-z]/.test(word)
        && !/^[A-Z][a-z]+(?:['-][A-Za-z]+)?$/.test(word)
      const allUpper = word === word.toUpperCase() && /[A-Z]/.test(word)
      if (index > 0 && stopWords.has(lower)) return lower
      if (hasWeirdMixedCase || allUpper) {
        return lower.charAt(0).toUpperCase() + lower.slice(1)
      }
      return word
    })
    .join(' ')
}

function looksLikeBookmarkNoise(text: string): boolean {
  const normalized = normalizeBookmarkText(text)
  if (!normalized) return true
  if (normalized.length < 4) return true
  if (!/[A-Za-z]/.test(normalized)) return true
  if (normalized.length > 90) return true
  const words = normalized.match(/\b[\p{L}\p{N}&/-]+\b/gu) || []
  if (words.length > 8) return true
  if (/^[A-Z]\s+[a-z].{12,}/.test(normalized)) return true
  if (/^[a-z]/.test(normalized)) return true
  if (looksLikeProseHeadingText(normalized) && words.length > 6) return true
  if (/(we are pleased|under the leadership|for the agency|state fiscal year|provides statistical|the weeks that followed)/i.test(normalized)) return true
  return false
}

function cleanedBookmarkHeadings(candidates: HeadingCandidate[]): Array<{
  text: string
  level: string
  targetRef?: string | null
  pageNumber: number
}> {
  const seen = new Set<string>()
  const headings: Array<{ text: string; level: string; targetRef?: string | null; pageNumber: number }> = []
  for (const candidate of candidates) {
    const text = normalizeBookmarkText(candidate.text)
    if (!text || looksLikeBookmarkNoise(text)) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    headings.push({
      text,
      level: normalizedExistingHeadingLevel(candidate.existingTag) || (candidate.pageNumber === 1 ? 'H1' : 'H2'),
      targetRef: candidate.targetRef,
      pageNumber: candidate.pageNumber,
    })
  }
  return headings
}

function toNormalizedBbox(x: number, y: number, width: number, height: number, pageWidth: number, pageHeight: number): BoundingBox {
  return {
    x: clamp(x / pageWidth),
    y: clamp(y / pageHeight),
    width: clamp(width / pageWidth, 0.001, 1),
    height: clamp(height / pageHeight, 0.001, 1),
  }
}

function extractTextLines(textContent: any, pageWidth: number, pageHeight: number): RemediationPageFact['textLines'] {
  const items = (textContent.items || [])
    .filter((item: any) => String(item?.str || '').trim())
    .map((item: any) => {
      const text = String(item.str).trim()
      const width = Math.max(1, Number(item.width) || (text.length * 5))
      const height = Math.max(8, Math.abs(Number(item.height)) || 12)
      const x = Number(item.transform?.[4]) || 0
      const y = Number(item.transform?.[5]) || 0
      return {
        text,
        x,
        y,
        width,
        height,
        fontSize: Math.max(8, Math.round(height)),
        fontName: typeof item.fontName === 'string' ? item.fontName : null,
      }
    })
    .sort((a: { y: number; x: number }, b: { y: number; x: number }) => (b.y - a.y) || (a.x - b.x))
  type TextItem = (typeof items)[number]

  const lines: Array<typeof items> = []
  for (const item of items) {
    const anchor = lines.at(-1)?.[0]
    if (anchor && Math.abs(anchor.y - item.y) < 8) {
      lines.at(-1)!.push(item)
    } else {
      lines.push([item])
    }
  }

  const medianFont = items.length
    ? [...items].map(item => item.fontSize).sort((a: number, b: number) => a - b)[Math.floor(items.length / 2)]
    : 12

  const splitOrderedLine = (ordered: TextItem[]): TextItem[][] => {
    if (ordered.length <= 1) return [ordered]
    const segments: TextItem[][] = []
    let current: TextItem[] = [ordered[0]!]
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = current[current.length - 1]!
      const next = ordered[index]!
      const gap = next.x - (previous.x + previous.width)
      const gapThreshold = Math.max(
        60,
        Math.round(Math.max(previous.fontSize, next.fontSize) * 3),
        Math.round(pageWidth * 0.06),
      )
      if (gap > gapThreshold) {
        segments.push(current)
        current = [next]
      } else {
        current.push(next)
      }
    }
    if (current.length) segments.push(current)
    return segments
  }

  return lines.flatMap(line => {
    const ordered = [...line].sort((a, b) => a.x - b.x)
    return splitOrderedLine(ordered).map((segment: TextItem[]) => {
      const text = segment.map(item => item.text).join(' ').replace(/\s+/g, ' ').trim()
      const fontSize = Math.round(segment.reduce((sum: number, item: TextItem) => sum + item.fontSize, 0) / segment.length)
      const fontNameCounts = new Map<string, number>()
      for (const item of segment) {
        const key = item.fontName || ''
        fontNameCounts.set(key, (fontNameCounts.get(key) || 0) + 1)
      }
      const dominantFontName = [...fontNameCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
      const minX = Math.min(...segment.map((item: TextItem) => item.x))
      const maxX = Math.max(...segment.map((item: TextItem) => item.x + item.width))
      const maxY = Math.max(...segment.map((item: TextItem) => item.y))
      const minY = Math.min(...segment.map((item: TextItem) => item.y - item.height))
      return {
        text,
        bbox: toNormalizedBbox(minX, minY, maxX - minX, maxY - minY, pageWidth, pageHeight),
        fontSize,
        fontWeight: fontSize > medianFont * 1.15 ? 'bold' as const : 'normal' as const,
        fontName: dominantFontName,
      }
    })
  }).slice(0, 120)
}

export const __test_extractTextLines = extractTextLines

function findLinkTextFromRect(annotation: any, items: any[]): string {
  return getLinkDisplayText(annotation, items)
}

function textNear(lines: RemediationPageFact['textLines'], index: number): string[] {
  return lines
    .slice(index + 1, index + 3)
    .map(line => line.text)
    .filter(Boolean)
}

export function needsAltTextDeepInspection(analysis: AnalysisResult): boolean {
  const altTextCategory = analysis.categories.find(category => category.id === 'alt_text')
  const hasUntaggedImageFindings = (altTextCategory?.findings || []).some(finding =>
    /none have accessibility tags|not tagged as <figure>|not tagged as \/figure|images exist in the pdf but are not tagged|cannot identify them or read any alternative text/i.test(finding))
  const hasAcrobatAltRiskFindings = (altTextCategory?.findings || []).some(finding =>
    /acrobat.risk|acrobat-risk|other-elements alternate text|graphics content is still owned by non-\/figure|acrobat-style|non-figure.*graphics|graphics.*non-figure/i.test(finding))
  if (hasAcrobatAltRiskFindings || hasUntaggedImageFindings) {
    // Once scoring has already surfaced Acrobat-risk ownership findings, keep deep inspection
    // enabled for follow-up remediation rounds regardless of the current category score.
    // The same applies when analysis shows images exist but are not tagged as /Figure:
    // that requires a structure-level ownership repair, not just missing alt text.
    return true
  }
  if (analysis.verapdf?.status !== 'failed') return false
  return analysis.verapdf.failures.some(failure =>
    failure.categoryIds.includes('alt_text')
    || /alternate text|figure|artifact|decorative image|non-text content/i.test(failure.message),
  )
}

function normalizeHeadingLevels(levels: string[]): string[] {
  let previous = 0
  return levels.map((level, index) => {
    const requested = /^H([1-6])$/i.test(level)
      ? Number(level.slice(1))
      : 2
    const normalized = index === 0
      ? 1
      : Math.min(6, Math.max(1, Math.min(requested, previous + 1)))
    previous = normalized
    return `H${normalized}`
  })
}

function looksLikeTitleCaseHeading(text: string): boolean {
  if (!text || text.length > 120) return false
  if (/[.!?]\s+[A-Z]/.test(text)) return false
  const tokens = text.split(/\s+/).filter(Boolean)
  if (!tokens.length) return false
  const alphaTokens = tokens.filter(token => /[A-Za-z]/.test(token))
  if (!alphaTokens.length) return false
  const titleLikeTokens = alphaTokens.filter(token =>
    /^[A-Z0-9]/.test(token)
    || /^(of|the|and|for|to|in|on|with|by|at|a|an|or|but|from|into|over|under|via|ii|iii|iv|v|vi|vii|viii|ix|x)$/i.test(token),
  )
  return titleLikeTokens.length / alphaTokens.length >= 0.8
}

function hasDistinctHeadingFont(
  line: RemediationPageFact['textLines'][number],
  dominantFontName: string | null,
): boolean {
  return !!line.fontName && !!dominantFontName && line.fontName !== dominantFontName
}

function isTopOfPageHeadingCandidate(
  line: RemediationPageFact['textLines'][number],
  index: number,
  lines: RemediationPageFact['textLines'],
): boolean {
  if (index > 2) return false
  if (line.bbox.y < 0.68) return false
  if (!looksLikeTitleCaseHeading(line.text)) return false
  const nextLine = lines[index + 1]
  if (!nextLine) return true
  return nextLine.text.length >= 60 || looksLikeProseHeadingText(nextLine.text)
}

export function buildHeadingCandidatesFromPageFacts(
  pages: RemediationPageFact[],
  structure: StructureBackendMutationResult,
): HeadingCandidate[] {
  const structuralTargets = structure.structuralNodes
  const candidates: HeadingCandidate[] = []
  let targetIndex = 0

  for (const page of pages) {
    const fontSizes = page.textLines.map(line => line.fontSize).sort((a, b) => a - b)
    const medianFont = fontSizes.length ? fontSizes[Math.floor(fontSizes.length / 2)] : 12
    const fontNameCounts = new Map<string, number>()
    for (const line of page.textLines) {
      const key = line.fontName || ''
      fontNameCounts.set(key, (fontNameCounts.get(key) || 0) + 1)
    }
    const dominantFontName = [...fontNameCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null

    page.textLines.forEach((line, index) => {
      const normalizedText = normalizeHeadingText(line.text)
      const distinctFont = hasDistinctHeadingFont(line, dominantFontName)
      const topOfPageHeading = isTopOfPageHeadingCandidate(line, index, page.textLines)
      const headingLike =
        normalizedText.length >= 3 &&
        normalizedText.length <= 120 &&
        !isRawUrl(normalizedText) &&
        !normalizedText.startsWith('•') &&
        !looksLikeProseHeadingText(normalizedText) &&
        (line.fontWeight === 'bold' || line.fontSize >= medianFont + 2 || distinctFont || topOfPageHeading)

      if (!headingLike) return
      const rawTarget = structuralTargets[targetIndex] || null
      const target = remapHeadingTarget(structuralTargets, targetIndex)
      candidates.push({
        id: `heading:${page.pageNumber}:${candidates.length + 1}`,
        pageNumber: page.pageNumber,
        text: normalizedText,
        bbox: line.bbox,
        fontSize: line.fontSize,
        fontWeight: line.fontWeight,
        fontName: line.fontName,
        nearbyContext: textNear(page.textLines, index),
        targetRef: target?.ref || null,
        existingTag: target?.tag || rawTarget?.tag || null,
        repairMode: target?.ref ? 'safe' : 'defer',
        unsafeReason: target?.ref
          ? undefined
          : isUnsafeHeadingTag(rawTarget?.tag)
            ? `Heading candidate resolved to unsafe structural tag ${rawTarget?.tag}.`
            : 'Heading candidate did not map cleanly to a safe text-bearing structure element.',
      })
      targetIndex++
    })
  }

  return candidates.slice(0, 16)
}

function buildFigureCandidates(
  pages: RemediationPageFact[],
  structure: StructureBackendMutationResult,
  qpdf: QpdfResult,
): FigureCandidate[] {
  const qpdfImageByRef = new Map<string, QpdfResult['images'][number]>()
  for (const image of qpdf.images) {
    for (const key of [image.ref, image.canonicalRef, image.contentFingerprint].filter(Boolean) as string[]) {
      if (!qpdfImageByRef.has(key)) qpdfImageByRef.set(key, image)
    }
  }
  const structuralByRef = new Map(structure.structuralNodes.map(node => [node.ref, node]))
  const figureByRef = new Map(structure.figures.map(figure => [figure.ref, figure]))
  const nestedFigureContainerRefs = new Set(
    structure.figures
      .filter(figure => (figure.childFigureCount || 0) > 0)
      .map(figure => figure.ref)
      .filter(Boolean),
  )
  const imagePages = pages.filter(page => page.imageCount > 0)
  const classifyFigureTarget = (
    targetRef: string | null | undefined,
    pageImageCount: number,
    surroundingText: string[],
    textDensityHint: FigureCandidate['textDensityHint'],
    imageEvidence: FigureCandidate['imageEvidence'],
    informativeHint: FigureCandidate['informativeHint'],
    splitGenerated = false,
    splitSourceTag: string | null | undefined = null,
    allowContainerAlt = false,
  ) => {
    const structuralNode = targetRef ? structuralByRef.get(targetRef) : null
    const figureNode = targetRef ? figureByRef.get(targetRef) : null
    const targetTag = figureNode?.tag || structuralNode?.tag || null
    const parentTagPath = figureNode?.parentTagPath || structuralNode?.parentTagPath || []
    const childFigureCount = figureNode?.childFigureCount || 0
    const unsafeTag = targetTag && UNSAFE_FIGURE_TAGS.includes(targetTag as (typeof UNSAFE_FIGURE_TAGS)[number])
    const unsafeParent = parentTagPath.find(tag => UNSAFE_FIGURE_TAGS.includes(tag as (typeof UNSAFE_FIGURE_TAGS)[number]))
    if (!targetRef) {
      return {
        repairMode: 'defer' as const,
        targetTag,
        parentTagPath,
        unsafeReason: imageEvidence === 'weak'
          ? 'no_figure_evidence: Figure candidate did not map to an editable structure element with strong figure evidence.'
          : 'Figure candidate did not map to an editable structure element.',
      }
    }
    if (targetTag === '/Figure') {
      if (childFigureCount > 0) {
        return {
          repairMode: 'defer' as const,
          targetTag,
          parentTagPath,
          unsafeReason: `nested_figure_container: Target ${targetRef} is a container /Figure with ${childFigureCount} descendant figure(s) and should not receive direct alt text.`,
        }
      }
      if (splitGenerated) {
        return {
          repairMode: informativeHint === 'decorative' ? 'set_alt' as const : 'defer' as const,
          targetTag,
          parentTagPath,
          unsafeReason: informativeHint === 'decorative'
            ? undefined
            : `split_generated_figure: Target ${targetRef} was created from mixed ${splitSourceTag || 'non-figure'} content and should not receive heading-derived informative alt text automatically.`,
        }
      }
      return {
        repairMode: 'set_alt' as const,
        targetTag,
        parentTagPath,
      }
    }
    const isTableCellWrapCandidate = targetTag === '/TD'
      && imageEvidence === 'strong'
      && informativeHint !== 'decorative'
    if ((unsafeTag || unsafeParent) && !isTableCellWrapCandidate) {
      return {
        repairMode: 'defer' as const,
        targetTag,
        parentTagPath,
        unsafeReason: `unsafe_ancestry: Target ${targetRef} is associated with ${unsafeTag ? targetTag : unsafeParent} and is not safe to retag as /Figure.`,
      }
    }
    if (isTableCellWrapCandidate) {
      return {
        repairMode: 'retag_then_set_alt' as const,
        targetTag,
        parentTagPath,
      }
    }
    if (allowContainerAlt && targetTag) {
      return {
        repairMode: 'set_alt' as const,
        targetTag,
        parentTagPath,
      }
    }
    if (targetTag && SAFE_FIGURE_TAGS.includes(targetTag as (typeof SAFE_FIGURE_TAGS)[number])) {
      const hasStrongFigureEvidence = imageEvidence === 'strong' || imageEvidence === 'vector'
      if (!hasStrongFigureEvidence) {
        return {
          repairMode: 'defer' as const,
          targetTag,
          parentTagPath,
          unsafeReason: `no_figure_evidence: Target ${targetRef} does not have strong enough figure evidence for automatic figure retagging.`,
        }
      }
      if (!hasStrongFigureEvidence && textDensityHint === 'high' && targetTag !== '/TextBox' && surroundingText.join(' ').length > 220) {
        return {
          repairMode: 'defer' as const,
          targetTag,
          parentTagPath,
          unsafeReason: `text_heavy_candidate: Target ${targetRef} appears text-heavy and is not safe to retag as /Figure.`,
        }
      }
      return {
        repairMode: 'retag_then_set_alt' as const,
        targetTag,
        parentTagPath,
      }
    }
    return {
      repairMode: 'defer' as const,
      targetTag,
      parentTagPath,
      unsafeReason: targetTag
        ? `Target ${targetRef} has tag ${targetTag} and is not safe to retag as /Figure.`
        : `Target ${targetRef} could not be matched to a safe figure structure node.`,
    }
  }

  const explicitFigures = structure.figures
    .filter(figure => !((figure.childFigureCount || 0) > 0))
    .map((figure, index) => {
    const qpdfImage = qpdfImageByRef.get(figure.ref)
      || (figure.splitSourceRef ? qpdfImageByRef.get(figure.splitSourceRef) : undefined)
    const page = imagePages[index] || pages[index] || null
    const surroundingText = page?.textLines.slice(0, 4).map(line => line.text) || []
    const informativeHint = figure.splitGenerated ? 'decorative' as const : (surroundingText.length > 0 ? 'informative' as const : 'unknown' as const)
    const textDensityHint = surroundingText.length <= 1 ? 'low' as const : surroundingText.length <= 3 ? 'medium' as const : 'high' as const
    const classification = classifyFigureTarget(
      figure.ref,
      page?.imageCount || 0,
      surroundingText,
      textDensityHint,
      'strong',
      informativeHint,
      !!figure.splitGenerated,
      figure.splitSourceTag,
    )
    return {
      id: `figure:${index + 1}`,
      pageNumber: page?.pageNumber || 1,
      targetRef: figure.ref,
      bbox: page ? { x: 0, y: 0, width: 1, height: 1 } : null,
      imageKey: qpdfImage?.contentFingerprint || qpdfImage?.canonicalRef || figure.splitSourceRef || figure.ref,
      imageCanonicalRef: qpdfImage?.canonicalRef || figure.splitSourceRef || figure.ref,
      imageContentFingerprint: qpdfImage?.contentFingerprint || null,
      placementPageNumbers: qpdfImage?.placementPageNumbers || (page?.pageNumber ? [page.pageNumber] : []),
      placementCount: qpdfImage?.placementCount || 1,
      hasAlt: figure.hasAlt,
      altText: figure.altText || null,
      hasLowQualityAlt: figure.hasAlt && hasLowQualityFigureAltText(figure.altText || null),
      informativeHint,
      surroundingText,
      repairMode: classification.repairMode,
      targetTag: classification.targetTag,
      unsafeReason: classification.unsafeReason,
      parentTagPath: classification.parentTagPath,
      pageImageCount: page?.imageCount || 0,
      textDensityHint,
      imageEvidence: 'strong' as const,
      containsText: figure.childFigureCount ? true : undefined,
      splitGenerated: !!figure.splitGenerated,
      splitSourceRef: figure.splitSourceRef || null,
      splitSourceTag: figure.splitSourceTag || null,
    }
    })
  const explicitImageStructNodes = (structure.imageStructNodes || []).filter(node => !node.hasText).map((node, index) => {
    const qpdfImage = qpdfImageByRef.get(node.ref)
    const page = imagePages[index] || pages[index] || null
    const surroundingText = page?.textLines.slice(0, 4).map(line => line.text) || []
    const textDensityHint = surroundingText.length <= 1 ? 'low' as const : surroundingText.length <= 3 ? 'medium' as const : 'high' as const
    const evidence = (page?.imageCount || 0) > 0 ? 'strong' as const : 'vector' as const
    const classification = classifyFigureTarget(node.ref, page?.imageCount || 0, surroundingText, textDensityHint, evidence, surroundingText.length > 0 ? 'informative' as const : 'unknown' as const, false, null, false)
    return {
      id: `figure:image-node:${index + 1}`,
      pageNumber: page?.pageNumber || 1,
      targetRef: node.ref,
      bbox: page ? { x: 0, y: 0, width: 1, height: 1 } : null,
      imageKey: qpdfImage?.contentFingerprint || qpdfImage?.canonicalRef || node.ref,
      imageCanonicalRef: qpdfImage?.canonicalRef || node.ref,
      imageContentFingerprint: qpdfImage?.contentFingerprint || null,
      placementPageNumbers: qpdfImage?.placementPageNumbers || (page?.pageNumber ? [page.pageNumber] : []),
      placementCount: qpdfImage?.placementCount || 1,
      hasAlt: node.hasAlt,
      altText: node.altText || null,
      hasLowQualityAlt: node.hasAlt && hasLowQualityFigureAltText(node.altText || null),
      informativeHint: surroundingText.length > 0 ? 'informative' as const : 'unknown' as const,
      surroundingText,
      repairMode: classification.repairMode,
      targetTag: classification.targetTag,
      unsafeReason: classification.unsafeReason,
      parentTagPath: classification.parentTagPath,
      pageImageCount: page?.imageCount || 0,
      textDensityHint,
      imageEvidence: evidence,
      containsText: !!node.hasText,
    }
  })
  const explicitRefs = new Set([...explicitFigures, ...explicitImageStructNodes].map(candidate => candidate.targetRef).filter(Boolean))
  for (const ref of nestedFigureContainerRefs) explicitRefs.add(ref)

  const fallbackFigures = qpdf.images
    .map((image, index) => ({ image, index }))
    .filter(({ image }) => !!image.ref && !explicitRefs.has(image.ref) && !nestedFigureContainerRefs.has(image.ref))
    .map(({ image, index }) => {
      const page = pages.find(candidate => candidate.pageNumber === image.pageNumber)
        || imagePages.find(candidate => candidate.pageNumber === image.pageNumber)
        || imagePages[index]
        || pages[index]
        || null
      const imageFallback = image.ref || null
      const surroundingText = page?.textLines.slice(0, 4).map(line => line.text) || []
      const textDensityHint = surroundingText.length <= 1 ? 'low' as const : surroundingText.length <= 3 ? 'medium' as const : 'high' as const
      const structuralFallback = imageFallback && structuralByRef.has(imageFallback)
        ? structuralByRef.get(imageFallback)!
        : structure.structuralNodes
          .filter(node => [...SAFE_FIGURE_TAGS, '/Figure', '/TD', '/TOCI'].includes(node.tag as any))
          [index] || null
      const targetRef = structuralFallback?.ref || imageFallback || null
      const imageEvidence = structuralFallback?.tag && !image.ref
        ? 'vector' as const
        : (structuralFallback || image.ref ? 'strong' as const : 'weak' as const)
      const classification = classifyFigureTarget(targetRef, page?.imageCount || 0, surroundingText, textDensityHint, imageEvidence, surroundingText.length ? 'informative' as const : 'unknown' as const)
      return {
        id: `figure:${explicitFigures.length + index + 1}`,
        pageNumber: page?.pageNumber || 1,
        targetRef,
        bbox: page ? { x: 0, y: 0, width: 1, height: 1 } : null,
        imageKey: image.contentFingerprint || image.canonicalRef || image.ref,
        imageCanonicalRef: image.canonicalRef || image.ref,
        imageContentFingerprint: image.contentFingerprint || null,
        placementPageNumbers: image.placementPageNumbers || (page?.pageNumber ? [page.pageNumber] : []),
        placementCount: image.placementCount || 1,
        hasAlt: image.hasAlt,
        altText: image.altText || null,
        informativeHint: surroundingText.length ? 'informative' as const : 'unknown' as const,
        surroundingText,
        repairMode: classification.repairMode,
        targetTag: classification.targetTag,
        unsafeReason: classification.unsafeReason,
        parentTagPath: classification.parentTagPath,
        pageImageCount: page?.imageCount || 0,
        textDensityHint,
        imageEvidence,
      }
    })

  if (explicitFigures.length || explicitImageStructNodes.length || fallbackFigures.length) {
    return [...explicitFigures, ...explicitImageStructNodes, ...fallbackFigures]
  }

  return imagePages.map((page, index) => {
    const imageFallback = qpdf.images.find(image => image.pageNumber === page.pageNumber)?.ref
      || qpdf.images[index]?.ref
      || null
    const structuralFallback = imageFallback && structuralByRef.has(imageFallback)
      ? structuralByRef.get(imageFallback)!
      : structure.structuralNodes
        .filter(node => [...SAFE_FIGURE_TAGS, '/Figure', '/TD', '/TOCI'].includes(node.tag as any))
        [index] || null
    const targetRef = structuralFallback?.ref || imageFallback || null
    const surroundingText = page.textLines.slice(0, 4).map(line => line.text)
    const textDensityHint = surroundingText.length <= 1 ? 'low' as const : surroundingText.length <= 3 ? 'medium' as const : 'high' as const
    const imageEvidence = structuralFallback?.tag && !imageFallback
      ? 'vector' as const
      : (structuralFallback ? 'strong' as const : 'weak' as const)
    const classification = classifyFigureTarget(targetRef, page.imageCount, surroundingText, textDensityHint, imageEvidence, page.textLines.length ? 'informative' as const : 'unknown' as const)
    return {
      id: `figure:${index + 1}`,
      pageNumber: page.pageNumber,
      targetRef,
      bbox: { x: 0, y: 0, width: 1, height: 1 },
      imageKey: qpdf.images.find(image => image.pageNumber === page.pageNumber)?.contentFingerprint
        || qpdf.images.find(image => image.pageNumber === page.pageNumber)?.canonicalRef
        || imageFallback
        || targetRef,
      imageCanonicalRef: qpdf.images.find(image => image.pageNumber === page.pageNumber)?.canonicalRef || imageFallback || targetRef,
      imageContentFingerprint: qpdf.images.find(image => image.pageNumber === page.pageNumber)?.contentFingerprint || null,
      placementPageNumbers: qpdf.images.find(image => image.pageNumber === page.pageNumber)?.placementPageNumbers || [page.pageNumber],
      placementCount: qpdf.images.find(image => image.pageNumber === page.pageNumber)?.placementCount || 1,
      hasAlt: !!figureByRef.get(targetRef || '')?.hasAlt,
      altText: figureByRef.get(targetRef || '')?.altText || null,
      hasLowQualityAlt: !!figureByRef.get(targetRef || '')?.hasAlt && hasLowQualityFigureAltText(figureByRef.get(targetRef || '')?.altText || null),
      informativeHint: page.textLines.length ? 'informative' as const : 'unknown' as const,
      surroundingText,
      repairMode: classification.repairMode,
      targetTag: classification.targetTag,
      unsafeReason: classification.unsafeReason,
      parentTagPath: classification.parentTagPath,
      pageImageCount: page.imageCount,
      textDensityHint,
      imageEvidence,
    }
  })
}

function buildReadingOrderCandidates(structure: StructureBackendMutationResult): ReadingOrderCandidate[] {
  const source = structure.readingOrderNodes.length > 1
    ? structure.readingOrderNodes
    : structure.structuralNodes.filter(node => !!node.parentRef)
  return source.map(node => ({
    id: `order:${node.ref}`,
    ref: node.ref,
    tag: node.tag,
    parentRef: node.parentRef || null,
    orderIndex: node.orderIndex,
  }))
}

function buildReadingOrderParentCandidates(
  structure: StructureBackendMutationResult,
  candidates: ReadingOrderCandidate[],
): ReadingOrderParentCandidate[] {
  const candidateByRef = new Map(candidates.map(candidate => [candidate.ref, candidate]))
  return structure.readingOrderParents
    .map(parent => {
      const childCandidateIds = parent.childRefs
        .map(ref => candidateByRef.get(ref)?.id)
        .filter(Boolean) as string[]
      const suggestedChildCandidateIds = parent.suggestedChildRefs
        .map(ref => candidateByRef.get(ref)?.id)
        .filter(Boolean) as string[]
      return {
        id: `order-parent:${parent.parentRef}`,
        parentRef: parent.parentRef,
        childCandidateIds,
        mutableKids: parent.mutableKids,
        mcidDisorderBefore: parent.mcidDisorderBefore,
        pageNumberHints: parent.pageNumberHints,
        tagMix: parent.childTags,
        suggestedChildCandidateIds,
      }
    })
    .filter(parent => parent.childCandidateIds.length > 1)
}

function suggestLinkText(url: string): string {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`)
    const host = parsed.hostname.replace(/^www\./, '')
    const hostLabel = host.split('.').slice(0, -1).join('.') || host
    const pathSegment = parsed.pathname.split('/').filter(Boolean).pop() || ''
    if (/github/i.test(hostLabel)) return 'GitHub profile'
    if (/linkedin/i.test(hostLabel)) return 'LinkedIn profile'
    if (pathSegment) return `${hostLabel} resource`
    return `${hostLabel} link`
  } catch {
    return 'Related link'
  }
}

function buildLinkCandidates(pages: RemediationPageFact[]): LinkCandidate[] {
  const candidates: LinkCandidate[] = []
  for (const page of pages) {
    for (const link of page.links) {
      const rawUrl = isRawUrl(link.text)
      candidates.push({
        id: `link:${page.pageNumber}:${candidates.length + 1}`,
        pageNumber: page.pageNumber,
        url: link.url,
        text: link.text,
        bbox: link.bbox,
        annotationIndex: link.annotationIndex,
        annotationContents: link.contents || null,
        rawUrl,
        suggestedText: rawUrl ? suggestLinkText(link.url) : null,
      })
    }
  }
  return candidates
}

function buildTableCandidates(
  pages: RemediationPageFact[],
  structure: StructureBackendMutationResult,
): TableCandidate[] {
  return structure.tables.map((table, index) => {
    const pageHints = Array.isArray(table.pageNumberHints)
      ? table.pageNumberHints.filter(pageNumber => Number.isFinite(pageNumber))
      : []
    const page = pageHints.length
      ? pages.find(entry => entry.pageNumber === pageHints[0]) || null
      : null
    const nearbyContext = page?.textLines.slice(0, 8).map(line => line.text).filter(Boolean) || []
    const hasHeaders = table.headerCellRefs.length > 0
    const canUseBackendRowRecovery = !!table.ref && !hasHeaders
    const hasTargets = table.firstRowCellRefs.length > 0 || canUseBackendRowRecovery
    return {
      id: `table:${index + 1}`,
      ref: table.ref,
      pageNumberHints: pageHints,
      firstRowCellRefs: table.firstRowCellRefs,
      headerCellRefs: table.headerCellRefs,
      hasHeaders,
      repairMode: hasTargets ? 'safe' : 'defer',
      nearbyContext,
      unsafeReason: hasTargets
        ? undefined
        : 'Table candidate does not expose first-row cells that can be safely promoted to headers.',
    }
  })
}

async function buildRemediationPageFacts(buffer: Buffer): Promise<RemediationPageFact[]> {
  buildRemediationPageFactsCallCount += 1
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdfLibDoc = await PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: true })
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    verbosity: 0,
  }).promise

  const OPS = pdfjsLib.OPS as Record<string, number>
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintImageXObjectRepeat].filter(value => value !== undefined))
  const pages: RemediationPageFact[] = []

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const textContent = await page.getTextContent()
      const annotations = await page.getAnnotations().catch(() => [])
      const pdfLibPage = pdfLibDoc.getPage(pageNumber - 1)
      const rawAnnots = pdfLibPage.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
      const linkContentsByOrdinal: Array<string | null> = []
      if (rawAnnots) {
        for (let rawIndex = 0; rawIndex < rawAnnots.size(); rawIndex++) {
          const annot = pdfLibDoc.context.lookup(rawAnnots.get(rawIndex), PDFDict)
          if (!annot || String(annot.get(PDFName.of('Subtype'))) !== '/Link') continue
          const rawContents = annot.get(PDFName.of('Contents'))
          let contents: string | null = null
          if (rawContents && typeof (rawContents as { decodeText?: unknown }).decodeText === 'function') {
            contents = (rawContents as PDFHexString | PDFString).decodeText()
          } else if (rawContents) {
            const text = String(rawContents)
            contents = text && text !== 'undefined' ? text : null
          }
          linkContentsByOrdinal.push(contents && contents.trim() ? contents : null)
        }
      }
      const links = annotations
        .filter((annotation: any) => annotation?.subtype === 'Link' && Array.isArray(annotation?.rect) && annotation.rect.length === 4)
        .map((annotation: any, annotationIndex: number) => {
          const [x1, y1, x2, y2] = annotation.rect
          const linkTarget = String(annotation.url || annotation.unsafeUrl || annotation.dest || annotation.action || `#page-${pageNumber}-link-${annotationIndex + 1}`)
          const pdfJsContents = typeof annotation.contents === 'string' ? annotation.contents : null
          const rawContents = linkContentsByOrdinal[annotationIndex] || null
          return {
            url: linkTarget,
            text: findLinkTextFromRect(annotation, textContent.items as any[]) || linkTarget,
            bbox: toNormalizedBbox(
              Math.min(x1, x2),
              Math.min(y1, y2),
              Math.abs(x2 - x1),
              Math.abs(y2 - y1),
              viewport.width,
              viewport.height,
            ),
            annotationIndex,
            contents: pdfJsContents && pdfJsContents.trim() ? pdfJsContents : rawContents,
          }
        })
      const ops = await page.getOperatorList()
      const imageCount = ops.fnArray.filter((fn: number) => imageOps.has(fn)).length

      pages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        imageCount,
        textLines: extractTextLines(textContent, viewport.width, viewport.height),
        links,
      })
    }
  } finally {
    await doc.destroy()
  }

  return pages
}

export async function inspectPdfForRemediation(
  buffer: Buffer,
  analysis: AnalysisResult,
  options: RemediationInspectOptions = {},
): Promise<PdfRemediationContext> {
  const startedAt = Date.now()
  const inspectMode = options.inspectMode || (needsAltTextDeepInspection(analysis) ? 'alt_text_deep' : 'light')
  const bufferSha256 = getBufferSha256(buffer)
  const cacheKey = inspectionCacheKey(bufferSha256, inspectMode)
  const perRunCache = options.cache
  let cacheHit: 'none' | 'per_run' | 'process' = 'none'
  if (perRunCache) {
    if (perRunCache.bufferSha256 !== bufferSha256) {
      perRunCache.bufferSha256 = bufferSha256
      perRunCache.contextsByMode = {}
    }
    const cachedContext = perRunCache.contextsByMode?.[inspectMode]
    if (cachedContext) {
      cacheHit = 'per_run'
      console.log(JSON.stringify({
        scope: 'pdf_inspection_timing',
        filename: analysis.filename,
        inspectMode,
        cacheHit,
        totalMs: Date.now() - startedAt,
      }))
      return toInspectionContext(analysis, cachedContext)
    }
  }

  const cachedPayload = inspectionResultCache.get(cacheKey)
  if (cachedPayload) {
    cacheHit = 'process'
    perRunCache && (perRunCache.contextsByMode = {
      ...(perRunCache.contextsByMode || {}),
      [inspectMode]: cachedPayload,
    })
    if (perRunCache) {
      perRunCache.qpdf = cachedPayload.qpdf
      perRunCache.pdfjs = cachedPayload.pdfjs
      setCachedPagesForHash(perRunCache, bufferSha256, cachedPayload.pages)
    }
    console.log(JSON.stringify({
      scope: 'pdf_inspection_timing',
      filename: analysis.filename,
      inspectMode,
      cacheHit,
      totalMs: Date.now() - startedAt,
    }))
    return toInspectionContext(analysis, cachedPayload)
  }

  const qpdfPromise = options.cache?.qpdf ? Promise.resolve(options.cache.qpdf) : analyzeWithQpdf(buffer)
  const pdfjsPromise = options.cache?.pdfjs ? Promise.resolve(options.cache.pdfjs) : analyzeWithPdfjs(buffer)
  const cachedPages = getCachedPagesForHash(options.cache, bufferSha256)
  const pagesPromise = cachedPages ? Promise.resolve(cachedPages) : buildRemediationPageFacts(buffer)
  const [qpdf, pdfjs, initialStructure, pages] = await Promise.all([
    qpdfPromise,
    pdfjsPromise,
    runPdfStructureBackend({ buffer, mutation: { operation: 'inspect', inspectMode } }),
    pagesPromise,
  ])
  const structure = inspectMode === 'alt_text_deep' && initialStructure.status === 'failed'
    ? await runPdfStructureBackend({ buffer, mutation: { operation: 'inspect', inspectMode: 'light' } })
    : initialStructure
  const effectiveInspectMode = inspectMode === 'alt_text_deep' && initialStructure.status === 'failed'
    ? 'light'
    : inspectMode

  const payload = toInspectionPayload({ qpdf, pdfjs, pages, structure })

  if (perRunCache) {
    perRunCache.bufferSha256 = bufferSha256
      perRunCache.contextsByMode = {
        ...(perRunCache.contextsByMode || {}),
        [effectiveInspectMode]: payload,
      }
      perRunCache.qpdf = qpdf
      perRunCache.pdfjs = pdfjs
      setCachedPagesForHash(perRunCache, bufferSha256, pages)
    }
  setCachedInspectionPayload(inspectionCacheKey(bufferSha256, effectiveInspectMode), payload)

  console.log(JSON.stringify({
    scope: 'pdf_inspection_timing',
    filename: analysis.filename,
    inspectMode: effectiveInspectMode,
    cacheHit,
    totalMs: Date.now() - startedAt,
  }))

  return toInspectionContext(analysis, payload)
}

export function buildRemediationContextFromSnapshot(input: {
  analysis: AnalysisResult
  qpdf: QpdfResult
  pdfjs: PdfjsResult
  pages: RemediationPageFact[]
  structure: StructureBackendMutationResult
  inspectMode?: RemediationInspectMode
  cache?: RemediationInspectionCache
}): PdfRemediationContext {
  const payload = toInspectionPayload({
    qpdf: input.qpdf,
    pdfjs: input.pdfjs,
    pages: input.pages,
    structure: input.structure,
  })

  if (input.cache) {
    if (!input.cache.contextsByMode) input.cache.contextsByMode = {}
    if (input.inspectMode) {
      input.cache.contextsByMode[input.inspectMode] = payload
    }
    input.cache.qpdf = input.qpdf
    input.cache.pdfjs = input.pdfjs
    input.cache.pages = input.pages
  }

  return toInspectionContext(input.analysis, payload)
}

function uniqueFlag(next: ModelReviewFlag, flags: ModelReviewFlag[]): ModelReviewFlag[] {
  if (flags.some(flag => flag.code === next.code && flag.pageNumber === next.pageNumber)) {
    return flags
  }
  return [...flags, next]
}

function unsupportedFlagForTool(tool: string): ModelReviewFlag | null {
  const mappings: Record<string, ModelReviewFlag> = {
    create_bookmark: {
      code: 'bookmark_tool_unsupported',
      label: 'Bookmark repair requires manual review',
      severity: 'warning',
      details: 'Bookmark creation is planned, but the current PDF mutation backend cannot safely write outline trees yet.',
    },
    update_link_visible_text: {
      code: 'link_text_visual_edit_required',
      label: 'Link text requires manual review',
      severity: 'warning',
      details: 'Changing visible link text requires page-content editing that is not safely implemented in this version.',
    },
    set_form_field_label: {
      code: 'form_label_backend_unsupported',
      label: 'Form labels require manual review',
      severity: 'warning',
      details: 'Form field label writing is not supported by the current mutation backend.',
    },
    set_form_field_tooltip: {
      code: 'form_tooltip_backend_unsupported',
      label: 'Form labels require manual review',
      severity: 'warning',
      details: 'Form field tooltip writing is not supported by the current mutation backend.',
    },
    mark_content_artifact: {
      code: 'artifact_backend_unsupported',
      label: 'Artifact tagging requires manual review',
      severity: 'warning',
      details: 'Artifact tagging is not yet supported by the current backend.',
    },
  }

  return mappings[tool] || null
}

function isSafeRetagWarning(warning: string | undefined): boolean {
  if (!warning) return false
  return /has tag (\/P|\/Span|\/Div|\/NonStruct|\/TextBox|\/LI) and is not an existing \/Figure/i.test(warning)
    || /^unsafe_ancestry:/i.test(warning)
}

async function setTitle(buffer: Buffer, title: string): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: true })
  pdfDoc.setTitle(title, { showInWindowTitleBar: true })
  const viewerPreferences = pdfDoc.catalog.lookup(PDFName.of('ViewerPreferences'), PDFDict) || pdfDoc.context.obj({})
  viewerPreferences.set(PDFName.of('DisplayDocTitle'), PDFBool.True)
  pdfDoc.catalog.set(PDFName.of('ViewerPreferences'), viewerPreferences)
  const infoRef = pdfDoc.context.trailerInfo.Info
  const info = infoRef ? pdfDoc.context.lookup(infoRef, PDFDict) : pdfDoc.context.obj({})
  info.set(PDFName.of('Title'), PDFHexString.fromText(title))
  if (!infoRef) {
    pdfDoc.context.trailerInfo.Info = pdfDoc.context.register(info)
  }
  return Buffer.from(await pdfDoc.save())
}

async function setLanguage(buffer: Buffer, language: string): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: true })
  const normalized = normalizeLanguageTag(language) || language.trim()
  pdfDoc.setLanguage(normalized)
  pdfDoc.catalog.set(PDFName.of('Lang'), PDFString.of(normalized))
  return Buffer.from(await pdfDoc.save())
}

async function normalizeDocumentMetadata(
  buffer: Buffer,
  input: { title: string; language: string },
): Promise<{ buffer: Buffer; warnings: string[]; changed: boolean }> {
  let nextBuffer = buffer
  if (input.title.trim()) {
    nextBuffer = await setTitle(nextBuffer, input.title.trim())
  }
  if (input.language.trim()) {
    nextBuffer = await setLanguage(nextBuffer, input.language.trim())
  }
  const result = await runPdfStructureBackend({
    buffer: nextBuffer,
    mutation: {
      operation: 'set_pdfua_identification',
      title: input.title.trim() || 'Accessible PDF',
      language: normalizeLanguageTag(input.language) || input.language.trim() || 'en',
      part: 1,
      conformance: 'B',
    },
  })
  return {
    buffer: result.outputBuffer || nextBuffer,
    warnings: result.warnings,
    changed: result.status === 'applied' || !nextBuffer.equals(buffer),
  }
}

async function setPageTabs(buffer: Buffer, pageNumbers: number[]): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: true })
  const uniquePages = [...new Set(pageNumbers.filter(pageNumber => Number.isFinite(pageNumber) && pageNumber >= 1))]
  for (const pageNumber of uniquePages) {
    const page = pdfDoc.getPage(pageNumber - 1)
    page.node.set(PDFName.of('Tabs'), PDFName.of('S'))
  }
  return Buffer.from(await pdfDoc.save())
}

function annotationMatchesCandidate(
  annot: PDFDict,
  candidate: LinkCandidate,
  page: { getWidth(): number; getHeight(): number },
  linkAnnotationIndex: number,
): boolean {
  const subtype = annot.get(PDFName.of('Subtype'))
  if (String(subtype) !== '/Link') return false
  if (linkAnnotationIndex === candidate.annotationIndex) return true
  const rectArray = annot.lookup(PDFName.of('Rect'), PDFArray)
  if (!rectArray || rectArray.size() !== 4) return false
  const values = [0, 1, 2, 3].map(position => Number(rectArray.get(position)))
  return rectMatches(candidate.bbox, values, page.getWidth(), page.getHeight())
}

async function setLinkAnnotationContents(buffer: Buffer, candidate: LinkCandidate, contents: string): Promise<Buffer> {
  const result = await runPdfStructureBackend({
    buffer,
    mutation: {
      operation: 'set_link_annotation_contents',
      pageNumber: candidate.pageNumber,
      annotationIndex: candidate.annotationIndex,
      contents,
    },
  })
  return result.outputBuffer || buffer
}

function absoluteRect(page: { getWidth(): number; getHeight(): number }, bbox: BoundingBox) {
  const width = page.getWidth()
  const height = page.getHeight()
  return {
    x: bbox.x * width,
    y: bbox.y * height,
    width: bbox.width * width,
    height: bbox.height * height,
  }
}

function rectMatches(normalized: BoundingBox, rect: number[], pageWidth: number, pageHeight: number): boolean {
  const [x1, y1, x2, y2] = rect
  const actual = {
    x: Math.min(x1, x2) / pageWidth,
    y: Math.min(y1, y2) / pageHeight,
    width: Math.abs(x2 - x1) / pageWidth,
    height: Math.abs(y2 - y1) / pageHeight,
  }
  return Math.abs(actual.x - normalized.x) < 0.03 &&
    Math.abs(actual.y - normalized.y) < 0.03 &&
    Math.abs(actual.width - normalized.width) < 0.06 &&
    Math.abs(actual.height - normalized.height) < 0.06
}

async function rewriteLinkVisibleText(buffer: Buffer, candidate: LinkCandidate, replacementText: string): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: true })
  const page = pdfDoc.getPage(candidate.pageNumber - 1)
  pdfDoc.registerFontkit(fontkit)
  const fontBytes = await loadRewriteFontBytes()
  if (!fontBytes) return buffer
  const font = await pdfDoc.embedFont(fontBytes, { subset: true })
  const rect = absoluteRect(page, candidate.bbox)

  page.drawRectangle({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height + 2,
    color: rgb(1, 1, 1),
  })
  page.drawText(replacementText, {
    x: rect.x,
    y: rect.y + Math.max(0, rect.height - 10),
    font,
    size: Math.max(10, Math.min(12, rect.height + 2)),
    color: rgb(0, 0, 0.8),
  })

  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
  if (annots) {
    for (let index = 0; index < annots.size(); index++) {
      const annotRef = annots.get(index)
      const annot = pdfDoc.context.lookup(annotRef) as PDFDict | undefined
      if (!annot) continue
      const subtype = annot.get(PDFName.of('Subtype'))
      if (String(subtype) !== '/Link') continue
      const rectArray = annot.lookup(PDFName.of('Rect'), PDFArray)
      if (!rectArray || rectArray.size() !== 4) continue
      const values = [0, 1, 2, 3].map(position => Number(rectArray.get(position)))
      if (!rectMatches(candidate.bbox, values, page.getWidth(), page.getHeight())) continue
      annot.set(PDFName.of('Contents'), PDFHexString.fromText(replacementText))
    }
  }

  return Buffer.from(await pdfDoc.save())
}

function deferredAction(
  baseAction: Omit<RemediationActionRecord, 'outcome'>,
  details: string,
  categoryTargets: string[],
  code: string,
  label: string,
): {
  action: RemediationActionRecord
  manualReviewFlags: ModelReviewFlag[]
} {
  return {
    action: {
      ...baseAction,
      details,
      autoApplied: false,
      categoryTargets,
      changedDocumentBytes: false,
      outcome: 'deferred',
    },
    manualReviewFlags: [{
      code,
      label,
      severity: 'warning',
      details,
    }],
  }
}

function structureResultToAction(input: {
  baseAction: Omit<RemediationActionRecord, 'outcome'>
  result: StructureBackendMutationResult
  categoryTargets: string[]
}): {
  action: RemediationActionRecord
  buffer?: Buffer
  manualReviewFlags: ModelReviewFlag[]
  operationResult: StructureBackendMutationResult
} {
  const condensedWarnings = Array.from(new Set(input.result.warnings.map(warning => warning.trim()).filter(Boolean)))
  const details = input.result.appliedMutations.length
    ? input.result.appliedMutations.map(mutationEntry => mutationEntry.details).join(' ')
    : condensedWarnings[0] || input.baseAction.details
  const fontSummary = input.result.fontOperationSummary
  const figureSummary = input.result.figureOperationSummary
  const fontSummaryText = fontSummary
    ? [
        fontSummary.embeddedFontProgramsAdded ? `embedded ${fontSummary.embeddedFontProgramsAdded} font program(s)` : null,
        fontSummary.toUnicodeMapsAdded ? `added ${fontSummary.toUnicodeMapsAdded} ToUnicode map(s)` : null,
        fontSummary.cidSetStreamsRebuilt ? `rebuilt ${fontSummary.cidSetStreamsRebuilt} CIDSet stream(s)` : null,
        fontSummary.substituteFontsApplied ? `applied ${fontSummary.substituteFontsApplied} substitute font(s)` : null,
        fontSummary.widthFixesApplied ? `normalized ${fontSummary.widthFixesApplied} width fix(es)` : null,
      ].filter(Boolean).join(', ')
    : ''
  const figureSummaryText = figureSummary
    ? [
        figureSummary.figureNodesRetagged ? `retagged ${figureSummary.figureNodesRetagged} figure node(s)` : null,
        figureSummary.figureAltPreserved ? `preserved ${figureSummary.figureAltPreserved} existing alt text value(s)` : null,
        figureSummary.figureAltPlaceholdersCreated ? `created ${figureSummary.figureAltPlaceholdersCreated} empty alt placeholder(s)` : null,
        figureSummary.graphicsOnlyOwnersPromoted ? `promoted ${figureSummary.graphicsOnlyOwnersPromoted} graphics-only owner(s)` : null,
      ].filter(Boolean).join(', ')
    : ''
  const detailedSummary = [
    details,
    fontSummaryText ? `Font operation summary: ${fontSummaryText}.` : null,
    figureSummaryText ? `Figure operation summary: ${figureSummaryText}.` : null,
  ].filter(Boolean).join(' ')

  if (input.result.status === 'applied' && input.result.outputBuffer) {
    return {
      buffer: input.result.outputBuffer,
      action: {
        ...input.baseAction,
        before: input.result.appliedMutations.map(entry => `${entry.ref}:${entry.before || ''}`).join(', ') || null,
        after: input.result.appliedMutations.map(entry => `${entry.ref}:${entry.after || ''}`).join(', ') || null,
        details: detailedSummary,
        categoryTargets: input.categoryTargets,
        changedDocumentBytes: true,
        validationWarnings: condensedWarnings,
        outcome: 'applied',
      },
      manualReviewFlags: [],
      operationResult: input.result,
    }
  }

  const outcome = input.result.status === 'no_effect' ? 'no_effect' : input.result.status === 'unsupported' ? 'unsupported' : 'failed'
  return {
    action: {
      ...input.baseAction,
      details: detailedSummary,
      autoApplied: false,
      categoryTargets: input.categoryTargets,
      changedDocumentBytes: false,
      validationWarnings: condensedWarnings,
      outcome,
    },
    manualReviewFlags: condensedWarnings.map((warning, index) => ({
      code: `${input.baseAction.tool}_${outcome}_${index + 1}`,
      label: 'Manual review required',
      severity: 'warning' as const,
      details: warning,
    })),
    operationResult: input.result,
  }
}

export async function executeRemediationTool(input: {
  buffer: Buffer
  context: PdfRemediationContext
  call: RemediationToolCall
}): Promise<{
  buffer: Buffer
  action: RemediationActionRecord
  manualReviewFlags: ModelReviewFlag[]
  operationResult?: StructureBackendMutationResult
}> {
  const { buffer, context, call } = input
  const args = call.arguments || {}
  const target = typeof args.target === 'string'
    ? args.target
    : typeof args.pageNumber === 'number'
      ? `page ${args.pageNumber}`
      : 'document'
  const baseAction = {
    tool: call.tool_name,
    target,
    candidateId: typeof args.candidateId === 'string' ? args.candidateId : undefined,
    candidateGroupId: typeof args.candidateGroupId === 'string' ? args.candidateGroupId : undefined,
    details: call.rationale || `${call.tool_name} executed.`,
    confidence: Math.max(0, Math.min(1, Number(call.confidence) || 0.5)),
    autoApplied: true,
    changedVisibleContent: ['update_link_visible_text', 'rewrite_link_visible_text'].includes(call.tool_name),
    generationSource: args.generationSource === 'semantic_ai' || args.generationSource === 'heuristic_fallback' || args.generationSource === 'manual_deferred'
      ? args.generationSource
      : undefined,
    categoryTargets: [],
    changedDocumentBytes: false,
  } satisfies Omit<RemediationActionRecord, 'outcome'>

  switch (call.tool_name) {
    case 'get_document_metadata':
    case 'adobe_accessibility_check':
    case 'list_bookmarks':
    case 'list_links':
    case 'list_figures':
    case 'list_form_fields':
    case 'inspect_tag_tree':
    case 'list_heading_candidates':
    case 'list_table_candidates':
    case 'inspect_reading_order':
    case 'save_working_pdf':
      return {
        buffer,
        action: {
          ...baseAction,
          details: baseAction.details || `Inspected ${target}.`,
          autoApplied: false,
          changedVisibleContent: false,
          outcome: 'inspection',
        },
        manualReviewFlags: [],
      }
    case 'adobe_auto_tag': {
      if (!REMEDIATION.ENABLE_ADOBE_API) {
        return {
          buffer,
          action: { ...baseAction, details: 'Adobe API disabled.', changedVisibleContent: false, changedDocumentBytes: false, outcome: 'deferred' },
          manualReviewFlags: [],
        }
      }
      const reviewAssetsDir = typeof args.reviewAssetsDir === 'string' ? args.reviewAssetsDir : undefined
      const autoTag = await runAdobeAutoTag({
        buffer,
        filename: typeof args.filename === 'string' ? args.filename : 'document.pdf',
        artifactsDir: reviewAssetsDir,
        generateReport: true,
      })
      return {
        buffer: autoTag.outputPdf || buffer,
        action: {
          ...baseAction,
          before: 'native remediation path',
          after: autoTag.outputPdf ? 'adobe auto-tag path' : 'native remediation path',
          details: autoTag.summary,
          changedVisibleContent: false,
          changedDocumentBytes: !!autoTag.outputPdf,
          categoryTargets: ['heading_structure', 'alt_text', 'reading_order'],
          validationWarnings: autoTag.warnings,
          outcome: autoTag.outputPdf ? 'applied' : (autoTag.status === 'unavailable' ? 'deferred' : 'no_effect'),
        },
        manualReviewFlags: autoTag.status === 'unavailable'
          ? [{
              code: 'adobe_autotag_unavailable',
              label: 'Adobe Auto-Tag unavailable',
              severity: 'warning',
              details: autoTag.summary,
            }]
          : [],
      }
    }
    case 'set_document_title': {
      const nextTitle = String(args.title || '').trim()
      if (!nextTitle) {
        return {
          buffer,
          action: {
            ...baseAction,
            details: 'Skipped document title update because no non-empty title was provided.',
            autoApplied: false,
            changedVisibleContent: false,
            outcome: 'skipped',
          },
          manualReviewFlags: [],
        }
      }
      const previousTitle = context.pdfjs.title || null
      if (previousTitle?.trim() === nextTitle) {
        return {
          buffer,
          action: {
            ...baseAction,
            before: previousTitle,
            after: nextTitle,
            details: `Skipped document title update because the title is already "${nextTitle}".`,
            autoApplied: false,
            changedVisibleContent: false,
            changedDocumentBytes: false,
            outcome: 'skipped',
          },
          manualReviewFlags: [],
        }
      }
      const nextBuffer = await setTitle(buffer, nextTitle)
      return {
        buffer: nextBuffer,
        action: {
          ...baseAction,
          before: previousTitle,
          after: nextTitle,
          details: `Updated document title metadata to "${nextTitle}".`,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['title_language'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      }
    }
    case 'set_document_language': {
      const requestedLanguage = String(args.language || '').trim()
      const nextLanguage = normalizeLanguageTag(requestedLanguage) || requestedLanguage
      if (!nextLanguage) {
        return {
          buffer,
          action: {
            ...baseAction,
            details: 'Skipped document language update because no language code was provided.',
            autoApplied: false,
            changedVisibleContent: false,
            outcome: 'skipped',
          },
          manualReviewFlags: [],
        }
      }
      const previousLanguage = context.qpdf.lang || context.pdfjs.lang || null
      if ((previousLanguage?.trim() || '') === nextLanguage) {
        return {
          buffer,
          action: {
            ...baseAction,
            before: previousLanguage,
            after: nextLanguage,
            details: `Skipped document language update because the language is already "${nextLanguage}".`,
            autoApplied: false,
            changedVisibleContent: false,
            changedDocumentBytes: false,
            outcome: 'skipped',
          },
          manualReviewFlags: [],
        }
      }
      const nextBuffer = await setLanguage(buffer, nextLanguage)
      return {
        buffer: nextBuffer,
        action: {
          ...baseAction,
          before: previousLanguage,
          after: nextLanguage,
          details: `Updated document language metadata to "${nextLanguage}".`,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['title_language'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      }
    }
    case 'set_pdfua_identification': {
      const title = String(args.title || context.pdfjs.title || 'Accessible PDF').trim() || 'Accessible PDF'
      const rawLanguage = String(args.language || context.qpdf.lang || context.pdfjs.lang || 'en').trim() || 'en'
      const language = normalizeLanguageTag(rawLanguage) || rawLanguage
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'set_pdfua_identification',
          title,
          language,
          part: Number(args.part) || 1,
          conformance: String(args.conformance || 'B').trim() || 'B',
        },
      })
      const translated = structureResultToAction({ baseAction, result, categoryTargets: ['title_language'] })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
        operationResult: translated.operationResult,
      }
    }
    case 'normalize_document_metadata': {
      const title = String(args.title || context.pdfjs.title || '').trim()
      const rawLanguage = String(args.language || context.qpdf.lang || context.pdfjs.lang || 'en').trim() || 'en'
      const language = normalizeLanguageTag(rawLanguage) || rawLanguage
      const normalized = await normalizeDocumentMetadata(buffer, {
        title: title || 'Accessible PDF',
        language,
      })
      return {
        buffer: normalized.buffer,
        action: {
          ...baseAction,
          before: `${context.pdfjs.title || ''}|${context.qpdf.lang || context.pdfjs.lang || ''}`,
          after: `${title || 'Accessible PDF'}|${language}`,
          details: `Normalized document metadata for title "${title || 'Accessible PDF'}", language "${language}", and PDF/UA identification.`,
          changedDocumentBytes: normalized.changed,
          changedVisibleContent: false,
          categoryTargets: ['title_language'],
          outcome: normalized.changed ? 'applied' : 'no_effect',
          validationWarnings: normalized.warnings,
        },
        manualReviewFlags: [],
      }
    }
    case 'set_page_tabs': {
      const pageNumbers = Array.isArray(args.pageNumbers)
        ? args.pageNumbers.map((value: unknown) => Number(value)).filter(Number.isFinite)
        : (typeof args.pageNumber === 'number' ? [args.pageNumber] : context.pages.filter(page => page.links.length > 0).map(page => page.pageNumber))
      if (!pageNumbers.length) {
        return {
          buffer,
          action: {
            ...baseAction,
            details: 'Skipped page Tabs normalization because no annotated pages were identified.',
            autoApplied: false,
            changedVisibleContent: false,
            outcome: 'skipped',
          },
          manualReviewFlags: [],
        }
      }
      const nextBuffer = await setPageTabs(buffer, pageNumbers)
      return {
        buffer: nextBuffer,
        action: {
          ...baseAction,
          before: null,
          after: pageNumbers.map(pageNumber => `page ${pageNumber} /Tabs /S`).join(', '),
          details: `Set /Tabs /S on ${pageNumbers.length} annotated page${pageNumbers.length === 1 ? '' : 's'}.`,
          changedVisibleContent: false,
          changedDocumentBytes: true,
          categoryTargets: ['link_quality', 'reading_order'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      }
    }
    case 'normalize_annotation_tab_order': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'normalize_annotation_tab_order',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['link_quality', 'reading_order'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'repair_annotation_alt_text': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_annotation_alt_text',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['alt_text', 'link_quality', 'reading_order'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'set_tabs_all_annotated_pages': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'set_tabs_all_annotated_pages',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['link_quality', 'reading_order'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'bootstrap_struct_tree': {
      const headingScore = context.analysis.categories.find(category => category.id === 'heading_structure')?.score ?? null
      const bookmarkScore = context.analysis.categories.find(category => category.id === 'bookmarks')?.score ?? null
      const pdfUaScore = context.analysis.categories.find(category => category.id === 'pdf_ua_compliance')?.score ?? null
      const bootstrapTargetCategoryIds = new Set(['text_extractability', 'heading_structure', 'alt_text', 'reading_order', 'table_markup'])
      const bootstrapTargetDebtRemaining = context.analysis.categories.some(category =>
        bootstrapTargetCategoryIds.has(category.id)
        && typeof category.score === 'number'
        && category.score < 100,
      )
      const hasBlockingLocalFindings = (context.analysis.localStandards?.findings ?? []).some(finding => finding.blocking)
      const headingCandidates = context.headingCandidates.length
        ? context.headingCandidates
        : context.pages.flatMap(page => {
            const fontSizes = page.textLines.map(line => line.fontSize).sort((a, b) => a - b)
            const medianFont = fontSizes.length ? fontSizes[Math.floor(fontSizes.length / 2)] : 12
            return page.textLines
              .filter(line =>
                normalizeHeadingText(line.text).length >= 3 &&
                normalizeHeadingText(line.text).length <= 140 &&
                !isRawUrl(normalizeHeadingText(line.text)) &&
                !normalizeHeadingText(line.text).startsWith('â€¢') &&
                !looksLikeProseHeadingText(normalizeHeadingText(line.text)) &&
                (line.fontWeight === 'bold' || line.fontSize >= medianFont + 1),
              )
              .slice(0, page.pageNumber === 1 ? 3 : 2)
              .map(line => ({
                pageNumber: page.pageNumber,
                text: normalizeHeadingText(line.text),
              }))
          })
      const selectedHeadingCandidates = headingCandidates.slice(0, 6)
      const normalizedHeadingLevels = normalizeHeadingLevels(
        selectedHeadingCandidates.map((candidate, index) => (candidate.pageNumber === 1 && index === 0) ? 'H1' : 'H2'),
      )
      const headings = selectedHeadingCandidates.map((candidate, index) => ({
        text: candidate.text,
        level: normalizedHeadingLevels[index] || 'H2',
        pageNumber: candidate.pageNumber,
      }))
      const figures = context.figureCandidates
        .filter(candidate =>
          (candidate.pageImageCount > 0 || candidate.imageEvidence === 'strong' || candidate.imageEvidence === 'vector')
          && candidate.targetTag !== '/Figure'
          && candidate.informativeHint !== 'decorative'
          && Number.isFinite(candidate.pageNumber)
        )
        .slice(0, 24)
        .map(candidate => ({
          pageNumber: candidate.pageNumber,
          altText: bootstrapFigureAltText(candidate),
        }))
      if (
        context.qpdf.hasStructTree
        && (
          (headingScore === 100 && !bootstrapTargetDebtRemaining)
          || (headingScore === 100 && bookmarkScore === 100 && pdfUaScore === 100 && !hasBlockingLocalFindings)
        )
      ) {
        return {
          buffer,
          action: {
            ...baseAction,
            details: 'Bootstrap target categories are already healthy, so skipping an unnecessary structure bootstrap pass.',
            autoApplied: false,
            categoryTargets: ['text_extractability', 'heading_structure', 'alt_text', 'reading_order', 'table_markup'],
            changedDocumentBytes: false,
            outcome: 'no_effect',
          },
          manualReviewFlags: [],
        }
      }
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'bootstrap_struct_tree',
          headings,
          figures,
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['text_extractability', 'heading_structure', 'alt_text', 'reading_order'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'replace_bookmarks_from_headings': {
      const explicitHeadings = Array.isArray(args.headings)
        ? args.headings
          .map(entry => ({
            text: normalizeBookmarkText(String(entry?.text || '')),
            level: /^H[1-6]$/i.test(String(entry?.level || '')) ? String(entry.level).toUpperCase() : 'H2',
            targetRef: typeof entry?.targetRef === 'string' ? entry.targetRef : undefined,
            pageNumber: Number.isFinite(Number(entry?.pageNumber)) ? Number(entry.pageNumber) : undefined,
          }))
          .filter(entry => entry.text && !looksLikeBookmarkNoise(entry.text) && (entry.targetRef || Number.isFinite(entry.pageNumber)))
        : null
      const headings = explicitHeadings?.length
        ? explicitHeadings
        : cleanedBookmarkHeadings(context.headingCandidates)
      if (!headings.length) {
        const deferred = deferredAction(
          baseAction,
          'Bookmark generation requires usable heading targets with page mapping.',
          ['bookmarks'],
          'bookmark_targets_unavailable',
          'Bookmark repair requires manual review',
        )
        return { buffer, ...deferred }
      }
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'replace_bookmarks_from_headings',
          headings,
        },
      })
      const translated = structureResultToAction({ baseAction, result, categoryTargets: ['bookmarks'] })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'normalize_heading_hierarchy': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'normalize_heading_hierarchy',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['heading_structure', 'pdf_ua_compliance'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'normalize_nested_figure_containers': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'normalize_nested_figure_containers',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['alt_text', 'pdf_ua_compliance', 'reading_order'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'create_heading_tag':
    case 'retag_node':
    case 'set_table_header_cells': {
      const operation = call.tool_name
      const mutation = operation === 'create_heading_tag'
        ? {
          operation,
          targets: Array.isArray(args.targets) ? args.targets : undefined,
          headingLevels: Array.isArray(args.headingLevels) ? args.headingLevels : undefined,
        }
        : operation === 'retag_node'
          ? {
            operation,
            targets: Array.isArray(args.targets) ? args.targets : [],
            targetTag: typeof args.targetTag === 'string' ? args.targetTag : '',
          }
          : {
            operation,
            targets: Array.isArray(args.targets) ? args.targets : undefined,
          }
      const result = await runPdfStructureBackend({ buffer, mutation })
      const categoryTargets = operation === 'set_table_header_cells' ? ['table_markup'] : ['heading_structure']
      const translated = structureResultToAction({ baseAction, result, categoryTargets })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'create_heading_from_candidate': {
      const candidate = context.headingCandidates.find(entry => entry.id === args.candidateId)
      if (!candidate?.targetRef) {
        const deferred = deferredAction(
          baseAction,
          'Heading candidate did not map cleanly to an editable structure element.',
          ['heading_structure'],
          'heading_candidate_unmapped',
          'Heading tagging requires manual review',
        )
        return { buffer, ...deferred }
      }
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'create_heading_from_candidate',
          targetRef: candidate.targetRef,
          level: typeof args.level === 'string' ? args.level : 'H2',
          text: candidate.text,
        },
      })
      const translated = structureResultToAction({ baseAction, result, categoryTargets: ['heading_structure'] })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'set_figure_alt_text':
    case 'retag_as_figure_and_set_alt':
    case 'mark_figure_decorative': {
      const candidate = context.figureCandidates.find(entry => entry.id === args.candidateId)
      if (!candidate?.targetRef) {
        const deferred = deferredAction(
          baseAction,
          'Figure candidate did not map cleanly to an editable structure element.',
          ['alt_text'],
          'figure_candidate_unmapped',
          'Figure alt text requires manual review',
        )
        return { buffer, ...deferred }
      }
      const semanticAiOverrideAllowed = args.generationSource === 'semantic_ai'
        && isSemanticAiEligibleDeferredFigureCandidate(candidate)
      if (candidate.repairMode === 'defer' && !semanticAiOverrideAllowed) {
        const unsafeCode = candidate.unsafeReason?.split(':', 1)[0]?.trim() || 'figure_candidate_unsafe'
        const deferred = deferredAction(
          baseAction,
          candidate.unsafeReason || 'Figure candidate is not safe to retag or annotate automatically.',
          ['alt_text'],
          unsafeCode,
          'Figure alt text requires manual review',
        )
        return { buffer, ...deferred }
      }
      const altText = typeof args.altText === 'string' ? args.altText.trim() : ''
      const needsRetag = candidate.repairMode === 'retag_then_set_alt' || semanticAiOverrideAllowed
      const operation = call.tool_name === 'mark_figure_decorative'
        ? (needsRetag ? 'retag_as_figure_and_set_alt' : 'mark_figure_decorative')
        : (call.tool_name === 'retag_as_figure_and_set_alt' || needsRetag
          ? 'retag_as_figure_and_set_alt'
          : 'set_figure_alt_text')
      let result = await runPdfStructureBackend({
        buffer,
        mutation: operation === 'mark_figure_decorative'
          ? {
              operation: 'mark_figure_decorative',
              targetRef: candidate.targetRef,
            }
          : {
              operation,
              targetRef: candidate.targetRef,
              altText: call.tool_name === 'mark_figure_decorative' ? 'Decorative image' : altText,
              pageImageCount: candidate.pageImageCount,
              textDensityHint: candidate.textDensityHint,
              imageEvidence: candidate.imageEvidence,
            },
      })
      if (
        call.tool_name === 'set_figure_alt_text' &&
        result.status === 'no_effect' &&
        isSafeRetagWarning(result.warnings[0]) &&
        altText
      ) {
        result = await runPdfStructureBackend({
          buffer,
          mutation: {
            operation: 'retag_as_figure_and_set_alt',
            targetRef: candidate.targetRef,
            altText,
            pageImageCount: candidate.pageImageCount,
            textDensityHint: candidate.textDensityHint,
            imageEvidence: candidate.imageEvidence,
          },
        })
      }
      const translated = structureResultToAction({ baseAction, result, categoryTargets: ['alt_text'] })
      return {
        buffer: translated.buffer || buffer,
        action: {
          ...translated.action,
          targetRef: candidate.targetRef,
        },
        manualReviewFlags: translated.manualReviewFlags,
        operationResult: translated.operationResult,
      }
    }
    case 'move_tag_in_reading_order':
    case 'reorder_structure_children': {
      const parentGroup = typeof args.candidateGroupId === 'string'
        ? context.readingOrderParentCandidates.find(entry => entry.id === args.candidateGroupId)
        : null
      if (parentGroup && !parentGroup.mutableKids) {
        const deferred = deferredAction(
          baseAction,
          `Reading-order parent ${parentGroup.parentRef} does not expose a mutable /K array.`,
          ['reading_order'],
          'reading_order_parent_immutable',
          'Reading order requires manual review',
        )
        return { buffer, ...deferred }
      }
      const orderedCandidateIds = parentGroup
        ? parentGroup.suggestedChildCandidateIds
        : Array.isArray(args.orderedCandidateIds)
          ? args.orderedCandidateIds.map((value: unknown) => String(value))
          : []
      const orderedTargets = orderedCandidateIds
        .map(candidateId => context.readingOrderCandidates.find(entry => entry.id === candidateId)?.ref)
        .filter(Boolean) as string[]
      if (orderedTargets.length < 2) {
        const deferred = deferredAction(
          baseAction,
          'Reading-order repair needs at least two concrete structure children to reorder.',
          ['reading_order'],
          'reading_order_targets_missing',
          'Reading order requires manual review',
        )
        return { buffer, ...deferred }
      }
      const parentRef = parentGroup?.parentRef || (typeof args.parentRef === 'string'
        ? args.parentRef
        : context.readingOrderCandidates.find(entry => entry.id === orderedCandidateIds[0])?.parentRef || null)
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'reorder_structure_children',
          parentRef: parentRef || undefined,
          orderedTargets,
          expectedDisorderBefore: parentGroup && Number.isFinite(parentGroup.mcidDisorderBefore)
            ? parentGroup.mcidDisorderBefore
            : undefined,
        },
      })
      const translated = structureResultToAction({ baseAction, result, categoryTargets: ['reading_order'] })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
        operationResult: translated.operationResult,
      }
    }
    case 'rewrite_link_visible_text':
    case 'update_link_visible_text': {
      const candidate = context.linkCandidates.find(entry => entry.id === args.candidateId)
      const replacementText = String(args.replacementText || '').trim()
      if (!candidate || !candidate.rawUrl || !replacementText) {
        const deferred = deferredAction(
          baseAction,
          'Link rewrite requires a raw-URL link candidate and a replacement label.',
          ['link_quality'],
          'link_rewrite_unavailable',
          'Link text requires manual review',
        )
        return { buffer, ...deferred }
      }
      const nextBuffer = await rewriteLinkVisibleText(buffer, candidate, replacementText)
      return {
        buffer: nextBuffer,
        action: {
          ...baseAction,
          before: candidate.text,
          after: replacementText,
          details: `Rewrote raw URL link text to "${replacementText}".`,
          changedDocumentBytes: true,
          changedVisibleContent: true,
          categoryTargets: ['link_quality'],
          outcome: 'applied',
        },
        manualReviewFlags: [],
      }
    }
    case 'set_link_annotation_contents': {
      const candidate = context.linkCandidates.find(entry => entry.id === args.candidateId)
        || context.linkCandidates.find(entry =>
          Number.isFinite(Number(args.pageNumber))
          && Number.isFinite(Number(args.annotationIndex))
          && entry.pageNumber === Number(args.pageNumber)
          && entry.annotationIndex === Number(args.annotationIndex),
        )
      const contents = String(args.contents || args.replacementText || candidate?.suggestedText || candidate?.text || '').trim()
      if (!candidate || !contents) {
        const deferred = deferredAction(
          baseAction,
          'Link annotation content repair requires a concrete link candidate and non-empty alternate description.',
          ['link_quality'],
          'link_annotation_contents_unavailable',
          'Link text requires manual review',
        )
        return { buffer, ...deferred }
      }
      const nextBuffer = await setLinkAnnotationContents(buffer, candidate, contents)
      return {
        buffer: nextBuffer,
        action: {
          ...baseAction,
          before: candidate.annotationContents || null,
          after: contents,
          details: `Set link annotation /Contents to "${contents}".`,
          changedDocumentBytes: nextBuffer !== buffer,
          changedVisibleContent: false,
          categoryTargets: ['link_quality'],
          outcome: nextBuffer === buffer ? 'no_effect' : 'applied',
        },
        manualReviewFlags: [],
      }
    }
    case 'repair_malformed_bdc_operators': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_malformed_bdc_operators',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['text_extractability', 'pdf_ua_compliance'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
        operationResult: translated.operationResult,
      }
    }
    case 'repair_structure_conformance': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_structure_conformance',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['text_extractability', 'heading_structure', 'alt_text', 'link_quality', 'reading_order'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'repair_note_tag_ids': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_note_tag_ids',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['reading_order'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'repair_native_marked_content_refs': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_native_marked_content_refs',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['text_extractability', 'reading_order'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'repair_native_link_structure': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_native_link_structure',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['link_quality', 'reading_order'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'tag_unowned_annotations': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'tag_unowned_annotations',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['reading_order', 'pdf_ua_compliance'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'repair_bootstrapped_chart_content_refs': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_bootstrapped_chart_content_refs',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['text_extractability', 'link_quality', 'reading_order'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'repair_native_figure_semantics': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_native_figure_semantics',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['alt_text'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'repair_other_elements_alt_text': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_other_elements_alt_text',
          maxRepairsPerRun: 64,
          maxElapsedMs: 12_000,
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['alt_text'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'repair_native_table_headers': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_native_table_headers',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['table_markup'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'repair_native_reading_order': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_native_reading_order',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['reading_order'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'repair_cid_symbol_font_maps': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_cid_symbol_font_maps',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['text_extractability', 'title_language'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'repair_font_unicode_maps': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_font_unicode_maps',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['text_extractability', 'title_language'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'repair_type1_font_unicode_maps': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_type1_font_unicode_maps',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['text_extractability', 'title_language'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'repair_truetype_encoding_differences': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_truetype_encoding_differences',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['text_extractability', 'pdf_ua_compliance'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'substitute_legacy_fonts_in_place': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'substitute_legacy_fonts_in_place',
          maxWidthDrift: ANALYSIS.LEGACY_FONT_WIDTH_DRIFT_THRESHOLD,
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['text_extractability', 'title_language'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'finalize_substituted_font_conformance': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'finalize_substituted_font_conformance',
          maxWidthDrift: ANALYSIS.LEGACY_FONT_WIDTH_DRIFT_THRESHOLD,
          reportedWidthFixes: Array.isArray(args.reportedWidthFixes) ? args.reportedWidthFixes : undefined,
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['text_extractability', 'title_language'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'repair_cidset_consistency': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'repair_cidset_consistency',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['text_extractability'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'artifact_nonsemantic_page_elements': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'artifact_nonsemantic_page_elements',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['alt_text', 'reading_order', 'pdf_ua_compliance'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    case 'embed_missing_fonts_in_place': {
      const result = await runPdfStructureBackend({
        buffer,
        mutation: {
          operation: 'embed_missing_fonts_in_place',
        },
      })
      const translated = structureResultToAction({
        baseAction,
        result,
        categoryTargets: ['text_extractability', 'title_language'],
      })
      return {
        buffer: translated.buffer || buffer,
        action: translated.action,
        manualReviewFlags: translated.manualReviewFlags,
      }
    }
    default: {
      const flag = unsupportedFlagForTool(call.tool_name)
      return {
        buffer,
        action: {
          ...baseAction,
          details: flag?.details || `${call.tool_name} is not supported by the current mutation backend.`,
          autoApplied: false,
          changedDocumentBytes: false,
          outcome: 'unsupported',
        },
        manualReviewFlags: flag ? [flag] : [],
      }
    }
  }
}

export function toAppliedChange(action: RemediationActionRecord): AppliedChange | null {
  if (action.outcome !== 'applied') return null
  const typeMap: Record<string, AppliedChange['type']> = {
    ocr_scanned_pdf: 'text_recovery',
    bootstrap_struct_tree: 'structure',
    set_document_title: 'title',
    set_document_language: 'language',
    set_pdfua_identification: 'language',
    normalize_document_metadata: 'language',
    repair_structure_conformance: 'structure',
    repair_malformed_bdc_operators: 'structure',
    repair_note_tag_ids: 'structure',
    repair_native_marked_content_refs: 'structure',
    repair_native_link_structure: 'structure',
    tag_unowned_annotations: 'structure',
    repair_bootstrapped_chart_content_refs: 'structure',
    repair_native_figure_semantics: 'alt_text',
    repair_other_elements_alt_text: 'alt_text',
    repair_native_table_headers: 'table',
    repair_native_reading_order: 'reading_order',
    repair_font_unicode_maps: 'text_recovery',
    repair_type1_font_unicode_maps: 'text_recovery',
    substitute_legacy_fonts_in_place: 'text_recovery',
    finalize_substituted_font_conformance: 'text_recovery',
    repair_cidset_consistency: 'text_recovery',
    set_page_tabs: 'structure',
    normalize_annotation_tab_order: 'reading_order',
    set_tabs_all_annotated_pages: 'reading_order',
    repair_annotation_alt_text: 'alt_text',
    replace_bookmarks_from_headings: 'bookmark',
    normalize_heading_hierarchy: 'structure',
    normalize_nested_figure_containers: 'structure',
    create_bookmark: 'bookmark',
    set_figure_alt_text: 'alt_text',
    retag_as_figure_and_set_alt: 'alt_text',
    mark_figure_decorative: 'artifact',
    set_table_header_cells: 'table',
    move_tag_in_reading_order: 'reading_order',
    reorder_structure_children: 'reading_order',
    create_heading_tag: 'structure',
    create_heading_from_candidate: 'structure',
    retag_node: 'structure',
    update_link_visible_text: 'structure',
    set_link_annotation_contents: 'structure',
    repair_cid_symbol_font_maps: 'text_recovery',
    artifact_nonsemantic_page_elements: 'artifact',
    embed_missing_fonts_in_place: 'text_recovery',
    embed_missing_fonts_for_page_content: 'text_recovery',
    rewrite_link_visible_text: 'structure',
  }
  return {
    type: typeMap[action.tool] || 'structure',
    label: action.tool,
    details: action.details,
    confidence: action.confidence,
    autoApplied: action.autoApplied,
    generationSource: action.generationSource,
  }
}

export function toSuggestedChange(action: RemediationActionRecord): SuggestedChange | null {
  if (!['unsupported', 'failed', 'skipped', 'no_effect', 'deferred', 'rejected'].includes(action.outcome)) return null
  const typeMap: Record<string, SuggestedChange['type']> = {
    ocr_scanned_pdf: 'text_recovery',
    bootstrap_struct_tree: 'structure',
    create_bookmark: 'bookmark',
    replace_bookmarks_from_headings: 'bookmark',
    normalize_heading_hierarchy: 'structure',
    normalize_nested_figure_containers: 'structure',
    set_figure_alt_text: 'alt_text',
    retag_as_figure_and_set_alt: 'alt_text',
    mark_figure_decorative: 'artifact',
    set_pdfua_identification: 'language',
    normalize_document_metadata: 'language',
    repair_structure_conformance: 'structure',
    repair_malformed_bdc_operators: 'structure',
    repair_note_tag_ids: 'structure',
    repair_native_marked_content_refs: 'structure',
    repair_native_link_structure: 'structure',
    tag_unowned_annotations: 'structure',
    repair_bootstrapped_chart_content_refs: 'structure',
    repair_native_figure_semantics: 'alt_text',
    repair_other_elements_alt_text: 'alt_text',
    repair_native_table_headers: 'table',
    repair_native_reading_order: 'reading_order',
    repair_font_unicode_maps: 'text_recovery',
    repair_type1_font_unicode_maps: 'text_recovery',
    repair_truetype_encoding_differences: 'text_recovery',
    substitute_legacy_fonts_in_place: 'text_recovery',
    finalize_substituted_font_conformance: 'text_recovery',
    repair_cidset_consistency: 'text_recovery',
    set_page_tabs: 'structure',
    normalize_annotation_tab_order: 'reading_order',
    set_tabs_all_annotated_pages: 'reading_order',
    repair_annotation_alt_text: 'alt_text',
    set_link_annotation_contents: 'structure',
    repair_cid_symbol_font_maps: 'text_recovery',
    artifact_nonsemantic_page_elements: 'artifact',
    embed_missing_fonts_in_place: 'text_recovery',
    embed_missing_fonts_for_page_content: 'text_recovery',
    set_form_field_label: 'structure',
    set_form_field_tooltip: 'structure',
    set_table_header_cells: 'table',
    move_tag_in_reading_order: 'reading_order',
    reorder_structure_children: 'reading_order',
    create_heading_tag: 'structure',
    create_heading_from_candidate: 'structure',
    retag_node: 'structure',
    update_link_visible_text: 'structure',
    rewrite_link_visible_text: 'structure',
  }
  return {
    type: typeMap[action.tool] || 'structure',
    label: action.tool,
    details: action.details,
    confidence: action.confidence,
    autoApplied: false,
    generationSource: action.generationSource,
    reason: action.outcome === 'unsupported'
      ? 'Current mutation backend does not support this repair safely.'
      : action.outcome === 'rejected'
        ? 'The proposed repair was rejected because it worsened standards validation on an already-tagged PDF.'
      : action.outcome === 'no_effect'
        ? 'The PDF was mutated, but the targeted accessibility score did not improve.'
        : 'The proposed repair could not be applied automatically.',
  }
}

export function mergeManualReviewFlags(existing: ModelReviewFlag[], next: ModelReviewFlag[]): ModelReviewFlag[] {
  return next.reduce((flags, flag) => uniqueFlag(flag, flags), existing)
}
