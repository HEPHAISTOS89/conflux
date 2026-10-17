import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import PlanView from '../components/PlanView';
import TimeSpace from '../components/TimeSpace';
import Player from '../components/Player';
import RepairPanel from '../components/RepairPanel';
import SsmPanel from '../components/SsmPanel';
import { useApi } from '../lib/api';
import { nf } from '../lib/format';
import { useReveal } from '../lib/motion';
import { ClockCtx, MPS_TO_MPH, poseAt, selectConflict, SelectionCtx, useClockFrame, useClockState, useSelectionState, type Clock, type ConflictT, type IntersectionT, type Selection } from '../lib/traj';
import '../styles/intersection.css';

const LidarView = lazy(() => import('../components/LidarView'));

interface IxCard { id: string; name: string; n_tracks: number; n_conflicts: number; source: { location: string; global_time_ms: number[] } }
const TYPE_LABEL = { rear_end: 'Rear-end', crossing: 'Crossing', lane_change: 'Lane change' } as const;

export default function IntersectionPage() {
  const { id = 'peachtree-10th' } = useParams();
  const nav = useNavigate();
  const cards = useApi<IxCard[]>('/intersections');
  const ix = useApi<IntersectionT>(`/intersections/${id}`);
  const cf = useApi<ConflictT[]>(`/intersections/${id}/conflicts`);
  const clock = useClockState(ix.data?.window_s ?? 90);
  const selection = useSelectionState(clock);
  const { selected, select } = selection;
  const [view, setView] = useState<'plan' | 'lidar'>('plan');
  const [typeF, setTypeF] = useState<'all' | ConflictT['type']>('all');
  const conflicts = useMemo(() => (cf.data ?? []).filter((c) => typeF === 'all' || c.type === typeF).sort((a, b) => a.t - b.t), [cf.data, typeF]);
  const ready = ix.data && cf.data && ix.data.id === id;

  const jump = (c: ConflictT) => selectConflict(selection, c);
  useDeepLink(ready ? id : null, cf.data ?? [], clock, selection);
  useKeys(clock, selection, setView);

  // keep the first conflict row of the selection in view when the selection comes from another view
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = list.current, row = box?.querySelector<HTMLElement>('tr[data-active], tr[data-rel]');
    if (!box || !row) return;
    const top = row.offsetTop - box.querySelector('thead')!.clientHeight;
    if (top < box.scrollTop || row.offsetTop + row.clientHeight > box.scrollTop + box.clientHeight) box.scrollTop = top - 8;
  }, [selected]);

  return (
    <div className="page ixlab">
      <header className="page-head">
        <h1>Intersection lab</h1>
        <p>
          Rear-end, crossing and lane-change conflicts screened by TTC, PET and DRAC on 10 Hz FHWA NGSIM vehicle tracks.
        </p>
      </header>

      <nav className="cor-tabs ix-tabs" aria-label="Intersections">
        {(cards.data ?? []).map((c) => (
          <button key={c.id} aria-pressed={c.id === id} onClick={() => { select(null); clock.setT(0); nav(`/intersections/${c.id}`); }}>
            <span>{c.name}</span>
            <small className="num">{c.n_tracks} tracks · {c.n_conflicts} conflicts</small>
          </button>
        ))}
      </nav>

      {(ix.error || cf.error) && <div className="error-box">{ix.error ?? cf.error}</div>}
      {!ready ? <div className="skeleton" style={{ height: 520 }} /> : (
        <ClockCtx.Provider value={clock}><SelectionCtx.Provider value={selection}>
          <Reveal className="ix-stage">
            <div className="ix-view panel" data-mode={view} data-ui data-r="1">
              <div className="ix-view-bar">
                <div className="seg" role="group" aria-label="View">
                  <button aria-pressed={view === 'plan'} onClick={() => setView('plan')} title="Plan view (2)">Plan</button>
                  <button aria-pressed={view === 'lidar'} onClick={() => setView('lidar')} title="3D view (3)">Roadside LiDAR 3D</button>
                </div>
                <Player conflicts={cf.data!} />
              </div>
              <div className="ix-canvas">
                {view === 'plan'
                  ? <PlanView data={ix.data!} conflicts={cf.data!} label={`Plan view of ${ix.data!.name}; click a vehicle to select it`} />
                  : <Suspense fallback={<div className="lidar" />}><LidarView data={ix.data!} conflicts={cf.data!} label={`Simulated roadside LiDAR point cloud of ${ix.data!.name}`} /></Suspense>}
              </div>
            </div>
            <aside className="ix-side" data-r="2">
              <VehicleReadout data={ix.data!} conflicts={cf.data!} />
              <div className="panel ix-conf" data-ui>
                <div className="ix-conf-h">
                  <h3>Conflicts <span className="num muted">{conflicts.length}</span></h3>
                  <select value={typeF} onChange={(e) => setTypeF(e.target.value as any)} aria-label="Filter conflict type">
                    <option value="all">All types</option><option value="rear_end">Rear-end</option><option value="crossing">Crossing</option><option value="lane_change">Lane change</option>
                  </select>
                </div>
                <div className="ix-conf-list" ref={list}>
                  <table className="data">
                    <thead><tr><th className="r">t s</th><th>Type</th><th className="r">TTC s</th><th className="r">PET s</th><th className="r wrap">DRAC ft/s²</th></tr></thead>
                    <tbody>
                      {conflicts.map((c) => (
                        <tr key={c.id} onClick={() => jump(c)} tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), jump(c))}
                          data-active={(selected.has(String(c.a)) && selected.has(String(c.b))) || undefined}
                          data-rel={(!(selected.has(String(c.a)) && selected.has(String(c.b))) && (selected.has(String(c.a)) || selected.has(String(c.b)))) || undefined}
                          data-hover={selection.hovered != null && (String(c.a) === selection.hovered || String(c.b) === selection.hovered) || undefined}
                          aria-selected={selection.conflict === c.id}
                          aria-label={`Jump to ${TYPE_LABEL[c.type]} conflict at ${c.t.toFixed(1)} s`}>
                          <td className="r num">{c.t.toFixed(1)}</td>
                          <td><span className={`sev sev-${c.severity}`}>{TYPE_LABEL[c.type]}</span>{(c as any).overlap ? <span className="flag" title="Simultaneous occupancy of the conflict zone; likely NGSIM position error">overlap</span> : null}</td>
                          <td className="r num">{c.ttc_min != null ? c.ttc_min.toFixed(2) : '—'}</td>
                          <td className="r num">{c.pet != null ? c.pet.toFixed(2) : '—'}</td>
                          <td className={`r num ${c.drac_max != null && c.drac_max > 8 ? 'implaus' : ''}`}>{c.drac_max != null ? (c.drac_max * 3.281).toFixed(1) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="ix-foot muted">Dotted DRAC exceeds tyre–road friction (26 ft/s²): a position error, not a manoeuvre.</p>
              </div>
            </aside>
          </Reveal>

          <Reveal className="section" aria-labelledby="ts-h">
            <div className="section-head" data-r="1">
              <h2 id="ts-h">Time–space diagram</h2>
              <p className="ix-keys muted"><kbd>Space</kbd> play · <kbd>←</kbd><kbd>→</kbd> 0.1 s · <kbd>Shift</kbd>+<kbd>←</kbd><kbd>→</kbd> 1 s · <kbd>Esc</kbd> clear · <kbd>2</kbd>/<kbd>3</kbd> plan / 3D</p>
            </div>
            <div className="panel ix-ts" data-ui data-r="2"><TimeSpace data={ix.data!} conflicts={cf.data!} label="Time–space diagram; drag to scrub time, click a line to select a vehicle" /></div>
          </Reveal>
        </SelectionCtx.Provider></ClockCtx.Provider>
      )}

      <SsmPanel id={id} />
      <RepairPanel id={id} />
    </div>
  );
}

const FT = 3.281;
const unit = (v: number | null, d: number, u: string) => (v == null ? '—' : `${nf(v, d)} ${u}`);

/** Inspector for the selection: live kinematics side by side, the pair's extremes, and their conflicts. */
function VehicleReadout({ data, conflicts }: { data: IntersectionT; conflicts: ConflictT[] }) {
  const sel = useContext(SelectionCtx)!;
  const trs = [...sel.selected].map((id) => data.tracks.find((t) => String(t.id) === id)).filter((t): t is IntersectionT['tracks'][number] => !!t).slice(0, 3);
  const [poses, setPoses] = useState<ReturnType<typeof poseAt>[]>([]);
  useClockFrame((t) => setPoses(trs.map((tr) => poseAt(tr, t, data.hz))), [sel.selected]);
  const mine = conflicts.filter((c) => sel.selected.has(String(c.a)) || sel.selected.has(String(c.b))).sort((a, b) => a.t - b.t);
  const pair = trs.length === 2 ? mine.filter((c) => sel.selected.has(String(c.a)) && sel.selected.has(String(c.b))) : [];
  const ext = (v: (number | null)[], f: (...x: number[]) => number) => { const n = v.filter((x): x is number => x != null); return n.length ? f(...n) : null; };
  const drac = ext(pair.map((c) => c.drac_max), Math.max);
  const live = (fn: (p: NonNullable<ReturnType<typeof poseAt>>) => string) => trs.map((tr, i) => <td key={String(tr.id)} className="r num">{poses[i] ? fn(poses[i]!) : '—'}</td>);
  return (
    <>
      <p className="sr-only" aria-live="polite">{trs.length ? `Selected ${trs.map((t) => `vehicle ${t.id}`).join(' and ')}` : ''}</p>
      {trs.length > 0 && (
        <div className="panel ix-veh">
          <div className="ix-veh-h">
            <h3>{pair.length ? 'Conflict pair' : trs.length > 1 ? `${trs.length} vehicles` : 'Vehicle'}</h3>
            <button className="btn ghost" onClick={() => sel.select(null)} title="Clear selection (Esc)">Clear</button>
          </div>
          {pair.length > 0 && (
            <dl className="num ix-pair">
              <div><dt>min TTC</dt><dd>{unit(ext(pair.map((c) => c.ttc_min), Math.min), 2, 's')}</dd></div>
              <div><dt>min PET</dt><dd>{unit(ext(pair.map((c) => c.pet), Math.min), 2, 's')}</dd></div>
              <div><dt>max DRAC</dt><dd>{unit(drac == null ? null : drac * FT, 1, 'ft/s²')}</dd></div>
            </dl>
          )}
          <table className="ix-kin">
            <thead><tr><th />{trs.map((tr, i) => <th key={String(tr.id)} className="r num" data-primary={i === 0 || undefined}>#{tr.id}</th>)}</tr></thead>
            <tbody>
              <tr><th>Class</th>{trs.map((tr) => <td key={String(tr.id)} className="r">{tr.cls}</td>)}</tr>
              <tr><th>Movement</th>{trs.map((tr) => <td key={String(tr.id)} className="r">{tr.dir} {tr.move}</td>)}</tr>
              <tr><th>Speed</th>{live((p) => `${(p.v * MPS_TO_MPH).toFixed(1)} mph`)}</tr>
              <tr><th>Accel.</th>{live((p) => `${(p.a * FT).toFixed(1)} ft/s²`)}</tr>
              <tr><th>Lane</th>{live((p) => String(p.lane))}</tr>
            </tbody>
          </table>
          {mine.length > 0 && (
            <ul className="ix-vc">
              {mine.slice(0, 3).map((c) => (
                <li key={c.id}>
                  <button onClick={() => selectConflict(sel, c)} aria-pressed={sel.conflict === c.id}>
                    <span className={`sev sev-${c.severity}`}>{TYPE_LABEL[c.type]}</span>
                    <span className="num">#{c.a}–#{c.b} · {c.t.toFixed(1)} s</span>
                    <span className="num muted">{c.ttc_min != null ? `TTC ${c.ttc_min.toFixed(2)}` : `PET ${nf(c.pet, 2)}`} s</span>
                  </button>
                </li>
              ))}
              {mine.length > 3 && <li className="muted ix-more">+{mine.length - 3} more, highlighted in the table</li>}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(el.tagName));

/** Page shortcuts: Space play/pause, ←/→ 0.1 s, Shift+←/→ 1 s, Esc clear selection, 2 / 3 plan / 3D. */
function useKeys(clock: Clock, sel: Selection, setView: (v: 'plan' | 'lidar') => void) {
  const ref = useRef({ clock, sel });
  ref.current = { clock, sel };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const { clock: c, sel: s } = ref.current;
      if (e.key === 'Escape') { if (s.selected.size) { s.select(null); e.preventDefault(); } return; }
      if (typing(e.target)) return;
      if (e.key === ' ') { e.preventDefault(); c.toggle(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); c.setT(c.now() + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 1 : 0.1)); }
      else if (e.key === '2') setView('plan');
      else if (e.key === '3') setView('lidar');
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [setView]);
}

/**
 * Deep links: ?conflict=<id> selects the pair and seeks; ?v=<id>[,<id>] selects; ?t=<s> seeks.
 * The URL then follows the selection and the paused time with replaceState (no history entries, no re-render).
 */
function useDeepLink(id: string | null, conflicts: ConflictT[], clock: Clock, sel: Selection) {
  const applied = useRef<string | null>(null);
  const playing = useRef(clock.playing);
  playing.current = clock.playing;
  useEffect(() => {
    if (!id || applied.current === id) return;
    applied.current = id;
    const q = new URLSearchParams(location.search);
    const c = q.get('conflict') != null ? conflicts.find((k) => String(k.id) === q.get('conflict')) : undefined;
    if (c) selectConflict(sel, c);
    else if (q.get('v')) sel.select(q.get('v')!.split(','));
    const t = Number(q.get('t'));
    if (q.get('t') != null && Number.isFinite(t)) clock.setT(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, conflicts]);

  const write = () => {
    if (!id || applied.current !== id) return;
    const q = new URLSearchParams(location.search);
    q.delete('conflict'); q.delete('v'); q.delete('t');
    if (sel.conflict != null) q.set('conflict', String(sel.conflict));
    else if (sel.selected.size) q.set('v', [...sel.selected].join(','));
    if (!playing.current && clock.now() > 0) q.set('t', clock.now().toFixed(1));
    const s = q.toString().replace(/%2C/g, ',');
    const url = `${location.pathname}${s ? `?${s}` : ''}${location.hash}`;
    if (url !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(history.state, '', url);
  };
  const writeRef = useRef(write);
  writeRef.current = write;
  useEffect(() => { writeRef.current(); }, [sel.selected, sel.conflict, clock.playing, id]);
  useEffect(() => {
    let h = 0;
    const off = clock.subscribe(() => { clearTimeout(h); h = window.setTimeout(() => { if (!playing.current) writeRef.current(); }, 300); });
    return () => { off(); clearTimeout(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock.subscribe]);
}

/** A section whose `data-r` children rise in sequence when it first enters the viewport. */
function Reveal(props: HTMLAttributes<HTMLElement>) {
  const ref = useReveal<HTMLElement>();
  return <section ref={ref} {...props} />;
}
