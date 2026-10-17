import { useMemo, useState } from 'react';
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
  { id: 'frequency', label: 'Crash frequency', unit: 'crashes / 3 yr', d: 'Raw count; simple, but ignores exposure and regression to the mean.' },
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
  const spf = useApi<SpfFull>('/spf');
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
          {nf(scr.data?.total)} one-mile state-system segments in Lubbock County, screened for pedestrian, cyclist and e-scooter crashes reported in CRIS for 2021–2023 and ranked by the performance measure you choose.
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
              <tr><th className="r">#</th><th>Segment</th><th className="r">AADT</th><th className="r">Ped/bike crashes</th><th className="r">{meta.label}</th><th className="r">{method === 'eb_excess' ? 'Crit. ratio' : 'EB excess'}</th></tr>
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
          <h2 id="spf-h">Safety performance functions by site type</h2>
          <p>Locally estimated NB2 models for {spf.data?.outcome ?? 'pedestrian and cyclist crashes'}</p>
        </div>
        {spf.data ? <SiteTypes spf={spf.data} /> : <div className="skeleton" style={{ height: 360 }} />}
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

interface SiteModel { spec: string[]; coef: Record<string, number>; se: Record<string, number>; k: number; k_convention?: string; n: number; crashes: number; aic: number }
interface SiteType { segments: number; crashes: number; fitted: boolean; model_used: string; model?: SiteModel; gof?: { mad: number; chi2_df: number }; cure?: { columns: string[]; points: [number, number, number][]; pct_outside: number }; eb_weight_median?: number; reason?: string }
interface SpfFull extends Spf { outcome?: string; crash_period?: string; crash_years?: number; site_types?: Record<string, SiteType>; fallback?: { model?: SiteModel; gof?: { mad: number; chi2_df: number } } }

const TERM: Record<string, string> = { const: 'β₀', ln_aadt: 'ln AADT', speed: 'posted speed (mph)', lanes: 'lanes', urban: 'urban' };

function SiteTypes({ spf }: { spf: SpfFull }) {
  const fitted = Object.entries(spf.site_types ?? {}).filter(([, v]) => v.fitted && v.model && v.cure);
  const [sel, setSel] = useState(fitted[0]?.[0] ?? '');
  const cur = fitted.find(([k]) => k === sel)?.[1];
  const rest = Object.entries(spf.site_types ?? {}).filter(([, v]) => !v.fitted);
  if (!cur) return <p className="muted">No site-type model available.</p>;
  const m = cur.model!;
  return (
    <div className="spf panel">
      <div className="seg" role="group" aria-label="Site type">
        {fitted.map(([k]) => <button key={k} aria-pressed={k === sel} onClick={() => setSel(k)}>{k}</button>)}
      </div>
      <div className="spf-grid">
        <div>
          <table className="data">
            <caption className="sr-only">Coefficients for {sel}</caption>
            <thead><tr><th>Term</th><th className="r">Estimate</th><th className="r">SE</th></tr></thead>
            <tbody>
              {Object.keys(m.coef).map((t) => <tr key={t}><td>{TERM[t] ?? t}</td><td className="r num">{m.coef[t].toFixed(3)}</td><td className="r num">{m.se?.[t]?.toFixed(3) ?? '—'}</td></tr>)}
              <tr><td>Overdispersion k (per mile)</td><td className="r num">{m.k.toFixed(2)}</td><td /></tr>
            </tbody>
          </table>
          <dl className="spf-gof num">
            <dt>Segments · crashes</dt><dd>{cur.segments} · {cur.crashes}</dd>
            <dt>MAD</dt><dd>{cur.gof?.mad.toFixed(2)}</dd>
            <dt>Pearson χ²/df</dt><dd>{cur.gof?.chi2_df.toFixed(2)}</dd>
            <dt>AIC</dt><dd>{m.aic.toFixed(1)}</dd>
            <dt>Median EB weight w</dt><dd>{cur.eb_weight_median?.toFixed(2) ?? '—'}</dd>
            <dt>CURE outside ±2σ*</dt><dd>{cur.cure!.pct_outside.toFixed(1)}%</dd>
          </dl>
        </div>
        <Cure pts={cur.cure!.points} label={sel} />
      </div>
      <p className="spf-legend muted">
        NB2 by maximum likelihood with offset ln L + ln Y (Y = {spf.crash_years ?? 3} yr); k per mile, applied as k/L (HSM segment convention).
        Site types without enough crashes use the pooled fallback: {rest.map(([k, v]) => `${k} (${v.crashes})`).join(', ')}.
      </p>
    </div>
  );
}

/** Cumulative residual (CURE) plot ordered by AADT with ±2σ* bounds (Hauer & Bamfo). */
function Cure({ pts, label }: { pts: [number, number, number][]; label: string }) {
  const W = 620, H = 300, P = { l: 52, r: 14, t: 14, b: 40 };
  const xs = pts.map((p) => p[0]);
  const x0 = Math.log10(Math.max(100, Math.min(...xs))), x1 = Math.log10(Math.max(...xs));
  const ym = Math.max(0.5, ...pts.map((p) => Math.max(Math.abs(p[1]), p[2]))) * 1.1;
  const X = (a: number) => P.l + ((Math.log10(Math.max(100, a)) - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
  const Y = (v: number) => P.t + (1 - (v + ym) / (2 * ym)) * (H - P.t - P.b);
  const line = (f: (p: [number, number, number]) => number) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(f(p)).toFixed(1)}`).join('');
  const ticks = [1000, 3000, 10000, 30000].filter((a) => Math.log10(a) >= x0 && Math.log10(a) <= x1);
  return (
    <figure className="cure">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`CURE plot for ${label}`}>
        {ticks.map((a) => <g key={a}><line x1={X(a)} x2={X(a)} y1={P.t} y2={H - P.b} className="gl" /><text x={X(a)} y={H - P.b + 16} className="tick" textAnchor="middle">{a.toLocaleString()}</text></g>)}
        <line x1={P.l} x2={W - P.r} y1={Y(0)} y2={Y(0)} className="zero" />
        <path d={line((p) => p[2]) + line((p) => -p[2]).replace(/^M/, 'M')} className="band" />
        <path d={line((p) => p[1])} className="cum" />
        <text x={P.l - 8} y={Y(ym * 0.9) + 4} className="tick" textAnchor="end">+{(ym * 0.9).toFixed(1)}</text>
        <text x={P.l - 8} y={Y(-ym * 0.9) + 4} className="tick" textAnchor="end">−{(ym * 0.9).toFixed(1)}</text>
        <text x={(W + P.l) / 2} y={H - 6} className="axis" textAnchor="middle">AADT (veh/day, log scale)</text>
        <text transform={`translate(14 ${(H - P.b) / 2}) rotate(-90)`} className="axis" textAnchor="middle">cumulative residual</text>
      </svg>
      <figcaption className="muted">Residuals cumulated in order of AADT; staying inside the dashed ±2σ* envelope indicates no systematic bias over the AADT range.</figcaption>
    </figure>
  );
}
