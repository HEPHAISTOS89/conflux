import { useMemo, useState } from 'react';
import MapView, { type MapLayer } from '../components/MapView';
import { useApi } from '../lib/api';
import { nf, SEV_HEX, SEV_LABEL } from '../lib/format';
import type { FC, Severity, VruProps, VruSummary } from '../lib/types';
import '../styles/vru.css';

type Mode = 'all' | 'ped' | 'bike' | 'scooter';
const SEVS: Severity[] = ['K', 'A', 'B', 'C', 'O'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MODE_LABEL: Record<string, string> = { ped: 'Pedestrian', bike: 'Cyclist', scooter: 'Scooter / other' };

const sevColor: any = ['match', ['get', 'severity'], ...SEVS.flatMap((s) => [s, SEV_HEX[s]]), '#98a1a7'];

/** Sequential ramp from paper (#f3f4f1) to --sev-a (#b3261e). */
function ramp(t: number): string {
  const a = [0xf3, 0xf4, 0xf1], b = [0xb3, 0x26, 0x1e];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
}
const lightLabel = (s: string) => s.replace(/^\d+\s*-\s*/, '').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export default function Vru() {
  const [mode, setMode] = useState<Mode>('all');
  const [sev, setSev] = useState<Severity[]>([]);
  const [year, setYear] = useState<number | null>(null);
  const [hover, setHover] = useState<VruProps | null>(null);

  const sum = useApi<VruSummary>('/vru/summary');
  const qs = new URLSearchParams();
  // API accepts mode=ped|bike only; scooter is filtered client-side from the unfiltered-by-mode response.
  if (mode === 'ped' || mode === 'bike') qs.set('mode', mode);
  if (sev.length) qs.set('severity', sev.join(','));
  if (year) qs.set('year', String(year));
  const pts = useApi<FC<VruProps>>(`/vru${qs.toString() ? `?${qs}` : ''}`);

  const feats = useMemo(() => {
    const f = pts.data?.features ?? [];
    return mode === 'scooter' ? f.filter((x) => (x.properties.mode as string) === 'scooter') : f;
  }, [pts.data, mode]);

  const years = useMemo(() => {
    const y = Object.keys(sum.data?.by_year ?? {}).map(Number).sort();
    return y.length ? y : [2021, 2022, 2023];
  }, [sum.data]);

  // Breakdowns follow the active filter, computed from the returned points.
  const agg = useMemo(() => {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    const pbcat = new Map<string, number>(), light = new Map<string, { n: number; ka: number }>();
    let ka = 0, unk = 0;
    for (const { properties: p } of feats) {
      if (p.hour != null && p.dow != null) grid[p.dow][p.hour]++; else unk++;
      const isKa = p.severity === 'K' || p.severity === 'A';
      if (isKa) ka++;
      const c = p.pbcat ?? 'Not recorded';
      pbcat.set(c, (pbcat.get(c) ?? 0) + 1);
      const l = p.light ? lightLabel(p.light) : 'Not recorded';
      const e = light.get(l) ?? { n: 0, ka: 0 };
      e.n++; if (isKa) e.ka++;
      light.set(l, e);
    }
    const max = Math.max(1, ...grid.flat());
    return {
      grid, max, unk, ka, n: feats.length,
      pbcat: [...pbcat].sort((a, b) => b[1] - a[1]).slice(0, 10),
      light: [...light].sort((a, b) => b[1].n - a[1].n),
    };
  }, [feats]);

  const sources = useMemo<MapLayer[]>(() => [{
    id: 'vru', data: { type: 'FeatureCollection', features: feats },
    layers: [{
      id: 'vru-pt', type: 'circle',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, ['match', ['get', 'severity'], ['K', 'A'], 4, 3], 14, ['match', ['get', 'severity'], ['K', 'A'], 8, 6]],
        'circle-color': sevColor, 'circle-stroke-color': '#fbfbf9', 'circle-stroke-width': 1, 'circle-opacity': 0.9,
      },
    } as any],
  }], [feats]);

  const toggleSev = (s: Severity) => setSev((v) => (v.includes(s) ? v.filter((x) => x !== s) : [...v, s]));
  const pbMax = agg.pbcat[0]?.[1] ?? 1;

  return (
    <div className="page vru">
      <header className="page-head">
        <h1>Pedestrian and cyclist crashes in Lubbock County</h1>
        <p>
          Crashes involving people on foot, on bicycles and on scooters, from TxDOT's Active Transportation crash layer
          for {years[0]}–{years[years.length - 1]}. Where and when vulnerable road users are struck, and the PBCAT
          pre-crash type, is the starting evidence for siting failure-to-yield countermeasures: high-visibility
          crosswalks, RRFBs, PHBs, leading pedestrian intervals and lighting. Locations here are candidates for field
          review, not findings of cause.
        </p>
      </header>

      <section className="section" aria-labelledby="vru-map-h">
        <div className="section-head">
          <h2 id="vru-map-h">Crash locations by KABCO severity</h2>
          <p className="num" aria-live="polite">{pts.loading ? 'Loading…' : `${nf(agg.n)} crashes · ${nf(agg.ka)} KA (${agg.n ? nf((100 * agg.ka) / agg.n, 1) : '—'}%)`}</p>
        </div>

        <div className="vru-filters" role="group" aria-label="Filters">
          <div className="vru-filter">
            <span className="vru-flabel">Mode</span>
            <div className="seg">
              {(['all', 'ped', 'bike', 'scooter'] as Mode[]).map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{m === 'all' ? 'All' : MODE_LABEL[m]}</button>
              ))}
            </div>
          </div>
          <div className="vru-filter">
            <span className="vru-flabel">Severity</span>
            <div className="seg">
              {SEVS.map((s) => (
                <button key={s} type="button" aria-pressed={sev.includes(s)} onClick={() => toggleSev(s)} title={SEV_LABEL[s]}>
                  <span className="vru-sw" style={{ background: SEV_HEX[s] }} aria-hidden="true" />{s}
                </button>
              ))}
            </div>
          </div>
          <div className="vru-filter">
            <span className="vru-flabel">Year</span>
            <div className="seg">
              <button type="button" aria-pressed={year == null} onClick={() => setYear(null)}>All</button>
              {years.map((y) => <button key={y} type="button" className="num" aria-pressed={year === y} onClick={() => setYear(y)}>{y}</button>)}
            </div>
          </div>
        </div>

        {pts.error && <div className="error-box">Could not load crash points: {pts.error}</div>}
        <div className="vru-map panel">
          <MapView
            label="Pedestrian and cyclist crash locations coloured by KABCO severity"
            sources={sources}
            interactiveLayers={['vru-pt']}
            onHover={(f) => setHover((f?.properties as VruProps) ?? null)}
          />
          <div className="vru-legend">
            {SEVS.map((s) => <span key={s}><i style={{ background: SEV_HEX[s] }} />{SEV_LABEL[s]}</span>)}
          </div>
          <div className="vru-readout" aria-live="polite">
            {hover ? (
              <>
                <strong>{hover.street ?? 'Unnamed street'}</strong> <span className="num muted">{hover.date}</span>
                <div>{MODE_LABEL[hover.mode] ?? hover.mode} · {SEV_LABEL[hover.severity]}</div>
                <div className="muted">{hover.pbcat ?? 'PBCAT not recorded'}</div>
                <div className="muted">{hover.light ? lightLabel(hover.light) : ''}{hover.speed_limit ? <> · <span className="num">{hover.speed_limit}</span> mph posted</> : null}</div>
              </>
            ) : <span className="muted">Hover a point for crash details.</span>}
          </div>
        </div>
      </section>

      <div className="vru-cols">
        <section className="section" aria-labelledby="vru-hd">
          <div className="section-head"><h2 id="vru-hd">Hour of day by day of week</h2></div>
          <Heatmap grid={agg.grid} max={agg.max} />
          {agg.unk > 0 && <p className="muted vru-note"><span className="num">{agg.unk}</span> crashes without a recorded time are omitted.</p>}
        </section>

        <section className="section" aria-labelledby="vru-pb">
          <div className="section-head"><h2 id="vru-pb">PBCAT crash type</h2><p>Top 10 under current filter</p></div>
          <ol className="vru-bars">
            {agg.pbcat.map(([k, v]) => (
              <li key={k}>
                <span className="vru-bar-l">{k}</span>
                <span className="vru-bar-t"><span className="vru-bar" style={{ width: `${(100 * v) / pbMax}%` }} /></span>
                <span className="num vru-bar-v">{v}</span>
              </li>
            ))}
            {!agg.pbcat.length && !pts.loading && <li className="muted">No crashes match the filter.</li>}
          </ol>
        </section>
      </div>

      <section className="section" aria-labelledby="vru-lt">
        <div className="section-head"><h2 id="vru-lt">Lighting condition</h2><p>KA share is fatal plus suspected-serious injury over all crashes in the row</p></div>
        <div className="vru-table-wrap">
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
            </tbody>
          </table>
        </div>
      </section>

      <p className="muted vru-source">
        Source: TxDOT Crash Records Information System via the Active Transportation Crashes feature service, {years[0]}–{years[years.length - 1]},
        Lubbock County. Informational use only; TxDOT makes no warranty as to accuracy, and these records are not to be
        used for litigation (23 U.S.C. §407).
      </p>
    </div>
  );
}

function Heatmap({ grid, max }: { grid: number[][]; max: number }) {
  const cw = 22, ch = 22, L = 36, T = 6, W = L + 24 * cw, H = T + 7 * ch + 22;
  return (
    <figure className="vru-heat">
      <div className="vru-heat-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Heatmap of crashes by hour of day and day of week">
          {grid.map((row, d) => (
            <g key={d}>
              <text x={L - 6} y={T + d * ch + ch / 2 + 4} textAnchor="end" className="vru-ax">{DOW[d]}</text>
              {row.map((v, h) => (
                <rect key={h} x={L + h * cw} y={T + d * ch} width={cw - 2} height={ch - 2} rx={1} fill={ramp(v / max)} stroke="var(--grid)" strokeWidth={0.5}>
                  <title>{`${DOW[d]} ${String(h).padStart(2, '0')}:00 — ${v} crash${v === 1 ? '' : 'es'}`}</title>
                </rect>
              ))}
            </g>
          ))}
          {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
            <text key={h} x={L + h * cw + (cw - 2) / 2} y={T + 7 * ch + 14} textAnchor="middle" className="vru-ax num">{String(h).padStart(2, '0')}</text>
          ))}
        </svg>
      </div>
      <figcaption className="vru-heat-legend">
        <span className="num">0</span>
        <span className="vru-steps" aria-hidden="true">{[0, 0.25, 0.5, 0.75, 1].map((t) => <i key={t} style={{ background: ramp(t) }} />)}</span>
        <span className="num">{max}</span>
        <span className="muted">crashes per hour-of-week cell</span>
      </figcaption>
    </figure>
  );
}
