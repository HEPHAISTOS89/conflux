import { describe, expect, it } from 'vitest';
import type { LaneGeom, Pt, TrackT } from '../traj';
import { cleanCentre, dashes, MUTCD, offset, ribbon, roadGeometry, xAt } from './road';
import { renderPose } from './metrics';

/** Lane centreline every 5 m from y0 to y1 at lateral x, skipping the box (|y| < gap). */
const lane = (dir: string, id: number, x: number, y0 = -60, y1 = 60, gap = 12): LaneGeom => {
  const centre: [number, number][] = [];
  for (let y = y0; y <= y1; y += 5) if (Math.abs(y) > gap) centre.push([x, y]);
  return { dir, lane: id, centre };
};
/** A queue: n stopped samples of a NB vehicle with its front at y. */
const queue = (dir: 'NB' | 'SB', x: number, y: number, n = 30): TrackT => ({
  id: `${dir}q`, cls: 'car', len_m: 4.5, w_m: 1.9, dir, pts: Array.from({ length: n }, (_, i) => [i / 10, x, y, 0, 0, 1] as Pt),
});

describe('road geometry from lanes', () => {
  const data = {
    bbox: [[-12, -60], [12, 60]] as [[number, number], [number, number]],
    lanes_geom: [lane('NB', 1, 1.8), lane('NB', 2, 5.1), lane('SB', 1, -1.8), lane('SB', 2, -5.1), { dir: 'NB', lane: 1, centre: [[25, 0]] } as LaneGeom],
    tracks: [queue('NB', 3.4, -16), queue('SB', -3.4, 16)],
  };
  const g = roadGeometry(data);
  it('finds the intersection box where no lane is observed', () => {
    expect(g.box).not.toBeNull();
    expect(g.box!.y0).toBeGreaterThanOrEqual(-15);
    expect(g.box!.y1).toBeLessThanOrEqual(15);
    expect(g.box!.y1 - g.box!.y0).toBeGreaterThanOrEqual(20);
  });
  it('estimates lane width from adjacent centrelines', () => {
    expect(g.laneW).toBeCloseTo(3.3, 1);
  });
  it('draws a double centre line between opposing lanes and dashed lane lines within a direction', () => {
    const centre = g.lines.filter((l) => l.kind === 'centre');
    expect(centre.length).toBe(2); // one per arm
    for (const c of centre) for (const [x] of c.pts) expect(x).toBeCloseTo(0, 5);
    const lanes = g.lines.filter((l) => l.kind === 'lane');
    expect(lanes.some((l) => Math.abs(l.pts[0][0] - 3.45) < 0.01)).toBe(true);
    expect(lanes.some((l) => Math.abs(l.pts[0][0] + 3.45) < 0.01)).toBe(true);
  });
  it('puts stop bars ahead of the queue head, never inside the box, spanning the approach lanes', () => {
    const nb = g.stops.find((s) => s.dir === 'NB')!, sb = g.stops.find((s) => s.dir === 'SB')!;
    expect(nb.a[1]).toBeLessThanOrEqual(g.box!.y0);
    expect(sb.a[1]).toBeGreaterThanOrEqual(g.box!.y1);
    expect(nb.a[0]).toBeCloseTo(1.8 - g.laneW / 2, 5);
    expect(nb.b[0]).toBeCloseTo(5.1 + g.laneW / 2, 5);
  });
  it('drops centreline bins far from the lane (turning traffic)', () => {
    const c = cleanCentre({ dir: 'NB', lane: 1, centre: [[2, -20], [2.1, -15], [22, -5], [2, 15]] });
    expect(c.map((p) => p[0])).toEqual([2, 2.1, 2]);
    expect(xAt(c, -17.5)).toBeCloseTo(2.05);
    expect(xAt(c, 0, 0.01)).toBeNull(); // 30 m without a bin is a break, not a gap to bridge
  });
});

describe('marking helpers', () => {
  it('splits a line into MUTCD 10 ft dashes with 30 ft gaps', () => {
    const d = dashes([[0, 0], [0, 40]]);
    expect(d.length).toBe(4); // dashes start at 0, 12.19, 24.38, 36.58 m
    const len = (p: [number, number][]) => Math.hypot(p[p.length - 1][0] - p[0][0], p[p.length - 1][1] - p[0][1]);
    expect(len(d[0])).toBeCloseTo(MUTCD.dash, 5);
    expect(d[1][0][1]).toBeCloseTo(MUTCD.dash + MUTCD.gap, 5);
  });
  it('offsets to the right of travel and builds two triangles per segment', () => {
    expect(offset([[0, 0], [0, 10]], 1)[0][0]).toBeCloseTo(1);
    expect(ribbon([[0, 0], [0, 10]], 0.2).length).toBe(12);
  });
});

describe('render pose', () => {
  const pts: Pt[] = [];
  for (let i = 0; i <= 50; i++) pts.push([+(2 + i / 10).toFixed(1), 0, 10 * (i / 10), 10, i > 30 ? -2 : 0, 1]);
  const tr: TrackT = { id: 1, cls: 'car', len_m: 4.5, w_m: 1.9, dir: 'NB', pts };
  it('interpolates smoothly between 10 Hz samples', () => {
    const p = renderPose(tr, 3.05, 10, [0, 90])!;
    expect(p.y).toBeCloseTo(10.5, 6);
    expect(p.h).toBeCloseTo(Math.PI / 2, 6);
  });
  it('fades in after a mid-window start and out before a mid-window end', () => {
    expect(renderPose(tr, 2.0, 10, [0, 90])!.fade).toBeCloseTo(0);
    expect(renderPose(tr, 2.25, 10, [0, 90])!.fade).toBeCloseTo(0.5);
    expect(renderPose(tr, 4.0, 10, [0, 90])!.fade).toBe(1);
    expect(renderPose(tr, 7.0, 10, [0, 90])!.fade).toBeCloseTo(0);
    // a track that starts with the replay window is already there
    expect(renderPose(tr, 2.0, 10, [2, 90])!.fade).toBe(1);
  });
  it('lights the brake lamps under deceleration', () => {
    expect(renderPose(tr, 4.0, 10)!.brake).toBe(0);
    expect(renderPose(tr, 6.0, 10)!.brake).toBe(1);
  });
  it('turns the heading along the shorter arc', () => {
    const turn: Pt[] = [];
    // heading sweeps through ±180° (westbound, curving): must not spin the long way round
    for (let i = 0; i <= 40; i++) { const a = Math.PI - 0.3 + (0.6 * i) / 40; turn.push([i / 10, 30 * Math.cos(a), 30 * Math.sin(a), 5, 0, 1]); }
    const T: TrackT = { id: 2, cls: 'car', len_m: 4.5, w_m: 1.9, pts: turn };
    let prev = renderPose(T, 1.0)!.h;
    for (let t = 1.0; t <= 3.0; t += 0.02) { const h = renderPose(T, t)!.h; expect(Math.abs(Math.atan2(Math.sin(h - prev), Math.cos(h - prev)))).toBeLessThan(0.05); prev = h; }
  });
});
