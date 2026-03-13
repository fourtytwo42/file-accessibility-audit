'use client'

import { ThemeProvider } from 'next-themes'
import { SWRConfig } from 'swr'
import type { PropsWithChildren } from 'react'

export function Providers({ children }: PropsWithChildren) {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <SWRConfig value={{ revalidateOnFocus: false }}>
        {children}
      </SWRConfig>
    </ThemeProvider>
  )
}
