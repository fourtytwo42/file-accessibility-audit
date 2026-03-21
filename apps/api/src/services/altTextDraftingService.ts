function normalizeDraftText(text: string | null | undefined): string {
  return String(text || '')
    .replace(/^u:/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function trimToWholeWords(text: string, maxWords: number, maxChars: number): string {
  const words = text.split(/\s+/).filter(Boolean)
  const limitedWords = words.slice(0, maxWords).join(' ')
  return limitedWords.slice(0, maxChars).replace(/[,\s;:.-]+$/g, '').trim()
}

function cleanContextLine(text: string | null | undefined): string | null {
  let normalized = normalizeDraftText(text)
  if (!normalized) return null

  normalized = normalized
    .replace(/^[\s*•·\-–—]+/, '')
    .replace(/^(figure|fig\.?|image|photo|graphic|illustration|chart|table)\s+\d+[:.)\-\s]*/i, '')
    .replace(/^(figure|fig\.?|image|photo|graphic|illustration|chart|table)[:.)\-\s]+/i, '')
    .replace(/[.]+$/g, '')
    .trim()

  if (!normalized) return null
  if (normalized.length < 3) return null
  if (/^(figure|chart|table|image|photo|graphic|illustration)(\s+\d+)?$/i.test(normalized)) return null
  if (!/[A-Za-z]/.test(normalized)) return null
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}$/i.test(normalized)) return null

  const words = normalized.split(/\s+/).filter(Boolean)
  const singleCharacterWords = words.filter(word => /^[A-Za-z]$/.test(word))
  if (words.length >= 5 && singleCharacterWords.length / words.length > 0.45) return null
  const isolatedGlyphWords = words.filter(word => word.replace(/[.,;:!?'"()\-_/\\]/g, '').length <= 1)
  if (words.length >= 6 && isolatedGlyphWords.length / words.length >= 0.65) return null
  if (/^[a-z]/.test(normalized) && words.length >= 6) return null
  if (/\b\d{1,3}\b/.test(normalized) && words.length >= 6) return null
  if (/\b(and|or|but|with|than|to|of|for|in|on|at|by)$/i.test(normalized)) return null

  return trimToWholeWords(normalized, 14, 100)
}

export function draftFigureAltText(input: {
  pageNumber: number
  surroundingText?: Array<string | null | undefined>
  decorative?: boolean
}): string {
  if (input.decorative) return `Decorative image on page ${input.pageNumber}`

  for (const line of input.surroundingText || []) {
    const cleaned = cleanContextLine(line)
    if (cleaned) return cleaned
  }

  return `Illustration on page ${input.pageNumber}`
}
