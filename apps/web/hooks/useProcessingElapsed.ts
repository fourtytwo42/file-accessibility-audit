'use client'

import { useEffect, useState } from 'react'

function toMillis(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function useProcessingElapsed(startedAt: string | null | undefined, completedAt?: string | null, active = false): number | null {
  const startMs = toMillis(startedAt)
  const completedMs = toMillis(completedAt)

  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active || startMs == null || completedMs != null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active, startMs, completedMs])

  if (startMs == null) return null
  const endMs = completedMs ?? now
  return Math.max(0, endMs - startMs)
}
