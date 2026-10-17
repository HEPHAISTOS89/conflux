/**
 * Signal phase INFERRED from vehicle behaviour. NGSIM did not record the controller state at Peachtree St &
 * 10th St, so the landing world shows an estimate, never an observation:
 *
 * - A discharge is a through vehicle crossing its stop bar (NB/SB, derived in road.ts) or the middle of the
 *   cross-street box (EB/WB) at more than 2 m/s. Turning vehicles are ignored (permissive lefts and right turns
 *   on red would otherwise read as green).
 * - A group is green while its through vehicles discharge (window 2 s before to 4 s after a crossing, so green
 *   leads the first crossing by the start-up lost time); when neither group discharges, a group whose through
 *   queue stands at the bar is red and the other one is held green; otherwise the last state holds.
 * - Green runs shorter than a 5 s minimum green are absorbed; each change gets a fixed 3.5 s yellow and 1 s all-red
 *   ahead of the next green (ITE-style clearance, assumed, not measured).
 */
import type { TrackT } from '../../lib/traj';

export type Group = 'ns' | 'ew';
/** 0 red, 1 yellow, 2 green. */
export type Lamp = 0 | 1 | 2;
export interface SignalPlan {
  hz: number;
  ns: Uint8Array;
  ew: Uint8Array;
  /** Discharge evidence used for the inference. */
  events: { t: number; g: Group }[];
}
export interface SignalGeom {
  /** Stop bars along the corridor (data y, m). */
  nbBar?: number | null;
  sbBar?: number | null;
  /** Middle of the cross-street box (data x, m). */
  xMid: number;
}

const DISCHARGE_V = 2;
const STOP_V = 0.5;
const QUEUE_REACH = 30;
const MIN_GREEN = 5;
const YELLOW = 3.5;
const ALL_RED = 1;

const through = (tr: TrackT) => !tr.move || tr.move === 'through';

/** Times at which through vehicles cross their reference line moving at > 2 m/s. */
export function dischargeEvents(tracks: TrackT[], g: SignalGeom): { t: number; g: Group }[] {
  const out: { t: number; g: Group }[] = [];
  for (const tr of tracks) {
    if (!through(tr)) continue;
    const d = tr.dir;
    const p = tr.pts;
    let axis: 1 | 2, line: number | null | undefined, sign: 1 | -1, grp: Group;
    if (d === 'NB') { axis = 2; line = g.nbBar; sign = 1; grp = 'ns'; }
    else if (d === 'SB') { axis = 2; line = g.sbBar; sign = -1; grp = 'ns'; }
    else if (d === 'EB') { axis = 1; line = g.xMid; sign = 1; grp = 'ew'; }
    else if (d === 'WB') { axis = 1; line = g.xMid; sign = -1; grp = 'ew'; }
    else continue;
    if (line == null) continue;
    for (let i = 1; i < p.length; i++) {
      const a = (p[i - 1][axis] - line) * sign, b = (p[i][axis] - line) * sign;
      if (a < 0 && b >= 0) {
        if (p[i][3] > DISCHARGE_V) out.push({ t: p[i][0], g: grp });
        break;
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Per-frame count of through vehicles standing in a queue before their reference line. */
function queues(tracks: TrackT[], g: SignalGeom, n: number, hz: number): { ns: Uint16Array; ew: Uint16Array } {
  const ns = new Uint16Array(n), ew = new Uint16Array(n);
  for (const tr of tracks) {
    if (!through(tr)) continue;
    const d = tr.dir;
    for (const p of tr.pts) {
      if (p[3] >= STOP_V) continue;
      const k = Math.round(p[0] * hz);
      if (k < 0 || k >= n) continue;
      if (d === 'NB' && g.nbBar != null && p[2] < g.nbBar && p[2] > g.nbBar - QUEUE_REACH) ns[k]++;
      else if (d === 'SB' && g.sbBar != null && p[2] > g.sbBar && p[2] < g.sbBar + QUEUE_REACH) ns[k]++;
      else if (d === 'EB' && p[1] < g.xMid) ew[k]++;
      else if (d === 'WB' && p[1] > g.xMid) ew[k]++;
    }
  }
  return { ns, ew };
}

export function inferSignals(tracks: TrackT[], g: SignalGeom, duration: number, hz = 10): SignalPlan {
  const n = Math.round(duration * hz) + 1;
  const events = dischargeEvents(tracks, g);
  const q = queues(tracks, g, n, hz);
  // green group per frame: 1 = ns, 2 = ew, 0 = undecided
  const grp = new Uint8Array(n);
  let prev = 0;
  for (let k = 0; k < n; k++) {
    const t = k / hz;
    let ns = 0, ew = 0;
    for (const e of events) { if (e.t < t - 4) continue; if (e.t > t + 2) break; if (e.g === 'ns') ns++; else ew++; }
    let cur = prev;
    if (ns > ew) cur = 1;
    else if (ew > ns) cur = 2;
    else if (!ns && !ew) {
      if (q.ns[k] && !q.ew[k]) cur = 2;
      else if (q.ew[k] && !q.ns[k]) cur = 1;
    }
    grp[k] = cur; prev = cur;
  }
  // backfill the undecided lead-in with the first decided group
  const first = grp.find((v) => v !== 0) ?? 1;
  for (let k = 0; k < n && grp[k] === 0; k++) grp[k] = first;
  // absorb green runs shorter than the minimum green into the preceding run
  const minK = Math.round(MIN_GREEN * hz);
  for (let pass = 0; pass < 3; pass++) {
    let s = 0;
    for (let k = 1; k <= n; k++) {
      if (k < n && grp[k] === grp[s]) continue;
      if (k - s < minK && s > 0) grp.fill(grp[s - 1], s, k);
      s = k;
    }
  }
  const ns = new Uint8Array(n), ew = new Uint8Array(n);
  for (let k = 0; k < n; k++) { ns[k] = grp[k] === 1 ? 2 : 0; ew[k] = grp[k] === 2 ? 2 : 0; }
  // clearance before every change: yellow, then all-red, carved from the end of the outgoing green
  const yK = Math.round(YELLOW * hz), rK = Math.round(ALL_RED * hz);
  for (let k = 1; k < n; k++) {
    if (grp[k] === grp[k - 1]) continue;
    const out = grp[k - 1] === 1 ? ns : ew, inc = grp[k] === 1 ? ns : ew;
    for (let j = Math.max(0, k - rK - yK); j < k - rK; j++) if (out[j] === 2) out[j] = 1;
    for (let j = Math.max(0, k - rK); j < k; j++) { out[j] = 0; inc[j] = 0; }
  }
  return { hz, ns, ew, events };
}

export function lampAt(plan: SignalPlan, g: Group, t: number): Lamp {
  const a = g === 'ns' ? plan.ns : plan.ew;
  const k = Math.max(0, Math.min(a.length - 1, Math.round(t * plan.hz)));
  return a[k] as Lamp;
}
