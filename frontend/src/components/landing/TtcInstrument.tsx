import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import MetricInfo, { ProvChip } from '../MetricInfo';
import Term from '../Term';
import { useApi } from '../../lib/api';
import { useReveal, useTween } from '../../lib/motion';
import { useWidth } from './types';

type Pt = [number, number, string, string | null];
interface Ssm {
  sensitivity: { ttc: Record<string, Record<string, number>> };
  scatter: Pt[];
  rules: { detection: { ttc_max_s: number; citation: string }; drac: { threshold_mps2: number; citation: string } };
}

const FT = 3.28084;
const SEV_VAR: Record<string, string> = { critical: 'var(--sev-a)', serious: 'var(--sev-b)', moderate: 'var(--sev-c)' };

/** The detection threshold as a control: move it and the conflict count, and the cloud of events it admits, follow. */
export default function TtcInstrument() {
  const ref = useReveal<HTMLElement>();
  const ssm = useApi<Ssm>('/intersections/peachtree-10th/ssm');
  const steps = useMemo(() => Object.keys(ssm.data?.sensitivity.ttc ?? { '1.0': 0, '1.5': 0, '2.0': 0, '3.0': 0 }).sort((a, b) => +a - +b), [ssm.data]);
  const def = ssm.data?.rules.detection.ttc_max_s ?? 1.5;
  const [step, setStep] = useState('1.5');
  const T = Number(step);
  const row = ssm.data?.sensitivity.ttc[step];
  const re = row?.rear_end ?? 0, lc = row?.lane_change ?? 0, drac = row?.drac_flag ?? 0;
  const shown = useTween(re + lc);
  const btns = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + steps.length) % steps.length;
    setStep(steps[j]);
    btns.current[j]?.focus();
  };

  return (
    <section ref={ref} className="ti" aria-labelledby="ti-h">
      <div className="ti-head" data-r="1">
        <h2 id="ti-h">Move the threshold</h2>
        <p>Peachtree St at 10th St, Atlanta: 90 s of NGSIM trajectories at 10 Hz, a stand-in for roadside LiDAR tracks. FHWA SSAM detects a rear-end conflict while <Term k="TTC">TTC</Term> stays at or below {def.toFixed(1)} s.</p>
      </div>
      <div className="ti-read" data-r="2">
        <p className="ti-count" aria-live="polite">
          <b className="num">{ssm.data ? Math.round(shown) : '—'}</b>
          <span>rear-end and lane-change conflicts at TTC ≤ {step} s</span>
        </p>
        <div className="ti-steps" role="radiogroup" aria-label="TTC detection threshold, seconds" data-ui>
          {steps.map((s, i) => (
            <button key={s} ref={(el) => { btns.current[i] = el; }} type="button" role="radio" aria-checked={step === s}
              tabIndex={step === s ? 0 : -1} onClick={() => setStep(s)} onKeyDown={(e) => onKey(e, i)}>
              <span className="num">{s}</span><small>s</small>{+s === def && <em>SSAM</em>}
            </button>
          ))}
        </div>
        <dl className="ti-split">
          <div><dt>Rear-end</dt><dd className="measure">{re}</dd></div>
          <div><dt>Lane change</dt><dd className="measure">{lc}</dd></div>
          <div><dt><Term k="DRAC">DRAC</Term> ≥ 11.2 ft/s²</dt><dd className="measure">{drac}</dd></div>
        </dl>
      </div>
      <div className="ti-plot" data-r="3" data-ui>
        {ssm.data ? <Scatter pts={ssm.data.scatter} T={T} def={def} dracT={ssm.data.rules.drac.threshold_mps2} /> : <div className="skeleton" style={{ height: 340 }} />}
        <div className="ti-foot">
          <span className="ti-legend">
            {(['critical', 'serious', 'moderate'] as const).map((k) => <span key={k}><i style={{ background: SEV_VAR[k] }} />{k}</span>)}
            <span><i data-k="beyond" />admitted above SSAM 1.5 s</span><span><i data-k="off" />outside threshold</span>
          </span>
          <ProvChip kind="derived" />
          <MetricInfo align="right" spec={{
            name: 'Time to collision', formula: <>TTC = gap / (v<sub>f</sub> − v<sub>l</sub>), when v<sub>f</sub> &gt; v<sub>l</sub></>,
            threshold: <>event while TTC ≤ {def} s for ≥ 0.3 s; severity: ≤ 0.5 s critical, ≤ 1.0 s serious, ≤ 1.5 s moderate</>, unit: 's',
            provenance: 'derived', source: 'FHWA NGSIM Peachtree St, CC BY-SA 3.0; Savitzky–Golay smoothed',
            citation: ssm.data?.rules.detection.citation ?? 'FHWA SSAM (Gettman et al. 2008)',
            note: 'Dots are the minimum TTC of each follower–leader series; the count is distinct events at the threshold, so the two can differ by one.',
          }} />
        </div>
      </div>
      <Link to="/intersections/peachtree-10th" className="ti-go" data-r="4">Replay these conflicts in the intersection lab <Icon name="arrow" size={16} /></Link>
    </section>
  );
}

function Scatter({ pts, T, def, dracT }: { pts: Pt[]; T: number; def: number; dracT: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const H = w < 560 ? 280 : 360;
  const m = { l: 52, r: 16, t: 34, b: 44 };
  const X0 = 0, X1 = 3.2, Y1 = Math.ceil((Math.max(...pts.map((p) => p[1])) * FT) / 20) * 20;
  const iw = Math.max(10, w - m.l - m.r), ih = H - m.t - m.b;
  const sx = (v: number) => m.l + ((v - X0) / (X1 - X0)) * iw;
  const sy = (v: number) => m.t + ih - (v / Y1) * ih;
  const xt = [0, 0.5, 1, 1.5, 2, 2.5, 3];
  const yt = Array.from({ length: Y1 / 20 + 1 }, (_, i) => i * 20);
  return (
    <div ref={ref} className="ti-svg">
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label={`Scatter of ${pts.length} TTC events: minimum time to collision against maximum deceleration rate to avoid crash. Events at or below ${T} s are counted.`}>
          <rect className="ti-beyond" x={sx(T)} y={m.t} width={Math.max(0, sx(X1) - sx(T))} height={ih} />
          {yt.map((v) => <g key={v}><line className="ti-grid" x1={m.l} x2={m.l + iw} y1={sy(v)} y2={sy(v)} /><text className="ti-tick" x={m.l - 8} y={sy(v) + 4} textAnchor="end">{v}</text></g>)}
          {xt.map((v) => <text key={v} className="ti-tick" x={sx(v)} y={H - m.b + 20} textAnchor="middle">{v.toFixed(1)}</text>)}
          <text className="ti-axis" x={m.l + iw} y={H - 6} textAnchor="end">minimum TTC, s</text>
          <text className="ti-axis" x={m.l - 44} y={m.t - 20}>max DRAC, ft/s²</text>
          <line className="ti-drac" x1={m.l} x2={m.l + iw} y1={sy(dracT * FT)} y2={sy(dracT * FT)} />
          <text className="ti-tick" x={m.l + iw - 4} y={sy(dracT * FT) - 6} textAnchor="end">AASHTO 11.2 ft/s²</text>
          <line className="ti-def" x1={sx(def)} x2={sx(def)} y1={m.t} y2={m.t + ih} />
          {pts.map(([ttc, d, type, sev], i) => {
            const on = ttc <= T;
            const fill = !on ? 'var(--ti-off)' : sev ? SEV_VAR[sev] : 'var(--ti-ink)';
            const x = sx(ttc), y = sy(d * FT);
            return type === 'lane_change'
              ? <rect key={i} className="ti-pt" x={x - 4.5} y={y - 4.5} width={9} height={9} transform={`rotate(45 ${x} ${y})`} style={{ fill }} data-on={on || undefined} />
              : <circle key={i} className="ti-pt" cx={x} cy={y} r={5} style={{ fill }} data-on={on || undefined} />;
          })}
          <g className="ti-thr" style={{ transform: `translateX(${sx(T)}px)` }}>
            <line x1={0} x2={0} y1={m.t - 6} y2={m.t + ih} />
            <text x={6} y={m.t + 8}>TTC ≤ {T.toFixed(1)} s</text>
          </g>
        </svg>
      )}
    </div>
  );
}
