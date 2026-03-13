'use client'

import { useEffect } from 'react'
import { ensureClientSession, queueEventUrl } from '@/lib/api'

export function useQueueEvents(onEvent: () => void) {
  useEffect(() => {
    let source: EventSource | null = null
    let cancelled = false

    async function connect() {
      const clientId = await ensureClientSession()
      if (cancelled) return
      source = new EventSource(queueEventUrl(clientId), { withCredentials: true })
      source.onmessage = () => onEvent()
      source.onerror = () => {
        source?.close()
        source = null
      }
    }

    void connect()
    return () => {
      cancelled = true
      source?.close()
    }
  }, [onEvent])
}
