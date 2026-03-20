import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ANALYSIS } from '#config'

const execFileAsync = promisify(execFile)
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
  fontsMissingToUnicode?: number
  type1FontsMissingToUnicode?: number
  cidFontsMissingCidToGidMap?: number
  cidSetRiskFontCount?: number
  cidSetExplicitFontCount?: number
  legacyWidthRiskFontCount?: number
  noteTagCount?: number
  noteTagsMissingId?: number
  linkAnnotationCount?: number
  linkAnnotationsMissingContents?: number
  images: Array<{ ref: string; hasAlt: boolean; altText?: string }>
  headings: Array<{ level: string; tag: string }>
  tables: Array<{ hasHeaders: boolean }>
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

    const { stdout } = await execFileAsync(QPDF_BIN, ['--json', tmpPath], {
      timeout: ANALYSIS.QPDF_TIMEOUT_MS,
      maxBuffer: ANALYSIS.QPDF_MAX_BUFFER,
      encoding: 'utf-8',
      signal: options?.signal,
      windowsHide: true,
    })

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
        fontsMissingToUnicode: 0,
        type1FontsMissingToUnicode: 0,
        cidFontsMissingCidToGidMap: 0,
        cidSetRiskFontCount: 0,
        cidSetExplicitFontCount: 0,
        legacyWidthRiskFontCount: 0,
        noteTagCount: 0,
        noteTagsMissingId: 0,
        linkAnnotationCount: 0,
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
      fontsMissingToUnicode: 0,
      type1FontsMissingToUnicode: 0,
      cidFontsMissingCidToGidMap: 0,
      cidSetRiskFontCount: 0,
      cidSetExplicitFontCount: 0,
      legacyWidthRiskFontCount: 0,
      noteTagCount: 0,
      noteTagsMissingId: 0,
      linkAnnotationCount: 0,
      linkAnnotationsMissingContents: 0,
      images: [],
      headings: [],
      tables: [],
      structTreeDepth: 0,
      contentOrder: [],
      annotationCount: 0,
      error: 'QPDF parsing failed',
    }
  } finally {
    try { fs.unlinkSync(tmpPath) } catch {}
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
    fontsMissingToUnicode: 0,
    type1FontsMissingToUnicode: 0,
    cidFontsMissingCidToGidMap: 0,
    cidSetRiskFontCount: 0,
    cidSetExplicitFontCount: 0,
    legacyWidthRiskFontCount: 0,
    noteTagCount: 0,
    noteTagsMissingId: 0,
    linkAnnotationCount: 0,
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
    const descendantFontRefs = new Set<string>()
    for (const obj of Object.values(objects)) {
      if (!obj || typeof obj !== 'object' || obj['/Type'] !== '/StructTreeRoot') continue
      const resolvedRoleMap = resolveObject(obj['/RoleMap'], objects)
      if (!resolvedRoleMap || typeof resolvedRoleMap !== 'object') continue
      for (const [tag, mapped] of Object.entries(resolvedRoleMap)) {
        if (mapped === '/Note' && typeof tag === 'string') {
          roleMapNoteAliases.add(tag)
        }
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

      // Image XObjects
      if (o['/Subtype'] === '/Image' || o['/Subtype'] === '/Form') {
        if (o['/Subtype'] === '/Image') {
          result.images.push({ ref, hasAlt: false })
        }
      }

      // Structure elements (headings, tables, figures with alt)
      if (o['/S']) {
        const tag = o['/S']
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
        // Headings
        if (tag === '/H' || tag === '/H1' || tag === '/H2' || tag === '/H3' ||
            tag === '/H4' || tag === '/H5' || tag === '/H6') {
          result.headings.push({ level: tag.replace('/', ''), tag })
        }
        // Tables
        if (tag === '/Table') {
          const hasHeaders = hasTableHeaders(o, objects)
          result.tables.push({ hasHeaders })
        }
        // Figures with alt text
        if (tag === '/Figure') {
          const rawAlt = o['/Alt']
          const altText = typeof rawAlt === 'string' ? rawAlt.replace(/^u:/, '') : undefined
          const hasAlt = altText !== undefined && altText !== ''
          const hasAssociatedContent = structElemHasAssociatedContent(o, objects)
          // Try to match to an image
          if (result.images.length > 0 && hasAlt && hasAssociatedContent) {
            const unmatched = result.images.find(img => !img.hasAlt)
            if (unmatched) {
              unmatched.hasAlt = true
              unmatched.altText = altText
            }
          }
          // Only count figures with real associated content. Empty /Figure elements with /Alt
          // are Adobe "Associated with content" failures and must not satisfy alt-text scoring.
          if (hasAssociatedContent && !result.images.some(img => img.ref === ref)) {
            result.images.push({ ref, hasAlt, altText })
          }
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

      if (isFontObject(o) && !descendantFontRefs.has(ref)) {
        result.fontCount = (result.fontCount ?? 0) + 1
        if (!fontHasEmbeddedProgram(o, objects)) result.unembeddedFontCount = (result.unembeddedFontCount ?? 0) + 1
        const missingToUnicode = !fontHasToUnicode(o, objects)
        if (missingToUnicode) {
          result.fontsMissingToUnicode = (result.fontsMissingToUnicode ?? 0) + 1
          const subtype = String(o['/Subtype'] || '')
          if (subtype === '/Type1' || subtype === '/Type3') {
            result.type1FontsMissingToUnicode = (result.type1FontsMissingToUnicode ?? 0) + 1
          }
        }
        if (fontMissingCidToGidMap(o, objects)) result.cidFontsMissingCidToGidMap = (result.cidFontsMissingCidToGidMap ?? 0) + 1
        if (fontHasLegacyWidthRisk(o, objects)) result.legacyWidthRiskFontCount = (result.legacyWidthRiskFontCount ?? 0) + 1
      }
    }

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

    const cidSetSignals = collectCidSetSignals(objects)
    result.cidSetRiskFontCount = cidSetSignals.riskCount
    result.cidSetExplicitFontCount = cidSetSignals.explicitCount

  } catch (err) {
    console.error('QPDF JSON parse error:', err)
    result.error = 'Failed to parse QPDF structure data'
  }

  return result
}

// Resolve a ref like "9 0 R" to its object, trying both "obj:9 0 R" and "9 0 R" key formats
function resolveRef(ref: string, objects: any): any {
  if (!ref || typeof ref !== 'string') return null
  return objects[ref] ?? objects[`obj:${ref}`] ?? null
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
