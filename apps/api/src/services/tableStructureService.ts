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

export interface TableStructureResult {
  status: 'ok' | 'unavailable' | 'timeout' | 'error'
  detectedTables: number | null
  taggedTables: number
  untaggedTables: number | null
  highConfidenceUntaggedTables?: number | null
  advisoryUntaggedTables?: number | null
  tableDetails: Array<{
    tableIndex: number
    rows: number
    cols: number
    confidence?: 'high' | 'low'
  }>
  warnings: string[]
}

export async function analyzeTableStructure(
  buffer: Buffer,
  taggedTableCount: number,
  options?: { signal?: AbortSignal },
): Promise<TableStructureResult> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-table-struct-'))
  const inputPath = path.join(tmpRoot, `${randomUUID()}.pdf`)
  const requestPath = path.join(tmpRoot, `${randomUUID()}.json`)

  try {
    await fs.promises.writeFile(inputPath, buffer)
    await fs.promises.writeFile(requestPath, JSON.stringify({
      operation: 'analyze_table_structure',
      taggedTableCount,
    }))

    const { stdout } = await execFileAsync(PYTHON_BIN, [
      EXTRAS_SCRIPT,
      '--input', inputPath,
      '--request', requestPath,
    ], {
      timeout: ANALYSIS.TABLE_STRUCTURE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
      windowsHide: true,
      signal: options?.signal,
    })

    const raw = JSON.parse(stdout.trim()) as any

    if (raw.status === 'unavailable') {
      return {
        status: 'unavailable',
        detectedTables: null,
        taggedTables: taggedTableCount,
        untaggedTables: null,
        highConfidenceUntaggedTables: null,
        advisoryUntaggedTables: null,
        tableDetails: [],
        warnings: raw.warnings ?? [],
      }
    }
    if (raw.status !== 'ok') {
      return {
        status: raw.status === 'timeout' ? 'timeout' : 'error',
        detectedTables: null,
        taggedTables: taggedTableCount,
        untaggedTables: null,
        highConfidenceUntaggedTables: null,
        advisoryUntaggedTables: null,
        tableDetails: [],
        warnings: raw.warnings ?? [],
      }
    }

    return {
      status: 'ok',
      detectedTables: raw.detected_tables ?? null,
      taggedTables: raw.tagged_tables ?? taggedTableCount,
      untaggedTables: raw.untagged_tables ?? null,
      highConfidenceUntaggedTables: raw.high_confidence_untagged_tables ?? raw.untagged_tables ?? null,
      advisoryUntaggedTables: raw.advisory_untagged_tables ?? 0,
      tableDetails: (raw.table_details ?? []).map((t: any) => ({
        tableIndex: t.table_index,
        rows: t.rows,
        cols: t.cols,
        confidence: t.confidence === 'low' ? 'low' : 'high',
      })),
      warnings: raw.warnings ?? [],
    }
  } catch (err: any) {
    if (err.name === 'AbortError' || options?.signal?.aborted) {
      const e = new Error('Table structure analysis cancelled') as any
      e.aborted = true
      throw e
    }
    if (err?.killed || err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT') {
      return {
        status: 'timeout',
        detectedTables: null,
        taggedTables: taggedTableCount,
        untaggedTables: null,
        highConfidenceUntaggedTables: null,
        advisoryUntaggedTables: null,
        tableDetails: [],
        warnings: ['Table structure analysis timed out.'],
      }
    }
    return {
      status: 'error',
      detectedTables: null,
      taggedTables: taggedTableCount,
      untaggedTables: null,
      highConfidenceUntaggedTables: null,
      advisoryUntaggedTables: null,
      tableDetails: [],
      warnings: [err?.message ?? 'Unknown error'],
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}
