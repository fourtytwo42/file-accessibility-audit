import fs from 'node:fs'
import path from 'node:path'
import type { Response } from 'express'
import type { QueueItemRecord } from './queueStore.js'

function quoteCsv(value: string | number | null | undefined): string {
  const normalized = value === null || value === undefined ? '' : String(value)
  return `"${normalized.replace(/"/g, '""')}"`
}

function summarizeJsonArray(raw: string | null | undefined): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.map(entry => {
        if (typeof entry === 'string') return entry
        if (entry && typeof entry === 'object' && 'label' in entry) {
          const item = entry as { label?: string; details?: string }
          return [item.label, item.details].filter(Boolean).join(': ')
        }
        return JSON.stringify(entry)
      }).join(' | ')
    }
  } catch {}
  return ''
}

function manifestCsv(items: QueueItemRecord[]): string {
  const header = [
    'item_id',
    'filename',
    'md5',
    'original_score',
    'original_grade',
    'remediated_score',
    'remediated_grade',
    'remediation_status',
    'applied_fixes',
    'skipped_fixes',
    'manual_review_flags',
    'failure_reason',
  ].join(',')

  const rows = items.map(item => ([
    quoteCsv(item.id),
    quoteCsv(item.filename),
    quoteCsv(item.md5),
    quoteCsv(item.original_overall_score),
    quoteCsv(item.original_grade),
    quoteCsv(item.remediated_overall_score),
    quoteCsv(item.remediated_grade),
    quoteCsv(item.remediation_status),
    quoteCsv(summarizeJsonArray(item.applied_fixes_json)),
    quoteCsv(summarizeJsonArray(item.skipped_fixes_json)),
    quoteCsv(summarizeJsonArray(item.manual_review_flags_json)),
    quoteCsv(item.remediation_error_json ? JSON.parse(item.remediation_error_json)?.error || '' : ''),
  ])).map(columns => columns.join(','))

  return `${header}\n${rows.join('\n')}\n`
}

export async function streamQueueArchive(res: Response, items: QueueItemRecord[]): Promise<void> {
  const archiverModule = await import('archiver')
  const archiver = archiverModule.default

  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="remediated-pdfs-${Date.now()}.zip"`)

  const archive = archiver('zip', { zlib: { level: 9 } })
  const completion = new Promise<void>((resolve, reject) => {
    archive.on('error', reject)
    res.on('close', resolve)
    res.on('finish', resolve)
  })

  archive.pipe(res)
  archive.append(manifestCsv(items), { name: 'manifest.csv' })

  const usedNames = new Set<string>()
  for (const item of items) {
    if (!item.remediated_storage_path || !fs.existsSync(item.remediated_storage_path)) continue
    const ext = path.extname(item.filename) || '.pdf'
    const base = path.basename(item.filename, ext).replace(/[^\w.-]+/g, '_') || item.id
    let archiveName = `${base}${ext}`
    let suffix = 1
    while (usedNames.has(archiveName)) {
      archiveName = `${base}-${suffix}${ext}`
      suffix += 1
    }
    usedNames.add(archiveName)
    archive.file(item.remediated_storage_path, { name: archiveName })
  }

  await archive.finalize()
  await completion
}
