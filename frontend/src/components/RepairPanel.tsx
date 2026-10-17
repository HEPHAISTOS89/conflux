import { useMemo, useState } from 'react';
import { useApi } from '../lib/api';
import { nf } from '../lib/format';

type P3 = [number, number, number];
interface RTrack { protocol?: string; occluded_by?: number; id: number; gaps: number | [number, number][]; method: string; rmse_m: number; speed_rmse: number; raw: P3[]; truth: P3[]; repaired: P3[]; linear: P3[]; methods?: Record<string, { rmse_m: number; speed_rmse: number }> }
interface M { gaps: number; gap_frames: number; rmse_m: number; speed_rmse: number }
interface RSummary {
  tracks_occluded: number; tracks_eligible: number; gaps: number; seed: number; gap_s: [number, number]; context_s?: number; selected_method?: string;
  params?: Record<string, Record<string, number>>; methods?: Record<string, M>; by_gap?: ({ gap_s: [number, number] } & Record<string, M | [number, number]>)[];
  validation?: { tracks: number; rmse_m: Record<string, number>; selected: string; grid?: { q: number[]; r: number[] }; q_curve?: { q: number; rmse_m: number }[] };
  better_than_linear_share?: Record<string, number>; truth?: string;
  protocols?: Record<string, { description: string; occlusion?: { gaps: number; occluded_share: number; gap_len_mean_s: number }; truth_variants: Record<string, Variant> }>;
  notes?: string[];
}
interface Variant { methods: Record<string, M>; by_gap: ({ gap_s: [number, number] } & Record<string, M | [number, number]>)[]; selected_method?: string; params?: Record<string, any>; better_than_linear_share?: Record<string, number>; tracks_test?: number }
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
  const s = base && v ? { ...base, methods: v.methods, by_gap: v.by_gap, selected_method: v.selected_method, params: v.params ?? base.params, better_than_linear_share: v.better_than_linear_share } : base;
  const shown = tracks.filter((t) => !t.protocol || t.protocol === proto);
  const tr = shown[Math.min(pick, shown.length - 1)];
  const methods = s?.methods ? Object.keys(s.methods) : [];

  return (
    <section className="section repair" aria-labelledby="rep-h">
      <div className="section-head">
        <h2 id="rep-h">Trajectory repair under occlusion</h2>
        <p>{proto === 'occluder' ? 'Gaps placed where a nearer vehicle blocks a virtual roadside sensor' : 'Gaps of uniform random length'}, 0.5–5 s · scored against {truth === 'raw' ? 'raw' : 'smoothed'} NGSIM positions</p>
      </div>
      <p className="rep-intro">
        Roadside sensors lose vehicles behind other vehicles, poles and turning trucks, and broken tracks corrupt speed profiles and conflict measures.
        Here gaps are cut out of complete tracks, refilled by each method using {s?.context_s ?? 3} s of observations either side, and scored against the held-out positions.
        Noise parameters are chosen on a separate validation set of tracks, never on the scored gaps.
      </p>
      {r.error && <div className="error-box">{r.error}</div>}
      {s && tr && (
        <div className="rep-grid">
          <div className="panel rep-plot">
            <div className="rep-plot-h rep-switch">
              <div className="seg" role="group" aria-label="Occlusion protocol">
                <button aria-pressed={proto === 'occluder'} onClick={() => { setProto('occluder'); setPick(0); }}>Line-of-sight occlusion</button>
                <button aria-pressed={proto === 'uniform'} onClick={() => { setProto('uniform'); setPick(0); }}>Uniform random gaps</button>
              </div>
              <div className="seg" role="group" aria-label="Ground truth">
                <button aria-pressed={truth === 'smoothed'} onClick={() => setTruth('smoothed')}>Smoothed truth</button>
                <button aria-pressed={truth === 'raw'} onClick={() => setTruth('raw')}>Raw NGSIM truth</button>
              </div>
            </div>
            {pv && <p className="muted rep-desc">{pv.description}{pv.occlusion ? ` — ${pv.occlusion.gaps} real gaps, mean ${pv.occlusion.gap_len_mean_s.toFixed(2)} s.` : ''}</p>}
            <div className="rep-plot-h">
              <label className="select"><span>Occluded track</span>
                <select value={pick} onChange={(e) => setPick(Number(e.target.value))}>
                  {shown.map((t, i) => <option key={t.id} value={i}>#{t.id} · {(t.truth.length / 10).toFixed(1)} s missing · {t.method === 'linear' ? 'linear' : 'Kalman'} {t.rmse_m.toFixed(2)} m</option>)}
                </select>
              </label>
            </div>
            <PathPlot t={tr} />
            <ErrPlot t={tr} />
          </div>
          <div className="panel rep-table">
            <table className="data">
              <caption className="sr-only">Position and speed RMSE by method and gap length</caption>
              <thead><tr><th>Gap length</th>{methods.map((m) => <th key={m} className="r">{m === 'linear' ? 'Linear' : m === 'kf_ca' ? 'KF-CA' : 'KF-CA path'}</th>)}</tr></thead>
              <tbody>
                {s.by_gap?.map((b) => {
                  const best = Math.min(...methods.map((m) => (b[m] as M)?.rmse_m ?? Infinity));
                  return (
                    <tr key={b.gap_s.join()}>
                      <td className="num">{b.gap_s[0]}–{b.gap_s[1]} s <span className="muted">({(b.linear as M)?.gaps})</span></td>
                      {methods.map((m) => <td key={m} className={`r num ${(b[m] as M)?.rmse_m === best ? 'best' : ''}`}>{nf((b[m] as M)?.rmse_m, 3)}</td>)}
                    </tr>
                  );
                })}
                <tr className="tot">
                  <td>All test gaps <span className="muted num">({s.gaps})</span></td>
                  {methods.map((m) => <td key={m} className="r num">{nf(s.methods![m].rmse_m, 3)}</td>)}
                </tr>
                {truth === 'smoothed' && <tr>
                  <td>Speed RMSE (m/s)</td>
                  {methods.map((m) => <td key={m} className="r num">{nf(s.methods![m].speed_rmse, 3)}</td>)}
                </tr>}
              </tbody>
            </table>
            <dl className="rep-facts num">
              <dt>Position RMSE (m)</dt><dd>gap frames only, vs held-out truth</dd>
              <dt>Selected on validation</dt><dd>{NAME[s.validation?.selected ?? s.selected_method ?? ''] ?? s.selected_method} ({s.validation?.tracks} tracks)</dd>
              {s.params?.kf_ca && <><dt>KF noise</dt><dd>q = {s.params.kf_ca.q} m²/s⁵, R = {s.params.kf_ca.r} m²</dd></>}
              {s.better_than_linear_share && <><dt>Tracks KF beats linear</dt><dd>{Math.round((s.better_than_linear_share.kf_ca ?? 0) * 100)}%</dd></>}
              <dt>Truth</dt><dd>{s.truth ?? 'smoothed NGSIM track'}</dd>
            </dl>
            {s.validation?.q_curve && <QCurve c={s.validation.q_curve} chosen={s.params?.kf_ca?.q} />}
            {base?.notes && <ul className="rep-notes muted">{base.notes.map((n) => <li key={n.slice(0, 40)}>{n}</li>)}</ul>}
          </div>
        </div>
      )}
    </section>
  );
}

function PathPlot({ t }: { t: RTrack }) {
  const W = 640, H = 300, pad = 18;
  const all = [...t.raw, ...t.truth];
  const g0 = t.truth[0]?.[0] ?? 0, g1 = t.truth[t.truth.length - 1]?.[0] ?? 0;
  const near = t.raw.filter((p) => p[0] > g0 - 4 && p[0] < g1 + 4);
  const pts = near.length ? [...near, ...t.truth] : all;
  const xs = pts.map((p) => p[2]), ys = pts.map((p) => p[1]);
  const [a, b, c, d] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sc = Math.min((W - 2 * pad) / Math.max(1, b - a), (H - 2 * pad) / Math.max(1, d - c));
  const P = (p: P3) => `${(pad + (p[2] - a) * sc).toFixed(1)},${(H - pad - (p[1] - c) * sc).toFixed(1)}`;
  const path = (arr: P3[]) => arr.map((p, i) => `${i ? 'L' : 'M'}${P(p)}`).join('');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="rep-svg" role="img" aria-label={`Track ${t.id}: observed points, held-out truth, linear and Kalman repairs`}>
      {near.map((p, i) => { const [x, y] = P(p).split(','); return <circle key={i} cx={x} cy={y} r={1.6} className="obs" />; })}
      <path d={path(t.truth)} className="truth" />
      <path d={path(t.linear)} className="lin" />
      <path d={path(t.repaired)} className="kf" />
      <g className="rep-key" transform={`translate(${pad} ${pad})`}>
        <circle cx={4} cy={0} r={2} className="obs" /><text x={12} y={4}>observed (10 Hz)</text>
        <line x1={120} x2={140} y1={0} y2={0} className="truth" /><text x={146} y={4}>held-out truth</text>
        <line x1={240} x2={260} y1={0} y2={0} className="lin" /><text x={266} y={4}>linear</text>
        <line x1={318} x2={338} y1={0} y2={0} className="kf" /><text x={344} y={4}>{t.method === 'linear' ? 'selected (linear)' : 'Kalman RTS'}</text>
      </g>
    </svg>
  );
}

function ErrPlot({ t }: { t: RTrack }) {
  const W = 640, H = 120, L = 40, B = 20;
  const err = (arr: P3[]) => arr.map((p, i) => [p[0], Math.hypot(p[1] - t.truth[i][1], p[2] - t.truth[i][2])] as [number, number]);
  const el = err(t.linear), ek = err(t.repaired);
  const t0 = t.truth[0][0], t1 = t.truth[t.truth.length - 1][0] + 0.1;
  const ym = Math.max(0.2, ...el.map((e) => e[1]), ...ek.map((e) => e[1]));
  const X = (v: number) => L + ((v - t0) / (t1 - t0 || 1)) * (W - L - 8), Y = (v: number) => H - B - (v / ym) * (H - B - 8);
  const pl = (e: [number, number][]) => e.map(([a, b], i) => `${i && e[i][0] - e[i - 1][0] < 0.15 ? 'L' : 'M'}${X(a)},${Y(b)}`).join('');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="rep-svg err" role="img" aria-label="Position error over the missing frames for each method">
      <line x1={L} x2={W - 8} y1={H - B} y2={H - B} className="ax" />
      <text x={L - 6} y={Y(ym) + 4} className="tk" textAnchor="end">{ym.toFixed(2)}</text>
      <text x={L - 6} y={H - B + 4} className="tk" textAnchor="end">0</text>
      <text x={L} y={H - 4} className="tk">position error (m) across missing frames</text>
      <path d={pl(el)} className="lin" /><path d={pl(ek)} className="kf" />
    </svg>
  );
}

function QCurve({ c, chosen }: { c: { q: number; rmse_m: number }[]; chosen?: number }) {
  const W = 320, H = 110, L = 34, B = 22;
  const lq = c.map((p) => Math.log10(p.q)), mn = Math.min(...lq), mx = Math.max(...lq);
  const ym = Math.max(...c.map((p) => p.rmse_m)), yn = Math.min(...c.map((p) => p.rmse_m));
  const X = (q: number) => L + ((Math.log10(q) - mn) / (mx - mn || 1)) * (W - L - 8);
  const Y = (v: number) => H - B - ((v - yn) / (ym - yn || 1)) * (H - B - 10);
  return (
    <figure className="qcurve">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Validation position RMSE against Kalman process noise q">
        <path d={c.map((p, i) => `${i ? 'L' : 'M'}${X(p.q)},${Y(p.rmse_m)}`).join('')} className="kf" />
        {c.map((p) => <circle key={p.q} cx={X(p.q)} cy={Y(p.rmse_m)} r={p.q === chosen ? 4 : 2} className={p.q === chosen ? 'chosen' : 'obs'} />)}
        <text x={L} y={H - 4} className="tk">q, log scale ({c[0].q} → {c[c.length - 1].q})</text>
        <text x={L - 4} y={Y(ym) + 4} className="tk" textAnchor="end">{ym.toFixed(2)}</text>
        <text x={L - 4} y={Y(yn) + 4} className="tk" textAnchor="end">{yn.toFixed(2)}</text>
      </svg>
      <figcaption className="muted">Validation RMSE (m) vs process noise; filled marker is the chosen q.</figcaption>
    </figure>
  );
}
