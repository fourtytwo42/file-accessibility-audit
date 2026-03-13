'use client'

export function BulkActionBar({
  count,
  busy,
  onRemediate,
  onReanalyze,
  onDownload,
  onDelete,
  onClear,
}: {
  count: number
  busy: boolean
  onRemediate: () => void
  onReanalyze: () => void
  onDownload: () => void
  onDelete: () => void
  onClear: () => void
}) {
  if (!count) return null

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t p-4" style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--surface) 96%, transparent)' }}>
      <div className="page-shell flex flex-wrap items-center justify-between gap-3 p-0">
        <span className="text-sm font-medium">{count} selected</span>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} className="rounded-full px-4 py-2 text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent-strong)' }} onClick={onRemediate}>Remediate</button>
          <button type="button" disabled={busy} className="rounded-full border px-4 py-2 text-sm disabled:opacity-50" style={{ borderColor: 'var(--border)' }} onClick={onReanalyze}>Re-analyze</button>
          <button type="button" disabled={busy} className="rounded-full border px-4 py-2 text-sm disabled:opacity-50" style={{ borderColor: 'var(--border)' }} onClick={onDownload}>Download</button>
          <button type="button" disabled={busy} className="rounded-full border px-4 py-2 text-sm disabled:opacity-50" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={onDelete}>Delete</button>
          <button type="button" className="rounded-full border px-4 py-2 text-sm" style={{ borderColor: 'var(--border)' }} onClick={onClear}>Clear</button>
        </div>
      </div>
    </div>
  )
}
