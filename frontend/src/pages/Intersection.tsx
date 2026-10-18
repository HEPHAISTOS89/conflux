import { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import Select from '../components/Select';
import MetricInfo, { type MetricSpec } from '../components/MetricInfo';
import { Icon } from '../components/Icon';
import Info from '../components/Info';
import DataHealth from '../components/lab/DataHealth';
import Shortcuts from '../components/lab/Shortcuts';
import SpeedHistogram from '../components/lab/SpeedHistogram';
import QueuePanel from '../components/lab/QueuePanel';
import { inferSignals } from '../components/world/signals';
import { phaseIntervals, signalGeometry } from '../lib/lab/queue';
import { downloadCSV } from '../lib/export';
import { exportCanvases, focusConflict, useFullscreen, writeParam } from '../lib/lab/hooks';
import { dataHealth, nearMissWarp, nextRisk, stepFrame } from '../lib/lab/metrics';
import { conflictIsGhostPair, trackQuality } from '../lib/lab/quality';
import { classCounts, CONFLICT_TYPES, hasPedestrians, isPedestrian, TYPE_LABEL, typesPresent } from '../lib/lab/classes';
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

interface IxCard { id: string; name: string; n_tracks: number; n_conflicts: number; source: { location: string; global_time_ms?: number[]; dataset?: string } }
type TypeF = 'all' | ConflictT['type'];
const isType = (v: string | null): v is ConflictT['type'] => (CONFLICT_TYPES as readonly string[]).includes(v ?? '');

const TTC_SPEC: MetricSpec = {
  name: 'Minimum TTC', provenance: 'derived', unit: 's',
  formula: 'TTC = gap / (v_f − v_l) while v_f > v_l; gap = front-to-rear spacing; minimum over the event',
  threshold: 'Event while TTC ≤ 1.5 s for ≥ 0.3 s. Critical ≤ 0.5 s, serious ≤ 1.0 s, moderate ≤ 1.5 s',
  source: 'FHWA NGSIM vehicle trajectories, 10 Hz',
  citation: 'FHWA SSAM, Gettman et al. (2008) FHWA-HRT-08-051',
};
const PET_SPEC: MetricSpec = {
  name: 'Post-encroachment time', provenance: 'derived', unit: 's',
  formula: 'PET = t(second vehicle front enters the shared swept-footprint zone) − t(first vehicle rear leaves it)',
  threshold: 'Crossing events with PET ≤ 5.0 s; critical ≤ 1 s, serious ≤ 2.5 s (study bins, no FHWA standard)',
  citation: 'Allen, Shin & Cooper (1978) TRR 667; FHWA SSAM (2008)',
  note: '"overlap" marks both footprints inside the zone at once: most likely NGSIM position error (Punzo et al. 2011).',
};
const PED_PET_SPEC: MetricSpec = {
  name: 'Pedestrian–vehicle PET', provenance: 'derived', unit: 's',
  formula: 'PET = t(second road user enters the shared swept-footprint zone inside a crosswalk) − t(first leaves it); pedestrian footprint 0.5 × 0.5 m, any conflict angle',
  threshold: 'Detected at PET ≤ 5.0 s; critical ≤ 1 s, serious ≤ 2 s, moderate ≤ 5 s (study bins; video-based VRU studies use 1–3 s)',
  citation: 'Allen, Shin & Cooper (1978) TRR 667; Zangenehpour et al. (2016) AAP 86',
  note: 'Overlap flags simultaneous occupancy of the zone (PET = 0).',
};
const YIELD_SPEC: MetricSpec = {
  name: 'Failure to yield', provenance: 'derived', unit: 'event',
  formula: 'A vehicle enters a crosswalk while a pedestrian is in it (or within 3 s before the pedestrian enters), never slows below 0.5 m/s in the 3 s before entry, and had at least the AASHTO stopping distance 2.5 s·v + v²/(2·3.4 m/s²) available when the pedestrian stepped in',
  threshold: 'Severity: pedestrian already in the crosswalk → distance to the pedestrian at entry ≤ 3.6 m critical, ≤ 7.2 m serious; pedestrian arriving after → lead time ≤ 1 s critical, ≤ 2 s serious (study bins)',
  citation: 'Texas Transportation Code §552.003; Fitzpatrick et al. (2006) NCHRP Report 562; AASHTO (2018)',
  note: 'Indicator, not a citation: signal phase and the roadway-half condition of §552.003(a) are not applied.',
};
const DRAC_SPEC: MetricSpec = {
  name: 'Deceleration rate to avoid crash', provenance: 'derived', unit: 'ft/s²',
  formula: 'DRAC = (v_f − v_l)² / (2 · gap), maximum over the event',
  threshold: 'Flag at ≥ 11.2 ft/s² (3.4 m/s²); reported with TTC events, not a detection criterion',
  citation: 'AASHTO (2018) Green Book, 7th ed.',
  note: 'Dotted: above tyre–road friction (≈ 26 ft/s²), likely position error.',
};

export default function IntersectionPage() {
  const { id = 'peachtree-10th' } = useParams();
  const nav = useNavigate();
  const cards = useApi<IxCard[]>('/intersections');
  const ix = useApi<IntersectionT>(`/intersections/${id}`);
  const cf = useApi<ConflictT[]>(`/intersections/${id}/conflicts`);
  const clock = useClockState(ix.data?.window_s ?? 90);
  const selection = useSelectionState(clock);
  const { selected, select } = selection;
  // view and type filter live in the deep link (?view=3d&type=crossing) with the selection, time and camera
  const [view, setView] = useState<'plan' | 'lidar'>(() => (new URLSearchParams(location.search).get('view') === '3d' ? 'lidar' : 'plan'));
  const [typeF, setTypeF] = useState<TypeF>(() => { const v = new URLSearchParams(location.search).get('type'); return isType(v) ? v : 'all'; });
  useEffect(() => { writeParam('view', view === 'lidar' ? '3d' : null); if (view !== 'lidar') writeParam('cam', null); }, [view, id]);
  useEffect(() => { writeParam('type', typeF === 'all' ? null : typeF); }, [typeF, id]);
  const [help, setHelp] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const [fs, toggleFs] = useFullscreen(stage);
  const conflicts = useMemo(() => (cf.data ?? []).filter((c) => typeF === 'all' || c.type === typeF).sort((a, b) => a.t - b.t), [cf.data, typeF]);
  const ready = ix.data && cf.data && ix.data.id === id;
  const health = useMemo(() => (ix.data ? dataHealth(ix.data.tracks, ix.data.hz) : null), [ix.data]);
  const quality = useMemo(() => (ix.data ? trackQuality(ix.data.tracks, ix.data.hz) : null), [ix.data]);
  // signal phase inferred from flow, shared by the scrubber strip and the queue chart (same geometry as the 3D world)
  const sig = useMemo(() => {
    if (!ix.data) return null;
    const g = signalGeometry(ix.data);
    const plan = inferSignals(ix.data.tracks, g, ix.data.window_s, ix.data.hz);
    return { g, plan, ns: phaseIntervals(plan, 'ns') };
  }, [ix.data]);
  const rep = useApi<{ summary: { tracks_occluded: number; tracks_eligible: number } }>(`/intersections/${id}/repair`);
  const all = cf.data ?? [];
  // critical excludes simultaneous-occupancy (overlap) flags, likely NGSIM position error: same rule as the landing verdict
  const isGhost = useCallback((c: ConflictT) => conflictIsGhostPair(quality, c.a, c.b, c.t), [quality]);
  const counts = useMemo(() => ({ n: all.length, crit: all.filter((c) => c.severity === 'critical' && !(c as { overlap?: boolean }).overlap && !isGhost(c)).length, ghost: all.filter(isGhost).length, overlap: all.filter((c) => (c as { overlap?: boolean }).overlap).length, ttc: all.reduce<number | null>((m, c) => (c.ttc_min != null && (m == null || c.ttc_min < m) ? c.ttc_min : m), null) }), [all, isGhost]);

  const jump = (c: ConflictT) => selectConflict(selection, c);
  useDeepLink(ready ? id : null, cf.data ?? [], clock, selection);
  useKeys(clock, selection, setView, conflicts, toggleFs, useCallback(() => setHelp((h) => !h), []));

  // near-miss moment: playback eases to 0.35× within ±0.6 s of the conflict being studied
  const focus = focusConflict(selection, cf.data ?? []);
  useEffect(() => {
    clock.setWarp(focus ? (t) => nearMissWarp(t, focus.t) : null);
    return () => clock.setWarp(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.id, clock.setWarp]);

  const site = ix.data?.name ?? id;
  const peds = ix.data ? hasPedestrians(ix.data) : false;
  const classes = useMemo(() => (ix.data ? classCounts(ix.data.tracks) : []), [ix.data]);
  const dataset = String(ix.data?.source?.dataset ?? 'FHWA NGSIM vehicle trajectories (USDOT ITS DataHub)');
  const licence = ix.data?.source?.licence ? String(ix.data.source.licence) : null;
  const yieldSum = useMemo(() => { const y = all.filter((c) => c.type === 'yield'); return y.length ? { n: new Set(y.map((c) => `${c.a}@${c.t}`)).size } : null; }, [all]);
  const caption = () => `${site} · ${dataset} · t = ${clock.now().toFixed(1)} s · Conflux`;
  const exportView = () => { const el = stage.current?.querySelector<HTMLElement>('.ix-canvas'); if (el) exportCanvases(`${id}-${view === 'plan' ? 'plan' : '3d'}-t${clock.now().toFixed(1)}.png`, el, caption()); };
  const exportTs = () => { const el = document.querySelector<HTMLElement>('.ix-ts .timespace'); if (el) exportCanvases(`${id}-time-space.png`, el, caption().replace(/ · t = [^·]+/, '')); };
  const exportCsv = () => downloadCSV(`${id}-conflicts${typeF === 'all' ? '' : `-${typeF}`}.csv`, conflicts.map((c) => ({
    site: id, conflict_id: c.id, t_s: c.t, type: c.type, vehicle_a: c.a, vehicle_b: c.b, severity: c.severity,
    ttc_min_s: c.ttc_min ?? '', pet_s: c.pet ?? '', drac_max_ft_s2: c.drac_max != null ? +(c.drac_max * 3.281).toFixed(2) : '', overlap_flag: (c as { overlap?: boolean }).overlap ? 1 : 0,
    crosswalk: c.crosswalk ?? '', yield_margin_s: c.margin_s ?? '', entry_speed_mph: c.v_entry_mps != null ? +(c.v_entry_mps * MPS_TO_MPH).toFixed(1) : '', ped_distance_ft: c.ped_dist_m != null ? +(c.ped_dist_m * 3.281).toFixed(1) : '',
  })));

  // keep the first conflict row of the selection in view when the selection comes from another view
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = list.current, row = box?.querySelector<HTMLElement>('tr[data-active], tr[data-rel]');
    if (!box || !row) return;
    const top = row.offsetTop;
    if (top < box.scrollTop || row.offsetTop + row.clientHeight > box.scrollTop + box.clientHeight) box.scrollTop = top - 8;
  }, [selected]);

  return (
    <div className="page ixlab">
      <PageHeader
        icon="signal" title="Intersection lab"
        lede={peds
          ? 'Rear-end, crossing and lane-change conflicts screened by TTC, PET and DRAC, plus pedestrian–vehicle PET over the crosswalks and a failure-to-yield indicator, on 10 Hz trajectories from a site feed. Pedestrians are drawn in teal as centred points; vehicles as front-bumper-referenced bodies.'
          : 'Rear-end, crossing and lane-change conflicts screened by TTC, PET and DRAC on 10 Hz vehicle trajectories. The 3D view is a simulated roadside LiDAR built from the same tracks. NGSIM has vehicle tracks only, no pedestrians. Select a vehicle in any view for its kinematics; select two for live TTC and PET.'}
        source={<>{dataset} · {site} · {ix.data ? `${Math.round(ix.data.window_s)} s window` : '…'} · {classes.length ? classes.map((c) => `${c.n} ${c.cls}${c.n === 1 ? '' : c.cls === 'bus' ? 'es' : 's'}`).join(', ') : 'vehicles only'}{licence ? <> · <span title={licence}>licence: {licence.length > 48 ? `${licence.slice(0, 46)}…` : licence}</span></> : null}</>}
        readouts={[
          { label: 'Conflicts', value: ready ? counts.n : null },
          { label: <span title={`Critical events, excluding ${counts.overlap} overlap flags (likely position error) and ${counts.ghost} events between a duplicate track and its host`}>Critical</span>, value: ready ? counts.crit : null, tone: 'alert' },
          ...(peds && yieldSum
            ? [{ label: <span title="Vehicle crosswalk entries that neither stopped nor lacked stopping distance while a pedestrian was in (or stepping into) the crosswalk">Failures to yield</span>, value: ready ? yieldSum.n : null, tone: 'alert' as const }]
            : [{ label: 'Worst TTC', value: ready ? counts.ttc : null, unit: 's', digits: 2 }]),
          { label: 'Complete', value: health?.completeness ?? null, unit: '%', digits: 1, tone: 'accent' },
        ]}
      />

      <nav className="cor-tabs ix-tabs" aria-label="Intersections">
        {(cards.data ?? []).map((c) => (
          <button key={c.id} aria-pressed={c.id === id} onClick={() => { select(null); clock.setT(0); nav(`/intersections/${c.id}`); }}>
            <span>{c.name}</span>
            <small className="num" title={`${c.n_tracks} tracks`}>{c.n_conflicts} conflicts</small>
          </button>
        ))}
      </nav>

      {health && ready && <DataHealth h={health} hz={ix.data!.hz} quality={quality} repaired={rep.data ? { n: rep.data.summary.tracks_occluded, of: rep.data.summary.tracks_eligible } : null} classes={classes} />}

      {(ix.error || cf.error) && <div className="error-box">{ix.error ?? cf.error}</div>}
      {!ready ? <div className="skeleton" style={{ height: 520 }} /> : (
        <ClockCtx.Provider value={clock}><SelectionCtx.Provider value={selection}>
          <Reveal className="ix-stage">
            <div className="ix-view panel" data-mode={view} data-fs={fs || undefined} data-ui data-r="1" ref={stage}>
              <div className="ix-view-bar">
                <div className="seg" role="group" aria-label="View">
                  <button aria-pressed={view === 'plan'} onClick={() => setView('plan')} title="Plan view (2)">Plan</button>
                  <button aria-pressed={view === 'lidar'} onClick={() => setView('lidar')} title="Simulated roadside LiDAR, 3D (3)">3D</button>
                </div>
                <Player conflicts={conflicts} phases={sig?.ns} />
                <div className="ix-view-tools">
                  <button className="btn ghost ic" onClick={exportView} title="Download view as PNG" aria-label="Download view as PNG"><Icon name="image" size={16} /></button>
                  <button className="btn ghost ic" onClick={() => setHelp(true)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts"><Icon name="help" size={16} /></button>
                  <button className="btn ghost ic" onClick={toggleFs} aria-pressed={fs} title={fs ? 'Leave fullscreen (F or Esc)' : 'Fullscreen (F)'} aria-label={fs ? 'Leave fullscreen' : 'Fullscreen'}><Icon name={fs ? 'exitFullscreen' : 'fullscreen'} size={16} /></button>
                </div>
              </div>
              <div className="ix-canvas">
                {view === 'plan'
                  ? <PlanView data={ix.data!} conflicts={cf.data!} label={`Plan view of ${ix.data!.name}; click a vehicle to select it`} />
                  : <Suspense fallback={<div className="lidar" />}><LidarView data={ix.data!} conflicts={cf.data!} label={`Simulated roadside LiDAR point cloud of ${ix.data!.name}`} /></Suspense>}
              </div>
              {fs && view === 'plan' && <aside className="ix-fs-side"><VehicleReadout data={ix.data!} conflicts={cf.data!} /></aside>}
              {help && <Shortcuts onClose={() => setHelp(false)} />}
            </div>
            <aside className="ix-side" data-r="2">
              <VehicleReadout data={ix.data!} conflicts={cf.data!} />
              <div className="panel ix-conf" data-ui>
                <div className="ix-conf-h">
                  <h3>Conflicts <span className="measure muted">{conflicts.length}</span></h3>
                  <div className="ix-conf-tools">
                    <Select<TypeF> compact label="Conflict type" icon="filter" value={typeF} onChange={setTypeF} options={[
                      { value: 'all', label: 'All types', hint: String(all.length) },
                      ...typesPresent(all).map((k) => ({ value: k, label: TYPE_LABEL[k], hint: String(all.filter((c) => c.type === k).length) })),
                    ]} />
                    <button className="btn ghost ic" onClick={exportCsv} title="Download conflicts as CSV" aria-label="Download conflicts as CSV"><Icon name="download" size={16} /></button>
                  </div>
                </div>
                {/* header outside the scroller so the methodology popovers are not clipped */}
                <table className="data ix-conf-head" aria-hidden="false">
                  <ConfCols />
                  <thead><tr><th className="r">t s</th><th>Type{peds && <span className="th-mi"><MetricInfo spec={YIELD_SPEC} /></span>}</th><th className="r"><span className="th-mi">TTC s<MetricInfo spec={TTC_SPEC} align="right" /></span></th><th className="r"><span className="th-mi">PET s<MetricInfo spec={peds ? PED_PET_SPEC : PET_SPEC} align="right" /></span></th><th className="r"><span className="th-mi">DRAC<MetricInfo spec={DRAC_SPEC} align="right" /></span></th></tr></thead>
                </table>
                <div className="ix-conf-list" ref={list}>
                  <table className="data" aria-label="Conflicts: time s, type, minimum TTC s, PET s, maximum DRAC ft/s²">
                    <ConfCols />
                    <tbody>
                      {conflicts.map((c) => (
                        <tr key={c.id} onClick={() => jump(c)} tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), jump(c))}
                          data-active={(selected.has(String(c.a)) && selected.has(String(c.b))) || undefined}
                          data-rel={(!(selected.has(String(c.a)) && selected.has(String(c.b))) && (selected.has(String(c.a)) || selected.has(String(c.b)))) || undefined}
                          data-hover={selection.hovered != null && (String(c.a) === selection.hovered || String(c.b) === selection.hovered) || undefined}
                          aria-selected={selection.conflict === c.id}
                          aria-label={`Jump to ${TYPE_LABEL[c.type]} conflict at ${c.t.toFixed(1)} s`}>
                          <td className="r measure">{c.t.toFixed(1)}</td>
                          <td><span className={`sev sev-${c.severity}`}>{c.type === 'pedestrian' || c.type === 'yield' ? <Icon name="pedestrian" size={12} /> : null}{TYPE_LABEL[c.type]}</span>{c.type === 'yield' && c.crosswalk ? <span className="flag" title={`Crosswalk ${c.crosswalk}: entered at ${nf(c.v_entry_mps! * MPS_TO_MPH, 0)} mph, ${nf(c.ped_dist_m! * 3.281, 0)} ft from the pedestrian${c.margin_s != null && c.margin_s < 0 ? `, ${nf(-c.margin_s, 1)} s before the pedestrian stepped in` : ''}; ${nf(c.dist_m! * 3.281, 0)} ft available vs ${nf(c.ssd_m! * 3.281, 0)} ft stopping distance`}>{c.crosswalk.replace('_crosswalk', '')} · {nf(c.ped_dist_m! * 3.281, 0)} ft</span> : null}{(c as any).overlap ? <span className="flag" title="Simultaneous occupancy of the conflict zone; likely NGSIM position error">overlap</span> : null}{isGhost(c) ? <span className="flag" title="Between a duplicate or ID-switched track and the vehicle it duplicates: an artefact of the tracking, not a near-miss">duplicate</span> : null}</td>
                          <td className="r measure">{c.ttc_min != null ? c.ttc_min.toFixed(2) : '—'}</td>
                          <td className="r measure">{c.pet != null ? c.pet.toFixed(2) : '—'}</td>
                          <td className={`r measure ${c.drac_max != null && c.drac_max > 8 ? 'implaus' : ''}`}>{c.drac_max != null ? (c.drac_max * 3.281).toFixed(1) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </aside>
          </Reveal>

          <Reveal className="section" aria-labelledby="ts-h">
            <div className="section-head sh-info" data-r="1">
              <h2 id="ts-h">Time–space diagram</h2><Info label="About the time–space diagram"><p>Vehicle positions along the corridor against time: shockwaves and queue discharge read as the slope of the lines. Drag to scrub time; click a line to select a vehicle.</p></Info>
              <button className="btn ghost ic" onClick={exportTs} title="Download PNG" aria-label="Download time–space diagram as PNG"><Icon name="image" size={16} /></button>
            </div>
            <div className="panel ix-ts" data-ui data-r="2"><TimeSpace data={ix.data!} conflicts={cf.data!} label="Time–space diagram; drag to scrub time, click a line to select a vehicle" /></div>
          </Reveal>
        </SelectionCtx.Provider></ClockCtx.Provider>
      )}

      {ready && (
        <Reveal className="section" aria-labelledby="spd-h">
          <div className="section-head sh-info" data-r="1">
            <h2 id="spd-h">Spot speeds</h2><Info label="About spot speeds"><p>Northbound and southbound approach speeds at a line upstream of the intersection, in 5 mph bins, with the 85th percentile marked.</p></Info>
          </div>
          <div className="panel" data-r="2"><SpeedHistogram data={ix.data!} /></div>
        </Reveal>
      )}

      {ready && sig && <ClockCtx.Provider value={clock}><QueuePanel data={ix.data!} plan={sig.plan} bars={sig.g} /></ClockCtx.Provider>}

      <SsmPanel id={id} />
      <RepairPanel id={id} />
    </div>
  );
}

/** Shared column widths for the split header/body conflict table. */
const ConfCols = () => <colgroup><col style={{ width: '15%' }} /><col style={{ width: '33%' }} /><col style={{ width: '17%' }} /><col style={{ width: '17%' }} /><col style={{ width: '18%' }} /></colgroup>;

const FT = 3.281;
const unit = (v: number | null, d: number, u: string) => (v == null ? '—' : `${nf(v, d)} ${u}`);

/** Inspector for the selection: live kinematics side by side, the pair's extremes, and their conflicts. */
function VehicleReadout({ data, conflicts }: { data: IntersectionT; conflicts: ConflictT[] }) {
  const sel = useContext(SelectionCtx)!;
  const trs = [...sel.selected].map((id) => data.tracks.find((t) => String(t.id) === id)).filter((t): t is IntersectionT['tracks'][number] => !!t).slice(0, 3);
  const [poses, setPoses] = useState<ReturnType<typeof poseAt>[]>([]);
  // readout refreshes at the 10 Hz sample rate, not every animation frame
  const lastKey = useRef('');
  useClockFrame((t) => {
    const key = `${[...sel.selected].join(',')}@${Math.round(t * 10)}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    setPoses(trs.map((tr) => poseAt(tr, t, data.hz)));
  }, [sel.selected]);
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
              <tr><th>Class</th>{trs.map((tr) => <td key={String(tr.id)} className="r"><span className="ix-cls"><Icon name={isPedestrian(tr) ? 'pedestrian' : tr.cls === 'bicycle' ? 'bike' : tr.cls === 'truck' || tr.cls === 'bus' ? 'truck' : 'vehicle'} size={12} />{tr.cls}</span></td>)}</tr>
              <tr><th>Movement</th>{trs.map((tr) => <td key={String(tr.id)} className="r">{tr.dir} {tr.move}</td>)}</tr>
              <tr><th>Speed</th>{live((p) => `${(p.v * MPS_TO_MPH).toFixed(1)} mph`)}</tr>
              <tr><th>Accel.</th>{live((p) => `${(p.a * FT).toFixed(1)} ft/s²`)}</tr>
              <tr><th>Lane</th>{live((p) => (p.lane === 0 ? 'in intersection' : p.lane >= 100 ? 'footway' : `lane ${p.lane}`))}</tr>
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
              {mine.length > 3 && <li className="muted ix-more" title="Highlighted in the conflict table">+{mine.length - 3} more</li>}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(el.tagName));

/**
 * Page shortcuts: Space play/pause, ←/→ 0.1 s (Shift 1 s), , / . one 10 Hz frame, [ / ] previous / next risk event,
 * Esc clear selection, 2 / 3 plan / 3D, F fullscreen, ? shortcut sheet. The 3D view adds its own camera keys.
 */
function useKeys(clock: Clock, sel: Selection, setView: (v: 'plan' | 'lidar') => void, conflicts: ConflictT[], fullscreen: () => void, help: () => void) {
  const ref = useRef({ clock, sel, conflicts, fullscreen, help });
  ref.current = { clock, sel, conflicts, fullscreen, help };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const { clock: c, sel: s, conflicts: cs } = ref.current;
      if (e.key === 'Escape') { if (s.selected.size && !document.querySelector('.kbd-sheet, .mi-pop, .sel-list, .pseudo-fs')) { s.select(null); e.preventDefault(); } return; }
      if (e.key === '?') { e.preventDefault(); ref.current.help(); return; }
      const inField = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName));
      if (inField) return;
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); ref.current.fullscreen(); return; }
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        const from = s.conflict != null ? cs.find((k) => k.id === s.conflict)?.t ?? c.now() : c.now();
        const k = nextRisk(cs, from, e.key === ']' ? 1 : -1);
        if (k) selectConflict(s, k);
        return;
      }
      if (e.key === ',' || e.key === '.') { e.preventDefault(); c.pause(); c.setT(stepFrame(c.now(), e.key === '.' ? 1 : -1, c.duration)); return; }
      if (e.key === '2') { setView('plan'); return; }
      if (e.key === '3') { setView('lidar'); return; }
      // Space and arrows keep their native meaning on a focused button, link or slider
      if (typing(e.target) || (e.target instanceof HTMLElement && e.target.getAttribute('role') === 'slider')) return;
      if (e.key === ' ') { e.preventDefault(); c.toggle(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); c.setT(c.now() + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 1 : 0.1)); }
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
