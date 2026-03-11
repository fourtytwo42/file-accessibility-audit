import SparkMD5 from 'spark-md5'

type QueueState = 'uploading' | 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled'
type RemediationStatus = 'pending' | 'processing' | 'completed' | 'manual_review_required' | 'failed'

interface ManualReviewFlag {
  code: string
  label: string
  severity: 'warning' | 'critical'
  details: string
}

export interface QueueItem {
  id: string
  clientId: string
  filename: string
  md5: string
  sizeBytes: number
  mimeType: string | null
  state: QueueState
  uploadProgress: number
  processingProgress: number
  processingStage: string | null
  remediationStatus: RemediationStatus
  pageCount: number | null
  overallScore: number | null
  grade: string | null
  result: any | null
  originalResult: any | null
  remediatedResult: any | null
  originalScore: number | null
  originalGrade: string | null
  remediatedScore: number | null
  remediatedGrade: string | null
  error: any | null
  remediationError: any | null
  appliedFixes: string[]
  skippedFixes: string[]
  manualReviewFlags: ManualReviewFlag[]
  createdAt: string
  updatedAt: string
  uploadStartedAt: string | null
  uploadCompletedAt: string | null
  processingStartedAt: string | null
  completedAt: string | null
  expiresAt: string
  canRetry: boolean
  canCancel: boolean
  canDownload: boolean
  canDownloadRemediated: boolean
}

const CLIENT_ID_KEY = 'file-accessibility-audit-client-id'

function createClientId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function hashFileMd5(file: File): Promise<string> {
  const chunkSize = 2 * 1024 * 1024
  const spark = new SparkMD5.ArrayBuffer()
  let offset = 0

  while (offset < file.size) {
    const chunk = file.slice(offset, offset + chunkSize)
    const buffer = await chunk.arrayBuffer()
    spark.append(buffer)
    offset += chunkSize
  }

  return spark.end()
}

function withClientHeaders(clientId: string) {
  return {
    'x-client-id': clientId,
  }
}

function upsertById(items: QueueItem[], item: QueueItem, sorter: (a: QueueItem, b: QueueItem) => number): QueueItem[] {
  const next = items.filter(existing => existing.id !== item.id)
  next.push(item)
  return next.sort(sorter)
}

function removeById(items: QueueItem[], itemId: string): QueueItem[] {
  return items.filter(item => item.id !== itemId)
}

export function useClientQueue() {
  const clientId = useState<string>('queue-client-id', () => '')
  const activeItems = useState<QueueItem[]>('queue-active-items', () => [])
  const historyItems = useState<QueueItem[]>('queue-history-items', () => [])
  const duplicateNotices = useState<Array<{ id: string; filename: string; createdAt: number }>>('queue-duplicate-notices', () => [])
  const selectedIds = useState<string[]>('queue-selected-ids', () => [])
  const historyPage = useState<number>('queue-history-page', () => 1)
  const historyHasMore = useState<boolean>('queue-history-has-more', () => true)
  const initialized = useState<boolean>('queue-initialized', () => false)
  const bootstrapping = useState<boolean>('queue-bootstrapping', () => false)

  const uploadProgressOverrides = useState<Record<string, number>>('queue-upload-progress-overrides', () => ({}))
  const uploadControllers = useState<Record<string, AbortController>>('queue-upload-controllers', () => ({}))
  const hashingFiles = useState<string[]>('queue-hashing-files', () => [])

  let eventSource: EventSource | null = null

  const allVisibleItems = computed(() => [...activeItems.value, ...historyItems.value])
  const hasSelection = computed(() => selectedIds.value.length > 0)

  function getOrCreateClientId() {
    if (clientId.value) return clientId.value
    if (import.meta.client) {
      const existing = window.localStorage.getItem(CLIENT_ID_KEY)
      if (existing) {
        clientId.value = existing
        return existing
      }
      const created = createClientId()
      window.localStorage.setItem(CLIENT_ID_KEY, created)
      clientId.value = created
      return created
    }
    return clientId.value
  }

  function sortActive(a: QueueItem, b: QueueItem) {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  }

  function sortHistory(a: QueueItem, b: QueueItem) {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  }

  function mergeItem(item: QueueItem) {
    const localUpload = uploadProgressOverrides.value[item.id]
    const nextItem = localUpload !== undefined
      ? { ...item, uploadProgress: item.state === 'uploading' ? localUpload : item.uploadProgress }
      : item

    if (item.state === 'uploading' || item.state === 'queued' || item.state === 'processing') {
      activeItems.value = upsertById(activeItems.value, nextItem, sortActive)
      historyItems.value = removeById(historyItems.value, item.id)
    } else {
      historyItems.value = upsertById(historyItems.value, nextItem, sortHistory)
      activeItems.value = removeById(activeItems.value, item.id)
      delete uploadProgressOverrides.value[item.id]
    }

    if (nextItem.state === 'cancelled' && uploadControllers.value[nextItem.id]) {
      uploadControllers.value[nextItem.id].abort()
      delete uploadControllers.value[nextItem.id]
      delete uploadProgressOverrides.value[nextItem.id]
    }
  }

  function removeItem(itemId: string) {
    activeItems.value = removeById(activeItems.value, itemId)
    historyItems.value = removeById(historyItems.value, itemId)
    selectedIds.value = selectedIds.value.filter(id => id !== itemId)
    if (uploadControllers.value[itemId]) {
      uploadControllers.value[itemId].abort()
      delete uploadControllers.value[itemId]
    }
    delete uploadProgressOverrides.value[itemId]
  }

  async function bootstrap() {
    if (bootstrapping.value || !import.meta.client) return
    bootstrapping.value = true
    const stableClientId = getOrCreateClientId()
    await $fetch('/api/client/bootstrap', {
      method: 'POST',
      body: { clientId: stableClientId },
      credentials: 'include',
    })
    bootstrapping.value = false
  }

  async function refreshActive() {
    const items = await $fetch<{ items: QueueItem[] }>('/api/queue/active', {
      credentials: 'include',
      headers: withClientHeaders(getOrCreateClientId()),
    })
    activeItems.value = items.items.sort(sortActive)
  }

  async function loadHistory(page = 1, append = false) {
    const data = await $fetch<{ items: QueueItem[]; pagination: { hasMore: boolean; page: number } }>('/api/queue/history', {
      credentials: 'include',
      headers: withClientHeaders(getOrCreateClientId()),
      query: { page, limit: 25 },
    })
    historyHasMore.value = data.pagination.hasMore
    historyPage.value = data.pagination.page
    historyItems.value = append
      ? [...historyItems.value, ...data.items.filter(item => !historyItems.value.some(existing => existing.id === item.id))].sort(sortHistory)
      : data.items.sort(sortHistory)
  }

  function connectEvents() {
    if (!import.meta.client || eventSource) return
    const stableClientId = getOrCreateClientId()
    eventSource = new EventSource(`/api/queue/events?clientId=${encodeURIComponent(stableClientId)}`, { withCredentials: true })
    eventSource.onmessage = (event) => {
      const payload = JSON.parse(event.data)
      if (payload.type === 'item-upserted') {
        mergeItem(payload.item as QueueItem)
      }
      if (payload.type === 'item-deleted') {
        removeItem(payload.itemId)
      }
    }
  }

  async function init() {
    if (initialized.value) return
    await bootstrap()
    await Promise.all([refreshActive(), loadHistory(1, false)])
    connectEvents()
    initialized.value = true
  }

  async function enqueueFiles(files: File[]) {
    await init()

    for (const file of files) {
      hashingFiles.value = [...hashingFiles.value, file.name]
      try {
        const md5 = await hashFileMd5(file)
        const preflight = await $fetch<{ status: 'duplicate' | 'restored' | 'created'; item: QueueItem }>('/api/queue/preflight', {
          method: 'POST',
          credentials: 'include',
          headers: withClientHeaders(getOrCreateClientId()),
          body: {
            clientId: getOrCreateClientId(),
            filename: file.name,
            md5,
            sizeBytes: file.size,
            mimeType: file.type || 'application/pdf',
          },
        })

        if (preflight.status === 'duplicate') {
          duplicateNotices.value = [
            { id: `${preflight.item.id}-${Date.now()}`, filename: file.name, createdAt: Date.now() },
            ...duplicateNotices.value,
          ].slice(0, 8)
          mergeItem(preflight.item)
          continue
        }

        mergeItem(preflight.item)

        if (preflight.status === 'created') {
          void uploadFile(preflight.item.id, file)
        }
      } finally {
        hashingFiles.value = hashingFiles.value.filter(name => name !== file.name)
      }
    }
  }

  function uploadFile(itemId: string, file: File): Promise<void> {
    return new Promise((resolve) => {
      const controller = new AbortController()
      uploadControllers.value[itemId] = controller
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/queue/items/${encodeURIComponent(itemId)}/upload?clientId=${encodeURIComponent(getOrCreateClientId())}`, true)
      xhr.withCredentials = true
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return
        uploadProgressOverrides.value[itemId] = Math.round((event.loaded / event.total) * 100)
      }
      xhr.onload = async () => {
        delete uploadControllers.value[itemId]
        delete uploadProgressOverrides.value[itemId]
        await refreshActive()
        await loadHistory(1, false)
        resolve()
      }
      xhr.onerror = async () => {
        delete uploadControllers.value[itemId]
        delete uploadProgressOverrides.value[itemId]
        await refreshActive()
        await loadHistory(1, false)
        resolve()
      }
      xhr.onabort = () => {
        delete uploadControllers.value[itemId]
        delete uploadProgressOverrides.value[itemId]
        resolve()
      }

      controller.signal.addEventListener('abort', () => xhr.abort(), { once: true })

      const formData = new FormData()
      formData.append('file', file)
      xhr.send(formData)
    })
  }

  async function cancelItem(itemId: string) {
    if (uploadControllers.value[itemId]) {
      uploadControllers.value[itemId].abort()
      delete uploadControllers.value[itemId]
      delete uploadProgressOverrides.value[itemId]
    }
    await $fetch(`/api/queue/items/${itemId}/cancel`, {
      method: 'POST',
      credentials: 'include',
      headers: withClientHeaders(getOrCreateClientId()),
      body: { clientId: getOrCreateClientId() },
    })
  }

  async function retryItem(itemId: string) {
    await $fetch(`/api/queue/items/${itemId}/retry`, {
      method: 'POST',
      credentials: 'include',
      headers: withClientHeaders(getOrCreateClientId()),
      body: { clientId: getOrCreateClientId() },
    })
  }

  async function deleteItems(itemIds: string[]) {
    if (!itemIds.length) return
    for (const itemId of itemIds) {
      if (uploadControllers.value[itemId]) {
        uploadControllers.value[itemId].abort()
        delete uploadControllers.value[itemId]
      }
    }
    await $fetch('/api/queue/delete-many', {
      method: 'POST',
      credentials: 'include',
      headers: withClientHeaders(getOrCreateClientId()),
      body: {
        clientId: getOrCreateClientId(),
        itemIds,
      },
    })
    selectedIds.value = selectedIds.value.filter(id => !itemIds.includes(id))
    for (const itemId of itemIds) removeItem(itemId)
  }

  async function deleteAll() {
    await $fetch('/api/queue/delete-all', {
      method: 'POST',
      credentials: 'include',
      headers: withClientHeaders(getOrCreateClientId()),
      body: { clientId: getOrCreateClientId() },
    })
    activeItems.value = []
    historyItems.value = []
    selectedIds.value = []
  }

  function toggleSelected(itemId: string) {
    selectedIds.value = selectedIds.value.includes(itemId)
      ? selectedIds.value.filter(id => id !== itemId)
      : [...selectedIds.value, itemId]
  }

  function clearNotices() {
    duplicateNotices.value = []
  }

  function downloadItem(itemId: string) {
    const stableClientId = getOrCreateClientId()
    window.open(`/api/queue/items/${encodeURIComponent(itemId)}/download?clientId=${encodeURIComponent(stableClientId)}`, '_blank')
  }

  async function downloadArchive(url: string, filename: string, body?: Record<string, unknown>) {
    const blob = await $fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: withClientHeaders(getOrCreateClientId()),
      body: {
        clientId: getOrCreateClientId(),
        ...(body || {}),
      },
      responseType: 'blob',
    })

    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(objectUrl)
  }

  async function downloadSelected(itemIds: string[]) {
    if (!itemIds.length) return
    await downloadArchive('/api/queue/download-many', 'remediated-selected.zip', { itemIds })
  }

  async function downloadAllVisible() {
    await downloadArchive('/api/queue/download-all', 'remediated-all-visible.zip')
  }

  function itemUploadProgress(item: QueueItem): number {
    if (uploadProgressOverrides.value[item.id] !== undefined) return uploadProgressOverrides.value[item.id]
    return item.uploadProgress
  }

  function itemOverallProgress(item: QueueItem): number {
    if (item.state === 'complete') return 100
    if (item.state === 'queued') return 0
    if (item.state === 'uploading') {
      return Math.round(itemUploadProgress(item) * 0.2)
    }
    if (item.state === 'processing') {
      return item.processingProgress
    }
    if (item.state === 'failed' || item.state === 'cancelled') {
      return Math.max(item.processingProgress, Math.round(itemUploadProgress(item) * 0.2), 0)
    }
    return item.processingProgress
  }

  onMounted(() => {
    void init()
  })

  onUnmounted(() => {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
  })

  return {
    clientId,
    activeItems,
    historyItems,
    duplicateNotices,
    selectedIds,
    hashingFiles,
    hasSelection,
    historyHasMore,
    init,
    enqueueFiles,
    cancelItem,
    retryItem,
    deleteItems,
    deleteAll,
    toggleSelected,
    clearNotices,
    loadMoreHistory: () => loadHistory(historyPage.value + 1, true),
    downloadItem,
    downloadSelected,
    downloadAllVisible,
    itemOverallProgress,
  }
}
