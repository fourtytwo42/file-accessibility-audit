'use client'

import { useState } from 'react'

export interface QueueFilters {
  search: string
  status: 'all' | 'complete' | 'processing' | 'failed'
  grade: 'all' | 'A' | 'B' | 'C' | 'D' | 'F'
  sort: 'created_desc' | 'created_asc' | 'score_desc' | 'score_asc' | 'name_asc' | 'name_desc'
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
  const [mobileExpanded, setMobileExpanded] = useState(false)

  return (
    <div className="sticky top-[4.5rem] z-20 rounded-[1.1rem] border px-3 py-2.5 md:top-[5rem] md:rounded-[1.5rem] md:p-4" style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--surface) 94%, transparent)' }}>
      <div className="flex items-center gap-2 md:hidden">
        <input
          aria-label="Search PDFs"
          value={filters.search}
          onChange={event => onChange({ search: event.target.value })}
          placeholder="Search by filename"
          className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
        />
        <button
          type="button"
          className="shrink-0 rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
          onClick={() => setMobileExpanded(current => !current)}
          aria-expanded={mobileExpanded}
          aria-label="Toggle filters and sort"
        >
          {mobileExpanded ? 'Hide' : 'Filter'}
        </button>
      </div>

      <div className={`${mobileExpanded ? 'mt-2 grid' : 'hidden'} gap-2 md:mt-0 md:grid md:grid-cols-[2fr_1fr_1fr_1fr] md:gap-3`}>
        <input
          aria-label="Search PDFs"
          value={filters.search}
          onChange={event => onChange({ search: event.target.value })}
          placeholder="Search by filename"
          className="hidden rounded-xl border px-3 py-2 text-sm md:block"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
        />
        <select
          aria-label="Filter by status"
          value={filters.status}
          onChange={event => onChange({ status: event.target.value as QueueFilters['status'] })}
          className="rounded-lg border px-3 py-2 text-sm md:rounded-xl"
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
          className="rounded-lg border px-3 py-2 text-sm md:rounded-xl"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
        >
          <option value="all">All grades</option>
          {['A', 'B', 'C', 'D', 'F'].map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <select
          aria-label="Sort PDFs"
          value={filters.sort}
          onChange={event => onChange({ sort: event.target.value as QueueFilters['sort'] })}
          className="rounded-lg border px-3 py-2 text-sm md:rounded-xl"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
        >
          <option value="created_desc">Last uploaded</option>
          <option value="created_asc">Oldest uploaded</option>
          <option value="score_desc">Score high-low</option>
          <option value="score_asc">Score low-high</option>
          <option value="name_asc">Name A-Z</option>
          <option value="name_desc">Name Z-A</option>
        </select>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs md:mt-3 md:text-sm" style={{ color: 'var(--text-muted)' }}>
        <span>Showing {showing} of {total}</span>
        <label className="flex items-center gap-2">
          <span className="whitespace-nowrap">Per page</span>
          <select
            aria-label="Items per page"
            value={filters.pageSize}
            onChange={event => onChange({ pageSize: Number(event.target.value) as QueueFilters['pageSize'] })}
            className="rounded-lg border px-2.5 py-1.5 text-xs md:rounded-xl md:px-3 md:py-2 md:text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
          >
            {[25, 50, 100].map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>
    </div>
  )
}
