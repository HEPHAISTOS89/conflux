import { useEffect, useMemo, useRef, useState } from 'react';
import Reticle from './Reticle';
import { focusConflict } from '../lib/lab/hooks';
import { kinAt, renderPose, type RenderPose } from '../lib/lab/metrics';
import { labPalette, useThemeName, type LabPalette } from '../lib/lab/palette';
import { bandLines, bandPolygon, MUTCD, roadGeometry, type RoadGeom, type XY } from '../lib/lab/road';
import { ghostFade, trackQuality } from '../lib/lab/quality';
import { bodyLength, isPedestrian } from '../lib/lab/classes';
import { activeAt, fitCanvas, leadIn, useClock, useClockFrame, useSelection, type ConflictT, type IntersectionT, type TrackT } from '../lib/traj';
import { reducedMotion } from '../lib/motion';

interface Props {
  data: IntersectionT;
  conflicts: ConflictT[];
  occlusion?: Map<string, [number, number][]>;
  label: string;
}

const FT = 3.28084;
const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);

/**
 * Top-down plan of the intersection drawn from the data alone: carriageway, MUTCD lane lines and stop bars
 * derived from the observed lanes (lib/lab/road.ts), vehicles as oriented footprints with brake lamps,
 * 3 s trails and live conflict links. Reads and writes the page selection; wheel zooms about the pointer,
 * drag pans, and a picked conflict eases the view onto the pair.
 */
export default function PlanView({ data, conflicts, occlusion, label }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const clock = useClock();
  const sel = useSelection();
  const theme = useThemeName();
  const selected = sel?.selected ?? new Set<string>();
  const hovered = sel?.hovered ?? null;
  const view = useRef({ s: 1, ox: 0, oy: 0, vertical: false });
  const user = useRef<{ k: number; tx: number; ty: number } | null>(null);
  const touched = useRef(false);
  const anim = useRef<{ from: { k: number; tx: number; ty: number }; to: { k: number; tx: number; ty: number }; t0: number } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [[x0, y0], [x1, y1]] = data.bbox as [[number, number], [number, number]];
  const road = useMemo(() => roadGeometry(data), [data]);
  // duplicate / ID-switched tracks fade out while they overlap the vehicle they duplicate (lib/lab/quality.ts)
  const quality = useMemo(() => trackQuality(data.tracks, data.hz), [data]);
  const byId = useMemo(() => new Map(data.tracks.map((t) => [String(t.id), t])), [data]);
  const staticLayer = useRef<{ key: string; c: HTMLCanvasElement } | null>(null);
  const focus = focusConflict(sel, conflicts);

  // road users that share a conflict with a selected one (drawn in amber)
  const partners = new Set<string>();
  for (const k of conflicts) {
    const a = String(k.a), b = String(k.b);
    if (selected.has(a) && !selected.has(b)) partners.add(b);
    if (selected.has(b) && !selected.has(a)) partners.add(a);
  }

  /** Base transform: the whole study area fits; corridor (+y) left→right on wide canvases, bottom→top on tall ones. */
  const base = (W: number, H: number) => {
    const vertical = H > W * 1.1;
    const s0 = vertical ? Math.min(W / (x1 - x0 + 8), H / (y1 - y0 + 8)) : Math.min(W / (y1 - y0 + 8), H / (x1 - x0 + 8));
    const ox0 = vertical ? (W - (x1 - x0) * s0) / 2 - x0 * s0 : (W - (y1 - y0) * s0) / 2 - y0 * s0;
    const oy0 = vertical ? (H - (y1 - y0) * s0) / 2 + y1 * s0 : (H - (x1 - x0) * s0) / 2 + x1 * s0;
    return { vertical, s0, ox0, oy0 };
  };

  /**
   * Home view: the conflict zone (5th–95th percentile of conflict positions along the corridor, plus 60 ft each
   * side) fills the canvas, never zoomed out beyond the whole study area. The approaches stay a scroll away.
   */
  const home = (W: number, H: number) => {
    const { vertical, s0, ox0, oy0 } = base(W, H);
    const ys = conflicts.map((k) => { const A = byId.get(String(k.a)); const q = A && kinAt(A, k.t, data.hz); return q ? q.y : null; }).filter((v): v is number => v != null).sort((a, b) => a - b);
    const lo = ys.length ? ys[Math.floor(ys.length * 0.05)] - 18 : y0, hi = ys.length ? ys[Math.ceil(ys.length * 0.95) - 1] + 18 : y1;
    const along = Math.max(40, hi - lo), cy = (lo + hi) / 2, cx = (x0 + x1) / 2;
    const k = Math.min(2, Math.max(1, (vertical ? H : W) / (along * s0)));
    const px = vertical ? ox0 * k + cx * s0 * k : ox0 * k + cy * s0 * k, py = vertical ? oy0 * k - cy * s0 * k : oy0 * k - cx * s0 * k;
    return k === 1 ? { k: 1, tx: 0, ty: 0 } : { k, tx: W / 2 - px, ty: H / 2 - py };
  };

  const draw = (t: number) => {
    const c = ref.current;
    if (!c) return;
    if (!user.current) user.current = home(c.clientWidth, c.clientHeight);
    const a = anim.current;
    if (a) {
      const u = Math.min(1, (performance.now() - a.t0) / 520), e = easeOut(u);
      user.current = { k: a.from.k + (a.to.k - a.from.k) * e, tx: a.from.tx + (a.to.tx - a.from.tx) * e, ty: a.from.ty + (a.to.ty - a.from.ty) * e };
      if (u < 1) requestAnimationFrame(() => drawRef.current(clock.now())); else anim.current = null;
    }
    const ctx = fitCanvas(c);
    const W = c.clientWidth, H = c.clientHeight;
    const { vertical, s0, ox0, oy0 } = base(W, H);
    const { k: uk, tx, ty } = user.current!;
    const s = s0 * uk, ox = ox0 * uk + tx, oy = oy0 * uk + ty;
    view.current = { s, ox, oy, vertical };
    const pal = labPalette(theme);
    const P = (x: number, y: number): [number, number] => (vertical ? [ox + x * s, oy - y * s] : [ox + y * s, oy - x * s]);
    const rot = (h: number) => (vertical ? -h : Math.atan2(-Math.cos(h), Math.sin(h)));

    // static layer: ground, grid, carriageway and markings, cached until size, view or theme change
    if (c.width === 0 || c.height === 0) return; // not laid out yet (first frame of a deep link): nothing to draw into
    const dpr = c.width / Math.max(1, W);
    const key = [W, H, dpr, s.toFixed(4), ox.toFixed(1), oy.toFixed(1), theme].join('|');
    if (staticLayer.current?.key !== key) {
      const sc = staticLayer.current?.c ?? document.createElement('canvas');
      sc.width = c.width; sc.height = c.height;
      const sx = sc.getContext('2d')!;
      sx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRoad(sx, W, H, road, pal, P, s, data.bbox as [[number, number], [number, number]], vertical, data.crosswalks, data.box);
      staticLayer.current = { key, c: sc };
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(staticLayer.current.c, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const active = activeAt(conflicts, t);
    const hot = new Set(active.flatMap((k) => [String(k.a), String(k.b)]));
    const poses = new Map<string, RenderPose>();
    const labels: [number, number, string, boolean][] = [];
    const win: [number, number] = [0, data.window_s];

    // selected and hovered road users are drawn last so they sit on top
    const order = [...data.tracks].sort((a, b) => rank(String(a.id)) - rank(String(b.id)));
    function rank(id: string) { return selected.has(id) ? 2 : id === hovered || partners.has(id) ? 1 : 0; }

    // trails first (under every vehicle): last 3 s
    for (const tr of order) {
      const id = String(tr.id);
      const p = renderPose(tr, t, data.hz, win);
      if (!p) continue;
      p.fade *= ghostFade(quality, id, t);
      if (p.fade <= 0.01) continue;
      poses.set(id, p);
      const isSel = selected.has(id), isPartner = partners.has(id);
      const i1 = Math.min(tr.pts.length - 1, Math.floor((t - tr.pts[0][0]) * data.hz)), i0 = Math.max(0, i1 - 30);
      if (i1 <= i0) continue;
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) { const [a, b] = P(tr.pts[i][1], tr.pts[i][2]); i === i0 ? ctx.moveTo(a, b) : ctx.lineTo(a, b); }
      { const [a, b] = P(p.x, p.y); ctx.lineTo(a, b); }
      ctx.strokeStyle = isSel ? pal.sel : isPartner ? pal.partner : pal.trail;
      ctx.globalAlpha = (isSel || isPartner ? 0.95 : pal.dark ? 0.16 : 0.2) * p.fade;
      ctx.lineWidth = isSel ? 2.5 : isPartner ? 2 : 1;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const tr of order) {
      const id = String(tr.id);
      const p = poses.get(id);
      if (!p) continue;
      const isSel = selected.has(id), isHov = hovered === id, isPartner = partners.has(id);
      const hidden = occlusion?.get(id)?.some(([g0, g1]) => t >= g0 && t <= g1);
      const [a, b] = P(p.x, p.y);
      if (isPedestrian(tr)) {
        // pedestrian: a disc at the served (centre) point with a short tick along the walking direction
        const r = Math.max(tr.w_m * s * 0.5, 3.5);
        ctx.save(); ctx.translate(a, b); ctx.rotate(rot(p.h));
        ctx.globalAlpha = (hidden ? 0.3 : 1) * p.fade;
        ctx.fillStyle = isSel ? pal.sel : hot.has(id) ? pal.hot : isPartner ? pal.partner : pal.ped;
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
        if (p.v > 0.3) { ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(r, 0); ctx.lineTo(r + Math.max(3, r * 0.9), 0); ctx.stroke(); }
        if (isSel || isHov) { ctx.globalAlpha = 1; ctx.strokeStyle = isSel ? pal.ink : pal.accent; ctx.lineWidth = isSel ? 1.6 : 1.25; ctx.beginPath(); ctx.arc(0, 0, r + 3, 0, Math.PI * 2); ctx.stroke(); }
        ctx.restore(); ctx.globalAlpha = 1;
        if (isSel || isHov) labels.push([a, b, `#${id} · ${(p.v * 2.236936).toFixed(1)} mph`, isSel]);
        continue;
      }
      const L = Math.max(bodyLength(tr) * s, 6), Wd = Math.max(tr.w_m * s, 3.5);
      ctx.save(); ctx.translate(a, b); ctx.rotate(rot(p.h)); ctx.translate(-L / 2, 0); // the served point is the front bumper: body extends L behind it
      ctx.globalAlpha = (hidden ? 0.3 : 1) * p.fade;
      // footprint: x along the heading (front at +L/2 of the body centre)
      const body = isSel ? pal.sel : hot.has(id) ? pal.hot : isPartner ? pal.partner : tr.cls === 'truck' ? pal.truck : pal.car;
      roundRect(ctx, -L / 2, -Wd / 2, L, Wd, Math.min(Wd * 0.3, 3));
      ctx.fillStyle = body; ctx.fill();
      if (L > 12) {
        // windscreen: a darker band a third back from the front shows the heading at a glance
        ctx.fillStyle = pal.ground; ctx.globalAlpha *= 0.55;
        ctx.fillRect(L / 2 - L * 0.36, -Wd / 2 + Wd * 0.16, Math.max(1.2, L * 0.07), Wd * 0.68);
        ctx.globalAlpha = (hidden ? 0.3 : 1) * p.fade;
        // brake lamps: on while decelerating or held at a stop
        const lamp = Math.max(1.2, Wd * 0.18);
        ctx.fillStyle = p.brake > 0.05 ? pal.brake : pal.lampOff;
        ctx.globalAlpha *= p.brake > 0.05 ? 0.45 + 0.55 * p.brake : 0.8;
        ctx.fillRect(-L / 2, -Wd / 2 + 0.6, 1.6, lamp); ctx.fillRect(-L / 2, Wd / 2 - 0.6 - lamp, 1.6, lamp);
        ctx.globalAlpha = (hidden ? 0.3 : 1) * p.fade;
      }
      if (hidden) { ctx.strokeStyle = pal.ink; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.strokeRect(-L / 2, -Wd / 2, L, Wd); ctx.setLineDash([]); }
      if (isSel || isHov) {
        ctx.globalAlpha = 1; ctx.strokeStyle = isSel ? pal.ink : pal.accent; ctx.lineWidth = isSel ? 1.6 : 1.25;
        roundRect(ctx, -L / 2 - 3, -Wd / 2 - 3, L + 6, Wd + 6, 4); ctx.stroke();
      }
      ctx.restore(); ctx.globalAlpha = 1;
      if (isSel || isHov) labels.push([a, b, `#${id} · ${(p.v * 2.236936).toFixed(1)} mph`, isSel]);
    }
    // conflict pairs active now: dashed link between the two road users, ring at the conflict point
    for (const k of active) {
      const ka = String(k.a), kb = String(k.b);
      const pa = poses.get(ka), pb = poses.get(kb);
      if (!pa || !pb) continue;
      const emph = selected.has(ka) || selected.has(kb);
      const col = k.severity === 'critical' ? pal.critical : pal.caution;
      const [ax, ay] = P(pa.x, pa.y), [bx, by] = P(pb.x, pb.y);
      ctx.setLineDash([4, 4]); ctx.strokeStyle = col; ctx.lineWidth = emph ? 2 : 1.25;
      ctx.globalAlpha = Math.min(pa.fade, pb.fade);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
      const A = byId.get(ka), B = byId.get(kb);
      const qa = A && kinAt(A, Math.min(t, k.t), data.hz), qb = B && kinAt(B, Math.min(t, k.t), data.hz);
      if (!qa || !qb) { ctx.globalAlpha = 1; continue; }
      const [mx, my] = P((qa.x + qb.x) / 2, (qa.y + qb.y) / 2);
      const age = Math.max(0, t - k.t);
      ctx.beginPath(); ctx.arc(mx, my, 10 + age * 14, 0, Math.PI * 2);
      ctx.globalAlpha = Math.max(0, 0.9 - age); ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;
    }
    // labels on top of everything, on a ground-coloured plate
    ctx.font = '500 13px Switzer, system-ui, sans-serif';
    const placed: [number, number, number][] = [];
    for (const [a, b, txt, isSel] of labels) {
      const w = ctx.measureText(txt).width;
      const lx = Math.max(8, Math.min(a + 12, W - w - 12));
      let ly = Math.max(20, b - 14);
      while (placed.some(([px, py, pw]) => lx < px + pw + 8 && px < lx + w + 8 && Math.abs(py - ly) < 22)) ly -= 22;
      placed.push([lx, ly, w]);
      ctx.globalAlpha = 0.9; ctx.fillStyle = pal.labelBg;
      roundRect(ctx, lx - 6, ly - 14, w + 12, 20, 4); ctx.fill(); ctx.globalAlpha = 1;
      if (isSel) { ctx.strokeStyle = pal.sel; ctx.lineWidth = 1; roundRect(ctx, lx - 6, ly - 14, w + 12, 20, 4); ctx.stroke(); }
      ctx.fillStyle = pal.label; ctx.fillText(txt, lx, ly);
    }
  };

  useClockFrame(draw, [data, conflicts, sel?.selected, hovered, occlusion, theme, road]);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const redraw = () => drawRef.current(clock.now());

  // a picked conflict eases the view onto the pair: both footprints from the replay lead-in to the event end
  const lastFocus = useRef<number | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!focus || !c || lastFocus.current === focus.id) { if (!focus) lastFocus.current = null; return; }
    lastFocus.current = focus.id;
    const A = byId.get(String(focus.a)), B = byId.get(String(focus.b));
    const pts: [number, number][] = [];
    for (let t = leadIn(focus); t <= (focus.t1 ?? focus.t) + 0.6; t += 0.3) for (const tr of [A, B]) { const k = tr && kinAt(tr, t, data.hz); if (k) pts.push([k.x, k.y]); }
    if (!pts.length) return;
    const W = c.clientWidth, H = c.clientHeight, { vertical, s0, ox0, oy0 } = base(W, H);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const spanX = Math.max(...xs) - Math.min(...xs) + 16, spanY = Math.max(...ys) - Math.min(...ys) + 16;
    const fit = vertical ? Math.min(W / (spanX * s0), H / (spanY * s0)) : Math.min(W / (spanY * s0), H / (spanX * s0));
    const k = Math.min(3, Math.max(1, fit * 0.7));
    // place the pair centre at the canvas centre at zoom k
    const px = vertical ? ox0 * k + cx * s0 * k : ox0 * k + cy * s0 * k, py = vertical ? oy0 * k - cy * s0 * k : oy0 * k - cx * s0 * k;
    const to = k === 1 ? { k: 1, tx: 0, ty: 0 } : { k, tx: W / 2 - px, ty: H / 2 - py };
    const from = user.current ?? home(W, H);
    if (reducedMotion()) { user.current = to; anim.current = null; } else anim.current = { from: { ...from }, to, t0: performance.now() };
    touched.current = true;
    setZoomed(true);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.id, data]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // until the reader pans or zooms, a resize re-fits the home view
    const ro = new ResizeObserver(() => { if (!touched.current) user.current = null; redraw(); });
    ro.observe(el);
    // wheel zoom about the pointer (non-passive so the page does not scroll under the map)
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      anim.current = null;
      const r = el.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const u = user.current ?? home(r.width, r.height), k = Math.min(12, Math.max(1, u.k * Math.exp(-e.deltaY * 0.0015)));
      u.tx = mx - (mx - u.tx) * (k / u.k); u.ty = my - (my - u.ty) * (k / u.k); u.k = k;
      if (k === 1) { u.tx = 0; u.ty = 0; }
      user.current = u; touched.current = true;
      setZoomed(true);
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
      const p = renderPose(tr, t, data.hz);
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = tr; }
    }
    return best;
  };

  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // touch: two pointers pinch-zoom about their midpoint
  const touches = useRef(new Map<number, [number, number]>());
  const pinch = useRef<{ d: number } | null>(null);
  const local = (e: React.PointerEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    touches.current.set(e.pointerId, [e.clientX, e.clientY]);
    if (touches.current.size === 2) {
      const [a, b] = [...touches.current.values()];
      pinch.current = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
      drag.current = { x: e.clientX, y: e.clientY, moved: true };
      return;
    }
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current, el = e.currentTarget;
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch.current && touches.current.size === 2) {
      const [a, b] = [...touches.current.values()], r = el.getBoundingClientRect();
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]), mx = (a[0] + b[0]) / 2 - r.left, my = (a[1] + b[1]) / 2 - r.top;
      const u = user.current ?? home(r.width, r.height), k = Math.min(12, Math.max(1, u.k * (dist / Math.max(1, pinch.current.d))));
      u.tx = mx - (mx - u.tx) * (k / u.k); u.ty = my - (my - u.ty) * (k / u.k); u.k = k;
      user.current = u; pinch.current.d = dist; anim.current = null; touched.current = true;
      setZoomed(true); redraw();
      return;
    }
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true; d.x = e.clientX; d.y = e.clientY;
      anim.current = null;
      if (user.current) { user.current.tx += dx; user.current.ty += dy; }
      touched.current = true;
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
    touches.current.delete(e.pointerId);
    if (pinch.current) { if (touches.current.size < 2) { pinch.current = null; drag.current = null; } return; }
    const d = drag.current;
    drag.current = null;
    delete e.currentTarget.dataset.pan;
    if (!d || d.moved || !sel) return;
    const best = hit(...local(e));
    if (best) sel.select([best.id], { add: e.shiftKey || e.metaKey });
    else if (!e.shiftKey) sel.select(null);
  };
  const reset = () => {
    const c = ref.current;
    if (!c) return;
    const to = home(c.clientWidth, c.clientHeight);
    if (reducedMotion() || !user.current) user.current = to; else anim.current = { from: { ...user.current }, to, t0: performance.now() };
    touched.current = false; lastFocus.current = null;
    setZoomed(false); redraw();
  };
  const read = (fx: number, fy: number) => {
    const c = ref.current;
    if (!c) return null;
    const { x, y } = toData(fx * c.clientWidth, fy * c.clientHeight);
    if (x < x0 - 4 || x > x1 + 4 || y < y0 - 4 || y > y1 + 4) return null;
    return `x ${Math.round(x * FT)} ft · y ${Math.round(y * FT)} ft`;
  };

  return (
    <>
      <canvas
        ref={ref} className="plan-canvas" role="img" aria-label={label}
        onPointerDown={down} onPointerMove={move} onPointerUp={up}
        onPointerCancel={(e) => { drag.current = null; touches.current.delete(e.pointerId); pinch.current = null; }}
        onPointerLeave={() => { if (!drag.current && sel?.hovered) sel.hover(null); }}
      />
      <Reticle read={read} />
      <div className="plan-tools">
        {zoomed && <button className="btn ghost" onClick={reset}>Reset view</button>}
        <span className="muted plan-hint" />
      </div>
    </>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

/** Ground, 50 ft grid, carriageway, MUTCD markings, stop bars, north arrow and scale bar. */
function drawRoad(
  ctx: CanvasRenderingContext2D, W: number, H: number, road: RoadGeom, pal: LabPalette,
  P: (x: number, y: number) => [number, number], s: number, bbox: [[number, number], [number, number]], vertical: boolean,
  crosswalks?: { id: string; polygon: [number, number][] }[], box?: [[number, number], [number, number]],
) {
  const [[x0, y0], [x1, y1]] = bbox;
  ctx.fillStyle = pal.ground; ctx.fillRect(0, 0, W, H);
  const drawCrosswalks = () => {
    if (!crosswalks?.length) return;
    for (const cw of crosswalks) {
      ctx.beginPath();
      cw.polygon.forEach(([x, y], i) => { const [a, b] = P(x, y); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
      ctx.closePath();
      ctx.globalAlpha = pal.dark ? 0.14 : 0.2; ctx.fillStyle = pal.stop; ctx.fill();
      ctx.globalAlpha = 0.55; ctx.setLineDash([Math.max(2, 0.6 * s), Math.max(2, 0.6 * s)]); ctx.strokeStyle = pal.stop; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  };
  const siteSheet = !!(box && crosswalks?.length);
  if (siteSheet && box) {
    // site feed: the intersection box and crosswalks come from site.json; the legs are the box extended to the
    // edge of the observed area (stylised: no lane lines are claimed that the feed does not carry)
    const poly = (pts: [number, number][]) => { ctx.beginPath(); pts.forEach(([x, y], k) => { const [a, b] = P(x, y); k ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }); ctx.closePath(); };
    const [[bx0, by0], [bx1, by1]] = box;
    const gridFt = 50 / 3.281;
    ctx.strokeStyle = pal.grid; ctx.lineWidth = 1;
    for (let gx = Math.floor(x0 / gridFt) * gridFt; gx <= x1; gx += gridFt) { const [a] = P(gx, 0); ctx.beginPath(); ctx.moveTo(a, 0); ctx.lineTo(a, H); ctx.stroke(); }
    for (let gy = Math.floor(y0 / gridFt) * gridFt; gy <= y1; gy += gridFt) { const [, b] = P(0, gy); ctx.beginPath(); ctx.moveTo(0, b); ctx.lineTo(W, b); ctx.stroke(); }
    ctx.fillStyle = pal.asphalt;
    poly([[bx0, y0 - 50], [bx1, y0 - 50], [bx1, y1 + 50], [bx0, y1 + 50]]); ctx.fill();
    poly([[x0 - 50, by0], [x1 + 50, by0], [x1 + 50, by1], [x0 - 50, by1]]); ctx.fill();
    ctx.strokeStyle = pal.kerb; ctx.lineWidth = 1.5;
    for (const [xa, xb] of [[bx0, bx0], [bx1, bx1]] as [number, number][]) {
      for (const [ya, yb] of [[y0 - 50, by0], [by1, y1 + 50]] as [number, number][]) { const [a, b] = P(xa, ya), [c, d] = P(xb, yb); ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke(); }
    }
    for (const [ya, yb] of [[by0, by0], [by1, by1]] as [number, number][]) {
      for (const [xa, xb] of [[x0 - 50, bx0], [bx1, x1 + 50]] as [number, number][]) { const [a, b] = P(xa, ya), [c, d] = P(xb, yb); ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke(); }
    }
    ctx.setLineDash([3, 5]); ctx.strokeStyle = pal.edge; ctx.lineWidth = 1; poly([[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]]); ctx.stroke(); ctx.setLineDash([]);
    drawCrosswalks();
  }
  if (!siteSheet) {
    // 50 ft grid in the local frame, a heavier line every 250 ft
    const g = 50 / FT;
    const span = Math.max(W, H) / s + 60;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    for (const major of [false, true]) {
      ctx.strokeStyle = major ? pal.gridMajor : pal.grid; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = Math.floor((cy - span) / g); k <= Math.ceil((cy + span) / g); k++) {
        if ((k % 5 === 0) !== major) continue;
        const [a, b] = P(cx - span, k * g), [c, d] = P(cx + span, k * g); ctx.moveTo(a, b); ctx.lineTo(c, d);
      }
      for (let k = Math.floor((cx - span) / g); k <= Math.ceil((cx + span) / g); k++) {
        if ((k % 5 === 0) !== major) continue;
        const [a, b] = P(k * g, cy - span), [c, d] = P(k * g, cy + span); ctx.moveTo(a, b); ctx.lineTo(c, d);
      }
      ctx.stroke();
    }

    const poly = (pts: XY[]) => { ctx.beginPath(); pts.forEach(([x, y], i) => { const [a, b] = P(x, y); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }); ctx.closePath(); };
    const line = (pts: XY[]) => { ctx.beginPath(); pts.forEach(([x, y], i) => { const [a, b] = P(x, y); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }); };

    // cross street derived from the EB/WB tracks (road.crossBand): solid across the corridor, fading beyond the observed edges
    const band = road.crossBand;
    if (band && road.cross) {
      const { x0: cx0, x1: cx1 } = road.cross;
      const reach = 30;
      for (const [a, b] of [[cx0, cx0 - reach], [cx1, cx1 + reach]] as [number, number][]) {
        const [pa, pb] = [P(a, band.m * a + band.b), P(b, band.m * b + band.b)];
        const grad = ctx.createLinearGradient(pa[0], pa[1], pb[0], pb[1]);
        grad.addColorStop(0, pal.asphalt); grad.addColorStop(1, pal.ground);
        ctx.fillStyle = grad;
        poly(bandPolygon(band, a, b)); ctx.fill();
      }
      ctx.fillStyle = pal.asphalt; poly(bandPolygon(band, cx0, cx1)); ctx.fill();
      ctx.fillStyle = pal.asphalt; poly([[cx0, road.cross.y0], [cx1, road.cross.y0], [cx1, road.cross.y1], [cx0, road.cross.y1]]); ctx.fill();
    } else if (road.cross) {
      const { x0: cx0, x1: cx1, y0: cy0, y1: cy1 } = road.cross;
      const reach = 30;
      for (const [a, b] of [[cx0, cx0 - reach], [cx1, cx1 + reach]] as [number, number][]) {
        const [pa, pb] = [P(a, (cy0 + cy1) / 2), P(b, (cy0 + cy1) / 2)];
        const grad = ctx.createLinearGradient(pa[0], pa[1], pb[0], pb[1]);
        grad.addColorStop(0, pal.asphalt); grad.addColorStop(1, pal.ground);
        ctx.fillStyle = grad;
        poly([[a, cy0 + 1.5], [b, cy0 + 1.5], [b, cy1 - 1.5], [a, cy1 - 1.5]]); ctx.fill();
      }
      ctx.fillStyle = pal.asphalt; poly([[cx0, cy0], [cx1, cy0], [cx1, cy1], [cx0, cy1]]); ctx.fill();
    }
    ctx.fillStyle = pal.asphalt;
    for (const a of road.arms) { poly(a); ctx.fill(); }
    ctx.strokeStyle = pal.kerb; ctx.lineWidth = 1;
    for (const a of road.arms) { poly(a); ctx.stroke(); }

    // markings: scaled to true width, never thinner than a hairline
    const px = (m: number) => Math.max(1, m * s);
    ctx.lineCap = 'butt';
    const crossMarks = band && road.cross ? [...bandLines(band, road.cross.x0 - 22, road.cross.x0 - 0.6), ...bandLines(band, road.cross.x1 + 0.6, road.cross.x1 + 22)] : [];
    for (const l of [...road.lines, ...crossMarks]) {
      if (l.kind === 'lane') {
        ctx.strokeStyle = pal.lane; ctx.lineWidth = px(MUTCD.line); ctx.setLineDash([MUTCD.dash * s, MUTCD.gap * s]);
        line(l.pts); ctx.stroke(); ctx.setLineDash([]);
      } else if (l.kind === 'edge') {
        ctx.strokeStyle = pal.edge; ctx.lineWidth = px(MUTCD.line); line(l.pts); ctx.stroke();
      } else {
        // double yellow: two lines 4 in apart
        ctx.strokeStyle = pal.centre; ctx.lineWidth = px(MUTCD.line);
        const d = (MUTCD.line + MUTCD.yellowGap) / 2;
        const [ax, ay] = l.pts[0], [bx, by] = l.pts[l.pts.length - 1], len = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / len, ny = (bx - ax) / len;
        line(l.pts.map(([x, y]) => [x - nx * d, y - ny * d] as XY)); ctx.stroke();
        line(l.pts.map(([x, y]) => [x + nx * d, y + ny * d] as XY)); ctx.stroke();
      }
    }
    ctx.strokeStyle = pal.stop; ctx.lineWidth = px(MUTCD.bar);
    for (const b of road.stops) { line([b.a, b.b]); ctx.stroke(); }
  drawCrosswalks();
  }
  // north arrow (corridor north, +y) and 50 ft scale bar
  ctx.save();
  const nx = W - 26, ny = H - 30;
  ctx.translate(nx, ny); ctx.rotate(vertical ? 0 : Math.PI / 2);
  ctx.fillStyle = pal.ink2; ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(5, 5); ctx.lineTo(0, 2); ctx.lineTo(-5, 5); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.font = '600 12px Switzer, system-ui, sans-serif'; ctx.fillStyle = pal.ink2;
  ctx.fillText('N', vertical ? nx - 4 : nx - 26, vertical ? ny - 16 : ny + 4);
  const bar = (50 / FT) * s;
  ctx.fillStyle = pal.ink3; ctx.fillRect(12, H - 18, bar, 2); ctx.fillRect(12, H - 22, 1, 6); ctx.fillRect(12 + bar - 1, H - 22, 1, 6);
  ctx.font = '13px Switzer, system-ui, sans-serif'; ctx.fillText('50 ft', 12, H - 27);
}
