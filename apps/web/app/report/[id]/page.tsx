'use client'

import { useParams } from 'next/navigation'
import useSWR from 'swr'
import { fetchSharedReport } from '@/lib/api'
import { GradeBadge } from '@/components/shared/GradeBadge'

export default function SharedReportPage() {
  const params = useParams<{ id: string }>()
  const { data, isLoading, error } = useSWR(['shared-report', params.id], () => fetchSharedReport(params.id))

  if (isLoading) {
    return <main className="page-shell py-10">Loading report...</main>
  }

  if (error || !data) {
    return <main className="page-shell py-10">Unable to load this shared report.</main>
  }

  const report = data.report

  return (
    <main className="page-shell space-y-6 py-10">
      <section className="rounded-[2rem] border p-6" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{report.filename}</h1>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
              Shared by {data.sharedBy} · expires {new Date(data.expiresAt).toLocaleString()}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <GradeBadge grade={report.grade} />
            <span className="text-2xl font-semibold">{report.overallScore}/100</span>
          </div>
        </div>
        <p className="mt-6 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
          {report.executiveSummary || 'No executive summary was included in this report.'}
        </p>
      </section>
      <section className="rounded-[2rem] border p-6" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
        <h2 className="text-lg font-semibold">Category breakdown</h2>
        <div className="mt-4 space-y-3">
          {(report.categories || []).map((category: any) => (
            <div key={category.id} className="rounded-2xl border p-4" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center justify-between gap-3">
                <strong>{category.label}</strong>
                <GradeBadge grade={category.grade} />
              </div>
              <ul className="mt-3 space-y-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                {(category.findings || []).map((finding: string) => <li key={finding}>• {finding}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}
