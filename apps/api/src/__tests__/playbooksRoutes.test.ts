import express from 'express'
import cookieParser from 'cookie-parser'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import playbooksRoutes from '../routes/playbooks.js'

let server: ReturnType<express.Express['listen']>
let baseUrl = ''
const originalAdminEmails = process.env.ADMIN_EMAILS

describe('playbooks routes', () => {
  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'anonymous'
    const app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use('/api', playbooksRoutes)
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Failed to bind test server')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    process.env.ADMIN_EMAILS = originalAdminEmails
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  })

  it('returns playbook summaries for admin readers', async () => {
    const response = await fetch(`${baseUrl}/api/playbooks`)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(Array.isArray(body.playbooks)).toBe(true)
  })
})
