import { describe, expect, it } from 'vitest';
import type { Pt, TrackT } from '../traj';
import { inferSignals } from '../../components/world/signals';
import { approachReach, losFromDelay, phaseIntervals, queueProfile, stoppedDelay, STOP_V } from './queue';

const BAR = -15;

/** A NB vehicle that arrives at `from` at t0 moving at v m/s, stops at `at` for `wait` s, then leaves at v (10 Hz, car centre). */
function nbVehicle(id: number, t0: number, from: number, v: number, at: number, wait: number, len = 4.6, move = 'through'): TrackT {
  const pts: Pt[] = [];
  let t = t0, y = from;
  while (y < at - 1e-9) { pts.push([+t.toFixed(1), 2, y, v, 0, 1]); y = Math.min(at, y + v / 10); t += 0.1; }
  for (let i = 0; i < wait * 10; i++) { pts.push([+t.toFixed(1), 2, at, 0, 0, 1]); t += 0.1; }
  for (let i = 0; i < 60; i++) { pts.push([+t.toFixed(1), 2, y, v, 0, 1]); y += v / 10; t += 0.1; }
  return { id, cls: 'car', len_m: len, w_m: 1.9, dir: 'NB', move, pts };
}
/** A NB vehicle that keeps v m/s from `from` for dur s without stopping. */
function freeNb(id: number, t0: number, from: number, v: number, dur: number): TrackT {
  const pts: Pt[] = [];
  for (let i = 0; i <= dur * 10; i++) pts.push([+(t0 + i / 10).toFixed(1), 2, from + v * (i / 10), v, 0, 1]);
  return { id, cls: 'car', len_m: 4.6, w_m: 1.9, dir: 'NB', move: 'through', pts };
}

describe('queueProfile', () => {
  it('counts stopped vehicles upstream of the bar per frame and measures the back of queue to the rear bumper', () => {
    // two cars queued at 10 and 16 m upstream of the bar from 2 to 6 s; one car stopped beyond the bar must not count
    const a = nbVehicle(1, 0, -45, 10, BAR - 10, 4);
    const b = nbVehicle(2, 0, -51, 10, BAR - 16, 4);
    const past: TrackT = { id: 3, cls: 'car', len_m: 4.6, w_m: 1.9, dir: 'NB', pts: Array.from({ length: 100 }, (_, i) => [i / 10, 2, BAR + 3, 0, 0, 0] as Pt) };
    const q = queueProfile([a, b, past], 'NB', BAR, 10, 12);
    expect(q.t).toHaveLength(121);
    expect(q.maxQueue).toBe(2);
    expect(q.n[40]).toBe(2);
    expect(q.n[10]).toBe(0);
    // farthest stopped car's front bumper is 16 m upstream (the served point); its rear bumper is 16 + 4.6 = 20.6 m from the bar
    expect(q.maxBackM).toBeCloseTo(20.6, 5);
    expect(q.maxBackFt).toBeCloseTo(20.6 * 3.28084, 3);
    expect(q.stoppedVehicles).toBe(2);
    expect(q.tMaxQueue).toBeCloseTo(2, 1); // both cars come to rest 20 m after their start at 10 m/s
  });
  it('time-weights the mean queue over all frames and ignores other approaches', () => {
    const a = nbVehicle(1, 0, -45, 10, BAR - 10, 4);
    const sb: TrackT = { ...nbVehicle(9, 0, -45, 10, BAR - 10, 4), dir: 'SB' };
    const q = queueProfile([a, sb], 'NB', BAR, 10, 10);
    const stoppedFrames = q.n.filter((v) => v === 1).length;
    expect(stoppedFrames).toBe(40);
    expect(q.meanQueue).toBeCloseTo(40 / 101, 6);
  });
  it('uses the stopped criterion v < 0.5 m/s', () => {
    const creeping: TrackT = { id: 1, cls: 'car', len_m: 4.6, w_m: 1.9, dir: 'NB', pts: Array.from({ length: 50 }, (_, i) => [i / 10, 2, BAR - 8, STOP_V, 0, 1] as Pt) };
    expect(queueProfile([creeping], 'NB', BAR, 10, 5).maxQueue).toBe(0);
  });
});

describe('stoppedDelay', () => {
  it('reports zero control delay for a free-flowing vehicle and the waiting time for a stopped one', () => {
    // three free vehicles at 10 m/s set the 85th-percentile spot speed at the entry line (BAR − 40)
    const free = [freeNb(1, 0, -70, 10, 8), freeNb(2, 3, -70, 10, 8), freeNb(3, 6, -70, 10, 8)];
    const stopped = nbVehicle(4, 10, -70, 10, BAR - 3, 5);
    const s = stoppedDelay([...free, stopped], 'NB', BAR, 10, 40);
    expect(s.nVehicles).toBe(4);
    expect(s.v85).toBeCloseTo(10, 6);
    expect(s.nSpot).toBe(4);
    const f = s.vehicles.find((v) => v.id === 1)!;
    expect(f.stoppedS).toBe(0);
    expect(f.segmentM).toBeCloseTo(40, 6);
    expect(f.controlS).toBeCloseTo(0, 6);
    const w = s.vehicles.find((v) => v.id === 4)!;
    expect(w.stoppedS).toBeCloseTo(5, 6);
    // 5 s standing still plus the 0.1 s step onto the bar: the delay is the standing time to within one frame
    expect(w.controlS).toBeGreaterThan(4.8);
    expect(w.controlS).toBeLessThan(5.4);
    expect(w.censored).toBe(false);
    expect(s.stoppedShare).toBeCloseTo(0.25, 6);
    expect(s.meanStoppedS).toBeCloseTo(1.25, 6);
    expect(s.los).toBe('A');
  });
  it('flags vehicles queued when the window opens or still upstream when it closes as censored', () => {
    const free = [freeNb(1, 0, -70, 10, 8), freeNb(2, 3, -70, 10, 8)];
    const early: TrackT = { id: 5, cls: 'car', len_m: 4.6, w_m: 1.9, dir: 'NB', pts: [[0, 2, BAR - 5, 0, 0, 1], [0.1, 2, BAR - 5, 0, 0, 1], [0.2, 2, BAR - 5, 0, 0, 1], [0.3, 2, BAR - 4, 8, 0, 1], [0.4, 2, BAR + 1, 8, 0, 1]] };
    // arrives at 20 s, stops at 25.5 s and is still standing when its track (the window) ends 60 s later
    const full = nbVehicle(6, 20, -70, 10, BAR - 3, 80);
    const late: TrackT = { ...full, pts: full.pts.filter((q) => q[0] <= 85) };
    const s = stoppedDelay([...free, early, late], 'NB', BAR, 10, 40);
    expect(s.vehicles.find((v) => v.id === 5)!.censored).toBe(true);
    const l = s.vehicles.find((v) => v.id === 6)!;
    expect(l.censored).toBe(true);
    expect(l.controlS).toBeGreaterThan(50);
    expect(s.censored).toBe(2);
  });
  it('leaves control delay null when the free-flow speed cannot be observed', () => {
    const only = nbVehicle(1, 0, -30, 10, BAR - 3, 2);
    const s = stoppedDelay([only], 'NB', BAR, 10, 60);
    expect(s.v85).toBeNull();
    expect(s.vehicles[0].controlS).toBeNull();
    expect(s.los).toBeNull();
  });
});

describe('HCM level of service', () => {
  it('applies the Exhibit 19-8 signalized thresholds', () => {
    expect(losFromDelay(10)).toBe('A');
    expect(losFromDelay(10.1)).toBe('B');
    expect(losFromDelay(20)).toBe('B');
    expect(losFromDelay(35)).toBe('C');
    expect(losFromDelay(55)).toBe('D');
    expect(losFromDelay(80)).toBe('E');
    expect(losFromDelay(80.5)).toBe('F');
  });
});

describe('approachReach', () => {
  it('caps the segment at 60 m and shortens it where tracks appear closer to the bar', () => {
    expect(approachReach([freeNb(1, 0, -90, 10, 5), freeNb(2, 0, -90, 10, 5)], 'NB', BAR)).toBe(60);
    expect(approachReach([freeNb(1, 0, -45, 10, 5), freeNb(2, 0, -44, 10, 5)], 'NB', BAR)).toBe(28);
  });
});

describe('phaseIntervals', () => {
  it('run-length encodes the inferred lamp states in seconds', () => {
    const plan = inferSignals([freeNb(1, 0, -40, 10, 6)], { nbBar: BAR, sbBar: 15, xMid: 0 }, 20, 10);
    const iv = phaseIntervals(plan, 'ns');
    expect(iv[0].from).toBe(0);
    expect(iv[iv.length - 1].to).toBe(20);
    for (let i = 1; i < iv.length; i++) { expect(iv[i].from).toBe(iv[i - 1].to); expect(iv[i].lamp).not.toBe(iv[i - 1].lamp); }
    expect(iv.every((x) => [0, 1, 2].includes(x.lamp))).toBe(true);
  });
});
