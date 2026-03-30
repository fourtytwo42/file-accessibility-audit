#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const apiBase = process.env.MANUAL_QUEUE_API_BASE || 'http://127.0.0.1:6103'
const clientId = process.env.MANUAL_QUEUE_CLIENT_ID || '44444444-4444-4444-8444-444444444444'
const tokenPath = process.env.MANUAL_QUEUE_TOKEN_PATH || '/tmp/pdfaf_internal_worker_token'
const batchSize = Math.max(1, Number(process.env.MANUAL_QUEUE_BATCH_SIZE || 4))
const pollMs = Math.max(5000, Number(process.env.MANUAL_QUEUE_POLL_MS || 15000))
const stallPolls = Math.max(4, Number(process.env.MANUAL_QUEUE_STALL_POLLS || 20))
const dbPath = path.join(repoRoot, 'apps', 'api', 'data', 'audit.db')

const token = fs.readFileSync(tokenPath, 'utf8').trim()
const db = new Database(dbPath, { readonly: true })
const dbWrite = new Database(dbPath)
const active = new Map()

function log(message) {
  const line = `[manual-runner] ${new Date().toISOString()} ${message}`
  console.log(line)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function safeStem(filename) {
  const stem = path.basename(filename, '.pdf')
  return `${stem.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'pdf'}.json`
}

function allCompleteFilenames() {
  const results = new Set()
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(next)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) results.add(entry.name)
    }
  }
  walk(path.join(repoRoot, 'Complete'))
  return results
}

function listVisibleRows() {
  return db.prepare(`
    SELECT id, filename, state, processing_stage, processing_progress, owner_id, job_group,
           promotion_status, COALESCE(promotion_rejection_reason, '') AS reason, hidden,
           created_at, updated_at
    FROM queue_items
    WHERE client_id = ? AND hidden = 0
    ORDER BY created_at DESC
  `).all(clientId)
}

function rowById(id) {
  return db.prepare(`
    SELECT id, filename, state, processing_stage, processing_progress, owner_id, job_group,
           promotion_status, COALESCE(promotion_rejection_reason, '') AS reason, hidden,
           created_at, updated_at
    FROM queue_items
    WHERE id = ?
  `).get(id)
}

function hideRow(id) {
  dbWrite.prepare('UPDATE queue_items SET hidden = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)
}

function nextCandidates(limit = batchSize) {
  const downloads = fs.readdirSync(path.join(repoRoot, 'Downloads'))
    .filter(name => name.toLowerCase().endsWith('.pdf'))
    .sort()
  const complete = allCompleteFilenames()
  const needs = new Set(
    fs.readdirSync(path.join(repoRoot, 'NeedsApiFix'))
      .filter(name => name.endsWith('.json') && name !== 'manifest.json'),
  )
  const visible = listVisibleRows()
  const visibleActive = new Set(
    visible
      .filter(row => row.state === 'queued' || row.state === 'processing')
      .map(row => row.filename),
  )
  const picked = []
  for (const filename of downloads) {
    if (complete.has(filename)) continue
    if (needs.has(safeStem(filename))) continue
    if (visibleActive.has(filename)) continue
    picked.push(filename)
    if (picked.length >= limit) break
  }
  return picked
}

async function api(pathname, options = {}) {
  const res = await fetch(`${apiBase}${pathname}`, {
    ...options,
    headers: {
      'x-client-id': clientId,
      'x-internal-worker-token': token,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const text = await res.text()
  const body = text ? JSON.parse(text) : null
  if (!res.ok) {
    throw new Error(`${pathname} ${res.status}: ${body?.error || text}`)
  }
  return body
}

async function startPdf(filename, lane) {
  const body = await api('/api/queue/start-or-reuse', {
    method: 'POST',
    body: JSON.stringify({
      filename,
      ownerId: lane,
      jobGroup: 'manual-batch',
    }),
  })
  const item = body.item
  active.set(item.id, {
    id: item.id,
    filename,
    lane,
    lastState: item.state,
    lastStage: item.processingStage || '',
    lastProgress: item.processingProgress || 0,
    stablePolls: 0,
  })
  log(`started ${lane} ${filename} -> ${item.id} state=${item.state}`)
}

function blockerSummaryFromValidation(filename, validation) {
  const reasons = []
  if (validation.visualComparison && !validation.visualComparison.passed) {
    reasons.push(`visual fidelity failed (${validation.visualComparison.reason})`)
  }
  if (validation.bookmarkValidation && !validation.bookmarkValidation.passed) {
    reasons.push(validation.bookmarkValidation.reason)
  }
  if (Array.isArray(validation.reasons) && validation.reasons.length > 0) {
    reasons.push(...validation.reasons)
  }
  return `${filename} did not pass the stop gate: ${reasons.filter(Boolean).join('; ') || 'blocking accessibility debt remains.'}`
}

async function closeCompleteItem(row) {
  const result = await api(`/api/queue/items/${row.id}/validate-for-complete`, { method: 'POST', body: '{}' })
  const validation = result.validation
  if (validation.promotionEligible) {
    const promoted = await api(`/api/queue/items/${row.id}/promote`, { method: 'POST', body: '{}' })
    log(`promoted ${row.filename} -> ${promoted.destinationPath}`)
    return 'promoted'
  }
  const summary = blockerSummaryFromValidation(row.filename, validation)
  const emitted = await api(`/api/queue/items/${row.id}/emit-blocker`, {
    method: 'POST',
    body: JSON.stringify({
      blockerType: 'validation_failure',
      subsystem: 'manual-runner',
      summary,
      reusable: true,
    }),
  })
  log(`blocked ${row.filename} -> ${emitted.needsApiFix.recordPath}`)
  return 'blocked'
}

async function emitRuntimeStall(row) {
  const emitted = await api(`/api/queue/items/${row.id}/emit-blocker`, {
    method: 'POST',
    body: JSON.stringify({
      blockerType: 'runtime_stall',
      subsystem: 'manual-runner',
      summary: `${row.filename} stayed ${row.state} at "${row.processing_stage || 'unknown stage'}" without enough progress to reach a terminal promotable result in the current runtime.`,
      reusable: true,
    }),
  })
  hideRow(row.id)
  log(`runtime-stall ${row.filename} -> ${emitted.needsApiFix.recordPath}`)
}

function hideRejectedActiveRows() {
  const rows = listVisibleRows().filter(
    row => (row.state === 'queued' || row.state === 'processing') && row.promotion_status === 'rejected',
  )
  for (const row of rows) {
    hideRow(row.id)
    log(`hid stale rejected active row ${row.filename} (${row.state})`)
  }
}

async function tickActive() {
  for (const [id, info] of [...active.entries()]) {
    const row = rowById(id)
    if (!row || row.hidden) {
      active.delete(id)
      continue
    }
    if (row.state === 'complete') {
      await closeCompleteItem(row)
      active.delete(id)
      continue
    }
    if (row.state === 'failed' || row.state === 'cancelled') {
      await emitRuntimeStall(row)
      active.delete(id)
      continue
    }

    const unchanged = row.state === info.lastState
      && (row.processing_stage || '') === info.lastStage
      && Number(row.processing_progress || 0) === Number(info.lastProgress || 0)

    if (unchanged) info.stablePolls += 1
    else {
      info.stablePolls = 0
      info.lastState = row.state
      info.lastStage = row.processing_stage || ''
      info.lastProgress = row.processing_progress || 0
    }

    log(`poll ${row.filename} state=${row.state} progress=${row.processing_progress} stage=${row.processing_stage || ''} stable=${info.stablePolls}`)

    if (info.stablePolls >= stallPolls) {
      await emitRuntimeStall(row)
      active.delete(id)
    }
  }
}

async function closeVisibleUnvalidatedCompletes() {
  const rows = listVisibleRows().filter(row => row.state === 'complete' && row.promotion_status === 'unvalidated')
  for (const row of rows) {
    await closeCompleteItem(row)
  }
}

async function fillBatch() {
  const lanes = ['Lane-A', 'Lane-B', 'Lane-C', 'Lane-D']
  const used = new Set([...active.values()].map(item => item.lane))
  const openLanes = lanes.filter(lane => !used.has(lane))
  if (!openLanes.length) return
  const candidates = nextCandidates(openLanes.length)
  for (let i = 0; i < Math.min(openLanes.length, candidates.length); i += 1) {
    await startPdf(candidates[i], openLanes[i])
  }
}

async function main() {
  log(`starting manual runner batchSize=${batchSize} pollMs=${pollMs} stallPolls=${stallPolls}`)
  hideRejectedActiveRows()
  await closeVisibleUnvalidatedCompletes()
  await fillBatch()
  while (true) {
    await tickActive()
    hideRejectedActiveRows()
    await closeVisibleUnvalidatedCompletes()
    await fillBatch()

    const candidates = nextCandidates(1)
    if (active.size === 0 && candidates.length === 0) {
      log('no active items and no remaining candidates; stopping')
      return
    }
    await sleep(pollMs)
  }
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
