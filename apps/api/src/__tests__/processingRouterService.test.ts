import { describe, expect, it } from 'vitest'
import { chooseProcessingPath } from '../services/processingRouterService.js'
import type { AnalysisResult } from '../services/pdfAnalyzer.js'
import type { VeraPdfResult } from '../services/veraPdfService.js'

function makeVeraPdfResult(overrides: Partial<VeraPdfResult> = {}): VeraPdfResult {
  return {
    status: 'passed',
    executionStatus: 'ok',
    profile: 'PDF/UA-1',
    flavour: 'ua1',
    isCompliant: true,
    passedChecks: 1,
    failedChecks: 0,
    failures: [],
    message: 'veraPDF passed PDF/UA validation.',
    ...overrides,
  }
}

function makeAnalysisResult(): AnalysisResult {
  return {
    filename: 'test.pdf',
    pageCount: 1,
    fileType: 'pdf',
    pdfMetadata: {
      creator: null,
      producer: null,
      creationDate: null,
      modDate: null,
      pdfVersion: null,
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 1,
    },
    routingSignals: {
      headingCount: 0,
      linkCount: 0,
      rawUrlLinkCount: 0,
      rawUrlLinkDensity: 0,
    },
    overallScore: 0,
    grade: 'F',
    isScanned: false,
    executiveSummary: '',
    verapdf: makeVeraPdfResult(),
    categories: [],
    warnings: [],
  }
}

describe('chooseProcessingPath', () => {
  it('always returns agent_patch', () => {
    expect(chooseProcessingPath(makeAnalysisResult())).toBe('agent_patch')
  })
})
