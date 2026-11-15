// Two small SVG charts for the results section (no chart library needed)
import type { OddsResult, RecoveryResult } from './statsLib'
import { verdict } from './statsLib'

const C = { ink: '#1f2a24', muted: '#6b736d', grid: '#e4ded3', lower: '#2f6b4f', higher: '#c4532b', unclear: '#9a948a',
            withRec: '#8a5a2b', withoutRec: '#7f8a84' }

// ------------------------------------------------------------- forest plot (one row per fire season)
export function ForestPlot({ rows, pooled }: { rows: OddsResult[]; pooled: OddsResult }) {
  const all = [...rows, pooled].filter((r) => Number.isFinite(r.or))
  const W = 640, rowH = 34, left = 120, right = 150, top = 26
  const H = top + (rows.length + 1) * rowH + 34
  const lo = Math.min(0.25, ...all.map((r) => r.lo)), hi = Math.max(4, ...all.map((r) => r.hi))
  const x = (v: number) => left + ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (W - left - right)
  const ticks = [0.25, 0.5, 1, 2, 4].filter((t) => t >= lo && t <= hi)
  const color = (r: OddsResult) => C[verdict(r)]

  const Row = ({ r, i, bold }: { r: OddsResult; i: number; bold?: boolean }) => {
    const y = top + i * rowH + rowH / 2
    if (!Number.isFinite(r.or)) {
      return <text x={left} y={y + 4} fontSize={12} fill={C.muted}>{r.label}: not enough burned areas</text>
    }
    return (
      <g>
        <text x={left - 12} y={y + 4} textAnchor="end" fontSize={13} fontWeight={bold ? 700 : 400} fill={C.ink}>{r.label}</text>
        <line x1={x(Math.max(r.lo, lo))} x2={x(Math.min(r.hi, hi))} y1={y} y2={y} stroke={color(r)} strokeWidth={3} strokeLinecap="round" />
        {bold
          ? <rect x={x(r.or) - 7} y={y - 7} width={14} height={14} transform={`rotate(45 ${x(r.or)} ${y})`} fill={color(r)} />
          : <circle cx={x(r.or)} cy={y} r={6} fill={color(r)} />}
        <text x={W - right + 14} y={y + 4} fontSize={12} fill={C.ink}>
          {r.or.toFixed(2)} <tspan fill={C.muted}>({r.lo.toFixed(2)}–{r.hi.toFixed(2)})</tspan>
        </text>
      </g>
    )
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Odds ratio for each fire season">
      <text x={W - right + 14} y={14} fontSize={11} fill={C.muted}>odds ratio (range)</text>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={top - 6} y2={H - 30} stroke={t === 1 ? C.ink : C.grid} strokeDasharray={t === 1 ? '4 3' : undefined} />
          <text x={x(t)} y={H - 14} textAnchor="middle" fontSize={11} fill={C.muted}>{t}</text>
        </g>
      ))}
      <text x={x(lo) + 2} y={top - 10} fontSize={11} fill={C.lower}>← burned less often</text>
      <text x={x(hi) - 2} y={top - 10} textAnchor="end" fontSize={11} fill={C.higher}>burned more often →</text>
      {rows.map((r, i) => <Row key={r.label} r={r} i={i} />)}
      <line x1={left - 100} x2={W - 10} y1={top + rows.length * rowH + 2} y2={top + rows.length * rowH + 2} stroke={C.grid} />
      <Row r={pooled} i={rows.length} bold />
    </svg>
  )
}

// ------------------------------------------------------------- recovery chart (two lines)
export function RecoveryChart({ rec, name }: { rec: RecoveryResult; name: string }) {
  const W = 640, H = 300, L = 52, R = 20, T = 20, B = 44
  const maxK = Math.max(1, ...rec.years.filter((_, i) => rec.withRec[i] !== null || rec.withoutRec[i] !== null))
  const vals = [...rec.withRec, ...rec.withoutRec].filter((v): v is number => v !== null)
  const yMin = Math.min(0, ...vals) - 0.1, yMax = Math.max(1.2, ...vals) + 0.05
  const x = (k: number) => L + (k / maxK) * (W - L - R)
  const y = (v: number) => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B)
  const path = (s: (number | null)[]) =>
    s.map((v, k) => (v === null || k > maxK ? '' : `${x(k)},${y(v)}`)).filter(Boolean).join(' ')
  const yTicks = [0, 0.25, 0.5, 0.75, 1].filter((t) => t >= yMin && t <= yMax)

  const Line = ({ s, color, dash }: { s: (number | null)[]; color: string; dash?: string }) => (
    <g>
      <polyline points={path(s)} fill="none" stroke={color} strokeWidth={3} strokeDasharray={dash} strokeLinejoin="round" />
      {s.map((v, k) => (v === null || k > maxK ? null : <circle key={k} cx={x(k)} cy={y(v)} r={4} fill={color} />))}
    </g>
  )

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Vegetation recovery after fire">
      {yTicks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={t === 1 ? C.ink : C.grid} strokeDasharray={t === 1 ? '4 3' : undefined} />
          <text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill={C.muted}>{Math.round(t * 100)}%</text>
        </g>
      ))}
      <text x={W - R} y={y(1) - 6} textAnchor="end" fontSize={11} fill={C.ink}>back to normal</text>
      {rec.years.filter((k) => k <= maxK).map((k) => (
        <text key={k} x={x(k)} y={H - B + 18} textAnchor="middle" fontSize={11} fill={C.muted}>{k}</text>
      ))}
      <text x={(L + W - R) / 2} y={H - 6} textAnchor="middle" fontSize={12} fill={C.muted}>years after the fire</text>
      <Line s={rec.withoutRec} color={C.withoutRec} dash="6 4" />
      <Line s={rec.withRec} color={C.withRec} />
      <g transform={`translate(${L + 12}, ${T + 6})`} fontSize={12}>
        <line x1={0} x2={22} y1={0} y2={0} stroke={C.withRec} strokeWidth={3} />
        <text x={28} y={4} fill={C.ink}>areas with {name} records</text>
        <line x1={0} x2={22} y1={20} y2={20} stroke={C.withoutRec} strokeWidth={3} strokeDasharray="6 4" />
        <text x={28} y={24} fill={C.ink}>areas without</text>
      </g>
    </svg>
  )
}
