import { describe, expect, it } from 'vitest';
import type { Pt, TrackT } from '../traj';
import {
  bearingDeg, bearingLabel, confidence, conflictPoint, dataHealth, headingAt, histogram, kinAt, nearMissWarp, nextRisk,
  percentile, petPair, projectCA, speedResidual, spotSpeeds, stepFrame, stopLine, ttcCV,
} from './metrics';

/** Straight track at constant speed v (m/s) from (x0, y0) along grid angle h, 10 Hz. */
function line(id: number, x0: number, y0: number, h: number, v: number, n: number, t0 = 0, dir = 'NB'): TrackT {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + i / 10, d = v * (i / 10);
    pts.push([+t.toFixed(1), x0 + Math.cos(h) * d, y0 + Math.sin(h) * d, v, 0, 1]);
  }
  return { id, cls: 'car', len_m: 4.6, w_m: 1.9, dir, pts };
}

describe('heading', () => {
  it('maps grid angles to bearings clockwise from corridor north', () => {
    expect(bearingDeg(Math.PI / 2)).toBeCloseTo(0);
    expect(bearingDeg(0)).toBeCloseTo(90);
    expect(bearingDeg(-Math.PI / 2)).toBeCloseTo(180);
    expect(bearingDeg(Math.PI)).toBeCloseTo(270);
    expect(bearingLabel(44)).toBe('NE');
    expect(bearingLabel(359)).toBe('N');
  });
  it('is null while stationary and follows displacement otherwise', () => {
    const still = line(1, 0, 0, 0, 0, 20);
    expect(headingAt(still.pts, 10)).toBeNull();
    const east = line(2, 0, 0, 0, 10, 20);
    expect(headingAt(east.pts, 10)).toBeCloseTo(0);
  });
  it('interpolates position between samples', () => {
    const tr = line(3, 0, 0, Math.PI / 2, 10, 50);
    const k = kinAt(tr, 1.05)!;
    expect(k.y).toBeCloseTo(10.5, 5);
    expect(bearingDeg(k.h)).toBeCloseTo(0);
    expect(kinAt(tr, 9)).toBeNull();
  });
});

describe('track confidence', () => {
  it('is high for a kinematically consistent track', () => {
    const tr = line(1, 0, 0, 0, 12, 60);
    expect(speedResidual(tr.pts, 30)).toBeLessThan(1e-9);
    const c = confidence(tr.pts, 30);
    expect(c.score).toBeCloseTo(1);
    expect(c.level).toBe('high');
  });
  it('drops on a position jump and on implausible acceleration', () => {
    const tr = line(1, 0, 0, 0, 12, 60);
    tr.pts[30] = [tr.pts[30][0], tr.pts[30][1] + 2, tr.pts[30][2], 12, 0, 1]; // 2 m jump = 20 m/s residual
    expect(confidence(tr.pts, 30).level).toBe('low');
    const tr2 = line(2, 0, 0, 0, 12, 60);
    tr2.pts[30][4] = 9;
    const c = confidence(tr2.pts, 30);
    expect(c.accelFlag).toBe(true);
    expect(c.score).toBeCloseTo(0.5);
  });
  it('penalises a missing-frame gap', () => {
    const tr = line(1, 0, 0, 0, 0, 60);
    tr.pts.splice(28, 5);
    const c = confidence(tr.pts, 28);
    expect(c.gapFlag).toBe(true);
    expect(c.score).toBeCloseTo(0.6);
  });
});

describe('data health', () => {
  it('reports completeness, gaps and jump tracks', () => {
    const a = line(1, 0, 0, 0, 10, 101);
    const b = line(2, 0, 5, 0, 10, 101);
    b.pts.splice(40, 10); // 1.0 s missing → longest gap 1.0 s
    b.pts[60] = [b.pts[60][0], b.pts[60][1] + 3, b.pts[60][2], 10, 0, 1];
    const h = dataHealth([a, b]);
    expect(h.expected).toBe(202);
    expect(h.samples).toBe(192);
    expect(h.completeness).toBeCloseTo((100 * 192) / 202);
    expect(h.longestGapS).toBeCloseTo(1.0);
    expect(h.gaps).toBe(1);
    expect(h.jumpTracks).toBe(1);
  });
});

describe('spot speeds and histogram', () => {
  it('takes one interpolated speed per vehicle at the line', () => {
    const nb = line(1, 0, -60, Math.PI / 2, 15, 80, 0, 'NB');
    const sb = line(2, 0, 60, -Math.PI / 2, 9, 120, 0, 'SB');
    expect(spotSpeeds([nb, sb], 'NB', -30)).toEqual([15]);
    expect(spotSpeeds([nb, sb], 'SB', 30)).toEqual([9]);
    expect(spotSpeeds([nb], 'SB', 30)).toEqual([]);
  });
  it('bins values and computes interpolated percentiles', () => {
    const b = histogram([1, 4.9, 5, 12], 5);
    expect(b.map((x) => x.n)).toEqual([2, 1, 1]);
    expect(b[2].x1).toBe(15);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([10, 20], 85)).toBeCloseTo(18.5);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('projection, TTC and PET', () => {
  it('projects with constant acceleration and stops instead of reversing', () => {
    const p = projectCA({ x: 0, y: 0, v: 10, a: 0, h: 0 }, 2);
    expect(p.length).toBe(21);
    expect(p[20][0]).toBeCloseTo(20, 5);
    const s = projectCA({ x: 0, y: 0, v: 2, a: -4, h: Math.PI / 2 }, 2);
    expect(s[20][1]).toBeCloseTo(0.5, 5); // stops after 0.5 s: v²/2a = 0.5 m
  });
  it('computes rear-end TTC for a closing follower', () => {
    const lead = { x: 20, y: 0, v: 5, a: 0, h: 0, len: 4, w: 2 };
    const fol = { x: 0, y: 0, v: 15, a: 0, h: 0, len: 4, w: 2 };
    // gap between front circle of follower (x=1, r=1) and rear circle of leader (x=19, r=1) = 16 m at 10 m/s
    expect(ttcCV(fol, lead)).toBeCloseTo(1.6, 5);
    expect(ttcCV(lead, { ...fol, v: 4 })).toBeNull();
    expect(ttcCV(fol, { ...lead, x: 1 })).toBe(0);
  });
  it('finds PET at a path crossing and recognises following', () => {
    const a = line(1, -30, 0, 0, 10, 61); // eastbound through (0,0) at t = 3.0
    const b = line(2, 0, -30, Math.PI / 2, 10, 61, 0, 'NB'); // northbound through (0,0) at t = 3.0, but start later
    b.pts.forEach((p) => (p[0] = +(p[0] + 2).toFixed(1))); // arrives at t = 5.0
    const r = petPair(a, b);
    expect(r.kind).toBe('crossing');
    expect(r.first).toBe('a');
    expect(r.pet).toBeCloseTo(2 - 0.3 + 0.0, 0); // exit ≈ 3.15, enter ≈ 4.85
    expect(Math.abs(r.x)).toBeLessThan(0.6);
    const f = line(3, -40, 0, 0, 10, 61);
    expect(petPair(a, f).kind).toBe('same_path');
    const far = line(4, 0, 50, 0, 10, 61);
    expect(petPair(a, far).kind).toBe('none');
  });
  it('locates crossing conflicts at the path crossing', () => {
    const a = line(1, -30, 0, 0, 10, 61);
    const b = line(2, 0, -30, Math.PI / 2, 10, 61, 2, 'NB');
    const p = conflictPoint({ id: 0, t: 4, a: 1, b: 2, type: 'crossing', ttc_min: null, pet: 1.7, drac_max: null, severity: 'serious' }, a, b)!;
    expect(Math.hypot(p.x, p.y)).toBeLessThan(0.8);
  });
});

describe('stop line', () => {
  it('estimates the queue head from stopped samples', () => {
    const tracks: TrackT[] = [];
    for (let k = 0; k < 6; k++) {
      const pts: Pt[] = [];
      for (let i = 0; i < 10; i++) pts.push([i / 10, 2, -12 - k * 7, 0, 0, 1]);
      tracks.push({ id: k, cls: 'car', len_m: 4.6, w_m: 1.9, dir: 'NB', pts });
    }
    const s = stopLine(tracks, 'NB')!;
    expect(s.y).toBeGreaterThan(-14);
    expect(s.y).toBeLessThanOrEqual(-12);
    expect(s.x).toBe(2);
    expect(stopLine(tracks, 'SB')).toBeNull();
  });
});

describe('playback helpers', () => {
  it('slows smoothly around a near-miss', () => {
    expect(nearMissWarp(10, 10)).toBe(0.35);
    expect(nearMissWarp(12, 10)).toBe(1);
    const mid = nearMissWarp(11.1, 10);
    expect(mid).toBeGreaterThan(0.35);
    expect(mid).toBeLessThan(1);
    expect(nearMissWarp(8.9, 10)).toBeCloseTo(mid, 9);
  });
  it('jumps to the next and previous risk event', () => {
    const cs = [{ t: 5 }, { t: 1 }, { t: 9 }];
    expect(nextRisk(cs, 1, 1)!.t).toBe(5);
    expect(nextRisk(cs, 5, -1)!.t).toBe(1);
    expect(nextRisk(cs, 9, 1)).toBeNull();
    expect(nextRisk(cs, 0.5, -1)).toBeNull();
  });
  it('steps on the 10 Hz frame grid', () => {
    expect(stepFrame(1.23, 1, 90)).toBeCloseTo(1.3);
    expect(stepFrame(1.27, -1, 90)).toBeCloseTo(1.2);
    expect(stepFrame(0, -1, 90)).toBe(0);
    expect(stepFrame(90, 1, 90)).toBe(90);
  });
});
