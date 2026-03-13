'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { DetailControls } from '@/components/detail/DetailControls'
import { FailureModeList } from '@/components/detail/FailureModeList'
import { GradePanel } from '@/components/detail/GradePanel'
import { VeraPdfPanel } from '@/components/detail/VeraPdfPanel'
import { VersionHistory } from '@/components/detail/VersionHistory'
import { StatusChip } from '@/components/shared/StatusChip'
import { formatDate } from '@/lib/formatters'
import { useQueueItem } from '@/hooks/useQueueItem'
import { useQueueVersions } from '@/hooks/useQueueVersions'

export default function PdfDetailPage() {
  const params = useParams<{ id: string }>()
  const itemId = params.id
  const { item, isLoading, error, mutate } = useQueueItem(itemId)
  const { versions } = useQueueVersions(itemId)

  if (isLoading) {
    return <main className="page-shell py-10">Loading PDF detail...</main>
  }

  if (error || !item) {
    return <main className="page-shell py-10">Unable to load PDF detail.</main>
  }

  return (
    <main className="page-shell space-y-6 pb-20">
      <div className="space-y-3">
        <Link href="/" className="text-sm" style={{ color: 'var(--accent)' }}>&larr; All PDFs</Link>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{item.filename}</h1>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
              Last updated {formatDate(item.updatedAt)}
            </p>
          </div>
          <StatusChip state={item.state} />
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <GradePanel item={item} />
          <VeraPdfPanel item={item} />
          <FailureModeList item={item} />
          <section className="rounded-[1.75rem] border p-5" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
            <h2 className="text-lg font-semibold">Category breakdown</h2>
            <div className="mt-4 space-y-3">
              {(item.result?.categories || []).map((category: any) => (
                <details key={category.id} className="rounded-2xl border p-4" style={{ borderColor: 'var(--border)' }}>
                  <summary className="cursor-pointer font-medium">{category.label} {typeof category.score === 'number' ? `(${category.score})` : ''}</summary>
                  <ul className="mt-3 space-y-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                    {(category.findings || []).map((finding: string) => <li key={finding}>• {finding}</li>)}
                  </ul>
                </details>
              ))}
            </div>
          </section>
        </div>
        <div className="space-y-6">
          <DetailControls item={item} onRefresh={mutate} />
          <VersionHistory versions={versions} />
        </div>
      </div>
    </main>
  )
}
