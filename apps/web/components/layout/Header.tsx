'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { logout } from '@/lib/api'

export function Header() {
  const pathname = usePathname()
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const isPublic = pathname?.startsWith('/report/')

  useEffect(() => {
    setMounted(true)
  }, [])

  async function handleLogout() {
    try {
      await logout()
    } finally {
      router.replace('/login')
    }
  }

  return (
    <header className="sticky top-0 z-30 border-b" style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--bg) 88%, transparent)' }}>
      <div className="page-shell flex items-center justify-between gap-4 py-4">
        <div>
          <Link href="/" className="text-lg font-semibold tracking-tight">
            {process.env.NEXT_PUBLIC_APP_NAME || 'Accessibility Audit'}
          </Link>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Queue, remediation status, and PDF detail in one place.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-full border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle color mode"
          >
            {mounted ? (resolvedTheme === 'dark' ? 'Light' : 'Dark') : 'Theme'}
          </button>
          {!isPublic && pathname !== '/login' ? (
            <button
              type="button"
              className="rounded-full border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
              onClick={handleLogout}
            >
              Log out
            </button>
          ) : null}
        </div>
      </div>
    </header>
  )
}
