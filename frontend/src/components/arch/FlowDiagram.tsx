import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { Icon } from '../Icon';
import { EDGES, NODES, NODE, NH, NW, ROW, VB_H, VB_W, bez, lut, pathD, type Flow, type Live } from './model';

/**
 * The living architecture diagram. Geometry and state come from ./model; this file draws it and runs
 * one requestAnimationFrame loop that moves "comets" along each running edge at a rate set by real volume.
 * When a node is down (a replay of a real failure or the labelled simulation), comets queue in front of it;
 * when it recovers the queue drains at an accelerated rate. The loop stops when the tab is hidden or the
 * diagram is off screen, and never starts under prefers-reduced-motion.
 */

const POOL = 9, TAIL = 4;
const LIVE_EDGES = EDGES.filter((e) => e.status === 'live');
const MARK_FLOWS: Flow[] = ['ingest', 'curated', 'api', 'metrics', 'ai', 'plan'];

interface Comet { s: number; on: boolean; q: boolean; fast: boolean }
interface RT { id: string; from: string; to: string; pts: Float32Array; len: number; n: number; comets: Comet[]; acc: number; burst: number; els: SVGGElement[] }

export default function FlowDiagram({ live, down, downLabel = 'Down · queueing', selected, onSelect, motion, onBacklog }: {
  live: Live; down: string | null; downLabel?: string; selected: string | null; onSelect: (id: string) => void; motion: boolean;
  onBacklog?: (n: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const liveRef = useRef(live); liveRef.current = live;
  const downRef = useRef(down); downRef.current = down;
  const backlogCb = useRef(onBacklog); backlogCb.current = onBacklog;
  const luts = useMemo(() => Object.fromEntries(LIVE_EDGES.map((e) => [e.id, lut(e.p)])), []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !motion) return;
    const rts: RT[] = LIVE_EDGES.map((e) => {
      const L = luts[e.id];
      return { id: e.id, from: e.from, to: e.to, pts: L.pts, len: L.len, n: L.pts.length / 2 - 1,
        comets: Array.from({ length: POOL }, () => ({ s: 0, on: false, q: false, fast: false })), acc: Math.random(), burst: 0,
        els: Array.from(svg.querySelectorAll<SVGGElement>(`[data-comets="${e.id}"] > g`)) };
    });
    const nodeEls = new Map<string, SVGGElement>();
    svg.querySelectorAll<SVGGElement>('[data-node]').forEach((el) => nodeEls.set(el.dataset.node!, el));
    const badge = new Map<string, SVGTextElement>();
    svg.querySelectorAll<SVGTextElement>('[data-badge]').forEach((el) => badge.set(el.dataset.badge!, el));
    const lastPulse = new Map<string, number>();
    const backlog = new Map<string, number>();
    let prevDown: string | null = null, shownBacklog = -1;

    const at = (rt: RT, s: number): [number, number] => {
      const f = Math.max(0, Math.min(1, s / rt.len)) * rt.n, i = Math.min(rt.n - 1, Math.floor(f)), k = f - i, p = rt.pts;
      return [p[i * 2] + (p[i * 2 + 2] - p[i * 2]) * k, p[i * 2 + 1] + (p[i * 2 + 3] - p[i * 2 + 1]) * k];
    };
    const pulse = (id: string, now: number) => {
      if (now - (lastPulse.get(id) ?? 0) < 420) return;
      lastPulse.set(id, now);
      const el = nodeEls.get(id);
      const band = el?.classList.contains('ar-band');
      el?.querySelector('.ar-ring')?.animate(band ? [{ opacity: 0.5 }, { opacity: 0 }] : [{ opacity: 0.55, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.06, 1.14)' }], { duration: 760, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
      if (!band) el?.querySelector('.ar-body')?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.015)' }, { transform: 'scale(1)' }], { duration: 360, easing: 'ease-out' });
    };

    let raf = 0, last = 0, running = false, visible = true;
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
      const L = liveRef.current, dn = downRef.current;
      if (dn !== prevDown) {
        if (prevDown && !dn) {
          // Recovery: release every queued comet fast and replay the backlog downstream as a burst.
          const n = backlog.get(prevDown) ?? 0;
          for (const rt of rts) {
            if (rt.to === prevDown) rt.comets.forEach((c) => { if (c.on) { c.q = false; c.fast = true; } });
            if (rt.from === prevDown) rt.burst += n;
          }
        }
        if (dn) backlog.set(dn, 0);
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
            if (blocked) backlog.set(rt.to, (backlog.get(rt.to) ?? 0) + 1);
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
      // Backlog: queued while down, draining as the downstream burst plays out after recovery.
      let total = 0;
      for (const id of new Set([...backlog.keys()])) {
        const n = id === dn ? backlog.get(id) ?? 0 : rts.filter((r) => r.from === id).reduce((a, r) => Math.max(a, r.burst), 0);
        if (id !== dn) backlog.set(id, n);
        total += n;
        const b = badge.get(id);
        if (b) { b.textContent = n > 0 ? (id === dn ? `${n} queued` : `draining ${n}`) : ''; }
      }
      if (total !== shownBacklog) { shownBacklog = total; backlogCb.current?.(total); }
      raf = requestAnimationFrame(frame);
    };
    const start = () => { if (!running && visible && !document.hidden) { running = true; last = 0; raf = requestAnimationFrame(frame); } };
    const stop = () => { running = false; cancelAnimationFrame(raf); };
    const onVis = () => (document.hidden ? stop() : start());
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; svg.toggleAttribute('data-offscreen', !visible); visible ? start() : stop(); });
    io.observe(svg);
    document.addEventListener('visibilitychange', onVis);
    start();
    return () => { stop(); io.disconnect(); document.removeEventListener('visibilitychange', onVis); rts.forEach((r) => r.els.forEach((el) => el.setAttribute('opacity', '0'))); };
  }, [motion, luts]);

  const key = (id: string) => (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id); } };

  return (
    <svg ref={svgRef} className="ar-svg" viewBox={`-4 0 ${VB_W + 8} ${VB_H}`} role="group" aria-labelledby="ar-t" data-motion={motion || undefined}>
      <title id="ar-t">RoadScope architecture: running system and planned roadside-LiDAR pilot</title>
      <defs>
        {/* taste-skill-ignore: owner-requested flow gradient — each running edge fades in from its source to show direction. */}
        {EDGES.filter((e) => e.status !== 'planned').map((e) => (
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

      {/* Lanes */}
      <text x={0} y={22} className="ar-lane">Running now</text>
      <text x={VB_W} y={22} className="ar-lane-note" textAnchor="end">AWS us-east-2 · account-level budget alarm</text>
      <rect x={-2} y={ROW.pilotHead - 24} width={VB_W + 4} height={VB_H - ROW.pilotHead + 22} rx={18} className="ar-pilot-bg" />
      <text x={18} y={ROW.pilotHead + 6} className="ar-lane">Pilot design</text>
      <text x={VB_W - 18} y={ROW.pilotHead + 6} className="ar-lane-note" textAnchor="end">Planned · roadside-LiDAR pedestrian warning · nothing below runs yet</text>

      {/* Edges */}
      {EDGES.map((e) => {
        const ed = live.edges[e.id];
        const d = pathD(e.p);
        const hot = selected && (e.from === selected || e.to === selected);
        const stalled = down && (e.from === down);
        const dur = ed?.rate ? 18 / Math.max(12, (ed.speed ?? 60) * 0.5) : 3.2;
        const [mx, my] = bez(e.p, 0.5);
        return (
          <g key={e.id} className="ar-edge" data-flow={e.flow} data-status={e.status} data-hot={hot || undefined} data-dim={(selected && !hot) || undefined} data-stalled={stalled || undefined}>
            <path d={d} className="ar-base" style={e.status === 'planned' ? undefined : { stroke: `url(#ar-g-${e.id})` }} markerEnd={`url(#ar-m-${e.flow})`} />
            {e.status === 'live' && <path d={d} className="ar-stream" style={{ stroke: `var(--fl-${e.flow})`, animationDuration: `${dur.toFixed(2)}s` }} />}
            {ed?.label && (
              <g className="ar-elabel" transform={`translate(${mx} ${my})`}>
                <text className="ar-etext" textAnchor="middle" y={-20}>
                  {ed.label.split('|')[0] && <tspan className="ar-ev" x={0}>{ed.label.split('|')[0]}</tspan>}
                  <tspan x={0} dy={ed.label.split('|')[0] ? 14 : 14}>{ed.label.split('|')[1]}</tspan>
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* Comets (pool per running edge; positions written by the rAF loop) */}
      {motion && LIVE_EDGES.map((e) => (
        <g key={e.id} data-comets={e.id} style={{ fill: `var(--fl-${e.flow})` }} aria-hidden="true">
          {Array.from({ length: POOL }, (_, i) => (
            <g key={i} opacity={0}>
              {Array.from({ length: TAIL }, (_, k) => <circle key={k} r={[4, 3.1, 2.3, 1.6][k]} style={{ opacity: [1, 0.5, 0.28, 0.14][k] }} />)}
            </g>
          ))}
        </g>
      ))}

      {/* Nodes */}
      {NODES.map((n) => {
        const st = live.nodes[n.id];
        const w = n.w ?? NW, h = n.h ?? NH;
        const isDown = down === n.id || st?.state === 'down';
        const state = isDown ? 'down' : st?.state ?? 'idle';
        const label = `${n.title}, ${n.service}. ${state === 'planned' ? 'Planned' : st?.chip ?? ''}. Open details.`;
        if (n.band) {
          return (
            <g key={n.id} data-node={n.id} className="ar-node ar-band" data-state={state} data-flow={n.flow} data-sel={selected === n.id || undefined}
              role="button" tabIndex={0} aria-label={label} aria-pressed={selected === n.id} onClick={() => onSelect(n.id)} onKeyDown={key(n.id)}>
              <g className="ar-body">
                <rect x={n.x} y={n.y} width={w} height={h} rx={h / 2} className="ar-box" />
                <rect x={n.x} y={n.y} width={w} height={h} rx={h / 2} className="ar-ring" />
                <g transform={`translate(${n.x + 18} ${n.y + h / 2 - 10})`} className="ar-ico"><Icon name={n.icon} size={20} weight="duotone" /></g>
                <text x={n.x + 48} y={n.y + h / 2 + 6} className="ar-btitle">{n.title}</text>
                <text x={n.x + 48 + (n.id === 'cw' ? 118 : 50)} y={n.y + h / 2 + 5} className="ar-bchip">{st?.chip}</text>
                <text x={n.x + w - 22} y={n.y + h / 2 + 5} className="ar-bspec" textAnchor="end">{n.id === 'cw' ? 'metrics + JSON logs from every compute stage' : 'one role per component'}</text>
              </g>
            </g>
          );
        }
        const nd = NODE[n.id];
        return (
          <g key={n.id} data-node={n.id} className="ar-node" data-state={state} data-flow={n.flow} data-lane={n.lane} data-sel={selected === n.id || undefined}
            data-dim={(selected && selected !== n.id && !EDGES.some((e) => (e.from === selected && e.to === n.id) || (e.to === selected && e.from === n.id))) || undefined}
            role="button" tabIndex={0} aria-label={label} aria-pressed={selected === n.id} onClick={() => onSelect(n.id)} onKeyDown={key(n.id)}>
            <g className="ar-body" style={{ transformOrigin: `${n.x + w / 2}px ${n.y + h / 2}px` }}>
              <rect x={n.x} y={n.y} width={w} height={h} rx={14} className="ar-box" />
              <rect x={n.x} y={n.y} width={w} height={h} rx={14} className="ar-ring" style={{ transformOrigin: `${n.x + w / 2}px ${n.y + h / 2}px` }} />
              <rect x={n.x + 14} y={n.y + 14} width={30} height={30} rx={8} className="ar-icobg" />
              <g transform={`translate(${n.x + 19} ${n.y + 19})`} className="ar-ico"><Icon name={nd.icon} size={20} weight="duotone" /></g>
              <text x={n.x + 54} y={n.y + 28} className="ar-title">{n.title}</text>
              <text x={n.x + 54} y={n.y + 45} className="ar-sub">{st?.sub ?? n.service}</text>
              <circle cx={n.x + 20} cy={n.y + 74} r={4} className="ar-dot" />
              <text x={n.x + 31} y={n.y + 78.5} className="ar-chip">{down === n.id ? downLabel : st?.chip}</text>
              <text x={n.x + w - 10} y={n.y - 8} className="ar-badge" textAnchor="end" data-badge={n.id} />
            </g>
          </g>
        );
      })}
    </svg>
  );
}
