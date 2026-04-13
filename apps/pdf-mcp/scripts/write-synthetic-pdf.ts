import fs from 'node:fs'
import { PDFDocument } from 'pdf-lib'

async function main() {
  const doc = await PDFDocument.create()
  const p = doc.addPage([400, 400])
  p.drawText('Hello accessible world', { x: 50, y: 350, size: 14 })
  const b = await doc.save()
  const out = process.argv[2] || '/home/hendo420/pdfaf/ICJIA-PDFs/staging/synthetic-hello.pdf'
  fs.writeFileSync(out, Buffer.from(b))
  console.log('wrote', out)
}

main().catch(console.error)
