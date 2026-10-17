import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../lib/api';
import { nf } from '../lib/format';
import Select from './Select';

const FT = 3.28084;
import { useReveal } from '../lib/motion';
import Info from './Info';

type P3 = [number, number, number];
interface RTrack { protocol?: string; occluded_by?: number; id: number; gaps: number | [number, number][]; method: string; rmse_m: number; speed_rmse: number; raw: P3[]; truth: P3[]; repaired: P3[]; linear: P3[]; methods?: Record<string, { rmse_m: number; speed_rmse: number }> }
interface M { gaps: number; gap_frames: number; rmse_m: number; speed_rmse: number }
interface RSummary {
  tracks_occluded: number; tracks_eligible: number; gaps: number; seed: number; gap_s: [number, number]; context_s?: number; selected_method?: string;
  params?: Record<string, Record<string, number>>; methods?: Record<string, M>; by_gap?: ({ gap_s: [number, number] } & Record<string, M | [number, number]>)[];
  validation?: { tracks: number; rmse_m: Record<string, number>; selected: string; grid?: { q: number[]; r: number[] }; q_curve?: ({ q: number; rmse_m: number } | [number, number])[] };
  better_than_linear_share?: Record<string, number>; truth?: string;
  protocols?: Record<string, { description: string; occlusion?: { gaps: number; occluded_share: number; gap_len_mean_s: number }; truth_variants: Record<string, Variant> }>;
  notes?: string[];
}
interface Variant { methods: Record<string, M>; by_gap: ({ gap_s: [number, number] } & Record<string, M | [number, number]>)[]; selected_method?: string; params?: Record<string, any>; better_than_linear_share?: Record<string, number>; tracks_test?: number }
const ops = (t: string) => t.replace(/<=/g, '≤').replace(/>=/g, '≥');
const NAME: Record<string, string> = { linear: 'Linear interpolation', kf_ca: 'Kalman CA + RTS', kf_ca_path: 'Kalman CA + RTS, along/cross-track' };

export default function RepairPanel({ id }: { id: string }) {
  const r = useApi<{ tracks: RTrack[]; summary: RSummary }>(`/intersections/${id}/repair`);
  const tracks = useMemo(() => [...(r.data?.tracks ?? [])].sort((a, b) => b.truth.length - a.truth.length), [r.data]);
  const [pick, setPick] = useState(0);
  const [proto, setProto] = useState<'occluder' | 'uniform'>('occluder');
  const [truth, setTruth] = useState<'smoothed' | 'raw'>('smoothed');
  const base = r.data?.summary;
  const pv = base?.protocols?.[proto];
  const v = pv?.truth_variants?.[truth];
  // the table reads the selected protocol × truth; fall back to legacy top-level summary
  const s = base && v ? { ...base, methods: v.methods, by_gap: v.by_gap, selected_method: v.selected_method, params: v.params ?? base.params, better_than_linear_share: v.better_than_linear_share, validation: (v as any).validation ?? base.validation } : base;
  const shown = tracks.filter((t) => !t.protocol || t.protocol === proto);
  const tr = shown[Math.min(pick, shown.length - 1)];
  const methods = s?.methods ? Object.keys(s.methods) : [];
  const ref = useReveal<HTMLElement>();

  return (
    <section ref={ref} className="section repair" aria-labelledby="rep-h">
      <div className="section-head sh-info" data-r="1">
        <h2 id="rep-h">Trajectory repair</h2>{s && (
          <Info label="About trajectory repair" title="Trajectory repair under occlusion">
            <p>Gaps of 0.5–5 s refilled from {s.context_s ?? 3} s of context either side, scored against {truth === 'raw' ? 'raw' : 'smoothed'} NGSIM positions on the gap frames only.</p>
            {pv && <p>{ops(pv.occlusion ? pv.description.replace(/\.\s*$/, '') : pv.description)}{pv.occlusion ? `. ${pv.occlusion.gaps} real gaps, mean ${pv.occlusion.gap_len_mean_s.toFixed(2)} s.` : ''}</p>}
            <p>Selected on validation: {NAME[s.validation?.selected ?? s.selected_method ?? ''] ?? s.selected_method} ({s.validation?.tracks} tracks).{s.params?.kf_ca ? ` KF noise q = ${s.params.kf_ca.q} m²/s⁵, R = ${s.params.kf_ca.r} m² (filter runs in SI).` : ''}</p>
            <p>Truth: {(s.truth ?? 'smoothed NGSIM track').replace(/\s*See summary\.protocols[^.]*\.?/, '')}</p>
            {base?.notes?.map((n) => <p key={n.slice(0, 40)}>{ops(n)}</p>)}
          </Info>
        )}
      </div>
      {r.error && <div className="error-box">{r.error}</div>}
      {s && tr && (
        <div className="rep-grid" data-r="2">
          <div className="panel rep-plot">
            <div className="rep-plot-h rep-switch">
              <div className="seg" role="group" aria-label="Occlusion protocol">
                <button aria-pressed={proto === 'occluder'} onClick={() => { setProto('occluder'); setPick(0); }} title="Line-of-sight occlusion from a virtual roadside sensor">Occlusion</button>
                <button aria-pressed={proto === 'uniform'} onClick={() => { setProto('uniform'); setPick(0); }} title="Uniform random gaps">Random gaps</button>
              </div>
              <div className="seg" role="group" aria-label="Ground truth">
                <button aria-pressed={truth === 'smoothed'} onClick={() => setTruth('smoothed')} title="Savitzky–Golay-smoothed NGSIM track">Smoothed</button>
                <button aria-pressed={truth === 'raw'} onClick={() => setTruth('raw')} title="Raw NGSIM positions">Raw</button>
              </div>
            </div>
            <div className="rep-plot-h">
              <Select<string> label="Occluded track" icon="vehicle" value={String(Math.min(pick, shown.length - 1))} onChange={(v) => setPick(Number(v))}
                options={shown.map((t, i) => ({ value: String(i), label: `#${t.id} · ${(t.truth.length / 10).toFixed(1)} s missing`, hint: `${t.method === 'linear' ? 'linear' : 'Kalman'} ${(t.rmse_m * FT).toFixed(2)} ft` }))} />
            </div>
            <PathPlot t={tr} />
            <ErrPlot t={tr} />
          </div>
          <div className="panel rep-table">
            <table className="data">
              <caption className="sr-only">Position RMSE (ft) and speed RMSE (ft/s) by method and gap length</caption>
              <thead><tr><th>RMSE ft</th>{methods.map((m) => <th key={m} className="r">{m === 'linear' ? 'Linear' : m === 'kf_ca' ? 'KF-CA' : 'KF-CA path'}</th>)}</tr></thead>
              <tbody>
                {s.by_gap?.map((b) => {
                  const best = Math.min(...methods.map((m) => (b[m] as M)?.rmse_m ?? Infinity));
                  return (
                    <tr key={b.gap_s.join()}>
                      <td className="num">{b.gap_s[0]}–{b.gap_s[1]} s <span className="muted">({(b.linear as M)?.gaps})</span></td>
                      {methods.map((m) => <td key={m} className={`r num ${(b[m] as M)?.rmse_m === best ? 'best' : ''}`}>{nf((b[m] as M)?.rmse_m != null ? (b[m] as M).rmse_m * FT : null, 2)}</td>)}
                    </tr>
                  );
                })}
                <tr className="tot">
                  <td>All <span className="muted num">({s.gaps})</span></td>
                  {methods.map((m) => <td key={m} className="r num">{nf(s.methods![m].rmse_m * FT, 2)}</td>)}
                </tr>
                {truth === 'smoothed' && <tr>
                  <td>Speed ft/s</td>
                  {methods.map((m) => <td key={m} className="r num">{nf(s.methods![m].speed_rmse * FT, 2)}</td>)}
                </tr>}
              </tbody>
            </table>
            {s.better_than_linear_share && (
              <p className="rep-win"><span className="measure">{Math.round((s.better_than_linear_share.kf_ca ?? 0) * 100)}<small>%</small></span>tracks where Kalman beats linear</p>
            )}
            {s.validation?.q_curve && <QCurve c={s.validation.q_curve} chosen={s.params?.kf_ca?.q} />}
          </div>
        </div>
      )}
    </section>
  );
}

function PathPlot({ t }: { t: RTrack }) {
  const W = 640, pad = 18, Hmax = 300, Hmin = 96;
  const all = [...t.raw, ...t.truth];
  const g0 = t.truth[0]?.[0] ?? 0, g1 = t.truth[t.truth.length - 1]?.[0] ?? 0;
  const near = t.raw.filter((p) => p[0] > g0 - 4 && p[0] < g1 + 4);
  const pts = near.length ? [...near, ...t.truth] : all;
  const xs = pts.map((p) => p[2]), ys = pts.map((p) => p[1]);
  const [a, b, c, d] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // equal scale on both axes; the box shrinks to the path instead of leaving empty ground around it
  const sc = Math.min((W - 2 * pad) / Math.max(1, b - a), (Hmax - 2 * pad) / Math.max(1, d - c));
  const H = Math.max(Hmin, Math.min(Hmax, (d - c) * sc + 2 * pad));
  const oy = (H - (d - c) * sc) / 2;
  const P = (p: P3) => `${(pad + (p[2] - a) * sc).toFixed(1)},${(H - oy - (p[1] - c) * sc).toFixed(1)}`;
  const path = (arr: P3[]) => arr.map((p, i) => `${i ? 'L' : 'M'}${P(p)}`).join('');
  return (
    <figure className="rep-fig">
      <svg viewBox={`0 0 ${W} ${H}`} className="rep-svg" role="img" aria-label={`Track ${t.id}: observed points, held-out truth, linear and Kalman repairs`}>
        {near.map((p, i) => { const [x, y] = P(p).split(','); return <circle key={i} cx={x} cy={y} r={1.6} className="obs" />; })}
        <path d={path(t.truth)} className="truth" />
        <path d={path(t.linear)} className="lin" />
        <path d={path(t.repaired)} className="kf" />
      </svg>
      <figcaption className="rep-key">
        <span><svg width="14" height="8" aria-hidden="true"><circle cx="7" cy="4" r="2" className="obs" /></svg>observed</span>
        <span><svg width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" className="truth" /></svg>truth</span>
        <span><svg width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" className="lin" /></svg>linear</span>
        <span><svg width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" className="kf" /></svg>{t.method === 'linear' ? 'selected (linear)' : 'Kalman'}</span>
      </figcaption>
    </figure>
  );
}

function ErrPlot({ t }: { t: RTrack }) {
  const box = useRef<HTMLElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 120, L = 48, B = 12;
  const err = (arr: P3[]) => arr.map((p, i) => [p[0], Math.hypot(p[1] - t.truth[i][1], p[2] - t.truth[i][2]) * FT] as [number, number]);
  const el = err(t.linear), ek = err(t.repaired);
  const t0 = t.truth[0][0], t1 = t.truth[t.truth.length - 1][0] + 0.1;
  const ym = Math.max(0.6, ...el.map((e) => e[1]), ...ek.map((e) => e[1]));
  const X = (v: number) => L + ((v - t0) / (t1 - t0 || 1)) * (W - L - 8), Y = (v: number) => H - B - (v / ym) * (H - B - 8);
  const pl = (e: [number, number][]) => e.map(([a, b], i) => `${i && e[i][0] - e[i - 1][0] < 0.15 ? 'L' : 'M'}${X(a)},${Y(b)}`).join('');
  return (
    <figure className="rep-fig" ref={box}>
    <svg viewBox={`0 0 ${W} ${H}`} className="rep-svg err" role="img" aria-label="Position error over the missing frames for each method">
      <line x1={L} x2={W - 8} y1={H - B} y2={H - B} className="ax" />
      <text x={L - 6} y={Y(ym) + 4} className="tk" textAnchor="end">{ym.toFixed(2)}</text>
      <text x={L - 6} y={H - B + 4} className="tk" textAnchor="end">0</text>
      <path d={pl(el)} className="lin" /><path d={pl(ek)} className="kf" />
    </svg>
    <figcaption className="muted">Error (ft)</figcaption>
    </figure>
  );
}

function QCurve({ c: raw, chosen }: { c: ({ q: number; rmse_m: number } | [number, number])[]; chosen?: number }) {
  const c = raw.map((p) => (Array.isArray(p) ? { q: p[0], rmse_m: p[1] } : p));
  const W = 320, H = 100, L = 40, B = 10;
  const lq = c.map((p) => Math.log10(p.q)), mn = Math.min(...lq), mx = Math.max(...lq);
  const ym = Math.max(...c.map((p) => p.rmse_m)), yn = Math.min(...c.map((p) => p.rmse_m));
  const X = (q: number) => L + ((Math.log10(q) - mn) / (mx - mn || 1)) * (W - L - 8);
  const Y = (v: number) => H - B - ((v - yn) / (ym - yn || 1)) * (H - B - 10);
  return (
    <figure className="qcurve">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Validation position RMSE against Kalman process noise q">
        <path d={c.map((p, i) => `${i ? 'L' : 'M'}${X(p.q)},${Y(p.rmse_m)}`).join('')} className="kf" />
        {c.map((p) => <circle key={p.q} cx={X(p.q)} cy={Y(p.rmse_m)} r={p.q === chosen ? 4 : 2} className={p.q === chosen ? 'chosen' : 'obs'} />)}
        <text x={L - 4} y={Y(ym) + 4} className="tk" textAnchor="end">{(ym * FT).toFixed(2)}</text>
        <text x={L - 4} y={Y(yn) + 4} className="tk" textAnchor="end">{(yn * FT).toFixed(2)}</text>
      </svg>
      <figcaption className="muted" title={`Validation RMSE (ft) against Kalman process noise q, log scale ${c[0].q} to ${c[c.length - 1].q}; filled marker is the chosen q`}>Validation RMSE vs q</figcaption>
    </figure>
  );
}
