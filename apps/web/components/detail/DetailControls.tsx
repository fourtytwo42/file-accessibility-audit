'use client'

import { useState } from 'react'
import type { QueueItem } from '@/lib/api'
import { createSharedReport, deleteQueueItems, reanalyzeQueueItems, remediateQueueItems } from '@/lib/api'

function downloadObject(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function DetailControls({ item, onRefresh }: { item: QueueItem; onRefresh: () => Promise<any> }) {
  const [busy, setBusy] = useState(false)
  const actionClassName = 'inline-flex w-full items-center justify-center rounded-full border px-4 py-2 text-sm text-center'

  async function runAction(action: () => Promise<unknown>) {
    setBusy(true)
    try {
      await action()
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-[1.75rem] border p-5" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
      <h2 className="text-lg font-semibold">Actions</h2>
      <div className="mt-4 flex flex-col gap-2">
        <button type="button" disabled={busy} className="inline-flex w-full items-center justify-center rounded-full px-4 py-2 text-sm text-center text-white disabled:opacity-50" style={{ background: 'var(--accent-strong)' }} onClick={() => runAction(() => remediateQueueItems([item.id]))}>Run remediation</button>
        <button type="button" disabled={busy} className={`${actionClassName} disabled:opacity-50`} style={{ borderColor: 'var(--border)' }} onClick={() => runAction(() => reanalyzeQueueItems([item.id]))}>Re-analyze</button>
        {item.canDownloadRebuilt ? <a className={actionClassName} style={{ borderColor: 'var(--border)' }} href={`/api/queue/items/${item.id}/download`}>Download remediated PDF</a> : null}
        {item.canDownloadOriginal ? <a className={actionClassName} style={{ borderColor: 'var(--border)' }} href={`/api/queue/items/${item.id}/download-original`}>Download original PDF</a> : null}
        <button type="button" className={actionClassName} style={{ borderColor: 'var(--border)' }} onClick={() => downloadObject(`${item.filename}.json`, JSON.stringify(item.result || {}, null, 2), 'application/json')}>Export JSON</button>
        <button type="button" className={actionClassName} style={{ borderColor: 'var(--border)' }} onClick={() => downloadObject(`${item.filename}.md`, `# ${item.filename}\n\nScore: ${item.overallScore ?? '-'}\nGrade: ${item.grade ?? '-'}\n\n${item.standardsDetail?.gradeBasis.summaryText || ''}`, 'text/markdown')}>Export Markdown</button>
        <button
          type="button"
          className={actionClassName}
          style={{ borderColor: 'var(--border)' }}
          onClick={async () => {
            const payload = item.result || { filename: item.filename, overallScore: item.overallScore, grade: item.grade }
            const response = await createSharedReport(payload)
            await navigator.clipboard.writeText(`${window.location.origin}/report/${response.id}`)
          }}
        >
          Share report
        </button>
        <button type="button" disabled={busy} className={`${actionClassName} disabled:opacity-50`} style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => runAction(() => deleteQueueItems([item.id]))}>Delete</button>
      </div>
    </section>
  )
}
