'use client'

import { useRef, useState } from 'react'

export function DropZone({ onFilesSelected }: { onFilesSelected: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)

  function commit(files: FileList | null) {
    if (!files?.length) return
    onFilesSelected(Array.from(files).filter(file => file.name.toLowerCase().endsWith('.pdf')))
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          inputRef.current?.click()
        }
      }}
      onDragOver={event => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => {
        event.preventDefault()
        setDragging(false)
        commit(event.dataTransfer.files)
      }}
      className="rounded-[1.2rem] border-2 border-dashed p-4 transition-all md:rounded-[2rem] md:p-6"
      style={{
        borderColor: dragging ? 'var(--accent)' : 'var(--border)',
        background: dragging ? 'color-mix(in srgb, var(--accent) 10%, var(--surface))' : 'var(--surface)',
      }}
      aria-label="Upload PDFs"
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={event => commit(event.currentTarget.files)}
      />
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-base font-semibold md:text-lg">Drop PDFs here</h2>
          <p className="text-xs md:text-sm" style={{ color: 'var(--text-muted)' }}>
            Multi-file uploads stay non-blocking and appear in the queue immediately.
          </p>
        </div>
        <div className="rounded-full px-3 py-1.5 text-xs font-medium md:px-4 md:py-2 md:text-sm" style={{ background: 'var(--surface-muted)' }}>
          Browse files
        </div>
      </div>
    </div>
  )
}
