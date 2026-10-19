import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { NODES, bez, layoutEdges, lut, pathD, type EdgeGeo, type Flow, type Live, type NodeState, type Rect } from './model';

/**
 * The living architecture diagram. Nodes are HTML laid out by CSS grid, so every label wraps inside its
 * box at the spec's real pixel sizes; the edges are an SVG drawn underneath from the measured node boxes
 * and re-measured on resize and font load. One requestAnimationFrame loop moves "comets" along each running
 * edge at a rate set by real volume. When a node is down (replay of a real failure or the labelled
 * simulation) comets queue in front of it; when it recovers the queue drains at an accelerated rate.
 * The loop stops when the tab is hidden or the diagram is off screen and never starts under reduced motion.
 */

const POOL = 9, TAIL = 4;
const MARK_FLOWS: Flow[] = ['ingest', 'curated', 'api', 'metrics', 'ai', 'plan'];
const LIVE = NODES.filter((n) => n.lane === 'live' && !n.band), PILOT = NODES.filter((n) => n.lane === 'pilot');
const ROWS = { r0: 1, r1: 2, r2: 3, p0: 1, p1: 2 } as const;

interface Comet { s: number; on: boolean; q: boolean; fast: boolean }
interface RT { id: string; from: string; to: string; pts: Float32Array; len: number; n: number; comets: Comet[]; acc: number; burst: number; els: SVGGElement[] }
interface Geo { w: number; h: number; rects: Record<string, Rect>; edges: EdgeGeo[] }
export interface Override { state: NodeState; chip: string }

export default function FlowDiagram({ live, down, overrides, badges, selected, onSelect, motion }: {
  live: Live; down: string | null; overrides?: Record<string, Override>; badges?: Record<string, string>;
  selected: string | null; onSelect: (id: string) => void; motion: boolean;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const liveRef = useRef(live); liveRef.current = live;
  const downRef = useRef(down); downRef.current = down;
  const [geo, setGeo] = useState<Geo | null>(null);

  // Measure node boxes (offset*, so pulse transforms never disturb the geometry) and derive the edges.
  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rects: Record<string, Rect> = {};
        c.querySelectorAll<HTMLElement>('[data-node]').forEach((el) => {
          let x = 0, y = 0, n: HTMLElement | null = el;
          while (n && n !== c) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent as HTMLElement | null; }
          rects[el.dataset.node!] = { x, y, w: el.offsetWidth, h: el.offsetHeight };
        });
        const grid = c.querySelector<HTMLElement>('.ar-grid');
        const gap = grid ? parseFloat(getComputedStyle(grid).columnGap) || 40 : 40;
        const w = c.offsetWidth, h = c.offsetHeight;
        setGeo((g) => {
          const same = g && g.w === w && g.h === h && Object.entries(rects).every(([k, r]) => {
            const o = g.rects[k]; return o && o.x === r.x && o.y === r.y && o.w === r.w && o.h === r.h;
          });
          return same ? g : { w, h, rects, edges: layoutEdges(rects, gap) };
        });
      });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    c.querySelectorAll('[data-node]').forEach((el) => ro.observe(el));
    document.fonts?.ready.then(measure).catch(() => {});
    measure();
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  const edges = geo?.edges ?? [];
  const liveEdges = useMemo(() => edges.filter((e) => e.status === 'live'), [edges]);
  const luts = useMemo(() => Object.fromEntries(liveEdges.map((e) => [e.id, lut(e.p)])), [liveEdges]);

  // Hide an edge label wherever it would sit on a node: the same figures are listed in each node's panel.
  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c || !geo) return;
    const boxes = Object.values(geo.rects);
    c.querySelectorAll<SVGGElement>('[data-elabel]').forEach((g) => {
      g.removeAttribute('data-clash');
      const b = g.getBBox(), t = g.transform.baseVal.consolidate()?.matrix;
      const x = b.x + (t?.e ?? 0), y = b.y + (t?.f ?? 0), pad = 3;
      const clash = boxes.some((r) => x < r.x + r.w + pad && x + b.width > r.x - pad && y < r.y + r.h + pad && y + b.height > r.y - pad)
        || x < 0 || x + b.width > geo.w;
      if (clash) g.setAttribute('data-clash', '');
    });
  }, [geo, live]);

  useEffect(() => {
    const svg = svgRef.current, canvas = canvasRef.current;
    if (!svg || !canvas || !motion || !liveEdges.length) return;
    const rts: RT[] = liveEdges.map((e) => {
      const L = luts[e.id];
      return { id: e.id, from: e.from, to: e.to, pts: L.pts, len: L.len, n: L.pts.length / 2 - 1,
        comets: Array.from({ length: POOL }, () => ({ s: 0, on: false, q: false, fast: false })), acc: Math.random(), burst: 0,
        els: Array.from(svg.querySelectorAll<SVGGElement>(`[data-comets="${e.id}"] > g`)) };
    });
    const nodeEls = new Map<string, HTMLElement>();
    canvas.querySelectorAll<HTMLElement>('[data-node]').forEach((el) => nodeEls.set(el.dataset.node!, el));
    const lastPulse = new Map<string, number>();
    const queued = new Map<string, number>();
    let prevDown: string | null = null;

    const at = (rt: RT, s: number): [number, number] => {
      const f = Math.max(0, Math.min(1, s / rt.len)) * rt.n, i = Math.min(rt.n - 1, Math.floor(f)), k = f - i, p = rt.pts;
      return [p[i * 2] + (p[i * 2 + 2] - p[i * 2]) * k, p[i * 2 + 1] + (p[i * 2 + 3] - p[i * 2 + 1]) * k];
    };
    const pulse = (id: string, now: number) => {
      if (now - (lastPulse.get(id) ?? 0) < 420) return;
      lastPulse.set(id, now);
      nodeEls.get(id)?.querySelector('.ar-ring')?.animate([{ opacity: 0.6 }, { opacity: 0 }], { duration: 760, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    };

    let raf = 0, last = 0, running = false, visible = true;
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
      const L = liveRef.current, dn = downRef.current;
      if (dn !== prevDown) {
        if (prevDown && !dn) {
          // Recovery: release every queued comet fast and replay what queued as a burst downstream.
          const n = queued.get(prevDown) ?? 0;
          for (const rt of rts) {
            if (rt.to === prevDown) rt.comets.forEach((c) => { if (c.on) { c.q = false; c.fast = true; } });
            if (rt.from === prevDown) rt.burst += Math.min(12, n);
          }
        }
        if (dn) queued.set(dn, 0);
        prevDown = dn;
      }
      for (const rt of rts) {
        const ed = L.edges[rt.id];
        const blocked = dn === rt.to, starved = dn === rt.from;
        const rate = ed?.rate ?? 0, speed = ed?.speed ?? 60;
        if (!starved && rate > 0) {
          rt.acc += dt * (rt.burst > 0 ? Math.max(4, rate * 3) : rate);
          while (rt.acc >= 1) {
            rt.acc -= 1;
            if (rt.burst > 0) rt.burst -= 1;
            if (blocked) queued.set(rt.to, (queued.get(rt.to) ?? 0) + 1);
            const c = rt.comets.find((x) => !x.on);
            if (c) { c.on = true; c.s = 0; c.q = false; c.fast = rt.burst > 0; }
          }
        }
        for (let i = 0; i < POOL; i++) {
          const c = rt.comets[i], el = rt.els[i];
          if (!el) continue;
          if (!c.on) { el.setAttribute('opacity', '0'); continue; }
          if (!c.q) c.s += speed * dt * (c.fast ? 2.6 : 1);
          if (blocked && !c.q) {
            const slot = rt.comets.reduce((a, x) => a + (x.on && x.q ? 1 : 0), 0);
            const stopAt = rt.len - 8 - slot * 7;
            if (c.s >= stopAt) { c.s = Math.max(0, stopAt); c.q = true; }
          }
          if (c.s >= rt.len) { c.on = false; c.fast = false; el.setAttribute('opacity', '0'); pulse(rt.to, now); continue; }
          el.setAttribute('opacity', '1');
          const kids = el.children;
          for (let k = 0; k < TAIL; k++) {
            const [x, y] = at(rt, c.s - k * (c.q ? 0 : 5.5));
            const dot = kids[k] as SVGCircleElement;
            dot.setAttribute('cx', x.toFixed(1)); dot.setAttribute('cy', y.toFixed(1));
            if (c.q) dot.setAttribute('opacity', k ? '0' : '0.9');
            else dot.removeAttribute('opacity');
          }
        }
      }
      raf = requestAnimationFrame(frame);
    };
    const start = () => { if (!running && visible && !document.hidden) { running = true; last = 0; raf = requestAnimationFrame(frame); } };
    const stop = () => { running = false; cancelAnimationFrame(raf); };
    const onVis = () => (document.hidden ? stop() : start());
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; svg.toggleAttribute('data-offscreen', !visible); if (visible) start(); else stop(); });
    io.observe(canvas);
    document.addEventListener('visibilitychange', onVis);
    start();
    return () => { stop(); io.disconnect(); document.removeEventListener('visibilitychange', onVis); rts.forEach((r) => r.els.forEach((el) => el.setAttribute('opacity', '0'))); };
  }, [motion, liveEdges, luts]);

  const isLinked = (id: string) => !selected || selected === id || edges.some((e) => (e.from === selected && e.to === id) || (e.to === selected && e.from === id));

  const node = (id: string) => {
    const n = NODES.find((x) => x.id === id)!;
    const st = live.nodes[id], ov = overrides?.[id];
    const state: NodeState = down === id ? 'down' : ov?.state ?? st?.state ?? 'idle';
    const chip = ov?.chip ?? st?.chip ?? '';
    const sub = st?.sub ?? n.service;
    const label = `${n.title}, ${n.service}. ${state === 'planned' ? 'Planned' : chip}. Open details.`;
    const common = {
      'data-node': id, 'data-state': state, 'data-flow': n.flow, 'data-sel': selected === id || undefined,
      'aria-pressed': selected === id, 'aria-label': label, onClick: () => onSelect(id), type: 'button' as const,
    };
    if (n.band) {
      return (
        <button key={id} className="ar-n ar-band" {...common}>
          <span className="ar-ring" aria-hidden="true" />
          <Icon name={n.icon} size={20} weight="duotone" />
          <b className="ar-n-t">{n.title}</b>
          <span className="ar-n-c measure"><i />{chip}</span>
          {badges?.[id] && <span className="ar-badge measure">{badges[id]}</span>}
        </button>
      );
    }
    return (
      <button key={id} className="ar-n" {...common} data-lane={n.lane} data-dim={!isLinked(id) || undefined}
        style={{ gridColumn: (n.col ?? 0) + 1, gridRow: ROWS[n.row ?? 'r0'] }}>
        <span className="ar-ring" aria-hidden="true" />
        <span className="ar-n-h"><span className="ar-n-ico"><Icon name={n.icon} size={20} weight="duotone" /></span></span><b className="ar-n-t">{n.title.replace(' · ', '\u00a0· ')}</b>
        {state !== 'planned' && <><span className="ar-n-s">{sub}</span><span className="ar-n-c measure"><i />{chip}</span></>}
        {badges?.[id] && <span className="ar-badge measure">{badges[id]}</span>}
      </button>
    );
  };

  return (
    <div className="ar-canvas" ref={canvasRef} role="group" aria-labelledby="ar-t" data-motion={motion || undefined}>
      <p id="ar-t" className="sr-only">Sightpole architecture: running system and planned roadside-LiDAR pilot. Each component is a button that opens its details.</p>
      <svg ref={svgRef} className="ar-svg" width={geo?.w ?? 0} height={geo?.h ?? 0} viewBox={`0 0 ${geo?.w ?? 1} ${geo?.h ?? 1}`} aria-hidden="true">
        <defs>
          {/* taste-skill-ignore: owner-requested flow gradient — each running edge fades in from its source to show direction. */}
          {edges.filter((e) => e.status !== 'planned').map((e) => (
            <linearGradient key={e.id} id={`ar-g-${e.id}`} gradientUnits="userSpaceOnUse" x1={e.p[0]} y1={e.p[1]} x2={e.p[6]} y2={e.p[7]}>
              <stop offset="0" style={{ stopColor: `var(--fl-${e.flow})`, stopOpacity: 0.18 }} />
              <stop offset="1" style={{ stopColor: `var(--fl-${e.flow})`, stopOpacity: 0.95 }} />
            </linearGradient>
          ))}
          {MARK_FLOWS.map((f) => (
            <marker key={f} id={`ar-m-${f}`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M1 1.5 L9 5 L1 8.5 Q2.6 5 1 1.5z" style={{ fill: `var(--fl-${f})` }} />
            </marker>
          ))}
        </defs>
        {edges.map((e) => {
          const ed = live.edges[e.id];
          const d = pathD(e.p);
          const hot = selected && (e.from === selected || e.to === selected);
          const dur = ed?.rate ? 18 / Math.max(12, (ed.speed ?? 60) * 0.5) : 3.2;
          return (
            <g key={e.id} className="ar-edge" data-flow={e.flow} data-status={e.status} data-hot={hot || undefined} data-dim={(selected && !hot) || undefined} data-stalled={(down && e.from === down) || undefined}>
              <path d={d} className="ar-base" style={e.status === 'planned' ? undefined : { stroke: `url(#ar-g-${e.id})` }} markerEnd={`url(#ar-m-${e.flow})`} />
              {e.status === 'live' && <path d={d} className="ar-stream" style={{ stroke: `var(--fl-${e.flow})`, animationDuration: `${dur.toFixed(2)}s` }} />}
            </g>
          );
        })}
        {motion && liveEdges.map((e) => (
          <g key={e.id} data-comets={e.id} style={{ fill: `var(--fl-${e.flow})` }}>
            {Array.from({ length: POOL }, (_, i) => (
              <g key={i} opacity={0}>
                {Array.from({ length: TAIL }, (_, k) => <circle key={k} r={[4, 3.1, 2.3, 1.6][k]} style={{ opacity: [1, 0.5, 0.28, 0.14][k] }} />)}
              </g>
            ))}
          </g>
        ))}
      </svg>

      <div className="ar-lanehead"><span className="ar-lane">Deployed</span><span className="ar-lane-note">us-east-2</span></div>
      {node('iam')}
      <div className="ar-grid" data-lane="live">{LIVE.map((n) => node(n.id))}</div>
      {node('cw')}
      <div className="ar-pilot">
        <div className="ar-lanehead" title="Planned roadside-LiDAR pedestrian warning; not deployed"><span className="ar-lane">Pilot</span><span className="ar-lane-note">Planned</span></div>
        <div className="ar-grid" data-lane="pilot">{PILOT.map((n) => node(n.id))}</div>
      </div>

      {/* Edge labels sit above the nodes; any label that would cover a node is hidden (see the node panel). */}
      <svg className="ar-svg ar-labels" width={geo?.w ?? 0} height={geo?.h ?? 0} viewBox={`0 0 ${geo?.w ?? 1} ${geo?.h ?? 1}`} aria-hidden="true">
        {edges.map((e) => {
          const lab = live.edges[e.id]?.label;
          if (!lab) return null;
          const [v, t] = lab.split('|');
          const [mx, my] = bez(e.p, 0.5);
          const dim = selected && !(e.from === selected || e.to === selected);
          return (
            <g key={e.id} data-elabel={e.id} transform={`translate(${mx.toFixed(1)} ${my.toFixed(1)})`} data-dim={dim || undefined} className="ar-elabel">
              <text className="ar-etext" textAnchor="middle" y={v ? -18 : -8}>
                {v && <tspan className="ar-ev" x={0}>{v}</tspan>}
                <tspan x={0} dy={v ? 15 : 0}>{t}</tspan>
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
