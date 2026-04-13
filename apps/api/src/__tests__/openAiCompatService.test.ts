import { afterEach, describe, expect, it, vi } from 'vitest'

describe('openAiCompatService', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('treats auth-protected models endpoints as reachable when preflighting', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    })

    vi.stubGlobal('fetch', fetchMock)

    const { isEndpointAlive } = await import('../services/openAiCompatService.js')
    const alive = await isEndpointAlive({
      baseUrl: 'http://192.168.50.238:1234/v1',
      apiKey: 'lm-studio-test',
    })

    expect(alive).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://192.168.50.238:1234/v1/models')
    expect(init?.headers).toEqual({ Authorization: 'Bearer lm-studio-test' })
  })

  it('drops fallback endpoints when OPENAI_COMPAT_DISABLE_FALLBACKS is set', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VITEST', '')
    vi.stubEnv('OPENAI_COMPAT_DISABLE_FALLBACKS', '1')
    vi.stubEnv('OPENAI_COMPAT_BASE_URL', 'http://primary.example/v1')
    vi.stubEnv('OPENAI_COMPAT_API_KEY', 'k1')
    vi.stubEnv('OPENAI_COMPAT_MODEL', 'm1')
    vi.stubEnv('OPENAI_COMPAT_FALLBACK_BASE_URL', 'http://fallback.example/v1')
    vi.stubEnv('OPENAI_COMPAT_FALLBACK_API_KEY', 'k2')
    vi.stubEnv('OPENAI_COMPAT_FALLBACK_MODEL', 'm2')

    vi.resetModules()
    const { getOpenAiCompatEndpoints, openAiCompatFallbacksDisabled } = await import('../services/openAiCompatService.js')
    expect(openAiCompatFallbacksDisabled()).toBe(true)
    const eps = getOpenAiCompatEndpoints()
    expect(eps).toHaveLength(1)
    expect(eps[0]?.label).toBe('primary')
    expect(eps[0]?.baseUrl).toBe('http://primary.example/v1')
  })
})
