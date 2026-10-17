import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import MapView, { type MapLayer } from '../components/MapView';
import PageHeader from '../components/PageHeader';
import MetricInfo, { type MetricSpec } from '../components/MetricInfo';
import Info from '../components/Info';
import { Icon, type IconName } from '../components/Icon';
import Term from '../components/Term';
import { useApi } from '../lib/api';
import { reducedMotion, useReveal } from '../lib/motion';
import { copyLink, downloadCSV, downloadPNG } from '../lib/export';
import { CHART, nf, SEV_HEX, SEV_LABEL } from '../lib/format';
import type { FC, Severity, VruProps } from '../lib/types';
import '../styles/vru.css';

type Crash = Omit<VruProps, 'mode'> & { mode: string; intersection?: string | null; contributing?: string | null; ka_count?: number };
type FocusKind = 'light' | 'speed' | 'yield';
type Focus = { kind: FocusKind; key: string } | null;
type Dim = 'sev' | 'mode' | 'year' | 'cell' | FocusKind;
type Row = { key: string; label: string; n: number; ka: number };

const SEVS: Severity[] = ['K', 'A', 'B', 'C', 'O'];
const MODES = ['ped', 'bike', 'scooter'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MODE_LABEL: Record<string, string> = { ped: 'Pedestrian', bike: 'Cyclist', scooter: 'Scooter / other' };
const MODE_ICON: Record<string, IconName> = { ped: 'ped', bike: 'bike', scooter: 'path' };
const hh = (h: number) => String(((h % 24) + 24) % 24).padStart(2, '0');
const isKA = (p: Crash) => p.severity === 'K' || p.severity === 'A';
const pct = (a: number, b: number, d = 1) => (b ? nf((100 * a) / b, d) : '—');

/* ---------- Derived breakdowns (pure, from CRIS fields as recorded) ---------- */

/** CRIS light condition grouped into the bands a lighting programme acts on. */
const LIGHT_GROUPS: [string, string][] = [['day', 'Daylight'], ['dark-lit', 'Dark, lighted'], ['dark-unlit', 'Dark, not lighted'], ['twilight', 'Dawn or dusk'], ['unk', 'Not recorded']];
export function lightGroup(light?: string | null): string {
  const s = (light ?? '').toUpperCase();
  if (s.includes('DAYLIGHT')) return 'day';
  if (s.includes('NOT LIGHTED')) return 'dark-unlit';
  if (s.includes('DARK, LIGHTED')) return 'dark-lit';
  if (s.includes('DAWN') || s.includes('DUSK')) return 'twilight';
  return 'unk';
}

/** Posted speed bins (mph): the speed–severity relationship pedestrian safety programmes plan around. */
const SPEED_BINS: [string, string][] = [['le25', '≤ 25'], ['30', '30'], ['35', '35'], ['40', '40'], ['45', '45'], ['50-55', '50–55'], ['60-65', '60–65'], ['70-75', '70–75'], ['unk', 'Not recorded']];
export function speedBin(v?: number | null): string {
  if (v == null || v <= 0) return 'unk';
  if (v <= 25) return 'le25';
  if (v <= 30) return '30';
  if (v <= 35) return '35';
  if (v <= 40) return '40';
  if (v <= 45) return '45';
  if (v <= 55) return '50-55';
  if (v <= 65) return '60-65';
  return '70-75';
}

/** Yield-related crashes, by PBCAT crash type or by the officer-coded CRIS contributing factor. */
type YieldSrc = 'pbcat' | 'factor';
const YIELD: { key: string; label: string; short: string; icon: IconName; test: Record<YieldSrc, (p: Crash) => boolean> }[] = [
  { key: 'motorist', label: 'Motorist failed to yield', short: 'Motorist', icon: 'car',
    test: { pbcat: (p) => p.pbcat === 'Motorist Failed To Yield', factor: (p) => !!p.contributing?.includes('FAILED TO YIELD RIGHT OF WAY - TO PEDESTRIAN') } },
  { key: 'pedestrian', label: 'Pedestrian failed to yield', short: 'Pedestrian', icon: 'ped',
    test: { pbcat: (p) => p.pbcat === 'Pedestrian Failed To Yield', factor: (p) => !!p.contributing?.includes('PEDESTRIAN FAILED TO YIELD') } },
];

/** Wilson score interval for a binomial share (95 %), robust at small n. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 0];
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Contiguous w-hour window (wrapping midnight) with the most crashes, all days pooled. */
export function peakWindow(byHour: number[], w = 3): { start: number; n: number } {
  let best = { start: 0, n: -1 };
  for (let s = 0; s < 24; s++) {
    let n = 0;
    for (let i = 0; i < w; i++) n += byHour[(s + i) % 24];
    if (n > best.n) best = { start: s, n };
  }
  return best;
}

const KA_SPEC: MetricSpec = {
  name: 'KA share', provenance: 'derived', unit: '% of crashes',
  formula: 'KA share = (K + A) / N;  95% CI: Wilson score',
  source: 'TxDOT CRIS crash severity (KABCO), as recorded by the reporting officer',
  citation: 'FHWA KABCO scale (MMUCC 5th ed.); Wilson (1927) score interval',
  note: 'Small groups have wide intervals; compare the whiskers. Computed with the severity filter off, so hiding K or A never distorts a share.',
};
const COUNT_SPEC: MetricSpec = {
  name: 'Crash count', provenance: 'observed', unit: 'crashes, 2021–2023',
  source: 'TxDOT CRIS via the Active Transportation Crashes layer; one record per crash involving a pedestrian, cyclist or scooter rider',
  note: 'Counts, not rates: no pedestrian exposure (volumes) is available county-wide, so a high count can reflect high walking activity.',
};

const typing = (e: KeyboardEvent) => e.metaKey || e.ctrlKey || e.altKey || !!(e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]') || !!document.querySelector('.cmdk-scrim');
const ramp = (t: number) => `color-mix(in srgb, var(--sev-a) ${Math.round(t * 100)}%, var(--raise))`;
const rampSoft = (t: number) => ramp(Math.min(1, t) * 0.45);
const titleCase = (s: string) => s.replace(/^\d+\s*-\s*/, '').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** Toggle one member; with Alt/Option, isolate it (or show all again if it is already the only one shown). */
function toggleSet<T>(off: Set<T>, all: T[], v: T, isolate: boolean): Set<T> {
  if (isolate) {
    const only = all.every((x) => (x === v ? !off.has(x) : off.has(x)));
    return only ? new Set() : new Set(all.filter((x) => x !== v));
  }
  const n = new Set(off);
  if (n.has(v)) n.delete(v); else n.add(v);
  return n;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Filter state read once from the URL (?hide=K,B&modes=bike&year=2022&cell=4-18&focus=light:dark-unlit&yield=factor&crash=ID). */
function fromUrl(p: URLSearchParams) {
  const list = (k: string) => (p.get(k) ?? '').split(',').filter(Boolean);
  const c = (p.get('cell') ?? '').split('-').map(Number);
  const [fk, fv] = (p.get('focus') ?? '').split(':');
  const y = Number(p.get('year'));
  return {
    sevOff: new Set(list('hide').filter((x): x is Severity => (SEVS as string[]).includes(x))),
    modeOff: new Set(list('modes').filter((x) => MODES.includes(x))),
    year: Number.isInteger(y) && y > 2000 ? y : null,
    cell: c.length === 2 && c[0] >= 0 && c[0] < 7 && c[1] >= 0 && c[1] < 24 ? ([c[0], c[1]] as [number, number]) : null,
    focus: (['light', 'speed', 'yield'] as string[]).includes(fk) && fv ? ({ kind: fk as FocusKind, key: fv }) : null,
    ysrc: (p.get('yield') === 'factor' ? 'factor' : 'pbcat') as YieldSrc,
    crash: p.get('crash'),
  };
}

export default function Vru() {
  const [params, setParams] = useSearchParams();
  const init = useMemo(() => fromUrl(params), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [sevOff, setSevOff] = useState<Set<Severity>>(init.sevOff);
  const [modeOff, setModeOff] = useState<Set<string>>(init.modeOff);
  const [year, setYear] = useState<number | null>(init.year);
  const [cell, setCell] = useState<[number, number] | null>(init.cell);
  const [focus, setFocus] = useState<Focus>(init.focus);
  const [ysrc, setYsrc] = useState<YieldSrc>(init.ysrc);
  const [selId, setSelId] = useState<string | null>(init.crash);
  // Mirror the filters into the URL so a copied link (and Back) reproduces the view.
  useEffect(() => {
    const p = new URLSearchParams();
    if (sevOff.size) p.set('hide', SEVS.filter((x) => sevOff.has(x)).join(','));
    if (modeOff.size) p.set('modes', MODES.filter((x) => modeOff.has(x)).join(','));
    if (year != null) p.set('year', String(year));
    if (cell) p.set('cell', `${cell[0]}-${cell[1]}`);
    if (focus) p.set('focus', `${focus.kind}:${focus.key}`);
    if (ysrc !== 'pbcat') p.set('yield', ysrc);
    if (selId) p.set('crash', selId);
    if (p.toString() !== params.toString()) setParams(p, { replace: true });
  }, [sevOff, modeOff, year, cell, focus, ysrc, selId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [hover, setHover] = useState<Crash | null>(null);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => { if (copied === 'idle') return; const t = setTimeout(() => setCopied('idle'), 1600); return () => clearTimeout(t); }, [copied]);

  // 307 points: fetch once, filter on the client so every control answers instantly.
  const pts = useApi<FC<Crash>>('/vru');
  const all = useMemo(() => (pts.data?.features ?? []) as (FC<Crash>['features'][number])[], [pts.data]);
  const years = useMemo(() => [...new Set(all.map((f) => f.properties.year))].sort(), [all]);
  const span = years.length ? `${years[0]}–${years[years.length - 1]}` : '2021–2023';

  const focusTest = (p: Crash, f: NonNullable<Focus>) =>
    f.kind === 'light' ? lightGroup(p.light) === f.key
      : f.kind === 'speed' ? speedBin(p.speed_limit) === f.key
        : !!YIELD.find((y) => y.key === f.key)?.test[ysrc](p);

  // KA shares are always computed with the severity filter off (hiding K or A would make the share meaningless);
  // counts, the map and the CSV respect it.
  const pass = (p: Crash, skip: Dim | Dim[] = []) => {
    const sk = (d: Dim) => (Array.isArray(skip) ? skip.includes(d) : skip === d);
    return (sk('sev') || !sevOff.has(p.severity)) &&
      (sk('mode') || !modeOff.has(p.mode)) &&
      (sk('year') || year == null || p.year === year) &&
      (sk('cell') || !cell || (p.dow === cell[0] && p.hour === cell[1])) &&
      (!focus || sk(focus.kind) || focusTest(p, focus));
  };

  const deps = [all, sevOff, modeOff, year, cell, focus, ysrc];
  const feats = useMemo(() => all.filter((f) => pass(f.properties)), deps); // eslint-disable-line react-hooks/exhaustive-deps
  const without = (d: Dim | Dim[]) => all.filter((f) => pass(f.properties, d)).map((f) => f.properties);

  const counts = useMemo(() => {
    const sev: Record<string, number> = {}, mode: Record<string, number> = {};
    for (const { properties: p } of all) {
      if (pass(p, 'sev')) sev[p.severity] = (sev[p.severity] ?? 0) + 1;
      if (pass(p, 'mode')) mode[p.mode] = (mode[p.mode] ?? 0) + 1;
    }
    return { sev, mode };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  // Each breakdown ignores its own drill-down so the alternatives stay visible around the selection.
  const heat = useMemo(() => {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    const byHour = Array(24).fill(0) as number[];
    let unk = 0;
    for (const p of without('cell')) {
      if (p.hour != null && p.dow != null) { grid[p.dow][p.hour]++; byHour[p.hour]++; } else unk++;
    }
    const pk = peakWindow(byHour, 3);
    const timed = byHour.reduce((a, b) => a + b, 0);
    // KA share inside the window, severity filter off
    const inWin = (h: number | null) => h != null && [0, 1, 2].some((i) => (pk.start + i) % 24 === h);
    const win = without(['cell', 'sev']).filter((p) => inWin(p.hour));
    return { grid, unk, max: Math.max(1, ...grid.flat()), peak: { ...pk, ka: win.filter(isKA).length, kaN: win.length, timed }, noonGap: byHour[12] === 0 && byHour[0] >= 5, midnight: byHour[0] };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  const group = (rows: Crash[], defs: [string, string][], key: (p: Crash) => string): Row[] => {
    const m = new Map(defs.map(([k, l]) => [k, { key: k, label: l, n: 0, ka: 0 }]));
    for (const p of rows) { const e = m.get(key(p))!; e.n++; if (isKA(p)) e.ka++; }
    return [...m.values()].filter((r) => r.n > 0 || r.key !== 'unk');
  };
  const lightRows = useMemo(() => group(without(['light', 'sev']), LIGHT_GROUPS, (p) => lightGroup(p.light)), deps); // eslint-disable-line react-hooks/exhaustive-deps
  const speedRows = useMemo(() => group(without(['speed', 'sev']), SPEED_BINS, (p) => speedBin(p.speed_limit)), deps); // eslint-disable-line react-hooks/exhaustive-deps
  const yieldRows = useMemo(() => {
    const rows = without(['yield', 'sev']).filter((p) => p.mode === 'ped');
    const share = (hit: Crash[], f: (p: Crash) => boolean) => (hit.length ? hit.filter(f).length / hit.length : null);
    const out = YIELD.map((y) => {
      const hit = rows.filter(y.test[ysrc]);
      return {
        ...y, n: hit.length, ka: hit.filter(isKA).length,
        ctx: {
          dark: share(hit, (p) => lightGroup(p.light).startsWith('dark')),
          mid: share(hit, (p) => p.intersection === 'NON INTERSECTION'),
          fast: share(hit, (p) => (p.speed_limit ?? 0) >= 40),
        },
      };
    });
    const both = rows.filter((p) => YIELD.every((y) => y.test[ysrc](p))).length;
    return { out, both, peds: rows.length };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  const agg = useMemo(() => {
    const pbcat = new Map<string, { n: number; ka: number }>();
    let ka = 0, unlit = 0;
    for (const { properties: p } of feats) {
      if (isKA(p)) ka++;
      if (lightGroup(p.light) === 'dark-unlit') unlit++;
      const c = p.pbcat ?? 'Not recorded';
      const e = pbcat.get(c) ?? { n: 0, ka: 0 };
      e.n++; if (isKA(p)) e.ka++;
      pbcat.set(c, e);
    }
    return { ka, unlit, n: feats.length, pbcat: [...pbcat].sort((a, b) => b[1].n - a[1].n).slice(0, 10) };
  }, [feats]);

  const sources = useMemo<MapLayer[]>(() => {
    const sevColor = ['match', ['get', 'severity'], ...SEVS.flatMap((s) => [s, SEV_HEX[s]]), SEV_HEX.O];
    return [{
      id: 'vru', data: { type: 'FeatureCollection', features: feats },
      layers: [{
        id: 'vru-pt', type: 'circle',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, ['match', ['get', 'severity'], ['K', 'A'], 4, 3], 14, ['match', ['get', 'severity'], ['K', 'A'], 8, 6]],
          'circle-color': sevColor, 'circle-stroke-color': CHART.ground, 'circle-stroke-width': 1, 'circle-opacity': 0.9,
        },
      } as any],
    }];
  }, [feats]);
  const selFeature = selId ? feats.find((f) => f.properties.id === selId) : undefined;
  // a newly selected crash flashes a halo (skipped with reduced motion)
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (!selId || reducedMotion()) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 60);
    return () => clearTimeout(t);
  }, [selId]);
  const mapSources = useMemo<MapLayer[]>(() => [...sources, {
    id: 'vru-sel', data: { type: 'FeatureCollection', features: selFeature ? [selFeature] : [] },
    layers: [
      { id: 'vru-sel-halo', type: 'circle', paint: { 'circle-radius': pulse ? 30 : 11, 'circle-color': CHART.accent, 'circle-opacity': pulse ? 0.45 : 0, 'circle-radius-transition': { duration: pulse ? 0 : 420, delay: 0 }, 'circle-opacity-transition': { duration: pulse ? 0 : 420, delay: 0 } } } as any,
      { id: 'vru-sel-ring', type: 'circle', paint: { 'circle-radius': 11, 'circle-opacity': 0, 'circle-stroke-color': CHART.ink, 'circle-stroke-width': 2.5 } } as any,
    ],
  }], [sources, selFeature, pulse]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || typing(e)) return;
      if (selId) setSelId(null); else if (focus) setFocus(null); else if (cell) setCell(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selId, cell, focus]);

  const filtered = sevOff.size > 0 || modeOff.size > 0 || year != null || cell != null || focus != null;
  const reset = () => { setSevOff(new Set()); setModeOff(new Set()); setYear(null); setCell(null); setFocus(null); };
  const toggleFocus = (kind: FocusKind, key: string) => setFocus((f) => (f?.kind === kind && f.key === key ? null : { kind, key }));
  const focusLabel = focus
    ? focus.kind === 'light' ? LIGHT_GROUPS.find(([k]) => k === focus.key)?.[1]
      : focus.kind === 'speed' ? `Posted ${SPEED_BINS.find(([k]) => k === focus.key)?.[1]} mph`
        : `${YIELD.find((y) => y.key === focus.key)?.label} (${ysrc === 'pbcat' ? 'PBCAT' : 'CRIS factor'})`
    : null;
  const suffix = `${year ?? span.replace('–', '-')}${filtered ? '-filtered' : ''}`;
  const exportCsv = () => downloadCSV(`conflux-vru-crashes-${suffix}.csv`, feats.map(({ properties: p, geometry: g }) => ({
    crash_id: p.id, date: p.date, year: p.year, hour: p.hour, dow: p.dow != null ? DOW[p.dow] : '', severity: p.severity, mode: p.mode,
    pbcat: p.pbcat, light: p.light, light_group: lightGroup(p.light), speed_limit_mph: p.speed_limit, street: p.street, on_system: p.on_system,
    intersection: p.intersection, contributing: p.contributing, lon: (g.coordinates as number[])[0], lat: (g.coordinates as number[])[1],
  })));
  const rowsCsv = (name: string, rows: Row[]) => downloadCSV(`conflux-vru-${name}-${suffix}.csv`, rows.map((r) => {
    const [lo, hi] = wilson(r.ka, r.n);
    return { group: r.label, crashes: r.n, ka: r.ka, ka_share_pct: r.n ? +(100 * r.ka / r.n).toFixed(1) : '', ci95_lo_pct: +(100 * lo).toFixed(1), ci95_hi_pct: +(100 * hi).toFixed(1) };
  }));
  const caption = `Conflux · TxDOT CRIS VRU crashes, Lubbock County ${year ?? span}${filtered ? ' (filtered)' : ''}`;

  const pk = heat.peak;
  // One-line findings computed from the same rows the charts draw.
  const sum = (rows: Row[], keys: string[]) => rows.filter((r) => keys.includes(r.key)).reduce((a, r) => ({ n: a.n + r.n, ka: a.ka + r.ka }), { n: 0, ka: 0 });
  const lightFind = (() => {
    const d = sum(lightRows, ['day']), u = sum(lightRows, ['dark-unlit']);
    if (!d.n || !u.n) return null;
    return <>Dark, unlit: <b className="num">{pct(u.ka, u.n)}%</b> KA (n = <span className="num">{u.n}</span>) against <b className="num">{pct(d.ka, d.n)}%</b> in daylight (n = <span className="num">{d.n}</span>).</>;
  })();
  const speedFind = (() => {
    const lo = sum(speedRows, ['le25', '30', '35']), hi = sum(speedRows, ['50-55', '60-65', '70-75']);
    if (!lo.n || !hi.n) return null;
    return <>Posted ≥ 50 mph: <b className="num">{pct(hi.ka, hi.n)}%</b> KA (n = <span className="num">{hi.n}</span>) against <b className="num">{pct(lo.ka, lo.n)}%</b> at ≤ 35 mph (n = <span className="num">{lo.n}</span>).</>;
  })();
  const sel = selFeature?.properties ?? null;
  const readout = sel ?? hover;
  // severity-independent share for all KA comparisons
  const share = useMemo(() => { const b = without('sev'); return { n: b.length, ka: b.filter(isKA).length }; }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  const overallShare = share.n ? share.ka / share.n : 0;
  // Light × posted-speed strata: separates the two effects, which overlap (high-speed roads are less often lit)
  const strata = useMemo(() => {
    const rows = without(['light', 'speed', 'sev']).filter((p) => (p.speed_limit ?? 0) > 0 && ['day', 'dark-lit', 'dark-unlit'].includes(lightGroup(p.light)));
    const cell = (dark: boolean, fast: boolean) => {
      const r = rows.filter((p) => lightGroup(p.light).startsWith('dark') === dark && (p.speed_limit! >= 50) === fast);
      return { n: r.length, ka: r.filter(isKA).length };
    };
    return { rows: rows.length, c: [[cell(false, false), cell(false, true)], [cell(true, false), cell(true, true)]] };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  const mapRef = useReveal<HTMLElement>(), gridRef = useReveal<HTMLDivElement>();
  const heatFig = useRef<HTMLElement>(null), lightFig = useRef<HTMLDivElement>(null), speedFig = useRef<HTMLDivElement>(null);

  return (
    <div className="page vru">
      <PageHeader
        icon="ped"
        title="Pedestrian and cyclist crashes"
        lede={agg.n
          ? sevOff.size
            ? <>{nf(agg.n)} crashes shown with the severity filter on; across all severities in this view, {pct(share.ka, share.n)}% of {nf(share.n)} were fatal or suspected serious injury (KA).</>
            : <>{pct(agg.ka, agg.n)}% of {nf(agg.n)} crashes were fatal or suspected serious injury (KA); {pct(agg.unlit, agg.n)}% occurred on dark, unlit roads.</>
          : pts.loading ? 'Loading crash records…' : 'No crashes match these filters.'}
        source={<>Observed: TxDOT CRIS, Lubbock County, on and off system, {year ?? span}. KA shares, Wilson intervals, peak window and groupings are derived from those records. Informational use only; crash records are protected from discovery and use in litigation (23 U.S.C. §407). Counts are not exposure-adjusted rates.</>}
        readouts={[
          { label: <>Crashes <MetricInfo spec={COUNT_SPEC} align="right" /></>, value: pts.loading ? null : agg.n },
          { label: <>KA <MetricInfo spec={KA_SPEC} align="right" /></>, value: pts.loading ? null : agg.ka, tone: 'alert', unit: agg.n ? `${pct(agg.ka, agg.n)}%` : undefined },
          { label: 'Dark, unlit', value: agg.n ? (100 * agg.unlit) / agg.n : null, unit: '%', digits: 1 },
          { label: <span title="Share of timed crashes in the busiest 3-hour window">Peak {pk.n > 0 ? <span className="measure">{hh(pk.start)}–{hh(pk.start + 3)} h</span> : 'window'}</span>, value: pk.timed ? (100 * pk.n) / pk.timed : null, unit: '%', digits: 1 },
        ]}
        actions={<>
          <button type="button" className="btn ghost" onClick={exportCsv} disabled={!feats.length}><Icon name="download" size={16} /><span>Download CSV</span></button>
          <button type="button" className="btn ghost" onClick={async () => setCopied((await copyLink()) ? 'ok' : 'fail')} aria-live="polite"><Icon name={copied === 'ok' ? 'check' : 'link'} size={16} /><span>{copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Copy blocked' : 'Copy link'}</span></button>
        </>}
      />

      <section className="section vru-mapsec" aria-labelledby="vru-map-h" ref={mapRef}>
        <h2 id="vru-map-h" className="sr-only">Crash locations by KABCO severity</h2>
        <div className="vru-filters" role="toolbar" aria-label="Filters" data-r="1">
          <div className="vru-chips" role="group" aria-label="Road user">
            {MODES.map((m) => (
              <button key={m} type="button" className="vru-chip" aria-pressed={!modeOff.has(m)} title="Alt-click to show only this"
                onClick={(e) => setModeOff((o) => toggleSet(o, MODES, m, e.altKey))}>
                <Icon name={MODE_ICON[m]} size={16} />{MODE_LABEL[m]} <span className="num">{nf(counts.mode[m] ?? 0)}</span>
              </button>
            ))}
          </div>
          <div className="seg vru-years" role="group" aria-label="Year">
            <button type="button" aria-pressed={year == null} onClick={() => setYear(null)}>All years</button>
            {years.map((y) => <button key={y} type="button" className="num" aria-pressed={year === y} onClick={() => setYear(y)}>{y}</button>)}
          </div>
          {(focus || cell) && (
            <div className="vru-drills" aria-live="polite">
              {cell && <button type="button" className="vru-drill" onClick={() => setCell(null)} aria-label={`Remove time filter ${DOW[cell[0]]} ${hh(cell[1])}:00`}><Icon name="clock" size={14} /><span className="num">{DOW[cell[0]]} {hh(cell[1])}:00</span><Icon name="close" size={13} /></button>}
              {focus && <button type="button" className="vru-drill" onClick={() => setFocus(null)} aria-label={`Remove filter ${focusLabel}`}><Icon name="filter" size={14} />{focusLabel}<Icon name="close" size={13} /></button>}
            </div>
          )}
          <div className="vru-actions">
            {filtered && <button type="button" className="btn ghost" onClick={reset}><Icon name="reset" size={16} />Reset</button>}
          </div>
        </div>

        {pts.error && <div className="error-box">Crash points unavailable: {pts.error} <button type="button" className="btn ghost" onClick={() => location.reload()}>Reload</button></div>}
        <div className="vru-map panel" data-ui data-r="2">
          <MapView
            label="Pedestrian and cyclist crash locations coloured by KABCO severity"
            sources={mapSources}
            interactiveLayers={['vru-pt']}
            onHover={(f) => setHover((f?.properties as Crash) ?? null)}
            onClick={(_, f) => setSelId((f.properties as Crash).id)}
          />
          <div className="vru-legend" role="group" aria-label="KABCO severity layers">
            <span className="vru-legend-h"><Term k="KABCO" /></span>
            {SEVS.map((s) => (
              <button key={s} type="button" className="vru-lchip" aria-pressed={!sevOff.has(s)} title={`${SEV_LABEL[s]}. Alt-click to show only this`} aria-label={`${SEV_LABEL[s]}, ${counts.sev[s] ?? 0}`}
                onClick={(e) => setSevOff((o) => toggleSet(o, SEVS, s, e.altKey))}>
                <i style={{ background: SEV_HEX[s] }} />{s}<span className="vru-lname">{SEV_LABEL[s].slice(1)}</span><span className="num">{nf(counts.sev[s] ?? 0)}</span>
              </button>
            ))}
          </div>
          {!pts.loading && !pts.error && !feats.length && <div className="vru-empty">No crashes match these filters. <button type="button" className="btn ghost" onClick={reset}>Reset</button></div>}
          <div className="vru-readout" aria-live="polite" data-on={readout ? '' : undefined} data-pinned={sel ? '' : undefined} data-idle={!readout && !pts.loading ? '' : undefined}>
            {readout ? (
              <>
                <div className="vru-readout-h">
                  <Icon name={MODE_ICON[readout.mode] ?? 'ped'} size={16} />
                  <strong>{readout.street ?? 'Unnamed street'}</strong>
                  {sel && <button type="button" className="vru-x" onClick={() => setSelId(null)} aria-label="Clear selected crash"><Icon name="close" size={16} /></button>}
                </div>
                <div className="measure muted">{readout.date}{readout.hour != null ? ` · ${hh(readout.hour)}:00` : ''}{readout.dow != null ? ` ${DOW[readout.dow]}` : ''}</div>
                <div><i className="vru-dot" style={{ background: SEV_HEX[readout.severity] }} />{MODE_LABEL[readout.mode] ?? readout.mode} · {SEV_LABEL[readout.severity]}</div>
                {sel === readout ? (
                  <dl className="vru-dl">
                    <dt><Term k="PBCAT" /></dt><dd>{readout.pbcat ?? 'Not recorded'}</dd>
                    <dt>Lighting</dt><dd>{readout.light ? titleCase(readout.light) : 'Not recorded'}</dd>
                    <dt>Posted</dt><dd className="measure">{readout.speed_limit ? `${readout.speed_limit} mph` : '—'}</dd>
                    <dt>Location</dt><dd>{readout.intersection ? titleCase(readout.intersection) : '—'} · {readout.on_system ? 'on system' : 'off system'}</dd>
                    {readout.contributing && <><dt>Contributing</dt><dd>{titleCase(readout.contributing.replace(/;\s*/g, '; '))}</dd></>}
                    <dt>CRIS id</dt><dd className="measure">{readout.id}</dd>
                  </dl>
                ) : <div className="muted">{readout.pbcat ?? 'PBCAT not recorded'}</div>}
              </>
            ) : pts.loading ? <span className="muted">Loading crashes…</span> : null}
          </div>
        </div>
      </section>

      <div className="vru-grid" ref={gridRef}>
        <section className="section vru-card vru-wide" aria-labelledby="vru-hd" data-r="1">
          <SecHead id="vru-hd" icon="clock" title="Hour of week" why={<>
            <p>Crashes by day and hour, all filters applied. Peak: the busiest 3-hour window; a uniform spread would put 12.5% in any 3 hours.</p>
            {pk.n > 0 && <p>KA share in the window {pct(pk.ka, pk.kaN)}% (n = {pk.kaN}, 95% CI {nf(100 * wilson(pk.ka, pk.kaN)[0], 0)}–{nf(100 * wilson(pk.ka, pk.kaN)[1], 0)}%) against {pct(share.ka, share.n)}% overall.</p>}
            <p>{heat.unk > 0 && <>{heat.unk} without a recorded time are omitted. </>}{heat.noonGap
              ? <>No crash is recorded at 12:00–12:59 while {heat.midnight} are at 00:00–00:59: the source time field likely codes noon as “12 AM”.</>
              : <>The source has no “12 PM” times. “12 AM” crashes in daylight are read as noon; in darkness, as midnight.</>}</p>
            <p>Click a cell to filter the page.</p>
          </>}
            actions={<><ExportBtn kind="png" onClick={() => heatFig.current && downloadPNG(`conflux-vru-hour-of-week-${suffix}.png`, heatFig.current, caption)} />
              <ExportBtn kind="csv" onClick={() => downloadCSV(`conflux-vru-hour-of-week-${suffix}.csv`, heat.grid.flatMap((r, d) => r.map((v, h) => ({ dow: DOW[d], hour: h, crashes: v }))))} /></>} />
          <div className="vru-heat-wrap">
            <Heatmap ref={heatFig} grid={heat.grid} max={heat.max} cell={cell} onCell={setCell} peak={pk.n > 0 ? pk.start : null} />
            {pk.n > 0 && (
              <aside className="vru-peak" aria-label="Peak window">
                <span className="vru-peak-k"><Icon name="target" size={16} />Peak 3 h</span>
                <span className="vru-peak-v measure">{hh(pk.start)}:00–{hh(pk.start + 3)}:00</span>
                <span className="vru-peak-s"><span className="num">{pk.n}</span> / <span className="num">{pk.timed}</span> · <span className="num">{pct(pk.n, pk.timed)}%</span></span>
                <span className="vru-peak-s">KA <b className="num">{pct(pk.ka, pk.kaN)}%</b> vs <span className="num">{pct(share.ka, share.n)}%</span></span>
              </aside>
            )}
          </div>
        </section>

        <section className="section vru-card" aria-labelledby="vru-lt" data-r="2">
          <SecHead id="vru-lt" icon="moon" title="Light condition" why={<>
            <p>KA share by CRIS light condition, with 95% Wilson intervals. Roadway lighting is an FHWA Proven Safety Countermeasure.</p>
            {lightFind && <p>{lightFind}</p>}
            <p>Dashed rule: overall KA share. Click a row to filter the page.</p>
          </>}
            actions={<><ExportBtn kind="png" onClick={() => lightFig.current && downloadPNG(`conflux-vru-light-${suffix}.png`, lightFig.current, caption)} />
              <ExportBtn kind="csv" onClick={() => rowsCsv('light', lightRows)} /></>} />
          <Breakdown ref={lightFig} rows={lightRows} overall={overallShare} selected={focus?.kind === 'light' ? focus.key : null}
            onPick={(k) => toggleFocus('light', k)} label="Crashes and KA share by light condition" loading={pts.loading} />
        </section>

        <section className="section vru-card" aria-labelledby="vru-sp" data-r="3">
          <SecHead id="vru-sp" icon="gauge" title="Posted speed" why={<>
            <p>Posted limit as recorded in CRIS, a network proxy for impact speed. KA share with 95% Wilson intervals.</p>
            {speedFind && <p>{speedFind}</p>}
            <p>Dashed rule: overall KA share. Click a row to filter the page.</p>
          </>}
            actions={<><ExportBtn kind="png" onClick={() => speedFig.current && downloadPNG(`conflux-vru-speed-${suffix}.png`, speedFig.current, caption)} />
              <ExportBtn kind="csv" onClick={() => rowsCsv('posted-speed', speedRows)} /></>} />
          <Breakdown ref={speedFig} rows={speedRows} overall={overallShare} selected={focus?.kind === 'speed' ? focus.key : null} unit="mph"
            onPick={(k) => toggleFocus('speed', k)} label="Crashes and KA share by posted speed limit" loading={pts.loading} />
        </section>

        <section className="section vru-card vru-wide" aria-labelledby="vru-st" data-r="4">
          <SecHead id="vru-st" icon="warning" title="Darkness and speed" why={<>
            <p>KA share in each combination of light and posted speed, so one condition is not credited with the other’s effect. 95% Wilson intervals.</p>
            <p>{strataText(strata.c)}</p>
            <p>{strata.rows} crashes with a recorded light condition and posted speed; dawn, dusk and unknown excluded.</p>
          </>}
            actions={<ExportBtn kind="csv" onClick={() => downloadCSV(`conflux-vru-dark-by-speed-${suffix}.csv`, ([['Daylight', 0], ['Dark (lit or unlit)', 1]] as const).flatMap(([l, d]) => (['< 50 mph', '≥ 50 mph'] as const).map((sp, f) => { const c = strata.c[d][f]; const [lo, hi] = wilson(c.ka, c.n); return { light: l, posted: sp, crashes: c.n, ka: c.ka, ka_share_pct: c.n ? +(100 * c.ka / c.n).toFixed(1) : '', ci95_lo_pct: +(100 * lo).toFixed(1), ci95_hi_pct: +(100 * hi).toFixed(1) }; })))} />} />
          <Strata c={strata.c} />
        </section>

        <section className="section vru-card" aria-labelledby="vru-fy" data-r="5">
          <SecHead id="vru-fy" icon="sign" title="Failure to yield" why={<>
            <p>Pedestrian crashes only ({yieldRows.peds} in view). Driver-yielding treatments target motorist failure to yield.</p>
            <p>{ysrc === 'pbcat' ? 'PBCAT: crash type assigned from the crash narrative and diagram.' : <>CRIS factor: officer-coded contributing factors, up to three per crash{yieldRows.both ? `, so ${yieldRows.both} count in both groups` : ''}.</>}</p>
            <p>Click a card to filter the page.</p>
          </>}
            actions={<ExportBtn kind="csv" onClick={() => downloadCSV(`conflux-vru-failure-to-yield-${ysrc}-${suffix}.csv`, yieldRows.out.map((y) => ({ source: ysrc === 'pbcat' ? 'PBCAT crash type' : 'CRIS contributing factor', group: y.label, crashes: y.n, ka: y.ka, ka_share_pct: y.n ? +(100 * y.ka / y.n).toFixed(1) : '', of_pedestrian_crashes: yieldRows.peds })))} />} />
          <div className="seg vru-ysrc" role="group" aria-label="Yield classification source">
            <button type="button" aria-pressed={ysrc === 'pbcat'} onClick={() => { setYsrc('pbcat'); if (focus?.kind === 'yield') setFocus(null); }}>PBCAT</button>
            <button type="button" aria-pressed={ysrc === 'factor'} onClick={() => { setYsrc('factor'); if (focus?.kind === 'yield') setFocus(null); }}>CRIS factor</button>
          </div>
          <YieldSpot rows={yieldRows.out}
            selected={focus?.kind === 'yield' ? focus.key : null} onPick={(k) => toggleFocus('yield', k)} />
        </section>

        <section className="section vru-card" aria-labelledby="vru-pb" data-r="6">
          <SecHead id="vru-pb" icon="ped" title={<>Top <Term k="PBCAT" /> types</>} why={<p>The ten most frequent PBCAT pre-crash manoeuvre types. Bar length: crashes; red part: KA.</p>}
            actions={<ExportBtn kind="csv" onClick={() => downloadCSV(`conflux-vru-pbcat-${suffix}.csv`, agg.pbcat.map(([k, e]) => ({ pbcat: k, crashes: e.n, ka: e.ka })))} />} />
          <ol className="vru-bars" data-ui>
            {agg.pbcat.map(([k, e]) => (
              <li key={k} title={`${k}: ${e.n} crashes, ${e.ka} KA`}>
                <span className="vru-bar-l">{k}</span>
                <span className="vru-bar-t">
                  <span className="vru-bar" style={{ transform: `scaleX(${e.n / (agg.pbcat[0]?.[1].n || 1)})` }}>
                    <span className="vru-bar-ka" style={{ width: `${(100 * e.ka) / e.n}%` }} />
                  </span>
                </span>
                <span className="num vru-bar-v">{e.n}<small>{e.ka ? ` · ${e.ka} KA` : ''}</small></span>
              </li>
            ))}
            {pts.loading && <li className="muted">Loading crash types…</li>}
            {!agg.pbcat.length && !pts.loading && <li className="muted">No crashes match these filters.</li>}
          </ol>
        </section>
      </div>

    </div>
  );
}

/** One-sentence reading of the light × speed table. */
function strataText(c: { n: number; ka: number }[][]): ReactNode {
  const hi = c[1][1], lo = c[0][0];
  if (!hi.n || !lo.n) return 'Too few crashes in this view to compare the four groups.';
  const sh = (x: { n: number; ka: number }) => (x.n ? x.ka / x.n : NaN);
  const dark = sh(c[1][0]) > sh(c[0][0]) && sh(c[1][1]) > sh(c[0][1]);
  const fast = sh(c[0][1]) > sh(c[0][0]) && sh(c[1][1]) > sh(c[1][0]);
  return <>Dark and posted 50 mph or more: {pct(hi.ka, hi.n, 0)}% KA against {pct(lo.ka, lo.n, 0)}% in daylight under 50 mph. {dark && fast ? 'Darkness raises the share at both speed levels, and higher posted speed raises it in both light conditions.'
    : dark ? 'Darkness raises the share at both speed levels; the speed effect is not consistent across light conditions here.'
      : fast ? 'Higher posted speed raises the share in both light conditions; the darkness effect is not consistent here.'
        : 'Neither condition raises the share consistently in this view.'}</>;
}

function Strata({ c }: { c: { n: number; ka: number }[][] }) {
  const cellTxt = (x: { n: number; ka: number }) => {
    if (!x.n) return <span className="muted">no crashes</span>;
    const [lo, hi] = wilson(x.ka, x.n);
    return <><b className="num">{pct(x.ka, x.n, 0)}%</b> <span className="muted num">{nf(100 * lo, 0)}–{nf(100 * hi, 0)}</span><span className="vru-st-n">n = <span className="num">{x.n}</span>{x.n < 20 ? ' · small n' : ''}</span></>;
  };
  const hi = c[1][1], lo = c[0][0];
  return (
    <div className="vru-st">
      <div className="vru-st-scroll" role="region" aria-label="KA share by light and posted speed" tabIndex={0}>
        <table className="data vru-st-t">
          <caption className="sr-only">KA share of crashes by light condition (rows) and posted speed (columns), 95% Wilson intervals</caption>
          <thead><tr><th>Light</th><th className="r">&lt; 50 mph</th><th className="r">≥ 50 mph</th></tr></thead>
          <tbody>
            <tr><th scope="row"><Icon name="sun" size={15} />Daylight</th><td className="r" style={{ background: rampSoft(lo.n ? lo.ka / lo.n : 0) }}>{cellTxt(c[0][0])}</td><td className="r" style={{ background: rampSoft(c[0][1].n ? c[0][1].ka / c[0][1].n : 0) }}>{cellTxt(c[0][1])}</td></tr>
            <tr><th scope="row"><Icon name="moon" size={15} />Dark</th><td className="r" style={{ background: rampSoft(c[1][0].n ? c[1][0].ka / c[1][0].n : 0) }}>{cellTxt(c[1][0])}</td><td className="r" style={{ background: rampSoft(hi.n ? hi.ka / hi.n : 0) }}>{cellTxt(c[1][1])}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Short title, the explanation behind an info button, exports at the right. */
function SecHead({ id, icon, title, why, actions }: { id: string; icon: IconName; title: ReactNode; why: ReactNode; actions?: ReactNode }) {
  return (
    <div className="vru-sh">
      <div className="vru-sh-t">
        <h2 id={id}><Icon name={icon} size={20} weight="duotone" />{title}</h2>
        <Info label="About this chart" title={typeof title === 'string' ? title : undefined}>{why}</Info>
        {actions && <div className="vru-sh-a">{actions}</div>}
      </div>
    </div>
  );
}

function ExportBtn({ kind, onClick }: { kind: 'png' | 'csv'; onClick: () => void }) {
  return (
    <button type="button" className="btn ghost sm vru-exp" onClick={onClick} aria-label={`Download ${kind.toUpperCase()}`} title={`Download ${kind.toUpperCase()}`}>
      <Icon name={kind === 'png' ? 'image' : 'download'} size={16} />{kind.toUpperCase()}
    </button>
  );
}

/**
 * Two aligned panels on one row set: crash count (stacked KA | other, shared scale) and KA share with its
 * Wilson 95% interval against the filtered overall share. Rows are clickable drill-downs.
 */
function Breakdown({ ref, rows, overall, selected, onPick, label, unit, loading }: {
  ref: React.Ref<HTMLDivElement>; rows: Row[]; overall: number; selected: string | null; onPick: (k: string) => void; label: string; unit?: string; loading?: boolean;
}) {
  const [box, w] = useWidth<HTMLDivElement>();
  const [hov, setHov] = useState<string | null>(null);
  const narrow = w < 440;
  const LW = narrow ? 118 : 128, G = 20, RH = 34, TOP = 26, BOT = 24;
  const pw = Math.max(60, (w - LW - G) / 2 - 4);
  const x1 = LW, x2 = LW + pw + G;
  const H = TOP + rows.length * RH + BOT;
  const nMax = Math.max(1, ...rows.map((r) => r.n));
  const hiMax = Math.max(overall, ...rows.map((r) => wilson(r.ka, r.n)[1]));
  const sMax = Math.min(1, Math.ceil(hiMax * 4) / 4 || 0.25);
  const sx = (v: number) => x2 + (v / sMax) * (pw - 6);
  const show = rows.find((r) => r.key === (hov ?? selected));
  const ticks = (pw < 150 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).filter((t) => t <= sMax + 1e-9);
  return (
    <div className="vru-bd">
      <div ref={ref} className="vru-bd-fig">
      <div ref={box} className="vru-bd-box">
        {w > 0 && (
          <svg width={w} height={H} role="img" data-narrow={narrow || undefined} aria-label={`${label}. ${rows.map((r) => `${r.label}${unit && r.key !== 'unk' ? ` ${unit}` : ''}: ${r.n} crashes, ${r.ka} KA`).join('; ')}`} onMouseLeave={() => setHov(null)}>
            <text x={x1} y={14} className="vru-bd-h">Crashes <tspan className="vru-bd-hk">■ KA</tspan></text>
            <text x={x2} y={14} className="vru-bd-h">KA share, 95% CI</text>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={sx(t)} x2={sx(t)} y1={TOP - 4} y2={H - BOT + 2} className="vru-bd-grid" />
                {Math.abs(sx(t) - sx(overall)) > 40 && <text x={sx(t)} y={H - 6} textAnchor="middle" className="vru-bd-ax">{Math.round(t * 100)}%</text>}
              </g>
            ))}
            <line x1={sx(overall)} x2={sx(overall)} y1={TOP - 6} y2={H - BOT + 2} className="vru-bd-ref" />
            <text x={sx(overall)} y={H - 6} textAnchor="middle" className="vru-bd-refl">all {nf(100 * overall, 0)}%</text>
            {rows.map((r, i) => {
              const y = TOP + i * RH, cy = y + RH / 2;
              const wn = (r.n / nMax) * (pw - 34), wk = r.n ? (r.ka / r.n) * wn : 0;
              const [lo, hi] = wilson(r.ka, r.n);
              const on = selected === r.key, dim = selected != null && !on;
              return (
                <g key={r.key} className="vru-bd-row" data-on={on || undefined} data-dim={dim || undefined}
                  role="button" tabIndex={0} aria-pressed={on} aria-label={`${r.label}${unit && r.key !== 'unk' ? ` ${unit}` : ''}: ${r.n} crashes, ${r.ka} KA. Filter the page to this group`}
                  onMouseEnter={() => setHov(r.key)} onFocus={() => setHov(r.key)} onBlur={() => setHov(null)}
                  onClick={() => r.n && onPick(r.key)} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && r.n) { e.preventDefault(); onPick(r.key); } }}>
                  <rect x={0} y={y + 1} width={w} height={RH - 2} rx={6} className="vru-bd-hit" />
                  <text x={LW - 12} y={cy + 5} textAnchor="end" className="vru-bd-l">{r.label}</text>
                  <g className="vru-bd-bars" style={{ "--bd-i": i } as React.CSSProperties}>
                    {wk > 0 && <rect x={x1} y={cy - 7} width={Math.max(2, wk - (wn > wk ? 1 : 0))} height={14} rx={3} style={{ fill: 'var(--sev-a)' }} />}
                    {wn - wk > 1 && <rect x={x1 + wk + (wk > 0 ? 1 : 0)} y={cy - 7} width={Math.max(1, wn - wk - (wk > 0 ? 1 : 0))} height={14} rx={3} className="vru-bd-rest" />}
                  </g>
                  <text x={x1 + wn + 6} y={cy + 5} className="vru-bd-n">{r.n}</text>
                  {r.n > 0 && <>
                    <line x1={sx(lo)} x2={sx(hi)} y1={cy} y2={cy} className="vru-bd-ci" />
                    <circle cx={sx(r.ka / r.n)} cy={cy} r={5} className="vru-bd-dot" />
                  </>}
                </g>
              );
            })}
          </svg>
        )}
        {loading && !rows.some((r) => r.n) && <div className="skeleton vru-bd-skel" />}
      </div>
      </div>
      <p className="vru-bd-read" aria-live="polite">
        {show ? (() => { const [lo, hi] = wilson(show.ka, show.n); return <><b>{show.label}{unit && show.key !== 'unk' ? ` ${unit}` : ''}</b> · <span className="num">{show.n}</span> crashes, <span className="num">{show.ka}</span> KA (<span className="num">{pct(show.ka, show.n)}%</span>, CI <span className="num">{nf(100 * lo, 0)}–{nf(100 * hi, 0)}%</span>){selected === show.key ? ' · filter on' : ''}</>; })()
          : null}
      </p>
    </div>
  );
}

function YieldSpot({ rows, selected, onPick }: {
  rows: { key: string; label: string; short: string; icon: IconName; n: number; ka: number; ctx: Record<'dark' | 'mid' | 'fast', number | null> }[]; selected: string | null; onPick: (k: string) => void;
}) {
  const tot = rows.reduce((a, r) => a + r.n, 0);
  return (
    <div className="vru-yield">
      <div className="vru-ysplit" role="img" aria-label={rows.map((r) => `${r.label}: ${r.n}`).join(', ')}>
        {rows.map((r) => <span key={r.key} data-k={r.key} style={{ flexGrow: Math.max(r.n, 0.0001) }} />)}
      </div>
      <div className="vru-ycards">
        {rows.map((r) => {
          const [lo, hi] = wilson(r.ka, r.n);
          return (
            <button key={r.key} type="button" className="vru-ycard" data-k={r.key} aria-pressed={selected === r.key} disabled={!r.n} onClick={() => onPick(r.key)}
              aria-label={`${r.label}: ${r.n} crashes, ${r.ka} KA. Filter the page`}>
              <span className="vru-yk"><Icon name={r.icon} size={18} weight="duotone" />{r.label}</span>
              <span className="vru-yv"><span className="num">{r.n}</span><small>{tot ? `${pct(r.n, tot, 0)}%` : ''}</small></span>
              <span className="vru-ys" title={`KA share ${pct(r.ka, r.n)}%, 95% CI ${nf(100 * lo, 0)}–${nf(100 * hi, 0)}%`}><span className="num">{r.ka}</span> KA · <span className="num">{pct(r.ka, r.n)}%</span></span>
            </button>
          );
        })}
      </div>
      <table className="data vru-yctx">
        <caption className="sr-only">Context of yield-coded pedestrian crashes</caption>
        <thead><tr><th>Share</th>{rows.map((r) => <th key={r.key} className="r">{r.short}</th>)}</tr></thead>
        <tbody>
          {([['dark', 'Dark', 'moon'], ['mid', 'Midblock', 'path'], ['fast', 'Posted ≥ 40 mph', 'gauge']] as const).map(([k, l, ic]) => (
            <tr key={k}>
              <td><Icon name={ic} size={15} />{l}</td>
              {rows.map((r) => <td key={r.key} className="r num">{r.ctx[k] == null ? '—' : `${nf(100 * r.ctx[k]!, 0)}%`}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Heatmap({ ref, grid, max, cell, onCell, peak }: { ref: React.Ref<HTMLElement>; grid: number[][]; max: number; cell: [number, number] | null; onCell: (c: [number, number] | null) => void; peak: number | null }) {
  const [hov, setHov] = useState<[number, number] | null>(null);
  const cw = 24, ch = 24, L = 44, T = 22, W = L + 24 * cw, H = T + 7 * ch + 26;
  const show = hov ?? cell;
  const scroller = useRef<HTMLDivElement>(null);
  // On narrow screens the week scrolls sideways: bring the peak window into view rather than midnight.
  useEffect(() => {
    const el = scroller.current;
    if (!el || peak == null || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft = Math.max(0, ((L + (peak + 1.5) * cw) / W) * el.scrollWidth - el.clientWidth / 2);
  }, [peak]); // eslint-disable-line react-hooks/exhaustive-deps
  // Peak bracket: up to two segments when the window wraps midnight.
  const segs = peak == null ? [] : peak + 3 <= 24 ? [[peak, peak + 3]] : [[peak, 24], [0, (peak + 3) % 24]];
  return (
    <figure className="vru-heat" ref={ref} data-ui data-cell={cell ? '' : undefined} onMouseLeave={() => setHov(null)}>
      <div className="vru-heat-scroll" ref={scroller} tabIndex={0} aria-label="Hour-of-week heatmap, scrolls horizontally on small screens">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Heatmap of crashes by hour of day and day of week${peak != null ? `; peak window ${hh(peak)}:00 to ${hh(peak + 3)}:00` : ''}; click a cell to filter the map`}>
          {segs.map(([a, b], i) => (
            <g key={i} className="vru-pk">
              <rect x={L + a * cw - 2} y={T - 3} width={(b - a) * cw + 1} height={7 * ch + 2} rx={5} className="vru-pk-band" />
              <path d={`M${L + a * cw} ${T - 6} V${T - 12} H${L + b * cw - 3} V${T - 6}`} />
              {i === 0 && <text x={L + a * cw} y={T - 15} className="vru-pk-t">peak</text>}
            </g>
          ))}
          {grid.map((row, d) => (
            <g key={d}>
              <text x={L - 10} y={T + d * ch + ch / 2 + 4} textAnchor="end" className="vru-ax" data-on={show?.[0] === d || undefined}>{DOW[d]}</text>
              {row.map((v, h) => {
                const on = cell?.[0] === d && cell?.[1] === h;
                return (
                  <rect key={h} x={L + h * cw} y={T + d * ch} width={cw - 3} height={ch - 3} rx={3} style={{ fill: ramp(v / max) }}
                    data-on={on || undefined} onMouseEnter={() => setHov([d, h])} onClick={() => onCell(on ? null : [d, h])}>
                    <title>{`${DOW[d]} ${hh(h)}:00, ${v} crash${v === 1 ? '' : 'es'}`}</title>
                  </rect>
                );
              })}
            </g>
          ))}
          {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
            <text key={h} x={L + h * cw + (cw - 3) / 2} y={T + 7 * ch + 16} textAnchor="middle" className="vru-ax num">{hh(h)}</text>
          ))}
        </svg>
      </div>
      <figcaption className="vru-heat-legend" aria-live="polite">
        <span className="num">0</span>
        <span className="vru-steps" aria-hidden="true">{[0, 0.25, 0.5, 0.75, 1].map((t) => <i key={t} style={{ background: ramp(t) }} />)}</span>
        <span className="num">{max}</span>
        <span className="vru-cell">
          {show ? <><span className="measure">{DOW[show[0]]} {hh(show[1])}:00</span>, <span className="num">{grid[show[0]][show[1]]}</span> crashes</> : 'crashes'}
        </span>
      </figcaption>
    </figure>
  );
}
