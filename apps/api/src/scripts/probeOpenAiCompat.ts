/**
 * CLI: summarize OpenAI-compatible providers from apps/api/.env and optionally
 * run a minimal tool-calling smoke request (same shape as remediation uses).
 *
 * Usage (from repo root):
 *   pnpm --filter api exec tsx src/scripts/probeOpenAiCompat.ts
 *   pnpm --filter api exec tsx src/scripts/probeOpenAiCompat.ts --tool-smoke
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))
const apiRoot = path.resolve(here, '..', '..')
dotenv.config({ path: path.join(apiRoot, '.env') })

const toolSmoke = process.argv.includes('--tool-smoke')

async function main(): Promise<void> {
  const {
    buildOpenAiCompatToolChoice,
    callWithOpenAiCompatFallbacks,
    getOpenAiCompatEndpoints,
    hasOpenAiCompatConfig,
    isEndpointAlive,
    listOpenAiCompatEndpointSummaries,
    openAiCompatFallbacksDisabled,
  } = await import('../services/openAiCompatService.js')

  console.log(JSON.stringify({
    configured: hasOpenAiCompatConfig(),
    fallbacksDisabled: openAiCompatFallbacksDisabled(),
    endpoints: listOpenAiCompatEndpointSummaries(),
  }, null, 2))

  const endpoints = getOpenAiCompatEndpoints()
  for (const ep of endpoints) {
    const reachable = await isEndpointAlive({
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey,
      timeoutMs: 3000,
    })
    console.log(`[alive] ${ep.label} ${ep.baseUrl} -> ${reachable ? 'ok' : 'unreachable'}`)
  }

  if (!toolSmoke) return

  const SMOKE_TOOL = 'pdfaf_cli_smoke'
  const data = await callWithOpenAiCompatFallbacks({
    serviceName: 'probeOpenAiCompatCli',
    invoke: async endpoint => {
      const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${endpoint.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: endpoint.model,
          temperature: 0,
          tools: [{
            type: 'function',
            function: {
              name: SMOKE_TOOL,
              description: 'Acknowledge.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['ok'],
                properties: { ok: { type: 'boolean' } },
              },
            },
          }],
          tool_choice: buildOpenAiCompatToolChoice({
            endpoint,
            functionName: SMOKE_TOOL,
          }),
          messages: [{ role: 'user', content: `Call ${SMOKE_TOOL} with ok true.` }],
        }),
      })
      if (!response.ok) {
        const t = await response.text().catch(() => '')
        throw new Error(`${endpoint.label}: HTTP ${response.status} ${t.slice(0, 400)}`)
      }
      return await response.json() as {
        choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>
      }
    },
  })

  const toolCall = data?.choices?.[0]?.message?.tool_calls?.find(c => c?.function?.name === SMOKE_TOOL)
  const raw = toolCall?.function?.arguments
  console.log('[tool-smoke]', raw ? `arguments: ${raw}` : 'no tool_calls (try OPENAI_COMPAT_TOOL_CHOICE_MODE=required)')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
