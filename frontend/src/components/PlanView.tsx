import { useEffect, useRef, useState } from 'react';
import { CHART, conflictColor } from '../lib/format';
import Reticle from './Reticle';
import { activeAt, fitCanvas, poseAt, useClock, useClockFrame, useSelection, type ConflictT, type IntersectionT, type TrackT } from '../lib/traj';

interface Props {
  data: IntersectionT;
  conflicts: ConflictT[];
  occlusion?: Map<string, [number, number][]>;
  label: string;
}

/**
 * Top-down plan of the intersection: lane bands, vehicles as oriented footprints, 3 s trails, live conflicts.
 * Reads and writes the page selection; wheel zooms about the pointer, drag pans.
 */
export default function PlanView({ data, conflicts, occlusion, label }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const clock = useClock();
  const sel = useSelection();
  const selected = sel?.selected ?? new Set<string>();
  const hovered = sel?.hovered ?? null;
  const view = useRef({ s: 1, ox: 0, oy: 0, vertical: false });
  const user = useRef({ k: 1, tx: 0, ty: 0 });
  const [zoomed, setZoomed] = useState(false);
  const [[x0, y0], [x1, y1]] = data.bbox as [[number, number], [number, number]];
  const byId = useRef(new Map<string, TrackT>());
  if (byId.current.size !== data.tracks.length) byId.current = new Map(data.tracks.map((t) => [String(t.id), t]));

  // road users that share a conflict with a selected one (drawn in amber)
  const partners = new Set<string>();
  for (const k of conflicts) {
    const a = String(k.a), b = String(k.b);
    if (selected.has(a) && !selected.has(b)) partners.add(b);
    if (selected.has(b) && !selected.has(a)) partners.add(a);
  }

  const draw = (t: number) => {
    const c = ref.current;
    if (!c) return;
    const ctx = fitCanvas(c);
    const W = c.clientWidth, H = c.clientHeight;
    // Corridor (+y) runs left→right on wide canvases and bottom→top on tall (phone) canvases.
    const vertical = H > W * 1.1;
    const s0 = vertical ? Math.min(W / (x1 - x0 + 8), H / (y1 - y0 + 8)) : Math.min(W / (y1 - y0 + 8), H / (x1 - x0 + 8));
    const ox0 = vertical ? (W - (x1 - x0) * s0) / 2 - x0 * s0 : (W - (y1 - y0) * s0) / 2 - y0 * s0;
    const oy0 = vertical ? (H - (y1 - y0) * s0) / 2 + y1 * s0 : (H - (x1 - x0) * s0) / 2 + x1 * s0;
    const { k: uk, tx, ty } = user.current;
    const s = s0 * uk, ox = ox0 * uk + tx, oy = oy0 * uk + ty;
    view.current = { s, ox, oy, vertical };
    const DIR: Record<string, string> = { NB: CHART.nb, SB: CHART.sb, EB: CHART.eb, WB: CHART.wb };
    const P = (x: number, y: number): [number, number] => (vertical ? [ox + x * s, oy - y * s] : [ox + y * s, oy - x * s]);
    const rot = (h: number) => (vertical ? -h : Math.atan2(-Math.cos(h), Math.sin(h)));

    ctx.clearRect(0, 0, W, H);
    // metre graticule every 10 m
    ctx.strokeStyle = CHART.graticule; ctx.lineWidth = 1;
    ctx.beginPath();
    const seg = (a: [number, number], b: [number, number]) => { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); };
    for (let g = Math.ceil(y0 / 10) * 10; g <= y1; g += 10) seg(P(x0 - 4, g), P(x1 + 4, g));
    for (let g = Math.ceil(x0 / 10) * 10; g <= x1; g += 10) seg(P(g, y0 - 4), P(g, y1 + 4));
    ctx.stroke();

    // lane bands (10th–90th percentile of observed lateral position)
    for (const l of data.lanes_geom) {
      if (!l.p10 || !l.p90) continue;
      ctx.beginPath();
      l.p10.forEach(([x, y], i) => { const [a, b] = P(x, y); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
      [...l.p90].reverse().forEach(([x, y]) => { const [a, b] = P(x, y); ctx.lineTo(a, b); });
      ctx.closePath();
      ctx.globalAlpha = 0.18; ctx.fillStyle = CHART.graticule; ctx.fill(); ctx.globalAlpha = 1;
      ctx.setLineDash([6, 6]); ctx.strokeStyle = CHART.rule;
      ctx.beginPath();
      l.centre.forEach(([x, y], i) => { const [a, b] = P(x, y); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
      ctx.stroke(); ctx.setLineDash([]);
    }
    // stop-bar reference at intersection centre
    ctx.strokeStyle = CHART.axis; ctx.lineWidth = 1.25;
    const [cx, cy] = P(0, 0);
    ctx.beginPath(); ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6); ctx.stroke();

    const active = activeAt(conflicts, t);
    const hot = new Set(active.flatMap((k) => [String(k.a), String(k.b)]));
    const poses = new Map<string, NonNullable<ReturnType<typeof poseAt>>>();
    const labels: [number, number, string][] = [];

    // selected and hovered road users are drawn last so they sit on top
    const order = [...data.tracks].sort((a, b) => rank(String(a.id)) - rank(String(b.id)));
    function rank(id: string) { return selected.has(id) ? 2 : id === hovered || partners.has(id) ? 1 : 0; }

    for (const tr of order) {
      const id = String(tr.id);
      const p = poseAt(tr, t, data.hz);
      if (!p) continue;
      poses.set(id, p);
      const isSel = selected.has(id), isHov = hovered === id, isPartner = partners.has(id);
      const gaps = occlusion?.get(id);
      const hidden = gaps?.some(([g0, g1]) => t >= g0 && t <= g1);
      // trail: last 3 s
      ctx.beginPath();
      const i1 = Math.round((t - tr.pts[0][0]) * data.hz), i0 = Math.max(0, i1 - 30);
      for (let i = i0; i <= i1 && i < tr.pts.length; i++) { const [a, b] = P(tr.pts[i][1], tr.pts[i][2]); i === i0 ? ctx.moveTo(a, b) : ctx.lineTo(a, b); }
      ctx.strokeStyle = isSel ? CHART.accent : isPartner ? CHART.caution : CHART.ink2;
      ctx.globalAlpha = isSel || isPartner ? 1 : 0.22; ctx.lineWidth = isSel ? 3 : isPartner ? 2 : 1; ctx.stroke(); ctx.globalAlpha = 1;
      // footprint
      const [a, b] = P(p.x, p.y);
      ctx.save(); ctx.translate(a, b); ctx.rotate(rot(p.h));
      const L = Math.max(tr.len_m * s, 4), Wd = Math.max(tr.w_m * s, 3);
      ctx.globalAlpha = hidden ? 0.25 : 1;
      ctx.fillStyle = isSel ? CHART.accent : hot.has(id) || isPartner ? CHART.caution : DIR[tr.dir ?? 'NB'] ?? CHART.ink2;
      ctx.fillRect(-L / 2, -Wd / 2, L, Wd);
      if (hidden) { ctx.strokeStyle = CHART.ink; ctx.setLineDash([2, 2]); ctx.strokeRect(-L / 2, -Wd / 2, L, Wd); ctx.setLineDash([]); }
      if (isSel || isHov) {
        ctx.globalAlpha = 1; ctx.strokeStyle = isSel ? CHART.ink : CHART.accent; ctx.lineWidth = 2;
        ctx.strokeRect(-L / 2 - 3, -Wd / 2 - 3, L + 6, Wd + 6);
      }
      ctx.restore(); ctx.globalAlpha = 1;
      if (isSel || isHov) labels.push([a, b, `#${id} · ${(p.v * 2.236936).toFixed(1)} mph`]);
    }
    // conflict pairs active now: dashed link between the two road users, ring at their midpoint
    for (const k of active) {
      const ka = String(k.a), kb = String(k.b);
      const pa = poses.get(ka), pb = poses.get(kb);
      if (!pa || !pb) continue;
      const emph = selected.has(ka) || selected.has(kb);
      const [ax, ay] = P(pa.x, pa.y), [bx, by] = P(pb.x, pb.y);
      ctx.setLineDash([4, 4]); ctx.strokeStyle = conflictColor(k.severity); ctx.lineWidth = emph ? 2 : 1.25;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
      const A = byId.current.get(ka), B = byId.current.get(kb);
      const qa = A && poseAt(A, Math.min(t, k.t), data.hz), qb = B && poseAt(B, Math.min(t, k.t), data.hz);
      if (!qa || !qb) continue;
      const [mx, my] = P((qa.x + qb.x) / 2, (qa.y + qb.y) / 2);
      const age = Math.max(0, t - k.t);
      ctx.beginPath(); ctx.arc(mx, my, 10 + age * 14, 0, Math.PI * 2);
      ctx.globalAlpha = Math.max(0, 0.9 - age); ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;
    }
    // labels on top of everything, on a ground-coloured plate
    ctx.font = '500 13px Switzer, system-ui, sans-serif';
    const placed: [number, number, number][] = [];
    for (const [a, b, txt] of labels) {
      const w = ctx.measureText(txt).width;
      const lx = Math.min(a + 10, W - w - 8);
      let ly = Math.max(18, b - 12);
      // stack labels that would overlap one already drawn
      while (placed.some(([px, py, pw]) => lx < px + pw + 8 && px < lx + w + 8 && Math.abs(py - ly) < 20)) ly -= 20;
      placed.push([lx, ly, w]);
      ctx.globalAlpha = 0.85; ctx.fillStyle = CHART.ground; ctx.fillRect(lx - 4, ly - 13, w + 8, 18); ctx.globalAlpha = 1;
      ctx.fillStyle = CHART.ink; ctx.fillText(txt, lx, ly);
    }
    // scale bar
    ctx.fillStyle = CHART.axis; ctx.fillRect(12, H - 18, 9.144 * s, 2);
    ctx.font = '13px Switzer, system-ui, sans-serif'; ctx.fillText('30 ft', 12, H - 25);
  };

  useClockFrame(draw, [data, conflicts, sel?.selected, hovered, occlusion]);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const redraw = () => drawRef.current(clock.now());
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(redraw);
    ro.observe(el);
    // wheel zoom about the pointer (non-passive so the page does not scroll under the map)
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const u = user.current, k = Math.min(12, Math.max(1, u.k * Math.exp(-e.deltaY * 0.0015)));
      u.tx = mx - (mx - u.tx) * (k / u.k); u.ty = my - (my - u.ty) * (k / u.k); u.k = k;
      if (k === 1) { u.tx = 0; u.ty = 0; }
      setZoomed(k !== 1 || u.tx !== 0 || u.ty !== 0);
      redraw();
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => { ro.disconnect(); el.removeEventListener('wheel', wheel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Canvas pixel → data metres, using the transform of the last frame drawn. */
  const toData = (cx: number, cy: number) => {
    const { s, ox, oy, vertical } = view.current;
    return vertical ? { x: (cx - ox) / s, y: (oy - cy) / s } : { x: (oy - cy) / s, y: (cx - ox) / s };
  };
  /** Nearest road user within 4 m (or 10 px when zoomed out) of a canvas point at the current clock time. */
  const hit = (cx: number, cy: number) => {
    const { x, y } = toData(cx, cy);
    const t = clock.now();
    let best: TrackT | null = null, bd = Math.max(4, 10 / view.current.s);
    for (const tr of data.tracks) {
      const p = poseAt(tr, t, data.hz);
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = tr; }
    }
    return best;
  };

  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const local = (e: React.PointerEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current, el = e.currentTarget;
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true; d.x = e.clientX; d.y = e.clientY;
      user.current.tx += dx; user.current.ty += dy;
      el.dataset.pan = '';
      setZoomed(true); redraw();
      return;
    }
    if (e.pointerType !== 'mouse') return;
    const best = hit(...local(e));
    if (best) el.dataset.hit = ''; else delete el.dataset.hit;
    const id = best ? String(best.id) : null;
    if (sel && id !== sel.hovered) sel.hover(id);
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    delete e.currentTarget.dataset.pan;
    if (!d || d.moved || !sel) return;
    const best = hit(...local(e));
    if (best) sel.select([best.id], { add: e.shiftKey || e.metaKey });
    else if (!e.shiftKey) sel.select(null);
  };
  const reset = () => { user.current = { k: 1, tx: 0, ty: 0 }; setZoomed(false); redraw(); };
  const read = (fx: number, fy: number) => {
    const c = ref.current;
    if (!c) return null;
    const { x, y } = toData(fx * c.clientWidth, fy * c.clientHeight);
    if (x < x0 - 4 || x > x1 + 4 || y < y0 - 4 || y > y1 + 4) return null;
    return `${Math.round(x * 3.281)}, ${Math.round(y * 3.281)} ft`;
  };

  return (
    <>
      <canvas
        ref={ref} className="plan-canvas" role="img" aria-label={label}
        onPointerDown={down} onPointerMove={move} onPointerUp={up}
        onPointerCancel={() => { drag.current = null; }}
        onPointerLeave={() => { if (!drag.current && sel?.hovered) sel.hover(null); }}
      />
      <Reticle read={read} />
      <div className="plan-tools">
        {zoomed && <button className="btn ghost" onClick={reset}>Reset view</button>}
        <span className="muted">Scroll to zoom · drag to pan</span>
      </div>
    </>
  );
}
