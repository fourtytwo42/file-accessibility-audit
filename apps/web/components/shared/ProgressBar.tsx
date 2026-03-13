export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--surface-strong)' }}>
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: 'linear-gradient(90deg, var(--accent), #f97316)' }}
      />
    </div>
  )
}
