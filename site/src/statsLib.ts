// Statistics computed in the browser, so results update for ANY uploaded animal.
//
// Data: grid/<size>/season.json from prep_web_stats.py (per area and year: burned share and August NDVI).
// Methods (simplified, explainable versions of the notebooks):
//   1. Fire: Mantel-Haenszel odds ratio - "did areas with records burn less often than areas WITHOUT records
//      in the same region and with similar vegetation?" - per fire season and pooled over all seasons.
//   2. Recovery: for areas whose first big fire was 2017-2023, how much of the fire's August-NDVI drop has come
//      back each year, compared with never-burned areas at the same latitude (removes good/bad growing years).

// ---------------------------------------------------------------- data
export interface SeasonData {
  grid: { cell_size_m: number; origin_x: number; origin_y_top: number; width: number; height: number }
  scale: number
  missing: number
  burn_years: number[]
  ndvi_years: number[]
  cells: { row: number[]; col: number[]; lat: number[]; lon: number[]; land_frac: number[] }
  burn: Record<string, number[]>
  burn_early: Record<string, number[]>
  ndvi: Record<string, number[]>
  default_animal: { name: string; counts: number[] }
}

export interface Points {
  name: string
  lat: number[]
  lon: number[]
  year: number[]
}

// ---------------------------------------------------------------- settings (same as the notebooks)
export const SETTINGS = {
  BLOCK_KM: 500,       // "region" = 500 km square
  MIN_NDVI_PRE: 0.3,   // skip bare / sparsely vegetated areas
  MIN_BURN: 0.01,      // an area "burned" if >= 1 % of its land burned in the season
  COHORT_BURN: 0.10,   // recovery: a "big fire" burned >= 10 % of the area
  CLEAN: 0.005,        // "no fire" = < 0.5 % burned
  REBURN: 0.05,        // recovery series stops when >= 5 % burns again
  MIN_DROP: 0.01,      // recovery: skip areas whose NDVI barely dropped
  FIRE_YEARS: [2017, 2023] as [number, number],
  MAX_YEARS: 8,
  LAT_BAND: 2,
}

// ---------------------------------------------------------------- North America Albers (ESRI:102008)
const A = 6378137.0
const F = 1 / 298.257222101
const E2 = F * (2 - F)
const E = Math.sqrt(E2)
const rad = (d: number) => (d * Math.PI) / 180
const q = (phi: number) => {
  const s = Math.sin(phi)
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)))
}
const m = (phi: number) => Math.cos(phi) / Math.sqrt(1 - E2 * Math.sin(phi) ** 2)
const M1 = m(rad(20)), M2 = m(rad(60))
const N = (M1 ** 2 - M2 ** 2) / (q(rad(60)) - q(rad(20)))
const C = M1 ** 2 + N * q(rad(20))
const RHO0 = (A * Math.sqrt(C - N * q(rad(40)))) / N

export function albers(lon: number, lat: number): [number, number] {
  const dlon = ((((lon + 96 + 180) % 360) + 360) % 360) - 180
  const rho = (A * Math.sqrt(C - N * q(rad(lat)))) / N
  const theta = N * rad(dlon)
  return [rho * Math.sin(theta), RHO0 - rho * Math.cos(theta)]
}

/** Count records per area (index into data.cells). Points outside the land areas are ignored. */
export function countPerCell(data: SeasonData, pts: { lat: number[]; lon: number[] }): Int32Array {
  const g = data.grid
  const index = new Map<number, number>()
  data.cells.row.forEach((r, i) => index.set(r * g.width + data.cells.col[i], i))
  const counts = new Int32Array(data.cells.row.length)
  for (let k = 0; k < pts.lat.length; k++) {
    const [x, y] = albers(pts.lon[k], pts.lat[k])
    const col = Math.floor((x - g.origin_x) / g.cell_size_m)
    const row = Math.floor((g.origin_y_top - y) / g.cell_size_m)
    if (col < 0 || row < 0 || col >= g.width || row >= g.height) continue
    const i = index.get(row * g.width + col)
    if (i !== undefined) counts[i]++
  }
  return counts
}

// ---------------------------------------------------------------- helpers
const val = (data: SeasonData, arr: number[] | undefined, i: number) =>
  !arr || arr[i] === data.missing ? NaN : arr[i] / data.scale

function median(a: number[]): number {
  if (!a.length) return NaN
  const s = [...a].sort((x, y) => x - y)
  const h = s.length >> 1
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2
}

function regionOf(data: SeasonData, i: number): number {
  const km = data.grid.cell_size_m / 1000
  return Math.floor((data.cells.row[i] * km) / SETTINGS.BLOCK_KM) * 10000 +
    Math.floor((data.cells.col[i] * km) / SETTINGS.BLOCK_KM)
}

// ---------------------------------------------------------------- 1. fire: Mantel-Haenszel odds ratio
export interface OddsResult {
  label: string
  or: number          // within region + vegetation (Mantel-Haenszel)
  lo: number
  hi: number
  crudeOr: number     // simple comparison, all areas together
  pctWith: number     // % of areas with records that burned
  pctWithout: number
  nWith: number
  nWithout: number
  burned: number
}

interface Table { a: number; b: number; c: number; d: number }   // a: rec+burned, b: rec+not, c: no rec+burned, d: no rec+not

function mantelHaenszel(tables: Iterable<Table>) {
  let R = 0, S = 0, PR = 0, PSQR = 0, QS = 0
  for (const { a, b, c, d } of tables) {
    const n = a + b + c + d
    if (n < 2) continue
    const r = (a * d) / n, s = (b * c) / n
    const p = (a + d) / n, qq = (b + c) / n
    R += r; S += s; PR += p * r; PSQR += p * s + qq * r; QS += qq * s
  }
  if (R === 0 || S === 0) return { or: NaN, lo: NaN, hi: NaN }
  const or = R / S
  const v = PR / (2 * R * R) + PSQR / (2 * R * S) + QS / (2 * S * S)   // Robins-Breslow-Greenland
  const se = Math.sqrt(v)
  return { or, lo: Math.exp(Math.log(or) - 1.96 * se), hi: Math.exp(Math.log(or) + 1.96 * se) }
}

function tercileCuts(values: number[]): [number, number] {
  const s = values.filter(Number.isFinite).sort((x, y) => x - y)
  return [s[Math.floor(s.length / 3)], s[Math.floor((2 * s.length) / 3)]]
}

export function fireAnalysis(data: SeasonData, counts: Int32Array): { seasons: OddsResult[]; pooled: OddsResult } {
  const n = counts.length
  const region = Array.from({ length: n }, (_, i) => regionOf(data, i))
  const seasons: OddsResult[] = []
  const pooledTables = new Map<string, Table>()
  const pooledCrude: Table = { a: 0, b: 0, c: 0, d: 0 }

  for (const Y of data.burn_years) {
    const pre = data.ndvi[String(Y - 1)]
    if (!pre) continue
    const burnY = data.burn[String(Y)]
    const pres: number[] = []
    for (let i = 0; i < n; i++) pres.push(val(data, pre, i))
    const [t1, t2] = tercileCuts(pres.filter((v) => v >= SETTINGS.MIN_NDVI_PRE))
    const tables = new Map<string, Table>()
    const crude: Table = { a: 0, b: 0, c: 0, d: 0 }
    for (let i = 0; i < n; i++) {
      const p = pres[i]
      if (!(p >= SETTINGS.MIN_NDVI_PRE)) continue
      const veg = p < t1 ? 0 : p < t2 ? 1 : 2
      const key = `${region[i]}_${veg}`
      const burned = burnY[i] / data.scale >= SETTINGS.MIN_BURN
      const rec = counts[i] > 0
      const cell = rec ? (burned ? "a" : "b") : burned ? "c" : "d"
      for (const [map, k] of [[tables, key], [pooledTables, `${Y}_${key}`]] as const) {
        const t = map.get(k) ?? { a: 0, b: 0, c: 0, d: 0 }
        t[cell]++
        map.set(k, t)
      }
      crude[cell]++
      pooledCrude[cell]++
    }
    seasons.push(summarise(String(Y), tables.values(), crude))
  }
  return { seasons, pooled: summarise("All seasons", pooledTables.values(), pooledCrude) }
}

function summarise(label: string, tables: Iterable<Table>, t: Table): OddsResult {
  const mh = mantelHaenszel(tables)
  return {
    label, ...mh,
    crudeOr: (t.a * t.d) / (t.b * t.c),
    pctWith: (100 * t.a) / (t.a + t.b),
    pctWithout: (100 * t.c) / (t.c + t.d),
    nWith: t.a + t.b,
    nWithout: t.c + t.d,
    burned: t.a + t.c,
  }
}

// ---------------------------------------------------------------- 2. recovery curves
export interface RecoveryResult {
  years: number[]                     // years since fire: 0..MAX
  withRec: (number | null)[]          // median recovery (0 = right after fire, 1 = back to before)
  withoutRec: (number | null)[]
  nWith: number[]
  nWithout: number[]
  areasWith: number
  areasWithout: number
}

export function recoveryAnalysis(data: SeasonData, counts: Int32Array): RecoveryResult {
  const n = counts.length
  const yearsB = data.burn_years
  const S = (y: number, i: number) => (data.burn[String(y)] ? data.burn[String(y)][i] / data.scale : NaN)
  const ND = (y: number, i: number) => val(data, data.ndvi[String(y)], i)
  const band = data.cells.lat.map((l) => Math.floor(l / SETTINGS.LAT_BAND))
  const never: number[] = []
  for (let i = 0; i < n; i++) if (yearsB.every((y) => S(y, i) < SETTINGS.CLEAN)) never.push(i)

  const rr: Map<number, { w: number[]; wo: number[] }> = new Map()
  for (let k = 0; k <= SETTINGS.MAX_YEARS; k++) rr.set(k, { w: [], wo: [] })
  const assigned = new Uint8Array(n)
  const burnedBefore = new Uint8Array(n)
  let areasWith = 0, areasWithout = 0

  for (const Y of yearsB) {
    const inRange = Y >= SETTINGS.FIRE_YEARS[0] && Y <= SETTINGS.FIRE_YEARS[1]
    if (inRange && data.ndvi[String(Y - 1)] && data.ndvi[String(Y - 2)]) {
      // reference: normal NDVI change of never-burned areas at the same latitude, per later year
      const refBase = new Map<number, number>()
      for (const i of never) refBase.set(i, (ND(Y - 2, i) + ND(Y - 1, i)) / 2)
      const refCache = new Map<number, Map<number, number>>()
      const ref = (yr: number, b: number) => {
        let byBand = refCache.get(yr)
        if (!byBand) {
          const groups = new Map<number, number[]>()
          for (const i of never) {
            const v = ND(yr, i) - (refBase.get(i) as number)
            if (Number.isFinite(v)) (groups.get(band[i]) ?? groups.set(band[i], []).get(band[i])!).push(v)
          }
          byBand = new Map([...groups].map(([bb, vs]) => [bb, median(vs)]))
          refCache.set(yr, byBand)
        }
        return byBand.get(b) ?? NaN
      }

      for (let i = 0; i < n; i++) {
        if (assigned[i] || burnedBefore[i] || !(S(Y, i) >= SETTINGS.COHORT_BURN)) continue
        const base = (ND(Y - 2, i) + ND(Y - 1, i)) / 2
        if (!Number.isFinite(base)) continue
        assigned[i] = 1
        const t0 = data.burn_early[String(Y)][i] / data.scale >= 0.5 * S(Y, i) ? Y : Y + 1
        let drop = NaN
        const series: [number, number][] = []
        for (let yr = t0; yr <= t0 + SETTINGS.MAX_YEARS; yr++) {
          if (yr > Y && yearsB.includes(yr) && S(yr, i) >= SETTINGS.REBURN) break   // burned again
          const anom = ND(yr, i) - base - ref(yr, band[i])
          if (!Number.isFinite(anom)) continue
          if (yr === t0) drop = -anom
          series.push([yr - t0, anom])
        }
        if (!(drop >= SETTINGS.MIN_DROP) || series.length < 2) continue
        const g = counts[i] > 0 ? "w" : "wo"
        g === "w" ? areasWith++ : areasWithout++
        for (const [k, anom] of series) rr.get(k)![g].push(1 + anom / drop)
      }
    }
    for (let i = 0; i < n; i++) if (S(Y, i) >= SETTINGS.CLEAN) burnedBefore[i] = 1
  }

  const years = [...rr.keys()]
  const med = (xs: number[]) => (xs.length >= 10 ? median(xs) : null)   // hide years with < 10 areas
  return {
    years,
    withRec: years.map((k) => med(rr.get(k)!.w)),
    withoutRec: years.map((k) => med(rr.get(k)!.wo)),
    nWith: years.map((k) => rr.get(k)!.w.length),
    nWithout: years.map((k) => rr.get(k)!.wo.length),
    areasWith, areasWithout,
  }
}

// ---------------------------------------------------------------- plain-language verdicts
export type Verdict = "lower" | "higher" | "unclear"

export function verdict(r: { or: number; lo: number; hi: number }): Verdict {
  if (!Number.isFinite(r.or)) return "unclear"
  if (r.hi < 1) return "lower"
  if (r.lo > 1) return "higher"
  return "unclear"
}

/** "34 % lower" / "12 % higher" from an odds ratio */
export function pctChange(or: number): string {
  if (!Number.isFinite(or)) return "–"
  const p = Math.round(Math.abs(1 - or) * 100)
  return or < 1 ? `${p}% lower` : `${p}% higher`
}
