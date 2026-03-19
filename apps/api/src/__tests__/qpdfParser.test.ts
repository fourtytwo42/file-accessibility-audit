import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { analyzeWithQpdf, parseQpdfJson } from '../services/qpdfService.js'

const fixturesDir = path.join(import.meta.dirname, 'fixtures')

function loadFixture(name: string): Buffer {
  return fs.readFileSync(path.join(fixturesDir, name))
}

describe('analyzeWithQpdf', () => {
  it('parses structural data from the accessible fixture', async () => {
    const result = await analyzeWithQpdf(loadFixture('accessible.pdf'))

    expect(result.error).toBeNull()
    expect(result.hasStructTree).toBe(true)
    expect(result.hasLang).toBe(true)
    expect(result.hasOutlines).toBe(true)
    expect(result.headings.length).toBeGreaterThan(0)
    expect(result.images.length).toBeGreaterThan(0)
    expect(result.structTreeDepth).toBeGreaterThan(0)
  }, 30_000)

  it('gracefully handles the inaccessible fixture', async () => {
    const result = await analyzeWithQpdf(loadFixture('inaccessible.pdf'))

    expect(result).toBeDefined()
    expect(result.hasStructTree).toBe(false)
    expect(result.headings).toHaveLength(0)
  }, 30_000)

  it('does not treat orphaned /Figure alt text as valid image coverage', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog', '/StructTreeRoot': 'obj:2 0 R', '/MarkInfo': { '/Marked': true } } },
        'obj:2 0 R': { value: { '/Type': '/StructTreeRoot', '/K': ['obj:10 0 R'] } },
        'obj:3 0 R': { value: { '/Subtype': '/Image' } },
        'obj:10 0 R': { value: { '/S': '/Figure', '/Alt': 'u:County seal', '/K': [] } },
      },
    })

    expect(result.images).toEqual([{ ref: 'obj:3 0 R', hasAlt: false }])
  })
})
