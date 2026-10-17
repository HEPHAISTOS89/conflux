/**
 * Pure kinematics and data-quality functions for the intersection lab.
 * Inputs are the served NGSIM tracks: 10 Hz samples [t s, x m, y m, v m/s, a m/s², lane] in a local
 * grid where +y runs along the corridor (northbound) and +x across it. No DOM, no React: unit-tested.
 */
import type { ConflictT, Pt, TrackT } from '../traj';

export const M_TO_FT = 3.28084;
export const MPS_TO_MPH = 2.236936;

/* ---------- heading ---------- */

/** Grid angle (rad, counter-clockwise from +x) → bearing in degrees clockwise from corridor north (+y). */
export function bearingDeg(h: number): number {
  const b = 90 - (h * 180) / Math.PI;
  return ((b % 360) + 360) % 360;
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
/** Eight-point compass label for a bearing. */
export const bearingLabel = (b: number) => POINTS[Math.round((((b % 360) + 360) % 360) / 45) % 8];

/** Heading at sample i from the displacement over ±3 samples (0.6 s); null while the vehicle is (nearly) stationary. */
export function headingAt(pts: Pt[], i: number, span = 3): number | null {
  const lo = pts[Math.max(0, i - span)], hi = pts[Math.min(pts.length - 1, i + span)];
  if (!lo || !hi) return null;
  const dx = hi[1] - lo[1], dy = hi[2] - lo[2];
  return Math.hypot(dx, dy) > 0.15 ? Math.atan2(dy, dx) : null;
}

/** Index of the sample at or just before t, or null outside the track. */
export function sampleIndex(tr: TrackT, t: number, hz = 10): number | null {
  const p = tr.pts;
  if (!p.length || t < p[0][0] - 1e-9 || t > p[p.length - 1][0] + 1e-9) return null;
  return Math.min(p.length - 1, Math.max(0, Math.floor((t - p[0][0]) * hz + 1e-6)));
}

export interface Kin { x: number; y: number; v: number; a: number; h: number }

/** Interpolated position and speed at t; heading from the ±3-sample displacement, falling back to the last moving heading. */
export function kinAt(tr: TrackT, t: number, hz = 10): Kin | null {
  const i = sampleIndex(tr, t, hz);
  if (i == null) return null;
  const p = tr.pts, a = p[i], b = p[Math.min(p.length - 1, i + 1)];
  const u = b === a ? 0 : Math.min(1, Math.max(0, (t - a[0]) * hz));
  let h = headingAt(p, i);
  for (let k = i; h == null && k >= 0; k -= 3) h = headingAt(p, k);
  for (let k = i; h == null && k < p.length; k += 3) h = headingAt(p, k);
  return { x: a[1] + (b[1] - a[1]) * u, y: a[2] + (b[2] - a[2]) * u, v: a[3] + (b[3] - a[3]) * u, a: a[4], h: h ?? Math.PI / 2 };
}

/* ---------- track confidence ---------- */

export const CONF = {
  /** RMS speed residual (m/s) at which confidence reaches zero. */
  residualZero: 1.5,
  /** Half-window in samples (±0.5 s at 10 Hz). */
  window: 5,
  /** Acceleration above tyre–road friction (m/s², ≈ 0.46 g = 14.8 ft/s²) is a position error, not a manoeuvre. */
  accelLimit: 4.5,
  accelPenalty: 0.5,
  /** A missing-frame gap inside the window (Δt > 1.5 frames) halves trust in interpolated motion. */
  gapPenalty: 0.6,
} as const;

/**
 * Kinematic consistency of the smoothed track around sample i: RMS over ±0.5 s of the difference between the
 * speed implied by successive positions (‖Δp‖/Δt) and the reported speed (mean of the two samples).
 * A clean track scores ~0.03 m/s; ID switches and position jumps score metres per second.
 */
export function speedResidual(pts: Pt[], i: number, w: number = CONF.window): number {
  let s = 0, n = 0;
  for (let k = Math.max(1, i - w); k <= Math.min(pts.length - 1, i + w); k++) {
    const a = pts[k - 1], b = pts[k], dt = b[0] - a[0];
    if (dt <= 0) continue;
    const r = Math.hypot(b[1] - a[1], b[2] - a[2]) / dt - (a[3] + b[3]) / 2;
    s += r * r; n++;
  }
  return n ? Math.sqrt(s / n) : 0;
}

export interface Confidence { score: number; level: 'high' | 'medium' | 'low'; residual: number; accelFlag: boolean; gapFlag: boolean }

/**
 * Track confidence in [0, 1] at sample i:
 *   c = clamp(1 − RMS residual / 1.5 m/s, 0, 1) × 0.5 if |a| > 4.5 m/s² in the window × 0.6 if a frame gap is in the window.
 * High ≥ 0.8, medium ≥ 0.5, low below.
 */
export function confidence(pts: Pt[], i: number, hz = 10): Confidence {
  const residual = speedResidual(pts, i);
  let score = Math.min(1, Math.max(0, 1 - residual / CONF.residualZero));
  let accelFlag = false, gapFlag = false;
  for (let k = Math.max(0, i - CONF.window); k <= Math.min(pts.length - 1, i + CONF.window); k++) {
    if (Math.abs(pts[k][4]) > CONF.accelLimit) accelFlag = true;
    if (k > 0 && pts[k][0] - pts[k - 1][0] > 1.5 / hz) gapFlag = true;
  }
  if (accelFlag) score *= CONF.accelPenalty;
  if (gapFlag) score *= CONF.gapPenalty;
  return { score, level: score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low', residual, accelFlag, gapFlag };
}

/* ---------- data health ---------- */

export interface Health {
  tracks: number; samples: number; expected: number;
  /** observed samples / samples expected from each track's first to last time at the nominal rate, % */
  completeness: number;
  longestGapS: number; gaps: number;
  /** tracks with at least one position jump (single-step residual > 3 m/s): repair candidates */
  jumpTracks: number; jumpSamples: number;
  /** samples with |a| above friction */
  accelSamples: number;
  /** share of samples whose confidence is high, % */
  highConfidence: number;
}

export const JUMP_MPS = 3;

export function dataHealth(tracks: TrackT[], hz = 10): Health {
  let samples = 0, expected = 0, longest = 0, gaps = 0, jumpTracks = 0, jumpSamples = 0, accelSamples = 0, high = 0;
  for (const tr of tracks) {
    const p = tr.pts;
    if (!p.length) continue;
    samples += p.length;
    expected += Math.round((p[p.length - 1][0] - p[0][0]) * hz) + 1;
    let jumped = false;
    for (let k = 0; k < p.length; k++) {
      if (Math.abs(p[k][4]) > CONF.accelLimit) accelSamples++;
      if (k === 0) continue;
      const dt = p[k][0] - p[k - 1][0];
      if (dt > 1.5 / hz) { gaps++; longest = Math.max(longest, dt - 1 / hz); }
      if (dt > 0 && Math.abs(Math.hypot(p[k][1] - p[k - 1][1], p[k][2] - p[k - 1][2]) / dt - (p[k][3] + p[k - 1][3]) / 2) > JUMP_MPS) { jumpSamples++; jumped = true; }
    }
    if (jumped) jumpTracks++;
    // confidence on every 5th sample keeps this O(n) and representative
    for (let k = 0; k < p.length; k += 5) if (confidence(p, k, hz).level === 'high') high++;
  }
  const sampled = tracks.reduce((s, tr) => s + Math.ceil(tr.pts.length / 5), 0);
  return {
    tracks: tracks.length, samples, expected,
    completeness: expected ? (100 * Math.min(samples, expected)) / expected : 0,
    longestGapS: longest, gaps, jumpTracks, jumpSamples, accelSamples,
    highConfidence: sampled ? (100 * high) / sampled : 0,
  };
}

/* ---------- spot speeds and histogram ---------- */

/**
 * Spot speed of each vehicle of `dir` where it crosses the line y = yLine (interpolated between samples):
 * one observation per vehicle, as in a radar spot-speed study. NB crosses with increasing y, SB decreasing.
 */
export function spotSpeeds(tracks: TrackT[], dir: string, yLine: number): number[] {
  const out: number[] = [];
  const up = dir === 'NB';
  for (const tr of tracks) {
    if (tr.dir !== dir) continue;
    const p = tr.pts;
    for (let k = 1; k < p.length; k++) {
      const y0 = p[k - 1][2], y1 = p[k][2];
      if (up ? y0 < yLine && y1 >= yLine : y0 > yLine && y1 <= yLine) {
        const u = (yLine - y0) / (y1 - y0);
        out.push(p[k - 1][3] + (p[k][3] - p[k - 1][3]) * u);
        break;
      }
    }
  }
  return out;
}

export interface Bin { x0: number; x1: number; n: number }

/** Fixed-width histogram from 0 to the first bin edge ≥ max (or the given max). */
export function histogram(values: number[], width: number, max?: number): Bin[] {
  const top = max ?? Math.max(width, Math.ceil((Math.max(0, ...values) + 1e-9) / width) * width);
  const n = Math.max(1, Math.round(top / width));
  const bins: Bin[] = Array.from({ length: n }, (_, i) => ({ x0: i * width, x1: (i + 1) * width, n: 0 }));
  for (const v of values) bins[Math.min(n - 1, Math.max(0, Math.floor(v / width)))].n++;
  return bins;
}

/** Percentile with linear interpolation between order statistics (p in 0–100); null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const r = (p / 100) * (s.length - 1), i = Math.floor(r), f = r - i;
  return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * f : s[i];
}

/* ---------- projection, TTC, PET ---------- */

/** Constant-acceleration projection along the current heading, 0.1 s steps; speed never goes below zero (the vehicle stops). */
export function projectCA(k: Kin, horizon = 2, step = 0.1): [number, number][] {
  const out: [number, number][] = [[k.x, k.y]];
  let x = k.x, y = k.y, v = k.v;
  const cx = Math.cos(k.h), cy = Math.sin(k.h);
  for (let s = step; s <= horizon + 1e-9; s += step) {
    const v1 = Math.max(0, v + k.a * step);
    const d = ((v + v1) / 2) * step;
    x += cx * d; y += cy * d; v = v1;
    out.push([x, y]);
  }
  return out;
}

export interface Body extends Kin { len: number; w: number }

/** Two equal circles per footprint (radius w/2, centres ±(len − w)/2 along the heading). */
function circles(b: Body): [number, number, number][] {
  const off = Math.max(0, (b.len - b.w) / 2), r = b.w / 2, cx = Math.cos(b.h), cy = Math.sin(b.h);
  return [[b.x + cx * off, b.y + cy * off, r], [b.x - cx * off, b.y - cy * off, r]];
}

/**
 * Time to collision if both road users keep their current velocity vectors, using a two-circle footprint.
 * 0 when the footprints already overlap; null when they never meet within the horizon.
 */
export function ttcCV(a: Body, b: Body, horizon = 10): number | null {
  const va = [Math.cos(a.h) * a.v, Math.sin(a.h) * a.v], vb = [Math.cos(b.h) * b.v, Math.sin(b.h) * b.v];
  const rvx = vb[0] - va[0], rvy = vb[1] - va[1];
  let best: number | null = null;
  for (const ca of circles(a)) for (const cb of circles(b)) {
    const px = cb[0] - ca[0], py = cb[1] - ca[1], R = ca[2] + cb[2];
    const c = px * px + py * py - R * R;
    if (c <= 0) return 0;
    const A = rvx * rvx + rvy * rvy, B = 2 * (px * rvx + py * rvy);
    if (A < 1e-9 || B >= 0) continue;
    const disc = B * B - 4 * A * c;
    if (disc < 0) continue;
    const t = (-B - Math.sqrt(disc)) / (2 * A);
    if (t >= 0 && t <= horizon && (best == null || t < best)) best = t;
  }
  return best;
}

export interface PetResult { kind: 'crossing' | 'same_path' | 'none'; pet: number | null; x: number; y: number; first: 'a' | 'b' | null; tExit: number | null; tEnter: number | null }

/**
 * Post-encroachment time for two tracks: the conflict point is where their paths pass closest (within `zone` m);
 * PET = time the second road user enters the zone − time the first one left it (negative: both inside at once).
 * Paths that run together (heading difference < 20°) are a following situation, where PET does not apply.
 */
export function petPair(A: TrackT, B: TrackT, zone = 1.5): PetResult {
  const none: PetResult = { kind: 'none', pet: null, x: 0, y: 0, first: null, tExit: null, tEnter: null };
  if (!A.pts.length || !B.pts.length) return none;
  let bd = Infinity, bi = 0, bj = 0;
  for (let i = 0; i < A.pts.length; i += 2) {
    const a = A.pts[i];
    for (let j = 0; j < B.pts.length; j += 2) {
      const d = (a[1] - B.pts[j][1]) ** 2 + (a[2] - B.pts[j][2]) ** 2;
      if (d < bd) { bd = d; bi = i; bj = j; }
    }
  }
  if (Math.sqrt(bd) > zone) return none;
  const x = (A.pts[bi][1] + B.pts[bj][1]) / 2, y = (A.pts[bi][2] + B.pts[bj][2]) / 2;
  const ha = headingAt(A.pts, bi, 5), hb = headingAt(B.pts, bj, 5);
  if (ha != null && hb != null) {
    const d = Math.abs(Math.atan2(Math.sin(ha - hb), Math.cos(ha - hb)));
    if (d < (20 * Math.PI) / 180) return { ...none, kind: 'same_path', x, y };
  }
  const inside = (tr: TrackT) => tr.pts.filter((p) => Math.hypot(p[1] - x, p[2] - y) <= zone).map((p) => p[0]);
  const ta = inside(A), tb = inside(B);
  if (!ta.length || !tb.length) return none;
  const aFirst = ta[0] <= tb[0];
  const tExit = aFirst ? ta[ta.length - 1] : tb[tb.length - 1];
  const tEnter = aFirst ? tb[0] : ta[0];
  return { kind: 'crossing', pet: tEnter - tExit, x, y, first: aFirst ? 'a' : 'b', tExit, tEnter };
}

/* ---------- geometry from behaviour ---------- */

/**
 * Stop-bar estimate for an approach from queueing behaviour: the queue head is the 95th-percentile position
 * toward the intersection of stopped samples (v < 0.5 m/s) on that approach. Returns null with fewer than 20 stopped samples.
 */
export function stopLine(tracks: TrackT[], dir: 'NB' | 'SB'): { x: number; y: number; n: number } | null {
  const ys: number[] = [], xs: number[] = [];
  for (const tr of tracks) {
    if (tr.dir !== dir) continue;
    for (const p of tr.pts) if (p[3] < 0.5 && (dir === 'NB' ? p[2] < -3 : p[2] > 3)) { ys.push(p[2]); xs.push(p[1]); }
  }
  if (ys.length < 20) return null;
  return { x: percentile(xs, 50)!, y: percentile(ys, dir === 'NB' ? 95 : 5)!, n: ys.length };
}

/** Location of a conflict: the path crossing for crossing conflicts when it exists, otherwise the midpoint of the pair at the event time. */
export function conflictPoint(c: ConflictT, A: TrackT | undefined, B: TrackT | undefined, hz = 10): { x: number; y: number } | null {
  if (!A || !B) return null;
  if (c.type === 'crossing') {
    const p = petPair(A, B);
    if (p.kind === 'crossing') return { x: p.x, y: p.y };
  }
  const a = kinAt(A, c.t, hz), b = kinAt(B, c.t, hz);
  return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a ?? b;
}

/* ---------- playback ---------- */

const smooth = (u: number) => u * u * (3 - 2 * u);

/** Playback-rate multiplier around a near-miss at time ct: `floor` within ±inner s, easing back to 1 by ±outer s. */
export function nearMissWarp(t: number, ct: number, floor = 0.35, inner = 0.6, outer = 1.6): number {
  const d = Math.abs(t - ct);
  if (d <= inner) return floor;
  if (d >= outer) return 1;
  return floor + (1 - floor) * smooth((d - inner) / (outer - inner));
}

/** The next (dir = 1) or previous (dir = −1) conflict strictly after/before t (ignoring ±eps), wrapping is left to the caller. */
export function nextRisk<T extends { t: number }>(conflicts: T[], t: number, dir: 1 | -1, eps = 0.05): T | null {
  const s = [...conflicts].sort((a, b) => a.t - b.t);
  if (dir > 0) return s.find((c) => c.t > t + eps) ?? null;
  for (let i = s.length - 1; i >= 0; i--) if (s[i].t < t - eps) return s[i];
  return null;
}

/** Snap a time to the 10 Hz frame grid, then step n frames, clamped to [0, duration]. */
export function stepFrame(t: number, n: number, duration: number, hz = 10): number {
  const f = Math.round(t * hz) + n;
  return Math.max(0, Math.min(duration, f / hz));
}

export const easeInOutCubic = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

/* ---------- rendering pose ---------- */

export interface RenderPose extends Kin {
  /** 0–1 opacity: 0.5 s fade where a track starts or ends inside the replay window (detection acquired / lost). */
  fade: number;
  /** 0–1 brake-lamp intensity: ramps from 2 to 4.6 ft/s² (0.6–1.4 m/s²) of deceleration; on while stopped (v < 0.3 m/s). */
  brake: number;
}

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Heading at sample i for drawing: vehicles do not rotate while stopped, so below 0.6 m/s (1.3 mph) the heading is
 * held from the last sample that was moving (or the next one, before the first move). Removes the heading
 * noise of creeping and queued vehicles, where ±0.3 s of displacement is mostly position error.
 */
function headingNear(p: Pt[], i: number): number | null {
  for (let k = i; k >= 0; k--) if (p[k][3] > 0.6) { const h = headingAt(p, k); if (h != null) return h; }
  for (let k = i + 1; k < p.length; k++) if (p[k][3] > 0.6) { const h = headingAt(p, k); if (h != null) return h; }
  return headingAt(p, i);
}

/**
 * Pose for drawing at any time t between 10 Hz samples: Catmull–Rom position (C¹, no kinks at samples),
 * heading interpolated along the shorter arc between the smoothed (±0.3 s) velocity headings of the two
 * bracketing samples, speed and acceleration linear. Metrics keep using `kinAt`.
 */
export function renderPose(tr: TrackT, t: number, hz = 10, window: [number, number] = [0, Infinity], fadeS = 0.5): RenderPose | null {
  const p = tr.pts;
  if (!p.length || t < p[0][0] - 1e-9 || t > p[p.length - 1][0] + 1e-9) return null;
  const f = Math.max(0, (t - p[0][0]) * hz);
  const i = Math.min(p.length - 1, Math.floor(f + 1e-9)), j = Math.min(p.length - 1, i + 1);
  const u = j === i ? 0 : Math.min(1, f - i);
  const a = p[Math.max(0, i - 1)], b = p[i], c = p[j], d = p[Math.min(p.length - 1, j + 1)];
  // a frame gap breaks the uniform-spacing assumption of the spline: fall back to linear
  const uniform = c[0] - b[0] < 1.5 / hz && b[0] - a[0] < 1.5 / hz && d[0] - c[0] < 1.5 / hz;
  const cr = (k: number) => {
    if (!uniform) return b[k] + (c[k] - b[k]) * u;
    const u2 = u * u, u3 = u2 * u;
    return 0.5 * (2 * b[k] + (c[k] - a[k]) * u + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * u2 + (3 * b[k] - a[k] - 3 * c[k] + d[k]) * u3);
  };
  const h0 = headingNear(p, i), h1 = j === i ? h0 : headingNear(p, j);
  const h = h0 == null ? (h1 ?? Math.PI / 2) : h1 == null ? h0 : h0 + wrapPi(h1 - h0) * u;
  const v = b[3] + (c[3] - b[3]) * u, acc = b[4] + (c[4] - b[4]) * u;
  const t0 = p[0][0], t1 = p[p.length - 1][0];
  const fin = t0 <= window[0] + 0.05 ? 1 : Math.min(1, (t - t0) / fadeS);
  const fout = t1 >= window[1] - 0.05 ? 1 : Math.min(1, (t1 - t) / fadeS);
  const brake = v < 0.3 ? 1 : Math.min(1, Math.max(0, (-acc - 0.6) / 0.8));
  return { x: cr(1), y: cr(2), v, a: acc, h: wrapPi(h), fade: Math.max(0, Math.min(fin, fout)), brake };
}
