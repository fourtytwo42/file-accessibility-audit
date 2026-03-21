import { PDFDocument } from 'pdf-lib'
import { chromium } from 'playwright'
import { cropPngRegionBuffer } from './pdfRenderService.js'
import type { DocumentModel, ReconstructionArtifacts } from './documentModel.js'
import { scopeCssToSelector } from './htmlPageService.js'
import { ensureDisplayDocTitle } from './pdfOutputFinalizer.js'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function parseBbox(raw: string | undefined): { x: number; y: number; width: number; height: number } | null {
  if (!raw) return null
  const parts = raw.split(',').map(part => Number(part.trim()))
  if (parts.length !== 4 || parts.some(value => !Number.isFinite(value))) return null
  const [x, y, width, height] = parts
  return { x, y, width, height }
}

async function materializePageHtml(pageHtml: string, pageNumber: number, artifacts: ReconstructionArtifacts): Promise<string> {
  const artifact = artifacts.pageImages.find(entry => entry.pageNumber === pageNumber)
  if (!artifact) return pageHtml

  let html = pageHtml.replace(/<img\b([^>]*)data-full-page="true"([^>]*)>/gi, (_match, before: string, after: string) => {
    const attrs = `${before} ${after}`.replace(/\sdata-full-page="true"/i, '')
    return `<img${attrs} src="${artifact.dataUrl}" />`
  })

  const matches = [...html.matchAll(/<img\b([^>]*)data-bbox="([^"]+)"([^>]*)>/gi)]
  for (const match of matches) {
    const bbox = parseBbox(match[2])
    if (!bbox) continue
    const cropped = await cropPngRegionBuffer(artifact.buffer, bbox)
    if (!cropped) continue
    const dataUrl = `data:image/png;base64,${cropped.toString('base64')}`
    const replacement = `<img${match[1]}${match[3]} src="${dataUrl}" />`
      .replace(/\sdata-bbox="[^"]+"/i, '')
      .replace(/\s{2,}/g, ' ')
    html = html.replace(match[0], replacement)
  }

  return html
}

export async function buildRebuiltHtml(input: {
  model: DocumentModel
  artifacts: ReconstructionArtifacts
}): Promise<string> {
  const pages = await Promise.all((input.model.pages || []).map(async page => {
    const fragmentClass = `page-fragment-${page.pageNumber}`
    const scopedCss = page.css ? scopeCssToSelector(page.css, `.${fragmentClass}`) : ''
    const html = await materializePageHtml(page.html, page.pageNumber, input.artifacts)

    return `
      <section class="page" style="width:${page.width}px;height:${page.height}px;">
        <div class="page-fragment ${fragmentClass}" data-page-number="${page.pageNumber}">
          ${scopedCss ? `<style>${scopedCss}</style>` : ''}
          ${html}
        </div>
      </section>
    `
  }))

  return `
    <!doctype html>
    <html lang="${escapeHtml(input.model.language || 'en')}">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(input.model.title || 'Accessible PDF')}</title>
        <style>
          @page { margin: 0; }
          html, body { margin: 0; padding: 0; background: transparent; font-family: "Segoe UI", Arial, sans-serif; color: #111827; }
          body { margin: 0; }
          .page {
            position: relative;
            overflow: hidden;
            page-break-after: always;
            break-after: page;
            background: transparent;
          }
          .page-fragment {
            box-sizing: border-box;
            width: 100%;
            height: 100%;
            padding: 36px 42px;
          }
          .page-fragment img {
            max-width: 100%;
            height: auto;
          }
          .page-fragment table {
            width: 100%;
            border-collapse: collapse;
          }
          .page-fragment th,
          .page-fragment td {
            border: 1px solid rgba(17, 24, 39, 0.25);
            padding: 0.35rem 0.45rem;
            vertical-align: top;
          }
          .page-fragment a {
            color: #0f4aa6;
            text-decoration: underline;
          }
          .page-fragment figure {
            margin: 0.5rem 0;
          }
        </style>
      </head>
      <body>
        ${pages.join('\n')}
      </body>
    </html>
  `
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true })
  } catch (error: any) {
    throw new Error(`Playwright Chromium is not available for rebuilt PDF generation. Install it with "pnpm --filter api exec playwright install chromium". ${error?.message || ''}`.trim())
  }
}

export async function buildRebuiltPdf(input: {
  model: DocumentModel
  artifacts: ReconstructionArtifacts
  signal?: AbortSignal
}): Promise<Buffer> {
  const browser = await launchBrowser()

  try {
    if (input.signal?.aborted) {
      const error = new Error('Rebuild cancelled') as Error & { aborted?: boolean }
      error.aborted = true
      throw error
    }

    const page = await browser.newPage()
    const html = await buildRebuiltHtml(input)
    await page.setContent(html, { waitUntil: 'load' })

    const session = await page.context().newCDPSession(page)
    const pdf = await session.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      generateTaggedPDF: true,
      generateDocumentOutline: true,
    }) as { data: string }

    await page.close()

    const pdfDoc = await PDFDocument.load(Buffer.from(pdf.data, 'base64'), { ignoreEncryption: true })
    pdfDoc.setTitle(input.model.title || 'Accessible PDF', { showInWindowTitleBar: true })
    pdfDoc.setLanguage(input.model.language || 'en')
    return ensureDisplayDocTitle(Buffer.from(await pdfDoc.save()))
  } finally {
    await browser.close()
  }
}
