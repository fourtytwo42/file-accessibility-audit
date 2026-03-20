import { describe, expect, it } from 'vitest'
import {
  buildPipelineConfig,
  classifyDepth,
  classifyFonts,
  classifyPdfFull,
  classifyScale,
  classifyStructure,
  fingerprintAuthoringTool,
  toPlaybookPdfClass,
  toReliabilityPdfClass,
} from '../services/pdfClassificationService.js'

describe('pdfClassificationService', () => {
  it('classifies structural states including well-tagged documents', () => {
    expect(classifyStructure({
      analysis: { isScanned: true, categories: [] } as any,
      pdfjs: { hasText: false },
      qpdf: { hasStructTree: false, structTreeDepth: 0, hasMarkInfo: false, headings: [] },
    })).toBe('scanned')

    expect(classifyStructure({
      analysis: { isScanned: false, categories: [] } as any,
      pdfjs: { hasText: true },
      qpdf: { hasStructTree: false, structTreeDepth: 0, hasMarkInfo: false, headings: [] },
    })).toBe('untagged_digital')

    expect(classifyStructure({
      analysis: { isScanned: false, categories: [{ score: 70 }] } as any,
      pdfjs: { hasText: true },
      qpdf: { hasStructTree: true, structTreeDepth: 1, hasMarkInfo: true, headings: [] },
    })).toBe('partially_tagged')

    expect(classifyStructure({
      analysis: { isScanned: false, categories: [{ score: 70 }, { score: 75 }] } as any,
      pdfjs: { hasText: true },
      qpdf: { hasStructTree: true, structTreeDepth: 3, hasMarkInfo: true, headings: [] },
    })).toBe('native_tagged')

    expect(classifyStructure({
      analysis: { isScanned: false, categories: [{ score: 82 }, { score: 88 }, { score: 91 }] } as any,
      pdfjs: { hasText: true },
      qpdf: { hasStructTree: true, structTreeDepth: 3, hasMarkInfo: true, headings: [{ level: 'H1', tag: 'H1' }] },
    })).toBe('well_tagged')

    expect(classifyStructure({
      analysis: {
        isScanned: false,
        categories: [
          { id: 'title_language', score: 100 },
          { id: 'heading_structure', score: 100 },
          { id: 'reading_order', score: 100 },
          { id: 'alt_text', score: 40 },
          { id: 'pdf_ua_compliance', score: 85 },
        ],
      } as any,
      pdfjs: { hasText: true },
      qpdf: { hasStructTree: true, structTreeDepth: 4, hasMarkInfo: true, headings: [{ level: 'H1', tag: 'H1' }] },
    })).toBe('native_tagged')
  })

  it('fingerprints authoring tools and font health', () => {
    expect(fingerprintAuthoringTool({
      producer: 'Microsoft Word',
      creator: null,
      creationDate: null,
      modDate: null,
      pdfVersion: '1.7',
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 1,
    })).toBe('microsoft_word')

    expect(fingerprintAuthoringTool({
      producer: null,
      creator: 'pdfTeX',
      creationDate: null,
      modDate: null,
      pdfVersion: '1.5',
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 1,
    })).toBe('latex')

    expect(fingerprintAuthoringTool({
      producer: null,
      creator: null,
      creationDate: null,
      modDate: null,
      pdfVersion: '1.3',
      isEncrypted: false,
      keywords: null,
      author: null,
      subject: null,
      pageCount: 1,
    })).toBe('government_cms')

    expect(classifyFonts({
      fontCount: 0,
      unembeddedFontCount: 0,
      fontsMissingToUnicode: 0,
      legacyWidthRiskFontCount: 0,
      cidFontsMissingCidToGidMap: 0,
    })).toBe('no_fonts')

    expect(classifyFonts({
      fontCount: 4,
      unembeddedFontCount: 1,
      unembeddedType3FontCount: 0,
      fontsMissingToUnicode: 0,
      type1FontsMissingToUnicode: 0,
      legacyWidthRiskFontCount: 0,
      cidFontsMissingCidToGidMap: 0,
    })).toBe('needs_embedding')

    expect(classifyFonts({
      fontCount: 4,
      unembeddedFontCount: 1,
      unembeddedType3FontCount: 1,
      fontsMissingToUnicode: 0,
      type1FontsMissingToUnicode: 0,
      legacyWidthRiskFontCount: 0,
      cidFontsMissingCidToGidMap: 0,
    })).toBe('needs_substitution')

    expect(classifyFonts({
      fontCount: 4,
      unembeddedFontCount: 0,
      unembeddedType3FontCount: 0,
      fontsMissingToUnicode: 3,
      type1FontsMissingToUnicode: 0,
      legacyWidthRiskFontCount: 1,
      cidFontsMissingCidToGidMap: 0,
    })).toBe('legacy_encoding')

    expect(classifyFonts({
      fontCount: 4,
      unembeddedFontCount: 1,
      unembeddedType3FontCount: 0,
      fontsMissingToUnicode: 1,
      type1FontsMissingToUnicode: 1,
      legacyWidthRiskFontCount: 0,
      cidFontsMissingCidToGidMap: 0,
    })).toBe('legacy_encoding')

    expect(classifyFonts({
      fontCount: 6,
      unembeddedFontCount: 0,
      unembeddedType3FontCount: 0,
      fontsMissingToUnicode: 0,
      type1FontsMissingToUnicode: 0,
      legacyWidthRiskFontCount: 3,
      cidFontsMissingCidToGidMap: 2,
    })).toBe('needs_substitution')
  })

  it('builds pipeline configs and compatibility mappings from the richer classifier', () => {
    const classification = classifyPdfFull({
      analysis: {
        isScanned: false,
        overallScore: 92,
        pageCount: 250,
        pdfMetadata: {
          producer: 'Adobe Acrobat',
          creator: null,
          creationDate: null,
          modDate: null,
          pdfVersion: '1.7',
          isEncrypted: false,
          keywords: null,
          author: null,
          subject: null,
          pageCount: 250,
        },
        categories: [{ score: 90 }, { score: 92 }, { score: 94 }],
      } as any,
      context: {
        qpdf: {
          hasStructTree: true,
          structTreeDepth: 3,
          hasMarkInfo: true,
          headings: [{ level: 'H1', tag: 'H1' }],
          images: [],
          tables: [],
          hasAcroForm: false,
          formFields: [],
          noteTagCount: 0,
          fontCount: 3,
          unembeddedFontCount: 0,
          unembeddedType3FontCount: 0,
          fontsMissingToUnicode: 0,
          legacyWidthRiskFontCount: 0,
          cidFontsMissingCidToGidMap: 0,
        } as any,
        pdfjs: {
          hasText: true,
          textLength: 6000,
          imageCount: 0,
          links: [],
          metadata: {
            producer: 'Adobe Acrobat',
            creator: null,
            creationDate: null,
            modDate: null,
            pdfVersion: '1.7',
            isEncrypted: false,
            keywords: null,
            author: null,
            subject: null,
            pageCount: 250,
          },
        } as any,
      },
    })

    expect(classification.structuralClass).toBe('well_tagged')
    expect(classification.fontProfile).toBe('clean')
    expect(classification.scale).toBe('massive')
    expect(classification.remediationDepth).toBe('polish')

    const config = buildPipelineConfig(classification)
    expect(config.stages.structureBootstrap).toBe(false)
    expect(config.stages.fonts).toBe(false)
    expect(config.semanticStrategy).toBe('heuristic_only')
    expect(config.maxRounds).toBe(2)
    expect(config.earlyExitScore).toBe(95)
    expect(config.excludedTools).toContain('bootstrap_struct_tree')
    expect(config.excludedTools).toContain('repair_native_link_structure')

    expect(toReliabilityPdfClass(classification)).toBe('native_tagged')
    expect(toPlaybookPdfClass(classification)).toBe('tagged')
    expect(classifyScale(1)).toBe('tiny')
    expect(classifyScale(50)).toBe('medium')
    expect(classifyDepth(10)).toBe('rebuild')
  })
})
