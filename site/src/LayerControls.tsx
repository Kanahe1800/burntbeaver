// Floating panel on the map: turn layers on/off + legends
import { NDVI_STOPS, BURN_LINE, BURN_FILL } from './dataLayers'

const rgba = (c: number[]) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})`

interface LayerControlsProps {
  showNdvi: boolean
  setShowNdvi: (v: boolean) => void
  showBurn: boolean
  setShowBurn: (v: boolean) => void
  showPoints: boolean
  setShowPoints: (v: boolean) => void
  ndviOpacity: number
  setNdviOpacity: (o: number) => void
  animalName: string
}

export default function LayerControls({
  showNdvi, setShowNdvi, showBurn, setShowBurn, showPoints, setShowPoints,
  ndviOpacity, setNdviOpacity, animalName,
}: LayerControlsProps) {
  const gradient = `linear-gradient(to right, ${NDVI_STOPS.map(
    ([v, c]) => `rgb(${c.join(',')}) ${((v + 0.2) / 1.1) * 100}%`,
  ).join(', ')})`

  return (
    <div className="layer-panel">
      <div className="layer-panel__title">Map layers</div>

      <label className="layer-row">
        <input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} />
        <span className="swatch swatch--dot" />
        <span>{animalName} records</span>
      </label>

      <label className="layer-row">
        <input type="checkbox" checked={showBurn} onChange={(e) => setShowBurn(e.target.checked)} />
        <span className="swatch" style={{ border: `2px solid ${rgba(BURN_LINE)}`, background: rgba(BURN_FILL) }} />
        <span>Burned that month</span>
      </label>

      <label className="layer-row">
        <input type="checkbox" checked={showNdvi} onChange={(e) => setShowNdvi(e.target.checked)} />
        <span className="swatch" style={{ background: gradient }} />
        <span>Plant greenness (NDVI)</span>
      </label>
      {showNdvi && (
        <div className="layer-sub">
          <div className="legend-bar" style={{ background: gradient }} />
          <div className="legend-labels"><span>bare</span><span>dense green</span></div>
          <label className="opacity">
            <span>Opacity {Math.round(ndviOpacity * 100)}%</span>
            <input type="range" min={0.1} max={1} step={0.05} value={ndviOpacity}
                   onChange={(e) => setNdviOpacity(Number(e.target.value))} />
          </label>
        </div>
      )}
    </div>
  )
}
