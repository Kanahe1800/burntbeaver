// Time slider that sits below the map: step through months, with year ticks
export function monthLabel(m: string | undefined, style: 'long' | 'short' = 'long'): string {
  if (!m) return '–'
  const [y, mo] = m.split('-').map(Number)
  return new Date(y, mo - 1, 1).toLocaleString('en', { month: style, year: 'numeric' })
}

interface Props {
  months: string[]
  index: number
  setIndex: (i: number) => void
  status?: string
}

export default function Timeline({ months, index, setIndex, status }: Props) {
  const last = months.length - 1

  if (!months.length) {
    return <div className="timeline timeline--empty">Loading the months of satellite data…</div>
  }

  // first month of each year -> tick mark
  const ticks = months
    .map((m, i) => ({ y: m.slice(0, 4), i }))
    .filter((t, k, arr) => k === 0 || t.y !== arr[k - 1].y)
  const pos = (i: number) => (last > 0 ? (i / last) * 100 : 0)

  return (
    <div className="timeline">
      <div className="timeline__buttons">
        <button className="icon-btn" onClick={() => setIndex(Math.max(0, index - 1))} disabled={index === 0} aria-label="Previous month">‹</button>
        <button className="icon-btn" onClick={() => setIndex(Math.min(last, index + 1))} disabled={index === last} aria-label="Next month">›</button>
      </div>

      <div className="timeline__date">
        <span className="timeline__month">{monthLabel(months[index])}</span>
        {status ? <span className="timeline__status">{status}</span> : <span className="timeline__hint">Drag the slider or use the arrows</span>}
      </div>

      <div className="timeline__track">
        <input
          type="range" min={0} max={last} value={index}
          onChange={(e) => setIndex(Number(e.target.value))}
          aria-label="Month"
          style={{ ['--fill' as string]: `${pos(index)}%` }}
        />
        <div className="timeline__ticks">
          {ticks.map((t) => (
            <button key={t.y} className="timeline__tick" style={{ left: `${pos(t.i)}%` }} onClick={() => setIndex(t.i)}>
              {t.y}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}