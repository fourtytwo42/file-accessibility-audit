import { describe, expect, it } from 'vitest'
import { BATCH_QUEUE } from '#config'

describe('audit config', () => {
  it('limits per-client queue concurrency to 5', () => {
    expect(BATCH_QUEUE.MAX_PARALLEL_PER_CLIENT).toBe(5)
  })
})
