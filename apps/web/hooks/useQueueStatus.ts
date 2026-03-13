'use client'

import useSWR from 'swr'
import { fetchQueueStatus, type QueueItemSummary } from '@/lib/api'
import type { QueueFilters } from '@/components/grid/FilterBar'

function applyFilters(items: QueueItemSummary[], filters: QueueFilters): QueueItemSummary[] {
  const filtered = items.filter(item => {
    if (filters.search && !item.filename.toLowerCase().includes(filters.search.toLowerCase())) return false
    if (filters.status === 'complete' && item.state !== 'complete') return false
    if (filters.status === 'processing' && !['uploading', 'queued', 'processing'].includes(item.state)) return false
    if (filters.status === 'failed' && item.state !== 'failed') return false
    if (filters.grade !== 'all' && item.grade !== filters.grade) return false
    return true
  })

  return filtered.sort((a, b) => {
    switch (filters.sort) {
      case 'updated_asc':
        return a.updatedAt.localeCompare(b.updatedAt)
      case 'score_desc':
        return (b.overallScore ?? -1) - (a.overallScore ?? -1)
      case 'score_asc':
        return (a.overallScore ?? 101) - (b.overallScore ?? 101)
      case 'name_asc':
        return a.filename.localeCompare(b.filename)
      case 'name_desc':
        return b.filename.localeCompare(a.filename)
      default:
        return b.updatedAt.localeCompare(a.updatedAt)
    }
  })
}

export function useQueueStatus(filters: QueueFilters, page: number) {
  const swr = useSWR('queue-status', fetchQueueStatus, { refreshInterval: 5000 })
  const items = swr.data?.items || []
  const filtered = applyFilters(items, filters)
  const start = (page - 1) * filters.pageSize
  const visibleItems = filtered.slice(start, start + filters.pageSize)

  return {
    ...swr,
    items,
    visibleItems,
    total: filtered.length,
    counts: swr.data?.counts,
  }
}
