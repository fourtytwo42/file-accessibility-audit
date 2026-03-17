import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import db from '../db/sqlite.js'
import { createClient, createQueueItem, listActiveQueueItems, serializeQueueItemDetail, serializeQueueItemSummary, updateQueueItem, type QueueItemRecord } from '../services/queueStore.js'

function makeRow(): QueueItemRecord {
  return {
    id: 'item-1',
    client_id: 'client-1',
    filename: 'example.pdf',
    md5: 'a'.repeat(32),
    size_bytes: 1234,
    mime_type: 'application/pdf',
    state: 'complete',
    storage_path: null,
    original_storage_path: null,
    remediated_storage_path: null,
    rebuilt_storage_path: null,
    document_model_path: 'C:\\temp\\model.json',
    review_assets_dir: null,
    upload_progress: 100,
    processing_progress: 100,
    processing_stage: 'Complete',
    processing_path: 'agent_patch',
    path_fallbacks_json: '["fallback"]',
    hidden: 0,
    result_json: JSON.stringify({
      overallScore: 97,
      grade: 'A',
      executiveSummary: 'veraPDF passed and no material standards issues remain.',
      verapdf: {
        status: 'passed',
        failedChecks: 0,
        profile: 'PDF/UA-1',
        flavour: 'UA',
        topFailures: [],
      },
    }),
    original_result_json: JSON.stringify({
      overallScore: 58,
      grade: 'F',
      verapdf: {
        status: 'failed',
        failedChecks: 12,
        failures: [{ message: 'Original standards failure' }],
      },
    }),
    remediated_result_json: null,
    rebuilt_result_json: JSON.stringify({
      overallScore: 97,
      grade: 'A',
      verapdf: {
        status: 'passed',
        failedChecks: 0,
        topFailures: [],
      },
    }),
    error_json: null,
    remediation_status: 'completed',
    document_model_status: 'completed',
    remediation_error_json: null,
    reconstruction_error_json: null,
    page_count: 12,
    overall_score: 97,
    grade: 'A',
    original_page_count: 12,
    original_overall_score: 58,
    original_grade: 'F',
    remediated_page_count: null,
    remediated_overall_score: null,
    remediated_grade: null,
    rebuilt_page_count: 12,
    rebuilt_overall_score: 97,
    rebuilt_grade: 'A',
    applied_fixes_json: null,
    skipped_fixes_json: null,
    manual_review_flags_json: null,
    ai_applied_changes_json: null,
    ai_suggested_changes_json: null,
    confidence_summary_json: null,
    adobe_summary_json: null,
    original_adobe_summary_json: null,
    rebuilt_adobe_summary_json: null,
    created_at: '2026-03-11T00:00:00.000Z',
    updated_at: '2026-03-11T00:01:00.000Z',
    upload_started_at: '2026-03-11T00:00:00.000Z',
    upload_completed_at: '2026-03-11T00:00:10.000Z',
    processing_started_at: '2026-03-11T00:00:11.000Z',
    completed_at: '2026-03-11T00:01:00.000Z',
    expires_at: '2026-04-10T00:00:00.000Z',
  }
}

describe('queueStore serialization', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    db.prepare('DELETE FROM queue_items').run()
    db.prepare('DELETE FROM browser_sessions').run()
    db.prepare('DELETE FROM browser_clients').run()
  })

  it('does not read the document model when serializing a summary item', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync')
    const readSpy = vi.spyOn(fs, 'readFileSync')

    const item = serializeQueueItemSummary(makeRow())

    expect(item.filename).toBe('example.pdf')
    expect(item.standardsSummary?.gradeBasis.currentScore).toBe(97)
    expect(item.standardsSummary?.veraPdf.status).toBe('passed')
    expect(item.standardsSummary?.failureOverview.topFailureModes).toEqual([])
    expect(existsSpy).not.toHaveBeenCalled()
    expect(readSpy).not.toHaveBeenCalled()
  })

  it('reads the document model when serializing detail', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      version: '6',
      sourceType: 'native-text',
      pathFallbacks: ['fallback'],
      failureProfile: {
        version: '1',
        generatedAt: '2026-03-13T00:00:00.000Z',
        analysisGrade: 'A',
        analysisScore: 97,
        veraPdfStatus: 'passed',
        veraPdfFailedChecks: 0,
        failureModes: [{
          key: 'pdfua.page_tabs',
          label: 'Page tab order metadata',
          source: 'verapdf',
          count: 2,
          categoryIds: ['reading_order'],
          blocking: true,
          unmatched: false,
          classification: 'deterministic',
          nativeToolFamilies: ['set_page_tabs'],
          evidence: ['Tabs shall be set to /S'],
        }],
        toolOpportunities: [],
        summary: {
          deterministicIssueCount: 1,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 1,
          autoRunnableOpportunityCount: 2,
        },
      },
      plannerEvidence: {
        topFailureModeKeys: ['pdfua.page_tabs'],
        topAutoRunnableOpportunityKeys: ['set_page_tabs:document'],
        skippedReasonCounts: [{ reason: 'blocked', count: 1 }],
        attemptedKeys: ['normalize_document_metadata:document'],
        rejectedKeys: [],
        noEffectKeys: [],
      },
      finalAudit: {
        overallScore: 97,
        grade: 'A',
        unresolvedIssues: [],
        veraPdf: {
          status: 'passed',
          profile: 'PDF/UA-1',
          flavour: 'UA',
          failedChecks: 0,
          passedChecks: 42,
          topFailures: [],
        },
      },
      originalVeraPdf: {
        status: 'failed',
        profile: 'PDF/UA-1',
        flavour: 'UA',
        failedChecks: 12,
        passedChecks: 30,
        topFailures: ['Original standards failure'],
      },
      remediatedVeraPdf: {
        status: 'passed',
        profile: 'PDF/UA-1',
        flavour: 'UA',
        failedChecks: 0,
        passedChecks: 42,
        topFailures: [],
      },
      aiAppliedChanges: [],
      aiSuggestedChanges: [],
      manualReviewFlags: [],
      confidenceSummary: null,
    }) as any)

    const item = serializeQueueItemDetail(makeRow())

    expect(item.documentModel?.sourceType).toBe('native-text')
    expect(item.documentModel?.failureProfile?.version).toBe('1')
    expect(item.standardsDetail?.failureModes[0]?.key).toBe('pdfua.page_tabs')
    expect(item.standardsDetail?.plannerEvidence?.topFailureModeKeys).toEqual(['pdfua.page_tabs'])
    expect(item.standardsDetail?.remediationSummary.autoRunnableOpportunityCount).toBe(2)
    expect(item.standardsDetail?.veraPdf.original.status).toBe('failed')
    expect(item.standardsDetail?.gradeBasis.summaryText).toContain('veraPDF passed')
    expect(item.pathFallbacks).toEqual(['fallback'])
  })

  it('falls back gracefully when the document model is missing', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)

    const row = makeRow()
    row.grade = 'B'
    row.overall_score = 99
    row.result_json = JSON.stringify({
      overallScore: 99,
      grade: 'B',
      verapdf: {
        status: 'failed',
        failedChecks: 1,
        profile: 'PDF/UA-1',
        flavour: 'UA',
        failures: [{ message: 'Tabs shall be set to /S' }],
      },
    })

    const item = serializeQueueItemDetail(row)

    expect(item.documentModel).toBeNull()
    expect(item.standardsDetail?.veraPdf.current.status).toBe('failed')
    expect(item.standardsDetail?.gradeBasis.scoreCappedByStandards).toBe(true)
    expect(item.standardsDetail?.failureModes).toEqual([])
    expect(item.standardsDetail?.plannerEvidence).toBeNull()
  })

  it('collapses duplicate transient active rows by filename', () => {
    const clientId = 'client-collapse'
    createClient(clientId)
    const older = createQueueItem({
      clientId,
      filename: 'duplicate.pdf',
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })
    updateQueueItem(older.id, {
      state: 'failed',
      processing_stage: 'Upload interrupted',
      error_json: JSON.stringify({ error: 'Older failure' }),
      updated_at: '2026-03-15T00:00:00.000Z' as any,
    } as any)

    const newer = createQueueItem({
      clientId,
      filename: 'duplicate.pdf',
      sizeBytes: 100,
      mimeType: 'application/pdf',
    })
    updateQueueItem(newer.id, {
      state: 'uploading',
      processing_stage: 'Uploading file',
    })

    const items = listActiveQueueItems(clientId)
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe(newer.id)
    expect(items[0]?.state).toBe('uploading')
  })
})
