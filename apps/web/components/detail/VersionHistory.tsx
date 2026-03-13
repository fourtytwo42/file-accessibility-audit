import type { QueueVersionsResponse } from '@/lib/api'
import { formatDate } from '@/lib/formatters'
import { GradeBadge } from '@/components/shared/GradeBadge'

export function VersionHistory({ versions }: { versions: QueueVersionsResponse['versions'] }) {
  return (
    <section className="rounded-[1.75rem] border p-5" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
      <h2 className="text-lg font-semibold">Versions</h2>
      <div className="mt-4 space-y-3">
        {versions.map(version => (
          <div key={version.key} className="flex items-center justify-between gap-3 rounded-2xl border p-4" style={{ borderColor: 'var(--border)' }}>
            <div>
              <div className="font-medium">{version.label}</div>
              <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{formatDate(version.createdAt)}</div>
              <div className="text-sm" style={{ color: 'var(--text-muted)' }}>veraPDF: {version.veraPdfStatus || '-'}</div>
            </div>
            <div className="flex items-center gap-3">
              <GradeBadge grade={version.grade} />
              {version.downloadUrl ? (
                <a className="rounded-full border px-3 py-1.5 text-sm" style={{ borderColor: 'var(--border)' }} href={version.downloadUrl}>
                  Download
                </a>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
