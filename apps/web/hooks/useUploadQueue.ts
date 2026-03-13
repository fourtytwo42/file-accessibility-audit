'use client'

import { useState } from 'react'
import type { LocalUploadItem } from '@/lib/api'
import { uploadFile } from '@/lib/api'

export function useUploadQueue(onUploaded: () => void) {
  const [uploads, setUploads] = useState<LocalUploadItem[]>([])

  async function enqueue(files: File[]) {
    for (const file of files) {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
      setUploads(current => [...current, { id, filename: file.name, progress: 0, stage: 'Waiting', error: null }])
      try {
        await uploadFile(file, (progress, stage) => {
          setUploads(current => current.map(entry => entry.id === id ? { ...entry, progress, stage } : entry))
        })
        setUploads(current => current.filter(entry => entry.id !== id))
        onUploaded()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Upload failed'
        setUploads(current => current.map(entry => entry.id === id ? { ...entry, stage: 'Failed', error: message } : entry))
      }
    }
  }

  return {
    uploads,
    enqueue,
  }
}
