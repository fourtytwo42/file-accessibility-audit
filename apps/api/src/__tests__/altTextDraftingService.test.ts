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

  it('skips body-prose fragments when drafting fallback alt text', () => {
    const result = draftFigureAltText({
      pageNumber: 7,
      surroundingText: [
        'emotional than men. 17 In addition, police culture may lead to skepticism, cynicism, and',
        'Support from administrative staff',
      ],
    })

    expect(result).toBe('Support from administrative staff')
  })

  it('skips bibliography-like context lines when drafting fallback alt text', () => {
    const result = draftFigureAltText({
      pageNumber: 14,
      surroundingText: [
        'Management , 36 (1), 91-118',
        'Illinois Policing Training Act',
      ],
    })

    expect(result).toBe('Illinois Policing Training Act')
  })
})
