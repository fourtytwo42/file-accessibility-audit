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

        <div class="flex flex-wrap gap-2">
          <UButton
            v-if="hasSelection"
            size="sm"
            variant="soft"
            color="primary"
            @click="downloadSelected(selectedIds)"
          >
            Download Selected
          </UButton>
          <UButton
            v-if="hasSelection"
            size="sm"
            variant="soft"
            color="neutral"
            @click="deleteItems(selectedIds)"
          >
            Delete Selected
          </UButton>
          <UButton
            v-if="activeItems.length || historyItems.length"
            size="sm"
            variant="soft"
            color="primary"
            @click="downloadAllVisible"
          >
            Download All Visible
          </UButton>
          <UButton
            v-if="activeItems.length || historyItems.length"
            size="sm"
            variant="ghost"
            color="neutral"
            @click="deleteAll"
          >
            Delete All
          </UButton>
        </div>
      </div>

      <DropZone @files-selected="enqueueFiles" />

      <div v-if="hashingFiles.length" class="mt-4 rounded-xl border border-blue-500/20 bg-blue-500/10 p-4">
        <p class="text-sm font-medium text-blue-200">Hashing files locally before upload</p>
        <ul class="mt-2 space-y-1 text-sm text-blue-100">
          <li v-for="name in hashingFiles" :key="name">{{ name }}</li>
        </ul>
      </div>
    </section>

    <section>
      <div class="flex items-center justify-between gap-4 mb-4">
        <div>
          <h2 class="text-lg font-semibold text-[var(--text-heading)]">Active Queue</h2>
          <p class="text-sm text-[var(--text-muted)]">Uploads and processing items are pinned here.</p>
        </div>
      </div>

      <div v-if="!activeItems.length" class="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-6 text-sm text-[var(--text-muted)]">
        No active items. Drop PDFs above to start a batch.
      </div>

      <div v-else class="space-y-4">
        <QueueItemCard
          v-for="item in activeItems"
          :key="item.id"
          :item="item"
          :selected="selectedIds.includes(item.id)"
          :overall-progress="itemOverallProgress(item)"
          @toggle-selected="toggleSelected"
          @cancel="cancelItem"
          @delete="deleteItems([$event])"
          @download="downloadItem"
          @retry="retryItem"
        />
      </div>
    </section>

    <section>
      <div class="flex items-center justify-between gap-4 mb-4">
        <div>
          <h2 class="text-lg font-semibold text-[var(--text-heading)]">Recent History</h2>
          <p class="text-sm text-[var(--text-muted)]">Completed, failed, and cancelled items remain here for 30 days.</p>
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
          @toggle-selected="toggleSelected"
          @cancel="cancelItem"
          @delete="deleteItems([$event])"
          @download="downloadItem"
          @retry="retryItem"
        />
      </div>

      <div ref="historySentinel" class="h-10" />
      <div v-if="historyHasMore" class="mt-4 text-center text-sm text-[var(--text-muted)]">
        Scroll for more history
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' })

const {
  activeItems,
  historyItems,
  duplicateNotices,
  selectedIds,
  hashingFiles,
  hasSelection,
  historyHasMore,
  enqueueFiles,
  cancelItem,
  retryItem,
  deleteItems,
  deleteAll,
  toggleSelected,
  clearNotices,
  loadMoreHistory,
  downloadItem,
  downloadSelected,
  downloadAllVisible,
  itemOverallProgress,
} = useClientQueue()

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
