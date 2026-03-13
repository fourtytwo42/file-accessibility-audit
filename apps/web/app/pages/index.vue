<template>
  <div class="space-y-8">
    <section v-if="duplicateNotices.length" class="rounded-xl border border-yellow-500/20 bg-yellow-500/10 p-4">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-sm font-semibold text-yellow-200">Already Uploaded</h2>
          <ul class="mt-2 space-y-1 text-sm text-yellow-100">
            <li v-for="notice in duplicateNotices" :key="notice.id">
              {{ notice.filename }} was already uploaded in this browser.
            </li>
          </ul>
        </div>
        <UButton size="xs" variant="ghost" color="neutral" @click="clearNotices">
          Dismiss
        </UButton>
      </div>
    </section>

    <section class="rounded-2xl border border-[var(--border)] bg-[var(--surface-card)] p-6">
      <div class="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h1 class="text-2xl font-semibold text-[var(--text-heading)]">Batch PDF Queue</h1>
          <p class="text-sm text-[var(--text-muted)] mt-1">
            Add PDFs or entire folders. Files process in the background and stay private to this browser for 30 days.
          </p>
        </div>

      </div>
      <DropZone @files-selected="enqueueFiles" />
    </section>

    <div class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:items-start">
      <section>
        <div class="mb-4">
          <div>
            <h2 class="text-lg font-semibold text-[var(--text-heading)]">Active Queue ({{ activeDisplayCount }})</h2>
            <p class="text-sm text-[var(--text-muted)]">Uploads, processing items, and failures stay here until completed or deleted.</p>
          </div>
          <div class="mt-3 flex flex-wrap gap-2">
            <UButton
              v-if="activeDisplayCount"
              size="sm"
              :variant="allActiveSelected ? 'soft' : 'ghost'"
              color="neutral"
              @click="toggleSelectAll('active')"
            >
              {{ allActiveSelected ? 'Clear' : 'Select All' }}
            </UButton>
            <UButton
              v-if="hasActiveSelection"
              size="sm"
              variant="ghost"
              color="error"
              square
              title="Delete selected"
              aria-label="Delete selected"
              @click="confirmDeleteItems(selectedActiveIds)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 6h18" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 6V4h8v2" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 6l-1 14H6L5 6" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M10 11v6" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M14 11v6" />
              </svg>
            </UButton>
          </div>
        </div>

        <div v-if="!mergedActiveItems.length" class="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-6 text-sm text-[var(--text-muted)]">
          No active items. Drop PDFs above to start a batch.
        </div>

        <div v-else class="space-y-4">
          <QueueItemCard
            v-for="item in mergedActiveItems"
            :key="item.id"
            :item="item"
            :selected="selectedIds.includes(item.id)"
            :overall-progress="itemOverallProgress(item)"
            :selectable="activeSelectableItemIds.includes(item.id)"
            @toggle-selected="toggleSelected"
            @delete="confirmDeleteItems([$event])"
            @download-rebuilt="downloadItem"
            @retry="retryItem"
            @load-details="loadItemDetail"
          />
        </div>
      </section>

      <section>
        <div class="mb-4">
          <div>
            <h2 class="text-lg font-semibold text-[var(--text-heading)]">Complete ({{ completeCount }})</h2>
            <p class="text-sm text-[var(--text-muted)]">Completed items remain here for 30 days.</p>
          </div>
          <div class="mt-3 flex flex-wrap gap-2">
            <UButton
              v-if="completeCount"
              size="sm"
              :variant="allHistorySelected ? 'soft' : 'ghost'"
              color="neutral"
              @click="toggleSelectAll('history')"
            >
              {{ allHistorySelected ? 'Clear' : 'Select All' }}
            </UButton>
            <UButton
              v-if="hasHistorySelection"
              size="sm"
              variant="ghost"
              color="primary"
              square
              title="Download selected"
              aria-label="Download selected"
              @click="downloadSelected(selectedCompletedIds)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 7v8" />
                <path stroke-linecap="round" stroke-linejoin="round" d="m8.5 12.5 3.5 3.5 3.5-3.5" />
              </svg>
            </UButton>
            <UButton
              v-if="hasHistorySelection"
              size="sm"
              variant="ghost"
              color="error"
              square
              title="Delete selected"
              aria-label="Delete selected"
              @click="confirmDeleteItems(selectedCompletedIds)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 6h18" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 6V4h8v2" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 6l-1 14H6L5 6" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M10 11v6" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M14 11v6" />
              </svg>
            </UButton>
          </div>
        </div>

        <div v-if="!historyItems.length" class="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-6 text-sm text-[var(--text-muted)]">
          No recent history yet.
        </div>

        <div v-else class="space-y-4">
          <QueueItemCard
            v-for="item in historyItems"
            :key="item.id"
            :item="item"
            :selected="selectedIds.includes(item.id)"
            :overall-progress="itemOverallProgress(item)"
            :selectable="item.state === 'complete'"
            :show-progress="false"
            @toggle-selected="toggleSelected"
            @delete="confirmDeleteItems([$event])"
            @download-rebuilt="downloadItem"
            @load-details="loadItemDetail"
          />
        </div>

        <div ref="historySentinel" class="h-10" />
        <div v-if="historyHasMore" class="mt-4 text-center text-sm text-[var(--text-muted)]">
          Scroll for more history
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' })

const {
  activeItems,
  mergedActiveItems,
  historyItems,
  activeCount,
  activeDisplayCount,
  completeCount,
  duplicateNotices,
  selectedIds,
  selectedActiveIds,
  selectedCompletedIds,
  hasActiveSelection,
  hasHistorySelection,
  activeSelectableItemIds,
  historySelectableItemIds,
  allActiveSelected,
  allHistorySelected,
  historyHasMore,
  enqueueFiles,
  retryItem,
  deleteItems,
  toggleSelected,
  toggleSelectAll,
  clearNotices,
  loadMoreHistory,
  loadItemDetail,
  downloadItem,
  downloadSelected,
  itemOverallProgress,
} = useClientQueue()

function confirmDeleteItems(itemIds: string[]) {
  if (!itemIds.length) return
  if (import.meta.client && !window.confirm(`Delete ${itemIds.length} item${itemIds.length === 1 ? '' : 's'}? This cannot be undone.`)) {
    return
  }
  void deleteItems(itemIds)
}

const historySentinel = ref<HTMLElement | null>(null)

onMounted(() => {
  const target = historySentinel.value
  if (!target) return

  const observer = new IntersectionObserver((entries) => {
    const visible = entries.some(entry => entry.isIntersecting)
    if (visible && historyHasMore.value) {
      void loadMoreHistory()
    }
  }, { rootMargin: '300px' })

  observer.observe(target)
  onUnmounted(() => observer.disconnect())
})
</script>
