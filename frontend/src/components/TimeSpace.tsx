import { useEffect, useRef } from 'react';
import { fitCanvas, poseAt, useClock, useClockFrame, type ConflictT, type IntersectionT } from '../lib/traj';

interface Props {
  data: IntersectionT;
  conflicts: ConflictT[];
  dir?: 'NB' | 'SB';
  selected?: string | null;
  label: string;
  compact?: boolean;
  /** draw lines progressively up to the clock time (Atlas intro) */
  reveal?: boolean;
}

const PAD = { l: 44, r: 12, t: 12, b: 26 };

/**
 * Time–space diagram along the corridor axis (+y). Each line is one vehicle; slope is speed,
 * horizontal runs are queues at the signal; amber ticks are surrogate-safety conflicts.
 */
export default function TimeSpace({ data, conflicts, dir, selected, label, compact, reveal }: Props) {
  const base = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const clock = useClock();
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
    ctx.font = '10.5px "Overpass Mono", monospace';
    ctx.fillStyle = '#5a636b'; ctx.strokeStyle = '#e1e4de'; ctx.lineWidth = 1;
    for (let s = 0; s <= T; s += 10) {
      ctx.beginPath(); ctx.moveTo(X(s), PAD.t); ctx.lineTo(X(s), H - PAD.b); ctx.stroke();
      if (!compact || s % 30 === 0) ctx.fillText(`${s}s`, X(s) - 8, H - 8);
    }
    for (let f = Math.ceil((y0 * 3.281) / 100) * 100; f <= y1 * 3.281; f += 100) {
      const m = f / 3.281;
      ctx.beginPath(); ctx.moveTo(PAD.l, Y(m)); ctx.lineTo(W - PAD.r, Y(m)); ctx.stroke();
      ctx.fillText(`${f}`, 6, Y(m) + 3);
    }
    // stop line (intersection centre, y = 0)
    ctx.strokeStyle = '#14171a'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(PAD.l, Y(0)); ctx.lineTo(W - PAD.r, Y(0)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#14171a'; ctx.fillText('stop line', W - PAD.r - 58, Y(0) - 4);

    for (const tr of tracks) {
      const sel = selected === String(tr.id);
      ctx.beginPath();
      let started = false;
      for (const p of tr.pts) {
        if (p[0] > upTo) break;
        if (p[2] < y0 || p[2] > y1) { started = false; continue; }
        started ? ctx.lineTo(X(p[0]), Y(p[2])) : ctx.moveTo(X(p[0]), Y(p[2]));
        started = true;
      }
      ctx.strokeStyle = sel ? '#c98a00' : tr.dir === 'SB' ? 'rgba(70,97,122,0.75)' : 'rgba(20,23,26,0.8)';
      ctx.lineWidth = sel ? 2.4 : 1;
      ctx.stroke();
    }
    for (const k of conflicts) {
      if (k.t > upTo) continue;
      const A = tracks.find((r) => String(r.id) === String(k.a));
      const p = A && poseAt(A, k.t, data.hz);
      if (!p) continue;
      ctx.fillStyle = k.severity === 'critical' ? '#b3261e' : '#c98a00';
      ctx.beginPath(); ctx.moveTo(X(k.t), Y(p.y) - 6); ctx.lineTo(X(k.t) + 5, Y(p.y)); ctx.lineTo(X(k.t), Y(p.y) + 6); ctx.lineTo(X(k.t) - 5, Y(p.y)); ctx.closePath(); ctx.fill();
    }
  };

  useEffect(() => {
    if (!reveal) drawBase();
    const ro = new ResizeObserver(() => drawBase(reveal ? clock.now() : T));
    if (base.current) ro.observe(base.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, conflicts, selected, dir, reveal]);

  useClockFrame((t) => {
    if (reveal) drawBase(t);
    const c = over.current;
    if (!c) return;
    const ctx = fitCanvas(c);
    const { W, H, X } = geom(c);
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#c98a00'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(t), PAD.t); ctx.lineTo(X(t), H - PAD.b); ctx.stroke();
    ctx.fillStyle = '#14171a'; ctx.font = '600 11px "Overpass Mono", monospace';
    ctx.fillText(`t = ${t.toFixed(1)} s`, Math.min(X(t) + 6, W - 70), PAD.t + 12);
    c.setAttribute('aria-valuenow', String(Math.round(t * 10) / 10));
    c.setAttribute('aria-valuetext', `${t.toFixed(1)} seconds`);
  }, [data, reveal]);

  const scrub = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.type === 'pointermove' && e.buttons !== 1) return;
    const r = e.currentTarget.getBoundingClientRect();
    const pw = r.width - PAD.l - PAD.r;
    clock.setT(((e.clientX - r.left - PAD.l) / pw) * T);
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
        onPointerDown={scrub}
        onPointerMove={scrub}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') clock.setT(clock.now() + (e.shiftKey ? 5 : 0.5));
          if (e.key === 'ArrowLeft') clock.setT(clock.now() - (e.shiftKey ? 5 : 0.5));
          if (e.key === ' ') { e.preventDefault(); clock.toggle(); }
        }}
      />
      <span className="ts-ylabel">distance along corridor (ft)</span>
    </div>
  );
}
