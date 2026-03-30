import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const envPath = path.join(repoRoot, '.env')

if (fs.existsSync(envPath)) {
  const envText = fs.readFileSync(envPath, 'utf8')
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1)
    if (!(key in process.env)) process.env[key] = value
  }
}

const baseUrl = process.env.AGENCY_STRAPI_BASE_URL
const graphqlUrl = process.env.AGENCY_STRAPI_GRAPHQL_URL
const username = process.env.AGENCY_STRAPI_USERNAME
const password = process.env.AGENCY_STRAPI_PASSWORD

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  let data: T | { error?: unknown } | null = null
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 300)}`)
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(data).slice(0, 500)}`)
  }

  return data as T
}

type AdminLoginResponse = {
  data?: {
    token?: string
    user?: {
      id: number
      email: string
      firstname?: string | null
      lastname?: string | null
      roles?: Array<{ name: string; code: string }>
    }
  }
}

type GraphqlResponse<T> = {
  data?: T
  errors?: Array<{ message: string }>
}

type PublicationRow = {
  id: string
  fileURL: string | null
}

async function main() {
  const resolvedBaseUrl = requireEnv('AGENCY_STRAPI_BASE_URL', baseUrl).replace(/\/+$/, '')
  const resolvedGraphqlUrl = requireEnv('AGENCY_STRAPI_GRAPHQL_URL', graphqlUrl)
  const resolvedUsername = requireEnv('AGENCY_STRAPI_USERNAME', username)
  const resolvedPassword = requireEnv('AGENCY_STRAPI_PASSWORD', password)

  const login = await postJson<AdminLoginResponse>(`${resolvedBaseUrl}/admin/login`, {
    email: resolvedUsername,
    password: resolvedPassword,
  })

  const token = login.data?.token
  const user = login.data?.user
  if (!token || !user) {
    throw new Error(`Login succeeded without token/user payload: ${JSON.stringify(login).slice(0, 500)}`)
  }

  const aggregate = await postJson<GraphqlResponse<{ publicationsConnection: { aggregate: { count: number } } }>>(
    resolvedGraphqlUrl,
    { query: '{ publicationsConnection { aggregate { count } } }' },
    { Authorization: `Bearer ${token}` },
  )

  const query = `
    query PublicationsPage($start: Int!, $limit: Int!) {
      publications(start: $start, limit: $limit) {
        id
        fileURL
      }
    }
  `

  let start = 0
  const limit = 100
  let publishedRows = 0
  let pdfRows = 0

  while (true) {
    const page = await postJson<GraphqlResponse<{ publications: PublicationRow[] }>>(
      resolvedGraphqlUrl,
      { query, variables: { start, limit } },
      { Authorization: `Bearer ${token}` },
    )

    if (page.errors?.length) {
      throw new Error(`GraphQL error: ${page.errors.map(error => error.message).join('; ')}`)
    }

    const rows = page.data?.publications ?? []
    publishedRows += rows.length
    pdfRows += rows.filter(row => typeof row.fileURL === 'string' && /\.pdf(\?|#|$)/i.test(row.fileURL)).length

    if (rows.length < limit) break
    start += limit
  }

  console.log(JSON.stringify({
    ok: true,
    baseUrl: resolvedBaseUrl,
    graphqlUrl: resolvedGraphqlUrl,
    user: {
      id: user.id,
      email: user.email,
      name: [user.firstname, user.lastname].filter(Boolean).join(' '),
      roles: user.roles?.map(role => role.name) ?? [],
    },
    counts: {
      aggregatePublications: aggregate.data?.publicationsConnection.aggregate.count ?? null,
      publishedRows,
      pdfFileUrlRows: pdfRows,
    },
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
