import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import MapView, { type MapLayer } from '../components/MapView';
import { useApi } from '../lib/api';
import { nf } from '../lib/format';
import '../styles/corridor.css';

interface St { dfo: number; route: string; lon: number; lat: number; lanes: number | null; speed_limit: number | null; aadt: number | null; truck_pct: number | null; speed_all: number | null; speed_am: number | null; speed_md: number | null; speed_pm: number | null; crashes_per_mi: number | null; seg_id?: string }
interface CorridorT { id: string; name: string; routes: string[]; len_mi: number; stations: St[]; summary: { segments: number; crashes_per_yr: number; crashes_total: number; crash_years: number; aadt_mean: number; aadt_max: number; speed_all_mean: number; truck_pct_mean: number; bbox: number[]; top_segment: string | null; note: string | null } }
type Card = Omit<CorridorT, 'stations'> & { n_stations: number };

const W = 1000, L = 132, R = 16;

export default function CorridorPage() {
  const { id = 'us-84' } = useParams();
  const nav = useNavigate();
  const list = useApi<Card[]>('/corridors');
  const cor = useApi<CorridorT>(`/corridors/${id}`);
  const [cur, setCur] = useState<number | null>(null);
  const st = cor.data?.stations ?? [];
  const X = (i: number) => L + (i / Math.max(1, st.length - 1)) * (W - L - R);
  const at = cur != null ? st[cur] : null;

  const sources = useMemo<MapLayer[]>(() => {
    if (!st.length) return [];
    const line = { type: 'FeatureCollection' as const, features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: st.map((s) => [s.lon, s.lat]) } }] };
    const dots = { type: 'FeatureCollection' as const, features: st.map((s, i) => ({ type: 'Feature', properties: { i, c: s.crashes_per_mi ?? 0 }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })) };
    const marker = { type: 'FeatureCollection' as const, features: at ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [at.lon, at.lat] } }] : [] };
    return [
      { id: 'cor', data: line as any, layers: [{ id: 'cor-line', type: 'line', paint: { 'line-color': '#14171a', 'line-width': 2.5 } } as any] },
      { id: 'cor-dots', data: dots as any, layers: [{ id: 'cor-dot', type: 'circle', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'c'], 0, 1.5, 8, 7], 'circle-color': '#b3261e', 'circle-opacity': ['case', ['>', ['get', 'c'], 0], 0.75, 0] } } as any] },
      { id: 'cor-mk', data: marker as any, layers: [{ id: 'cor-mk-c', type: 'circle', paint: { 'circle-radius': 7, 'circle-color': '#c98a00', 'circle-stroke-color': '#14171a', 'circle-stroke-width': 2 } } as any] },
    ];
  }, [st, at]);

  const bbox = cor.data?.summary.bbox;
  const bounds = bbox ? ([[bbox[0], bbox[1]], [bbox[2], bbox[3]]] as [[number, number], [number, number]]) : undefined;

  const pointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((x - L) / (W - L - R)) * (st.length - 1));
    setCur(i >= 0 && i < st.length ? i : null);
  };

  const max = (k: keyof St) => Math.max(1, ...st.map((s) => (s[k] as number) ?? 0));
  const strips: { key: string; title: string; unit: string; h: number; render: (h: number) => React.ReactNode }[] = [
    { key: 'lanes', title: 'Through lanes', unit: 'count', h: 46, render: (h) => step(st, 'lanes', X, h, 8, 'var(--ink)') },
    { key: 'speed', title: 'Speed', unit: 'mph · posted vs 2024 operating', h: 92, render: (h) => (
      <>
        {step(st, 'speed_limit', X, h, 80, 'var(--ink)', true)}
        {line(st, 'speed_am', X, h, 80, '#46617a')}
        {line(st, 'speed_md', X, h, 80, '#5b6b4d')}
        {line(st, 'speed_pm', X, h, 80, '#c98a00')}
      </>
    ) },
    { key: 'aadt', title: 'AADT', unit: `veh/day · max ${nf(max('aadt'))}`, h: 72, render: (h) => area(st, 'aadt', X, h, max('aadt'), '#c5cac2') },
    { key: 'truck', title: 'Trucks', unit: '% of AADT', h: 46, render: (h) => area(st, 'truck_pct', X, h, Math.max(20, max('truck_pct')), '#d9c79a') },
    { key: 'crash', title: 'Ped/bike crash density', unit: 'ped/bike crashes / mi / yr (2021–23)', h: 72, render: (h) => bars(st, 'crashes_per_mi', X, h, Math.max(1, max('crashes_per_mi')), '#b3261e') },
  ];
  let y = 26;
  const layout = strips.map((s) => { const o = { ...s, y }; y += s.h + 22; return o; });
  const H = y + 6;

  // milepost ticks every 5 corridor-miles, DFO labels at route changes
  const ticks = st.map((s, i) => ({ s, i })).filter(({ i }) => i % 20 === 0);
  const routeBreaks = st.map((s, i) => ({ s, i })).filter(({ s, i }) => i === 0 || s.route !== st[i - 1].route);

  return (
    <div className="page corridor">
      <header className="page-head">
        <h1>{cor.data?.name ?? 'Corridor'}</h1>
        <p>
          Straight-line diagram along the TxDOT distance-from-origin (DFO) reference, stationed every quarter mile: geometry, posted and 2024 operating speeds by period,
          volume, heavy-vehicle share and on-system pedestrian/cyclist crash density (TxDOT CRIS, 2021–2023) on one axis, so a ped/bike crash cluster can be read against what the road is doing at that point.
        </p>
      </header>

      <nav className="cor-tabs" aria-label="Corridors">
        {(list.data ?? []).map((c) => (
          <button key={c.id} aria-pressed={c.id === id} onClick={() => { setCur(null); nav(`/corridors/${c.id}`); }}>
            <span>{c.name.split(' (')[0]}</span>
            <small className="num">{nf(c.len_mi, 1)} mi · {nf(c.summary.crashes_per_yr, 1)} ped/bike/yr</small>
          </button>
        ))}
      </nav>
      {cor.data?.summary.note && <p className="cor-note">{cor.data.summary.note}</p>}
      {cor.error && <div className="error-box">{cor.error}</div>}

      <section className="cor-grid">
        <figure className="panel sld">
          {st.length ? (
            <svg viewBox={`0 0 ${W} ${H}`} onPointerMove={pointer} onPointerLeave={() => setCur(null)} role="img" aria-label={`Straight-line diagram for ${cor.data?.name}`}>
              {ticks.map(({ s, i }) => (
                <g key={i}>
                  <line x1={X(i)} x2={X(i)} y1={18} y2={H} className="sld-grid" />
                  <text x={X(i)} y={12} className="sld-tick" textAnchor="middle">{s.dfo.toFixed(1)}</text>
                </g>
              ))}
              {routeBreaks.map(({ s, i }) => <text key={`r${i}`} x={X(i) + 3} y={H - 2} className="sld-route">{s.route.replace('-KG', '')}</text>)}
              {layout.map((s) => (
                <g key={s.key} transform={`translate(0 ${s.y})`}>
                  <text x={0} y={12} className="sld-title">{s.title}</text>
                  <text x={0} y={26} className="sld-unit">{s.unit}</text>
                  <line x1={L} x2={W - R} y1={s.h} y2={s.h} className="sld-base" />
                  {s.render(s.h)}
                </g>
              ))}
              {cur != null && <line x1={X(cur)} x2={X(cur)} y1={18} y2={H - 12} className="sld-cursor" />}
            </svg>
          ) : <div className="skeleton" style={{ height: 420 }} />}
          <figcaption className="sld-legend">
            <span><i className="k solid" /> posted limit</span>
            <span><i className="k" style={{ background: '#46617a' }} /> AM peak</span>
            <span><i className="k" style={{ background: '#5b6b4d' }} /> midday</span>
            <span><i className="k" style={{ background: '#c98a00' }} /> PM peak</span>
            <span className="muted">Top axis: DFO (mi). Operating speeds: TxDOT Statewide Speed 2024, average weekday.</span>
          </figcaption>
        </figure>

        <aside className="cor-side">
          <div className="panel cor-map"><MapView label="Corridor alignment with ped/bike crash density, 2021–2023" sources={sources} bounds={bounds} /></div>
          <div className="panel cor-read" aria-live="polite">
            {at ? (
              <>
                <h3>DFO {at.dfo.toFixed(2)} <span className="muted num">{at.route.replace('-KG', '')}</span></h3>
                <dl className="num">
                  <dt>Lanes</dt><dd>{nf(at.lanes)}</dd>
                  <dt>Posted</dt><dd>{nf(at.speed_limit)} mph</dd>
                  <dt>Operating AM / MD / PM</dt><dd>{nf(at.speed_am)} / {nf(at.speed_md)} / {nf(at.speed_pm)}</dd>
                  <dt>AADT</dt><dd>{nf(at.aadt)}</dd>
                  <dt>Trucks</dt><dd>{nf(at.truck_pct, 1)}%</dd>
                  <dt>Ped/bike crashes / mi / yr</dt><dd>{nf(at.crashes_per_mi, 2)}</dd>
                </dl>
                {at.seg_id && <Link to={`/screening?seg=${encodeURIComponent(at.seg_id)}`}>See this segment in the screening</Link>}
              </>
            ) : cor.data ? (
              <dl className="num">
                <dt>Screened segments</dt><dd>{nf(cor.data.summary.segments)}</dd>
                <dt>Ped/bike crashes</dt><dd>{nf(cor.data.summary.crashes_total)} / {cor.data.summary.crash_years} yr (2021–23)</dd>
                <dt>Mean AADT</dt><dd>{nf(cor.data.summary.aadt_mean)}</dd>
                <dt>Peak AADT</dt><dd>{nf(cor.data.summary.aadt_max)}</dd>
                <dt>Mean operating speed</dt><dd>{nf(cor.data.summary.speed_all_mean, 1)} mph</dd>
                <dt>Mean truck share</dt><dd>{nf(cor.data.summary.truck_pct_mean, 1)}%</dd>
              </dl>
            ) : null}
            {!at && <p className="muted hint">Move across the diagram to read any station.</p>}
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
