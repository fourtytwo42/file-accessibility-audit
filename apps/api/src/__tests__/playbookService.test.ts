import { afterEach, describe, expect, it } from 'vitest'
import db from '../db/sqlite.js'
import {
  __test_resetPlaybooks,
  buildFailureSignature,
  createPlaybookRun,
  finalizePlaybookRun,
  findUsablePlaybookBySignatureHash,
  learnFromSuccessfulRemediation,
} from '../services/playbookService.js'

describe('playbookService', () => {
  afterEach(() => {
    __test_resetPlaybooks()
    db.prepare('DELETE FROM tool_outcomes').run()
  })

  it('creates playbook tables and tool outcome linkage columns during sqlite bootstrap', () => {
    const playbookTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'playbook_entries'").get() as { name?: string } | undefined
    const playbookRunsTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'playbook_runs'").get() as { name?: string } | undefined
    const columns = db.prepare('PRAGMA table_info(tool_outcomes)').all() as Array<{ name: string }>

    expect(playbookTable?.name).toBe('playbook_entries')
    expect(playbookRunsTable?.name).toBe('playbook_runs')
    expect(columns.some(column => column.name === 'playbook_id')).toBe(true)
    expect(columns.some(column => column.name === 'playbook_run_id')).toBe(true)
  })

  it('builds stable signatures and promotes a learned playbook through lifecycle states', () => {
    const signatureA = buildFailureSignature({
      failureProfile: {
        failureModes: [{ key: 'b' }, { key: 'a' }],
      } as any,
      analysis: { isScanned: false, categories: [], pdfMetadata: { pdfVersion: '1.7' } } as any,
      context: { qpdf: { hasStructTree: true, structTreeDepth: 2, hasMarkInfo: true } } as any,
    })
    const signatureB = buildFailureSignature({
      failureProfile: {
        failureModes: [{ key: 'a' }, { key: 'b' }],
      } as any,
      analysis: { isScanned: false, categories: [], pdfMetadata: { pdfVersion: '1.7' } } as any,
      context: { qpdf: { hasStructTree: true, structTreeDepth: 2, hasMarkInfo: true } } as any,
    })

    expect(signatureA.hash).toBe(signatureB.hash)

    const initialContext = {
      qpdf: {
        images: [{}],
        hasAcroForm: false,
        formFields: [],
        tables: [],
      },
    } as any

    const baseModel = {
      actions: [
        { tool: 'normalize_document_metadata', target: 'document', outcome: 'applied', changedDocumentBytes: true },
        { tool: 'repair_native_link_structure', target: 'document', outcome: 'applied', changedDocumentBytes: true },
      ],
      iterations: [{}, {}],
    } as any

    const created = learnFromSuccessfulRemediation({
      failureSignature: signatureA,
      initialAnalysis: { overallScore: 70, pageCount: 8 } as any,
      initialContext,
      finalAnalysis: { overallScore: 100 } as any,
      model: baseModel,
    })

    expect(created?.status).toBe('candidate')
    expect(created?.toolSequence.map(step => step.tool)).toEqual([
      'normalize_document_metadata',
      'repair_native_link_structure',
    ])

    const learnedTwice = learnFromSuccessfulRemediation({
      failureSignature: signatureA,
      initialAnalysis: { overallScore: 72, pageCount: 8 } as any,
      initialContext,
      finalAnalysis: { overallScore: 100 } as any,
      model: baseModel,
    })
    expect(learnedTwice?.status).toBe('validated')

    let entry = learnedTwice!
    for (let i = 0; i < 3; i += 1) {
      entry = learnFromSuccessfulRemediation({
        failureSignature: signatureA,
        initialAnalysis: { overallScore: 75, pageCount: 8 } as any,
        initialContext,
        finalAnalysis: { overallScore: 100 } as any,
        model: baseModel,
      })!
    }
    expect(entry.status).toBe('hardened')

    const matched = findUsablePlaybookBySignatureHash(signatureA.hash)
    expect(matched?.id).toBe(entry.id)

    const run = createPlaybookRun({
      playbook: entry,
      failureSignature: signatureA,
      initialScore: 75,
    })
    const finalized = finalizePlaybookRun({
      playbook: entry,
      run,
      outcome: 'failed',
      finalScore: 82,
    })
    expect(finalized.outcome).toBe('failed')
  })
})
