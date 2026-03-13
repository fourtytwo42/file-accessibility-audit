<template>
  <div>
    <div
      class="flex flex-col items-center justify-center min-h-[50vh] border-2 border-dashed rounded-2xl transition-all cursor-pointer"
      :class="dragging
        ? 'border-green-400 bg-green-400/5 scale-[1.01]'
        : 'border-[var(--border-input)] hover:border-[var(--border-hover)] bg-[var(--surface-card-50)]'"
      @dragover.prevent.stop
      @dragenter.prevent.stop="onDragEnter"
      @dragleave.prevent.stop="onDragLeave"
      @drop.prevent.stop="handleDrop"
      @click="openPicker"
    >
      <div class="text-center space-y-4 p-8">
        <div class="mx-auto w-16 h-16 rounded-full bg-[var(--surface-icon)] flex items-center justify-center">
          <svg class="w-8 h-8 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12l-3-3m0 0l-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
        </div>

        <div>
          <p class="text-lg font-medium" :class="dragging ? 'text-green-400' : 'text-[var(--text-heading)]'">
            {{ dragging ? 'Drop your PDFs or folder here' : 'Drop PDFs or a folder here' }}
          </p>
          <p class="text-sm text-[var(--text-muted)] mt-1">or click to browse - PDF only, max 100 MB each</p>
        </div>
      </div>
    </div>

    <input
      ref="fileInput"
      type="file"
      multiple
      accept=".pdf,application/pdf"
      class="hidden"
      @change="handleFileInput"
    />
  </div>
</template>

<script setup lang="ts">
const emit = defineEmits<{
  'files-selected': [files: File[]]
}>()

const dragging = ref(false)
const dragCounter = ref(0)
const fileInput = ref<HTMLInputElement | null>(null)

function onDragEnter() {
  dragCounter.value++
  dragging.value = true
}

function onDragLeave() {
  dragCounter.value--
  if (dragCounter.value <= 0) {
    dragCounter.value = 0
    dragging.value = false
  }
}

onMounted(() => {
  const prevent = (e: DragEvent) => {
    const hasFiles = Array.from(e.dataTransfer?.types || []).includes('Files')
    if (!hasFiles) return
    e.preventDefault()
  }

  window.addEventListener('dragover', prevent, true)
  window.addEventListener('drop', prevent, true)
  document.addEventListener('dragover', prevent, true)
  document.addEventListener('drop', prevent, true)
  onUnmounted(() => {
    window.removeEventListener('dragover', prevent, true)
    window.removeEventListener('drop', prevent, true)
    document.removeEventListener('dragover', prevent, true)
    document.removeEventListener('drop', prevent, true)
  })
})

function openPicker() {
  fileInput.value?.click()
}

async function handleDrop(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  dragCounter.value = 0
  dragging.value = false
  const files = await extractDroppedPdfFiles(e.dataTransfer)
  processFiles(files)
}

function handleFileInput(e: Event) {
  const input = e.target as HTMLInputElement
  processFiles(Array.from(input.files || []))
  input.value = ''
}

function processFiles(files: File[]) {
  const valid = files.filter(file => file.name.toLowerCase().endsWith('.pdf') && file.size <= 100 * 1024 * 1024)
  if (!valid.length) {
    alert('Please select at least one PDF under the 100 MB limit')
    return
  }
  emit('files-selected', valid)
}

async function extractDroppedPdfFiles(dataTransfer?: DataTransfer | null): Promise<File[]> {
  if (!dataTransfer) return []
  const items = Array.from(dataTransfer.items || [])
  const supportsEntries = items.some(item => typeof (item as any).webkitGetAsEntry === 'function')

  if (!supportsEntries) {
    return Array.from(dataTransfer.files || []).filter(file => file.name.toLowerCase().endsWith('.pdf'))
  }

  const nested = await Promise.all(items.map(item => walkEntry((item as any).webkitGetAsEntry?.())))
  return nested.flat()
}

async function walkEntry(entry: any): Promise<File[]> {
  if (!entry) return []

  if (entry.isFile) {
    const file = await new Promise<File | null>(resolve => entry.file((value: File) => resolve(value), () => resolve(null)))
    return file && file.name.toLowerCase().endsWith('.pdf') ? [file] : []
  }

  if (!entry.isDirectory) return []

  const reader = entry.createReader()
  const children = await readAllEntries(reader)
  const nested = await Promise.all(children.map((child: any) => walkEntry(child)))
  return nested.flat()
}

async function readAllEntries(reader: any): Promise<any[]> {
  const all: any[] = []
  while (true) {
    const batch = await new Promise<any[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (!batch.length) break
    all.push(...batch)
  }
  return all
}
</script>
