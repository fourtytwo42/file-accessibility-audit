'use client'

import { useMemo, useState } from 'react'
import { BulkActionBar } from '@/components/grid/BulkActionBar'
import { FilterBar, type QueueFilters } from '@/components/grid/FilterBar'
import { PdfCard } from '@/components/grid/PdfCard'
import { DropZone } from '@/components/upload/DropZone'
import { clearStoredClientSession, deleteQueueItems, downloadMany, downloadQueueFile, reanalyzeQueueItems, remediateQueueItems, retryQueueItem } from '@/lib/api'
import { useQueueEvents } from '@/hooks/useQueueEvents'
import { useQueueStatus } from '@/hooks/useQueueStatus'
import { useSelection } from '@/hooks/useSelection'
import { useUploadQueue } from '@/hooks/useUploadQueue'

const DEFAULT_FILTERS: QueueFilters = {
  search: '',
  status: 'all',
  grade: 'all',
  sort: 'created_desc',
  pageSize: 25,
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export default function QueuePage() {
  const [filters, setFilters] = useState<QueueFilters>(DEFAULT_FILTERS)
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  const { data, visibleItems, total, mutate, loadError } = useQueueStatus(filters, page)
  const { uploads, enqueue } = useUploadQueue(() => mutate())
  const selection = useSelection()

  useQueueEvents(() => { void mutate() })

  const cards = useMemo(
    () => [
      ...uploads.map(item => ({ ...item, local: true as const })),
      ...visibleItems,
    ],
    [uploads, visibleItems],
  )

  const selectedVisibleIds = visibleItems.map(item => item.id).filter(id => selection.selectedSet.has(id))
  const allPageSelected = !!visibleItems.length && selectedVisibleIds.length === visibleItems.length
  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize))

  async function runBulkAction(action: () => Promise<unknown>) {
    setBusy(true)
    try {
      await action()
      selection.clear()
      await mutate()
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page-shell space-y-4 pb-24 md:space-y-6 md:pb-28">
      <section className="space-y-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Unified PDF queue</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            Upload, remediate, re-analyze, and inspect standards-aware scoring from a single dashboard.
          </p>
        </div>
        <DropZone onFilesSelected={enqueue} />
      </section>

      <FilterBar
        filters={filters}
        onChange={patch => {
          setFilters(current => ({ ...current, ...patch }))
          setPage(1)
        }}
        showing={visibleItems.length}
        total={total}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs md:text-sm">
          <input
            type="checkbox"
            checked={allPageSelected}
            onChange={() => allPageSelected ? selection.clearPage(visibleItems.map(item => item.id)) : selection.selectPage(visibleItems.map(item => item.id))}
          />
          Select all on page
        </label>
        <div className="text-xs md:text-sm" style={{ color: 'var(--text-muted)' }}>
          {data?.counts ? `${data.counts.processing} processing | ${data.counts.complete} complete` : 'Loading queue status'}
        </div>
      </div>

      {loadError ? (
        <section
          className="rounded-[1rem] border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, var(--surface))', color: 'var(--text)' }}
        >
          <p className="mb-2">Failed to load your PDF queue. {loadError}</p>
          {(loadError.includes('Client session expired') || loadError.includes('Client session required') || loadError.includes('Client session mismatch')) ? (
            <button
              type="button"
              className="rounded-full border px-3 py-1.5 text-sm font-medium hover:opacity-90"
              style={{ borderColor: 'var(--border)' }}
              onClick={() => {
                clearStoredClientSession()
                void mutate()
              }}
            >
              Reconnect
            </button>
          ) : null}
        </section>
      ) : null}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {cards.map(item => (
          <PdfCard
            key={item.id}
            item={item as any}
            selected={selection.selectedSet.has(item.id)}
            onToggle={selection.toggle}
            onRetry={id => void retryQueueItem(id).then(() => mutate())}
            onDownload={id => void downloadQueueFile(`/api/queue/items/${id}/download`, 'remediated.pdf')}
            onDelete={id => void deleteQueueItems([id]).then(() => mutate())}
          />
        ))}
      </section>

      {!cards.length && !loadError ? (
        <section className="rounded-[1.2rem] border p-8 text-center md:rounded-[1.75rem] md:p-10" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <p className="text-base font-medium md:text-lg">Drop PDFs here to get started.</p>
        </section>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <button type="button" disabled={page === 1} className="rounded-full border px-3 py-1.5 text-sm disabled:opacity-50 md:px-4 md:py-2" style={{ borderColor: 'var(--border)' }} onClick={() => setPage(current => Math.max(1, current - 1))}>Previous</button>
        <span className="text-xs md:text-sm" style={{ color: 'var(--text-muted)' }}>Page {page} of {totalPages}</span>
        <button type="button" disabled={page >= totalPages} className="rounded-full border px-3 py-1.5 text-sm disabled:opacity-50 md:px-4 md:py-2" style={{ borderColor: 'var(--border)' }} onClick={() => setPage(current => Math.min(totalPages, current + 1))}>Next</button>
      </div>

      <BulkActionBar
        count={selection.selectedIds.length}
        busy={busy}
        onClear={selection.clear}
        onDelete={() => void runBulkAction(() => deleteQueueItems(selection.selectedIds))}
        onDownload={() => void runBulkAction(async () => {
          const blob = await downloadMany(selection.selectedIds)
          downloadBlob('queue-selection.zip', blob)
        })}
        onReanalyze={() => void runBulkAction(() => reanalyzeQueueItems(selection.selectedIds))}
        onRemediate={() => void runBulkAction(() => remediateQueueItems(selection.selectedIds))}
      />
    </main>
  )
}
