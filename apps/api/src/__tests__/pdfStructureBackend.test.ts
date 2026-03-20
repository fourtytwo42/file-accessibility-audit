import { describe, expect, it } from 'vitest'
import { __test_structureBackendTimeoutMs } from '../services/pdfStructureBackend.js'

describe('pdfStructureBackend', () => {
  it('fails fast on pathological alt_text_deep inspections', () => {
    expect(__test_structureBackendTimeoutMs({
      operation: 'inspect',
      inspectMode: 'alt_text_deep',
    })).toBe(45_000)
  })

  it('keeps longer timeouts for light inspect and heavy alt-text repair mutations', () => {
    expect(__test_structureBackendTimeoutMs({
      operation: 'inspect',
      inspectMode: 'light',
    })).toBe(120_000)
    expect(__test_structureBackendTimeoutMs({
      operation: 'repair_other_elements_alt_text',
    })).toBe(900_000)
  })
})
