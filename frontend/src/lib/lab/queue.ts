/**
 * Queue and delay measures for one signalised approach, computed from the served NGSIM tracks
 * (10 Hz samples [t s, x m, y m, v m/s, a m/s², lane], +y along the corridor northbound, positions at the
 * vehicle centre). No DOM, no React: unit-tested in queue.test.ts.
 *
 * Definitions follow the Highway Capacity Manual, 7th ed. (TRB 2022), chapter 19 (signalized intersections):
 * - A vehicle is "stopped" while its speed is below 0.5 m/s (HCM stopped-delay convention, ≈ 1.1 mph; also the
 *   criterion used for the stop-bar estimate in metrics.ts and the queue evidence in signals.ts).
 * - Queue length is the number of stopped vehicles upstream of the stop bar at an instant; the back of queue is the
 *   distance from the bar to the rear bumper of the farthest stopped vehicle (HCM 7th ed. §19, back-of-queue).
 * - Control delay is the extra travel time caused by the control: observed travel time over the approach segment
 *   minus the time to cover the same distance at free-flow speed (HCM 7th ed. eq. 19-18 form; the field method in
 *   HCM ch. 19 appendix / ITE Manual of Transportation Engineering Studies, "intersection delay study").
 *   NGSIM has no controller log and a 90 s window, so everything here is an estimate from one short sample.
 */
import type { IntersectionT, TrackT } from '../traj';
import { M_TO_FT, percentile, spotSpeeds } from './metrics';
import { roadGeometry } from './road';
import type { Group, Lamp, SignalPlan } from '../../components/world/signals';

/** Speed below which a vehicle counts as stopped (m/s): HCM 7th ed. ch. 19 stopped-delay convention. */
export const STOP_V = 0.5;

export type Approach = 'NB' | 'SB';

/** y-sign of travel: NB moves toward +y, SB toward −y. */
const sign = (dir: Approach) => (dir === 'NB' ? 1 : -1);

/** Distance (m) of a vehicle centre upstream of the bar, positive before the bar. */
const upstreamOf = (dir: Approach, y: number, bar: number) => (bar - y) * sign(dir);

/** Last sample time over the tracks (window end). */
export const windowEnd = (tracks: TrackT[]) => tracks.reduce((m, tr) => (tr.pts.length ? Math.max(m, tr.pts[tr.pts.length - 1][0]) : m), 0);

export interface QueueProfile {
  dir: Approach;
  /** Frame times, s. */
  t: number[];
  /** Stopped vehicles upstream of the bar at each frame. */
  n: number[];
  /** Back of queue at each frame: distance from the bar to the rear of the farthest stopped vehicle, m (0 when empty). */
  backM: number[];
  /** Vehicles on the approach that were stopped upstream of the bar at least once. */
  stoppedVehicles: number;
  maxQueue: number;
  maxBackM: number;
  maxBackFt: number;
  /** Time-weighted mean queue, veh (frames are uniform, so the plain mean over frames). */
  meanQueue: number;
  /** Time at which the longest queue (first occurrence) was observed, s. */
  tMaxQueue: number;
}

/**
 * Per-frame queue on approach `dir` upstream of the stop bar y = stopBarY: stopped vehicles (v < 0.5 m/s) and the
 * back-of-queue distance measured to the farthest stopped vehicle's rear bumper (the served point is the
 * NGSIM front-bumper centre, so the rear is len behind it along travel).
 * All movements on the approach count (through and turning lanes queue together on NGSIM's shared approaches).
 */
export function queueProfile(tracks: TrackT[], dir: Approach, stopBarY: number, hz = 10, duration = windowEnd(tracks)): QueueProfile {
  const frames = Math.max(1, Math.round(duration * hz) + 1);
  const t = Array.from({ length: frames }, (_, k) => k / hz);
  const n = new Array<number>(frames).fill(0);
  const backM = new Array<number>(frames).fill(0);
  let stoppedVehicles = 0;
  for (const tr of tracks) {
    if (tr.dir !== dir) continue;
    let ever = false;
    for (const p of tr.pts) {
      if (p[3] >= STOP_V) continue;
      const d = upstreamOf(dir, p[2], stopBarY);
      if (d <= 0) continue;
      const k = Math.round(p[0] * hz);
      if (k < 0 || k >= frames) continue;
      ever = true;
      n[k]++;
      const rear = d + tr.len_m;
      if (rear > backM[k]) backM[k] = rear;
    }
    if (ever) stoppedVehicles++;
  }
  let maxQueue = 0, tMaxQueue = 0, maxBackM = 0, sum = 0;
  for (let k = 0; k < frames; k++) {
    sum += n[k];
    if (n[k] > maxQueue) { maxQueue = n[k]; tMaxQueue = t[k]; }
    if (backM[k] > maxBackM) maxBackM = backM[k];
  }
  return { dir, t, n, backM, stoppedVehicles, maxQueue, maxBackM, maxBackFt: maxBackM * M_TO_FT, meanQueue: sum / frames, tMaxQueue };
}

/**
 * Approach length observable in the data, m: the 90th percentile of the distance upstream of the bar at which the
 * approach's tracks first appear, less 1 m, capped at `max` (60 m by default). NGSIM's Peachtree grid ends ~37 m
 * south of the NB bar, so a 60 m segment is not available on every approach.
 */
export function approachReach(tracks: TrackT[], dir: Approach, stopBarY: number, max = 60): number {
  const d: number[] = [];
  for (const tr of tracks) if (tr.dir === dir && tr.pts.length) { const u = upstreamOf(dir, tr.pts[0][2], stopBarY); if (u > 0) d.push(u); }
  const r = percentile(d, 90);
  return r == null ? max : Math.max(5, Math.min(max, Math.floor(r) - 1));
}

export interface VehicleDelay {
  id: number | string;
  move?: string;
  /** Time with v < 0.5 m/s upstream of the bar, s. */
  stoppedS: number;
  /** Observed travel time over the segment, s. */
  travelS: number;
  /** Length of the segment actually observed for this vehicle, m (≤ the approach length). */
  segmentM: number;
  /** Control delay ≈ travel time − segment / free-flow speed, s, floored at 0; null when the segment was not observed. */
  controlS: number | null;
  /** True when the delay is a lower bound: already stopped in the segment when the window opens, or not yet past the bar when it closes. */
  censored: boolean;
}

export type Los = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/** HCM 7th ed. Exhibit 19-8: LOS by control delay (s/veh) for a signalized intersection, assuming v/c ≤ 1. */
export function losFromDelay(d: number): Los {
  return d <= 10 ? 'A' : d <= 20 ? 'B' : d <= 35 ? 'C' : d <= 55 ? 'D' : d <= 80 ? 'E' : 'F';
}

export interface DelaySummary {
  dir: Approach;
  vehicles: VehicleDelay[];
  /** Vehicles with an observed control delay (reached the approach segment). */
  nControl: number;
  /** Vehicles on the approach (any movement) inside the window. */
  nVehicles: number;
  /** Vehicles that stopped at least once upstream of the bar, share of nVehicles (0–1). */
  stoppedShare: number;
  meanStoppedS: number | null;
  meanControlS: number | null;
  /** Vehicles whose delay is a lower bound (queued when the window opens or still upstream when it closes). */
  censored: number;
  /** Free-flow proxy: 85th-percentile spot speed at the segment entry line, m/s; null without enough observations. */
  v85: number | null;
  /** Spot-speed observations behind v85. */
  nSpot: number;
  /** Approach segment length used, m (the entry line is this far upstream of the bar). */
  approachM: number;
  los: Los | null;
}

/**
 * Stopped delay and an approximate control delay for every vehicle on approach `dir`:
 * - stopped delay = time at v < 0.5 m/s upstream of the stop bar;
 * - control delay = time from the entry line (approachM upstream of the bar, or the first observed sample when the
 *   track starts inside the segment) to the bar, minus the same distance at the 85th-percentile spot speed measured
 *   where vehicles cross the entry line (spotSpeeds in metrics.ts). Vehicles already queued when the window opens or
 *   not yet past the bar when it closes keep the delay observed so far and are flagged `censored` (a lower bound).
 * The summary LOS applies HCM 7th ed. Exhibit 19-8 thresholds to the mean control delay. It is an estimate: one 90 s
 * sample, no controller data, and a spot speed standing in for free-flow speed.
 */
export function stoppedDelay(tracks: TrackT[], dir: Approach, stopBarY: number, hz = 10, approachM = 60): DelaySummary {
  const s = sign(dir);
  const entryY = stopBarY - s * approachM;
  const spots = spotSpeeds(tracks, dir, entryY);
  const v85 = percentile(spots, 85);
  const vehicles: VehicleDelay[] = [];
  for (const tr of tracks) {
    if (tr.dir !== dir) continue;
    const p = tr.pts;
    if (p.length < 2) continue;
    let stopped = 0;
    for (const q of p) if (q[3] < STOP_V && upstreamOf(dir, q[2], stopBarY) > 0) stopped++;
    const stoppedS = stopped / hz;
    // entry: interpolated crossing of the entry line, or the first sample when the track begins inside the segment
    let tIn: number | null = null, yIn = 0, censored = false;
    if (upstreamOf(dir, p[0][2], entryY) <= 0 && upstreamOf(dir, p[0][2], stopBarY) > 0) {
      tIn = p[0][0]; yIn = p[0][2];
      if (p[0][3] < STOP_V) censored = true; // already queued when the window opens
    } else tIn = crossing(p, entryY, s, (t, y) => { yIn = y; return t; });
    // exit: interpolated crossing of the bar, else the last sample (still upstream: censored)
    let yOut = 0;
    let tOut = crossing(p, stopBarY, s, (t, y) => { yOut = y; return t; });
    if (tOut == null) {
      const last = p[p.length - 1];
      if (upstreamOf(dir, last[2], stopBarY) > 0) { tOut = last[0]; yOut = last[2]; censored = true; }
    }
    let controlS: number | null = null, travelS = 0, segmentM = 0;
    if (tIn != null && tOut != null && tOut > tIn) {
      segmentM = Math.abs(yOut - yIn);
      travelS = tOut - tIn;
      if (v85 != null && v85 > 0 && segmentM > 0) controlS = Math.max(0, travelS - segmentM / v85);
    }
    vehicles.push({ id: tr.id, move: tr.move, stoppedS, travelS, segmentM, controlS, censored });
  }
  const withControl = vehicles.filter((v) => v.controlS != null);
  const nStopped = vehicles.filter((v) => v.stoppedS > 0).length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const meanControlS = mean(withControl.map((v) => v.controlS!));
  return {
    dir, vehicles, nControl: withControl.length, nVehicles: vehicles.length,
    stoppedShare: vehicles.length ? nStopped / vehicles.length : 0,
    meanStoppedS: mean(vehicles.map((v) => v.stoppedS)),
    meanControlS,
    censored: vehicles.filter((v) => v.censored).length,
    v85, nSpot: spots.length, approachM,
    los: meanControlS == null ? null : losFromDelay(meanControlS),
  };
}

/** Interpolated time at which the track crosses y = line in travel direction s; `on` receives (t, y). */
function crossing(p: TrackT['pts'], line: number, s: 1 | -1, on: (t: number, y: number) => number): number | null {
  for (let k = 1; k < p.length; k++) {
    const a = (p[k - 1][2] - line) * s, b = (p[k][2] - line) * s;
    if (a < 0 && b >= 0) {
      const u = b === a ? 0 : -a / (b - a);
      return on(p[k - 1][0] + (p[k][0] - p[k - 1][0]) * u, line);
    }
  }
  return null;
}

export interface PhaseInterval { from: number; to: number; lamp: Lamp }

/** Run-length intervals [from, to) in seconds of the inferred lamp state for a signal group, for drawing. */
export function phaseIntervals(plan: SignalPlan, group: Group): PhaseInterval[] {
  const a = group === 'ns' ? plan.ns : plan.ew;
  const out: PhaseInterval[] = [];
  if (!a.length) return out;
  let start = 0;
  for (let k = 1; k <= a.length; k++) {
    if (k < a.length && a[k] === a[start]) continue;
    out.push({ from: start / plan.hz, to: (k < a.length ? k : a.length - 1) / plan.hz, lamp: a[start] as Lamp });
    start = k;
  }
  return out;
}

/** Stop bars and cross-street middle for the signal inference, from the behaviour-derived road geometry (road.ts). */
export function signalGeometry(data: Pick<IntersectionT, 'lanes_geom' | 'tracks' | 'bbox'>): { nbBar: number | null; sbBar: number | null; xMid: number } {
  const g = roadGeometry(data);
  const nb = g.stops.find((s) => s.dir === 'NB'), sb = g.stops.find((s) => s.dir === 'SB');
  return { nbBar: nb?.a[1] ?? null, sbBar: sb?.a[1] ?? null, xMid: g.cross ? (g.cross.x0 + g.cross.x1) / 2 : 0 };
}
