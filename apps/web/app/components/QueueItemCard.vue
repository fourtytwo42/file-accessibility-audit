<template>
  <div class="rounded-xl border border-[var(--border)] bg-[var(--surface-card)] overflow-hidden">
    <div class="px-4 py-4 border-b border-[var(--border-subtle)]">
      <div class="flex flex-wrap items-start gap-3">
        <input
          type="checkbox"
          class="mt-1 disabled:cursor-not-allowed disabled:opacity-40"
          :checked="selected"
          :disabled="!selectable"
          :title="selectable ? 'Select item' : 'Selection unavailable'"
          @change="$emit('toggle-selected', item.id)"
        >

        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <p class="font-medium text-[var(--text-heading)] break-all">{{ item.filename }}</p>
            <span v-if="showStatusChip" class="text-xs px-2 py-0.5 rounded-full capitalize" :class="statusClass">
              {{ statusChipLabel }}
            </span>
            <span
              v-if="item.originalGrade"
              class="text-xs px-2 py-0.5 rounded-full"
              :style="{ backgroundColor: originalGradeColor + '20', color: originalGradeColor }"
            >
              Original {{ item.originalGrade }}
            </span>
            <span
              v-if="item.rebuiltGrade"
              class="text-xs px-2 py-0.5 rounded-full"
              :style="{ backgroundColor: rebuiltGradeColor + '20', color: rebuiltGradeColor }"
            >
              Remediated {{ item.rebuiltGrade }}
            </span>
            <span
              v-if="item.documentModelStatus === 'processing'"
              class="text-xs px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300"
            >
              Planning
            </span>
          </div>
          <p class="text-xs text-[var(--text-muted)] mt-1">
            {{ formatDate(item.updatedAt) }}
          </p>
          <p v-if="reconstructionLabel" class="text-xs text-[var(--text-muted)] mt-1">
            {{ reconstructionLabel }}
          </p>
        </div>

        <div class="flex flex-wrap gap-2">
          <UButton
            v-if="item.canRetry"
            size="xs"
            variant="ghost"
            color="neutral"
            square
            title="Retry"
            aria-label="Retry"
            @click="$emit('retry', item.id)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M21 3v6h-6" />
            </svg>
          </UButton>
          <UButton
            v-if="item.canDownloadRebuilt"
            size="xs"
            variant="ghost"
            color="primary"
            square
            title="Download remediated accessible PDF"
            aria-label="Download remediated accessible PDF"
            @click="$emit('download-rebuilt', item.id)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 7v8" />
              <path stroke-linecap="round" stroke-linejoin="round" d="m8.5 12.5 3.5 3.5 3.5-3.5" />
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
            v-if="canShowDetailsButton"
            size="xs"
            variant="ghost"
            color="neutral"
            square
            :title="expanded ? 'Hide Details' : 'Show Details'"
            :aria-label="expanded ? 'Hide Details' : 'Show Details'"
            @click="toggleExpanded"
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

      <div v-if="showProgress" class="mt-4">
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

      <div v-if="item.reconstructionError" class="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
        {{ item.reconstructionError.error || 'Reconstruction failed after the original analysis was captured.' }}
      </div>
    </div>

    <div v-if="expanded" class="p-5 space-y-5">
      <div v-if="item.detailsLoading" class="rounded-xl border border-[var(--border)] bg-[var(--surface-card-alt)] p-5 text-sm text-[var(--text-muted)]">
        Loading details…
      </div>

      <div v-else-if="item.detailsError" class="rounded-xl border border-amber-500/20 bg-amber-500/10 p-5 text-sm text-amber-100">
        {{ item.detailsError }}
      </div>

      <div v-if="gradeComparisonVisible" class="grid gap-4 lg:grid-cols-2">
        <div v-if="item.originalResult" class="rounded-xl border border-[var(--border)] bg-[var(--surface-card-alt)] p-5">
          <p class="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-4">Original</p>
          <ScoreCard :result="item.originalResult" />
        </div>
        <div v-if="item.rebuiltResult" class="rounded-xl border border-[var(--border)] bg-[var(--surface-card-alt)] p-5">
          <p class="text-xs uppercase tracking-wide text-[var(--text-muted)] mb-4">Remediated</p>
          <ScoreCard :result="item.rebuiltResult" />
        </div>
      </div>

      <div v-if="mitigatedIssues.length || item.aiAppliedChanges.length || item.aiSuggestedChanges.length || item.manualReviewFlags.length || item.confidenceSummary || originalVeraPdf || remediatedVeraPdf" class="rounded-xl border border-[var(--border)] bg-[var(--surface-card-alt)] p-5 space-y-4">
        <div v-if="mitigatedIssues.length">
          <h3 class="text-sm font-semibold text-[var(--text-heading)]">Issues Mitigated</h3>
          <ul class="mt-2 space-y-2 text-sm text-emerald-100">
            <li
              v-for="issue in mitigatedIssues"
              :key="issue.label"
              class="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-3"
            >
              <p class="font-medium text-emerald-200">{{ issue.label }}</p>
              <p class="mt-1">{{ issue.summary }}</p>
            </li>
          </ul>
        </div>

        <div v-if="item.confidenceSummary">
          <h3 class="text-sm font-semibold text-[var(--text-heading)]">Confidence Summary</h3>
          <div class="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5 text-sm text-[var(--text-muted)]">
            <div class="rounded-lg border border-[var(--border)] px-3 py-2">Overall: {{ item.confidenceSummary.overall }}%</div>
            <div class="rounded-lg border border-[var(--border)] px-3 py-2">Text: {{ item.confidenceSummary.textRecovery }}%</div>
            <div class="rounded-lg border border-[var(--border)] px-3 py-2">Structure: {{ item.confidenceSummary.structureRecovery }}%</div>
            <div class="rounded-lg border border-[var(--border)] px-3 py-2">Tables: {{ item.confidenceSummary.tableRecovery }}%</div>
            <div class="rounded-lg border border-[var(--border)] px-3 py-2">Fidelity: {{ item.confidenceSummary.visualFidelity }}%</div>
          </div>
        </div>

        <div v-if="originalVeraPdf || remediatedVeraPdf">
          <h3 class="text-sm font-semibold text-[var(--text-heading)]">PDF/UA Validation</h3>
          <div class="mt-2 grid gap-3 md:grid-cols-2">
            <div v-if="originalVeraPdf" class="rounded-lg border border-[var(--border)] px-4 py-3 text-sm text-[var(--text-muted)]">
              <p class="font-medium text-[var(--text-heading)]">Original</p>
              <p class="mt-1">{{ formatVeraPdfStatus(originalVeraPdf) }}</p>
              <p v-if="originalVeraPdf.topFailures?.length" class="mt-2 text-xs">{{ originalVeraPdf.topFailures[0] }}</p>
            </div>
            <div v-if="remediatedVeraPdf" class="rounded-lg border border-[var(--border)] px-4 py-3 text-sm text-[var(--text-muted)]">
              <p class="font-medium text-[var(--text-heading)]">Remediated</p>
              <p class="mt-1">{{ formatVeraPdfStatus(remediatedVeraPdf) }}</p>
              <p v-if="remediatedVeraPdf.topFailures?.length" class="mt-2 text-xs">{{ remediatedVeraPdf.topFailures[0] }}</p>
            </div>
          </div>
        </div>

        <div v-if="item.pathFallbacks.length">
          <h3 class="text-sm font-semibold text-[var(--text-heading)]">Path Fallbacks</h3>
          <ul class="mt-2 space-y-2 text-sm text-[var(--text-muted)]">
            <li v-for="fallback in item.pathFallbacks" :key="fallback" class="rounded-lg border border-[var(--border)] px-4 py-3">
              {{ fallback }}
            </li>
          </ul>
        </div>

        <div v-if="item.aiAppliedChanges.length">
          <h3 class="text-sm font-semibold text-[var(--text-heading)]">AI-Applied Changes</h3>
          <ul class="mt-2 space-y-2 text-sm text-[var(--text-muted)]">
            <li v-for="change in item.aiAppliedChanges" :key="change.label + change.pageNumber" class="rounded-lg border border-[var(--border)] px-4 py-3">
              <p class="font-medium text-[var(--text-heading)]">{{ change.label }}</p>
              <p class="mt-1">{{ change.details }}</p>
              <p class="mt-1 text-xs">Confidence {{ Math.round(change.confidence * 100) }}%</p>
            </li>
          </ul>
        </div>

        <div v-if="item.aiSuggestedChanges.length">
          <h3 class="text-sm font-semibold text-[var(--text-heading)]">AI-Suggested / Deferred Changes</h3>
          <ul class="mt-2 space-y-2 text-sm text-[var(--text-muted)]">
            <li v-for="change in item.aiSuggestedChanges" :key="change.label + change.pageNumber" class="rounded-lg border border-[var(--border)] px-4 py-3">
              <p class="font-medium text-[var(--text-heading)]">{{ change.label }}</p>
              <p class="mt-1">{{ change.details }}</p>
              <p class="mt-1 text-xs">Confidence {{ Math.round(change.confidence * 100) }}%<span v-if="change.reason"> · {{ change.reason }}</span></p>
            </li>
          </ul>
        </div>

        <div v-if="item.manualReviewFlags.length">
          <h3 class="text-sm font-semibold text-[var(--text-heading)]">Manual Review Required</h3>
          <ul class="mt-2 space-y-3">
            <li
              v-for="flag in item.manualReviewFlags"
              :key="flag.code + (flag.pageNumber || '')"
              class="rounded-lg border px-4 py-3 text-sm"
              :class="flag.severity === 'critical' ? 'border-red-500/20 bg-red-500/10 text-red-100' : 'border-amber-500/20 bg-amber-500/10 text-amber-100'"
            >
              <p class="font-medium">{{ flag.label }}<span v-if="flag.pageNumber"> · Page {{ flag.pageNumber }}</span></p>
              <p class="mt-1 opacity-90">{{ flag.details }}</p>
            </li>
          </ul>
        </div>
      </div>

      <div v-if="item.documentModel" class="rounded-xl border border-[var(--border)] bg-[var(--surface-card-alt)] p-5">
        <h3 class="text-sm font-semibold text-[var(--text-heading)]">Remediation Record</h3>
        <div class="mt-3 grid gap-3 md:grid-cols-2 text-sm text-[var(--text-muted)]">
          <div>Path: <span class="text-[var(--text-heading)]">{{ processingPathLabel }}</span></div>
          <div>Source type: <span class="text-[var(--text-heading)]">{{ item.documentModel.sourceType }}</span></div>
          <div>Iterations: <span class="text-[var(--text-heading)]">{{ item.documentModel.iterations?.length || 0 }}</span></div>
          <div>Actions: <span class="text-[var(--text-heading)]">{{ item.documentModel.actions?.length || 0 }}</span></div>
          <div v-if="item.documentModel.originalVeraPdf">Original PDF/UA: <span class="text-[var(--text-heading)]">{{ formatVeraPdfStatus(item.documentModel.originalVeraPdf) }}</span></div>
          <div v-if="item.documentModel.remediatedVeraPdf">Remediated PDF/UA: <span class="text-[var(--text-heading)]">{{ formatVeraPdfStatus(item.documentModel.remediatedVeraPdf) }}</span></div>
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

      <div v-if="item.rebuiltResult" class="space-y-3">
        <h3 class="text-sm font-semibold text-[var(--text-heading)]">Remediated Findings</h3>
        <CategoryRow
          v-for="category in item.rebuiltResult.categories"
          :key="`rebuilt-${item.id}-${category.id}`"
          :category="category"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { isLocalIntakeItem, type ActiveQueueRow } from '../composables/useClientQueue'

const props = withDefaults(defineProps<{
  item: ActiveQueueRow
  selected: boolean
  overallProgress: number
  selectable?: boolean
  showProgress?: boolean
}>(), {
  selectable: false,
  showProgress: true,
})

const emit = defineEmits<{
  'toggle-selected': [itemId: string]
  retry: [itemId: string]
  delete: [itemId: string]
  'download-rebuilt': [itemId: string]
  'load-details': [itemId: string]
}>()

const expanded = ref(false)
const isLocalItem = computed(() => isLocalIntakeItem(props.item))

const showStatusChip = computed(() => isLocalItem.value || props.item.state !== 'complete')
const gradeComparisonVisible = computed(() => !!props.item.originalResult || !!props.item.rebuiltResult)
const canShowDetailsButton = computed(() =>
  !isLocalItem.value && (
    props.item.state === 'complete'
  || props.item.state === 'failed'
  || props.item.detailsLoaded
  || !!props.item.error
  || !!props.item.reconstructionError
  ),
)

const gradeColors: Record<string, string> = {
  A: '#22c55e',
  B: '#14b8a6',
  C: '#eab308',
  D: '#f97316',
  F: '#ef4444',
}

const originalGradeColor = computed(() => gradeColors[props.item.originalGrade || ''] || '#94a3b8')
const rebuiltGradeColor = computed(() => gradeColors[props.item.rebuiltGrade || ''] || '#94a3b8')
const processingPathLabel = computed(() => {
  if (props.item.processingPath === 'ai_html') return 'AI HTML'
  if (props.item.processingPath === 'agent_patch') return 'Agent Patch'
  return props.item.processingPath
})

const statusChipLabel = computed(() => {
  if (!isLocalItem.value) return props.item.state
  const map: Record<string, string> = {
    pending: 'Pending',
    hashing: 'Hashing',
    preflight: 'Preparing upload',
    uploading: 'Uploading',
    failed_intake: 'Intake failed',
  }
  return map[props.item.intakeStatus] || 'Pending'
})

const statusClass = computed(() => {
  if (isLocalItem.value) {
    const map: Record<string, string> = {
      pending: 'bg-slate-500/15 text-slate-300',
      hashing: 'bg-cyan-500/15 text-cyan-300',
      preflight: 'bg-blue-500/15 text-blue-300',
      uploading: 'bg-cyan-500/15 text-cyan-300',
      failed_intake: 'bg-red-500/15 text-red-300',
    }
    return map[props.item.intakeStatus] || 'bg-slate-500/15 text-slate-300'
  }
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

const reconstructionLabel = computed(() => {
  if (isLocalItem.value) return ''
  const map: Record<string, string> = {
    pending: 'Reconstruction pending',
    processing: 'Reconstruction in progress',
    completed: 'Remediated PDF completed',
    manual_review_required: 'Remediated PDF completed with manual review required',
    failed: 'Reconstruction failed',
  }
  return map[props.item.reconstructionStatus] || ''
})

const progressLabel = computed(() => {
  if (isLocalItem.value) {
    const map: Record<string, string> = {
      pending: 'Pending',
      hashing: 'Hashing',
      preflight: 'Preparing upload',
      uploading: 'Uploading',
      failed_intake: 'Failed',
    }
    return map[props.item.intakeStatus] || 'Pending'
  }
  if (props.item.state === 'uploading') return 'Uploading'
  if (props.item.state === 'queued') return 'Queued'
  if (props.item.state === 'processing') return props.item.processingStage || 'Processing'
  if (props.item.state === 'failed') return 'Failed'
  if (props.item.state === 'cancelled') return 'Cancelled'
  return 'Complete'
})

const mitigatedIssues = computed(() => {
  const originalCategories = props.item.originalResult?.categories
  const rebuiltCategories = props.item.rebuiltResult?.categories

  if (!Array.isArray(originalCategories) || !Array.isArray(rebuiltCategories)) {
    return []
  }

  return originalCategories.flatMap((originalCategory: any) => {
    const rebuiltCategory = rebuiltCategories.find((entry: any) => entry.id === originalCategory.id)
    if (!rebuiltCategory) return []

    const originalScore = typeof originalCategory.score === 'number' ? originalCategory.score : null
    const rebuiltScore = typeof rebuiltCategory.score === 'number' ? rebuiltCategory.score : null

    if (originalScore === null || rebuiltScore === null || rebuiltScore <= originalScore) {
      return []
    }

    const improvedBy = rebuiltScore - originalScore
    const resolvedFindings = (originalCategory.findings || []).filter((finding: string) => {
      const normalized = finding.toLowerCase()
      const looksProblematic = normalized.includes('missing')
        || normalized.includes('no ')
        || normalized.includes('not ')
        || normalized.includes('failed')
        || normalized.includes('raw url')
        || normalized.includes('out of sequence')
      if (!looksProblematic) return false
      return !(rebuiltCategory.findings || []).includes(finding)
    })

    let summary = `Improved from ${originalScore} to ${rebuiltScore}.`
    if (resolvedFindings.length) {
      summary = `Improved from ${originalScore} to ${rebuiltScore}. Resolved: ${resolvedFindings.slice(0, 2).join(' ')}`
    } else if (improvedBy > 0) {
      summary = `Improved by ${improvedBy} points after remediating the document.`
    }

    return [{
      label: originalCategory.label,
      summary,
    }]
  })
})

const originalVeraPdf = computed(() => props.item.originalResult?.verapdf || props.item.documentModel?.originalVeraPdf || null)
const remediatedVeraPdf = computed(() => props.item.rebuiltResult?.verapdf || props.item.documentModel?.remediatedVeraPdf || null)

function formatVeraPdfStatus(summary: any): string {
  if (!summary) return 'Unavailable'
  if (summary.status === 'passed') return 'Pass'
  if (summary.status === 'failed') {
    const count = Number(summary.failedChecks) || 0
    return `Fail${count ? ` (${count})` : ''}`
  }
  if (summary.status === 'timeout') return 'Unavailable (timeout)'
  if (summary.status === 'parse_error') return 'Unavailable (parse error)'
  if (summary.status === 'error') return 'Unavailable (error)'
  return 'Unavailable'
}

function toggleExpanded() {
  expanded.value = !expanded.value
  if (expanded.value && !isLocalItem.value && !props.item.detailsLoaded && !props.item.detailsLoading) {
    emit('load-details', props.item.id)
  }
}

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
