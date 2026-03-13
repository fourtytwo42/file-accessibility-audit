import type { QueueState } from '@/lib/api'

const STATUS_COLORS: Record<QueueState, string> = {
  uploading: '#0ea5e9',
  queued: '#6366f1',
  processing: '#f59e0b',
  complete: '#22c55e',
  failed: '#ef4444',
  cancelled: '#6b7280',
}

export function StatusChip({ state }: { state: QueueState }) {
  const color = STATUS_COLORS[state]
  return (
    <span
      className="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wide"
      style={{ background: `${color}20`, color }}
    >
      {state}
    </span>
  )
}
