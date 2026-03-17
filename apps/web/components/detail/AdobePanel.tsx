'use client'

import type { QueueItem } from '@/lib/api'

export function AdobePanel({ item }: { item: QueueItem }) {
  const adobe = item.standardsDetail?.adobe
  if (!adobe) return null

  const current = adobe.current
  const status = current?.status ?? 'unavailable'
  const isPassed = status === 'passed'
  const isFailed = status === 'failed'
  const isUnavailable = status === 'unavailable' || status === 'error'

  return (
    <section className="rounded-[1.75rem] border p-5" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Adobe Accessibility Checker</h2>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Third-party accessibility signal (PDF/UA and WCAG) for the latest stored version.
          </p>
        </div>
        <span
          className="rounded-full px-3 py-1 text-sm font-medium"
          style={{
            background: isPassed ? '#22c55e22' : isFailed ? '#ef444422' : '#6b728022',
            color: isPassed ? '#22c55e' : isFailed ? '#ef4444' : 'var(--text-muted)',
          }}
        >
          {status}
        </span>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl p-4" style={{ background: 'var(--surface-muted)' }}>
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Current issues</div>
          <div className="mt-1 text-xl font-semibold">{current?.issueCount ?? '-'}</div>
        </div>
        <div className="rounded-2xl p-4" style={{ background: 'var(--surface-muted)' }}>
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Original issues</div>
          <div className="mt-1 text-xl font-semibold">{adobe.original?.issueCount ?? '-'}</div>
        </div>
        <div className="rounded-2xl p-4" style={{ background: 'var(--surface-muted)' }}>
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Remediated issues</div>
          <div className="mt-1 text-xl font-semibold">{adobe.rebuilt?.issueCount ?? '-'}</div>
        </div>
      </div>
      {current?.summary ? (
        <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
          {current.summary}
        </p>
      ) : null}
      {(current?.findings?.length ?? 0) > 0 ? (
        <ul className="mt-3 space-y-2 text-sm" style={{ color: 'var(--text-muted)' }}>
          {current!.findings.slice(0, 5).map((f, i) => (
            <li key={`${f.id}-${i}`}>
              - [{f.severity}] {f.message || f.rule}
            </li>
          ))}
        </ul>
      ) : isUnavailable && current?.summary ? (
        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
          {current.summary}
        </p>
      ) : null}
    </section>
  )
}
