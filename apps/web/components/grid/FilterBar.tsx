'use client'

export interface QueueFilters {
  search: string
  status: 'all' | 'complete' | 'processing' | 'failed'
  grade: 'all' | 'A' | 'B' | 'C' | 'D' | 'F'
  sort: 'updated_desc' | 'updated_asc' | 'score_desc' | 'score_asc' | 'name_asc' | 'name_desc'
  pageSize: 25 | 50 | 100
}

export function FilterBar({
  filters,
  onChange,
  showing,
  total,
}: {
  filters: QueueFilters
  onChange: (patch: Partial<QueueFilters>) => void
  showing: number
  total: number
}) {
  return (
    <div className="sticky top-[5.25rem] z-20 rounded-[1.5rem] border p-4" style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--surface) 94%, transparent)' }}>
      <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_1fr]">
        <input
          aria-label="Search PDFs"
          value={filters.search}
          onChange={event => onChange({ search: event.target.value })}
          placeholder="Search by filename"
          className="rounded-xl border px-3 py-2"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
        />
        <select
          aria-label="Filter by status"
          value={filters.status}
          onChange={event => onChange({ status: event.target.value as QueueFilters['status'] })}
          className="rounded-xl border px-3 py-2"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
        >
          <option value="all">All statuses</option>
          <option value="complete">Complete</option>
          <option value="processing">Processing</option>
          <option value="failed">Failed</option>
        </select>
        <select
          aria-label="Filter by grade"
          value={filters.grade}
          onChange={event => onChange({ grade: event.target.value as QueueFilters['grade'] })}
          className="rounded-xl border px-3 py-2"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
        >
          <option value="all">All grades</option>
          {['A', 'B', 'C', 'D', 'F'].map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <select
          aria-label="Sort PDFs"
          value={filters.sort}
          onChange={event => onChange({ sort: event.target.value as QueueFilters['sort'] })}
          className="rounded-xl border px-3 py-2"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
        >
          <option value="updated_desc">Date newest</option>
          <option value="updated_asc">Date oldest</option>
          <option value="score_desc">Score high-low</option>
          <option value="score_asc">Score low-high</option>
          <option value="name_asc">Name A-Z</option>
          <option value="name_desc">Name Z-A</option>
        </select>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-sm" style={{ color: 'var(--text-muted)' }}>
        <span>Showing {showing} of {total} PDFs</span>
        <label className="flex items-center gap-2">
          <span>Per page</span>
          <select
            aria-label="Items per page"
            value={filters.pageSize}
            onChange={event => onChange({ pageSize: Number(event.target.value) as QueueFilters['pageSize'] })}
            className="rounded-xl border px-3 py-2"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
          >
            {[25, 50, 100].map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>
    </div>
  )
}
