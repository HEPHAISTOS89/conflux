import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import MapView, { type MapLayer } from '../components/MapView';
import { Icon } from '../components/Icon';
import Term from '../components/Term';
import { useApi } from '../lib/api';
import { CHART, nf } from '../lib/format';
import { useReveal } from '../lib/motion';
import '../styles/corridor.css';

interface St { dfo: number; route: string; lon: number; lat: number; lanes: number | null; speed_limit: number | null; aadt: number | null; truck_pct: number | null; speed_all: number | null; speed_am: number | null; speed_md: number | null; speed_pm: number | null; crashes_per_mi: number | null; seg_id?: string }
interface CorridorT { id: string; name: string; routes: string[]; len_mi: number; stations: St[]; summary: { segments: number; crashes_per_yr: number; crashes_total: number; crash_years: number; aadt_mean: number; aadt_max: number; speed_all_mean: number; truck_pct_mean: number; bbox: number[]; top_segment: string | null; note: string | null } }
type Card = Omit<CorridorT, 'stations'> & { n_stations: number };

/** Tracks an element's content width so the diagram draws in true pixels and its labels never scale below their set size. */
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

const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function downloadCsv(name: string, cols: string[], rows: unknown[][]) {
  const text = [cols, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const typing = (e: KeyboardEvent) => e.metaKey || e.ctrlKey || e.altKey || !!(e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]') || !!document.querySelector('.cmdk-scrim');

export default function CorridorPage() {
  const { id = 'us-84' } = useParams();
  const nav = useNavigate();
  const list = useApi<Card[]>('/corridors');
  const cor = useApi<CorridorT>(`/corridors/${id}`);
  const [hov, setHov] = useState<number | null>(null);
  const [pin, setPin] = useState<number | null>(null);
  const cur = hov ?? pin;
  const [figRef, W] = useWidth<HTMLDivElement>(900);
  const reveal = useReveal<HTMLDivElement>();
  const narrow = W < 620;
  const L = narrow ? 0 : 168, R = 8;
  const st = cor.data?.stations ?? [];
  const X = (i: number) => L + (i / Math.max(1, st.length - 1)) * (W - L - R);
  const at = cur != null ? st[cur] : null;
  const pinned = pin != null ? st[pin] : null;
  const hovered = hov != null && hov !== pin ? st[hov] : null;

  const sources = useMemo<MapLayer[]>(() => {
    if (!st.length) return [];
    const line = { type: 'FeatureCollection' as const, features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: st.map((s) => [s.lon, s.lat]) } }] };
    const dots = { type: 'FeatureCollection' as const, features: st.map((s, i) => ({ type: 'Feature', properties: { i, c: s.crashes_per_mi ?? 0 }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })) };
    const pt = (s: St, kind: string) => ({ type: 'Feature', properties: { kind }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } });
    const marker = { type: 'FeatureCollection' as const, features: [...(pinned ? [pt(pinned, 'pin')] : []), ...(hovered ? [pt(hovered, 'hov')] : [])] };
    return [
      { id: 'cor', data: line as any, layers: [{ id: 'cor-line', type: 'line', paint: { 'line-color': CHART.ink, 'line-width': 2.5 } } as any] },
      { id: 'cor-dots', data: dots as any, layers: [{ id: 'cor-dot', type: 'circle', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'c'], 0, 1.5, 8, 7], 'circle-color': CHART.critical, 'circle-opacity': ['case', ['>', ['get', 'c'], 0], 0.75, 0] } } as any] },
      { id: 'cor-mk', data: marker as any, layers: [{ id: 'cor-mk-c', type: 'circle', paint: { 'circle-radius': ['match', ['get', 'kind'], 'pin', 8, 6], 'circle-color': ['match', ['get', 'kind'], 'pin', CHART.accent, CHART.ink], 'circle-stroke-color': CHART.ground, 'circle-stroke-width': 2 } } as any] },
    ];
  }, [st, pinned, hovered]);

  const bbox = cor.data?.summary.bbox;
  const bounds = bbox ? ([[bbox[0], bbox[1]], [bbox[2], bbox[3]]] as [[number, number], [number, number]]) : undefined;

  const indexAt = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((x - L) / (W - L - R)) * (st.length - 1));
    return i >= 0 && i < st.length ? i : null;
  };
  const pick = (i: number | null) => setPin((p) => (i == null || p === i ? null : i));

  useEffect(() => {
    if (pin == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setHov(null); setPin((p) => p == null ? p : Math.max(0, Math.min(st.length - 1, p + (e.key === 'ArrowRight' ? 1 : -1)))); }
      else if (e.key === 'Escape') setPin(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pin, st.length]);

  const exportCsv = () => downloadCsv(`roadscope-corridor-${id}-stations.csv`,
    ['route', 'dfo_mi', 'lon', 'lat', 'lanes', 'speed_limit_mph', 'speed_all_mph', 'speed_am_mph', 'speed_md_mph', 'speed_pm_mph', 'aadt', 'truck_pct', 'pedbike_crashes_per_mi_yr', 'seg_id'],
    st.map((s) => [s.route, s.dfo, s.lon, s.lat, s.lanes, s.speed_limit, s.speed_all, s.speed_am, s.speed_md, s.speed_pm, s.aadt, s.truck_pct, s.crashes_per_mi, s.seg_id]));

  const max = (k: keyof St) => Math.max(1, ...st.map((s) => (s[k] as number) ?? 0));
  const strips: { key: string; title: string; unit: string; h: number; render: (h: number) => React.ReactNode }[] = [
    { key: 'lanes', title: 'Through lanes', unit: 'count', h: 40, render: (h) => step(st, 'lanes', X, h, 8, 'var(--ink)') },
    { key: 'speed', title: 'Speed', unit: 'mph, 2024', h: 92, render: (h) => (
      <>
        {step(st, 'speed_limit', X, h, 80, 'var(--ink)', true)}
        {line(st, 'speed_am', X, h, 80, CHART.sb)}
        {line(st, 'speed_md', X, h, 80, CHART.midday)}
        {line(st, 'speed_pm', X, h, 80, CHART.pm)}
      </>
    ) },
    { key: 'aadt', title: 'AADT', unit: `veh/day · max ${nf(max('aadt'))}`, h: 72, render: (h) => area(st, 'aadt', X, h, max('aadt'), CHART.areaFill) },
    { key: 'truck', title: 'Trucks', unit: '% of AADT', h: 44, render: (h) => area(st, 'truck_pct', X, h, Math.max(20, max('truck_pct')), CHART.truckFill) },
    { key: 'crash', title: 'Ped/bike crashes', unit: 'per mi per yr', h: 72, render: (h) => bars(st, 'crashes_per_mi', X, h, Math.max(1, max('crashes_per_mi')), CHART.critical) },
  ];
  const head = narrow ? 24 : 0;
  let y = 34;
  const layout = strips.map((s) => { const o = { ...s, y: y + head }; y += s.h + head + 26; return o; });
  const H = y + 14;

  // milepost ticks every 5 corridor-miles, DFO labels at route changes
  const every = Math.max(4, Math.ceil(st.length / Math.max(2, Math.floor((W - L - R) / 64))));
  const ticks = st.map((s, i) => ({ s, i })).filter(({ i }) => i % every === 0);
  const routeBreaks = st.map((s, i) => ({ s, i })).filter(({ s, i }) => i === 0 || s.route !== st[i - 1].route);

  return (
    <div className="page corridor" ref={reveal}>
      <header className="page-head">
        <h1 data-r="1">{cor.data?.name ?? 'Corridor'}</h1>
        <p data-r="2">Lanes, speeds, volume, trucks and ped/bike crashes (CRIS 2021–2023) every quarter mile on one DFO axis.</p>
      </header>

      <nav className="cor-tabs" aria-label="Corridors" data-r="3">
        {(list.data ?? []).map((c, k) => (
          <button key={c.id} style={{ '--i': k } as React.CSSProperties} aria-pressed={c.id === id} onClick={() => { setHov(null); setPin(null); nav(`/corridors/${c.id}`); }}>
            <span>{c.name.split(' (')[0]}</span>
            <small className="num">{nf(c.len_mi, 1)} mi · {nf(c.summary.crashes_per_yr, 1)} / yr</small>
          </button>
        ))}
        {list.loading && Array.from({ length: 6 }, (_, k) => <div key={k} className="skeleton cor-tab-sk" aria-hidden="true" />)}
      </nav>
      {list.error && <div className="error-box">Corridor list unavailable: {list.error}</div>}
      {cor.data?.summary.note && <p className="cor-note">{cor.data.summary.note}</p>}
      {cor.error && <div className="error-box">Corridor unavailable: {cor.error} <button type="button" className="btn ghost" onClick={() => location.reload()}>Reload</button></div>}

      <section className="cor-grid">
        <figure className="panel sld" data-ui data-r="4">
          <div className="sld-bar">
            <span className="sld-axis"><Term k="DFO" />, mi</span>
            <span className="sld-hint" aria-hidden="true">
              <span className="sld-hint-kb">{pin != null ? <><kbd>←</kbd><kbd>→</kbd> step <kbd>Esc</kbd> unpin</> : 'Click to pin a station'}</span>
              <span className="sld-hint-touch">{pin != null ? 'Tap again to unpin' : 'Tap to pin a station'}</span>
            </span>
            <button type="button" className="btn ghost" onClick={exportCsv} disabled={!st.length}>Export CSV</button>
          </div>
          <div className="sld-box" ref={figRef}>
            {st.length ? (
              <svg key={id} viewBox={`0 0 ${W} ${H}`} width={W} height={H} onPointerMove={(e) => setHov(indexAt(e))} onPointerLeave={() => setHov(null)}
                onClick={(e) => pick(indexAt(e))} role="img" aria-label={`Straight-line diagram for ${cor.data?.name}; click to pin a station, arrow keys step`}>
                {ticks.map(({ s, i }) => (
                  <g key={i}>
                    <line x1={X(i)} x2={X(i)} y1={24} y2={H - 18} className="sld-grid" />
                    <text x={X(i)} y={16} className="sld-tick" textAnchor={X(i) - L < 22 ? 'start' : W - R - X(i) < 22 ? 'end' : 'middle'}>{s.dfo.toFixed(1)}</text>
                  </g>
                ))}
                {routeBreaks.map(({ s, i }) => <text key={`r${i}`} x={X(i) + 3} y={H - 2} className="sld-route">{s.route.replace('-KG', '')}</text>)}
                {layout.map((s, k) => (
                  <g key={s.key} transform={`translate(0 ${s.y})`}><g className="sld-strip" style={{ animationDelay: `${120 + k * 70}ms` }}>
                    {narrow
                      ? <text x={0} y={-8} className="sld-title">{s.title} <tspan className="sld-unit">{s.unit}</tspan></text>
                      : <><text x={0} y={14} className="sld-title">{s.title}</text><text x={0} y={32} className="sld-unit">{s.unit}</text></>}
                    <line x1={L} x2={W - R} y1={s.h} y2={s.h} className="sld-base" />
                    {s.render(s.h)}
                  </g></g>
                ))}
                {pin != null && <line x1={X(pin)} x2={X(pin)} y1={24} y2={H - 18} className="sld-pin" />}
                {hov != null && hov !== pin && <line x1={X(hov)} x2={X(hov)} y1={24} y2={H - 18} className="sld-cursor" />}
              </svg>
            ) : cor.data ? <p className="muted sld-empty">No inventory stations on this corridor.</p>
              : !cor.error && <div className="skeleton" style={{ height: 420 }} aria-label="Loading diagram" />}
          </div>
          <figcaption className="sld-legend">
            <span><i className="k solid" /> posted</span>
            <span><i className="k" style={{ background: CHART.sb }} /> AM peak</span>
            <span><i className="k" style={{ background: CHART.midday }} /> midday</span>
            <span><i className="k" style={{ background: CHART.pm }} /> PM peak</span>
          </figcaption>
        </figure>

        <aside className="cor-side" data-r="5">
          <div className="panel cor-map" data-ui><MapView label="Corridor alignment with ped/bike crash density, 2021–2023" sources={sources} bounds={bounds} interactiveLayers={['cor-dot']} onClick={(_, f) => setPin(Number((f.properties as any).i))} /></div>
          <div className="panel cor-read" aria-live="polite">
            {at ? (
              <>
                <div className="cor-read-h">
                  <h3 key={cur}>DFO {at.dfo.toFixed(2)} <span className="muted num">{at.route.replace('-KG', '')}</span></h3>
                  {cur === pin && <button type="button" className="cor-x" onClick={() => setPin(null)} aria-label="Unpin station"><Icon name="close" size={16} /></button>}
                </div>
                <dl className="num">
                  <dt>Lanes</dt><dd>{nf(at.lanes)}</dd>
                  <dt>Posted</dt><dd>{nf(at.speed_limit)} mph</dd>
                  <dt>AM / MD / PM</dt><dd>{nf(at.speed_am)} / {nf(at.speed_md)} / {nf(at.speed_pm)}</dd>
                  <dt>AADT</dt><dd>{nf(at.aadt)}</dd>
                  <dt>Trucks</dt><dd>{nf(at.truck_pct, 1)}%</dd>
                  <dt>Ped/bike / mi / yr</dt><dd>{nf(at.crashes_per_mi, 2)}</dd>
                </dl>
                {at.seg_id && <Link to={`/screening?seg=${encodeURIComponent(at.seg_id)}`}>Open in screening</Link>}
              </>
            ) : cor.data ? (
              <dl className="num">
                <dt>Screened segments</dt><dd>{nf(cor.data.summary.segments)}</dd>
                <dt>Ped/bike crashes</dt><dd>{nf(cor.data.summary.crashes_total)} in {cor.data.summary.crash_years} yr</dd>
                <dt>Mean AADT</dt><dd>{nf(cor.data.summary.aadt_mean)}</dd>
                <dt>Peak AADT</dt><dd>{nf(cor.data.summary.aadt_max)}</dd>
                <dt>Mean operating speed</dt><dd>{nf(cor.data.summary.speed_all_mean, 1)} mph</dd>
                <dt>Mean truck share</dt><dd>{nf(cor.data.summary.truck_pct_mean, 1)}%</dd>
              </dl>
            ) : null}
          </div>
        </aside>
      </section>
    </div>
  );
}

type XF = (i: number) => number;
const v = (s: St, k: keyof St) => (s[k] as number | null) ?? null;

function step(st: St[], k: keyof St, X: XF, h: number, max: number, color: string, dashed = false) {
  let d = '', prev: number | null = null;
  st.forEach((s, i) => {
    const val = v(s, k);
    if (val == null) { prev = null; return; }
    const y = h - (val / max) * h;
    d += prev == null ? `M${X(i)},${y}` : `H${X(i)}V${y}`;
    prev = y;
  });
  return <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeDasharray={dashed ? '4 3' : undefined} />;
}
function line(st: St[], k: keyof St, X: XF, h: number, max: number, color: string) {
  let d = '';
  st.forEach((s, i) => { const val = v(s, k); if (val == null) return; d += `${d && st[i - 1] && v(st[i - 1], k) != null ? 'L' : 'M'}${X(i)},${h - (val / max) * h}`; });
  return <path d={d} fill="none" stroke={color} strokeWidth={1.4} />;
}
function area(st: St[], k: keyof St, X: XF, h: number, max: number, color: string) {
  const w = (X(1) - X(0)) * 1.02;
  return <g>{st.map((s, i) => { const val = v(s, k); if (!val) return null; const bh = (val / max) * h; return <rect key={i} x={X(i) - w / 2} y={h - bh} width={w} height={bh} fill={color} />; })}</g>;
}
function bars(st: St[], k: keyof St, X: XF, h: number, max: number, color: string) {
  const w = Math.max(1.5, (X(1) - X(0)) * 0.7);
  return <g>{st.map((s, i) => { const val = v(s, k); if (!val) return null; const bh = Math.min(h, (val / max) * h); return <rect key={i} x={X(i) - w / 2} y={h - bh} width={w} height={bh} fill={color} />; })}</g>;
}
