import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import Info from '../Info';
import { useApi } from '../../lib/api';
import { reducedMotion } from '../../lib/motion';
import { useThemeName } from '../../lib/lab/palette';
import { webglAvailable } from '../../lib/lab/hooks';
import type { IntersectionT } from '../../lib/traj';
import { conflictIsGhostPair, trackQuality } from '../../lib/lab/quality';
import { createWorld, type FlareConflict, type World, type WorldState } from './scene';

const IX = '/intersections/peachtree-10th';

/** Full-bleed landing hero: the NGSIM replay as a night (or dusk) street, with one action and a live HUD. */
export default function HeroWorld() {
  const ix = useApi<IntersectionT>(IX);
  const cf = useApi<FlareConflict[]>(`${IX}/conflicts`);
  const theme = useThemeName();
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const hud = { t: useRef<HTMLElement>(null), veh: useRef<HTMLElement>(null), conf: useRef<HTMLElement>(null), crit: useRef<HTMLElement>(null) };
  const world = useRef<World | null>(null);
  const saved = useRef<WorldState | null>(null);
  const [still] = useState(reducedMotion);
  const [playing, setPlaying] = useState(!still);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const [gl] = useState(() => webglAvailable());
  const [failed, setFailed] = useState(false);

  const quality = useMemo(() => (ix.data ? trackQuality(ix.data.tracks, ix.data.hz) : null), [ix.data]);
  const ready = !!(ix.data && cf.data && quality);
  useEffect(() => {
    if (!ready || !gl || !host.current || !labels.current) return;
    let w: World;
    try {
      w = createWorld({
        host: host.current, labels: labels.current, data: ix.data!, conflicts: cf.data!, theme, still, quality,
        state: saved.current,
        hud: { t: hud.t.current, veh: hud.veh.current, conf: hud.conf.current, crit: hud.crit.current },
      });
    } catch {
      setFailed(true);
      return;
    }
    world.current = w;
    w.setPlaying(saved.current ? playingRef.current : !still);
    let inView = true;
    const sync = () => w.setActive(inView && !document.hidden);
    const io = new IntersectionObserver(([e]) => { inView = e.isIntersecting; sync(); }, { threshold: 0.01 });
    if (section.current) io.observe(section.current);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      saved.current = w.state();
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
      w.dispose();
      world.current = null;
    };
    // hud refs are stable; recreate only when data, theme or WebGL availability change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, gl, theme, still]);

  const toggle = () => { const p = !playing; setPlaying(p); world.current?.setPlaying(p); };
  const broken = !gl || failed || ix.error || cf.error;
  const nTracks = ix.data?.tracks.length;
  const real = cf.data?.filter((c) => !c.overlap && !conflictIsGhostPair(quality, c.a, c.b, c.t));
  const nCrit = real?.filter((c) => c.severity === 'critical').length;
  const nConf = real?.length;
  const nGhost = quality?.byId.size;

  return (
    <section ref={section} className="wd" aria-labelledby="hero-h" data-state={broken ? 'broken' : ready ? 'ready' : 'loading'}>
      <div ref={host} className="wd-stage" role="img"
        aria-label={`Replay of ${nTracks ?? ''} real vehicle trajectories at Peachtree St and 10th St, Atlanta, with headlights, tail lights, signal heads and traffic conflicts flaring where they occurred. Drag sideways to turn the view.`}>
        <div ref={labels} className="wd-labels" aria-hidden="true" />
      </div>
      {!ready && !broken && <p className="wd-note" aria-busy="true">Loading 90 s of trajectories…</p>}
      {broken && <p className="wd-note">{!gl || failed ? 'This browser cannot draw the 3D replay.' : 'Trajectory replay unavailable.'} <Link to={IX}>Open intersection lab</Link></p>}

      <div className="wd-top">
        <h1 id="hero-h" className="wd-h">Conflux</h1>
      </div>

      <div className="wd-bottom">
        <div className="wd-act">
          <Link to={IX} className="btn wd-btn">Open intersection lab <Icon name="arrow" size={16} /></Link>
          <Link to="/screening" className="wd-link">Network screening</Link>
        </div>
        <div className="wd-hud" aria-label="Replay readout">
          <span className="wd-place">Peachtree St &amp; 10th St, Atlanta</span>
          <dl className="wd-read">
            <div><dt>t</dt><dd ref={hud.t as React.RefObject<HTMLElement>}>00:00.0</dd></div>
            <div><dt>vehicles</dt><dd ref={hud.veh as React.RefObject<HTMLElement>}>0</dd></div>
            <div><dt>conflicts</dt><dd ref={hud.conf as React.RefObject<HTMLElement>}>0</dd></div>
            <div data-k="crit"><dt>critical</dt><dd ref={hud.crit as React.RefObject<HTMLElement>}>0</dd></div>
          </dl>
          <div className="wd-ctl">
            <button type="button" className="wd-play" onClick={toggle} disabled={!ready || !!broken}
              aria-label={playing ? 'Pause replay' : 'Play replay'} title={playing ? 'Pause replay' : 'Play replay'}>
              <Icon name={playing ? 'pause' : 'play'} size={16} />
            </button>
            <Info label="About this scene" title="What you are watching" align="right">
              <p>{nTracks ?? 'All'} vehicle trajectories, 90 s of NGSIM at Peachtree St &amp; 10th St, Atlanta (FHWA, 10 Hz), replayed in real time. Atlanta data stands in for roadside LiDAR until Lubbock sensor data exists.</p>
              <ul className="wd-legend">
                <li><i data-k="head" />Headlights</li>
                <li><i data-k="tail" />Tail lights; brighter when braking (&gt; 2 ft/s²)</li>
                <li><i data-k="conf" />SSAM conflict where and when it occurred, with its TTC or PET{nConf != null ? ` (${nConf} in 90 s)` : ''}</li>
                <li><i data-k="crit" />Critical conflict{nCrit != null ? ` (${nCrit})` : ''}; position-overlap flags and events between a duplicate track and its host excluded as data error</li>
              </ul>
              <p><b>Signals are inferred from flow, not observed</b> (NGSIM has no controller log): green while through vehicles discharge across the derived stop bar, red while a queue stands at it; 3.5 s yellow and 1 s all-red assumed.</p>
              <p>Corridor lanes, the cross street (axis, width and lanes fitted to the EB/WB tracks), markings and corridor stop bars are derived from the trajectories; vehicle bodies are shaped by class and length, wheels roll with the travelled distance. Crosswalks, cross-street stop bars, buildings, street lights and streets beyond the study area are stylised. Vehicles appear and vanish at its edges.</p>
              <p><b>{nGhost ?? ''} tracks are duplicate or ID-switched detections</b> (a known NGSIM defect, Coifman &amp; Li 2017): they fade out while they overlap the vehicle they duplicate, so no car is drawn through another. Nothing is removed from the data; the lab lists them.</p>
              <p>Source: <a href="https://doi.org/10.21949/1504477" target="_blank" rel="noreferrer">NGSIM Vehicle Trajectories, USDOT ITS DataHub</a>, CC BY-SA 3.0. Smoothed with Savitzky–Golay (15 frames).</p>
            </Info>
          </div>
        </div>
      </div>
    </section>
  );
}
