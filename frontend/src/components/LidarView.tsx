import { useEffect, useRef, useState } from 'react';
import { CHART } from '../lib/format';
import { createEngine, SENSOR, BLIND_R, type CamMode, type Engine, type EngineView, type Layers, type PresetId, type ReplayStatus } from '../lib/lab/engine';
import { labPalette, useThemeName } from '../lib/lab/palette';
import { focusConflict, webglAvailable, writeParam } from '../lib/lab/hooks';
import { useClock, useClockFrame, useSelection, type ConflictT, type IntersectionT } from '../lib/traj';
import { Icon, type IconName } from './Icon';
import Hud from './lab/Hud';
import PlanView from './PlanView';

interface Props { data: IntersectionT; conflicts: ConflictT[]; label: string }

export const MODES: { id: CamMode; name: string; icon: IconName; tip: string }[] = [
  { id: 'orbit', name: 'Orbit', icon: 'reset', tip: 'Orbit: drag to rotate, right-drag to pan, scroll to zoom' },
  { id: 'fly', name: 'Fly', icon: 'path', tip: 'Free-fly: W A S D or arrows to move, Q / E down / up, Shift faster, drag to look' },
  { id: 'follow', name: 'Follow', icon: 'vehicle', tip: 'Chase camera behind the selected vehicle; drag to swing, scroll for distance' },
  { id: 'top', name: 'Top', icon: 'target', tip: 'Top-down orthographic: true-scale plan, drag to pan, scroll to zoom' },
  { id: 'sensor', name: 'Sensor', icon: 'sensor', tip: 'Sensor point of view from the pole head; drag to look, scroll to change field of view' },
];
export const PRESETS: { id: PresetId; name: string }[] = [
  { id: 'overview', name: 'Overview' },
  { id: 'approach', name: 'Approach' },
  { id: 'zone', name: 'Conflict zone' },
  { id: 'stopline', name: 'Stop line' },
  { id: 'sensor', name: 'Sensor POV' },
];
const LAYERS: { id: keyof Layers; name: string; tip: string }[] = [
  { id: 'cloud', name: 'Point cloud', tip: 'Simulated LiDAR returns; off shows vehicle bodies' },
  { id: 'trails', name: 'Trails', tip: 'Last 3 s of every vehicle; selected in colour' },
  { id: 'projection', name: 'Projection', tip: '2 s constant-acceleration projection of the selected vehicles: a kinematic extrapolation, not a prediction model' },
  { id: 'zones', name: 'Conflict zones', tip: 'Location of every screened conflict, coloured by severity; brighter while active' },
  { id: 'fov', name: 'Sensor FOV', tip: `Assumed sensor model: ${SENSOR.vMin}° to +${SENSOR.vMax}° vertical, ${SENSOR.range} m range, ${(BLIND_R * 3.281).toFixed(0)} ft blind radius under the pole` },
];

/** Roadside-LiDAR 3D lab, or the plan view with an explanation where WebGL2 is unavailable. */
export default function LidarView(props: Props) {
  if (!webglAvailable()) {
    return (
      <div className="lidar lidar-fallback">
        <PlanView data={props.data} conflicts={props.conflicts} label={props.label.replace('Simulated roadside LiDAR point cloud', 'Plan view')} />
        <p className="lidar-nogl" role="status"><Icon name="warning" size={16} /> No WebGL2: showing the plan view.</p>
      </div>
    );
  }
  return <Lidar3D {...props} />;
}

function Lidar3D({ data, conflicts, label }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mini = useRef<HTMLCanvasElement>(null);
  const needle = useRef<HTMLSpanElement>(null);
  const heading = useRef<HTMLSpanElement>(null);
  const eng = useRef<Engine | null>(null);
  const clock = useClock();
  const sel = useSelection();
  const selRef = useRef(sel);
  selRef.current = sel;
  const [mode, setMode] = useState<CamMode>(() => { const c = new URLSearchParams(location.search).get('cam'); return c === 'fly' || c === 'top' || c === 'sensor' ? c : 'orbit'; });
  const [layers, setLayers] = useState<Layers>(() => readLayers());
  const [replay, setReplay] = useState<ReplayStatus | null>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [glError, setGlError] = useState(false);
  const focus = focusConflict(sel, conflicts);
  const primary = sel ? [...sel.selected][0] ?? null : null;
  const layersRef = useRef(layers); layersRef.current = layers;
  const modeRef = useRef(mode); modeRef.current = mode;
  const theme = useThemeName();
  // camera kept across a rebuild (theme switch); seeded from ?cam= on first mount
  const viewRef = useRef<EngineView | null>(null);
  const [fps, setFps] = useState<number | null>(null);

  useEffect(() => {
    let e: Engine;
    try {
      e = createEngine({
        host: host.current!, minimap: mini.current, compass: needle.current, heading: heading.current,
        data, conflicts, layers: layersRef.current, mode: modeRef.current, clock, palette: labPalette(theme), view: viewRef.current,
        onFps: setFps,
        onPick: (id, add) => { const s = selRef.current; if (!s) return; if (id) s.select([id], { add }); else s.select(null); },
        onHover: (id) => { const s = selRef.current; if (s && s.hovered !== id) s.hover(id); },
        onMode: setMode,
        onReplay: setReplay,
      });
    } catch { setGlError(true); return; }
    eng.current = e;
    e.setSel(selRef.current?.selected ?? new Set(), selRef.current?.hovered ?? null, null);
    return () => { viewRef.current = e.getView(); e.dispose(); eng.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, conflicts, theme]);

  useEffect(() => { eng.current?.setSel(sel?.selected ?? new Set(), sel?.hovered ?? null, focus); }, [sel?.selected, sel?.hovered, focus, data, conflicts, theme]);
  useEffect(() => { eng.current?.setLayers(layers); try { localStorage.setItem('rs-lab-layers', JSON.stringify(layers)); } catch { /* private mode */ } }, [layers]);
  useClockFrame((t) => eng.current?.update(t), [data, conflicts, theme]);
  // camera mode in the deep link
  useEffect(() => { writeParam('cam', mode === 'orbit' ? null : mode); }, [mode]);

  // 3D shortcuts: C / Shift+C camera mode, P preset, R replay from three angles
  const api = useRef({ cycle: (_d: number) => {}, preset: () => {}, replay: () => {} });
  api.current = {
    cycle: (d) => {
      const list = MODES.filter((m) => m.id !== 'follow' || primary).map((m) => m.id);
      const i = list.indexOf(mode);
      eng.current?.setMode(list[(i + d + list.length) % list.length]);
    },
    preset: () => { const i = (presetIdx.current + 1) % PRESETS.length; presetIdx.current = i; eng.current?.preset(PRESETS[i].id); },
    replay: () => { if (focus) eng.current?.replay(); },
  };
  const presetIdx = useRef(-1);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === 'c') { e.preventDefault(); api.current.cycle(e.shiftKey ? -1 : 1); }
      else if (k === 'p') { e.preventDefault(); api.current.preset(); }
      else if (k === 'r') { e.preventDefault(); api.current.replay(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const PT = { car: CHART.sb, truck: CHART.eb, hot: CHART.critical, sel: CHART.accent, partner: CHART.caution };
  if (glError) {
    return (
      <div className="lidar lidar-fallback">
        <PlanView data={data} conflicts={conflicts} label={label} />
        <p className="lidar-nogl" role="status"><Icon name="warning" size={16} /> WebGL context failed to start; showing the plan view.</p>
      </div>
    );
  }
  return (
    <div ref={host} className="lidar" data-mode={mode}>
      <span className="sr-only" role="img" aria-label={label} />
      <Hud data={data} conflicts={conflicts} />

      <div className="lidar-cams">
        <div className="seg" role="group" aria-label="Camera mode">
          {MODES.map((m) => (
            <button key={m.id} aria-label={m.name} aria-pressed={mode === m.id} disabled={m.id === 'follow' && !primary} title={m.id === 'follow' && !primary ? 'Select a vehicle to follow it' : `${m.tip} (C cycles)`}
              onClick={() => eng.current?.setMode(m.id)}>
              <Icon name={m.icon} size={15} /><span>{m.name}</span>
            </button>
          ))}
        </div>
        <div className="lidar-presets" role="group" aria-label="Camera presets">
          {PRESETS.map((p, i) => <button key={p.id} onClick={() => { presetIdx.current = i; eng.current?.preset(p.id); }} title={`Fly to ${p.name} (P cycles)`}>{p.name}</button>)}
        </div>
      </div>

      {(replay || focus) && (
        <div className="lidar-moment" role="status" aria-live="polite">
          {replay ? (
            <>
              <span className="lidar-moment-k"><Icon name="camera" size={15} /> Angle {replay.angle} of {replay.of}</span>
              <span>{replay.name}</span>
              <button className="btn ghost" onClick={() => eng.current?.cancelReplay()}>Stop replay</button>
            </>
          ) : focus && (
            <>
              <span className="lidar-moment-k"><Icon name="alert" size={15} /> Near-miss at <span className="measure">{focus.t.toFixed(1)} s</span></span>
              <button className="btn" onClick={() => eng.current?.replay()} title="Replays the conflict three times: behind each vehicle, then overhead (R)"><Icon name="camera" size={15} /> Replay</button>
            </>
          )}
        </div>
      )}

      <div className="lidar-layers" data-open={layersOpen || undefined}>
        <button className="lidar-layers-t" aria-expanded={layersOpen} onClick={() => setLayersOpen((v) => !v)}><Icon name="layers" size={15} /> Layers</button>
        {layersOpen && (
          <>
            <div className="lidar-chips" role="group" aria-label="Layers">
              {LAYERS.map((l) => (
                <button key={l.id} aria-pressed={layers[l.id]} title={l.tip} onClick={() => setLayers((s) => ({ ...s, [l.id]: !s[l.id] }))}>
                  <Icon name={layers[l.id] ? 'eye' : 'eyeOff'} size={14} />{l.name}
                </button>
              ))}
            </div>
            <div className="lidar-legend" aria-label="Legend">
              <span><i style={{ background: PT.car }} />car</span>
              <span><i style={{ background: PT.truck }} />heavy vehicle</span>
              <span><i style={{ background: PT.hot }} />in conflict now</span>
              <span><i style={{ background: PT.sel }} />selected</span>
              <span><i style={{ background: PT.partner }} />partner</span>
              <span><i className="bar" />stop bar</span>
            </div>
          </>
        )}
      </div>

      <div className="lidar-mini">
        <canvas ref={mini} aria-label="Minimap: click to move the camera there" role="img" />
        <span className="lidar-compass" aria-hidden="true" title="Corridor north (+y of the NGSIM local grid)">
          <span ref={needle} className="needle">
            <svg viewBox="-20 -20 40 40" width="38" height="38">
              <circle r="17" className="c-ring" />
              {[0, 90, 180, 270].map((a) => <line key={a} x1="0" y1="-17" x2="0" y2="-13" transform={`rotate(${a})`} className="c-tick" />)}
              <path d="M0,-12 L4,1 L0,-1.5 L-4,1 Z" className="c-n" />
              <path d="M0,12 L4,-1 L0,1.5 L-4,-1 Z" className="c-s" />
              <text y="-5" x="7.5" className="c-l">N</text>
            </svg>
          </span>
        </span>
        <span ref={heading} className="lidar-heading measure" aria-hidden="true" />
      </div>
      {fps != null && <span className="lidar-fps measure" title="Frames drawn per second while the scene moves (target 60)">{fps} fps</span>}
    </div>
  );
}

function readLayers(): Layers {
  const d: Layers = { trails: true, projection: true, zones: false, fov: false, cloud: true };
  try { const v = JSON.parse(localStorage.getItem('rs-lab-layers') ?? 'null'); return v && typeof v === 'object' ? { ...d, ...v } : d; } catch { return d; }
}

