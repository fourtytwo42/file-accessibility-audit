import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  __test_killAllRegisteredStructureHelpers,
  __test_runPdfStructureHelperCommand,
  __test_structureBackendTimeoutMs,
  runPdfStructureBackend,
  runPdfStructureBackendBatch,
} from '../services/pdfStructureBackend.js'

function makeFakeChild(pid = 4321) {
  const events = new PassThrough() as PassThrough & {
    pid: number
    stdout: PassThrough
    stderr: PassThrough
    once: (event: string, listener: (...args: any[]) => void) => any
    on: (event: string, listener: (...args: any[]) => void) => any
    emit: (event: string, ...args: any[]) => boolean
  }
  const child = Object.assign(events, {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  return child
}

describe('pdfStructureBackend', () => {
  it('fails fast on pathological alt_text_deep inspections', () => {
    expect(__test_structureBackendTimeoutMs({
      operation: 'inspect',
      inspectMode: 'alt_text_deep',
    })).toBe(45_000)
  })

  it('keeps longer timeouts for light inspect and heavy alt-text repair mutations', () => {
    expect(__test_structureBackendTimeoutMs({
      operation: 'inspect',
      inspectMode: 'light',
    })).toBe(120_000)
    expect(__test_structureBackendTimeoutMs({
      operation: 'repair_other_elements_alt_text',
    })).toBe(900_000)
    expect(__test_structureBackendTimeoutMs({
      operation: 'tag_unowned_annotations',
    })).toBe(120_000)
  })

  it('cleans up helper processes on timeout', async () => {
    const child = makeFakeChild(2468)
    const spawnImpl = vi.fn(() => child as any)
    const processKillImpl = vi.fn<(pid: number, signal?: string | number) => boolean>(() => true)
    const setTimeoutImpl = vi.fn<(callback: (...args: any[]) => void, delay?: number) => ReturnType<typeof setTimeout>>((callback: (...args: any[]) => void) => {
      callback()
      return 1 as any
    })
    const clearTimeoutImpl = vi.fn()

    await expect(__test_runPdfStructureHelperCommand({
      inputPath: '/tmp/in.pdf',
      requestPath: '/tmp/request.json',
      outputPath: '/tmp/out.pdf',
      timeoutMs: 5,
    }, {
      spawnImpl,
      processKillImpl,
      setTimeoutImpl,
      clearTimeoutImpl,
    })).rejects.toMatchObject({ code: 'ETIMEDOUT' })

    const expectedPid = 2468
    expect(processKillImpl).toHaveBeenCalledWith(expectedPid, 'SIGTERM')
    expect(processKillImpl).toHaveBeenCalledWith(expectedPid, 'SIGKILL')
  })

  it('cleans up helper processes on abort', async () => {
    const child = makeFakeChild(1357)
    const spawnImpl = vi.fn(() => child as any)
    const processKillImpl = vi.fn<(pid: number, signal?: string | number) => boolean>(() => true)
    const controller = new AbortController()
    let timeoutCallCount = 0
    const setTimeoutImpl = vi.fn<(callback: (...args: any[]) => void, delay?: number) => ReturnType<typeof setTimeout>>((callback: (...args: any[]) => void) => {
      timeoutCallCount += 1
      if (timeoutCallCount > 1) callback()
      return 1 as any
    })
    const clearTimeoutImpl = vi.fn()

    const promise = __test_runPdfStructureHelperCommand({
      inputPath: '/tmp/in.pdf',
      requestPath: '/tmp/request.json',
      outputPath: '/tmp/out.pdf',
      timeoutMs: 1_000,
      signal: controller.signal,
    }, {
      spawnImpl,
      processKillImpl,
      setTimeoutImpl,
      clearTimeoutImpl,
    })

    controller.abort()

    await expect(promise).rejects.toMatchObject({ code: 'ABORT_ERR' })

    const expectedPid = 1357
    expect(processKillImpl).toHaveBeenCalledWith(expectedPid, 'SIGTERM')
    expect(processKillImpl).toHaveBeenCalledWith(expectedPid, 'SIGKILL')
  })

  it('returns helper output without killing the process on success', async () => {
    const child = makeFakeChild(9753)
    const spawnImpl = vi.fn(() => child as any)
    const processKillImpl = vi.fn<(pid: number, signal?: string | number) => boolean>(() => true)

    const promise = __test_runPdfStructureHelperCommand({
      inputPath: '/tmp/in.pdf',
      requestPath: '/tmp/request.json',
      outputPath: '/tmp/out.pdf',
      timeoutMs: 1_000,
    }, {
      spawnImpl,
      processKillImpl,
    })

    child.stdout.write('{"status":"ok"}')
    child.stderr.write('warning')
    child.emit('close', 0, null)

    await expect(promise).resolves.toEqual({
      stdout: '{"status":"ok"}',
      stderr: 'warning',
    })
    expect(processKillImpl).not.toHaveBeenCalled()
  })

  it('maps timeout failures to safe no_effect results for single operations', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'mkdtempSync').mockReturnValue('/tmp/pdf-struct-single')
    vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as any)
    vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined as any)

    const backend = await import('../services/pdfStructureBackend.js')
    vi.spyOn(backend, 'runPdfStructureHelperCommand').mockRejectedValue(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))

    const result = await runPdfStructureBackend({
      buffer: Buffer.from('pdf'),
      mutation: { operation: 'repair_font_unicode_maps' },
    })

    expect(result.status).toBe('failed')
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('maps abort failures to safe no_effect results for batch operations', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'mkdtempSync').mockReturnValue('/tmp/pdf-struct-batch')
    vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined as any)
    vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined as any)

    const backend = await import('../services/pdfStructureBackend.js')
    vi.spyOn(backend, 'runPdfStructureHelperCommand').mockRejectedValue(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))

    const result = await runPdfStructureBackendBatch({
      buffer: Buffer.from('pdf'),
      mutations: [{ operation: 'repair_font_unicode_maps' }],
    })

    expect(result.status).toBe('failed')
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.operationResults).toEqual([])
  })
})
