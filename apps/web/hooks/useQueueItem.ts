'use client'

import useSWR from 'swr'
import { fetchQueueItem } from '@/lib/api'

export function useQueueItem(itemId: string) {
  const swr = useSWR(itemId ? ['queue-item', itemId] : null, () => fetchQueueItem(itemId), {
    refreshInterval(data) {
      const state = data?.item.state
      return state === 'processing' || state === 'queued' || state === 'uploading' ? 3000 : 0
    },
  })

  return {
    ...swr,
    item: swr.data?.item || null,
  }
}
