import type { CSSProperties } from 'react'
import { NDVI_STOPS, BURN_LINE, BURN_FILL } from './dataLayers'

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

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 4 }

function monthLabel(m: string | undefined): string {
  if (!m) return '–'
  const [y, mo] = m.split('-').map(Number)
  return new Date(y, mo - 1, 1).toLocaleString('en', { month: 'short', year: 'numeric' })
}

const rgba = (c: number[]) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})`

interface LayerControlsProps {
  showNdvi: boolean
  setShowNdvi: (v: boolean) => void
  showBurn: boolean
  setShowBurn: (v: boolean) => void
  months: string[]
  monthIndex: number
  setMonthIndex: (i: number) => void
  ndviOpacity: number
  setNdviOpacity: (o: number) => void
  status?: string
}

export default function LayerControls({
  showNdvi, setShowNdvi,
  showBurn, setShowBurn,
  months, monthIndex, setMonthIndex,
  ndviOpacity, setNdviOpacity,
  status,
}: LayerControlsProps) {
  const month = months[monthIndex]
  const gradient = `linear-gradient(to right, ${NDVI_STOPS.map(
    ([v, c]) => `rgb(${c.join(',')}) ${((v + 0.2) / 1.1) * 100}%`,
  ).join(', ')})`

  return (
    <div style={panel}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Layers</div>

      <label style={row}>
        <input type="checkbox" checked={showNdvi} onChange={(e) => setShowNdvi(e.target.checked)} />
        NDVI (vegetation)
      </label>
      {showNdvi && (
        <div style={{ margin: '2px 0 8px 22px' }}>
          <div style={{ height: 8, borderRadius: 3, background: gradient }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#555' }}>
            <span>-0.2 bare</span>
            <span>0.9 dense</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#555', marginTop: 2 }}>
            <span>Opacity</span>
            <span>{Math.round(ndviOpacity * 100)}%</span>
          </div>
          <input
            type="range" min={0.1} max={1} step={0.05} value={ndviOpacity}
            onChange={(e) => setNdviOpacity(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>
      )}

      <label style={row}>
        <input type="checkbox" checked={showBurn} onChange={(e) => setShowBurn(e.target.checked)} />
        <span
          style={{
            display: 'inline-block', width: 14, height: 10, borderRadius: 2,
            border: `2px solid ${rgba(BURN_LINE)}`, background: rgba(BURN_FILL),
          }}
        />
        Burned area (that month)
      </label>

      {months.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Month</span>
            <strong>{monthLabel(month)}</strong>
          </div>
          <input
            type="range" min={0} max={months.length - 1} value={monthIndex}
            onChange={(e) => setMonthIndex(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </div>
      )}

      {status && <div style={{ marginTop: 6, fontSize: 11, color: '#a33' }}>{status}</div>}
    </div>
  )
}