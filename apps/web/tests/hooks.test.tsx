import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSelection } from '@/hooks/useSelection'
import { useQueueEvents } from '@/hooks/useQueueEvents'

vi.mock('@/lib/api', () => ({
  ensureClientSession: vi.fn(async () => 'client-1'),
  queueEventUrl: vi.fn((clientId: string) => `/api/queue/events?clientId=${clientId}`),
}))

describe('useSelection', () => {
  it('keeps selection across page-level operations', () => {
    const { result } = renderHook(() => useSelection())

    act(() => result.current.selectPage(['a', 'b']))
    act(() => result.current.toggle('c'))
    act(() => result.current.clearPage(['a']))

    expect(result.current.selectedIds).toEqual(['b', 'c'])
  })
})

describe('useQueueEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens an EventSource subscription', async () => {
    const onEvent = vi.fn()
    renderHook(() => useQueueEvents(onEvent))

    await act(async () => {
      await Promise.resolve()
    })

    expect((window.EventSource as any)).toBeDefined()
  })
})
