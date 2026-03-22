import { afterEach, describe, expect, it } from 'vitest'
import db from '../db/sqlite.js'
import {
  __test_resetFamilyOutcomes,
  __test_selectFamilyOutcomes,
  recordFamilyOutcomes,
} from '../services/familyOutcomeService.js'

describe('familyOutcomeService', () => {
  afterEach(() => {
    __test_resetFamilyOutcomes()
  })

  it('creates the family_outcomes table idempotently during sqlite bootstrap', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'family_outcomes'").get() as { name?: string } | undefined
    expect(row?.name).toBe('family_outcomes')
  })

  it('records family outcomes with postcondition status', () => {
    recordFamilyOutcomes([
      {
        familyId: 'font_embedding_and_unicode',
        pdfClass: 'native_tagged',
        stepTool: 'repair_font_unicode_maps',
        postconditionStatus: 'satisfied',
        roundNumber: 1,
        stageNumber: 4,
        overallScoreBefore: 70,
        overallScoreAfter: 90,
        blockingKeysBefore: ['pdfua.font_unicode'],
        blockingKeysAfter: [],
      },
    ])

    expect(__test_selectFamilyOutcomes('font_embedding_and_unicode')).toEqual([
      {
        family_id: 'font_embedding_and_unicode',
        pdf_class: 'native_tagged',
        step_tool: 'repair_font_unicode_maps',
        postcondition_status: 'satisfied',
      },
    ])
  })
})

