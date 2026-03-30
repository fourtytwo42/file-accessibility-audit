import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import cookieParser from 'cookie-parser'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import db from '../db/sqlite.js'
import queueRoutes from '../routes/queue.js'
import { createClient, createQueueItem, updateQueueItem } from '../services/queueStore.js'
import * as queuePromotionService from '../services/queuePromotionService.js'
import { getFixFamiliesReportPath, getRemediationLedgerPath } from '../services/remediationLedgerService.js'

let server: ReturnType<express.Express['listen']>
let baseUrl = ''
const INTERNAL_WORKER_TOKEN = 'test-internal-worker-token'
let testNeedsApiFixDir = ''
let testRemediationDataDir = ''

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

async function bootstrapWithoutClientId(cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/client/bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({}),
  })
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
    process.env.INTERNAL_QUEUE_WORKER_TOKEN = INTERNAL_WORKER_TOKEN
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

  beforeEach(() => {
    testNeedsApiFixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'needs-api-fix-'))
    testRemediationDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remediation-data-'))
    process.env.NEEDS_API_FIX_ROOT = testNeedsApiFixDir
    process.env.REMEDIATION_DATA_ROOT = testRemediationDataDir
  })

  afterEach(() => {
    vi.restoreAllMocks()
    const rows = db.prepare('SELECT document_model_path FROM queue_items').all() as Array<{ document_model_path: string | null }>
    for (const row of rows) {
      if (row.document_model_path && fs.existsSync(row.document_model_path)) {
        fs.unlinkSync(row.document_model_path)
      }
    }
    if (testNeedsApiFixDir && fs.existsSync(testNeedsApiFixDir)) {
      fs.rmSync(testNeedsApiFixDir, { recursive: true, force: true })
    }
    if (testRemediationDataDir && fs.existsSync(testRemediationDataDir)) {
      fs.rmSync(testRemediationDataDir, { recursive: true, force: true })
    }
    db.prepare('DELETE FROM queue_items').run()
    db.prepare('DELETE FROM browser_sessions').run()
    db.prepare('DELETE FROM browser_clients').run()
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    delete process.env.INTERNAL_QUEUE_WORKER_TOKEN
    delete process.env.NEEDS_API_FIX_ROOT
    delete process.env.REMEDIATION_DATA_ROOT
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

  it('restores the existing client session when bootstrap is called without a clientId', async () => {
    const clientId = randomClientId('restore1')
    createClient(clientId)
    createQueueItem({
      clientId,
      filename: 'restored.pdf',
      md5: '0'.repeat(32),
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })

    const { cookie } = await bootstrap(clientId)
    const restoreResponse = await bootstrapWithoutClientId(cookie)

    expect(restoreResponse.status).toBe(200)
    const restoreBody = await restoreResponse.json()
    expect(restoreBody.clientId).toBe(clientId)
    expect(restoreBody.restored).toBe(true)

    const statusResponse = await fetch(`${baseUrl}/api/queue/status`, {
      headers: authHeaders(clientId, cookie),
    })

    expect(statusResponse.status).toBe(200)
    const statusBody = await statusResponse.json()
    expect(statusBody.items).toHaveLength(1)
    expect(statusBody.items[0].filename).toBe('restored.pdf')
  })

  it('creates a new client session when bootstrap is called without a clientId and no cookie', async () => {
    const response = await bootstrapWithoutClientId()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(typeof body.clientId).toBe('string')
    expect(body.clientId).toMatch(/^[a-f0-9-]{20,}$/i)
    expect(body.restored).toBe(false)
    expect(response.headers.get('set-cookie')).toBeTruthy()
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

  it('delete permanently removes failed upload placeholders that never stored an artifact', async () => {
    const clientId = randomClientId('transient1')
    createClient(clientId)
    const failed = createQueueItem({
      clientId,
      filename: 'broken.pdf',
      md5: '5'.repeat(32),
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })
    updateQueueItem(failed.id, {
      state: 'failed',
      processing_stage: 'Upload failed',
      error_json: JSON.stringify({ error: 'network' }),
      completed_at: '2026-03-14T00:00:00.000Z',
    })

    const { cookie } = await bootstrap(clientId)
    const response = await fetch(`${baseUrl}/api/queue/items/${failed.id}/delete`, {
      method: 'POST',
      headers: authHeaders(clientId, cookie),
    })

    expect(response.status).toBe(200)
    const row = db.prepare('SELECT id, hidden FROM queue_items WHERE id = ?').get(failed.id)
    expect(row).toBeUndefined()
  })

  it('upload creates a queued item in a single request', async () => {
    const clientId = randomClientId('upload1')
    createClient(clientId)
    const { cookie } = await bootstrap(clientId)
    const boundary = '----codexuploadboundary'
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="single.pdf"\r\nContent-Type: application/pdf\r\n\r\n`, 'utf8'),
      Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF', 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ])

    const response = await fetch(`${baseUrl}/api/queue/upload`, {
      method: 'POST',
      headers: {
        ...authHeaders(clientId, cookie),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body: payload as any,
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.item.filename).toBe('single.pdf')
    expect(body.item.state).toBe('queued')

    const count = db.prepare('SELECT COUNT(*) as count FROM queue_items WHERE client_id = ?')
      .get(clientId) as { count: number }
    expect(count.count).toBe(1)
  })

  it('claim assigns ownership metadata to the latest visible queue lineage', async () => {
    const clientId = randomClientId('claim1')
    createClient(clientId)
    const item = createQueueItem({
      clientId,
      filename: 'owned.pdf',
      md5: '6'.repeat(32),
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })
    updateQueueItem(item.id, {
      state: 'failed',
      original_storage_path: 'C:\\queue\\owned.pdf',
      owner_kind: null,
      owner_id: null,
      job_group: null,
    })

    const { cookie } = await bootstrap(clientId)
    const response = await fetch(`${baseUrl}/api/queue/claim`, {
      method: 'POST',
      headers: {
        ...authHeaders(clientId, cookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        filename: 'owned.pdf',
        ownerId: 'agent-lane-1',
        jobGroup: 'mv-family',
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.item.ownerKind).toBe('agent')
    expect(body.item.ownerId).toBe('agent-lane-1')
    expect(body.item.jobGroup).toBe('mv-family')
  })

  it('allows internal worker token access on agent-safe routes without a browser cookie', async () => {
    const clientId = randomClientId('worker1')
    createClient(clientId)
    const item = createQueueItem({
      clientId,
      filename: 'worker-owned.pdf',
      md5: '11'.repeat(16),
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })
    updateQueueItem(item.id, {
      state: 'failed',
      original_storage_path: 'C:\\queue\\worker-owned.pdf',
    })

    const claimResponse = await fetch(`${baseUrl}/api/queue/claim`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-id': clientId,
        'x-internal-worker-token': INTERNAL_WORKER_TOKEN,
      },
      body: JSON.stringify({
        filename: 'worker-owned.pdf',
        ownerId: 'internal-worker-1',
        jobGroup: 'worker-test',
      }),
    })

    expect(claimResponse.status).toBe(200)
    const claimBody = await claimResponse.json()
    expect(claimBody.item.ownerId).toBe('internal-worker-1')

    const freshnessResponse = await fetch(`${baseUrl}/api/queue/items/${item.id}/freshness`, {
      headers: {
        'x-client-id': clientId,
        'x-internal-worker-token': INTERNAL_WORKER_TOKEN,
      },
    })

    expect(freshnessResponse.status).toBe(200)
    const freshnessBody = await freshnessResponse.json()
    expect(freshnessBody.itemId).toBe(item.id)
  })

  it('still requires a browser session on normal queue routes without internal token bypass', async () => {
    const clientId = randomClientId('worker2')
    createClient(clientId)
    createQueueItem({
      clientId,
      filename: 'normal-route.pdf',
      md5: '12'.repeat(16),
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })

    const response = await fetch(`${baseUrl}/api/queue/status`, {
      headers: {
        'x-client-id': clientId,
        'x-internal-worker-token': INTERNAL_WORKER_TOKEN,
      },
    })

    expect(response.status).toBe(401)
  })

  it('start-or-reuse returns the current fresh active item for the owned filename', async () => {
    const clientId = randomClientId('reuse1')
    createClient(clientId)
    const item = createQueueItem({
      clientId,
      filename: 'reused.pdf',
      md5: '7'.repeat(32),
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })
    updateQueueItem(item.id, {
      state: 'processing',
      processing_stage: 'Analyzing',
      owner_kind: 'agent',
      owner_id: 'old-owner',
      result_freshness: 'fresh',
    })

    const { cookie } = await bootstrap(clientId)
    const response = await fetch(`${baseUrl}/api/queue/start-or-reuse`, {
      method: 'POST',
      headers: {
        ...authHeaders(clientId, cookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        filename: 'reused.pdf',
        ownerId: 'new-owner',
        jobGroup: 'general',
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.reused).toBe(true)
    expect(body.item.id).toBe(item.id)
    expect(body.item.ownerId).toBe('new-owner')
    expect(body.item.jobGroup).toBe('general')
  })

  it('freshness returns ownership, freshness, and promotion metadata', async () => {
    const clientId = randomClientId('fresh1')
    createClient(clientId)
    const item = createQueueItem({
      clientId,
      filename: 'freshness.pdf',
      md5: '8'.repeat(32),
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })
    updateQueueItem(item.id, {
      owner_kind: 'agent',
      owner_id: 'agent-77',
      job_group: 'county',
      supersedes_item_id: 'older-item',
      runtime_generation: 'runtime:test',
      code_version: 'code:test',
      result_freshness: 'stale_after_restart',
      promotion_status: 'rejected',
    })

    const { cookie } = await bootstrap(clientId)
    const response = await fetch(`${baseUrl}/api/queue/items/${item.id}/freshness`, {
      headers: authHeaders(clientId, cookie),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.itemId).toBe(item.id)
    expect(body.ownerKind).toBe('agent')
    expect(body.ownerId).toBe('agent-77')
    expect(body.jobGroup).toBe('county')
    expect(body.supersedesItemId).toBe('older-item')
    expect(body.runtimeGeneration).toBe('runtime:test')
    expect(body.codeVersion).toBe('code:test')
    expect(body.resultFreshness).toBe('stale_after_restart')
    expect(body.promotionStatus).toBe('rejected')
  })

  it('emit-blocker stores a normalized blocker packet on the queue item', async () => {
    const clientId = randomClientId('blocker1')
    createClient(clientId)
    const item = createQueueItem({
      clientId,
      filename: 'blocked.pdf',
      md5: '9'.repeat(32),
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })
    updateQueueItem(item.id, {
      state: 'processing',
      processing_stage: 'Applying PDF fixes (stage 1)',
      processing_progress: 49,
      overall_score: 83,
      grade: 'B',
      result_json: JSON.stringify({
        overallScore: 83,
        grade: 'B',
        verapdf: { status: 'failed', failedChecks: 4, failures: [{ message: 'Needs repair' }] },
      }),
      manual_review_flags_json: JSON.stringify([
        {
          code: 'critical_structure',
          label: 'Critical structure debt',
          severity: 'critical',
          details: 'Logical structure still broken.',
        },
      ]),
      document_model_path: writeDocumentModel('needs-api-fix-detail', {
        version: '6',
        sourceType: 'native-text',
        manualReviewFlags: [],
        aiAppliedChanges: [],
        aiSuggestedChanges: [],
        confidenceSummary: null,
        failureProfile: {
          version: '2',
          generatedAt: '2026-03-24T00:00:00.000Z',
          analysisGrade: 'B',
          analysisScore: 83,
          veraPdfStatus: 'failed',
          veraPdfFailedChecks: 4,
          adobeStatus: 'failed',
          adobeIssueCount: 3,
          failureModes: [
            {
              key: 'pdfua.logical_structure',
              label: 'Logical structure',
              source: 'derived',
              reportingCategory: 'structure_tree',
              sourceDetail: 'derived_family',
              derivedFrom: ['derived:pdfua.logical_structure'],
              count: 3,
              categoryIds: ['structure_tree'],
              blocking: true,
              unmatched: false,
              classification: 'deterministic',
              nativeToolFamilies: ['repair_structure_tree'],
              evidence: ['Structure tree is incomplete'],
            },
          ],
          toolOpportunities: [],
          summary: {
            deterministicIssueCount: 1,
            semanticIssueCount: 0,
            manualOnlyIssueCount: 0,
            blockedOpportunityCount: 1,
            autoRunnableOpportunityCount: 0,
          },
        },
        classification: {
          structuralClass: 'native_tagged',
        },
        plannerEvidence: {
          topBlockingResidualFamilyIds: ['logical_structure_marked_content'],
          topResidualFamilyIds: ['logical_structure_marked_content'],
        },
      }),
    })

    const { cookie } = await bootstrap(clientId)
    const response = await fetch(`${baseUrl}/api/queue/items/${item.id}/emit-blocker`, {
      method: 'POST',
      headers: {
        ...authHeaders(clientId, cookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        blockerType: 'shared_fix_needed',
        subsystem: 'planner',
        summary: 'Document-level routing still bypasses candidate-scoped table repair.',
        reusable: true,
        artifactPaths: ['/tmp/evidence.json'],
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.item.promotionStatus).toBe('rejected')
    expect(body.item.promotionRejectionReason).toContain('bypasses')
    expect(body.blockerReport.subsystem).toBe('planner')
    expect(typeof body.needsApiFix.recordPath).toBe('string')
    expect(fs.existsSync(body.needsApiFix.recordPath)).toBe(true)
    expect(fs.existsSync(getRemediationLedgerPath())).toBe(true)
    expect(fs.existsSync(getFixFamiliesReportPath())).toBe(true)

    const row = db.prepare('SELECT blocker_report_json, promotion_status FROM queue_items WHERE id = ?').get(item.id) as any
    expect(row.promotion_status).toBe('rejected')
    const blockerPayload = JSON.parse(row.blocker_report_json)
    expect(blockerPayload.blockerType).toBe('shared_fix_needed')
    expect(blockerPayload.needsApiFixRecordPath).toBe(body.needsApiFix.recordPath)

    const record = JSON.parse(fs.readFileSync(body.needsApiFix.recordPath, 'utf8'))
    expect(record.filename).toBe('blocked.pdf')
    expect(record.subsystem).toBe('planner')
    expect(record.reusable).toBe(true)
    expect(record.classification.fixFamily).toBe('logical_structure_marked_content')
    expect(record.classification.blockerKind).toBe('manual_review_blocker')
    expect(record.classification.pipelineStage).toBe('remediation')
    expect(record.classification.structuralClass).toBe('native_tagged')
    expect(record.classification.residualFamilyIds).toEqual(['logical_structure_marked_content'])
    expect(record.classification.topFailureModeKeys).toEqual(['pdfua.logical_structure'])
    expect(record.classification.visualFidelity).toBe('not_run')
    expect(record.classification.bookmarkState).toBe('unknown')
    expect(record.classification.semanticSidecarState).toBe('not_flagged')
    expect(record.classification.likelyNextGenericFix).toBe('Logical structure')
    expect(record.classification.generalizationConfidence).toBe('high')
    expect(record.explanation.queueState).toBe('processing')
    expect(record.explanation.processingStage).toBe('Applying PDF fixes (stage 1)')
    expect(record.explanation.processingProgress).toBe(49)
    expect(record.explanation.overallScore).toBe(83)
    expect(record.explanation.grade).toBe('B')
    expect(record.explanation.likelyNextFixArea).toBe('Logical structure')
    expect(record.explanation.topFailureModes[0].key).toBe('pdfua.logical_structure')
    expect(record.explanation.criticalManualReviewFlags[0].code).toBe('critical_structure')

    const ledgerLines = fs.readFileSync(getRemediationLedgerPath(), 'utf8').trim().split('\n').filter(Boolean)
    expect(ledgerLines).toHaveLength(1)
    const ledgerEntry = JSON.parse(ledgerLines[0])
    expect(ledgerEntry.outcome).toBe('needs_api_fix')
    expect(ledgerEntry.filename).toBe('blocked.pdf')

    const fixFamiliesReport = JSON.parse(fs.readFileSync(getFixFamiliesReportPath(), 'utf8'))
    expect(fixFamiliesReport.totalBlockedPdfs).toBe(1)
    expect(fixFamiliesReport.totalFamilies).toBe(1)
    expect(fixFamiliesReport.families[0].fixFamily).toBe('logical_structure_marked_content')
    expect(fixFamiliesReport.families[0].filenames).toEqual(['blocked.pdf'])
  })

  it('validate-for-complete proxies the promotion validator output', async () => {
    const clientId = randomClientId('validate1')
    createClient(clientId)
    const item = createQueueItem({
      clientId,
      filename: 'validate.pdf',
      md5: 'a1'.padEnd(32, '1'),
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })

    vi.spyOn(queuePromotionService, 'validateQueueItemForComplete').mockResolvedValue({
      validation: {
        passed: false,
        scorePassed: true,
        gradePassed: true,
        veraPdfPassed: true,
        blockingFailureModesClear: false,
        blockingResidualFamiliesClear: true,
        criticalManualReviewClear: true,
        visualComparison: {
          passed: false,
          reason: 'page mismatch',
          originalWidth: 1,
          originalHeight: 1,
          remediatedWidth: 1,
          remediatedHeight: 1,
          sameDimensions: true,
          changedPixelRatio: 0,
          meanChannelDelta: 0,
          originalNonWhiteRatio: 0.1,
          remediatedNonWhiteRatio: 0.1,
          originalBlank: false,
          remediatedBlank: false,
        },
        bookmarkValidation: {
          passed: true,
          usedAiCleanup: true,
          reason: 'ok',
          titles: [],
          flaggedTitles: [],
        },
        freshnessPassed: true,
        queueStateEligible: true,
        promotionEligible: false,
        resultFreshness: 'fresh',
        queueState: 'complete',
        reasons: ['visual mismatch'],
      },
      artifacts: {
        reviewAssetsDir: '/tmp/review',
        rebuiltPdfPath: '/tmp/rebuilt.pdf',
        originalPdfPath: '/tmp/original.pdf',
        originalPage1PngPath: '/tmp/original.png',
        remediatedPage1PngPath: '/tmp/remediated.png',
        visualComparisonJsonPath: '/tmp/compare.json',
        failurePacketJsonPath: '/tmp/failure.json',
      },
      failurePacket: {
        filename: 'validate.pdf',
        queueItemId: item.id,
        latestAttemptPath: '/tmp/rebuilt.pdf',
        latestQueueSummary: { score: 96, grade: 'A', verapdfStatus: 'passed', failedChecks: 0 },
        topFailureModes: [],
        topBlockingResidualFamilyIds: [],
        topResidualFamilies: [],
        semanticSidecarState: 'not_flagged',
        visualComparison: null,
        bookmarkValidation: null,
        freshPostRestartRemediation: true,
        generatedAt: '2026-03-24T00:00:00.000Z',
      },
    })

    const { cookie } = await bootstrap(clientId)
    const response = await fetch(`${baseUrl}/api/queue/items/${item.id}/validate-for-complete`, {
      method: 'POST',
      headers: authHeaders(clientId, cookie),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.validation.promotionEligible).toBe(false)
    expect(body.failurePacketPath).toBe('/tmp/failure.json')
  })

  it('promote returns the promoted destination when the validator allows it', async () => {
    const clientId = randomClientId('promote1')
    createClient(clientId)
    const item = createQueueItem({
      clientId,
      filename: 'promote.pdf',
      md5: 'b2'.padEnd(32, '2'),
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })

    vi.spyOn(queuePromotionService, 'promoteQueueItemToComplete').mockResolvedValue({
      destinationPath: '/tmp/Complete/promote.pdf',
      validation: {
        passed: true,
        scorePassed: true,
        gradePassed: true,
        veraPdfPassed: true,
        blockingFailureModesClear: true,
        blockingResidualFamiliesClear: true,
        criticalManualReviewClear: true,
        visualComparison: {
          passed: true,
          reason: 'ok',
          originalWidth: 1,
          originalHeight: 1,
          remediatedWidth: 1,
          remediatedHeight: 1,
          sameDimensions: true,
          changedPixelRatio: 0,
          meanChannelDelta: 0,
          originalNonWhiteRatio: 0.1,
          remediatedNonWhiteRatio: 0.1,
          originalBlank: false,
          remediatedBlank: false,
        },
        bookmarkValidation: {
          passed: true,
          usedAiCleanup: true,
          reason: 'ok',
          titles: [],
          flaggedTitles: [],
        },
        freshnessPassed: true,
        queueStateEligible: true,
        promotionEligible: true,
        resultFreshness: 'fresh',
        queueState: 'complete',
        reasons: [],
      },
      artifacts: {
        reviewAssetsDir: '/tmp/review',
        rebuiltPdfPath: '/tmp/rebuilt.pdf',
        originalPdfPath: '/tmp/original.pdf',
        originalPage1PngPath: '/tmp/original.png',
        remediatedPage1PngPath: '/tmp/remediated.png',
        visualComparisonJsonPath: '/tmp/compare.json',
        failurePacketJsonPath: '/tmp/failure.json',
      },
    })

    const { cookie } = await bootstrap(clientId)
    const response = await fetch(`${baseUrl}/api/queue/items/${item.id}/promote`, {
      method: 'POST',
      headers: authHeaders(clientId, cookie),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.destinationPath).toBe('/tmp/Complete/promote.pdf')
    expect(body.validation.promotionEligible).toBe(true)

    const ledgerLines = fs.readFileSync(getRemediationLedgerPath(), 'utf8').trim().split('\n').filter(Boolean)
    expect(ledgerLines).toHaveLength(1)
    const ledgerEntry = JSON.parse(ledgerLines[0])
    expect(ledgerEntry.outcome).toBe('complete')
    expect(ledgerEntry.completeDestinationPath).toBe('/tmp/Complete/promote.pdf')
  })
})
