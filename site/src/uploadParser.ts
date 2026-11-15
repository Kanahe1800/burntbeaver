// Read an occurrence CSV/TSV of ANY animal (GBIF download, iNaturalist export, field data ...) in the browser.
// Same cleaning as animal_cells.py: detect columns, year from eventDate if needed, keep records since 2015,
// drop missing / 0,0 coordinates and records less precise than 5 km.
import Papa from 'papaparse'
import type { Points } from './statsLib'

const LAT = ['decimallatitude', 'latitude', 'lat']
const LON = ['decimallongitude', 'longitude', 'lon', 'lng', 'long']
const YEAR = ['year']
const DATE = ['eventdate', 'observed_on', 'date', 'datetime']
const UNC = ['coordinateuncertaintyinmeters', 'positional_accuracy']
const SPECIES = ['species', 'scientificname', 'scientific_name', 'taxon_name', 'common_name']

export const SINCE_YEAR = 2015
const MAX_UNCERTAINTY_M = 5000

export interface UploadResult {
  points: Points
  rowsRead: number
  kept: number
  name: string            // most common species name, or the file name
}

const pick = (fields: string[], names: string[]) => {
  const lower = new Map(fields.map((f) => [f.trim().toLowerCase(), f]))
  for (const n of names) if (lower.has(n)) return lower.get(n)
  return undefined
}

export async function parseOccurrences(file: File, onProgress?: (rows: number) => void): Promise<UploadResult> {
  // GBIF downloads are tab-separated and unquoted: a stray " in a text field must not break parsing
  const head = await file.slice(0, 20000).text()
  const firstLine = head.split('\n')[0]
  const tab = (firstLine.match(/\t/g) ?? []).length > (firstLine.match(/,/g) ?? []).length

  return new Promise((resolve, reject) => {
    const lat: number[] = [], lon: number[] = [], year: number[] = []
    const species = new Map<string, number>()
    let rowsRead = 0
    let cols: { lat?: string; lon?: string; year?: string; date?: string; unc?: string; sp?: string } | null = null

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      chunkSize: 1024 * 1024 * 2,   // stream 2 MB at a time so the page stays responsive
      delimiter: tab ? '\t' : '',
      quoteChar: tab ? '\u0000' : '"',
      chunk: (res, parser) => {
        if (!cols) {
          const f = res.meta.fields ?? []
          cols = { lat: pick(f, LAT), lon: pick(f, LON), year: pick(f, YEAR), date: pick(f, DATE),
                   unc: pick(f, UNC), sp: pick(f, SPECIES) }
          if (!cols.lat || !cols.lon) {
            parser.abort()
            reject(new Error(`No latitude/longitude columns found. Columns are: ${f.slice(0, 12).join(', ')}`))
            return
          }
        }
        for (const r of res.data) {
          rowsRead++
          const la = Number(r[cols.lat!]), lo = Number(r[cols.lon!])
          if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) continue
          if (la === 0 && lo === 0) continue
          if (cols.unc) {
            const u = Number(r[cols.unc])
            if (r[cols.unc] !== '' && Number.isFinite(u) && u > MAX_UNCERTAINTY_M) continue
          }
          let y = cols.year ? Number(r[cols.year]) : NaN
          if (!Number.isFinite(y) && cols.date) y = Number((r[cols.date] ?? '').slice(0, 4))
          if (Number.isFinite(y) && y > 0 && y < SINCE_YEAR) continue
          lat.push(la); lon.push(lo); year.push(Number.isFinite(y) ? y : 0)
          if (cols.sp && r[cols.sp]) species.set(r[cols.sp], (species.get(r[cols.sp]) ?? 0) + 1)
        }
        onProgress?.(rowsRead)
      },
      complete: () => {
        const top = [...species.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
        const name = top ?? file.name.replace(/\.(csv|tsv|txt)$/i, '')
        resolve({ points: { name, lat, lon, year }, rowsRead, kept: lat.length, name })
      },
      error: (err) => reject(err),
    })
  })
}
