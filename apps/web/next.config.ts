import type { NextConfig } from 'next'
import { BRANDING, DEPLOY } from '../../audit.config'

const isProduction = process.env.NODE_ENV === 'production'
const siteUrl = isProduction ? DEPLOY.PRODUCTION_URL : `http://localhost:${DEPLOY.WEB_PORT}`

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `http://localhost:${DEPLOY.API_PORT}/api/:path*`,
      },
    ]
  },
  env: {
    NEXT_PUBLIC_APP_NAME: BRANDING.APP_SHORT_NAME,
    NEXT_PUBLIC_SITE_URL: siteUrl,
  },
}

export default nextConfig
