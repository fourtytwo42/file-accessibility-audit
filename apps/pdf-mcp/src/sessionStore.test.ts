import { describe, expect, it } from 'vitest'
import {
  closeSession,
  createSession,
  getSession,
  invalidateContextCache,
  maxSessions,
  sha256Buffer,
} from './sessionStore.ts'

describe('sessionStore', () => {
  it('creates and retrieves session', () => {
    const buf = Buffer.from('%PDF-1.4 minimal')
    const s = createSession(buf, 't.pdf')
    expect(s.id).toBeTruthy()
    expect(getSession(s.id).buffer.equals(buf)).toBe(true)
    expect(closeSession(s.id)).toBe(true)
  })

  it('sha256Buffer is stable', () => {
    const a = sha256Buffer(Buffer.from('x'))
    const b = sha256Buffer(Buffer.from('x'))
    expect(a).toBe(b)
    expect(a.length).toBe(64)
  })

  it('invalidateContextCache clears inspection cache', () => {
    const s = createSession(Buffer.from('x'), 'x.pdf')
    s.inspectionCache.qpdf = {} as any
    s.contextCache = {} as any
    invalidateContextCache(s)
    expect(s.contextCache).toBeNull()
    expect(s.inspectionCache).toEqual({})
    closeSession(s.id)
  })

  it('respects max sessions', () => {
    const prev = process.env.PDF_MCP_MAX_SESSIONS
    process.env.PDF_MCP_MAX_SESSIONS = '2'
    const ids: string[] = []
    try {
      ids.push(createSession(Buffer.from('a'), 'a.pdf').id)
      ids.push(createSession(Buffer.from('b'), 'b.pdf').id)
      expect(() => createSession(Buffer.from('c'), 'c.pdf')).toThrow(/Too many open sessions/)
    } finally {
      for (const id of ids) closeSession(id)
      if (prev === undefined) delete process.env.PDF_MCP_MAX_SESSIONS
      else process.env.PDF_MCP_MAX_SESSIONS = prev
    }
    expect(maxSessions()).toBeGreaterThan(0)
  })
})
