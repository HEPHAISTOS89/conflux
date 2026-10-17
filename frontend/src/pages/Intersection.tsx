import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import PlanView from '../components/PlanView';
import TimeSpace from '../components/TimeSpace';
import Player from '../components/Player';
import RepairPanel from '../components/RepairPanel';
import SsmPanel from '../components/SsmPanel';
import { useApi } from '../lib/api';
import { nf } from '../lib/format';
import { ClockCtx, MPS_TO_MPH, poseAt, useClockFrame, useClockState, type ConflictT, type IntersectionT } from '../lib/traj';
import '../styles/intersection.css';

const LidarView = lazy(() => import('../components/LidarView'));

interface IxCard { id: string; name: string; n_tracks: number; n_conflicts: number; source: { location: string; global_time_ms: number[] } }
const TYPE_LABEL = { rear_end: 'Rear-end', crossing: 'Crossing', lane_change: 'Lane change' } as const;

export default function IntersectionPage() {
  const { id = 'peachtree-10th' } = useParams();
  const nav = useNavigate();
  const list = useApi<IxCard[]>('/intersections');
  const ix = useApi<IntersectionT>(`/intersections/${id}`);
  const cf = useApi<ConflictT[]>(`/intersections/${id}/conflicts`);
  const clock = useClockState(ix.data?.window_s ?? 90);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'plan' | 'lidar'>('plan');
  const [typeF, setTypeF] = useState<'all' | ConflictT['type']>('all');
  const conflicts = useMemo(() => (cf.data ?? []).filter((c) => typeF === 'all' || c.type === typeF).sort((a, b) => a.t - b.t), [cf.data, typeF]);
  const ready = ix.data && cf.data && ix.data.id === id;

  const jump = (c: ConflictT) => { clock.setT(Math.max(0, c.t - 1.5)); setSelected(String(c.a)); };

  return (
    <div className="page ixlab">
      <header className="page-head">
        <h1>Intersection lab</h1>
        <p>
          Proactive safety from trajectories rather than crash history. Vehicle tracks at 10 Hz from the FHWA NGSIM arterial datasets, a stand-in for the
          roadside-LiDAR trajectories a pole-mounted sensor produces, are screened for rear-end, crossing and lane-change traffic conflicts (surrogate safety events) with time-to-collision,
          post-encroachment time and deceleration rate to avoid crash.
        </p>
      </header>

      <nav className="cor-tabs ix-tabs" aria-label="Intersections">
        {(list.data ?? []).map((c) => (
          <button key={c.id} aria-pressed={c.id === id} onClick={() => { setSelected(null); clock.setT(0); nav(`/intersections/${c.id}`); }}>
            <span>{c.name}</span>
            <small className="num">{c.n_tracks} tracks · {c.n_conflicts} conflicts · NGSIM {c.source.location}</small>
          </button>
        ))}
      </nav>

      {ix.error && <div className="error-box">{ix.error}</div>}
      {!ready ? <div className="skeleton" style={{ height: 520 }} /> : (
        <ClockCtx.Provider value={clock}>
          <section className="ix-stage">
            <div className="ix-view panel" data-mode={view}>
              <div className="ix-view-bar">
                <div className="seg" role="group" aria-label="View">
                  <button aria-pressed={view === 'plan'} onClick={() => setView('plan')}>Plan</button>
                  <button aria-pressed={view === 'lidar'} onClick={() => setView('lidar')}>Roadside LiDAR 3D</button>
                </div>
                <Player />
              </div>
              <div className="ix-canvas">
                {view === 'plan'
                  ? <PlanView data={ix.data!} conflicts={cf.data!} selected={selected} onSelect={setSelected} label={`Plan view of ${ix.data!.name}; click a vehicle to select it`} />
                  : <Suspense fallback={<div className="lidar" />}><LidarView data={ix.data!} conflicts={cf.data!} selected={selected} label={`Simulated roadside LiDAR point cloud of ${ix.data!.name}`} /></Suspense>}
              </div>
            </div>
            <aside className="ix-side">
              <VehicleReadout data={ix.data!} id={selected} onClear={() => setSelected(null)} />
              <div className="panel ix-conf">
                <div className="ix-conf-h">
                  <h3>Conflicts <span className="num muted">{conflicts.length}</span></h3>
                  <select value={typeF} onChange={(e) => setTypeF(e.target.value as any)} aria-label="Filter conflict type">
                    <option value="all">All types</option><option value="rear_end">Rear-end</option><option value="crossing">Crossing</option><option value="lane_change">Lane change</option>
                  </select>
                </div>
                <div className="ix-conf-list">
                  <table className="data">
                    <thead><tr><th className="r">t (s)</th><th>Type</th><th className="r">TTC</th><th className="r">PET</th><th className="r">DRAC ft/s²</th></tr></thead>
                    <tbody>
                      {conflicts.map((c) => (
                        <tr key={c.id} onClick={() => jump(c)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && jump(c)} data-active={selected === String(c.a)}>
                          <td className="r num">{c.t.toFixed(1)}</td>
                          <td><span className={`sev sev-${c.severity}`}>{TYPE_LABEL[c.type]}</span>{(c as any).overlap ? <span className="flag" title="Simultaneous occupancy of the conflict zone; likely NGSIM position error">overlap</span> : null}</td>
                          <td className="r num">{c.ttc_min != null ? `${c.ttc_min.toFixed(2)} s` : '—'}</td>
                          <td className="r num">{c.pet != null ? `${c.pet.toFixed(2)} s` : '—'}</td>
                          <td className={`r num ${c.drac_max != null && c.drac_max > 8 ? 'implaus' : ''}`}>{c.drac_max != null ? (c.drac_max * 3.281).toFixed(1) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="ix-foot muted">Click a conflict to jump 1.5 s before it. DRAC above 26 ft/s² (8 m/s²) exceeds tyre–road friction and flags NGSIM position error rather than a real manoeuvre.</p>
              </div>
            </aside>
          </section>

          <section className="section" aria-labelledby="ts-h">
            <div className="section-head">
              <h2 id="ts-h">Time–space diagram</h2>
              <p>Northbound and southbound through traffic along the corridor axis; drag or use ← → to scrub, space to play.</p>
            </div>
            <div className="panel ix-ts"><TimeSpace data={ix.data!} conflicts={cf.data!} selected={selected} label="Time–space diagram; drag to scrub time" /></div>
          </section>
        </ClockCtx.Provider>
      )}

      <SsmPanel id={id} />
      <RepairPanel id={id} />
    </div>
  );
}

function VehicleReadout({ data, id, onClear }: { data: IntersectionT; id: string | null; onClear: () => void }) {
  const tr = id ? data.tracks.find((t) => String(t.id) === id) : null;
  const [p, setP] = useState<ReturnType<typeof poseAt>>(null);
  useClockFrame((t) => setP(tr ? poseAt(tr, t, data.hz) : null), [tr]);
  return (
    <div className="panel ix-veh" aria-live="polite">
      {tr ? (
        <>
          <div className="ix-veh-h"><h3>Vehicle <span className="num">#{tr.id}</span></h3><button className="btn ghost" onClick={onClear}>Clear</button></div>
          <dl className="num">
            <dt>Class · movement</dt><dd>{tr.cls} · {tr.dir} {tr.move}</dd>
            <dt>Footprint</dt><dd>{nf(tr.len_m * 3.281, 1)} × {nf(tr.w_m * 3.281, 1)} ft</dd>
            <dt>Speed</dt><dd>{p ? `${(p.v * MPS_TO_MPH).toFixed(1)} mph` : 'not in view'}</dd>
            <dt>Acceleration</dt><dd>{p ? `${(p.a * 3.281).toFixed(1)} ft/s² (${p.a.toFixed(2)} m/s²)` : '—'}</dd>
            <dt>Lane</dt><dd>{p ? p.lane : '—'}</dd>
            <dt>Position (x, y)</dt><dd>{p ? `${(p.x * 3.281).toFixed(0)}, ${(p.y * 3.281).toFixed(0)} ft` : '—'}</dd>
          </dl>
        </>
      ) : <p className="muted">Select a vehicle in the plan or a conflict in the list to inspect its speed, acceleration and lane.</p>}
    </div>
  );
}
