const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'div', 'span', 'section', 'article', 'header', 'footer', 'main',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'a', 'img',
  'strong', 'em', 'b', 'i', 'br', 'hr',
  'figure', 'figcaption',
])

const GLOBAL_ATTRS = new Set(['class', 'id', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby'])
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['alt', 'src', 'data-bbox', 'data-full-page']),
  td: new Set(['colspan', 'rowspan', 'scope']),
  th: new Set(['colspan', 'rowspan', 'scope']),
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("'", '&#39;')
}

function sanitizeAttributeValue(tag: string, attr: string, rawValue: string): string | null {
  const value = rawValue.trim()
  if (!value) return ''
  if (/^on/i.test(attr)) return null

  if (attr === 'href') {
    if (/^(https?:|mailto:|tel:|#)/i.test(value)) return value
    return null
  }

  if (attr === 'src') {
    if (/^(data:image\/[a-z0-9.+-]+;base64,|https?:)/i.test(value)) return value
    return null
  }

  if (attr === 'target') {
    return value === '_blank' ? '_blank' : null
  }

  if (attr === 'rel') {
    return value
  }

  if (attr === 'data-bbox') {
    return /^(\d*\.?\d+\s*,\s*){3}\d*\.?\d+$/.test(value) ? value : null
  }

  if (attr === 'data-full-page') {
    return value === 'true' ? 'true' : null
  }

  if (attr === 'colspan' || attr === 'rowspan') {
    return /^\d+$/.test(value) ? value : null
  }

  return value
}

function sanitizeAttributes(tag: string, rawAttrs: string): string {
  const allowed = new Set([...(TAG_ATTRS[tag] || new Set<string>()), ...GLOBAL_ATTRS])
  const attrs = [...rawAttrs.matchAll(/([:@a-zA-Z0-9_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)]
  const kept: string[] = []

  for (const match of attrs) {
    const attr = match[1]
    if (!allowed.has(attr)) continue
    const rawValue = match[3] ?? match[4] ?? match[5] ?? ''
    const value = sanitizeAttributeValue(tag, attr, rawValue)
    if (value === null) continue
    kept.push(`${attr}="${escapeAttribute(value)}"`)
  }

  if (tag === 'a' && kept.some(attr => attr.startsWith('target="_blank"')) && !kept.some(attr => attr.startsWith('rel='))) {
    kept.push('rel="noopener noreferrer"')
  }

  return kept.length ? ` ${kept.join(' ')}` : ''
}

export function sanitizeHtmlFragment(fragment: string): string {
  const stripped = fragment
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(iframe|object|embed|svg|math|form|input|button|textarea|select)[\s\S]*?<\/\1>/gi, '')

  return stripped.replace(/<\/?([a-zA-Z0-9-]+)([^>]*)>/g, (full, tagName: string, rawAttrs: string) => {
    const tag = tagName.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) return ''
    if (full.startsWith('</')) return `</${tag}>`
    const selfClosing = /\/\s*>$/.test(full) || tag === 'img' || tag === 'br' || tag === 'hr'
    const attrs = sanitizeAttributes(tag, rawAttrs)
    return `<${tag}${attrs}${selfClosing ? ' />' : '>'}`
  }).trim()
}

export function hasHtmlTags(fragment: string): boolean {
  return /<\s*[a-z][^>]*>/i.test(fragment)
}

export function sanitizeCssFragment(css: string | null | undefined): string {
  if (!css) return ''
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import[^;]+;/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/javascript:/gi, '')
    .trim()
}

export function scopeCssToSelector(css: string, selector: string): string {
  if (!css.trim()) return ''
  return css.replace(/(^|})\s*([^@}{][^{}]*)\{/g, (_match, prefix: string, rawSelector: string) => {
    const scoped = rawSelector
      .split(',')
      .map(part => `${selector} ${part.trim()}`)
      .join(', ')
    return `${prefix} ${scoped} {`
  }).trim()
}

export function buildBasicHtmlFromText(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(entry => entry.trim())
    .filter(Boolean)

  if (!paragraphs.length) return '<p>Unable to reconstruct this page automatically.</p>'

  return paragraphs.map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join('\n')
}
