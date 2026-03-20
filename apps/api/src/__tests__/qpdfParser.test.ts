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

  it('extracts tagged-pdf metadata and font conformance signals from qpdf json', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': {
          value: {
            '/Type': '/Catalog',
            '/StructTreeRoot': 'obj:2 0 R',
            '/Lang': 'u:en-US',
            '/MarkInfo': { '/Marked': true },
            '/Metadata': 'obj:9 0 R',
            '/ViewerPreferences': { '/DisplayDocTitle': true },
          },
        },
        'obj:2 0 R': { value: { '/Type': '/StructTreeRoot' } },
        'obj:9 0 R': { value: { '/Type': '/Metadata', '/Subtype': '/XML' } },
        'obj:10 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/Type0',
            '/DescendantFonts': ['obj:11 0 R'],
          },
        },
        'obj:11 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/CIDFontType2',
            '/FontDescriptor': 'obj:12 0 R',
          },
        },
        'obj:12 0 R': { value: { '/Type': '/FontDescriptor' } },
      },
    })

    expect(result.hasMarkInfo).toBe(true)
    expect(result.marked).toBe(true)
    expect(result.displayDocTitle).toBe(true)
    expect(result.metadataRef).toBe('obj:9 0 R')
    expect(result.metadataTypeValid).toBe(true)
    expect(result.metadataSubtypeXml).toBe(true)
    expect(result.fontCount).toBeGreaterThan(0)
    expect(result.unembeddedFontCount).toBeGreaterThan(0)
    expect(result.fontsMissingToUnicode).toBeGreaterThan(0)
    expect(result.cidFontsMissingCidToGidMap).toBeGreaterThan(0)
  })

  it('tracks link annotations missing contents and legacy width-risk fonts', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog' } },
        'obj:2 0 R': { value: { '/Type': '/Annot', '/Subtype': '/Link', '/Rect': [0, 0, 10, 10] } },
        'obj:3 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/Type1',
            '/BaseFont': '/ABCDEF+LegacyFont',
            '/Encoding': 'obj:9 0 R',
            '/FirstChar': 32,
            '/LastChar': 255,
            '/Widths': new Array(224).fill(500),
            '/FontDescriptor': 'obj:4 0 R',
          },
        },
        'obj:4 0 R': { value: { '/Type': '/FontDescriptor', '/FontFile': 'obj:5 0 R' } },
        'obj:9 0 R': { value: { '/Type': '/Encoding', '/Differences': [32, '/A'] } },
      },
    })

    expect(result.linkAnnotationCount).toBe(1)
    expect(result.linkAnnotationsMissingContents).toBe(1)
    expect(result.legacyWidthRiskFontCount).toBe(1)
  })

  it('tracks explicit and inferred CIDSet risk signals for CID fonts', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog' } },
        'obj:10 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/Type0',
            '/BaseFont': '/ABCDEE+SymbolMT',
            '/DescendantFonts': ['obj:11 0 R'],
          },
        },
        'obj:11 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/CIDFontType2',
            '/FontDescriptor': 'obj:12 0 R',
          },
        },
        'obj:12 0 R': {
          value: {
            '/Type': '/FontDescriptor',
            '/FontFile2': 'obj:13 0 R',
            '/CIDSet': 'obj:14 0 R',
          },
        },
        'obj:20 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/Type0',
            '/BaseFont': '/XYZABC+SymbolMT',
            '/DescendantFonts': ['obj:21 0 R'],
          },
        },
        'obj:21 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/CIDFontType2',
            '/FontDescriptor': 'obj:22 0 R',
          },
        },
        'obj:22 0 R': {
          value: {
            '/Type': '/FontDescriptor',
            '/FontFile2': 'obj:23 0 R',
          },
        },
      },
    })

    expect(result.cidSetRiskFontCount).toBe(2)
    expect(result.cidSetExplicitFontCount).toBe(1)
  })

  it('counts role-mapped note tags that are missing ID entries', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': {
          value: {
            '/Type': '/Catalog',
            '/StructTreeRoot': 'obj:2 0 R',
            '/MarkInfo': { '/Marked': true },
          },
        },
        'obj:2 0 R': {
          value: {
            '/Type': '/StructTreeRoot',
            '/RoleMap': {
              '/Footnote': '/Note',
              '/Endnote': '/Note',
            },
            '/K': ['obj:10 0 R', 'obj:11 0 R'],
          },
        },
        'obj:10 0 R': { value: { '/S': '/Footnote' } },
        'obj:11 0 R': { value: { '/S': '/Endnote', '/ID': 'u:note-2' } },
      },
    })

    expect(result.noteTagCount).toBe(2)
    expect(result.noteTagsMissingId).toBe(1)
  })

  it('detects explicit CIDSet descriptors on direct CID font objects', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog' } },
        'obj:10 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/CIDFontType2',
            '/BaseFont': '/ABCDEE+SymbolMT',
            '/FontDescriptor': 'obj:11 0 R',
          },
        },
        'obj:11 0 R': {
          value: {
            '/Type': '/FontDescriptor',
            '/FontFile2': 'obj:12 0 R',
            '/CIDSet': 'obj:13 0 R',
          },
        },
      },
    })

    expect(result.cidSetRiskFontCount).toBe(1)
    expect(result.cidSetExplicitFontCount).toBe(1)
  })

  it('detects metadata type/subtype from QPDF v2 stream objects (no value wrapper)', () => {
    // QPDF v2 JSON format: stream objects use { stream: { dict: {...} } } without a "value" key
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': {
          value: {
            '/Type': '/Catalog',
            '/StructTreeRoot': 'obj:2 0 R',
            '/MarkInfo': { '/Marked': true },
            '/Metadata': 'obj:9 0 R',
          },
        },
        'obj:2 0 R': { value: { '/Type': '/StructTreeRoot' } },
        // Metadata as a stream object — v2 format has no "value" key
        'obj:9 0 R': { stream: { dict: { '/Type': '/Metadata', '/Subtype': '/XML' } } },
      },
    })

    expect(result.metadataRef).toBe('obj:9 0 R')
    expect(result.metadataTypeValid).toBe(true)
    expect(result.metadataSubtypeXml).toBe(true)
  })

  it('detects Image XObjects from QPDF v2 stream objects (no value wrapper)', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog' } },
        // Image XObject as a stream object — v2 format has no "value" key
        'obj:5 0 R': { stream: { dict: { '/Subtype': '/Image', '/Width': 100, '/Height': 100 } } },
      },
    })

    expect(result.images).toHaveLength(1)
    expect(result.images[0].ref).toBe('obj:5 0 R')
  })
})
