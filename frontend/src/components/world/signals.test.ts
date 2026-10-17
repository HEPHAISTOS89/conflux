import { describe, expect, it } from 'vitest';
import type { Pt, TrackT } from '../../lib/traj';
import { dischargeEvents, inferSignals, lampAt } from './signals';

/** A vehicle on `dir` moving at v m/s from `from` along its axis, starting at t0, for dur s. */
const mover = (id: string, dir: 'NB' | 'SB' | 'EB' | 'WB', t0: number, from: number, v: number, dur: number, move = 'through'): TrackT => {
  const pts: Pt[] = [];
  const sign = dir === 'NB' || dir === 'EB' ? 1 : -1;
  for (let i = 0; i <= dur * 10; i++) {
    const s = from + sign * v * (i / 10);
    pts.push(dir === 'NB' || dir === 'SB' ? [t0 + i / 10, 2, s, v, 0, 1] : [t0 + i / 10, s, 0, v, 0, 1]);
  }
  return { id, cls: 'car', len_m: 4.5, w_m: 1.9, dir, move, pts };
};
/** A through vehicle standing still at `at` on `dir` from t0 for dur s. */
const stopped = (id: string, dir: 'NB' | 'SB' | 'EB' | 'WB', t0: number, at: number, dur: number): TrackT => {
  const pts: Pt[] = [];
  for (let i = 0; i <= dur * 10; i++) pts.push(dir === 'NB' || dir === 'SB' ? [t0 + i / 10, 2, at, 0, 0, 1] : [t0 + i / 10, at, 0, 0, 0, 1]);
  return { id, cls: 'car', len_m: 4.5, w_m: 1.9, dir, move: 'through', pts };
};

const G = { nbBar: -15, sbBar: 15, xMid: 0 };

describe('signal inference from flow', () => {
  it('records a discharge when a through vehicle crosses its line above 2 m/s, and ignores turns', () => {
    const ev = dischargeEvents([mover('a', 'NB', 0, -40, 10, 4), mover('b', 'EB', 0, -20, 10, 4), mover('c', 'NB', 0, -40, 10, 4, 'left')], G);
    expect(ev.map((e) => e.g).sort()).toEqual(['ew', 'ns']);
    expect(ev.find((e) => e.g === 'ns')!.t).toBeCloseTo(2.5, 1);
  });

  it('is green for the group that discharges and red for the other, with yellow and all-red before a change', () => {
    // NS platoon crosses during 2–14 s; EW platoon crosses during 30–44 s
    const tracks = [
      ...[2, 5, 8, 11, 14].map((t, i) => mover(`n${i}`, 'NB', t - 2.5, -40, 10, 6)),
      ...[30, 33, 36, 40, 44].map((t, i) => mover(`e${i}`, 'EB', t - 2, -20, 10, 4)),
    ];
    const plan = inferSignals(tracks, G, 60);
    expect(lampAt(plan, 'ns', 8)).toBe(2);
    expect(lampAt(plan, 'ew', 8)).toBe(0);
    expect(lampAt(plan, 'ew', 36)).toBe(2);
    expect(lampAt(plan, 'ns', 36)).toBe(0);
    // the change to EW green happens 2 s before the first EW crossing (t = 28); NS shows yellow, then all-red
    expect(lampAt(plan, 'ns', 25)).toBe(1);
    expect(lampAt(plan, 'ns', 27.5)).toBe(0);
    expect(lampAt(plan, 'ew', 27.5)).toBe(0);
    expect(lampAt(plan, 'ew', 28.2)).toBe(2);
    // never both green
    for (let k = 0; k < plan.ns.length; k++) expect(plan.ns[k] === 2 && plan.ew[k] === 2).toBe(false);
  });

  it('turns a group red when its queue stands at the bar and nothing discharges', () => {
    const tracks = [mover('n0', 'NB', 0, -40, 10, 5), stopped('q', 'NB', 15, -17, 20)];
    const plan = inferSignals(tracks, G, 40);
    expect(lampAt(plan, 'ns', 2)).toBe(2);
    expect(lampAt(plan, 'ns', 25)).toBe(0);
    expect(lampAt(plan, 'ew', 25)).toBe(2);
  });

  it('absorbs green runs shorter than the minimum green', () => {
    const tracks = [
      ...[2, 5, 8, 11, 14, 17, 20, 23].map((t, i) => mover(`n${i}`, 'NB', t - 2.5, -40, 10, 6)),
      mover('e', 'EB', 13 - 2, -20, 10, 4), // one EW crossing amid NS flow: a tie, not a phase
    ];
    const plan = inferSignals(tracks, G, 30);
    expect(Array.from(plan.ew).every((v) => v === 0)).toBe(true);
  });
});
