import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { renderPdfPageToDataUrl } from './pdfRenderService.js'

const execFileAsync = promisify(execFile)
const TESSERACT_BIN = process.env.TESSERACT_PATH || 'tesseract'
const QPDF_BIN = process.env.QPDF_PATH || 'qpdf'
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

async function renderPdfPagesToPngs(
  buffer: Buffer,
  outputDir: string,
  signal?: AbortSignal,
  onProgress?: (progress: { stage: string; percent: number }) => void,
): Promise<string[]> {
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
      // Render one page at a time and immediately write to disk — avoids holding all pages in memory
      const rendered = await renderPdfPageToDataUrl(page, { scale: OCR_RENDER_SCALE, format: 'png' })
      page.cleanup()
      const pngPath = path.join(outputDir, `${String(pageNumber).padStart(4, '0')}.png`)
      await fs.promises.writeFile(pngPath, rendered.buffer)
      // Release the rendered buffer immediately after writing
      ;(rendered as any).buffer = null
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

/**
 * Merge per-page OCR PDFs using qpdf as an external process.
 * This avoids loading all pages into Node's heap at once (which caused OOM crashes
 * on large scanned documents when using pdf-lib's in-process merge).
 */
async function mergePdfFilesViaQpdf(pdfPaths: string[], outputPath: string): Promise<void> {
  if (pdfPaths.length === 1) {
    await fs.promises.copyFile(pdfPaths[0], outputPath)
    return
  }
  // qpdf --empty --pages page1.pdf page2.pdf ... -- output.pdf
  const args = ['--empty', '--pages', ...pdfPaths, '--', outputPath]
  await execFileAsync(QPDF_BIN, args, {
    timeout: 300_000,
    windowsHide: true,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  })
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

  const tmpDir = process.env.TMP_DIR || os.tmpdir()
  const tmpRoot = await fs.promises.mkdtemp(path.join(tmpDir, 'pdf-ocr-'))
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
      // Delete the PNG immediately after OCR to free disk and reduce memory pressure
      try { await fs.promises.unlink(pngPath) } catch {}
      options?.onProgress?.({
        stage: `Running OCR ${index + 1} of ${pngPaths.length}`,
        percent: 40 + Math.round(((index + 1) / pngPaths.length) * 50),
      })
    }

    options?.onProgress?.({ stage: 'Merging OCR pages', percent: 93 })
    const mergedPath = path.join(tmpRoot, 'merged.pdf')
    // Merge via qpdf subprocess — keeps all PDF data out of Node's heap
    await mergePdfFilesViaQpdf(ocrPdfPaths, mergedPath)
    options?.onProgress?.({ stage: 'Merging OCR pages', percent: 97 })
    const result = await fs.promises.readFile(mergedPath)
    return result
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}
