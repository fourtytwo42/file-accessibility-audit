import { PDFBool, PDFDict, PDFDocument, PDFName } from 'pdf-lib'

export async function ensureDisplayDocTitle(buffer: Buffer): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(buffer, {
    updateMetadata: false,
    ignoreEncryption: true,
  })
  const viewerPreferencesRef = pdfDoc.catalog.get(PDFName.of('ViewerPreferences'))
  const viewerPreferences = viewerPreferencesRef
    ? pdfDoc.catalog.lookup(PDFName.of('ViewerPreferences'), PDFDict)
    : pdfDoc.context.obj({})
  const displayDocTitle = viewerPreferences.get(PDFName.of('DisplayDocTitle'))
  if (displayDocTitle === PDFBool.True) return buffer
  viewerPreferences.set(PDFName.of('DisplayDocTitle'), PDFBool.True)
  pdfDoc.catalog.set(PDFName.of('ViewerPreferences'), viewerPreferences)
  return Buffer.from(await pdfDoc.save())
}
