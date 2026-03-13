'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getAuthConfig, getAuthMe, requestOtp, verifyOtp } from '@/lib/api'

export default function LoginPage() {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    async function init() {
      try {
        const config = await getAuthConfig()
        if (!config.requireLogin) {
          router.replace('/')
          return
        }
        await getAuthMe()
        router.replace('/')
        return
      } catch {
        if (active) setReady(true)
      }
    }
    void init()
    return () => {
      active = false
    }
  }, [router])

  async function submitEmail(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setLoading(true)
    try {
      await requestOtp(email.trim().toLowerCase())
      setOtpSent(true)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to send code')
    } finally {
      setLoading(false)
    }
  }

  async function submitOtp(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setLoading(true)
    try {
      await verifyOtp(email.trim().toLowerCase(), otp.trim())
      router.replace('/')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Verification failed')
    } finally {
      setLoading(false)
    }
  }

  if (!ready) {
    return <main className="page-shell py-10">Loading login...</main>
  }

  return (
    <main className="page-shell flex min-h-[70vh] items-center justify-center">
      <div className="w-full max-w-md rounded-[2rem] border p-8" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
        <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
          {otpSent ? 'Enter the code sent to your email.' : 'Use your allowed email address to receive a one-time code.'}
        </p>
        {!otpSent ? (
          <form className="mt-6 space-y-4" onSubmit={submitEmail}>
            <input
              type="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              className="w-full rounded-xl border px-4 py-3"
              style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
              placeholder="you@agency.illinois.gov"
            />
            {error ? <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p> : null}
            <button type="submit" disabled={loading} className="w-full rounded-full px-4 py-3 text-white disabled:opacity-50" style={{ background: 'var(--accent-strong)' }}>
              Send verification code
            </button>
          </form>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={submitOtp}>
            <input
              type="text"
              value={otp}
              onChange={event => setOtp(event.target.value)}
              className="w-full rounded-xl border px-4 py-3 text-center tracking-[0.4em]"
              style={{ borderColor: 'var(--border)', background: 'var(--surface-muted)' }}
              placeholder="000000"
            />
            {error ? <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p> : null}
            <button type="submit" disabled={loading} className="w-full rounded-full px-4 py-3 text-white disabled:opacity-50" style={{ background: 'var(--success)' }}>
              Verify and continue
            </button>
            <button type="button" className="w-full text-sm" style={{ color: 'var(--text-muted)' }} onClick={() => { setOtpSent(false); setOtp(''); setError('') }}>
              Use a different email
            </button>
          </form>
        )}
      </div>
    </main>
  )
}
