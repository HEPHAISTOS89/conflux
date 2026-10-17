import { useEffect, useMemo, useState } from 'react';
import MapView, { type MapLayer } from '../components/MapView';
import { Icon } from '../components/Icon';
import Term from '../components/Term';
import { useApi } from '../lib/api';
import { useReveal, useTween } from '../lib/motion';
import { CHART, nf, SEV_HEX, SEV_LABEL } from '../lib/format';
import type { FC, Severity, VruProps } from '../lib/types';
import '../styles/vru.css';

type Crash = Omit<VruProps, 'mode'> & { mode: string; intersection?: string | null; contributing?: string | null; ka_count?: number };
type Dim = 'sev' | 'mode' | 'year' | 'cell';
const SEVS: Severity[] = ['K', 'A', 'B', 'C', 'O'];
const MODES = ['ped', 'bike', 'scooter'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MODE_LABEL: Record<string, string> = { ped: 'Pedestrian', bike: 'Cyclist', scooter: 'Scooter / other' };
const hh = (h: number) => String(h).padStart(2, '0');

/** Sequential ramp from --sheet to --sev-a, resolved by CSS so it follows the theme. */
const ramp = (t: number) => `color-mix(in srgb, var(--sev-a) ${Math.round(t * 100)}%, var(--sheet))`;
const lightLabel = (s: string) => s.replace(/^\d+\s*-\s*/, '').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const typing = (e: KeyboardEvent) => e.metaKey || e.ctrlKey || e.altKey || !!(e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]') || !!document.querySelector('.cmdk-scrim');

const csvCell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function downloadCsv(name: string, cols: string[], rows: unknown[][]) {
  const text = [cols, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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

export default function Vru() {
  const [sevOff, setSevOff] = useState<Set<Severity>>(new Set());
  const [modeOff, setModeOff] = useState<Set<string>>(new Set());
  const [year, setYear] = useState<number | null>(null);
  const [cell, setCell] = useState<[number, number] | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [hover, setHover] = useState<Crash | null>(null);

  // 307 points: fetch once, filter on the client so every control answers instantly.
  const pts = useApi<FC<Crash>>('/vru');
  const all = useMemo(() => (pts.data?.features ?? []) as (FC<Crash>['features'][number])[], [pts.data]);
  const years = useMemo(() => [...new Set(all.map((f) => f.properties.year))].sort(), [all]);

  const pass = (p: Crash, skip?: Dim) =>
    (skip === 'sev' || !sevOff.has(p.severity)) &&
    (skip === 'mode' || !modeOff.has(p.mode)) &&
    (skip === 'year' || year == null || p.year === year) &&
    (skip === 'cell' || !cell || (p.dow === cell[0] && p.hour === cell[1]));

  const feats = useMemo(() => all.filter((f) => pass(f.properties)), [all, sevOff, modeOff, year, cell]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => {
    const sev: Record<string, number> = {}, mode: Record<string, number> = {};
    for (const { properties: p } of all) {
      if (pass(p, 'sev')) sev[p.severity] = (sev[p.severity] ?? 0) + 1;
      if (pass(p, 'mode')) mode[p.mode] = (mode[p.mode] ?? 0) + 1;
    }
    return { sev, mode };
  }, [all, sevOff, modeOff, year, cell]); // eslint-disable-line react-hooks/exhaustive-deps

  // The heatmap ignores its own cell filter so the rest of the week stays visible around the selection.
  const heat = useMemo(() => {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    let unk = 0;
    for (const { properties: p } of all) {
      if (!pass(p, 'cell')) continue;
      if (p.hour != null && p.dow != null) grid[p.dow][p.hour]++; else unk++;
    }
    return { grid, unk, max: Math.max(1, ...grid.flat()) };
  }, [all, sevOff, modeOff, year]); // eslint-disable-line react-hooks/exhaustive-deps

  const agg = useMemo(() => {
    const pbcat = new Map<string, number>(), light = new Map<string, { n: number; ka: number }>();
    let ka = 0;
    for (const { properties: p } of feats) {
      const isKa = p.severity === 'K' || p.severity === 'A';
      if (isKa) ka++;
      const c = p.pbcat ?? 'Not recorded';
      pbcat.set(c, (pbcat.get(c) ?? 0) + 1);
      const l = p.light ? lightLabel(p.light) : 'Not recorded';
      const e = light.get(l) ?? { n: 0, ka: 0 };
      e.n++; if (isKa) e.ka++;
      light.set(l, e);
    }
    return { ka, n: feats.length, pbcat: [...pbcat].sort((a, b) => b[1] - a[1]).slice(0, 10), light: [...light].sort((a, b) => b[1].n - a[1].n) };
  }, [feats]);


  const sources = useMemo<MapLayer[]>(() => {
    const sevColor = ['match', ['get', 'severity'], ...SEVS.flatMap((s) => [s, SEV_HEX[s]]), SEV_HEX.O];
    return [{
      id: 'vru', data: { type: 'FeatureCollection', features: feats },
      layers: [
        {
          id: 'vru-pt', type: 'circle',
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, ['match', ['get', 'severity'], ['K', 'A'], 4, 3], 14, ['match', ['get', 'severity'], ['K', 'A'], 8, 6]],
            'circle-color': sevColor, 'circle-stroke-color': CHART.ground, 'circle-stroke-width': 1, 'circle-opacity': 0.9,
          },
        } as any,
      ],
    }];
  }, [feats]);
  const selFeature = selId ? feats.find((f) => f.properties.id === selId) : undefined;
  const mapSources = useMemo<MapLayer[]>(() => [...sources, {
    id: 'vru-sel', data: { type: 'FeatureCollection', features: selFeature ? [selFeature] : [] },
    layers: [{ id: 'vru-sel-ring', type: 'circle', paint: { 'circle-radius': 11, 'circle-opacity': 0, 'circle-stroke-color': CHART.ink, 'circle-stroke-width': 2.5 } } as any],
  }], [sources, selFeature]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || typing(e)) return;
      if (selId) setSelId(null); else if (cell) setCell(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selId, cell]);

  const filtered = sevOff.size > 0 || modeOff.size > 0 || year != null || cell != null;
  const reset = () => { setSevOff(new Set()); setModeOff(new Set()); setYear(null); setCell(null); };
  const exportCsv = () => downloadCsv(`roadscope-vru-crashes${year ? `-${year}` : ''}${filtered ? '-filtered' : ''}.csv`,
    ['crash_id', 'date', 'year', 'hour', 'dow', 'severity', 'mode', 'pbcat', 'light', 'speed_limit_mph', 'street', 'on_system', 'intersection', 'contributing', 'lon', 'lat'],
    feats.map(({ properties: p, geometry: g }) => [p.id, p.date, p.year, p.hour, p.dow != null ? DOW[p.dow] : '', p.severity, p.mode, p.pbcat, p.light, p.speed_limit, p.street, p.on_system, p.intersection, p.contributing, ...(g.coordinates as number[])]));

  const pbMax = agg.pbcat[0]?.[1] ?? 1;
  const shown = useTween(agg.n);
  const headRef = useReveal<HTMLElement>(), mapRef = useReveal<HTMLElement>(), colsRef = useReveal<HTMLDivElement>(), lightRef = useReveal<HTMLElement>();
  const sel = selFeature?.properties ?? null;
  const readout = sel ?? hover;

  return (
    <div className="page vru">
      <header className="page-head vru-head" ref={headRef}>
        <h1 data-r="1">Pedestrian and cyclist crashes</h1>
        <p data-r="2">
          TxDOT CRIS{years.length ? `, ${years[0]}–${years[years.length - 1]}` : ''}, Lubbock County, on and off the state system. Candidates for field review, not findings of cause.
        </p>
      </header>

      <section className="section vru-mapsec" aria-labelledby="vru-map-h" ref={mapRef}>
        <h2 id="vru-map-h" className="sr-only">Crash locations by KABCO severity</h2>
        <div className="vru-count" data-r="1" aria-live="polite">
          <span className="vru-big num" data-busy={pts.loading || undefined}>{nf(Math.round(shown))}</span>
          <span className="vru-count-l">
            crashes, <span className="num">{nf(agg.ka)}</span> killed or seriously injured
            {agg.n ? <> (<span className="num">{nf((100 * agg.ka) / agg.n, 1)}</span>%)</> : null}
            {cell && <> · <span className="num">{DOW[cell[0]]} {hh(cell[1])}:00</span></>}
          </span>
        </div>

        <div className="vru-filters" role="toolbar" aria-label="Filters" data-r="2">
          <div className="vru-chips" role="group" aria-label="Road user">
            {MODES.map((m) => (
              <button key={m} type="button" className="vru-chip" aria-pressed={!modeOff.has(m)} title="Alt-click to show only this"
                onClick={(e) => setModeOff((o) => toggleSet(o, MODES, m, e.altKey))}>
                {MODE_LABEL[m]} <span className="num">{nf(counts.mode[m] ?? 0)}</span>
              </button>
            ))}
          </div>
          <div className="seg vru-years" role="group" aria-label="Year">
            <button type="button" aria-pressed={year == null} onClick={() => setYear(null)}>All years</button>
            {years.map((y) => <button key={y} type="button" className="num" aria-pressed={year === y} onClick={() => setYear(y)}>{y}</button>)}
          </div>
          <div className="vru-actions">
            {filtered && <button type="button" className="btn ghost" onClick={reset}>Reset filters</button>}
            <button type="button" className="btn ghost" onClick={exportCsv} disabled={!feats.length}>Export CSV</button>
          </div>
        </div>

        {pts.error && <div className="error-box">Crash points unavailable: {pts.error} <button type="button" className="btn ghost" onClick={() => location.reload()}>Reload</button></div>}
        <div className="vru-map panel" data-ui data-r="3">
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
            <span className="vru-legend-tip">Alt-click isolates</span>
          </div>
          {!pts.loading && !pts.error && !feats.length && <div className="vru-empty">No crashes match these filters. <button type="button" className="btn ghost" onClick={reset}>Reset</button></div>}
          <div className="vru-readout" aria-live="polite" data-on={readout ? '' : undefined} data-pinned={sel ? '' : undefined}>
            {readout ? (
              <>
                <div className="vru-readout-h">
                  <strong>{readout.street ?? 'Unnamed street'}</strong>
                  {sel && <button type="button" className="vru-x" onClick={() => setSelId(null)} aria-label="Clear selected crash"><Icon name="close" size={16} /></button>}
                </div>
                <div className="num muted">{readout.date}{readout.hour != null ? ` · ${hh(readout.hour)}:00` : ''}{readout.dow != null ? ` ${DOW[readout.dow]}` : ''}</div>
                <div><i className="vru-dot" style={{ background: SEV_HEX[readout.severity] }} />{MODE_LABEL[readout.mode] ?? readout.mode} · {SEV_LABEL[readout.severity]}</div>
                {sel === readout ? (
                  <dl className="vru-dl">
                    <dt><Term k="PBCAT" /></dt><dd>{readout.pbcat ?? 'Not recorded'}</dd>
                    <dt>Lighting</dt><dd>{readout.light ? lightLabel(readout.light) : 'Not recorded'}</dd>
                    <dt>Posted</dt><dd className="num">{readout.speed_limit ? `${readout.speed_limit} mph` : '—'}</dd>
                    <dt>Location</dt><dd>{readout.intersection ? lightLabel(readout.intersection) : '—'} · {readout.on_system ? 'on system' : 'off system'}</dd>
                    {readout.contributing && <><dt>Contributing</dt><dd>{lightLabel(readout.contributing.replace(/;\s*/g, "; "))}</dd></>}
                    <dt>CRIS id</dt><dd className="num">{readout.id}</dd>
                  </dl>
                ) : <div className="muted">{readout.pbcat ?? 'PBCAT not recorded'}</div>}
              </>
            ) : <span className="muted">{pts.loading ? 'Loading crashes…' : 'Click a point for details'}</span>}
          </div>
        </div>
      </section>

      <div className="vru-cols" ref={colsRef}>
        <section className="section" aria-labelledby="vru-hd" data-r="1">
          <h2 id="vru-hd">When they happen</h2>
          <Heatmap grid={heat.grid} max={heat.max} cell={cell} onCell={setCell} />
          {heat.unk > 0 && <p className="muted vru-note"><span className="num">{heat.unk}</span> without a recorded time are omitted.</p>}
        </section>

        <section className="section" aria-labelledby="vru-pb" data-r="2">
          <h2 id="vru-pb">Ten most frequent <Term k="PBCAT" /> types</h2>
          <ol className="vru-bars" data-ui>
            {agg.pbcat.map(([k, v]) => (
              <li key={k}>
                <span className="vru-bar-l">{k}</span>
                <span className="vru-bar-t"><span className="vru-bar" style={{ transform: `scaleX(${v / pbMax})` }} /></span>
                <span className="num vru-bar-v">{v}</span>
              </li>
            ))}
            {pts.loading && <li className="muted">Loading crash types…</li>}
            {!agg.pbcat.length && !pts.loading && <li className="muted">No crashes match these filters.</li>}
          </ol>
        </section>
      </div>

      <section className="section vru-light" aria-labelledby="vru-lt" ref={lightRef}>
        <h2 id="vru-lt" data-r="1">Lighting</h2>
        <div className="vru-table-wrap" data-ui data-r="2">
          <table className="data">
            <thead><tr><th>Lighting</th><th className="r">Crashes</th><th className="r">Share</th><th className="r">KA</th><th className="r">KA share</th></tr></thead>
            <tbody>
              {agg.light.map(([k, e]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="r num">{e.n}</td>
                  <td className="r num">{nf((100 * e.n) / Math.max(1, agg.n), 1)}%</td>
                  <td className="r num">{e.ka}</td>
                  <td className="r num">{nf((100 * e.ka) / e.n, 1)}%</td>
                </tr>
              ))}
              {!agg.light.length && <tr><td colSpan={5} className="muted">{pts.loading ? 'Loading…' : 'No crashes match these filters.'}</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="muted vru-source" data-r="3">
          TxDOT CRIS, Active Transportation Crashes layer. Informational use only; not for litigation (23 U.S.C. §407).
        </p>
      </section>
    </div>
  );
}

function Heatmap({ grid, max, cell, onCell }: { grid: number[][]; max: number; cell: [number, number] | null; onCell: (c: [number, number] | null) => void }) {
  const [hov, setHov] = useState<[number, number] | null>(null);
  const cw = 24, ch = 24, L = 44, T = 4, W = L + 24 * cw, H = T + 7 * ch + 26;
  const show = hov ?? cell;
  return (
    <figure className="vru-heat" data-ui data-cell={cell ? '' : undefined} onMouseLeave={() => setHov(null)}>
      <div className="vru-heat-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Heatmap of crashes by hour of day and day of week; click a cell to filter the map">
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
          {show ? <><span className="num">{DOW[show[0]]} {hh(show[1])}:00</span>, <span className="num">{grid[show[0]][show[1]]}</span> crashes</> : 'per hour of the week · click to filter'}
        </span>
        {cell && <button type="button" className="btn ghost vru-cell-x" onClick={() => onCell(null)}>Clear {DOW[cell[0]]} {hh(cell[1])}:00</button>}
      </figcaption>
    </figure>
  );
}
