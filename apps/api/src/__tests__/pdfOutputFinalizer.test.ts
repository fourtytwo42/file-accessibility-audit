import { describe, expect, it } from 'vitest'
import { PDFBool, PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { ensureDisplayDocTitle } from '../services/pdfOutputFinalizer.js'

describe('ensureDisplayDocTitle', () => {
  it('forces ViewerPreferences /DisplayDocTitle to true on rebuilt PDFs', async () => {
    const pdfDoc = await PDFDocument.create()
    pdfDoc.addPage([300, 300])
    pdfDoc.setTitle('Finalized PDF')
    const input = Buffer.from(await pdfDoc.save())

    const output = await ensureDisplayDocTitle(input)
    const nextDoc = await PDFDocument.load(output, { ignoreEncryption: true })
    const viewerPreferences = nextDoc.catalog.lookup(PDFName.of('ViewerPreferences'), PDFDict)
    const displayDocTitle = viewerPreferences?.get(PDFName.of('DisplayDocTitle'))

    expect(displayDocTitle).toBe(PDFBool.True)
  })
})
