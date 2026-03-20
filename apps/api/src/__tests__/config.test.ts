import { describe, expect, it } from 'vitest'
import { BATCH_QUEUE, REMEDIATION } from '#config'

describe('audit config', () => {
  it('limits per-client queue concurrency to 5', () => {
    expect(BATCH_QUEUE.MAX_PARALLEL_PER_CLIENT).toBe(5)
  })

  it('uses fast remediation guardrails tuned for shorter repair loops', () => {
    expect(REMEDIATION.MAX_REMEDIATION_ROUNDS).toBe(3)
    expect(REMEDIATION.MIN_SCORE_IMPROVEMENT_TO_CONTINUE).toBe(1)
    expect(REMEDIATION.MAX_NO_PROGRESS_STAGES).toBe(2)
    expect(REMEDIATION.MAX_ACROBAT_OWNERSHIP_PASSES_PER_ROUND).toBe(4)
    expect(REMEDIATION.MIN_ACROBAT_RISK_REDUCTION_TO_CONTINUE).toBe(1)
    expect(REMEDIATION.MIN_STRUCTURAL_ROUNDS).toBe(2)
  })
})
