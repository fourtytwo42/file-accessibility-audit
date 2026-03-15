export function normalizeLanguageTag(value: string | null | undefined): string {
  const raw = String(value || '').trim().replace(/_/g, '-')
  if (!raw) return ''

  const parts = raw.split('-').filter(Boolean)
  if (!parts.length) return ''

  return parts.map((part, index) => {
    if (index === 0) return part.toLowerCase()
    if (/^[A-Za-z]{4}$/.test(part)) return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    if (/^[A-Za-z]{2}$/.test(part) || /^\d{3}$/.test(part)) return part.toUpperCase()
    return part.toLowerCase()
  }).join('-')
}

export function hasCanonicalLanguageTag(value: string | null | undefined): boolean {
  const raw = String(value || '').trim()
  return !!raw && normalizeLanguageTag(raw) === raw
}

export function needsLanguageTagNormalization(value: string | null | undefined): boolean {
  const raw = String(value || '').trim()
  return !!raw && normalizeLanguageTag(raw) !== raw
}
