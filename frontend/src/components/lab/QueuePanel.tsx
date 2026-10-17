import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { SignalPlan } from '../world/signals';
import { downloadCSV } from '../../lib/export';
import { CHART } from '../../lib/format';
import { M_TO_FT, MPS_TO_MPH } from '../../lib/lab/metrics';
import { useThemeName } from '../../lib/lab/palette';
import { approachReach, phaseIntervals, queueProfile, stoppedDelay, type Approach, type DelaySummary, type QueueProfile } from '../../lib/lab/queue';
import { useReveal } from '../../lib/motion';
import { useClock, useClockFrame, type IntersectionT } from '../../lib/traj';
import { Icon } from '../Icon';
import Info from '../Info';

const LAMP = ['red', 'yellow', 'green'] as const;
const LOS_WORD = { A: 'free flow', B: 'stable', C: 'stable', D: 'approaching unstable', E: 'unstable', F: 'forced' } as const;

interface ApproachResult { dir: Approach; q: QueueProfile; d: DelaySummary; bar: number }

/**
 * Queues and delay on the NB and SB approaches: queue length against time over the inferred NS signal phase,
 * bound to the page clock (click or drag the chart to seek), and the HCM-style delay summary per approach.
 * Everything is computed in the browser from the served NGSIM tracks (queue.ts); the stop bars and the phase plan
 * are themselves derived from vehicle behaviour, so every figure is an estimate from one 90 s sample.
 */
export default function QueuePanel({ data, plan, bars }: { data: IntersectionT; plan: SignalPlan; bars: { nbBar: number | null; sbBar: number | null } }) {
  useThemeName(); // CHART is swapped in place on a theme change
  const clock = useClock();
  const ref = useReveal<HTMLElement>();
  const duration = clock.duration;
  const r = useMemo(() => {
    const out: ApproachResult[] = [];
    for (const [dir, bar] of [['NB', bars.nbBar], ['SB', bars.sbBar]] as const) {
      if (bar == null) continue;
      const reach = approachReach(data.tracks, dir, bar);
      out.push({ dir, bar, q: queueProfile(data.tracks, dir, bar, data.hz, duration), d: stoppedDelay(data.tracks, dir, bar, data.hz, reach) });
    }
    return out;
  }, [data, bars, duration]);
  const phases = useMemo(() => phaseIntervals(plan, 'ns'), [plan]);

  // chart frame: the viewBox follows the container width, so tick text never renders below its 12 px size
  const fig = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = fig.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const Wd = width, Ht = width < 480 ? 180 : 200, pad = { l: 36, r: 12, t: 20, b: 30 };
  const iw = Wd - pad.l - pad.r, ih = Ht - pad.t - pad.b;
  const maxQ = Math.max(1, ...r.map((a) => a.q.maxQueue));
  const step = [1, 2, 5, 10, 20].find((k) => maxQ / k <= 5) ?? 50;
  const yTop = Math.ceil(maxQ / step) * step;
  const X = (t: number) => pad.l + (t / duration) * iw;
  const Y = (n: number) => pad.t + ih - (n / yTop) * ih;
  const ticksY = Array.from({ length: yTop / step + 1 }, (_, i) => i * step);
  const tickT = Wd < 480 ? 30 : duration > 60 ? 15 : 10;
  const ticksT = Array.from({ length: Math.floor(duration / tickT) + 1 }, (_, i) => i * tickT);
  // step path: the count holds for one frame, so each sample is a horizontal run
  const stepPath = (q: QueueProfile) => {
    let d = `M${X(0).toFixed(1)},${Y(q.n[0]).toFixed(1)}`;
    let last = q.n[0];
    for (let k = 1; k < q.n.length; k++) {
      if (q.n[k] === last) continue;
      d += `H${X(q.t[k]).toFixed(1)}V${Y(q.n[k]).toFixed(1)}`;
      last = q.n[k];
    }
    return d + `H${X(duration).toFixed(1)}`;
  };
  const paths = useMemo(() => r.map((a) => stepPath(a.q)), [r, duration, yTop, Wd]); // eslint-disable-line react-hooks/exhaustive-deps

  // time cursor and live readout: imperative, in step with the shared clock, no React re-render per frame
  const cursor = useRef<SVGLineElement>(null);
  const tLabel = useRef<SVGTextElement>(null);
  const live = useRef<(HTMLElement | null)[]>([]);
  useClockFrame((t) => {
    const x = X(t).toFixed(1);
    cursor.current?.setAttribute('x1', x); cursor.current?.setAttribute('x2', x);
    if (tLabel.current) { tLabel.current.setAttribute('x', x); tLabel.current.textContent = `${t.toFixed(1)} s`; tLabel.current.setAttribute('text-anchor', t / duration > 0.9 ? 'end' : t / duration < 0.1 ? 'start' : 'middle'); }
    const k = Math.round(t * data.hz);
    r.forEach((a, i) => { const el = live.current[i]; if (el) el.textContent = String(a.q.n[Math.max(0, Math.min(a.q.n.length - 1, k))]); });
  }, [r, duration, Wd]);

  const svg = useRef<SVGSVGElement>(null);
  const seek = (e: React.PointerEvent<SVGSVGElement>) => {
    const el = svg.current; if (!el) return;
    const b = el.getBoundingClientRect();
    const u = ((e.clientX - b.left) / b.width) * Wd;
    clock.setT(Math.max(0, Math.min(duration, ((u - pad.l) / iw) * duration)));
  };

  const csv = () => downloadCSV(`${data.id}-delay.csv`, r.flatMap((a) => a.d.vehicles.map((v) => ({
    site: data.id, approach: a.dir, vehicle: v.id, movement: v.move ?? '', stopped_delay_s: v.stoppedS.toFixed(1),
    segment_ft: (v.segmentM * M_TO_FT).toFixed(1), travel_time_s: v.travelS.toFixed(1), control_delay_s: v.controlS == null ? '' : v.controlS.toFixed(1), lower_bound: v.censored ? 1 : 0,
  }))));

  const fmt = (v: number | null | undefined, d = 1) => (v == null ? '—' : v.toFixed(d));
  const col = (dir: Approach) => (dir === 'NB' ? CHART.nb : CHART.sb);

  return (
    <section ref={ref} className="section" aria-labelledby="queue-h">
      <div className="section-head sh-info" data-r="1">
        <h2 id="queue-h">Queues and delay</h2>
        <Info label="About queues and delay" title="Method, estimate">
          <p>Stopped vehicles (v &lt; 0.5 m/s, 1.1 mph) upstream of each behaviour-derived stop bar, per 10 Hz frame; back of queue is measured to the rear bumper of the farthest stopped vehicle. HCM 7th ed. ch. 19 stopped-delay convention.</p>
          <dl className="ssm-rules-dl">
            <dt>Control delay</dt><dd>Travel time from the entry line to the bar minus the same distance at the 85th-percentile spot speed where vehicles cross the entry line (free-flow proxy). HCM 7th ed. ch. 19, field delay study form; ITE Manual of Transportation Engineering Studies.</dd>
            <dt>LOS</dt><dd>HCM 7th ed. Exhibit 19-8 by mean control delay: A ≤ 10, B ≤ 20, C ≤ 35, D ≤ 55, E ≤ 80, F &gt; 80 s/veh.</dd>
            <dt>Signal phase</dt><dd>Inferred from through-vehicle discharge and standing queues (signals.ts); NGSIM logged no controller state. Yellow 3.5 s and all-red 1 s are assumed.</dd>
            {r.map((a) => (
              <Fragment key={a.dir}>
                <dt>{a.dir} segment</dt>
                <dd>{(a.d.approachM * M_TO_FT).toFixed(0)} ft ({a.d.approachM} m) upstream of the bar at y = {a.bar.toFixed(1)} m · v85 {a.d.v85 == null ? '—' : `${(a.d.v85 * MPS_TO_MPH).toFixed(1)} mph`} from n = {a.d.nSpot} spot speeds · {a.d.censored} of {a.d.nVehicles} delays are lower bounds (queued when the window opens or still upstream when it closes).</dd>
              </Fragment>
            ))}
          </dl>
          <p>Estimate: one 90 s sample, no controller data, no v/c or progression terms, and the observed grid ends ~37 m south of the NB bar.</p>
        </Info>
        <button className="btn ghost ic" onClick={csv} title="Download CSV" aria-label="Download per-vehicle delay as CSV"><Icon name="download" size={16} /></button>
      </div>
      <div className="panel queue" data-ui data-r="2">
        <div className="queue-bar">
          <dl className="queue-legend">
            {r.map((a, i) => (
              <div key={a.dir}><dt><i style={{ background: col(a.dir) }} />{a.dir} queue</dt><dd className="measure"><span ref={(el) => { live.current[i] = el; }}>0</span><small>veh</small></dd></div>
            ))}
            <div className="queue-phase-key" aria-label="Inferred NS signal phase">
              <dt><i data-lamp="green" />NS green</dt><dt><i data-lamp="red" />NS red</dt>
            </div>
          </dl>
          <span className="chip queue-est" title="Stop bars, phase plan and delays are derived from vehicle behaviour in one 90 s window">Estimate</span>
        </div>
        <div className="queue-fig" ref={fig}>
          <svg ref={svg} viewBox={`0 0 ${Wd} ${Ht}`} role="img" aria-label={`Queue length against time, ${r.map((a) => `${a.dir} maximum ${a.q.maxQueue} vehicles`).join(', ')}; inferred north–south signal phase behind; click to seek`}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seek(e); }} onPointerMove={(e) => { if (e.buttons & 1) seek(e); }}>
            {phases.map((p, i) => <rect key={i} x={X(p.from)} y={pad.t} width={Math.max(0, X(p.to) - X(p.from))} height={ih} className="queue-band" data-lamp={LAMP[p.lamp]} />)}
            {ticksY.map((n) => (
              <g key={n}>
                <line x1={pad.l} x2={Wd - pad.r} y1={Y(n)} y2={Y(n)} className="queue-grid" />
                <text x={pad.l - 8} y={Y(n) + 4} textAnchor="end" className="queue-tick">{n}</text>
              </g>
            ))}
            {ticksT.map((t) => <text key={t} x={X(t)} y={Ht - pad.b + 16} textAnchor={t === 0 ? 'start' : 'middle'} className="queue-tick">{t}</text>)}
            <line x1={pad.l} x2={Wd - pad.r} y1={pad.t + ih} y2={pad.t + ih} className="queue-axis" />
            {r.map((a, i) => <path key={a.dir} d={paths[i]} fill="none" stroke={col(a.dir)} strokeWidth={1.75} strokeLinejoin="round" />)}
            <line ref={cursor} x1={X(0)} x2={X(0)} y1={pad.t} y2={pad.t + ih} className="queue-cursor" />
            <text ref={tLabel} x={X(0)} y={pad.t - 7} textAnchor="start" className="queue-tlab">0.0 s</text>
            <text x={pad.l + iw / 2} y={Ht - 4} textAnchor="middle" className="queue-axis-t">Time in window (s)</text>
            <text x={12} y={pad.t + ih / 2} transform={`rotate(-90 12 ${pad.t + ih / 2})`} textAnchor="middle" className="queue-axis-t">Queue (veh)</text>
          </svg>
        </div>
        <div className="queue-tablewrap" role="region" aria-label="Queue and delay by approach, scrolls sideways on narrow screens" tabIndex={0}>
          <table className="data queue-table">
            <thead>
              <tr>
                <th>Approach</th>
                <th className="r" title="Vehicles observed on the approach in the window">Vehicles</th>
                <th className="r" title="Share of vehicles stopped at least once upstream of the bar">Stopped</th>
                <th className="r" title="Most vehicles stopped at once (veh)">Max queue</th>
                <th className="r" title="Farthest rear bumper from the bar while stopped, ft (m in cell)">Back of queue ft</th>
                <th className="r" title="Mean time at v < 0.5 m/s upstream of the bar, s/veh">Stopped delay s</th>
                <th className="r" title="Mean control delay, s/veh (estimate)">Control delay s</th>
                <th title="HCM 7th ed. Exhibit 19-8, signalized thresholds, from mean control delay">LOS</th>
              </tr>
            </thead>
            <tbody>
              {r.map((a) => (
                <tr key={a.dir}>
                  <td><i className="queue-sw" style={{ background: col(a.dir) }} />{a.dir}</td>
                  <td className="r measure">{a.d.nVehicles}</td>
                  <td className="r measure">{Math.round(a.d.stoppedShare * 100)}<small>%</small></td>
                  <td className="r measure" title={`at ${a.q.tMaxQueue.toFixed(1)} s; time-weighted mean ${a.q.meanQueue.toFixed(1)} veh`}>{a.q.maxQueue}</td>
                  <td className="r measure" title={`${a.q.maxBackM.toFixed(1)} m`}>{a.q.maxBackFt.toFixed(0)}</td>
                  <td className="r measure">{fmt(a.d.meanStoppedS)}</td>
                  <td className="r measure" title={a.d.meanControlS == null ? 'No free-flow speed observed' : `n = ${a.d.nControl}; ${a.d.censored} lower bounds`}>{a.d.censored > 0 && a.d.meanControlS != null ? <small title={`${a.d.censored} of ${a.d.nVehicles} vehicles queued at a window edge: a lower bound`}>≥ </small> : null}{fmt(a.d.meanControlS)}</td>
                  <td>{a.d.los ? <span className="queue-los" data-los={a.d.los} title={`${LOS_WORD[a.d.los]} · mean control delay ${fmt(a.d.meanControlS)} s/veh`}>{a.d.los}</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
