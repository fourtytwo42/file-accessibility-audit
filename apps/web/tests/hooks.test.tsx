import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSelection } from '@/hooks/useSelection'
import { useQueueEvents } from '@/hooks/useQueueEvents'
import { useQueueStatus } from '@/hooks/useQueueStatus'

vi.mock('@/lib/api', () => ({
  ensureClientSession: vi.fn(async () => 'client-1'),
  queueEventUrl: vi.fn((clientId: string) => `/api/queue/events?clientId=${clientId}`),
  fetchQueueStatus: vi.fn(async () => ({
    items: [
      {
        id: 'older',
        clientId: 'c1',
        filename: 'older.pdf',
        md5: 'a'.repeat(32),
        sizeBytes: 100,
        mimeType: 'application/pdf',
        state: 'complete',
        uploadProgress: 100,
        processingProgress: 100,
        processingStage: 'Complete',
        processingPath: 'agent_patch',
        pathFallbacks: [],
        reconstructionStatus: 'completed',
        documentModelStatus: 'completed',
        pageCount: 1,
        overallScore: 80,
        grade: 'B',
        originalScore: 60,
        originalGrade: 'D',
        rebuiltScore: 80,
        rebuiltGrade: 'B',
        standardsSummary: null,
        error: null,
        reconstructionError: null,
        createdAt: '2026-03-13T00:00:00.000Z',
        updatedAt: '2026-03-13T00:10:00.000Z',
        uploadStartedAt: null,
        uploadCompletedAt: null,
        processingStartedAt: null,
        completedAt: null,
        expiresAt: '',
        canRetry: false,
        canCancel: false,
        canDownloadOriginal: true,
        canDownloadRebuilt: true,
      },
      {
        id: 'newer',
        clientId: 'c1',
        filename: 'newer.pdf',
        md5: 'b'.repeat(32),
        sizeBytes: 100,
        mimeType: 'application/pdf',
        state: 'processing',
        uploadProgress: 100,
        processingProgress: 30,
        processingStage: 'Analyzing',
        processingPath: 'agent_patch',
        pathFallbacks: [],
        reconstructionStatus: 'processing',
        documentModelStatus: 'processing',
        pageCount: null,
        overallScore: null,
        grade: null,
        originalScore: null,
        originalGrade: null,
        rebuiltScore: null,
        rebuiltGrade: null,
        standardsSummary: null,
        error: null,
        reconstructionError: null,
        createdAt: '2026-03-13T01:00:00.000Z',
        updatedAt: '2026-03-13T00:05:00.000Z',
        uploadStartedAt: null,
        uploadCompletedAt: null,
        processingStartedAt: null,
        completedAt: null,
        expiresAt: '',
        canRetry: false,
        canCancel: true,
        canDownloadOriginal: true,
        canDownloadRebuilt: false,
      },
    ],
    counts: { active: 1, history: 1, processing: 1, failed: 0, complete: 1 },
    generatedAt: '2026-03-13T01:01:00.000Z',
  })),
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

describe('useQueueStatus', () => {
  it('defaults to created-desc ordering instead of updated-desc jitter', async () => {
    const { result } = renderHook(() => useQueueStatus({
      search: '',
      status: 'all',
      grade: 'all',
      sort: 'created_desc',
      pageSize: 25,
    }, 1))

    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.visibleItems.map(item => item.id)).toEqual(['newer', 'older'])
  })
})
