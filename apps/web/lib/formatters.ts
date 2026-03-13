export function formatDate(value: string | null | undefined): string {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString()
}

export function formatFileSize(size: number | null | undefined): string {
  if (typeof size !== 'number' || size < 0) return 'Unknown'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function formatScore(score: number | null | undefined): string {
  return typeof score === 'number' ? `${score}/100` : 'Pending'
}
