import { useState, useEffect, useMemo, useCallback } from 'react'
import type { ChangeEvent } from 'react'
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps'

import './App.css'
import Papa from 'papaparse'
import type { Layer, PickingInfo } from '@deck.gl/core'
import { GoogleMapsOverlay } from '@deck.gl/google-maps'
import { ScatterplotLayer } from '@deck.gl/layers'

import LayerControls from './LayerControls'
import type { Background } from './LayerControls'
import {
  NDVI_MANIFEST_URL, FIRE_MANIFEST_URL,
  makeNdviLayer, ndviFromPick, loadFirePoints, makeFireLayer, FIRE_CONF_LABEL,
} from './dataLayers'
import type { NdviManifest, FireManifest, FirePoint } from './dataLayers'


export interface BeaverRow {
  lat: number
  lng: number
  year: number | null
}

type CsvRow = Record<string, unknown>

function pickColumn(fields: string[], candidates: string[]): string | undefined {
  return fields.find((f) => candidates.includes(f.trim().toLowerCase()))
}

function DatasetUpload({ onData }: { onData: (rows: BeaverRow[]) => void }) {
  const [status, setStatus] = useState('No file loaded')

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setStatus('Loading...')

    Papa.parse<CsvRow>(file, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      worker: true,
      complete: (result) => {
        const fields = result.meta.fields || []
        const latKey = pickColumn(fields, ['decimallatitude', 'latitude', 'lat'])
        const lngKey = pickColumn(fields, ['decimallongitude', 'longitude', 'lon', 'lng', 'long'])
        const yearKey = pickColumn(fields, ['year'])

        if (!latKey || !lngKey) {
          setStatus('Could not find latitude/longitude columns')
          return
        }

        const rows = result.data
          .map((r): BeaverRow => ({
            lat: r[latKey] as number,
            lng: r[lngKey] as number,
            year: yearKey ? (r[yearKey] as number | null) : null,
          }))
          .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng))

        onData(rows)
        setStatus(`${rows.length.toLocaleString()} points loaded`)
      },
      error: (err) => setStatus(`Error: ${err.message}`),
    })
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 10,
        left: 10,
        zIndex: 10,
        background: 'white',
        padding: '8px 10px',
        borderRadius: 8,
        boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
        fontSize: 13,
        color: '#222',
      }}
    >
      <input type="file" accept=".csv,.tsv,.txt" onChange={handleFile} />
      <div style={{ marginTop: 4 }}>{status}</div>
    </div>
  )
}


// select only north america
function NorthAmericaLayer() {
  const map = useMap()

  useEffect(() => {
    if (!map) return

    const listeners = [
      map.data.addListener('mouseover', (e: google.maps.Data.MouseEvent) => {
        map.data.overrideStyle(e.feature, { fillOpacity: 0.7 })
      }),
      map.data.addListener('mouseout', () => { map.data.revertStyle() }),
      map.data.addListener('click', (e: google.maps.Data.MouseEvent) => {
        console.log(e.feature.getProperty('NAME'))
      }),
    ]

    return () => {
      listeners.forEach((l) => l.remove())
      map.data.forEach((feature) => map.data.remove(feature))
    }
  }, [map])

  return null
}


type Tooltip = { text: string } | null

// One deck.gl overlay on the Google map that draws all our layers (in order: first = bottom)
function DeckOverlay({ layers, getTooltip }: { layers: Layer[]; getTooltip: (info: PickingInfo) => Tooltip }) {
  const map = useMap()
  const [overlay] = useState(() => new GoogleMapsOverlay({ interleaved: false }))

  // attach overlay to the map once it's fully initialized
  useEffect(() => {
    if (!map) return
    const listener = map.addListener('idle', () => {
      overlay.setMap(map)
      listener.remove()
    })
    return () => {
      listener.remove()
      overlay.setMap(null)
    }
  }, [map, overlay])

  useEffect(() => {
    overlay.setProps({ layers, getTooltip })
  }, [overlay, layers, getTooltip])

  return null
}


// Load the NDVI + fire manifests and build a combined, sorted list of months
function useManifests() {
  const [ndvi, setNdvi] = useState<NdviManifest | null>(null)
  const [fire, setFire] = useState<FireManifest | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const get = <T,>(url: string): Promise<T> =>
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`)
        return r.json() as Promise<T>
      })
    get<NdviManifest>(NDVI_MANIFEST_URL)
      .then(setNdvi)
      .catch((e) => { console.error(e); setError('NDVI data not available') })
    get<FireManifest>(FIRE_MANIFEST_URL)
      .then(setFire)
      .catch((e) => { console.error(e); setError((s) => s || 'Fire data not available') })
  }, [])

  const months = useMemo(() => {
    const set = new Set<string>()
    ndvi?.files.forEach((f) => set.add(f.date)) // "2026-06"
    fire?.files.forEach((f) => set.add(f.start.slice(0, 7))) // "2026-07-20" -> "2026-07"
    return [...set].sort()
  }, [ndvi, fire])

  return { ndvi, fire, months, error }
}


function App() {
  const [rows, setRows] = useState<BeaverRow[]>([])
  const [background, setBackground] = useState<Background>('ndvi')
  const [monthIndex, setMonthIndex] = useState(0)
  const [opacity, setOpacity] = useState(0.8)
  const [firePoints, setFirePoints] = useState<FirePoint[]>([])

  const { ndvi, fire, months, error } = useManifests()
  const month: string | undefined = months[monthIndex]

  // start on the latest month once the manifests arrive
  useEffect(() => { if (months.length) setMonthIndex(months.length - 1) }, [months.length])

  // files for the selected month
  const ndviFile = ndvi?.files.find((f) => f.date === month)?.file
  const fireFiles = useMemo(
    () => (fire?.files ?? []).filter((f) => month && f.start.startsWith(month)).map((f) => f.file),
    [fire, month],
  )

  // load fire points when the fire background is on (all 8-day composites in the month)
  useEffect(() => {
    if (background !== 'fire' || fireFiles.length === 0) { setFirePoints([]); return }
    let cancelled = false
    loadFirePoints(fireFiles)
      .then((pts) => { if (!cancelled) setFirePoints(pts) })
      .catch((e) => console.error(e))
    return () => { cancelled = true }
  }, [background, fireFiles])

  // layers, bottom -> top: background (NDVI or fire), then beavers
  const layers = useMemo(() => {
    const list: Layer[] = []
    if (background === 'ndvi' && ndviFile) {
      list.push(makeNdviLayer({ file: ndviFile, opacity, maxZoom: ndvi?.max_zoom ?? 7 }))
    }
    if (background === 'fire' && firePoints.length) {
      list.push(makeFireLayer({ points: firePoints, opacity }))
    }
    list.push(new ScatterplotLayer<BeaverRow>({
      id: 'beavers',
      data: rows,
      pickable: true,
      getPosition: (d) => [d.lng, d.lat],
      getRadius: 4000,
      radiusMinPixels: 2,
      getFillColor: [139, 69, 19, 200],
      getLineColor: [255, 255, 255, 220],
      stroked: true,
      lineWidthMinPixels: 0.5,
    }))
    return list
  }, [background, ndviFile, ndvi, firePoints, opacity, rows])

  // hover text for whatever is under the cursor
  const getTooltip = useCallback((info: PickingInfo): Tooltip => {
    if (!info.layer) return null
    if (info.layer.id === 'beavers' && info.object) {
      const d = info.object as BeaverRow
      return { text: `Beaver record${d.year ? ` (${d.year})` : ''}` }
    }
    if (info.layer.id === 'fire' && info.object) {
      const d = info.object as FirePoint
      return { text: `Fire ${d.start} – ${d.end}\nconfidence: ${FIRE_CONF_LABEL[d.conf] ?? d.conf}` }
    }
    if (info.layer.id.startsWith('ndvi')) {
      const v = ndviFromPick(info)
      return v === null ? null : { text: `NDVI ${v.toFixed(2)}` }
    }
    return null
  }, [])

  const noDataForMonth =
    month && ((background === 'ndvi' && !ndviFile) || (background === 'fire' && fireFiles.length === 0))
      ? `No ${background === 'ndvi' ? 'NDVI' : 'fire'} data for this month`
      : ''

  return (
    <>
      <header style={{ padding: '1rem 2rem' }}>
        <h1>Burnt Beaver</h1>
      </header>

      <main style={{ maxWidth: 1000, margin: '0 auto', padding: '0 1rem' }}>
        <p>Some intro text above the map.</p>

        <APIProvider apiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY}>
          <div style={{ position: 'relative', width: '60vw', height: '70vh' }}>
            <DatasetUpload onData={setRows} />
            <LayerControls
              background={background} setBackground={setBackground}
              months={months} monthIndex={monthIndex} setMonthIndex={setMonthIndex}
              opacity={opacity} setOpacity={setOpacity}
              status={error || noDataForMonth}
            />

            <Map
              defaultCenter={{ lat: 50, lng: -100 }}
              defaultZoom={3}
              gestureHandling="greedy"
              disableDefaultUI={false}
            >
              <DeckOverlay layers={layers} getTooltip={getTooltip} />
              <NorthAmericaLayer />
            </Map>
          </div>
        </APIProvider>

        <p>Observation data like iNaturalist or GBIF reflects where people go looking, not just where beavers are.</p>
      </main>
    </>
  )
}

export default App