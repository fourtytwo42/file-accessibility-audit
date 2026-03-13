export interface PdfMetadata {
  creator: string | null
  producer: string | null
  creationDate: string | null
  modDate: string | null
  pdfVersion: string | null
  isEncrypted: boolean
  keywords: string | null
  author: string | null
  subject: string | null
  pageCount: number
}

export interface PdfjsResult {
  pageCount: number
  hasText: boolean
  textLength: number
  title: string | null
  author: string | null
  subject: string | null
  lang: string | null
  hasOutlines: boolean
  outlineCount: number
  links: Array<{ url: string; text: string }>
  imageCount: number
  metadata: PdfMetadata
  error: string | null
}

function isRawUrlLinkText(text: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(text.trim())
}

export function getLinkDisplayText(annotation: any, textItems: any[]): string {
  const annotationLabel = String(annotation?.contents || annotation?.contentsObj?.str || '').trim()
  if (annotationLabel && !isRawUrlLinkText(annotationLabel)) {
    return annotationLabel
  }
  const extracted = findLinkText(annotation, textItems)
  if (extracted) return extracted
  return String(annotation?.url || '')
}

export async function analyzeWithPdfjs(
  buffer: Buffer,
  options?: {
    signal?: AbortSignal
    onProgress?: (progress: { stage: string; percent: number }) => void
  },
): Promise<PdfjsResult> {
  // Dynamic import since pdfjs-dist is ESM-heavy
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')

  const result: PdfjsResult = {
    pageCount: 0,
    hasText: false,
    textLength: 0,
    title: null,
    author: null,
    subject: null,
    lang: null,
    hasOutlines: false,
    outlineCount: 0,
    links: [],
    imageCount: 0,
    metadata: {
      creator: null,
      producer: null,
      creationDate: null,
      modDate: null,
      pdfVersion: null,
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 0,
    },
    error: null,
  }

  try {
    const data = new Uint8Array(buffer)
    const doc = await pdfjsLib.getDocument({
      data,
      useSystemFonts: true,
      verbosity: 0, // Suppress harmless TrueType font warnings
    }).promise

    result.pageCount = doc.numPages

    // Metadata
    const metadata = await doc.getMetadata()
    const info = metadata?.info as any
    if (info) {
      result.title = info.Title || null
      result.author = info.Author || null
      result.subject = info.Subject || null
      result.lang = info.Language || null
      result.metadata.creator = info.Creator || null
      result.metadata.producer = info.Producer || null
      result.metadata.creationDate = parsePdfDate(info.CreationDate) || null
      result.metadata.modDate = parsePdfDate(info.ModDate) || null
      result.metadata.pdfVersion = info.PDFFormatVersion || null
      result.metadata.isEncrypted = !!info.IsEncrypted
      result.metadata.keywords = info.Keywords || null
      result.metadata.author = info.Author || null
      result.metadata.subject = info.Subject || null
    }
    result.metadata.pageCount = doc.numPages

    // Check if title looks like a filename (not useful for accessibility)
    if (result.title) {
      const t = result.title.toLowerCase()
      if (t.endsWith('.pdf') || t.endsWith('.docx') || /^[a-z0-9_-]+$/.test(t)) {
        result.title = null // Treat filename-like titles as absent
      }
    }

    // Outlines/bookmarks
    try {
      const outline = await doc.getOutline()
      if (outline && outline.length > 0) {
        result.hasOutlines = true
        result.outlineCount = outline.length
      }
    } catch {}

    // Extract text and links from all pages
    let totalText = ''
    for (let i = 1; i <= doc.numPages; i++) {
      if (options?.signal?.aborted) {
        const error = new Error('PDF.js cancelled') as any
        error.aborted = true
        throw error
      }
      const page = await doc.getPage(i)

      // Text content
      const textContent = await page.getTextContent()
      const pageText = textContent.items
        .map((item: any) => item.str || '')
        .join(' ')
      totalText += pageText + ' '

      // Link annotations
      try {
        const annotations = await page.getAnnotations()
        for (const annot of annotations) {
          if (annot.subtype === 'Link' && annot.url) {
            const linkText = getLinkDisplayText(annot, textContent.items)
            result.links.push({ url: annot.url, text: linkText })
          }
        }
      } catch {}

      if (doc.numPages > 0) {
        const percent = Math.max(0, Math.min(100, Math.round((i / doc.numPages) * 100)))
        options?.onProgress?.({
          stage: `Extracting page ${i} of ${doc.numPages}`,
          percent,
        })
      }
    }

    // Count images via operator list (fallback when QPDF can't detect them)
    const OPS = pdfjsLib.OPS as Record<string, number>
    const imageOps = new Set([OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintImageXObjectRepeat].filter(v => v !== undefined))
    let imageCount = 0
    for (let i = 1; i <= doc.numPages; i++) {
      if (options?.signal?.aborted) {
        const error = new Error('PDF.js cancelled') as any
        error.aborted = true
        throw error
      }
      const page = await doc.getPage(i)
      const ops = await page.getOperatorList()
      for (const fn of ops.fnArray) {
        if (imageOps.has(fn)) imageCount++
      }
    }
    result.imageCount = imageCount

    result.textLength = totalText.trim().length
    result.hasText = result.textLength > 50 // Minimum meaningful text

    await doc.destroy()
  } catch (err) {
    console.error('pdfjs-dist error:', err)
    result.error = 'pdfjs-dist parsing failed'
  }

  return result
}

function findLinkText(annot: any, textItems: any[]): string {
  if (!annot.rect || !textItems) return ''

  const [x1, y1, x2, y2] = annot.rect
  const matchingTexts: string[] = []

  for (const item of textItems) {
    if (!item.transform) continue
    const tx = item.transform[4]
    const ty = item.transform[5]

    // Check if text item overlaps with link rect (with some tolerance)
    if (tx >= x1 - 5 && tx <= x2 + 5 && ty >= y1 - 5 && ty <= y2 + 5) {
      if (item.str?.trim()) {
        matchingTexts.push(item.str.trim())
      }
    }
  }

  return matchingTexts.join(' ')
}

/** Parse PDF date strings like "D:20240115120000+05'30'" into ISO format */
function parsePdfDate(raw: string | undefined): string | null {
  if (!raw) return null
  // Strip the "D:" prefix and quotes
  const cleaned = raw.replace(/^D:/, '').replace(/'/g, '')
  // Format: YYYYMMDDHHmmSS(+|-)HH'mm'
  const match = cleaned.match(/^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/)
  if (!match) return raw // Return raw string if we can't parse
  const [, y, m = '01', d = '01', h = '00', min = '00', s = '00'] = match
  try {
    const date = new Date(`${y}-${m}-${d}T${h}:${min}:${s}Z`)
    return date.toISOString()
  } catch {
    return raw
  }
}
