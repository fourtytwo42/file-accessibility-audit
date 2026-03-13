import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serializeQueueItemDetail, serializeQueueItemSummary, type QueueItemRecord } from '../services/queueStore.js'

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
    result_json: '{"score":97}',
    original_result_json: '{"score":58}',
    remediated_result_json: null,
    rebuilt_result_json: '{"score":97}',
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
  })

  it('does not read the document model when serializing a summary item', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync')
    const readSpy = vi.spyOn(fs, 'readFileSync')

    const item = serializeQueueItemSummary(makeRow())

    expect(item.filename).toBe('example.pdf')
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
        failureModes: [],
        toolOpportunities: [],
        summary: {
          deterministicIssueCount: 0,
          semanticIssueCount: 0,
          manualOnlyIssueCount: 0,
          blockedOpportunityCount: 0,
          autoRunnableOpportunityCount: 0,
        },
      },
      plannerEvidence: {
        topFailureModeKeys: [],
        topAutoRunnableOpportunityKeys: [],
        skippedReasonCounts: [],
        attemptedKeys: [],
        rejectedKeys: [],
        noEffectKeys: [],
      },
      aiAppliedChanges: [],
      aiSuggestedChanges: [],
      manualReviewFlags: [],
      confidenceSummary: null,
    }) as any)

    const item = serializeQueueItemDetail(makeRow())

    expect(item.documentModel?.sourceType).toBe('native-text')
    expect(item.documentModel?.failureProfile?.version).toBe('1')
    expect(item.pathFallbacks).toEqual(['fallback'])
  })
})
