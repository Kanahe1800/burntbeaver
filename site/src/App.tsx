import { useState, useEffect, useMemo, useCallback } from 'react'
import type { ChangeEvent } from 'react'
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps'

import './App.css'
import Papa from 'papaparse'
import type { Layer, PickingInfo } from '@deck.gl/core'
import { GoogleMapsOverlay } from '@deck.gl/google-maps'
import { ScatterplotLayer } from '@deck.gl/layers'

import LayerControls from './LayerControls'
import {
  NDVI_MANIFEST_URL, BURN_MANIFEST_URL,
  makeNdviLayer, ndviFromPick, loadBurn, makeBurnLayer,
} from './dataLayers'
import type { NdviManifest, BurnManifest, BurnProps } from './dataLayers'


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


// Load the NDVI + burned-area manifests and build a combined, sorted list of months
function useManifests() {
  const [ndvi, setNdvi] = useState<NdviManifest | null>(null)
  const [burn, setBurn] = useState<BurnManifest | null>(null)
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
    get<BurnManifest>(BURN_MANIFEST_URL)
      .then(setBurn)
      .catch((e) => { console.error(e); setError((s) => s || 'Burned-area data not available') })
  }, [])

  const months = useMemo(() => {
    const set = new Set<string>()
    ndvi?.files.forEach((f) => set.add(f.date)) // "2026-06"
    burn?.files.forEach((f) => set.add(f.month)) // "2026-07"
    return [...set].sort()
  }, [ndvi, burn])

  return { ndvi, burn, months, error }
}


function App() {
  const [rows, setRows] = useState<BeaverRow[]>([])
  const [showNdvi, setShowNdvi] = useState(true)
  const [showBurn, setShowBurn] = useState(true)
  const [monthIndex, setMonthIndex] = useState(0)
  const [ndviOpacity, setNdviOpacity] = useState(0.8)
  const [burnData, setBurnData] = useState<Awaited<ReturnType<typeof loadBurn>> | null>(null)

  const { ndvi, burn, months, error } = useManifests()
  const month: string | undefined = months[monthIndex]

  // start on the latest month once the manifests arrive
  useEffect(() => { if (months.length) setMonthIndex(months.length - 1) }, [months.length])

  // files for the selected month
  const ndviFile = ndvi?.files.find((f) => f.date === month)?.file
  const burnFile = burn?.files.find((f) => f.month === month)?.file

  // load that month's burned-area outlines
  useEffect(() => {
    if (!showBurn || !burnFile) { setBurnData(null); return }
    let cancelled = false
    loadBurn(burnFile)
      .then((d) => { if (!cancelled) setBurnData(d) })
      .catch((e) => console.error(e))
    return () => { cancelled = true }
  }, [showBurn, burnFile])

  // layers, bottom -> top: NDVI raster, burned-area outlines, beaver points
  const layers = useMemo(() => {
    const list: Layer[] = []
    if (showNdvi && ndviFile) {
      list.push(makeNdviLayer({ file: ndviFile, opacity: ndviOpacity, maxZoom: ndvi?.max_zoom ?? 7 }))
    }
    if (showBurn && burnData) {
      list.push(makeBurnLayer({ data: burnData }))
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
  }, [showNdvi, ndviFile, ndvi, ndviOpacity, showBurn, burnData, rows])

  // hover text for whatever is under the cursor (top layer wins)
  const getTooltip = useCallback((info: PickingInfo): Tooltip => {
    if (!info.layer) return null
    if (info.layer.id === 'beavers' && info.object) {
      const d = info.object as BeaverRow
      return { text: `Beaver record${d.year ? ` (${d.year})` : ''}` }
    }
    if (info.layer.id === 'burn' && info.object) {
      const p = (info.object as { properties: BurnProps }).properties
      const dates = p.start === p.end ? p.start : `${p.start} – ${p.end}`
      return { text: `Burned ${dates}\n${p.area_km2.toLocaleString()} km²` }
    }
    if (info.layer.id.startsWith('ndvi')) {
      const v = ndviFromPick(info)
      return v === null ? null : { text: `NDVI ${v.toFixed(2)}` }
    }
    return null
  }, [])

  const missing = [
    showNdvi && month && !ndviFile ? 'NDVI' : '',
    showBurn && month && !burnFile ? 'burned area' : '',
  ].filter(Boolean)
  const status = error || (missing.length ? `No ${missing.join(' or ')} data for this month` : '')

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
              showNdvi={showNdvi} setShowNdvi={setShowNdvi}
              showBurn={showBurn} setShowBurn={setShowBurn}
              months={months} monthIndex={monthIndex} setMonthIndex={setMonthIndex}
              ndviOpacity={ndviOpacity} setNdviOpacity={setNdviOpacity}
              status={status}
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