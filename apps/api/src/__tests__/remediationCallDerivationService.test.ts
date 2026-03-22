import { describe, expect, it } from 'vitest'
import { deriveDeterministicCall, heuristicFigureAltText } from '../services/remediationCallDerivationService.js'

describe('remediationCallDerivationService', () => {
  it('does not default unknown figure hints to decorative alt text', () => {
    const altText = heuristicFigureAltText('figure:1', {
      figureCandidates: [{
        id: 'figure:1',
        pageNumber: 1,
        targetRef: 'obj:1 0 R',
        bbox: null,
        hasAlt: false,
        altText: null,
        informativeHint: 'unknown',
        surroundingText: [],
        repairMode: 'retag_then_set_alt',
        targetTag: '/P',
        parentTagPath: [],
        pageImageCount: 0,
        textDensityHint: 'low',
        imageEvidence: 'strong',
      }],
    } as any)

    expect(altText).toBe('Illustration on page 1')
  })

  it('uses concise surrounding context instead of boilerplate figure phrasing', () => {
    const altText = heuristicFigureAltText('figure:1', {
      figureCandidates: [{
        id: 'figure:1',
        pageNumber: 1,
        targetRef: 'obj:1 0 R',
        bbox: null,
        hasAlt: false,
        altText: null,
        informativeHint: 'informative',
        surroundingText: ['Figure 1: Organizational culture chart.'],
        repairMode: 'set_alt',
        targetTag: '/Figure',
        parentTagPath: [],
        pageImageCount: 0,
        textDensityHint: 'low',
        imageEvidence: 'strong',
      }],
    } as any)

    expect(altText).toBe('Organizational culture chart')
  })

  it('preserves residual family metadata on deterministic calls', () => {
    const call = deriveDeterministicCall({
      filename: 'example.pdf',
      analysis: { verapdf: { failures: [] } } as any,
      context: {
        pdfjs: { title: null, lang: 'en' },
        qpdf: { lang: 'en' },
        headingCandidates: [],
        figureCandidates: [],
        tableCandidates: [],
        pages: [],
        linkCandidates: [],
        readingOrderParentCandidates: [],
      } as any,
      opportunity: {
        toolName: 'normalize_document_metadata',
        reason: 'Normalize metadata',
        confidence: 0.9,
        candidateIds: [],
        candidateGroupIds: [],
        familyId: 'metadata_normalization',
        familyStep: 2,
        expectedPostconditions: ['metadata_blocking_keys_shrink'],
      },
      selectedActions: [],
    })

    expect(call).toMatchObject({
      tool_name: 'normalize_document_metadata',
      familyId: 'metadata_normalization',
      familyStep: 2,
      expectedPostconditions: ['metadata_blocking_keys_shrink'],
    })
  })
})
