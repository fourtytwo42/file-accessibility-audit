import { describe, expect, it } from 'vitest'
import { heuristicFigureAltText } from '../services/remediationCallDerivationService.js'

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
})
