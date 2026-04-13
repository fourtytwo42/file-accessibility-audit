export interface OpenAiCompatEndpoint {
  label: string
  baseUrl: string
  apiKey: string
  model: string
}

export type OpenAiCompatToolChoice =
  | 'required'
  | {
    type: 'function'
    function: {
      name: string
    }
  }

export interface OpenAiCompatAttemptRecord {
  serviceName: string
  label: string
  baseUrl: string
  model: string
  outcome: 'success' | 'failed' | 'skipped_unreachable'
  timestamp: string
  errorMessage?: string
}

const openAiCompatAttemptLog: OpenAiCompatAttemptRecord[] = []

function recordAttempt(record: OpenAiCompatAttemptRecord): void {
  openAiCompatAttemptLog.push(record)
}

export function consumeOpenAiCompatAttemptRecords(serviceName?: string): OpenAiCompatAttemptRecord[] {
  if (!serviceName) {
    const records = [...openAiCompatAttemptLog]
    openAiCompatAttemptLog.length = 0
    return records
  }

  const matching = openAiCompatAttemptLog.filter(record => record.serviceName === serviceName)
  if (!matching.length) return []
  const remaining = openAiCompatAttemptLog.filter(record => record.serviceName !== serviceName)
  openAiCompatAttemptLog.length = 0
  openAiCompatAttemptLog.push(...remaining)
  return matching
}

function envValue(name: string): string {
  return String(process.env[name] || '').trim()
}

function normalizeToolChoiceMode(value: string): 'required' | 'named_function' | null {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'required') return 'required'
  if (normalized === 'named_function') return 'named_function'
  return null
}

function endpointFromEnv(input: {
  prefix: string
  label: string
  fallbackBaseUrlEnv?: string
  fallbackApiKeyEnv?: string
  fallbackModelEnv?: string
}): OpenAiCompatEndpoint | null {
  const baseUrl = envValue(`${input.prefix}_BASE_URL`) || (input.fallbackBaseUrlEnv ? envValue(input.fallbackBaseUrlEnv) : '')
  const apiKey = envValue(`${input.prefix}_API_KEY`) || (input.fallbackApiKeyEnv ? envValue(input.fallbackApiKeyEnv) : '')
  const model = envValue(`${input.prefix}_MODEL`) || (input.fallbackModelEnv ? envValue(input.fallbackModelEnv) : '')

  if (!baseUrl || !apiKey || !model) return null

  return {
    label: input.label,
    baseUrl,
    apiKey,
    model,
  }
}

export function openAiCompatFallbacksDisabled(): boolean {
  return /^1|true|yes$/i.test(envValue('OPENAI_COMPAT_DISABLE_FALLBACKS'))
}

export interface OpenAiCompatEndpointSummary {
  label: string
  baseUrl: string
  model: string
}

export function listOpenAiCompatEndpointSummaries(): OpenAiCompatEndpointSummary[] {
  return getOpenAiCompatEndpoints().map(endpoint => ({
    label: endpoint.label,
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
  }))
}

export function getOpenAiCompatEndpoints(): OpenAiCompatEndpoint[] {
  const endpoints = [
    endpointFromEnv({
      prefix: 'OPENAI_COMPAT',
      label: 'primary',
      fallbackBaseUrlEnv: 'OPENROUTER_BASE_URL',
      fallbackApiKeyEnv: 'OPENROUTER_API_KEY',
      fallbackModelEnv: 'OPENROUTER_MODEL',
    }),
    endpointFromEnv({
      prefix: 'OPENAI_COMPAT_FALLBACK',
      label: 'fallback_1',
    }),
    endpointFromEnv({
      prefix: 'OPENAI_COMPAT_SECONDARY_FALLBACK',
      label: 'fallback_2',
    }),
  ].filter((endpoint): endpoint is OpenAiCompatEndpoint => Boolean(endpoint))

  const seen = new Set<string>()
  const uniqueEndpoints = endpoints.filter(endpoint => {
    const key = `${endpoint.baseUrl}::${endpoint.model}::${endpoint.apiKey}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const disableFallbacks = openAiCompatFallbacksDisabled()
  const chain = disableFallbacks && uniqueEndpoints.length > 0
    ? uniqueEndpoints.slice(0, 1)
    : uniqueEndpoints

  if (chain.length > 0) return chain

  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return [{
      label: 'test_default',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'test-openai-compat-key',
      model: 'test-model',
    }]
  }

  return []
}

export function hasOpenAiCompatConfig(): boolean {
  return getOpenAiCompatEndpoints().length > 0
}

export function buildOpenAiCompatToolChoice(input: {
  endpoint: OpenAiCompatEndpoint
  functionName: string
}): OpenAiCompatToolChoice {
  const explicitMode = normalizeToolChoiceMode(
    envValue('OPENAI_COMPAT_TOOL_CHOICE_MODE')
    || envValue('OPENAI_COMPAT_TOOL_CHOICE'),
  )

  const mode = explicitMode
    ?? (input.endpoint.baseUrl.includes(':1234') ? 'required' : 'named_function')

  if (mode === 'required') {
    return 'required'
  }

  return {
    type: 'function',
    function: { name: input.functionName },
  }
}

export async function isEndpointAlive(input: {
  baseUrl: string
  apiKey?: string
  timeoutMs?: number
}): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 2000)
    const response = await fetch(`${input.baseUrl.replace(/\/$/, '')}/models`, {
      signal: controller.signal,
      headers: input.apiKey
        ? { Authorization: `Bearer ${input.apiKey}` }
        : undefined,
    })
    clearTimeout(timer)
    return response.ok || response.status === 401 || response.status === 403
  } catch {
    return false
  }
}

export async function callWithOpenAiCompatFallbacks<T>(input: {
  serviceName: string
  invoke: (endpoint: OpenAiCompatEndpoint) => Promise<T>
  preflightPrimary?: boolean
}): Promise<T> {
  const endpoints = getOpenAiCompatEndpoints()
  if (!endpoints.length) {
    throw new Error('OpenAI-compatible endpoint is not configured.')
  }

  let lastError: unknown = null

  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index]!
    const hasFallbackAfterThis = index < endpoints.length - 1

    if (index === 0 && input.preflightPrimary && hasFallbackAfterThis) {
      const primaryAlive = await isEndpointAlive({
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
      })
      if (!primaryAlive) {
        recordAttempt({
          serviceName: input.serviceName,
          label: endpoint.label,
          baseUrl: endpoint.baseUrl,
          model: endpoint.model,
          outcome: 'skipped_unreachable',
          timestamp: new Date().toISOString(),
        })
        console.warn(`[${input.serviceName}] Primary endpoint unreachable, skipping ${endpoint.baseUrl}`)
        continue
      }
    }

    try {
      const result = await input.invoke(endpoint)
      recordAttempt({
        serviceName: input.serviceName,
        label: endpoint.label,
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        outcome: 'success',
        timestamp: new Date().toISOString(),
      })
      console.log(JSON.stringify({
        scope: 'openai_compat_provider_routing',
        serviceName: input.serviceName,
        endpointLabel: endpoint.label,
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        outcome: 'success',
      }))
      return result
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      recordAttempt({
        serviceName: input.serviceName,
        label: endpoint.label,
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        outcome: 'failed',
        timestamp: new Date().toISOString(),
        errorMessage: message,
      })
      console.warn(`[${input.serviceName}] Endpoint ${endpoint.baseUrl} failed (${message}), trying next configured provider`)
      if (!hasFallbackAfterThis) throw error
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'All OpenAI-compatible providers failed.'))
}
