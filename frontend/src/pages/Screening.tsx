import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import MapView, { type MapLayer } from '../components/MapView';
import { useApi } from '../lib/api';
import { bboxOf, nf } from '../lib/format';
import type { FC, SegmentProps, Spf } from '../lib/types';
import '../styles/screening.css';

const METHODS = [
  { id: 'eb_excess', label: 'EB excess', unit: 'crashes / yr', d: 'Excess expected average crash frequency with Empirical Bayes adjustment: EB-expected minus SPF-predicted crashes per year, the HSM Part B potential-for-safety-improvement (PSI) measure that corrects for regression to the mean.' },
  { id: 'critical_ratio', label: 'Critical rate ratio', unit: 'R / Rc', d: 'Observed rate over critical rate at 95% confidence for the facility group; > 1 flags a statistically high rate.' },
  { id: 'rate', label: 'Crash rate', unit: 'per 100 MVMT', d: 'Crashes per hundred million vehicle-miles travelled; exposure-normalised, biased toward low-volume segments.' },
  { id: 'frequency', label: 'Crash frequency', unit: 'crashes / 9 yr', d: 'Raw count; simple, but ignores exposure and regression to the mean.' },
] as const;
type MethodId = (typeof METHODS)[number]['id'];
const FIELD: Record<MethodId, keyof SegmentProps> = { eb_excess: 'eb_excess', critical_ratio: 'crit_ratio', rate: 'rate_100mvmt', frequency: 'crashes_total' };
const GROUPS = ['All', 'Interstate/freeway', 'Principal arterial', 'Minor arterial', 'Collector/local'];

interface Screening { method: string; total: number; items: (SegmentProps & { fc_group?: string; crashes_per_yr?: number; score?: number; screen_rank?: number; dfo_from?: number; dfo_to?: number })[] }

export default function ScreeningPage() {
  const [params, setParams] = useSearchParams();
  const method = (params.get('method') as MethodId) || 'eb_excess';
  const group = params.get('group') || 'All';
  const focus = params.get('seg');
  const set = (k: string, v: string | null) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); setParams(p, { replace: true }); };

  const net = useApi<FC<SegmentProps & { fc_group?: string }>>('/network');
  const scr = useApi<Screening>(`/screening?method=${method}&limit=443`);
  const spf = useApi<Spf>('/spf');
  const meta = METHODS.find((m) => m.id === method)!;

  const rows = useMemo(() => (scr.data?.items ?? []).filter((r) => group === 'All' || r.fc_group === group), [scr.data, group]);
  const top = rows.slice(0, 25);
  const focusFeature = net.data?.features.find((f) => f.properties.seg_id === focus);
  const bounds = focusFeature ? bboxOf(focusFeature.geometry.coordinates as number[][]) : undefined;

  const rankOf = useMemo(() => new Map(rows.map((r, i) => [r.seg_id, i + 1])), [rows]);
  const sources = useMemo<MapLayer[]>(() => {
    if (!net.data) return [];
    const data = { ...net.data, features: net.data.features.map((f) => ({ ...f, properties: { ...f.properties, _rank: rankOf.get(f.properties.seg_id) ?? 9999 } })) };
    return [{
      id: 'net', data: data as any,
      layers: [
        { id: 'net-base', type: 'line', paint: { 'line-color': '#c9cfc6', 'line-width': 1.4 } } as any,
        { id: 'net-top', type: 'line', filter: ['<=', ['get', '_rank'], 25], paint: { 'line-color': ['interpolate', ['linear'], ['get', '_rank'], 1, '#6e120d', 8, '#b3261e', 25, '#d9a038'], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3, 13, 7] }, layout: { 'line-cap': 'round' } } as any,
        { id: 'net-hl', type: 'line', filter: ['==', ['get', 'seg_id'], '__none__'], paint: { 'line-color': '#14171a', 'line-width': 10, 'line-opacity': 0.3 } } as any,
      ],
    }];
  }, [net.data, rankOf]);

  return (
    <div className="page screening">
      <header className="page-head">
        <h1>Network screening</h1>
        <p>
          {nf(scr.data?.total)} one-mile state-system segments in Lubbock County, ranked by the performance measure you choose.
          Agencies screen with more than one measure because each is biased differently; segments that stay near the top under all of them are the strongest candidates for diagnosis.
        </p>
      </header>

      <div className="scr-controls" role="toolbar" aria-label="Screening options">
        <div className="seg" role="group" aria-label="Performance measure">
          {METHODS.map((m) => <button key={m.id} aria-pressed={method === m.id} onClick={() => set('method', m.id)}>{m.label}</button>)}
        </div>
        <label className="select">
          <span>Facility group</span>
          <select value={group} onChange={(e) => set('group', e.target.value === 'All' ? null : e.target.value)}>
            {GROUPS.map((g) => <option key={g}>{g}</option>)}
          </select>
        </label>
        <Link to="/brief" className="btn ghost scr-brief">One-page district brief</Link>
        <p className="scr-def muted">{meta.d}</p>
      </div>

      <section className="scr-grid">
        <div className="panel scr-table-wrap">
          {scr.error && <div className="error-box">Could not load the ranking: {scr.error}</div>}
          <table className="data">
            <caption className="sr-only">Top 25 segments by {meta.label}</caption>
            <thead>
              <tr><th className="r">#</th><th>Segment</th><th className="r">AADT</th><th className="r">Crashes</th><th className="r">{meta.label}</th><th className="r">{method === 'eb_excess' ? 'Crit. ratio' : 'EB excess'}</th></tr>
            </thead>
            <tbody>
              {scr.loading && !scr.data && Array.from({ length: 10 }, (_, i) => <tr key={i}><td colSpan={6}><div className="skeleton" style={{ height: 18 }} /></td></tr>)}
              {top.map((r, i) => (
                <tr key={r.seg_id} data-active={focus === r.seg_id} onMouseEnter={() => set('seg', r.seg_id)} onClick={() => set('seg', r.seg_id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && set('seg', r.seg_id)}>
                  <td className="r num">{i + 1}</td>
                  <td>
                    <div className="seg-name">{r.name}</div>
                    <div className="num muted seg-id">DFO {nf(r.dfo_from, 2)}–{nf(r.dfo_to, 2)} · {r.fc_group}</div>
                  </td>
                  <td className="r num">{nf(r.aadt)}</td>
                  <td className="r num">{nf(r.crashes_total)}</td>
                  <td className="r num strong">{nf(r[FIELD[method]] as number, method === 'frequency' ? 0 : method === 'rate' ? 1 : 2)}</td>
                  <td className="r num">{nf(method === 'eb_excess' ? r.crit_ratio : r.eb_excess, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel scr-map">
          <MapView
            label={`Map of the top 25 segments by ${meta.label}`}
            sources={sources}
            interactiveLayers={['net-top', 'net-base']}
            highlight={{ source: 'net', key: 'seg_id', value: focus }}
            bounds={bounds}
            onClick={(_, f) => set('seg', (f.properties as any).seg_id)}
          />
          {focusFeature && <SegmentCard s={focusFeature.properties as any} rank={rankOf.get(focusFeature.properties.seg_id)} />}
        </div>
      </section>

      <section className="section" aria-labelledby="spf-h">
        <div className="section-head">
          <h2 id="spf-h">Safety performance function</h2>
          <p>Locally estimated negative binomial SPF, ln μ = β₀ + β₁ ln AADT + ln L, {nf(spf.data?.n)} segments</p>
        </div>
        {spf.data && net.data ? <SpfPlot spf={spf.data} feats={net.data.features.map((f) => f.properties)} focus={focus} onPick={(id) => set('seg', id)} /> : <div className="skeleton" style={{ height: 360 }} />}
      </section>
    </div>
  );
}

function SegmentCard({ s, rank }: { s: SegmentProps & { fc_group?: string; crashes_per_yr?: number; speed_all?: number }; rank?: number }) {
  const corridor = { US0084: 'us-84', US0062: 'us-62-82', US0082: 'us-62-82', SL0289: 'loop-289', IH0027: 'i-27', SH0114: 'sh-114', FM2255: 'fm-2255', FM1264: 'fm-1264' }[s.route?.slice(0, 6) ?? ''];
  return (
    <div className="seg-card">
      <div className="seg-card-h"><strong>{s.name}</strong><span className="num muted">{rank ? `rank ${rank}` : 'unranked'}</span></div>
      <dl className="num">
        <dt>Facility</dt><dd>{s.fc_group ?? '—'} · {nf(s.lanes)} lanes</dd>
        <dt>Posted / operating</dt><dd>{nf(s.speed_limit)} / {nf(s.speed_all, 1)} mph</dd>
        <dt>AADT · trucks</dt><dd>{nf(s.aadt)} · {nf(s.truck_pct, 1)}%</dd>
        <dt>Observed</dt><dd>{nf(s.crashes_per_yr, 2)} crashes / yr</dd>
        <dt>SPF predicted</dt><dd>{nf(s.spf_pred, 2)} / yr</dd>
        <dt>EB expected</dt><dd>{nf(s.eb_expected, 2)} / yr</dd>
        <dt>Critical ratio</dt><dd>{nf(s.crit_ratio, 2)}</dd>
      </dl>
      {corridor && <Link className="btn ghost" to={`/corridors/${corridor}`}>Open corridor diagram</Link>}
    </div>
  );
}

function SpfPlot({ spf, feats, focus, onPick }: { spf: Spf; feats: (SegmentProps & { fc_group?: string; crashes_per_yr?: number })[]; focus: string | null; onPick: (id: string) => void }) {
  const W = 960, H = 360, P = { l: 56, r: 16, t: 14, b: 40 };
  const pts = feats.filter((f) => f.aadt && f.aadt > 0 && f.crashes_per_yr != null);
  const xMin = Math.log10(300), xMax = Math.log10(80000);
  const yMax = Math.max(6, ...pts.map((p) => p.crashes_per_yr!));
  const X = (a: number) => P.l + ((Math.log10(a) - xMin) / (xMax - xMin)) * (W - P.l - P.r);
  const Y = (v: number) => H - P.b - (v / yMax) * (H - P.t - P.b);
  const curve = (b0: number, b1: number) => Array.from({ length: 60 }, (_, i) => { const a = 10 ** (xMin + (i / 59) * (xMax - xMin)); return `${i ? 'L' : 'M'}${X(a).toFixed(1)},${Y(Math.min(yMax, Math.exp(b0) * a ** b1)).toFixed(1)}`; }).join('');
  const classes = Object.entries(spf.by_class ?? {}).filter(([, v]: any) => v.fitted);
  const COLORS = ['#14171a', '#46617a', '#7a5a2e', '#5b6b4d'];
  return (
    <figure className="spf panel">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Observed crashes per year against AADT with fitted SPF curves">
        {[1000, 3000, 10000, 30000].map((a) => <g key={a}><line x1={X(a)} x2={X(a)} y1={P.t} y2={H - P.b} className="gl" /><text x={X(a)} y={H - P.b + 16} className="tick" textAnchor="middle">{a.toLocaleString()}</text></g>)}
        {Array.from({ length: Math.floor(yMax) + 1 }, (_, v) => v).filter((v) => v % 1 === 0).map((v) => <g key={v}><line x1={P.l} x2={W - P.r} y1={Y(v)} y2={Y(v)} className="gl" /><text x={P.l - 8} y={Y(v) + 4} className="tick" textAnchor="end">{v}</text></g>)}
        <text x={(W + P.l) / 2} y={H - 6} className="axis" textAnchor="middle">AADT (veh/day, log scale)</text>
        <text transform={`translate(14 ${(H - P.b) / 2}) rotate(-90)`} className="axis" textAnchor="middle">crashes / yr / mi</text>
        {pts.map((p) => (
          <circle key={p.seg_id} cx={X(p.aadt!)} cy={Y(p.crashes_per_yr!)} r={p.seg_id === focus ? 6 : 3}
            className={`pt ${p.seg_id === focus ? 'on' : ''}`} onClick={() => onPick(p.seg_id)}>
            <title>{`${p.name} · AADT ${nf(p.aadt)} · ${nf(p.crashes_per_yr, 2)}/yr`}</title>
          </circle>
        ))}
        <path d={curve(spf.b0, spf.b1)} className="curve pooled" />
        {classes.map(([name, v]: any, i) => <path key={name} d={curve(v.b0, v.b1)} className="curve" style={{ stroke: COLORS[i % 4] }} strokeDasharray="5 4" />)}
      </svg>
      <figcaption className="spf-legend">
        <span><i className="sw pooled" /> pooled: β₀ = <b className="num">{spf.b0.toFixed(2)}</b>, β₁ = <b className="num">{spf.b1.toFixed(3)}</b>, k = <b className="num">{spf.k.toFixed(2)}</b></span>
        {classes.map(([name, v]: any, i) => <span key={name}><i className="sw" style={{ borderColor: COLORS[i % 4] }} /> {name}: β₁ = <b className="num">{v.b1.toFixed(2)}</b> ± {v.se_b1?.toFixed(2)}</span>)}
        <span className="muted">EPDO is not offered: the TxDOT segment layer carries crash counts without KABCO severity.</span>
      </figcaption>
    </figure>
  );
}
