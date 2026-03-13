import SparkMD5 from 'spark-md5'

type QueueState = 'uploading' | 'queued' | 'processing' | 'complete' | 'failed' | 'cancelled'
type ReconstructionStatus = 'pending' | 'processing' | 'completed' | 'manual_review_required' | 'failed'
type DocumentModelStatus = 'pending' | 'processing' | 'completed' | 'failed'
type LocalIntakeStatus = 'pending' | 'hashing' | 'preflight' | 'uploading' | 'failed_intake'

interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

interface AssetRef {
  path: string
  mimeType: 'image/png'
}

interface ManualReviewFlag {
  code: string
  label: string
  severity: 'warning' | 'critical'
  details: string
  pageNumber?: number
  region?: BoundingBox | null
  asset?: AssetRef | null
}

interface ConfidenceSummary {
  overall: number
  textRecovery: number
  structureRecovery: number
  tableRecovery: number
  visualFidelity: number
}

interface AiChange {
  type: string
  label: string
  details: string
  pageNumber?: number
  confidence: number
  autoApplied: boolean
  reason?: string
}

export interface QueueItemSummary {
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
  processingPath: 'ai_html' | 'agent_patch'
  pathFallbacks: string[]
  reconstructionStatus: ReconstructionStatus
  documentModelStatus: DocumentModelStatus
  pageCount: number | null
  overallScore: number | null
  grade: string | null
  originalScore: number | null
  originalGrade: string | null
  rebuiltScore: number | null
  rebuiltGrade: string | null
  error: any | null
  reconstructionError: any | null
  createdAt: string
  updatedAt: string
  uploadStartedAt: string | null
  uploadCompletedAt: string | null
  processingStartedAt: string | null
  completedAt: string | null
  expiresAt: string
  canRetry: boolean
  canCancel: boolean
  canDownloadOriginal: boolean
  canDownloadRebuilt: boolean
}

export interface QueueItemDetail {
  result: any | null
  originalResult: any | null
  rebuiltResult: any | null
  documentModel: any | null
  aiAppliedChanges: AiChange[]
  aiSuggestedChanges: AiChange[]
  confidenceSummary: ConfidenceSummary | null
  manualReviewFlags: ManualReviewFlag[]
}

export interface QueueItem extends QueueItemSummary, QueueItemDetail {
  kind?: 'server'
  detailsLoaded?: boolean
  detailsLoading?: boolean
  detailsError?: string | null
}

export interface LocalIntakeItem extends QueueItemDetail {
  kind: 'local'
  id: string
  localId: string
  filename: string
  sizeBytes: number
  mimeType: string | null
  state: 'uploading' | 'failed'
  intakeStatus: LocalIntakeStatus
  progress: number
  error: { error: string } | null
  createdAt: string
  updatedAt: string
  processingStage: string | null
  serverItemId?: string
  md5?: string
  dedupeKey: string
  uploadProgress: number
  processingProgress: number
  processingPath: 'agent_patch'
  pathFallbacks: string[]
  reconstructionStatus: ReconstructionStatus
  documentModelStatus: DocumentModelStatus
  pageCount: number | null
  overallScore: number | null
  grade: string | null
  originalScore: number | null
  originalGrade: string | null
  rebuiltScore: number | null
  rebuiltGrade: string | null
  reconstructionError: any | null
  uploadStartedAt: string | null
  uploadCompletedAt: string | null
  processingStartedAt: string | null
  completedAt: string | null
  expiresAt: string
  canRetry: boolean
  canCancel: boolean
  canDownloadOriginal: boolean
  canDownloadRebuilt: boolean
  result: any | null
  originalResult: any | null
  rebuiltResult: any | null
  documentModel: any | null
  aiAppliedChanges: AiChange[]
  aiSuggestedChanges: AiChange[]
  confidenceSummary: ConfidenceSummary | null
  manualReviewFlags: ManualReviewFlag[]
  detailsLoaded?: boolean
  detailsLoading?: boolean
  detailsError?: string | null
}

export type ActiveQueueRow = QueueItem | LocalIntakeItem

const CLIENT_ID_KEY = 'file-accessibility-audit-client-id'
const INTAKE_CONCURRENCY = 3
const REFRESH_DEBOUNCE_MS = 250

function normalizeErrorMessage(error: any, fallback: string): string {
  const direct = error?.data?.error ?? error?.error ?? error?.statusMessage ?? error?.message
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  if (typeof direct === 'boolean') return fallback
  if (error?.data && typeof error.data === 'object') {
    const details = error.data.details
    if (typeof details === 'string' && details.trim()) return details.trim()
  }
  return fallback
}

function emptyQueueItemDetail(): QueueItemDetail {
  return {
    result: null,
    originalResult: null,
    rebuiltResult: null,
    documentModel: null,
    aiAppliedChanges: [],
    aiSuggestedChanges: [],
    confidenceSummary: null,
    manualReviewFlags: [],
  }
}

function mergeQueueItem(summary: QueueItemSummary, detail?: Partial<QueueItemDetail>, existing?: QueueItem): QueueItem {
  return {
    ...emptyQueueItemDetail(),
    ...summary,
    ...(detail || {}),
    kind: 'server',
    detailsLoaded: existing?.detailsLoaded ?? false,
    detailsLoading: existing?.detailsLoading ?? false,
    detailsError: existing?.detailsError ?? null,
  }
}

export function isLocalIntakeItem(item: ActiveQueueRow): item is LocalIntakeItem {
  return item.kind === 'local'
}

export function buildLocalIntakeDedupeKey(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}::${file.size}::${file.lastModified}`
}

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

function createLocalIntakeItem(file: File): LocalIntakeItem {
  const timestamp = new Date().toISOString()
  const localId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

  return {
    ...emptyQueueItemDetail(),
    kind: 'local',
    id: `local:${localId}`,
    localId,
    filename: file.name,
    sizeBytes: file.size,
    mimeType: file.type || 'application/pdf',
    state: 'uploading',
    intakeStatus: 'pending',
    progress: 0,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    processingStage: 'Waiting to hash',
    dedupeKey: buildLocalIntakeDedupeKey(file),
    uploadProgress: 0,
    processingProgress: 0,
    processingPath: 'agent_patch',
    pathFallbacks: [],
    reconstructionStatus: 'pending',
    documentModelStatus: 'pending',
    pageCount: null,
    overallScore: null,
    grade: null,
    originalScore: null,
    originalGrade: null,
    rebuiltScore: null,
    rebuiltGrade: null,
    reconstructionError: null,
    uploadStartedAt: timestamp,
    uploadCompletedAt: null,
    processingStartedAt: null,
    completedAt: null,
    expiresAt: timestamp,
    canRetry: false,
    canCancel: false,
    canDownloadOriginal: false,
    canDownloadRebuilt: false,
    detailsLoaded: false,
    detailsLoading: false,
    detailsError: null,
  }
}

export function useClientQueue() {
  const clientId = useState<string>('queue-client-id', () => '')
  const activeItems = useState<QueueItem[]>('queue-active-items', () => [])
  const historyItems = useState<QueueItem[]>('queue-history-items', () => [])
  const pendingIntakeItems = useState<LocalIntakeItem[]>('queue-pending-intake-items', () => [])
  const intakeFiles = useState<Record<string, File>>('queue-intake-files', () => ({}))
  const itemDetails = useState<Record<string, QueueItemDetail>>('queue-item-details', () => ({}))
  const activeCount = useState<number>('queue-active-count', () => 0)
  const completeCount = useState<number>('queue-complete-count', () => 0)
  const intakeWorkersRunning = useState<number>('queue-intake-workers-running', () => 0)
  const duplicateNotices = useState<Array<{ id: string; filename: string; createdAt: number }>>('queue-duplicate-notices', () => [])
  const selectedActiveIdsState = useState<string[]>('queue-selected-active-ids', () => [])
  const selectedCompletedIdsState = useState<string[]>('queue-selected-completed-ids', () => [])
  const historyPage = useState<number>('queue-history-page', () => 1)
  const historyHasMore = useState<boolean>('queue-history-has-more', () => true)
  const initialized = useState<boolean>('queue-initialized', () => false)
  const bootstrapping = useState<boolean>('queue-bootstrapping', () => false)

  const uploadProgressOverrides = useState<Record<string, number>>('queue-upload-progress-overrides', () => ({}))
  const uploadControllers = useState<Record<string, AbortController>>('queue-upload-controllers', () => ({}))
  const bootstrapPromise = useState<Promise<void> | null>('queue-bootstrap-promise', () => null)
  const initPromise = useState<Promise<void> | null>('queue-init-promise', () => null)

  let eventSource: EventSource | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let refreshPending = { counts: false, active: false, history: false }

  const mergedActiveItems = computed<ActiveQueueRow[]>(() => [
    ...pendingIntakeItems.value,
    ...activeItems.value,
  ])

  const activeDisplayCount = computed(() => mergedActiveItems.value.length)

  const activeSelectableItemIds = computed(() => mergedActiveItems.value.map(item => item.id))

  const historySelectableItemIds = computed(() =>
    historyItems.value
      .filter(item => item.state === 'complete')
      .map(item => item.id),
  )

  const selectedIds = computed(() => Array.from(new Set([
    ...selectedActiveIdsState.value,
    ...selectedCompletedIdsState.value,
  ])))

  const selectableItemIds = computed(() => [...activeSelectableItemIds.value, ...historySelectableItemIds.value])

  const selectedActiveIds = computed(() => {
    const selectable = new Set(activeSelectableItemIds.value)
    return selectedActiveIdsState.value.filter(id => selectable.has(id))
  })

  const selectedCompletedIds = computed(() => Array.from(new Set(selectedCompletedIdsState.value)))

  const hasActiveSelection = computed(() => selectedActiveIds.value.length > 0)
  const hasHistorySelection = computed(() => selectedCompletedIds.value.length > 0)
  const allActiveSelected = computed(() =>
    activeSelectableItemIds.value.length > 0 && selectedActiveIds.value.length === activeSelectableItemIds.value.length,
  )
  const allHistorySelected = computed(() =>
    completeCount.value > 0 && selectedCompletedIds.value.length === completeCount.value,
  )

  function scheduleRefresh(next: { counts?: boolean; active?: boolean; history?: boolean }, delay = REFRESH_DEBOUNCE_MS) {
    refreshPending = {
      counts: refreshPending.counts || !!next.counts,
      active: refreshPending.active || !!next.active,
      history: refreshPending.history || !!next.history,
    }

    if (refreshTimer) return

    refreshTimer = setTimeout(async () => {
      const run = refreshPending
      refreshPending = { counts: false, active: false, history: false }
      refreshTimer = null
      const tasks: Array<Promise<unknown>> = []
      if (run.counts) tasks.push(refreshCounts())
      if (run.active) tasks.push(refreshActive())
      if (run.history) tasks.push(loadHistory(1, false))
      await Promise.all(tasks)
    }, delay)
  }

  function detailForItem(itemId: string): QueueItemDetail | undefined {
    return itemDetails.value[itemId]
  }

  function currentItem(itemId: string): QueueItem | undefined {
    return activeItems.value.find(item => item.id === itemId) || historyItems.value.find(item => item.id === itemId)
  }

  function withCachedDetail(summary: QueueItemSummary, existing?: QueueItem): QueueItem {
    return mergeQueueItem(summary, detailForItem(summary.id), existing)
  }

  function syncSelectedIds() {
    const activeSelectable = new Set(activeSelectableItemIds.value)
    selectedActiveIdsState.value = selectedActiveIdsState.value.filter(id => activeSelectable.has(id))
    if (!completeCount.value) {
      selectedCompletedIdsState.value = []
    }
  }

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
    const timeFor = (item: QueueItem) =>
      new Date(item.uploadStartedAt || item.processingStartedAt || item.createdAt).getTime()
    const timeDiff = timeFor(a) - timeFor(b)
    if (timeDiff !== 0) return timeDiff
    return a.id.localeCompare(b.id)
  }

  function sortHistory(a: QueueItem, b: QueueItem) {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  }

  function replacePendingIntake(localId: string, patch: Partial<LocalIntakeItem>) {
    pendingIntakeItems.value = pendingIntakeItems.value.map(item => item.localId === localId
      ? { ...item, ...patch, updatedAt: new Date().toISOString() }
      : item)
  }

  function removePendingIntake(localId: string) {
    pendingIntakeItems.value = pendingIntakeItems.value.filter(item => item.localId !== localId)
    delete intakeFiles.value[localId]
  }

  function findPendingIntake(localId: string): LocalIntakeItem | undefined {
    return pendingIntakeItems.value.find(item => item.localId === localId)
  }

  function claimNextPendingIntake(): LocalIntakeItem | null {
    const next = pendingIntakeItems.value.find(item => item.intakeStatus === 'pending')
    if (!next) return null
    replacePendingIntake(next.localId, {
      intakeStatus: 'hashing',
      processingStage: 'Hashing file locally',
      progress: 5,
      error: null,
    })
    return findPendingIntake(next.localId) || null
  }

  function mergeItem(item: QueueItemSummary) {
    const existing = currentItem(item.id)
    if (existing && existing.updatedAt !== item.updatedAt) {
      delete itemDetails.value[item.id]
    }

    const localUpload = uploadProgressOverrides.value[item.id]
    const nextItem = withCachedDetail(item, existing)
    if (localUpload !== undefined && nextItem.state === 'uploading') {
      nextItem.uploadProgress = localUpload
    }

    if (nextItem.state === 'complete') {
      historyItems.value = upsertById(historyItems.value, nextItem, sortHistory)
      activeItems.value = removeById(activeItems.value, nextItem.id)
      delete uploadProgressOverrides.value[nextItem.id]
    } else {
      activeItems.value = upsertById(activeItems.value, nextItem, sortActive)
      historyItems.value = removeById(historyItems.value, nextItem.id)
    }

    if (nextItem.state === 'cancelled' && uploadControllers.value[nextItem.id]) {
      uploadControllers.value[nextItem.id].abort()
      delete uploadControllers.value[nextItem.id]
      delete uploadProgressOverrides.value[nextItem.id]
    }

    syncSelectedIds()
  }

  function removeItem(itemId: string) {
    if (itemId.startsWith('local:')) {
      removePendingIntake(itemId.replace(/^local:/, ''))
      return
    }

    activeItems.value = removeById(activeItems.value, itemId)
    historyItems.value = removeById(historyItems.value, itemId)
    delete itemDetails.value[itemId]
    selectedActiveIdsState.value = selectedActiveIdsState.value.filter(id => id !== itemId)
    selectedCompletedIdsState.value = selectedCompletedIdsState.value.filter(id => id !== itemId)
    if (uploadControllers.value[itemId]) {
      uploadControllers.value[itemId].abort()
      delete uploadControllers.value[itemId]
    }
    delete uploadProgressOverrides.value[itemId]
    syncSelectedIds()
  }

  async function bootstrap() {
    if (!import.meta.client) return
    if (bootstrapPromise.value) {
      await bootstrapPromise.value
      return
    }

    bootstrapping.value = true
    const stableClientId = getOrCreateClientId()
    bootstrapPromise.value = (async () => {
      await $fetch('/api/client/bootstrap', {
        method: 'POST',
        body: { clientId: stableClientId },
        credentials: 'include',
      })
    })()

    try {
      await bootstrapPromise.value
    } finally {
      bootstrapPromise.value = null
      bootstrapping.value = false
    }
  }

  async function refreshCounts() {
    const data = await $fetch<{ active: number; complete: number }>('/api/queue/counts', {
      credentials: 'include',
      headers: withClientHeaders(getOrCreateClientId()),
    })
    activeCount.value = data.active
    completeCount.value = data.complete
    syncSelectedIds()
  }

  async function refreshActive() {
    const items = await $fetch<{ items: QueueItemSummary[] }>('/api/queue/active', {
      credentials: 'include',
      headers: withClientHeaders(getOrCreateClientId()),
    })
    activeItems.value = items.items.map(item => withCachedDetail(item, currentItem(item.id))).sort(sortActive)
  }

  async function loadHistory(page = 1, append = false) {
    const data = await $fetch<{ items: QueueItemSummary[]; pagination: { hasMore: boolean; page: number } }>('/api/queue/history', {
      credentials: 'include',
      headers: withClientHeaders(getOrCreateClientId()),
      query: { page, limit: 25 },
    })
    historyHasMore.value = data.pagination.hasMore
    historyPage.value = data.pagination.page
    const completeItems = data.items.map(item => withCachedDetail(item, currentItem(item.id)))
    historyItems.value = append
      ? [...historyItems.value, ...completeItems.filter(item => !historyItems.value.some(existing => existing.id === item.id))].sort(sortHistory)
      : completeItems.sort(sortHistory)
  }

  async function loadItemDetail(itemId: string, force = false) {
    const existing = currentItem(itemId)
    if (!existing) return
    if (existing.detailsLoaded && !force) return
    if (existing.detailsLoading) return

    const mark = (item: QueueItem) => ({ ...item, detailsLoading: true, detailsError: null })
    activeItems.value = activeItems.value.map(item => item.id === itemId ? mark(item) : item)
    historyItems.value = historyItems.value.map(item => item.id === itemId ? mark(item) : item)

    try {
      const data = await $fetch<{ item: QueueItemSummary & QueueItemDetail }>('/api/queue/items/:id'.replace(':id', encodeURIComponent(itemId)), {
        credentials: 'include',
        headers: withClientHeaders(getOrCreateClientId()),
      })
      itemDetails.value[itemId] = {
        result: data.item.result,
        originalResult: data.item.originalResult,
        rebuiltResult: data.item.rebuiltResult,
        documentModel: data.item.documentModel,
        aiAppliedChanges: data.item.aiAppliedChanges || [],
        aiSuggestedChanges: data.item.aiSuggestedChanges || [],
        confidenceSummary: data.item.confidenceSummary || null,
        manualReviewFlags: data.item.manualReviewFlags || [],
      }
      const merged = mergeQueueItem(data.item, itemDetails.value[itemId], existing)
      merged.detailsLoaded = true
      merged.detailsLoading = false
      merged.detailsError = null
      mergeItem(merged)
    } catch (error: any) {
      const message = error?.data?.error || error?.message || 'Failed to load details.'
      const markError = (item: QueueItem) => item.id === itemId ? { ...item, detailsLoading: false, detailsError: message } : item
      activeItems.value = activeItems.value.map(markError)
      historyItems.value = historyItems.value.map(markError)
    }
  }

  function connectEvents() {
    if (!import.meta.client || eventSource) return
    const stableClientId = getOrCreateClientId()
    eventSource = new EventSource(`/api/queue/events?clientId=${encodeURIComponent(stableClientId)}`, { withCredentials: true })
    eventSource.onmessage = (event) => {
      const payload = JSON.parse(event.data)
      if (payload.type === 'item-upserted') {
        const previous = currentItem(payload.item.id)
        mergeItem(payload.item as QueueItemSummary)
        if (!previous || previous.state !== payload.item.state) {
          scheduleRefresh({ counts: true })
        }
      }
      if (payload.type === 'item-deleted') {
        removeItem(payload.itemId)
        scheduleRefresh({ counts: true })
      }
    }
  }

  async function init() {
    if (!import.meta.client) return
    if (initialized.value) return
    if (initPromise.value) {
      await initPromise.value
      return
    }

    initPromise.value = (async () => {
      await bootstrap()
      await Promise.all([refreshCounts(), refreshActive(), loadHistory(1, false)])
      connectEvents()
      initialized.value = true
    })()

    try {
      await initPromise.value
    } finally {
      initPromise.value = null
    }
  }

  async function processLocalIntakeItem(item: LocalIntakeItem) {
    if (!findPendingIntake(item.localId)) return

    try {
      const file = intakeFiles.value[item.localId]
      if (!file) {
        throw new Error('Local intake file reference is missing.')
      }

      const md5 = await hashFileMd5(file)
      replacePendingIntake(item.localId, {
        md5,
        intakeStatus: 'preflight',
        processingStage: 'Preparing queue item',
        progress: 35,
      })

      const preflight = await $fetch<{ status: 'duplicate' | 'restored' | 'created'; item: QueueItemSummary }>('/api/queue/preflight', {
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
        removePendingIntake(item.localId)
        return
      }

      replacePendingIntake(item.localId, {
        intakeStatus: 'uploading',
        processingStage: 'Uploading file',
        progress: 55,
        serverItemId: preflight.item.id,
      })
      mergeItem(preflight.item)
      removePendingIntake(item.localId)
      uploadProgressOverrides.value[preflight.item.id] = 1
      scheduleRefresh({ counts: true, active: true })
      void uploadFile(preflight.item.id, file)
    } catch (error: any) {
      replacePendingIntake(item.localId, {
        intakeStatus: 'failed_intake',
        state: 'failed',
        processingStage: 'Intake failed',
        progress: 0,
        error: {
          error: normalizeErrorMessage(error, 'Failed to queue this file.'),
        },
      })
    }
  }

  function ensureIntakeWorkers() {
    while (intakeWorkersRunning.value < INTAKE_CONCURRENCY && pendingIntakeItems.value.some(item => item.intakeStatus === 'pending')) {
      intakeWorkersRunning.value++
      void (async () => {
        try {
          while (true) {
            const next = claimNextPendingIntake()
            if (!next) break
            await processLocalIntakeItem(next)
          }
        } finally {
          intakeWorkersRunning.value = Math.max(0, intakeWorkersRunning.value - 1)
          if (pendingIntakeItems.value.some(item => item.intakeStatus === 'pending')) {
            ensureIntakeWorkers()
          }
        }
      })()
    }
  }

  async function enqueueFiles(files: File[]) {
    await init()

    const existingKeys = new Set(pendingIntakeItems.value.map(item => item.dedupeKey))
    const nextItems: LocalIntakeItem[] = []
    for (const file of files) {
      const dedupeKey = buildLocalIntakeDedupeKey(file)
      if (existingKeys.has(dedupeKey)) continue
      existingKeys.add(dedupeKey)
      const localItem = createLocalIntakeItem(file)
      intakeFiles.value[localItem.localId] = file
      nextItems.push(localItem)
    }

    if (!nextItems.length) return
    pendingIntakeItems.value = [...pendingIntakeItems.value, ...nextItems]
    ensureIntakeWorkers()
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
      xhr.onload = () => {
        delete uploadControllers.value[itemId]
        delete uploadProgressOverrides.value[itemId]
        scheduleRefresh({ counts: true, active: true })
        resolve()
      }
      xhr.onerror = () => {
        delete uploadControllers.value[itemId]
        delete uploadProgressOverrides.value[itemId]
        scheduleRefresh({ counts: true, active: true })
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

  async function retryItem(itemId: string) {
    await $fetch(`/api/queue/items/${itemId}/retry`, {
      method: 'POST',
      credentials: 'include',
      headers: withClientHeaders(getOrCreateClientId()),
      body: { clientId: getOrCreateClientId() },
    })
    await refreshCounts()
  }

  async function deleteItems(itemIds: string[]) {
    if (!itemIds.length) return

    const localIds = itemIds.filter(itemId => itemId.startsWith('local:'))
    const serverIds = itemIds.filter(itemId => !itemId.startsWith('local:'))

    for (const localId of localIds) {
      removePendingIntake(localId.replace(/^local:/, ''))
    }

    if (!serverIds.length) {
      selectedActiveIdsState.value = selectedActiveIdsState.value.filter(id => !itemIds.includes(id))
      selectedCompletedIdsState.value = selectedCompletedIdsState.value.filter(id => !itemIds.includes(id))
      return
    }

    for (const itemId of serverIds) {
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
        itemIds: serverIds,
      },
    })
    selectedActiveIdsState.value = selectedActiveIdsState.value.filter(id => !itemIds.includes(id))
    selectedCompletedIdsState.value = selectedCompletedIdsState.value.filter(id => !itemIds.includes(id))
    for (const itemId of serverIds) removeItem(itemId)
    await refreshCounts()
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
    pendingIntakeItems.value = []
    intakeFiles.value = {}
    selectedActiveIdsState.value = []
    selectedCompletedIdsState.value = []
    itemDetails.value = {}
    activeCount.value = 0
    completeCount.value = 0
  }

  function downloadUrl(itemId: string, kind: 'rebuilt' | 'original' = 'rebuilt') {
    const suffix = kind === 'original' ? '/download-original' : '/download'
    return `/api/queue/items/${encodeURIComponent(itemId)}${suffix}?clientId=${encodeURIComponent(getOrCreateClientId())}`
  }

  function downloadItem(itemId: string) {
    if (!import.meta.client) return
    window.open(downloadUrl(itemId, 'rebuilt'), '_blank', 'noopener')
  }

  function downloadOriginalItem(itemId: string) {
    if (!import.meta.client) return
    window.open(downloadUrl(itemId, 'original'), '_blank', 'noopener')
  }

  async function downloadSelected(itemIds: string[]) {
    if (!itemIds.length || !import.meta.client) return

    const response = await fetch('/api/queue/download-many', {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...withClientHeaders(getOrCreateClientId()),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientId: getOrCreateClientId(),
        itemIds,
      }),
    })
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'rebuilt-pdfs.zip'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function downloadAllVisible() {
    if (!import.meta.client) return
    const response = await fetch('/api/queue/download-all', {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...withClientHeaders(getOrCreateClientId()),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        clientId: getOrCreateClientId(),
      }),
    })
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'rebuilt-pdfs.zip'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function toggleSelected(itemId: string) {
    if (!selectableItemIds.value.includes(itemId)) return
    const inActiveScope = activeSelectableItemIds.value.includes(itemId)
    const source = inActiveScope ? selectedActiveIdsState.value : selectedCompletedIdsState.value
    const next = source.includes(itemId)
      ? source.filter(id => id !== itemId)
      : [...source, itemId]
    if (inActiveScope) {
      selectedActiveIdsState.value = next
      return
    }
    selectedCompletedIdsState.value = next
  }

  async function fetchSelectableIds(scope: 'active' | 'complete') {
    const data = await $fetch<{ ids: string[] }>('/api/queue/selectable-ids', {
      credentials: 'include',
      headers: withClientHeaders(getOrCreateClientId()),
      query: { scope },
    })
    return data.ids
  }

  async function toggleSelectAll(scope: 'active' | 'history') {
    const allSelected = scope === 'active' ? allActiveSelected.value : allHistorySelected.value

    if (allSelected) {
      if (scope === 'active') {
        selectedActiveIdsState.value = []
      } else {
        selectedCompletedIdsState.value = []
      }
      return
    }

    if (scope === 'active') {
      const serverIds = await fetchSelectableIds('active')
      selectedActiveIdsState.value = Array.from(new Set([
        ...serverIds,
        ...pendingIntakeItems.value.map(item => item.id),
      ]))
      return
    }

    selectedCompletedIdsState.value = await fetchSelectableIds('complete')
  }

  function clearNotices() {
    duplicateNotices.value = []
  }

  async function loadMoreHistory() {
    if (!historyHasMore.value) return
    await loadHistory(historyPage.value + 1, true)
  }

  function itemOverallProgress(item: ActiveQueueRow) {
    if (isLocalIntakeItem(item)) {
      return item.progress
    }
    if (item.state === 'uploading') {
      return Math.max(item.uploadProgress, 1)
    }
    if (item.state === 'queued') return item.uploadProgress ? Math.max(5, item.uploadProgress) : 3
    if (item.state === 'processing') return Math.max(5, item.processingProgress)
    if (item.state === 'complete') return 100
    return 0
  }

  if (import.meta.client) {
    void init()
  }

  return {
    activeItems,
    mergedActiveItems,
    pendingIntakeItems,
    historyItems,
    activeCount,
    activeDisplayCount,
    completeCount,
    intakeWorkersRunning,
    duplicateNotices,
    selectedIds,
    selectedActiveIds,
    selectedCompletedIds,
    hasActiveSelection,
    hasHistorySelection,
    activeSelectableItemIds,
    historySelectableItemIds,
    selectableItemIds,
    allActiveSelected,
    allHistorySelected,
    historyHasMore,
    enqueueFiles,
    retryItem,
    deleteItems,
    deleteAll,
    toggleSelected,
    toggleSelectAll,
    clearNotices,
    loadMoreHistory,
    loadItemDetail,
    downloadItem,
    downloadOriginalItem,
    downloadSelected,
    downloadAllVisible,
    itemOverallProgress,
  }
}
