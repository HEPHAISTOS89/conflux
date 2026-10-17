/**
 * Track quality: duplicate and ID-switch detection on the served trajectories.
 *
 * NGSIM is known to carry tracks that occupy the same footprint as another vehicle for seconds at a time
 * (duplicate detections and ID switches, Coifman & Li 2017, "A critical evaluation of the NGSIM vehicle
 * trajectory dataset"; Punzo, Borzacchiello & Ciuffo 2011). Replayed naively, these draw one car driving
 * through another. This module finds every pair whose oriented footprints overlap for a sustained window
 * and names one of them the ghost for that window, so the views can hide it and the data-health panel can
 * report it. Pure functions, unit-tested; nothing is deleted from the data.
 */
import type { TrackT } from '../traj';
import { headingAt, JUMP_MPS } from './metrics';

export type GhostReason = 'id_switch' | 'duplicate';
export interface GhostWindow {
  /** Hidden track. */
  id: string;
  /** The track it duplicates (kept visible). */
  of: string;
  from: number;
  to: number;
  reason: GhostReason;
  /** Overlapping frames. */
  frames: number;
}
export interface Quality {
  windows: GhostWindow[];
  /** Hidden windows by track id, sorted by time. */
  byId: Map<string, GhostWindow[]>;
  /** Tracks hidden for their whole life (duplicates from first to last frame). */
  wholeTracks: string[];
  /** Seconds of track time hidden in total. */
  hiddenS: number;
}

export const QUALITY = {
  /** Oriented-footprint overlap counts when the other centre sits inside this fraction of the half-extents. */
  shrink: 0.8,
  /** Overlap must last at least this long to be a duplicate rather than a near-miss passing by. */
  minS: 1.0,
  /** Overlap windows closer than this are merged. */
  mergeS: 1.0,
  /** A position jump at or before the overlap marks the track as switched from then on: it is the ghost. */
  jumpLookbackS: Infinity,
} as const;

const DIR_H: Record<string, number> = { NB: Math.PI / 2, SB: -Math.PI / 2, EB: 0, WB: Math.PI };

interface Sample { id: string; x: number; y: number; h: number; len: number; w: number }

/** Heading per sample: velocity heading where moving, otherwise the last moving heading, otherwise the approach direction. */
function headings(tr: TrackT): Float64Array {
  const p = tr.pts, out = new Float64Array(p.length);
  let last: number | null = null;
  for (let i = 0; i < p.length; i++) { const h = headingAt(p, i); if (h != null) last = h; out[i] = last ?? DIR_H[tr.dir ?? ''] ?? Math.PI / 2; }
  // fill the leading samples (before the first move) from the first moving heading
  let first: number | null = null;
  for (let i = 0; i < p.length && first == null; i++) if (headingAt(p, i) != null) first = headingAt(p, i);
  if (first != null) for (let i = 0; i < p.length; i++) { if (headingAt(p, i) != null) break; out[i] = first; }
  return out;
}

/** Frames (t · hz) at which the track's position-implied speed disagrees with its reported speed by more than JUMP_MPS. */
function jumpFrames(tr: TrackT, hz: number): number[] {
  const out: number[] = [], p = tr.pts;
  for (let k = 1; k < p.length; k++) {
    const dt = p[k][0] - p[k - 1][0];
    if (dt > 0 && Math.abs(Math.hypot(p[k][1] - p[k - 1][1], p[k][2] - p[k - 1][2]) / dt - (p[k][3] + p[k - 1][3]) / 2) > JUMP_MPS) out.push(Math.round(p[k][0] * hz));
  }
  return out;
}

/** True when b's centre lies inside a's oriented footprint shrunk by `shrink`, or vice versa. */
export function footprintsOverlap(a: Sample, b: Sample, shrink = QUALITY.shrink): boolean {
  const test = (p: Sample, q: Sample) => {
    const dx = q.x - p.x, dy = q.y - p.y, c = Math.cos(p.h), s = Math.sin(p.h);
    const along = dx * c + dy * s, across = -dx * s + dy * c;
    return Math.abs(along) < ((p.len + q.len) / 2) * shrink && Math.abs(across) < ((p.w + q.w) / 2) * shrink;
  };
  return test(a, b) || test(b, a);
}

/**
 * Ghost windows for a set of tracks. For every pair whose footprints overlap for ≥ minS, the ghost is the track
 * that jumped (an ID switch, from the jump onward), else the one that appeared later (a duplicate detection; ties by id).
 * A window that reaches within 1 s of the ghost's first or last frame is extended to that end.
 */
export function trackQuality(tracks: TrackT[], hz = 10): Quality {
  const byFrame = new Map<number, Sample[]>();
  const t0 = new Map<string, number>(), t1 = new Map<string, number>(), jumps = new Map<string, number[]>();
  for (const tr of tracks) {
    const id = String(tr.id), hs = headings(tr);
    if (!tr.pts.length) continue;
    t0.set(id, tr.pts[0][0]); t1.set(id, tr.pts[tr.pts.length - 1][0]); jumps.set(id, jumpFrames(tr, hz));
    tr.pts.forEach((p, i) => {
      const f = Math.round(p[0] * hz);
      let arr = byFrame.get(f); if (!arr) byFrame.set(f, (arr = []));
      arr.push({ id, x: p[1], y: p[2], h: hs[i], len: tr.len_m, w: tr.w_m });
    });
  }
  // overlapping frames per unordered pair
  const pairs = new Map<string, number[]>();
  for (const [f, arr] of byFrame) {
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b = arr[j];
      if (Math.abs(a.x - b.x) > 8 || Math.abs(a.y - b.y) > 14) continue;
      if (!footprintsOverlap(a, b)) continue;
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      let v = pairs.get(key); if (!v) pairs.set(key, (v = []));
      v.push(f);
    }
  }
  const minFrames = Math.round(QUALITY.minS * hz), mergeFrames = Math.round(QUALITY.mergeS * hz), look = Math.round(QUALITY.jumpLookbackS * hz);
  const windows: GhostWindow[] = [];
  for (const [key, frames] of pairs) {
    frames.sort((a, b) => a - b);
    // split into runs separated by more than mergeFrames
    const runs: [number, number][] = [];
    for (const f of frames) { const r = runs[runs.length - 1]; if (r && f - r[1] <= mergeFrames) r[1] = f; else runs.push([f, f]); }
    const [A, B] = key.split('|');
    for (const [fa, fb] of runs) {
      if (fb - fa + 1 < minFrames) continue;
      // an ID switch corrupts a track from the jump onward: the track that jumped first (and before the overlap) is the ghost
      const firstJump = (id: string) => jumps.get(id)!.find((jf) => jf >= fa - look && jf <= fb) ?? null;
      const ja = firstJump(A), jb = firstJump(B);
      let ghost: string, of: string, reason: GhostReason;
      if (ja != null || jb != null) { ghost = ja == null ? B : jb == null ? A : ja <= jb ? A : B; reason = 'id_switch'; }
      else {
        const sa = t0.get(A)!, sb = t0.get(B)!;
        ghost = sa > sb ? A : sb > sa ? B : (A > B ? A : B); reason = 'duplicate';
      }
      of = ghost === A ? B : A;
      let from = fa / hz, to = fb / hz;
      if (from - t0.get(ghost)! <= 1) from = t0.get(ghost)!;
      if (t1.get(ghost)! - to <= 1) to = t1.get(ghost)!;
      windows.push({ id: ghost, of, from, to, reason, frames: fb - fa + 1 });
    }
  }
  windows.sort((a, b) => a.from - b.from || (a.id < b.id ? -1 : 1));
  const byId = new Map<string, GhostWindow[]>();
  for (const w of windows) { let v = byId.get(w.id); if (!v) byId.set(w.id, (v = [])); v.push(w); }
  // merge a track's own windows where they touch
  let hiddenS = 0;
  const wholeTracks: string[] = [];
  for (const [id, ws] of byId) {
    ws.sort((a, b) => a.from - b.from);
    const merged: GhostWindow[] = [];
    for (const w of ws) { const m = merged[merged.length - 1]; if (m && w.from <= m.to + QUALITY.mergeS) { m.to = Math.max(m.to, w.to); m.frames += w.frames; } else merged.push({ ...w }); }
    byId.set(id, merged);
    for (const w of merged) hiddenS += w.to - w.from;
    if (merged.length === 1 && merged[0].from <= t0.get(id)! + 1e-6 && merged[0].to >= t1.get(id)! - 1e-6) wholeTracks.push(id);
  }
  return { windows, byId, wholeTracks, hiddenS };
}

/**
 * Visibility weight of a track at t: 0 inside a ghost window, 1 outside, easing over `edge` s at each end so a
 * hidden car fades rather than pops. Tracks without windows are always 1.
 */
export function ghostFade(q: Quality | null | undefined, id: string, t: number, edge = 0.3): number {
  const ws = q?.byId.get(id);
  if (!ws) return 1;
  for (const w of ws) {
    if (t < w.from - edge || t > w.to + edge) continue;
    if (t >= w.from && t <= w.to) return 0;
    const d = t < w.from ? w.from - t : t - w.to;
    return Math.min(1, d / edge);
  }
  return 1;
}

/** Conflicts whose pair is a ghost and its host during the event: an artefact of the duplicate, not a near-miss. */
export function conflictIsGhostPair(q: Quality | null | undefined, a: string | number, b: string | number, t: number): boolean {
  if (!q) return false;
  const check = (g: string, h: string) => (q.byId.get(g) ?? []).some((w) => w.of === h && t >= w.from - 0.5 && t <= w.to + 0.5);
  return check(String(a), String(b)) || check(String(b), String(a));
}
