import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import MapView, { type MapLayer } from '../components/MapView';
import { Icon, type IconName } from '../components/Icon';
import Term from '../components/Term';
import PageHeader from '../components/PageHeader';
import Select from '../components/Select';
import MetricInfo, { type MetricSpec } from '../components/MetricInfo';
import Info from '../components/Info';
import { useApi } from '../lib/api';
import { copyLink, downloadCSV, downloadPNG } from '../lib/export';
import { bboxOf, CHART, nf, SEV_HEX } from '../lib/format';
import { reducedMotion, useReveal } from '../lib/motion';
import type { FC, SegmentProps, Spf } from '../lib/types';
import '../styles/screening.css';

const CRIS = <>TxDOT CRIS on-system ped/bike crashes 2021–2023; TxDOT Roadway Inventory 2024; TxDOT AADT (AADT_CUR)</>;
const HSM = <>AASHTO <i>Highway Safety Manual</i> (2010), Part B ch. 4</>;

/** Methodology of every screening measure, shown in MetricInfo popovers. */
const SPECS: Record<'eb_excess' | 'critical_ratio' | 'rate' | 'frequency' | 'spf' | 'aadt' | 'k', MetricSpec> = {
  eb_excess: {
    name: 'Excess expected crashes (EB)', provenance: 'derived', unit: 'ped/bike crashes per year',
    formula: <>E = w·μ + (1−w)·N, w = 1/(1 + k·μ); excess = E − μ</>,
    threshold: <>&gt; 0 flags a site (potential for safety improvement)</>,
    source: CRIS,
    citation: <>{HSM}; Hauer (1997), <i>Observational Before–After Studies in Road Safety</i></>,
    note: 'μ and N over the same three years; k is per mile, applied to a segment as k/L.',
  },
  critical_ratio: {
    name: 'Critical rate ratio', provenance: 'derived', unit: 'ratio (R / Rc)',
    formula: <>Rc = Ra + 1.645·√(Ra/M) + 1/(2M)</>,
    threshold: <>&gt; 1 is high at 95% confidence (one-sided)</>,
    source: CRIS, citation: HSM,
    note: 'Ra is the crash rate of the site type; M is the segment’s exposure in 100 MVMT.',
  },
  rate: {
    name: 'Crash rate', provenance: 'derived', unit: 'crashes per 100 MVMT',
    formula: <>R = N·10⁸ / (365·Y·AADT·L)</>,
    threshold: 'none; ranks only. Favours low-volume segments.',
    source: CRIS, citation: HSM,
  },
  frequency: {
    name: 'Crash frequency', provenance: 'observed', unit: 'crashes in 3 years',
    formula: <>N = Σ crashes, 2021–2023</>,
    threshold: 'none; ignores exposure and regression to the mean',
    source: CRIS, citation: HSM,
  },
  spf: {
    name: 'Safety performance function', provenance: 'derived', unit: 'predicted crashes per year',
    formula: <>μ = L·Y·exp(β₀ + β₁·ln AADT + …), NB2</>,
    threshold: 'fitted per site type when events per variable allow; pooled otherwise',
    source: CRIS, citation: <>{HSM}; Hauer &amp; Bamfo (1997), CURE plots</>,
  },
  aadt: {
    name: 'Annual average daily traffic', provenance: 'public', unit: 'vehicles per day',
    formula: 'Count year as published in TxDOT_AADT.AADT_CUR, joined to the segment by route and DFO',
    source: 'TxDOT AADT annuals (ArcGIS FeatureServer), © TxDOT, informational use',
    citation: 'FHWA Traffic Monitoring Guide (2022)',
  },
  k: {
    name: 'Overdispersion k', provenance: 'derived', unit: 'per mile',
    formula: <>Var(N) = μ + k·μ²; segment k = k/L</>,
    threshold: 'larger k gives the SPF less weight in EB',
    source: CRIS, citation: HSM,
  },
};

const METHODS: { id: MethodId; label: string; short: string; d: string; icon: IconName }[] = [
  { id: 'eb_excess', label: 'EB excess', short: 'EB excess', d: 'EB expected minus SPF-predicted crashes per year (HSM potential for safety improvement).', icon: 'target' },
  { id: 'critical_ratio', label: 'Critical rate ratio', short: 'R/Rc', d: 'Observed over critical rate, 95% confidence. Above 1 is high.', icon: 'warning' },
  { id: 'rate', label: 'Crash rate', short: 'Rate', d: 'Crashes per 100 MVMT. Favours low-volume segments.', icon: 'gauge' },
  { id: 'frequency', label: 'Crash frequency', short: 'Count', d: 'Three-year count. Ignores exposure and regression to the mean.', icon: 'rank' },
];
type MethodId = 'eb_excess' | 'critical_ratio' | 'rate' | 'frequency';
const FIELD: Record<MethodId, keyof SegmentProps> = { eb_excess: 'eb_excess', critical_ratio: 'crit_ratio', rate: 'rate_100mvmt', frequency: 'crashes_total' };
const GROUPS = ['All', 'Interstate/Freeway', 'Principal arterial', 'Minor arterial', 'Collector/Local'] as const;
const TOP = 25;

type Row = SegmentProps & { fc_group?: string; site_type?: string; crashes_per_yr?: number; crashes_ka?: number; dfo_from?: number; dfo_to?: number; speed_all?: number };
interface Screening { method: string; total: number; items: Row[]; unscreened?: { segments: number; crashes: number; reason: string } }
/** TxDOT Statewide Speed 2024 tops out at exactly 65 mph (352 of 2,738 records, none above): treat 65 as "65 or more". */
const SPEED_CAP = 65;
const opSpeed = (v?: number | null) => (v == null ? '—' : v >= SPEED_CAP ? `≥ ${SPEED_CAP}` : nf(v, 1));

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const typing = (e: KeyboardEvent) => e.metaKey || e.ctrlKey || e.altKey || !!(e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable], [role="listbox"]') || !!document.querySelector('.cmdk-scrim');

/** Bumps a counter on each new selection so the map can flash a halo there (skipped with reduced motion). */
function usePulse(key: string | null) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!key || reducedMotion()) return;
    setOn(true);
    const t = setTimeout(() => setOn(false), 60);
    return () => clearTimeout(t);
  }, [key]);
  return on;
}

/** FLIP: rows keyed by id glide from their previous offset to the new one when the order changes. */
function useFlip(els: React.RefObject<Map<string, HTMLElement>>, order: string, box: React.RefObject<HTMLElement | null>) {
  const last = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const prev = last.current, next = new Map<string, number>();
    els.current.forEach((el, id) => next.set(id, el.offsetTop));
    if (!next.size) return; // keep the last order across a loading gap
    last.current = next;
    const wrap = box.current;
    if (!prev.size || !wrap || reducedMotion()) return;
    const top = wrap.scrollTop, bottom = top + wrap.clientHeight, span = wrap.clientHeight;
    els.current.forEach((el, id) => {
      const now = next.get(id)!, was = prev.get(id);
      if (now < top - 40 || now > bottom + 40) return;
      const dy = was == null ? span : Math.max(-span, Math.min(span, was - now));
      if (Math.abs(dy) < 1) return;
      el.animate([{ transform: `translateY(${dy}px)`, opacity: was == null || Math.abs(was - now) > span ? 0 : 1 }, { transform: 'none', opacity: 1 }],
        { duration: 380, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    });
  }, [order]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Network figures for the header: flagged sites, top excess, crashes, and the exposure-weighted rate. */
function headline(rows: Row[]) {
  let n = 0, vmt = 0, flagged = 0, top: number | null = null;
  for (const r of rows) {
    if ((r.eb_excess ?? 0) > 0) flagged++;
    if (r.eb_excess != null) top = Math.max(top ?? -Infinity, r.eb_excess);
    if (r.aadt) { n += r.crashes_total; vmt += 365 * r.crash_years * r.aadt * r.len_mi; }
  }
  return { flagged, top, crashes: rows.reduce((s, r) => s + r.crashes_total, 0), rate: vmt ? (n * 1e8) / vmt : null };
}

/** Competition ranks (ties share the best rank) of every segment under each measure, nulls last. */
function ranksBy(rows: Row[]) {
  const out = {} as Record<MethodId, Map<string, number>>;
  for (const m of METHODS) {
    const f = FIELD[m.id];
    const sorted = rows.filter((r) => r[f] != null).sort((a, b) => (b[f] as number) - (a[f] as number));
    const map = new Map<string, number>();
    sorted.forEach((r, i) => map.set(r.seg_id, i > 0 && sorted[i - 1][f] === r[f] ? map.get(sorted[i - 1].seg_id)! : i + 1));
    out[m.id] = map;
  }
  return out;
}

export default function ScreeningPage() {
  const [params, setParams] = useSearchParams();
  const method = (METHODS.find((m) => m.id === params.get('method'))?.id ?? 'eb_excess') as MethodId;
  const group = (GROUPS as readonly string[]).includes(params.get('group') ?? '') ? params.get('group')! : 'All';
  const focus = params.get('seg');
  const set = useCallback((k: string, v: string | null) => setParams((prev) => { const p = new URLSearchParams(prev); v ? p.set(k, v) : p.delete(k); return p; }, { replace: true }), [setParams]);

  // retry: a new query token re-requests a failed endpoint without reloading the page
  const [retry, setRetry] = useState(0);
  const rq = retry ? `${'&'}retry=${retry}` : '';
  const net = useApi<FC<SegmentProps & { fc_group?: string }>>(`/network${rq ? `?${rq.slice(1)}` : ''}`);
  const scr = useApi<Screening>(`/screening?method=${method}&limit=1000${rq}`);
  const spf = useApi<SpfFull>(`/spf${rq ? `?${rq.slice(1)}` : ''}`);
  const meta = METHODS.find((m) => m.id === method)!;
  const gridRef = useReveal<HTMLElement>();
  const stabRef = useReveal<HTMLElement>();
  const spfRef = useReveal<HTMLElement>();
  const wrapRef = useRef<HTMLDivElement>(null);
  const figRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLTableRowElement>());
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => { if (copied === 'idle') return; const t = setTimeout(() => setCopied('idle'), 1600); return () => clearTimeout(t); }, [copied]);

  const rows = useMemo(() => (scr.data?.items ?? []).filter((r) => group === 'All' || r.fc_group === group), [scr.data, group]);
  const rankOf = useMemo(() => new Map(rows.map((r, i) => [r.seg_id, i + 1])), [rows]);
  const head = useMemo(() => headline(rows), [rows]);
  const focusFeature = net.data?.features.find((f) => f.properties.seg_id === focus);
  const focusRow = rows.find((r) => r.seg_id === focus);
  const groupCount = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of scr.data?.items ?? []) c[r.fc_group ?? ''] = (c[r.fc_group ?? ''] ?? 0) + 1;
    return c;
  }, [scr.data]);
  const unscr = scr.data?.unscreened;

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

  useFlip(rowEls as React.RefObject<Map<string, HTMLElement>>, rows.map((r) => r.seg_id).join(','), wrapRef);
  const pulse = usePulse(focus);

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
      else if (e.key === 'Escape' && focus && !document.querySelector('.term-tip, .mi-pop, .sel-list')) set('seg', null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const exportCsv = () => downloadCSV(`roadscope-screening-${method}-${slug(group)}.csv`,
    rows.map((r, i) => ({
      rank: i + 1, seg_id: r.seg_id, name: r.name, route: r.route, dfo_from: r.dfo_from, dfo_to: r.dfo_to, facility: r.fc_group, site_type: r.site_type,
      lanes: r.lanes, speed_limit_mph: r.speed_limit, operating_speed_mph: r.speed_all, aadt: r.aadt, truck_pct: r.truck_pct, crashes_3yr: r.crashes_total, crashes_ka_3yr: r.crashes_ka,
      crashes_per_yr: r.crashes_per_yr, rate_100mvmt: r.rate_100mvmt, crit_rate: r.crit_rate, crit_ratio: r.crit_ratio, spf_pred_per_yr: r.spf_pred, eb_expected_per_yr: r.eb_expected, eb_excess_per_yr: r.eb_excess,
    })));
  // The WebGL map cannot be read back, so the PNG is drawn from the same geometry as a vector figure.
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    if (!exporting) return;
    const el = figRef.current;
    if (!el) { setExporting(false); return; }
    downloadPNG(`roadscope-screening-${method}-${slug(group)}.png`, el,
      `RoadScope network screening · top ${TOP} by ${meta.label} · ${group} · TxDOT CRIS ped/bike 2021–2023 · HSM Part B`).finally(() => setExporting(false));
  }, [exporting]); // eslint-disable-line react-hooks/exhaustive-deps
  const exportFig = () => setExporting(true);
  const share = async () => setCopied((await copyLink()) ? 'ok' : 'fail');

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
    layers: [
      { id: 'sel-halo', type: 'line', paint: { 'line-color': CHART.accent, 'line-width': pulse ? 28 : 10, 'line-opacity': pulse ? 0.6 : 0, 'line-width-transition': { duration: pulse ? 0 : 420, delay: 0 }, 'line-opacity-transition': { duration: pulse ? 0 : 420, delay: 0 } }, layout: { 'line-cap': 'round', 'line-join': 'round' } } as any,
      { id: 'sel-line', type: 'line', paint: { 'line-color': CHART.ink, 'line-width': 2, 'line-gap-width': ['interpolate', ['linear'], ['zoom'], 9, 5, 13, 9] }, layout: { 'line-cap': 'round', 'line-join': 'round' } } as any,
    ],
  }), [focusFeature, pulse]);
  const mapSources = useMemo(() => (sources.length ? [...sources, selSource] : []), [sources, selSource]);

  const methodHead = method === 'eb_excess' ? <Term k="EB excess" /> : method === 'critical_ratio' ? <Term k="Critical ratio">R/Rc</Term> : method === 'rate' ? 'Per 100 MVMT' : 'Crashes, 3 yr';
  const dp = method === 'frequency' ? 0 : method === 'rate' ? 1 : 2;

  return (
    <div className="page screening">
      <PageHeader
        icon="rank"
        title="Network screening"
        lede={<>{nf(scr.data?.total)} one-mile on-system segments in Lubbock County, ranked by pedestrian and bicyclist crashes{unscr?.segments ? <> ({nf(unscr.segments)} more lack an inventory or AADT match and are not ranked)</> : null}.</>}
        source={<>Derived from TxDOT CRIS 2021–2023 (on-system ped/bike crashes), TxDOT Roadway Inventory 2024 and TxDOT AADT (AADT_CUR); method per {HSM}.</>}
        readouts={[
          { label: <span className="rd-l">Sites flagged <MetricInfo spec={SPECS.eb_excess} align="right" /></span>, value: scr.data ? head.flagged : null, unit: `/ ${nf(rows.length)}`, tone: 'alert' },
          { label: <span className="rd-l">Top EB excess</span>, value: head.top, unit: 'crashes/yr', digits: 2 },
          { label: <span className="rd-l">Ped/bike crashes</span>, value: scr.data ? head.crashes : null, unit: '3 yr' },
          { label: <span className="rd-l">Network rate <MetricInfo spec={SPECS.rate} align="right" /></span>, value: head.rate, unit: '/100 MVMT', digits: 2 },
        ]}
        actions={<>
          <button type="button" className="btn ghost" onClick={exportCsv} disabled={!rows.length}><Icon name="download" size={16} /><span>Download CSV</span></button>
          <button type="button" className="btn ghost" onClick={exportFig} disabled={!rows.length}><Icon name="image" size={16} /><span>Download PNG</span></button>
          <button type="button" className="btn ghost" onClick={share} aria-live="polite"><Icon name={copied === 'ok' ? 'check' : 'link'} size={16} /><span>{copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Copy blocked' : 'Copy link'}</span></button>
          <Link to="/brief" className="btn ghost"><Icon name="sheet" size={16} /><span>Open brief</span></Link>
        </>}
      />

      <div className="scr-controls" role="toolbar" aria-label="Screening options">
        <div className="seg" role="group" aria-label="Performance measure">
          {METHODS.map((m) => <button key={m.id} aria-pressed={method === m.id} onClick={() => set('method', m.id)}><Icon name={m.icon} size={16} />{m.label}</button>)}
        </div>
        <Select label="Facility" icon="corridor" value={group} onChange={(v) => set('group', v === 'All' ? null : v)}
          options={GROUPS.map((g) => ({ value: g, label: g, hint: g === 'All' ? nf(scr.data?.items.length) : nf(groupCount[g] ?? 0) }))} />
        <Info label="About this ranking" title={meta.label}>
          <p>{meta.d}</p>
          <p className="mi-formula">{SPECS[method].formula}</p>
          {SPECS[method].threshold && <p>Threshold: {SPECS[method].threshold}.</p>}
          <p>{SPECS[method].citation}</p>
          <p>A dot after a segment name marks a site flagged by both tests (EB excess &gt; 0 and R/Rc &gt; 1).</p>
          {unscr?.segments ? <p>{nf(unscr.segments)} segments lack an inventory or AADT match and are not ranked.</p> : null}
          <p>Keyboard: J / K step through the list, F fits the map, Esc clears. Double-click a row to fit the map.</p>
        </Info>
      </div>
      {scr.data && head.crashes < 10 && rows.length > 0 && (
        <p className="scr-warn" role="note"><Icon name="warning" size={16} /><span>Only {head.crashes} crash{head.crashes === 1 ? '' : 'es'} here: lower ranks are ties.</span></p>
      )}

      <section className="scr-grid" ref={gridRef} aria-label="Ranking and map">
        <div className="panel scr-table-wrap" data-ui data-r="1" ref={wrapRef} aria-busy={scr.loading || undefined} role="region" aria-label="Ranked segments table" tabIndex={0}>
          {scr.error && <div className="error-box scr-state" role="alert">Ranking unavailable: {scr.error} <button type="button" className="btn ghost" onClick={() => setRetry((n) => n + 1)}><Icon name="reset" size={16} /><span>Retry</span></button></div>}
          <table className="data">
            <caption className="sr-only">Segments ranked by {meta.label}{group !== 'All' ? `, ${group}` : ''}</caption>
            <thead>
              <tr>
                <th className="r">#</th><th>Segment · DFO, mi</th><th className="r opt"><Term k="AADT" /></th><th className="r">Ped/bike</th>
                <th className="r">{methodHead}</th><th className="r opt"><Term k="SPF">SPF/yr</Term></th>
                <th className="r opt opt2">{method === 'eb_excess' ? <Term k="Critical ratio">R/Rc</Term> : <Term k="EB excess" />}</th>
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
                  <td className="r measure rank">{i + 1}</td>
                  <td>
                    <div className="seg-name">{r.name}{(r.crit_ratio ?? 0) > 1 && (r.eb_excess ?? 0) > 0 && <i className="scr-both" role="img" aria-label="confirmed by both tests" title="Confirmed: EB excess > 0 and R/Rc > 1" />}</div>
                    <div className="measure seg-id">{nf(r.dfo_from, 2)}–{nf(r.dfo_to, 2)} · {nf(r.lanes)} ln · {nf(r.speed_limit)} mph</div>
                  </td>
                  <td className="r measure opt">{nf(r.aadt)}</td>
                  <td className="r measure">{nf(r.crashes_total)}</td>
                  <td className="r measure strong" key={method}><span className="flip">{nf(r[FIELD[method]] as number, dp)}</span></td>
                  <td className="r measure opt">{nf(r.spf_pred, 2)}</td>
                  <td className="r measure opt opt2">{nf(method === 'eb_excess' ? r.crit_ratio : r.eb_excess, 2)}</td>
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
          {net.error && <div className="error-box scr-map-err" role="alert">Network unavailable: {net.error} <button type="button" className="btn ghost" onClick={() => setRetry((n) => n + 1)}><Icon name="reset" size={16} /><span>Retry</span></button></div>}
          <div className="scr-legend" aria-hidden="true">
            <span>{meta.short}</span>
            <i style={{ background: `linear-gradient(90deg, ${SEV_HEX.K}, ${SEV_HEX.A}, ${SEV_HEX.B})` }} />
            <span className="measure">#1–{TOP}</span>
          </div>
          {focusFeature && <SegmentCard key={focusFeature.properties.seg_id} s={{ ...focusFeature.properties, ...focusRow } as any} rank={rankOf.get(focusFeature.properties.seg_id)}
            onFit={() => fitTo(focusFeature.properties.seg_id)} onClose={() => set('seg', null)} />}
        </div>
      </section>

      {exporting && net.data && (
        <div className="scr-export" ref={figRef} aria-hidden="true">
          <NetworkFigure fc={net.data} rankOf={rankOf} focus={focus} title={`Top ${TOP} segments by ${meta.label}${group !== 'All' ? ` · ${group}` : ''}`} />
        </div>
      )}

      <section className="section scr-stab" aria-labelledby="stab-h" ref={stabRef}>
        <div className="scr-sec-h" data-r="1">
          <h2 id="stab-h"><Icon name="trend" size={22} />Rank stability</h2>
          <Info label="About this chart" title="Rank stability">
            <p>The top {N_STAB} sites by {meta.label}, re-ranked under the other three HSM Part B measures. A site is robust when it stays in the top {TOP} under all four.</p>
            <p>Rank on a log scale, 1 = worst; ties share a rank; ranks beyond {CAP} sit on the floor. Hover a line for its four ranks, click to select the segment.</p>
          </Info>
        </div>
        <div data-r="2">
          {scr.data ? <RankStability rows={rows} method={method} focus={focus} onPick={(id) => select(id, true)} group={group} />
            : scr.error ? null : <div className="skeleton" style={{ height: 420 }} aria-label="Loading rank stability" />}
        </div>
      </section>

      <section className="section scr-spf" aria-labelledby="spf-h" ref={spfRef}>
        <div className="scr-sec-h" data-r="1">
          <h2 id="spf-h"><Icon name="methods" size={22} /><Term k="SPF">SPFs</Term> by site type</h2>
          {spf.data && <Info label="About these models" title="Safety performance functions">
            <p className="mi-formula">{SPECS.spf.formula}</p>
            <p>{SPECS.spf.citation}</p>
            <p>NB2 models used in the EB ranking, offset ln L + ln Y (Y = {spf.data.crash_years ?? 3} yr), k per mile applied as k/L.</p>
            <p>The CURE plot checks fit along AADT: inside the dashed ±2σ* band there is no systematic bias.</p>
            <p>Pooled fallback: {Object.entries(spf.data.site_types ?? {}).filter(([, v]) => !v.fitted).map(([k, v]) => `${k} (${v.crashes})`).join(', ') || 'none'}.</p>
          </Info>}
        </div>
        <div data-r="2">
          {spf.error ? <div className="error-box" role="alert">Models unavailable: {spf.error} <button type="button" className="btn ghost" onClick={() => setRetry((n) => n + 1)}><Icon name="reset" size={16} /><span>Retry</span></button></div>
            : spf.data ? <SiteTypes spf={spf.data} /> : <div className="skeleton" style={{ height: 360 }} aria-label="Loading models" />}
        </div>
      </section>
    </div>
  );
}

function SegmentCard({ s, rank, onFit, onClose }: { s: Row; rank?: number; onFit: () => void; onClose: () => void }) {
  const corridor = { US0084: 'us-84', US0062: 'us-62-82', US0082: 'us-62-82', SL0289: 'loop-289', IH0027: 'i-27', SH0114: 'sh-114', FM2255: 'fm-2255', FM0835: 'fm-835' }[s.route?.slice(0, 6) ?? ''];
  return (
    <div className="seg-card" role="region" aria-label={`Selected segment ${s.name}`}>
      <div className="seg-card-h">
        <strong>{s.name}</strong><span className="measure">{rank ? `#${rank}` : 'unranked'}</span>
        <button type="button" className="seg-card-x" onClick={onClose} aria-label="Clear selection"><Icon name="close" size={16} /></button>
      </div>
      <dl className="measure">
        <dt>Facility</dt><dd>{s.fc_group ?? '—'} · {nf(s.lanes)} ln</dd>
        <dt>Posted / operating</dt><dd>{nf(s.speed_limit)} / {opSpeed(s.speed_all)} mph</dd>
        <dt><Term k="AADT" /> · trucks</dt><dd>{nf(s.aadt)} veh/d · {nf(s.truck_pct, 1)}%</dd>
        <dt>Observed</dt><dd>{nf(s.crashes_per_yr, 2)} /yr · {nf(s.crashes_total)} in 3 yr, {nf(s.crashes_ka)} KA</dd>
        <dt><Term k="SPF">SPF</Term> predicted</dt><dd>{nf(s.spf_pred, 2)} /yr</dd>
        <dt><Term k="EB">EB</Term> expected</dt><dd>{nf(s.eb_expected, 2)} /yr</dd>
        <dt><Term k="Critical ratio" /></dt><dd data-hi={(s.crit_ratio ?? 0) > 1 || undefined}>{nf(s.crit_ratio, 2)}</dd>
      </dl>
      <div className="seg-card-a">
        <button type="button" className="btn ghost" onClick={onFit}><Icon name="fit" size={16} /><span>Fit map to segment</span></button>
        {corridor && <Link className="btn ghost" to={`/corridors/${corridor}`}><Icon name="corridor" size={16} /><span>Open corridor diagram</span></Link>}
      </div>
    </div>
  );
}

/** Vector rendering of the screened network for PNG export (equirectangular, cos φ corrected). */
function NetworkFigure({ fc, rankOf, focus, title }: { fc: FC<SegmentProps>; rankOf: Map<string, number>; focus: string | null; title: string }) {
  const W = 1200, H = 900, pad = 40, head = 56;
  const all = fc.features.flatMap((f) => f.geometry.coordinates as number[][]);
  const [[a, b], [c, d]] = bboxOf(all);
  const k = Math.cos(((b + d) / 2) * Math.PI / 180);
  const s = Math.min((W - 2 * pad) / ((c - a) * k), (H - head - 2 * pad) / (d - b));
  const ox = (W - (c - a) * k * s) / 2, oy = head + pad;
  const path = (co: number[][]) => co.map(([x, y], i) => `${i ? 'L' : 'M'}${(ox + (x - a) * k * s).toFixed(1)},${(oy + (d - y) * s).toFixed(1)}`).join('');
  const col = (r: number) => (r <= 1 ? SEV_HEX.K : r <= 8 ? SEV_HEX.A : SEV_HEX.B);
  const ranked = fc.features.map((f) => ({ f, r: rankOf.get(f.properties.seg_id) ?? 9999 })).sort((x, y) => y.r - x.r);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <rect width={W} height={H} fill={CHART.ground} />
      <text x={pad} y={36} fill={CHART.ink} fontSize={22} fontWeight={600}>{title}</text>
      <text x={W - pad} y={36} fill={CHART.axis} fontSize={14} textAnchor="end">Lubbock County state system · 1-mi segments</text>
      {ranked.map(({ f, r }) => (
        <path key={f.properties.seg_id} d={path(f.geometry.coordinates as number[][])} fill="none" strokeLinecap="round"
          stroke={r <= TOP ? col(r) : CHART.areaFill} strokeWidth={r <= TOP ? 5 : 1.6} />
      ))}
      {ranked.filter(({ r }) => r <= 5).map(({ f, r }) => {
        const co = f.geometry.coordinates as number[][], m = co[Math.floor(co.length / 2)];
        const x = ox + (m[0] - a) * k * s, y = oy + (d - m[1]) * s;
        return <g key={`l${r}`}><circle cx={x + 16} cy={y - 16} r={12} fill={CHART.ink} /><text x={x + 16} y={y - 11.5} fill={CHART.ground} fontSize={13} fontWeight={700} textAnchor="middle">{r}</text></g>;
      })}
      {fc.features.filter((f) => f.properties.seg_id === focus).map((f) => <path key="sel" d={path(f.geometry.coordinates as number[][])} fill="none" stroke={CHART.ink} strokeWidth={2} strokeDasharray="6 4" />)}
      <g transform={`translate(${pad} ${H - pad})`}>
        {[['#1', SEV_HEX.K], ['#2–8', SEV_HEX.A], [`#9–${TOP}`, SEV_HEX.B], ['other', CHART.areaFill]].map(([l, cl], i) => (
          <g key={l} transform={`translate(${i * 110} 0)`}><rect y={-8} width={22} height={6} rx={3} fill={cl} /><text x={30} y={0} fill={CHART.axis} fontSize={14}>{l}</text></g>
        ))}
      </g>
    </svg>
  );
}

/** Tracks an element's content width so charts draw in true pixels and their text never scales below its set size. */
function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const N_STAB = 12, CAP = 40;

/** Bump chart: the top sites under the active measure, re-ranked under the other three (ties share rank). */
function RankStability({ rows, method, focus, onPick, group }: { rows: Row[]; method: MethodId; focus: string | null; onPick: (id: string) => void; group: string }) {
  const [ref, W] = useWidth<HTMLDivElement>(900);
  const box = useRef<HTMLDivElement>(null);
  const [hov, setHov] = useState<string | null>(null);
  const ranks = useMemo(() => ranksBy(rows), [rows]);
  const order = [method, ...METHODS.map((m) => m.id).filter((m) => m !== method)];
  const top = rows.slice(0, N_STAB);
  const robust = (id: string) => order.every((m) => (ranks[m].get(id) ?? Infinity) <= TOP);
  const nRobust = top.filter((r) => robust(r.seg_id)).length;
  const narrow = W < 640;
  const P = { l: narrow ? 112 : 200, r: narrow ? 26 : 40, t: 46, b: 34 };
  const H = 470;
  const X = (k: number) => P.l + (k / (order.length - 1)) * (W - P.l - P.r);
  // log rank scale: the top of the list, where decisions are made, gets the room
  const Y = (rank: number | undefined) => P.t + (Math.log(Math.min(rank ?? CAP + 1, CAP + 1)) / Math.log(CAP + 1)) * (H - P.t - P.b);
  const active = hov ?? (focus && top.some((r) => r.seg_id === focus) ? focus : null);

  // labels at the first column, nudged apart so none overlap
  const labels = top.map((r) => ({ r, y: Y(ranks[order[0]].get(r.seg_id)) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 17);
  const yTicks = [1, 2, 5, 10, 25, 40];
  const cur = top.find((r) => r.seg_id === active);
  const save = () => box.current && downloadPNG(`roadscope-rank-stability-${method}-${slug(group)}.png`, box.current,
    `RoadScope rank stability · top ${N_STAB} by ${METHODS.find((m) => m.id === method)!.label} · ${group} · TxDOT CRIS ped/bike 2021–2023`);

  if (!top.length) return <p className="muted">No segments in this facility group.</p>;
  return (
    <div className="panel stab">
      <div className="stab-bar">
        <span className="stab-verdict"><b className="measure">{nRobust}</b> of {top.length} robust</span>
        <span className="stab-key" aria-hidden="true"><i className="k-robust" />robust <i className="k-frag" />measure-dependent</span>
        <button type="button" className="btn ghost" onClick={save}><Icon name="image" size={16} /><span>Download PNG</span></button>
      </div>
      <div ref={box} className="stab-fig">
        <div ref={ref}>
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Bump chart of rank under four measures for the top ${top.length} sites; ${nRobust} stay in the top ${TOP} under all four`}
            onPointerLeave={() => setHov(null)}>
            {order.map((m, k) => {
              const M = METHODS.find((x) => x.id === m)!;
              return (
                <g key={m}>
                  <line x1={X(k)} x2={X(k)} y1={P.t - 6} y2={H - P.b + 4} className="stab-col" />
                  <text x={X(k)} y={18} textAnchor={k === order.length - 1 ? 'end' : 'middle'} className={k === 0 ? 'stab-head on' : 'stab-head'}>{narrow ? M.short : M.label}</text>
                </g>
              );
            })}
            {yTicks.map((t) => <g key={t}><line x1={P.l - 6} x2={W - P.r} y1={Y(t)} y2={Y(t)} className="stab-grid" /><text x={W - P.r + 6} y={Y(t) + 4} className="stab-tick">{t}</text></g>)}
            <rect x={P.l - 4} y={Y(TOP) } width={W - P.l - P.r + 8} height={Y(CAP + 1) - Y(TOP)} className="stab-out" />
            <text x={W - P.r - 6} y={Y(TOP) + 15} textAnchor="end" className="stab-tick">below top {TOP}</text>
            <text x={W - P.r} y={H - 8} textAnchor="end" className="stab-tick">rank, log scale</text>
            {top.map((r) => {
              const pts = order.map((m, k) => [X(k), Y(ranks[m].get(r.seg_id))] as const);
              const rb = robust(r.seg_id);
              const on = active === r.seg_id;
              return (
                <g key={r.seg_id} className="stab-line" data-robust={rb || undefined} data-on={on || undefined} data-dim={(active && !on) || undefined}
                  onPointerEnter={() => setHov(r.seg_id)} onClick={() => onPick(r.seg_id)}>
                  <path d={pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('')} className="stab-path" />
                  <path d={pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('')} className="stab-hit" />
                  {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={on ? 4.5 : 3} className="stab-dot" />)}
                  {on && pts.map((p, i) => { const rk = ranks[order[i]].get(r.seg_id); return <text key={`t${i}`} x={p[0] + 8} y={p[1] - 7} className="stab-rk">{rk == null ? 'n/a' : rk > CAP ? `#${rk}` : `#${rk}`}</text>; })}
                </g>
              );
            })}
            {labels.map(({ r, y }) => (
              <text key={r.seg_id} x={P.l - 14} y={y + 4} textAnchor="end" className="stab-lab" data-on={active === r.seg_id || undefined} data-robust={robust(r.seg_id) || undefined}
                tabIndex={0} role="button" aria-label={`${r.name} DFO ${nf(r.dfo_from, 1)}: ${order.map((m) => `${METHODS.find((x) => x.id === m)!.short} #${ranks[m].get(r.seg_id) ?? 'n/a'}`).join(', ')}. Select segment`}
                onFocus={() => setHov(r.seg_id)} onBlur={() => setHov(null)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(r.seg_id); } }}
                onPointerEnter={() => setHov(r.seg_id)} onClick={() => onPick(r.seg_id)}>
                {r.name}{narrow ? '' : ` · ${nf(r.dfo_from, 1)}`}
              </text>
            ))}
          </svg>
        </div>
      </div>
      <p className="stab-read" aria-live="polite">
        {cur ? (
          <><b>{cur.name}</b> <span className="measure">DFO {nf(cur.dfo_from, 2)}–{nf(cur.dfo_to, 2)}</span>
            {order.map((m) => { const M = METHODS.find((x) => x.id === m)!; const v = cur[FIELD[m]] as number | null; return <span key={m} className="stab-chip"><span>{M.short}</span><b className="measure">#{ranks[m].get(cur.seg_id) ?? '—'}</b><span className="measure muted">{nf(v, m === 'frequency' ? 0 : m === 'rate' ? 1 : 2)}</span></span>; })}
            {robust(cur.seg_id) ? <span className="status" data-s="ok"><Icon name="ok" size={14} />robust</span> : <span className="status" data-s="warn"><Icon name="warning" size={14} />measure-dependent</span>}
          </>
        ) : null}
      </p>
    </div>
  );
}

interface SiteModel { spec: string[]; coef: Record<string, number>; se: Record<string, number>; k: number; k_convention?: string; n: number; crashes: number; aic: number }
interface SiteType { segments: number; crashes: number; fitted: boolean; model_used: string; model?: SiteModel; gof?: { mad: number; chi2_df: number }; cure?: { columns: string[]; points: [number, number, number][]; pct_outside: number; max_abs_cum?: number }; eb_weight_median?: number; reason?: string }
interface SpfFull extends Spf { outcome?: string; crash_period?: string; crash_years?: number; site_types?: Record<string, SiteType>; fallback?: { model?: SiteModel; gof?: { mad: number; chi2_df: number } } }

const TERM: Record<string, string> = { const: 'β₀', ln_aadt: 'ln AADT', speed: 'posted speed (mph)', lanes: 'lanes', urban: 'urban' };

function SiteTypes({ spf }: { spf: SpfFull }) {
  const fitted = Object.entries(spf.site_types ?? {}).filter(([, v]) => v.fitted && v.model && v.cure);
  const [sel, setSel] = useState(fitted[0]?.[0] ?? '');
  const figRef = useRef<HTMLDivElement>(null);
  const cur = fitted.find(([k]) => k === sel)?.[1];
  if (!cur) return <p className="muted">No site-type model available.</p>;
  const m = cur.model!;
  const save = () => figRef.current && downloadPNG(`roadscope-cure-${slug(sel)}.png`, figRef.current, `CURE plot · ${sel} · NB2 SPF, k = ${m.k.toFixed(2)}/mi · TxDOT CRIS ped/bike 2021–2023`);
  return (
    <div className="spf panel">
      <div className="spf-bar">
        <div className="seg" role="group" aria-label="Site type">
          {fitted.map(([k, v]) => <button key={k} aria-pressed={k === sel} onClick={() => setSel(k)}>{k} <small className="measure">{v.segments}</small></button>)}
        </div>
        <button type="button" className="btn ghost" onClick={save}><Icon name="image" size={16} /><span>Download PNG</span></button>
      </div>
      <div className="spf-grid">
        <div>
          <table className="data">
            <caption className="sr-only">Coefficients for {sel}</caption>
            <thead><tr><th>Term</th><th className="r">Estimate</th><th className="r">SE</th></tr></thead>
            <tbody>
              {Object.keys(m.coef).map((t) => <tr key={t}><td>{TERM[t] ?? t}</td><td className="r measure">{m.coef[t].toFixed(3)}</td><td className="r measure">{m.se?.[t]?.toFixed(3) ?? '—'}</td></tr>)}
              <tr><td>Overdispersion k <MetricInfo spec={SPECS.k} /></td><td className="r measure">{m.k < 0.005 ? '< 0.01' : m.k.toFixed(2)}</td><td className="r muted">/mi</td></tr>
            </tbody>
          </table>
          <dl className="spf-gof">
            <dt>Segments · crashes</dt><dd className="measure">{cur.segments} · {cur.crashes}</dd>
            <dt>MAD</dt><dd className="measure">{cur.gof?.mad.toFixed(2)}</dd>
            <dt>Pearson χ²/df</dt><dd className="measure">{cur.gof?.chi2_df.toFixed(2)}</dd>
            <dt>AIC</dt><dd className="measure">{m.aic.toFixed(1)}</dd>
            <dt>Median EB weight w</dt><dd className="measure">{cur.eb_weight_median?.toFixed(2) ?? '—'}</dd>
            <dt>CURE outside ±2σ*</dt><dd className="measure" data-hi={cur.cure!.pct_outside > 5 || undefined}>{cur.cure!.pct_outside.toFixed(1)}%</dd>
          </dl>
        </div>
        <div ref={figRef}><Cure pts={cur.cure!.points} label={sel} k={m.k} outside={cur.cure!.pct_outside} /></div>
      </div>
    </div>
  );
}

/** Cumulative residual (CURE) plot ordered by AADT with ±2σ* bounds (Hauer & Bamfo 1997); hover reads a point. */
function Cure({ pts, label, k, outside }: { pts: [number, number, number][]; label: string; k: number; outside: number }) {
  const [ref, W] = useWidth<HTMLElement>(620);
  const [hi, setHi] = useState<number | null>(null);
  const H = Math.round(Math.min(360, Math.max(260, W * 0.55))), P = { l: 52, r: 14, t: 34, b: 44 };
  const xs = pts.map((p) => p[0]);
  const x0 = Math.log10(Math.max(100, Math.min(...xs))), x1 = Math.log10(Math.max(...xs));
  const ym = Math.max(0.5, ...pts.map((p) => Math.max(Math.abs(p[1]), p[2]))) * 1.12;
  const X = (a: number) => P.l + ((Math.log10(Math.max(100, a)) - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
  const Y = (v: number) => P.t + (1 - (v + ym) / (2 * ym)) * (H - P.t - P.b);
  const line = (f: (p: [number, number, number]) => number) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(f(p)).toFixed(1)}`).join('');
  const ticks = [300, 1000, 3000, 10000, 30000, 100000].filter((a) => Math.log10(a) >= x0 && Math.log10(a) <= x1);
  let mi = 0;
  pts.forEach((p, i) => { if (Math.abs(p[1]) > Math.abs(pts[mi][1])) mi = i; });
  const pk = pts[mi];
  const h = hi != null ? pts[hi] : null;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    let best = 0, d = Infinity;
    pts.forEach((p, i) => { const dd = Math.abs(X(p[0]) - x); if (dd < d) { d = dd; best = i; } });
    setHi(best);
  };
  const fmtK = (a: number) => (a >= 1000 ? `${(a / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k` : String(a));
  return (
    <figure className="cure" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" tabIndex={0} aria-label={`CURE plot for ${label}: ${outside.toFixed(1)}% of points outside the two-sigma band. Arrow keys step through the points`}
        onPointerMove={onMove} onPointerLeave={() => setHi(null)} onBlur={() => setHi(null)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
          e.preventDefault();
          setHi((h) => e.key === 'Home' ? 0 : e.key === 'End' ? pts.length - 1 : Math.max(0, Math.min(pts.length - 1, (h ?? (e.key === 'ArrowRight' ? -1 : pts.length)) + (e.key === 'ArrowRight' ? 1 : -1))));
        }}>
        <text x={0} y={14} className="axis">Cumulative residual, crashes</text>
        {ticks.map((a) => <g key={a}><line x1={X(a)} x2={X(a)} y1={P.t} y2={H - P.b} className="gl" /><text x={X(a)} y={H - P.b + 20} className="tick" textAnchor="middle">{fmtK(a)}</text></g>)}
        <line x1={P.l} x2={W - P.r} y1={Y(0)} y2={Y(0)} className="zero" />
        <path d={line((p) => p[2])} className="band" />
        <path d={line((p) => -p[2])} className="band" />
        <text x={X(pts[0][0]) + 4} y={Y(pts[0][2]) - 6} className="tick band-l">+2σ*</text>
        <path key={label} d={line((p) => p[1])} className="cum" />
        <circle cx={X(pk[0])} cy={Y(pk[1])} r={3.5} className="pk" />
        <text x={X(pk[0]) > W * 0.5 ? Math.min(W - P.r - 4, X(pk[0]) - 8) : X(pk[0]) + 8} y={Y(pk[1]) + (pk[1] > 0 ? -8 : 16)} className="tick ann" textAnchor={X(pk[0]) > W * 0.5 ? 'end' : 'start'}>max {Math.abs(pk[1]).toFixed(1)} at {fmtK(pk[0])}</text>
        {[ym * 0.9, 0, -ym * 0.9].map((v) => <text key={v} x={P.l - 8} y={Y(v) + 5} className="tick" textAnchor="end">{v > 0 ? '+' : v < 0 ? '−' : ''}{Math.abs(v).toFixed(1)}</text>)}
        <text x={W - P.r} y={H - 4} className="axis" textAnchor="end">AADT, veh/day (log)</text>
        {h && (
          <g className="cure-hi">
            <line x1={X(h[0])} x2={X(h[0])} y1={P.t} y2={H - P.b} />
            <circle cx={X(h[0])} cy={Y(h[1])} r={4} />
          </g>
        )}
      </svg>
      <figcaption className="cure-read" aria-live="polite">
        {h ? <span className="measure">AADT {h[0].toLocaleString()} veh/d · Σ residual {h[1] >= 0 ? '+' : '−'}{Math.abs(h[1]).toFixed(2)} · ±2σ* {h[2].toFixed(2)} {Math.abs(h[1]) > h[2] ? '· outside band' : ''}</span>
          : null}
      </figcaption>
    </figure>
  );
}
