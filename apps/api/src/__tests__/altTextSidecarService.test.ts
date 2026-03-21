import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  altTextSidecarPath,
  loadAltTextSidecar,
  planAltTextSidecarDirectives,
  syncAltTextSidecar,
} from '../services/altTextSidecarService.js'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alt-sidecar-'))
  tempDirs.push(dir)
  return dir
}

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    qpdf: {
      images: [{
        ref: 'obj:10 0 R',
        canonicalRef: 'obj:10 0 R',
        contentFingerprint: 'sha:abc',
        hasAlt: false,
        pageNumber: 1,
        placementPageNumbers: [1, 2],
        placementCount: 2,
      }],
    },
    figureCandidates: [{
      id: 'figure:1',
      pageNumber: 1,
      targetRef: 'obj:10 0 R',
      imageKey: 'sha:abc',
      imageCanonicalRef: 'obj:10 0 R',
      imageContentFingerprint: 'sha:abc',
      placementPageNumbers: [1, 2],
      placementCount: 2,
      hasAlt: false,
      altText: null,
      informativeHint: 'informative',
      surroundingText: ['County outcomes chart', 'Trend lines by year'],
      repairMode: 'set_alt',
      pageImageCount: 1,
      textDensityHint: 'low',
      imageEvidence: 'strong',
    }],
    ...overrides,
  } as any
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('altTextSidecarService', () => {
  it('creates a sidecar for canonicalized images and stores review context', async () => {
    const artifactsDir = await makeTempDir()
    const sidecar = await syncAltTextSidecar({
      artifactsDir,
      filename: 'example.pdf',
      context: makeContext(),
    })

    expect(sidecar.entries['sha:abc']).toMatchObject({
      imageId: 'sha:abc',
      status: 'needs_review',
      pageNumber: 1,
      placementPageNumbers: [1, 2],
      placementCount: 2,
      caption: 'County outcomes chart',
      contextAfter: 'Trend lines by year',
    })

    const persisted = await loadAltTextSidecar(artifactsDir)
    expect(persisted?.entries['sha:abc']?.aiDraft).toBe('County outcomes chart')
  })

  it('preserves approved entries across reruns of the same canonical image', async () => {
    const artifactsDir = await makeTempDir()
    await syncAltTextSidecar({
      artifactsDir,
      filename: 'example.pdf',
      context: makeContext(),
    })

    const filePath = altTextSidecarPath(artifactsDir)
    const sidecar = JSON.parse(await fs.readFile(filePath, 'utf8'))
    sidecar.entries['sha:abc'].status = 'approved'
    sidecar.entries['sha:abc'].altText = 'Approved county outcomes chart'
    await fs.writeFile(filePath, JSON.stringify(sidecar, null, 2))

    const next = await syncAltTextSidecar({
      artifactsDir,
      filename: 'example.pdf',
      context: makeContext({
        figureCandidates: [{
          ...makeContext().figureCandidates[0],
          pageNumber: 2,
        }],
      }),
    })

    expect(next.entries['sha:abc']).toMatchObject({
      status: 'approved',
      altText: 'Approved county outcomes chart',
      placementCount: 2,
    })
  })

  it('prefers updating existing figures before planning retag wrappers', () => {
    const directives = planAltTextSidecarDirectives({
      sidecar: {
        version: 1,
        filename: 'example.pdf',
        updatedAt: new Date().toISOString(),
        entries: {
          'sha:abc': {
            imageId: 'sha:abc',
            pageNumber: 1,
            placementPageNumbers: [1],
            placementCount: 1,
            status: 'approved',
            altText: 'Approved chart alt text',
            updatedAt: new Date().toISOString(),
          },
        },
      },
      context: makeContext({
        figureCandidates: [
          {
            ...makeContext().figureCandidates[0],
            id: 'figure:set',
            repairMode: 'set_alt',
            hasAlt: false,
          },
          {
            ...makeContext().figureCandidates[0],
            id: 'figure:retag',
            repairMode: 'retag_then_set_alt',
            targetRef: 'obj:11 0 R',
          },
        ],
      }),
    })

    expect(directives).toHaveLength(1)
    expect(directives[0]).toMatchObject({
      candidateId: 'figure:set',
      toolName: 'set_figure_alt_text',
      altText: 'Approved chart alt text',
    })
  })

  it('applies decorative reviewed entries to existing figure tags', () => {
    const directives = planAltTextSidecarDirectives({
      sidecar: {
        version: 1,
        filename: 'example.pdf',
        updatedAt: new Date().toISOString(),
        entries: {
          'sha:abc': {
            imageId: 'sha:abc',
            pageNumber: 1,
            placementPageNumbers: [1],
            placementCount: 1,
            status: 'decorative',
            altText: '',
            updatedAt: new Date().toISOString(),
          },
        },
      },
      context: makeContext(),
    })

    expect(directives).toEqual([{
      imageId: 'sha:abc',
      status: 'decorative',
      candidateId: 'figure:1',
      toolName: 'mark_figure_decorative',
    }])
  })
})
