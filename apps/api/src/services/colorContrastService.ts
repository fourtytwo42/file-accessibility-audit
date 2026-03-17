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
const EXTRAS_SCRIPT = path.resolve(moduleDir, '../../scripts/pdf_accessibility_extras.py')

export interface ContrastFailure {
  page: number
  textPreview: string
  contrastRatio: number
  threshold: number
  fgColor: string
  bgColor: string
  fontSizePt: number
}

export interface ColorContrastResult {
  status: 'ok' | 'unavailable' | 'timeout' | 'error'
  pagesAnalyzed: number
  totalSamples: number
  failingContrastCount: number
  failRatio: number | null
  failures: ContrastFailure[]
  warnings: string[]
}

export async function analyzeColorContrast(
  buffer: Buffer,
  options?: { signal?: AbortSignal },
): Promise<ColorContrastResult> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-contrast-'))
  const inputPath = path.join(tmpRoot, `${randomUUID()}.pdf`)
  const requestPath = path.join(tmpRoot, `${randomUUID()}.json`)

  try {
    await fs.promises.writeFile(inputPath, buffer)
    await fs.promises.writeFile(requestPath, JSON.stringify({
      operation: 'analyze_color_contrast',
      maxPages: ANALYSIS.COLOR_CONTRAST_MAX_PAGES,
    }))

    const { stdout } = await execFileAsync(PYTHON_BIN, [
      EXTRAS_SCRIPT,
      '--input', inputPath,
      '--request', requestPath,
    ], {
      timeout: ANALYSIS.COLOR_CONTRAST_TIMEOUT_MS,
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
        totalSamples: 0,
        failingContrastCount: 0,
        failRatio: null,
        failures: [],
        warnings: raw.warnings ?? [],
      }
    }
    if (raw.status === 'timeout') {
      return {
        status: 'timeout',
        pagesAnalyzed: 0,
        totalSamples: 0,
        failingContrastCount: 0,
        failRatio: null,
        failures: [],
        warnings: [],
      }
    }
    if (raw.status !== 'ok') {
      return {
        status: 'error',
        pagesAnalyzed: 0,
        totalSamples: 0,
        failingContrastCount: 0,
        failRatio: null,
        failures: [],
        warnings: raw.warnings ?? [],
      }
    }

    return {
      status: 'ok',
      pagesAnalyzed: raw.pages_analyzed ?? 0,
      totalSamples: raw.total_samples ?? 0,
      failingContrastCount: raw.failing_contrast_count ?? 0,
      failRatio: raw.fail_ratio ?? null,
      failures: (raw.failures ?? []).map((f: any) => ({
        page: f.page,
        textPreview: f.text_preview,
        contrastRatio: f.contrast_ratio,
        threshold: f.threshold,
        fgColor: f.fg_color,
        bgColor: f.bg_color,
        fontSizePt: f.font_size_pt ?? 0,
      })),
      warnings: raw.warnings ?? [],
    }
  } catch (err: any) {
    if (err.name === 'AbortError' || options?.signal?.aborted) {
      const e = new Error('Color contrast analysis cancelled') as any
      e.aborted = true
      throw e
    }
    if (err?.killed || err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT') {
      return {
        status: 'timeout',
        pagesAnalyzed: 0,
        totalSamples: 0,
        failingContrastCount: 0,
        failRatio: null,
        failures: [],
        warnings: ['Color contrast analysis timed out.'],
      }
    }
    return {
      status: 'error',
      pagesAnalyzed: 0,
      totalSamples: 0,
      failingContrastCount: 0,
      failRatio: null,
      failures: [],
      warnings: [err?.message ?? 'Unknown error'],
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}
