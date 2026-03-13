import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import cookieParser from 'cookie-parser'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import db from '../db/sqlite.js'
import queueRoutes from '../routes/queue.js'
import { createClient, createQueueItem, updateQueueItem } from '../services/queueStore.js'

let server: ReturnType<express.Express['listen']>
let baseUrl = ''

function randomClientId(seed: string): string {
  const hex = seed.replace(/[^a-f0-9]/gi, '').toLowerCase().padEnd(12, '0').slice(0, 12)
  return `12345678-1234-1234-1234-${hex}`
}

async function bootstrap(clientId: string): Promise<{ cookie: string }> {
  const response = await fetch(`${baseUrl}/api/client/bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-client-id': clientId,
    },
    body: JSON.stringify({ clientId }),
  })

  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')
  expect(cookie).toBeTruthy()
  return { cookie: cookie! }
}

function authHeaders(clientId: string, cookie: string): Record<string, string> {
  return {
    'x-client-id': clientId,
    cookie,
  }
}

function writeDocumentModel(name: string, data: unknown): string {
  const modelPath = path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  fs.writeFileSync(modelPath, JSON.stringify(data), 'utf8')
  return modelPath
}

describe('queue routes', () => {
  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use('/api', queueRoutes)
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Failed to bind test server')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(() => {
    const rows = db.prepare('SELECT document_model_path FROM queue_items').all() as Array<{ document_model_path: string | null }>
    for (const row of rows) {
      if (row.document_model_path && fs.existsSync(row.document_model_path)) {
        fs.unlinkSync(row.document_model_path)
      }
    }
    db.prepare('DELETE FROM queue_items').run()
    db.prepare('DELETE FROM browser_sessions').run()
    db.prepare('DELETE FROM browser_clients').run()
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  })

  it('returns a DB-backed queue status snapshot ordered by updatedAt desc', async () => {
    const clientId = randomClientId('status1')
    createClient(clientId)
    const older = createQueueItem({
      clientId,
      filename: 'older.pdf',
      md5: 'a'.repeat(32),
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })
    updateQueueItem(older.id, {
      state: 'complete',
      processing_stage: 'Complete',
      overall_score: 88,
      grade: 'B',
      result_json: JSON.stringify({
        overallScore: 88,
        grade: 'B',
        verapdf: { status: 'failed', failedChecks: 2, failures: [{ message: 'Minor standards issue' }] },
      }),
      completed_at: '2026-03-13T00:01:00.000Z',
    })
    db.prepare('UPDATE queue_items SET updated_at = ? WHERE id = ?').run('2026-03-13T00:01:00.000Z', older.id)

    const newer = createQueueItem({
      clientId,
      filename: 'newer.pdf',
      md5: 'b'.repeat(32),
      sizeBytes: 200,
      mimeType: 'application/pdf',
    })
    updateQueueItem(newer.id, {
      state: 'processing',
      processing_stage: 'Applying fixes',
      overall_score: 99,
      grade: 'B',
      result_json: JSON.stringify({
        overallScore: 99,
        grade: 'B',
        verapdf: { status: 'failed', failedChecks: 1, failures: [{ message: 'Tabs shall be set to /S' }] },
      }),
    })
    db.prepare('UPDATE queue_items SET updated_at = ? WHERE id = ?').run('2026-03-13T00:02:00.000Z', newer.id)

    const hidden = createQueueItem({
      clientId,
      filename: 'hidden.pdf',
      md5: 'c'.repeat(32),
      sizeBytes: 300,
      mimeType: 'application/pdf',
    })
    updateQueueItem(hidden.id, { hidden: 1, state: 'complete' })

    const { cookie } = await bootstrap(clientId)
    const response = await fetch(`${baseUrl}/api/queue/status`, {
      headers: authHeaders(clientId, cookie),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.items).toHaveLength(2)
    expect(body.items.map((item: any) => item.filename)).toEqual(['newer.pdf', 'older.pdf'])
    expect(body.items[0].standardsSummary.gradeBasis.scoreCappedByStandards).toBe(true)
    expect(body.counts).toEqual({
      active: 1,
      history: 1,
      processing: 1,
      failed: 0,
      complete: 1,
    })
    expect(typeof body.generatedAt).toBe('string')
  })

  it('returns original and rebuilt versions with download URLs', async () => {
    const clientId = randomClientId('version1')
    createClient(clientId)
    const item = createQueueItem({
      clientId,
      filename: 'example.pdf',
      md5: 'd'.repeat(32),
      sizeBytes: 400,
      mimeType: 'application/pdf',
    })
    const modelPath = writeDocumentModel('queue-versions', {
      version: '6',
      sourceType: 'native-text',
      confidenceSummary: null,
      manualReviewFlags: [],
      aiAppliedChanges: [],
      aiSuggestedChanges: [],
      originalVeraPdf: {
        status: 'failed',
        profile: 'PDF/UA-1',
        flavour: 'UA',
        failedChecks: 7,
        passedChecks: 12,
        topFailures: ['Original issue'],
      },
      remediatedVeraPdf: {
        status: 'passed',
        profile: 'PDF/UA-1',
        flavour: 'UA',
        failedChecks: 0,
        passedChecks: 19,
        topFailures: [],
      },
    })

    updateQueueItem(item.id, {
      state: 'complete',
      original_storage_path: 'C:\\queue\\original.pdf',
      rebuilt_storage_path: 'C:\\queue\\rebuilt.pdf',
      document_model_path: modelPath,
      original_overall_score: 54,
      original_grade: 'F',
      rebuilt_overall_score: 96,
      rebuilt_grade: 'A',
      result_json: JSON.stringify({
        overallScore: 96,
        grade: 'A',
        verapdf: { status: 'passed', failedChecks: 0, topFailures: [] },
      }),
      original_result_json: JSON.stringify({
        overallScore: 54,
        grade: 'F',
        verapdf: { status: 'failed', failedChecks: 7, failures: [{ message: 'Original issue' }] },
      }),
      rebuilt_result_json: JSON.stringify({
        overallScore: 96,
        grade: 'A',
        verapdf: { status: 'passed', failedChecks: 0, topFailures: [] },
      }),
      completed_at: '2026-03-13T00:03:00.000Z',
    })

    const { cookie } = await bootstrap(clientId)
    const response = await fetch(`${baseUrl}/api/queue/items/${item.id}/versions`, {
      headers: authHeaders(clientId, cookie),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.itemId).toBe(item.id)
    expect(body.versions).toEqual([
      expect.objectContaining({
        key: 'original',
        kind: 'input',
        score: 54,
        grade: 'F',
        veraPdfStatus: 'failed',
        veraPdfFailedChecks: 7,
        downloadUrl: `/api/queue/items/${item.id}/download-original`,
      }),
      expect.objectContaining({
        key: 'rebuilt',
        kind: 'output',
        score: 96,
        grade: 'A',
        veraPdfStatus: 'passed',
        veraPdfFailedChecks: 0,
        downloadUrl: `/api/queue/items/${item.id}/download`,
      }),
    ])
  })

  it('returns 404 for hidden or foreign-client version requests', async () => {
    const ownerClientId = randomClientId('owner1')
    const otherClientId = randomClientId('other1')
    createClient(ownerClientId)
    createClient(otherClientId)
    const item = createQueueItem({
      clientId: ownerClientId,
      filename: 'secret.pdf',
      md5: 'e'.repeat(32),
      sizeBytes: 500,
      mimeType: 'application/pdf',
    })
    updateQueueItem(item.id, { original_storage_path: 'C:\\queue\\secret.pdf', hidden: 1 })

    const { cookie } = await bootstrap(otherClientId)
    const response = await fetch(`${baseUrl}/api/queue/items/${item.id}/versions`, {
      headers: authHeaders(otherClientId, cookie),
    })

    expect(response.status).toBe(404)
  })

  it('returns only the original version when no rebuilt artifact exists', async () => {
    const clientId = randomClientId('version2')
    createClient(clientId)
    const item = createQueueItem({
      clientId,
      filename: 'original-only.pdf',
      md5: 'f'.repeat(32),
      sizeBytes: 600,
      mimeType: 'application/pdf',
    })
    updateQueueItem(item.id, {
      state: 'failed',
      original_storage_path: 'C:\\queue\\original-only.pdf',
      original_overall_score: 61,
      original_grade: 'D',
      original_result_json: JSON.stringify({
        overallScore: 61,
        grade: 'D',
        verapdf: { status: 'failed', failedChecks: 4, failures: [{ message: 'Needs remediation' }] },
      }),
    })

    const { cookie } = await bootstrap(clientId)
    const response = await fetch(`${baseUrl}/api/queue/items/${item.id}/versions`, {
      headers: authHeaders(clientId, cookie),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.versions).toHaveLength(1)
    expect(body.versions[0]).toEqual(expect.objectContaining({
      key: 'original',
      score: 61,
      grade: 'D',
      veraPdfStatus: 'failed',
      veraPdfFailedChecks: 4,
    }))
  })

  it('bulk remediation requeues only eligible visible items', async () => {
    const clientId = randomClientId('bulkremed')
    createClient(clientId)
    const ready = createQueueItem({
      clientId,
      filename: 'retry.pdf',
      md5: '1'.repeat(32),
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })
    updateQueueItem(ready.id, {
      state: 'failed',
      original_storage_path: 'C:\\queue\\retry.pdf',
      result_json: JSON.stringify({ overallScore: 55, grade: 'F' }),
      rebuilt_storage_path: 'C:\\queue\\rebuilt.pdf',
    })

    const processing = createQueueItem({
      clientId,
      filename: 'busy.pdf',
      md5: '2'.repeat(32),
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })
    updateQueueItem(processing.id, {
      state: 'processing',
      original_storage_path: 'C:\\queue\\busy.pdf',
    })

    const { cookie } = await bootstrap(clientId)
    const response = await fetch(`${baseUrl}/api/queue/remediate-many`, {
      method: 'POST',
      headers: {
        ...authHeaders(clientId, cookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ itemIds: [ready.id, processing.id, 'missing-id'] }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.count).toBe(1)
    expect(body.items).toHaveLength(1)
    expect(body.items[0].id).toBe(ready.id)
    const updated = db.prepare('SELECT state, processing_stage FROM queue_items WHERE id = ?').get(ready.id) as any
    expect(updated.state).toBe('queued')
    expect(updated.processing_stage).toBe('Queued for remediation')
  })

  it('bulk reanalysis queues analysis-only runs and rejects fully invalid batches', async () => {
    const clientId = randomClientId('bulkanal')
    createClient(clientId)
    const item = createQueueItem({
      clientId,
      filename: 'reanalyze.pdf',
      md5: '3'.repeat(32),
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })
    updateQueueItem(item.id, {
      state: 'complete',
      original_storage_path: 'C:\\queue\\reanalyze.pdf',
      rebuilt_storage_path: 'C:\\queue\\old-output.pdf',
      result_json: JSON.stringify({ overallScore: 91, grade: 'A' }),
    })

    const { cookie } = await bootstrap(clientId)
    const okResponse = await fetch(`${baseUrl}/api/queue/reanalyze-many`, {
      method: 'POST',
      headers: {
        ...authHeaders(clientId, cookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ itemIds: [item.id] }),
    })

    expect(okResponse.status).toBe(200)
    const row = db.prepare('SELECT state, processing_stage, path_fallbacks_json FROM queue_items WHERE id = ?').get(item.id) as any
    expect(row.state).toBe('queued')
    expect(row.processing_stage).toBe('Queued for re-analysis')
    expect(row.path_fallbacks_json).toContain('__reanalyze_only__')

    const notFoundResponse = await fetch(`${baseUrl}/api/queue/reanalyze-many`, {
      method: 'POST',
      headers: {
        ...authHeaders(clientId, cookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ itemIds: ['missing-id'] }),
    })

    expect(notFoundResponse.status).toBe(404)
  })
})
