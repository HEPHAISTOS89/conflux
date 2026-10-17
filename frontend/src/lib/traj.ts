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

/** Shared playback clock for a page. `t` is not React state: read it with useClockFrame or now() so playback does not re-render the page. */
export interface Clock { playing: boolean; rate: number; duration: number; setT: (t: number) => void; toggle: () => void; play: () => void; pause: () => void; setRate: (r: number) => void; subscribe: (fn: (t: number) => void) => () => void; now: () => number }

export function useClockState(duration: number): Clock {
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const tRef = useRef(0);
  const subs = useRef(new Set<(t: number) => void>());
  const emit = (v: number) => { tRef.current = v; subs.current.forEach((f) => f(v)); };
  const setT = useCallback((v: number) => { const c = Math.max(0, Math.min(duration, v)); emit(c); }, [duration]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      let v = tRef.current + dt * rate;
      if (v >= duration) v = 0;
      emit(v);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, duration]);

  return {
    playing, rate, duration, setT, setRate,
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

/** Conflicts whose window (with a short lead-in and fade-out) contains t. */
export const activeAt = (conflicts: ConflictT[], t: number) =>
  conflicts.filter((k) => t >= (k.t0 ?? k.t - 0.6) - 0.4 && t <= (k.t1 ?? k.t + 0.6) + 0.8);

/** Replay start for a conflict: 1.5 s before it opens. */
export const leadIn = (c: ConflictT) => Math.max(0, (c.t0 ?? c.t) - 1.5);

/**
 * Shared selection for a page: plan view, 3D, time–space, timeline and tables read and write it.
 * `selected` keeps insertion order (the first id is the primary road user); `conflict` is set when a
 * conflict was picked, so links and readouts can name the event.
 */
export interface Selection {
  selected: Set<string>;
  hovered: string | null;
  conflict: number | null;
  select: (ids: (string | number)[] | null, opts?: { seek?: number; add?: boolean; conflict?: number }) => void;
  hover: (id: string | number | null) => void;
}

export function useSelectionState(clock: Clock): Selection {
  const [sel, setSel] = useState<{ ids: Set<string>; conflict: number | null }>({ ids: new Set(), conflict: null });
  const [hovered, setHovered] = useState<string | null>(null);
  const setT = clock.setT;
  const select = useCallback<Selection['select']>((ids, opts = {}) => {
    setSel((prev) => {
      const next = new Set(opts.add ? prev.ids : []);
      for (const raw of ids ?? []) { const id = String(raw); if (opts.add && next.has(id)) next.delete(id); else next.add(id); }
      return { ids: next, conflict: opts.conflict ?? null };
    });
    if (opts.seek != null) setT(opts.seek);
  }, [setT]);
  const hover = useCallback((id: string | number | null) => setHovered(id == null ? null : String(id)), []);
  return { selected: sel.ids, conflict: sel.conflict, hovered, select, hover };
}

export const SelectionCtx = createContext<Selection | null>(null);
/** The page selection, or null where a view is used without one (selection features then stay off). */
export const useSelection = () => useContext(SelectionCtx);

/** Select both road users of a conflict and replay from just before it. */
export const selectConflict = (s: Selection, c: ConflictT) => s.select([c.a, c.b], { seek: leadIn(c), conflict: c.id });
