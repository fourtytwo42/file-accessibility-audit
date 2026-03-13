'use client'

import useSWR from 'swr'
import { fetchQueueVersions } from '@/lib/api'

export function useQueueVersions(itemId: string) {
  const swr = useSWR(itemId ? ['queue-versions', itemId] : null, () => fetchQueueVersions(itemId))
  return {
    ...swr,
    versions: swr.data?.versions || [],
  }
}
