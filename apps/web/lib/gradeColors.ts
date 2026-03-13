export const GRADE_COLORS: Record<string, string> = {
  A: '#22c55e',
  B: '#14b8a6',
  C: '#eab308',
  D: '#f97316',
  F: '#ef4444',
}

export function gradeColor(grade: string | null | undefined): string {
  if (!grade) return '#6b7280'
  return GRADE_COLORS[grade] || '#6b7280'
}
