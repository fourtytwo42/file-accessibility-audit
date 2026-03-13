import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isProtected = pathname === '/' || pathname.startsWith('/pdf/')
  const isLogin = pathname === '/login'
  const isPublicReport = pathname.startsWith('/report/')

  if ((!isProtected && !isLogin) || isPublicReport) {
    return NextResponse.next()
  }

  try {
    const configResponse = await fetch(new URL('/api/auth/config', request.url), {
      headers: { cookie: request.headers.get('cookie') || '' },
    })
    const config = await configResponse.json() as { requireLogin?: boolean }
    if (!config.requireLogin) return NextResponse.next()
  } catch {
    return NextResponse.next()
  }

  const hasToken = !!request.cookies.get('token')?.value
  if (!hasToken && isProtected) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  if (hasToken && isLogin) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!api|_next|favicon.ico|site.webmanifest|robots.txt).*)'],
}
