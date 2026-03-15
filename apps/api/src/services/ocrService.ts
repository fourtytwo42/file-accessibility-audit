import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import { renderPdfPageToDataUrl } from './pdfRenderService.js'

const execFileAsync = promisify(execFile)
const TESSERACT_BIN = process.env.TESSERACT_PATH || 'tesseract'
const OCR_LANGUAGE = process.env.OCR_LANGUAGE || 'eng'
const OCR_RENDER_SCALE = Number(process.env.OCR_RENDER_SCALE || 2)

let cachedAvailability: boolean | null = null

async function pdfjsLib() {
  return import('pdfjs-dist/legacy/build/pdf.mjs')
}

export async function isOcrAvailable(): Promise<boolean> {
  if (cachedAvailability !== null) return cachedAvailability
  try {
    await execFileAsync(TESSERACT_BIN, ['--version'], {
      timeout: 10_000,
      windowsHide: true,
      encoding: 'utf-8',
    })
    cachedAvailability = true
  } catch {
    cachedAvailability = false
  }
  return cachedAvailability
}

async function renderPdfPagesToPngs(buffer: Buffer, outputDir: string, signal?: AbortSignal, onProgress?: (progress: { stage: string; percent: number }) => void) {
  const pdfjs = await pdfjsLib()
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, verbosity: 0 }).promise
  const files: string[] = []
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      if (signal?.aborted) {
        const error = new Error('OCR cancelled') as Error & { aborted?: boolean }
        error.aborted = true
        throw error
      }
      const page = await doc.getPage(pageNumber)
      const rendered = await renderPdfPageToDataUrl(page, { scale: OCR_RENDER_SCALE, format: 'png' })
      const pngPath = path.join(outputDir, `${String(pageNumber).padStart(4, '0')}.png`)
      await fs.promises.writeFile(pngPath, rendered.buffer)
      files.push(pngPath)
      onProgress?.({
        stage: `Rendering OCR page ${pageNumber} of ${doc.numPages}`,
        percent: Math.round((pageNumber / doc.numPages) * 40),
      })
    }
  } finally {
    await doc.destroy()
  }
  return files
}

async function runTesseractPdf(inputPngPath: string, outputBasePath: string, signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error('OCR cancelled') as Error & { aborted?: boolean }
    error.aborted = true
    throw error
  }
  await execFileAsync(TESSERACT_BIN, [
    inputPngPath,
    outputBasePath,
    '-l',
    OCR_LANGUAGE,
    '--dpi',
    '300',
    'pdf',
    'quiet',
  ], {
    timeout: 300_000,
    windowsHide: true,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  })
  return `${outputBasePath}.pdf`
}

async function mergePdfFiles(pdfPaths: string[]): Promise<Buffer> {
  const merged = await PDFDocument.create()
  for (const pdfPath of pdfPaths) {
    const bytes = await fs.promises.readFile(pdfPath)
    const source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    const pages = await merged.copyPages(source, source.getPageIndices())
    for (const page of pages) merged.addPage(page)
  }
  return Buffer.from(await merged.save())
}

export async function ocrPdfToSearchablePdf(
  buffer: Buffer,
  options?: {
    signal?: AbortSignal
    onProgress?: (progress: { stage: string; percent: number }) => void
  },
): Promise<Buffer> {
  if (!await isOcrAvailable()) {
    throw new Error('Tesseract OCR is not available.')
  }

  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pdf-ocr-'))
  try {
    const pngDir = path.join(tmpRoot, 'pages')
    const pdfDir = path.join(tmpRoot, 'ocr')
    await fs.promises.mkdir(pngDir, { recursive: true })
    await fs.promises.mkdir(pdfDir, { recursive: true })

    const pngPaths = await renderPdfPagesToPngs(buffer, pngDir, options?.signal, options?.onProgress)
    const ocrPdfPaths: string[] = []

    for (let index = 0; index < pngPaths.length; index++) {
      const pngPath = pngPaths[index]
      const outputBasePath = path.join(pdfDir, path.basename(pngPath, '.png'))
      const ocrPdfPath = await runTesseractPdf(pngPath, outputBasePath, options?.signal)
      ocrPdfPaths.push(ocrPdfPath)
      options?.onProgress?.({
        stage: `Running OCR ${index + 1} of ${pngPaths.length}`,
        percent: 40 + Math.round(((index + 1) / pngPaths.length) * 50),
      })
    }

    const merged = await mergePdfFiles(ocrPdfPaths)
    options?.onProgress?.({ stage: 'Merging OCR pages', percent: 95 })
    return merged
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}
