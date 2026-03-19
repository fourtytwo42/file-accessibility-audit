import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib'

export interface TabOrderIssue {
  page: number
  reason: 'missing_tabs_s' | 'annotation_order'
  details: string
}

export interface TabOrderResult {
  status: 'ok' | 'error'
  pagesAnalyzed: number
  annotatedPageCount: number
  missingTabsCount: number
  outOfOrderPageCount: number
  issues: TabOrderIssue[]
  warnings: string[]
}

function decodePdfNumber(value: unknown): number | null {
  if (value instanceof PDFNumber) return value.asNumber()
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function annotationIsInvisible(annotation: PDFDict): boolean {
  const flags = annotation.lookupMaybe(PDFName.of('F'), PDFNumber)
  const numeric = decodePdfNumber(flags)
  if (!Number.isFinite(numeric)) return false
  return Boolean((numeric! & 1) || (numeric! & 2) || (numeric! & 32))
}

function annotationSortKey(annotation: PDFDict): [number, number] {
  const rect = annotation.lookupMaybe(PDFName.of('Rect'), PDFArray)
  if (!(rect instanceof PDFArray) || rect.size() !== 4) return [0, 0]
  const values = [0, 1, 2, 3].map(index => decodePdfNumber(rect.get(index)))
  if (values.some(value => value === null)) return [0, 0]
  const [x0, y0, x1, y1] = values as number[]
  return [-Math.max(y0, y1), Math.min(x0, x1)]
}

function compareAnnotationOrder(a: PDFDict, b: PDFDict): number {
  const [topA, leftA] = annotationSortKey(a)
  const [topB, leftB] = annotationSortKey(b)
  return (topA - topB) || (leftA - leftB)
}

export async function analyzeTabOrder(
  buffer: Buffer,
  options?: { isTagged?: boolean },
): Promise<TabOrderResult> {
  try {
    const pdfDoc = await PDFDocument.load(buffer, {
      updateMetadata: false,
      ignoreEncryption: true,
    })

    const pages = pdfDoc.getPages()
    const issues: TabOrderIssue[] = []
    let annotatedPageCount = 0
    let missingTabsCount = 0
    let outOfOrderPageCount = 0

    for (const [index, page] of pages.entries()) {
      const pageNumber = index + 1
      const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
      const visibleAnnotations: PDFDict[] = []

      if (annots instanceof PDFArray) {
        for (let annotIndex = 0; annotIndex < annots.size(); annotIndex++) {
          const annotation = pdfDoc.context.lookup(annots.get(annotIndex), PDFDict)
          if (!(annotation instanceof PDFDict)) continue
          if (String(annotation.get(PDFName.of('Subtype')) || '') === '/Popup') continue
          if (annotationIsInvisible(annotation)) continue
          visibleAnnotations.push(annotation)
        }
      }

      if (visibleAnnotations.length > 0) annotatedPageCount += 1

      const pageRequiresTabs = visibleAnnotations.length > 0 || Boolean(options?.isTagged)
      const tabs = page.node.get(PDFName.of('Tabs'))
      if (pageRequiresTabs && String(tabs || '') !== '/S') {
        missingTabsCount += 1
        issues.push({
          page: pageNumber,
          reason: 'missing_tabs_s',
          details: `Page ${pageNumber} is missing /Tabs /S.`,
        })
      }

      if (visibleAnnotations.length > 1) {
        const sorted = [...visibleAnnotations].sort(compareAnnotationOrder)
        const matches = visibleAnnotations.every((annotation, annotIndex) => annotation === sorted[annotIndex])
        if (!matches) {
          outOfOrderPageCount += 1
          issues.push({
            page: pageNumber,
            reason: 'annotation_order',
            details: `Page ${pageNumber} annotations are not ordered top-to-bottom, left-to-right.`,
          })
        }
      }
    }

    return {
      status: 'ok',
      pagesAnalyzed: pages.length,
      annotatedPageCount,
      missingTabsCount,
      outOfOrderPageCount,
      issues,
      warnings: [],
    }
  } catch (error: any) {
    return {
      status: 'error',
      pagesAnalyzed: 0,
      annotatedPageCount: 0,
      missingTabsCount: 0,
      outOfOrderPageCount: 0,
      issues: [],
      warnings: [error?.message || 'Tab order analysis failed.'],
    }
  }
}
