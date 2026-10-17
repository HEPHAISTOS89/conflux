import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import MapView, { type MapLayer } from '../components/MapView';
import { Icon } from '../components/Icon';
import Term from '../components/Term';
import PageHeader from '../components/PageHeader';
import MetricInfo, { ProvChip, type MetricSpec } from '../components/MetricInfo';
import { useApi } from '../lib/api';
import { copyLink, downloadCSV, downloadPNG } from '../lib/export';
import { CHART, nf } from '../lib/format';
import { useReveal } from '../lib/motion';
import '../styles/corridor.css';

interface St { dfo: number; route: string; lon: number; lat: number; lanes: number | null; speed_limit: number | null; aadt: number | null; truck_pct: number | null; speed_all: number | null; speed_am: number | null; speed_md: number | null; speed_pm: number | null; crashes_per_mi: number | null; seg_id?: string | null }
interface CorridorT { id: string; name: string; routes: string[]; len_mi: number; stations: St[]; summary: { segments: number; crashes_per_yr: number; crashes_total: number; crash_years: number; aadt_mean: number; aadt_max: number; speed_all_mean: number; truck_pct_mean: number; bbox: number[]; top_segment: string | null; note: string | null } }
type Card = Omit<CorridorT, 'stations'> & { n_stations: number };

const INV = 'TxDOT Roadway Inventory 2024 (lanes, posted speed), sampled every 0.25 mi on DFO';
const SPECS: Record<'density' | 'aadt' | 'speed' | 'rho', MetricSpec> = {
  density: {
    name: 'Ped/bike crash density', provenance: 'derived', unit: 'crashes per mile per year',
    formula: <>d = N / (L · Y), N = CRIS ped/bike crashes on the one-mile segment, Y = 3</>,
    threshold: 'none; descriptive. Stations inherit the density of the screened segment that contains them.',
    source: 'TxDOT CRIS on-system ped/bike crashes 2021–2023, joined to segments by route and DFO',
    citation: <>AASHTO <i>Highway Safety Manual</i> (2010), Part B §4.4 (crash frequency)</>,
  },
  aadt: {
    name: 'Annual average daily traffic', provenance: 'public', unit: 'vehicles per day',
    formula: 'TxDOT_AADT.AADT_CUR nearest count station on the route, per 0.25 mi station',
    source: 'TxDOT AADT annuals, © TxDOT, informational use', citation: 'FHWA Traffic Monitoring Guide (2022)',
  },
  speed: {
    name: 'Operating speed', provenance: 'public', unit: 'mph',
    formula: 'Segment mean speed from the TxDOT Statewide Speed 2024 layer; AM, midday and PM periods as published',
    threshold: 'compared against the posted limit from the roadway inventory',
    source: <>TxDOT Statewide Speed 2024; {INV}</>,
    citation: 'NCHRP Report 504, Design Speed, Operating Speed, and Posted Speed Practices (2003)',
  },
  rho: {
    name: 'Spearman rank correlation', provenance: 'derived', unit: 'ρ, −1 to 1',
    formula: <>ρ = Pearson r of the ranks (average ranks for ties)</>,
    threshold: 'descriptive only: stations within one segment share a crash value, so they are not independent',
    source: 'Stations with both an operating speed and a crash density',
    citation: 'Spearman (1904)',
  },
};

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

const typing = (e: KeyboardEvent) => e.metaKey || e.ctrlKey || e.altKey || !!(e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable], [role="listbox"]') || !!document.querySelector('.cmdk-scrim');
const route = (r: string) => r.replace('-KG', '').replace(/^([A-Z]{2})0*/, '$1 ');

/** Average ranks (ties share the mean rank), then Pearson r of the ranks. */
function spearman(xs: number[], ys: number[]) {
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const n = xs.length;
  if (n < 3) return null;
  const a = rank(xs), b = rank(ys);
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : null;
}

export default function CorridorPage() {
  const { id = 'us-84' } = useParams();
  const nav = useNavigate();
  const list = useApi<Card[]>('/corridors');
  const cor = useApi<CorridorT>(`/corridors/${id}`);
  const [hov, setHov] = useState<number | null>(null);
  const [pin, setPin] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(t); }, [copied]);
  const cur = hov ?? pin;
  const [figRef, W] = useWidth<HTMLDivElement>(900);
  const sldRef = useRef<HTMLDivElement>(null);
  const reveal = useReveal<HTMLDivElement>();
  const narrow = W < 620;
  const L = narrow ? 0 : 168, R = 8;
  const st = useMemo(() => cor.data?.stations ?? [], [cor.data]);
  const X = (i: number) => L + (i / Math.max(1, st.length - 1)) * (W - L - R);
  const at = cur != null ? st[cur] : null;
  const pinned = pin != null ? st[pin] : null;
  const hovered = hov != null && hov !== pin ? st[hov] : null;

  const stats = useMemo(() => {
    const s = cor.data?.summary;
    let worst = -1;
    st.forEach((x, i) => { if ((x.crashes_per_mi ?? 0) > (worst < 0 ? 0 : st[worst].crashes_per_mi ?? 0)) worst = i; });
    const both = st.filter((x) => x.speed_all != null && x.speed_limit != null);
    const mean = (f: (x: St) => number) => (both.length ? both.reduce((a, x) => a + f(x), 0) / both.length : null);
    return {
      density: s && s.segments ? s.crashes_per_yr / s.segments : null,
      worst: worst >= 0 ? worst : null,
      op: mean((x) => x.speed_all!), posted: mean((x) => x.speed_limit!), nBoth: both.length,
    };
  }, [st, cor.data]);
  const worstSt = stats.worst != null ? st[stats.worst] : null;

  const sources = useMemo<MapLayer[]>(() => {
    if (!st.length) return [];
    const line = { type: 'FeatureCollection' as const, features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: st.map((s) => [s.lon, s.lat]) } }] };
    const dots = { type: 'FeatureCollection' as const, features: st.map((s, i) => ({ type: 'Feature', properties: { i, c: s.crashes_per_mi ?? 0 }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })) };
    const pt = (s: St, kind: string) => ({ type: 'Feature', properties: { kind }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } });
    const marker = { type: 'FeatureCollection' as const, features: [...(pinned ? [pt(pinned, 'pin')] : []), ...(hovered ? [pt(hovered, 'hov')] : [])] };
    return [
      { id: 'cor', data: line as any, layers: [{ id: 'cor-line', type: 'line', paint: { 'line-color': CHART.ink, 'line-width': 2.5 } } as any] },
      { id: 'cor-dots', data: dots as any, layers: [{ id: 'cor-dot', type: 'circle', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'c'], 0, 1.5, 3, 8], 'circle-color': CHART.critical, 'circle-opacity': ['case', ['>', ['get', 'c'], 0], 0.75, 0] } } as any] },
      { id: 'cor-mk', data: marker as any, layers: [{ id: 'cor-mk-c', type: 'circle', paint: { 'circle-radius': ['match', ['get', 'kind'], 'pin', 8, 6], 'circle-color': ['match', ['get', 'kind'], 'pin', CHART.accent, CHART.ink], 'circle-stroke-color': CHART.ground, 'circle-stroke-width': 2 } } as any] },
    ];
  }, [st, pinned, hovered]);

  const bbox = cor.data?.summary.bbox;
  const bounds = useMemo(() => (bbox ? ([[bbox[0], bbox[1]], [bbox[2], bbox[3]]] as [[number, number], [number, number]]) : undefined), [bbox]);

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
      else if (e.key === 'Escape' && !document.querySelector('.term-tip, .mi-pop')) setPin(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pin, st.length]);

  const exportCsv = () => downloadCSV(`roadscope-corridor-${id}-stations.csv`, st.map((s) => ({
    route: s.route, dfo_mi: s.dfo, lon: s.lon, lat: s.lat, lanes: s.lanes, speed_limit_mph: s.speed_limit, speed_all_mph: s.speed_all, speed_am_mph: s.speed_am,
    speed_md_mph: s.speed_md, speed_pm_mph: s.speed_pm, aadt: s.aadt, truck_pct: s.truck_pct, pedbike_crashes_per_mi_yr: s.crashes_per_mi, seg_id: s.seg_id,
  })));
  const exportSld = () => sldRef.current && downloadPNG(`roadscope-corridor-${id}-sld.png`, sldRef.current,
    `${name.split(' (')[0]} SLD · dashed = posted · TxDOT Inventory, AADT, Speed 2024 · CRIS 2021–23`);
  const share = async () => setCopied(await copyLink());

  const max = (k: keyof St) => Math.max(1, ...st.map((s) => (s[k] as number) ?? 0));
  const crashMax = Math.max(1, max('crashes_per_mi'));
  const strips: { key: string; title: string; unit: string; h: number; render: (h: number) => React.ReactNode }[] = [
    { key: 'lanes', title: 'Through lanes', unit: 'count', h: 40, render: (h) => step(st, 'lanes', X, h, 8, 'var(--ink)') },
    { key: 'speed', title: 'Speed', unit: 'mph, 2024', h: 92, render: (h) => (
      <>
        {[40, 80].map((t) => <g key={t}><line x1={L} x2={W - R} y1={h - (t / 80) * h} y2={h - (t / 80) * h} className="sld-grid" />{!narrow && <text x={L - 6} y={h - (t / 80) * h + 4} textAnchor="end" className="sld-tick">{t}</text>}</g>)}
        {step(st, 'speed_limit', X, h, 80, 'var(--ink)', true)}
        {line(st, 'speed_am', X, h, 80, CHART.sb)}
        {line(st, 'speed_md', X, h, 80, CHART.midday)}
        {line(st, 'speed_pm', X, h, 80, CHART.pm)}
      </>
    ) },
    { key: 'aadt', title: 'AADT', unit: `veh/day · max ${nf(max('aadt'))}`, h: 72, render: (h) => area(st, 'aadt', X, h, max('aadt'), CHART.areaFill) },
    { key: 'truck', title: 'Trucks', unit: '% of AADT', h: 44, render: (h) => area(st, 'truck_pct', X, h, Math.max(20, max('truck_pct')), CHART.truckFill) },
    { key: 'crash', title: 'Ped/bike crashes', unit: 'per mi per yr', h: 72, render: (h) => (
      <>
        {bars(st, 'crashes_per_mi', X, h, crashMax, CHART.critical)}
        {stats.worst != null && worstSt && (() => {
          const x = X(stats.worst), right = x > W * 0.7;
          return (
            <g className="sld-ann">
              {!narrow && <line x1={x} x2={x} y1={-6} y2={h - Math.min(h, ((worstSt.crashes_per_mi ?? 0) / crashMax) * h) - 2} />}
              <text x={x + (right ? -6 : 6)} y={narrow ? h + 15 : -8} textAnchor={right ? 'end' : 'start'}>max {nf(worstSt.crashes_per_mi, 2)} · DFO {worstSt.dfo.toFixed(2)}</text>
            </g>
          );
        })()}
      </>
    ) },
  ];
  const head = narrow ? 24 : 0;
  let y = 34;
  const layout = strips.map((s) => { const o = { ...s, y: y + head + (s.key === 'crash' ? 12 : 0) }; y += s.h + head + 26 + (s.key === 'crash' ? 12 : 0); return o; });
  const H = y + 14;

  const every = Math.max(4, Math.ceil(st.length / Math.max(2, Math.floor((W - L - R) / 64))));
  const ticks = st.map((s, i) => ({ s, i })).filter(({ i }) => i % every === 0);
  const routeBreaks = st.map((s, i) => ({ s, i })).filter(({ s, i }) => i === 0 || s.route !== st[i - 1].route);
  const name = cor.data?.name ?? 'Corridor';

  return (
    <div className="page corridor" ref={reveal}>
      <PageHeader
        icon="corridor"
        title={name.split(' (')[0]}
        lede={<>{name.includes('(') ? `${name.split(' (')[1].replace(')', '')}: ` : ''}lanes, speeds, volume, trucks and ped/bike crashes every quarter mile on one <Term k="DFO" /> axis.</>}
        source={<>Roadway Inventory 2024 · AADT · Statewide Speed 2024 · CRIS 2021–2023 · <ProvChip kind="public" /></>}
        readouts={[
          { label: <span className="rd-l">Crash density <MetricInfo spec={SPECS.density} align="right" /></span>, value: stats.density, unit: '/mi/yr', digits: 2, tone: 'alert' },
          { label: <span className="rd-l">Worst DFO</span>, value: worstSt?.dfo ?? null, unit: worstSt ? `${route(worstSt.route)} · ${nf(worstSt.crashes_per_mi, 2)}/mi/yr` : undefined, digits: 2 },
          { label: <span className="rd-l">Operating speed <MetricInfo spec={SPECS.speed} align="right" /></span>, value: stats.op, unit: stats.posted != null ? `mph · ${nf(stats.posted, 0)} posted` : 'mph', digits: 1, tone: stats.op != null && stats.posted != null && stats.op > stats.posted ? 'alert' : undefined },
        ]}
        actions={<>
          <button type="button" className="btn ghost" onClick={exportCsv} disabled={!st.length}><Icon name="download" size={16} /><span>CSV</span></button>
          <button type="button" className="btn ghost" onClick={exportSld} disabled={!st.length}><Icon name="image" size={16} /><span>PNG</span></button>
          <button type="button" className="btn ghost" onClick={share} aria-live="polite"><Icon name={copied ? 'check' : 'link'} size={16} /><span>{copied ? 'Copied' : 'Link'}</span></button>
        </>}
      />

      <nav className="cor-tabs" aria-label="Corridors">
        {(list.data ?? []).map((c, k) => (
          <button key={c.id} style={{ '--i': k } as React.CSSProperties} aria-pressed={c.id === id} onClick={() => { setHov(null); setPin(null); nav(`/corridors/${c.id}`); }}>
            <span>{c.name.split(' (')[0]}</span>
            <small className="measure">{nf(c.len_mi, 1)} mi · {nf(c.summary.crashes_per_yr, 1)}/yr</small>
          </button>
        ))}
        {list.loading && Array.from({ length: 7 }, (_, k) => <div key={k} className="skeleton cor-tab-sk" aria-hidden="true" />)}
      </nav>
      {list.error && <div className="error-box">Corridor list unavailable: {list.error}</div>}
      {cor.data?.summary.note && <p className="cor-note"><Icon name="warning" size={16} />{cor.data.summary.note}</p>}
      {cor.error && <div className="error-box">Corridor unavailable: {cor.error} <button type="button" className="btn ghost" onClick={() => location.reload()}>Reload</button></div>}

      <section className="cor-grid">
        <figure className="panel sld" data-ui data-r="4">
          <div className="sld-bar">
            <span className="sld-axis"><Icon name="sign" size={16} /><span><Term k="DFO" />, mi</span></span>
            <span className="sld-hint" aria-hidden="true">
              <span className="sld-hint-kb">{pin != null ? <><kbd>←</kbd><kbd>→</kbd> step <kbd>Esc</kbd> unpin</> : 'Click to pin a station'}</span>
              <span className="sld-hint-touch">{pin != null ? 'Tap again to unpin' : 'Tap to pin a station'}</span>
            </span>
          </div>
          <div className="sld-box" ref={(el) => { figRef.current = el; sldRef.current = el; }}>
            {st.length ? (
              <svg key={id} viewBox={`0 0 ${W} ${H}`} width={W} height={H} onPointerMove={(e) => setHov(indexAt(e))} onPointerLeave={() => setHov(null)}
                onClick={(e) => pick(indexAt(e))} role="img" aria-label={`Straight-line diagram for ${name}; click to pin a station, arrow keys step`}>
                {ticks.map(({ s, i }) => (
                  <g key={i}>
                    <line x1={X(i)} x2={X(i)} y1={24} y2={H - 18} className="sld-grid" />
                    <text x={X(i)} y={16} className="sld-tick" textAnchor={X(i) - L < 22 ? 'start' : W - R - X(i) < 22 ? 'end' : 'middle'}>{s.dfo.toFixed(1)}</text>
                  </g>
                ))}
                {routeBreaks.map(({ s, i }) => <text key={`r${i}`} x={X(i) + 3} y={H - 2} className="sld-route">{route(s.route)}</text>)}
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
                {cur != null && st[cur] && (() => {
                  const x = X(cur), right = x > W - 90;
                  return <text x={x + (right ? -5 : 5)} y={36} textAnchor={right ? 'end' : 'start'} className="sld-cur-l">{st[cur].dfo.toFixed(2)}</text>;
                })()}
              </svg>
            ) : cor.data ? <p className="muted sld-empty">No inventory stations on this corridor.</p>
              : !cor.error && <div className="skeleton" style={{ height: 420 }} aria-label="Loading diagram" />}
          </div>
          <figcaption className="sld-legend">
            <span><i className="k solid" /> posted</span>
            <span><i className="k" style={{ background: CHART.sb }} /> AM peak</span>
            <span><i className="k" style={{ background: CHART.midday }} /> midday</span>
            <span><i className="k" style={{ background: CHART.pm }} /> PM peak</span>
            <span className="sld-legend-mi"><Term k="AADT" /><MetricInfo spec={SPECS.aadt} /> Crash density<MetricInfo spec={SPECS.density} align="right" /></span>
          </figcaption>
        </figure>

        <aside className="cor-side" data-r="5">
          <div className="panel cor-map" data-ui><MapView label={`${name} alignment with ped/bike crash density, 2021–2023`} sources={sources} bounds={bounds} interactiveLayers={['cor-dot']} onClick={(_, f) => setPin(Number((f.properties as any).i))} /></div>
          <div className="panel cor-read" aria-live="polite">
            {at ? (
              <>
                <div className="cor-read-h">
                  <h3 key={cur}><span className="measure">DFO {at.dfo.toFixed(2)}</span> <span className="muted">{route(at.route)}</span></h3>
                  {cur === pin && <button type="button" className="cor-x" onClick={() => setPin(null)} aria-label="Unpin station"><Icon name="close" size={16} /></button>}
                </div>
                <dl>
                  <dt>Lanes</dt><dd className="measure">{nf(at.lanes)}</dd>
                  <dt>Posted</dt><dd className="measure">{nf(at.speed_limit)} mph</dd>
                  <dt>AM / MD / PM</dt><dd className="measure">{nf(at.speed_am)} / {nf(at.speed_md)} / {nf(at.speed_pm)} mph</dd>
                  <dt><Term k="AADT" /></dt><dd className="measure">{nf(at.aadt)} veh/d</dd>
                  <dt>Trucks</dt><dd className="measure">{nf(at.truck_pct, 1)}%</dd>
                  <dt>Ped/bike crashes</dt><dd className="measure" data-hi={(at.crashes_per_mi ?? 0) > 0 || undefined}>{nf(at.crashes_per_mi, 2)} /mi/yr</dd>
                </dl>
                {at.seg_id && <Link className="cor-link" to={`/screening?seg=${encodeURIComponent(at.seg_id)}`}><Icon name="rank" size={16} />Open in screening</Link>}
              </>
            ) : cor.data ? (
              <>
                <h3>Corridor summary</h3>
                <dl>
                  <dt>Screened segments</dt><dd className="measure">{nf(cor.data.summary.segments)}</dd>
                  <dt>Ped/bike crashes</dt><dd className="measure">{nf(cor.data.summary.crashes_total)} in {cor.data.summary.crash_years} yr</dd>
                  <dt>Mean <Term k="AADT" /></dt><dd className="measure">{nf(cor.data.summary.aadt_mean)} veh/d</dd>
                  <dt>Peak AADT</dt><dd className="measure">{nf(cor.data.summary.aadt_max)} veh/d</dd>
                  <dt>Mean truck share</dt><dd className="measure">{nf(cor.data.summary.truck_pct_mean, 1)}%</dd>
                </dl>
                <p className="muted cor-tip">Hover the diagram or the scatter to read a station.</p>
              </>
            ) : null}
          </div>
        </aside>
      </section>

      <section className="section cor-sc-sec" aria-labelledby="sc-h">
        <div className="cor-sec-h">
          <h2 id="sc-h"><Icon name="gauge" size={22} />Where speed and crashes coincide</h2>
          <p>Each quarter-mile station: operating speed against ped/bike crash density, with the posted limit as reference. Linked to the diagram above.</p>
        </div>
        {st.length ? <SpeedScatter st={st} cur={cur} pin={pin} onHover={setHov} onPick={pick} id={id} name={name} /> : !cor.error && <div className="skeleton" style={{ height: 380 }} aria-label="Loading scatter" />}
      </section>
    </div>
  );
}

/** Operating speed (or its difference from the posted limit) against crash density, one dot per station. */
function SpeedScatter({ st, cur, pin, onHover, onPick, id, name }: { st: St[]; cur: number | null; pin: number | null; onHover: (i: number | null) => void; onPick: (i: number | null) => void; id: string; name: string }) {
  const [ref, W] = useWidth<HTMLDivElement>(900);
  const box = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'abs' | 'delta'>('abs');
  const pts = st.map((s, i) => ({ s, i })).filter(({ s }) => s.speed_all != null && s.crashes_per_mi != null && s.speed_limit != null);
  const xv = (s: St) => (mode === 'abs' ? s.speed_all! : s.speed_all! - s.speed_limit!);
  const rho = spearman(pts.map(({ s }) => xv(s)), pts.map(({ s }) => s.crashes_per_mi!));
  const xsAll = pts.flatMap(({ s }) => (mode === 'abs' ? [s.speed_all!, s.speed_limit!] : [xv(s), 0]));
  const x0 = Math.floor((Math.min(...xsAll) - 3) / 5) * 5, x1 = Math.ceil((Math.max(...xsAll) + 3) / 5) * 5;
  const ymax = Math.max(1, ...pts.map(({ s }) => s.crashes_per_mi!)) * 1.12;
  const H = Math.round(Math.min(400, Math.max(280, W * 0.42)));
  const P = { l: 54, r: 18, t: 22, b: 46 };
  const X = (v: number) => P.l + ((v - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
  const Y = (v: number) => P.t + (1 - v / ymax) * (H - P.t - P.b);
  const xt: number[] = []; for (let v = x0; v <= x1; v += (x1 - x0) > 40 ? 10 : 5) xt.push(v);
  const yt = [0, ymax / 1.12 / 2, ymax / 1.12];
  const above = pts.filter(({ s }) => s.speed_all! > s.speed_limit!).length;
  const active = cur != null ? pts.find((p) => p.i === cur) : undefined;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * W, my = ((e.clientY - r.top) / r.height) * H;
    let best: number | null = null, d = 24 * 24;
    for (const p of pts) { const dd = (X(xv(p.s)) - mx) ** 2 + (Y(p.s.crashes_per_mi!) - my) ** 2; if (dd < d) { d = dd; best = p.i; } }
    onHover(best);
  };
  const save = () => box.current && downloadPNG(`roadscope-corridor-${id}-speed-crash.png`, box.current,
    `${name.split(' (')[0]}: speed vs ped/bike crash density, 0.25-mi stations · TxDOT Speed 2024 · CRIS 2021–23`);
  if (!pts.length) return <p className="muted">No station has both an operating speed and a crash density on this corridor.</p>;
  const posted = [...new Set(pts.map(({ s }) => s.speed_limit!))].sort((a, b) => a - b);
  return (
    <div className="panel sc">
      <div className="sc-bar">
        <div className="seg" role="group" aria-label="Horizontal axis">
          <button aria-pressed={mode === 'abs'} onClick={() => setMode('abs')}>Operating speed</button>
          <button aria-pressed={mode === 'delta'} onClick={() => setMode('delta')}>Operating − posted</button>
        </div>
        <span className="sc-stat">ρ <b className="measure">{rho == null ? '—' : rho.toFixed(2)}</b><MetricInfo spec={SPECS.rho} /> <span className="muted">n = {pts.length} stations · {above} above posted</span></span>
        <button type="button" className="btn ghost" onClick={save}><Icon name="image" size={16} /><span>PNG</span></button>
      </div>
      <div ref={box}>
        <div ref={ref}>
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" onPointerMove={onMove} onPointerLeave={() => onHover(null)} onClick={() => active && onPick(active.i)}
            aria-label={`Scatter of ${pts.length} stations: ${mode === 'abs' ? 'operating speed' : 'operating minus posted speed'} against ped/bike crash density; Spearman rho ${rho?.toFixed(2) ?? 'n/a'}`}>
            {xt.map((v) => <g key={v}><line x1={X(v)} x2={X(v)} y1={P.t} y2={H - P.b} className="sc-grid" /><text x={X(v)} y={H - P.b + 18} textAnchor="middle" className="sc-tick">{mode === 'delta' && v > 0 ? `+${v}` : v}</text></g>)}
            {yt.map((v) => <g key={v}><line x1={P.l} x2={W - P.r} y1={Y(v)} y2={Y(v)} className="sc-grid" /><text x={P.l - 8} y={Y(v) + 4} textAnchor="end" className="sc-tick">{v === 0 ? '0' : v.toFixed(v < 1 ? 2 : 1)}</text></g>)}
            {mode === 'abs'
              ? posted.map((p) => <g key={p}><line x1={X(p)} x2={X(p)} y1={P.t} y2={H - P.b} className="sc-posted" />{W >= 640 && <text x={X(p) + 3} y={P.t + 10} className="sc-posted-l">{p}</text>}</g>)
              : <g><line x1={X(0)} x2={X(0)} y1={P.t} y2={H - P.b} className="sc-zero" /><text x={X(0) + 5} y={P.t + 10} className="sc-posted-l">posted limit</text></g>}
            {pts.map(({ s, i }) => {
              const hit = (s.crashes_per_mi ?? 0) > 0;
              return <circle key={i} cx={X(xv(s))} cy={Y(s.crashes_per_mi!)} r={hit ? 4.5 : 3} className="sc-dot" data-hit={hit || undefined} data-over={s.speed_all! > s.speed_limit! || undefined} data-pin={i === pin || undefined} />;
            })}
            {active && (() => {
              const s = active.s, cx = X(xv(s)), cy = Y(s.crashes_per_mi!), right = cx > W * 0.62;
              return (
                <g className="sc-active">
                  {mode === 'abs' && <line x1={X(s.speed_limit!)} x2={cx} y1={cy} y2={cy} className="sc-gap" />}
                  {mode === 'abs' && <line x1={X(s.speed_limit!)} x2={X(s.speed_limit!)} y1={cy - 6} y2={cy + 6} className="sc-gap" />}
                  <circle cx={cx} cy={cy} r={7} className="sc-ring" />
                  <text x={cx + (right ? -12 : 12)} y={cy - 12} textAnchor={right ? 'end' : 'start'} className="sc-lab">
                    DFO {s.dfo.toFixed(2)} · {nf(s.speed_all)} mph ({nf(s.speed_limit)} posted) · {nf(s.crashes_per_mi, 2)}/mi/yr
                  </text>
                </g>
              );
            })()}
            <text x={W - P.r} y={H - 6} textAnchor="end" className="sc-axis">{mode === 'abs' ? 'Operating speed, mph (dashed: posted limits present)' : 'Operating minus posted speed, mph'}</text>
            <text x={0} y={12} className="sc-axis">Ped/bike crashes per mi per yr</text>
          </svg>
        </div>
      </div>
      <p className="sc-key" aria-hidden="true"><span><i data-k="hit" />crashes, at or below posted</span><span><i data-k="over" />crashes, above posted</span><span><i data-k="none" />no crash</span></p>
      <p className="sc-foot muted">Stations inherit the density of their one-mile screened segment, so dots stack in runs; ρ is descriptive, not a test. Operating speed from TxDOT Statewide Speed 2024.</p>
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
