import { afterEach, describe, expect, it, vi } from 'vitest'

describe('openAiCompatService', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
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
})
