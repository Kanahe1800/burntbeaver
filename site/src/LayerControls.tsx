import type { CSSProperties } from 'react'
import { NDVI_STOPS } from './dataLayers'

export type Background = 'ndvi' | 'fire' | 'none'

const panel: CSSProperties = {
  position: 'absolute',
  top: 10,
  right: 10,
  zIndex: 10,
  width: 230,
  background: 'white',
  padding: '10px 12px',
  borderRadius: 8,
  boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
  fontSize: 13,
  color: '#222',
}

const BACKGROUNDS: { id: Background; label: string }[] = [
  { id: 'ndvi', label: 'NDVI' },
  { id: 'fire', label: 'Fire' },
  { id: 'none', label: 'None' },
]

function monthLabel(m: string | undefined): string {
  if (!m) return '–'
  const [y, mo] = m.split('-').map(Number)
  return new Date(y, mo - 1, 1).toLocaleString('en', { month: 'short', year: 'numeric' })
}

interface LayerControlsProps {
  background: Background
  setBackground: (b: Background) => void
  months: string[]
  monthIndex: number
  setMonthIndex: (i: number) => void
  opacity: number
  setOpacity: (o: number) => void
  status?: string
}

export default function LayerControls({
  background, setBackground,
  months, monthIndex, setMonthIndex,
  opacity, setOpacity,
  status,
}: LayerControlsProps) {
  const month = months[monthIndex]
  const gradient = `linear-gradient(to right, ${NDVI_STOPS.map(
    ([v, c]) => `rgb(${c.join(',')}) ${((v + 0.2) / 1.1) * 100}%`,
  ).join(', ')})`

  return (
    <div style={panel}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Background</div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {BACKGROUNDS.map((b) => (
          <button
            key={b.id}
            onClick={() => setBackground(b.id)}
            style={{
              flex: 1,
              padding: '4px 0',
              borderRadius: 6,
              border: '1px solid #bbb',
              cursor: 'pointer',
              background: background === b.id ? '#1f4e79' : 'white',
              color: background === b.id ? 'white' : '#222',
            }}
          >
            {b.label}
          </button>
        ))}
      </div>

      {background !== 'none' && months.length > 0 && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Month</span>
            <strong>{monthLabel(month)}</strong>
          </div>
          <input
            type="range"
            min={0}
            max={months.length - 1}
            value={monthIndex}
            onChange={(e) => setMonthIndex(Number(e.target.value))}
            style={{ width: '100%' }}
          />

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
            <span>Opacity</span>
            <span>{Math.round(opacity * 100)}%</span>
          </div>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </>
      )}

      {background === 'ndvi' && (
        <div style={{ marginTop: 6 }}>
          <div style={{ height: 10, borderRadius: 3, background: gradient }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#555' }}>
            <span>-0.2 bare</span>
            <span>0.9 dense</span>
          </div>
        </div>
      )}

      {background === 'fire' && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#555', display: 'flex', gap: 8 }}>
          <span><span style={{ color: 'rgb(255,190,0)' }}>●</span> low</span>
          <span><span style={{ color: 'rgb(255,110,0)' }}>●</span> nominal</span>
          <span><span style={{ color: 'rgb(210,20,20)' }}>●</span> high</span>
        </div>
      )}

      {status && <div style={{ marginTop: 8, fontSize: 11, color: '#a33' }}>{status}</div>}
    </div>
  )
}