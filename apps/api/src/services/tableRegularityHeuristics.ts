import type { QpdfResult } from './qpdfService.js'

type QpdfTable = QpdfResult['tables'][number]

export function isAdvisoryTableRegularity(table: QpdfTable): boolean {
  const rowCellCounts = table.rowCellCounts?.filter(count => Number.isFinite(count) && count > 0) ?? []
  const dominantColumnCount = table.dominantColumnCount ?? 0
  if (!table.hasHeaders || table.isRegular !== false) return false
  if (rowCellCounts.length < 4 || dominantColumnCount <= 0) return false
  if ((table.maxRowSpan ?? 1) > 1 || (table.maxColSpan ?? 1) > 1) return false

  const mismatchIndexes = rowCellCounts
    .map((count, index) => ({ count, index }))
    .filter(entry => entry.count !== dominantColumnCount)

  if (mismatchIndexes.length === 0 || mismatchIndexes.length > 2) return false

  const regularRatio = (rowCellCounts.length - mismatchIndexes.length) / rowCellCounts.length
  if (regularRatio < 0.8) return false

  const halfWidth = Math.max(1, Math.ceil(dominantColumnCount / 2))
  const hasBoundaryMismatch = mismatchIndexes.some(entry =>
    entry.index === 0 || entry.index === rowCellCounts.length - 1,
  )

  return mismatchIndexes.every(entry =>
    entry.count < dominantColumnCount
    && (hasBoundaryMismatch || entry.count <= halfWidth),
  )
}
