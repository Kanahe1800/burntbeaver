// Map data layers: NDVI (COG rasters on R2) and burned-area outlines (MCD64A1 GeoJSON on R2).
import type { PickingInfo } from '@deck.gl/core'
import { TileLayer } from '@deck.gl/geo-layers'
import type { TileLayerPickingInfo } from '@deck.gl/geo-layers'
import { BitmapLayer, GeoJsonLayer } from '@deck.gl/layers'
import type { BitmapLayerPickingInfo } from '@deck.gl/layers'
import { fromUrl } from 'geotiff'
import type GeoTIFF from 'geotiff'

// Where the preprocessed data lives (R2 bucket). Override with VITE_DATA_URL if needed,
// e.g. VITE_DATA_URL=/data to test with files in site/public/data/
export const DATA_URL: string = import.meta.env.VITE_DATA_URL || 'https://data.smoky-creatures.earth'
export const NDVI_MANIFEST_URL = `${DATA_URL}/ndvi/manifest.json`
export const BURN_MANIFEST_URL = `${DATA_URL}/burn/burn_manifest.json`
export const STATS_GRID = '25km'                                             // grid used for the in-browser statistics
export const SEASON_URL = `${DATA_URL}/grid/${STATS_GRID}/season.json`       // from prep_web_stats.py
export const DEFAULT_POINTS_URL = `${DATA_URL}/grid/${STATS_GRID}/beaver_points.json`

const NODATA = -3000
const SCALE = 0.0001
const TILE = 256

// ---------- manifest types (match the Python prep scripts' output) ----------
export interface NdviManifest {
  variable: 'NDVI'
  max_zoom: number
  bounds_lonlat: [number, number, number, number]
  scale: number
  nodata: number
  files: { date: string; file: string; size_mb: number }[] // date = "2026-06"
}

export interface BurnManifest {
  variable: 'burned_area'
  bounds_lonlat: [number, number, number, number]
  files: { month: string; file: string; fires: number; burned_km2: number }[] // month = "2026-07"
}

export interface BurnProps {
  id: number
  area_km2: number
  start: string // first burn day in the month, "2026-07-04"
  end: string // last burn day in the month
}

type RGB = [number, number, number]
type RGBA = [number, number, number, number]

// ---------- NDVI colors ----------
// [NDVI, color] - brown (bare / burned) -> yellow -> green (dense vegetation)
export const NDVI_STOPS: [number, RGB][] = [
  [-0.2, [120, 85, 60]],
  [0.1, [190, 150, 95]],
  [0.3, [235, 220, 130]],
  [0.5, [150, 200, 90]],
  [0.7, [60, 150, 60]],
  [0.9, [10, 85, 30]],
]

// Lookup table for every raw value -2000..10000 so coloring a tile is just an array lookup
const LUT_MIN = -2000
const LUT_MAX = 10000
const LUT: Uint8Array = (() => {
  const lut = new Uint8Array((LUT_MAX - LUT_MIN + 1) * 3)
  for (let raw = LUT_MIN; raw <= LUT_MAX; raw++) {
    const v = raw * SCALE
    let i = 1
    while (i < NDVI_STOPS.length - 1 && v > NDVI_STOPS[i][0]) i++
    const [v0, c0] = NDVI_STOPS[i - 1]
    const [v1, c1] = NDVI_STOPS[i]
    const t = Math.min(1, Math.max(0, (v - v0) / (v1 - v0)))
    for (let k = 0; k < 3; k++) lut[(raw - LUT_MIN) * 3 + k] = c0[k] + (c1[k] - c0[k]) * t
  }
  return lut
})()

// ---------- helpers ----------
const R = 6378137
const mercX = (lon: number): number => ((lon * Math.PI) / 180) * R
const mercY = (lat: number): number => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))

// Open each COG once and reuse it (geotiff.js only downloads the byte ranges it needs)
const tiffCache = new Map<string, Promise<GeoTIFF>>()
function openTiff(url: string): Promise<GeoTIFF> {
  let p = tiffCache.get(url)
  if (!p) {
    p = fromUrl(url, { allowFullFile: false })
    p.catch(() => tiffCache.delete(url)) // allow retry after a network error
    tiffCache.set(url, p)
  }
  return p
}

interface NdviTile {
  image: ImageBitmap
  values: ArrayLike<number> // raw int16 values, kept for hover lookups
}

interface GeoBBox {
  west: number
  south: number
  east: number
  north: number
}

// Read one map tile's worth of NDVI from the COG and turn it into a colored image
async function loadNdviTile(url: string, bbox: GeoBBox, signal?: AbortSignal): Promise<NdviTile | null> {
  const tiff = await openTiff(url)
  const image = await tiff.getImage()
  const [ix0, iy0, ix1, iy1] = image.getBoundingBox() // Web Mercator metres

  const x0 = mercX(bbox.west)
  const x1 = mercX(bbox.east)
  const y0 = mercY(bbox.south)
  const y1 = mercY(bbox.north)
  if (x1 <= ix0 || x0 >= ix1 || y1 <= iy0 || y0 >= iy1) return null // tile outside the data

  // geotiff.js picks the right overview level for this zoom automatically
  const rasters = await tiff.readRasters({
    bbox: [x0, y0, x1, y1],
    width: TILE,
    height: TILE,
    samples: [0],
    fillValue: NODATA,
    signal,
  })
  const values = rasters[0] as unknown as ArrayLike<number>

  const rgba = new Uint8ClampedArray(TILE * TILE * 4)
  let any = false
  for (let i = 0; i < values.length; i++) {
    const raw = values[i]
    if (raw === NODATA || raw < LUT_MIN || raw > LUT_MAX) continue // stays transparent
    const j = (raw - LUT_MIN) * 3
    rgba[i * 4] = LUT[j]
    rgba[i * 4 + 1] = LUT[j + 1]
    rgba[i * 4 + 2] = LUT[j + 2]
    rgba[i * 4 + 3] = 255
    any = true
  }
  if (!any) return null

  return { image: await createImageBitmap(new ImageData(rgba, TILE, TILE)), values }
}

// ---------- NDVI layer ----------
export function makeNdviLayer({
  file,
  opacity = 0.8,
  maxZoom = 7,
}: {
  file: string
  opacity?: number
  maxZoom?: number
}) {
  const url = `${DATA_URL}/ndvi/${file}`
  return new TileLayer<NdviTile | null>({
    id: `ndvi-${file}`,
    data: url,
    tileSize: TILE,
    minZoom: 0,
    maxZoom, // beyond this, deck.gl just enlarges the zoom-7 tiles (data is 1 km anyway)
    opacity,
    pickable: true,
    maxRequests: 12,
    getTileData: ({ bbox, signal }) => {
      if (!('west' in bbox)) return null // only geographic tiles are used here
      return loadNdviTile(url, bbox, signal)
    },
    renderSubLayers: (props) => {
      const { data, tile, ...rest } = props
      if (!data) return null
      const { west, south, east, north } = tile.bbox as GeoBBox
      return new BitmapLayer(rest, {
        image: data.image,
        bounds: [west, south, east, north],
      })
    },
  })
}

// NDVI value under the cursor (from the tile's raw values), or null
export function ndviFromPick(info: PickingInfo): number | null {
  const pick = info as TileLayerPickingInfo<NdviTile | null, BitmapLayerPickingInfo>
  const content = (pick.sourceTile ?? pick.tile)?.content
  if (!content || !pick.bitmap) return null
  const [px, py] = pick.bitmap.pixel
  const raw = content.values[Math.floor(py) * TILE + Math.floor(px)]
  return raw === undefined || raw === NODATA ? null : raw * SCALE
}

// ---------- burned-area layer ----------
interface BurnFeature {
  type: 'Feature'
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown }
  properties: BurnProps
}
interface BurnCollection {
  type: 'FeatureCollection'
  features: BurnFeature[]
}

const burnCache = new Map<string, Promise<BurnCollection>>()

// Load one month of burned-area outlines (cached, so moving the slider back is instant)
export function loadBurn(file: string): Promise<BurnCollection> {
  let p = burnCache.get(file)
  if (!p) {
    p = fetch(`${DATA_URL}/burn/${file}`).then((r) => {
      if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`)
      return r.json() as Promise<BurnCollection>
    })
    p.catch(() => burnCache.delete(file))
    burnCache.set(file, p)
  }
  return p
}

export const BURN_LINE: RGBA = [200, 20, 20, 235]
export const BURN_FILL: RGBA = [230, 60, 30, 45]

export function makeBurnLayer({ data, opacity = 1 }: { data: BurnCollection; opacity?: number }) {
  return new GeoJsonLayer({
    id: 'burn',
    data: data as never, // our own GeoJSON types; deck.gl only needs standard GeoJSON
    opacity,
    pickable: true,
    stroked: true,
    filled: true,
    getFillColor: BURN_FILL,
    getLineColor: BURN_LINE,
    getLineWidth: 1.5,
    lineWidthUnits: 'pixels',
    autoHighlight: true,
    highlightColor: [255, 200, 0, 120],
  })
}

// ---------- statistics data ----------
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return r.json() as Promise<T>
}

export const loadSeason = () => getJson<import('./statsLib').SeasonData>(SEASON_URL)
export const loadDefaultPoints = () => getJson<import('./statsLib').Points>(DEFAULT_POINTS_URL)
