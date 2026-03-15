import { describe, expect, it } from 'vitest'
import { beginClientUpload, getActiveClientUploads } from '../services/uploadActivity.js'

describe('uploadActivity', () => {
  it('tracks concurrent uploads per client and releases idempotently', () => {
    const releaseA = beginClientUpload('client-a')
    const releaseB = beginClientUpload('client-a')

    expect(getActiveClientUploads('client-a')).toBe(2)

    releaseA()
    expect(getActiveClientUploads('client-a')).toBe(1)

    releaseA()
    expect(getActiveClientUploads('client-a')).toBe(1)

    releaseB()
    expect(getActiveClientUploads('client-a')).toBe(0)
  })
})
