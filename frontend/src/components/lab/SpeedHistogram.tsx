import { useMemo, useRef, useState } from 'react';
import { CHART } from '../../lib/format';
import { useThemeName } from '../../lib/lab/palette';
import { downloadCSV } from '../../lib/export';
import { histogram, MPS_TO_MPH, percentile, spotSpeeds } from '../../lib/lab/metrics';
import type { IntersectionT } from '../../lib/traj';
import { Icon } from '../Icon';
import MetricInfo, { type MetricSpec } from '../MetricInfo';
import Select from '../Select';

const DIST = [['65', 20], ['100', 30.48], ['150', 45.72]] as const;
type Dist = (typeof DIST)[number][0];
const BIN = 5;

const SPEC: MetricSpec = {
  name: 'Approach spot speed',
  provenance: 'derived',
  formula: 'Speed of each vehicle interpolated where its trajectory crosses a line the chosen distance upstream of the intersection centre; one observation per vehicle',
  threshold: '85th-percentile speed (linear interpolation between order statistics)',
  unit: 'mph',
  source: 'FHWA NGSIM vehicle trajectories, 10 Hz, smoothed speed',
  citation: 'ITE Manual of Transportation Engineering Studies, spot speed studies',
  note: 'Includes vehicles arriving on red, so the low bins carry queue discharge; a free-flow speed study would sample upstream of signal influence.',
};

/** Spot-speed distribution on the corridor approaches, NB against SB, in 5 mph bins with 85th-percentile markers. */
export default function SpeedHistogram({ data }: { data: IntersectionT }) {
  useThemeName(); // canvas palette (CHART) is swapped in place on a theme change: re-render to pick it up
  const [dist, setDist] = useState<Dist>('100');
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const yLine = DIST.find((d) => d[0] === dist)![1];
  const s = useMemo(() => {
    const nb = spotSpeeds(data.tracks, 'NB', -yLine).map((v) => v * MPS_TO_MPH);
    const sb = spotSpeeds(data.tracks, 'SB', yLine).map((v) => v * MPS_TO_MPH);
    const top = Math.max(40, Math.ceil(Math.max(0, ...nb, ...sb) / BIN) * BIN);
    return { nb, sb, hn: histogram(nb, BIN, top), hs: histogram(sb, BIN, top), top, p85n: percentile(nb, 85), p85s: percentile(sb, 85), mn: mean(nb), ms: mean(sb) };
  }, [data, yLine]);

  const Wd = 640, Ht = 260, pad = { l: 40, r: 12, t: 30, b: 40 };
  const iw = Wd - pad.l - pad.r, ih = Ht - pad.t - pad.b;
  const maxN = Math.max(1, ...s.hn.map((b) => b.n), ...s.hs.map((b) => b.n));
  const step = [1, 2, 5, 10, 20, 50].find((k) => maxN / k <= 5) ?? 100;
  const yTop = Math.ceil(maxN / step) * step;
  const X = (mph: number) => pad.l + (mph / s.top) * iw;
  const Y = (n: number) => pad.t + ih - (n / yTop) * ih;
  const bw = (iw / s.hn.length - 6) / 2;
  const ticksY = Array.from({ length: yTop / step + 1 }, (_, i) => i * step);
  const bar = (x: number, n: number, w: number) => {
    if (!n) return '';
    const y = Y(n), h = pad.t + ih - y, r = Math.min(4, h, w / 2);
    return `M${x},${pad.t + ih}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${pad.t + ih}Z`;
  };
  const hb = hover != null ? { b: s.hn[hover], nb: s.hn[hover].n, sb: s.hs[hover].n } : null;

  return (
    <div className="spd">
      <div className="spd-bar">
        <Select<Dist> label="Spot line" icon="crosshair" value={dist} onChange={setDist}
          options={DIST.map(([k, m]) => ({ value: k, label: `${k} ft upstream`, hint: `${m.toFixed(0)} m` }))} />
        <dl className="spd-stats">
          <div><dt><i style={{ background: CHART.nb }} />NB 85th</dt><dd className="measure">{fmt(s.p85n)}<small>mph</small></dd><dd className="muted measure" title={`mean ${fmt(s.mn)} mph`}>n {s.nb.length}</dd></div>
          <div><dt><i style={{ background: CHART.sb }} />SB 85th</dt><dd className="measure">{fmt(s.p85s)}<small>mph</small></dd><dd className="muted measure" title={`mean ${fmt(s.ms)} mph`}>n {s.sb.length}</dd></div>
        </dl>
        <div className="spd-actions">
          <MetricInfo spec={SPEC} align="right" />
          <button className="btn ghost ic" title="Download CSV" aria-label="Download spot speeds as CSV" onClick={() => downloadCSV(`${data.id}-spot-speeds-${dist}ft.csv`, [
            ...s.nb.map((v) => ({ site: data.id, direction: 'NB', spot_line_ft: dist, speed_mph: v.toFixed(2) })),
            ...s.sb.map((v) => ({ site: data.id, direction: 'SB', spot_line_ft: dist, speed_mph: v.toFixed(2) })),
          ])}><Icon name="download" size={16} /></button>
        </div>
      </div>
      <div className="spd-fig">
        <svg ref={svg} viewBox={`0 0 ${Wd} ${Ht}`} role="img" aria-label={`Spot speed histogram ${dist} ft upstream: northbound n ${s.nb.length}, 85th percentile ${fmt(s.p85n)} mph; southbound n ${s.sb.length}, 85th percentile ${fmt(s.p85s)} mph`}
          onPointerLeave={() => setHover(null)}>
          {ticksY.map((n) => (
            <g key={n}>
              <line x1={pad.l} x2={Wd - pad.r} y1={Y(n)} y2={Y(n)} className="spd-grid" />
              <text x={pad.l - 8} y={Y(n) + 4} textAnchor="end" className="spd-tick">{n}</text>
            </g>
          ))}
          {s.hn.map((b, i) => {
            const x0 = X(b.x0) + 3;
            return (
              <g key={i} onPointerEnter={() => setHover(i)}>
                <rect x={X(b.x0)} y={pad.t} width={X(b.x1) - X(b.x0)} height={ih} fill="transparent" />
                {hover === i && <rect x={X(b.x0)} y={pad.t} width={X(b.x1) - X(b.x0)} height={ih} className="spd-hl" />}
                <path d={bar(x0, b.n, bw)} fill={CHART.nb} />
                <path d={bar(x0 + bw + 2, s.hs[i].n, bw)} fill={CHART.sb} />
                <text x={X(b.x0)} y={Ht - pad.b + 18} textAnchor="middle" className="spd-tick">{b.x0}</text>
              </g>
            );
          })}
          <text x={X(s.top)} y={Ht - pad.b + 18} textAnchor="end" className="spd-tick">{s.top}</text>
          <line x1={pad.l} x2={Wd - pad.r} y1={pad.t + ih} y2={pad.t + ih} className="spd-axis" />
          {([['NB', s.p85n, CHART.nb, (s.p85n ?? 0) > (s.p85s ?? 0) ? 1 : 0], ['SB', s.p85s, CHART.sb, (s.p85n ?? 0) > (s.p85s ?? 0) ? 0 : 1]] as const).map(([d, p, c, k]) => p != null && (
            <g key={d} className="spd-p85">
              <line x1={X(p)} x2={X(p)} y1={pad.t - 4} y2={pad.t + ih} stroke={c} strokeDasharray="4 3" strokeWidth={1.5} />
              <text x={X(p) + (k ? 6 : -6)} y={pad.t - 10} textAnchor={k ? 'start' : 'end'} className="spd-lab">{d} 85th {p.toFixed(1)}</text>
            </g>
          ))}
          <text x={pad.l + iw / 2} y={Ht - 4} textAnchor="middle" className="spd-axis-t">Spot speed (mph)</text>
          <text x={12} y={pad.t + ih / 2} transform={`rotate(-90 12 ${pad.t + ih / 2})`} textAnchor="middle" className="spd-axis-t">Vehicles</text>
        </svg>
        {hb && (
          <div className="spd-tip" style={{ left: `${(X(hb.b.x0 + BIN / 2) / Wd) * 100}%` }} role="status">
            <b className="measure">{hb.b.x0}–{hb.b.x1} mph</b>
            <span><i style={{ background: CHART.nb }} />NB <span className="measure">{hb.nb}</span></span>
            <span><i style={{ background: CHART.sb }} />SB <span className="measure">{hb.sb}</span></span>
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>Spot speeds by 5 mph bin</caption>
        <thead><tr><th>Bin (mph)</th><th>NB vehicles</th><th>SB vehicles</th></tr></thead>
        <tbody>{s.hn.map((b, i) => <tr key={i}><td>{b.x0}–{b.x1}</td><td>{b.n}</td><td>{s.hs[i].n}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const fmt = (v: number | null) => (v == null ? '—' : v.toFixed(1));
