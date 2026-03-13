import { GradeBadge } from '@/components/shared/GradeBadge'
import type { QueueItem } from '@/lib/api'
import { formatScore } from '@/lib/formatters'

export function GradePanel({ item }: { item: QueueItem }) {
  return (
    <section className="rounded-[1.75rem] border p-5" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Current grade</p>
          <div className="mt-2 flex items-center gap-3">
            <GradeBadge grade={item.grade} />
            <span className="text-2xl font-semibold">{formatScore(item.overallScore)}</span>
          </div>
        </div>
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          <div>Original: {item.standardsDetail?.gradeBasis.originalGrade || '-'} / {item.standardsDetail?.gradeBasis.originalScore ?? '-'}</div>
          <div>Remediated: {item.standardsDetail?.gradeBasis.rebuiltGrade || '-'} / {item.standardsDetail?.gradeBasis.rebuiltScore ?? '-'}</div>
        </div>
      </div>
      <p className="mt-4 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
        {item.standardsDetail?.gradeBasis.summaryText || item.result?.executiveSummary || 'Analysis summary is not available yet.'}
      </p>
      {item.standardsDetail?.gradeBasis.scoreCappedByStandards || item.standardsDetail?.gradeBasis.gradeReducedByStandards ? (
        <div className="mt-4 rounded-2xl border p-3 text-sm" style={{ borderColor: 'var(--warning)', color: 'var(--warning)' }}>
          Standards validation still limits the top-end grade or score for this document.
        </div>
      ) : null}
    </section>
  )
}
