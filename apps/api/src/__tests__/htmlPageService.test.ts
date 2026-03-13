import { describe, expect, it } from 'vitest'
import { buildBasicHtmlFromText, hasHtmlTags, sanitizeCssFragment, sanitizeHtmlFragment, scopeCssToSelector } from '../services/htmlPageService.js'
import { buildPageReconstructionPrompt, normalizeAiPageReconstruction } from '../services/openRouterService.js'

describe('normalizeAiPageReconstruction', () => {
  it('accepts valid html payloads', () => {
    const normalized = normalizeAiPageReconstruction({
      html: '<h1>Title</h1><p>Body</p>',
      css: '.title { font-size: 20px; }',
      reviewFlags: [],
      titleSuggestion: 'Example',
      documentTitleHint: 'Example Document',
      languageSuggestion: 'en-US',
      pageRole: 'content',
      headingCandidates: [{ text: 'Title', level: 'H1', confidence: 0.95 }],
      tableCandidates: [{ summary: 'Summary table', hasHeaderRow: true, confidence: 0.88 }],
      imageCandidates: [{ altText: 'Cover photo', decorative: false, confidence: 0.78 }],
      confidence: 0.88,
    })

    expect(normalized.html).toContain('<h1>Title</h1>')
    expect(normalized.css).toContain('font-size')
    expect(normalized.titleSuggestion).toBe('Example')
    expect(normalized.documentTitleHint).toBe('Example Document')
    expect(normalized.languageSuggestion).toBe('en-US')
    expect(normalized.pageRole).toBe('content')
    expect(normalized.headingCandidates).toHaveLength(1)
    expect(normalized.tableCandidates).toHaveLength(1)
    expect(normalized.imageCandidates).toHaveLength(1)
    expect(normalized.confidence).toBe(0.88)
  })
})

describe('buildPageReconstructionPrompt', () => {
  it('includes structured page context alongside native text', () => {
    const prompt = buildPageReconstructionPrompt({
      filename: 'example.pdf',
      pageNumber: 2,
      nativeText: 'Visible native text',
      pageContext: {
        width: 612,
        height: 792,
        textLength: 18,
        imageCount: 1,
        textLines: [{
          text: 'Heading',
          bbox: { x: 0.1, y: 0.1, width: 0.4, height: 0.05 },
          fontSize: 18,
          fontWeight: 'bold',
        }],
        links: [{
          url: 'https://example.com',
          text: 'Example',
          bbox: { x: 0.1, y: 0.2, width: 0.2, height: 0.03 },
        }],
      },
    })

    expect(prompt).toContain('structured page_context JSON is the source of truth')
    expect(prompt).toContain('Plain text without tags is invalid')
    expect(prompt).toContain('headingCandidates')
    expect(prompt).toContain('tableCandidates')
    expect(prompt).toContain('imageCandidates')
    expect(prompt).toContain('Native extracted text (may be partial): Visible native text')
    expect(prompt).toContain('"imageCount":1')
    expect(prompt).toContain('"text":"Heading"')
    expect(prompt).toContain('"url":"https://example.com"')
  })
})

describe('sanitizeHtmlFragment', () => {
  it('strips unsupported tags and unsafe attributes', () => {
    const sanitized = sanitizeHtmlFragment('<script>alert(1)</script><p onclick="x()">Hi</p><iframe src="x"></iframe>')
    expect(sanitized).toBe('<p>Hi</p>')
  })

  it('preserves semantic html tags', () => {
    const sanitized = sanitizeHtmlFragment('<h1 class="title">Title</h1><p>Body</p><ul><li>One</li></ul><table><tbody><tr><th scope="col">A</th><td colspan="2">B</td></tr></tbody></table><a href="https://example.com">Link</a><img data-bbox="0.1,0.2,0.3,0.4" alt="Figure" />')
    expect(sanitized).toContain('<h1 class="title">Title</h1>')
    expect(sanitized).toContain('<table>')
    expect(sanitized).toContain('<a href="https://example.com">Link</a>')
    expect(sanitized).toContain('data-bbox="0.1,0.2,0.3,0.4"')
  })
})

describe('hasHtmlTags', () => {
  it('detects real html tags and rejects plain prose', () => {
    expect(hasHtmlTags('<p>Hello</p>')).toBe(true)
    expect(hasHtmlTags('Just a plain sentence.')).toBe(false)
  })
})

describe('sanitizeCssFragment', () => {
  it('removes unsafe css constructs', () => {
    const sanitized = sanitizeCssFragment('@import url(x); .x { color: red; background: javascript:alert(1); width: expression(alert(1)); }')
    expect(sanitized).not.toContain('@import')
    expect(sanitized).not.toContain('javascript:')
    expect(sanitized).not.toContain('expression')
    expect(sanitized).toContain('.x { color: red; background: alert(1); width: ); }')
  })
})

describe('scopeCssToSelector', () => {
  it('prefixes selectors with a page scope', () => {
    expect(scopeCssToSelector('h1, p.note { color: red; }', '.page-fragment-1')).toContain('.page-fragment-1 h1, .page-fragment-1 p.note { color: red; }')
  })
})

describe('buildBasicHtmlFromText', () => {
  it('creates paragraphs from plain text', () => {
    const html = buildBasicHtmlFromText('Hello world\n\nSecond paragraph')
    expect(html).toContain('<p>Hello world</p>')
    expect(html).toContain('<p>Second paragraph</p>')
  })
})
