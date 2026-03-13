import type { QueueItem } from '@/lib/api'

export function FailureModeList({ item }: { item: QueueItem }) {
  const failureModes = item.standardsDetail?.failureModes || []
  return (
    <section className="rounded-[1.75rem] border p-5" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
      <h2 className="text-lg font-semibold">Failure modes</h2>
      <div className="mt-4 space-y-3">
        {failureModes.length ? failureModes.map(mode => (
          <div key={mode.key} className="rounded-2xl border p-4" style={{ borderColor: 'var(--border)' }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong>{mode.label}</strong>
              <span className="rounded-full px-3 py-1 text-xs uppercase tracking-wide" style={{ background: mode.blocking ? '#ef444422' : '#14b8a622', color: mode.blocking ? '#ef4444' : '#14b8a6' }}>
                {mode.classification.replace('_', ' ')}
              </span>
            </div>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>Count: {mode.count}</p>
            {(mode.evidence || []).slice(0, 3).map(entry => (
              <p key={entry} className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>• {entry}</p>
            ))}
          </div>
        )) : (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No grouped failure-mode data is available for this item.</p>
        )}
      </div>
    </section>
  )
}
