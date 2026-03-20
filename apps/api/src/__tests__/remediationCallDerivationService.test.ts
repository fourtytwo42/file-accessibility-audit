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

    expect(altText).toBe('Image on page 1')
  })
})
