#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerPdfTools } from './registerTools.ts'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDir, '..', '..', '..')
dotenv.config({ path: path.join(repoRoot, '.env'), override: false })
dotenv.config({ path: path.join(repoRoot, 'apps', 'api', '.env'), override: false })

const INSTRUCTIONS = `PDF accessibility repair MCP (pdfaf).

Workflow:
1) pdf_open with path or base64 → sessionId
2) pdf_analyze (optionally skipVeraPdf:true for faster smoke) → scores and findings
3) pdf_inspect → candidates (figures, headings, tables, links)
4) pdf_apply_tool with tool_name + arguments from pdf_list_remediation_tools
5) After any mutation, re-run pdf_analyze and pdf_inspect before trusting old ids.

Safety: paths must be under repo root, HOME, or PDF_MCP_ALLOW_PATHS (see README).`

async function main() {
  const mcp = new McpServer(
    { name: 'pdfaf-pdf', version: '0.0.1' },
    { instructions: INSTRUCTIONS },
  )
  registerPdfTools(mcp)
  const transport = new StdioServerTransport()
  await mcp.connect(transport)

  const shutdown = async () => {
    await mcp.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
