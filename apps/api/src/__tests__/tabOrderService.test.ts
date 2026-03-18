import { describe, expect, it } from 'vitest'
import { PDFArray, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { analyzeTabOrder } from '../services/tabOrderService.js'

async function makePdfWithOutOfOrderLinks(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Top link', { x: 72, y: 720, size: 12, font })
  page.drawText('Bottom link', { x: 72, y: 640, size: 12, font })
  const topAction = doc.context.obj({
    S: PDFName.of('URI'),
    URI: PDFString.of('https://example.com/top'),
  })
  const bottomAction = doc.context.obj({
    S: PDFName.of('URI'),
    URI: PDFString.of('https://example.com/bottom'),
  })
  const topAnnot = doc.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Link'),
    Rect: [72, 716, 140, 732],
    Border: [0, 0, 0],
    A: topAction,
  })
  const bottomAnnot = doc.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Link'),
    Rect: [72, 636, 160, 652],
    Border: [0, 0, 0],
    A: bottomAction,
  })
  page.node.set(PDFName.of('Annots'), doc.context.obj([bottomAnnot, topAnnot]))
  return Buffer.from(await doc.save())
}

describe('analyzeTabOrder', () => {
  it('detects missing /Tabs /S on tagged or annotated pages', async () => {
    const buffer = await makePdfWithOutOfOrderLinks()
    const result = await analyzeTabOrder(buffer, { isTagged: true })

    expect(result.status).toBe('ok')
    expect(result.missingTabsCount).toBe(1)
    expect(result.issues.some(issue => issue.reason === 'missing_tabs_s')).toBe(true)
  })

  it('detects out-of-order annotations', async () => {
    const buffer = await makePdfWithOutOfOrderLinks()
    const result = await analyzeTabOrder(buffer)

    expect(result.status).toBe('ok')
    expect(result.outOfOrderPageCount).toBe(1)
    expect(result.issues.some(issue => issue.reason === 'annotation_order')).toBe(true)
  })

  it('passes after tabs and annotation order are normalized', async () => {
    const buffer = await makePdfWithOutOfOrderLinks()
    const nextDoc = await PDFDocument.load(buffer, { ignoreEncryption: true })
    const page = nextDoc.getPage(0)
    page.node.set(PDFName.of('Tabs'), PDFName.of('S'))
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    page.node.set(PDFName.of('Annots'), nextDoc.context.obj([annots!.get(1), annots!.get(0)]))

    const result = await analyzeTabOrder(Buffer.from(await nextDoc.save()))

    expect(result.status).toBe('ok')
    expect(result.missingTabsCount).toBe(0)
    expect(result.outOfOrderPageCount).toBe(0)
  })
})
