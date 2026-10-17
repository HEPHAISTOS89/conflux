import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export type Pt = [number, number, number, number, number, number]; // t, x, y, v, a, lane
export interface TrackT { id: number | string; cls: string; len_m: number; w_m: number; dir?: string; move?: string; pts: Pt[] }
export interface LaneGeom { dir: string; lane: number; centre: [number, number][]; p10?: [number, number][]; p90?: [number, number][] }
export interface IntersectionT {
  id: string; name: string; hz: number; window_s: number; bbox: [[number, number], [number, number]] | number[];
  axes?: string; lanes_geom: LaneGeom[]; tracks: TrackT[]; source?: Record<string, unknown>;
}
export interface ConflictT { id: number; t: number; t0?: number; t1?: number; a: number | string; b: number | string; type: 'rear_end' | 'crossing' | 'lane_change'; ttc_min: number | null; pet: number | null; drac_max: number | null; severity: string }

export interface Pose { x: number; y: number; v: number; a: number; h: number; lane: number }

/** Pose of a track at time t (10 Hz uniform samples), with heading from the local velocity vector. */
export function poseAt(tr: TrackT, t: number, hz = 10): Pose | null {
  const p = tr.pts;
  if (!p.length || t < p[0][0] || t > p[p.length - 1][0]) return null;
  const f = (t - p[0][0]) * hz;
  const i = Math.min(p.length - 1, Math.floor(f));
  const j = Math.min(p.length - 1, i + 1);
  const u = f - i;
  const a = p[i], b = p[j];
  const lo = p[Math.max(0, i - 3)], hi = p[Math.min(p.length - 1, i + 3)];
  const dx = hi[1] - lo[1], dy = hi[2] - lo[2];
  const h = Math.hypot(dx, dy) > 0.15 ? Math.atan2(dy, dx) : (tr as any)._h ?? Math.PI / 2;
  (tr as any)._h = h;
  return { x: a[1] + (b[1] - a[1]) * u, y: a[2] + (b[2] - a[2]) * u, v: a[3] + (b[3] - a[3]) * u, a: a[4], h, lane: a[5] };
}

export const MPS_TO_MPH = 2.236936;

export const DIR_COLOR: Record<string, string> = { NB: '#14171a', SB: '#46617a', EB: '#7a5a2e', WB: '#5b6b4d' };

/** Shared playback clock for a page: every diagram reads and scrubs the same t. */
export interface Clock { t: number; playing: boolean; rate: number; duration: number; setT: (t: number) => void; toggle: () => void; play: () => void; pause: () => void; setRate: (r: number) => void; subscribe: (fn: (t: number) => void) => () => void; now: () => number }

export function useClockState(duration: number): Clock {
  const [t, setTState] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const tRef = useRef(0);
  const subs = useRef(new Set<(t: number) => void>());
  const emit = (v: number) => { tRef.current = v; subs.current.forEach((f) => f(v)); };
  const setT = useCallback((v: number) => { const c = Math.max(0, Math.min(duration, v)); emit(c); setTState(c); }, [duration]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now(), lastState = 0;
    const loop = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      let v = tRef.current + dt * rate;
      if (v >= duration) v = 0;
      emit(v);
      if (now - lastState > 120) { setTState(v); lastState = now; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, duration]);

  return {
    t, playing, rate, duration, setT, setRate,
    toggle: () => setPlaying((p) => !p),
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    subscribe: (fn) => { subs.current.add(fn); return () => { subs.current.delete(fn); }; },
    now: () => tRef.current,
  };
}

export const ClockCtx = createContext<Clock | null>(null);
export const useClock = () => {
  const c = useContext(ClockCtx);
  if (!c) throw new Error('ClockCtx missing');
  return c;
};

/** Run `draw` on every clock tick (rAF-synchronised) without React re-renders. */
export function useClockFrame(draw: (t: number) => void, deps: unknown[]) {
  const clock = useClock();
  const fn = useRef(draw);
  fn.current = draw;
  useEffect(() => {
    let raf = 0, pending = false, tv = clock.now();
    const kick = (v: number) => { tv = v; if (!pending) { pending = true; raf = requestAnimationFrame(() => { pending = false; fn.current(tv); }); } };
    kick(tv);
    const off = clock.subscribe(kick);
    return () => { off(); cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** HiDPI canvas helper. */
export function fitCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const r = c.getBoundingClientRect();
  const d = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  return ctx;
}
