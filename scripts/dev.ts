import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'

const API_PORT = 6103
const WEB_PORT = 6102

function killPort(port: number): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['kill-port', String(port)], { stdio: 'ignore', shell: true })
    proc.on('close', () => resolve())
    proc.on('error', () => resolve())
  })
}

function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Port ${port} did not open within ${timeoutMs / 1000}s`))
        return
      }
      const sock = createConnection({ port, host: 'localhost' })
      sock.on('connect', () => { sock.destroy(); resolve() })
      sock.on('error', () => setTimeout(check, 500))
    }
    check()
  })
}

function prefix(name: string, data: Buffer) {
  const lines = data.toString().split('\n')
  for (const line of lines) {
    if (line.trim()) process.stdout.write(`\x1b[90m[${name}]\x1b[0m ${line}\n`)
  }
}

async function main() {
  console.log('Killing ports...')
  await Promise.all([killPort(API_PORT), killPort(WEB_PORT)])

  console.log('Starting API and Web servers...\n')

  const procs: ChildProcess[] = []

  const api = spawn('pnpm', ['--filter', 'api', 'dev'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  })
  procs.push(api)

  const web = spawn('pnpm', ['--filter', 'web', 'dev'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  })
  procs.push(web)

  api.stdout!.on('data', (d) => prefix('api', d))
  api.stderr!.on('data', (d) => prefix('api', d))
  web.stdout!.on('data', (d) => prefix('web', d))
  web.stderr!.on('data', (d) => prefix('web', d))

  const cleanup = () => {
    for (const p of procs) p.kill('SIGTERM')
    setTimeout(() => process.exit(0), 500)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  // Check if either exits with an error before ports are ready
  let earlyExit = false
  for (const [proc, name] of [[api, 'API'], [web, 'Web']] as const) {
    proc.on('close', (code) => {
      if (code && code !== 0 && !earlyExit) {
        earlyExit = true
        console.error(`\n✖ ${name} exited with code ${code}`)
        cleanup()
      }
    })
  }

  try {
    await Promise.all([waitForPort(API_PORT), waitForPort(WEB_PORT)])
    console.log(`\n✔ API running on http://localhost:${API_PORT}`)
    console.log(`✔ Web running on http://localhost:${WEB_PORT}\n`)
  } catch (err: any) {
    console.error(`\n✖ ${err.message}`)
    cleanup()
    process.exit(1)
  }

  // Keep alive — wait for either process to exit
  await new Promise<void>((resolve) => {
    api.on('close', resolve)
    web.on('close', resolve)
  })
}

main()
