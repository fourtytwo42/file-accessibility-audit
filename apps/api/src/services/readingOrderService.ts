import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { ANALYSIS } from '#config'

const execFileAsync = promisify(execFile)
const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const apiRoot = path.resolve(moduleDir, '../..')
dotenv.config({ path: path.resolve(apiRoot, '.env'), override: false })
dotenv.config({ path: path.resolve(apiRoot, '../../.env'), override: false })
const PYTHON_BIN = process.env.PYTHON_PATH || 'python'
const HELPER_PATH = path.resolve(moduleDir, '../../scripts/pdf_structure_helper.py')

export interface ReadingOrderResult {
  status: 'ok' | 'unavailable' | 'timeout' | 'error'
  pagesAnalyzed: number
  totalBlocks: number
  disorderRatio: number | null
  disorderedBlockCount: number
  disorderedBlocks: Array<{
    page: number
    streamRank: number
    visualRank: number
    textPreview: string
  }>
  warnings: string[]
}

export async function analyzeReadingOrder(
  buffer: Buffer,
  options?: { signal?: AbortSignal },
): Promise<ReadingOrderResult> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-reading-order-'))
  const inputPath = path.join(tmpRoot, `${randomUUID()}.pdf`)
  const requestPath = path.join(tmpRoot, `${randomUUID()}.json`)
  // --output is required by the script argument parser; pass a dummy path
  const outputPath = path.join(tmpRoot, `${randomUUID()}.pdf`)

  try {
    await fs.promises.writeFile(inputPath, buffer)
    await fs.promises.writeFile(requestPath, JSON.stringify({
      operation: 'analyze_reading_order_pdfminer',
      maxPages: ANALYSIS.PDFMINER_MAX_PAGES,
    }))

    const { stdout, stderr } = await execFileAsync(PYTHON_BIN, [
      HELPER_PATH,
      '--input', inputPath,
      '--request', requestPath,
      '--output', outputPath,
    ], {
      timeout: ANALYSIS.PDFMINER_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
      windowsHide: true,
      signal: options?.signal,
    })

    const raw = JSON.parse(stdout.trim()) as any

    if (raw.status === 'unavailable') {
      return {
        status: 'unavailable',
        pagesAnalyzed: 0,
        totalBlocks: 0,
        disorderRatio: null,
        disorderedBlockCount: 0,
        disorderedBlocks: [],
        warnings: raw.warnings ?? [],
      }
    }
    if (raw.status === 'error') {
      return {
        status: 'error',
        pagesAnalyzed: 0,
        totalBlocks: 0,
        disorderRatio: null,
        disorderedBlockCount: 0,
        disorderedBlocks: [],
        warnings: raw.warnings ?? [],
      }
    }

    return {
      status: 'ok',
      pagesAnalyzed: raw.pages_analyzed ?? 0,
      totalBlocks: raw.total_blocks ?? 0,
      disorderRatio: raw.disorder_ratio ?? null,
      disorderedBlockCount: raw.disordered_block_count ?? 0,
      disorderedBlocks: (raw.disordered_blocks ?? []).map((b: any) => ({
        page: b.page,
        streamRank: b.stream_rank,
        visualRank: b.visual_rank,
        textPreview: b.text_preview,
      })),
      warnings: raw.warnings ?? [],
    }
  } catch (error: any) {
    if (error?.killed || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT') {
      return {
        status: 'timeout',
        pagesAnalyzed: 0,
        totalBlocks: 0,
        disorderRatio: null,
        disorderedBlockCount: 0,
        disorderedBlocks: [],
        warnings: ['Reading order analysis timed out.'],
      }
    }
    return {
      status: 'error',
      pagesAnalyzed: 0,
      totalBlocks: 0,
      disorderRatio: null,
      disorderedBlockCount: 0,
      disorderedBlocks: [],
      warnings: [error?.message || 'Reading order analysis failed.'],
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}
