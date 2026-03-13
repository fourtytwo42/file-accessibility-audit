import { createCanvas, loadImage } from '@napi-rs/canvas'

export async function renderPdfPageToDataUrl(page: any, options?: {
  scale?: number
  format?: 'png'
}): Promise<{
  width: number
  height: number
  buffer: Buffer
  dataUrl: string
}> {
  const scale = options?.scale || 1.5
  const format = options?.format || 'png'
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const context = canvas.getContext('2d')

  await page.render({
    canvasContext: context as any,
    viewport,
  }).promise

  const mimeType = format === 'png' ? 'image/png' : 'image/png'
  const buffer = canvas.toBuffer(mimeType)
  return {
    width: canvas.width,
    height: canvas.height,
    buffer,
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
  }
}

export async function renderPdfPageToPngDataUrl(page: any, scale = 1.5): Promise<{
  width: number
  height: number
  buffer: Buffer
  dataUrl: string
}> {
  return renderPdfPageToDataUrl(page, { scale, format: 'png' })
}

export async function cropDataUrlRegion(imageBuffer: Buffer, bbox: { x: number; y: number; width: number; height: number }): Promise<string | null> {
  const buffer = await cropPngRegionBuffer(imageBuffer, bbox)
  return buffer ? `data:image/png;base64,${buffer.toString('base64')}` : null
}

export async function cropPngRegionBuffer(imageBuffer: Buffer, bbox: { x: number; y: number; width: number; height: number }): Promise<Buffer | null> {
  if (bbox.width <= 0 || bbox.height <= 0) return null
  const image = await loadImage(imageBuffer)
  const cropWidth = Math.max(1, Math.round(image.width * bbox.width))
  const cropHeight = Math.max(1, Math.round(image.height * bbox.height))
  const cropX = Math.max(0, Math.round(image.width * bbox.x))
  const cropY = Math.max(0, Math.round(image.height * bbox.y))

  const canvas = createCanvas(cropWidth, cropHeight)
  const context = canvas.getContext('2d')
  context.drawImage(image as any, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
  return canvas.toBuffer('image/png')
}
