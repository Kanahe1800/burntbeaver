import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { ChangeEvent } from 'react'
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps'
import type { Layer, PickingInfo } from '@deck.gl/core'
import { GoogleMapsOverlay } from '@deck.gl/google-maps'
import { ScatterplotLayer } from '@deck.gl/layers'

import './App.css'
import LayerControls from './LayerControls'
import Timeline from './Timeline'
import Results from './Results'
import { parseOccurrences } from './uploadParser'
import {
  NDVI_MANIFEST_URL, BURN_MANIFEST_URL,
  makeNdviLayer, ndviFromPick, loadBurn, makeBurnLayer, loadSeason, loadDefaultPoints,
} from './dataLayers'
import type { NdviManifest, BurnManifest, BurnProps } from './dataLayers'
import type { Points, SeasonData } from './statsLib'

type Tooltip = { text: string } | null

// One deck.gl overlay on the Google map that draws all our layers (first = bottom)
function DeckOverlay({ layers, getTooltip }: { layers: Layer[]; getTooltip: (info: PickingInfo) => Tooltip }) {
  const map = useMap()
  const [overlay] = useState(() => new GoogleMapsOverlay({ interleaved: false }))

  useEffect(() => {
    if (!map) return
    const listener = map.addListener('idle', () => { overlay.setMap(map); listener.remove() })
    return () => { listener.remove(); overlay.setMap(null) }
  }, [map, overlay])

  useEffect(() => { overlay.setProps({ layers, getTooltip }) }, [overlay, layers, getTooltip])
  return null
}

// NDVI + burned-area manifests -> one sorted list of months
function useManifests() {
  const [ndvi, setNdvi] = useState<NdviManifest | null>(null)
  const [burn, setBurn] = useState<BurnManifest | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const get = <T,>(url: string): Promise<T> =>
      fetch(url).then((r) => { if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`); return r.json() as Promise<T> })
    get<NdviManifest>(NDVI_MANIFEST_URL).then(setNdvi)
      .catch((e) => { console.error(e); setError('NDVI data not available') })
    get<BurnManifest>(BURN_MANIFEST_URL).then(setBurn)
      .catch((e) => { console.error(e); setError((s) => s || 'Burned-area data not available') })
  }, [])

  const months = useMemo(() => {
    const set = new Set<string>()
    ndvi?.files.forEach((f) => set.add(f.date))
    burn?.files.forEach((f) => set.add(f.month))
    // stop at the newest month that has fire data: NASA publishes MCD64A1 a few months late
    const lastFire = burn?.files.map((f) => f.month).sort().at(-1)
    return [...set].sort().filter((m) => !lastFire || m <= lastFire)
  }, [ndvi, burn])

  return { ndvi, burn, months, error }
}

// grid statistics + default animal (beaver)
function useStatsData() {
  const [season, setSeason] = useState<SeasonData | null>(null)
  const [defaultPoints, setDefaultPoints] = useState<Points | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    loadSeason().then(setSeason)
      .catch((e) => { console.error(e); setError('The statistics data (season.json) could not be loaded.') })
    loadDefaultPoints().then(setDefaultPoints).catch((e) => console.error(e))
  }, [])
  return { season, defaultPoints, error }
}

// GBIF asks every user of a download to cite its DOI. Copy the citation from
// https://www.gbif.org/occurrence/download/0011564-261023074918325 ("Cite as")
const BEAVER_CITATION = {
  text: 'GBIF.org (28 October 2026) GBIF Occurrence Download',
  doi: 'https://doi.org/10.15468/dl.9wtavz',
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function App() {
  const [showNdvi, setShowNdvi] = useState(true)
  const [showBurn, setShowBurn] = useState(true)
  const [showPoints, setShowPoints] = useState(true)
  const [ndviOpacity, setNdviOpacity] = useState(0.75)
  const [monthIndex, setMonthIndex] = useState(0)
  const [burnData, setBurnData] = useState<Awaited<ReturnType<typeof loadBurn>> | null>(null)

  const { ndvi, burn, months, error: mapError } = useManifests()
  const { season, defaultPoints, error: statsError } = useStatsData()

  // the animal shown on the map and analysed: uploaded file, or the beaver default
  const [uploaded, setUploaded] = useState<Points | null>(null)
  const [uploadMsg, setUploadMsg] = useState('')
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const points = uploaded ?? defaultPoints
  const animal = points?.name ?? 'beaver'

  const month: string | undefined = months[monthIndex]
  useEffect(() => { if (months.length) setMonthIndex(months.length - 1) }, [months.length])

  const ndviFile = ndvi?.files.find((f) => f.date === month)?.file
  const burnFile = burn?.files.find((f) => f.month === month)?.file

  useEffect(() => {
    if (!showBurn || !burnFile) { setBurnData(null); return }
    let cancelled = false
    loadBurn(burnFile).then((d) => { if (!cancelled) setBurnData(d) }).catch((e) => console.error(e))
    return () => { cancelled = true }
  }, [showBurn, burnFile])

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setUploadMsg(`Reading ${file.name}…`)
    try {
      const res = await parseOccurrences(file, (n) => setUploadMsg(`Reading ${file.name}… ${n.toLocaleString()} rows`))
      if (res.kept === 0) {
        setUploadMsg(`No usable records in ${file.name} (need locations from 2015 or later).`)
      } else {
        setUploaded(res.points)
        setUploadMsg(`${res.kept.toLocaleString()} of ${res.rowsRead.toLocaleString()} rows kept from ${file.name}`)
      }
    } catch (err) {
      setUploadMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  // layers, bottom -> top: NDVI raster, burned-area outlines, animal points
  const pointIdx = useMemo(() => (points ? Array.from(points.lat, (_, i) => i) : []), [points])
  const layers = useMemo(() => {
    const list: Layer[] = []
    if (showNdvi && ndviFile) list.push(makeNdviLayer({ file: ndviFile, opacity: ndviOpacity, maxZoom: ndvi?.max_zoom ?? 7 }))
    if (showBurn && burnData) list.push(makeBurnLayer({ data: burnData }))
    if (showPoints && points) {
      list.push(new ScatterplotLayer<number>({
        id: 'animals',
        data: pointIdx,
        pickable: true,
        getPosition: (i) => [points.lon[i], points.lat[i]],
        getRadius: 3000,
        radiusMinPixels: 2,
        radiusMaxPixels: 8,
        getFillColor: [120, 72, 30, 210],
        getLineColor: [255, 248, 235, 230],
        stroked: true,
        lineWidthMinPixels: 0.6,
        updateTriggers: { getPosition: points },
      }))
    }
    return list
  }, [showNdvi, ndviFile, ndvi, ndviOpacity, showBurn, burnData, showPoints, points, pointIdx])

  const getTooltip = useCallback((info: PickingInfo): Tooltip => {
    if (!info.layer) return null
    if (info.layer.id === 'animals' && info.index >= 0 && points) {
      const y = points.year[info.index]
      return { text: `${capital(points.name)} record${y ? ` (${y})` : ''}` }
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
  }, [points])

  const missing = [
    showNdvi && month && !ndviFile ? 'greenness' : '',
    showBurn && month && !burnFile ? 'fire' : '',
  ].filter(Boolean)
  const status = mapError || (missing.length ? `No ${missing.join(' or ')} data for this month` : '')

  return (
    <>
      <header className="site-header">
        <div className="brand">
          <span className="brand__mark" aria-hidden>🦫</span>
          <span className="brand__name">Smokey Creatures</span>
        </div>
        <nav>
          <a href="#map">Map</a>
          <a href="#results">Results</a>
          <a href="#about">About</a>
        </nav>
      </header>

      <section className="hero">
        <span className="eyebrow">NASA Space Apps 2026 · Earth Trend Detective</span>
        <h1>Where animals live, do wildfires burn differently?</h1>
        <p>
          We combine ten years of NASA satellite maps of <b>burned land</b> and <b>plant greenness</b> with
          wildlife sightings. Start with beavers — nature's firefighters? — or upload any animal and see what the data says.
        </p>
      </section>

      <main>
        <div className="toolbar" id="map">
          <div className="toolbar__animal">
            <span className="toolbar__label">Animal</span>
            <span className="chip">{capital(animal)}</span>
            <span className="toolbar__count">{points ? `${points.lat.length.toLocaleString()} records` : 'loading…'}</span>
          </div>
          <div className="toolbar__actions">
            {uploadMsg && <span className="toolbar__msg">{uploadMsg}</span>}
            {uploaded && (
              <button className="btn btn--ghost" onClick={() => { setUploaded(null); setUploadMsg('') }}>Back to beaver</button>
            )}
            <button className="btn" onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? 'Reading…' : 'Upload your own CSV'}
            </button>
            <input ref={fileInput} type="file" accept=".csv,.tsv,.txt" onChange={onFile} hidden />
          </div>
        </div>

        <div className="map-card">
          <APIProvider apiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY}>
            <div className="map-wrap">
              <LayerControls
                showNdvi={showNdvi} setShowNdvi={setShowNdvi}
                showBurn={showBurn} setShowBurn={setShowBurn}
                showPoints={showPoints} setShowPoints={setShowPoints}
                ndviOpacity={ndviOpacity} setNdviOpacity={setNdviOpacity}
                animalName={capital(animal)}
              />
              <Map defaultCenter={{ lat: 52, lng: -100 }} defaultZoom={3} gestureHandling="greedy"
                   mapTypeControl={false} streetViewControl={false}>
                <DeckOverlay layers={layers} getTooltip={getTooltip} />
              </Map>
            </div>
          </APIProvider>
          <Timeline months={months} index={monthIndex} setIndex={setMonthIndex} status={status} />
        </div>
        <p className="credit">
          {uploaded
            ? <>Showing your own file. If it came from GBIF, cite its download DOI when you share these results.</>
            : <>Beaver records: {BEAVER_CITATION.text}{' '}
                <a href={BEAVER_CITATION.doi} target="_blank" rel="noreferrer">{BEAVER_CITATION.doi.replace('https://', '')}</a></>}
        </p>

        <Results season={season} points={points} error={statsError} />

        <section className="about" id="about">
          <div>
            <h3>Data</h3>
            <ul>
              <li>Burned area: NASA MODIS MCD64A1 (500 m, monthly)</li>
              <li>Plant greenness: NASA MODIS MOD13A3 NDVI (1 km, monthly)</li>
              <li>
                Beaver records: {BEAVER_CITATION.text}{' '}
                <a href={BEAVER_CITATION.doi} target="_blank" rel="noreferrer">{BEAVER_CITATION.doi.replace('https://', '')}</a>
              </li>
            </ul>
          </div>
          <div>
            <h3>Method</h3>
            <p>
              25 km equal-area squares. Fire: Mantel–Haenszel odds ratio within 500 km regions and vegetation groups,
              per fire season (April–October). Recovery: NDVI change after fire relative to unburned squares at the same
              latitude. Full analysis in our Python notebooks.
            </p>
          </div>
        </section>
      </main>

      <footer className="site-footer">Smokey Creatures · NASA Space Apps Challenge 2026</footer>
    </>
  )
}

export default App