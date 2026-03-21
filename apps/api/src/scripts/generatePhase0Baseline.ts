import fs from 'node:fs/promises'
import path from 'node:path'
import { analyzePDF } from '../services/pdfAnalyzer.js'
import { buildFailureProfileArtifacts } from '../services/failureProfileService.js'
import { classifyPdfFull } from '../services/pdfClassificationService.js'
import type {
  AdobeFindingSummary,
  PdfClassification,
  PdfStructuralClass,
} from '../services/documentModel.js'
import { inspectPdfForRemediation } from '../services/pdfRemediationTools.js'
import { PHASE0_BASELINE_CORPUS, type Phase0CorpusEntry } from './phase0BaselineCorpus.js'
import {
  PHASE0_CANARY_DYNAMIC_CLASS_TARGETS,
  PHASE0_CANARY_PINNED,
} from './phase0CanaryCorpus.js'

type AdobeNormalizedFamily =
  | 'adobe.figures_alt_text'
  | 'adobe.other_elements_alt_text'
  | 'adobe.tagged_annotations'
  | 'adobe.character_encoding'
  | 'adobe.nested_alt_text'
  | 'adobe.table_regularity'
  | 'adobe.other'

interface AdobeReportFinding extends AdobeFindingSummary {
  section: string
  statusText: string
  normalizedFamily: AdobeNormalizedFamily
}

interface ParsedAdobeHtmlReport {
  filename: string | null
  summaryCounts: Record<string, number>
  failedFindings: AdobeReportFinding[]
  rawFailedCount: number
}

interface Phase0FileReport {
  filename: string
  source: {
    pdfPath: string
    adobeReportPath: string | null
    sourceSet: Phase0CorpusEntry['sourceSet']
    corpusMembership: string[]
  }
  overallScore: number
  grade: string
  veraPdf: {
    status: string
    failedChecks: number
    passedChecks: number
    profile: string | null
    flavour: string | null
    topFailures: string[]
  }
  adobe: {
    source: 'acrobat_html_report' | 'analysis_result' | 'unavailable'
    status: string
    issueCount: number
    summary: string
    rawSummaryCounts: Record<string, number>
    normalizedFailedFamilyCounts: Record<AdobeNormalizedFamily, number>
    failedFamilies: AdobeNormalizedFamily[]
    failedFindings: AdobeReportFinding[]
  }
  classification: PdfClassification
  categoryScores: Record<string, number | null>
  lowestCategories: Array<{
    id: string
    label: string
    score: number | null
  }>
  failureProfileKeys: string[]
  plannerOpportunityKeys: string[]
  plannerAutoRunnableKeys: string[]
  false100: boolean
  analysisProfile: 'remediation_fast'
}

interface Phase0CanaryEntry {
  filename: string
  why: string
  expectedSignals: string[]
  verificationLocks?: {
    disallowedAutoRunnableKeys?: string[]
    requiredFailureProfileKeys?: string[]
    requiredPlannerOpportunityKeys?: string[]
    requiredAutoRunnableKeys?: string[]
  }
  source: 'pinned' | 'dynamic_class_fill'
  structuralClass: PdfStructuralClass | 'unknown'
  pdfPath: string
}

function repoRoot(): string {
  return path.resolve(process.cwd(), '../..')
}

function htmlDecode(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

function stripTags(input: string): string {
  return htmlDecode(input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
}

function adobeFamilyForFinding(input: {
  section: string
  rule: string
  description: string
}): AdobeNormalizedFamily {
  const haystack = `${input.section} ${input.rule} ${input.description}`.toLowerCase()
  if (/figures alternate text|figalttext/.test(haystack)) return 'adobe.figures_alt_text'
  if (/other elements alternate text|otheralttext|associated with content|alttextnocontent/.test(haystack)) return 'adobe.other_elements_alt_text'
  if (/tagged annotations|taggedannots/.test(haystack)) return 'adobe.tagged_annotations'
  if (/character encoding|charenc/.test(haystack)) return 'adobe.character_encoding'
  if (/nested alternate text|nestedalttext/.test(haystack)) return 'adobe.nested_alt_text'
  if (/regularity|regulartable/.test(haystack)) return 'adobe.table_regularity'
  return 'adobe.other'
}

function parseAdobeHtmlReport(html: string): ParsedAdobeHtmlReport {
  const filenameMatch = html.match(/<dt>\s*Filename:\s*<\/dt><dd>([^<]+)<\/dd>/i)
  const filename = filenameMatch ? stripTags(filenameMatch[1]) : null
  const summaryCounts: Record<string, number> = {}
  for (const match of html.matchAll(/<li>([^:<]+):\s*(\d+)<\/li>/gi)) {
    summaryCounts[stripTags(match[1]).toLowerCase().replace(/\s+/g, '_')] = Number(match[2])
  }

  const failedFindings: AdobeReportFinding[] = []
  let activeSection = 'Unknown'
  const rowPattern = /<tr><td colspan="3" class="cattitle"\s*><h3>([^<]+)<\/h3><\/td><\/tr>|<tr><td>([\s\S]*?)<\/td><td>(Passed|Failed|Needs manual check|Passed manually|Failed manually|Skipped)<\/td><td>([\s\S]*?)<\/td><\/tr>/gi
  for (const match of html.matchAll(rowPattern)) {
    if (match[1]) {
      activeSection = stripTags(match[1])
      continue
    }
    const rule = stripTags(match[2] || '')
    const statusText = stripTags(match[3] || '')
    const description = stripTags(match[4] || '')
    if (!rule || statusText !== 'Failed') continue
    const normalizedFamily = adobeFamilyForFinding({
      section: activeSection,
      rule,
      description,
    })
    failedFindings.push({
      id: `${activeSection}/${rule}`,
      section: activeSection,
      rule,
      categoryId: null,
      severity: 'error',
      message: description || rule,
      statusText,
      normalizedFamily,
    })
  }

  return {
    filename,
    summaryCounts,
    failedFindings,
    rawFailedCount: failedFindings.length,
  }
}

function emptyAdobeFamilyCounts(): Record<AdobeNormalizedFamily, number> {
  return {
    'adobe.figures_alt_text': 0,
    'adobe.other_elements_alt_text': 0,
    'adobe.tagged_annotations': 0,
    'adobe.character_encoding': 0,
    'adobe.nested_alt_text': 0,
    'adobe.table_regularity': 0,
    'adobe.other': 0,
  }
}

function timestampForFilename(input: Date): string {
  return input.toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z')
}

function sanitizeForFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'phase0'
}

function categoryScores(result: Awaited<ReturnType<typeof analyzePDF>>): Record<string, number | null> {
  return Object.fromEntries(result.categories.map(category => [
    category.id,
    typeof category.score === 'number' ? category.score : null,
  ]))
}

function lowestCategories(result: Awaited<ReturnType<typeof analyzePDF>>) {
  return result.categories
    .map(category => ({
      id: category.id,
      label: category.label,
      score: typeof category.score === 'number' ? category.score : null,
    }))
    .sort((left, right) => {
      const leftScore = left.score ?? 101
      const rightScore = right.score ?? 101
      return leftScore - rightScore
    })
    .slice(0, 5)
}

function plannerAutoRunnableKeys(keys: { key: string; status: string }[]): string[] {
  return keys
    .filter(entry => entry.status === 'auto_runnable')
    .map(entry => entry.key)
    .sort()
}

function topVeraFailures(result: Awaited<ReturnType<typeof analyzePDF>>): string[] {
  return result.verapdf.failures
    .map(failure => failure.message)
    .filter((message, index, all) => !!message && all.indexOf(message) === index)
    .slice(0, 5)
}

async function resolveDynamicClassFill(input: {
  existingNames: Set<string>
  existingStructuralClasses: Set<PdfStructuralClass>
  discoveredByName: Map<string, Phase0FileReport>
  limit?: number
}): Promise<Phase0CanaryEntry[]> {
  const root = repoRoot()
  const results: Phase0CanaryEntry[] = []
  const downloadsRoot = path.join(root, 'Downloads')
  const allDownloads = (await fs.readdir(downloadsRoot))
    .filter(name => name.toLowerCase().endsWith('.pdf'))
    .sort()
  const maxToScan = input.limit ?? 250
  const missing = new Set(
    PHASE0_CANARY_DYNAMIC_CLASS_TARGETS
      .filter(target => !input.existingStructuralClasses.has(target.structuralClass))
      .map(target => target.structuralClass),
  )

  for (const name of allDownloads) {
    if (!missing.size || results.length >= PHASE0_CANARY_DYNAMIC_CLASS_TARGETS.length) break
    if (input.existingNames.has(name)) continue
    const filePath = path.join(downloadsRoot, name)
    const buffer = await fs.readFile(filePath)
    const analysis = await analyzePDF(buffer, name, {
      skipAdobe: true,
      skipVeraPdf: false,
      analysisProfile: 'remediation_fast',
    })
    const context = await inspectPdfForRemediation(buffer, analysis, { inspectMode: 'light' })
    const classification = classifyPdfFull({ analysis, context })
    if (!missing.has(classification.structuralClass)) continue

    input.discoveredByName.set(name, {
      filename: name,
      source: {
        pdfPath: path.relative(root, filePath),
        adobeReportPath: null,
        sourceSet: 'downloads',
        corpusMembership: ['phase0_dynamic_class_fill'],
      },
      overallScore: analysis.overallScore,
      grade: analysis.grade,
      veraPdf: {
        status: analysis.verapdf.status,
        failedChecks: analysis.verapdf.failedChecks,
        passedChecks: analysis.verapdf.passedChecks,
        profile: analysis.verapdf.profile,
        flavour: analysis.verapdf.flavour,
        topFailures: topVeraFailures(analysis),
      },
      adobe: {
        source: 'unavailable',
        status: 'unavailable',
        issueCount: 0,
        summary: 'No static Acrobat HTML report available for this dynamic canary class-fill file.',
        rawSummaryCounts: {},
        normalizedFailedFamilyCounts: emptyAdobeFamilyCounts(),
        failedFamilies: [],
        failedFindings: [],
      },
      classification,
      categoryScores: categoryScores(analysis),
      lowestCategories: lowestCategories(analysis),
      failureProfileKeys: [],
      plannerOpportunityKeys: [],
      plannerAutoRunnableKeys: [],
      false100: false,
      analysisProfile: 'remediation_fast',
    })

    const target = PHASE0_CANARY_DYNAMIC_CLASS_TARGETS.find(entry => entry.structuralClass === classification.structuralClass)
    if (!target) continue
    results.push({
      filename: name,
      why: target.why,
      expectedSignals: [`structural_class.${classification.structuralClass}`],
      verificationLocks: undefined,
      source: 'dynamic_class_fill',
      structuralClass: classification.structuralClass,
      pdfPath: path.relative(root, filePath),
    })
    missing.delete(classification.structuralClass)
    if (results.length >= maxToScan) break
  }

  return results
}

function markdownSummary(input: {
  corpusName: string
  generatedAt: string
  fileReports: Phase0FileReport[]
  canaryEntries: Phase0CanaryEntry[]
  summary: any
}): string {
  const lines: string[] = []
  lines.push(`### Phase 0 Baseline Harness (${input.generatedAt})`)
  lines.push(`- Corpus: \`${input.corpusName}\``)
  lines.push(`- Analysis profile: \`remediation_fast\``)
  lines.push(`- Result source: fresh post-change baseline run`)
  lines.push(`- Files analyzed: ${input.summary.fileCount}`)
  lines.push(`- Adobe-fail files: ${input.summary.adobeFailFileCount}`)
  lines.push(`- False 100s: ${input.summary.false100Count}`)
  lines.push(`- 100/100 + Adobe fail: ${input.summary.score100AdobeFailCount}`)
  lines.push(`- Structural classes: ${Object.entries(input.summary.structuralClassCounts).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`)
  lines.push(`- Adobe families: ${Object.entries(input.summary.adobeFailedFamilyTotals).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`)
  lines.push(`- Canary membership: ${input.canaryEntries.map(entry => `${entry.filename} [${entry.structuralClass}]`).join('; ')}`)
  lines.push(`- Canary expectations: ${input.canaryEntries.map(entry => `${entry.filename}: ${entry.expectedSignals.join(', ')}`).join('; ')}`)
  return lines.join('\n')
}

async function main() {
  const args = process.argv.slice(2)
  let corpusName: 'phase0-baseline' | 'phase0-canary' = 'phase0-baseline'
  let limit = Number.POSITIVE_INFINITY
  let outputDir = path.join(repoRoot(), 'MitigationAttempts', 'phase0-baselines')

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--corpus') {
      const value = args[index + 1]
      if (value === 'phase0-canary') corpusName = 'phase0-canary'
      index += 1
      continue
    }
    if (arg === '--limit') {
      const value = Number(args[index + 1] || '')
      if (Number.isFinite(value) && value > 0) limit = value
      index += 1
      continue
    }
    if (arg === '--output-dir') {
      outputDir = path.resolve(args[index + 1] || outputDir)
      index += 1
    }
  }

  await fs.mkdir(outputDir, { recursive: true })
  const root = repoRoot()
  const baselineEntries = PHASE0_BASELINE_CORPUS.slice(0, Number.isFinite(limit) ? limit : undefined)
  const fileReports: Phase0FileReport[] = []
  const discoveredByName = new Map<string, Phase0FileReport>()

  for (const entry of baselineEntries) {
    const pdfBuffer = await fs.readFile(path.join(root, entry.pdfPath))
    const analysis = await analyzePDF(pdfBuffer, entry.filename, {
      skipAdobe: true,
      skipVeraPdf: false,
      analysisProfile: 'remediation_fast',
    })
    const context = await inspectPdfForRemediation(pdfBuffer, analysis, { inspectMode: 'light' })
    const classification = classifyPdfFull({ analysis, context })
    const { failureProfile } = buildFailureProfileArtifacts({
      analysis,
      context,
      actions: [],
      rejectedActions: [],
      iterations: [],
    })
    const adobeReport = entry.adobeReportPath
      ? parseAdobeHtmlReport(await fs.readFile(path.join(root, entry.adobeReportPath), 'utf8'))
      : null
    const normalizedFamilyCounts = emptyAdobeFamilyCounts()
    for (const finding of adobeReport?.failedFindings || []) {
      normalizedFamilyCounts[finding.normalizedFamily] += 1
    }

    const report: Phase0FileReport = {
      filename: entry.filename,
      source: {
        pdfPath: entry.pdfPath,
        adobeReportPath: entry.adobeReportPath,
        sourceSet: entry.sourceSet,
        corpusMembership: ['phase0_baseline'],
      },
      overallScore: analysis.overallScore,
      grade: analysis.grade,
      veraPdf: {
        status: analysis.verapdf.status,
        failedChecks: analysis.verapdf.failedChecks,
        passedChecks: analysis.verapdf.passedChecks,
        profile: analysis.verapdf.profile,
        flavour: analysis.verapdf.flavour,
        topFailures: topVeraFailures(analysis),
      },
      adobe: {
        source: adobeReport ? 'acrobat_html_report' : analysis.adobe ? 'analysis_result' : 'unavailable',
        status: adobeReport
          ? (adobeReport.rawFailedCount > 0 ? 'failed' : 'passed')
          : (analysis.adobe?.status || 'unavailable'),
        issueCount: adobeReport?.rawFailedCount || analysis.adobe?.issueCount || 0,
        summary: adobeReport
          ? `Acrobat HTML report lists ${adobeReport.rawFailedCount} failed check${adobeReport.rawFailedCount === 1 ? '' : 's'}.`
          : (analysis.adobe?.summary || 'Adobe data unavailable.'),
        rawSummaryCounts: adobeReport?.summaryCounts || {},
        normalizedFailedFamilyCounts: normalizedFamilyCounts,
        failedFamilies: Object.entries(normalizedFamilyCounts)
          .filter(([, count]) => count > 0)
          .map(([family]) => family as AdobeNormalizedFamily),
        failedFindings: adobeReport?.failedFindings || [],
      },
      classification,
      categoryScores: categoryScores(analysis),
      lowestCategories: lowestCategories(analysis),
      failureProfileKeys: failureProfile.failureModes.map(mode => mode.key).sort(),
      plannerOpportunityKeys: failureProfile.toolOpportunities.map(opportunity => opportunity.key).sort(),
      plannerAutoRunnableKeys: plannerAutoRunnableKeys(failureProfile.toolOpportunities.map(opportunity => ({
        key: opportunity.key,
        status: opportunity.status,
      }))),
      false100: analysis.overallScore === 100 && (adobeReport?.rawFailedCount || analysis.adobe?.issueCount || 0) > 0,
      analysisProfile: 'remediation_fast',
    }
    fileReports.push(report)
    discoveredByName.set(entry.filename, report)
  }

  const canaryEntries: Phase0CanaryEntry[] = []
  const canaryNames = new Set<string>()
  const canaryStructuralClasses = new Set<PdfStructuralClass>()
  for (const pinned of PHASE0_CANARY_PINNED) {
    let report = discoveredByName.get(pinned.filename)
    if (!report) {
      const pdfBuffer = await fs.readFile(path.join(root, pinned.pdfPath))
      const analysis = await analyzePDF(pdfBuffer, pinned.filename, {
        skipAdobe: true,
        skipVeraPdf: false,
        analysisProfile: 'remediation_fast',
      })
      const context = await inspectPdfForRemediation(pdfBuffer, analysis, { inspectMode: 'light' })
      const classification = classifyPdfFull({ analysis, context })
      const { failureProfile } = buildFailureProfileArtifacts({
        analysis,
        context,
        actions: [],
        rejectedActions: [],
        iterations: [],
      })
      report = {
        filename: pinned.filename,
        source: {
          pdfPath: pinned.pdfPath,
          adobeReportPath: null,
          sourceSet: pinned.sourceSet,
          corpusMembership: [],
        },
        overallScore: analysis.overallScore,
        grade: analysis.grade,
        veraPdf: {
          status: analysis.verapdf.status,
          failedChecks: analysis.verapdf.failedChecks,
          passedChecks: analysis.verapdf.passedChecks,
          profile: analysis.verapdf.profile,
          flavour: analysis.verapdf.flavour,
          topFailures: topVeraFailures(analysis),
        },
        adobe: {
          source: 'unavailable',
          status: 'unavailable',
          issueCount: 0,
          summary: 'No static Acrobat HTML report is pinned for this canary-only file.',
          rawSummaryCounts: {},
          normalizedFailedFamilyCounts: emptyAdobeFamilyCounts(),
          failedFamilies: [],
          failedFindings: [],
        },
        classification,
        categoryScores: categoryScores(analysis),
        lowestCategories: lowestCategories(analysis),
        failureProfileKeys: failureProfile.failureModes.map(mode => mode.key).sort(),
        plannerOpportunityKeys: failureProfile.toolOpportunities.map(opportunity => opportunity.key).sort(),
        plannerAutoRunnableKeys: plannerAutoRunnableKeys(failureProfile.toolOpportunities.map(opportunity => ({
          key: opportunity.key,
          status: opportunity.status,
        }))),
        false100: false,
        analysisProfile: 'remediation_fast',
      }
      discoveredByName.set(pinned.filename, report)
    }
    canaryEntries.push({
      filename: pinned.filename,
      why: pinned.why,
      expectedSignals: pinned.expectedSignals,
      verificationLocks: pinned.verificationLocks,
      source: 'pinned',
      structuralClass: report?.classification.structuralClass || 'unknown',
      pdfPath: report?.source.pdfPath || pinned.pdfPath,
    })
    canaryNames.add(pinned.filename)
    if (report) {
      report.source.corpusMembership.push('phase0_canary')
      canaryStructuralClasses.add(report.classification.structuralClass)
    }
  }

  const dynamicClassFill = await resolveDynamicClassFill({
    existingNames: canaryNames,
    existingStructuralClasses: canaryStructuralClasses,
    discoveredByName,
  })
  for (const entry of dynamicClassFill) {
    canaryEntries.push(entry)
    const report = discoveredByName.get(entry.filename)
    if (report) report.source.corpusMembership.push('phase0_canary')
  }

  const effectiveReports = corpusName === 'phase0-canary'
    ? [...discoveredByName.values()].filter(report => report.source.corpusMembership.includes('phase0_canary'))
    : fileReports

  const structuralClassCounts = effectiveReports.reduce<Record<string, number>>((accumulator, report) => {
    accumulator[report.classification.structuralClass] = (accumulator[report.classification.structuralClass] || 0) + 1
    return accumulator
  }, {})
  const adobeFailedFamilyTotals = effectiveReports.reduce<Record<AdobeNormalizedFamily, number>>((accumulator, report) => {
    for (const [family, count] of Object.entries(report.adobe.normalizedFailedFamilyCounts) as Array<[AdobeNormalizedFamily, number]>) {
      accumulator[family] = (accumulator[family] || 0) + count
    }
    return accumulator
  }, emptyAdobeFamilyCounts())
  const adobeFailFileCount = effectiveReports.filter(report => report.adobe.issueCount > 0).length
  const false100Count = effectiveReports.filter(report => report.false100).length
  const comparisonContract = {
    metrics: [
      'score_delta',
      'grade_delta',
      'verapdf_delta',
      'adobe_family_delta',
      'failure_profile_key_delta',
      'planner_opportunity_delta',
      'structural_class_stability',
    ],
    falsePassRule: 'A file is a false 100 when overallScore === 100 and Adobe failed-check count > 0.',
    improvementRule: 'Adobe alignment improves when normalized Adobe-family failures decrease without introducing worse score, standards, or planner regressions.',
    regressionRule: 'A regression occurs when a previously cleared Adobe family reappears, score drops unexpectedly, or planner opportunities become less complete for the same failure family.',
  }
  const rerunProtocol = {
    defaultValidation: 'phase0_canary',
    fullBaselineTriggers: [
      'after each Phase 1 scoring wave',
      'after each major planner or routing change',
      'after each tool-level regression-isolation change',
    ],
    resultLabels: [
      'full baseline rerun',
      'canary-only rerun',
      'stale pre-restart result',
      'fresh post-restart rerun',
    ],
  }
  const summary = {
    fileCount: effectiveReports.length,
    adobeFailFileCount,
    false100Count,
    score100AdobeFailCount: false100Count,
    structuralClassCounts,
    adobeFailedFamilyTotals,
    dominantAdobeFailureFamilies: Object.entries(adobeFailedFamilyTotals)
      .filter(([, count]) => count > 0)
      .sort((left, right) => right[1] - left[1]),
  }

  const generatedAt = new Date().toISOString()
  const artifact = {
    generatedAt,
    corpusName,
    analysisProfile: 'remediation_fast',
    corpusDefinition: {
      baselineFileCount: PHASE0_BASELINE_CORPUS.length,
      baselineFiles: PHASE0_BASELINE_CORPUS.map(entry => entry.filename),
      canaryPinnedFiles: PHASE0_CANARY_PINNED,
      canaryDynamicClassTargets: PHASE0_CANARY_DYNAMIC_CLASS_TARGETS,
    },
    summary,
    canary: {
      entries: canaryEntries,
      coverage: {
        structuralClasses: [...new Set(canaryEntries.map(entry => entry.structuralClass))].sort(),
        missingStructuralClasses: PHASE0_CANARY_DYNAMIC_CLASS_TARGETS
          .map(target => target.structuralClass)
          .filter(target => !canaryEntries.some(entry => entry.structuralClass === target)),
      },
    },
    comparisonContract,
    rerunProtocol,
    files: effectiveReports.sort((left, right) => left.filename.localeCompare(right.filename)),
    markdownSummary: markdownSummary({
      corpusName,
      generatedAt,
      fileReports: effectiveReports,
      canaryEntries,
      summary,
    }),
  }

  const outputPath = path.join(
    outputDir,
    `${timestampForFilename(new Date())}.${sanitizeForFilename(corpusName)}.json`,
  )
  await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2))
  console.log(JSON.stringify({
    ok: true,
    outputPath,
    corpusName,
    summary,
    canaryCoverage: artifact.canary.coverage,
    markdownSummary: artifact.markdownSummary,
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
