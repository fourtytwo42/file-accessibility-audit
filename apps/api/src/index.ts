import path from 'node:path'
import dotenv from 'dotenv'
import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { globalLimiter } from './middleware/rateLimiter.js'
import authRoutes from './routes/auth.js'
import analyzeRoutes from './routes/analyze.js'
import reportsRoutes from './routes/reports.js'
import logsRoutes from './routes/logs.js'
import queueRoutes from './routes/queue.js'
import { recoverInterruptedProcessing } from './services/queueManager.js'
import { cleanupExpiredQueueItems, failStaleUploads } from './services/queueStore.js'
import { probeVeraPdf } from './services/veraPdfService.js'

// Import db to trigger table creation on startup
import './db/sqlite.js'
import { validateMailConfig } from './mailer.js'
import { AUTH, DEPLOY } from '#config'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })
dotenv.config({ path: path.resolve(process.cwd(), 'apps/api/.env'), override: false })

// Validate email config before starting — only needed when auth requires OTP emails
if (AUTH.REQUIRE_LOGIN) {
  validateMailConfig()
}

const app = express()
const PORT = Number(process.env.PORT) || 5103
const isProduction = process.env.NODE_ENV === 'production'
let veraPdfStatus: { available: boolean; message: string } = {
  available: false,
  message: 'veraPDF probe has not run yet.',
}

// Trust proxy — behind nginx in production, behind Nuxt proxy in development
app.set('trust proxy', 1)

// Security headers
app.use(helmet())

// CORS
app.use(cors({
  origin: isProduction ? DEPLOY.PRODUCTION_URL : DEPLOY.DEV_FRONTEND_URL,
  credentials: true,
}))

// Body parsing
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())

// Global rate limit
app.use((req, res, next) => {
  const requestPath = req.path || ''
  if (
    requestPath === '/api/health'
    || requestPath === '/api'
    || requestPath === '/'
    || requestPath === '/api/client/bootstrap'
    || requestPath.startsWith('/api/queue/')
  ) {
    next()
    return
  }
  globalLimiter(req, res, next)
})

// Routes
app.use('/api/auth', authRoutes)
app.use('/api', queueRoutes)
app.use('/api', analyzeRoutes)
app.use('/api', reportsRoutes)
app.use('/api', logsRoutes)

// Health check — also serves as the root API response
const startedAt = new Date()

function healthPayload() {
  const uptimeSec = Math.floor((Date.now() - startedAt.getTime()) / 1000)
  const days = Math.floor(uptimeSec / 86400)
  const hours = Math.floor((uptimeSec % 86400) / 3600)
  const minutes = Math.floor((uptimeSec % 3600) / 60)
  const seconds = uptimeSec % 60
  const uptime = days > 0
    ? `${days}d ${hours}h ${minutes}m ${seconds}s`
    : hours > 0
      ? `${hours}h ${minutes}m ${seconds}s`
      : `${minutes}m ${seconds}s`

  return { status: 'ok', uptime }
}

function extendedHealthPayload() {
  return {
    ...healthPayload(),
    validators: {
      veraPdf: veraPdfStatus.available ? 'available' : 'unavailable',
    },
  }
}

app.get('/', (_req, res) => res.json(extendedHealthPayload()))
app.get('/api', (_req, res) => res.json(extendedHealthPayload()))
app.get('/api/health', (_req, res) => res.json(extendedHealthPayload()))

function runQueueMaintenance() {
  cleanupExpiredQueueItems()
  failStaleUploads()
}

// Global error handler — never leak internals
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err)

  // Multer file size error
  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({
      error: 'This file is too large. The maximum upload size is 100 MB.',
      details: 'Large PDFs are often inflated by uncompressed images. To reduce file size: (1) In Adobe Acrobat, use File → Save As Other → Reduced Size PDF; (2) Use File → Save As Other → Optimized PDF to downsample images; (3) Split the document into smaller sections (File → Organize Pages → Split) and analyze each part separately.',
    })
    return
  }

  const status = err.status || 500
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
  })
})

app.listen(PORT, async () => {
  console.log(`[API] Running on http://localhost:${PORT}`)
  console.log(`[API] Environment: ${process.env.NODE_ENV || 'development'}`)
  veraPdfStatus = await probeVeraPdf()
  console.log(`[API] veraPDF: ${veraPdfStatus.available ? 'available' : 'unavailable'}${veraPdfStatus.message ? ` (${veraPdfStatus.message})` : ''}`)
  runQueueMaintenance()
  const interval = setInterval(runQueueMaintenance, 5 * 60 * 1000)
  interval.unref?.()
  const recovered = recoverInterruptedProcessing()
  if (recovered > 0) {
    console.log(`[API] Re-queued ${recovered} interrupted processing item${recovered === 1 ? '' : 's'} after restart`)
  }
})
