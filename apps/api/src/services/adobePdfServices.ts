import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import {
  AutotagPDFJob,
  AutotagPDFParams,
  AutotagPDFResult,
  MimeType,
  PDFAccessibilityCheckerJob,
  PDFAccessibilityCheckerParams,
  PDFAccessibilityCheckerResult,
  PDFServices,
  ServicePrincipalCredentials,
} from '@adobe/pdfservices-node-sdk'

export type AdobeServiceStatus = 'passed' | 'failed' | 'unavailable' | 'error'

export interface AdobeFinding {
  id: string
  rule: string
  categoryId: string | null
  severity: 'info' | 'warning' | 'error'
  message: string
}

export interface AdobeArtifactPaths {
  checkerJsonPath?: string | null
  checkerReportPath?: string | null
  autoTagPdfPath?: string | null
  autoTagReportPath?: string | null
}

export interface AdobeAccessibilitySummary {
  status: AdobeServiceStatus
  summary: string
  passed: boolean | null
  issueCount: number
  findings: AdobeFinding[]
  warnings: string[]
  rawJson?: unknown
  artifacts?: AdobeArtifactPaths
}

export interface AdobeAutoTagSummary {
  status: AdobeServiceStatus
  summary: string
  warnings: string[]
  outputPdf?: Buffer | null
  artifacts?: AdobeArtifactPaths
}

interface AdobeCredentialsFile {
  client_credentials?: {
    client_id?: string
    client_secret?: string
  }
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDir, '..', '..', '..', '..')
function getCredentialsPath(): string {
  const atCwd = path.join(process.cwd(), 'pdfservices-api-credentials.json')
  if (fs.existsSync(atCwd)) return atCwd
  const atParent = path.join(process.cwd(), '..', 'pdfservices-api-credentials.json')
  if (fs.existsSync(atParent)) return atParent
  return path.join(repoRoot, 'pdfservices-api-credentials.json')
}
let credentialsPath: string = getCredentialsPath()

let cachedServices: PDFServices | null | undefined

function readCredentialsFile(): AdobeCredentialsFile {
  return JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as AdobeCredentialsFile
}

function getPdfServices(): PDFServices {
  if (cachedServices) return cachedServices
  if (cachedServices === null) throw new Error('Adobe PDF Services credentials are unavailable.')

  if (!fs.existsSync(credentialsPath)) {
    cachedServices = null
    throw new Error(`Adobe credentials file not found at ${credentialsPath}.`)
  }

  const parsed = readCredentialsFile()
  const clientId = parsed.client_credentials?.client_id?.trim()
  const clientSecret = parsed.client_credentials?.client_secret?.trim()
  if (!clientId || !clientSecret) {
    cachedServices = null
    throw new Error('Adobe credentials file is missing client_credentials.client_id or client_secret.')
  }

  cachedServices = new PDFServices({
    credentials: new ServicePrincipalCredentials({
      clientId,
      clientSecret,
    }),
  })
  return cachedServices
}

export function adobeServicesAvailable(): { available: boolean; message: string } {
  try {
    getPdfServices()
    return { available: true, message: 'Adobe PDF Services credentials loaded.' }
  } catch (error) {
    return { available: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function toBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

function ensureDir(dir: string | undefined): string | null {
  if (!dir) return null
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'document'
}

function mapAdobeCategory(text: string): string | null {
  const normalized = text.toLowerCase()
  if (/alt|alternate|figure|image|decorative|other elements/.test(normalized)) return 'alt_text'
  if (/title|language|metadata/.test(normalized)) return 'title_language'
  if (/heading|header/.test(normalized)) return 'heading_structure'
  if (/bookmark|navigation/.test(normalized)) return 'bookmarks'
  if (/table/.test(normalized)) return 'table_markup'
  if (/link|url/.test(normalized)) return 'link_quality'
  if (/form|field/.test(normalized)) return 'form_accessibility'
  if (/reading order|structure|tag|artifact|content/.test(normalized)) return 'reading_order'
  if (/pdf\/ua|wcag|compliance/.test(normalized)) return 'pdf_ua_compliance'
  return null
}

interface AdobeCheckerEntry {
  Rule?: string
  Status?: string
  Description?: string
}

// Parse Adobe PDF Services Accessibility Checker JSON:
// { "Summary": {...}, "Detailed Report": { "SectionName": [{Rule, Status, Description}] } }
function parseAdobeCheckerJson(input: unknown): AdobeFinding[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const root = input as Record<string, unknown>
  const detailedReport = root['Detailed Report']
  if (!detailedReport || typeof detailedReport !== 'object' || Array.isArray(detailedReport)) return []

  const findings: AdobeFinding[] = []
  for (const [section, checks] of Object.entries(detailedReport as Record<string, unknown>)) {
    if (!Array.isArray(checks)) continue
    for (const check of checks as AdobeCheckerEntry[]) {
      const rule = check.Rule?.trim()
      const status = check.Status?.trim() ?? ''
      const description = check.Description?.trim()
      if (!rule) continue
      const severity: AdobeFinding['severity'] = /pass/i.test(status)
        ? 'info'
        : /manual|warn/i.test(status)
          ? 'warning'
          : 'error'
      findings.push({
        id: `${section}/${rule}`,
        rule,
        categoryId: mapAdobeCategory(`${section} ${rule} ${description ?? ''}`),
        severity,
        message: description ?? rule,
      })
    }
  }
  return findings
}

function summarizeChecker(json: unknown): AdobeAccessibilitySummary {
  const findings = parseAdobeCheckerJson(json)
  const issueCount = findings.filter(finding => finding.severity === 'error').length
  return {
    status: issueCount > 0 ? 'failed' : 'passed',
    summary: issueCount > 0
      ? `Adobe Accessibility Checker reported ${issueCount} issue${issueCount === 1 ? '' : 's'}.`
      : 'Adobe Accessibility Checker did not report blocking issues in the downloaded result.',
    passed: issueCount === 0,
    issueCount,
    findings,
    warnings: [],
    rawJson: json,
  }
}

export async function runAdobeAccessibilityCheck(input: {
  buffer: Buffer
  filename: string
  artifactsDir?: string
  pageStart?: number
  pageEnd?: number
}): Promise<AdobeAccessibilitySummary> {
  try {
    const pdfServices = getPdfServices()
    const inputAsset = await pdfServices.upload({
      readStream: Readable.from(input.buffer),
      mimeType: MimeType.PDF,
    })
    const params = new PDFAccessibilityCheckerParams({
      pageStart: input.pageStart,
      pageEnd: input.pageEnd,
    })
    const pollingURL = await pdfServices.submit({
      job: new PDFAccessibilityCheckerJob({ inputAsset, params }),
    })
    const response = await pdfServices.getJobResult({
      pollingURL,
      resultType: PDFAccessibilityCheckerResult,
    })
    const result = response.result
    if (!result) throw new Error('Adobe Accessibility Checker returned no result.')
    const resultAsset = await pdfServices.getContent({ asset: result.asset })
    const resultBuffer = await toBuffer(resultAsset.readStream)
    const reportAsset = result.report ? await pdfServices.getContent({ asset: result.report }) : null
    const reportBuffer = reportAsset ? await toBuffer(reportAsset.readStream) : null
    const artifactsRoot = ensureDir(input.artifactsDir)
    const slug = safeSlug(input.filename)
    const artifacts: AdobeArtifactPaths = {}

    // The API returns "asset" and "report" – either may contain the issue list (JSON).
    // If asset is PDF or non-JSON, the report often has the structured findings.
    // Acrobat desktop's "Other elements alternate text" may not be in the API's rule set.
    const assetStr = resultBuffer.toString('utf8')
    const reportStr = reportBuffer ? reportBuffer.toString('utf8') : ''
    const assetIsPdf = resultBuffer.length >= 5 && resultBuffer.subarray(0, 5).toString('ascii') === '%PDF-'
    let parsedJson: unknown = null

    if (artifactsRoot) {
      const checkerJsonPath = path.join(artifactsRoot, `${slug}.adobe-checker.json`)
      fs.writeFileSync(checkerJsonPath, resultBuffer)
      artifacts.checkerJsonPath = checkerJsonPath
      if (reportBuffer) {
        const ext = reportBuffer.length >= 2 && reportBuffer[0] === 0x7b ? '.json' : '.bin'
        const checkerReportPath = path.join(artifactsRoot, `${slug}.adobe-checker-report${ext}`)
        fs.writeFileSync(checkerReportPath, reportBuffer)
        artifacts.checkerReportPath = checkerReportPath
      }
    }

    // The report JSON (result.report) contains the "Detailed Report" structure with findings.
    // The asset (result.asset) is typically the tagged PDF output, not a JSON findings file.
    if (reportStr && reportStr.trim().startsWith('{')) {
      try {
        parsedJson = JSON.parse(reportStr)
      } catch {
        // report is not parseable JSON
      }
    } else if (!assetIsPdf) {
      try {
        parsedJson = JSON.parse(assetStr)
      } catch {
        // asset is not parseable JSON
      }
    }

    const summary = summarizeChecker(parsedJson)
    summary.artifacts = artifacts
    return summary
  } catch (error) {
    const unavailable = adobeServicesAvailable()
    return {
      status: unavailable.available ? 'error' : 'unavailable',
      summary: unavailable.available
        ? `Adobe Accessibility Checker failed: ${error instanceof Error ? error.message : String(error)}`
        : unavailable.message,
      passed: null,
      issueCount: 0,
      findings: [],
      warnings: [error instanceof Error ? error.message : String(error)],
    }
  }
}

export async function runAdobeAutoTag(input: {
  buffer: Buffer
  filename: string
  artifactsDir?: string
  generateReport?: boolean
  shiftHeadings?: boolean
}): Promise<AdobeAutoTagSummary> {
  try {
    const pdfServices = getPdfServices()
    const inputAsset = await pdfServices.upload({
      readStream: Readable.from(input.buffer),
      mimeType: MimeType.PDF,
    })
    const pollingURL = await pdfServices.submit({
      job: new AutotagPDFJob({
        inputAsset,
        params: new AutotagPDFParams({
          generateReport: input.generateReport ?? true,
          shiftHeadings: input.shiftHeadings ?? false,
        }),
      }),
    })
    const response = await pdfServices.getJobResult({
      pollingURL,
      resultType: AutotagPDFResult,
    })
    const result = response.result
    if (!result) throw new Error('Adobe Auto-Tag returned no result.')
    const tagged = result.taggedPDF
      ? await pdfServices.getContent({ asset: result.taggedPDF })
      : null
    const report = result.report
      ? await pdfServices.getContent({ asset: result.report })
      : null
    const outputPdf = tagged ? await toBuffer(tagged.readStream) : null
    const reportBuffer = report ? await toBuffer(report.readStream) : null
    const artifactsRoot = ensureDir(input.artifactsDir)
    const slug = safeSlug(input.filename)
    const artifacts: AdobeArtifactPaths = {}

    if (artifactsRoot && outputPdf) {
      const autoTagPdfPath = path.join(artifactsRoot, `${slug}.adobe-autotag.pdf`)
      fs.writeFileSync(autoTagPdfPath, outputPdf)
      artifacts.autoTagPdfPath = autoTagPdfPath
    }
    if (artifactsRoot && reportBuffer) {
      const autoTagReportPath = path.join(artifactsRoot, `${slug}.adobe-autotag-report.bin`)
      fs.writeFileSync(autoTagReportPath, reportBuffer)
      artifacts.autoTagReportPath = autoTagReportPath
    }

    return {
      status: outputPdf ? 'passed' : 'failed',
      summary: outputPdf
        ? 'Adobe Auto-Tag generated a tagged PDF.'
        : 'Adobe Auto-Tag completed without a tagged PDF output.',
      warnings: [],
      outputPdf,
      artifacts,
    }
  } catch (error) {
    const unavailable = adobeServicesAvailable()
    return {
      status: unavailable.available ? 'error' : 'unavailable',
      summary: unavailable.available
        ? `Adobe Auto-Tag failed: ${error instanceof Error ? error.message : String(error)}`
        : unavailable.message,
      warnings: [error instanceof Error ? error.message : String(error)],
      outputPdf: null,
    }
  }
}
