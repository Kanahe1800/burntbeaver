// Background data layers for the map: NDVI (COG rasters on R2) and fire (GeoJSON on R2).
import type { PickingInfo } from '@deck.gl/core'
import { TileLayer } from '@deck.gl/geo-layers'
import type { TileLayerPickingInfo } from '@deck.gl/geo-layers'
import { BitmapLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { BitmapLayerPickingInfo } from '@deck.gl/layers'
import { fromUrl } from 'geotiff'
import type GeoTIFF from 'geotiff'

// Where the preprocessed data lives (R2 bucket). Override with VITE_DATA_URL if needed,
// e.g. VITE_DATA_URL=/data to test with files in site/public/data/
export const DATA_URL: string = import.meta.env.VITE_DATA_URL || 'https://data.smoky-creatures.earth'
export const NDVI_MANIFEST_URL = `${DATA_URL}/ndvi/manifest.json`
export const FIRE_MANIFEST_URL = `${DATA_URL}/fire/fire_manifest.json`

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

export type FireConf = 7 | 8 | 9

export interface FireManifest {
  variable: 'fire'
  min_conf: FireConf
  bounds_lonlat: [number, number, number, number]
  files: { start: string; end: string; file: string; fire_pixels: number }[] // start = "2026-07-20"
}

export interface FirePoint {
  position: [number, number]
  start: string
  end: string
  conf: FireConf
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

// ---------- fire layer ----------
const FIRE_COLORS: Record<FireConf, RGBA> = {
  7: [255, 190, 0, 220],
  8: [255, 110, 0, 230],
  9: [210, 20, 20, 240],
}
export const FIRE_CONF_LABEL: Record<FireConf, string> = { 7: 'low', 8: 'nominal', 9: 'high' }

interface FireFeatureCollection {
  type: 'FeatureCollection'
  features: {
    geometry: { type: 'Polygon'; coordinates: [number, number][][] }
    properties: { start: string; end: string; conf: FireConf }
  }[]
}

const fireFileCache = new Map<string, Promise<FirePoint[]>>()

// Load all 8-day fire files for a month and return one point per fire pixel
export async function loadFirePoints(files: string[]): Promise<FirePoint[]> {
  const lists = await Promise.all(
    files.map((f) => {
      let p = fireFileCache.get(f)
      if (!p) {
        p = fetch(`${DATA_URL}/fire/${f}`)
          .then((r) => {
            if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`)
            return r.json() as Promise<FireFeatureCollection>
          })
          .then((gj) =>
            gj.features.map((ft): FirePoint => {
              const ring = ft.geometry.coordinates[0]
              return {
                position: [
                  (ring[0][0] + ring[1][0] + ring[2][0] + ring[3][0]) / 4,
                  (ring[0][1] + ring[1][1] + ring[2][1] + ring[3][1]) / 4,
                ],
                ...ft.properties,
              }
            }),
          )
        p.catch(() => fireFileCache.delete(f))
        fireFileCache.set(f, p)
      }
      return p
    }),
  )
  return lists.flat()
}

export function makeFireLayer({ points, opacity = 0.9 }: { points: FirePoint[]; opacity?: number }) {
  return new ScatterplotLayer<FirePoint>({
    id: 'fire',
    data: points,
    opacity,
    pickable: true,
    getPosition: (d) => d.position,
    getRadius: 500, // ~1 km pixel
    radiusUnits: 'meters',
    radiusMinPixels: 1.5, // still visible when zoomed out
    getFillColor: (d) => FIRE_COLORS[d.conf] ?? FIRE_COLORS[8],
  })
}