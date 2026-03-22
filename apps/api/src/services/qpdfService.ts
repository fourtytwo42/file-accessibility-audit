import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ANALYSIS } from '#config'

const execFileAsync = promisify(execFile)
const LEGACY_HEADING_TAG_RE = /^\/heading\s+(\d+)$/i
const STANDARD_STRUCTURE_TAGS = new Set<string>([
  '/Document', '/Part', '/Art', '/Sect', '/Div', '/BlockQuote', '/Caption', '/TOC', '/TOCI', '/Index',
  '/NonStruct', '/Private', '/P', '/H', '/H1', '/H2', '/H3', '/H4', '/H5', '/H6',
  '/L', '/LI', '/Lbl', '/LBody', '/Table', '/TR', '/TH', '/TD', '/THead', '/TBody', '/TFoot',
  '/Span', '/Quote', '/Note', '/Reference', '/BibEntry', '/Code', '/Link', '/Annot',
  '/Ruby', '/RB', '/RT', '/RP', '/Warichu', '/WT', '/WP', '/Figure', '/Formula', '/Form',
  '/Artifact',
])
const QPDF_RETRY_MAX_BUFFER = 150 * 1024 * 1024
const QPDF_BIN = process.env.QPDF_PATH || (() => {
  const candidates = [
    'C:/Program Files/qpdf 12.3.2/bin/qpdf.exe',
    '/opt/homebrew/bin/qpdf',
    '/usr/local/bin/qpdf',
  ]
  return candidates.find(candidate => fs.existsSync(candidate)) || 'qpdf'
})()

export interface QpdfResult {
  hasStructTree: boolean
  isTagged: boolean // /MarkInfo /Marked = true in the catalog
  hasMarkInfo?: boolean
  marked?: boolean | null
  hasLang: boolean
  lang: string | null
  hasOutlines: boolean
  outlineCount: number
  outlineTitles: string[]
  displayDocTitle?: boolean | null
  metadataRef?: string | null
  metadataTypeValid?: boolean
  metadataSubtypeXml?: boolean
  hasAcroForm: boolean
  formFields: Array<{ hasTU: boolean; name?: string }>
  fontCount?: number
  unembeddedFontCount?: number
  unembeddedType3FontCount?: number
  fontsMissingToUnicode?: number
  fontsMissingToUnicodeBlocking?: number
  fontsMissingToUnicodeProxy?: number
  fontsMissingToUnicodeAdvisory?: number
  type1FontsMissingToUnicode?: number
  cidFontsMissingCidToGidMap?: number
  cidSetRiskFontCount?: number
  cidSetExplicitFontCount?: number
  legacyWidthRiskFontCount?: number
  noteTagCount?: number
  noteTagsMissingId?: number
  unmappedRoleMapTagCount?: number
  unmappedRoleMapTags?: string[]
  linkAnnotationCount?: number
  linkStructCount?: number
  linkAnnotationsMissingContents?: number
  images: Array<{
    ref: string
    hasAlt: boolean
    altText?: string
    canonicalRef?: string | null
    contentFingerprint?: string | null
    pageNumber?: number | null
    placementPageNumbers?: number[]
    placementCount?: number
  }>
  headings: Array<{ level: string; tag: string; text?: string | null }>
  tables: Array<{
    hasHeaders: boolean
    rowCellCounts?: number[]
    dominantColumnCount?: number
    isRegular?: boolean
    headerRowCount?: number
    maxRowSpan?: number
    maxColSpan?: number
  }>
  structTreeDepth: number
  // MCIDs in struct-tree depth-first order, as (pageIndex, mcid) pairs.
  // Each pair is encoded as pageIndex * 100000 + mcid so that the scorer can
  // detect per-page disorder without cross-page MCID resets causing false positives.
  contentOrder: number[]
  annotationCount: number // non-Widget annotations visible on pages
  error: string | null
}

export async function analyzeWithQpdf(buffer: Buffer, options?: { signal?: AbortSignal }): Promise<QpdfResult> {
  const tmpDir = process.env.TMP_DIR || os.tmpdir()
  const tmpPath = path.join(tmpDir, `${randomUUID()}.pdf`)

  try {
    fs.writeFileSync(tmpPath, buffer)

    const { stdout } = await runQpdfJson(tmpPath, ANALYSIS.QPDF_MAX_BUFFER, options?.signal)

    const json = JSON.parse(stdout)
    return parseQpdfJson(json)
  } catch (err: any) {
    // Check for password-protected PDF
    if (err.stderr?.includes('encrypted') || err.message?.includes('encrypted')) {
      throw new Error('encrypted')
    }
    // Check for timeout
    if (err.killed || err.signal === 'SIGTERM') {
      return {
        hasStructTree: false,
        isTagged: false,
        hasMarkInfo: false,
        marked: null,
        hasLang: false,
        lang: null,
        hasOutlines: false,
        outlineCount: 0,
        outlineTitles: [],
        displayDocTitle: null,
        metadataRef: null,
        metadataTypeValid: false,
        metadataSubtypeXml: false,
        hasAcroForm: false,
        formFields: [],
        fontCount: 0,
        unembeddedFontCount: 0,
        unembeddedType3FontCount: 0,
        fontsMissingToUnicode: 0,
        fontsMissingToUnicodeBlocking: 0,
        fontsMissingToUnicodeProxy: 0,
        fontsMissingToUnicodeAdvisory: 0,
        type1FontsMissingToUnicode: 0,
        cidFontsMissingCidToGidMap: 0,
        cidSetRiskFontCount: 0,
        cidSetExplicitFontCount: 0,
        legacyWidthRiskFontCount: 0,
        noteTagCount: 0,
        noteTagsMissingId: 0,
        unmappedRoleMapTagCount: 0,
        unmappedRoleMapTags: [],
        linkAnnotationCount: 0,
        linkStructCount: 0,
        linkAnnotationsMissingContents: 0,
        images: [],
        headings: [],
        tables: [],
        structTreeDepth: 0,
        contentOrder: [],
        annotationCount: 0,
        error: 'QPDF timeout',
      }
    }
    if (err.name === 'AbortError') {
      const error = new Error('QPDF cancelled') as any
      error.aborted = true
      throw error
    }
    // Return partial result with error
    return emptyQpdfResult('QPDF parsing failed')
  } finally {
    try { fs.unlinkSync(tmpPath) } catch {}
  }
}

async function runQpdfJson(tmpPath: string, maxBuffer: number, signal?: AbortSignal) {
  try {
    return await execFileAsync(QPDF_BIN, ['--json', '--json-stream-data=inline', tmpPath], {
      timeout: ANALYSIS.QPDF_TIMEOUT_MS,
      maxBuffer,
      encoding: 'utf-8',
      signal,
      windowsHide: true,
    })
  } catch (err: any) {
    if (isQpdfBufferOverflow(err) && maxBuffer < QPDF_RETRY_MAX_BUFFER) {
      try {
        return await execFileAsync(QPDF_BIN, ['--json', '--json-stream-data=inline', tmpPath], {
          timeout: ANALYSIS.QPDF_TIMEOUT_MS,
          maxBuffer: QPDF_RETRY_MAX_BUFFER,
          encoding: 'utf-8',
          signal,
          windowsHide: true,
        })
      } catch (retryErr: any) {
        if (!isQpdfBufferOverflow(retryErr)) throw retryErr
        // For very large post-remediation PDFs, inline stream bodies can make qpdf JSON
        // balloon into hundreds of MB. We only need stream dictionaries for structure,
        // font, image, and metadata inspection, so fall back to omitting stream bodies
        // rather than treating the whole qpdf pass as failed.
        return execFileAsync(QPDF_BIN, ['--json', '--json-stream-data=none', tmpPath], {
          timeout: ANALYSIS.QPDF_TIMEOUT_MS,
          maxBuffer,
          encoding: 'utf-8',
          signal,
          windowsHide: true,
        })
      }
    }
    throw err
  }
}

function isQpdfBufferOverflow(err: any): boolean {
  const message = String(err?.message || '')
  return err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    || /maxBuffer/i.test(message)
    || /stdout maxBuffer length exceeded/i.test(message)
  }

function isLikelyStructureElement(obj: Record<string, any>, tag: string, roleMap: Map<string, string>, roleMapNoteAliases: Set<string>): boolean {
  const legacyHeading = LEGACY_HEADING_TAG_RE.test(tag)
  const standardOrMappedTag = isStandardStructureTag(tag, roleMap) || roleMapNoteAliases.has(tag) || legacyHeading
  if (standardOrMappedTag) return true
  return obj['/Type'] === '/StructElem'
    || obj['/P'] !== undefined
    || obj['/K'] !== undefined
    || obj['/Pg'] !== undefined
    || obj['/Alt'] !== undefined
    || obj['/ID'] !== undefined
}

function emptyQpdfResult(error: string): QpdfResult {
  return {
    hasStructTree: false,
    isTagged: false,
    hasMarkInfo: false,
    marked: null,
    hasLang: false,
    lang: null,
    hasOutlines: false,
    outlineCount: 0,
    outlineTitles: [],
    displayDocTitle: null,
    metadataRef: null,
    metadataTypeValid: false,
    metadataSubtypeXml: false,
    hasAcroForm: false,
    formFields: [],
    fontCount: 0,
    unembeddedFontCount: 0,
    unembeddedType3FontCount: 0,
    fontsMissingToUnicode: 0,
    fontsMissingToUnicodeBlocking: 0,
    fontsMissingToUnicodeProxy: 0,
    fontsMissingToUnicodeAdvisory: 0,
    type1FontsMissingToUnicode: 0,
    cidFontsMissingCidToGidMap: 0,
    cidSetRiskFontCount: 0,
    cidSetExplicitFontCount: 0,
    legacyWidthRiskFontCount: 0,
    noteTagCount: 0,
    noteTagsMissingId: 0,
    unmappedRoleMapTagCount: 0,
    unmappedRoleMapTags: [],
    linkAnnotationCount: 0,
    linkStructCount: 0,
    linkAnnotationsMissingContents: 0,
    images: [],
    headings: [],
    tables: [],
    structTreeDepth: 0,
    contentOrder: [],
    annotationCount: 0,
    error,
  }
}

export function parseQpdfJson(json: any): QpdfResult {
  const result: QpdfResult = {
    hasStructTree: false,
    isTagged: false,
    hasMarkInfo: false,
    marked: null,
    hasLang: false,
    lang: null,
    hasOutlines: false,
    outlineCount: 0,
    outlineTitles: [],
    displayDocTitle: null,
    metadataRef: null,
    metadataTypeValid: false,
    metadataSubtypeXml: false,
    hasAcroForm: false,
    formFields: [],
    fontCount: 0,
    unembeddedFontCount: 0,
    unembeddedType3FontCount: 0,
    fontsMissingToUnicode: 0,
    fontsMissingToUnicodeBlocking: 0,
    fontsMissingToUnicodeProxy: 0,
    fontsMissingToUnicodeAdvisory: 0,
    type1FontsMissingToUnicode: 0,
    cidFontsMissingCidToGidMap: 0,
    cidSetRiskFontCount: 0,
    cidSetExplicitFontCount: 0,
    legacyWidthRiskFontCount: 0,
    noteTagCount: 0,
    noteTagsMissingId: 0,
    unmappedRoleMapTagCount: 0,
    unmappedRoleMapTags: [],
    linkAnnotationCount: 0,
    linkStructCount: 0,
    linkAnnotationsMissingContents: 0,
    images: [],
    headings: [],
    tables: [],
    structTreeDepth: 0,
    contentOrder: [],
    annotationCount: 0,
    error: null,
  }

  try {
    const rawObjects = json.objects || json.qpdf?.[1] || {}

    // QPDF v2 JSON wraps objects as { value: {...} } for plain dicts or
    // { stream: { dict: {...} } } for stream objects (no "value" key).
    // Normalize so we always work with the inner dict.
    const objects: Record<string, any> = {}
    for (const [ref, raw] of Object.entries(rawObjects)) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as any
      if (r.value !== undefined) {
        objects[ref] = r.value
      } else if (r.stream?.dict !== undefined) {
        // Stream object: expose the stream dict so /Type, /Subtype etc. are directly accessible.
        objects[ref] = r.stream.dict
      } else {
        objects[ref] = r
      }
    }

    const roleMapNoteAliases = new Set<string>(['/Note'])
    const structRoleMap = new Map<string, string>()
    const unmappedRoleTags = new Set<string>()
    const descendantFontRefs = new Set<string>()
    const softMaskImageRefs = new Set<string>()
    const ignoredFormDefaultFontRefs = new Set<string>()
    const pendingFigureEntries: Array<{
      ref: string
      hasAlt: boolean
      altText?: string
      hasAssociatedContent: boolean
      hasDirectAssociatedContent: boolean
      directImageRefs: string[]
    }> = []
    const canonicalImageEntries = new Map<string, {
      ref: string
      hasAlt: boolean
      altText?: string
      canonicalRef: string
      contentFingerprint?: string
      pageNumber?: number
      placementPageNumbers: number[]
      placementCount: number
    }>()
    const rawImageRefToCanonicalRef = new Map<string, string>()
    for (const obj of Object.values(objects)) {
      if (!obj || typeof obj !== 'object' || obj['/Type'] !== '/StructTreeRoot') continue
      const resolvedRoleMap = resolveObject(obj['/RoleMap'], objects)
      if (!resolvedRoleMap || typeof resolvedRoleMap !== 'object') continue
      for (const [tag, mapped] of Object.entries(resolvedRoleMap)) {
        if (typeof tag === 'string' && typeof mapped === 'string') {
          structRoleMap.set(tag, mapped)
        }
        if (mapped === '/Note' && typeof tag === 'string') {
          roleMapNoteAliases.add(tag)
        }
      }
    }

    for (const [ref, obj] of Object.entries(objects)) {
      if (!obj || typeof obj !== 'object' || obj['/Subtype'] !== '/Image') continue
      const softMaskRef = (obj as any)['/SMask']
      if (typeof softMaskRef === 'string') {
        softMaskImageRefs.add(softMaskRef)
        softMaskImageRefs.add(softMaskRef.replace(/^obj:/, ''))
        softMaskImageRefs.add(softMaskRef.startsWith('obj:') ? softMaskRef : `obj:${softMaskRef}`)
      }
    }

    for (const [ref, obj] of Object.entries(objects)) {
      if (!obj || typeof obj !== 'object' || obj['/Type'] !== '/Font') continue
      for (const descendant of resolveDescendantFonts(obj, objects)) {
        if (typeof descendant === 'string') {
          descendantFontRefs.add(descendant)
          descendantFontRefs.add(descendant.replace(/^obj:/, ''))
          descendantFontRefs.add(descendant.startsWith('obj:') ? descendant : `obj:${descendant}`)
          continue
        }
        if (descendant && typeof descendant === 'object') {
          const descendantRef = Object.entries(objects).find(([, candidate]) => candidate === descendant)?.[0]
          if (descendantRef) {
            descendantFontRefs.add(descendantRef)
            descendantFontRefs.add(descendantRef.replace(/^obj:/, ''))
            descendantFontRefs.add(descendantRef.startsWith('obj:') ? descendantRef : `obj:${descendantRef}`)
          }
        }
      }
    }

    for (const obj of Object.values(objects)) {
      if (!obj || typeof obj !== 'object' || obj['/Type'] !== '/Catalog' || !obj['/AcroForm']) continue
      const acroForm = resolveObject(obj['/AcroForm'], objects)
      if (!acroForm || typeof acroForm !== 'object') continue
      const fieldList = resolveObject(acroForm['/Fields'], objects)
      if (!Array.isArray(fieldList) || fieldList.length > 0) continue
      const defaultResources = resolveObject(acroForm['/DR'], objects)
      const fontResources = defaultResources && typeof defaultResources === 'object'
        ? resolveObject((defaultResources as any)['/Font'], objects)
        : null
      if (!fontResources || typeof fontResources !== 'object') continue
      for (const fontRef of Object.values(fontResources as Record<string, unknown>)) {
        addCanonicalRef(ignoredFormDefaultFontRefs, fontRef)
      }
    }

    // Walk all objects looking for key structures
    for (const [ref, obj] of Object.entries(objects)) {
      if (!obj || typeof obj !== 'object') continue
      const o = obj as any

      // Check for StructTreeRoot
      if (o['/Type'] === '/StructTreeRoot' || o['/StructTreeRoot']) {
        result.hasStructTree = true
      }

      // Check catalog for StructTreeRoot, Lang, Outlines, MarkInfo
      if (o['/Type'] === '/Catalog') {
        if (o['/StructTreeRoot']) result.hasStructTree = true
        if (o['/Lang']) {
          result.hasLang = true
          // Strip QPDF "u:" Unicode prefix (e.g., "u:EN-US" → "EN-US")
          const rawLang = typeof o['/Lang'] === 'string' ? o['/Lang'] : null
          result.lang = rawLang?.replace(/^u:/, '') ?? null
        }
        if (o['/Outlines']) result.hasOutlines = true
        if (o['/AcroForm']) result.hasAcroForm = true
        if (o['/Metadata']) {
          const rawMetadataRef = o['/Metadata']
          result.metadataRef = typeof rawMetadataRef === 'string' ? rawMetadataRef : null
        }
        const viewerPreferences = o['/ViewerPreferences']
        if (viewerPreferences && typeof viewerPreferences === 'object') {
          const displayDocTitle = viewerPreferences['/DisplayDocTitle']
          result.displayDocTitle = displayDocTitle === true || displayDocTitle === 'true'
        }
        // /MarkInfo /Marked = true means the document is a Tagged PDF
        const markInfo = o['/MarkInfo']
        if (markInfo) {
          result.hasMarkInfo = true
          const marked = typeof markInfo === 'object' ? markInfo['/Marked'] : null
          if (marked === true || marked === 'true') {
            result.isTagged = true
            result.marked = true
          } else if (marked === false || marked === 'false') {
            result.marked = false
          }
        }
      }

      if (o['/Type'] === '/Metadata') result.metadataTypeValid = true
      if (o['/Subtype'] === '/XML') result.metadataSubtypeXml = true

      // Count outline entries and collect titles
      if (o['/Type'] === '/Outlines' || (o['/First'] && o['/Last'] && !o['/Parent'])) {
        const titles: string[] = []
        result.outlineCount = countOutlineEntries(o, objects, titles)
        result.outlineTitles = titles
      }

      // Structure elements (headings, tables, figures with alt)
      if (o['/S']) {
        const tag = o['/S']
        if (typeof tag !== 'string' || !isLikelyStructureElement(o, tag, structRoleMap, roleMapNoteAliases)) {
          continue
        }
        if (typeof tag === 'string' && roleMapNoteAliases.has(tag)) {
          result.noteTagCount = (result.noteTagCount ?? 0) + 1
          const rawId = o['/ID']
          const hasId = typeof rawId === 'string'
            ? rawId.replace(/^u:/, '').trim().length > 0
            : !!rawId
          if (!hasId) {
            result.noteTagsMissingId = (result.noteTagsMissingId ?? 0) + 1
          }
        }
        if (tag === '/Link') {
          result.linkStructCount = (result.linkStructCount ?? 0) + 1
        }
        if (typeof tag === 'string' && !isStandardStructureTag(tag, structRoleMap)) {
          unmappedRoleTags.add(tag)
        }
        // Headings
        const legacyHeading = typeof tag === 'string' ? tag.match(LEGACY_HEADING_TAG_RE) : null
        if (tag === '/H' || tag === '/H1' || tag === '/H2' || tag === '/H3' ||
            tag === '/H4' || tag === '/H5' || tag === '/H6' || legacyHeading) {
          const level = legacyHeading ? `H${Number(legacyHeading[1]) || 1}` : tag.replace('/', '')
          result.headings.push({ level, tag })
        }
        // Tables
        if (tag === '/Table') {
          const hasHeaders = hasTableHeaders(o, objects)
          const regularity = analyzeTableRegularity(o, objects)
          result.tables.push({
            hasHeaders,
            rowCellCounts: regularity.rowCellCounts,
            dominantColumnCount: regularity.dominantColumnCount,
            isRegular: regularity.isRegular,
          })
        }
        // Figures with alt text
        if (tag === '/Figure') {
          const rawAlt = o['/Alt']
          const altText = typeof rawAlt === 'string' ? rawAlt.replace(/^u:/, '') : undefined
          const hasAlt = altText !== undefined && altText !== ''
          const hasAssociatedContent = structElemHasAssociatedContent(o, objects)
          const hasDirectAssociatedContent = structElemHasDirectAssociatedContent(o, objects)
          const directImageRefs = collectStructElemDirectImageRefs(o, objects)
          pendingFigureEntries.push({ ref, hasAlt, altText, hasAssociatedContent, hasDirectAssociatedContent, directImageRefs })
        }

      }

      // Annotations (non-Widget subtypes that appear on pages)
      if (o['/Type'] === '/Annot') {
        const subtype = o['/Subtype']
        if (subtype === '/Widget') {
          const name = typeof o['/T'] === 'string' ? o['/T'].replace(/^u:/, '') : undefined
          result.formFields.push({ hasTU: !!o['/TU'], name })
        } else if (subtype && subtype !== '/Popup') {
          // Count all non-Widget, non-Popup annotations (Link, Text, Stamp, etc.)
          result.annotationCount++
          if (subtype === '/Link') {
            result.linkAnnotationCount = (result.linkAnnotationCount ?? 0) + 1
            const rawContents = o['/Contents']
            const hasContents = typeof rawContents === 'string'
              ? rawContents.replace(/^u:/, '').trim().length > 0
              : !!rawContents
            if (!hasContents) {
              result.linkAnnotationsMissingContents = (result.linkAnnotationsMissingContents ?? 0) + 1
            }
          }
        }
      }

      if (isFontObject(o) && !descendantFontRefs.has(ref) && !ignoredFormDefaultFontRefs.has(ref)) {
        result.fontCount = (result.fontCount ?? 0) + 1
        if (!fontHasEmbeddedProgram(o, objects)) {
          result.unembeddedFontCount = (result.unembeddedFontCount ?? 0) + 1
          if (String(o['/Subtype'] || '') === '/Type3') {
            result.unembeddedType3FontCount = (result.unembeddedType3FontCount ?? 0) + 1
          }
        }
        const missingToUnicode = !fontHasToUnicode(o, objects)
        if (missingToUnicode) {
          result.fontsMissingToUnicode = (result.fontsMissingToUnicode ?? 0) + 1
          const unicodeRisk = classifyMissingToUnicodeRisk(o, objects)
          if (unicodeRisk === 'blocking_text_font') {
            result.fontsMissingToUnicodeBlocking = (result.fontsMissingToUnicodeBlocking ?? 0) + 1
          } else if (unicodeRisk === 'legacy_symbol_or_subset_proxy') {
            result.fontsMissingToUnicodeProxy = (result.fontsMissingToUnicodeProxy ?? 0) + 1
          } else {
            result.fontsMissingToUnicodeAdvisory = (result.fontsMissingToUnicodeAdvisory ?? 0) + 1
          }
          const subtype = String(o['/Subtype'] || '')
          if (subtype === '/Type1' || subtype === '/Type3') {
            result.type1FontsMissingToUnicode = (result.type1FontsMissingToUnicode ?? 0) + 1
          }
        }
        if (fontMissingCidToGidMap(o, objects)) result.cidFontsMissingCidToGidMap = (result.cidFontsMissingCidToGidMap ?? 0) + 1
        if (fontHasLegacyWidthRisk(o, objects)) result.legacyWidthRiskFontCount = (result.legacyWidthRiskFontCount ?? 0) + 1
      }
    }

    collectDiscoveredPageImages({
      json,
      objects,
      rawObjects,
      softMaskImageRefs,
      canonicalImageEntries,
      rawImageRefToCanonicalRef,
    })

    if (canonicalImageEntries.size === 0) {
      for (const [ref, obj] of Object.entries(objects)) {
        if (!obj || typeof obj !== 'object' || obj['/Subtype'] !== '/Image') continue
        const isSoftMaskOnly = softMaskImageRefs.has(ref)
        const isStencilMask = obj['/ImageMask'] === true || obj['/ImageMask'] === 'true'
        if (isSoftMaskOnly || isStencilMask) continue
        registerDiscoveredImage({
          ref,
          pageNumber: undefined,
          objects,
          rawObjects,
          canonicalImageEntries,
          rawImageRefToCanonicalRef,
        })
      }
    }

    result.images = [...canonicalImageEntries.values()].map(entry => ({
      ref: entry.ref,
      hasAlt: entry.hasAlt,
      altText: entry.altText,
      canonicalRef: entry.canonicalRef,
      contentFingerprint: entry.contentFingerprint || null,
      pageNumber: entry.pageNumber ?? null,
      placementPageNumbers: entry.placementPageNumbers,
      placementCount: entry.placementCount,
    }))

    // Also check for form fields via AcroForm
    if (result.hasAcroForm) {
      for (const [_ref, obj] of Object.entries(objects)) {
        const o = obj as any
        if (o?.['/AcroForm']?.['/Fields']) {
          const fieldRefs = o['/AcroForm']['/Fields']
          if (Array.isArray(fieldRefs)) {
            // If we didn't find fields via widget annotations, count from AcroForm
            if (result.formFields.length === 0) {
              for (const fieldRef of fieldRefs) {
                const fieldKey = typeof fieldRef === 'string' ? fieldRef : fieldRef?.toString()
                const field = objects[fieldKey] as any
                if (field) {
                  result.formFields.push({ hasTU: !!field['/TU'] })
                }
              }
            }
          }
        }
      }
    }

    // Walk structure tree from root for proper depth measurement and reading-order MCIDs
    if (result.hasStructTree) {
      // Find the StructTreeRoot ref from the catalog
      let structTreeRootRef: string | null = null
      for (const [_ref, obj] of Object.entries(objects)) {
        const o = obj as any
        if (o?.['/Type'] === '/Catalog' && o['/StructTreeRoot']) {
          const rawRef = o['/StructTreeRoot']
          structTreeRootRef = typeof rawRef === 'string' ? rawRef : null
          break
        }
      }

      if (structTreeRootRef) {
        const structRoot = resolveRef(structTreeRootRef, objects)
        result.structTreeDepth = structRoot ? calculateTreeDepthFromRoot(structRoot, objects) : 0

        // Build a page-ref → page-index map for per-page MCID ordering
        const pageRefToIndex = new Map<string, number>()
        for (const [ref, obj] of Object.entries(objects)) {
          const o = obj as any
          if (o?.['/Type'] === '/Page') {
            pageRefToIndex.set(ref, pageRefToIndex.size)
          }
        }

        // Walk struct tree depth-first, collect (pageIndex * 100000 + mcid) pairs
        walkStructTreeForMCIDs(structRoot, objects, pageRefToIndex, result.contentOrder, null)
      } else {
        result.structTreeDepth = calculateTreeDepth(objects)
      }
    }

    const claimedCanonicalImageRefs = new Set<string>()
    const imageEntryByCanonicalRef = new Map(
      result.images.map(image => [image.canonicalRef || image.ref, image]),
    )
    const claimFigureEntries = (
      figures: Array<typeof pendingFigureEntries[number]>,
      options?: { requireAlt?: boolean },
    ) => {
      for (const figure of figures) {
        if (!figure.hasAssociatedContent) continue
        if (options?.requireAlt && !figure.hasAlt) continue
        const directCanonicalRefs = figure.directImageRefs
          .map(ref => canonicalizeQpdfRef(rawImageRefToCanonicalRef.get(ref) || ref))
          .filter(Boolean)
        const directImage = directCanonicalRefs
          .map(ref => imageEntryByCanonicalRef.get(ref))
          .find((image, index) => image && !claimedCanonicalImageRefs.has(directCanonicalRefs[index])) || null
        const matchingRawImage = directImage
          ? directImage
          : result.images.find(img => !claimedCanonicalImageRefs.has(img.canonicalRef || img.ref))
        if (!matchingRawImage) continue
        claimedCanonicalImageRefs.add(matchingRawImage.canonicalRef || matchingRawImage.ref)
        if (figure.hasAlt) {
          matchingRawImage.hasAlt = true
          matchingRawImage.altText = figure.altText
        }
      }
    }
    claimFigureEntries(
      pendingFigureEntries.filter(figure => figure.hasDirectAssociatedContent && figure.hasAlt),
    )
    claimFigureEntries(
      pendingFigureEntries.filter(figure => !figure.hasDirectAssociatedContent),
      { requireAlt: true },
    )
    for (const figure of pendingFigureEntries) {
      if (!figure.hasAssociatedContent) continue
      const canonicalFigureRef = canonicalizeQpdfRef(
        rawImageRefToCanonicalRef.get(figure.directImageRefs[0] || '')
        || rawImageRefToCanonicalRef.get(figure.ref)
        || figure.directImageRefs[0]
        || figure.ref,
      )
      const matchingRawImage = result.images.find(img => !claimedCanonicalImageRefs.has(img.canonicalRef || img.ref))
      if (matchingRawImage) continue
      // Only count figures with real associated content. Empty /Figure elements with /Alt
      // are Adobe "Associated with content" failures and must not satisfy alt-text scoring.
      if (
        !result.images.some(img => (img.canonicalRef || img.ref) === canonicalFigureRef)
        && (figure.hasDirectAssociatedContent || result.images.length === 0)
      ) {
        result.images.push({
          ref: canonicalFigureRef,
          hasAlt: figure.hasAlt,
          altText: figure.altText,
          canonicalRef: canonicalFigureRef,
          contentFingerprint: null,
          pageNumber: null,
          placementPageNumbers: [],
          placementCount: 0,
        })
      }
    }

    const cidSetSignals = collectCidSetSignals(objects)
    result.cidSetRiskFontCount = cidSetSignals.riskCount
    result.cidSetExplicitFontCount = cidSetSignals.explicitCount
    result.unmappedRoleMapTags = [...unmappedRoleTags].sort()
    result.unmappedRoleMapTagCount = unmappedRoleTags.size

  } catch (err) {
    console.error('QPDF JSON parse error:', err)
    result.error = 'Failed to parse QPDF structure data'
  }

  return result
}

function isStandardStructureTag(tag: string, roleMap: Map<string, string>): boolean {
  if (STANDARD_STRUCTURE_TAGS.has(tag)) return true
  const visited = new Set<string>()
  let current: string | undefined = tag
  while (current && !visited.has(current)) {
    visited.add(current)
    const mapped = roleMap.get(current)
    if (!mapped) return false
    if (STANDARD_STRUCTURE_TAGS.has(mapped)) return true
    current = mapped
  }
  return false
}

function canonicalizeQpdfRef(ref: string | null | undefined): string {
  if (!ref) return ''
  return ref.startsWith('obj:') ? ref : `obj:${ref}`
}

function imageStreamFingerprint(raw: any, obj: any): string | null {
  const streamData = raw?.stream?.data
  if (typeof streamData === 'string' && streamData.length > 0) {
    return createHash('sha1').update(streamData).digest('hex')
  }
  if (!obj || typeof obj !== 'object') return null
  const normalizedDict = JSON.stringify({
    subtype: obj['/Subtype'] || null,
    width: obj['/Width'] || null,
    height: obj['/Height'] || null,
    bitsPerComponent: obj['/BitsPerComponent'] || null,
    colorSpace: obj['/ColorSpace'] || null,
    filter: obj['/Filter'] || null,
    decodeParms: obj['/DecodeParms'] || null,
    length: obj['/Length'] || null,
  })
  if (!normalizedDict) return null
  return createHash('sha1').update(normalizedDict).digest('hex')
}

function registerDiscoveredImage(input: {
  ref: string
  pageNumber?: number
  objects: Record<string, any>
  rawObjects: Record<string, any>
  canonicalImageEntries: Map<string, {
    ref: string
    hasAlt: boolean
    altText?: string
    canonicalRef: string
    contentFingerprint?: string
    pageNumber?: number
    placementPageNumbers: number[]
    placementCount: number
  }>
  rawImageRefToCanonicalRef: Map<string, string>
}): void {
  const canonicalRef = canonicalizeQpdfRef(input.ref)
  const obj = resolveRef(canonicalRef, input.objects)
  const raw = input.rawObjects[canonicalRef] || input.rawObjects[canonicalRef.replace(/^obj:/, '')]
  const fingerprint = imageStreamFingerprint(raw, obj)
  const canonicalKey = fingerprint || canonicalRef
  const existing = input.canonicalImageEntries.get(canonicalKey)
  if (existing) {
    existing.placementCount += 1
    if (input.pageNumber && !existing.placementPageNumbers.includes(input.pageNumber)) {
      existing.placementPageNumbers.push(input.pageNumber)
    }
    input.rawImageRefToCanonicalRef.set(canonicalRef, existing.canonicalRef)
    return
  }
  input.canonicalImageEntries.set(canonicalKey, {
    ref: canonicalRef,
    hasAlt: false,
    canonicalRef,
    contentFingerprint: fingerprint || undefined,
    pageNumber: input.pageNumber,
    placementPageNumbers: input.pageNumber ? [input.pageNumber] : [],
    placementCount: 1,
  })
  input.rawImageRefToCanonicalRef.set(canonicalRef, canonicalRef)
}

function collectDiscoveredPageImages(input: {
  json: any
  objects: Record<string, any>
  rawObjects: Record<string, any>
  softMaskImageRefs: Set<string>
  canonicalImageEntries: Map<string, {
    ref: string
    hasAlt: boolean
    altText?: string
    canonicalRef: string
    contentFingerprint?: string
    pageNumber?: number
    placementPageNumbers: number[]
    placementCount: number
  }>
  rawImageRefToCanonicalRef: Map<string, string>
}): void {
  const pages = Array.isArray(input.json?.pages) ? input.json.pages : []
  for (const page of pages) {
    const pageRef = typeof page?.object === 'string' ? canonicalizeQpdfRef(page.object) : ''
    if (!pageRef) continue
    const pageObj = resolveRef(pageRef, input.objects)
    if (!pageObj || typeof pageObj !== 'object') continue
    const resources = resolveObject(pageObj['/Resources'], input.objects)
    walkXObjectResources(resources, {
      pageNumber: Number(page.pageposfrom1) || undefined,
      objects: input.objects,
      rawObjects: input.rawObjects,
      softMaskImageRefs: input.softMaskImageRefs,
      canonicalImageEntries: input.canonicalImageEntries,
      rawImageRefToCanonicalRef: input.rawImageRefToCanonicalRef,
      visitedForms: new Set<string>(),
    })
  }
}

function walkXObjectResources(
  resources: any,
  input: {
    pageNumber?: number
    objects: Record<string, any>
    rawObjects: Record<string, any>
    softMaskImageRefs: Set<string>
    canonicalImageEntries: Map<string, {
      ref: string
      hasAlt: boolean
      altText?: string
      canonicalRef: string
      contentFingerprint?: string
      pageNumber?: number
      placementPageNumbers: number[]
      placementCount: number
    }>
    rawImageRefToCanonicalRef: Map<string, string>
    visitedForms: Set<string>
  },
): void {
  if (!resources || typeof resources !== 'object') return
  const xobjects = resolveObject(resources['/XObject'], input.objects)
  if (!xobjects || typeof xobjects !== 'object') return
  for (const value of Object.values(xobjects as Record<string, unknown>)) {
    const rawRef = typeof value === 'string' ? canonicalizeQpdfRef(value) : null
    const xobj = resolveObject(value, input.objects)
    if (!xobj || typeof xobj !== 'object') continue
    const subtype = String(xobj['/Subtype'] || '')
    if (subtype === '/Image') {
      const imageRef = rawRef || Object.entries(input.objects).find(([, candidate]) => candidate === xobj)?.[0]
      if (!imageRef) continue
      const isSoftMaskOnly = input.softMaskImageRefs.has(imageRef)
      const isStencilMask = xobj['/ImageMask'] === true || xobj['/ImageMask'] === 'true'
      if (isSoftMaskOnly || isStencilMask) continue
      registerDiscoveredImage({
        ref: imageRef,
        pageNumber: input.pageNumber,
        objects: input.objects,
        rawObjects: input.rawObjects,
        canonicalImageEntries: input.canonicalImageEntries,
        rawImageRefToCanonicalRef: input.rawImageRefToCanonicalRef,
      })
      continue
    }
    if (subtype !== '/Form') continue
    if (rawRef && input.visitedForms.has(rawRef)) continue
    if (rawRef) input.visitedForms.add(rawRef)
    const childResources = resolveObject(xobj['/Resources'], input.objects)
    walkXObjectResources(childResources, input)
  }
}

// Resolve a ref like "9 0 R" to its object, trying both "obj:9 0 R" and "9 0 R" key formats
function resolveRef(ref: string, objects: any): any {
  if (!ref || typeof ref !== 'string') return null
  const resolved = objects[ref] ?? objects[`obj:${ref}`] ?? null
  if (!resolved || typeof resolved !== 'object') return resolved
  if (resolved.value && typeof resolved.value === 'object') return resolved.value
  if (resolved.stream?.dict && typeof resolved.stream.dict === 'object') return resolved.stream.dict
  return resolved
}

function addCanonicalRef(target: Set<string>, ref: unknown): void {
  if (typeof ref !== 'string' || ref.length === 0) return
  target.add(ref)
  target.add(ref.replace(/^obj:/, ''))
  target.add(ref.startsWith('obj:') ? ref : `obj:${ref}`)
}

function resolveObject(value: any, objects: any): any {
  if (!value) return null
  if (typeof value === 'string') return resolveRef(value, objects)
  return value
}

function structElemHasAssociatedContent(node: any, objects: any, visited = new Set<any>()): boolean {
  if (!node || typeof node !== 'object') return false
  if (visited.has(node)) return false
  visited.add(node)

  const kids = node['/K']
  if (kids === undefined || kids === null) return false
  if (typeof kids === 'number') return true

  const kidList = Array.isArray(kids) ? kids : [kids]
  for (const kid of kidList) {
    if (typeof kid === 'number') return true
    if (typeof kid === 'string') {
      const child = resolveRef(kid, objects)
      if (child && structElemHasAssociatedContent(child, objects, visited)) return true
      continue
    }
    if (kid && typeof kid === 'object') {
      if (kid['/Type'] === '/OBJR' || kid['/MCID'] !== undefined) return true
      if (structElemHasAssociatedContent(kid, objects, visited)) return true
    }
  }

  return false
}

function structElemHasDirectAssociatedContent(node: any, objects: any): boolean {
  if (!node || typeof node !== 'object') return false
  const kids = node['/K']
  if (kids === undefined || kids === null) return false
  if (typeof kids === 'number') return true

  const kidList = Array.isArray(kids) ? kids : [kids]
  for (const kid of kidList) {
    if (typeof kid === 'number') return true
    if (typeof kid === 'object' && kid) {
      if (kid['/Type'] === '/OBJR' || kid['/MCID'] !== undefined) return true
    }
    if (typeof kid === 'string') {
      const child = resolveRef(kid, objects)
      if (child && typeof child === 'object' && (child['/Type'] === '/OBJR' || child['/MCID'] !== undefined)) {
        return true
      }
    }
  }

  return false
}

function collectStructElemDirectImageRefs(node: any, objects: any): string[] {
  if (!node || typeof node !== 'object') return []
  const refs = new Set<string>()
  const kids = node['/K']
  const kidList = Array.isArray(kids) ? kids : kids !== undefined && kids !== null ? [kids] : []
  for (const kid of kidList) {
    if (!kid || typeof kid !== 'object') continue
    if (kid['/Type'] === '/OBJR' && typeof kid['/Obj'] === 'string') {
      refs.add(canonicalizeQpdfRef(kid['/Obj']))
      continue
    }
  }
  return [...refs]
}

function isFontObject(obj: any): boolean {
  return obj?.['/Type'] === '/Font'
}

function resolveDescendantFonts(fontObj: any, objects: any): any[] {
  if (!fontObj || typeof fontObj !== 'object') return []
  const descendants = fontObj['/DescendantFonts']
  const directList = Array.isArray(descendants) ? descendants : descendants ? [descendants] : []
  const resolved: any[] = []

  for (const descendant of directList) {
    if (typeof descendant === 'string') {
      const byRef = resolveRef(descendant, objects)
      if (Array.isArray(byRef)) {
        resolved.push(...byRef)
      } else {
        resolved.push(descendant)
      }
      continue
    }
    if (Array.isArray(descendant)) {
      resolved.push(...descendant)
      continue
    }
    resolved.push(descendant)
  }

  return resolved
}

function resolveFontDescriptor(fontObj: any, objects: any): any | null {
  if (!fontObj || typeof fontObj !== 'object') return null
  const directDescriptor = fontObj['/FontDescriptor']
  if (typeof directDescriptor === 'string') return resolveRef(directDescriptor, objects)
  if (directDescriptor && typeof directDescriptor === 'object') return directDescriptor

  for (const descendant of resolveDescendantFonts(fontObj, objects)) {
    const resolved = typeof descendant === 'string' ? resolveRef(descendant, objects) : descendant
    if (!resolved || typeof resolved !== 'object') continue
    const descriptor = resolved['/FontDescriptor']
    if (typeof descriptor === 'string') return resolveRef(descriptor, objects)
    if (descriptor && typeof descriptor === 'object') return descriptor
  }

  return null
}

function fontHasEmbeddedProgram(fontObj: any, objects: any): boolean {
  const descriptor = resolveFontDescriptor(fontObj, objects)
  if (!descriptor || typeof descriptor !== 'object') return false
  return !!(descriptor['/FontFile'] || descriptor['/FontFile2'] || descriptor['/FontFile3'])
}

function fontHasToUnicode(fontObj: any, objects: any): boolean {
  if (fontObj['/ToUnicode']) return true
  return resolveDescendantFonts(fontObj, objects).some(descendant => {
    const resolved = typeof descendant === 'string' ? resolveRef(descendant, objects) : descendant
    return !!resolved?.['/ToUnicode']
  })
}

function classifyMissingToUnicodeRisk(
  fontObj: any,
  objects: any,
): 'blocking_text_font' | 'legacy_symbol_or_subset_proxy' | 'advisory_post_repair_proxy' {
  const descendantList = resolveDescendantFonts(fontObj, objects)
  const descendant = descendantList.length > 0
    ? (typeof descendantList[0] === 'string' ? resolveRef(descendantList[0], objects) : descendantList[0])
    : null
  const target = descendant && typeof descendant === 'object' ? descendant : fontObj
  const subtype = String(target?.['/Subtype'] || fontObj?.['/Subtype'] || '')
  const baseFont = String(fontObj?.['/BaseFont'] || target?.['/BaseFont'] || '')
  const normalizedBaseFont = baseFont.replace(/^\//, '')
  const looksSubsetted = /^\//.test(baseFont) && baseFont.includes('+')
  const looksLegacySymbol = /symbol|wingdings|webdings|zapfdingbats|dingbat/i.test(normalizedBaseFont)
  const cidFont = resolveCidFontTarget(fontObj, objects)
  const missingCidToGidMap = fontMissingCidToGidMap(fontObj, objects)
  const legacyWidthRisk = fontHasLegacyWidthRisk(fontObj, objects)
  const hasEmbeddedProgram = fontHasEmbeddedProgram(fontObj, objects)

  if (looksLegacySymbol || subtype === '/Type3') {
    return 'advisory_post_repair_proxy'
  }

  if (hasEmbeddedProgram && (legacyWidthRisk || missingCidToGidMap || (cidFont && looksSubsetted))) {
    return 'legacy_symbol_or_subset_proxy'
  }

  return 'blocking_text_font'
}

function fontMissingCidToGidMap(fontObj: any, objects: any): boolean {
  const subtype = fontObj['/Subtype']
  const descendantList = resolveDescendantFonts(fontObj, objects)
  const descendant = descendantList.length > 0
    ? (typeof descendantList[0] === 'string' ? resolveRef(descendantList[0], objects) : descendantList[0])
    : null

  const target = descendant && typeof descendant === 'object' ? descendant : fontObj
  if (!target || typeof target !== 'object') return false
  const targetSubtype = target['/Subtype'] || subtype
  if (targetSubtype !== '/CIDFontType2') return false
  return !target['/CIDToGIDMap']
}

function fontCidSetRisk(fontObj: any, objects: any): { risk: boolean; explicit: boolean } {
  const target = resolveCidFontTarget(fontObj, objects)
  if (!target) return { risk: false, explicit: false }
  const descriptor = resolveFontDescriptor(fontObj, objects)
  const explicit = !!descriptor?.['/CIDSet']
  if (explicit) return { risk: true, explicit: true }

  if (!fontHasEmbeddedProgram(fontObj, objects)) return { risk: false, explicit: false }

  const baseFont = String(fontObj['/BaseFont'] || target['/BaseFont'] || '')
  const looksSubsetted = /^\//.test(baseFont) && baseFont.includes('+')
  const looksLegacyCidFont = /symbol|wingdings|zapfdingbats/i.test(baseFont)
  const missingUnicode = !fontHasToUnicode(fontObj, objects)

  return {
    risk: looksSubsetted && (looksLegacyCidFont || missingUnicode),
    explicit: false,
  }
}

function resolveCidFontTarget(fontObj: any, objects: any): any | null {
  if (!fontObj || typeof fontObj !== 'object') return null
  if (fontObj['/Subtype'] === '/CIDFontType0' || fontObj['/Subtype'] === '/CIDFontType2') {
    return fontObj
  }
  for (const descendant of resolveDescendantFonts(fontObj, objects)) {
    const resolved = typeof descendant === 'string' ? resolveRef(descendant, objects) : descendant
    if (!resolved || typeof resolved !== 'object') continue
    if (resolved['/Subtype'] === '/CIDFontType0' || resolved['/Subtype'] === '/CIDFontType2') {
      return resolved
    }
  }
  return null
}

function collectCidSetSignals(objects: Record<string, any>): { riskCount: number; explicitCount: number } {
  let explicitCount = 0
  let inferredCount = 0
  const seenExplicit = new Set<string>()
  const seenRisk = new Set<string>()

  for (const [ref, obj] of Object.entries(objects)) {
    if (!isFontObject(obj)) continue
    const target = resolveCidFontTarget(obj, objects)
    if (!target) continue

    const descriptor = resolveFontDescriptor(obj, objects)
    if (descriptor?.['/CIDSet']) {
      const key = typeof target['/FontDescriptor'] === 'string' ? target['/FontDescriptor'] : ref
      if (!seenExplicit.has(key)) {
        seenExplicit.add(key)
        explicitCount += 1
      }
      continue
    }

    const baseFont = String(obj['/BaseFont'] || target['/BaseFont'] || '')
    const looksSubsetted = /^\//.test(baseFont) && baseFont.includes('+')
    const looksLegacyCidFont = /symbol|wingdings|zapfdingbats/i.test(baseFont)
    const missingUnicode = !fontHasToUnicode(obj, objects)
    const missingCidToGidMap = fontMissingCidToGidMap(obj, objects)
    if (!fontHasEmbeddedProgram(obj, objects)) continue
    if (looksSubsetted && (looksLegacyCidFont || missingUnicode || missingCidToGidMap)) {
      const key = ref
      if (!seenRisk.has(key)) {
        seenRisk.add(key)
        inferredCount += 1
      }
    }
  }

  return {
    explicitCount,
    riskCount: explicitCount + inferredCount,
  }
}

function hasCustomEncoding(fontObj: any, objects: any): boolean {
  const encoding = fontObj['/Encoding']
  if (!encoding) return false
  if (typeof encoding === 'string') {
    if (!encoding.startsWith('/')) return true
    return !['/WinAnsiEncoding', '/MacRomanEncoding', '/MacExpertEncoding', '/StandardEncoding'].includes(encoding)
  }
  const resolved = typeof encoding === 'string' ? resolveRef(encoding, objects) : encoding
  return !!resolved
}

function fontHasLegacyWidthRisk(fontObj: any, objects: any): boolean {
  if (!fontObj || typeof fontObj !== 'object') return false
  const subtype = fontObj['/Subtype']
  if (!['/Type1', '/TrueType', '/Type3'].includes(subtype)) return false
  const widths = fontObj['/Widths']
  if (!Array.isArray(widths) || widths.length === 0) return false
  if (!fontHasEmbeddedProgram(fontObj, objects)) return false
  const widthSpanLooksLegacy = widths.length >= 200 || widths.length === 224 || widths.length === 225 || widths.length === 256
  if (!widthSpanLooksLegacy) return false
  const hasUnicodeMap = fontHasToUnicode(fontObj, objects)
  const baseFont = String(fontObj['/BaseFont'] || '')
  const looksSubsetted = /^\//.test(baseFont) && baseFont.includes('+')
  return !hasUnicodeMap && (looksSubsetted || hasCustomEncoding(fontObj, objects))
}

function countOutlineEntries(outline: any, objects: any, titles: string[]): number {
  let count = 0
  const visited = new Set<string>()

  const walk = (node: any, depth: number) => {
    let current = node['/First']
    while (current && typeof current === 'string' && !visited.has(current)) {
      visited.add(current)
      count++
      const entry = resolveRef(current, objects)
      if (!entry) break
      const title = typeof entry['/Title'] === 'string' ? entry['/Title'].replace(/^u:/, '') : ''
      if (title && titles.length < 50) {
        titles.push('  '.repeat(depth) + title)
      }
      // Count nested children recursively
      if (entry['/First']) walk(entry, depth + 1)
      current = entry['/Next']
    }
  }

  walk(outline, 0)
  return count
}

function hasTableHeaders(tableObj: any, objects: any): boolean {
  // Look through children for /TH tags
  const kids = tableObj['/K']
  if (!kids) return false

  const checkForTH = (node: any, depth: number): boolean => {
    if (depth > 10) return false
    if (Array.isArray(node)) {
      return node.some(n => checkForTH(n, depth + 1))
    }
    if (typeof node === 'string') {
      const obj = resolveRef(node, objects)
      if (obj?.['/S'] === '/TH') return true
      return checkForTH(obj?.['/K'], depth + 1)
    }
    if (node && typeof node === 'object') {
      if (node['/S'] === '/TH') return true
      return checkForTH(node['/K'], depth + 1)
    }
    return false
  }

  return checkForTH(kids, 0)
}

function analyzeTableRegularity(
  tableObj: any,
  objects: any,
): {
  rowCellCounts: number[]
  dominantColumnCount: number
  isRegular: boolean
  headerRowCount: number
  maxRowSpan: number
  maxColSpan: number
} {
  const rows: any[] = []

  const collectRows = (node: any, depth: number): void => {
    if (!node || depth > 12) return
    if (Array.isArray(node)) {
      for (const kid of node) collectRows(kid, depth + 1)
      return
    }
    if (typeof node === 'string') {
      collectRows(resolveRef(node, objects), depth + 1)
      return
    }
    if (typeof node !== 'object') return
    if (node['/S'] === '/TR') {
      rows.push(node)
      return
    }
    collectRows(node['/K'], depth + 1)
  }

  const cellColSpan = (cell: any): number => {
    try {
      const attrs = cell?.['/A']
      if (attrs && typeof attrs === 'object') {
        const span = Number(attrs['/ColSpan'] ?? cell?.['/ColSpan'] ?? 1)
        return Number.isFinite(span) && span > 0 ? Math.max(1, Math.trunc(span)) : 1
      }
      const span = Number(cell?.['/ColSpan'] ?? 1)
      return Number.isFinite(span) && span > 0 ? Math.max(1, Math.trunc(span)) : 1
    } catch {}
    return 1
  }

  const cellRowSpan = (cell: any): number => {
    try {
      const attrs = cell?.['/A']
      if (attrs && typeof attrs === 'object') {
        const span = Number(attrs['/RowSpan'] ?? cell?.['/RowSpan'] ?? 1)
        return Number.isFinite(span) && span > 0 ? Math.max(1, Math.trunc(span)) : 1
      }
      const span = Number(cell?.['/RowSpan'] ?? 1)
      return Number.isFinite(span) && span > 0 ? Math.max(1, Math.trunc(span)) : 1
    } catch {}
    return 1
  }

  const listRowCells = (row: any): any[] => {
    const kids = row?.['/K']
    const stack = Array.isArray(kids) ? [...kids] : kids !== undefined ? [kids] : []
    const cells: any[] = []
    let guard = 0
    while (stack.length && guard < 400) {
      guard += 1
      const kid = stack.shift()
      if (!kid) continue
      if (typeof kid === 'string') {
        stack.unshift(resolveRef(kid, objects))
        continue
      }
      if (typeof kid !== 'object') continue
      const tag = kid['/S']
      if (tag === '/TH' || tag === '/TD') {
        cells.push(kid)
        continue
      }
      const nested = kid['/K']
      if (Array.isArray(nested)) stack.unshift(...nested)
      else if (nested !== undefined) stack.unshift(nested)
    }
    return cells
  }

  collectRows(tableObj?.['/K'], 0)
  const rowCellCounts: number[] = []
  let headerRowCount = 0
  let maxRowSpan = 1
  let maxColSpan = 1
  const activeRowSpans: number[] = []
  for (const row of rows) {
    while (activeRowSpans.length && activeRowSpans[activeRowSpans.length - 1] <= 0) activeRowSpans.pop()
    const priorSpanCount = activeRowSpans.length
    let occupiedColumns = activeRowSpans.reduce((sum, span) => sum + (span > 0 ? 1 : 0), 0)
    const cells = listRowCells(row)
    if (cells.some(cell => cell?.['/S'] === '/TH')) headerRowCount += 1
    for (const cell of cells) {
      const colSpan = cellColSpan(cell)
      const rowSpan = cellRowSpan(cell)
      maxColSpan = Math.max(maxColSpan, colSpan)
      maxRowSpan = Math.max(maxRowSpan, rowSpan)
      occupiedColumns += colSpan
      if (rowSpan > 1) {
        for (let index = 0; index < colSpan; index += 1) {
          activeRowSpans.push(rowSpan - 1)
        }
      }
    }
    rowCellCounts.push(occupiedColumns)
    for (let index = 0; index < priorSpanCount; index += 1) {
      if (activeRowSpans[index] > 0) activeRowSpans[index] -= 1
    }
  }
  const filteredRowCounts = rowCellCounts.filter(count => Number.isFinite(count) && count > 0)
  const frequency = new Map<number, number>()
  for (const count of filteredRowCounts) frequency.set(count, (frequency.get(count) ?? 0) + 1)
  const dominantColumnCount = [...frequency.entries()]
    .sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]))[0]?.[0] ?? 0
  const isRegular = filteredRowCounts.length <= 1
    ? true
    : filteredRowCounts.every(count => count === dominantColumnCount)

  return {
    rowCellCounts: filteredRowCounts,
    dominantColumnCount,
    isRegular,
    headerRowCount,
    maxRowSpan,
    maxColSpan,
  }
}

function collectMCIDs(obj: any, mcids: number[]): void {
  const kids = obj['/K']
  if (kids === undefined) return
  if (typeof kids === 'number') {
    mcids.push(kids)
    return
  }
  if (Array.isArray(kids)) {
    for (const kid of kids) {
      if (typeof kid === 'number') {
        mcids.push(kid)
      } else if (kid && typeof kid === 'object') {
        if (kid['/MCID'] !== undefined) {
          mcids.push(kid['/MCID'])
        }
        collectMCIDs(kid, mcids)
      }
    }
  }
}

function calculateTreeDepth(objects: any): number {
  let maxDepth = 0

  const measure = (node: any, depth: number): void => {
    if (depth > 50) return // safety limit
    maxDepth = Math.max(maxDepth, depth)
    const kids = node?.['/K']
    if (!kids) return
    if (Array.isArray(kids)) {
      for (const kid of kids) {
        if (typeof kid === 'string') {
          const child = resolveRef(kid, objects)
          if (child) measure(child, depth + 1)
        } else if (kid && typeof kid === 'object') {
          measure(kid, depth + 1)
        }
      }
    } else if (typeof kids === 'string') {
      const child = resolveRef(kids, objects)
      if (child) measure(child, depth + 1)
    }
  }

  for (const obj of Object.values(objects)) {
    if ((obj as any)?.['/Type'] === '/StructTreeRoot') {
      measure(obj, 0)
      break
    }
  }

  return maxDepth
}

function calculateTreeDepthFromRoot(root: any, objects: any): number {
  let maxDepth = 0
  const visited = new Set<string>()

  const measure = (node: any, depth: number): void => {
    if (depth > 50) return
    maxDepth = Math.max(maxDepth, depth)
    const kids = node?.['/K']
    if (!kids) return
    const kidList = Array.isArray(kids) ? kids : [kids]
    for (const kid of kidList) {
      if (typeof kid === 'number') continue // leaf MCID
      if (kid && typeof kid === 'object' && kid['/MCID'] !== undefined) continue // marked content ref
      if (typeof kid === 'string') {
        if (visited.has(kid)) continue
        visited.add(kid)
        const child = resolveRef(kid, objects)
        if (child) measure(child, depth + 1)
      } else if (kid && typeof kid === 'object') {
        measure(kid, depth + 1)
      }
    }
  }

  measure(root, 0)
  return maxDepth
}

/**
 * Walk the struct tree depth-first from `node` and collect per-page MCID pairs.
 * Each entry pushed to `out` is encoded as: pageIndex * 100_000 + mcid
 * so that disorder can be detected per-page (cross-page MCID resets don't cause
 * false positives). `inheritedPageRef` carries the /Pg from parent elements.
 */
function walkStructTreeForMCIDs(
  node: any,
  objects: any,
  pageRefToIndex: Map<string, number>,
  out: number[],
  inheritedPageRef: string | null,
): void {
  if (!node || typeof node !== 'object') return

  const nodePageRef: string | null = typeof node['/Pg'] === 'string' ? node['/Pg'] : inheritedPageRef
  const kids = node['/K']
  if (kids === undefined) return

  const kidList = Array.isArray(kids) ? kids : [kids]
  for (const kid of kidList) {
    if (typeof kid === 'number') {
      // Bare MCID integer
      const pageIdx = nodePageRef ? (pageRefToIndex.get(nodePageRef) ?? pageRefToIndex.get(`obj:${nodePageRef}`) ?? -1) : -1
      if (pageIdx >= 0) out.push(pageIdx * 100_000 + kid)
    } else if (kid && typeof kid === 'object') {
      if (kid['/MCID'] !== undefined) {
        // Marked content reference dict: { /Type /MCR, /Pg ..., /MCID N }
        const kidPage: string | null = typeof kid['/Pg'] === 'string' ? kid['/Pg'] : nodePageRef
        const pageIdx = kidPage ? (pageRefToIndex.get(kidPage) ?? pageRefToIndex.get(`obj:${kidPage}`) ?? -1) : -1
        if (pageIdx >= 0) out.push(pageIdx * 100_000 + kid['/MCID'])
      } else if (typeof kid === 'object' && kid['/S']) {
        // Inline struct element
        walkStructTreeForMCIDs(kid, objects, pageRefToIndex, out, nodePageRef)
      } else {
        walkStructTreeForMCIDs(kid, objects, pageRefToIndex, out, nodePageRef)
      }
    } else if (typeof kid === 'string') {
      // Ref to another struct element
      const child = resolveRef(kid, objects)
      if (child) walkStructTreeForMCIDs(child, objects, pageRefToIndex, out, nodePageRef)
    }
  }
}
