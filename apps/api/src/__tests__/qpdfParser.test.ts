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

    expect(result.images).toEqual([expect.objectContaining({ ref: 'obj:3 0 R', hasAlt: false })])
  })

  it('reconciles associated figure alt text onto a raw image without double-counting when figure objects appear first', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog', '/StructTreeRoot': 'obj:2 0 R', '/MarkInfo': { '/Marked': true } } },
        'obj:2 0 R': { value: { '/Type': '/StructTreeRoot', '/K': ['obj:10 0 R'] } },
        'obj:10 0 R': {
          value: {
            '/S': '/Figure',
            '/Alt': 'u:Program logo',
            '/K': { '/Type': '/OBJR', '/Obj': 'obj:3 0 R' },
          },
        },
        'obj:3 0 R': { value: { '/Subtype': '/Image' } },
      },
    })

    expect(result.images).toEqual([
      expect.objectContaining({ ref: 'obj:3 0 R', hasAlt: true, altText: 'Program logo' }),
    ])
  })

  it('does not let a parent figure container steal raw image credit from an informative child figure', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog', '/StructTreeRoot': 'obj:2 0 R', '/MarkInfo': { '/Marked': true } } },
        'obj:2 0 R': { value: { '/Type': '/StructTreeRoot', '/K': ['obj:10 0 R'] } },
        'obj:10 0 R': {
          value: {
            '/S': '/Figure',
            '/K': ['obj:11 0 R'],
          },
        },
        'obj:11 0 R': {
          value: {
            '/S': '/Figure',
            '/Alt': 'u:Program logo',
            '/K': { '/Type': '/OBJR', '/Obj': 'obj:3 0 R' },
          },
        },
        'obj:3 0 R': { value: { '/Subtype': '/Image' } },
      },
    })

    expect(result.images).toContainEqual(expect.objectContaining({ ref: 'obj:3 0 R', hasAlt: true, altText: 'Program logo' }))
    expect(result.images.some(image => image.ref === 'obj:10 0 R')).toBe(false)
  })

  it('lets an alt-bearing figure container backfill a raw image when no direct child alt is present', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog', '/StructTreeRoot': 'obj:2 0 R', '/MarkInfo': { '/Marked': true } } },
        'obj:2 0 R': { value: { '/Type': '/StructTreeRoot', '/K': ['obj:10 0 R'] } },
        'obj:10 0 R': {
          value: {
            '/S': '/Figure',
            '/Alt': 'u:Program logo',
            '/K': ['obj:11 0 R'],
          },
        },
        'obj:11 0 R': {
          value: {
            '/S': '/Figure',
            '/K': { '/Type': '/OBJR', '/Obj': 'obj:3 0 R' },
          },
        },
        'obj:3 0 R': { value: { '/Subtype': '/Image' } },
      },
    })

    expect(result.images).toContainEqual(expect.objectContaining({ ref: 'obj:3 0 R', hasAlt: true, altText: 'Program logo' }))
    expect(result.images.some(image => image.ref === 'obj:10 0 R')).toBe(false)
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

  it('parses legacy /heading N tags into heading levels for scoring', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog', '/StructTreeRoot': 'obj:2 0 R', '/MarkInfo': { '/Marked': true } } },
        'obj:2 0 R': { value: { '/Type': '/StructTreeRoot', '/K': ['obj:10 0 R', 'obj:11 0 R'] } },
        'obj:10 0 R': { value: { '/S': '/heading 4' } },
        'obj:11 0 R': { value: { '/S': '/heading 9' } },
      },
    })

    expect(result.headings).toEqual([
      { level: 'H4', tag: '/heading 4' },
      { level: 'H9', tag: '/heading 9' },
    ])
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

  it('tracks unmapped non-standard structure tags that are not resolved through RoleMap', () => {
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
              '/CustomHeading': '/H1',
            },
            '/K': ['obj:10 0 R', 'obj:11 0 R'],
          },
        },
        'obj:10 0 R': { value: { '/Type': '/StructElem', '/S': '/CustomHeading' } },
        'obj:11 0 R': { value: { '/Type': '/StructElem', '/S': '/Lbody' } },
      },
    })

    expect(result.unmappedRoleMapTagCount).toBe(1)
    expect(result.unmappedRoleMapTags).toEqual(['/Lbody'])
  })

  it('ignores action and transparency dictionaries when counting unmapped role tags', () => {
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
            '/K': ['obj:10 0 R'],
          },
        },
        'obj:10 0 R': { value: { '/Type': '/StructElem', '/S': '/P' } },
        'obj:20 0 R': { value: { '/S': '/URI', '/URI': 'u:https://example.com' } },
        'obj:21 0 R': { value: { '/S': '/GoTo', '/D': 'obj:99 0 R' } },
        'obj:22 0 R': { value: { '/S': '/Transparency' } },
      },
    })

    expect(result.unmappedRoleMapTagCount).toBe(0)
    expect(result.unmappedRoleMapTags).toEqual([])
  })

  it('counts table row spans from structure attributes when checking regularity', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': {
          value: {
            '/Type': '/Catalog',
            '/StructTreeRoot': 'obj:2 0 R',
            '/MarkInfo': { '/Marked': true },
          },
        },
        'obj:2 0 R': { value: { '/Type': '/StructTreeRoot', '/K': ['obj:10 0 R'] } },
        'obj:10 0 R': { value: { '/S': '/Table', '/K': ['obj:11 0 R', 'obj:12 0 R'] } },
        'obj:11 0 R': { value: { '/S': '/TR', '/K': ['obj:20 0 R', 'obj:21 0 R', 'obj:22 0 R', 'obj:23 0 R', 'obj:24 0 R', 'obj:25 0 R'] } },
        'obj:12 0 R': { value: { '/S': '/TR', '/K': ['obj:30 0 R', 'obj:31 0 R', 'obj:32 0 R', 'obj:33 0 R', 'obj:34 0 R', 'obj:35 0 R', 'obj:36 0 R', 'obj:37 0 R', 'obj:38 0 R', 'obj:39 0 R'] } },
        'obj:20 0 R': { value: { '/S': '/TH', '/A': { '/RowSpan': 2 } } },
        'obj:21 0 R': { value: { '/S': '/TH', '/A': { '/ColSpan': 2 } } },
        'obj:22 0 R': { value: { '/S': '/TH', '/A': { '/ColSpan': 2 } } },
        'obj:23 0 R': { value: { '/S': '/TH', '/A': { '/ColSpan': 2 } } },
        'obj:24 0 R': { value: { '/S': '/TH', '/A': { '/ColSpan': 2 } } },
        'obj:25 0 R': { value: { '/S': '/TH', '/A': { '/ColSpan': 2 } } },
        'obj:30 0 R': { value: { '/S': '/TD' } },
        'obj:31 0 R': { value: { '/S': '/TD' } },
        'obj:32 0 R': { value: { '/S': '/TD' } },
        'obj:33 0 R': { value: { '/S': '/TD' } },
        'obj:34 0 R': { value: { '/S': '/TD' } },
        'obj:35 0 R': { value: { '/S': '/TD' } },
        'obj:36 0 R': { value: { '/S': '/TD' } },
        'obj:37 0 R': { value: { '/S': '/TD' } },
        'obj:38 0 R': { value: { '/S': '/TD' } },
        'obj:39 0 R': { value: { '/S': '/TD' } },
      },
    })

    expect(result.tables).toEqual([
      { hasHeaders: true, rowCellCounts: [11, 11], dominantColumnCount: 11, isRegular: true },
    ])
  })

  it('tracks unembedded Type3 fonts separately so display-font debt can escalate', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog' } },
        'obj:3 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/Type3',
            '/BaseFont': '/ABCDEE+BebasNeueBold',
            '/FontDescriptor': 'obj:4 0 R',
          },
        },
        'obj:4 0 R': { value: { '/Type': '/FontDescriptor' } },
      },
    })

    expect(result.fontCount).toBe(1)
    expect(result.unembeddedFontCount).toBe(1)
    expect(result.unembeddedType3FontCount).toBe(1)
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

  it('counts Type1 and Type3 fonts that are still missing ToUnicode maps', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog' } },
        'obj:10 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/Type1',
            '/BaseFont': '/ABCDEE+GillSans',
            '/Encoding': '/WinAnsiEncoding',
            '/FontDescriptor': 'obj:11 0 R',
          },
        },
        'obj:11 0 R': { value: { '/Type': '/FontDescriptor', '/FontFile': 'obj:12 0 R' } },
        'obj:20 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/Type3',
            '/BaseFont': '/XYZABC+LegacyType3',
            '/Encoding': '/WinAnsiEncoding',
            '/FontDescriptor': 'obj:21 0 R',
          },
        },
        'obj:21 0 R': { value: { '/Type': '/FontDescriptor', '/FontFile3': 'obj:22 0 R' } },
        'obj:30 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/TrueType',
            '/BaseFont': '/ABCDEE+Arial',
            '/Encoding': '/WinAnsiEncoding',
            '/FontDescriptor': 'obj:31 0 R',
          },
        },
        'obj:31 0 R': { value: { '/Type': '/FontDescriptor', '/FontFile2': 'obj:32 0 R' } },
      },
    })

    expect(result.fontsMissingToUnicode).toBe(3)
    expect(result.type1FontsMissingToUnicode).toBe(2)
  })

  it('ignores empty AcroForm default-resource fonts when there are no form fields', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': {
          value: {
            '/Type': '/Catalog',
            '/AcroForm': 'obj:4 0 R',
          },
        },
        'obj:4 0 R': {
          value: {
            '/Fields': [],
            '/DR': {
              '/Font': {
                '/Helv': 'obj:70 0 R',
                '/ZaDb': 'obj:71 0 R',
              },
            },
          },
        },
        'obj:70 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/Type1',
            '/BaseFont': '/Helvetica',
          },
        },
        'obj:71 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/Type1',
            '/BaseFont': '/ZapfDingbats',
          },
        },
      },
    })

    expect(result.hasAcroForm).toBe(true)
    expect(result.formFields).toHaveLength(0)
    expect(result.fontCount).toBe(0)
    expect(result.unembeddedFontCount).toBe(0)
    expect(result.fontsMissingToUnicode).toBe(0)
  })

  it('does not double-count descendant CID fonts when the Type0 parent already has ToUnicode', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog' } },
        'obj:10 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/Type0',
            '/BaseFont': '/ABCDEF+SymbolMT',
            '/Encoding': '/Identity-H',
            '/ToUnicode': 'obj:14 0 R',
            '/DescendantFonts': ['obj:11 0 R'],
          },
        },
        'obj:11 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/CIDFontType0',
            '/BaseFont': '/ABCDEF+SymbolMT',
            '/FontDescriptor': 'obj:12 0 R',
          },
        },
        'obj:12 0 R': {
          value: {
            '/Type': '/FontDescriptor',
            '/FontFile3': 'obj:13 0 R',
          },
        },
        'obj:14 0 R': { stream: { dict: {} } },
      },
    })

    expect(result.fontCount).toBe(1)
    expect(result.unembeddedFontCount).toBe(0)
    expect(result.fontsMissingToUnicode).toBe(0)
    expect(result.type1FontsMissingToUnicode).toBe(0)
  })

  it('resolves descendant CID fonts through indirect DescendantFonts arrays', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog' } },
        'obj:10 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/Type0',
            '/BaseFont': '/ABCDEF+SymbolMT',
            '/Encoding': '/Identity-H',
            '/ToUnicode': 'obj:14 0 R',
            '/DescendantFonts': 'obj:11 0 R',
          },
        },
        'obj:11 0 R': { value: ['obj:12 0 R'] },
        'obj:12 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/CIDFontType2',
            '/BaseFont': '/ABCDEF+SymbolMT',
            '/FontDescriptor': 'obj:13 0 R',
            '/CIDToGIDMap': '/Identity',
          },
        },
        'obj:13 0 R': {
          value: {
            '/Type': '/FontDescriptor',
            '/FontFile2': 'obj:15 0 R',
          },
        },
        'obj:14 0 R': { stream: { dict: {} } },
      },
    })

    expect(result.fontCount).toBe(1)
    expect(result.unembeddedFontCount).toBe(0)
    expect(result.fontsMissingToUnicode).toBe(0)
    expect(result.cidFontsMissingCidToGidMap).toBe(0)
  })

  it('unwraps referenced font descriptors before checking embedded programs', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog' } },
        'obj:10 0 R': {
          value: {
            '/Type': '/Font',
            '/Subtype': '/TrueType',
            '/BaseFont': '/ExampleEmbedded',
            '/FontDescriptor': 'obj:11 0 R',
          },
        },
        'obj:11 0 R': {
          stream: {
            dict: {
              '/Type': '/FontDescriptor',
              '/FontFile2': 'obj:12 0 R',
            },
          },
        },
      },
    })

    expect(result.fontCount).toBe(1)
    expect(result.unembeddedFontCount).toBe(0)
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

  it('does not count soft-mask image streams as standalone images requiring alt text', () => {
    const result = parseQpdfJson({
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog' } },
        'obj:5 0 R': {
          stream: {
            dict: {
              '/Subtype': '/Image',
              '/Width': 100,
              '/Height': 100,
              '/SMask': 'obj:6 0 R',
            },
          },
        },
        'obj:6 0 R': {
          stream: {
            dict: {
              '/Subtype': '/Image',
              '/Width': 100,
              '/Height': 100,
              '/ColorSpace': '/DeviceGray',
            },
          },
        },
      },
    })

    expect(result.images).toHaveLength(1)
    expect(result.images[0].ref).toBe('obj:5 0 R')
  })

  it('detects nested image XObjects inside /Form resources and assigns a stable fingerprint', () => {
    const result = parseQpdfJson({
      pages: [
        { object: 'obj:2 0 R', pageposfrom1: 1 },
      ],
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog' } },
        'obj:2 0 R': {
          value: {
            '/Type': '/Page',
            '/Resources': {
              '/XObject': {
                '/Fm1': 'obj:10 0 R',
              },
            },
          },
        },
        'obj:10 0 R': {
          stream: {
            dict: {
              '/Subtype': '/Form',
              '/Resources': {
                '/XObject': {
                  '/ImNested': 'obj:11 0 R',
                },
              },
            },
          },
        },
        'obj:11 0 R': {
          stream: {
            dict: {
              '/Subtype': '/Image',
              '/Width': 32,
              '/Height': 32,
            },
            data: 'nested-image-stream',
          },
        },
      },
    })

    expect(result.images).toHaveLength(1)
    expect(result.images[0]).toEqual(expect.objectContaining({
      ref: 'obj:11 0 R',
      canonicalRef: 'obj:11 0 R',
      pageNumber: 1,
      placementCount: 1,
    }))
    expect(result.images[0].contentFingerprint).toMatch(/^[a-f0-9]{40}$/)
  })

  it('deduplicates repeated placements of the same image stream by content fingerprint', () => {
    const result = parseQpdfJson({
      pages: [
        { object: 'obj:2 0 R', pageposfrom1: 1 },
        { object: 'obj:3 0 R', pageposfrom1: 2 },
      ],
      objects: {
        'obj:1 0 R': { value: { '/Type': '/Catalog' } },
        'obj:2 0 R': {
          value: {
            '/Type': '/Page',
            '/Resources': { '/XObject': { '/Im1': 'obj:20 0 R' } },
          },
        },
        'obj:3 0 R': {
          value: {
            '/Type': '/Page',
            '/Resources': { '/XObject': { '/Im2': 'obj:21 0 R' } },
          },
        },
        'obj:20 0 R': {
          stream: {
            dict: { '/Subtype': '/Image', '/Width': 16, '/Height': 16 },
            data: 'same-image-stream',
          },
        },
        'obj:21 0 R': {
          stream: {
            dict: { '/Subtype': '/Image', '/Width': 16, '/Height': 16 },
            data: 'same-image-stream',
          },
        },
      },
    })

    expect(result.images).toHaveLength(1)
    expect(result.images[0]).toEqual(expect.objectContaining({
      ref: 'obj:20 0 R',
      canonicalRef: 'obj:20 0 R',
      pageNumber: 1,
      placementPageNumbers: [1, 2],
      placementCount: 2,
    }))
  })
})
