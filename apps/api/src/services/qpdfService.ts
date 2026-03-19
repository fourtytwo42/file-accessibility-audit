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
  hasLang: boolean
  lang: string | null
  hasOutlines: boolean
  outlineCount: number
  outlineTitles: string[]
  hasAcroForm: boolean
  formFields: Array<{ hasTU: boolean; name?: string }>
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
        hasLang: false,
        lang: null,
        hasOutlines: false,
        outlineCount: 0,
        outlineTitles: [],
        hasAcroForm: false,
        formFields: [],
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
      hasLang: false,
      lang: null,
      hasOutlines: false,
      outlineCount: 0,
      outlineTitles: [],
      hasAcroForm: false,
      formFields: [],
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
    hasLang: false,
    lang: null,
    hasOutlines: false,
    outlineCount: 0,
    outlineTitles: [],
    hasAcroForm: false,
    formFields: [],
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

    // QPDF v2 JSON wraps objects as { value: {...}, stream?: {...} }
    // Normalize so we always work with the inner value.
    const objects: Record<string, any> = {}
    for (const [ref, raw] of Object.entries(rawObjects)) {
      if (!raw || typeof raw !== 'object') continue
      objects[ref] = (raw as any).value ?? raw
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
        // /MarkInfo /Marked = true means the document is a Tagged PDF
        const markInfo = o['/MarkInfo']
        if (markInfo) {
          const marked = typeof markInfo === 'object' ? markInfo['/Marked'] : null
          if (marked === true || marked === 'true') result.isTagged = true
        }
      }

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
        }
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
