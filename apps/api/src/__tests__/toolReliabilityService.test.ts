import { afterEach, describe, expect, it } from 'vitest'
import db from '../db/sqlite.js'
import { __test_resetToolOutcomes, getToolReliability, recordToolOutcomes } from '../services/toolReliabilityService.js'

describe('toolReliabilityService', () => {
  afterEach(() => {
    __test_resetToolOutcomes()
  })

  it('creates the tool_outcomes table idempotently during sqlite bootstrap', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool_outcomes'").get() as { name?: string } | undefined
    expect(row?.name).toBe('tool_outcomes')
  })

  it('falls back from class-specific history to global history and then default reliability', () => {
    recordToolOutcomes([
      {
        toolName: 'set_document_title',
        pdfClass: 'untagged_digital',
        outcome: 'applied',
        roundNumber: 1,
        stageNumber: 1,
        overallScoreBefore: 80,
        overallScoreAfter: 90,
        categoryDeltas: [{ categoryId: 'title_language', before: 80, after: 100 }],
        reliabilitySuccess: true,
      },
      {
        toolName: 'set_document_title',
        pdfClass: 'untagged_digital',
        outcome: 'rejected',
        roundNumber: 1,
        stageNumber: 1,
        overallScoreBefore: 80,
        overallScoreAfter: 80,
        categoryDeltas: [{ categoryId: 'title_language', before: 80, after: 80 }],
        reliabilitySuccess: false,
      },
    ])

    const defaultReliability = getToolReliability('set_document_language', 'native_tagged')
    expect(defaultReliability.source).toBe('default')
    expect(defaultReliability.reliability).toBe(0.85)

    const globalReliability = getToolReliability('set_document_title', 'native_tagged')
    expect(globalReliability.source).toBe('tool_global')
    expect(globalReliability.attempts).toBe(2)
    expect(globalReliability.successes).toBe(1)
    expect(globalReliability.reliability).toBe(0.5)

    recordToolOutcomes([
      {
        toolName: 'set_document_title',
        pdfClass: 'native_tagged',
        outcome: 'applied',
        roundNumber: 2,
        stageNumber: 1,
        overallScoreBefore: 90,
        overallScoreAfter: 100,
        categoryDeltas: [{ categoryId: 'title_language', before: 90, after: 100 }],
        reliabilitySuccess: true,
      },
      {
        toolName: 'set_document_title',
        pdfClass: 'native_tagged',
        outcome: 'applied',
        roundNumber: 3,
        stageNumber: 1,
        overallScoreBefore: 90,
        overallScoreAfter: 100,
        categoryDeltas: [{ categoryId: 'title_language', before: 90, after: 100 }],
        reliabilitySuccess: true,
      },
      {
        toolName: 'set_document_title',
        pdfClass: 'native_tagged',
        outcome: 'rejected',
        roundNumber: 4,
        stageNumber: 1,
        overallScoreBefore: 90,
        overallScoreAfter: 90,
        categoryDeltas: [{ categoryId: 'title_language', before: 90, after: 90 }],
        reliabilitySuccess: false,
      },
    ])

    const classSpecific = getToolReliability('set_document_title', 'native_tagged')
    expect(classSpecific.source).toBe('tool_and_class')
    expect(classSpecific.attempts).toBe(3)
    expect(classSpecific.successes).toBe(2)
    expect(classSpecific.reliability).toBeCloseTo(2 / 3, 5)
  })
})
