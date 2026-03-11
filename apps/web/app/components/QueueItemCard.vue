<template>
  <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] overflow-hidden">
    <div class="px-4 py-4 border-b border-[var(--border-subtle)]">
      <div class="flex flex-wrap items-start gap-3">
        <input
          type="checkbox"
          class="mt-1"
          :checked="selected"
          @change="$emit('toggle-selected', item.id)"
        >

        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <p class="font-medium text-[var(--text-heading)] break-all">{{ item.filename }}</p>
            <span v-if="showStatusChip" class="text-xs px-2 py-0.5 rounded-full capitalize" :class="statusClass">
              {{ item.state }}
            </span>
            <span
              v-if="item.originalGrade"
              class="text-xs px-2 py-0.5 rounded-full"
              :style="{ backgroundColor: originalGradeColor + '20', color: originalGradeColor }"
            >
              Original {{ item.originalGrade }}
            </span>
            <span
              v-if="item.remediatedGrade"
              class="text-xs px-2 py-0.5 rounded-full"
              :style="{ backgroundColor: remediatedGradeColor + '20', color: remediatedGradeColor }"
            >
              Fixed {{ item.remediatedGrade }}
            </span>
            <span
              v-if="item.manualReviewFlags.length"
              class="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300"
            >
              Manual Review
            </span>
          </div>
          <p class="text-xs text-[var(--text-muted)] mt-1">
            {{ formatDate(item.updatedAt) }}
          </p>
          <p v-if="remediationLabel" class="text-xs text-[var(--text-muted)] mt-1">
            {{ remediationLabel }}
          </p>
        </div>

        <div class="flex flex-wrap gap-2">
          <UButton v-if="item.canRetry" size="xs" variant="soft" color="neutral" @click="$emit('retry', item.id)">
            Retry
          </UButton>
          <UButton v-if="item.canCancel" size="xs" variant="soft" color="neutral" @click="$emit('cancel', item.id)">
            Cancel
          </UButton>
          <UButton
            v-if="item.canDownloadRemediated"
            size="xs"
            variant="ghost"
            color="neutral"
            square
            title="Download fixed PDF"
            aria-label="Download fixed PDF"
            @click="$emit('download', item.id)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12" />
              <path stroke-linecap="round" stroke-linejoin="round" d="m7 10 5 5 5-5" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 21h14" />
            </svg>
          </UButton>
          <UButton
            size="xs"
            variant="ghost"
            color="error"
            square
            title="Delete"
            aria-label="Delete"
            @click="$emit('delete', item.id)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 6h18" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M8 6V4h8v2" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 6l-1 14H6L5 6" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M10 11v6" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M14 11v6" />
            </svg>
          </UButton>
          <UButton
            v-if="item.originalResult || item.remediatedResult || item.manualReviewFlags.length"
            size="xs"
            variant="ghost"
            color="neutral"
            square
            :title="expanded ? 'Hide Details' : 'Show Details'"
            :aria-label="expanded ? 'Hide Details' : 'Show Details'"
            @click="expanded = !expanded"
          >
            <svg
              v-if="expanded"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="h-4 w-4"
              aria-hidden="true"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 3l18 18" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M10.6 10.6A3 3 0 0 0 12 15a3 3 0 0 0 2.4-4.4" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M9.9 5.2A10.7 10.7 0 0 1 12 5c5 0 9.3 3 10 7-.3 1.7-1.3 3.2-2.8 4.4" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M6.2 6.2C4 7.5 2.5 9.6 2 12c.7 4 5 7 10 7 1.5 0 3-.3 4.2-.8" />
            </svg>
            <svg
              v-else
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="h-4 w-4"
              aria-hidden="true"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </UButton>
        </div>
      </div>

      <div class="mt-4">
        <div>
          <div class="flex items-center justify-between text-xs text-[var(--text-muted)] mb-1">
            <span>{{ progressLabel }}</span>
            <span>{{ overallProgress }}%</span>
          </div>
          <div class="h-2 rounded-full bg-[var(--surface-icon)] overflow-hidden">
            <div class="h-full rounded-full bg-blue-500 transition-all" :style="{ width: `${overallProgress}%` }" />
          </div>
        </div>
      </div>

      <div v-if="item.error" class="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
        {{ item.error.error || item.error.details || 'This item failed.' }}
      </div>

      <div v-if="item.remediationError" class="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
        {{ item.remediationError.error || 'Remediation failed after the original analysis was captured.' }}
      </div>
    </div>

    <div v-if="expanded" class="p-5 space-y-5">
      <div v-if="gradeComparisonVisible" class="grid gap-4 lg:grid-cols-2">
        <div v-if="item.originalResult" class="rounded-xl border border-[var(--border)] bg-[var(--surface-card-alt)] p-5">
          <p class="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-4">Original</p>
          <ScoreCard :result="item.originalResult" />
        </div>
        <div v-if="item.remediatedResult" class="rounded-xl border border-[var(--border)] bg-[var(--surface-card-alt)] p-5">
          <p class="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-4">Fixed</p>
          <ScoreCard :result="item.remediatedResult" />
        </div>
      </div>

      <div v-if="item.appliedFixes.length || item.skippedFixes.length || item.manualReviewFlags.length" class="rounded-xl border border-[var(--border)] bg-[var(--surface-card-alt)] p-5 space-y-4">
        <div v-if="item.appliedFixes.length">
          <h3 class="text-sm font-semibold text-[var(--text-heading)]">Applied Fixes</h3>
          <ul class="mt-2 space-y-2 text-sm text-[var(--text-muted)]">
            <li v-for="fix in item.appliedFixes" :key="fix">• {{ fix }}</li>
          </ul>
        </div>

        <div v-if="item.skippedFixes.length">
          <h3 class="text-sm font-semibold text-[var(--text-heading)]">Skipped Fixes</h3>
          <ul class="mt-2 space-y-2 text-sm text-[var(--text-muted)]">
            <li v-for="fix in item.skippedFixes" :key="fix">• {{ fix }}</li>
          </ul>
        </div>

        <div v-if="item.manualReviewFlags.length">
          <h3 class="text-sm font-semibold text-[var(--text-heading)]">Manual Review Required</h3>
          <ul class="mt-2 space-y-3">
            <li
              v-for="flag in item.manualReviewFlags"
              :key="flag.code"
              class="rounded-lg border px-4 py-3 text-sm"
              :class="flag.severity === 'critical' ? 'border-red-500/20 bg-red-500/10 text-red-100' : 'border-amber-500/20 bg-amber-500/10 text-amber-100'"
            >
              <p class="font-medium">{{ flag.label }}</p>
              <p class="mt-1 opacity-90">{{ flag.details }}</p>
            </li>
          </ul>
        </div>
      </div>

      <div v-if="item.originalResult" class="space-y-3">
        <h3 class="text-sm font-semibold text-[var(--text-heading)]">Original Findings</h3>
        <CategoryRow
          v-for="category in item.originalResult.categories"
          :key="`original-${item.id}-${category.id}`"
          :category="category"
        />
      </div>

      <div v-if="item.remediatedResult" class="space-y-3">
        <h3 class="text-sm font-semibold text-[var(--text-heading)]">Fixed Findings</h3>
        <CategoryRow
          v-for="category in item.remediatedResult.categories"
          :key="`fixed-${item.id}-${category.id}`"
          :category="category"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { QueueItem } from '../composables/useClientQueue'

const props = defineProps<{
  item: QueueItem
  selected: boolean
  overallProgress: number
}>()

defineEmits<{
  'toggle-selected': [itemId: string]
  retry: [itemId: string]
  cancel: [itemId: string]
  delete: [itemId: string]
  download: [itemId: string]
}>()

const expanded = ref(false)

const showStatusChip = computed(() => props.item.state !== 'complete')
const gradeComparisonVisible = computed(() => !!props.item.originalResult || !!props.item.remediatedResult)

const gradeColors: Record<string, string> = {
  A: '#22c55e',
  B: '#14b8a6',
  C: '#eab308',
  D: '#f97316',
  F: '#ef4444',
}

const originalGradeColor = computed(() => gradeColors[props.item.originalGrade || ''] || '#94a3b8')
const remediatedGradeColor = computed(() => gradeColors[props.item.remediatedGrade || ''] || '#94a3b8')

const statusClass = computed(() => {
  const map: Record<string, string> = {
    complete: 'bg-green-500/15 text-green-300',
    processing: 'bg-blue-500/15 text-blue-300',
    queued: 'bg-yellow-500/15 text-yellow-300',
    uploading: 'bg-cyan-500/15 text-cyan-300',
    failed: 'bg-red-500/15 text-red-300',
    cancelled: 'bg-slate-500/15 text-slate-300',
  }
  return map[props.item.state] || 'bg-slate-500/15 text-slate-300'
})

const remediationLabel = computed(() => {
  const map: Record<string, string> = {
    pending: 'Remediation pending',
    processing: 'Remediation in progress',
    completed: 'Automatic remediation completed',
    manual_review_required: 'Automatic remediation completed with manual review required',
    failed: 'Automatic remediation failed',
  }
  return map[props.item.remediationStatus] || ''
})

const progressLabel = computed(() => {
  if (props.item.state === 'uploading') return 'Uploading'
  if (props.item.state === 'queued') return 'Queued'
  if (props.item.state === 'processing') return props.item.processingStage || 'Processing'
  if (props.item.state === 'failed') return 'Failed'
  if (props.item.state === 'cancelled') return 'Cancelled'
  return 'Complete'
})

function formatDate(value: string): string {
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
</script>
