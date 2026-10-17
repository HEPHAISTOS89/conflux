import { describe, expect, it } from 'vitest';
import type { Pt, TrackT } from '../traj';
import { conflictIsGhostPair, footprintsOverlap, ghostFade, trackQuality } from './quality';

/** A northbound track along x = x0 from y0 at speed v, t from ts. */
function track(id: number, x0: number, y0: number, v: number, ts: number, n: number, opts: Partial<TrackT> = {}): TrackT {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) pts.push([+(ts + i / 10).toFixed(1), x0, y0 + (v * i) / 10, v, 0, 1]);
  return { id, cls: 'car', len_m: 4.8, w_m: 1.9, dir: 'NB', move: 'through', pts, ...opts };
}

describe('footprintsOverlap', () => {
  it('is oriented: a car beside another in the next lane does not overlap, one on top of it does', () => {
    const a = { id: 'a', x: 0, y: 0, h: Math.PI / 2, len: 4.8, w: 1.9 };
    expect(footprintsOverlap(a, { ...a, id: 'b', x: 3.3 })).toBe(false);
    expect(footprintsOverlap(a, { ...a, id: 'b', y: 1.0 })).toBe(true);
    expect(footprintsOverlap(a, { ...a, id: 'b', y: 4.5 })).toBe(false); // bumper to bumper, not overlapping
  });
});

describe('trackQuality', () => {
  it('finds nothing in clean traffic', () => {
    const q = trackQuality([track(1, 0, 0, 10, 0, 50), track(2, 0, -12, 10, 0, 50), track(3, 3.3, 0, 10, 0, 50)]);
    expect(q.windows).toEqual([]);
    expect(q.hiddenS).toBe(0);
  });

  it('hides the later-starting duplicate for the whole overlap, extending to the track ends', () => {
    const host = track(1, 0, 0, 2, 0, 100);
    const dup = track(2, 0.2, 0.6, 2, 0.3, 97); // same car, detected a second time 0.3 s later
    const q = trackQuality([host, dup]);
    expect(q.windows).toHaveLength(1);
    const w = q.windows[0];
    expect(w.id).toBe('2'); expect(w.of).toBe('1'); expect(w.reason).toBe('duplicate');
    expect(w.from).toBeCloseTo(0.3, 5); expect(w.to).toBeCloseTo(9.9, 5);
    expect(q.wholeTracks).toEqual(['2']);
    expect(ghostFade(q, '2', 5)).toBe(0);
    expect(ghostFade(q, '1', 5)).toBe(1);
  });

  it('names the track that jumped onto another an ID switch', () => {
    const host = track(1, 0, 20, 0, 0, 80); // queued at y = 20 for 8 s
    const sw = track(2, 0, -40, 8, 0, 80); // approaches at 8 m/s…
    for (let i = 40; i < 80; i++) sw.pts[i] = [sw.pts[i][0], 0, 20.4, 0, 0, 1]; // …then jumps onto the queued car
    const q = trackQuality([host, sw]);
    expect(q.windows).toHaveLength(1);
    expect(q.windows[0]).toMatchObject({ id: '2', of: '1', reason: 'id_switch' });
    expect(q.windows[0].from).toBeCloseTo(4, 5);
    expect(q.windows[0].to).toBeCloseTo(7.9, 5);
  });

  it('ignores brief overlaps (a near-miss passing through), keeps sustained ones', () => {
    const a = track(1, 0, 0, 10, 0, 40);
    const b = track(2, 0, 0.5, 10, 0, 5); // 0.5 s only
    expect(trackQuality([a, b]).windows).toEqual([]);
    const c = track(3, 0, 0.5, 10, 0, 11); // 1.1 s
    expect(trackQuality([a, c]).windows).toHaveLength(1);
  });

  it('fades over the window edges', () => {
    const q = trackQuality([track(1, 0, 0, 2, 0, 100), track(2, 0.2, 0.6, 2, 2, 30)]);
    const w = q.windows[0];
    expect(ghostFade(q, '2', w.from - 0.15)).toBeCloseTo(0.5, 5);
    expect(ghostFade(q, '2', w.to + 0.3)).toBeCloseTo(1, 6);
  });

  it('flags a conflict between a ghost and its host', () => {
    const q = trackQuality([track(1, 0, 0, 2, 0, 100), track(2, 0.2, 0.6, 2, 2, 30)]);
    expect(conflictIsGhostPair(q, 1, 2, 3)).toBe(true);
    expect(conflictIsGhostPair(q, 1, 2, 9)).toBe(false);
    expect(conflictIsGhostPair(q, 1, 3, 3)).toBe(false);
  });
});
