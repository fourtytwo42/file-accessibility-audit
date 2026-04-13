import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { analyzePDF } from '../../api/src/services/pdfAnalyzer.ts'
import {
  createSession,
  invalidateContextCache,
  closeSession,
} from './sessionStore.ts'

describe('pdf_analyze smoke', () => {
  it('analyzes minimal pdf with vera/adobe skipped', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([200, 200])
    const bytes = await doc.save()
    const session = createSession(Buffer.from(bytes), 'minimal.pdf')
    try {
      const result = await analyzePDF(session.buffer, session.filename, {
        skipVeraPdf: true,
        skipAdobe: true,
        analysisProfile: 'remediation_fast',
      })
      expect(result.fileType).toBe('pdf')
      expect(result.pageCount).toBeGreaterThanOrEqual(1)
      expect(typeof result.overallScore).toBe('number')
      session.lastAnalysis = result
      invalidateContextCache(session)
      expect(session.lastAnalysis).not.toBeNull()
    } finally {
      closeSession(session.id)
    }
  }, 120_000)
})
