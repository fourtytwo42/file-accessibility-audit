import type { Metadata } from 'next'
import { Header } from '@/components/layout/Header'
import { Providers } from './providers'
import './globals.css'

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_APP_NAME || 'Accessibility Audit',
  description: 'Queue-driven PDF accessibility analysis and remediation.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          <div className="app-shell">
            <Header />
            {children}
          </div>
        </Providers>
      </body>
    </html>
  )
}
