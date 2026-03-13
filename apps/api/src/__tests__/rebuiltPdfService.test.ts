import { describe, expect, it } from 'vitest'
import { buildRebuiltHtml } from '../services/rebuiltPdfService.js'
import type { DocumentModel, ReconstructionArtifacts } from '../services/documentModel.js'

function makeModel(html: string, css = ''): DocumentModel {
  return {
    version: '4',
    processingPath: 'ai_html',
    title: 'Example Title',
    language: 'en-US',
    sourceType: 'native-text',
    confidenceSummary: {
      overall: 85,
      textRecovery: 85,
      structureRecovery: 85,
      tableRecovery: 0,
      visualFidelity: 85,
    },
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        html,
        css,
        links: [{ url: 'https://example.com', text: 'Example' }],
      },
    ],
    manualReviewFlags: [],
    aiAppliedChanges: [],
    aiSuggestedChanges: [],
  }
}

function makeArtifacts(): ReconstructionArtifacts {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0eQAAAAASUVORK5CYII=', 'base64')
  return {
    pageImages: [{
      pageNumber: 1,
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      buffer: png,
    }],
  }
}

describe('buildRebuiltHtml', () => {
  it('sets title and language on the final html document', async () => {
    const html = await buildRebuiltHtml({
      model: makeModel('<h1>Title</h1><p>Body</p>'),
      artifacts: makeArtifacts(),
    })
    expect(html).toContain('<html lang="en-US">')
    expect(html).toContain('<title>Example Title</title>')
  })

  it('preserves links and semantic tables', async () => {
    const html = await buildRebuiltHtml({
      model: makeModel('<a href="https://example.com">Example</a><table><tbody><tr><th scope="col">A</th><td>B</td></tr></tbody></table>'),
      artifacts: makeArtifacts(),
    })
    expect(html).toContain('<a href="https://example.com">Example</a>')
    expect(html).toContain('<table>')
    expect(html).not.toContain('page-background')
  })

  it('materializes full-page image tags without synthetic background layers', async () => {
    const html = await buildRebuiltHtml({
      model: makeModel('<figure><img data-full-page="true" alt="Scanned page" /></figure>', '.scan { color: red; }'),
      artifacts: makeArtifacts(),
    })
    expect(html).toContain('src="data:image/png;base64,')
    expect(html).toContain('alt="Scanned page"')
    expect(html).not.toContain('page-background')
    expect(html).toContain('.page-fragment-1 .scan')
  })
})
