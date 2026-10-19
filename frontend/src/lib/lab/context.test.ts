import { describe, expect, it } from 'vitest';
import { occludedShare, segmentHitsFootprint, type Footprint } from './context';
import { clipPolygon, principalAxis } from './street';

const car = (x: number, y: number, h = Math.PI / 2): Footprint => ({ x, y, h, len: 4.8, w: 1.9 });

describe('line of sight', () => {
  it('a ray through a rectangle hits it, a ray beside it does not', () => {
    expect(segmentHitsFootprint(0, 0, 0, 20, car(0, 10))).toBe(true);
    expect(segmentHitsFootprint(0, 0, 3, 20, car(0, 10))).toBe(false);
    // orientation matters: a car across the ray is wider than it is long along it
    expect(segmentHitsFootprint(0, 0, 2.2, 20, car(0, 10, 0))).toBe(true);
    expect(segmentHitsFootprint(0, 0, 3, 20, car(0, 10, Math.PI / 2))).toBe(false); // a 2.2 m offset still grazes the near corner of a 4.8 m car
  });
  it('a nearer car in line hides the one behind it; one beside leaves it clear', () => {
    expect(occludedShare(0, 0, car(0, 20), [car(0, 10)])).toBe(1);
    expect(occludedShare(0, 0, car(0, 20), [car(4, 10)])).toBe(0);
    // partially: only the far end of the target is shadowed
    expect(occludedShare(0, 0, car(0, 20, 0), [car(1.2, 10)])).toBeGreaterThan(0);
    expect(occludedShare(0, 0, car(0, 20, 0), [car(1.2, 10)])).toBeLessThan(1);
  });
});

describe('crosswalk geometry', () => {
  it('principal axis follows the long side', () => {
    const { ax, ay } = principalAxis([[0, 0], [10, 0], [10, 2], [0, 2]]);
    expect(Math.abs(ax)).toBeCloseTo(1, 5); expect(Math.abs(ay)).toBeCloseTo(0, 5);
  });
  it('clips a bar to a convex polygon in either winding', () => {
    const tri: [number, number][] = [[0, 0], [10, 0], [0, 10]];
    const bar: [number, number][] = [[-5, 2], [20, 2], [20, 3], [-5, 3]];
    const a = clipPolygon(bar, tri), b = clipPolygon(bar, [...tri].reverse());
    expect(a.length).toBeGreaterThanOrEqual(4);
    for (const [x, y] of a) { expect(x).toBeGreaterThanOrEqual(-1e-9); expect(y).toBeGreaterThanOrEqual(2 - 1e-9); expect(x + y).toBeLessThanOrEqual(10 + 1e-9); }
    expect(b.length).toBe(a.length);
  });
});
