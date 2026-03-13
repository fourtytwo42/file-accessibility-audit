import { describe, expect, it } from 'vitest'
import { parseVeraPdfJson } from '../services/veraPdfService.js'

describe('veraPdfService', () => {
  it('parses a passing veraPDF JSON report', () => {
    const result = parseVeraPdfJson({
      report: {
        profileName: 'PDF/UA-1',
        flavour: 'ua1',
        isCompliant: true,
        passedChecks: 14,
        failedChecks: 0,
      },
    })

    expect(result.status).toBe('passed')
    expect(result.failedChecks).toBe(0)
    expect(result.profile).toBe('PDF/UA-1')
  })

  it('parses failed assertions and maps them to categories', () => {
    const result = parseVeraPdfJson({
      report: {
        profileName: 'PDF/UA-1',
        flavour: 'ua1',
        isCompliant: false,
        failedChecks: 2,
        checks: [
          {
            status: 'failed',
            ruleId: 'clause-7.18',
            specification: 'PDF/UA-1',
            clause: '7.18',
            message: 'Figure element is missing alternate text.',
            location: 'Page 1',
          },
          {
            status: 'failed',
            ruleId: 'clause-7.1',
            specification: 'PDF/UA-1',
            clause: '7.1',
            message: 'Structure tree is invalid.',
            location: 'StructTreeRoot',
          },
        ],
      },
    })

    expect(result.status).toBe('failed')
    expect(result.failedChecks).toBe(2)
    expect(result.failures[0]?.categoryIds).toContain('alt_text')
    expect(result.failures[1]?.categoryIds).toContain('text_extractability')
  })

  it('parses real failure-style JSON payloads where compliance is false', () => {
    const result = parseVeraPdfJson({
      report: {
        profileName: 'PDF/UA-1',
        flavour: 'ua1',
        isCompliant: false,
        failedChecks: 1,
        checks: [
          {
            status: 'failed',
            ruleId: 'clause-7.2',
            specification: 'PDF/UA-1',
            clause: '7.2',
            message: 'Heading structure is invalid.',
            location: 'Page 1',
          },
        ],
      },
    })

    expect(result.status).toBe('failed')
    expect(result.executionStatus).toBe('ok')
    expect(result.message).toContain('veraPDF detected 1 PDF/UA compliance issue')
  })
})
