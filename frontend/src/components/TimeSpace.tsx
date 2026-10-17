import '../styles/timespace.css';
import { useEffect, useRef } from 'react';
import Reticle from './Reticle';
import { CHART, conflictColor } from '../lib/format';
import { fitCanvas, poseAt, selectConflict, useClock, useClockFrame, useSelection, type ConflictT, type IntersectionT } from '../lib/traj';

interface Props {
  data: IntersectionT;
  conflicts: ConflictT[];
  dir?: 'NB' | 'SB';
  label: string;
  /** fired when a conflict diamond is clicked; without it, a click selects the pair (when a selection store exists) */
  onConflict?: (c: ConflictT) => void;
  compact?: boolean;
  /** draw lines progressively up to the clock time (Atlas intro) */
  reveal?: boolean;
}

const PAD = { l: 52, r: 12, t: 14, b: 28 };

/**
 * Time–space diagram along the corridor axis (+y). Each line is one vehicle; slope is speed,
 * horizontal runs are queues at the signal; amber and red ticks are surrogate-safety conflicts.
 */
export default function TimeSpace({ data, conflicts, dir, label, compact, reveal, onConflict }: Props) {
  const base = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const clock = useClock();
  const sel = useSelection();
  const hovered = sel?.hovered ?? null;
  const T = data.window_s;
  const [[, y0], [, y1]] = data.bbox as [[number, number], [number, number]];
  const tracks = data.tracks.filter((tr) => (dir ? tr.dir === dir : tr.dir === 'NB' || tr.dir === 'SB'));

  const geom = (c: HTMLCanvasElement) => {
    const W = c.clientWidth, H = c.clientHeight;
    const pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b;
    return { W, H, X: (t: number) => PAD.l + (t / T) * pw, Y: (y: number) => PAD.t + ph - ((y - y0) / (y1 - y0)) * ph, pw, ph };
  };

  const drawBase = (upTo = T) => {
    const c = base.current;
    if (!c) return;
    const ctx = fitCanvas(c);
    const { W, H, X, Y } = geom(c);
    ctx.clearRect(0, 0, W, H);
    ctx.font = '13px Switzer, system-ui, sans-serif';
    ctx.fillStyle = CHART.axis; ctx.strokeStyle = CHART.graticule; ctx.lineWidth = 1;
    for (let s = 0; s <= T; s += 10) {
      ctx.beginPath(); ctx.moveTo(X(s), PAD.t); ctx.lineTo(X(s), H - PAD.b); ctx.stroke();
      if (!compact || s % 30 === 0) ctx.fillText(`${s} s`, X(s) - 9, H - 8);
    }
    const fTop = Math.floor((y1 * 3.281) / 100) * 100;
    for (let f = Math.ceil((y0 * 3.281) / 100) * 100; f <= y1 * 3.281; f += 100) {
      const m = f / 3.281;
      ctx.beginPath(); ctx.moveTo(PAD.l, Y(m)); ctx.lineTo(W - PAD.r, Y(m)); ctx.stroke();
      ctx.fillText(f === fTop ? `${f} ft` : `${f}`, 4, Y(m) + 4);
    }
    // stop line (intersection centre, y = 0)
    ctx.strokeStyle = CHART.axis; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(PAD.l, Y(0)); ctx.lineTo(W - PAD.r, Y(0)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = CHART.ink2; ctx.fillText('stop line', W - PAD.r - 56, Y(0) - 5);

    const emph = (id: string) => (sel?.selected.has(id) ? 2 : id === hovered ? 1 : 0);
    const order = sel ? [...tracks].sort((a, b) => emph(String(a.id)) - emph(String(b.id))) : tracks;
    for (const tr of order) {
      const e = emph(String(tr.id));
      ctx.beginPath();
      let started = false;
      for (const p of tr.pts) {
        if (p[0] > upTo) break;
        if (p[2] < y0 || p[2] > y1) { started = false; continue; }
        started ? ctx.lineTo(X(p[0]), Y(p[2])) : ctx.moveTo(X(p[0]), Y(p[2]));
        started = true;
      }
      if (e) { ctx.strokeStyle = CHART.ground; ctx.lineWidth = 6; ctx.stroke(); } // halo so the pick reads over the bundle
      ctx.strokeStyle = e === 2 ? CHART.accent : e === 1 ? CHART.ink : tr.dir === 'SB' ? CHART.sb : CHART.nb;
      ctx.globalAlpha = e ? 1 : sel?.selected.size ? 0.3 : 0.7;
      ctx.lineWidth = e === 2 ? 2.6 : e === 1 ? 2 : 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const { k, p } of diamonds()) {
      if (k.t > upTo) continue;
      ctx.fillStyle = conflictColor(k.severity);
      ctx.beginPath(); ctx.moveTo(X(k.t), Y(p.y) - 6); ctx.lineTo(X(k.t) + 5, Y(p.y)); ctx.lineTo(X(k.t), Y(p.y) + 6); ctx.lineTo(X(k.t) - 5, Y(p.y)); ctx.closePath(); ctx.fill();
    }
  };

  /** Conflict markers: at the time of the event, on the first road user's line. */
  function diamonds() {
    const out: { k: ConflictT; p: NonNullable<ReturnType<typeof poseAt>> }[] = [];
    for (const k of conflicts) {
      const A = tracks.find((r) => String(r.id) === String(k.a));
      const p = A && poseAt(A, k.t, data.hz);
      if (p) out.push({ k, p });
    }
    return out;
  }

  useEffect(() => {
    if (!reveal) drawBase();
    const ro = new ResizeObserver(() => drawBase(reveal ? clock.now() : T));
    if (base.current) ro.observe(base.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, conflicts, sel?.selected, hovered, dir, reveal]);

  useClockFrame((t) => {
    if (reveal) drawBase(t);
    const c = over.current;
    if (!c) return;
    const ctx = fitCanvas(c);
    const { W, H, X } = geom(c);
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = CHART.accent; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(t), PAD.t); ctx.lineTo(X(t), H - PAD.b); ctx.stroke();
    ctx.fillStyle = CHART.ink; ctx.font = '500 13px Switzer, system-ui, sans-serif';
    ctx.fillText(`t = ${t.toFixed(1)} s`, Math.min(X(t) + 6, W - 72), PAD.t + 13);
    c.setAttribute('aria-valuenow', String(Math.round(t * 10) / 10));
    c.setAttribute('aria-valuetext', `${t.toFixed(1)} seconds`);
  }, [data, reveal]);

  /** Hit test in CSS pixels: a conflict diamond within 8 px, else the nearest vehicle line within 6 px. */
  const hitAt = (c: HTMLCanvasElement, px: number, py: number) => {
    const { X, Y, pw } = geom(c);
    let kBest: ConflictT | null = null, kd = 8;
    for (const { k, p } of diamonds()) {
      const d = Math.hypot(X(k.t) - px, Y(p.y) - py);
      if (d < kd) { kd = d; kBest = k; }
    }
    if (kBest) return { conflict: kBest, id: null };
    const tc = ((px - PAD.l) / pw) * T;
    const span = Math.ceil(6 / Math.max(0.05, (pw / T) / data.hz)) + 1;
    let id: string | null = null, bd = 6;
    for (const tr of tracks) {
      const pts = tr.pts, i = Math.round((tc - pts[0][0]) * data.hz);
      for (let j = Math.max(1, i - span); j <= Math.min(pts.length - 1, i + span); j++) {
        const a = pts[j - 1], b = pts[j];
        if (a[2] < y0 || a[2] > y1 || b[2] < y0 || b[2] > y1) continue;
        const d = segDist(px, py, X(a[0]), Y(a[2]), X(b[0]), Y(b[2]));
        if (d < bd) { bd = d; id = String(tr.id); }
      }
    }
    return { conflict: null, id };
  };

  const press = useRef<{ x: number; y: number } | null>(null);
  const tAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return ((e.clientX - r.left - PAD.l) / (r.width - PAD.l - PAD.r)) * T;
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    press.current = { x: e.clientX, y: e.clientY };
    clock.setT(tAt(e));
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.buttons === 1) { clock.setT(tAt(e)); return; }
    if (e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    const h = hitAt(e.currentTarget, e.clientX - r.left, e.clientY - r.top);
    const on = !!h.conflict || (!!sel && !!h.id);
    if (on) e.currentTarget.dataset.hit = ''; else delete e.currentTarget.dataset.hit;
    if (sel && h.id !== sel.hovered) sel.hover(h.id);
  };
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = press.current;
    press.current = null;
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) return;
    const r = e.currentTarget.getBoundingClientRect();
    const h = hitAt(e.currentTarget, e.clientX - r.left, e.clientY - r.top);
    if (h.conflict) { if (onConflict) onConflict(h.conflict); else if (sel) selectConflict(sel, h.conflict); return; }
    if (sel && h.id) sel.select([h.id], { add: e.shiftKey || e.metaKey });
  };

  /** Pointer readout in chart units; null outside the plotted area. */
  const read = (fx: number, fy: number) => {
    const c = base.current;
    if (!c) return null;
    const { W, H, pw, ph } = geom(c);
    const px = fx * W, py = fy * H;
    if (px < PAD.l || px > W - PAD.r || py < PAD.t || py > H - PAD.b) return null;
    const t = ((px - PAD.l) / pw) * T, y = y0 + ((PAD.t + ph - py) / ph) * (y1 - y0);
    return `t = ${t.toFixed(1)} s · ${Math.round(y * 3.281)} ft`;
  };

  return (
    <div className={`timespace ${compact ? 'compact' : ''}`}>
      <canvas ref={base} className="ts-base" aria-hidden="true" />
      <canvas
        ref={over}
        className="ts-over"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={T}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => { if (sel?.hovered) sel.hover(null); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); clock.setT(clock.now() + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 1 : 0.1)); }
          if (e.key === ' ') { e.preventDefault(); clock.toggle(); }
        }}
      />
      <Reticle read={read} />
    </div>
  );
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const u = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - ax - u * dx, py - ay - u * dy);
}
