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
      className="rounded-[2rem] border-2 border-dashed p-6 transition-all"
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
          <h2 className="text-lg font-semibold">Drop PDFs here</h2>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Multi-file uploads stay non-blocking and appear in the queue immediately.
          </p>
        </div>
        <div className="rounded-full px-4 py-2 text-sm font-medium" style={{ background: 'var(--surface-muted)' }}>
          Browse files
        </div>
      </div>
    </div>
  )
}
