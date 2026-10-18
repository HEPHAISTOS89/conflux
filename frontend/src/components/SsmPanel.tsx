import { useEffect, useRef, useState } from 'react';
import { useApi } from '../lib/api';
import { useReveal } from '../lib/motion';
import Info from './Info';

interface Rule { rule?: string; citation?: string; note?: string; threshold_mps2?: number }
interface Ssm {
  rules: { detection: Rule; severity_ttc: Rule; severity_pet: Rule; drac: Rule; overlap?: Rule; pedestrian_pet?: Rule; failure_to_yield?: Rule & { severity?: string } };
  pedestrians?: { tracks: number; crosswalks: number; pet_events: number; yield: { opportunities: number; failures: number; yield_rate: number | null; note?: string } };
  sensitivity: { ttc: Record<string, Record<string, number>>; pet: Record<string, Record<string, number>>; note?: string };
  scatter: [number, number, string, string | null][];
  scatter_note?: string;
  counts: { total: number; drac_flag: number; overlap: number };
}

const FT = 3.281;
/** Typeset comparison operators from the API's plain-text rules. */
const ops = (t?: string) => t?.replace(/<=/g, '≤').replace(/>=/g, '≥');

export default function SsmPanel({ id }: { id: string }) {
  const r = useApi<Ssm>(`/intersections/${id}/ssm`);
  const s = r.data;
  const ref = useReveal<HTMLElement>();
  return (
    <section ref={ref} className="section ssm" aria-labelledby="ssm-h">
      <div className="section-head sh-info" data-r="1">
        <h2 id="ssm-h">Threshold sensitivity</h2>{s && (
          <Info label="Detection rules" title="Detection rules as run">
            <p>{s.counts.total} events · {s.counts.drac_flag} with DRAC ≥ 11.2 ft/s² · {s.counts.overlap} simultaneous-occupancy flags.{s.pedestrians && s.pedestrians.tracks > 0 ? <> {s.pedestrians.tracks} pedestrians over {s.pedestrians.crosswalks} crosswalks: {s.pedestrians.pet_events} pedestrian PET events; {s.pedestrians.yield.failures} failures to yield in {s.pedestrians.yield.opportunities} opportunities{s.pedestrians.yield.yield_rate != null ? ` (yielding rate ${Math.round(s.pedestrians.yield.yield_rate * 100)} %)` : ''}.</> : null}</p>
            <dl className="ssm-rules-dl">
              <dt>Detection</dt><dd>{ops(s.rules.detection.rule)}<cite>{ops(s.rules.detection.citation)}</cite></dd>
              <dt>TTC severity</dt><dd>{ops(s.rules.severity_ttc.rule)}<cite>{ops(s.rules.severity_ttc.note)}</cite></dd>
              <dt>PET severity</dt><dd>{ops(s.rules.severity_pet.rule)}<cite>{ops(s.rules.severity_pet.note)}</cite></dd>
              <dt>DRAC flag</dt><dd>DRAC ≥ 11.2 ft/s² (3.4 m/s²), reported with TTC events, not used for detection.<cite>{s.rules.drac.citation}</cite></dd>
                          {s.rules.pedestrian_pet && s.pedestrians && s.pedestrians.tracks > 0 && <><dt>Pedestrian PET</dt><dd>{ops(s.rules.pedestrian_pet.rule)}<cite>{ops(s.rules.pedestrian_pet.citation)}</cite></dd></>}
              {s.rules.failure_to_yield && s.pedestrians && s.pedestrians.tracks > 0 && <><dt>Failure to yield</dt><dd>{ops(s.rules.failure_to_yield.rule)} Severity: {ops(s.rules.failure_to_yield.severity)}. {ops(s.rules.failure_to_yield.note)}<cite>{ops(s.rules.failure_to_yield.citation)}</cite></dd></>}
</dl>
            {s.scatter_note && <p>{ops(s.scatter_note)}</p>}
          </Info>
        )}
      </div>
      {r.error && <div className="error-box">{r.error}</div>}
      {s && (
        <div className="ssm-grid" data-r="2">
          <div className="panel ssm-rules">
            <table className="data">
              <thead><tr><th>TTC ≤</th><th className="r">Rear-end</th><th className="r">Lane change</th><th className="r">DRAC flag</th></tr></thead>
              <tbody>
                {Object.entries(s.sensitivity.ttc).map(([k, v]) => (
                  <tr key={k} data-active={k === '1.5'}><td className="num">{k} s{k === '1.5' ? ' (SSAM)' : ''}</td><td className="r num">{v.rear_end ?? 0}</td><td className="r num">{v.lane_change ?? 0}</td><td className="r num">{v.drac_flag ?? 0}</td></tr>
                ))}
              </tbody>
            </table>
            <table className="data">
              <thead><tr><th>PET ≤</th><th className="r">Crossing</th><th className="r">excl. overlap</th>{s.pedestrians && s.pedestrians.tracks > 0 ? <th className="r">Pedestrian</th> : null}</tr></thead>
              <tbody>
                {Object.entries(s.sensitivity.pet).map(([k, v]) => (
                  <tr key={k} data-active={k === '5.0'}><td className="num">{k} s{k === '5.0' ? ' (SSAM)' : ''}</td><td className="r num">{v.crossing ?? 0}</td><td className="r num">{v.crossing_excl_overlap ?? '—'}</td>{s.pedestrians && s.pedestrians.tracks > 0 ? <td className="r num">{v.pedestrian ?? 0}</td> : null}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel ssm-scatter"><Scatter pts={s.scatter} /></div>
        </div>
      )}
    </section>
  );
}

function Scatter({ pts }: { pts: Ssm['scatter'] }) {
  // drawn at the rendered width so tick and label text stays at its CSS size on every screen
  const box = useRef<HTMLElement>(null);
  const [W, setW] = useState(560);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = Math.round(Math.min(380, Math.max(280, W * 0.62))), P = { l: 54, r: 14, t: 14, b: 42 };
  const yMax = 40; // ft/s²; larger values are NGSIM position errors and are clipped to the top edge
  const X = (t: number) => P.l + (t / 3) * (W - P.l - P.r);
  const Y = (d: number) => H - P.b - (Math.min(d, yMax) / yMax) * (H - P.t - P.b);
  const col: Record<string, string> = { critical: 'var(--sev-a)', serious: 'var(--sev-b)', moderate: 'var(--sev-c)' };
  return (
    <figure className="ssm-fig" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Minimum TTC against maximum DRAC for each rear-end and lane-change event">
        {[0, 0.5, 1, 1.5, 2, 2.5, 3].map((t) => <g key={t}><line x1={X(t)} x2={X(t)} y1={P.t} y2={H - P.b} className="gl" /><text x={X(t)} y={H - P.b + 16} className="tick" textAnchor="middle">{t}</text></g>)}
        {[0, 10, 20, 30, 40].map((d) => <g key={d}><line x1={P.l} x2={W - P.r} y1={Y(d)} y2={Y(d)} className="gl" /><text x={P.l - 8} y={Y(d) + 4} className="tick" textAnchor="end">{d}{d === 40 ? '+' : ''}</text></g>)}
        <rect x={P.l} y={P.t} width={X(1.5) - P.l} height={H - P.t - P.b} className="zone" />
        <line x1={X(1.5)} x2={X(1.5)} y1={P.t} y2={H - P.b} className="thr" />
        <line x1={P.l} x2={W - P.r} y1={Y(11.2)} y2={Y(11.2)} className="thr" />
        <line x1={P.l} x2={W - P.r} y1={Y(26.2)} y2={Y(26.2)} className="thr dim" />
        <text x={X(1.5) + 4} y={P.t + 12} className="lbl">SSAM TTC 1.5 s</text>
        <text x={W - P.r - 4} y={Y(11.2) - 4} className="lbl" textAnchor="end">AASHTO 11.2 ft/s²</text>
        <text x={W - P.r - 4} y={Y(26.2) - 4} className="lbl" textAnchor="end">friction 26 ft/s²</text>
        {pts.map(([ttc, drac, type, sev], i) => (
          <circle key={i} cx={X(Math.min(3, ttc))} cy={Y(drac * FT)} r={3.6} fill={sev ? col[sev] : 'none'} stroke={sev ? 'var(--sheet)' : 'var(--ink-3)'} strokeWidth={sev ? 0.8 : 1.2}>
            <title>{`${type.replace('_', ' ')} · TTC ${ttc.toFixed(2)} s · DRAC ${(drac * FT).toFixed(1)} ft/s²`}</title>
          </circle>
        ))}
        <text x={(W + P.l) / 2} y={H - 6} className="axis" textAnchor="middle">minimum TTC (s)</text>
        <text transform={`translate(14 ${(H - P.b) / 2}) rotate(-90)`} className="axis" textAnchor="middle">maximum DRAC (ft/s²)</text>
      </svg>
      <figcaption className="muted ssm-key"><span><i data-k="on" />detected</span><span><i data-k="off" />below detection</span></figcaption>
    </figure>
  );
}
