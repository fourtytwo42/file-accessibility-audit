import type { QueueItem } from '@/lib/api'

export function VeraPdfPanel({ item }: { item: QueueItem }) {
  const current = item.standardsDetail?.veraPdf.current
  return (
    <section className="rounded-[1.75rem] border p-5" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">veraPDF</h2>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Standards validation status for the latest stored version.
          </p>
        </div>
        <span className="rounded-full px-3 py-1 text-sm font-medium" style={{ background: current?.status === 'passed' ? '#22c55e22' : '#ef444422', color: current?.status === 'passed' ? '#22c55e' : '#ef4444' }}>
          {current?.status || 'unknown'}
        </span>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl p-4" style={{ background: 'var(--surface-muted)' }}>
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Current failures</div>
          <div className="mt-1 text-xl font-semibold">{current?.failedChecks ?? '-'}</div>
        </div>
        <div className="rounded-2xl p-4" style={{ background: 'var(--surface-muted)' }}>
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Original failures</div>
          <div className="mt-1 text-xl font-semibold">{item.standardsDetail?.veraPdf.original.failedChecks ?? '-'}</div>
        </div>
        <div className="rounded-2xl p-4" style={{ background: 'var(--surface-muted)' }}>
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Remediated failures</div>
          <div className="mt-1 text-xl font-semibold">{item.standardsDetail?.veraPdf.rebuilt.failedChecks ?? '-'}</div>
        </div>
      </div>
      <ul className="mt-4 space-y-2 text-sm" style={{ color: 'var(--text-muted)' }}>
        {(current?.topFailures || []).slice(0, 5).map(failure => <li key={failure}>• {failure}</li>)}
      </ul>
    </section>
  )
}
