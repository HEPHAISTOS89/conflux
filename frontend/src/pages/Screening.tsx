import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import MapView, { type MapLayer } from '../components/MapView';
import { Icon } from '../components/Icon';
import Term from '../components/Term';
import { useApi } from '../lib/api';
import { bboxOf, CHART, nf, SEV_HEX } from '../lib/format';
import { reducedMotion, useReveal } from '../lib/motion';
import type { FC, SegmentProps, Spf } from '../lib/types';
import '../styles/screening.css';

const METHODS = [
  { id: 'eb_excess', label: 'EB excess', d: 'EB-expected minus SPF-predicted crashes per year: the HSM potential for safety improvement.' },
  { id: 'critical_ratio', label: 'Critical rate ratio', d: 'Observed over critical rate at 95% confidence; above 1 is statistically high.' },
  { id: 'rate', label: 'Crash rate', d: 'Crashes per 100 million vehicle-miles; favours low-volume segments.' },
  { id: 'frequency', label: 'Crash frequency', d: 'Raw three-year count; ignores exposure and regression to the mean.' },
] as const;
type MethodId = (typeof METHODS)[number]['id'];
const FIELD: Record<MethodId, keyof SegmentProps> = { eb_excess: 'eb_excess', critical_ratio: 'crit_ratio', rate: 'rate_100mvmt', frequency: 'crashes_total' };
const GROUPS = ['All', 'Interstate/Freeway', 'Principal arterial', 'Minor arterial', 'Collector/Local'];
const TOP = 25;

type Row = SegmentProps & { fc_group?: string; site_type?: string; crashes_per_yr?: number; score?: number; screen_rank?: number; dfo_from?: number; dfo_to?: number };
interface Screening { method: string; total: number; items: Row[] }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function downloadCsv(name: string, cols: string[], rows: unknown[][]) {
  const text = [cols, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Copies the current URL; the returned label confirms for 1.6 s. */
function useCopyLink() {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => { if (state === 'idle') return; const t = setTimeout(() => setState('idle'), 1600); return () => clearTimeout(t); }, [state]);
  const copy = () => {
    const url = window.location.href;
    // execCommand fallback covers browsers that deny the async clipboard to an unfocused document
    const legacy = () => {
      const t = Object.assign(document.createElement('textarea'), { value: url });
      t.style.cssText = 'position:fixed;opacity:0';
      document.body.append(t); t.select();
      const ok = document.execCommand('copy'); t.remove();
      setState(ok ? 'ok' : 'fail');
    };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => setState('ok'), legacy); else legacy();
  };
  return [state === 'ok' ? 'Link copied' : state === 'fail' ? 'Copy blocked' : 'Copy link', copy] as const;
}
const typing = (e: KeyboardEvent) => e.metaKey || e.ctrlKey || e.altKey || !!(e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]') || !!document.querySelector('.cmdk-scrim');

export default function ScreeningPage() {
  const [params, setParams] = useSearchParams();
  const method = (params.get('method') as MethodId) || 'eb_excess';
  const group = params.get('group') || 'All';
  const focus = params.get('seg');
  const set = useCallback((k: string, v: string | null) => setParams((prev) => { const p = new URLSearchParams(prev); v ? p.set(k, v) : p.delete(k); return p; }, { replace: true }), [setParams]);

  const net = useApi<FC<SegmentProps & { fc_group?: string }>>('/network');
  const scr = useApi<Screening>(`/screening?method=${method}&limit=443`);
  const spf = useApi<SpfFull>('/spf');
  const meta = METHODS.find((m) => m.id === method)!;
  const headRef = useReveal<HTMLElement>();
  const gridRef = useReveal<HTMLElement>();
  const spfRef = useReveal<HTMLElement>();
  const wrapRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLTableRowElement>());
  const [linkLabel, copyLink] = useCopyLink();

  const rows = useMemo(() => (scr.data?.items ?? []).filter((r) => group === 'All' || r.fc_group === group), [scr.data, group]);
  const rankOf = useMemo(() => new Map(rows.map((r, i) => [r.seg_id, i + 1])), [rows]);
  const focusFeature = net.data?.features.find((f) => f.properties.seg_id === focus);
  const focusRow = rows.find((r) => r.seg_id === focus);

  // Fit only on request (double-click, F, deep link); n nudges the bounds so the same segment can be refitted.
  const [fit, setFit] = useState<{ id: string; n: number } | null>(() => (focus ? { id: focus, n: 0 } : null));
  const fitFeature = fit && net.data?.features.find((f) => f.properties.seg_id === fit.id);
  const bounds = useMemo(() => {
    if (!fitFeature || !fit) return undefined;
    const [[a, b], [c, d]] = bboxOf(fitFeature.geometry.coordinates as number[][]);
    const e = fit.n * 1e-7;
    return [[a - e, b], [c, d]] as [[number, number], [number, number]];
  }, [fitFeature, fit]);
  const fitTo = (id: string) => setFit((f) => ({ id, n: (f?.n ?? 0) + 1 }));

  const scrollRow = (id: string) => {
    const row = rowEls.current.get(id), wrap = wrapRef.current;
    if (!row || !wrap) return;
    const r = row.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    wrap.scrollBy({ top: r.top - w.top - wrap.clientHeight / 2 + r.height / 2, behavior: reducedMotion() ? 'auto' : 'smooth' });
  };
  const select = (id: string | null, scroll = false) => {
    set('seg', id);
    if (id && scroll) requestAnimationFrame(() => { scrollRow(id); rowEls.current.get(id)?.focus({ preventScroll: true }); });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e)) return;
      const k = e.key.toLowerCase();
      if ((k === 'j' || k === 'k') && rows.length) {
        e.preventDefault();
        const i = rows.findIndex((r) => r.seg_id === focus);
        const n = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + (k === 'j' ? 1 : -1)));
        select(rows[n].seg_id, true);
      } else if (k === 'f' && focus) { e.preventDefault(); fitTo(focus); }
      else if (e.key === 'Escape' && focus && !document.querySelector('.term-tip')) set('seg', null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const exportCsv = () => downloadCsv(`roadscope-screening-${method}-${slug(group)}.csv`,
    ['rank', 'seg_id', 'name', 'route', 'dfo_from', 'dfo_to', 'facility', 'site_type', 'lanes', 'speed_limit_mph', 'aadt', 'truck_pct', 'crashes_3yr', 'crashes_per_yr', 'rate_100mvmt', 'crit_rate', 'crit_ratio', 'spf_pred_per_yr', 'eb_expected_per_yr', 'eb_excess_per_yr'],
    rows.map((r, i) => [i + 1, r.seg_id, r.name, r.route, r.dfo_from, r.dfo_to, r.fc_group, r.site_type, r.lanes, r.speed_limit, r.aadt, r.truck_pct, r.crashes_total, r.crashes_per_yr, r.rate_100mvmt, r.crit_rate, r.crit_ratio, r.spf_pred, r.eb_expected, r.eb_excess]));

  const sources = useMemo<MapLayer[]>(() => {
    if (!net.data) return [];
    const data = { ...net.data, features: net.data.features.map((f) => ({ ...f, properties: { ...f.properties, _rank: rankOf.get(f.properties.seg_id) ?? 9999 } })) };
    return [{
      id: 'net', data: data as any,
      layers: [
        { id: 'net-base', type: 'line', paint: { 'line-color': CHART.areaFill, 'line-width': 1.4 } } as any,
        { id: 'net-top', type: 'line', filter: ['<=', ['get', '_rank'], TOP], paint: { 'line-color': ['interpolate', ['linear'], ['get', '_rank'], 1, SEV_HEX.K, 8, SEV_HEX.A, TOP, SEV_HEX.B], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3, 13, 7] }, layout: { 'line-cap': 'round' } } as any,
        // Invisible wide stroke: a forgiving hit target for thin segments
        { id: 'net-hit', type: 'line', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 14 } } as any,
      ],
    }];
  }, [net.data, rankOf]);
  // The selection is its own one-feature source, so selecting never re-sends the network.
  const selSource = useMemo<MapLayer>(() => ({
    id: 'sel', data: { type: 'FeatureCollection', features: focusFeature ? [focusFeature] : [] },
    layers: [{ id: 'sel-line', type: 'line', paint: { 'line-color': CHART.ink, 'line-width': 2, 'line-gap-width': ['interpolate', ['linear'], ['zoom'], 9, 5, 13, 9] }, layout: { 'line-cap': 'round', 'line-join': 'round' } } as any],
  }), [focusFeature]);
  const mapSources = useMemo(() => (sources.length ? [...sources, selSource] : []), [sources, selSource]);

  const methodHead = method === 'eb_excess' ? <Term k="EB excess" /> : method === 'critical_ratio' ? <Term k="Critical ratio">R/Rc</Term> : method === 'rate' ? 'Per 100 MVMT' : 'Crashes, 3 yr';
  const dp = method === 'frequency' ? 0 : method === 'rate' ? 1 : 2;

  return (
    <div className="page screening">
      <header className="page-head scr-head" ref={headRef}>
        <h1 data-r="1">Network screening</h1>
        <p data-r="2">{nf(scr.data?.total)} one-mile state-system segments, ranked by CRIS ped/bike crashes, 2021–2023.</p>
        <div className="scr-controls" role="toolbar" aria-label="Screening options" data-r="3">
          <div className="seg" role="group" aria-label="Performance measure">
            {METHODS.map((m) => <button key={m.id} aria-pressed={method === m.id} onClick={() => set('method', m.id)}>{m.label}</button>)}
          </div>
          <label className="select">
            <span>Facility</span>
            <select value={group} onChange={(e) => set('group', e.target.value === 'All' ? null : e.target.value)}>
              {GROUPS.map((g) => <option key={g}>{g}</option>)}
            </select>
          </label>
          <div className="scr-actions">
            <button type="button" className="btn ghost" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
            <button type="button" className="btn ghost" onClick={copyLink} aria-live="polite">{linkLabel}</button>
            <Link to="/brief" className="btn ghost">District brief</Link>
          </div>
        </div>
        <p className="scr-def" key={method}>{meta.d}</p>
      </header>

      <section className="scr-grid" ref={gridRef}>
        <div className="panel scr-table-wrap" data-ui data-r="1" ref={wrapRef} aria-busy={scr.loading || undefined}>
          {scr.error && <div className="error-box scr-state">Ranking unavailable: {scr.error} <button type="button" className="btn ghost" onClick={() => location.reload()}>Reload</button></div>}
          <table className="data">
            <caption className="sr-only">Segments ranked by {meta.label}{group !== 'All' ? `, ${group}` : ''}</caption>
            <thead>
              <tr>
                <th className="r">#</th><th>Segment · DFO</th><th className="r opt"><Term k="AADT" /></th><th className="r">Ped/bike</th>
                <th className="r">{methodHead}</th><th className="r opt"><Term k="SPF">SPF/yr</Term></th>
                <th className="r opt">{method === 'eb_excess' ? <Term k="Critical ratio">R/Rc</Term> : <Term k="EB excess" />}</th>
              </tr>
            </thead>
            <tbody>
              {scr.loading && !scr.data && Array.from({ length: 10 }, (_, i) => <tr key={i} aria-hidden="true"><td colSpan={7}><div className="skeleton" style={{ height: 18 }} /></td></tr>)}
              {scr.data && !rows.length && <tr><td colSpan={7} className="scr-empty">No ranked segments in {group}.</td></tr>}
              {rows.map((r, i) => (
                <tr key={r.seg_id} ref={(el) => { if (el) rowEls.current.set(r.seg_id, el); else rowEls.current.delete(r.seg_id); }}
                  style={{ '--i': Math.min(i, 14) } as React.CSSProperties} data-active={focus === r.seg_id} data-top={i < TOP || undefined}
                  aria-selected={focus === r.seg_id} tabIndex={0}
                  onClick={() => select(r.seg_id)} onDoubleClick={() => fitTo(r.seg_id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); select(r.seg_id); } }}>
                  <td className="r num rank">{i + 1}</td>
                  <td>
                    <div className="seg-name">{r.name}</div>
                    <div className="num seg-id">{nf(r.dfo_from, 2)}–{nf(r.dfo_to, 2)} · {r.fc_group}</div>
                  </td>
                  <td className="r num opt">{nf(r.aadt)}</td>
                  <td className="r num">{nf(r.crashes_total)}</td>
                  <td className="r num strong" key={method}><span className="flip">{nf(r[FIELD[method]] as number, dp)}</span></td>
                  <td className="r num opt">{nf(r.spf_pred, 2)}</td>
                  <td className="r num opt">{nf(method === 'eb_excess' ? r.crit_ratio : r.eb_excess, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel scr-map" data-ui data-r="2">
          <MapView
            label={`Map of the top ${TOP} segments by ${meta.label}`}
            sources={mapSources}
            interactiveLayers={['net-hit']}
            bounds={bounds}
            onClick={(_, f) => select((f.properties as any).seg_id, true)}
          />
          {net.error && <div className="error-box scr-map-err">Network unavailable: {net.error}</div>}
          <p className="scr-keys" aria-hidden="true"><kbd>J</kbd><kbd>K</kbd> step <kbd>F</kbd> fit <kbd>Esc</kbd> clear</p>
          {focusFeature && <SegmentCard key={focusFeature.properties.seg_id} s={{ ...focusFeature.properties, ...focusRow } as any} rank={rankOf.get(focusFeature.properties.seg_id)}
            onFit={() => fitTo(focusFeature.properties.seg_id)} onClose={() => set('seg', null)} />}
        </div>
      </section>

      <section className="section scr-spf" aria-labelledby="spf-h" ref={spfRef}>
        <h2 id="spf-h" data-r="1"><Term k="SPF">Safety performance functions</Term> by site type</h2>
        <div data-r="2">
          {spf.error ? <div className="error-box">Models unavailable: {spf.error}</div>
            : spf.data ? <SiteTypes spf={spf.data} /> : <div className="skeleton" style={{ height: 360 }} aria-label="Loading models" />}
        </div>
      </section>
    </div>
  );
}

function SegmentCard({ s, rank, onFit, onClose }: { s: Row & { speed_all?: number }; rank?: number; onFit: () => void; onClose: () => void }) {
  const corridor = { US0084: 'us-84', US0062: 'us-62-82', US0082: 'us-62-82', SL0289: 'loop-289', IH0027: 'i-27', SH0114: 'sh-114', FM2255: 'fm-2255', FM0835: 'fm-835' }[s.route?.slice(0, 6) ?? ''];
  return (
    <div className="seg-card" role="region" aria-label={`Selected segment ${s.name}`}>
      <div className="seg-card-h">
        <strong>{s.name}</strong><span className="num">{rank ? `#${rank}` : 'unranked'}</span>
        <button type="button" className="seg-card-x" onClick={onClose} aria-label="Clear selection"><Icon name="close" size={16} /></button>
      </div>
      <dl className="num">
        <dt>Facility</dt><dd>{s.fc_group ?? '—'} · {nf(s.lanes)} lanes</dd>
        <dt>Posted / operating</dt><dd>{nf(s.speed_limit)} / {nf(s.speed_all, 1)} mph</dd>
        <dt><Term k="AADT" /> · trucks</dt><dd>{nf(s.aadt)} · {nf(s.truck_pct, 1)}%</dd>
        <dt>Observed</dt><dd>{nf(s.crashes_per_yr, 2)} / yr</dd>
        <dt><Term k="SPF">SPF</Term> predicted</dt><dd>{nf(s.spf_pred, 2)} / yr</dd>
        <dt><Term k="EB">EB</Term> expected</dt><dd>{nf(s.eb_expected, 2)} / yr</dd>
        <dt><Term k="Critical ratio" /></dt><dd>{nf(s.crit_ratio, 2)}</dd>
      </dl>
      <div className="seg-card-a">
        <button type="button" className="btn ghost" onClick={onFit}>Fit map</button>
        {corridor && <Link className="btn ghost" to={`/corridors/${corridor}`}>Corridor diagram</Link>}
      </div>
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
      <p className="spf-legend">
        NB2, offset ln L + ln Y (Y = {spf.crash_years ?? 3} yr), k per mile applied as k/L. Pooled fallback: {rest.map(([k, v]) => `${k} (${v.crashes})`).join(', ')}.
      </p>
    </div>
  );
}

/** Tracks an element's content width so charts draw in true pixels and their text never scales below its set size. */
function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Cumulative residual (CURE) plot ordered by AADT with ±2σ* bounds (Hauer & Bamfo). */
function Cure({ pts, label }: { pts: [number, number, number][]; label: string }) {
  const [ref, W] = useWidth<HTMLElement>(620);
  const H = Math.round(Math.min(340, Math.max(240, W * 0.52))), P = { l: 52, r: 12, t: 30, b: 42 };
  const xs = pts.map((p) => p[0]);
  const x0 = Math.log10(Math.max(100, Math.min(...xs))), x1 = Math.log10(Math.max(...xs));
  const ym = Math.max(0.5, ...pts.map((p) => Math.max(Math.abs(p[1]), p[2]))) * 1.1;
  const X = (a: number) => P.l + ((Math.log10(Math.max(100, a)) - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
  const Y = (v: number) => P.t + (1 - (v + ym) / (2 * ym)) * (H - P.t - P.b);
  const line = (f: (p: [number, number, number]) => number) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(f(p)).toFixed(1)}`).join('');
  const ticks = [1000, 3000, 10000, 30000, 100000].filter((a) => Math.log10(a) >= x0 && Math.log10(a) <= x1);
  return (
    <figure className="cure" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`CURE plot for ${label}`}>
        <text x={0} y={14} className="axis">Cumulative residual</text>
        {ticks.map((a) => <g key={a}><line x1={X(a)} x2={X(a)} y1={P.t} y2={H - P.b} className="gl" /><text x={X(a)} y={H - P.b + 20} className="tick" textAnchor="middle">{a.toLocaleString()}</text></g>)}
        <line x1={P.l} x2={W - P.r} y1={Y(0)} y2={Y(0)} className="zero" />
        <path d={line((p) => p[2]) + line((p) => -p[2]).replace(/^M/, 'M')} className="band" />
        <path key={label} d={line((p) => p[1])} className="cum" />
        <text x={P.l - 8} y={Y(ym * 0.9) + 5} className="tick" textAnchor="end">+{(ym * 0.9).toFixed(1)}</text>
        <text x={P.l - 8} y={Y(0) + 5} className="tick" textAnchor="end">0</text>
        <text x={P.l - 8} y={Y(-ym * 0.9) + 5} className="tick" textAnchor="end">−{(ym * 0.9).toFixed(1)}</text>
        <text x={W - P.r} y={H - 4} className="axis" textAnchor="end">AADT, veh/day (log)</text>
      </svg>
    </figure>
  );
}
