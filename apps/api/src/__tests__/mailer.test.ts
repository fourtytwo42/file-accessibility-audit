import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// We need to test validateMailConfig which reads process.env at call time
// and calls process.exit(1) in production without SMTP creds.
//
// The mailer module creates a nodemailer transporter at import time, so we
// mock nodemailer to prevent actual SMTP connections.
// ---------------------------------------------------------------------------

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn(),
    })),
  },
}))

// Store original env values
const originalEnv: Record<string, string | undefined> = {}
const envKeys = ['NODE_ENV', 'SMTP_USER', 'SMTP_PASS', 'SMTP_HOST', 'SMTP_PORT']

beforeEach(() => {
  for (const key of envKeys) {
    originalEnv[key] = process.env[key]
  }
  vi.restoreAllMocks()
})

afterEach(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalEnv[key]
    }
  }
})

// We need to re-import validateMailConfig for each test to avoid module caching
// issues. But since the transporter is created at import time and we already
// mock nodemailer, we can just import once.

describe('validateMailConfig', { timeout: 15_000 }, () => {
  it('calls process.exit(1) in production without SMTP_USER', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASS

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Dynamic import to get the function
    const { validateMailConfig } = await import('../mailer.js')
    validateMailConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalled()

    // Verify error messages mention the missing config
    const allMessages = errorSpy.mock.calls.map(c => c.join(' ')).join(' ')
    expect(allMessages).toContain('not configured')
  })

  it('calls process.exit(1) in production with SMTP_USER but no SMTP_PASS', async () => {
    process.env.NODE_ENV = 'production'
    process.env.SMTP_USER = 'user@example.com'
    delete process.env.SMTP_PASS

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { validateMailConfig } = await import('../mailer.js')
    validateMailConfig()

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('warns but continues in development without SMTP credentials', async () => {
    process.env.NODE_ENV = 'development'
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASS

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { validateMailConfig } = await import('../mailer.js')
    validateMailConfig()

    expect(exitSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()

    const allWarnings = warnSpy.mock.calls.map(c => c.join(' ')).join(' ')
    expect(allWarnings).toContain('SMTP credentials not set')
    expect(allWarnings).toContain('console')
  })

  it('warns but continues in test env (not production) without credentials', async () => {
    process.env.NODE_ENV = 'test'
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASS

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { validateMailConfig } = await import('../mailer.js')
    validateMailConfig()

    expect(exitSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('logs provider info when credentials are present', async () => {
    process.env.NODE_ENV = 'development'
    process.env.SMTP_USER = 'user@example.com'
    process.env.SMTP_PASS = 'secret123'

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { validateMailConfig } = await import('../mailer.js')
    validateMailConfig()

    expect(exitSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalled()

    const allLogs = logSpy.mock.calls.map(c => c.join(' ')).join(' ')
    expect(allLogs).toContain('Email provider')
  })

  it('logs provider info in production when credentials are present', async () => {
    process.env.NODE_ENV = 'production'
    process.env.SMTP_USER = 'user@example.com'
    process.env.SMTP_PASS = 'secret123'

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const { validateMailConfig } = await import('../mailer.js')
    validateMailConfig()

    expect(exitSpy).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalled()
  })
})
