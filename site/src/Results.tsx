// Results section: the statistics for the current animal, explained in plain language
import { useEffect, useState } from 'react'
import type { SeasonData, Points, OddsResult, RecoveryResult } from './statsLib'
import { countPerCell, fireAnalysis, recoveryAnalysis, verdict, pctChange, SETTINGS } from './statsLib'
import { ForestPlot, RecoveryChart } from './charts'

interface Analysis {
  areas: number
  areasWithRecords: number
  fire: { seasons: OddsResult[]; pooled: OddsResult }
  rec: RecoveryResult
}

function useAnalysis(season: SeasonData | null, points: Points | null) {
  const [result, setResult] = useState<Analysis | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!season || !points) return
    setBusy(true)
    // let the "calculating" message paint first; the maths takes about half a second
    const t = setTimeout(() => {
      const counts = countPerCell(season, points)
      let withRec = 0
      for (const c of counts) if (c > 0) withRec++
      setResult({ areas: counts.length, areasWithRecords: withRec,
                  fire: fireAnalysis(season, counts), rec: recoveryAnalysis(season, counts) })
      setBusy(false)
    }, 30)
    return () => clearTimeout(t)
  }, [season, points])
  return { result, busy }
}

const pct = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`
const fmt = (v: number) => v.toLocaleString()

const TAG = {
  lower: { text: 'Clear pattern: burned less', cls: 'tag tag--lower' },
  higher: { text: 'Clear pattern: burned more', cls: 'tag tag--higher' },
  unclear: { text: 'No clear pattern', cls: 'tag tag--unclear' },
}

function recoveryAt(rec: RecoveryResult, k: number) {
  const w = rec.withRec[k], wo = rec.withoutRec[k]
  return w === null || wo === null || w === undefined || wo === undefined ? null : { w, wo }
}

function recoverySentence(rec: RecoveryResult, name: string) {
  const k = [5, 4, 3].find((y) => recoveryAt(rec, y))
  if (k === undefined) return { k: null, text: `Not enough burned areas with ${name} records to compare recovery.` }
  const { w, wo } = recoveryAt(rec, k)!
  const diff = Math.round((w - wo) * 100)
  if (Math.abs(diff) < 10) {
    return { k, text: `${k} years after a fire, both groups had recovered about the same amount (${pct(w * 100)} vs ${pct(wo * 100)}).` }
  }
  return { k, text: `${k} years after a fire, areas with ${name} records had recovered ${pct(w * 100)} of their lost greenness, vs ${pct(wo * 100)} elsewhere.` }
}

export default function Results({ season, points, error }: { season: SeasonData | null; points: Points | null; error?: string }) {
  const { result, busy } = useAnalysis(season, points)
  const name = points?.name ?? 'animal'

  if (error) return <section className="results"><div className="card card--warn">{error}</div></section>
  if (!result) return <section className="results"><div className="card">Calculating the statistics…</div></section>

  const { fire, rec } = result
  const p = fire.pooled
  const v = verdict(p)
  const sameWay = fire.seasons.filter((s) => Number.isFinite(s.or) && verdict(s) === v && v !== 'unclear').length
  const lowerSeasons = fire.seasons.filter((s) => s.or < 1).length
  const valid = fire.seasons.filter((s) => Number.isFinite(s.or)).length
  const r = recoverySentence(rec, name)

  return (
    <section className={`results ${busy ? 'results--busy' : ''}`} id="results">
      <div className="section-head">
        <span className="eyebrow">Results</span>
        <h2>Do fires behave differently where <em>{name}</em> is found?</h2>
        <p className="lede">
          We split North America into {fmt(result.areas)} squares of 25 × 25 km.{' '}
          <strong>{fmt(result.areasWithRecords)}</strong> of them have at least one {name} record since 2015
          ({fmt(points?.lat.length ?? 0)} records in total). Every number below compares those squares with the rest.
        </p>
      </div>

      {/* ---------------- key findings */}
      <div className="findings">
        <article className="finding">
          <span className={TAG[v].cls}>{TAG[v].text}</span>
          <h3>Chance of burning</h3>
          <p className="big">
            {v === 'unclear' ? 'About the same' : pctChange(p.or)}
          </p>
          <p>
            {v === 'unclear'
              ? `Squares with ${name} records were not clearly more or less likely to burn than similar squares nearby.`
              : `The odds that a square burned were ${pctChange(p.or)} where ${name} was recorded, compared with similar squares in the same region.`}
          </p>
        </article>

        <article className="finding">
          <span className="tag tag--plain">Raw numbers</span>
          <h3>How often squares burned</h3>
          <div className="bars">
            <div className="bar"><span>with {name}</span><div><i style={{ width: `${Math.min(100, (p.pctWith / Math.max(p.pctWith, p.pctWithout, 0.1)) * 100)}%` }} className="bar--with" /></div><b>{pct(p.pctWith)}</b></div>
            <div className="bar"><span>without</span><div><i style={{ width: `${Math.min(100, (p.pctWithout / Math.max(p.pctWith, p.pctWithout, 0.1)) * 100)}%` }} className="bar--without" /></div><b>{pct(p.pctWithout)}</b></div>
          </div>
          <p>Share of squares where at least 1% of the land burned in a fire season (April–October), all seasons together.</p>
        </article>

        <article className="finding">
          <span className="tag tag--plain">Consistency</span>
          <h3>Year after year</h3>
          <p className="big">{lowerSeasons} of {valid}</p>
          <p>
            fire seasons point to <em>less</em> burning near {name}.{' '}
            {v !== 'unclear' && <>In {sameWay} of them the pattern is clear on its own. </>}
            A pattern that repeats every year is more trustworthy than one good year.
          </p>
        </article>

        <article className="finding">
          <span className="tag tag--plain">Recovery</span>
          <h3>Greening up after fire</h3>
          <p className="big">{r.k ? `${r.k} years later` : '–'}</p>
          <p>{r.text}</p>
        </article>
      </div>

      {/* ---------------- forest plot */}
      <div className="card chart-card">
        <div className="chart-text">
          <h3>Season by season</h3>
          <p>
            Each dot is one fire season. A dot <b>left of the dashed line</b> means squares with {name} records burned
            less often than similar squares; <b>right</b> means more often. The bar shows the range the true value is
            probably in (95% confidence). If the bar <b>crosses the dashed line</b>, that season alone can't tell us
            anything for sure. The diamond combines all seasons.
          </p>
          <p className="small">
            A simple comparison of all squares gives an odds ratio of {p.crudeOr.toFixed(2)}. After comparing only squares
            in the same {SETTINGS.BLOCK_KM} km region with similar vegetation, it becomes {p.or.toFixed(2)}.
            {Math.abs(Math.log(p.crudeOr) - Math.log(p.or)) > 0.15 && ' The big change shows why a fair comparison matters: part of the simple difference was just geography.'}
          </p>
        </div>
        <ForestPlot rows={fire.seasons} pooled={p} />
      </div>

      {/* ---------------- recovery */}
      <div className="card chart-card">
        <div className="chart-text">
          <h3>How fast does the green come back?</h3>
          <p>
            We follow squares after a big fire (≥ 10% burned) using NDVI, a satellite measure of how green plants are.
            <b> 0%</b> means as brown as right after the fire, <b>100%</b> means back to how green it was before.
            We also subtract normal year-to-year weather changes using unburned squares at the same latitude.
          </p>
          <p className="small">
            Squares followed: {fmt(rec.areasWith)} with {name} records, {fmt(rec.areasWithout)} without.
            Years with fewer than 10 squares are not drawn.
            {rec.areasWith < 30 && ` With so few squares near ${name}, treat this line as a rough sketch.`}
          </p>
        </div>
        <RecoveryChart rec={rec} name={name} />
      </div>

      {/* ---------------- how to read */}
      <div className="section-head">
        <span className="eyebrow">Explained</span>
        <h2>How to read these results</h2>
      </div>
      <div className="explain">
        <article>
          <h4>1. What is an "odds ratio"?</h4>
          <p>
            Odds compare "burned" to "didn't burn". If 1 in 10 squares burns, the odds are 1 to 9. An odds ratio divides
            the odds for one group by the odds for the other. <b>1 means no difference.</b> 0.7 means the odds were 30%
            lower; 1.5 means 50% higher.
          </p>
        </article>
        <article>
          <h4>2. Why compare "within the same region"?</h4>
          <p>
            Animals and fires both live in some places more than others. Beavers are common in wet eastern forests, and
            big fires happen in dry western ones. Comparing a square in Ontario with one in California would mostly
            measure climate, not the animal. So we only compare squares that are close together and have similar plant cover.
          </p>
        </article>
        <article>
          <h4>3. What does "clear pattern" mean?</h4>
          <p>
            Random chance can make two groups look different. We call a result clear only when the whole 95% range sits on
            one side of 1. That means a difference this big would rarely appear by luck alone.
          </p>
        </article>
        <article>
          <h4>4. Pattern ≠ cause</h4>
          <p>
            Even a clear pattern doesn't prove the animal changes fire. Something else may explain both. For example,
            people report animals near towns and roads, and firefighters also protect those places first. A real
            cause needs field studies or experiments.
          </p>
        </article>
        <article>
          <h4>5. Records show where people looked</h4>
          <p>
            "No records" doesn't mean "no animals". Sightings from GBIF or iNaturalist pile up where people hike and live.
            Remote northern forests have few records even if many animals live there.
          </p>
        </article>
        <article>
          <h4>6. Bigger and smaller squares</h4>
          <p>
            The website uses 25 km squares. Our notebooks also test 10 km and 50 km. If a result only shows up at one
            size, be careful: it may depend on how the map was cut up.
          </p>
        </article>
      </div>

      {/* ---------------- try another animal */}
      <div className="card try">
        <div>
          <span className="eyebrow">Your turn</span>
          <h2>Try another animal</h2>
          <p>The same tests work for any species: moose, elk, woodpeckers, salamanders…</p>
        </div>
        <ol>
          <li>Go to <a href="https://www.gbif.org/occurrence/search" target="_blank" rel="noreferrer">GBIF</a> or <a href="https://www.inaturalist.org/observations/export" target="_blank" rel="noreferrer">iNaturalist</a> and search a species in Canada and the USA.</li>
          <li>Download the records as CSV ("simple" format on GBIF).</li>
          <li>Click <b>Upload your own CSV</b> above the map. The file stays on your computer; nothing is uploaded to a server.</li>
          <li>Read the four cards again. Ask: is the pattern clear? Does it repeat each season? Could people, roads or climate explain it?</li>
        </ol>
        <p className="small">
          The file needs latitude and longitude columns. Records before 2015, without a location, or with a location
          uncertain by more than 5 km are dropped.
        </p>
      </div>
    </section>
  )
}
