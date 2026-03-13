'use client'

import Link from 'next/link'
import type { LocalUploadItem, QueueItemSummary } from '@/lib/api'
import { formatDate, formatScore } from '@/lib/formatters'
import { GradeBadge } from '@/components/shared/GradeBadge'
import { ProgressBar } from '@/components/shared/ProgressBar'
import { StatusChip } from '@/components/shared/StatusChip'

type CardItem = QueueItemSummary | (LocalUploadItem & { local: true })

function isLocal(item: CardItem): item is LocalUploadItem & { local: true } {
  return 'local' in item
}

export function PdfCard({
  item,
  selected,
  onToggle,
  onRetry,
  onDownload,
  onDelete,
}: {
  item: CardItem
  selected: boolean
  onToggle: (id: string) => void
  onRetry?: (id: string) => void
  onDownload?: (id: string) => void
  onDelete?: (id: string) => void
}) {
  const local = isLocal(item)
  const topIssue = local
    ? item.stage
    : item.standardsSummary?.failureOverview.topFailureModes[0]?.label
      || item.processingStage
      || item.error?.error
      || 'No major issue summary yet'
  const progress = local
    ? item.progress
    : item.state === 'uploading'
      ? item.uploadProgress
      : item.state === 'queued' || item.state === 'processing'
        ? item.processingProgress
        : 100

  const content = (
    <div
      className="flex h-full flex-col gap-4 rounded-[1.75rem] border p-5 transition-transform hover:-translate-y-0.5"
      style={{
        borderColor: selected ? 'var(--accent)' : 'var(--border)',
        background: 'var(--surface)',
        boxShadow: selected ? '0 0 0 1px var(--accent)' : 'none',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggle(item.id)}
            onClick={event => event.stopPropagation()}
            aria-label={`Select ${item.filename}`}
          />
          <div>
            <h3 className="line-clamp-2 text-base font-semibold">{item.filename}</h3>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{formatDate(local ? new Date().toISOString() : item.updatedAt)}</p>
          </div>
        </label>
        <GradeBadge grade={local ? null : item.grade} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <StatusChip state={local ? 'uploading' : item.state} />
        <span className="text-sm font-medium">{local ? `${item.progress}%` : formatScore(item.overallScore)}</span>
      </div>
      <div className="space-y-2">
        <ProgressBar value={progress} />
        <p className="line-clamp-2 text-sm" style={{ color: 'var(--text-muted)' }}>
          Top issue: {topIssue}
        </p>
      </div>
      <div className="mt-auto flex flex-wrap gap-2 text-sm">
        {!local ? (
          <>
            <button type="button" className="rounded-full border px-3 py-1.5" style={{ borderColor: 'var(--border)' }} onClick={event => { event.preventDefault(); event.stopPropagation(); onDownload?.(item.id) }}>Download</button>
            {item.canRetry ? (
              <button type="button" className="rounded-full border px-3 py-1.5" style={{ borderColor: 'var(--border)' }} onClick={event => { event.preventDefault(); event.stopPropagation(); onRetry?.(item.id) }}>Retry</button>
            ) : null}
            <button type="button" className="rounded-full border px-3 py-1.5" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={event => { event.preventDefault(); event.stopPropagation(); onDelete?.(item.id) }}>Delete</button>
          </>
        ) : (
          <span className="rounded-full border px-3 py-1.5" style={{ borderColor: 'var(--border)' }}>Uploading</span>
        )}
      </div>
    </div>
  )

  if (local) return content

  return (
    <Link href={`/pdf/${item.id}`} className="block">
      {content}
    </Link>
  )
}
