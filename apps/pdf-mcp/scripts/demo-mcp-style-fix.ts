/**
 * Same stack as MCP tools: analyzePDF → inspectPdfForRemediation → executeRemediationTool.
 * Run: pnpm --filter pdf-mcp exec tsx scripts/demo-mcp-style-fix.ts <input.pdf> [out.pdf]
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { analyzePDF } from '../../api/src/services/pdfAnalyzer.ts'
import { evaluatePromotionGate } from '../../api/src/services/promotionGate.ts'
import type { RemediationToolCall } from '../../api/src/services/documentModel.ts'
import {
  executeRemediationTool,
  inspectPdfForRemediation,
} from '../../api/src/services/pdfRemediationTools.ts'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDir, '..', '..', '..')
dotenv.config({ path: path.join(repoRoot, '.env'), override: false })
dotenv.config({ path: path.join(repoRoot, 'apps', 'api', '.env'), override: false })

function call(
  tool_name: RemediationToolCall['tool_name'],
  args: Record<string, unknown> = {},
): RemediationToolCall {
  return {
    tool_name,
    arguments: args,
    rationale: 'mcp-style demo batch',
    confidence: 0.9,
  }
}

async function main() {
  const input = process.argv[2]
  const output = process.argv[3] || input.replace(/\.pdf$/i, '.mcp-fixed.pdf')
  if (!input) {
    console.error('Usage: tsx scripts/demo-mcp-style-fix.ts <input.pdf> [output.pdf]')
    process.exit(1)
  }

  const filename = path.basename(input)
  let buffer = await fs.readFile(input)
  let analysis = await analyzePDF(buffer, filename, {
    skipAdobe: true,
    analysisProfile: 'full_final',
  })

  const gate0 = evaluatePromotionGate({ analysisResult: analysis })
  console.log(JSON.stringify({ step: 'initial', grade: analysis.grade, score: analysis.overallScore, gate: gate0 }, null, 2))

  const batch: RemediationToolCall[] = [
    call('get_document_metadata'),
    call('normalize_document_metadata'),
    call('set_pdfua_identification'),
    call('embed_missing_fonts_in_place'),
    call('repair_font_unicode_maps'),
    call('repair_structure_conformance'),
    call('repair_malformed_bdc_operators'),
    call('repair_native_marked_content_refs'),
    call('repair_note_tag_ids'),
    call('repair_native_link_structure'),
    call('tag_unowned_annotations'),
    call('normalize_annotation_tab_order'),
    call('set_tabs_all_annotated_pages'),
    call('repair_native_figure_semantics'),
    call('repair_other_elements_alt_text'),
    call('normalize_nested_figure_containers'),
  ]

  for (let round = 0; round < 2; round++) {
    const cache: import('../../api/src/services/pdfRemediationTools.ts').RemediationInspectionCache = {}
    for (const c of batch) {
      const ctx = await inspectPdfForRemediation(buffer, analysis, { cache })
      const { buffer: next, action } = await executeRemediationTool({ buffer, context: ctx, call: c })
      buffer = next
      if (action.outcome === 'applied' && action.changedDocumentBytes) {
        console.log(JSON.stringify({ tool: c.tool_name, outcome: action.outcome, changed: true }))
      } else {
        console.log(JSON.stringify({ tool: c.tool_name, outcome: action.outcome, changed: Boolean(action.changedDocumentBytes) }))
      }
    }
    analysis = await analyzePDF(buffer, filename, {
      skipAdobe: true,
      analysisProfile: 'full_final',
    })
    const g = evaluatePromotionGate({ analysisResult: analysis })
    console.log(JSON.stringify({ step: `after_round_${round + 1}`, grade: analysis.grade, score: analysis.overallScore, gate: g }, null, 2))
    if (g.passed) break
  }

  await fs.writeFile(output, buffer)
  console.log('Wrote', output)

  const finalAnalysis = await analyzePDF(buffer, filename, {
    skipAdobe: true,
    analysisProfile: 'full_final',
  })
  const finalGate = evaluatePromotionGate({ analysisResult: finalAnalysis })
  console.log(JSON.stringify({ step: 'final_verify', grade: finalAnalysis.grade, score: finalAnalysis.overallScore, gatePassed: finalGate.passed, gate: finalGate }, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
