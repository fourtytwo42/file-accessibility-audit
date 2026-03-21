import { describe, expect, it } from 'vitest'

import { draftFigureAltText } from '../services/altTextDraftingService.js'

describe('draftFigureAltText', () => {
  it('skips unreadable glyph-soup and date-only context lines', () => {
    const result = draftFigureAltText({
      pageNumber: 1,
      surroundingText: [
        'M a y 1 7 , 2 0 2 2',
        'Ŗ œ œ h Ǝ Ǥ ™ † Ä Ü T â Ù e',
        'Police Training and Policy Examples',
      ],
    })

    expect(result).toBe('Police Training and Policy Examples')
  })

  it('falls back to a safe illustration label when no useful context remains', () => {
    const result = draftFigureAltText({
      pageNumber: 4,
      surroundingText: [
        'M a y 1 7 , 2 0 2 2',
        'Ŗ œ œ h Ǝ Ǥ ™ † Ä Ü T â Ù e',
      ],
    })

    expect(result).toBe('Illustration on page 4')
  })
})
