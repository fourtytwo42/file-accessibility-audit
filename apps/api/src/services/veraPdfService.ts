import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ANALYSIS } from '#config'

const execFileAsync = promisify(execFile)
const TMP_DIR = process.env.TMP_DIR || os.tmpdir()

const VERA_PDF_BIN = process.env.VERAPDF_PATH || (() => {
  const candidates = [
    'C:/Users/Hendo420/veraPDF/verapdf.bat',
    'C:/Program Files/veraPDF/veraPDF CLI/verapdf.bat',
    'C:/Program Files/veraPDF/veraPDF Software/verapdf.bat',
    'C:/Program Files/veraPDF/verapdf.bat',
    '/opt/homebrew/bin/verapdf',
    '/usr/local/bin/verapdf',
  ]
  return candidates.find(candidate => fs.existsSync(candidate)) || 'verapdf'
})()

function veraPdfChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (env.JAVACMD) return env

  const javaCandidates = [
    'C:/Program Files/Eclipse Adoptium/jre-17.0.18.8-hotspot/bin/java.exe',
    'C:/Program Files/Eclipse Adoptium/jre-17/bin/java.exe',
    'C:/Program Files/Java/jre/bin/java.exe',
    'C:/Program Files/Java/bin/java.exe',
  ]
  const detectedJava = javaCandidates.find(candidate => fs.existsSync(candidate))
  if (detectedJava) {
    env.JAVACMD = detectedJava
  }
  return env
}

export type VeraPdfExecutionStatus = 'ok' | 'timeout' | 'missing_binary' | 'parse_error' | 'error'
export type VeraPdfStatus = 'passed' | 'failed' | 'unavailable' | 'timeout' | 'parse_error' | 'error'

export interface VeraPdfFailure {
  ruleId: string | null
  specification: string | null
  clause: string | null
  testNumber: string | null
  location: string | null
  message: string
  categoryIds: string[]
}

export interface VeraPdfResult {
  status: VeraPdfStatus
  executionStatus: VeraPdfExecutionStatus
  profile: string | null
  flavour: string | null
  isCompliant: boolean | null
  passedChecks: number
  failedChecks: number
  failures: VeraPdfFailure[]
  message: string | null
}

export function emptyVeraPdfResult(overrides: Partial<VeraPdfResult> = {}): VeraPdfResult {
  return {
    status: 'unavailable',
    executionStatus: 'missing_binary',
    profile: null,
    flavour: ANALYSIS.VERAPDF_DEFAULT_FLAVOUR,
    isCompliant: null,
    passedChecks: 0,
    failedChecks: 0,
    failures: [],
    message: 'veraPDF validation was not available.',
    ...overrides,
  }
}

function normalizeWhitespace(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized || null
}

function firstString(values: Array<unknown>): string | null {
  for (const value of values) {
    const normalized = normalizeWhitespace(typeof value === 'string' ? value : null)
    if (normalized) return normalized
  }
  return null
}

function maybeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function categoryIdsForFailure(failure: Omit<VeraPdfFailure, 'categoryIds'>): string[] {
  const text = [
    failure.ruleId,
    failure.specification,
    failure.clause,
    failure.testNumber,
    failure.location,
    failure.message,
  ].filter(Boolean).join(' ').toLowerCase()

  const categories = new Set<string>()

  if (/(title|dc:title|metadata title|natural language|lang\b|language declaration)/.test(text)) {
    categories.add('title_language')
  }
  if (/(structtree|structure tree|logical structure|tagged pdf|tag tree|rolemap|parenttree)/.test(text)) {
    categories.add('text_extractability')
    categories.add('reading_order')
  }
  if (/(heading|\/h[1-6]|\bh1\b|\bh2\b|\bh3\b|\bh4\b|\bh5\b|\bh6\b)/.test(text)) {
    categories.add('heading_structure')
  }
  if (/(alt text|alternate description|alternate text|\/alt\b|figure|decorative image|artifact image)/.test(text)) {
    categories.add('alt_text')
  }
  if (/(table|th\b|td\b|header cell|table header|scope\b)/.test(text)) {
    categories.add('table_markup')
  }
  if (/(outline|bookmark|table of contents|navigation)/.test(text)) {
    categories.add('bookmarks')
  }
  if (/(form|widget|field label|tooltip|\/tu\b|choice field|text field)/.test(text)) {
    categories.add('form_accessibility')
  }
  if (/(reading order|content order|mcid|marked content order)/.test(text)) {
    categories.add('reading_order')
  }

  return Array.from(categories)
}

function collectFailedAssertions(root: unknown): VeraPdfFailure[] {
  const failures: VeraPdfFailure[] = []
  const seen = new Set<string>()

  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry)
      return
    }

    const record = node as Record<string, unknown>
    const status = typeof record.status === 'string' ? record.status.toLowerCase() : null
    const failed = status === 'failed'
      || record.failed === true
      || record.passed === false
      || record.isCompliant === false
      || record.compliant === false

    const message = firstString([
      record.message,
      record.description,
      record.errorMessage,
      record.testDescription,
      record.test,
      record.ruleDescription,
    ])

    const ruleId = firstString([record.ruleId, record.ruleID, record.checkId, record.id])
    const specification = firstString([record.specification, record.spec, record.profile])
    const clause = firstString([record.clause, record.isoClause])
    const testNumber = firstString([record.testNumber, record.testNo, record.test])
    const location = firstString([record.location, record.context, record.object, record.path])

    if (failed && (message || ruleId || specification || clause || testNumber)) {
      const normalizedMessage = message || 'veraPDF reported a PDF/UA compliance failure.'
      const failureBase = {
        ruleId,
        specification,
        clause,
        testNumber,
        location,
        message: normalizedMessage,
      }
      const failure: VeraPdfFailure = {
        ...failureBase,
        categoryIds: categoryIdsForFailure(failureBase),
      }
      const key = JSON.stringify([
        failure.ruleId,
        failure.specification,
        failure.clause,
        failure.testNumber,
        failure.location,
        failure.message,
      ])
      if (!seen.has(key)) {
        seen.add(key)
        failures.push(failure)
      }
    }

    for (const value of Object.values(record)) {
      walk(value)
    }
  }

  walk(root)
  return failures
}

export function parseVeraPdfJson(json: any): VeraPdfResult {
  const report = json?.report || json?.validationReport || json
  const failures = collectFailedAssertions(report)
  const parsedFailedChecks = maybeNumber(
    report?.failedChecks ?? report?.failedRules ?? report?.failedAssertions ?? report?.summary?.failedChecks,
  )
  const parsedPassedChecks = maybeNumber(
    report?.passedChecks ?? report?.passedRules ?? report?.passedAssertions ?? report?.summary?.passedChecks,
  )
  const explicitCompliance = typeof report?.isCompliant === 'boolean'
    ? report.isCompliant
    : typeof report?.compliant === 'boolean'
      ? report.compliant
      : null
  const failedChecks = parsedFailedChecks ?? failures.length
  const isCompliant = explicitCompliance ?? (failedChecks === 0 ? true : false)

  return emptyVeraPdfResult({
    status: isCompliant ? 'passed' : 'failed',
    executionStatus: 'ok',
    profile: firstString([
      report?.profileName,
      report?.profile,
      report?.validationProfile,
      report?.details?.profileName,
    ]),
    flavour: firstString([
      report?.flavour,
      report?.defaultFlavour,
      report?.validationFlavour,
      ANALYSIS.VERAPDF_DEFAULT_FLAVOUR,
    ]),
    isCompliant,
    passedChecks: parsedPassedChecks ?? 0,
    failedChecks,
    failures,
    message: isCompliant
      ? 'veraPDF passed PDF/UA validation.'
      : `veraPDF detected ${failedChecks} PDF/UA compliance issue${failedChecks === 1 ? '' : 's'}.`,
  })
}

function parseVeraPdfOutput(output: string | null | undefined): VeraPdfResult | null {
  const normalized = normalizeWhitespace(output)
  if (!normalized) return null
  try {
    return parseVeraPdfJson(JSON.parse(normalized))
  } catch {
    return null
  }
}

export async function analyzeWithVeraPdf(buffer: Buffer, options?: { signal?: AbortSignal }): Promise<VeraPdfResult> {
  const tmpPath = path.join(TMP_DIR, `${randomUUID()}.pdf`)

  try {
    fs.writeFileSync(tmpPath, buffer)

    const shell = /\.bat$/i.test(VERA_PDF_BIN) || /\.cmd$/i.test(VERA_PDF_BIN)
    const { stdout } = await execFileAsync(VERA_PDF_BIN, [
      '--format',
      'json',
      '--defaultflavour',
      ANALYSIS.VERAPDF_DEFAULT_FLAVOUR,
      tmpPath,
    ], {
      timeout: ANALYSIS.VERAPDF_TIMEOUT_MS,
      maxBuffer: ANALYSIS.VERAPDF_MAX_BUFFER,
      encoding: 'utf-8',
      signal: options?.signal,
      shell,
      env: veraPdfChildEnv(),
      windowsHide: true,
    })

    const parsed = parseVeraPdfOutput(stdout)
    if (parsed) return parsed
    return emptyVeraPdfResult({
      status: 'parse_error',
      executionStatus: 'parse_error',
      message: 'veraPDF returned output that could not be parsed.',
    })
  } catch (err: any) {
    if (err.name === 'AbortError') {
      const error = new Error('veraPDF cancelled') as Error & { aborted?: boolean }
      error.aborted = true
      throw error
    }
    if (err.code === 'ENOENT' || /not recognized|cannot find|no such file/i.test(err?.message || '')) {
      return emptyVeraPdfResult({
        status: 'unavailable',
        executionStatus: 'missing_binary',
        message: 'veraPDF CLI is not installed or not available on the configured path.',
      })
    }
    if (err.killed || err.signal === 'SIGTERM') {
      return emptyVeraPdfResult({
        status: 'timeout',
        executionStatus: 'timeout',
        message: 'veraPDF validation timed out before completion.',
      })
    }
    const parsed = parseVeraPdfOutput(err?.stdout) || parseVeraPdfOutput(err?.stderr)
    if (parsed) {
      return parsed
    }
    return emptyVeraPdfResult({
      status: 'error',
      executionStatus: 'error',
      message: normalizeWhitespace(err?.stderr || err?.message) || 'veraPDF validation failed.',
    })
  } finally {
    try { fs.unlinkSync(tmpPath) } catch {}
  }
}

export async function probeVeraPdf(): Promise<{ available: boolean; message: string }> {
  try {
    const shell = /\.bat$/i.test(VERA_PDF_BIN) || /\.cmd$/i.test(VERA_PDF_BIN)
    const { stdout, stderr } = await execFileAsync(VERA_PDF_BIN, ['--version'], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      shell,
      env: veraPdfChildEnv(),
      windowsHide: true,
    })
    const output = normalizeWhitespace(stdout || stderr) || 'veraPDF CLI detected.'
    return { available: true, message: output }
  } catch (error: any) {
    return {
      available: false,
      message: normalizeWhitespace(error?.stderr || error?.message) || 'veraPDF CLI unavailable.',
    }
  }
}
