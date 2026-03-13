import { gradeColor } from '@/lib/gradeColors'

export function GradeBadge({ grade }: { grade: string | null | undefined }) {
  return (
    <span
      className="inline-flex min-w-10 items-center justify-center rounded-full px-3 py-1 text-sm font-semibold"
      style={{ background: `${gradeColor(grade)}22`, color: gradeColor(grade) }}
    >
      {grade || '-'}
    </span>
  )
}
